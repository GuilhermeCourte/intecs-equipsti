// ============================================================
//  Acesso a dados das tabelas de equipamento/Tactical RMM.
// ============================================================
import { query, sql } from '../db.js';

const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });
const N = (v) => ({ type: sql.Int, value: v == null ? null : Number(v) });

export async function upsertTacticalAgent(agent) {
  const existe = await query(
    'SELECT id FROM dbo.EQUIPSTI_tactical_agents WHERE tactical_agent_id = @id',
    { id: S(agent.tactical_agent_id) }
  );
  if (existe.recordset.length) {
    await query(
      `UPDATE dbo.EQUIPSTI_tactical_agents SET
         hostname = @hostname, client_name = @client_name, site_name = @site_name,
         status_online = @status_online, last_seen = @last_seen,
         public_ip = @publicIp, local_ips = @localIps, logged_username = @loggedUsername,
         plat = @plat, atualizado_em = SYSUTCDATETIME()
       WHERE tactical_agent_id = @id`,
      {
        id: S(agent.tactical_agent_id), hostname: S(agent.hostname),
        client_name: S(agent.client_name), site_name: S(agent.site_name),
        status_online: { type: sql.Bit, value: !!agent.status_online },
        last_seen: { type: sql.DateTime2, value: agent.last_seen || null },
        publicIp: S(agent.public_ip), localIps: S(agent.local_ips),
        loggedUsername: S(agent.logged_username), plat: S(agent.plat)
      }
    );
    return existe.recordset[0].id;
  }
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_tactical_agents
       (tactical_agent_id, hostname, client_name, site_name, status_online, last_seen, public_ip, local_ips, logged_username, plat)
     OUTPUT INSERTED.id
     VALUES (@id, @hostname, @client_name, @site_name, @status_online, @last_seen, @publicIp, @localIps, @loggedUsername, @plat)`,
    {
      id: S(agent.tactical_agent_id), hostname: S(agent.hostname),
      client_name: S(agent.client_name), site_name: S(agent.site_name),
      status_online: { type: sql.Bit, value: !!agent.status_online },
      last_seen: { type: sql.DateTime2, value: agent.last_seen || null },
      publicIp: S(agent.public_ip), localIps: S(agent.local_ips),
      loggedUsername: S(agent.logged_username), plat: S(agent.plat)
    }
  );
  return inserted.recordset[0].id;
}

// Agente que sumiu do RMM (desinstalado/máquina descartada) sai também do
// cache — senão vira linha fantasma na Conexão Remota e na detecção por IP.
// Seguro apagar: snapshots/devices de chamados antigos não dependem desta
// tabela (o detalhe do chamado já tem fallback quando o agente não existe).
// Lista vazia não apaga nada: resposta suspeita do RMM não pode zerar o cache.
export async function deleteTacticalAgentsAusentes(idsAtuais) {
  if (!Array.isArray(idsAtuais) || !idsAtuais.length) return 0;
  const result = await query(
    `DELETE FROM dbo.EQUIPSTI_tactical_agents
      WHERE tactical_agent_id NOT IN (SELECT value FROM STRING_SPLIT(@ids, ','))`,
    { ids: { type: sql.NVarChar(sql.MAX), value: idsAtuais.join(',') } }
  );
  return result.rowsAffected?.[0] || 0;
}

// Detecção por IP: fallback da abertura do chamado, para quem não tem AgentID.
// Devolve CANDIDATOS, não uma certeza — quem confirma é o usuário.
export async function buscarAgentesPorIp(ip) {
  // IP da LAN primeiro: é muito mais específico que o público, que atrás de NAT
  // é o mesmo para a rede inteira. Casa por token exato porque local_ips vem
  // como lista ("192.168.15.6, 192.168.56.1"); com LIKE '%ip%' solto o
  // "192.168.1.4" casaria com o "192.168.1.45" de outra máquina.
  const porLocal = await query(
    `SELECT * FROM dbo.EQUIPSTI_tactical_agents
      WHERE ',' + REPLACE(local_ips, ' ', '') + ',' LIKE '%,' + @ip + ',%'
      ORDER BY status_online DESC, last_seen DESC`,
    { ip: S(ip) }
  );
  if (porLocal.recordset.length) return porLocal.recordset;

  const porPublico = await query(
    `SELECT * FROM dbo.EQUIPSTI_tactical_agents
      WHERE public_ip = @ip
      ORDER BY status_online DESC, last_seen DESC`,
    { ip: S(ip) }
  );
  return porPublico.recordset;
}

export async function listTacticalAgents() {
  const result = await query('SELECT * FROM dbo.EQUIPSTI_tactical_agents ORDER BY hostname');
  return result.recordset;
}

export async function getOrCreateDeviceByAgentId(tacticalAgentId, dadosBase = {}) {
  const existe = await query(
    'SELECT * FROM dbo.EQUIPSTI_devices WHERE tactical_agent_id = @id',
    { id: S(tacticalAgentId) }
  );
  // Equipamento já cadastrado: completa só o que ainda está vazio. O COALESCE
  // preserva qualquer enriquecimento manual (patrimônio, apelido) e não faz
  // nada quando dadosBase vem vazio.
  if (existe.recordset.length) {
    const atualizado = await query(
      `UPDATE dbo.EQUIPSTI_devices SET
         nome_amigavel = COALESCE(nome_amigavel, @nome),
         numero_serie  = COALESCE(numero_serie, @ns),
         fabricante    = COALESCE(fabricante, @fab),
         modelo        = COALESCE(modelo, @modelo),
         dominio       = COALESCE(dominio, @dominio),
         atualizado_em = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE tactical_agent_id = @id`,
      {
        id: S(tacticalAgentId), nome: S(dadosBase.nome_amigavel), ns: S(dadosBase.numero_serie),
        fab: S(dadosBase.fabricante), modelo: S(dadosBase.modelo), dominio: S(dadosBase.dominio)
      }
    );
    return atualizado.recordset[0];
  }

  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_devices (tactical_agent_id, nome_amigavel, numero_serie, fabricante, modelo, dominio)
     OUTPUT INSERTED.*
     VALUES (@id, @nome, @ns, @fab, @modelo, @dominio)`,
    {
      id: S(tacticalAgentId), nome: S(dadosBase.nome_amigavel), ns: S(dadosBase.numero_serie),
      fab: S(dadosBase.fabricante), modelo: S(dadosBase.modelo), dominio: S(dadosBase.dominio)
    }
  );
  return inserted.recordset[0];
}

