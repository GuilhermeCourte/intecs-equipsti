// ============================================================
//  E-mail de chamado — a "ficha" do chamado em HTML.
//
//  Dois destinos, duas molduras:
//   • solicitante → identidade do portal /chamados, em cards com ícones.
//     Para ele o e-mail é o ÚNICO canal: o portal não tem sininho.
//   • equipe      → moldura do admin (branca, cabeçalho escuro), ficha enxuta.
//
//  Tudo em tabela com estilo inline: cliente de e-mail não suporta flex/grid,
//  webfont externa nem <style> confiável. Ícone é PNG hospedado — SVG inline o
//  Gmail remove, e data: URI ele bloqueia.
// ============================================================

// Escapa texto para inserir com segurança no HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Paleta do portal (public/chamados.html) — mantida em sincronia manualmente.
const P = {
  papel: '#F7F6F3', surface: '#FFFFFF', ink: '#1C1917', muted: '#78716C',
  faint: '#A8A29E', linha: '#E7E5E0', cta: '#D45C0D', indigo: '#5B45E0',
  cartao: '#F5F4F8' // fundo dos cards internos; igual ao assado nos PNGs de ícone
};

// Fundo do cabeçalho. Cliente de e-mail é irregular com gradiente: Apple Mail e
// iOS renderizam, o Outlook (motor do Word) ignora background-image por
// completo. Por isso a cor sólida vai separada em background-color e em
// bgcolor — quem não entende o gradiente ainda recebe um azul escuro, e o logo
// branco continua legível. Não usar o atalho 'background:', que sobrescreve a
// reserva nos clientes que entendem só parte da regra.
const HEADER_COR_RESERVA = '#2C36E8'; // azul do meio do linear-gradient

// Faixa do e-mail da equipe: chapada, sem gradiente. Distingue de relance o
// aviso interno da conversa com o usuário, sem mudar mais nada no corpo.
const CABECALHO_EQUIPE = '#2b2b2b';
const HEADER_GRADIENTE = [
  'radial-gradient(620px 620px at -10% 30%, #F97C26 0%, rgba(249, 124, 38, .55) 30%, rgba(249, 124, 38, 0) 60%)',
  'radial-gradient(200px 200px at 72% 34%, rgba(250, 140, 60, .95) 0%, rgba(160, 90, 190, .55) 55%, rgba(44, 54, 232, 0) 80%)',
  'radial-gradient(640px 540px at 96% 114%, rgba(18, 14, 106, .95) 0%, rgba(18, 14, 106, 0) 60%)',
  'linear-gradient(160deg, #3B45F2 0%, #2C36E8 52%, #241F9E 100%)'
].join(', ');

// Selos de status, espelhando --ok/--warn/--danger/--info/--neutral do portal.
const SELO_POR_TIPO = {
  ABERTO:    { bg: '#EFEDE9', fg: '#57534E' },
  ANDAMENTO: { bg: '#EDEBFA', fg: '#4A3BD1' },
  RESOLVIDO: { bg: '#E6F4EA', fg: '#1A7F37' },
  FECHADO:   { bg: '#EFEDE9', fg: '#57534E' },
  CANCELADO: { bg: '#FBECEA', fg: '#B3261E' }
};
const SELO_POR_PRIORIDADE = {
  BAIXA:   { bg: '#E6F4EA', fg: '#1A7F37' },
  MEDIA:   { bg: '#FCF3E0', fg: '#9A6700' },
  ALTA:    { bg: '#FAEEE1', fg: '#B4530F' },
  CRITICA: { bg: '#FBECEA', fg: '#B3261E' }
};

