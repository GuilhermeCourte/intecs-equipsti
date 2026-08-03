// ============================================================
//  Cliente HTTP da API da Hostinger (Bearer token, só leitura).
//  Espelha o formato de server/tacticalrmm/client.js: fetch nativo,
//  1 retry em 5xx, sem sessão/cookie.
// ============================================================
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = 'https://developers.hostinger.com';
const API_KEY = process.env.API_HOSTINGER || '';

async function hostingerRequest(path, { retry = true, timeoutMs = 20000 } = {}) {
  if (!API_KEY) {
    throw new Error('API_HOSTINGER não configurada no .env');
  }

  const res = await fetch(BASE_URL + path, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (res.status >= 500 && retry) {
    return hostingerRequest(path, { retry: false, timeoutMs });
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = res.status === 429
      ? 'Hostinger: limite de requisições atingido, tente novamente em instantes.'
      : (data && data.error) || `Hostinger: erro ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Lista todas as VPS da conta.
export function listVirtualMachines() {
  return hostingerRequest('/api/vps/v1/virtual-machines');
}

// Métricas históricas (CPU/RAM/disco/rede/uptime) de uma VPS num intervalo.
export function getVirtualMachineMetrics(id, dateFrom, dateTo) {
  const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  return hostingerRequest(`/api/vps/v1/virtual-machines/${encodeURIComponent(id)}/metrics?${qs}`);
}

// Histórico paginado de ações (start/stop/restart/etc.) executadas na VPS.
export function getVirtualMachineActions(id, page = 1) {
  return hostingerRequest(`/api/vps/v1/virtual-machines/${encodeURIComponent(id)}/actions?page=${encodeURIComponent(page)}`, { timeoutMs: 15000 });
}

// Projetos Docker Compose rodando na VPS, com seus containers.
export function getDockerProjects(id) {
  return hostingerRequest(`/api/vps/v1/virtual-machines/${encodeURIComponent(id)}/docker`);
}
