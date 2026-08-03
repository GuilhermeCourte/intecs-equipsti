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
//  res.json. Isso começou como restrição do serverless (na Vercel a
//  invocação congelava assim que a resposta saía e o INSERT se
//  perdia), mas continua de propósito na VPS: é um INSERT de
//  milissegundos, e auditoria sumindo em silêncio é pior que a
//  latência que ele custa. Diferente do e-mail em notificacoes.js,
//  que passou a ser disparado em segundo plano.
// ============================================================
import { query, sql } from './db.js';

// Módulos válidos — whitelist da rota GET /api/logs e do <select> do front.
export const MODULOS_LOG = [
  'REGISTROS', 'EMPRESTIMOS', 'CHAMADOS_INTECS', 'CHAMADOS_MSA',
  'CONEXAO_REMOTA', 'INTERNET', 'SENHAS', 'CALENDARIO', 'OPCOES', 'USUARIOS',
  // ACESSO é o único módulo que não registra ação de gente logada: são as
  // tentativas de login bloqueadas por excesso de erro (ver server/index.js).
  'ACESSO'
];

// Recorte de segurança do log: os pares (modulo, acao[, campo]) que valem um
// aviso na Visão Geral e no cockpit. A definição vive aqui, e não no front,
// porque `acao` sozinha não basta — ATUALIZADO é genérico e aparece em todo
// módulo; só o par com `campo` separa "mudaram as permissões de alguém" de
// "trocaram o e-mail".
//
// ALERTA: alguém foi barrado, ganhou poder ou leu um segredo.
// INFO:   acesso legítimo à máquina de outra pessoa — rotina do técnico, mas
//         auditável. Fica fora do card do dashboard, que encheria todo dia.
//
// Duas coisas que NÃO dá para listar aqui porque não são gravadas: falha de
// login individual (só o bloqueio agregado, após 10 tentativas) e 403 de
// permissão negada.
export const EVENTOS_SEGURANCA = {
  ALERTA: [
    { modulo: 'ACESSO',   acao: 'LOGIN_BLOQUEADO' },
    { modulo: 'USUARIOS', acao: 'ATUALIZADO', campo: 'PERMISSÕES' },
    { modulo: 'USUARIOS', acao: 'ATUALIZADO', campo: 'PAPEL' },
    { modulo: 'USUARIOS', acao: 'SENHA_REDEFINIDA' },
    { modulo: 'SENHAS',   acao: 'SENHA_REVELADA' }
  ],
  INFO: [
    { modulo: 'CONEXAO_REMOTA', acao: 'CONEXAO' },
    { modulo: 'CONEXAO_REMOTA', acao: 'SCRIPT_EXECUTADO' }
  ]
};

// Valores aceitos em ?seguranca= — whitelist da rota GET /api/logs.
export const NIVEIS_SEGURANCA = ['alerta', 'todos'];

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
 * @param {string} [f.seguranca]   'alerta' | 'todos' — recorte de EVENTOS_SEGURANCA
 * @param {number} [f.limit=50]
 * @param {number} [f.offset=0]
 * @returns {Promise<Array>} linhas { id, modulo, entidadeId, entidadeRotulo, acao, campo,
 *   valorAnterior, valorNovo, justificativa, usuario, usuarioId, dataHora }.
 *   dataHora sai crua (Date do driver → ISO com 'Z' no JSON) — o front formata em hora local.
 */
export async function listarLogs({ modulo = null, entidadeId = null, q = null, de = null, ate = null, seguranca = null, limit = 50, offset = 0 } = {}) {
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
  if (seguranca) {
    // Um OR de pares em vez de várias chamadas filtradas no cliente: assim o
    // ORDER BY id DESC + limit vê o conjunto inteiro, e um módulo barulhento
    // (CONEXAO_REMOTA) não empurra um LOGIN_BLOQUEADO para fora do resultado.
    const pares = seguranca === 'todos'
      ? [...EVENTOS_SEGURANCA.ALERTA, ...EVENTOS_SEGURANCA.INFO]
      : EVENTOS_SEGURANCA.ALERTA;
    const ors = pares.map((p, i) => {
      params[`sm${i}`] = S(p.modulo);
      params[`sa${i}`] = S(p.acao);
      let cond = `(modulo = @sm${i} AND acao = @sa${i}`;
      if (p.campo) { params[`sc${i}`] = S(p.campo); cond += ` AND campo = @sc${i}`; }
      return `${cond})`;
    });
    where.push(`(${ors.join(' OR ')})`);
  }

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
