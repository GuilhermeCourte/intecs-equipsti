// ============================================================
//  Acesso a dados: chamados INTECS, categorias, comentários, histórico.
// ============================================================
import { query, sql } from './db.js';

const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });
const N = (v) => ({ type: sql.Int, value: v == null ? null : Number(v) });
const DEC = (v) => ({ type: sql.Decimal(6, 2), value: v == null ? null : Number(v) });
const DT = (v) => ({ type: sql.DateTime2, value: v || null });
const B = (v) => ({ type: sql.Bit, value: v ? 1 : 0 });

export async function listarCategorias() {
  const [cats, subs] = await Promise.all([
    query('SELECT * FROM dbo.EQUIPSTI_chamados_intecs_categorias WHERE ativo = 1 ORDER BY nome'),
    query('SELECT * FROM dbo.EQUIPSTI_chamados_intecs_subcategorias WHERE ativo = 1 ORDER BY nome')
  ]);
  return cats.recordset.map((c) => ({
    ...c,
    subcategorias: subs.recordset.filter((s) => s.categoria_id === c.id)
  }));
}

export async function criarCategoria(nome) {
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_chamados_intecs_categorias (nome) OUTPUT INSERTED.* VALUES (@nome)`,
    { nome: S(nome) }
  );
  return inserted.recordset[0];
}

export async function criarSubcategoria(categoriaId, nome) {
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_chamados_intecs_subcategorias (categoria_id, nome)
     OUTPUT INSERTED.* VALUES (@categoriaId, @nome)`,
    { categoriaId: N(categoriaId), nome: S(nome) }
  );
  return inserted.recordset[0];
}

export async function removerCategoria(id) {
  await query('UPDATE dbo.EQUIPSTI_chamados_intecs_categorias SET ativo = 0 WHERE id = @id', { id: N(id) });
}

export async function removerSubcategoria(id) {
  await query('UPDATE dbo.EQUIPSTI_chamados_intecs_subcategorias SET ativo = 0 WHERE id = @id', { id: N(id) });
}

// ---------- Prioridades (com SLA) ----------

export async function listarPrioridades() {
  const r = await query('SELECT * FROM dbo.EQUIPSTI_chamados_intecs_prioridades WHERE ativo = 1 ORDER BY ordem, nome');
  return r.recordset;
}

export async function criarPrioridade({ nome, sla_resposta_horas, sla_conclusao_horas, cor, ordem }) {
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_chamados_intecs_prioridades (nome, sla_resposta_horas, sla_conclusao_horas, cor, ordem)
     OUTPUT INSERTED.* VALUES (@nome, @resposta, @conclusao, @cor, @ordem)`,
    { nome: S(nome), resposta: DEC(sla_resposta_horas), conclusao: DEC(sla_conclusao_horas), cor: S(cor), ordem: N(ordem || 0) }
  );
  return inserted.recordset[0];
}

export async function atualizarPrioridade(id, { sla_resposta_horas, sla_conclusao_horas, cor, ordem }) {
  await query(
    `UPDATE dbo.EQUIPSTI_chamados_intecs_prioridades
     SET sla_resposta_horas = @resposta, sla_conclusao_horas = @conclusao, cor = @cor, ordem = @ordem
     WHERE id = @id`,
    { id: N(id), resposta: DEC(sla_resposta_horas), conclusao: DEC(sla_conclusao_horas), cor: S(cor), ordem: N(ordem || 0) }
  );
}

export async function removerPrioridade(id) {
  await query('UPDATE dbo.EQUIPSTI_chamados_intecs_prioridades SET ativo = 0 WHERE id = @id', { id: N(id) });
}

export async function getPrioridadePorNome(nome) {
  const r = await query('SELECT * FROM dbo.EQUIPSTI_chamados_intecs_prioridades WHERE nome = @nome', { nome: S(nome) });
  return r.recordset[0] || null;
}

// ---------- Status ----------

export async function listarStatusConfig() {
  const r = await query('SELECT * FROM dbo.EQUIPSTI_chamados_intecs_status WHERE ativo = 1 ORDER BY ordem, nome');
  return r.recordset;
}

export async function criarStatus({ nome, tipo_sistema, cor, ordem, notifica_solicitante }) {
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_chamados_intecs_status (nome, tipo_sistema, cor, ordem, notifica_solicitante)
     OUTPUT INSERTED.* VALUES (@nome, @tipo, @cor, @ordem, @notifica)`,
    {
      nome: S(nome), tipo: S(tipo_sistema), cor: S(cor), ordem: N(ordem || 0),
      notifica: B(notifica_solicitante)
    }
  );
  return inserted.recordset[0];
}

