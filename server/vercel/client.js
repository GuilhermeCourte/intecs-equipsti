// ============================================================
//  Cliente HTTP da API da Vercel (Bearer token, só leitura).
//  2 contas PESSOAIS (sem teamId) — cada uma com o próprio token.
//  Espelha o formato de server/hostinger/client.js: fetch nativo,
//  1 retry em 5xx, sem sessão/cookie.
// ============================================================
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = 'https://api.vercel.com';

const TOKENS = {
  1: process.env.API_VERCEL_1 || '',
  2: process.env.API_VERCEL_2 || ''
};

// Contas com token configurado no .env — usado pra tela mostrar um aviso
// amigável em vez de quebrar quando falta um token.
export function contasConfiguradas() {
  return Object.keys(TOKENS).filter((conta) => TOKENS[conta]);
}

async function vercelRequest(conta, path, { retry = true, timeoutMs = 20000 } = {}) {
  const token = TOKENS[conta];
  if (!token) {
    throw new Error(`Conta Vercel ${conta}: token não configurado no .env`);
  }

  const res = await fetch(BASE_URL + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (res.status >= 500 && retry) {
    return vercelRequest(conta, path, { retry: false, timeoutMs });
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = res.status === 429
      ? `Vercel (conta ${conta}): limite de requisições atingido, tente novamente em instantes.`
      : (data && data.error && data.error.message) || `Vercel (conta ${conta}): erro ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Lista todos os projetos da conta (paginado — segue pagination.next até acabar).
export async function listProjects(conta) {
  const projetos = [];
  let until;
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (until) qs.set('until', String(until));
    const data = await vercelRequest(conta, `/v9/projects?${qs}`);
    projetos.push(...(data.projects || []));
    until = data.pagination && data.pagination.next ? data.pagination.next : null;
  } while (until);
  return projetos;
}

// Último deployment do projeto (o mais recente, qualquer ambiente).
export async function getLatestDeployment(conta, projectId) {
  const qs = new URLSearchParams({ projectId, limit: '1' });
  const data = await vercelRequest(conta, `/v6/deployments?${qs}`);
  return (data.deployments && data.deployments[0]) || null;
}

// Domínios atribuídos ao projeto (custom domains + o *.vercel.app padrão).
export async function getProjectDomains(conta, projectId) {
  const data = await vercelRequest(conta, `/v9/projects/${encodeURIComponent(projectId)}/domains`);
  return data.domains || [];
}
