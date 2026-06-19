// ============================================================
//  API + servidor estático — Revalidação de Inventário
// ============================================================
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query, sql } from './db.js';
import { gerarToken, exigirAuth } from './auth.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(cors());
app.use(express.json());

const OPTION_LISTS = ['UNIDADE', 'STATUS', 'SETOR', 'EQUIPAMENTO', 'INSUMOS'];
const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });
const trim = (v) => String(v == null ? '' : v).trim();

// Encapsula handlers async e encaminha erros.
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erro interno.' });
});

// ===================== AUTH =====================
app.post('/api/auth/login', wrap(async (req, res) => {
  const email = trim(req.body.email).toLowerCase();
  const senha = String(req.body.senha || '');
  if (!email || !senha) return res.status(400).json({ error: 'Informe e-mail e senha.' });

  const r = await query('SELECT id, email, senha_hash, ativo FROM dbo.EQUIPSTI_usuarios WHERE email = @email', { email: S(email) });
  const u = r.recordset[0];
  if (!u || !(await bcrypt.compare(senha, u.senha_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  if (!u.ativo) return res.status(403).json({ error: 'Usuário inativo. Contate o administrador.' });
  res.json({ token: gerarToken(u), email: u.email });
}));

app.get('/api/auth/me', exigirAuth, (req, res) => {
  res.json({ id: req.user.sub, email: req.user.email });
});

// ===================== USUÁRIOS =====================
app.get('/api/users', exigirAuth, wrap(async (req, res) => {
  const r = await query('SELECT id, email, criado_em, ativo FROM dbo.EQUIPSTI_usuarios ORDER BY email');
  res.json(r.recordset);
}));

app.post('/api/users', exigirAuth, wrap(async (req, res) => {
  const email = trim(req.body.email).toLowerCase();
  const senha = String(req.body.senha || '');
  if (!email) return res.status(400).json({ error: 'Informe o e-mail.' });
  if (senha.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });

  const existe = await query('SELECT id FROM dbo.EQUIPSTI_usuarios WHERE email = @email', { email: S(email) });
  if (existe.recordset.length) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const hash = await bcrypt.hash(senha, 10);
  await query('INSERT INTO dbo.EQUIPSTI_usuarios (email, senha_hash) VALUES (@email, @hash)',
    { email: S(email), hash: S(hash) });
  res.status(201).json({ ok: true });
}));

app.put('/api/users/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const novoEmail = req.body.email !== undefined ? trim(req.body.email).toLowerCase() : null;
  const novaSenha = req.body.senha !== undefined ? String(req.body.senha) : null;

  if (novoEmail) {
    const dup = await query('SELECT id FROM dbo.EQUIPSTI_usuarios WHERE email = @email AND id <> @id',
      { email: S(novoEmail), id });
    if (dup.recordset.length) return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    await query('UPDATE dbo.EQUIPSTI_usuarios SET email = @email WHERE id = @id', { email: S(novoEmail), id });
  }
  if (novaSenha) {
    if (novaSenha.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await query('UPDATE dbo.EQUIPSTI_usuarios SET senha_hash = @hash WHERE id = @id', { hash: S(hash), id });
  }
  if (req.body.ativo !== undefined) {
    const ativo = req.body.ativo ? 1 : 0;
    if (id === Number(req.user.sub) && !ativo) {
      return res.status(400).json({ error: 'Você não pode inativar o próprio usuário.' });
    }
    await query('UPDATE dbo.EQUIPSTI_usuarios SET ativo = @ativo WHERE id = @id', { ativo, id });
  }
  res.json({ ok: true });
}));

// ===================== OPÇÕES =====================
app.get('/api/options', exigirAuth, wrap(async (req, res) => {
  const r = await query('SELECT lista, valor, oculto, detalhe, preco, tipo_aquisicao, quantidade FROM dbo.EQUIPSTI_opcoes ORDER BY lista, valor');
  const counts = await query(`
    SELECT equipamento, COUNT(*) AS total
    FROM dbo.EQUIPSTI_registros
    GROUP BY equipamento
  `);
  const equipCount = {};
  counts.recordset.forEach((row) => { equipCount[row.equipamento] = row.total; });

  const out = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [], INSUMOS: [] };
  r.recordset.forEach((row) => {
    if (!out[row.lista]) return;
    const item = {
      valor: row.valor, oculto: !!row.oculto, detalhe: row.detalhe || null,
      preco: row.preco != null ? Number(row.preco) : null,
      tipo_aquisicao: row.tipo_aquisicao || null
    };
    if (row.lista === 'INSUMOS') item.quantidade = row.quantidade ?? 0;
    if (row.lista === 'EQUIPAMENTO') item.qtd_registros = equipCount[row.valor] ?? 0;
    out[row.lista].push(item);
  });
  res.json(out);
}));

