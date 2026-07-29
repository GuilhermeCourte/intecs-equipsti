// ============================================================
//  Regras da auditoria do Google Drive (aba Logs > fonte "Google Drive").
//  Só leitura: o GTI nunca escreve nada no Workspace.
//
//  Divisão de trabalho combinada com o usuário:
//   - download / cópia / sync / edição / exclusão são GRAVADOS no SQL
//     (busca por texto, filtro e scroll infinito ficam locais e rápidos,
//     e o histórico passa dos 6 meses de retenção do Google);
//   - "view" NÃO é gravado — é o evento mais volumoso de longe e vale
//     pouco. Ele é consultado ao vivo, sob demanda, em listarVisualizacoes().
// ============================================================
import dotenv from 'dotenv';
import * as client from './client.js';
import * as repo from './repository.js';
import { configurado } from './auth.js';

dotenv.config();

export { configurado };

// Eventos gravados no banco. A família de cópia entra inteira porque é o foco
// do pedido ("cópia de arquivo pelo Windows"): ao copiar um arquivo do Drive
// para uma máquina com o Drive para Computador o Google registra download E
// item_content_synced; numa cópia dentro do Drive ele registra copy no arquivo
// novo e source_copy no original.
// trash entra junto com delete porque mandar para a lixeira gera 'trash' —
// 'delete' é só a exclusão definitiva, que quase nunca acontece.
// Atenção ao nome de sync_item_content: no Admin Console ele aparece como
// "Item content synced", mas o eventName da API é nesta ordem. Conferido no
// /diagnostico deste domínio.
const PADRAO_EVENTOS = [
  'download', 'copy', 'source_copy', 'sync_item_content',
  'edit', 'trash', 'delete'
];

// GOOGLE_DRIVE_EVENTOS (CSV) sobrescreve a lista sem precisar de deploy —
// é o ajuste mais provável depois de olhar o /diagnostico.
const eventosDoEnv = (process.env.GOOGLE_DRIVE_EVENTOS || '')
  .split(',').map((e) => e.trim()).filter(Boolean);
const EVENTOS_PERSISTIDOS = new Set(eventosDoEnv.length ? eventosDoEnv : PADRAO_EVENTOS);

const BACKFILL_DIAS = Number(process.env.GOOGLE_DRIVE_BACKFILL_DIAS || 30);
const RETENCAO_DIAS = Number(process.env.GOOGLE_DRIVE_RETENCAO_DIAS || 365);

// O lag do log do Drive é de "alguns minutos", mas evento pode chegar fora de
// ordem; 1h de sobreposição cobre isso de graça (o índice único com
// IGNORE_DUP_KEY descarta o que já está gravado).
const SOBREPOSICAO_MS = 60 * 60 * 1000;

// O sync anda para frente em janelas de 24h, da mais antiga para a mais nova,
// drenando cada uma antes de passar para a próxima. É isso que torna o cursor
// (MAX(data_evento)) confiável: interromper no meio nunca deixa buraco atrás.
const JANELA_MS = 24 * 60 * 60 * 1000;
const MAX_JANELAS = 40;
// Por (janela, evento). Com o filtro por eventName, um dia inteiro de downloads
// cabe em uma página — 20 é folga larga antes de gritar.
const MAX_PAGINAS_JANELA = 20;

// ---------- normalização ----------

// Um parâmetro vem como { name, value } | { name, boolValue } | { name,
// intValue } | { name, multiValue: [...] } | messageValue aninhado.
function valorParam(p) {
  if (p.value !== undefined) return p.value;
  if (p.boolValue !== undefined) return p.boolValue;
  if (p.intValue !== undefined) return p.intValue;
  if (p.multiValue !== undefined) return p.multiValue.join(', ');
  if (p.multiIntValue !== undefined) return p.multiIntValue.join(', ');
  if (p.messageValue !== undefined) return p.messageValue;
  if (p.multiMessageValue !== undefined) return p.multiMessageValue;
  return null;
}

function achatarParametros(parametros) {
  const mapa = {};
  for (const p of parametros || []) {
    if (p && p.name) mapa[p.name] = valorParam(p);
  }
  return mapa;
}

