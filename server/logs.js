// ============================================================
//  Auditoria unificada (tabela dbo.EQUIPSTI_logs).
//
//  Uma linha por ação HUMANA que toca o banco (ou, no caso da
//  Conexão Remota, por acesso a uma máquina). Cada módulo grava
//  aqui via registrarLog(); a aba "Logs" e os ícones de histórico
//  por aba leem via listarLogs().
//
//  registrarLog() NUNCA lança — qualquer falha é só logada, para
//  nunca derrubar a operação principal (criar registro, chamado,
//  conectar numa máquina...). E é SEMPRE aguardado antes do
//  res.json: em serverless (Vercel) a invocação congela assim que
//  a resposta HTTP sai, e um INSERT em segundo plano se perderia
//  no meio — mesma razão de notificacoes.js.
// ============================================================
import { query, sql } from './db.js';

// Módulos válidos — whitelist da rota GET /api/logs e do <select> do front.
export const MODULOS_LOG = [
  'REGISTROS', 'EMPRESTIMOS', 'CHAMADOS_INTECS', 'CHAMADOS_MSA',
  'CONEXAO_REMOTA', 'INTERNET', 'CALENDARIO', 'OPCOES', 'USUARIOS'
];

// NVARCHAR curto (com tamanho definido na coluna) — trunca defensivamente.
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });
// NVARCHAR(MAX) — valores antigos/novos podem ser grandes (descrições); não trunca.
const SMAX = (v) => ({ type: sql.NVarChar(sql.MAX), value: v == null ? null : String(v) });

/**
 * Grava uma linha de auditoria. NUNCA lança. SEMPRE aguardar antes de responder.
 * @param {object} o
 * @param {string} o.modulo          um de MODULOS_LOG
 * @param {string|number} [o.entidadeId]     id do item afetado (cabe int, agentId, código MSA)
 * @param {string} [o.entidadeRotulo]        rótulo legível ("PAT 1234 · Notebook", hostname, "Chamado #57")
 * @param {string} o.acao            CRIADO|ATUALIZADO|EXCLUIDO|CONEXAO|SCRIPT_EXECUTADO|...
 * @param {string} [o.campo]         campo alterado (rótulo)
 * @param {string} [o.valorAnterior]
 * @param {string} [o.valorNovo]
 * @param {string} [o.justificativa]
 * @param {string} o.usuario         email de quem executou
 * @param {number} [o.usuarioId]
 */
export async function registrarLog({
  modulo, entidadeId = null, entidadeRotulo = null, acao,
  campo = null, valorAnterior = null, valorNovo = null,
  justificativa = null, usuario, usuarioId = null
}) {
  try {
    if (!modulo || !acao) { console.warn('[logs] modulo/acao ausentes — ignorado'); return; }
    await query(
      `INSERT INTO dbo.EQUIPSTI_logs
         (modulo, entidade_id, entidade_rotulo, acao, campo, valor_anterior, valor_novo, justificativa, usuario, usuario_id)
       VALUES (@modulo, @entidadeId, @entidadeRotulo, @acao, @campo, @valorAnterior, @valorNovo, @justificativa, @usuario, @usuarioId)`,
      {
        modulo: S(trunc(modulo, 30)),
        entidadeId: S(trunc(entidadeId, 100)),
        entidadeRotulo: S(trunc(entidadeRotulo, 255)),
        acao: S(trunc(acao, 40)),
        campo: S(trunc(campo, 150)),
        valorAnterior: SMAX(valorAnterior),
        valorNovo: SMAX(valorNovo),
        justificativa: S(trunc(justificativa, 500)),
        usuario: S(trunc(usuario, 255) || 'desconhecido'),
        usuarioId: usuarioId == null ? null : (Number(usuarioId) || null)
      }
    );
  } catch (err) {
    console.warn('[logs] registrarLog falhou:', err.message);
  }
}

/**
 * Lê o log com filtros. Lança normalmente (as rotas usam wrap()).
 * @param {object} [f]
 * @param {string} [f.modulo]      restringe a um módulo (aba/ícone)
 * @param {string|number} [f.entidadeId]  restringe a um item (leituras por registro/chamado)
 * @param {string} [f.q]           busca (LIKE) em ação/campo/valores/rótulo/usuário/justificativa
 * @param {Date}   [f.de]          data_hora >= de
 * @param {Date}   [f.ate]         data_hora < ate  (limite superior EXCLUSIVO)
 * @param {number} [f.limit=50]
 * @param {number} [f.offset=0]
 * @returns {Promise<Array>} linhas { id, modulo, entidadeId, entidadeRotulo, acao, campo,
 *   valorAnterior, valorNovo, justificativa, usuario, usuarioId, dataHora }.
 *   dataHora sai crua (Date do driver → ISO com 'Z' no JSON) — o front formata em hora local.
 */
export async function listarLogs({ modulo = null, entidadeId = null, q = null, de = null, ate = null, limit = 50, offset = 0 } = {}) {
  const params = {};
  const where = [];

  if (modulo) { params.modulo = S(modulo); where.push('modulo = @modulo'); }
  if (entidadeId != null) { params.entidadeId = S(String(entidadeId)); where.push('entidade_id = @entidadeId'); }
  if (q) {
    // Escapa curingas do LIKE (%, _, [) para a busca ser literal.
    const termo = String(q).replace(/[\\%_[]/g, '\\$&');
    params.q = S(`%${termo}%`);
    where.push(`(acao LIKE @q ESCAPE '\\' OR campo LIKE @q ESCAPE '\\'`
      + ` OR valor_anterior LIKE @q ESCAPE '\\' OR valor_novo LIKE @q ESCAPE '\\'`
      + ` OR entidade_rotulo LIKE @q ESCAPE '\\' OR usuario LIKE @q ESCAPE '\\'`
      + ` OR justificativa LIKE @q ESCAPE '\\')`);
  }
  if (de instanceof Date && !isNaN(de)) { params.de = { type: sql.DateTime2, value: de }; where.push('data_hora >= @de'); }
  if (ate instanceof Date && !isNaN(ate)) { params.ate = { type: sql.DateTime2, value: ate }; where.push('data_hora < @ate'); }

  params.limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  params.offset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query(
    `SELECT id, modulo, entidade_id AS entidadeId, entidade_rotulo AS entidadeRotulo,
            acao, campo, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
            justificativa, usuario, usuario_id AS usuarioId, data_hora AS dataHora
       FROM dbo.EQUIPSTI_logs
       ${whereSql}
      ORDER BY id DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    params
  );
  return r.recordset;
}
