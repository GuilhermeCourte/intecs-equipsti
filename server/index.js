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
import { opcoesRegistro, verificarRegistro, opcoesAutenticacao, verificarAutenticacao } from './webauthn.js';
import { notificar, notificarTeste } from './notificacoes.js';
import * as deviceService from './tacticalrmm/deviceService.js';
import * as deviceIntecsRepo from './tacticalrmm/deviceRepository.js';
import * as chamadosIntecsRepo from './chamadosIntecsRepository.js';
import { calcularPrazosSla } from './chamadosIntecsSla.js';
import { carregarPerfilChamados, exigirPapel, podeVerChamado } from './chamadosIntecsAuth.js';

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

// ===================== NOTIFICAÇÕES (sininho) =====================
// Lista as 30 notificações mais recentes do usuário logado + total não lido.
app.get('/api/notifications', exigirAuth, wrap(async (req, res) => {
  const uid = Number(req.user.sub);
  const itens = await query(
    `SELECT TOP 30 id, tipo, acao, titulo, mensagem, link, ref_id AS refId, ator_email AS ator,
            lido, CONVERT(varchar(19), criado_em, 120) AS criadoEm
       FROM dbo.EQUIPSTI_notificacoes
      WHERE usuario_id = @uid
      ORDER BY criado_em DESC, id DESC`, { uid });
  const nao = await query(
    `SELECT COUNT(*) AS n FROM dbo.EQUIPSTI_notificacoes WHERE usuario_id = @uid AND lido = 0`, { uid });
  res.json({ itens: itens.recordset, naoLidas: nao.recordset[0].n });
}));

// Marca todas as não lidas do usuário como lidas. (Antes da rota /:id/read.)
app.put('/api/notifications/read-all', exigirAuth, wrap(async (req, res) => {
  await query(`UPDATE dbo.EQUIPSTI_notificacoes SET lido = 1 WHERE usuario_id = @uid AND lido = 0`,
    { uid: Number(req.user.sub) });
  res.json({ ok: true });
}));

// Marca uma notificação específica como lida (apenas do próprio usuário).
app.put('/api/notifications/:id/read', exigirAuth, wrap(async (req, res) => {
  await query(`UPDATE dbo.EQUIPSTI_notificacoes SET lido = 1 WHERE id = @id AND usuario_id = @uid`,
    { id: Number(req.params.id), uid: Number(req.user.sub) });
  res.json({ ok: true });
}));

// Gera uma notificação de TESTE para o próprio usuário (sininho + e-mail),
// para validar os dois canais. emailEnviado=false indica SMTP não configurado.
app.post('/api/notifications/test', exigirAuth, wrap(async (req, res) => {
  const r = await notificarTeste({ id: req.user.sub, email: req.user.email });
  res.json({ ok: true, ...r });
}));

// ===================== BIOMETRIA (WebAuthn) =====================
// Lista as credenciais biométricas de um usuário.
const credsDoUsuario = async (usuarioId) => {
  const r = await query(
    'SELECT credential_id, public_key, counter, transports FROM dbo.EQUIPSTI_webauthn WHERE usuario_id = @id',
    { id: usuarioId }
  );
  return r.recordset;
};

// Há biometria cadastrada para o usuário logado?
app.get('/api/biometric/status', exigirAuth, wrap(async (req, res) => {
  const creds = await credsDoUsuario(Number(req.user.sub));
  res.json({ registrado: creds.length > 0 });
}));

// Inicia o cadastro: gera as opções de registro.
app.post('/api/biometric/register/options', exigirAuth, wrap(async (req, res) => {
  const creds = await credsDoUsuario(Number(req.user.sub));
  const options = await opcoesRegistro(Number(req.user.sub), req.user.email, creds);
  res.json(options);
}));

// Conclui o cadastro: valida e grava a credencial.
app.post('/api/biometric/register/verify', exigirAuth, wrap(async (req, res) => {
  const dados = await verificarRegistro(Number(req.user.sub), req.body);
  const rotulo = trim(req.body.rotulo) || null;
  await query(
    `INSERT INTO dbo.EQUIPSTI_webauthn (usuario_id, credential_id, public_key, counter, transports, rotulo)
     VALUES (@uid, @cid, @pk, @counter, @transports, @rotulo)`,
    {
      uid: Number(req.user.sub),
      cid: S(dados.credentialId),
      pk: S(dados.publicKey),
      counter: dados.counter,
      transports: S(dados.transports),
      rotulo: S(rotulo)
    }
  );
  res.status(201).json({ ok: true });
}));

// Inicia o login biométrico: gera challenge. O cliente informa a credencial
// deste aparelho (credId) para apontá-la diretamente, sem o seletor do Google.
app.post('/api/biometric/auth/options', wrap(async (req, res) => {
  const credId = trim(req.body?.credId);
  const allow = credId ? [{ id: credId }] : [];
  const { flowId, options } = await opcoesAutenticacao(allow);
  res.json({ flowId, options });
}));

// Conclui o login biométrico: valida e emite o JWT (mesmo do login normal).
app.post('/api/biometric/auth/verify', wrap(async (req, res) => {
  const { flowId, response } = req.body || {};
  if (!flowId || !response) return res.status(400).json({ error: 'Requisição inválida.' });

  const credId = String(response.id || '');
  const r = await query(
    `SELECT w.usuario_id, w.credential_id, w.public_key, w.counter, w.transports,
            u.email, u.ativo
       FROM dbo.EQUIPSTI_webauthn w
       JOIN dbo.EQUIPSTI_usuarios u ON u.id = w.usuario_id
      WHERE w.credential_id = @cid`,
    { cid: S(credId) }
  );
  const cred = r.recordset[0];
  if (!cred) return res.status(401).json({ error: 'Biometria não cadastrada neste sistema.' });
  if (!cred.ativo) return res.status(403).json({ error: 'Usuário inativo. Contate o administrador.' });

  const { newCounter } = await verificarAutenticacao(flowId, response, cred);
  await query('UPDATE dbo.EQUIPSTI_webauthn SET counter = @c WHERE credential_id = @cid',
    { c: newCounter, cid: S(credId) });

  res.json({ token: gerarToken({ id: cred.usuario_id, email: cred.email }), email: cred.email });
}));

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
  const inserted = await query(
    'INSERT INTO dbo.EQUIPSTI_usuarios (email, senha_hash) OUTPUT INSERTED.id VALUES (@email, @hash)',
    { email: S(email), hash: S(hash) }
  );
  res.status(201).json({ ok: true, id: inserted.recordset[0].id });
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
  const r = await query('SELECT lista, valor, oculto, detalhe, preco, tipo_aquisicao, quantidade, cnpj, endereco FROM dbo.EQUIPSTI_opcoes ORDER BY lista, valor');
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
      tipo_aquisicao: row.tipo_aquisicao || null,
      cnpj: row.cnpj || null,
      endereco: row.endereco || null
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
  const cnpjDigits = trim(req.body.cnpj || '').replace(/\D/g, '');
  let cnpj = null;
  if (cnpjDigits) {
    if (cnpjDigits.length !== 14) return res.status(400).json({ error: 'CNPJ inválido — informe 14 dígitos.' });
    cnpj = cnpjDigits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  const endereco = trim(req.body.endereco || '') || null;
  if (!OPTION_LISTS.includes(lista)) return res.status(400).json({ error: 'Lista inválida.' });
  await query('UPDATE dbo.EQUIPSTI_opcoes SET detalhe = @detalhe, preco = @preco, tipo_aquisicao = @tipoAquisicao, cnpj = @cnpj, endereco = @endereco WHERE lista = @lista AND valor = @valor',
    { detalhe: { type: sql.NVarChar, value: detalhe },
      preco: preco != null ? { type: sql.Decimal(15,2), value: preco } : S(null),
      tipoAquisicao: S(tipoAquisicao),
      cnpj: S(cnpj),
      endereco: S(endereco),
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
  await notificar({
    tipo: 'REGISTRO', acao: 'CRIADO', link: 'tab-registros', refId: novoId,
    ator: { id: req.user.sub, email: usuario },
    titulo: 'Novo registro',
    mensagem: `${d.equipamento || 'Equipamento'} — PAT ${d.pat || '—'} · N/S ${d.ns || '—'} · ${d.unidade || '—'}`
  });
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

  const camposAlterados = [];
  for (const [key, label] of CAMPOS_LOG) {
    const vAntes = String(old[key] ?? '');
    const vDepois = String(key === 'valor' ? (d.valor ?? '') : (d[key] ?? ''));
    const igual = key === 'valor'
      ? parseFloat(vAntes || 'NaN') === parseFloat(vDepois || 'NaN')
      : vAntes === vDepois;
    if (!igual) {
      camposAlterados.push(label);
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
      camposAlterados.push(nomeLog);
      await query(`INSERT INTO dbo.EQUIPSTI_registros_log
        (registro_id, acao, campo, valor_anterior, valor_novo, justificativa, usuario)
        VALUES (@id, 'ATUALIZADO', @campo, @antes, @depois, @justificativa, @usuario)`,
        { id, campo: S(nomeLog), antes: S(antes), depois: S(depois), justificativa: S(justificativa), usuario: S(usuario) });
    }
  }

  await notificar({
    tipo: 'REGISTRO', acao: 'ATUALIZADO', link: 'tab-registros', refId: id,
    ator: { id: req.user.sub, email: usuario },
    titulo: 'Registro atualizado',
    mensagem: `${d.equipamento || 'Equipamento'} — PAT ${d.pat || '—'}`
            + (camposAlterados.length ? ` · campos: ${camposAlterados.join(', ')}` : '')
  });

  res.json({ ok: true });
}));

