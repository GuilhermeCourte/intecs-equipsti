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

export async function listarAgentesDisponiveis() {
  const agentesRemotos = await client.getAgents();
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
      local_ips: agent.local_ips || null
    });
  }
  return repo.listTacticalAgents();
}

// Detecção da máquina do usuário no momento da abertura do chamado — pelo IP
// de origem da requisição, cruzado com os agentes já sincronizados. Sem
// vínculo fixo usuário<->equipamento (removido a pedido do usuário).
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
