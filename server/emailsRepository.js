// ============================================================
//  Catálogo de e-mails (dbo.EQUIPSTI_emails + _membros).
//
//  Duas leituras bem diferentes saem daqui:
//    - listarPublico(): o buscador /emails, que qualquer pessoa logada usa.
//      Só o que está ativo e visível.
//    - listarAdmin(): a aba "E-mails" do Gestão TI, que vê tudo — inclusive
//      o que está oculto ou inativo, senão a TI não teria como reverter.
//
//  A importação da Locaweb (importarLocaweb) é um upsert por endereço:
//  o e-mail é a identidade da linha. Nada é apagado — o que sumiu do painel
//  vira ativo = 0, porque endereço desativado ainda explica e-mail antigo.
// ============================================================
import { query, sql } from './db.js';

export const TIPOS = ['GRUPO', 'CAIXA', 'CONTATO'];

const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));
const S = (v, n) => ({ type: sql.NVarChar, value: trunc(v, n) });
const I = (v) => ({ type: sql.Int, value: v == null ? null : (Number(v) || null) });
const B = (v) => ({ type: sql.Bit, value: v ? 1 : 0 });

// 9 colunas × 100 linhas = 900 parâmetros, com folga no teto de 2100 do SQL Server.
const LOTE = 100;

const SELECT_BASE = `
  SELECT e.id, e.tipo, e.email, e.nome, e.descricao, e.origem, e.externo_id AS externoId,
         e.oculto, e.ativo, e.desativado, e.sincronizado_em AS sincronizadoEm,
         e.criado_em AS criadoEm, e.atualizado_em AS atualizadoEm,
         e.criado_por AS criadoPor, e.atualizado_por AS atualizadoPor,
         (SELECT COUNT(*) FROM dbo.EQUIPSTI_emails_membros m WHERE m.email_id = e.id) AS totalMembros
    FROM dbo.EQUIPSTI_emails e`;