app.put('/api/options/quantidade', exigirAuth, wrap(async (req, res) => {
  const valor = trim(req.body.valor);
  const qtd = parseInt(req.body.quantidade, 10);
  if (isNaN(qtd) || qtd < 0) return res.status(400).json({ error: 'Quantidade inválida.' });
  await query('UPDATE dbo.EQUIPSTI_opcoes SET quantidade = @qtd WHERE lista = @lista AND valor = @valor',
    { qtd: { type: sql.Int, value: qtd }, lista: S('INSUMOS'), valor: S(valor) });
  res.json({ ok: true });
}));

app.post('/api/options', exigirAuth, wrap(async (req, res) => {
  const lista = trim(req.body.lista).toUpperCase();
  const valor = trim(req.body.valor).toUpperCase();
  const detalhe = trim(req.body.detalhe || '') || null;
  const precoRaw = lista === 'EQUIPAMENTO' && req.body.preco !== undefined && req.body.preco !== ''
    ? Number(String(req.body.preco).replace(',', '.')) : null;
  const preco = precoRaw != null && !isNaN(precoRaw) ? precoRaw : null;
  const tipoAquisicao = lista === 'EQUIPAMENTO' ? (trim(req.body.tipo_aquisicao || '') || null) : null;
  if (!OPTION_LISTS.includes(lista)) return res.status(400).json({ error: 'Lista inválida.' });
  if (!valor) return res.status(400).json({ error: 'O valor não pode ser vazio.' });

  const existe = await query('SELECT id FROM dbo.EQUIPSTI_opcoes WHERE lista = @lista AND valor = @valor',
    { lista: S(lista), valor: S(valor) });
  if (existe.recordset.length) return res.status(409).json({ error: `"${valor}" já existe em ${lista}.` });

  await query('INSERT INTO dbo.EQUIPSTI_opcoes (lista, valor, oculto, detalhe, preco, tipo_aquisicao) VALUES (@lista, @valor, 0, @detalhe, @preco, @tipoAquisicao)',
    { lista: S(lista), valor: S(valor), detalhe: { type: sql.NVarChar, value: detalhe },
      preco: preco != null ? { type: sql.Decimal(15,2), value: preco } : S(null),
      tipoAquisicao: S(tipoAquisicao) });
  res.status(201).json({ ok: true });
}));

// Renomeia uma opção (atualiza também os registros que a usavam).
app.put('/api/options/rename', exigirAuth, wrap(async (req, res) => {
  const lista = trim(req.body.lista).toUpperCase();
  const valor = trim(req.body.valor);
  const novoValor = trim(req.body.novoValor).toUpperCase();
  if (!OPTION_LISTS.includes(lista)) return res.status(400).json({ error: 'Lista inválida.' });
  if (!novoValor) return res.status(400).json({ error: 'O valor não pode ser vazio.' });

  const dup = await query('SELECT id FROM dbo.EQUIPSTI_opcoes WHERE lista = @lista AND valor = @novo AND valor <> @valor',
    { lista: S(lista), novo: S(novoValor), valor: S(valor) });
  if (dup.recordset.length) return res.status(409).json({ error: `"${novoValor}" já existe em ${lista}.` });

  await query('UPDATE dbo.EQUIPSTI_opcoes SET valor = @novo WHERE lista = @lista AND valor = @valor',
    { novo: S(novoValor), lista: S(lista), valor: S(valor) });
  res.json({ ok: true });
}));

// Atualiza o detalhe e o preço de uma opção de equipamento.
app.put('/api/options/detalhe', exigirAuth, wrap(async (req, res) => {
  const lista = trim(req.body.lista).toUpperCase();
  const valor = trim(req.body.valor);
  const detalhe = trim(req.body.detalhe || '') || null;
  const precoRaw = req.body.preco !== undefined && req.body.preco !== ''
    ? Number(String(req.body.preco).replace(',', '.')) : null;
  const preco = precoRaw != null && !isNaN(precoRaw) ? precoRaw : null;
  const tipoAquisicao = trim(req.body.tipo_aquisicao || '') || null;
  if (!OPTION_LISTS.includes(lista)) return res.status(400).json({ error: 'Lista inválida.' });
  await query('UPDATE dbo.EQUIPSTI_opcoes SET detalhe = @detalhe, preco = @preco, tipo_aquisicao = @tipoAquisicao WHERE lista = @lista AND valor = @valor',
    { detalhe: { type: sql.NVarChar, value: detalhe },
      preco: preco != null ? { type: sql.Decimal(15,2), value: preco } : S(null),
      tipoAquisicao: S(tipoAquisicao),
      lista: S(lista), valor: S(valor) });
  res.json({ ok: true });
}));