app.delete('/api/records/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const prev = await query('SELECT pat, ns, equipamento FROM dbo.EQUIPSTI_registros WHERE id = @id', { id });
  await query('DELETE FROM dbo.EQUIPSTI_registros WHERE id = @id', { id });
  const r = prev.recordset[0];
  if (r) {
    await notificar({
      tipo: 'REGISTRO', acao: 'EXCLUIDO', link: 'tab-registros', refId: id,
      ator: { id: req.user.sub, email: req.user.email },
      titulo: 'Registro excluído',
      mensagem: `${r.equipamento || 'Equipamento'} — PAT ${r.pat || '—'} · N/S ${r.ns || '—'}`
    });
  }
  res.json({ ok: true });
}));

// ===================== INTERNET =====================
function lerInternet(body) {
  const valor = body.valor !== undefined && body.valor !== '' ? Number(String(body.valor).replace(',', '.')) : null;
  const diaRaw = parseInt(body.vencimentoDia ?? body.vencimento_dia, 10);
  const vencimentoDia = Number.isInteger(diaRaw) && diaRaw >= 1 && diaRaw <= 31 ? diaRaw : null;
  return {
    unidade: trim(body.unidade),
    empresa: trim(body.empresa) || null,
    contratoCnpj: trim(body.contratoCnpj ?? body.contrato_cnpj) || null,
    ipInternet: trim(body.ipInternet ?? body.ip_internet) || null,
    upDown: trim(body.upDown ?? body.up_down) || null,
    valor: isNaN(valor) ? null : valor,
    vencimentoDia,
    telefoneSuporte: trim(body.telefoneSuporte ?? body.telefone_suporte) || null,
    linhaAcesso: trim(body.linhaAcesso ?? body.linha_acesso) || null,
    linkAcesso: trim(body.linkAcesso ?? body.link_acesso) || null,
    emailContas: trim(body.emailContas ?? body.email_contas) || null,
    observacao: trim(body.observacao) || null
  };
}

const INTERNET_SELECT = `SELECT id, unidade, empresa, contrato_cnpj AS contratoCnpj,
  ip_internet AS ipInternet, up_down AS upDown, valor, vencimento_dia AS vencimentoDia,
  telefone_suporte AS telefoneSuporte, linha_acesso AS linhaAcesso, link_acesso AS linkAcesso,
  email_contas AS emailContas, observacao,
  criado_por AS criadoPor, atualizado_por AS atualizadoPor,
  CONVERT(varchar(19), criado_em, 120) AS criadoEm,
  CONVERT(varchar(19), atualizado_em, 120) AS atualizadoEm
  FROM dbo.EQUIPSTI_internet`;

function paramsInternet(d) {
  return {
    unidade: S(d.unidade), empresa: S(d.empresa), contratoCnpj: S(d.contratoCnpj),
    ipInternet: S(d.ipInternet), upDown: S(d.upDown),
    valor: d.valor != null ? { type: sql.Decimal(15,2), value: d.valor } : S(null),
    vencimentoDia: d.vencimentoDia != null ? { type: sql.Int, value: d.vencimentoDia } : S(null),
    telefoneSuporte: S(d.telefoneSuporte), linhaAcesso: S(d.linhaAcesso),
    linkAcesso: S(d.linkAcesso), emailContas: S(d.emailContas), observacao: S(d.observacao)
  };
}

app.get('/api/internet', exigirAuth, wrap(async (req, res) => {
  const r = await query(`${INTERNET_SELECT} ORDER BY unidade, id DESC`);
  res.json(r.recordset);
}));

app.post('/api/internet', exigirAuth, wrap(async (req, res) => {
  const d = lerInternet(req.body);
  if (!d.unidade) return res.status(400).json({ error: 'Selecione a unidade.' });
  await query(`INSERT INTO dbo.EQUIPSTI_internet
    (unidade, empresa, contrato_cnpj, ip_internet, up_down, valor, vencimento_dia, telefone_suporte, linha_acesso, link_acesso, email_contas, observacao, criado_por, atualizado_por)
    VALUES (@unidade, @empresa, @contratoCnpj, @ipInternet, @upDown, @valor, @vencimentoDia, @telefoneSuporte, @linhaAcesso, @linkAcesso, @emailContas, @observacao, @criadoPor, @criadoPor)`,
    { ...paramsInternet(d), criadoPor: S(req.user.email) });
  res.status(201).json({ ok: true });
}));

app.put('/api/internet/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerInternet(req.body);
  if (!d.unidade) return res.status(400).json({ error: 'Selecione a unidade.' });
  await query(`UPDATE dbo.EQUIPSTI_internet SET
    unidade=@unidade, empresa=@empresa, contrato_cnpj=@contratoCnpj, ip_internet=@ipInternet, up_down=@upDown,
    valor=@valor, vencimento_dia=@vencimentoDia, telefone_suporte=@telefoneSuporte, linha_acesso=@linhaAcesso,
    link_acesso=@linkAcesso, email_contas=@emailContas, observacao=@observacao,
    atualizado_por=@atualizadoPor, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`,
    { ...paramsInternet(d), id, atualizadoPor: S(req.user.email) });
  res.json({ ok: true });
}));

app.delete('/api/internet/:id', exigirAuth, wrap(async (req, res) => {
  await query('DELETE FROM dbo.EQUIPSTI_internet WHERE id = @id', { id: Number(req.params.id) });
  res.json({ ok: true });
}));

