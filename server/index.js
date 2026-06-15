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

const OPTION_LISTS = ['UNIDADE', 'STATUS', 'SETOR', 'EQUIPAMENTO'];
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
  const r = await query('SELECT lista, valor, oculto FROM dbo.EQUIPSTI_opcoes ORDER BY lista, valor');
  const out = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [] };
  r.recordset.forEach((row) => {
    if (out[row.lista]) out[row.lista].push({ valor: row.valor, oculto: !!row.oculto });
  });
  res.json(out);
}));

app.post('/api/options', exigirAuth, wrap(async (req, res) => {
  const lista = trim(req.body.lista).toUpperCase();
  const valor = trim(req.body.valor).toUpperCase();
  if (!OPTION_LISTS.includes(lista)) return res.status(400).json({ error: 'Lista inválida.' });
  if (!valor) return res.status(400).json({ error: 'O valor não pode ser vazio.' });

  const existe = await query('SELECT id FROM dbo.EQUIPSTI_opcoes WHERE lista = @lista AND valor = @valor',
    { lista: S(lista), valor: S(valor) });
  if (existe.recordset.length) return res.status(409).json({ error: `"${valor}" já existe em ${lista}.` });

  await query('INSERT INTO dbo.EQUIPSTI_opcoes (lista, valor, oculto) VALUES (@lista, @valor, 0)',
    { lista: S(lista), valor: S(valor) });
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
  return {
    unidade: trim(body.unidade), status: trim(body.status), setor: trim(body.setor),
    usuario: trim(body.usuario), ns: trim(body.ns),
    patNovo: trim(body.patNovo), equipamento: trim(body.equipamento), obs: trim(body.obs)
  };
}
function validarRegistro(d) {
  const faltando = [];
  if (!d.unidade) faltando.push('UNIDADE');
  if (!d.status) faltando.push('STATUS');
  if (!d.ns) faltando.push('N/S');
  if (!d.equipamento) faltando.push('EQUIPAMENTO');
  if (faltando.length) throw new Error('Preencha: ' + faltando.join(', ') + '.');
}

app.get('/api/records', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT id, unidade, status, setor, usuario, ns,
    pat_novo AS patNovo, equipamento, obs
    FROM dbo.EQUIPSTI_registros ORDER BY id DESC`);
  res.json(r.recordset);
}));

app.post('/api/records', exigirAuth, wrap(async (req, res) => {
  const d = lerRegistro(req.body);
  validarRegistro(d);
  await query(`INSERT INTO dbo.EQUIPSTI_registros
    (unidade, status, setor, usuario, ns, pat_novo, equipamento, obs)
    VALUES (@unidade, @status, @setor, @usuario, @ns, @patNovo, @equipamento, @obs)`,
    { unidade: S(d.unidade), status: S(d.status), setor: S(d.setor), usuario: S(d.usuario),
      ns: S(d.ns), patNovo: S(d.patNovo), equipamento: S(d.equipamento), obs: S(d.obs) });
  res.status(201).json({ ok: true });
}));

app.put('/api/records/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerRegistro(req.body);
  validarRegistro(d);
  await query(`UPDATE dbo.EQUIPSTI_registros SET
    unidade=@unidade, status=@status, setor=@setor, usuario=@usuario, ns=@ns,
    pat_novo=@patNovo, equipamento=@equipamento, obs=@obs,
    atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`,
    { id, unidade: S(d.unidade), status: S(d.status), setor: S(d.setor), usuario: S(d.usuario),
      ns: S(d.ns), patNovo: S(d.patNovo), equipamento: S(d.equipamento), obs: S(d.obs) });
  res.json({ ok: true });
}));

app.delete('/api/records/:id', exigirAuth, wrap(async (req, res) => {
  await query('DELETE FROM dbo.EQUIPSTI_registros WHERE id = @id', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

// ===================== PATs (origem dos empréstimos) =====================
app.get('/api/pats', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT DISTINCT pat_novo FROM dbo.EQUIPSTI_registros
    WHERE pat_novo IS NOT NULL AND LTRIM(RTRIM(pat_novo)) <> '' ORDER BY pat_novo`);
  res.json(r.recordset.map((row) => row.pat_novo));
}));