// Oculta / exibe uma opção.
app.put('/api/options/hidden', exigirAuth, wrap(async (req, res) => {
  const lista = trim(req.body.lista).toUpperCase();
  const valor = trim(req.body.valor);
  const oculto = req.body.oculto ? 1 : 0;
  await query('UPDATE dbo.EQUIPSTI_opcoes SET oculto = @oculto WHERE lista = @lista AND valor = @valor',
    { oculto, lista: S(lista), valor: S(valor) });
  res.json({ ok: true });
}));

// ===================== REGISTROS =====================
function lerRegistro(body) {
  const valor = body.valor !== undefined && body.valor !== '' ? Number(String(body.valor).replace(',', '.')) : null;
  return {
    unidade: trim(body.unidade), status: trim(body.status), setor: trim(body.setor),
    usuario: trim(body.usuario), ns: trim(body.ns),
    pat: trim(body.pat), equipamento: trim(body.equipamento),
    equipamento_detalhe: trim(body.equipamento_detalhe) || null,
    obs: trim(body.obs),
    protocolo: trim(body.protocolo),
    dataRecebimento: trim(body.dataRecebimento) || null,
    valor: isNaN(valor) ? null : valor,
    insumo: trim(body.insumo) || null,
    tipo_aquisicao: trim(body.tipo_aquisicao) || null,
    imagem_base64: body.imagem_base64 || null,
    imagem2_base64: body.imagem2_base64 || null,
    imagem3_base64: body.imagem3_base64 || null
  };
}
function validarRegistro(d) {
  const faltando = [];
  if (!d.unidade) faltando.push('UNIDADE');
  if (!d.status) faltando.push('STATUS');
  if (!d.setor) faltando.push('SETOR');
  if (!d.ns) faltando.push('N/S');
  if (!d.equipamento) faltando.push('EQUIPAMENTO');
  if (!d.pat) faltando.push('PAT MSA');
  if (!d.tipo_aquisicao) faltando.push('COMPRADO/LOCADO');
  if (!d.protocolo) faltando.push('PROTOCOLO');
  if (!d.dataRecebimento) faltando.push('DATA DE RECEBIMENTO');
  if (faltando.length) throw new Error('Preencha: ' + faltando.join(', ') + '.');
}

