// ============================================================
//  Cliente HTTP do Tactical RMM (API Key, sem sessão/cookie).
//  Espelha o formato de retorno { status, data } usado no cliente
//  Eurosa (server/index.js), mas sem login/sessão — só um retry
//  em falha 5xx.
// ============================================================
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = (process.env.TACTICALRMM_API_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.TACTICALRMM_API_KEY || '';

async function tacticalRequest(path, { method = 'GET', retry = true } = {}) {
  if (!BASE_URL || !API_KEY) {
    throw new Error('TACTICALRMM_API_URL/TACTICALRMM_API_KEY não configurados no .env');
  }

  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' }
  });

  if (res.status >= 500 && retry) {
    return tacticalRequest(path, { method, retry: false });
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = (data && data.detail) || `Tactical RMM: erro ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Lista todos os agentes cadastrados no Tactical RMM.
export function getAgents() {
  return tacticalRequest('/agents/');
}

// Detalhe completo de um agente (hardware, SO, rede, segurança, etc.).
export function getAgentDetail(agentId) {
  return tacticalRequest(`/agents/${encodeURIComponent(agentId)}/`);
}