const FONTE = "'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const ORIGEM = (process.env.WEBAUTHN_ORIGIN || '').replace(/\/+$/, '');
const LOGO_URL = process.env.EMAIL_LOGO_URL
  || (/^https:\/\//i.test(ORIGEM) ? `${ORIGEM}/logo_intecs.png` : '');

// Ícones em public/icons/email (gerados a partir do Phosphor, ver README lá).
// Cada PNG tem 2x o tamanho de exibição e já traz assado o fundo sobre o qual
// aparece — não dá para contar com PNG transparente no Outlook.
const iconeUrl = (nome) => (ORIGEM ? `${ORIGEM}/icons/email/${nome}.png` : '');

// <img> do ícone. alt vazio de propósito: é decoração, o rótulo ao lado já diz
// o que é, e leitor de tela não deve ler duas vezes.
function icone(nome, tamanho) {
  const url = iconeUrl(nome);
  if (!url) return '';
  return `<img src="${esc(url)}" width="${tamanho}" height="${tamanho}" alt=""
    style="display:block;border:0;width:${tamanho}px;height:${tamanho}px;">`;
}

// Rótulo legível a partir do nome cru do status (AGUARDANDO_USUARIO -> Aguardando usuário).
const ACENTOS = { USUARIO: 'usuário', ANALISE: 'análise' };
const rotular = (v) => {
  if (!v) return '—';
  const partes = String(v).split('_').map((p) => ACENTOS[p] || p.toLowerCase());
  const texto = partes.join(' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
};

// Datas sempre em horário de Brasília: o banco grava SYSUTCDATETIME().
const dataBr = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
};

function selo({ texto, bg, fg }) {
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;`
    + `font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:5px 11px;`
    + `border-radius:999px;margin-right:6px;">${esc(texto)}</span>`;
}

// ---------- blocos do e-mail do solicitante ----------

// Tiles do cabeçalho, um por tipo de evento — o ícone e a cor dizem o que
// aconteceu antes da pessoa ler o texto. As cores saem da mesma paleta de
// status dos selos, então o topo nunca contradiz o selo logo abaixo.
// Ver a tabela em public/icons/email/README.md.
const TILES = new Set(['recibo', 'resposta', 'resolvido', 'aguardando', 'fechado', 'cancelado', 'generico']);

// Cabeçalho de conteúdo: tile do ícone à esquerda, manchete e chamada à direita.
function tituloHtml({ titulo, chamada, tile: nomeTile }) {
  const tile = icone(`topo-${TILES.has(nomeTile) ? nomeTile : 'generico'}`, 56);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${tile ? `<td width="56" valign="top" style="padding-right:16px;">${tile}</td>` : ''}
    <td valign="top">
      <h1 style="margin:0;font-size:22px;line-height:1.25;font-weight:800;color:${P.ink};">${esc(titulo)}</h1>
      ${chamada ? `<p style="margin:8px 0 0;font-size:14px;line-height:1.5;color:${P.muted};">${esc(chamada)}</p>` : ''}
    </td>
  </tr></table>`;
}

// Card do chamado: tile do clipboard, "#id — titulo" e os selos.
function cardChamadoHtml(chamado) {
  const tipoStatus = chamado.tipo_sistema_status || 'ABERTO';
  const seloStatus = SELO_POR_TIPO[tipoStatus] || SELO_POR_TIPO.ABERTO;
  const seloPrio = SELO_POR_PRIORIDADE[String(chamado.prioridade || '').toUpperCase()]
    || SELO_POR_PRIORIDADE.MEDIA;
  const tile = icone('chamado', 44);

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="background:${P.cartao};border-radius:14px;"><tr>
    <td style="padding:16px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        ${tile ? `<td width="44" valign="top" style="padding-right:14px;">${tile}</td>` : ''}
        <td valign="top">
          <div style="font-size:16px;font-weight:700;line-height:1.35;color:${P.ink};word-break:break-word;">
            #${esc(chamado.id)} — ${esc(chamado.titulo)}</div>
          <div style="margin-top:10px;">
            ${selo({ texto: rotular(chamado.status), ...seloStatus })}${selo({ texto: rotular(chamado.prioridade), ...seloPrio })}
          </div>
        </td>
      </tr></table>
    </td>
  </tr></table>`;
}

// Uma célula do grid: ícone + rótulo em maiúsculas + valor.
function celulaInfo({ icone: nome, rotulo, valor }) {
  const img = icone(nome, 22);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${img ? `<td width="22" valign="top" style="padding:2px 10px 0 0;">${img}</td>` : ''}
    <td valign="top">
      <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${P.indigo};">${esc(rotulo)}</div>
      <div style="font-size:14px;line-height:1.4;color:${P.ink};margin-top:3px;word-break:break-word;">${esc(valor)}</div>
    </td>
  </tr></table>`;
}

// Grid de duas colunas com POSIÇÕES FIXAS: cada campo tem seu lugar, e campo
// vazio vira célula em branco em vez de puxar os de baixo. Assim a leitura é
// sempre a mesma, chamado com ou sem equipamento vinculado.
function gridInfoHtml(chamado, equipamento) {
  const categoria = [chamado.categoria_nome, chamado.subcategoria_nome].filter(Boolean).join(' › ');
  const local = [chamado.unidade, chamado.departamento].filter(Boolean).join(' · ');

  const preenchido = (c) => c && c.valor && c.valor !== '—';
  const grade = [
    [{ icone: 'unidade', rotulo: 'Unidade', valor: local },
     { icone: 'solicitante', rotulo: 'Solicitante', valor: chamado.criado_por }],
    [{ icone: 'equipamento', rotulo: 'Equipamento', valor: equipamento },
     { icone: 'categoria', rotulo: 'Categoria', valor: categoria }],
    [{ icone: 'responsavel', rotulo: 'Responsável', valor: chamado.responsavel_email },
     { icone: 'aberto', rotulo: 'Aberto em', valor: dataBr(chamado.criado_em) }]
  ];

  let linhas = '';
  for (const [esq, dir] of grade) {
    // Linha inteira vazia sai fora: buraco de uma célula preserva a coluna,
    // mas de duas só produziria um vão vertical sem informação nenhuma.
    if (!preenchido(esq) && !preenchido(dir)) continue;
    linhas += `<tr>
      <td width="50%" valign="top" style="padding:0 10px 20px 0;">${preenchido(esq) ? celulaInfo(esq) : '&nbsp;'}</td>
      <td width="50%" valign="top" style="padding:0 0 20px 10px;">${preenchido(dir) ? celulaInfo(dir) : '&nbsp;'}</td>
    </tr>`;
  }
  if (!linhas) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="margin-top:24px;">${linhas}</table>`;
}

// Prazo do SLA em destaque, centralizado na própria faixa.
function prazoHtml(chamado) {
  const prazo = dataBr(chamado.sla_conclusao_prazo);
  if (prazo === '—') return '';
  const img = icone('prazo', 22);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="background:${P.cartao};border-radius:14px;"><tr>
    <td align="center" style="padding:16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${img ? `<td width="22" valign="middle" style="padding-right:12px;">${img}</td>` : ''}
        <td align="left">
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${P.indigo};">Prazo de conclusão</div>
          <div style="font-size:14px;color:${P.ink};margin-top:3px;">${esc(prazo)}</div>
        </td>
      </tr></table>
    </td>
  </tr></table>`;
}

// Bloco do evento: o comentário novo ou a transição de status, em card.
function eventoHtml({ comentario, autor, mudancas }) {
  const corpo = comentario
    ? `<div style="font-size:14px;line-height:1.55;color:${P.ink};white-space:pre-wrap;word-break:break-word;">${esc(comentario)}</div>`
    : (Array.isArray(mudancas) && mudancas.length
      ? mudancas.map((m) => `<div style="font-size:14px;line-height:1.6;color:${P.ink};">
          <span style="color:${P.faint};text-decoration:line-through;">${esc(rotular(m.de))}</span>
          <span style="color:${P.faint};padding:0 8px;">&rarr;</span>
          <strong>${esc(rotular(m.para))}</strong></div>`).join('')
      : '');
  if (!corpo) return '';

  const img = icone(comentario ? 'comentario' : 'status', 22);
  const legenda = comentario
    ? `<strong style="color:${P.ink};">${esc(autor)}</strong> comentou:`
    : `Alterado por <strong style="color:${P.ink};">${esc(autor)}</strong>:`;

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="background:${P.cartao};border-radius:14px;"><tr>
    <td style="padding:16px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        ${img ? `<td width="22" valign="top" style="padding:1px 12px 0 0;">${img}</td>` : ''}
        <td valign="top">
          <div style="font-size:12px;color:${P.muted};margin-bottom:6px;">${legenda}</div>
          ${corpo}
        </td>
      </tr></table>
    </td>
  </tr></table>`;
}

// Botão do CTA. Usa tabela + fundo sólido: <a> estilizado some no Outlook.
function botaoHtml(url, texto) {
  if (!url) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"
      style="margin:26px auto 4px;"><tr>
    <td align="center" style="background:${P.cta};border-radius:10px;">
      <a href="${esc(url)}" style="display:inline-block;padding:13px 30px;font-family:${FONTE};
         font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(texto)}</a>
    </td></tr></table>`;
}

// Espaçador vertical entre os cards.
const respiro = (px) => `<div style="height:${px}px;line-height:${px}px;font-size:0;">&nbsp;</div>`;

// Documento completo do e-mail. Solicitante e equipe compartilham TODO o corpo
// — a única diferença é a faixa do topo, e para onde o botão leva.
// 'cabecalhoEstilo' é passado inteiro pelo chamador porque o gradiente precisa
// de background-color e background-image separados (ver HEADER_GRADIENTE).
function montarDocumento({ chamado, titulo, chamada, autor, comentario, mudancas, equipamento, tile, url, cabecalhoBg, cabecalhoEstilo }) {
  const evento = eventoHtml({ comentario, autor, mudancas });
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<title>${esc(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${P.papel};-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${P.papel};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
          style="max-width:560px;width:100%;font-family:${FONTE};">

        <tr><td bgcolor="${cabecalhoBg}" style="${cabecalhoEstilo}padding:18px 26px;border-radius:14px 14px 0 0;">
          ${LOGO_URL ? `<img src="${esc(LOGO_URL)}" alt="Intecs" height="24" style="height:24px;width:auto;vertical-align:middle;border:0;margin-right:10px;display:inline-block;">` : ''}<span style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:.3px;vertical-align:middle;">GTI · Chamados</span>
        </td></tr>

        <tr><td style="background:${P.surface};padding:26px;border:1px solid ${P.linha};border-top:0;border-radius:0 0 14px 14px;">
          ${tituloHtml({ titulo, chamada, tile })}
          ${evento ? respiro(22) + evento : ''}
          ${respiro(18)}
          ${cardChamadoHtml(chamado)}
          ${gridInfoHtml(chamado, equipamento)}
          ${prazoHtml(chamado)}
          ${botaoHtml(url, 'Ver chamado')}
        </td></tr>

        <tr><td style="padding:18px 26px 6px;text-align:center;font-size:12px;line-height:1.6;color:${P.faint};">
          Mensagem automática do sistema de Gestão TI.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * E-mail para o SOLICITANTE, com a identidade do portal /chamados.
 * A interação (comentário / mudança de status) vem ANTES da ficha: é o que ele
 * abriu o e-mail para ler; a ficha é contexto de apoio.
 * @param {object} o
 * @param {object} o.chamado      linha de getChamadoIntecs()
 * @param {string} o.titulo       manchete (ex.: 'Seu chamado foi resolvido')
 * @param {string} [o.chamada]    frase de abertura
 * @param {string} [o.autor]      quem executou a ação
 * @param {string} [o.comentario] texto do comentário novo
 * @param {Array}  [o.mudancas]   [{de, para}] da transição de status
 * @param {string} [o.equipamento]
 * @param {string} [o.tile]  qual tile do cabeçalho: 'recibo' | 'resposta' |
 *   'resolvido' | 'aguardando' | 'fechado' | 'cancelado'. Vazio ou desconhecido
 *   cai no 'generico'.
 * @returns {{subject:string, html:string, text:string}}
 */
export function emailParaSolicitante(o) {
  const url = ORIGEM ? `${ORIGEM}/chamados?chamado=${o.chamado.id}` : '';
  return {
    subject: `[Chamado #${o.chamado.id}] ${o.titulo}`,
    html: montarDocumento({
      ...o, url,
      cabecalhoBg: HEADER_COR_RESERVA,
      cabecalhoEstilo: `background-color:${HEADER_COR_RESERVA};background-image:${HEADER_GRADIENTE};`
    }),
    text: textoChamado({ ...o, url })
  };
}

