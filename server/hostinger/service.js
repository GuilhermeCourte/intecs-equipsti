// ============================================================
//  Regras da aba VPS (monitoramento só leitura da Hostinger).
//  A aba nunca liga/desliga/reinicia nada — só lê status, specs,
//  métricas e histórico de ações.
// ============================================================
import * as client from './client.js';

// state (enum da Hostinger) → cor do badge na tela, sem o front precisar
// conhecer o enum inteiro.
const ESTADOS_OK = ['running'];
const ESTADOS_ERRO = ['error', 'stopped', 'destroyed', 'suspended'];

function estadoCor(state) {
  if (ESTADOS_OK.includes(state)) return 'ok';
  if (ESTADOS_ERRO.includes(state)) return 'erro';
  return 'transicao'; // starting, stopping, creating, recreating, etc.
}

function normalizarVm(vm) {
  return {
    id: vm.id,
    hostname: vm.hostname,
    state: vm.state,
    estadoCor: estadoCor(vm.state),
    plan: vm.plan,
    dataCenterId: vm.data_center_id,
    cpus: vm.cpus,
    memory: vm.memory,
    disk: vm.disk,
    bandwidth: vm.bandwidth,
    ns1: vm.ns1,
    ns2: vm.ns2,
    ipv4: vm.ipv4 || [],
    ipv6: vm.ipv6 || [],
    template: vm.template || null,
    createdAt: vm.created_at
  };
}

// Cache leve em memória: a aba não faz polling, mas evita golpe duplo de
// requisição se o usuário reabrir a aba/clicar em Atualizar rapidamente.
// Mesmo padrão de uptimerobot/service.js.
let _cacheVms = { ts: 0, data: null };

export async function listarMaquinas() {
  if (_cacheVms.data && Date.now() - _cacheVms.ts < 60_000) return _cacheVms.data;
  const maquinas = (await client.listVirtualMachines()).map(normalizarVm);
  _cacheVms = { ts: Date.now(), data: maquinas };
  return maquinas;
}

// ---------- Métricas históricas ----------

const FAIXAS_MS = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };

function intervaloDaFaixa(faixa) {
  const ms = FAIXAS_MS[faixa] || FAIXAS_MS['24h'];
  const agora = new Date();
  return { dateFrom: new Date(agora.getTime() - ms).toISOString(), dateTo: agora.toISOString() };
}

// bytes → MB (1 casa decimal); usado para ram/disco/tráfego.
function bytesParaMb(v) {
  return Math.round((v / 1024 / 1024) * 10) / 10;
}

// Cada métrica vem como { unit, usage: { "<epochSeg>": valor, ... } } —
// vira { labels: [ISO...], data: [numeros...] } ordenado por tempo.
function serie(resource, transform = (v) => v) {
  if (!resource || !resource.usage) return { labels: [], data: [] };
  const pontos = Object.entries(resource.usage)
    .map(([ts, v]) => ({ ts: Number(ts), v: Number(v) }))
    .sort((a, b) => a.ts - b.ts);
  return {
    labels: pontos.map((p) => new Date(p.ts * 1000).toISOString()),
    data: pontos.map((p) => transform(p.v))
  };
}

// Cache por VM+faixa: o endpoint de métricas é o mais pesado da API e não
// muda de forma perceptível minuto a minuto.
const _cacheMetricas = new Map();

export async function metricas(id, faixa) {
  const chave = `${id}:${faixa}`;
  const cache = _cacheMetricas.get(chave);
  if (cache && Date.now() - cache.ts < 5 * 60_000) return cache.data;

  const { dateFrom, dateTo } = intervaloDaFaixa(faixa);
  const bruto = await client.getVirtualMachineMetrics(id, dateFrom, dateTo);

  // "uptime" do endpoint de métricas NÃO é o uptime real da VPS (fica travado
  // em minutos mesmo com a VPS rodando há dias, conferido contra o hPanel) —
  // por isso não entra aqui. O uptime real vem de created_at, calculado no
  // front (ver formatarUptimeDesde() em app.js).
  const data = {
    cpu_usage: serie(bruto.cpu_usage),
    ram_usage: serie(bruto.ram_usage, bytesParaMb),
    disk_space: serie(bruto.disk_space, bytesParaMb),
    outgoing_traffic: serie(bruto.outgoing_traffic, bytesParaMb),
    incoming_traffic: serie(bruto.incoming_traffic, bytesParaMb)
  };
  _cacheMetricas.set(chave, { ts: Date.now(), data });
  return data;
}

