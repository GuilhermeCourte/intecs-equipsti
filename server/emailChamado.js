// ============================================================
//  E-mail de chamado — a "ficha" do chamado em HTML.
//
//  Dois destinos, duas molduras:
//   • solicitante → identidade do portal /chamados (papel quente, CTA laranja).
//     Para ele o e-mail é o ÚNICO canal: o portal não tem sininho.
//   • equipe      → moldura do admin (branca, cabeçalho escuro).
//
//  Tudo em tabela com estilo inline: cliente de e-mail não suporta flex/grid,
//  webfont externa nem <style> confiável.
// ============================================================

// Escapa texto para inserir com segurança no HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Paleta do portal (public/chamados.html) — mantida em sincronia manualmente.
const P = {
  papel: '#F7F6F3', surface: '#FFFFFF', ink: '#1C1917', muted: '#78716C',
  faint: '#A8A29E', linha: '#E7E5E0', cta: '#D45C0D', indigo: '#5B45E0'
};

// Fundo do cabeçalho. Cliente de e-mail é irregular com gradiente: Apple Mail e
// iOS renderizam, o Outlook (motor do Word) ignora background-image por
// completo. Por isso a cor sólida vai separada em background-color e em
// bgcolor — quem não entende o gradiente ainda recebe um azul escuro, e o logo
// branco continua legível. Não usar o atalho 'background:', que sobrescreve a
// reserva nos clientes que entendem só parte da regra.
const HEADER_COR_RESERVA = '#2C36E8'; // azul do meio do linear-gradient
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

// Linha "rótulo / valor" da ficha. Em tabela para não depender de flex.
function linhaFicha(rotulo, valor, ultima) {
  if (valor == null || valor === '' || valor === '—') return '';
  const borda = ultima ? '' : `border-bottom:1px solid ${P.linha};`;
  return `<tr>
    <td style="padding:9px 0;${borda}width:38%;vertical-align:top;font-size:12px;color:${P.muted};
        text-transform:uppercase;letter-spacing:.5px;">${esc(rotulo)}</td>
    <td style="padding:9px 0;${borda}font-size:14px;color:${P.ink};font-weight:600;
        word-break:break-word;">${esc(valor)}</td>
  </tr>`;
}

// Ficha do chamado: selos + dados. 'chamado' vem de getChamadoIntecs().
function fichaHtml(chamado, equipamento) {
  const tipoStatus = chamado.tipo_sistema_status || 'ABERTO';
  const seloStatus = SELO_POR_TIPO[tipoStatus] || SELO_POR_TIPO.ABERTO;
  const seloPrio = SELO_POR_PRIORIDADE[String(chamado.prioridade || '').toUpperCase()]
    || SELO_POR_PRIORIDADE.MEDIA;

  const categoria = [chamado.categoria_nome, chamado.subcategoria_nome].filter(Boolean).join(' › ');
  const local = [chamado.unidade, chamado.departamento].filter(Boolean).join(' · ');

  const linhas = [
    linhaFicha('Solicitante', chamado.criado_por),
    linhaFicha('Unidade', local),
    linhaFicha('Categoria', categoria),
    linhaFicha('Equipamento', equipamento),
    linhaFicha('Responsável', chamado.responsavel_email),
    linhaFicha('Aberto em', dataBr(chamado.criado_em)),
    linhaFicha('Prazo de conclusão', dataBr(chamado.sla_conclusao_prazo), true)
  ].filter(Boolean).join('');

  return `${selo({ texto: rotular(chamado.status), ...seloStatus })}`
    + `${selo({ texto: rotular(chamado.prioridade), ...seloPrio })}`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="margin-top:16px;border-collapse:collapse;">${linhas}</table>`;
}

// Bloco do evento: comentário novo (com barra lateral) ou a transição de status.
function eventoHtml({ comentario, autor, mudancas }) {
  if (comentario) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="margin-top:18px;"><tr>
      <td style="border-left:3px solid ${P.cta};padding:2px 0 2px 14px;">
        <div style="font-size:12px;color:${P.muted};margin-bottom:5px;">
          <strong style="color:${P.ink};">${esc(autor)}</strong> comentou:</div>
        <div style="font-size:14px;line-height:1.55;color:${P.ink};white-space:pre-wrap;
            word-break:break-word;">${esc(comentario)}</div>
      </td></tr></table>`;
  }
  if (Array.isArray(mudancas) && mudancas.length) {
    const linhas = mudancas.map((m) => `<div style="font-size:14px;line-height:1.6;color:${P.ink};">
      <span style="color:${P.faint};text-decoration:line-through;">${esc(rotular(m.de))}</span>
      <span style="color:${P.faint};padding:0 8px;">&rarr;</span>
      <strong>${esc(rotular(m.para))}</strong></div>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="margin-top:18px;"><tr>
      <td style="border-left:3px solid ${P.cta};padding:2px 0 2px 14px;">
        <div style="font-size:12px;color:${P.muted};margin-bottom:5px;">
          Alterado por <strong style="color:${P.ink};">${esc(autor)}</strong>:</div>
        ${linhas}
      </td></tr></table>`;
  }
  return '';
}