// ===================== PATs (origem dos empréstimos) =====================
app.get('/api/pats', exigirAuth, wrap(async (req, res) => {
  const r = await query(`SELECT DISTINCT pat FROM dbo.EQUIPSTI_registros
    WHERE pat IS NOT NULL AND LTRIM(RTRIM(pat)) <> '' ORDER BY pat`);
  res.json(r.recordset.map((row) => row.pat));
}));

app.get('/api/pats/:pat/info', exigirAuth, wrap(async (req, res) => {
  const pat = trim(req.params.pat);
  const r = await query(
    `SELECT TOP 1 equipamento, ns FROM dbo.EQUIPSTI_registros
      WHERE pat = @pat ORDER BY criado_em DESC`,
    { pat: S(pat) });
  const row = r.recordset[0];
  res.json(row ? { equipamento: row.equipamento || '', ns: row.ns || '' } : { equipamento: '', ns: '' });
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

// Lookup do último cadastro de um PAT (+NS opcional): equipamento, setor e unidade.
// Usado para auto-preencher PONTO DE INSTALAÇÃO / DESCRIÇÃO EQUIP / BKP UNIDADE no módulo INTECS vs MSA.
async function lookupEquip(pat, ns) {
  const p = trim(pat);
  const n = trim(ns);
  const r = await query(
    `SELECT TOP 1 equipamento, setor, unidade, ns FROM dbo.EQUIPSTI_registros
      WHERE pat = @pat${n ? ' AND ns = @ns' : ''}
      ORDER BY criado_em DESC`,
    n ? { pat: S(p), ns: S(n) } : { pat: S(p) });
  const row = r.recordset[0];
  return row
    ? { equipamento: row.equipamento || '', setor: row.setor || '', unidade: row.unidade || '', ns: row.ns || '' }
    : { equipamento: '', setor: '', unidade: '', ns: '' };
}

app.get('/api/pats/:pat/lookup', exigirAuth, wrap(async (req, res) => {
  res.json(await lookupEquip(req.params.pat, req.query.ns));
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

  // Busca unidade original e nome do equipamento do cadastro.
  const origemRes = await query(
    `SELECT TOP 1 unidade, equipamento FROM dbo.EQUIPSTI_registros
     WHERE pat = @pat ${ns ? 'AND ns = @ns' : ''}
     ORDER BY criado_em`,
    ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });
  const origem = origemRes.recordset[0] || {};
  const unidadeOriginal = origem.unidade || null;
  const equipamento = origem.equipamento || '';

  // Se destino é a unidade original, trata como devolução (não cria novo empréstimo).
  if (unidadeOriginal && unidade.toUpperCase() === unidadeOriginal.toUpperCase()) {
    await query(
      `UPDATE dbo.EQUIPSTI_emprestimos
         SET status = 'DEVOLVIDO', data_devolucao = CAST(GETDATE() AS date)
       WHERE pat = @pat AND status = 'EMPRESTADO'
         ${ns ? 'AND (ns = @ns OR ns IS NULL)' : ''}`,
      ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });
    await notificar({
      tipo: 'EMPRESTIMO', acao: 'DEVOLVIDO', link: 'tab-emprestimos', email: true,
      ator: { id: req.user.sub, email: req.user.email },
      titulo: 'Devolução de empréstimo',
      mensagem: `${equipamento || 'Equipamento'} — PAT ${pat} devolvido a ${unidade}`
    });
    return res.status(201).json({ ok: true, devolvido: true });
  }

  // Fecha empréstimo aberto anterior como TRANSFERIDO (suporta cadeia 1→2→3→1).
  await query(
    `UPDATE dbo.EQUIPSTI_emprestimos
       SET status = 'TRANSFERIDO', data_devolucao = CAST(GETDATE() AS date)
     WHERE pat = @pat AND status = 'EMPRESTADO'
       ${ns ? 'AND (ns = @ns OR ns IS NULL)' : ''}`,
    ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });

  const insLoan = await query(
    `INSERT INTO dbo.EQUIPSTI_emprestimos (pat, ns, unidade, data_emprestimo, status, obs)
      OUTPUT INSERTED.id
      VALUES (@pat, @ns, @unidade, @data, 'EMPRESTADO', @obs)`,
    { pat: S(pat), ns: S(ns || null), unidade: S(unidade), data: S(data || null), obs: S(obs) });
  await notificar({
    tipo: 'EMPRESTIMO', acao: 'CRIADO', link: 'tab-emprestimos', email: true,
    refId: insLoan.recordset[0]?.id,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Novo empréstimo',
    mensagem: `${equipamento || 'Equipamento'} — PAT ${pat} → ${unidade}`
  });
  res.status(201).json({ ok: true });
}));

app.put('/api/loans/:id/status', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const status = trim(req.body.status).toUpperCase();
  if (status !== 'EMPRESTADO' && status !== 'DEVOLVIDO') {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  const loanRow = await query(`SELECT pat, ns, status FROM dbo.EQUIPSTI_emprestimos WHERE id=@id`, { id });
  if (!loanRow.recordset.length) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
  const { pat: aPat, ns: aNs, status: statusAntigo } = loanRow.recordset[0];

  if (status === 'EMPRESTADO') {
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

  const eq = await lookupEquip(aPat, aNs);
  const mudancasEmp = statusAntigo && statusAntigo !== status
    ? [{ campo: 'Status', de: statusAntigo, para: status }] : [];
  await notificar({
    tipo: 'EMPRESTIMO', acao: 'ATUALIZADO', link: 'tab-emprestimos', refId: id, email: true,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Empréstimo atualizado',
    mensagem: `${eq.equipamento || 'Equipamento'} — PAT ${aPat}`,
    mudancas: mudancasEmp
  });
  res.json({ ok: true });
}));

// ===================== CHAMADOS — INTECS vs MSA =====================
function lerIntecsMsa(body) {
  const g = (k) => { const v = trim(body[k]); return v === '' ? null : v; };
  return {
    data_solicitacao:      g('data_solicitacao'),
    numero_chamado_msa:    g('numero_chamado_msa'),
    problema:              g('problema'),
    unidade:               g('unidade'),
    glpi:                  g('glpi'),
    status_intecs:         g('status_intecs'),
    patrimonio_msa:        g('patrimonio_msa'),
    ns:                    g('ns'),
    ponto_instalacao:      g('ponto_instalacao'),
    descricao_equip:       g('descricao_equip'),
    data_retirada_equip:   g('data_retirada_equip'),
    data_entrega_equip:    g('data_entrega_equip'),
    patrimonio_bkp_intecs: g('patrimonio_bkp_intecs'),
    bkp_unidade:           g('bkp_unidade'),
    observacao:            g('observacao'),
  };
}

const paramsIntecsMsa = (d) => ({
  data_solicitacao:      S(d.data_solicitacao),
  numero_chamado_msa:    S(d.numero_chamado_msa),
  problema:              S(d.problema),
  unidade:               S(d.unidade),
  glpi:                  S(d.glpi),
  status_intecs:         S(d.status_intecs),
  patrimonio_msa:        S(d.patrimonio_msa),
  ns:                    S(d.ns),
  ponto_instalacao:      S(d.ponto_instalacao),
  descricao_equip:       S(d.descricao_equip),
  data_retirada_equip:   S(d.data_retirada_equip),
  data_entrega_equip:    S(d.data_entrega_equip),
  patrimonio_bkp_intecs: S(d.patrimonio_bkp_intecs),
  bkp_unidade:           S(d.bkp_unidade),
  observacao:            S(d.observacao),
});