app.get('/api/records', exigirAuth, wrap(async (req, res) => {
  const selectFields = `SELECT id, unidade, status, setor, usuario, ns,
    pat, equipamento, equipamento_detalhe AS equipamentoDetalhe, insumo, tipo_aquisicao AS tipoAquisicao, protocolo,
    CONVERT(varchar(10), data_recebimento, 23) AS dataRecebimento, valor, obs,
    criado_por AS criadoPor, atualizado_por AS atualizadoPor,
    CONVERT(varchar(19), criado_em, 120) AS criadoEm,
    CONVERT(varchar(19), atualizado_em, 120) AS atualizadoEm,
    CASE WHEN imagem_base64 IS NOT NULL THEN 1 ELSE 0 END AS temFoto
    FROM dbo.EQUIPSTI_registros ORDER BY id DESC`;
  if (req.query.all === '1') {
    const r = await query(selectFields, {});
    return res.json(r.recordset);
  }
  const limit  = Math.min(Math.max(parseInt(req.query.limit)  || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const r = await query(`${selectFields} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    { offset: { type: sql.Int, value: offset }, limit: { type: sql.Int, value: limit } });
  res.json(r.recordset);
}));

app.get('/api/records/:id/imagem', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT imagem_base64, imagem2_base64, imagem3_base64 FROM dbo.EQUIPSTI_registros WHERE id = @id`,
    { id: Number(req.params.id) });
  if (!r.recordset.length) return res.status(404).json({ error: 'Não encontrado.' });
  const row = r.recordset[0];
  res.json({ imagem_base64: row.imagem_base64 || null, imagem2_base64: row.imagem2_base64 || null, imagem3_base64: row.imagem3_base64 || null });
}));

app.get('/api/records/:id/log', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT acao, campo, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
    justificativa, usuario, CONVERT(varchar(19), data_hora, 120) AS dataHora
    FROM dbo.EQUIPSTI_registros_log WHERE registro_id = @id ORDER BY id DESC`,
    { id });
  res.json(r.recordset);
}));

app.post('/api/records', exigirAuth, wrap(async (req, res) => {
  const d = lerRegistro(req.body);
  validarRegistro(d);
  const usuario = req.user.email;
  const ins = await query(`INSERT INTO dbo.EQUIPSTI_registros
    (unidade, status, setor, usuario, ns, pat, equipamento, equipamento_detalhe, obs, protocolo, data_recebimento, valor, insumo, tipo_aquisicao, imagem_base64, imagem2_base64, imagem3_base64, criado_por)
    OUTPUT INSERTED.id
    VALUES (@unidade, @status, @setor, @usuario, @ns, @pat, @equipamento, @equipamentoDetalhe, @obs, @protocolo, @dataRecebimento, @valor, @insumo, @tipoAquisicao, @imagemBase64, @imagem2Base64, @imagem3Base64, @criadoPor)`,
    { unidade: S(d.unidade), status: S(d.status), setor: S(d.setor), usuario: S(d.usuario),
      ns: S(d.ns), pat: S(d.pat), equipamento: S(d.equipamento), equipamentoDetalhe: S(d.equipamento_detalhe),
      obs: S(d.obs), protocolo: S(d.protocolo), dataRecebimento: S(d.dataRecebimento),
      valor: d.valor != null ? { type: sql.Decimal(15,2), value: d.valor } : S(null),
      insumo: S(d.insumo), tipoAquisicao: S(d.tipo_aquisicao),
      imagemBase64: S(d.imagem_base64), imagem2Base64: S(d.imagem2_base64), imagem3Base64: S(d.imagem3_base64),
      criadoPor: S(usuario) });
  const novoId = ins.recordset[0].id;
  await query(`INSERT INTO dbo.EQUIPSTI_registros_log (registro_id, acao, usuario) VALUES (@id, 'CRIADO', @usuario)`,
    { id: novoId, usuario: S(usuario) });
  res.status(201).json({ ok: true });
}));

const CAMPOS_LOG = [
  ['unidade','UNIDADE'], ['status','STATUS'], ['setor','SETOR'], ['usuario','USUARIO'],
  ['ns','N/S'], ['pat','PAT MSA'], ['equipamento','EQUIPAMENTO'],
  ['equipamento_detalhe','EQUIPAMENTO DETALHE'], ['insumo','INSUMO'], ['tipo_aquisicao','TIPO AQUISIÇÃO'], ['protocolo','PROTOCOLO'],
  ['dataRecebimento','DATA RECEBIMENTO'], ['valor','VALOR'], ['obs','OBS']
];

app.put('/api/records/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerRegistro(req.body);
  validarRegistro(d);
  const justificativa = trim(req.body.justificativa || '');
  if (!justificativa) return res.status(400).json({ error: 'Informe a justificativa da edição.' });
  const usuario = req.user.email;

  const dup = await query(
    `SELECT id FROM dbo.EQUIPSTI_registros WHERE ns = @ns AND pat = @pat AND id <> @id`,
    { ns: S(d.ns), pat: S(d.pat), id });
  if (dup.recordset.length) return res.status(409).json({ error: `Já existe outro registro com N/S "${d.ns}" e PAT "${d.pat}".` });

  const anterior = await query(`SELECT unidade, status, setor, usuario, ns, pat, equipamento,
    equipamento_detalhe AS equipamento_detalhe, insumo, tipo_aquisicao,
    obs, protocolo, CONVERT(varchar(10), data_recebimento, 23) AS dataRecebimento,
    CAST(valor AS NVARCHAR) AS valor, imagem_base64, imagem2_base64, imagem3_base64
    FROM dbo.EQUIPSTI_registros WHERE id=@id`, { id });
  const old = anterior.recordset[0] || {};

  await query(`UPDATE dbo.EQUIPSTI_registros SET
    unidade=@unidade, status=@status, setor=@setor, usuario=@usuario, ns=@ns,
    pat=@pat, equipamento=@equipamento, equipamento_detalhe=@equipamentoDetalhe, obs=@obs,
    protocolo=@protocolo, data_recebimento=@dataRecebimento, valor=@valor, insumo=@insumo, tipo_aquisicao=@tipoAquisicao,
    imagem_base64=@imagemBase64, imagem2_base64=@imagem2Base64, imagem3_base64=@imagem3Base64,
    atualizado_por=@atualizadoPor, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`,
    { id, unidade: S(d.unidade), status: S(d.status), setor: S(d.setor), usuario: S(d.usuario),
      ns: S(d.ns), pat: S(d.pat), equipamento: S(d.equipamento), equipamentoDetalhe: S(d.equipamento_detalhe),
      obs: S(d.obs), protocolo: S(d.protocolo), dataRecebimento: S(d.dataRecebimento),
      valor: d.valor != null ? { type: sql.Decimal(15,2), value: d.valor } : S(null),
      insumo: S(d.insumo), tipoAquisicao: S(d.tipo_aquisicao),
      imagemBase64: S(d.imagem_base64), imagem2Base64: S(d.imagem2_base64), imagem3Base64: S(d.imagem3_base64),
      atualizadoPor: S(usuario) });

  for (const [key, label] of CAMPOS_LOG) {
    const vAntes = String(old[key] ?? '');
    const vDepois = String(key === 'valor' ? (d.valor ?? '') : (d[key] ?? ''));
    const igual = key === 'valor'
      ? parseFloat(vAntes || 'NaN') === parseFloat(vDepois || 'NaN')
      : vAntes === vDepois;
    if (!igual) {
      await query(`INSERT INTO dbo.EQUIPSTI_registros_log
        (registro_id, acao, campo, valor_anterior, valor_novo, justificativa, usuario)
        VALUES (@id, 'ATUALIZADO', @campo, @antes, @depois, @justificativa, @usuario)`,
        { id, campo: S(label), antes: S(vAntes), depois: S(vDepois), justificativa: S(justificativa), usuario: S(usuario) });
    }
  }

  const fotoCols = [['imagem_base64','FOTO 1'],['imagem2_base64','FOTO 2'],['imagem3_base64','FOTO 3']];
  for (const [col, label] of fotoCols) {
    const antes = old[col] ? 'SIM' : 'NÃO';
    const depois = d[col] ? 'SIM' : 'NÃO';
    if ((old[col] || '') !== (d[col] || '')) {
      const nomeLog = antes === depois ? label + ' (substituída)' : label;
      await query(`INSERT INTO dbo.EQUIPSTI_registros_log
        (registro_id, acao, campo, valor_anterior, valor_novo, justificativa, usuario)
        VALUES (@id, 'ATUALIZADO', @campo, @antes, @depois, @justificativa, @usuario)`,
        { id, campo: S(nomeLog), antes: S(antes), depois: S(depois), justificativa: S(justificativa), usuario: S(usuario) });
    }
  }

  res.json({ ok: true });
}));

app.delete('/api/records/:id', exigirAuth, wrap(async (req, res) => {
  await query('DELETE FROM dbo.EQUIPSTI_registros WHERE id = @id', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

// ===================== PATs (origem dos empréstimos) =====================
app.get('/api/pats', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT DISTINCT pat FROM dbo.EQUIPSTI_registros
    WHERE pat IS NOT NULL AND LTRIM(RTRIM(pat)) <> '' ORDER BY pat`);
  res.json(r.recordset.map((row) => row.pat));
}));