export async function getDeviceById(deviceId) {
  const result = await query('SELECT * FROM dbo.EQUIPSTI_devices WHERE id = @id', { id: N(deviceId) });
  return result.recordset[0] || null;
}

// Linha do cache de agentes (a mesma tabela que alimenta a aba Conexão Remota).
// Usada no detalhe do chamado para mostrar hostname/status da máquina vinculada.
export async function getAgenteCache(tacticalAgentId) {
  const result = await query(
    `SELECT hostname, status_online, logged_username, site_name, plat
       FROM dbo.EQUIPSTI_tactical_agents WHERE tactical_agent_id = @id`,
    { id: S(tacticalAgentId) }
  );
  return result.recordset[0] || null;
}

export async function salvarSnapshot(deviceId, chamadoId, snapshot) {
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_device_snapshots
       (device_id, chamado_id, os_info, hardware_info, rede_info, seguranca_info,
        usuario_logado_info, status_online, cpu_pct, ram_pct, uptime_seg)
     OUTPUT INSERTED.id
     VALUES (@deviceId, @chamadoId, @os, @hardware, @rede, @seguranca, @usuarioLogado,
             @statusOnline, @cpuPct, @ramPct, @uptimeSeg)`,
    {
      deviceId: N(deviceId), chamadoId: N(chamadoId),
      os: S(JSON.stringify(snapshot.os_info || {})),
      hardware: S(JSON.stringify(snapshot.hardware_info || {})),
      rede: S(JSON.stringify(snapshot.rede_info || {})),
      seguranca: S(JSON.stringify(snapshot.seguranca_info || {})),
      usuarioLogado: S(JSON.stringify(snapshot.usuario_logado_info || {})),
      statusOnline: { type: sql.Bit, value: !!snapshot.status_online },
      cpuPct: { type: sql.Decimal(5, 2), value: snapshot.cpu_pct ?? null },
      ramPct: { type: sql.Decimal(5, 2), value: snapshot.ram_pct ?? null },
      uptimeSeg: { type: sql.BigInt, value: snapshot.uptime_seg ?? null }
    }
  );
  return inserted.recordset[0].id;
}

export async function getSnapshotMaisRecente(deviceId) {
  const result = await query(
    `SELECT TOP 1 * FROM dbo.EQUIPSTI_device_snapshots
     WHERE device_id = @deviceId ORDER BY coletado_em DESC`,
    { deviceId: N(deviceId) }
  );
  return result.recordset[0] || null;
}

export async function registrarLog(deviceId, chamadoId, tipo, descricao, resultado, usuarioId) {
  await query(
    `INSERT INTO dbo.EQUIPSTI_device_logs (device_id, chamado_id, tipo, descricao, resultado, usuario_id)
     VALUES (@deviceId, @chamadoId, @tipo, @descricao, @resultado, @usuarioId)`,
    {
      deviceId: N(deviceId), chamadoId: N(chamadoId), tipo: S(tipo),
      descricao: S(descricao), resultado: S(resultado), usuarioId: N(usuarioId)
    }
  );
}

// Chamados/categorias/comentários/histórico ficam em ../chamadosIntecsRepository.js