export async function atualizarStatus(id, { tipo_sistema, cor, ordem, notifica_solicitante }) {
  // notifica_solicitante só é tocado quando vem no payload — assim um PUT
  // parcial (só cor/ordem) não desliga o aviso ao solicitante sem querer.
  const params = { id: N(id), tipo: S(tipo_sistema), cor: S(cor), ordem: N(ordem || 0) };
  let setNotifica = '';
  if (notifica_solicitante !== undefined) {
    params.notifica = B(notifica_solicitante);
    setNotifica = ', notifica_solicitante = @notifica';
  }
  await query(
    `UPDATE dbo.EQUIPSTI_chamados_intecs_status
        SET tipo_sistema = @tipo, cor = @cor, ordem = @ordem${setNotifica}
      WHERE id = @id`,
    params
  );
}

// Este status avisa por e-mail quem abriu o chamado? Ver a coluna
// notifica_solicitante em init-db.js — status desconhecido não avisa.
export async function statusNotificaSolicitante(nome) {
  const r = await query(
    'SELECT notifica_solicitante FROM dbo.EQUIPSTI_chamados_intecs_status WHERE nome = @nome',
    { nome: S(nome) }
  );
  return r.recordset[0]?.notifica_solicitante === true;
}

export async function removerStatus(id) {
  await query('UPDATE dbo.EQUIPSTI_chamados_intecs_status SET ativo = 0 WHERE id = @id', { id: N(id) });
}

// Nomes de status cujo tipo_sistema está entre os informados — usado pra
// trocar as listas fixas ('RESOLVIDO','FECHADO',...) por uma consulta real.
export async function getNomesStatusPorTipo(tipos) {
  if (!tipos.length) return [];
  const params = {};
  const placeholders = tipos.map((t, i) => { params[`t${i}`] = S(t); return `@t${i}`; });
  const r = await query(
    `SELECT nome FROM dbo.EQUIPSTI_chamados_intecs_status WHERE tipo_sistema IN (${placeholders.join(',')})`,
    params
  );
  return r.recordset.map((row) => row.nome);
}

// tipo_sistema de um único status pelo nome — usado pra decidir se uma
// mudança de status conta como "fechar o chamado" etc, sem hardcode.
export async function getTipoSistemaDoStatus(nome) {
  const r = await query('SELECT tipo_sistema FROM dbo.EQUIPSTI_chamados_intecs_status WHERE nome = @nome', { nome: S(nome) });
  return r.recordset[0]?.tipo_sistema || null;
}