// Mesmo escape de curinga do LIKE usado em server/logs.js.
function condicaoBusca(q, params) {
  const termo = String(q).replace(/[\\%_[]/g, '\\$&');
  params.q = S(`%${termo}%`, 400);
  return `(e.email LIKE @q ESCAPE '\\' OR e.nome LIKE @q ESCAPE '\\'`
    + ` OR e.descricao LIKE @q ESCAPE '\\'`
    // Achar o grupo pelo nome de quem recebe ("para onde vai e-mail da Camilla?").
    + ` OR EXISTS (SELECT 1 FROM dbo.EQUIPSTI_emails_membros m`
    + `             WHERE m.email_id = e.id AND m.membro_email LIKE @q ESCAPE '\\'))`;
}

// Anexa os integrantes às linhas de grupo (uma consulta só para o conjunto todo).
async function comMembros(linhas) {
  const idsGrupo = linhas.filter((l) => l.totalMembros > 0).map((l) => l.id);
  if (!idsGrupo.length) return linhas.map((l) => ({ ...l, membros: [] }));

  const params = {};
  const nomes = idsGrupo.map((id, i) => { params['g' + i] = I(id); return '@g' + i; });
  const r = await query(
    `SELECT email_id AS emailId, membro_email AS email, membro_tipo AS tipo
       FROM dbo.EQUIPSTI_emails_membros
      WHERE email_id IN (${nomes.join(',')})
      ORDER BY membro_email`,
    params
  );

  const porId = new Map();
  for (const m of r.recordset) {
    if (!porId.has(m.emailId)) porId.set(m.emailId, []);
    porId.get(m.emailId).push({ email: m.email, tipo: m.tipo });
  }
  return linhas.map((l) => ({ ...l, membros: porId.get(l.id) || [] }));
}

/**
 * Buscador público (exige login, não exige permissão de aba).
 *
 * Três razões distintas para um endereço não aparecer aqui, e todas contam:
 * sumiu do painel (ativo = 0), está "Desativada" no painel (desativado = 1) ou
 * a TI escondeu (oculto = 1). Mandar alguém escrever para conta desativada é
 * exatamente o erro que este catálogo existe para evitar.
 */
export async function listarPublico({ q = null, tipo = null } = {}) {
  const params = {};
  const where = ['e.ativo = 1', 'e.desativado = 0', 'e.oculto = 0'];

  if (q) where.push(condicaoBusca(q, params));
  if (tipo && TIPOS.includes(tipo)) { params.tipo = S(tipo, 10); where.push('e.tipo = @tipo'); }

  const r = await query(
    `${SELECT_BASE} WHERE ${where.join(' AND ')} ORDER BY e.tipo DESC, e.email`,
    params
  );
  return comMembros(r.recordset);
}

/** Tela da TI: tudo, inclusive oculto e inativo. */
export async function listarAdmin({ q = null } = {}) {
  const params = {};
  const where = q ? `WHERE ${condicaoBusca(q, params)}` : '';
  const r = await query(`${SELECT_BASE} ${where} ORDER BY e.tipo DESC, e.email`, params);
  return comMembros(r.recordset);
}

export async function obter(id) {
  const r = await query(`${SELECT_BASE} WHERE e.id = @id`, { id: I(id) });
  if (!r.recordset.length) return null;
  return (await comMembros(r.recordset))[0];
}

export async function existeEmail(email, ignorarId = null) {
  const r = await query(
    `SELECT id FROM dbo.EQUIPSTI_emails WHERE email = @email${ignorarId ? ' AND id <> @id' : ''}`,
    ignorarId ? { email: S(email, 255), id: I(ignorarId) } : { email: S(email, 255) }
  );
  return r.recordset.length > 0;
}

/** Cadastro manual. Devolve a linha criada. */
export async function criar({ tipo, email, nome, descricao, oculto }, usuario) {
  const r = await query(
    `INSERT INTO dbo.EQUIPSTI_emails (tipo, email, nome, descricao, origem, oculto, criado_por, atualizado_por)
     OUTPUT INSERTED.id
     VALUES (@tipo, @email, @nome, @descricao, 'MANUAL', @oculto, @usuario, @usuario)`,
    {
      tipo: S(tipo, 10),
      email: S(String(email).trim().toLowerCase(), 255),
      nome: S(nome, 255),
      descricao: S(descricao, 500),
      oculto: B(oculto),
      usuario: S(usuario, 255)
    }
  );
  return obter(r.recordset[0].id);
}

/**
 * Edição pela tela da TI. `email` e `tipo` de linha vinda da Locaweb também
 * podem ser corrigidos — mas a próxima importação manda de volta, porque lá
 * o endereço é a identidade.
 */
export async function atualizar(id, { tipo, email, nome, descricao, oculto }, usuario) {
  await query(
    `UPDATE dbo.EQUIPSTI_emails
        SET tipo = @tipo, email = @email, nome = @nome, descricao = @descricao,
            oculto = @oculto, atualizado_em = SYSUTCDATETIME(), atualizado_por = @usuario
      WHERE id = @id`,
    {
      id: I(id),
      tipo: S(tipo, 10),
      email: S(String(email).trim().toLowerCase(), 255),
      nome: S(nome, 255),
      descricao: S(descricao, 500),
      oculto: B(oculto),
      usuario: S(usuario, 255)
    }
  );
  return obter(id);
}

export async function excluir(id) {
  const r = await query('DELETE FROM dbo.EQUIPSTI_emails WHERE id = @id', { id: I(id) });
  return (r.rowsAffected || []).reduce((a, b) => a + b, 0) > 0;
}

async function inserirEmLote(linhas, usuario) {
  const COLUNAS = 'tipo, email, nome, origem, externo_id, oculto, ativo, desativado, sincronizado_em, criado_por, atualizado_por';
  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE);
    const params = { usuario: S(usuario, 255) };
    const tuplas = lote.map((l, idx) => {
      params['t' + idx] = S(l.tipo, 10);
      params['e' + idx] = S(l.email, 255);
      params['n' + idx] = S(l.nome, 255);
      params['x' + idx] = S(l.externoId, 50);
      params['d' + idx] = B(l.desativada);
      return `(@t${idx}, @e${idx}, @n${idx}, 'LOCAWEB', @x${idx}, 0, 1, @d${idx}, SYSUTCDATETIME(), @usuario, @usuario)`;
    });
    await query(`INSERT INTO dbo.EQUIPSTI_emails (${COLUNAS}) VALUES ${tuplas.join(',')}`, params);
  }
}

// Integrantes são substituídos por inteiro: ~10 linhas por grupo, um diff aqui
// custaria mais código do que economiza escrita.
async function regravarMembros(emailId, membros) {
  await query('DELETE FROM dbo.EQUIPSTI_emails_membros WHERE email_id = @id', { id: I(emailId) });
  if (!membros.length) return;

  for (let i = 0; i < membros.length; i += LOTE) {
    const lote = membros.slice(i, i + LOTE);
    const params = { id: I(emailId) };
    const tuplas = lote.map((m, idx) => {
      params['m' + idx] = S(m.email, 255);
      params['k' + idx] = S(m.tipo === 'external' ? 'external' : 'internal', 10);
      return `(@id, @m${idx}, @k${idx})`;
    });
    await query(
      `INSERT INTO dbo.EQUIPSTI_emails_membros (email_id, membro_email, membro_tipo)
       VALUES ${tuplas.join(',')}`,
      params
    );
  }
}

/**
 * Aplica o resultado de parsePainelLocaweb(). Upsert por endereço.
 *
 * São DUAS páginas do painel, cada uma sabendo de coisas diferentes, e a
 * importação só mexe naquilo que a página colada realmente conhece:
 *
 *   GRUPOS  → os 49 grupos (com integrantes) e a lista de caixas existentes.
 *             Não sabe nome de caixa nem quem está "Desativada".
 *   CAIXAS  → as 146 caixas com NOME e o estado "Desativada".
 *             Não sabe nada de grupo.
 *
 * Daí o `escopo`: a inativação por ausência só vale para os tipos que a página
 * enumera. Sem isso, colar a página de caixas inativaria os 49 grupos de uma vez.
 *
 * O que a importação NUNCA sobrescreve: `descricao` e `oculto` — o painel não
 * tem esses campos, são trabalho da TI aqui dentro. `nome` é sobrescrito
 * quando o painel tem um: a descrição do grupo, ou o nome da caixa. Caixa sem
 * nome no painel (6 hoje) mantém o que estiver gravado, para não apagar o que
 * alguém digitou à mão.
 *
 * @returns {{pagina:string, grupos:number, caixas:number, novos:number,
 *            atualizados:number, inativados:number, desativadas:number}}
 */
