// ============================================================
//  Regras do monitoramento de conexões (aba Internet › Conexão).
//  Só leitura: o GTI nunca cria, pausa ou altera monitor, e nunca
//  mexe nos alert contacts — os avisos por e-mail continuam sendo
//  assunto do painel do uptimerobot.com.
// ============================================================
import * as client from './client.js';
import * as statusPage from './statusPage.js';

// status numérico da v2 → rótulo usado no front (cor da bolinha).
// Atenção: a numeração NÃO é intuitiva — 2 é "up" e 9 é "down".
const STATUS = {
  0: 'PAUSADO',
  1: 'NAO_VERIFICADO',  // criado agora, ainda sem a primeira checagem
  2: 'UP',
  8: 'INSTAVEL',        // "seems down": falhou uma vez, ainda confirmando
  9: 'DOWN'
};

// Epoch em segundos → "YYYY-MM-DD HH:MM:SS" em UTC, o mesmo formato que o
// CONVERT(varchar(19), ..., 120) das outras rotas — é o que tempoRelativo()
// (app.js) sabe ler (ele acrescenta o "Z" por conta própria).
export function dataUtc(seg) {
  if (!seg) return null;
  const d = new Date(seg * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizar(m) {
  return {
    id: m.id,
    nome: m.friendly_name || String(m.id),
    url: m.url || null,
    status: STATUS[m.status] || 'DESCONHECIDO',
    // O último log é a mudança de estado mais recente — ou seja, quando o
    // monitor entrou no estado em que está agora.
    desde: dataUtc(m.logs?.[0]?.datetime)
  };
}

// Cache leve em memória: o painel auto-atualiza a cada 60s e pode estar
// aberto em várias telas ao mesmo tempo, mas o plano free da API só
// permite 10 req/min. Mesmo padrão de listarScriptsFavoritos().
let _cache = { ts: 0, data: null };

export async function listarMonitores() {
  if (_cache.data && Date.now() - _cache.ts < 60_000) return _cache.data;
  const monitores = (await client.getMonitors())
    .map(normalizar)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  _cache = { ts: Date.now(), data: monitores };
  return monitores;
}

// ---------- Uptime dos últimos dias (a lista de barrinhas) ----------

const DIAS_UPTIME = 30;

// Uma faixa por dia, da mais antiga para a de hoje, em horário local — a API
// devolve os ratios na mesma ordem em que as faixas foram pedidas, e é essa
// ordem que a tela usa (esquerda = mais antigo).
function faixasDiarias() {
  const meiaNoite = new Date();
  meiaNoite.setHours(0, 0, 0, 0);
  const faixas = [];
  for (let i = DIAS_UPTIME - 1; i >= 0; i--) {
    const ini = new Date(meiaNoite);
    ini.setDate(ini.getDate() - i);
    const fim = new Date(ini);
    fim.setDate(fim.getDate() + 1);
    faixas.push({
      dia: `${ini.getFullYear()}-${String(ini.getMonth() + 1).padStart(2, '0')}-${String(ini.getDate()).padStart(2, '0')}`,
      ini: Math.floor(ini.getTime() / 1000),
      fim: Math.floor(fim.getTime() / 1000) - 1
    });
  }
  return faixas;
}

function ratio(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A página de status já entrega 90 dias prontos e em ~2s. É a fonte principal;
// só o "sem histórico" dela é aproveitado (label "black", dia anterior à
// criação do monitor) — as cores da tela continuam sendo as nossas.
async function uptimeDaPsp() {
  const monitores = await statusPage.getStatusPage();
  return monitores.map((m) => ({
    id: m.monitorId,
    ratio: ratio(m['90dRatio']?.ratio),
    dias: (m.dailyRatios || []).map((d) => ({
      dia: d.date,
      ratio: d.label === 'black' ? null : ratio(d.ratio)
    }))
  }));
}

// Plano B, caso a página de status (endpoint não documentado) pare de atender:
// monta os mesmos dias pela API v2 oficial. Custa ~12s e cobre 30 dias.
async function uptimeDaApiV2() {
  const faixas = faixasDiarias();
  const monitores = await client.getMonitorsUptime({
    ratios: String(DIAS_UPTIME),
    ranges: faixas.map((f) => f.ini + '_' + f.fim).join('-')
  });

  return monitores.map((m) => {
    const porFaixa = String(m.custom_uptime_ranges ?? '').split('-');
    const criadoEm = Number(m.create_datetime) || 0;
    return {
      id: m.id,
      ratio: ratio(m.custom_uptime_ratio),
      dias: faixas.map((f, i) => ({
        dia: f.dia,
        // Dia que terminou antes do monitor existir não tem histórico: a API
        // manda 0.000, e na tela isso pareceria queda de um dia inteiro.
        ratio: f.fim < criadoEm ? null : ratio(porFaixa[i])
      }))
    };
  });
}

// Cache próprio, separado do dos cards: um % de 90 dias não muda de minuto em
// minuto, e assim o auto-refresh de 60s dos cards não puxa isto junto.
let _cacheUptime = { ts: 0, data: null };

export async function listarUptime() {
  if (_cacheUptime.data && Date.now() - _cacheUptime.ts < 5 * 60_000) return _cacheUptime.data;

  let data;
  try {
    data = await uptimeDaPsp();
  } catch {
    // Sem página de status configurada (ou fora do ar): a v2 responde o mesmo
    // formato, só que com menos dias. Se ela também falhar, o erro sobe e a
    // rota devolve 502 — a tela mostra o aviso inline.
    data = await uptimeDaApiV2();
  }

  _cacheUptime = { ts: Date.now(), data };
  return data;
}
