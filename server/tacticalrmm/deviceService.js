// ============================================================
//  Regra de negócio: equipamento vinculado a um chamado INTECS.
//
//  mapeamentoAgentParaSnapshot() foi conferido contra uma resposta REAL de
//  GET /agents/{id}/ de uma instância Tactical RMM em produção (2026-07-14).
//  Campos confirmados existentes: status, cpu_model[], local_ips, make_model,
//  disks[] ({free,used,total,device,fstype,percent} — percent é uso de DISCO,
//  não de RAM), graphics, operating_system, plat, goarch, hostname, agent_id,
//  public_ip, total_ram (GB), boot_time (epoch segundos), logged_in_username,
//  last_logged_in_user, last_seen, needs_reboot.
//  Campos que a API NÃO expõe nesta instância (ficam null/ausentes, sem
//  quebrar nada): mac_address, gateway, dns, domain, antivirus, cpu_load,
//  mem_load — não há uso de CPU/RAM em tempo real neste endpoint.
// ============================================================
import * as client from './client.js';
import * as repo from './deviceRepository.js';

function mapeamentoAgentParaSnapshot(agent) {
  const disks = agent.disks || [];
  const uptimeSeg = agent.boot_time ? Math.max(0, Math.floor(Date.now() / 1000) - agent.boot_time) : null;

  return {
    os_info: {
      plat: agent.plat,
      operating_system: agent.operating_system,
      arch: agent.goarch,
      boot_time: agent.boot_time ? new Date(agent.boot_time * 1000).toISOString() : null
    },
    hardware_info: {
      cpu_model: Array.isArray(agent.cpu_model) ? agent.cpu_model[0] : agent.cpu_model,
      total_ram_gb: agent.total_ram,
      make_model: agent.make_model,
      graphics: agent.graphics,
      disks
    },
    rede_info: {
      local_ips: agent.local_ips,
      public_ip: agent.public_ip
    },
    seguranca_info: {
      needs_reboot: agent.needs_reboot
    },
    usuario_logado_info: {
      logged_in_username: agent.logged_in_username,
      last_logged_in_user: agent.last_logged_in_user,
      last_seen: agent.last_seen
    },
    status_online: agent.status === 'online',
    cpu_pct: agent.cpu_load ?? null,
    ram_pct: agent.mem_load ?? null,
    uptime_seg: uptimeSeg
  };
}

// wmi_detail vem embrulhado em arrays aninhados (Array[Array[Object]]) —
// conferido em 4 agentes desta instância. Desembrulha até chegar no objeto.
function wmi(agent, bloco) {
  let no = agent?.wmi_detail?.[bloco];
  while (Array.isArray(no)) no = no[0];
  return no && typeof no === 'object' ? no : {};
}

// Identificação para o cadastro do equipamento. O detalhe do agente não expõe
// série nem fabricante — só make_model/hostname —, então o resto vem do WMI.
function dadosIdentificacao(agent) {
  const bios = wmi(agent, 'bios');
  const compSys = wmi(agent, 'comp_sys');
  const prod = wmi(agent, 'comp_sys_prod');
  return {
    nome_amigavel: agent.hostname || null,
    // bios.Manufacturer é quem fez a BIOS (ex.: "Insyde"), não quem fez a
    // máquina — daí o fabricante sair do comp_sys.
    fabricante: compSys.Manufacturer || prod.Vendor || null,
    modelo: agent.make_model || null,
    numero_serie: bios.SerialNumber || prod.IdentifyingNumber || null,
    dominio: compSys.Domain || null
  };
}

// Vincula a máquina ao chamado que está sendo aberto: cria (ou completa) o
// cadastro do equipamento e guarda o snapshot — tudo com uma única leitura do
// Tactical RMM. Falha no snapshot não impede o vínculo: o chamado continua
// sabendo qual é a máquina.
export async function vincularEquipamento(tacticalAgentId, usuarioId) {
  const agent = await client.getAgentDetail(tacticalAgentId);
  const device = await repo.getOrCreateDeviceByAgentId(tacticalAgentId, dadosIdentificacao(agent));
  try {
    const snapshotId = await repo.salvarSnapshot(device.id, null, mapeamentoAgentParaSnapshot(agent));
    await repo.registrarLog(device.id, null, 'SNAPSHOT', 'Snapshot coletado na abertura do chamado', null, usuarioId);
    return { device, snapshotId };
  } catch (err) {
    await repo.registrarLog(device.id, null, 'ERRO_SYNC', 'Falha ao guardar snapshot na abertura', err.message, usuarioId);
    return { device, snapshotId: null };
  }
}

export async function listarAgentesDisponiveis() {
  let agentesRemotos;
  try {
    agentesRemotos = await client.getAgents();
  } catch (err) {
    // RMM fora do ar não pode travar a abertura de chamado — a seleção de
    // máquina agora é obrigatória no portal, então serve o cache local.
    console.warn('[tacticalrmm] lista de agentes indisponível, servindo cache local:', err.message);
    return repo.listTacticalAgents();
  }
  const lista = Array.isArray(agentesRemotos) ? agentesRemotos : (agentesRemotos?.results || []);
  for (const agent of lista) {
    await repo.upsertTacticalAgent({
      tactical_agent_id: agent.agent_id,
      hostname: agent.hostname,
      client_name: agent.client_name,
      site_name: agent.site_name,
      status_online: agent.status === 'online',
      last_seen: agent.last_seen || null,
      public_ip: agent.public_ip || null,
      local_ips: agent.local_ips || null,
      // Usuário logado (ou o último, se ninguém está na máquina agora).
      logged_username: agent.logged_username || null
    });
  }
  return repo.listTacticalAgents();
}