// NS distintos para um PAT (para popular o select de NS no form de empréstimo).
app.get('/api/pats/:pat/ns', exigirAuth, wrap(async (req, res) => {
  const pat = trim(req.params.pat);
  const r = await query(
    `SELECT DISTINCT ns FROM dbo.EQUIPSTI_registros
      WHERE pat = @pat AND ns IS NOT NULL AND LTRIM(RTRIM(ns)) <> ''
      ORDER BY ns`,
    { pat: S(pat) });
  res.json(r.recordset.map((row) => row.ns));
}));

// Histórico completo de um PAT (+NS opcional): unidade(s) de origem + linha do tempo de empréstimos.
app.get('/api/pats/:pat/history', exigirAuth, wrap(async (req, res) => {
  const pat = trim(req.params.pat);
  const ns  = trim(req.query.ns);
  const origens = await query(
    `SELECT unidade, equipamento, ns,
        CONVERT(varchar(10), MIN(criado_em), 23) AS criadoEm
      FROM dbo.EQUIPSTI_registros
      WHERE pat = @pat${ns ? ' AND ns = @ns' : ''}
      GROUP BY unidade, equipamento, ns ORDER BY criadoEm`,
    ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });
  const emprestimos = await query(
    `SELECT unidade, ns,
        CONVERT(varchar(10), data_emprestimo, 23) AS data, status,
        CONVERT(varchar(10), data_devolucao, 23) AS dataDevolucao, obs
      FROM dbo.EQUIPSTI_emprestimos
      WHERE pat = @pat${ns ? ' AND (ns = @ns OR ns IS NULL)' : ''}
      ORDER BY data_emprestimo, id`,
    ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });
  res.json({ pat, ns: ns || null, origens: origens.recordset, emprestimos: emprestimos.recordset });
}));