// Histórico completo de um PAT: unidade(s) de origem + linha do tempo de empréstimos.
app.get('/api/pats/:pat/history', exigirAuth, wrap(async (req, res) => {
  const pat = trim(req.params.pat);
  const origens = await query(`SELECT unidade, equipamento, ns,
      CONVERT(varchar(10), MIN(criado_em), 23) AS criadoEm
    FROM dbo.EQUIPSTI_registros WHERE pat_novo = @pat
    GROUP BY unidade, equipamento, ns ORDER BY criadoEm`,
    { pat: S(pat) });
  const emprestimos = await query(`SELECT unidade,
      CONVERT(varchar(10), data_emprestimo, 23) AS data, status,
      CONVERT(varchar(10), data_devolucao, 23) AS dataDevolucao, obs
    FROM dbo.EQUIPSTI_emprestimos WHERE pat = @pat
    ORDER BY data_emprestimo, id`,
    { pat: S(pat) });
  res.json({ pat, origens: origens.recordset, emprestimos: emprestimos.recordset });
}));

// ===================== EMPRÉSTIMOS =====================
app.get('/api/loans', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT id, pat, unidade,
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
  const unidade = trim(req.body.unidade);
  const data = trim(req.body.data);
  const obs = trim(req.body.obs);
  const faltando = [];
  if (!pat) faltando.push('PAT');
  if (!unidade) faltando.push('UNIDADE');
  if (faltando.length) return res.status(400).json({ error: 'Preencha: ' + faltando.join(', ') + '.' });

  const aberto = await query(`SELECT TOP 1 unidade FROM dbo.EQUIPSTI_emprestimos
    WHERE pat = @pat AND status = 'EMPRESTADO'`, { pat: S(pat) });
  if (aberto.recordset.length) {
    return res.status(400).json({
      error: 'Este PAT já está emprestado para ' + aberto.recordset[0].unidade +
        '. Devolva-o antes de emprestar para outra unidade.'
    });
  }

  await query(`INSERT INTO dbo.EQUIPSTI_emprestimos (pat, unidade, data_emprestimo, status, obs)
    VALUES (@pat, @unidade, @data, 'EMPRESTADO', @obs)`,
    { pat: S(pat), unidade: S(unidade), data: S(data || null), obs: S(obs) });
  res.status(201).json({ ok: true });
}));

app.put('/api/loans/:id/status', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const status = trim(req.body.status).toUpperCase();
  if (status !== 'EMPRESTADO' && status !== 'DEVOLVIDO') {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  if (status === 'EMPRESTADO') {
    const atual = await query(`SELECT pat FROM dbo.EQUIPSTI_emprestimos WHERE id=@id`, { id });
    if (!atual.recordset.length) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
    const aberto = await query(`SELECT TOP 1 unidade FROM dbo.EQUIPSTI_emprestimos
      WHERE pat = @pat AND status = 'EMPRESTADO' AND id <> @id`,
      { pat: S(atual.recordset[0].pat), id });
    if (aberto.recordset.length) {
      return res.status(400).json({
        error: 'Este PAT já está emprestado para ' + aberto.recordset[0].unidade + '.'
      });
    }
  }

  const devol = status === 'DEVOLVIDO' ? 'CAST(SYSUTCDATETIME() AS DATE)' : 'NULL';
  await query(`UPDATE dbo.EQUIPSTI_emprestimos
    SET status=@status, data_devolucao=${devol}, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`, { id, status: S(status) });
  res.json({ ok: true });
}));

// ===================== ESTÁTICO (front-end vanilla) =====================
// Usado no desenvolvimento local; na Vercel os estáticos são servidos pela CDN.
app.use(express.static(PUBLIC_DIR));

export default app;

// Sobe o servidor apenas localmente (na Vercel o app é importado como função).
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`API + app em http://localhost:${PORT}`);
  });
}
