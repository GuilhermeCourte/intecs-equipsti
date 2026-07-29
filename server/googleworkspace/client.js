// ============================================================
//  Cliente HTTP da Admin SDK Reports API (relatório de auditoria
//  do Drive). Só leitura — o escopo é audit.readonly.
//
//  Mesmo desenho dos clientes do Tactical RMM e do UptimeRobot:
//  fetch nativo, timeout e retry curto. Duas particularidades desta
//  API que valem o comentário:
//   - 503 aqui significa COTA estourada (não "fora do ar"); a
//     recomendação do próprio Google é backoff começando em 5s;
//   - eventName aceita UM evento por chamada, e toda chamada com
//     filtro (eventName, filters, userKey...) cai num limite à parte
//     de 250/min. Ainda assim o sync usa o filtro e faz uma chamada por
//     evento: varrer sem filtro traria ~65% de "view" para descartar
//     depois, o que sai muito mais caro (ver coletarJanela no service).
// ============================================================
import { getAccessToken, invalidarToken } from './auth.js';

const BASE_URL = 'https://admin.googleapis.com/admin/reports/v1';
const CAMINHO_DRIVE = '/activity/users/all/applications/drive';

// Máximo aceito pela API (e também o default dela).
const MAX_RESULTS = 1000;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function reportsRequest(caminho, params, { retry5xx = true, retryCota = true, retryAuth = true } = {}) {
  const token = await getAccessToken();
  const url = BASE_URL + caminho + '?' + new URLSearchParams(params).toString();

  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });

  // Token expirado em voo (ou o admin impersonado mudou): joga fora o que
  // está em cache e tenta uma vez com um token novo.
  if (res.status === 401 && retryAuth) {
    invalidarToken();
    return reportsRequest(caminho, params, { retry5xx, retryCota, retryAuth: false });
  }
  if (res.status === 503 && retryCota) {
    await esperar(5000);
    return reportsRequest(caminho, params, { retry5xx, retryCota: false, retryAuth });
  }
  if (res.status >= 500 && retry5xx) {
    return reportsRequest(caminho, params, { retry5xx: false, retryCota, retryAuth });
  }

  const texto = await res.text();
  let data;
  try { data = texto ? JSON.parse(texto) : null; } catch { data = null; }

  if (!res.ok) {
    // 403 aqui quase sempre é delegação/privilégio, não "sem permissão no
    // arquivo": ou o escopo não foi liberado, ou o GOOGLE_ADMIN_SUBJECT não
    // tem o privilégio de Relatórios.
    const detalhe = data?.error?.message || `erro ${res.status}`;
    const dica = res.status === 403
      ? ' — confira a delegação em todo o domínio e se o GOOGLE_ADMIN_SUBJECT é administrador'
      : '';
    throw new Error(`Google Reports API: ${detalhe}${dica}`);
  }

  return data || {};
}

/**
 * Uma página do relatório de auditoria do Drive.
 * @param {object} o
 * @param {Date}   o.inicio        startTime (RFC 3339)
 * @param {Date}   [o.fim]         endTime; sem isto a API usa "agora"
 * @param {string} [o.evento]      eventName — UM só (usado apenas no modo ao vivo)
 * @param {string} [o.pageToken]
 * @param {number} [o.maxResults]
 * @returns {Promise<{items: Array, nextPageToken: string|undefined}>}
 */
export async function listarAtividadesDrive({ inicio, fim = null, evento = null, pageToken = null, maxResults = MAX_RESULTS } = {}) {
  const params = { maxResults: String(Math.min(maxResults, MAX_RESULTS)) };
  if (inicio instanceof Date && !isNaN(inicio)) params.startTime = inicio.toISOString();
  if (fim instanceof Date && !isNaN(fim)) params.endTime = fim.toISOString();
  if (evento) params.eventName = evento;
  if (pageToken) params.pageToken = pageToken;

  const data = await reportsRequest(CAMINHO_DRIVE, params);
  return { items: data.items || [], nextPageToken: data.nextPageToken };
}