// Botão do CTA. Usa tabela + fundo sólido: <a> estilizado some no Outlook.
function botaoHtml(url, texto) {
  if (!url) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"
      style="margin:24px auto 4px;"><tr>
    <td align="center" style="background:${P.cta};border-radius:10px;">
      <a href="${esc(url)}" style="display:inline-block;padding:13px 30px;font-family:${FONTE};
         font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(texto)}</a>
    </td></tr></table>`;
}

/**
 * E-mail para o SOLICITANTE, com a identidade do portal /chamados.
 * @param {object} o
 * @param {object} o.chamado      linha de getChamadoIntecs()
 * @param {string} o.titulo       manchete (ex.: 'Seu chamado foi resolvido')
 * @param {string} [o.chamada]    frase de abertura
 * @param {string} [o.autor]      quem executou a ação
 * @param {string} [o.comentario] texto do comentário novo
 * @param {Array}  [o.mudancas]   [{de, para}] da transição de status
 * @param {string} [o.equipamento]
 * @returns {{subject:string, html:string, text:string}}
 */
export function emailParaSolicitante({ chamado, titulo, chamada, autor, comentario, mudancas, equipamento }) {
  const url = ORIGEM ? `${ORIGEM}/chamados?chamado=${chamado.id}` : '';
  const cabecalho = `#${chamado.id} — ${chamado.titulo}`;

  const html = `<!DOCTYPE html>
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

        <tr><td bgcolor="${HEADER_COR_RESERVA}" style="background-color:${HEADER_COR_RESERVA};background-image:${HEADER_GRADIENTE};padding:18px 26px;border-radius:14px 14px 0 0;">
          ${LOGO_URL ? `<img src="${esc(LOGO_URL)}" alt="Intecs" height="24" style="height:24px;width:auto;vertical-align:middle;border:0;margin-right:10px;display:inline-block;">` : ''}<span style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:.3px;vertical-align:middle;">Gestão TI</span>
        </td></tr>

        <tr><td style="background:${P.surface};padding:26px;border:1px solid ${P.linha};border-top:0;border-radius:0 0 14px 14px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${P.indigo};">Chamado</div>
          <h1 style="margin:8px 0 0;font-size:21px;line-height:1.3;font-weight:800;color:${P.ink};">${esc(titulo)}</h1>
          ${chamada ? `<p style="margin:10px 0 0;font-size:15px;line-height:1.55;color:${P.muted};">${esc(chamada)}</p>` : ''}

          <div style="margin-top:22px;padding-top:20px;border-top:1px solid ${P.linha};">
            <div style="font-size:16px;font-weight:700;color:${P.ink};margin-bottom:12px;word-break:break-word;">${esc(cabecalho)}</div>
            ${fichaHtml(chamado, equipamento)}
          </div>

          ${eventoHtml({ comentario, autor, mudancas })}
          ${botaoHtml(url, 'Ver chamado')}
        </td></tr>

        <tr><td style="padding:18px 26px 6px;text-align:center;font-size:12px;line-height:1.6;color:${P.faint};">
          Você recebeu este aviso porque abriu o chamado #${chamado.id}.<br>
          Mensagem automática do sistema de Gestão TI.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: `[Chamado #${chamado.id}] ${titulo}`, html, text: textoChamado({ chamado, titulo, chamada, autor, comentario, mudancas, equipamento, url }) };
}

// Versão texto puro — fallback para cliente que não renderiza HTML.
function textoChamado({ chamado, titulo, chamada, autor, comentario, mudancas, equipamento, url }) {
  const linhas = [titulo, ''];
  if (chamada) linhas.push(chamada, '');
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
  if (comentario) linhas.push('', `${autor} comentou:`, comentario);
  else if (Array.isArray(mudancas) && mudancas.length) {
    linhas.push('', `Alterado por ${autor}:`);
    mudancas.forEach((m) => linhas.push(`  ${rotular(m.de)} -> ${rotular(m.para)}`));
  }
  if (url) linhas.push('', `Ver chamado: ${url}`);
  return linhas.join('\n');
}

/**
 * Corpo do e-mail para a EQUIPE — mesma ficha, moldura do admin.
 * @returns {{conteudoHtml:string, texto:string}}
 */
export function corpoChamadoEquipe({ chamado, chamada, autor, comentario, mudancas, equipamento }) {
  const url = ORIGEM ? `${ORIGEM}/#tab-chamados` : '';
  const conteudoHtml =
    (chamada ? `<p style="margin:0 0 16px;">${esc(chamada)}</p>` : '')
    + `<div style="font-size:16px;font-weight:700;color:${P.ink};margin-bottom:12px;word-break:break-word;">`
    + `#${chamado.id} — ${esc(chamado.titulo)}</div>`
    + fichaHtml(chamado, equipamento)
    + eventoHtml({ comentario, autor, mudancas })
    + botaoHtml(url, 'Abrir no Gestão TI');
  return {
    conteudoHtml,
    texto: textoChamado({ chamado, titulo: chamada || 'Chamado', chamada: null, autor, comentario, mudancas, equipamento, url })
  };
}

export { rotular, dataBr };