export async function importarLocaweb({ pagina = 'GRUPOS', grupos = [], caixas = [] }, usuario) {
  const ehPaginaDeCaixas = pagina === 'CAIXAS';
  const entradas = [
    ...grupos.map((g) => ({ tipo: 'GRUPO', email: g.email, nome: g.nome, externoId: g.externoId, membros: g.membros || [] })),
    ...caixas.map((c) => ({
      tipo: 'CAIXA', email: c.email, externoId: c.externoId, membros: [],
      // A página de grupos não traz nome nem estado: manda null e o UPDATE
      // preserva o que já existe.
      nome: ehPaginaDeCaixas ? (c.nome || null) : null,
      desativada: ehPaginaDeCaixas ? !!c.desativada : null
    }))
  ].filter((x) => x.email);

  const escopo = ehPaginaDeCaixas ? ['CAIXA'] : ['GRUPO', 'CAIXA'];

  const existentes = await query('SELECT id, email, tipo, origem, ativo FROM dbo.EQUIPSTI_emails');
  const porEmail = new Map(existentes.recordset.map((l) => [l.email.toLowerCase(), l]));

  const novos = entradas.filter((x) => !porEmail.has(x.email));
  const jaExistiam = entradas.filter((x) => porEmail.has(x.email));

  await inserirEmLote(novos, usuario);

  for (const x of jaExistiam) {
    const atual = porEmail.get(x.email);
    // Só entra no SET o que ESTA página sabe: nome quando o painel tem um,
    // desativado só quando veio da página de caixas.
    const temNome = x.nome != null && x.nome !== '';
    const temEstado = x.desativada != null;
    await query(
      `UPDATE dbo.EQUIPSTI_emails
          SET tipo = @tipo, origem = 'LOCAWEB', externo_id = @externoId, ativo = 1,
              nome = ${temNome ? '@nome' : 'nome'},
              desativado = ${temEstado ? '@desativado' : 'desativado'},
              sincronizado_em = SYSUTCDATETIME(), atualizado_em = SYSUTCDATETIME(),
              atualizado_por = @usuario
        WHERE id = @id`,
      {
        id: I(atual.id),
        tipo: S(x.tipo, 10),
        externoId: S(x.externoId, 50),
        ...(temNome ? { nome: S(x.nome, 255) } : {}),
        ...(temEstado ? { desativado: B(x.desativada) } : {}),
        usuario: S(usuario, 255)
      }
    );
  }

  // Regrava os integrantes com os ids finais (os recém-inseridos ainda não
  // tinham id na volta do lote).
  const idsFinais = await query('SELECT id, email FROM dbo.EQUIPSTI_emails');
  const idPorEmail = new Map(idsFinais.recordset.map((l) => [l.email.toLowerCase(), l.id]));
  for (const g of grupos) {
    const id = idPorEmail.get(String(g.email || '').toLowerCase());
    if (id) await regravarMembros(id, g.membros || []);
  }

  // Some do painel → inativa, não apaga. Só mexe no que veio da Locaweb
  // (contato manual não some por não estar na página) e só nos tipos que ESTA
  // página enumera — senão colar a página de caixas mataria os 49 grupos.
  // O conjunto é calculado aqui, e não com um NOT IN gigante, para o teto de
  // 2100 parâmetros não virar limite de tamanho do domínio.
  const vivos = new Set(entradas.map((x) => x.email));
  const orfaos = existentes.recordset
    .filter((l) => l.origem === 'LOCAWEB' && l.ativo
      && escopo.includes(l.tipo) && !vivos.has(l.email.toLowerCase()))
    .map((l) => l.id);

  for (let i = 0; i < orfaos.length; i += LOTE) {
    const params = {};
    const nomes = orfaos.slice(i, i + LOTE).map((id, idx) => { params['o' + idx] = I(id); return '@o' + idx; });
    await query(
      `UPDATE dbo.EQUIPSTI_emails
          SET ativo = 0, atualizado_em = SYSUTCDATETIME()
        WHERE id IN (${nomes.join(',')})`,
      params
    );
  }

  return {
    pagina,
    grupos: grupos.length,
    caixas: caixas.length,
    novos: novos.length,
    atualizados: jaExistiam.length,
    inativados: orfaos.length,
    desativadas: ehPaginaDeCaixas ? caixas.filter((c) => c.desativada).length : 0,
    comNome: ehPaginaDeCaixas ? caixas.filter((c) => c.nome).length : grupos.length
  };
}