// ===================== EMPRÉSTIMOS =====================
app.get('/api/loans', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT id, pat, ns, unidade,
    CONVERT(varchar(10), data_emprestimo, 23) AS data,
    status,
    CONVERT(varchar(10), data_devolucao, 23) AS dataDevolucao,
    obs
    FROM dbo.EQUIPSTI_emprestimos
    ORDER BY CASE status WHEN 'EMPRESTADO' THEN 0 ELSE 1 END, id DESC`);
  res.json(r.recordset);
}));

app.post('/api/loans', exigirAuth, wrap(async (req, res) => {
  const pat = trim(req.body.pat);
  const ns  = trim(req.body.ns);
  const unidade = trim(req.body.unidade);
  const data = trim(req.body.data);
  const obs = trim(req.body.obs);
  const faltando = [];
  if (!pat) faltando.push('PAT');
  if (!unidade) faltando.push('UNIDADE');
  if (faltando.length) return res.status(400).json({ error: 'Preencha: ' + faltando.join(', ') + '.' });

  // Busca unidade original do cadastro.
  const origemRes = await query(
    `SELECT TOP 1 unidade FROM dbo.EQUIPSTI_registros
     WHERE pat = @pat ${ns ? 'AND ns = @ns' : ''}
     ORDER BY criado_em`,
    ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });
  const unidadeOriginal = origemRes.recordset.length ? origemRes.recordset[0].unidade : null;

  // Se destino é a unidade original, trata como devolução (não cria novo empréstimo).
  if (unidadeOriginal && unidade.toUpperCase() === unidadeOriginal.toUpperCase()) {
    await query(
      `UPDATE dbo.EQUIPSTI_emprestimos
         SET status = 'DEVOLVIDO', data_devolucao = CAST(GETDATE() AS date)
       WHERE pat = @pat AND status = 'EMPRESTADO'
         ${ns ? 'AND (ns = @ns OR ns IS NULL)' : ''}`,
      ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });
    return res.status(201).json({ ok: true, devolvido: true });
  }

  // Fecha empréstimo aberto anterior como TRANSFERIDO (suporta cadeia 1→2→3→1).
  await query(
    `UPDATE dbo.EQUIPSTI_emprestimos
       SET status = 'TRANSFERIDO', data_devolucao = CAST(GETDATE() AS date)
     WHERE pat = @pat AND status = 'EMPRESTADO'
       ${ns ? 'AND (ns = @ns OR ns IS NULL)' : ''}`,
    ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });

  await query(
    `INSERT INTO dbo.EQUIPSTI_emprestimos (pat, ns, unidade, data_emprestimo, status, obs)
      VALUES (@pat, @ns, @unidade, @data, 'EMPRESTADO', @obs)`,
    { pat: S(pat), ns: S(ns || null), unidade: S(unidade), data: S(data || null), obs: S(obs) });
  res.status(201).json({ ok: true });
}));

app.put('/api/loans/:id/status', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const status = trim(req.body.status).toUpperCase();
  if (status !== 'EMPRESTADO' && status !== 'DEVOLVIDO') {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  if (status === 'EMPRESTADO') {
    const atual = await query(`SELECT pat, ns FROM dbo.EQUIPSTI_emprestimos WHERE id=@id`, { id });
    if (!atual.recordset.length) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
    const { pat: aPat, ns: aNs } = atual.recordset[0];
    const aberto = await query(
      `SELECT TOP 1 unidade FROM dbo.EQUIPSTI_emprestimos
        WHERE pat = @pat AND status = 'EMPRESTADO' AND id <> @id
          ${aNs ? 'AND (ns = @ns OR ns IS NULL)' : ''}`,
      aNs ? { pat: S(aPat), ns: S(aNs), id } : { pat: S(aPat), id });
    if (aberto.recordset.length) {
      return res.status(400).json({
        error: 'Este PAT' + (aNs ? '/N/S' : '') + ' já está emprestado para ' + aberto.recordset[0].unidade + '.'
      });
    }
  }

  const devol = status === 'DEVOLVIDO' ? 'CAST(SYSUTCDATETIME() AS DATE)' : 'NULL';
  await query(`UPDATE dbo.EQUIPSTI_emprestimos
    SET status=@status, data_devolucao=${devol}, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`, { id, status: S(status) });
  res.json({ ok: true });
}));

// ===================== CHAMADOS (proxy eurosa.desk.ms) =====================
let eurosaCookie = null;

const EUROSA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

async function eurosaLogin() {
  // 1) GET /?LoginPortal — mesma URL que o browser usa; obtém cookies PHP de sessão
  const getRes = await fetch('https://eurosa.desk.ms/?LoginPortal', {
    redirect: 'follow',
    headers: { 'User-Agent': EUROSA_UA }
  });
  const initCookies = (getRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]);

  // 2) POST das credenciais
  const loginBody = new URLSearchParams({
    Dados: JSON.stringify({
      Prefixo: process.env.EUROSA_PREFIXO,
      Dispositivo: '',
      Login: process.env.EUROSA_LOGIN,
      Senha: process.env.EUROSA_SENHA,
      website: ''
    })
  });
  const postRes = await fetch('https://eurosa.desk.ms/portal/logar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://eurosa.desk.ms/?LoginPortal',
      'Origin': 'https://eurosa.desk.ms',
      'User-Agent': EUROSA_UA,
      ...(initCookies.length ? { Cookie: initCookies.join('; ') } : {})
    },
    body: loginBody.toString(),
    redirect: 'follow'
  });

  const postBody = await postRes.text().catch(() => '');

  const postCookies = (postRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]);
  const cookieMap = new Map();
  [...initCookies, ...postCookies].forEach(c => {
    const [k] = c.split('=');
    if (k) cookieMap.set(k, c);
  });

  // Tenta extrair Sessao do corpo (JSON ou JS embarcado)
  let sessao = null;
  try {
    const parsed = JSON.parse(postBody);
    sessao = parsed?.root?.Sessao ?? parsed?.Sessao ?? null;
  } catch {
    const m = postBody.match(/"Sessao"\s*:\s*"([^"]+)"/);
    if (m) sessao = m[1];
  }

  // 3) GET /?Portal — obtém pcdeskmanager e inicializa a sessão do portal
  const portalRes = await fetch('https://eurosa.desk.ms/?Portal', {
    redirect: 'follow',
    headers: {
      'User-Agent': EUROSA_UA,
      Cookie: [...cookieMap.values()].join('; ')
    }
  });
  const portalCookies = (portalRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]);
  portalCookies.forEach(c => {
    const [k] = c.split('=');
    if (k) cookieMap.set(k, c);
  });

  if (!cookieMap.size) throw new Error('Login eurosa falhou — nenhum cookie obtido');

  eurosaCookie = [...cookieMap.values()].join('; ');
  if (sessao) eurosaCookie += `; Sessao=${sessao}`;
  console.log('[eurosa login] ok | sessao:', sessao ? 'ok' : 'ausente', '| cookies:', [...cookieMap.keys()].join(', '));
}

async function eurosaRequest(method, path, dados, extra = {}) {
  const body = new URLSearchParams({ Dados: JSON.stringify(dados), App: 'Portal', ...extra });
  const res = await fetch('https://eurosa.desk.ms' + path, {
    method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://eurosa.desk.ms/?Portal',
      'Origin': 'https://eurosa.desk.ms',
      'User-Agent': EUROSA_UA,
      'Cookie': eurosaCookie
    },
    body: body.toString()
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const eurosaPost = (path, dados) => eurosaRequest('POST', path, dados);

function eurosaSessionExpired(result) {
  return result.status === 401 || result.status === 302 ||
    (typeof result.data === 'string' && result.data.includes('LoginPortal')) ||
    (typeof result.data === 'object' && result.data?.erro);
}

async function eurosaFetchChamados() {
  // Body espelhado exatamente do que o browser envia (HAR capturado em 2026-06-16)
  const body = new URLSearchParams({
    Dados: JSON.stringify({
      Pesquisa: '', Ativo: '', Ordem: [],
      DataCriacao: '', DataInicioCriacao: '', DataFimCriacao: '',
      DataFinalizacao: '', DataInicioFinalizacao: '', DataFimFinalizacao: '',
      DataExpira: '', DataInicioExpira: '', HoraInicioExpira: '',
      DataFimExpira: '', HoraFimExpira: ''
    }),
    App: 'Portal',
    Mobile: 'false'
  });

  const res = await fetch('https://eurosa.desk.ms/Chamados/lista', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://eurosa.desk.ms/?Portal',
      'Origin': 'https://eurosa.desk.ms',
      'User-Agent': EUROSA_UA,
      'Cookie': eurosaCookie
    },
    body: body.toString()
  });
  const text = await res.text();
  console.log('[chamados raw]', text.slice(0, 300));
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function eurosaCall(fn) {
  if (!eurosaCookie) await eurosaLogin();
  let result = await fn();
  if (eurosaSessionExpired(result)) {
    eurosaCookie = null;
    await eurosaLogin();
    result = await fn();
  }
  return result;
}

app.get('/api/chamados', exigirAuth, wrap(async (req, res) => {
  const result = await eurosaCall(() => eurosaFetchChamados());
  console.log('[chamados] status:', result.status, '| data:', JSON.stringify(result.data).slice(0, 200));
  res.json(result.data);
}));

async function eurosaGetChamadoDetalhe(chave) {
  const body = new URLSearchParams({ Chave: String(chave), OrigemID: '', App: 'Portal' });
  const res = await fetch('https://eurosa.desk.ms/Chamados', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://eurosa.desk.ms/?Portal',
      'Origin': 'https://eurosa.desk.ms',
      'User-Agent': EUROSA_UA,
      'Cookie': eurosaCookie
    },
    body: body.toString()
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

app.get('/api/chamados/:chave', exigirAuth, wrap(async (req, res) => {
  const chave = trim(req.params.chave);
  const result = await eurosaCall(() => eurosaGetChamadoDetalhe(chave));
  if (result.status >= 400) throw new Error('Eurosa retornou ' + result.status);
  res.json(result.data);
}));

app.post('/api/chamados/:chave/interacao', exigirAuth, wrap(async (req, res) => {
  const chave   = trim(req.params.chave);
  const codigo  = trim(req.body.codigo   || '');
  const descricao = trim(req.body.descricao || '');
  if (!descricao) return res.status(400).json({ error: 'Informe a descrição.' });

  const dados = {
    Continuar: '',
    TChamado: {
      Chave:    chave,
      Codigo:   codigo,
      Descricao: '<p>' + descricao + '</p>'
    }
  };
  const result = await eurosaCall(() => eurosaRequest('PUT', '/Chamados', dados));
  console.log('[interacao] status:', result.status, JSON.stringify(result.data).slice(0, 200));
  if (result.status >= 400) throw new Error('Eurosa retornou ' + result.status + ': ' + JSON.stringify(result.data));
  res.status(201).json(result.data);
}));

app.get('/api/chamados/assuntos', exigirAuth, wrap(async (req, res) => {
  const dados = {
    Pesquisa: '', Ativo: '1', Ordem: [], Tudo: 'true', Ajax: 'true',
    Filtro: { ListaCatalogoUsuario: ['', 'equal'] }
  };
  const result = await eurosaCall(() => eurosaPost('/Chamados/listaAutoCategoria', dados));
  if (result.status >= 400) throw new Error('Erro eurosa: ' + result.status);
  const lista = result.data?.root ?? [];
  res.json(lista.map(i => ({ id: String(i.id).replace(/\\+$/, ''), text: i.text })));
}));

const EUROSA_CODUSUARIO = '12290';

app.post('/api/chamados', exigirAuth, wrap(async (req, res) => {
  const codCatalogo   = trim(req.body.codCatalogo   || '');
  const assuntoText   = trim(req.body.assuntoText   || '');
  const descricao     = trim(req.body.descricao     || '');
  const localTrabalho = trim(req.body.localTrabalho || '');
  const endereco      = trim(req.body.endereco      || '');
  const unidade       = trim(req.body.unidade       || '');

  if (!codCatalogo) return res.status(400).json({ error: 'Selecione o assunto.' });
  if (!descricao)   return res.status(400).json({ error: 'Informe a descrição.' });

  // AutoCategoriaArvore = parte após o último " - " no texto do assunto
  const arvore = assuntoText.includes(' - ')
    ? assuntoText.slice(assuntoText.lastIndexOf(' - ') + 3)
    : assuntoText;

  const dados = {
    Continuar: '',
    TChamado: {
      Chave:                '',
      CodUsuario:           EUROSA_CODUSUARIO,
      Assunto:              assuntoText,
      AutoCategoria:        codCatalogo + '\\',
      AutoCategoriaArvore:  arvore,
      CodSolIC:             EUROSA_CODUSUARIO,
      Descricao:            '<p>' + descricao + '</p>'
    },
    TCampoExtra: {
      '12310': localTrabalho,
      '12311': endereco,
      '19024': unidade,
      '20742': '0'
    }
  };

  const result = await eurosaCall(() => eurosaRequest('PUT', '/Chamados', dados, { Menu: 'Chamados' }));
  console.log('[chamado criado] status:', result.status, JSON.stringify(result.data).slice(0, 200));
  if (result.status >= 400) throw new Error('Eurosa retornou ' + result.status + ': ' + JSON.stringify(result.data));
  res.status(201).json(result.data);
}));

// ===================== ESTÁTICO (front-end vanilla) =====================
// Usado no desenvolvimento local; na Vercel os estáticos são servidos pela CDN.
app.use(express.static(PUBLIC_DIR));

export default app;

// Sobe o servidor apenas localmente (na Vercel o app é importado como função).
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`API + app em http://localhost:${PORT}`);
  });
}
