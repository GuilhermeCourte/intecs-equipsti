// ============================================================
//  Regras da sub-aba Serverless (VPS › Serverless): projetos hospedados
//  fora da VPS, em 2 contas Vercel pessoais. Só leitura — nunca redeploy.
//  Quais projetos aparecem é escolhido pelo usuário (ver EQUIPSTI_vercel_projetos
//  em server/index.js); aqui só fala com a API da Vercel.
// ============================================================
import * as client from './client.js';

const ESTADOS_OK = ['READY'];
const ESTADOS_ERRO = ['ERROR', 'CANCELED'];

function statusCor(readyState) {
  if (!readyState) return 'transicao';
  if (ESTADOS_OK.includes(readyState)) return 'ok';
  if (ESTADOS_ERRO.includes(readyState)) return 'erro';
  return 'transicao'; // BUILDING, QUEUED, INITIALIZING
}

// Domínio "principal" pra exibir: prefere um domínio próprio verificado
// (não termina em .vercel.app); sem nenhum, cai no *.vercel.app padrão.
function dominioPrincipal(dominios, nomeProjeto) {
  const verificado = (dominios || []).find((d) => d.verified && !d.name.endsWith('.vercel.app'));
  if (verificado) return verificado.name;
  const qualquer = (dominios || [])[0];
  return qualquer ? qualquer.name : `${nomeProjeto}.vercel.app`;
}

// A Vercel não expõe logo de projeto — usa o favicon do próprio site.
// Lê o <link rel="icon"> da home (a maioria não usa o /favicon.ico padrão);
// sem sorte nenhuma, chuta /favicon.ico. Nunca lança: sem favicon nenhum, o
// front cai no placeholder (ph-cloud) sozinho via onerror da <img>.
async function faviconDoDominio(dominio) {
  if (!dominio) return null;
  try {
    const res = await fetch(`https://${dominio}/`, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
    const html = await res.text();
    const tag = html.match(/<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*>/i);
    const href = tag && tag[0].match(/href=["']([^"']+)["']/i);
    if (href) return new URL(href[1], res.url).href;
  } catch { /* segue pro chute abaixo */ }
  return `https://${dominio}/favicon.ico`;
}

// Catálogo (para o modal de seleção): todos os projetos das contas com token
// configurado. Conta sem token some da lista, sem quebrar — o chamador
// (rota) avisa quais contas faltam configurar.
export async function catalogo() {
  const contas = client.contasConfiguradas();
  const listas = await Promise.all(contas.map(async (conta) => {
    const projetos = await client.listProjects(conta);
    return projetos.map((p) => ({ conta, projectId: p.id, nome: p.name }));
  }));
  return listas.flat().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// Cache leve em memória por projeto — mesmo padrão de hostinger/uptimerobot:
// evita golpe duplo ao reabrir a sub-aba ou clicar em Atualizar rapidamente.
const _cache = new Map();

// A parte que fala com a Vercel — separada do id/apelido (locais, do banco)
// pra cachear só o que vem da API.
async function dadosDaVercel(conta, projectId) {
  const chave = `${conta}:${projectId}`;
  const cache = _cache.get(chave);
  if (cache && Date.now() - cache.ts < 60_000) return cache.data;

  const [deploy, dominios] = await Promise.all([
    client.getLatestDeployment(conta, projectId).catch(() => null),
    client.getProjectDomains(conta, projectId).catch(() => [])
  ]);
  const dominio = dominioPrincipal(dominios, (deploy && deploy.name) || projectId);
  const favicon = await faviconDoDominio(dominio);

  const data = {
    nomeVercel: (deploy && deploy.name) || projectId,
    status: deploy ? deploy.readyState : null,
    statusCor: statusCor(deploy && deploy.readyState),
    deployEm: deploy ? deploy.createdAt : null, // epoch ms
    dominio, favicon
  };
  _cache.set(chave, { ts: Date.now(), data });
  return data;
}

// Nome oficial na Vercel (nunca o projectId cru pro chamador usar em log).
// Cacheado junto com o resto dos dados do projeto (dadosDaVercel).
export async function nomeVercelDe(conta, projectId) {
  const d = await dadosDaVercel(conta, projectId);
  return d.nomeVercel;
}

// Rótulo único pra log de auditoria (Item/entidadeRotulo): sempre o nome
// oficial da Vercel, com o apelido entre parênteses quando existir. Helper
// único pra CRIADO/EXCLUIDO/ATUALIZADO não duplicarem esse formato.
export function rotuloProjeto(nomeVercel, apelido) {
  return apelido ? `${nomeVercel} (${apelido})` : nomeVercel;
}

// Status dos projetos SELECIONADOS (lista única, sem indicar a conta —
// decisão do usuário: a tela não distingue de qual conta é o projeto).
// 's' vem do banco: { id, conta, projectId, nomeExibicao }.
export async function statusProjetos(selecionados) {
  const resultados = await Promise.all(selecionados.map(async (s) => {
    try {
      const d = await dadosDaVercel(s.conta, s.projectId);
      return { id: s.id, projectId: s.projectId, nomeExibicao: s.nomeExibicao || null,
        nome: s.nomeExibicao || d.nomeVercel,
        status: d.status, statusCor: d.statusCor, deployEm: d.deployEm, dominio: d.dominio, favicon: d.favicon };
    } catch (err) {
      return { id: s.id, projectId: s.projectId, nomeExibicao: s.nomeExibicao || null,
        nome: s.nomeExibicao || s.projectId,
        status: null, statusCor: 'erro', deployEm: null, dominio: null, favicon: null, erro: err.message };
    }
  }));
  return resultados.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