// IDs OAuth de app -> origem. Levantados pelo GET /api/drive-logs/diagnostico
// neste domínio; se aparecer um ID novo, ele cai em 'APP' e o ID fica visível
// no tooltip da coluna Origem da tela — daí é só acrescentar aqui.
const APPS_CONHECIDOS = {
  // Downloads e sync_item_content saem sempre em par e de um IP de cliente
  // real: é a assinatura do Drive para Computador.
  '947318989803': 'DESKTOP',
  // Só view + sync_item_content, sem IP nenhum: app do Drive no celular
  // sincronizando para uso offline.
  '1082607815231': 'MOBILE'
  // 691301496089 fica de fora de propósito: é o próprio back-end do Drive
  // (sem IP de cliente, dezenas de atores, eventos em cascata do tipo
  // *_hierarchy_reconciled). Não é nem web nem desktop — vira "Outro aplicativo".
};

/**
 * De onde partiu a ação: WEB | DESKTOP | MOBILE | APP | DESCONHECIDA.
 *
 * A Admin SDK Reports API NÃO expõe um campo "client_type" (não está nem na
 * referência de eventos do Drive nem na lista de atributos do Admin Console).
 * Então isto é derivado de três sinais, nesta ordem:
 *   1. client_type, se algum dia aparecer no domínio — lido oportunisticamente;
 *   2. sync_item_content, emitido ao sincronizar o arquivo para a máquina;
 *   3. originating_app_id (ou actor.applicationInfo.oauthClientId), o ID OAuth
 *      do app que agiu. A interface web normalmente não manda nenhum.
 */
// O MESMO app chega em duas formas: o número do projeto ("947318989803", em
// originating_app_id) e o client ID inteiro
// ("947318989803-6bn6....apps.googleusercontent.com", em applicationInfo).
// O número na frente é o que identifica o app — o resto é ruído.
function idDoApp(appId) {
  return String(appId).split('-')[0].split('.')[0];
}

function origemDoEvento(params, nomeEvento, appId) {
  const bruto = params.client_type;
  if (bruto) {
    const v = String(bruto).toUpperCase();
    if (v.includes('WEB')) return 'WEB';
    if (v.includes('SYNC') || v.includes('DESKTOP') || v.includes('FS')) return 'DESKTOP';
    if (v.includes('IOS') || v.includes('ANDROID') || v.includes('MOBILE')) return 'MOBILE';
    return 'APP';
  }
  // O ID do app manda mais que o evento: sync_item_content também sai do app
  // do celular sincronizando para uso offline, então checar o mapa primeiro
  // evita marcar celular como desktop.
  if (appId) return APPS_CONHECIDOS[idDoApp(appId)] || 'APP';
  if (nomeEvento === 'sync_item_content') return 'DESKTOP';
  // Confirmado no diagnóstico: 572 dos 609 downloads do domínio vêm sem
  // originating_app_id — é a interface web.
  return 'WEB';
}

// (atividade, evento) -> uma linha da tabela. Uma atividade pode trazer vários
// events[], e cada par vira uma linha — daí o evento fazer parte da chave única.
function normalizar(atividade, evento) {
  const params = achatarParametros(evento.parameters);
  const appId = params.originating_app_id || atividade.actor?.applicationInfo?.oauthClientId || null;

  return {
    // id.time é RFC 3339 em UTC; id.uniqueQualifier é int64 e ESTOURA o Number
    // do JS — fica string do começo ao fim.
    dataEvento: new Date(atividade.id?.time),
    qualificador: String(atividade.id?.uniqueQualifier ?? ''),
    evento: evento.name,
    atorEmail: atividade.actor?.email || null,
    ip: atividade.ipAddress || null,
    docId: params.doc_id || null,
    docTitulo: params.doc_title || null,
    docTipo: params.doc_type || null,
    proprietario: params.owner || null,
    driveCompartilhado: params.shared_drive_id || null,
    emDriveCompartilhado: Boolean(params.owner_is_shared_drive ?? params.owner_is_team_drive),
    origem: origemDoEvento(params, evento.name, appId),
    appOrigemId: appId ? String(appId) : null,
    visibilidade: params.visibility || null,
    alvo: params.target_user || null,
    valorAnterior: params.old_value == null ? null : String(params.old_value),
    valorNovo: params.new_value == null ? null : String(params.new_value),
    // Saco cru achatado: nada do que o Google mandou se perde, mesmo o que
    // não virou coluna.
    parametrosJson: JSON.stringify(params)
  };
}

