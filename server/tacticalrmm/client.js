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

async function tacticalRequest(path, { method = 'GET', body = null, retry = true, timeoutMs = 30000 } = {}) {
  if (!BASE_URL || !API_KEY) {
    throw new Error('TACTICALRMM_API_URL/TACTICALRMM_API_KEY não configurados no .env');
  }

  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (res.status >= 500 && retry) {
    return tacticalRequest(path, { method, body, retry: false, timeoutMs });
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

// URLs de acesso remoto via MeshCentral ({ control, terminal, file, ... }).
// O token de login embutido é efêmero — gerar a cada clique, nunca cachear.
export function getMeshCentralUrls(agentId) {
  return tacticalRequest(`/agents/${encodeURIComponent(agentId)}/meshcentral/`);
}

// Lista de scripts cadastrados no Tactical RMM (o filtro de favoritos fica
// no service).
export function getScripts() {
  return tacticalRequest('/scripts/');
}

// Roda um script no agente. Com output "wait" a resposta é a saída do script,
// então o timeout HTTP precisa cobrir o timeout do próprio script + folga.
// Sem retry: re-executar um script após um 5xx tardio é pior que falhar.
export function runScript(agentId, payload, timeoutMs) {
  return tacticalRequest(`/agents/${encodeURIComponent(agentId)}/runscript/`,
    { method: 'POST', body: payload, retry: false, timeoutMs });
}
