// ============================================================
//  Envio de e-mail (nodemailer) — usado pelas notificações.
//  Degrada com elegância: se o SMTP não estiver configurado no .env,
//  enviarEmail() apenas retorna false e nada quebra.
// ============================================================
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

let transporter; // undefined = não inicializado; null = SMTP ausente

function getTransporter() {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) {
    transporter = null; // sem host => e-mail desativado
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true', // false = STARTTLS (587)
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    // Conexão reaproveitada entre envios. Era inútil em serverless (cada
    // invocação era um processo novo); com o processo vivo 24/7 na VPS, os
    // e-mails seguintes pulam handshake TCP + TLS + AUTH inteiros.
    pool: true,
    maxConnections: 2,
    // Os timeouts eram apertados para caber no tempo limite da função na
    // Vercel. Agora o envio acontece fora do caminho da resposta HTTP (ver
    // notificacoes.js), então vale esperar um SMTP lento em vez de desistir
    // e perder a mensagem.
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000
  });
  return transporter;
}

// Envia um e-mail. Use 'to' para um destinatário direto (ex.: teste) ou 'bcc'
// para vários destinatários sem expor a lista (notificações em massa).
// Retorna true se enviou, false se o SMTP não está configurado / sem destinatários.
// Lança o erro do servidor SMTP (com a resposta) quando a entrega falha.
export async function enviarEmail({ to, bcc, subject, html, text }) {
  const t = getTransporter();
  const temBcc = Array.isArray(bcc) && bcc.length > 0;
  if (!t || (!to && !temBcc)) return false;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  // Quando só há BCC, 'to' = remetente (servidores costumam recusar msg só com BCC).
  const info = await t.sendMail({ from, to: to || from, bcc: temBcc ? bcc : undefined, subject, text, html });
  // Entrega parcial não lança: o servidor aceita a mensagem e recusa só alguns
  // endereços. Sem este log a falha ficaria invisível.
  if (info?.rejected?.length) console.warn('[email] destinatários recusados:', info.rejected.join(', '));
  return true;
}