// Campos do chamado rastreados para o "de → para" nas notificações de atualização.
const CAMPOS_CHAMADO = [
  ['status_intecs', 'Status INTECS'],
  ['problema', 'Problema'],
  ['unidade', 'Unidade'],
  ['numero_chamado_msa', 'Nº MSA'],
  ['glpi', 'GLPI'],
  ['patrimonio_msa', 'Patrimônio'],
  ['ns', 'N/S'],
  ['ponto_instalacao', 'Ponto de instalação'],
  ['descricao_equip', 'Descrição equip.'],
  ['data_retirada_equip', 'Data retirada'],
  ['data_entrega_equip', 'Data entrega'],
  ['patrimonio_bkp_intecs', 'Patrimônio BKP'],
  ['bkp_unidade', 'Unidade BKP'],
  ['observacao', 'Observação'],
];

// Converte o status do chamado no eurosa (St) para os buckets da aba INTECS vs
// MSA. Retorna null quando não há status (rows criadas manualmente seguem o
// cálculo por datas no cliente).
function mapStatusMsa(st) {
  const s = trim(st).toLowerCase();
  if (!s) return null;
  if (/resolv|cancel|fechad|finaliz|conclu/.test(s)) return 'Finalizado';
  if (/atend|andamento|process|execu/.test(s))       return 'Em Andamento';
  return 'Aberto';
}

// Insere uma linha em INTECS vs MSA a partir de um chamado da MSA, se ainda não
// existir (dedup pelo Nº MSA). Preenche os campos automáticos; deixa os manuais
// em branco. Retorna true se inseriu.
async function inserirChamadoMsaSeNovo({ codigo, dataSolic, problema, statusMsa,
                                         unidade, patrimonio, ns, criadoPor }) {
  if (!codigo) return false;
  const ja = await query(
    'SELECT TOP 1 1 FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE numero_chamado_msa = @c',
    { c: S(codigo) });
  if (ja.recordset.length) return false;            // dedup pelo Nº MSA
  let ponto = null, descr = null;
  if (trim(patrimonio)) {
    const eq = await lookupEquip(patrimonio, ns);    // auto-preenche se houver PAT
    ponto = eq.setor || null; descr = eq.equipamento || null;
  }
  const d = lerIntecsMsa({                            // reusa o shape existente
    data_solicitacao: dataSolic, numero_chamado_msa: codigo, problema,
    unidade, patrimonio_msa: patrimonio, ns,
    ponto_instalacao: ponto, descricao_equip: descr,
  });
  await query(`INSERT INTO dbo.EQUIPSTI_chamados_intecsmsa
    (data_solicitacao, numero_chamado_msa, problema, unidade,
     patrimonio_msa, ns, ponto_instalacao, descricao_equip, status_msa, criado_por)
    VALUES (@data_solicitacao, @numero_chamado_msa, @problema, @unidade,
     @patrimonio_msa, @ns, @ponto_instalacao, @descricao_equip, @status_msa, @criado_por)`,
    { ...paramsIntecsMsa(d), status_msa: S(statusMsa || null), criado_por: S(criadoPor || 'sync') });
  return true;
}

// Máximo de chamados que buscam o detalhe (unidade) por sincronização, para não
// travar o carregamento da aba quando há muitos chamados sem unidade.
const SYNC_MAX_DETALHE = 60;

// Puxa a lista de chamados do eurosa e sincroniza a aba INTECS vs MSA: cria uma
// linha para cada chamado novo (backfill + novos), mantém o status_msa dos já
// existentes atualizado, e preenche a unidade (do sistema) puxando o detalhe do
// chamado para as linhas que ainda estão sem unidade.
async function sincronizarIntecsMsa() {
  const result = await eurosaCall(() => eurosaFetchChamados());
  const data = result.data;
  const lista = Array.isArray(data)
    ? data : (data?.root ?? data?.Lista ?? data?.lista ?? []);

  // Associação unidade da MSA -> unidade do sistema (EQUIPSTI_opcoes.detalhe).
  const assocRows = await query(
    "SELECT valor, detalhe FROM dbo.EQUIPSTI_opcoes WHERE lista = 'UNIDADE' AND detalhe IS NOT NULL AND detalhe <> ''");
  const assoc = {};
  assocRows.recordset.forEach((r) => { assoc[trim(r.detalhe)] = r.valor; });

  // Linhas existentes (para saber quais ainda não têm unidade).
  const existRows = await query(
    'SELECT numero_chamado_msa, unidade FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE numero_chamado_msa IS NOT NULL');
  const existUnidade = {};
  existRows.recordset.forEach((r) => { existUnidade[r.numero_chamado_msa] = r.unidade; });

  const semUnidade = [];   // { codigo, chave } a buscar o detalhe
  for (const ch of lista) {
    const codigo = trim(ch.Codigo);
    if (!codigo) continue;
    const statusMsa = mapStatusMsa(ch.St);
    const inseriu = await inserirChamadoMsaSeNovo({
      codigo,
      dataSolic: trim(ch.Criacao).slice(0, 10) || null,  // 'YYYY-MM-DD'
      problema:  trim(ch.Assunto) || null,
      statusMsa,
      criadoPor: 'sync',
    });
    if (!inseriu && statusMsa) {                        // já existe: refresca status
      await query(
        'UPDATE dbo.EQUIPSTI_chamados_intecsmsa SET status_msa = @s WHERE numero_chamado_msa = @c',
        { s: S(statusMsa), c: S(codigo) });
    }
    const temUnidade = !inseriu && trim(existUnidade[codigo]);
    if (!temUnidade && ch.Chave) semUnidade.push({ codigo, chave: ch.Chave });
  }

  // Preenche a unidade buscando o detalhe (campo 19024) e mapeando para o sistema.
  for (const { codigo, chave } of semUnidade.slice(0, SYNC_MAX_DETALHE)) {
    try {
      const lst = await eurosaCamposExtras(chave);
      const campo = lst.find((e) => Number(e.codcampoextra) === 19024);
      const msaUnidade = campo?.valcampoextra ? trim(String(campo.valcampoextra)) : '';
      if (!msaUnidade) continue;
      const unidadeSistema = assoc[msaUnidade] || msaUnidade;
      await query(
        `UPDATE dbo.EQUIPSTI_chamados_intecsmsa SET unidade = @u
           WHERE numero_chamado_msa = @c AND (unidade IS NULL OR unidade = '')`,
        { u: S(unidadeSistema), c: S(codigo) });
    } catch (e) { console.warn('[intecs-msa unidade] chamado', codigo, '->', e.message); }
  }
}

app.get('/api/intecs-msa', exigirAuth, wrap(async (req, res) => {
  try { await sincronizarIntecsMsa(); }
  catch (e) { console.warn('[intecs-msa sync] falhou:', e.message); }
  const r = await query(`SELECT id,
    CONVERT(varchar(10), data_solicitacao, 23) AS data_solicitacao,
    numero_chamado_msa, problema, unidade, glpi, status_intecs,
    patrimonio_msa, ns, ponto_instalacao, descricao_equip,
    CONVERT(varchar(10), data_retirada_equip, 23) AS data_retirada_equip,
    CONVERT(varchar(10), data_entrega_equip, 23) AS data_entrega_equip,
    patrimonio_bkp_intecs, bkp_unidade, observacao, status_msa,
    criado_por, atualizado_por,
    CONVERT(varchar(19), criado_em, 120) AS criado_em,
    CONVERT(varchar(19), atualizado_em, 120) AS atualizado_em
    FROM dbo.EQUIPSTI_chamados_intecsmsa ORDER BY id DESC`);
  res.json(r.recordset);
}));