/**
 * E-mail para a EQUIPE — mesmo corpo do solicitante, só o topo muda: faixa
 * chapada #2b2b2b em vez do gradiente da marca, para separar de relance o que é
 * aviso interno do que é conversa com o usuário. O botão leva para o admin, não
 * para o portal: é lá que a equipe atende.
 * @returns {{html:string, texto:string}}
 */
export function emailParaEquipe(o) {
  const url = ORIGEM ? `${ORIGEM}/#tab-chamados` : '';
  return {
    html: montarDocumento({
      ...o, url,
      cabecalhoBg: CABECALHO_EQUIPE,
      cabecalhoEstilo: `background-color:${CABECALHO_EQUIPE};`
    }),
    texto: textoChamado({ ...o, url })
  };
}

// Versão texto puro — fallback para cliente que não renderiza HTML.
function textoChamado({ chamado, titulo, chamada, autor, comentario, mudancas, equipamento, url }) {
  const linhas = [titulo, ''];
  if (chamada) linhas.push(chamada, '');
  if (comentario) linhas.push(`${autor} comentou:`, comentario, '');
  else if (Array.isArray(mudancas) && mudancas.length) {
    linhas.push(`Alterado por ${autor}:`);
    mudancas.forEach((m) => linhas.push(`  ${rotular(m.de)} -> ${rotular(m.para)}`));
    linhas.push('');
  }
  linhas.push(`Chamado #${chamado.id} — ${chamado.titulo}`);
  linhas.push(`Status: ${rotular(chamado.status)}   Prioridade: ${rotular(chamado.prioridade)}`);
  if (chamado.criado_por) linhas.push(`Solicitante: ${chamado.criado_por}`);
  const local = [chamado.unidade, chamado.departamento].filter(Boolean).join(' · ');
  if (local) linhas.push(`Unidade: ${local}`);
  const categoria = [chamado.categoria_nome, chamado.subcategoria_nome].filter(Boolean).join(' > ');
  if (categoria) linhas.push(`Categoria: ${categoria}`);
  if (equipamento) linhas.push(`Equipamento: ${equipamento}`);
  if (chamado.responsavel_email) linhas.push(`Responsável: ${chamado.responsavel_email}`);
  linhas.push(`Aberto em: ${dataBr(chamado.criado_em)}`);
  const prazo = dataBr(chamado.sla_conclusao_prazo);
  if (prazo !== '—') linhas.push(`Prazo de conclusão: ${prazo}`);
  if (url) linhas.push('', `Ver chamado: ${url}`);
  return linhas.join('\n');
}

export { rotular, dataBr };
