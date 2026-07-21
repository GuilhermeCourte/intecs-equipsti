// ============================================================
//  Serviço de notificações (sininho + e-mail).
//
//  Regra de negócio: notifica todos os usuários ATIVOS, exceto quem
//  executou a ação. O sininho recebe TODOS os eventos; o e-mail só é
//  enviado quando email=true (empréstimos e chamados).
//
//  notificar() NUNCA lança — qualquer falha é apenas logada, para nunca
//  quebrar a operação principal (criar registro, empréstimo, chamado...).
// ============================================================
import { query, sql } from './db.js';
import { enviarEmail } from './email.js';
import { emailParaSolicitante } from './emailChamado.js';

const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });

// Escapa texto para inserir com segurança no HTML do e-mail.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rótulo amigável do tipo (usado como "tag" no e-mail).
const TIPO_LABEL = { REGISTRO: 'Registro', EMPRESTIMO: 'Empréstimo', CHAMADO: 'Chamado' };

// URL pública do logo no e-mail (precisa ser acessível pela internet, https).
// Defina EMAIL_LOGO_URL no .env; senão é derivada de WEBAUTHN_ORIGIN quando https.
const _emailOrigin = (process.env.WEBAUTHN_ORIGIN || '').replace(/\/+$/, '');
const LOGO_URL = process.env.EMAIL_LOGO_URL
  || (/^https:\/\//i.test(_emailOrigin) ? `${_emailOrigin}/logo_intecs.png` : '');

// Template de e-mail HTML personalizado (branded "Gestão TI"). Layout em tabela
// com estilos inline, para máxima compatibilidade entre clientes de e-mail.
// 'conteudoHtml' e 'rodapeHtml' já devem vir como HTML (escapados pelo chamador).
function montarEmailHtml({ tag, titulo, conteudoHtml, rodapeHtml }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<title>${esc(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;width:100%;background:#ffffff;border:1px solid #e4e4e4;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <!-- Cabeçalho da marca -->
        <tr><td style="background:#2b2b2b;padding:18px 28px;">
          ${LOGO_URL ? `<img src="${esc(LOGO_URL)}" alt="Intecs" height="26" style="height:26px;width:auto;vertical-align:middle;border:0;margin-right:10px;display:inline-block;">` : ''}<span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.4px;vertical-align:middle;">Gestão TI</span>
        </td></tr>
        <!-- Corpo -->
        <tr><td style="padding:28px 28px 6px;">
          ${tag ? `<span style="display:inline-block;border:1px solid #e4e4e4;color:#6b6b6b;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding:3px 11px;border-radius:999px;">${esc(tag)}</span>` : ''}
          <h1 style="margin:14px 0 0;font-size:20px;line-height:1.3;font-weight:700;color:#2b2b2b;">${esc(titulo)}</h1>
        </td></tr>
        <tr><td style="padding:12px 28px 4px;font-size:15px;line-height:1.55;color:#3a3a3a;">
          ${conteudoHtml}
        </td></tr>
        <!-- Rodapé -->
        <tr><td style="padding:18px 28px 26px;">
          <div style="border-top:1px solid #e4e4e4;padding-top:16px;font-size:12px;line-height:1.6;color:#9a9a9a;">
            ${rodapeHtml ? `<div style="margin-bottom:6px;">${rodapeHtml}</div>` : ''}
            <div>Mensagem automática do sistema de Gestão TI</div>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Bloco visual de alterações (valor antigo riscado → valor novo em destaque).
function renderMudancasHtml(mudancas) {
  if (!Array.isArray(mudancas) || !mudancas.length) return '';
  const linhas = mudancas.map((m, i) => `
    <tr><td style="padding:8px 0;${i < mudancas.length - 1 ? 'border-bottom:1px solid #f0f0f0;' : ''}">
      <div style="font-size:11px;color:#9a9a9a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">${esc(m.campo)}</div>
      <div style="font-size:14px;line-height:1.4;">
        <span style="color:#9a9a9a;text-decoration:line-through;">${esc(m.de || '—')}</span>
        <span style="color:#cfcfcf;padding:0 8px;font-weight:700;">&rarr;</span>
        <span style="color:#2b2b2b;font-weight:700;">${esc(m.para || '—')}</span>
      </div>
    </td></tr>`).join('');
  return `<div style="margin:6px 0 2px;">`
    + `<div style="font-size:12px;font-weight:700;color:#6b6b6b;text-transform:uppercase;letter-spacing:.5px;">Alterações</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${linhas}</table>`
    + `</div>`;
}

// Versão texto puro das alterações (fallback do e-mail).
function renderMudancasTxt(mudancas) {
  if (!Array.isArray(mudancas) || !mudancas.length) return '';
  return '\n\nAlterações:\n' + mudancas.map((m) => `- ${m.campo}: ${m.de || '—'} -> ${m.para || '—'}`).join('\n');
}

// Aceita apenas endereços sintaticamente válidos — um registro malformado no
// cadastro faria o servidor recusar a mensagem inteira.
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

// Fragmento SQL que restringe destinatários por papel e/ou por id, acumulando
// os parâmetros em 'params'. Prefixo evita colisão quando o mesmo params serve
// a dois filtros.
//
// A distinção que importa: NÃO pedir escopo (campos ausentes) significa "todos
// os ativos" — o padrão de Registros/Empréstimos. Pedir escopo e ele resolver
// vazio (ex.: [] e [] quando o chamado não tem responsável) significa
// "ninguém". Sem isso, um escopo vazio cairia no padrão e mandaria e-mail para
// a empresa inteira, que é o oposto do pedido.
function filtroDestinatarios({ papeis, usuarioIds }, params, prefixo = '') {
  const pediuEscopo = papeis !== undefined || usuarioIds !== undefined;
  const condicoes = [];

  const listaPapeis = Array.isArray(papeis) ? papeis.filter(Boolean) : [];
  if (listaPapeis.length) {
    listaPapeis.forEach((p, i) => { params[`${prefixo}papel${i}`] = S(p); });
    condicoes.push(`role IN (${listaPapeis.map((_, i) => `@${prefixo}papel${i}`).join(', ')})`);
  }

  const listaIds = (Array.isArray(usuarioIds) ? usuarioIds : []).map(Number).filter(Boolean);
  if (listaIds.length) {
    listaIds.forEach((id, i) => { params[`${prefixo}uid${i}`] = id; });
    condicoes.push(`id IN (${listaIds.map((_, i) => `@${prefixo}uid${i}`).join(', ')})`);
  }

  if (condicoes.length) return `AND (${condicoes.join(' OR ')})`;
  return pediuEscopo ? 'AND 1 = 0' : '';
}

// Lista de e-mails que recebem a notificação: usuários ativos, exceto o autor.
// Sem 'papeis' nem 'usuarioIds' => todos (comportamento padrão). Com eles, o
// destino é a união dos dois — ex.: a equipe técnica + o dono do chamado.
async function destinatariosEmail({ atorId, papeis, usuarioIds }) {
  const params = { atorId };
  const filtro = filtroDestinatarios({ papeis, usuarioIds }, params);
  const r = await query(
    `SELECT DISTINCT email FROM dbo.EQUIPSTI_usuarios
      WHERE ativo = 1 AND id <> @atorId AND email IS NOT NULL ${filtro}`,
    params
  );
  return r.recordset.map((u) => u.email).filter(emailValido);
}

/**
 * @param {object} o
 * @param {'REGISTRO'|'EMPRESTIMO'|'CHAMADO'} o.tipo
 * @param {'CRIADO'|'ATUALIZADO'|'EXCLUIDO'|'DEVOLVIDO'|'TRANSFERIDO'} o.acao
 * @param {string} o.titulo      título curto (vira o assunto do e-mail)
 * @param {string} [o.mensagem]  detalhe (equipamento, PAT, unidade...)
 * @param {string} [o.link]      id da aba alvo (ex.: 'tab-registros')
 * @param {number} [o.refId]     id da entidade afetada
 * @param {{id:number,email:string}} o.ator  quem executou a ação
 * @param {boolean} [o.email]    também enviar e-mail?
 * @param {Array<{campo:string,de:string,para:string}>} [o.mudancas]  alterações (de → para) p/ o e-mail
 * @param {string[]} [o.emailPapeis]      restringe o e-mail a estes papéis (ex.: ['TECNICO','MASTER'])
 * @param {number[]} [o.emailUsuarioIds]  usuários que recebem o e-mail mesmo fora dos papéis (ex.: dono do chamado)
 * @param {string[]} [o.papeis]   restringe o SININHO a estes papéis (só quem tem a tela)
 * @param {{html:string, texto:string}} [o.corpo]  e-mail já montado (ex.: a ficha
 *   do chamado). Quando vem, substitui o template genérico inteiro.
 */
export async function notificar({ tipo, acao, titulo, mensagem, link, refId, ator, email = false, mudancas, emailPapeis, emailUsuarioIds, papeis, corpo }) {
  try {
    const atorId = Number(ator?.id) || 0;

    // 1) Sininho: insere uma linha por destinatário (ativos, exceto o autor).
    //    O fan-out acontece no próprio SQL via INSERT ... SELECT. 'papeis'
    //    limita a quem realmente tem sininho — gravar para quem só usa o
    //    portal /chamados seria linha que ninguém nunca vai ler.
    const paramsSino = {
      tipo: S(tipo), acao: S(acao), titulo: S(titulo), msg: S(mensagem),
      link: S(link), refId: refId == null ? null : Number(refId),
      ator: S(ator?.email), atorId
    };
    const filtroSino = filtroDestinatarios({ papeis }, paramsSino, 'sino_');
    await query(
      `INSERT INTO dbo.EQUIPSTI_notificacoes
         (usuario_id, tipo, acao, titulo, mensagem, link, ref_id, ator_email)
       SELECT id, @tipo, @acao, @titulo, @msg, @link, @refId, @ator
         FROM dbo.EQUIPSTI_usuarios
        WHERE ativo = 1 AND id <> @atorId ${filtroSino}`,
      paramsSino
    );

    // 2) E-mail (apenas quando email=true): BCC a todos os destinatários.
    //    O envio é AGUARDADO de propósito: em serverless (Vercel) a invocação
    //    congela assim que a resposta HTTP sai, e um disparo em segundo plano
    //    seria interrompido no meio do diálogo SMTP — o e-mail nunca chegava.
    if (email) {
      const dest = await destinatariosEmail({ atorId, papeis: emailPapeis, usuarioIds: emailUsuarioIds });
      if (dest.length) {
        const corpoPronto = corpo;                  // ficha do chamado, quando houver
        const corpoTexto = mensagem || titulo;      // fallback genérico
        const quem = ator?.email || 'sistema';
        try {
          await enviarEmail({
            bcc: dest,
            subject: `[Gestão TI] ${titulo}`,
            text: corpoPronto
              ? corpoPronto.texto
              : `${titulo}\n\n${corpoTexto}${renderMudancasTxt(mudancas)}\n\nAção realizada por: ${quem}`,
            // Corpo pronto já é o documento inteiro — quem monta sabe melhor que
            // o template genérico como aquele evento deve aparecer.
            html: corpoPronto
              ? corpoPronto.html
              : montarEmailHtml({
                tag: TIPO_LABEL[tipo] || 'Notificação',
                titulo,
                conteudoHtml: `<p style="margin:0 0 12px;">${esc(corpoTexto)}</p>` + renderMudancasHtml(mudancas),
                rodapeHtml: `Ação realizada por <strong style="color:#2b2b2b;">${esc(quem)}</strong>.`
              })
          });
        } catch (e) {
          // Falha de e-mail nunca derruba a operação principal, mas precisa
          // aparecer no log com a resposta do servidor para ser diagnosticável.
          console.error('[email] falhou:', e.responseCode || '', e.response || e.message);
        }
      }
    }
  } catch (err) {
    console.warn('[notificar] falhou:', err.message);
  }
}

/**
 * E-mail para quem ABRIU o chamado, com a identidade do portal /chamados.
 *
 * Vive fora de notificar() de propósito: o solicitante não tem sininho (o portal
 * não tem um), então aqui não há fan-out — é só e-mail, para uma pessoa. Também
 * nunca lança, pela mesma razão que notificar(): não pode derrubar a operação.
 *
 * @param {object} o
 * @param {object} o.chamado   linha de getChamadoIntecs()
 * @param {{id:number,email:string}} o.ator  quem executou a ação
 * @param {string} o.titulo    manchete do e-mail
 * @param {string} [o.chamada] frase de abertura
 * @param {string} [o.comentario]
 * @param {Array}  [o.mudancas]
 * @param {string} [o.equipamento]
 * @returns {Promise<boolean>} true se o e-mail saiu
 */
export async function notificarSolicitante({ chamado, ator, titulo, chamada, comentario, mudancas, equipamento, tile }) {
  try {
    const donoId = Number(chamado?.usuario_id) || 0;
    if (!donoId) return false;
    // Quem age não é avisado da própria ação — mesma regra do sininho.
    if (donoId === (Number(ator?.id) || 0)) return false;

    const r = await query(
      'SELECT email FROM dbo.EQUIPSTI_usuarios WHERE id = @id AND ativo = 1',
      { id: donoId }
    );
    // email_contato é o que ele digitou no formulário: vale como reserva
    // quando a conta não tem e-mail cadastrado.
    const destino = [r.recordset[0]?.email, chamado.email_contato].find(emailValido);
    if (!destino) return false;

    const { subject, html, text } = emailParaSolicitante({
      chamado, titulo, chamada, autor: ator?.email || 'a equipe de TI',
      comentario, mudancas, equipamento, tile
    });
    return await enviarEmail({ to: destino, subject, html, text });
  } catch (e) {
    console.error('[notificarSolicitante] falhou:', e.responseCode || '', e.response || e.message);
    return false;
  }
}

/**
 * Notificação de TESTE: cria no sininho do PRÓPRIO usuário e envia e-mail para
 * ele mesmo. Ao contrário de notificar(), aqui o objetivo é o autor VER o
 * resultado, então ele não é excluído.
 * @param {{id:number,email:string}} user
 * @returns {Promise<{emailEnviado:boolean, email:string}>}
 */
// Marca usado para identificar/limpar as notificações geradas pelo teste.
const ATOR_TESTE = 'simulação (teste)';

// Cenários de exemplo — mesmos formatos das notificações reais. 'email' indica
// se aquele tipo de evento envia e-mail na operação real (empréstimos/chamados).
const AMOSTRAS_TESTE = [
  { tipo: 'REGISTRO',   acao: 'CRIADO',     link: 'tab-registros',   email: false, titulo: 'Novo registro',           mensagem: 'NOTEBOOK — PAT 90001 · N/S SN-TST-01 · UNIDADE EXEMPLO' },
  { tipo: 'REGISTRO',   acao: 'ATUALIZADO', link: 'tab-registros',   email: false, titulo: 'Registro atualizado',     mensagem: 'MONITOR — PAT 90002', mudancas: [{ campo: 'Status', de: 'EM USO', para: 'MANUTENÇÃO' }, { campo: 'Setor', de: 'ADMINISTRATIVO', para: 'TI' }] },
  { tipo: 'EMPRESTIMO', acao: 'CRIADO',     link: 'tab-emprestimos', email: true,  titulo: 'Novo empréstimo',         mensagem: 'NOTEBOOK — PAT 90001 → UNIDADE FILIAL' },
  { tipo: 'EMPRESTIMO', acao: 'DEVOLVIDO',  link: 'tab-emprestimos', email: true,  titulo: 'Devolução de empréstimo', mensagem: 'NOTEBOOK — PAT 90001 devolvido a UNIDADE MATRIZ' },
  { tipo: 'EMPRESTIMO', acao: 'ATUALIZADO', link: 'tab-emprestimos', email: true,  titulo: 'Empréstimo atualizado',   mensagem: 'IMPRESSORA — PAT 90003', mudancas: [{ campo: 'Status', de: 'EMPRESTADO', para: 'DEVOLVIDO' }] },
  { tipo: 'CHAMADO',    acao: 'CRIADO',     link: 'tab-chamados',    email: true,  titulo: 'Chamado aberto',          mensagem: 'Troca de equipamento · MONITOR — PAT 90002 · nº 2025-000123' },
  { tipo: 'CHAMADO',    acao: 'ATUALIZADO', link: 'tab-chamados',    email: true,  titulo: 'Chamado atualizado',      mensagem: 'NOTEBOOK — PAT 90001 · nº 2025-000123', mudancas: [{ campo: 'Status INTECS', de: 'ABERTO', para: 'FINALIZADO' }, { campo: 'Data entrega', de: '—', para: '26/06/2026' }] },
];

/**
 * Gera notificações de TESTE simulando eventos reais (empréstimo novo/devolvido/
 * atualizado, chamado aberto/atualizado, registro...) no sininho do PRÓPRIO
 * usuário, e envia 1 e-mail de teste resumindo os cenários que enviam e-mail.
 * Cada clique substitui as simulações anteriores deste usuário (não acumula).
 * @param {{id:number,email:string}} user
 * @returns {Promise<{criadas:number, emailEnviado:boolean, email:string, erro:string|null}>}
 */
export async function notificarTeste(user) {
  const uid = Number(user?.id) || 0;
  const email = user?.email || '';

  // Sininho — limpa simulações anteriores deste usuário e insere o novo conjunto.
  await query(
    'DELETE FROM dbo.EQUIPSTI_notificacoes WHERE usuario_id = @uid AND ator_email = @ator',
    { uid, ator: S(ATOR_TESTE) }
  );
  for (const a of AMOSTRAS_TESTE) {
    await query(
      `INSERT INTO dbo.EQUIPSTI_notificacoes (usuario_id, tipo, acao, titulo, mensagem, link, ator_email)
       VALUES (@uid, @tipo, @acao, @titulo, @msg, @link, @ator)`,
      { uid, tipo: S(a.tipo), acao: S(a.acao), titulo: S(a.titulo), msg: S(a.mensagem), link: S(a.link), ator: S(ATOR_TESTE) }
    );
  }

  // E-mail — 1 mensagem ao próprio usuário, demonstrando como chegam por e-mail
  // os eventos que disparam e-mail na vida real (empréstimos e chamados).
  const comEmail = AMOSTRAS_TESTE.filter((a) => a.email);
  const linhasTxt = comEmail.map((a) => `• ${a.titulo}: ${a.mensagem}${renderMudancasTxt(a.mudancas)}`).join('\n\n');
  const cardsHtml = comEmail.map((a) =>
    `<div style="border:1px solid #eee;border-radius:12px;padding:14px 16px;margin-bottom:12px;">`
    + `<span style="display:inline-block;border:1px solid #e4e4e4;color:#6b6b6b;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding:2px 9px;border-radius:999px;">${esc(TIPO_LABEL[a.tipo] || 'Notificação')}</span>`
    + `<div style="font-weight:700;color:#2b2b2b;font-size:15px;margin-top:8px;">${esc(a.titulo)}</div>`
    + `<div style="color:#6b6b6b;font-size:13px;margin-top:3px;">${esc(a.mensagem)}</div>`
    + renderMudancasHtml(a.mudancas)
    + `</div>`).join('');

  let emailEnviado = false;
  let erro = null;
  try {
    emailEnviado = await enviarEmail({
      to: email,
      subject: '[Gestão TI · TESTE] Simulação de notificações',
      text: `Simulação de teste do sistema de notificações.\n\n`
          + `Cenários que enviam e-mail (empréstimos e chamados):\n${linhasTxt}\n\n`
          + `Na operação real, cada evento gera um e-mail próprio. Esta é só uma mensagem de teste.`,
      html: montarEmailHtml({
        tag: 'Teste',
        titulo: 'Simulação de notificações',
        conteudoHtml: `<p style="margin:0 0 14px;">Veja como ficam os e-mails de empréstimos e chamados, já com as alterações (de &rarr; para):</p>${cardsHtml}`,
        rodapeHtml: 'Na operação real, cada evento gera um e-mail próprio. Esta é apenas uma mensagem de teste.'
      })
    });
    if (!emailEnviado) erro = 'SMTP não configurado no .env (SMTP_HOST vazio).';
  } catch (e) {
    erro = e.response || e.message || String(e);
    console.warn('[notificarTeste email] falhou:', erro);
  }

  return { criadas: AMOSTRAS_TESTE.length, emailEnviado, email, erro };
}