// ---------- Resumo (dashboard/cockpit: estado + CPU/RAM atuais) ----------
// Mesmo recorte que a aba VPS já mostra por VM (último ponto das séries de
// métricas), só que compacto — evita duplicar essa leitura em cada front.
export async function resumo() {
  const maquinas = await listarMaquinas();
  const ultimo = (serie) => (serie && serie.data.length ? serie.data[serie.data.length - 1] : null);
  return Promise.all(maquinas.map(async (vm) => {
    let cpu = null, ramPercent = null;
    try {
      const m = await metricas(vm.id, '24h');
      const ramUsadoMb = ultimo(m.ram_usage);
      cpu = ultimo(m.cpu_usage);
      if (ramUsadoMb != null && vm.memory) ramPercent = Math.round((ramUsadoMb / vm.memory) * 1000) / 10;
    } catch { /* sem métrica não derruba o resumo, só fica sem número */ }
    return { id: vm.id, hostname: vm.hostname, state: vm.state, estadoCor: vm.estadoCor, cpu, ramPercent };
  }));
}

// ---------- Docker (projetos e containers) ----------

function estadoCorProjeto(state) {
  if (state === 'running') return 'ok';
  if (state === 'stopped') return 'erro';
  return 'transicao'; // created, mixed, unknown
}

function estadoCorContainer(state) {
  if (state === 'running') return 'ok';
  if (state === 'exited' || state === 'dead') return 'erro';
  return 'transicao'; // created, restarting, paused, stopping
}

// Porta publicada mostra "host:container/protocolo"; exposta (só entre
// containers, sem porta no host) mostra só o lado do container.
function formatarPorta(p) {
  const proto = p.protocol || 'tcp';
  if (p.type === 'published') return `${p.host_port}:${p.container_port}/${proto}`;
  if (p.type === 'published_range') return `${p.host_port_start}-${p.host_port_end}:${p.container_port_start}-${p.container_port_end}/${proto}`;
  if (p.type === 'exposed_range') return `${p.container_port_start}-${p.container_port_end}/${proto} (interno)`;
  return `${p.container_port}/${proto} (interno)`;
}

// A lista de projetos (getDockerProjects) não traz "stats" (fica null) —
// só o endpoint por projeto (getDockerProjectContainers) preenche.
function normalizarStats(s) {
  if (!s) return null;
  return {
    cpuPercent: s.cpu_percentage,
    memPercent: s.memory_percentage,
    memUsadaMb: bytesParaMb(s.memory_used),
    memTotalMb: bytesParaMb(s.memory_total),
    netEntradaMb: bytesParaMb(s.net_in),
    netSaidaMb: bytesParaMb(s.net_out)
  };
}

function normalizarContainer(c) {
  return {
    id: c.id,
    name: c.name,
    image: c.image,
    status: c.status,
    state: c.state,
    estadoCor: estadoCorContainer(c.state),
    health: c.health || null,
    portas: (c.ports || []).map(formatarPorta),
    stats: normalizarStats(c.stats)
  };
}

// Cache curto: diferente da lista de VMs, aqui o usuário costuma checar
// logo depois de um deploy, então o estado precisa ficar bem recente.
const _cacheDocker = new Map();

export async function dockerProjetos(id) {
  const cache = _cacheDocker.get(id);
  if (cache && Date.now() - cache.ts < 30_000) return cache.data;

  const listaProjetos = await client.getDockerProjects(id);

  // getDockerProjects não traz stats; busca os containers de cada projeto
  // (com stats) em paralelo pra completar.
  const projetos = await Promise.all(listaProjetos.map(async (p) => {
    let containers = p.containers || [];
    try {
      containers = await client.getDockerProjectContainers(id, p.name);
    } catch {
      // se o endpoint de stats falhar, mantém os containers já obtidos (sem stats).
    }
    return {
      name: p.name,
      status: p.status,
      state: p.state,
      estadoCor: estadoCorProjeto(p.state),
      containers: containers.map(normalizarContainer)
    };
  }));
  _cacheDocker.set(id, { ts: Date.now(), data: projetos });
  return projetos;
}

// ---------- Histórico de ações ----------

const ESTADO_ACAO_LABEL = {
  success: 'Concluída',
  error: 'Falhou',
  delayed: 'Atrasada',
  sent: 'Enviada',
  created: 'Criada'
};

// Sem cache: é paginado, raramente aberto, e cachear complicaria a
// paginação sem ganho real.
export async function acoes(id, page) {
  const resp = await client.getVirtualMachineActions(id, page);
  return {
    data: (resp.data || []).map((a) => ({
      id: a.id,
      name: a.name,
      state: a.state,
      stateLabel: ESTADO_ACAO_LABEL[a.state] || a.state,
      createdAt: a.created_at,
      updatedAt: a.updated_at
    })),
    meta: resp.meta || null
  };
}
