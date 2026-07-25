// ============================================================
//  Cliente da página de status pública do UptimeRobot (stats.uptimerobot.com).
//  É a mesma origem dos dados da API v2, só que já mastigados: 90 dias de
//  uptime por dia numa única resposta de ~2s, contra ~12s para montar 30 dias
//  com custom_uptime_ranges na v2. Não usa chave nem gasta o limite de 10
//  req/min do plano free.
//
//  O endpoint não é documentado — daí o service.js manter o caminho da API v2
//  como plano B se isto aqui parar de responder.
// ============================================================
import dotenv from 'dotenv';

dotenv.config();

// Id da página de status (o pedaço final da URL pública).
const PSP_ID = process.env.UPTIMEROBOT_PSP_ID || '';

export async function getStatusPage({ timeoutMs = 20000, retry = true } = {}) {
  if (!PSP_ID) {
    throw new Error('UPTIMEROBOT_PSP_ID não configurada no .env');
  }

  const res = await fetch(`https://stats.uptimerobot.com/api/getMonitorList/${PSP_ID}`, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (res.status >= 500 && retry) {
    return getStatusPage({ timeoutMs, retry: false });
  }
  if (!res.ok) {
    throw new Error(`Página de status: erro ${res.status}`);
  }

  const data = await res.json();
  if (data?.status !== 'ok' || !Array.isArray(data.data)) {
    throw new Error('Página de status: resposta inesperada.');
  }
  return data.data;
}
