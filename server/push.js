// ============================================================
//  Web Push (VAPID) — notificações do app admin que chegam mesmo com o
//  app fechado/minimizado (Android e desktop).
//
//  enviarPush() NUNCA lança — mesma regra de notificar(): falha de push
//  (SMTP-like, é I/O externo) não pode quebrar a operação principal.
// ============================================================
import webPush from 'web-push';
import { query, sql } from './db.js';

const PUB = process.env.VAPID_PUBLIC_KEY || '';
const PRIV = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || '';
const HABILITADO = !!(PUB && PRIV && SUBJECT);

if (HABILITADO) {
  webPush.setVapidDetails(SUBJECT, PUB, PRIV);
} else {
  console.warn('[push] VAPID não configurado no .env — push desativado (sininho/e-mail continuam normais).');
}

export const chavePublica = () => PUB;

export async function salvarSubscription(usuarioId, { endpoint, keys }) {
  const ep = { type: sql.NVarChar(sql.MAX), value: endpoint };
  await query(
    'DELETE FROM dbo.EQUIPSTI_push_subscriptions WHERE usuario_id = @uid AND endpoint = @ep',
    { uid: usuarioId, ep }
  );
  await query(
    `INSERT INTO dbo.EQUIPSTI_push_subscriptions (usuario_id, endpoint, p256dh, auth)
     VALUES (@uid, @ep, @p256dh, @auth)`,
    { uid: usuarioId, ep, p256dh: keys?.p256dh, auth: keys?.auth }
  );
}

export async function removerSubscription(usuarioId, endpoint) {
  await query(
    'DELETE FROM dbo.EQUIPSTI_push_subscriptions WHERE usuario_id = @uid AND endpoint = @ep',
    { uid: usuarioId, ep: { type: sql.NVarChar(sql.MAX), value: endpoint } }
  );
}

// Envia para todos os dispositivos inscritos dos usuários dados. Assinaturas
// mortas (404/410 — usuário revogou a permissão ou desinstalou) são limpas
// automaticamente; outros erros só ficam no log. Retorna quantos dispositivos
// foram alvo do envio (0 = push desativado ou ninguém inscrito) — usado pelo
// teste de notificação pra dizer ao usuário se havia algo pra receber.
export async function enviarPush(usuarioIds, { titulo, corpo, url, tipo }) {
  if (!HABILITADO) return 0;
  const ids = (Array.isArray(usuarioIds) ? usuarioIds : []).map(Number).filter(Boolean);
  if (!ids.length) return 0;
  try {
    const params = {};
    ids.forEach((id, i) => { params[`uid${i}`] = id; });
    const r = await query(
      `SELECT id, endpoint, p256dh, auth FROM dbo.EQUIPSTI_push_subscriptions
        WHERE usuario_id IN (${ids.map((_, i) => `@uid${i}`).join(', ')})`,
      params
    );
    // 'tipo' vai cru; quem traduz para arquivo de ícone é o service worker, que
    // é onde já vive o caminho dos ícones. Tipo desconhecido cai no ícone do app.
    const payload = JSON.stringify({ title: titulo, body: corpo, url: url || './', tipo: tipo || '' });
    await Promise.all(r.recordset.map(async (row) => {
      try {
        await webPush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload
        );
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await query('DELETE FROM dbo.EQUIPSTI_push_subscriptions WHERE id = @id', { id: row.id }).catch(() => {});
        } else {
          console.error('[push] falhou:', e.statusCode || '', e.body || e.message);
        }
      }
    }));
    return r.recordset.length;
  } catch (err) {
    console.warn('[push] enviarPush falhou:', err.message);
    return 0;
  }
}