// Identificação exata da máquina: o próprio agente Tactical grava seu AgentID
// em HKLM\SOFTWARE\TacticalRMM, e ele chega ao front pelo atalho ?agent=.
// Devolve null (em vez de estourar) quando o ID não resolve, para o chamado
// cair no fallback por IP em vez de travar.
export async function getResumoAgente(tacticalAgentId) {
  if (!tacticalAgentId) return null;
  try {
    const agent = await client.getAgentDetail(tacticalAgentId);
    if (!agent || !agent.agent_id) return null;
    return {
      tactical_agent_id: agent.agent_id,
      hostname: agent.hostname,
      make_model: agent.make_model,
      site_name: agent.site_name,
      status_online: agent.status === 'online'
    };
  } catch (err) {
    console.warn('[tacticalrmm] agente', tacticalAgentId, 'não resolvido:', err.message);
    return null;
  }
}

// Acesso remoto (aba Conexão Remota do admin): URLs do MeshCentral com token
// de login efêmero — geradas a cada clique, nunca cacheadas. Devolve null
// quando o agente não resolve, para a rota responder 404 em vez de estourar.
export async function getConexaoRemota(tacticalAgentId) {
  if (!tacticalAgentId) return null;
  const mesh = await client.getMeshCentralUrls(tacticalAgentId);
  if (!mesh || !mesh.control) return null;
  return {
    hostname: mesh.hostname,
    control: mesh.control,
    terminal: mesh.terminal,
    file: mesh.file,
    status: mesh.status
  };
}

// Scripts favoritos do Tactical RMM (estrela do modal Conexão Remota).
// Cache leve em memória: a lista muda raramente e o painel pode ser aberto
// várias vezes seguidas.
let _scriptsFavCache = { ts: 0, data: null };

export async function listarScriptsFavoritos() {
  if (_scriptsFavCache.data && Date.now() - _scriptsFavCache.ts < 60_000) {
    return _scriptsFavCache.data;
  }
  const scripts = await client.getScripts();
  const lista = (Array.isArray(scripts) ? scripts : (scripts?.results || []))
    .filter((s) => s.favorite === true)
    .map((s) => ({
      id: s.id,
      name: s.name,
      shell: s.shell || null,
      category: s.category || null,
      // Dica de uso cadastrada no RMM (ex.: "SET-HOSTNAME <novo nome>") —
      // aparece no diálogo de confirmação junto do campo de argumentos.
      syntax: s.syntax || null
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  _scriptsFavCache = { ts: Date.now(), data: lista };
  return lista;
}

// Roda um script favorito no agente e espera a saída (output: "wait").
const RUNSCRIPT_TIMEOUT_SEG = 90; // timeout do script no próprio agente

export async function rodarScriptFavorito(tacticalAgentId, scriptId, args = []) {
  const payload = {
    script: scriptId,
    output: 'wait',
    args,
    timeout: RUNSCRIPT_TIMEOUT_SEG,
    run_as_user: false,
    env_vars: []
  };
  // O HTTP espera o script inteiro rodar + 30s de folga de rede.
  const saida = await client.runScript(tacticalAgentId, payload, (RUNSCRIPT_TIMEOUT_SEG + 30) * 1000);
  return { output: typeof saida === 'string' ? saida : JSON.stringify(saida, null, 2) };
}

// Detecção da máquina do usuário no momento da abertura do chamado — pelo IP
// de origem da requisição, cruzado com os agentes já sincronizados. Fallback
// para quem não tem AgentID (celular, navegador novo, máquina sem agente):
// atrás de NAT um IP público aponta para a rede inteira, então o resultado é
// uma lista de candidatos para o usuário confirmar, nunca uma certeza.
export async function detectarAgentesPorIp(ip) {
  if (!ip) return [];
  return repo.buscarAgentesPorIp(ip);
}

// Busca o agente ao vivo no Tactical RMM e persiste um novo snapshot.
export async function takeSnapshot(deviceId, tacticalAgentId, chamadoId, usuarioId) {
  try {
    const agent = await client.getAgentDetail(tacticalAgentId);
    const snapshot = mapeamentoAgentParaSnapshot(agent);
    const snapshotId = await repo.salvarSnapshot(deviceId, chamadoId, snapshot);
    await repo.registrarLog(deviceId, chamadoId, 'SNAPSHOT', 'Snapshot coletado do Tactical RMM', null, usuarioId);
    return snapshotId;
  } catch (err) {
    await repo.registrarLog(deviceId, chamadoId, 'ERRO_SYNC', 'Falha ao coletar snapshot', err.message, usuarioId);
    throw err;
  }
}

// Sempre lê o snapshot já persistido — nunca chama o Tactical RMM ao vivo
// nesta leitura (ver premissa de "sem cache em memória" no plano).
export async function getDeviceSummary(deviceId) {
  const snapshot = await repo.getSnapshotMaisRecente(deviceId);
  if (!snapshot) return null;
  return {
    coletado_em: snapshot.coletado_em,
    status_online: snapshot.status_online,
    cpu_pct: snapshot.cpu_pct,
    ram_pct: snapshot.ram_pct,
    uptime_seg: snapshot.uptime_seg,
    os_info: JSON.parse(snapshot.os_info || '{}'),
    hardware_info: JSON.parse(snapshot.hardware_info || '{}'),
    rede_info: JSON.parse(snapshot.rede_info || '{}'),
    seguranca_info: JSON.parse(snapshot.seguranca_info || '{}'),
    usuario_logado_info: JSON.parse(snapshot.usuario_logado_info || '{}')
  };
}
