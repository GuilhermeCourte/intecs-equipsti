// ============================================================
//  Cliente HTTP do UptimeRobot (API v2, chave read-only).
//  Segue o mesmo desenho do cliente do Tactical RMM: fetch nativo,
//  timeout e um retry só em falha 5xx.
//
//  Duas particularidades da v2 que valem o comentário:
//   - os parâmetros vão como form-urlencoded no corpo, não em JSON;
//   - erro de chave/quota volta como HTTP 200 com { stat: "fail" },
//     então não dá para confiar só no res.ok.
// ============================================================
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = 'https://api.uptimerobot.com/v2';
const API_KEY = process.env.UPTIMEROBOT_API_KEY || '';

// A v2 devolve no máximo 50 monitores por chamada.
const PAGE_SIZE = 50;

async function uptimeRobotRequest(path, params = {}, { retry = true, timeoutMs = 20000 } = {}) {
  if (!API_KEY) {
    throw new Error('UPTIMEROBOT_API_KEY não configurada no .env');
  }

  const body = new URLSearchParams({ api_key: API_KEY, format: 'json', ...params });

  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (res.status >= 500 && retry) {
    return uptimeRobotRequest(path, params, { retry: false, timeoutMs });
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    // 429 = estourou o rate limit (10 req/min no plano free).
    const msg = res.status === 429
      ? 'UptimeRobot: limite de requisições atingido, tente em instantes.'
      : `UptimeRobot: erro ${res.status}`;
    throw new Error(msg);
  }
  if (!data || data.stat !== 'ok') {
    throw new Error(data?.error?.message || 'UptimeRobot: resposta inesperada.');
  }
  return data;
}

// Percorre todas as páginas de /getMonitors com os parâmetros dados.
async function listarTodos(params, opts) {
  const monitores = [];
  let offset = 0;
  let total = 0;

  do {
    const data = await uptimeRobotRequest('/getMonitors', {
      ...params,
      limit: String(PAGE_SIZE),
      offset: String(offset)
    }, opts);
    monitores.push(...(data.monitors || []));
    total = data.pagination?.total ?? monitores.length;
    offset += PAGE_SIZE;
  } while (offset < total && monitores.length < total);

  return monitores;
}

// Todos os monitores da conta, já paginados.
// logs=1 + logs_limit=1 traz só o último evento de cada monitor — é dele que
// sai o "desde quando" o monitor está no estado atual.
export function getMonitors() {
  return listarTodos({ logs: '1', logs_limit: '1' });
}

// Uptime para as barrinhas: custom_uptime_ratios devolve o % do período inteiro
// e custom_uptime_ranges um % por faixa (uma faixa por dia).
// Calcular 30 faixas custa caro do lado deles — mediu ~12s com 16 monitores —,
// daí o timeout maior e nenhum retry: repetir só dobraria a espera.
export function getMonitorsUptime({ ratios, ranges }) {
  return listarTodos(
    { custom_uptime_ratios: ratios, custom_uptime_ranges: ranges },
    { retry: false, timeoutMs: 45000 }
  );
}
