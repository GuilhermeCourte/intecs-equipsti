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
import { emitirTodos, emitirPara } from './realtime.js';
import { enviarPush } from './push.js';

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
// cadastro faria o servidor recusar a mensagem inteira. Exportado para quem
// valida endereços digitados à mão (e-mails extras do calendário) usar a mesma
// régua do envio, em vez de manter uma segunda regex que pode divergir.
export const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

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

// Lista de ids que recebem o PUSH: mesma regra do sininho (não a do e-mail) —
// o push existe pra estender o alcance do sininho a quando a tela está
// fechada, então segue o escopo dele ('papeis'/'sininhoUsuarioIds').
async function destinatariosPush({ atorId, papeis, usuarioIds }) {
  const params = { atorId };
  const filtro = filtroDestinatarios({ papeis, usuarioIds }, params);
  const r = await query(
    `SELECT id FROM dbo.EQUIPSTI_usuarios WHERE ativo = 1 AND id <> @atorId ${filtro}`,
    params
  );
  return r.recordset.map((u) => u.id);
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
 * @param {number[]} [o.sininhoUsuarioIds]  usuários que recebem o SININHO mesmo fora
 *   dos papéis (ex.: o dono de um evento particular do calendário)
 * @param {{html:string, texto:string}} [o.corpo]  e-mail já montado (ex.: a ficha
 *   do chamado). Quando vem, substitui o template genérico inteiro.
 * @param {boolean} [o.push]    também enviar push (Web Push)? Segue o mesmo
 *   escopo do sininho ('papeis'/'sininhoUsuarioIds'). Default true.
 */
export async function notificar({ tipo, acao, titulo, mensagem, link, refId, ator, email = false, mudancas, emailPapeis, emailUsuarioIds, papeis, sininhoUsuarioIds, corpo, push = true }) {
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
    const filtroSino = filtroDestinatarios({ papeis, usuarioIds: sininhoUsuarioIds }, paramsSino, 'sino_');
    await query(
      `INSERT INTO dbo.EQUIPSTI_notificacoes
         (usuario_id, tipo, acao, titulo, mensagem, link, ref_id, ator_email)
       SELECT id, @tipo, @acao, @titulo, @msg, @link, @refId, @ator
         FROM dbo.EQUIPSTI_usuarios
        WHERE ativo = 1 AND id <> @atorId ${filtroSino}`,
      paramsSino
    );

    // Sinaliza quem está com a tela aberta, para o sininho atualizar sem F5.
    // Vai para todos os conectados de propósito: quem realmente recebeu linha
    // é decidido pelo GET /api/notifications, que filtra pelo usuário do
    // token — ninguém enxerga nada a mais. A alternativa (INSERT ... OUTPUT
    // INSERTED.usuario_id, para mirar exatamente nos destinatários) trocaria
    // um INSERT hoje infalível por um que quebra se alguém puser um trigger
    // na tabela, e o catch lá embaixo engoliria a falha com console.warn —
    // notificação sumindo em silêncio. Não vale o risco pela precisão.
    emitirTodos('notificacao');

    // 2) Push (Web Push): mesmo escopo do sininho, não o do e-mail — o push
    //    existe pra alcançar quem tem a tela fechada, então segue a regra
    //    "avisa de tudo" do sininho. Não aguardado, mesma razão do e-mail:
    //    é I/O externo e não deve atrasar a resposta ao usuário.
    if (push) {
      destinatariosPush({ atorId, papeis, usuarioIds: sininhoUsuarioIds })
        .then((ids) => enviarPush(ids, { titulo, corpo: mensagem || titulo, tipo }))
        .catch((e) => console.warn('[push] falhou:', e.message));
    }

    // 3) E-mail (apenas quando email=true): uma mensagem endereçada a todos os
    //    destinatários (ver enviarEmail — o BCC de antes caía no spam).
    //    O envio NÃO é aguardado: quem chama responde ao usuário na hora e o
    //    diálogo SMTP corre em segundo plano. Ele já foi aguardado um dia, por
    //    causa do serverless — na Vercel a invocação congelava assim que a
    //    resposta HTTP saía e o e-mail era interrompido no meio. Com processo
    //    24/7 na VPS isso não acontece, e abrir um chamado deixa de esperar
    //    dois handshakes SMTP em série antes de responder.
    if (email) {
      const dest = await destinatariosEmail({ atorId, papeis: emailPapeis, usuarioIds: emailUsuarioIds });
      if (dest.length) {
        const corpoPronto = corpo;                  // ficha do chamado, quando houver
        const corpoTexto = mensagem || titulo;      // fallback genérico
        const quem = ator?.email || 'sistema';
        enviarEmail({
          to: dest,
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
        }).catch((e) => {
          // Falha de e-mail nunca derruba a operação principal, mas precisa
          // aparecer no log com a resposta do servidor para ser diagnosticável.
          // Tem que ser .catch e não try/catch: sem o await, a exceção chega
          // pela promise, e rejeição sem tratamento derruba o processo.
          console.error('[email] falhou:', e.responseCode || '', e.response || e.message);
        });
      }
    }
  } catch (err) {
    console.warn('[notificar] falhou:', err.message);
  }
}