app.post('/api/intecs-msa', exigirAuth, wrap(async (req, res) => {
  const d = lerIntecsMsa(req.body);
  await query(`INSERT INTO dbo.EQUIPSTI_chamados_intecsmsa
    (data_solicitacao, numero_chamado_msa, problema, unidade, glpi, status_intecs,
     patrimonio_msa, ns, ponto_instalacao, descricao_equip, data_retirada_equip, data_entrega_equip,
     patrimonio_bkp_intecs, bkp_unidade, observacao, criado_por)
    VALUES (@data_solicitacao, @numero_chamado_msa, @problema, @unidade, @glpi, @status_intecs,
     @patrimonio_msa, @ns, @ponto_instalacao, @descricao_equip, @data_retirada_equip, @data_entrega_equip,
     @patrimonio_bkp_intecs, @bkp_unidade, @observacao, @criado_por)`,
    { ...paramsIntecsMsa(d), criado_por: S(req.user.email) });
  res.status(201).json({ ok: true });
}));

app.put('/api/intecs-msa/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerIntecsMsa(req.body);
  const antesRes = await query(`SELECT numero_chamado_msa, problema, unidade, glpi, status_intecs,
      patrimonio_msa, ns, ponto_instalacao, descricao_equip,
      CONVERT(varchar(10), data_retirada_equip, 23) AS data_retirada_equip,
      CONVERT(varchar(10), data_entrega_equip, 23) AS data_entrega_equip,
      patrimonio_bkp_intecs, bkp_unidade, observacao
      FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE id=@id`, { id });
  const antes = antesRes.recordset[0];
  const upd = await query(`UPDATE dbo.EQUIPSTI_chamados_intecsmsa SET
    data_solicitacao=@data_solicitacao, numero_chamado_msa=@numero_chamado_msa, problema=@problema,
    unidade=@unidade, glpi=@glpi, status_intecs=@status_intecs, patrimonio_msa=@patrimonio_msa, ns=@ns,
    ponto_instalacao=@ponto_instalacao, descricao_equip=@descricao_equip,
    data_retirada_equip=@data_retirada_equip, data_entrega_equip=@data_entrega_equip,
    patrimonio_bkp_intecs=@patrimonio_bkp_intecs, bkp_unidade=@bkp_unidade, observacao=@observacao,
    atualizado_por=@atualizado_por, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`,
    { ...paramsIntecsMsa(d), id, atualizado_por: S(req.user.email) });
  if (upd.rowsAffected[0] === 0) return res.status(404).json({ error: 'Registro não encontrado.' });

  const mudancasCh = [];
  if (antes) {
    for (const [key, label] of CAMPOS_CHAMADO) {
      const de = String(antes[key] ?? '');
      const para = String(d[key] ?? '');
      if (de !== para) mudancasCh.push({ campo: label, de, para });
    }
  }

  const eqUpd = await lookupEquip(d.patrimonio_msa, d.ns);
  await notificar({
    tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', refId: id, email: true,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Chamado atualizado',
    mensagem: `${eqUpd.equipamento || 'Equipamento'} — PAT ${d.patrimonio_msa || '—'}`
            + (d.numero_chamado_msa ? ` · nº ${d.numero_chamado_msa}` : ''),
    mudancas: mudancasCh
  });
  res.json({ ok: true });
}));