// Descarta atividade sem id.time válido (não dá para deduplicar nem ordenar).
// `sohEste` limita aos eventos com esse nome: a API devolve a atividade inteira,
// e uma atividade pode carregar eventos que não são o que foi pedido.
function linhasDaAtividade(atividade, sohEste = null) {
  const quando = new Date(atividade.id?.time);
  if (isNaN(quando)) return [];
  return (atividade.events || [])
    .filter((ev) => ev?.name && (!sohEste || ev.name === sohEste))
    .map((ev) => normalizar(atividade, ev));
}

// ---------- sync incremental ----------

// Drena uma janela, UMA CHAMADA FILTRADA POR EVENTO.
//
// A primeira versão varria a janela sem eventName e peneirava aqui, para fugir
// do limite separado de 250 consultas-com-filtro por minuto. Medido no domínio
// real, isso é caro demais: ~65% das atividades do Drive são "view", e um dia
// passa de 30 páginas de 1000 só para achar algumas dezenas de downloads.
// Com filtro são poucas chamadas por janela, cada uma devolvendo quase só o
// que interessa — e mesmo um backfill de 30 dias fica bem abaixo do limite.
async function coletarJanela(inicio, fim) {
  const linhas = [];

  for (const evento of EVENTOS_PERSISTIDOS) {
    let pageToken = null;
    let paginas = 0;
    do {
      const pagina = await client.listarAtividadesDrive({ inicio, fim, evento, pageToken });
      for (const atividade of pagina.items) linhas.push(...linhasDaAtividade(atividade, evento));
      pageToken = pagina.nextPageToken;
      paginas++;
      if (pageToken && paginas >= MAX_PAGINAS_JANELA) {
        // Falhar alto em vez de deixar buraco silencioso no histórico: seguir
        // para a próxima janela aqui perderia o começo desta sem ninguém saber.
        throw new Error(
          `Google Drive: volume acima do esperado em ${inicio.toISOString().slice(0, 10)} `
          + `para "${evento}" (mais de ${MAX_PAGINAS_JANELA} páginas).`
        );
      }
    } while (pageToken);
  }

  return linhas;
}

let _sincronizando = null;
let _ultimoSync = 0;
const TTL_SYNC_MS = 5 * 60 * 1000;

/**
 * Puxa o que falta desde o último evento gravado.
 * @param {object} [o]
 * @param {boolean} [o.forcar] ignora o TTL de 5 min (botão "Atualizar")
 * @returns {Promise<{inseridos:number, completo:boolean, ate:Date, pulado?:boolean}>}
 */
export async function sincronizar({ forcar = false } = {}) {
  if (!configurado()) {
    throw new Error('Google Workspace não configurado: preencha GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY e GOOGLE_ADMIN_SUBJECT no .env');
  }
  // Várias telas abertas (ou o refresh do navegador) não podem virar várias
  // varreduras simultâneas: quem chegar durante um sync em curso espera o mesmo.
  if (_sincronizando) return _sincronizando;
  if (!forcar && Date.now() - _ultimoSync < TTL_SYNC_MS) {
    return { inseridos: 0, completo: true, ate: new Date(_ultimoSync), pulado: true };
  }

  _sincronizando = (async () => {
    const ultimo = await repo.ultimoEventoUtc();
    let cursor = ultimo
      ? new Date(ultimo.getTime() - SOBREPOSICAO_MS)
      : new Date(Date.now() - BACKFILL_DIAS * 24 * 60 * 60 * 1000);

    const agora = new Date();
    let inseridos = 0;
    let janelas = 0;
    let completo = true;

    while (cursor < agora) {
      if (janelas >= MAX_JANELAS) {
        // Backfill longo não trava uma requisição: para aqui e continua no
        // próximo sync, de onde o cursor parou.
        completo = false;
        break;
      }
      const fim = new Date(Math.min(cursor.getTime() + JANELA_MS, agora.getTime()));
      const linhas = await coletarJanela(cursor, fim);

      if (linhas.length) {
        // Ordem crescente: se a gravação falhar no meio, o que ficou no banco
        // é um prefixo contínuo e MAX(data_evento) continua sendo um cursor
        // seguro para o próximo sync.
        linhas.sort((a, b) => a.dataEvento - b.dataEvento);
        inseridos += await repo.salvarEventos(linhas);
      }

      cursor = fim;
      janelas++;
    }

    if (completo) _ultimoSync = Date.now();
    await repo.purgar(RETENCAO_DIAS);
    return { inseridos, completo, ate: cursor };
  })().finally(() => { _sincronizando = null; });

  return _sincronizando;
}