// Deixa links clicáveis num texto já escapado para HTML (a observação do
// evento pode trazer uma URL — sem isto ela chega como texto puro no e-mail).
const LINK_RE = /(https?:\/\/[^\s<]+)/g;
function linkify(escapedHtml) {
  return escapedHtml.replace(LINK_RE, (url) => {
    const [, href, fechamento] = url.match(/^(.*?)([.,;:!?)\]]*)$/);
    return `<a href="${href}" style="color:#2b6cb0;text-decoration:underline;">${href}</a>${fechamento}`;
  });
}

// Bloco visual de um item dentro do e-mail em lote (título + mensagem).
function renderBlocosHtml(blocos) {
  return blocos.map((b, i) => `
    <div style="padding:12px 0;${i < blocos.length - 1 ? 'border-bottom:1px solid #f0f0f0;' : ''}">
      <div style="font-size:15px;font-weight:700;color:#2b2b2b;margin-bottom:4px;">${esc(b.titulo)}</div>
      <div style="font-size:14px;line-height:1.5;color:#3a3a3a;white-space:pre-line;">${linkify(esc(b.mensagem))}</div>
    </div>`).join('');
}

function renderBlocosTxt(blocos) {
  return blocos.map((b) => `${b.titulo}\n${b.mensagem}`).join('\n\n');
}

/**
 * Um único e-mail cobrindo vários avisos (ex.: todos os vencimentos do
 * calendário do dia). Existe separado de notificar() porque aqui não há
 * sininho — quem chama já cuidou disso por item — e porque o envio É
 * aguardado: quem usa isto roda fora do caminho de uma resposta HTTP (cron),
 * então vale esperar para o chamador saber se marca o item como avisado.
 *
 * Reduz N handshakes SMTP (um por evento, cada um um ponto de falha
 * independente) a só 1 por execução.
 *
 * @param {object} o
 * @param {string} o.titulo   assunto do e-mail
 * @param {string} [o.tag]    rótulo do template (ex.: 'Calendário')
 * @param {Array<{titulo:string, mensagem:string}>} o.blocos  um item por aviso
 * @param {string[]} [o.papeis]  quem recebe (ex.: ['MASTER'])
 * @param {number[]} [o.usuarioIds]  usuários específicos, somados aos papéis
 * @param {string[]} [o.emailsExtras]  endereços avulsos, de gente sem conta no
 *   sistema (ex.: fornecedor num evento do calendário)
 * @returns {Promise<boolean>} true se enviado — ou se não havia ninguém para
 *   receber, o que não é falha e não deve ser retentado
 */
export async function notificarEmailLote({ titulo, tag, blocos, papeis, usuarioIds, emailsExtras }) {
  try {
    if (!Array.isArray(blocos) || !blocos.length) return false;
    const dosUsuarios = await destinatariosEmail({ atorId: 0, papeis, usuarioIds });
    // Extras entram junto dos usuários, sem repetir quem já está na lista.
    const vistos = new Set(dosUsuarios.map((e) => e.toLowerCase()));
    const dest = [...dosUsuarios];
    for (const e of (Array.isArray(emailsExtras) ? emailsExtras : [])) {
      const limpo = String(e).trim();
      if (!emailValido(limpo) || vistos.has(limpo.toLowerCase())) continue;
      vistos.add(limpo.toLowerCase());
      dest.push(limpo);
    }
    // "Ninguém para receber" NÃO é falha transiente: devolver false faria quem
    // chama retentar (o cron do calendário insiste 3× em 15 min e repete no dia
    // seguinte) para sempre, e o aviso nunca seria marcado como entregue.
    if (!dest.length) {
      console.warn('[email] lote sem destinatários:', titulo);
      return true;
    }
    await enviarEmail({
      to: dest,
      subject: `[Gestão TI] ${titulo}`,
      text: renderBlocosTxt(blocos),
      html: montarEmailHtml({ tag, titulo, conteudoHtml: renderBlocosHtml(blocos), rodapeHtml: '' })
    });
    return true;
  } catch (e) {
    console.error('[email] lote falhou:', e.responseCode || '', e.response || e.message);
    return false;
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
 * @returns {Promise<boolean>} true se o e-mail foi disparado (há destinatário
 *   válido e o solicitante não é o próprio autor). A entrega em si acontece em
 *   segundo plano — falha de SMTP aparece só no log.
 */
export async function notificarSolicitante({ chamado, ator, titulo, chamada, comentario, mudancas, equipamento, tile }) {
  try {
    const donoId = Number(chamado?.usuario_id) || 0;
    if (!donoId) return false;
    // Quem age não é avisado da própria ação — mesma regra do sininho.
    if (donoId === (Number(ator?.id) || 0)) return false;

    // Sinal para o portal /chamados atualizar a lista sem F5. Aqui o alvo é
    // uma pessoa só (o dono do chamado), então não faz sentido transmitir
    // para todos como no sininho. Vem antes do e-mail de propósito: o canal
    // in-app não depende de SMTP nenhum estar de pé.
    emitirPara([donoId], 'chamado');

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
    // Não aguardado, pela mesma razão de notificar(): o técnico não fica
    // esperando o SMTP para ver o comentário dele salvo.
    enviarEmail({ to: destino, subject, html, text }).catch((e) => {
      console.error('[notificarSolicitante] falhou:', e.responseCode || '', e.response || e.message);
    });
    return true;
  } catch (e) {
    console.error('[notificarSolicitante] falhou:', e.responseCode || '', e.response || e.message);
    return false;
  }
}
