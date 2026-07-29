// ============================================================
//  Persistência dos eventos de auditoria do Drive
//  (tabela dbo.EQUIPSTI_google_drive_eventos).
//
//  A deduplicação NÃO é feita aqui: o índice único
//  UQ_EQUIPSTI_gdrive_evento é criado com IGNORE_DUP_KEY = ON, então
//  reinserir a janela de sobreposição do sync é um no-op silencioso e
//  o rowsAffected já volta só com as linhas realmente novas.
// ============================================================
import { query, sql } from '../db.js';

const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const S = (v, n) => ({ type: sql.NVarChar, value: trunc(v, n) });
const SMAX = (v) => ({ type: sql.NVarChar(sql.MAX), value: v == null ? null : String(v) });
const DT = (v) => ({ type: sql.DateTime2, value: v instanceof Date && !isNaN(v) ? v : null });
const B = (v) => ({ type: sql.Bit, value: v ? 1 : 0 });

// Ordem fixa das colunas do INSERT — usada para montar os VALUES em lote.
const COLUNAS = [
  'data_evento', 'qualificador', 'evento', 'ator_email', 'ip',
  'doc_id', 'doc_titulo', 'doc_tipo', 'proprietario',
  'drive_compartilhado', 'em_drive_compartilhado',
  'origem', 'app_origem_id', 'visibilidade', 'alvo',
  'valor_anterior', 'valor_novo', 'parametros_json'
];

// 18 colunas × 100 linhas = 1800 parâmetros, com folga no teto de 2100
// por requisição do SQL Server.
const LOTE = 100;

function valoresDaLinha(l) {
  return [
    DT(l.dataEvento),
    S(l.qualificador, 40),
    S(l.evento, 60),
    S(l.atorEmail, 255),
    S(l.ip, 45),
    S(l.docId, 200),
    S(l.docTitulo, 500),
    S(l.docTipo, 60),
    S(l.proprietario, 255),
    S(l.driveCompartilhado, 200),
    B(l.emDriveCompartilhado),
    S(l.origem, 20),
    S(l.appOrigemId, 120),
    S(l.visibilidade, 80),
    S(l.alvo, 255),
    S(l.valorAnterior, 500),
    S(l.valorNovo, 500),
    SMAX(l.parametrosJson)
  ];
}

/**
 * Grava as linhas normalizadas. Devolve quantas eram realmente novas
 * (as repetidas caem no IGNORE_DUP_KEY e não contam).
 */
export async function salvarEventos(linhas) {
  let inseridos = 0;

  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE);
    const params = {};
    const tuplas = lote.map((linha, idx) => {
      const valores = valoresDaLinha(linha);
      const nomes = valores.map((valor, c) => {
        const nome = `p${idx}_${c}`;
        params[nome] = valor;
        return '@' + nome;
      });
      return '(' + nomes.join(',') + ')';
    });

    const r = await query(
      `INSERT INTO dbo.EQUIPSTI_google_drive_eventos (${COLUNAS.join(', ')})
       VALUES ${tuplas.join(',')}`,
      params
    );
    inseridos += (r.rowsAffected || []).reduce((a, b) => a + b, 0);
  }

  return inseridos;
}

/**
 * Data/hora do evento mais recente já gravado (UTC) — é o cursor do sync.
 * null quando a tabela ainda está vazia (primeira execução).
 */
export async function ultimoEventoUtc() {
  const r = await query('SELECT MAX(data_evento) AS ultimo FROM dbo.EQUIPSTI_google_drive_eventos');
  const ultimo = r.recordset[0]?.ultimo;
  return ultimo instanceof Date && !isNaN(ultimo) ? ultimo : null;
}

/**
 * Lê os eventos gravados. Espelha listarLogs() de server/logs.js:
 * mesmo escape de curinga no LIKE, mesmo OFFSET/FETCH, mesmo teto de 200.
 * @param {object} [f]
 * @param {string} [f.q]        busca em arquivo/usuário/dono/evento
 * @param {string[]} [f.eventos] restringe a estes eventos
 * @param {string} [f.proprietario] dono do arquivo (drive compartilhado ou e-mail)
 * @param {Date}   [f.de]       data_evento >= de
 * @param {Date}   [f.ate]      data_evento < ate (limite superior EXCLUSIVO)
 */
export async function listarEventos({ q = null, eventos = null, proprietario = null, de = null, ate = null, limit = 50, offset = 0 } = {}) {
  const params = {};
  const where = [];

  if (q) {
    const termo = String(q).replace(/[\\%_[]/g, '\\$&');
    params.q = S(`%${termo}%`, 400);
    where.push(`(doc_titulo LIKE @q ESCAPE '\\' OR ator_email LIKE @q ESCAPE '\\'`
      + ` OR proprietario LIKE @q ESCAPE '\\' OR evento LIKE @q ESCAPE '\\'`
      + ` OR alvo LIKE @q ESCAPE '\\' OR doc_id LIKE @q ESCAPE '\\')`);
  }
  if (Array.isArray(eventos) && eventos.length) {
    const nomes = eventos.map((e, i) => {
      params['ev' + i] = S(e, 60);
      return '@ev' + i;
    });
    where.push(`evento IN (${nomes.join(',')})`);
  }
  if (proprietario) { params.prop = S(proprietario, 255); where.push('proprietario = @prop'); }
  if (de instanceof Date && !isNaN(de)) { params.de = DT(de); where.push('data_evento >= @de'); }
  if (ate instanceof Date && !isNaN(ate)) { params.ate = DT(ate); where.push('data_evento < @ate'); }

  params.limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  params.offset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await query(
    `SELECT id, data_evento AS dataEvento, evento, ator_email AS atorEmail, ip,
            doc_id AS docId, doc_titulo AS docTitulo, doc_tipo AS docTipo,
            proprietario, drive_compartilhado AS driveCompartilhado,
            em_drive_compartilhado AS emDriveCompartilhado,
            origem, app_origem_id AS appOrigemId, visibilidade, alvo,
            valor_anterior AS valorAnterior, valor_novo AS valorNovo
       FROM dbo.EQUIPSTI_google_drive_eventos
       ${whereSql}
      ORDER BY data_evento DESC, id DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    params
  );
  return r.recordset;
}

/**
 * Donos distintos já gravados — alimenta o select da toolbar. Sai do banco
 * inteiro (não da página carregada), senão o filtro só veria os 50 da tela.
 * Só drives compartilhados: dono pessoa física é um e-mail, não um HD.
 */
export async function listarProprietarios() {
  const r = await query(
    `SELECT proprietario
       FROM dbo.EQUIPSTI_google_drive_eventos
      WHERE proprietario IS NOT NULL AND proprietario <> ''
        AND em_drive_compartilhado = 1
      GROUP BY proprietario
      ORDER BY proprietario`
  );
  return r.recordset.map((x) => x.proprietario);
}

/** Apaga eventos mais antigos que `dias`. dias <= 0 desliga a limpeza. */
export async function purgar(dias) {
  const d = Number(dias);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const limite = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
  const r = await query(
    'DELETE FROM dbo.EQUIPSTI_google_drive_eventos WHERE data_evento < @limite',
    { limite: DT(limite) }
  );
  return (r.rowsAffected || []).reduce((a, b) => a + b, 0);
}