// ---------- leitura ----------

export function listarEventos(filtros) {
  return repo.listarEventos(filtros);
}

// Janela máxima da consulta ao vivo. Janela estreita é MUITO mais rápida nesta
// API (recomendação do próprio Google) e "view" é o evento mais volumoso.
// Exportada porque a rota valida o período antes (400) — aqui fica a garantia.
export const MAX_DIAS_AO_VIVO = 7;

/**
 * Visualizações (eventName=view) direto da API — nada é gravado.
 * @returns {Promise<{linhas:Array, nextPageToken:string|undefined}>}
 */
export async function listarVisualizacoes({ de, ate, pageToken = null } = {}) {
  if (!(de instanceof Date) || isNaN(de) || !(ate instanceof Date) || isNaN(ate)) {
    throw new Error('Informe o período (de/até) para consultar as visualizações.');
  }
  if (ate - de > MAX_DIAS_AO_VIVO * 24 * 60 * 60 * 1000) {
    throw new Error(`A consulta de visualizações cobre no máximo ${MAX_DIAS_AO_VIVO} dias.`);
  }

  const pagina = await client.listarAtividadesDrive({
    inicio: de, fim: ate, evento: 'view', pageToken, maxResults: 100
  });

  const linhas = [];
  for (const atividade of pagina.items) linhas.push(...linhasDaAtividade(atividade, 'view'));
  return { linhas, nextPageToken: pagina.nextPageToken };
}

/**
 * Amostra crua para conferir, no domínio real, quais parâmetros a API manda —
 * em especial se existe "client_type" e quais originating_app_id aparecem
 * (é daí que sai o mapa APPS_CONHECIDOS).
 */
export async function amostraDiagnostico({ horas = 24 } = {}) {
  const h = Math.min(Math.max(Number(horas) || 24, 1), 168);
  const de = new Date(Date.now() - h * 60 * 60 * 1000);

  const pagina = await client.listarAtividadesDrive({ inicio: de, maxResults: 500 });

  const conta = (mapa, chave) => { if (chave) mapa[chave] = (mapa[chave] || 0) + 1; };
  const eventos = {};
  const parametros = {};
  const appsOrigem = {};
  let temClientType = false;

  for (const atividade of pagina.items) {
    for (const ev of atividade.events || []) {
      conta(eventos, ev.name);
      for (const p of ev.parameters || []) {
        conta(parametros, p.name);
        if (p.name === 'client_type') temClientType = true;
        if (p.name === 'originating_app_id') conta(appsOrigem, String(valorParam(p)));
      }
    }
    const oauth = atividade.actor?.applicationInfo?.oauthClientId;
    if (oauth) conta(appsOrigem, String(oauth));
  }

  return {
    periodo: { de: de.toISOString(), ate: new Date().toISOString() },
    totalAtividades: pagina.items.length,
    truncado: Boolean(pagina.nextPageToken),
    temClientType,
    eventos,
    parametros,
    appsOrigem,
    eventosPersistidos: [...EVENTOS_PERSISTIDOS],
    amostra: pagina.items.slice(0, 5)
  };
}
