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
  const valor = body.valor !== undefined && body.valor !== '' ? Number(String(body.valor).replace(',', '.')) : null;
  return {
    unidade: trim(body.unidade), status: trim(body.status), setor: trim(body.setor),
    usuario: trim(body.usuario), ns: trim(body.ns),
    pat: trim(body.pat), equipamento: trim(body.equipamento), obs: trim(body.obs),
    protocolo: trim(body.protocolo),
    dataRecebimento: trim(body.dataRecebimento) || null,
    valor: isNaN(valor) ? null : valor
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
  if (!d.protocolo) faltando.push('PROTOCOLO');
  if (!d.dataRecebimento) faltando.push('DATA DE RECEBIMENTO');
  if (d.valor == null) faltando.push('VALOR');
  if (faltando.length) throw new Error('Preencha: ' + faltando.join(', ') + '.');
}

app.get('/api/records', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT id, unidade, status, setor, usuario, ns,
    pat, equipamento, protocolo,
    CONVERT(varchar(10), data_recebimento, 23) AS dataRecebimento, valor, obs,
    criado_por AS criadoPor, atualizado_por AS atualizadoPor,
    CONVERT(varchar(19), criado_em, 120) AS criadoEm,
    CONVERT(varchar(19), atualizado_em, 120) AS atualizadoEm
    FROM dbo.EQUIPSTI_registros ORDER BY id DESC`);
  res.json(r.recordset);
}));

app.get('/api/records/:id/log', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT acao, campo, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
    usuario, CONVERT(varchar(19), data_hora, 120) AS dataHora
    FROM dbo.EQUIPSTI_registros_log WHERE registro_id = @id ORDER BY id DESC`,
    { id });
  res.json(r.recordset);
}));

app.post('/api/records', exigirAuth, wrap(async (req, res) => {
  const d = lerRegistro(req.body);
  validarRegistro(d);
  const usuario = req.user.email;
  const ins = await query(`INSERT INTO dbo.EQUIPSTI_registros
    (unidade, status, setor, usuario, ns, pat, equipamento, obs, protocolo, data_recebimento, valor, criado_por)
    OUTPUT INSERTED.id
    VALUES (@unidade, @status, @setor, @usuario, @ns, @pat, @equipamento, @obs, @protocolo, @dataRecebimento, @valor, @criadoPor)`,
    { unidade: S(d.unidade), status: S(d.status), setor: S(d.setor), usuario: S(d.usuario),
      ns: S(d.ns), pat: S(d.pat), equipamento: S(d.equipamento), obs: S(d.obs),
      protocolo: S(d.protocolo), dataRecebimento: S(d.dataRecebimento),
      valor: d.valor != null ? { type: sql.Decimal(15,2), value: d.valor } : S(null),
      criadoPor: S(usuario) });
  const novoId = ins.recordset[0].id;
  await query(`INSERT INTO dbo.EQUIPSTI_registros_log (registro_id, acao, usuario) VALUES (@id, 'CRIADO', @usuario)`,
    { id: novoId, usuario: S(usuario) });
  res.status(201).json({ ok: true });
}));

const CAMPOS_LOG = [
  ['unidade','UNIDADE'], ['status','STATUS'], ['setor','SETOR'], ['usuario','USUARIO'],
  ['ns','N/S'], ['pat','PAT MSA'], ['equipamento','EQUIPAMENTO'], ['protocolo','PROTOCOLO'],
  ['dataRecebimento','DATA RECEBIMENTO'], ['valor','VALOR'], ['obs','OBS']
];

app.put('/api/records/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerRegistro(req.body);
  validarRegistro(d);
  const usuario = req.user.email;

  const anterior = await query(`SELECT unidade, status, setor, usuario, ns, pat, equipamento,
    obs, protocolo, CONVERT(varchar(10), data_recebimento, 23) AS dataRecebimento,
    CAST(valor AS NVARCHAR) AS valor
    FROM dbo.EQUIPSTI_registros WHERE id=@id`, { id });
  const old = anterior.recordset[0] || {};

  await query(`UPDATE dbo.EQUIPSTI_registros SET
    unidade=@unidade, status=@status, setor=@setor, usuario=@usuario, ns=@ns,
    pat=@pat, equipamento=@equipamento, obs=@obs,
    protocolo=@protocolo, data_recebimento=@dataRecebimento, valor=@valor,
    atualizado_por=@atualizadoPor, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`,
    { id, unidade: S(d.unidade), status: S(d.status), setor: S(d.setor), usuario: S(d.usuario),
      ns: S(d.ns), pat: S(d.pat), equipamento: S(d.equipamento), obs: S(d.obs),
      protocolo: S(d.protocolo), dataRecebimento: S(d.dataRecebimento),
      valor: d.valor != null ? { type: sql.Decimal(15,2), value: d.valor } : S(null),
      atualizadoPor: S(usuario) });

  for (const [key, label] of CAMPOS_LOG) {
    const vAntes = String(old[key] ?? '');
    const vDepois = String(key === 'valor' ? (d.valor ?? '') : (d[key] ?? ''));
    const igual = key === 'valor'
      ? parseFloat(vAntes || 'NaN') === parseFloat(vDepois || 'NaN')
      : vAntes === vDepois;
    if (!igual) {
      await query(`INSERT INTO dbo.EQUIPSTI_registros_log
        (registro_id, acao, campo, valor_anterior, valor_novo, usuario)
        VALUES (@id, 'ATUALIZADO', @campo, @antes, @depois, @usuario)`,
        { id, campo: S(label), antes: S(vAntes), depois: S(vDepois), usuario: S(usuario) });
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

// Histórico completo de um PAT: unidade(s) de origem + linha do tempo de empréstimos.
app.get('/api/pats/:pat/history', exigirAuth, wrap(async (req, res) => {
  const pat = trim(req.params.pat);
  const origens = await query(`SELECT unidade, equipamento, ns,
      CONVERT(varchar(10), MIN(criado_em), 23) AS criadoEm
    FROM dbo.EQUIPSTI_registros WHERE pat = @pat
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

app.get('/api/chamados', exigirAuth, wrap(async (req, res) => {
  if (!eurosaCookie) await eurosaLogin();
  let result = await eurosaFetchChamados();
  // Re-login se sessão expirou (resposta HTML ou erro de auth)
  const expired = result.status === 401 || result.status === 302 ||
    (typeof result.data === 'string' && result.data.includes('LoginPortal')) ||
    (typeof result.data === 'object' && result.data?.erro);
  if (expired) {
    eurosaCookie = null;
    await eurosaLogin();
    result = await eurosaFetchChamados();
  }
  console.log('[chamados] status:', result.status, '| data:', JSON.stringify(result.data).slice(0, 200));
  res.json(result.data);
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