export async function criarChamadoIntecs(dados) {
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_chamados_intecs
       (titulo, descricao, categoria_id, subcategoria_id, prioridade, usuario_id, device_id,
        snapshot_id, unidade, departamento, localizacao, telefone, ramal, email_contato,
        sla_resposta_prazo, sla_conclusao_prazo, criado_por)
     OUTPUT INSERTED.*
     VALUES (@titulo, @descricao, @categoriaId, @subcategoriaId, @prioridade, @usuarioId, @deviceId,
             @snapshotId, @unidade, @departamento, @localizacao, @telefone, @ramal, @emailContato,
             @slaResposta, @slaConclusao, @criadoPor)`,
    {
      titulo: S(dados.titulo), descricao: S(dados.descricao),
      categoriaId: N(dados.categoria_id), subcategoriaId: N(dados.subcategoria_id),
      prioridade: S(dados.prioridade || 'MEDIA'), usuarioId: N(dados.usuario_id),
      deviceId: N(dados.device_id), snapshotId: N(dados.snapshot_id),
      unidade: S(dados.unidade), departamento: S(dados.departamento), localizacao: S(dados.localizacao),
      telefone: S(dados.telefone), ramal: S(dados.ramal), emailContato: S(dados.email_contato),
      slaResposta: DT(dados.sla_resposta_prazo), slaConclusao: DT(dados.sla_conclusao_prazo),
      criadoPor: S(dados.criado_por)
    }
  );
  return inserted.recordset[0];
}

// Sem papéis nesta aplicação: qualquer usuário autenticado vê e atende
// qualquer chamado (mesmo modelo já usado em Registros/Empréstimos/MSA).
export async function listarChamadosIntecs() {
  const result = await query(`
    SELECT c.*, cat.nome AS categoria_nome, sub.nome AS subcategoria_nome,
           u.email AS responsavel_email
    FROM dbo.EQUIPSTI_chamados_intecs c
    LEFT JOIN dbo.EQUIPSTI_chamados_intecs_categorias cat ON cat.id = c.categoria_id
    LEFT JOIN dbo.EQUIPSTI_chamados_intecs_subcategorias sub ON sub.id = c.subcategoria_id
    LEFT JOIN dbo.EQUIPSTI_usuarios u ON u.id = c.responsavel_id
    ORDER BY c.criado_em DESC
  `);
  return result.recordset;
}

export async function getChamadoIntecs(id) {
  // tipo_sistema_status alimenta a cor do selo de status no e-mail — o nome do
  // status é customizável, o tipo é que tem significado fixo.
  const result = await query(`
    SELECT c.*, cat.nome AS categoria_nome, sub.nome AS subcategoria_nome,
           u.email AS responsavel_email, st.tipo_sistema AS tipo_sistema_status
    FROM dbo.EQUIPSTI_chamados_intecs c
    LEFT JOIN dbo.EQUIPSTI_chamados_intecs_categorias cat ON cat.id = c.categoria_id
    LEFT JOIN dbo.EQUIPSTI_chamados_intecs_subcategorias sub ON sub.id = c.subcategoria_id
    LEFT JOIN dbo.EQUIPSTI_usuarios u ON u.id = c.responsavel_id
    LEFT JOIN dbo.EQUIPSTI_chamados_intecs_status st ON st.nome = c.status
    WHERE c.id = @id
  `, { id: N(id) });
  return result.recordset[0] || null;
}

export async function atualizarCamposChamado(id, campos) {
  const sets = [];
  const params = { id: N(id) };
  for (const [k, v] of Object.entries(campos)) {
    sets.push(`${k} = @${k}`);
    params[k] = k.endsWith('_em') || k.endsWith('_prazo') ? DT(v) : (typeof v === 'number' ? N(v) : S(v));
  }
  sets.push('atualizado_em = SYSUTCDATETIME()');
  await query(`UPDATE dbo.EQUIPSTI_chamados_intecs SET ${sets.join(', ')} WHERE id = @id`, params);
}

export async function registrarHistorico(chamadoId, usuarioId, acao, campo, valorAnterior, valorNovo) {
  await query(
    `INSERT INTO dbo.EQUIPSTI_chamados_intecs_historico
       (chamado_id, usuario_id, acao, campo, valor_anterior, valor_novo)
     VALUES (@chamadoId, @usuarioId, @acao, @campo, @valorAnterior, @valorNovo)`,
    {
      chamadoId: N(chamadoId), usuarioId: N(usuarioId), acao: S(acao), campo: S(campo),
      valorAnterior: S(valorAnterior), valorNovo: S(valorNovo)
    }
  );
}

export async function listarHistorico(chamadoId) {
  const result = await query(`
    SELECT h.*, u.email AS usuario_email
    FROM dbo.EQUIPSTI_chamados_intecs_historico h
    LEFT JOIN dbo.EQUIPSTI_usuarios u ON u.id = h.usuario_id
    WHERE h.chamado_id = @chamadoId ORDER BY h.criado_em`,
    { chamadoId: N(chamadoId) }
  );
  return result.recordset;
}

export async function criarComentario(chamadoId, usuarioId, texto) {
  const inserted = await query(
    `INSERT INTO dbo.EQUIPSTI_chamados_intecs_comentarios (chamado_id, usuario_id, texto)
     OUTPUT INSERTED.* VALUES (@chamadoId, @usuarioId, @texto)`,
    { chamadoId: N(chamadoId), usuarioId: N(usuarioId), texto: S(texto) }
  );
  return inserted.recordset[0];
}

export async function listarComentarios(chamadoId) {
  const result = await query(`
    SELECT co.*, u.email AS usuario_email
    FROM dbo.EQUIPSTI_chamados_intecs_comentarios co
    LEFT JOIN dbo.EQUIPSTI_usuarios u ON u.id = co.usuario_id
    WHERE co.chamado_id = @chamadoId ORDER BY co.criado_em`,
    { chamadoId: N(chamadoId) }
  );
  return result.recordset;
}

// Monta um "status IN (@p0,@p1,...)" parametrizado a partir de uma lista de
// nomes de status (vazia = condição sempre falsa, "1 = 0").
function condicaoStatusIn(coluna, nomes, prefixo, params) {
  if (!nomes.length) return '1 = 0';
  const placeholders = nomes.map((n, i) => {
    const key = `${prefixo}${i}`;
    params[key] = S(n);
    return `@${key}`;
  });
  return `${coluna} IN (${placeholders.join(',')})`;
}

// usuarioIdsFiltro: opcional — quando informado (Gestor), restringe o
// dashboard aos chamados abertos por esses usuários (equipe supervisionada).
export async function getDashboard(usuarioIdsFiltro = null) {
  let whereClause = '';
  const params = {};
  if (Array.isArray(usuarioIdsFiltro)) {
    if (!usuarioIdsFiltro.length) {
      whereClause = 'WHERE 1 = 0';
    } else {
      const nomes = usuarioIdsFiltro.map((id, i) => `@uid${i}`);
      usuarioIdsFiltro.forEach((id, i) => { params[`uid${i}`] = N(id); });
      whereClause = `WHERE usuario_id IN (${nomes.join(',')})`;
    }
  }

  const [nomesAberto, nomesAndamento, nomesResolvido, nomesFechado, nomesCancelado] = await Promise.all([
    getNomesStatusPorTipo(['ABERTO']),
    getNomesStatusPorTipo(['ANDAMENTO']),
    getNomesStatusPorTipo(['RESOLVIDO']),
    getNomesStatusPorTipo(['FECHADO']),
    getNomesStatusPorTipo(['CANCELADO'])
  ]);
  const nomesEncerrado = [...nomesResolvido, ...nomesFechado, ...nomesCancelado];
  const nomesResolvidoFechado = [...nomesResolvido, ...nomesFechado];

  const pContadores = {}, pVencidos = {}, pProx = {}, pTempo = {};
  const condAberto = condicaoStatusIn('status', nomesAberto, 'ab', pContadores);
  const condAndamento = condicaoStatusIn('status', nomesAndamento, 'an', pContadores);
  const condResolvido = condicaoStatusIn('status', nomesResolvido, 're', pContadores);
  const condFechado = condicaoStatusIn('status', nomesFechado, 'fe', pContadores);
  const condNaoEncerrado1 = condicaoStatusIn('status', nomesEncerrado, 'nc1', pVencidos);
  const condNaoEncerrado2 = condicaoStatusIn('status', nomesEncerrado, 'nc2', pProx);
  const condResolvidoFechado = condicaoStatusIn('status', nomesResolvidoFechado, 'rf', pTempo);

  const [contadores, vencidos, proxVencimento, tempoMedio, porCategoria, porPrioridade, porStatus, porMes, porUnidade] = await Promise.all([
    query(`
      SELECT
        SUM(CASE WHEN ${condAberto} THEN 1 ELSE 0 END) AS abertos,
        SUM(CASE WHEN ${condAndamento} THEN 1 ELSE 0 END) AS em_andamento,
        SUM(CASE WHEN ${condResolvido} AND CAST(atualizado_em AS DATE) = CAST(SYSUTCDATETIME() AS DATE) THEN 1 ELSE 0 END) AS resolvidos_hoje,
        SUM(CASE WHEN ${condFechado} THEN 1 ELSE 0 END) AS fechados
      FROM dbo.EQUIPSTI_chamados_intecs ${whereClause}
    `, { ...params, ...pContadores }),
    query(`
      SELECT COUNT(*) AS total FROM dbo.EQUIPSTI_chamados_intecs
      ${whereClause ? whereClause + ' AND' : 'WHERE'} NOT (${condNaoEncerrado1}) AND sla_conclusao_prazo < SYSUTCDATETIME()
    `, { ...params, ...pVencidos }),
    query(`
      SELECT COUNT(*) AS total FROM dbo.EQUIPSTI_chamados_intecs
      ${whereClause ? whereClause + ' AND' : 'WHERE'} NOT (${condNaoEncerrado2})
        AND sla_conclusao_prazo BETWEEN SYSUTCDATETIME() AND DATEADD(HOUR, 2, SYSUTCDATETIME())
    `, { ...params, ...pProx }),
    query(`
      SELECT
        AVG(CASE WHEN sla_respondido_em IS NOT NULL THEN DATEDIFF(MINUTE, criado_em, sla_respondido_em) END) AS media_atendimento_min,
        AVG(CASE WHEN ${condResolvidoFechado} THEN DATEDIFF(MINUTE, criado_em, atualizado_em) END) AS media_resolucao_min
      FROM dbo.EQUIPSTI_chamados_intecs ${whereClause}
    `, { ...params, ...pTempo }),
    query(`
      SELECT ISNULL(cat.nome, 'Sem categoria') AS categoria, COUNT(*) AS total
      FROM dbo.EQUIPSTI_chamados_intecs c
      LEFT JOIN dbo.EQUIPSTI_chamados_intecs_categorias cat ON cat.id = c.categoria_id
      ${whereClause.replace('usuario_id', 'c.usuario_id')}
      GROUP BY cat.nome
    `, params),
    query(`SELECT prioridade, COUNT(*) AS total FROM dbo.EQUIPSTI_chamados_intecs ${whereClause} GROUP BY prioridade`, params),
    query(`SELECT status, COUNT(*) AS total FROM dbo.EQUIPSTI_chamados_intecs ${whereClause} GROUP BY status`, params),
    query(`
      SELECT FORMAT(criado_em, 'yyyy-MM') AS mes, COUNT(*) AS total
      FROM dbo.EQUIPSTI_chamados_intecs ${whereClause} GROUP BY FORMAT(criado_em, 'yyyy-MM')
    `, params),
    query(`
      SELECT ISNULL(NULLIF(unidade, ''), 'Sem unidade') AS unidade, COUNT(*) AS total
      FROM dbo.EQUIPSTI_chamados_intecs ${whereClause} GROUP BY ISNULL(NULLIF(unidade, ''), 'Sem unidade')
    `, params)
  ]);

  return {
    ...contadores.recordset[0],
    vencidos: vencidos.recordset[0].total,
    sla_proximos_vencimento: proxVencimento.recordset[0].total,
    tempo_medio_atendimento_min: tempoMedio.recordset[0].media_atendimento_min,
    tempo_medio_resolucao_min: tempoMedio.recordset[0].media_resolucao_min,
    por_categoria: porCategoria.recordset,
    por_prioridade: porPrioridade.recordset,
    por_status: porStatus.recordset,
    por_mes: porMes.recordset,
    por_unidade: porUnidade.recordset
  };
}

// IDs de usuário que pertencem a alguma das combinações unidade+setor
// informadas (equipes supervisionadas por um Gestor) — usado pra escopar
// lista e dashboard.
export async function getUsuarioIdsDaEquipe(equipes) {
  if (!equipes.length) return [];
  const params = {};
  const condicoes = equipes.map((e, i) => {
    params[`unidade${i}`] = S(e.unidade);
    params[`setor${i}`] = S(e.setor);
    return `(unidade = @unidade${i} AND setor = @setor${i})`;
  });
  const result = await query(
    `SELECT id FROM dbo.EQUIPSTI_usuarios WHERE ${condicoes.join(' OR ')}`,
    params
  );
  return result.recordset.map((r) => r.id);
}

// Usuários que podem ser atribuídos como responsável de um chamado
// (Técnico/Master) — usado no dropdown "Responsável" e no filtro da lista.
export async function listarAtendentes() {
  const result = await query(
    "SELECT id, email FROM dbo.EQUIPSTI_usuarios WHERE role IN ('TECNICO','MASTER') AND ativo = 1 ORDER BY email"
  );
  return result.recordset;
}

// ---------- Administração (só Master) ----------

export async function listarUsuariosComPapel() {
  const result = await query(
    'SELECT id, email, role, unidade, setor, ativo, permissoes FROM dbo.EQUIPSTI_usuarios ORDER BY email'
  );
  return result.recordset;
}

export async function atualizarPapelUsuario(id, { role, unidade, setor, permissoesJson = null }) {
  await query(
    `UPDATE dbo.EQUIPSTI_usuarios SET role = @role, unidade = @unidade, setor = @setor, permissoes = @permissoes WHERE id = @id`,
    { id: N(id), role: S(role), unidade: S(unidade), setor: S(setor), permissoes: S(permissoesJson) }
  );
}