app.delete('/api/intecs-msa/:id', exigirAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const prev = await query(
    'SELECT numero_chamado_msa, patrimonio_msa, ns FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE id = @id', { id });
  await query('DELETE FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE id = @id', { id });
  const c = prev.recordset[0];
  if (c) {
    const eqDel = await lookupEquip(c.patrimonio_msa, c.ns);
    await notificar({
      tipo: 'CHAMADO', acao: 'EXCLUIDO', link: 'tab-chamados', refId: id, email: true,
      ator: { id: req.user.sub, email: req.user.email },
      titulo: 'Chamado excluído',
      mensagem: (c.numero_chamado_msa ? `nº ${c.numero_chamado_msa} · ` : '')
              + `${eqDel.equipamento || 'Equipamento'} — PAT ${c.patrimonio_msa || '—'}`
    });
  }
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

// Lê os CamposExtras de um chamado (listaDetalhes). Usado para puxar a unidade
// (codcampoextra 19024) dos chamados já existentes na sincronização.
async function eurosaCamposExtras(chave) {
  const body = new URLSearchParams({ App: 'Portal', Dados: JSON.stringify({ Codigo: String(chave), CodigoAcao: '0' }) });
  const res = await fetch('https://eurosa.desk.ms/Chamados/listaDetalhes', {
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
  let d; try { d = JSON.parse(text); } catch { d = null; }
  return Array.isArray(d?.CamposExtras) ? d.CamposExtras : [];
}

const CHAMADO_UNIDADES = [
  'INTECS_SP',
  'AS - SÃO MIGUEL PAULISTA',
  'AS - CITY JARAGUA',
  'AS - JARAGUA',
  'AS - BRASILANDIA',
  'AS - GUAIANASES',
  'AS - TIRADENTES',
  'AS - MBOI MIRIM',
];

app.get('/api/chamados/assuntos', exigirAuth, wrap(async (req, res) => {
  const dados = {
    Pesquisa: '', Ativo: '1', Ordem: [], Tudo: 'true', Ajax: 'true',
    Filtro: { ListaCatalogoUsuario: ['', 'equal'] }
  };
  const result = await eurosaCall(() => eurosaPost('/Chamados/listaAutoCategoria', dados));
  console.log('[assuntos] status:', result.status, '| data:', JSON.stringify(result.data).slice(0, 300));
  if (result.status >= 400) throw new Error('Erro eurosa: ' + result.status);
  const raw = result.data?.root ?? result.data ?? [];
  const lista = Array.isArray(raw) ? raw : [];
  res.json(lista.map(i => ({ id: String(i.id).replace(/\\+$/, ''), text: i.text })));
}));

app.get('/api/chamados/unidades', exigirAuth, (req, res) => {
  res.json(CHAMADO_UNIDADES);
});

app.get('/api/chamados/:chave', exigirAuth, wrap(async (req, res) => {
  const chave = trim(req.params.chave);

  const [detalhe, detalhesExtra] = await Promise.all([
    eurosaCall(() => eurosaGetChamadoDetalhe(chave)),
    eurosaCall(() => {
      const body = new URLSearchParams({ App: 'Portal', Dados: JSON.stringify({ Codigo: chave, CodigoAcao: '0' }) });
      return fetch('https://eurosa.desk.ms/Chamados/listaDetalhes', {
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
      }).then(async r => { const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; });
    })
  ]);

  if (detalhe.status >= 400) throw new Error('Eurosa retornou ' + detalhe.status);

  const data = detalhe.data || {};
  const extras = Array.isArray(detalhesExtra?.data?.CamposExtras) ? detalhesExtra.data.CamposExtras : [];
  const patExtra = extras.find(e => e.codcampoextra === 20742);
  const pat = patExtra?.valcampoextra && patExtra.valcampoextra !== '0' ? trim(String(patExtra.valcampoextra)) : null;

  let equipamento = null;
  if (pat) {
    try {
      const eq = await query(
        `SELECT TOP 1 equipamento FROM dbo.EQUIPSTI_registros WHERE pat = @pat ORDER BY criado_em DESC`,
        { pat: S(pat) });
      equipamento = eq.recordset[0]?.equipamento || null;
    } catch { /* ignora se falhar */ }
  }

  data._pat = pat;
  data._equipamento = equipamento;
  res.json(data);
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

  let mensagemInt = `nº ${codigo || chave}`;
  try {
    const ch = await query(
      'SELECT TOP 1 patrimonio_msa, ns FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE numero_chamado_msa = @c',
      { c: S(codigo) });
    const row = ch.recordset[0];
    if (row && (row.patrimonio_msa || trim(row.ns))) {
      const eq = await lookupEquip(row.patrimonio_msa, row.ns);
      mensagemInt += ` · ${eq.equipamento || 'Equipamento'} — PAT ${row.patrimonio_msa || '—'}`;
    }
  } catch { /* lookup é apenas enriquecimento da mensagem */ }
  await notificar({
    tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', email: true,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Nova interação no chamado',
    mensagem: mensagemInt
  });
  res.status(201).json(result.data);
}));

app.post('/api/chamados', exigirAuth, wrap(async (req, res) => {
  const codCatalogo   = trim(req.body.codCatalogo   || '');
  const assuntoText   = trim(req.body.assuntoText   || '');
  const descricao     = trim(req.body.descricao     || '');
  const localTrabalho = trim(req.body.localTrabalho || '');
  const endereco      = trim(req.body.endereco      || '');
  const unidade       = trim(req.body.unidade       || '');

  if (!codCatalogo) return res.status(400).json({ error: 'Selecione o assunto.' });

  // Resolve o equipamento (nome + N/S) a partir do patrimônio para montar o
  // cabeçalho padrão da descrição. Quando o PAT tem N/S único, o front não envia
  // o NS, então derivamos do banco (eqChamado.ns).
  const patChamado = trim(req.body.patrimonio || '');
  const nsForm     = trim(req.body.ns || '');
  const eqChamado  = patChamado
    ? await lookupEquip(patChamado, nsForm)
    : { equipamento: '', setor: '', unidade: '', ns: '' };
  const nsChamado  = nsForm || eqChamado.ns;

  // Descrição = cabeçalho do equipamento (nome / PAT / N/S) + observação opcional,
  // separados por uma linha em branco. Linhas sem valor são omitidas.
  const linhasEquip = [];
  if (eqChamado.equipamento) linhasEquip.push(eqChamado.equipamento);
  if (patChamado)            linhasEquip.push('PAT: ' + patChamado);
  if (nsChamado)             linhasEquip.push('N/S: ' + nsChamado);

  const partes = [];
  if (linhasEquip.length) partes.push(linhasEquip.join('<br>'));
  if (descricao)          partes.push(descricao);
  const descricaoHtml = partes.map(p => '<p>' + p + '</p>').join('');

  if (!descricaoHtml) return res.status(400).json({ error: 'Informe o patrimônio ou uma observação.' });

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
      Descricao:            descricaoHtml
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

  // Espelha o novo chamado na aba INTECS vs MSA já com os campos automáticos
  // que só estão disponíveis no momento da criação (patrimônio/NS/unidade).
  const codigo = String(result.data?.url?.text || '').match(/\d{4}-\d{6}/)?.[0] || '';
  try {
    // Converte a unidade da MSA para a unidade cadastrada no sistema, usando a
    // associação gravada em EQUIPSTI_opcoes.detalhe (lista UNIDADE).
    let unidadeSistema = unidade;
    if (unidade) {
      const m = await query(
        "SELECT TOP 1 valor FROM dbo.EQUIPSTI_opcoes WHERE lista = 'UNIDADE' AND detalhe = @d",
        { d: S(unidade) });
      if (m.recordset.length) unidadeSistema = m.recordset[0].valor;
    }
    await inserirChamadoMsaSeNovo({
      codigo,
      dataSolic:  new Date().toISOString().slice(0, 10),
      problema:   assuntoText || descricao,
      unidade:    unidadeSistema,
      patrimonio: patChamado,
      ns:         nsChamado,
      criadoPor:  req.user.email,
    });
  } catch (e) { console.warn('[intecs-msa enrich] falhou:', e.message); }

  await notificar({
    tipo: 'CHAMADO', acao: 'CRIADO', link: 'tab-chamados', email: true,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Chamado aberto',
    mensagem: `${assuntoText || descricao}`
            + (patChamado ? ` · ${eqChamado.equipamento || 'Equipamento'} — PAT ${patChamado}` : '')
            + (codigo ? ` · nº ${codigo}` : '')
  });

  res.status(201).json(result.data);
}));

// ===================== DASHBOARD =====================
app.get('/api/dashboard', exigirAuth, wrap(async (req, res) => {
  const [rEquip, rTotal, rEmp, rEmpTotal, rInsumos] = await Promise.all([
    query(`
      SELECT
        unidade,
        COUNT(*) AS total,
        SUM(CASE WHEN tipo_aquisicao = 'LOCADO' THEN 1 ELSE 0 END) AS locados,
        SUM(CASE WHEN tipo_aquisicao = 'LOCADO' THEN ISNULL(valor, 0) ELSE 0 END) AS valor_locacao
      FROM dbo.EQUIPSTI_registros
      GROUP BY unidade
      ORDER BY unidade
    `),
    query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN tipo_aquisicao = 'LOCADO' THEN 1 ELSE 0 END) AS locados,
        SUM(CASE WHEN tipo_aquisicao = 'LOCADO' THEN ISNULL(valor, 0) ELSE 0 END) AS valor_locacao
      FROM dbo.EQUIPSTI_registros
    `),
    query(`
      SELECT unidade, COUNT(*) AS emprestados
      FROM dbo.EQUIPSTI_emprestimos
      WHERE status = 'EMPRESTADO'
      GROUP BY unidade
    `),
    query(`SELECT COUNT(*) AS emprestados FROM dbo.EQUIPSTI_emprestimos WHERE status = 'EMPRESTADO'`),
    query(`SELECT ISNULL(SUM(quantidade), 0) AS total_insumos FROM dbo.EQUIPSTI_opcoes WHERE lista = 'INSUMOS'`),
  ]);

  const empMap = {};
  for (const row of rEmp.recordset) empMap[row.unidade] = row.emprestados;

  res.json({
    geral: {
      total_equipamentos: rTotal.recordset[0].total,
      locados: rTotal.recordset[0].locados,
      valor_locacao: Number(rTotal.recordset[0].valor_locacao) || 0,
      emprestados: rEmpTotal.recordset[0].emprestados,
      total_insumos: rInsumos.recordset[0].total_insumos,
    },
    por_unidade: rEquip.recordset.map(r => ({
      unidade: r.unidade,
      total: r.total,
      locados: r.locados,
      valor_locacao: Number(r.valor_locacao) || 0,
      emprestados: empMap[r.unidade] || 0,
    })),
  });
}));

// ===================== CHAMADOS INTECS (RMM + papéis) =====================
// Módulo interno, independente do MSA/Eurosa. Papéis (Básico/Gestor/Técnico/
// Master) valem só aqui — o resto do app continua sem restrição por papel.

app.get('/api/tactical-agents', exigirAuth, wrap(async (req, res) => {
  const agentes = await deviceService.listarAgentesDisponiveis();
  res.json(agentes);
}));

// Detecção da máquina do usuário no momento da abertura do chamado, por IP
// da requisição (sem vínculo fixo usuário<->equipamento).
app.post('/api/chamados-intecs/verificar-maquina', exigirAuth, wrap(async (req, res) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket.remoteAddress || '';
  const ipLimpo = ip.replace('::ffff:', '');
  const matches = await deviceService.detectarAgentesPorIp(ipLimpo);
  res.json({ ip: ipLimpo, matches });
}));

app.get('/api/chamados-intecs/meu-perfil', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  res.json({ id: req.perfilCI.id, email: req.perfilCI.email, role: req.perfilCI.role, unidade: req.perfilCI.unidade, setor: req.perfilCI.setor });
}));

app.get('/api/chamados-intecs/categorias', exigirAuth, wrap(async (req, res) => {
  const categorias = await chamadosIntecsRepo.listarCategorias();
  res.json(categorias);
}));

// Usuários elegíveis para atender chamado (Técnico/Master) — usado no
// dropdown "Responsável" e no filtro da lista.
app.get('/api/chamados-intecs/atendentes', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const atendentes = await chamadosIntecsRepo.listarAtendentes();
  res.json(atendentes);
}));

app.post('/api/chamados-intecs/categorias', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const nome = trim(req.body.nome || '');
  if (!nome) return res.status(400).json({ error: 'Informe o nome da categoria.' });
  const categoria = await chamadosIntecsRepo.criarCategoria(nome);
  res.status(201).json(categoria);
}));

app.post('/api/chamados-intecs/subcategorias', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const nome = trim(req.body.nome || '');
  const categoriaId = Number(req.body.categoria_id);
  if (!nome || !categoriaId) return res.status(400).json({ error: 'Informe categoria e nome da subcategoria.' });
  const subcategoria = await chamadosIntecsRepo.criarSubcategoria(categoriaId, nome);
  res.status(201).json(subcategoria);
}));

app.delete('/api/chamados-intecs/categorias/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  await chamadosIntecsRepo.removerCategoria(req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/chamados-intecs/subcategorias/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  await chamadosIntecsRepo.removerSubcategoria(req.params.id);
  res.json({ ok: true });
}));

// ---------- Prioridades (com SLA) ----------

app.get('/api/chamados-intecs/prioridades', exigirAuth, wrap(async (req, res) => {
  res.json(await chamadosIntecsRepo.listarPrioridades());
}));

app.post('/api/chamados-intecs/prioridades', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const nome = trim(req.body.nome || '').toUpperCase();
  const slaResposta = Number(req.body.sla_resposta_horas);
  const slaConclusao = Number(req.body.sla_conclusao_horas);
  if (!nome || !slaResposta || !slaConclusao) {
    return res.status(400).json({ error: 'Informe nome, horas de resposta e horas de conclusão.' });
  }
  const prioridade = await chamadosIntecsRepo.criarPrioridade({
    nome, sla_resposta_horas: slaResposta, sla_conclusao_horas: slaConclusao,
    cor: trim(req.body.cor || ''), ordem: Number(req.body.ordem) || 0
  });
  res.status(201).json(prioridade);
}));

app.put('/api/chamados-intecs/prioridades/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const slaResposta = Number(req.body.sla_resposta_horas);
  const slaConclusao = Number(req.body.sla_conclusao_horas);
  if (!slaResposta || !slaConclusao) return res.status(400).json({ error: 'Informe horas de resposta e conclusão.' });
  await chamadosIntecsRepo.atualizarPrioridade(req.params.id, {
    sla_resposta_horas: slaResposta, sla_conclusao_horas: slaConclusao,
    cor: trim(req.body.cor || ''), ordem: Number(req.body.ordem) || 0
  });
  res.json({ ok: true });
}));

app.delete('/api/chamados-intecs/prioridades/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  await chamadosIntecsRepo.removerPrioridade(req.params.id);
  res.json({ ok: true });
}));

// ---------- Status ----------

app.get('/api/chamados-intecs/status-config', exigirAuth, wrap(async (req, res) => {
  res.json(await chamadosIntecsRepo.listarStatusConfig());
}));

app.post('/api/chamados-intecs/status-config', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const nome = trim(req.body.nome || '').toUpperCase().replace(/\s+/g, '_');
  const tipoSistema = trim(req.body.tipo_sistema || '');
  const tiposValidos = ['ABERTO', 'ANDAMENTO', 'RESOLVIDO', 'FECHADO', 'CANCELADO'];
  if (!nome || !tiposValidos.includes(tipoSistema)) {
    return res.status(400).json({ error: 'Informe nome e um tipo de sistema válido.' });
  }
  const status = await chamadosIntecsRepo.criarStatus({
    nome, tipo_sistema: tipoSistema, cor: trim(req.body.cor || ''), ordem: Number(req.body.ordem) || 0
  });
  res.status(201).json(status);
}));

app.put('/api/chamados-intecs/status-config/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const tipoSistema = trim(req.body.tipo_sistema || '');
  const tiposValidos = ['ABERTO', 'ANDAMENTO', 'RESOLVIDO', 'FECHADO', 'CANCELADO'];
  if (!tiposValidos.includes(tipoSistema)) return res.status(400).json({ error: 'Tipo de sistema inválido.' });
  await chamadosIntecsRepo.atualizarStatus(req.params.id, {
    tipo_sistema: tipoSistema, cor: trim(req.body.cor || ''), ordem: Number(req.body.ordem) || 0
  });
  res.json({ ok: true });
}));

app.delete('/api/chamados-intecs/status-config/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  await chamadosIntecsRepo.removerStatus(req.params.id);
  res.json({ ok: true });
}));

// ---------- Administração (só Master) ----------

app.get('/api/chamados-intecs/usuarios', exigirAuth, carregarPerfilChamados, exigirPapel('MASTER'), wrap(async (req, res) => {
  const usuarios = await chamadosIntecsRepo.listarUsuariosComPapel();
  res.json(usuarios);
}));

app.put('/api/chamados-intecs/usuarios/:id', exigirAuth, carregarPerfilChamados, exigirPapel('MASTER'), wrap(async (req, res) => {
  const role = trim(req.body.role || 'BASICO');
  const unidade = trim(req.body.unidade || '') || null;
  const setor = trim(req.body.setor || '') || null;
  await chamadosIntecsRepo.atualizarPapelUsuario(req.params.id, { role, unidade, setor });
  res.json({ ok: true });
}));

// ---------- Chamados ----------

app.get('/api/chamados-intecs', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const lista = await chamadosIntecsRepo.listarChamadosIntecs();
  if (['TECNICO', 'MASTER'].includes(req.perfilCI.role)) return res.json(lista);
  const visiveis = [];
  for (const c of lista) {
    if (await podeVerChamado(req.perfilCI, c)) visiveis.push(c);
  }
  res.json(visiveis);
}));

app.post('/api/chamados-intecs', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const titulo = trim(req.body.titulo || '');
  const descricao = trim(req.body.descricao || '');
  const prioridade = trim(req.body.prioridade || 'MEDIA');
  if (!titulo) return res.status(400).json({ error: 'Informe um título para o chamado.' });

  const tacticalAgentId = trim(req.body.tactical_agent_id || '');
  let device = null;
  let snapshotId = null;
  if (tacticalAgentId) {
    try {
      device = await deviceIntecsRepo.getOrCreateDeviceByAgentId(tacticalAgentId);
      snapshotId = await deviceService.takeSnapshot(device.id, tacticalAgentId, null, req.user.sub);
    } catch (err) {
      console.error('[chamados-intecs] falha ao coletar snapshot:', err.message);
    }
  }

  const agora = new Date();
  const { sla_resposta_prazo, sla_conclusao_prazo } = await calcularPrazosSla(prioridade, agora);

  const chamado = await chamadosIntecsRepo.criarChamadoIntecs({
    titulo, descricao,
    categoria_id: req.body.categoria_id ? Number(req.body.categoria_id) : null,
    subcategoria_id: req.body.subcategoria_id ? Number(req.body.subcategoria_id) : null,
    prioridade, usuario_id: req.user.sub, device_id: device?.id ?? null, snapshot_id: snapshotId,
    unidade: trim(req.body.unidade || '') || req.perfilCI.unidade,
    departamento: trim(req.body.departamento || '') || req.perfilCI.setor,
    localizacao: trim(req.body.localizacao || ''), telefone: trim(req.body.telefone || ''),
    ramal: trim(req.body.ramal || ''), email_contato: trim(req.body.email_contato || ''),
    sla_resposta_prazo, sla_conclusao_prazo, criado_por: req.user.email
  });

  await chamadosIntecsRepo.registrarHistorico(chamado.id, req.user.sub, 'CRIADO', null, null, titulo);
  await notificar({
    tipo: 'CHAMADO', acao: 'CRIADO', link: 'tab-chamados', email: false,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Novo chamado INTECS',
    mensagem: `${req.user.email} abriu o chamado "${titulo}".`
  });

  res.status(201).json(chamado);
}));

app.get('/api/chamados-intecs/dashboard', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const { role, unidade, setor } = req.perfilCI;
  if (role === 'BASICO') return res.status(403).json({ error: 'Sem acesso ao dashboard.' });
  if (role === 'GESTOR') {
    const equipes = (unidade && setor) ? [{ unidade, setor }] : [];
    const usuarioIds = await chamadosIntecsRepo.getUsuarioIdsDaEquipe(equipes);
    return res.json(await chamadosIntecsRepo.getDashboard(usuarioIds));
  }
  res.json(await chamadosIntecsRepo.getDashboard());
}));

app.get('/api/chamados-intecs/:id', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const chamado = await chamadosIntecsRepo.getChamadoIntecs(req.params.id);
  if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
  if (!(await podeVerChamado(req.perfilCI, chamado))) return res.status(403).json({ error: 'Sem acesso a este chamado.' });
  const [comentarios, historico] = await Promise.all([
    chamadosIntecsRepo.listarComentarios(chamado.id),
    chamadosIntecsRepo.listarHistorico(chamado.id)
  ]);
  res.json({ ...chamado, comentarios, historico });
}));

app.patch('/api/chamados-intecs/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const chamado = await chamadosIntecsRepo.getChamadoIntecs(req.params.id);
  if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });

  const campos = {};
  const historicoEntradas = [];
  let respondidoAgora = false;

  if (req.body.status !== undefined && req.body.status !== chamado.status) {
    campos.status = trim(req.body.status);
    historicoEntradas.push(['STATUS', 'status', chamado.status, campos.status]);
    const tipoAnterior = await chamadosIntecsRepo.getTipoSistemaDoStatus(chamado.status);
    const tipoNovo = await chamadosIntecsRepo.getTipoSistemaDoStatus(campos.status);
    if (tipoAnterior === 'ABERTO' && !chamado.sla_respondido_em) respondidoAgora = true;
    if (['RESOLVIDO', 'FECHADO'].includes(tipoNovo) && !chamado.fechado_em) {
      campos.fechado_em = new Date();
    }
  }
  if (req.body.prioridade !== undefined && req.body.prioridade !== chamado.prioridade) {
    campos.prioridade = trim(req.body.prioridade);
    historicoEntradas.push(['PRIORIDADE', 'prioridade', chamado.prioridade, campos.prioridade]);
  }
  if (req.body.responsavel_id !== undefined && Number(req.body.responsavel_id) !== chamado.responsavel_id) {
    campos.responsavel_id = Number(req.body.responsavel_id) || null;
    historicoEntradas.push(['RESPONSAVEL', 'responsavel_id', chamado.responsavel_id, campos.responsavel_id]);
  }
  if (req.body.categoria_id !== undefined && Number(req.body.categoria_id) !== chamado.categoria_id) {
    campos.categoria_id = Number(req.body.categoria_id) || null;
    historicoEntradas.push(['CATEGORIA', 'categoria_id', chamado.categoria_id, campos.categoria_id]);
  }
  if (respondidoAgora) campos.sla_respondido_em = new Date();
  campos.atualizado_por = req.user.email;

  if (Object.keys(campos).length) {
    await chamadosIntecsRepo.atualizarCamposChamado(chamado.id, campos);
    for (const [acao, campo, antes, depois] of historicoEntradas) {
      await chamadosIntecsRepo.registrarHistorico(chamado.id, req.user.sub, acao, campo, antes, depois);
    }
    if (historicoEntradas.length) {
      await notificar({
        tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', email: false,
        ator: { id: req.user.sub, email: req.user.email },
        titulo: 'Chamado INTECS atualizado',
        mensagem: `${req.user.email} atualizou o chamado "${chamado.titulo}".`
      });
    }
  }

  const atualizado = await chamadosIntecsRepo.getChamadoIntecs(chamado.id);
  res.json(atualizado);
}));

app.post('/api/chamados-intecs/:id/comentarios', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const chamado = await chamadosIntecsRepo.getChamadoIntecs(req.params.id);
  if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
  const podeComentar = ['TECNICO', 'MASTER'].includes(req.perfilCI.role) || chamado.usuario_id === req.perfilCI.id;
  if (!podeComentar) return res.status(403).json({ error: 'Sem permissão para comentar neste chamado.' });
  const texto = trim(req.body.texto || '');
  if (!texto) return res.status(400).json({ error: 'Escreva um comentário.' });

  const comentario = await chamadosIntecsRepo.criarComentario(chamado.id, req.user.sub, texto);
  await chamadosIntecsRepo.registrarHistorico(chamado.id, req.user.sub, 'COMENTARIO', null, null, texto.slice(0, 200));
  if (!chamado.sla_respondido_em) {
    await chamadosIntecsRepo.atualizarCamposChamado(chamado.id, { sla_respondido_em: new Date() });
  }
  await notificar({
    tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', email: false,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Novo comentário no chamado INTECS',
    mensagem: `${req.user.email} comentou no chamado "${chamado.titulo}".`
  });
  res.status(201).json(comentario);
}));

app.get('/api/chamados-intecs/:id/equipamento', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const chamado = await chamadosIntecsRepo.getChamadoIntecs(req.params.id);
  if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
  if (!(await podeVerChamado(req.perfilCI, chamado))) return res.status(403).json({ error: 'Sem acesso a este chamado.' });
  if (!chamado.device_id) return res.json(null);
  const resumo = await deviceService.getDeviceSummary(chamado.device_id);
  res.json(resumo);
}));

app.post('/api/chamados-intecs/:id/equipamento/atualizar', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const chamado = await chamadosIntecsRepo.getChamadoIntecs(req.params.id);
  if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
  if (!chamado.device_id) return res.status(400).json({ error: 'Chamado sem equipamento vinculado.' });

  const device = await deviceIntecsRepo.getDeviceById(chamado.device_id);
  const tacticalAgentId = device?.tactical_agent_id;
  if (!tacticalAgentId) return res.status(400).json({ error: 'Equipamento sem agente Tactical RMM vinculado.' });

  await deviceService.takeSnapshot(chamado.device_id, tacticalAgentId, chamado.id, req.user.sub);
  const resumo = await deviceService.getDeviceSummary(chamado.device_id);
  res.json(resumo);
}));

// ===================== ESTÁTICO (front-end vanilla) =====================
// Usado no desenvolvimento local; na Vercel os estáticos são servidos pela CDN
// (ver vercel.json para o roteamento de /chamados em produção).
app.get('/chamados', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chamados.html')));
app.use(express.static(PUBLIC_DIR));

export default app;

// Sobe o servidor apenas localmente (na Vercel o app é importado como função).
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`API + app em http://localhost:${PORT}`);
  });
}
