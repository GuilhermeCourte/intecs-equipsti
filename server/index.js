// ============================================================
//  API + servidor estático — Revalidação de Inventário
// ============================================================
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query, sql } from './db.js';
import { gerarToken, exigirAuth } from './auth.js';
import { opcoesRegistro, verificarRegistro, opcoesAutenticacao, verificarAutenticacao } from './webauthn.js';
import { notificar, notificarTeste, notificarSolicitante, notificarEmailLote, emailValido } from './notificacoes.js';
import { chavePublica, salvarSubscription, removerSubscription } from './push.js';
import { inscrever } from './realtime.js';
import { registrarLog, listarLogs, MODULOS_LOG, NIVEIS_SEGURANCA } from './logs.js';
import { emailParaEquipe, rotular } from './emailChamado.js';
import * as deviceService from './tacticalrmm/deviceService.js';
import * as deviceIntecsRepo from './tacticalrmm/deviceRepository.js';
import * as uptimeRobot from './uptimerobot/service.js';
import * as hostinger from './hostinger/service.js';
import * as googleDrive from './googleworkspace/service.js';
import * as chamadosIntecsRepo from './chamadosIntecsRepository.js';
import * as emailsRepo from './emailsRepository.js';
import { parsePainelLocaweb } from './locaweb/parser.js';
import { calcularPrazosSla } from './chamadosIntecsSla.js';
import { carregarPerfilChamados, exigirPapel, exigirPermissao, podeVerChamado } from './chamadosIntecsAuth.js';
import {
  CHAVES_PERMISSOES, PADROES_POR_PAPEL, ROTULOS,
  permissoesEfetivas, calcularOverrides, validarPermissoes, isCustomizado, papelValido
} from './permissoes.js';
import { chaveConfigurada, cifrar, decifrar } from './cripto.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
// Atrás do proxy reverso (nginx na VPS): sem isto req.ip e req.protocol
// refletem o proxy, não o cliente.
app.set('trust proxy', 1);
app.use(cors());
app.use(compression()); // JSON de inventário comprime ~85-90% — decisivo em rede lenta
// 15mb: um registro vai com as 3 fotos no mesmo corpo — o default de 100kb
// não cabe. Folga generosa (fotos comprimidas ficam bem abaixo disso), só
// pra travar request corrompido/anormal. Mantido em sincronia com o
// client_max_body_size do nginx (nginx/gestaoti.conf).
app.use(express.json({ limit: '15mb' }));

const OPTION_LISTS = ['UNIDADE', 'STATUS', 'SETOR', 'EQUIPAMENTO', 'INSUMOS'];
const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });
const trim = (v) => String(v == null ? '' : v).trim();

// Encapsula handlers async e encaminha erros.
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erro interno.' });
});

// Compara valor antigo x novo para o log de auditoria. numeric=true compara por
// número (ignora formatação "1500.00" vs "1500"); senão compara texto, tratando
// null e '' como iguais (evita "diferença" fantasma de campo vazio).
const logMudou = (de, para, numeric = false) => {
  if (numeric) {
    const a = de == null || de === '' ? null : parseFloat(String(de).replace(',', '.'));
    const b = para == null || para === '' ? null : parseFloat(String(para).replace(',', '.'));
    return a !== b;
  }
  return String(de ?? '') !== String(para ?? '');
};

// ===================== HEALTH =====================
// Usado pelo healthcheck do container. Sem auth, então não devolve a mensagem
// crua do driver (vazaria host/usuário do banco) — o detalhe vai para o log.
// 503 quando o banco não responde: toda tela do sistema depende dele.
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1 AS ok');
    res.json({ ok: true, db: 'ok' });
  } catch (err) {
    console.error('Healthcheck: banco inacessível —', err.message);
    res.status(503).json({ ok: false, db: 'erro' });
  }
});

// ===================== AUTH =====================
// Freio de força bruta nas rotas que emitem token. Sem ele dá para tentar senha
// em volume sem nada segurar: o bcrypt.compare é lento de propósito, mas isso
// só atrasa o atacante — e ainda vira um jeito barato de queimar CPU do
// servidor. Contagem em memória, que basta porque a instância é única (ver
// docker-compose.yml). skipSuccessfulRequests: quem acerta não gasta cota.
//
// São DUAS camadas de propósito. O escritório inteiro sai por um IP público só,
// então uma cota só por IP faria uma pessoa errando a senha trancar todos os
// colegas junto. A de baixo é por conta; a de cima, por IP, e larga o bastante
// para nenhum uso normal encostar nela.
//
// req.ip chega correto porque o nginx manda X-Forwarded-For e o app tem
// trust proxy = 1 (ver acima).

// Descreve de onde veio a tentativa, cruzando o IP com o cache do Tactical RMM.
// O IP que chega é o PÚBLICO — atrás do NAT ele identifica o LOCAL, não a
// máquina (o IP da MBO cobre 7 delas). Por isso o rótulo para na unidade, sem
// fingir apontar um computador.
//
// "origem externa" é o caso mais interessante de todos: tentativa vinda de um
// IP que não bate com nenhuma unidade. Diz origem, e não "usuário externo",
// porque o IP não identifica pessoa — pode ser um técnico de casa ou do 4G.
async function descreverOrigemIp(ip) {
  try {
    const agentes = await deviceIntecsRepo.buscarAgentesPorIp(ip);
    if (!agentes.length) return `IP ${ip} · origem externa`;
    const locais = [...new Set(agentes.map((a) =>
      [a.client_name, a.site_name].filter(Boolean).join(' / ')).filter(Boolean))];
    // Sem rótulo é só higiene de string: no Tactical RMM todo agente pertence
    // obrigatoriamente a um cliente e a um site, então na prática não acontece.
    return locais.length ? `IP ${ip} · ${locais.join(', ')}` : `IP ${ip}`;
  } catch {
    return `IP ${ip}`;
  }
}

// Grava o bloqueio na aba Logs. Só o BLOQUEIO, não cada senha errada: como são
// necessárias 10 falhas do mesmo valor para chegar aqui, um engano isolado
// (senha digitada no campo de e-mail) nunca vira linha — o que torna seguro
// guardar exatamente o que foi digitado, que é o dado útil num ataque.
async function registrarBloqueioLogin(req, cota) {
  try {
    // Só a PRIMEIRA requisição bloqueada vira linha. O handler roda em todas as
    // seguintes, e sem isto alguém insistindo mil vezes geraria mil linhas
    // idênticas — afogando o resto da auditoria. (O onLimitReached, que fazia
    // exatamente isso, está deprecado na v8 da lib.)
    const rl = req.rateLimit;
    if (rl && rl.used !== rl.limit + 1) return;
    await registrarLog({
      modulo: 'ACESSO',
      acao: 'LOGIN_BLOQUEADO',
      entidadeId: req.ip,
      entidadeRotulo: await descreverOrigemIp(req.ip),
      campo: cota,
      usuario: trim(req.body?.email) || 'desconhecido'
    });
  } catch (e) {
    console.warn('[acesso] falha ao registrar bloqueio:', e.message);
  }
}

// Por (IP + conta tentada): segura quem fica testando senha de UMA pessoa, sem
// afetar quem está do lado. O ipKeyGenerator normaliza IPv6 — concatenar req.ip
// cru trataria cada endereço da mesma faixa /64 como um cliente diferente.
const limiteConta = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) =>
    ipKeyGenerator(req.ip) + '|' + String(req.body?.email || '').trim().toLowerCase(),
  message: { error: 'Muitas tentativas seguidas para este usuário. Aguarde alguns minutos.' },
  handler: async (req, res, next, options) => {
    await registrarBloqueioLogin(req, 'Cota por usuário');
    res.status(options.statusCode).json(options.message);
  }
});

// Por IP: pega quem espalha a mesma senha por várias contas, o que escapa da
// cota por conta. Teto alto porque é compartilhado pelo escritório — ninguém
// erra a senha 100 vezes em 15 minutos sem ser máquina.
const limitePorIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.' },
  handler: async (req, res, next, options) => {
    await registrarBloqueioLogin(req, 'Cota por IP');
    res.status(options.statusCode).json(options.message);
  }
});

app.post('/api/auth/login', limitePorIp, limiteConta, wrap(async (req, res) => {
  const email = trim(req.body.email).toLowerCase();
  const senha = String(req.body.senha || '');
  if (!email || !senha) return res.status(400).json({ error: 'Informe e-mail e senha.' });

  // Aceita e-mail completo ou só a parte antes do @ (facilidade de digitação).
  const r = email.includes('@')
    ? await query('SELECT id, email, senha_hash, ativo FROM dbo.EQUIPSTI_usuarios WHERE email = @email', { email: S(email) })
    : await query(
        `SELECT id, email, senha_hash, ativo FROM dbo.EQUIPSTI_usuarios
          WHERE CHARINDEX('@', email) > 1 AND LOWER(LEFT(email, CHARINDEX('@', email) - 1)) = @usuario`,
        { usuario: S(email) });
  // Confere a senha contra TODOS os homônimos antes de decidir qualquer coisa.
  // Antes, "informe o e-mail completo" saía só por existirem dois usuários com
  // aquele nome — o que confirmava a existência das contas para quem só
  // chutasse o nome, sem senha. Agora essa mensagem exige que a pessoa já tenha
  // acertado uma senha válida; para todo o resto a resposta é sempre a mesma.
  //
  // De quebra resolve o caso real: dois homônimos com senhas diferentes agora
  // entram digitando só o nome, sem precisar do e-mail inteiro.
  //
  // O teto de 5 existe porque cada comparação é um bcrypt (lento de propósito):
  // sem ele, um nome que casasse com muitos usuários viraria carga de CPU.
  const candidatos = r.recordset.slice(0, 5);
  const validos = [];
  for (const c of candidatos) {
    if (await bcrypt.compare(senha, c.senha_hash)) validos.push(c);
  }
  if (!validos.length) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  if (validos.length > 1) {
    return res.status(401).json({ error: 'Mais de um usuário com esse nome. Informe o e-mail completo.' });
  }
  const u = validos[0];
  if (!u.ativo) return res.status(403).json({ error: 'Usuário inativo. Contate o administrador.' });
  res.json({ token: gerarToken(u), email: u.email });
}));

app.get('/api/auth/me', exigirAuth, (req, res) => {
  res.json({ id: req.user.sub, email: req.user.email });
});

// ===================== NOTIFICAÇÕES (sininho) =====================
// Lista as notificações dos últimos 3 dias do usuário logado (máx. 30) + total
// não lido no mesmo período, para o badge bater com o que aparece na lista.
app.get('/api/notifications', exigirAuth, wrap(async (req, res) => {
  const uid = Number(req.user.sub);
  const itens = await query(
    `SELECT TOP 30 id, tipo, acao, titulo, mensagem, link, ref_id AS refId, ator_email AS ator,
            lido, CONVERT(varchar(19), criado_em, 120) AS criadoEm
       FROM dbo.EQUIPSTI_notificacoes
      WHERE usuario_id = @uid
        AND criado_em >= DATEADD(day, -3, SYSUTCDATETIME())
      ORDER BY criado_em DESC, id DESC`, { uid });
  const nao = await query(
    `SELECT COUNT(*) AS n FROM dbo.EQUIPSTI_notificacoes
      WHERE usuario_id = @uid AND lido = 0
        AND criado_em >= DATEADD(day, -3, SYSUTCDATETIME())`, { uid });
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

// Chave pública VAPID, para o cliente chamar PushManager.subscribe(). Não é
// segredo (é o que qualquer serviço de push já expõe a quem envia), fica
// atrás de exigirAuth porque a inscrição só acontece pós-login.
app.get('/api/push/public-key', exigirAuth, wrap(async (req, res) => {
  res.json({ publicKey: chavePublica() });
}));

app.post('/api/push/subscribe', exigirAuth, wrap(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Inscrição inválida.' });
  await salvarSubscription(Number(req.user.sub), { endpoint, keys });
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', exigirAuth, wrap(async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint obrigatório.' });
  await removerSubscription(Number(req.user.sub), endpoint);
  res.json({ ok: true });
}));

// Canal de tempo real (SSE). Manda só um sinal — quem recarrega é o cliente,
// chamando GET /api/notifications (sininho) ou a lista do portal. Ver
// server/realtime.js para o porquê de trafegar sinal e não dado.
//
// Três detalhes que parecem opcionais e não são:
//
// 1) NÃO usa wrap(): ele responde 500 em JSON no catch, e aqui os cabeçalhos
//    já saíram — o res.status() estouraria ERR_HTTP_HEADERS_SENT dentro do
//    próprio catch, virando unhandledRejection (que no Node 22 mata o
//    processo). Handler síncrono, sem async: verificar token, setar
//    cabeçalhos e inscrever não esperam nada.
// 2) 'no-transform' desliga o compression() global. text/event-stream casa
//    com o filtro padrão do pacote e o sinal ficaria represado no buffer do
//    gzip, saindo só depois de dezenas de eventos acumulados.
// 3) 'X-Accel-Buffering: no' desliga o buffer do nginx apenas nesta resposta,
//    sem depender de editar o gestaoti.conf — que o deploy não toca, por
//    rodar no host e não no container.
app.get('/api/notifications/stream', exigirAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': conectado\n\n');

  const desinscrever = inscrever(req.user.sub, res);

  // O JWT vence (JWT_EXPIRES_HOURS, 12h por padrão) mas o socket não morre
  // junto: sem isto uma sessão vencida seguiria recebendo sinal por dias.
  // Ao fechar, o cliente reconecta, leva 401 e cai no logout que já existe.
  const restaMs = (Number(req.user.exp) || 0) * 1000 - Date.now();
  const expirar = setTimeout(() => res.end(),
    Math.max(1000, Math.min(restaMs, 2 ** 31 - 1)));

  req.on('close', () => { clearTimeout(expirar); desinscrever(); });
});

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
  await registrarLog({
    modulo: 'USUARIOS', entidadeId: String(req.user.sub), entidadeRotulo: req.user.email,
    acao: 'BIOMETRIA_CADASTRADA', valorNovo: rotulo,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json({ ok: true });
}));

// Inicia o login biométrico: gera challenge. O cliente informa a credencial
// deste aparelho (credId) para apontá-la diretamente, sem o seletor do Google.
app.post('/api/biometric/auth/options', limitePorIp, wrap(async (req, res) => {
  const credId = trim(req.body?.credId);
  const allow = credId ? [{ id: credId }] : [];
  const { flowId, options } = await opcoesAutenticacao(allow);
  res.json({ flowId, options });
}));

// Conclui o login biométrico: valida e emite o JWT (mesmo do login normal).
app.post('/api/biometric/auth/verify', limitePorIp, wrap(async (req, res) => {
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
app.get('/api/users', exigirAuth, exigirPermissao('aba_usuarios'), wrap(async (req, res) => {
  const r = await query('SELECT id, email, criado_em, ativo FROM dbo.EQUIPSTI_usuarios ORDER BY email');
  res.json(r.recordset);
}));

app.post('/api/users', exigirAuth, exigirPermissao('aba_usuarios'), wrap(async (req, res) => {
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
  const novoId = inserted.recordset[0].id;
  await registrarLog({
    modulo: 'USUARIOS', entidadeId: String(novoId), entidadeRotulo: email,
    acao: 'CRIADO', valorNovo: email, usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json({ ok: true, id: novoId });
}));

app.put('/api/users/:id', exigirAuth, exigirPermissao('aba_usuarios'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const novoEmail = req.body.email !== undefined ? trim(req.body.email).toLowerCase() : null;
  const novaSenha = req.body.senha !== undefined ? String(req.body.senha) : null;

  const antesU = (await query('SELECT email, ativo FROM dbo.EQUIPSTI_usuarios WHERE id = @id', { id })).recordset[0] || {};
  const rotuloU = antesU.email || `Usuário #${id}`;   // e-mail ANTERIOR identifica mesmo com troca

  if (novoEmail) {
    const dup = await query('SELECT id FROM dbo.EQUIPSTI_usuarios WHERE email = @email AND id <> @id',
      { email: S(novoEmail), id });
    if (dup.recordset.length) return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    await query('UPDATE dbo.EQUIPSTI_usuarios SET email = @email WHERE id = @id', { email: S(novoEmail), id });
    if (logMudou(antesU.email, novoEmail)) {
      await registrarLog({
        modulo: 'USUARIOS', entidadeId: String(id), entidadeRotulo: rotuloU,
        acao: 'ATUALIZADO', campo: 'E-MAIL', valorAnterior: antesU.email, valorNovo: novoEmail,
        usuario: req.user.email, usuarioId: req.user.sub
      });
    }
  }
  if (novaSenha) {
    if (novaSenha.length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await query('UPDATE dbo.EQUIPSTI_usuarios SET senha_hash = @hash WHERE id = @id', { hash: S(hash), id });
    // Reset de senha: registra o EVENTO, nunca o valor (hash ou texto).
    await registrarLog({
      modulo: 'USUARIOS', entidadeId: String(id), entidadeRotulo: rotuloU,
      acao: 'SENHA_REDEFINIDA', usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  if (req.body.ativo !== undefined) {
    const ativo = req.body.ativo ? 1 : 0;
    if (id === Number(req.user.sub) && !ativo) {
      return res.status(400).json({ error: 'Você não pode inativar o próprio usuário.' });
    }
    await query('UPDATE dbo.EQUIPSTI_usuarios SET ativo = @ativo WHERE id = @id', { ativo, id });
    const ativoAntes = antesU.ativo ? 1 : 0;
    if (ativoAntes !== ativo) {
      await registrarLog({
        modulo: 'USUARIOS', entidadeId: String(id), entidadeRotulo: rotuloU,
        acao: 'ATUALIZADO', campo: 'ATIVO',
        valorAnterior: ativoAntes ? 'SIM' : 'NÃO', valorNovo: ativo ? 'SIM' : 'NÃO',
        usuario: req.user.email, usuarioId: req.user.sub
      });
    }
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

app.put('/api/options/quantidade', exigirAuth, exigirPermissao('aba_gerenciar'), wrap(async (req, res) => {
  const valor = trim(req.body.valor);
  const qtd = parseInt(req.body.quantidade, 10);
  if (isNaN(qtd) || qtd < 0) return res.status(400).json({ error: 'Quantidade inválida.' });
  const antesQ = await query('SELECT quantidade FROM dbo.EQUIPSTI_opcoes WHERE lista = @lista AND valor = @valor',
    { lista: S('INSUMOS'), valor: S(valor) });
  await query('UPDATE dbo.EQUIPSTI_opcoes SET quantidade = @qtd WHERE lista = @lista AND valor = @valor',
    { qtd: { type: sql.Int, value: qtd }, lista: S('INSUMOS'), valor: S(valor) });
  const qAntes = antesQ.recordset[0]?.quantidade;
  if (logMudou(qAntes, qtd, true)) {
    await registrarLog({
      modulo: 'OPCOES', entidadeRotulo: `INSUMOS · ${valor}`,
      acao: 'ATUALIZADO', campo: 'QUANTIDADE',
      valorAnterior: qAntes == null ? null : String(qAntes), valorNovo: String(qtd),
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  res.json({ ok: true });
}));

app.post('/api/options', exigirAuth, exigirPermissao('aba_gerenciar'), wrap(async (req, res) => {
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
  await registrarLog({
    modulo: 'OPCOES', entidadeRotulo: `${lista} · ${valor}`,
    acao: 'CRIADO', valorNovo: detalhe ? `${valor} · ${detalhe}` : valor,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json({ ok: true });
}));

// Renomeia uma opção (atualiza também os registros que a usavam).
app.put('/api/options/rename', exigirAuth, exigirPermissao('aba_gerenciar'), wrap(async (req, res) => {
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
  await registrarLog({
    modulo: 'OPCOES', entidadeRotulo: `${lista} · ${novoValor}`,
    acao: 'RENOMEADO', campo: 'VALOR', valorAnterior: valor, valorNovo: novoValor,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ ok: true });
}));

// Atualiza o detalhe e o preço de uma opção de equipamento.
app.put('/api/options/detalhe', exigirAuth, exigirPermissao('aba_gerenciar'), wrap(async (req, res) => {
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
  const antesD = await query('SELECT detalhe, CAST(preco AS NVARCHAR) AS preco, tipo_aquisicao, cnpj, endereco FROM dbo.EQUIPSTI_opcoes WHERE lista = @lista AND valor = @valor',
    { lista: S(lista), valor: S(valor) });
  await query('UPDATE dbo.EQUIPSTI_opcoes SET detalhe = @detalhe, preco = @preco, tipo_aquisicao = @tipoAquisicao, cnpj = @cnpj, endereco = @endereco WHERE lista = @lista AND valor = @valor',
    { detalhe: { type: sql.NVarChar, value: detalhe },
      preco: preco != null ? { type: sql.Decimal(15,2), value: preco } : S(null),
      tipoAquisicao: S(tipoAquisicao),
      cnpj: S(cnpj),
      endereco: S(endereco),
      lista: S(lista), valor: S(valor) });
  const oa = antesD.recordset[0] || {};
  const paresOpc = [
    ['DETALHE', oa.detalhe, detalhe, false],
    ['PREÇO', oa.preco, preco == null ? null : String(preco), true],
    ['TIPO AQUISIÇÃO', oa.tipo_aquisicao, tipoAquisicao, false],
    ['CNPJ', oa.cnpj, cnpj, false],
    ['ENDEREÇO', oa.endereco, endereco, false]
  ];
  for (const [campo, de, para, num] of paresOpc) {
    if (logMudou(de, para, num)) {
      await registrarLog({
        modulo: 'OPCOES', entidadeRotulo: `${lista} · ${valor}`,
        acao: 'ATUALIZADO', campo, valorAnterior: de, valorNovo: para,
        usuario: req.user.email, usuarioId: req.user.sub
      });
    }
  }
  res.json({ ok: true });
}));

// Oculta / exibe uma opção.
app.put('/api/options/hidden', exigirAuth, exigirPermissao('aba_gerenciar'), wrap(async (req, res) => {
  const lista = trim(req.body.lista).toUpperCase();
  const valor = trim(req.body.valor);
  const oculto = req.body.oculto ? 1 : 0;
  const antesH = await query('SELECT oculto FROM dbo.EQUIPSTI_opcoes WHERE lista = @lista AND valor = @valor',
    { lista: S(lista), valor: S(valor) });
  await query('UPDATE dbo.EQUIPSTI_opcoes SET oculto = @oculto WHERE lista = @lista AND valor = @valor',
    { oculto, lista: S(lista), valor: S(valor) });
  const ocAntes = antesH.recordset[0]?.oculto ? 1 : 0;
  if (ocAntes !== oculto) {
    await registrarLog({
      modulo: 'OPCOES', entidadeRotulo: `${lista} · ${valor}`,
      acao: 'ATUALIZADO', campo: 'OCULTO',
      valorAnterior: ocAntes ? 'SIM' : 'NÃO', valorNovo: oculto ? 'SIM' : 'NÃO',
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
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
  if (faltando.length) throw new Error('Preencha: ' + faltando.join(', ') + '.');
}

app.get('/api/records', exigirAuth, exigirPermissao('aba_registros'), wrap(async (req, res) => {
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

// Facetas: valores únicos por coluna para os filtros de cabeçalho — poucos KB
// no lugar do dump completo. Valores CRUS (sem trim/normalização): o cliente
// formata com a mesma regra das linhas, senão a contagem de "todos
// selecionados" divergiria. Sem WHERE de filtros ativos de propósito: hoje as
// opções derivam da tabela inteira e o comportamento deve ser preservado.
const FACET_COLS = {
  unidade: 'unidade', status: 'status', setor: 'setor', usuario: 'usuario',
  ns: 'ns', pat: 'pat', equipamento: 'equipamento', protocolo: 'protocolo',
  dataRecebimento: 'CONVERT(varchar(10), data_recebimento, 23)',
  temFoto: 'CASE WHEN imagem_base64 IS NOT NULL THEN 1 ELSE 0 END',
  obs: 'obs',
};
const FACET_PADRAO = Object.keys(FACET_COLS).filter((k) => k !== 'obs'); // obs: quase única por linha, só sob demanda

app.get('/api/records/facets', exigirAuth, exigirPermissao('aba_registros'), wrap(async (req, res) => {
  const pedidos = req.query.campo
    ? String(req.query.campo).split(',').filter((c) => FACET_COLS[c]) // whitelist
    : FACET_PADRAO;
  const out = {};
  await Promise.all(pedidos.map(async (campo) => {
    const r = await query(`SELECT DISTINCT ${FACET_COLS[campo]} AS v FROM dbo.EQUIPSTI_registros`, {});
    out[campo] = r.recordset.map((row) => row.v);
  }));
  res.json(out);
}));

app.get('/api/records/:id/imagem', exigirAuth, exigirPermissao('aba_registros'), wrap(async (req, res) => {
  const r = await query(`SELECT imagem_base64, imagem2_base64, imagem3_base64 FROM dbo.EQUIPSTI_registros WHERE id = @id`,
    { id: Number(req.params.id) });
  if (!r.recordset.length) return res.status(404).json({ error: 'Não encontrado.' });
  const row = r.recordset[0];
  res.json({ imagem_base64: row.imagem_base64 || null, imagem2_base64: row.imagem2_base64 || null, imagem3_base64: row.imagem3_base64 || null });
}));

app.get('/api/records/:id/log', exigirAuth, exigirPermissao('aba_registros'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT acao, campo, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
    justificativa, usuario, CONVERT(varchar(19), data_hora, 120) AS dataHora
    FROM dbo.EQUIPSTI_logs WHERE modulo = 'REGISTROS' AND entidade_id = @id ORDER BY id DESC`,
    { id: S(String(id)) });
  res.json(r.recordset);
}));

app.post('/api/records', exigirAuth, exigirPermissao('aba_registros'), wrap(async (req, res) => {
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
  await registrarLog({
    modulo: 'REGISTROS', entidadeId: String(novoId),
    entidadeRotulo: `PAT ${d.pat || '—'} · ${d.equipamento || '—'}`,
    acao: 'CRIADO', usuario, usuarioId: req.user.sub
  });
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

app.put('/api/records/:id', exigirAuth, exigirPermissao('aba_registros'), wrap(async (req, res) => {
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

  const rotuloReg = `PAT ${d.pat || '—'} · ${d.equipamento || '—'}`;
  const camposAlterados = [];
  for (const [key, label] of CAMPOS_LOG) {
    const vAntes = String(old[key] ?? '');
    const vDepois = String(key === 'valor' ? (d.valor ?? '') : (d[key] ?? ''));
    const igual = key === 'valor'
      ? parseFloat(vAntes || 'NaN') === parseFloat(vDepois || 'NaN')
      : vAntes === vDepois;
    if (!igual) {
      camposAlterados.push(label);
      await registrarLog({
        modulo: 'REGISTROS', entidadeId: String(id), entidadeRotulo: rotuloReg,
        acao: 'ATUALIZADO', campo: label, valorAnterior: vAntes, valorNovo: vDepois,
        justificativa, usuario, usuarioId: req.user.sub
      });
    }
  }

  const fotoCols = [['imagem_base64','FOTO 1'],['imagem2_base64','FOTO 2'],['imagem3_base64','FOTO 3']];
  for (const [col, label] of fotoCols) {
    const antes = old[col] ? 'SIM' : 'NÃO';
    const depois = d[col] ? 'SIM' : 'NÃO';
    if ((old[col] || '') !== (d[col] || '')) {
      const nomeLog = antes === depois ? label + ' (substituída)' : label;
      camposAlterados.push(nomeLog);
      await registrarLog({
        modulo: 'REGISTROS', entidadeId: String(id), entidadeRotulo: rotuloReg,
        acao: 'ATUALIZADO', campo: nomeLog, valorAnterior: antes, valorNovo: depois,
        justificativa, usuario, usuarioId: req.user.sub
      });
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

app.delete('/api/records/:id', exigirAuth, exigirPermissao('aba_registros'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const prev = await query('SELECT pat, ns, equipamento FROM dbo.EQUIPSTI_registros WHERE id = @id', { id });
  await query('DELETE FROM dbo.EQUIPSTI_registros WHERE id = @id', { id });
  const r = prev.recordset[0];
  if (r) {
    await registrarLog({
      modulo: 'REGISTROS', entidadeId: String(id),
      entidadeRotulo: `PAT ${r.pat || '—'} · ${r.equipamento || '—'}`,
      acao: 'EXCLUIDO',
      valorAnterior: `${r.equipamento || '—'} · PAT ${r.pat || '—'} · N/S ${r.ns || '—'}`,
      usuario: req.user.email, usuarioId: req.user.sub
    });
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

// Campos auditados da Internet (chave do shape → rótulo; 3º = comparar como número).
const CAMPOS_LOG_INTERNET = [
  ['unidade', 'UNIDADE'], ['empresa', 'EMPRESA'], ['contratoCnpj', 'CONTRATO/CNPJ'],
  ['ipInternet', 'IP INTERNET'], ['upDown', 'UP/DOWN'], ['valor', 'VALOR', true],
  ['vencimentoDia', 'VENCIMENTO (DIA)'], ['telefoneSuporte', 'TELEFONE SUPORTE'],
  ['linhaAcesso', 'LINHA DE ACESSO'], ['linkAcesso', 'LINK DE ACESSO'],
  ['emailContas', 'E-MAIL CONTAS'], ['observacao', 'OBSERVAÇÃO']
];
const rotuloInternet = (d) => `${d.unidade || '—'} · ${d.empresa || '—'}`;

app.get('/api/internet', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  const r = await query(`${INTERNET_SELECT} ORDER BY unidade, id DESC`);
  res.json(r.recordset);
}));

app.post('/api/internet', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  const d = lerInternet(req.body);
  if (!d.unidade) return res.status(400).json({ error: 'Selecione a unidade.' });
  const insI = await query(`INSERT INTO dbo.EQUIPSTI_internet
    (unidade, empresa, contrato_cnpj, ip_internet, up_down, valor, vencimento_dia, telefone_suporte, linha_acesso, link_acesso, email_contas, observacao, criado_por, atualizado_por)
    OUTPUT INSERTED.id
    VALUES (@unidade, @empresa, @contratoCnpj, @ipInternet, @upDown, @valor, @vencimentoDia, @telefoneSuporte, @linhaAcesso, @linkAcesso, @emailContas, @observacao, @criadoPor, @criadoPor)`,
    { ...paramsInternet(d), criadoPor: S(req.user.email) });
  await registrarLog({
    modulo: 'INTERNET', entidadeId: String(insI.recordset[0].id), entidadeRotulo: rotuloInternet(d),
    acao: 'CRIADO', valorNovo: `${d.empresa || '—'} · ${d.ipInternet || '—'}`,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json({ ok: true });
}));

app.put('/api/internet/:id', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerInternet(req.body);
  if (!d.unidade) return res.status(400).json({ error: 'Selecione a unidade.' });
  const antesRow = (await query(`${INTERNET_SELECT} WHERE id = @id`, { id })).recordset[0] || {};
  await query(`UPDATE dbo.EQUIPSTI_internet SET
    unidade=@unidade, empresa=@empresa, contrato_cnpj=@contratoCnpj, ip_internet=@ipInternet, up_down=@upDown,
    valor=@valor, vencimento_dia=@vencimentoDia, telefone_suporte=@telefoneSuporte, linha_acesso=@linhaAcesso,
    link_acesso=@linkAcesso, email_contas=@emailContas, observacao=@observacao,
    atualizado_por=@atualizadoPor, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`,
    { ...paramsInternet(d), id, atualizadoPor: S(req.user.email) });
  for (const [key, label, num] of CAMPOS_LOG_INTERNET) {
    if (logMudou(antesRow[key], d[key], num)) {
      await registrarLog({
        modulo: 'INTERNET', entidadeId: String(id), entidadeRotulo: rotuloInternet(d),
        acao: 'ATUALIZADO', campo: label,
        valorAnterior: antesRow[key] == null ? null : String(antesRow[key]),
        valorNovo: d[key] == null ? null : String(d[key]),
        usuario: req.user.email, usuarioId: req.user.sub
      });
    }
  }
  res.json({ ok: true });
}));

app.delete('/api/internet/:id', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const prev = (await query(`${INTERNET_SELECT} WHERE id = @id`, { id })).recordset[0];
  await query('DELETE FROM dbo.EQUIPSTI_internet WHERE id = @id', { id });
  if (prev) {
    await registrarLog({
      modulo: 'INTERNET', entidadeId: String(id), entidadeRotulo: rotuloInternet(prev),
      acao: 'EXCLUIDO',
      valorAnterior: `${prev.unidade || '—'} · ${prev.empresa || '—'} · ${prev.ipInternet || '—'}`,
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  res.json({ ok: true });
}));

// ===================== SENHAS (controle de portas) =====================
// Gerencia quem tem acesso físico às portas 814/815 e 811 (controladoras
// Intelbras Digiprox SA 203 MF). A senha de 4 dígitos precisa poder ser lida
// de volta (o técnico a digita no teclado da porta) — por isso é cifrada
// (AES-256-GCM, server/cripto.js), não um hash. Nunca entra em texto claro
// no retorno da listagem nem em nenhum campo de log; só o GET /revelar a
// devolve, e essa é a única ação que grava 'SENHA_REVELADA'.
const PORTAS_SENHAS = ['814_815', '811'];
const ROTULO_PORTA_SENHA = { '814_815': '814/815', '811': '811' };

function lerSenha(body) {
  const acessosBody = body.acessos && typeof body.acessos === 'object' ? body.acessos : {};
  const acessos = {};
  for (const porta of PORTAS_SENHAS) {
    const a = acessosBody[porta] || {};
    const habilitado = !!a.habilitado;
    acessos[porta] = {
      habilitado,
      login: habilitado ? (trim(a.login) || null) : null,
      ativo: habilitado ? a.ativo !== false : false
    };
  }
  return { nome: trim(body.nome), senha: trim(body.senha), acessos };
}

function validarSenha(d) {
  if (!d.nome) return 'Informe o nome.';
  if (!/^\d{4}$/.test(d.senha)) return 'A senha deve ter 4 dígitos.';
  const habilitadas = PORTAS_SENHAS.filter((p) => d.acessos[p].habilitado);
  if (!habilitadas.length) return 'Selecione ao menos uma porta.';
  for (const p of habilitadas) {
    if (!/^\d{4}$/.test(d.acessos[p].login || '')) {
      return `Login da porta ${ROTULO_PORTA_SENHA[p]} deve ter 4 dígitos.`;
    }
  }
  return null;
}

const rotuloSenha = (d) => d.nome || '—';

// Login já usado por OUTRO cadastro na mesma porta? (excluirId = ignora a própria
// linha, usado no PUT). Não há transação no projeto (grep confirma: só query()) —
// isto é um pré-check; o UNIQUE (porta, login) é o backstop contra corrida real.
async function checarLoginEmUso(acessos, excluirId = null) {
  for (const porta of PORTAS_SENHAS) {
    const a = acessos[porta];
    if (!a.habilitado) continue;
    const params = { porta: S(porta), login: S(a.login) };
    let condicaoId = '';
    if (excluirId != null) {
      params.excluirId = { type: sql.Int, value: excluirId };
      condicaoId = 'AND senha_id <> @excluirId';
    }
    const r = await query(
      `SELECT TOP 1 senha_id FROM dbo.EQUIPSTI_senhas_portas_acesso WHERE porta=@porta AND login=@login ${condicaoId}`,
      params
    );
    if (r.recordset.length) return `O login ${a.login} já está em uso na porta ${ROTULO_PORTA_SENHA[porta]}.`;
  }
  return null;
}

function agruparAcessos(linhas) {
  const mapa = new Map();
  for (const l of linhas) {
    if (!mapa.has(l.senhaId)) mapa.set(l.senhaId, {});
    mapa.get(l.senhaId)[l.porta] = { habilitado: true, login: l.login, ativo: !!l.ativo };
  }
  return mapa;
}

app.get('/api/senhas', exigirAuth, exigirPermissao('aba_senhas'), wrap(async (req, res) => {
  const senhas = (await query(
    `SELECT id, nome, criado_por AS criadoPor, atualizado_por AS atualizadoPor,
      CONVERT(varchar(19), criado_em, 120) AS criadoEm,
      CONVERT(varchar(19), atualizado_em, 120) AS atualizadoEm
      FROM dbo.EQUIPSTI_senhas_portas ORDER BY nome`
  )).recordset;
  const acessosLinhas = (await query(
    'SELECT senha_id AS senhaId, porta, login, ativo FROM dbo.EQUIPSTI_senhas_portas_acesso'
  )).recordset;
  const acessosPorSenha = agruparAcessos(acessosLinhas);
  res.json(senhas.map((s) => ({ ...s, acessos: acessosPorSenha.get(s.id) || {} })));
}));

app.get('/api/senhas/proximo-login', exigirAuth, exigirPermissao('aba_senhas'), wrap(async (req, res) => {
  const porta = trim(req.query.porta);
  if (!PORTAS_SENHAS.includes(porta)) return res.status(400).json({ error: 'Porta inválida.' });
  const r = await query('SELECT login FROM dbo.EQUIPSTI_senhas_portas_acesso WHERE porta=@porta', { porta: S(porta) });
  const usados = new Set(r.recordset.map((x) => x.login));
  let max = 0;
  for (const login of usados) { const n = Number(login); if (Number.isFinite(n) && n > max) max = n; }
  const candidatoMax = String(max + 1).padStart(4, '0');
  if (max + 1 <= 9999 && !usados.has(candidatoMax)) return res.json({ login: candidatoMax });
  for (let n = 1; n <= 9999; n++) {
    const candidato = String(n).padStart(4, '0');
    if (!usados.has(candidato)) return res.json({ login: candidato });
  }
  res.json({ login: '' });
}));

app.get('/api/senhas/:id/revelar', exigirAuth, exigirPermissao('aba_senhas'), wrap(async (req, res) => {
  if (!chaveConfigurada()) return res.status(503).json({ error: 'SENHAS_CHAVE não configurada no .env.' });
  const id = Number(req.params.id);
  const row = (await query(
    'SELECT nome, senha_cifrada AS senhaCifrada FROM dbo.EQUIPSTI_senhas_portas WHERE id=@id', { id }
  )).recordset[0];
  if (!row) return res.status(404).json({ error: 'Cadastro não encontrado.' });
  const senha = decifrar(row.senhaCifrada);
  await registrarLog({
    modulo: 'SENHAS', entidadeId: String(id), entidadeRotulo: row.nome,
    acao: 'SENHA_REVELADA', usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ senha });
}));

app.post('/api/senhas', exigirAuth, exigirPermissao('aba_senhas'), wrap(async (req, res) => {
  if (!chaveConfigurada()) return res.status(503).json({ error: 'SENHAS_CHAVE não configurada no .env.' });
  const d = lerSenha(req.body);
  const erroValidacao = validarSenha(d);
  if (erroValidacao) return res.status(400).json({ error: erroValidacao });
  const conflito = await checarLoginEmUso(d.acessos);
  if (conflito) return res.status(409).json({ error: conflito });

  const ins = await query(
    `INSERT INTO dbo.EQUIPSTI_senhas_portas (nome, senha_cifrada, criado_por, atualizado_por)
     OUTPUT INSERTED.id
     VALUES (@nome, @senhaCifrada, @criadoPor, @criadoPor)`,
    { nome: S(d.nome), senhaCifrada: S(cifrar(d.senha)), criadoPor: S(req.user.email) }
  );
  const id = ins.recordset[0].id;
  for (const porta of PORTAS_SENHAS) {
    const a = d.acessos[porta];
    if (!a.habilitado) continue;
    await query(
      `INSERT INTO dbo.EQUIPSTI_senhas_portas_acesso (senha_id, porta, login, ativo)
       VALUES (@senhaId, @porta, @login, @ativo)`,
      {
        senhaId: { type: sql.Int, value: id }, porta: S(porta), login: S(a.login),
        ativo: { type: sql.Bit, value: a.ativo ? 1 : 0 }
      }
    );
  }
  await registrarLog({
    modulo: 'SENHAS', entidadeId: String(id), entidadeRotulo: rotuloSenha(d), acao: 'CRIADO',
    valorNovo: PORTAS_SENHAS.filter((p) => d.acessos[p].habilitado).map((p) => ROTULO_PORTA_SENHA[p]).join(', ') || '—',
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json({ ok: true, id });
}));

app.put('/api/senhas/:id', exigirAuth, exigirPermissao('aba_senhas'), wrap(async (req, res) => {
  if (!chaveConfigurada()) return res.status(503).json({ error: 'SENHAS_CHAVE não configurada no .env.' });
  const id = Number(req.params.id);
  const d = lerSenha(req.body);
  const erroValidacao = validarSenha(d);
  if (erroValidacao) return res.status(400).json({ error: erroValidacao });
  const conflito = await checarLoginEmUso(d.acessos, id);
  if (conflito) return res.status(409).json({ error: conflito });

  const antes = (await query(
    'SELECT nome, senha_cifrada AS senhaCifrada FROM dbo.EQUIPSTI_senhas_portas WHERE id=@id', { id }
  )).recordset[0];
  if (!antes) return res.status(404).json({ error: 'Cadastro não encontrado.' });
  const acessosAntesLinhas = (await query(
    'SELECT porta, login, ativo FROM dbo.EQUIPSTI_senhas_portas_acesso WHERE senha_id=@id', { id }
  )).recordset;
  const acessosAntes = {};
  for (const p of PORTAS_SENHAS) acessosAntes[p] = { habilitado: false, login: null, ativo: false };
  for (const l of acessosAntesLinhas) acessosAntes[l.porta] = { habilitado: true, login: l.login, ativo: !!l.ativo };

  await query(
    `UPDATE dbo.EQUIPSTI_senhas_portas SET nome=@nome, senha_cifrada=@senhaCifrada,
     atualizado_por=@atualizadoPor, atualizado_em=SYSUTCDATETIME() WHERE id=@id`,
    { nome: S(d.nome), senhaCifrada: S(cifrar(d.senha)), id, atualizadoPor: S(req.user.email) }
  );

  await query('DELETE FROM dbo.EQUIPSTI_senhas_portas_acesso WHERE senha_id=@id', { id });
  for (const porta of PORTAS_SENHAS) {
    const a = d.acessos[porta];
    if (!a.habilitado) continue;
    await query(
      `INSERT INTO dbo.EQUIPSTI_senhas_portas_acesso (senha_id, porta, login, ativo)
       VALUES (@senhaId, @porta, @login, @ativo)`,
      {
        senhaId: { type: sql.Int, value: id }, porta: S(porta), login: S(a.login),
        ativo: { type: sql.Bit, value: a.ativo ? 1 : 0 }
      }
    );
  }

  if (logMudou(antes.nome, d.nome)) {
    await registrarLog({
      modulo: 'SENHAS', entidadeId: String(id), entidadeRotulo: rotuloSenha(d), acao: 'ATUALIZADO', campo: 'NOME',
      valorAnterior: antes.nome, valorNovo: d.nome, usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  // Compara em claro só para decidir SE mudou (nunca grava o valor no log).
  let senhaAnteriorTexto = null;
  try { senhaAnteriorTexto = decifrar(antes.senhaCifrada); } catch { /* pacote antigo/corrompido: trata como alterada */ }
  if (senhaAnteriorTexto !== d.senha) {
    await registrarLog({
      modulo: 'SENHAS', entidadeId: String(id), entidadeRotulo: rotuloSenha(d), acao: 'ATUALIZADO', campo: 'SENHA',
      valorAnterior: '(oculto)', valorNovo: '(oculto)', usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  for (const porta of PORTAS_SENHAS) {
    const a = acessosAntes[porta];
    const b = d.acessos[porta];
    if (logMudou(a.habilitado, b.habilitado) || logMudou(a.login, b.login) || logMudou(a.ativo, b.ativo)) {
      await registrarLog({
        modulo: 'SENHAS', entidadeId: String(id), entidadeRotulo: rotuloSenha(d), acao: 'ATUALIZADO',
        campo: `PORTA ${ROTULO_PORTA_SENHA[porta]}`,
        valorAnterior: a.habilitado ? `login ${a.login}${a.ativo ? '' : ' (inativo)'}` : 'desabilitada',
        valorNovo: b.habilitado ? `login ${b.login}${b.ativo ? '' : ' (inativo)'}` : 'desabilitada',
        usuario: req.user.email, usuarioId: req.user.sub
      });
    }
  }
  res.json({ ok: true });
}));

app.delete('/api/senhas/:id', exigirAuth, exigirPermissao('aba_senhas'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const prev = (await query('SELECT nome FROM dbo.EQUIPSTI_senhas_portas WHERE id=@id', { id })).recordset[0];
  await query('DELETE FROM dbo.EQUIPSTI_senhas_portas WHERE id=@id', { id }); // cascade cuida dos acessos
  if (prev) {
    await registrarLog({
      modulo: 'SENHAS', entidadeId: String(id), entidadeRotulo: prev.nome, acao: 'EXCLUIDO',
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  res.json({ ok: true });
}));

// ===================== CONEXÕES (UptimeRobot) =====================
// Somente leitura do monitoramento: o painel da sub-aba "Conexão" casa cada
// UNIDADE cadastrada em Opções com um monitor do UptimeRobot. Nenhum aviso é
// enviado daqui — os alertas por e-mail continuam sendo do painel do próprio
// UptimeRobot. Mesma permissão da aba Internet, onde o painel vive.

// Unidades visíveis + o monitor vinculado a cada uma.
// SEDE e MATRIZ ficam de fora: são escritórios, não lojas com link monitorado.
async function unidadesComMonitor() {
  const r = await query(`SELECT valor, uptimerobot_monitor_id AS monitorId
    FROM dbo.EQUIPSTI_opcoes
    WHERE lista = 'UNIDADE' AND oculto = 0 AND valor NOT IN ('SEDE', 'MATRIZ')
    ORDER BY valor`);
  return r.recordset;
}

app.get('/api/conexoes', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  const unidades = await unidadesComMonitor();
  let monitores;
  try {
    monitores = await uptimeRobot.listarMonitores();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  const porId = new Map(monitores.map((m) => [String(m.id), m]));
  res.json({
    atualizadoEm: uptimeRobot.dataUtc(Math.floor(Date.now() / 1000)),
    unidades: unidades.map((u) => {
      const m = u.monitorId == null ? null : porId.get(String(u.monitorId));
      // Vínculo apontando para monitor que não existe mais no UptimeRobot
      // (apagado lá) aparece como não vinculado, sem quebrar o painel.
      if (!m) return { unidade: u.valor, monitorId: null, monitor: null, status: 'SEM_MONITOR', desde: null };
      return { unidade: u.valor, monitorId: m.id, monitor: m.nome, status: m.status, desde: m.desde };
    })
  });
}));

// Uptime de 30 dias das unidades já vinculadas (a lista de barrinhas embaixo
// dos cards). Rota separada de propósito: essa consulta é lenta e tem cache
// longo, então os cards de status não podem depender dela para aparecer.
app.get('/api/conexoes/uptime', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  const unidades = (await unidadesComMonitor()).filter((u) => u.monitorId != null);
  let uptime;
  try {
    uptime = await uptimeRobot.listarUptime();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  const porId = new Map(uptime.map((u) => [String(u.id), u]));
  res.json({
    // Monitor sem histórico aqui (apagado, ou não publicado na página de
    // status) entra com dias vazio: a unidade some da lista seria pior.
    unidades: unidades.map((u) => {
      const m = porId.get(String(u.monitorId));
      return { unidade: u.valor, ratio: m?.ratio ?? null, dias: m?.dias || [] };
    })
  });
}));

// Lista para o select da engrenagem (vincular unidade → monitor).
app.get('/api/conexoes/monitores', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  try {
    res.json(await uptimeRobot.listarMonitores());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.put('/api/conexoes/vinculo', exigirAuth, exigirPermissao('aba_internet'), wrap(async (req, res) => {
  const unidade = trim(req.body.unidade);
  const monitorId = req.body.monitorId == null || req.body.monitorId === ''
    ? null : Number(req.body.monitorId);
  if (!unidade) return res.status(400).json({ error: 'Informe a unidade.' });
  if (monitorId != null && !Number.isInteger(monitorId)) {
    return res.status(400).json({ error: 'Monitor inválido.' });
  }

  const atual = (await query(`SELECT uptimerobot_monitor_id AS monitorId
    FROM dbo.EQUIPSTI_opcoes WHERE lista = 'UNIDADE' AND valor = @unidade`,
    { unidade: S(unidade) })).recordset[0];
  if (!atual) return res.status(404).json({ error: 'Unidade não encontrada.' });

  await query(`UPDATE dbo.EQUIPSTI_opcoes SET uptimerobot_monitor_id = @monitorId
    WHERE lista = 'UNIDADE' AND valor = @unidade`,
    { monitorId: { type: sql.BigInt, value: monitorId }, unidade: S(unidade) });

  // Log com o nome do monitor (o id sozinho não diz nada em auditoria).
  let nomeDe = null;
  let nomePara = null;
  try {
    const monitores = await uptimeRobot.listarMonitores();
    const nome = (id) => (id == null ? null : (monitores.find((m) => String(m.id) === String(id))?.nome || String(id)));
    nomeDe = nome(atual.monitorId);
    nomePara = nome(monitorId);
  } catch {
    // UptimeRobot fora do ar não pode impedir o vínculo nem o log.
    nomeDe = atual.monitorId == null ? null : String(atual.monitorId);
    nomePara = monitorId == null ? null : String(monitorId);
  }
  if (logMudou(nomeDe, nomePara, false)) {
    await registrarLog({
      modulo: 'INTERNET', entidadeRotulo: unidade,
      acao: 'ATUALIZADO', campo: 'MONITOR',
      valorAnterior: nomeDe, valorNovo: nomePara,
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  res.json({ ok: true });
}));

// ===================== VPS (Hostinger, só leitura) =====================
app.get('/api/vps', exigirAuth, exigirPermissao('aba_vps'), wrap(async (req, res) => {
  try {
    res.json(await hostinger.listarMaquinas());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// Resumo compacto (estado + CPU/RAM atuais) para o Dashboard e o Cockpit.
app.get('/api/vps/resumo', exigirAuth, exigirPermissao('aba_vps'), wrap(async (req, res) => {
  try {
    res.json(await hostinger.resumo());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.get('/api/vps/:id/metricas', exigirAuth, exigirPermissao('aba_vps'), wrap(async (req, res) => {
  const faixa = req.query.faixa === '7d' ? '7d' : '24h';
  try {
    res.json(await hostinger.metricas(req.params.id, faixa));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.get('/api/vps/:id/acoes', exigirAuth, exigirPermissao('aba_vps'), wrap(async (req, res) => {
  const page = Number(req.query.page) || 1;
  try {
    res.json(await hostinger.acoes(req.params.id, page));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.get('/api/vps/:id/docker', exigirAuth, exigirPermissao('aba_vps'), wrap(async (req, res) => {
  try {
    res.json(await hostinger.dockerProjetos(req.params.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// ===================== Calendário (vencimentos) =====================
const CALENDARIO_SELECT = `SELECT id, titulo, tipo,
  CONVERT(varchar(10), data, 120) AS data, recorrencia, valor, observacao,
  avisar_dias_antes AS avisarDiasAntes,
  visibilidade, emails_extras AS emailsExtras,
  criado_por AS criadoPor, criado_por_id AS criadoPorId, atualizado_por AS atualizadoPor,
  CONVERT(varchar(19), criado_em, 120) AS criadoEm,
  CONVERT(varchar(19), atualizado_em, 120) AS atualizadoEm
  FROM dbo.EQUIPSTI_calendario_eventos`;

// Quem vê e quem é avisado: 'EQUIPE' = MASTER + técnicos; 'SEDE' = só os MASTER;
// 'EU' = só quem criou.
const CAL_VISIBILIDADES = ['EQUIPE', 'SEDE', 'EU'];
const CAL_PAPEIS_EQUIPE = ['TECNICO', 'MASTER'];
const CAL_PAPEIS_SEDE = ['MASTER'];

// emails_extras é um array JSON no banco (mesmo padrão de EQUIPSTI_usuarios.permissoes):
// sai como string e vira array aqui, no JS — o projeto não usa OPENJSON em lugar nenhum.
function mapEventoCalendario(row) {
  if (!row) return row;
  let extras = [];
  try {
    const lista = JSON.parse(row.emailsExtras || '[]');
    if (Array.isArray(lista)) extras = lista;
  } catch { /* JSON corrompido não pode derrubar a agenda inteira */ }
  return { ...row, emailsExtras: extras };
}

// Normaliza a lista digitada no modal: minúsculas, sem espaço, sem repetição.
// A validação em si fica em validarEventoCalendario, para o usuário ver QUAL
// endereço está errado em vez de vê-lo sumir em silêncio.
function lerEmailsExtras(valor) {
  const bruto = Array.isArray(valor) ? valor : [];
  const vistos = new Set();
  const lista = [];
  for (const e of bruto) {
    const limpo = trim(e).toLowerCase();
    if (!limpo || vistos.has(limpo)) continue;
    vistos.add(limpo);
    lista.push(limpo);
  }
  return lista;
}

function lerEventoCalendario(body) {
  return {
    titulo: trim(body.titulo),
    tipo: trim(body.tipo),
    data: trim(body.data),
    recorrencia: ['MENSAL', 'ANUAL', 'NENHUMA'].includes(body.recorrencia) ? body.recorrencia : null,
    valor: body.valor !== null && body.valor !== '' && body.valor !== undefined ? Number(body.valor) : null,
    observacao: trim(body.observacao),
    avisarDiasAntes: (() => {
      const n = Math.trunc(Number(body.avisarDiasAntes));
      return Number.isFinite(n) && n >= 1 ? n : null;
    })(),
    visibilidade: CAL_VISIBILIDADES.includes(body.visibilidade) ? body.visibilidade : null,
    emailsExtras: lerEmailsExtras(body.emailsExtras)
  };
}

function paramsEventoCalendario(d) {
  return {
    titulo: S(d.titulo), tipo: S(d.tipo),
    data: { type: sql.Date, value: d.data },
    recorrencia: S(d.recorrencia),
    valor: d.valor != null && !isNaN(d.valor) ? { type: sql.Decimal(15, 2), value: d.valor } : S(null),
    observacao: S(d.observacao),
    avisarDias: d.avisarDiasAntes != null ? { type: sql.Int, value: d.avisarDiasAntes } : S(null),
    visibilidade: S(d.visibilidade),
    emailsExtras: S(d.emailsExtras.length ? JSON.stringify(d.emailsExtras) : null)
  };
}

function validarEventoCalendario(d, res) {
  if (!d.titulo) { res.status(400).json({ error: 'Informe o título.' }); return false; }
  if (!d.tipo) { res.status(400).json({ error: 'Informe o tipo.' }); return false; }
  if (!d.data) { res.status(400).json({ error: 'Informe a data.' }); return false; }
  if (!d.recorrencia) { res.status(400).json({ error: 'Selecione a repetição (mensal, anual ou não repete).' }); return false; }
  if (!d.visibilidade) { res.status(400).json({ error: 'Selecione o destinatário (equipe de TI, Sede TI ou só você).' }); return false; }
  if (!d.observacao) { res.status(400).json({ error: 'Informe a observação.' }); return false; }
  const invalidos = d.emailsExtras.filter((e) => !emailValido(e));
  if (invalidos.length) {
    res.status(400).json({ error: `E-mail inválido: ${invalidos.join(', ')}` });
    return false;
  }
  return true;
}

// Campos auditados do Calendário (chave do shape → rótulo; 3º = comparar como número).
// emailsExtras entra como texto já achatado — logMudou compara strings, não arrays.
const CAMPOS_LOG_CALENDARIO = [
  ['titulo', 'TÍTULO'], ['tipo', 'TIPO'], ['data', 'DATA'],
  ['recorrencia', 'REPETIÇÃO'], ['valor', 'VALOR', true], ['observacao', 'OBSERVAÇÃO'],
  ['avisarDiasAntes', 'AVISO (DIAS)', true], ['visibilidade', 'DESTINATÁRIO'],
  ['emailsExtras', 'E-MAILS ADICIONAIS']
];

// Evento restrito não pode ser editado nem apagado por quem não o enxerga —
// sem isto, ele sairia da lista mas continuaria alcançável pelo id. O dono
// sempre mexe no que criou, inclusive no evento de Sede TI feito por um técnico.
function podeMexerNoEvento(ev, usuarioId, papel) {
  if (Number(ev.criadoPorId) === Number(usuarioId)) return true;
  if (ev.visibilidade === 'EU') return false;
  if (ev.visibilidade === 'SEDE') return papel === 'MASTER';
  return true;
}

// Destinatários de um evento, no formato que notificarEmailLote espera. Os
// e-mails adicionais entram nos três casos; eles só recebem e-mail, nunca
// sininho (não têm conta no sistema).
function publicoDoEvento(ev) {
  const papeis = ev.visibilidade === 'EU' ? []
    : ev.visibilidade === 'SEDE' ? CAL_PAPEIS_SEDE
      : CAL_PAPEIS_EQUIPE;
  return {
    papeis,
    usuarioIds: ev.visibilidade === 'EU' ? [ev.criadoPorId].filter(Boolean) : [],
    emailsExtras: ev.emailsExtras || []
  };
}

const CAL_RECORRENCIA_TXT = { MENSAL: 'repete todo mês', ANUAL: 'repete todo ano' };
const calValorTxt = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// Ficha do evento dentro do e-mail (tipo · data · valor · repetição + observação).
function blocoEventoCalendario(d) {
  const partes = [d.tipo, ymdParaBR(d.data)];
  if (d.valor != null && !isNaN(d.valor)) partes.push(calValorTxt(d.valor));
  if (CAL_RECORRENCIA_TXT[d.recorrencia]) partes.push(CAL_RECORRENCIA_TXT[d.recorrencia]);
  return { titulo: d.titulo, mensagem: partes.join(' · ') + (d.observacao ? `\n${d.observacao}` : '') };
}

app.get('/api/calendario/eventos', exigirAuth, exigirPermissao('aba_calendario'), wrap(async (req, res) => {
  // Evento 'EU' é particular: nem MASTER vê o dos outros — é o sentido da opção.
  // 'SEDE' só aparece para os MASTER. Em ambos, quem criou continua vendo o
  // próprio evento: um técnico que pauta algo para a Sede TI não pode salvar e
  // ver o evento sumir da agenda dele.
  const r = await query(`${CALENDARIO_SELECT}
    WHERE criado_por_id = @meuId
       OR (visibilidade <> 'EU' AND (visibilidade <> 'SEDE' OR @ehMaster = 1))
    ORDER BY data`,
    { meuId: req.user.sub, ehMaster: { type: sql.Bit, value: req.perfilCI.role === 'MASTER' ? 1 : 0 } });
  res.json(r.recordset.map(mapEventoCalendario));
}));

app.post('/api/calendario/eventos', exigirAuth, exigirPermissao('aba_calendario'), wrap(async (req, res) => {
  const d = lerEventoCalendario(req.body);
  if (!validarEventoCalendario(d, res)) return;
  const insC = await query(`INSERT INTO dbo.EQUIPSTI_calendario_eventos
    (titulo, tipo, data, recorrencia, valor, observacao, avisar_dias_antes,
     visibilidade, emails_extras, criado_por, criado_por_id, atualizado_por)
    OUTPUT INSERTED.id
    VALUES (@titulo, @tipo, @data, @recorrencia, @valor, @observacao, @avisarDias,
     @visibilidade, @emailsExtras, @criadoPor, @criadoPorId, @criadoPor)`,
    { ...paramsEventoCalendario(d), criadoPor: S(req.user.email), criadoPorId: req.user.sub });
  await registrarLog({
    modulo: 'CALENDARIO', entidadeId: String(insC.recordset[0].id), entidadeRotulo: d.titulo,
    acao: 'CRIADO', valorNovo: `${d.tipo || '—'} · ${d.data || '—'}`,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  // Avisa o público do evento na hora — quem está só nos e-mails adicionais não
  // tem a agenda, então este é o único momento em que fica sabendo do evento
  // quando não há "avisar N dias antes" configurado. Sem await, pelo mesmo
  // motivo do resto do sistema: o Salvar não espera handshake SMTP.
  notificarEmailLote({
    titulo: `Novo evento na agenda: ${d.titulo}`,
    tag: 'Calendário',
    blocos: [blocoEventoCalendario(d)],
    ...publicoDoEvento({ ...d, criadoPorId: req.user.sub })
  });
  res.status(201).json({ ok: true });
}));

app.put('/api/calendario/eventos/:id', exigirAuth, exigirPermissao('aba_calendario'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerEventoCalendario(req.body);
  if (!validarEventoCalendario(d, res)) return;
  const antesEv = mapEventoCalendario((await query(`${CALENDARIO_SELECT} WHERE id = @id`, { id })).recordset[0]) || {};
  if (!podeMexerNoEvento(antesEv, req.user.sub, req.perfilCI.role)) return res.status(404).json({ error: 'Evento não encontrado.' });
  await query(`UPDATE dbo.EQUIPSTI_calendario_eventos SET
    titulo=@titulo, tipo=@tipo, data=@data, recorrencia=@recorrencia, valor=@valor, observacao=@observacao,
    avisar_dias_antes=@avisarDias, visibilidade=@visibilidade, emails_extras=@emailsExtras,
    atualizado_por=@atualizadoPor, atualizado_em=SYSUTCDATETIME()
    WHERE id=@id`,
    { ...paramsEventoCalendario(d), id, atualizadoPor: S(req.user.email) });
  // Listas viram texto para o log: logMudou compara strings, não arrays.
  const antesLog = { ...antesEv, emailsExtras: (antesEv.emailsExtras || []).join(', ') };
  const depoisLog = { ...d, emailsExtras: d.emailsExtras.join(', ') };
  for (const [key, label, num] of CAMPOS_LOG_CALENDARIO) {
    if (logMudou(antesLog[key], depoisLog[key], num)) {
      await registrarLog({
        modulo: 'CALENDARIO', entidadeId: String(id), entidadeRotulo: d.titulo,
        acao: 'ATUALIZADO', campo: label,
        valorAnterior: antesLog[key] == null ? null : String(antesLog[key]),
        valorNovo: depoisLog[key] == null ? null : String(depoisLog[key]),
        usuario: req.user.email, usuarioId: req.user.sub
      });
    }
  }
  // Quem acabou de ser incluído nos e-mails adicionais recebe a ficha do evento;
  // quem já estava na lista não é avisado de novo a cada edição.
  const novosExtras = d.emailsExtras.filter((e) => !(antesEv.emailsExtras || []).includes(e));
  if (novosExtras.length) {
    notificarEmailLote({
      titulo: `Evento na agenda: ${d.titulo}`,
      tag: 'Calendário',
      blocos: [blocoEventoCalendario(d)],
      papeis: [], usuarioIds: [], emailsExtras: novosExtras
    });
  }
  res.json({ ok: true });
}));

app.delete('/api/calendario/eventos/:id', exigirAuth, exigirPermissao('aba_calendario'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const prev = mapEventoCalendario((await query(`${CALENDARIO_SELECT} WHERE id = @id`, { id })).recordset[0]);
  if (prev && !podeMexerNoEvento(prev, req.user.sub, req.perfilCI.role)) return res.status(404).json({ error: 'Evento não encontrado.' });
  await query('DELETE FROM dbo.EQUIPSTI_calendario_eventos WHERE id = @id', { id });
  if (prev) {
    await registrarLog({
      modulo: 'CALENDARIO', entidadeId: String(id), entidadeRotulo: prev.titulo,
      acao: 'EXCLUIDO',
      valorAnterior: `${prev.titulo || '—'} · ${prev.tipo || '—'} · ${prev.data || '—'}`,
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  res.json({ ok: true });
}));

// ---- Avisos por e-mail antes do vencimento -----------------------------
// Toda a aritmética de datas é feita em UTC "puro" (Date.UTC) sobre strings
// YYYY-MM-DD, para não sofrer com o fuso do servidor. O "hoje" de referência
// é o de São Paulo, para a janela bater com o calendário brasileiro mesmo com
// o processo em UTC (o container roda assim de propósito — ver Dockerfile).
const UM_DIA_MS = 86400000;
const ymdParaUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const utcParaYmd = (ms) => {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};
const ymdParaBR = (s) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };

function hojeEmSaoPaulo() {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// Próxima ocorrência >= hoje (ms UTC), respeitando a recorrência. Dia clampeado
// ao fim do mês (ex.: dia 31 em fevereiro, ou 29/02 em ano não bissexto).
function proximaOcorrencia(dataStr, recorrencia, hojeMs) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const mes0 = m - 1;
  if (recorrencia === 'MENSAL') {
    const h = new Date(hojeMs);
    let yy = h.getUTCFullYear(), mm = h.getUTCMonth();
    for (let i = 0; i < 13; i++) {
      const ultimoDia = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
      const cand = Date.UTC(yy, mm, Math.min(d, ultimoDia));
      if (cand >= hojeMs) return cand;
      if (++mm > 11) { mm = 0; yy++; }
    }
    return null;
  }
  if (recorrencia === 'ANUAL') {
    let yy = new Date(hojeMs).getUTCFullYear();
    for (let i = 0; i < 3; i++) {
      const ultimoDia = new Date(Date.UTC(yy, mes0 + 1, 0)).getUTCDate();
      const cand = Date.UTC(yy, mes0, Math.min(d, ultimoDia));
      if (cand >= hojeMs) return cand;
      yy++;
    }
    return null;
  }
  return Date.UTC(y, mes0, d); // NENHUMA: data fixa (pode ser passada → filtrada pela janela)
}

// Falha de SMTP costuma ser transiente (ex.: "451 4.3.0 queue file write
// error", o próprio servidor pedindo pra tentar depois) — esperar até amanhã
// pra tentar de novo é tempo demais pra um problema que often se resolve em
// minutos. 3 tentativas com 5 min de intervalo cobre isso sem virar polling
// agressivo.
const RETRY_EMAIL_LOTE_TENTATIVAS = 3;
const RETRY_EMAIL_LOTE_ESPERA_MS = 5 * 60 * 1000;

// Percorre os eventos com aviso configurado e dispara sininho (por evento) +
// e-mail em lote quando "hoje" cai na janela [ocorrência - N dias, ocorrência] e
// essa ocorrência ainda não foi avisada. Idempotente via ultimo_aviso_data — só
// marcado depois que o e-mail é confirmado, então uma falha de SMTP (mesmo
// esgotando as tentativas) faz o lote tentar de novo no dia seguinte, em vez de sumir.
//
// O lote é POR PÚBLICO, não mais um só: cada evento agora tem destinatário
// próprio (a equipe de TI, a Sede TI ou só o dono, mais os e-mails adicionais), e juntar
// tudo num e-mail mandaria evento particular para a equipe inteira. Eventos com
// o mesmo público continuam viajando juntos — que é o ponto do lote: um
// handshake SMTP em vez de N (ver comentário em notificacoes.js).
async function rodarLembretesCalendario() {
  const hojeMs = ymdParaUTC(hojeEmSaoPaulo());
  const evs = (await query(`SELECT id, titulo, tipo,
      CONVERT(varchar(10), data, 120) AS data, recorrencia, valor, observacao,
      avisar_dias_antes AS avisarDiasAntes, visibilidade,
      emails_extras AS emailsExtras, criado_por_id AS criadoPorId,
      CONVERT(varchar(10), ultimo_aviso_data, 120) AS ultimoAvisoData
    FROM dbo.EQUIPSTI_calendario_eventos
    WHERE avisar_dias_antes IS NOT NULL AND avisar_dias_antes > 0`)).recordset;
  // Chave do grupo = o público exato do evento. Eventos de equipe sem e-mails
  // adicionais (o caso comum) caem todos na mesma chave.
  const grupos = new Map();
  let total = 0;
  for (const linha of evs) {
    const ev = mapEventoCalendario(linha);
    try {
      const occMs = proximaOcorrencia(ev.data, ev.recorrencia, hojeMs);
      if (occMs == null) continue;
      const occStr = utcParaYmd(occMs);
      if (hojeMs < occMs - ev.avisarDiasAntes * UM_DIA_MS || hojeMs > occMs) continue;
      if (ev.ultimoAvisoData === occStr) continue;
      const faltam = Math.round((occMs - hojeMs) / UM_DIA_MS);
      const quando = faltam <= 0 ? 'hoje' : faltam === 1 ? 'amanhã' : `em ${faltam} dias`;
      const partes = [ev.tipo, ymdParaBR(occStr)];
      if (ev.valor != null) partes.push(calValorTxt(ev.valor));
      const mensagem = partes.join(' · ') + (ev.observacao ? `\n${ev.observacao}` : '');
      const titulo = `Vence ${quando}: ${ev.titulo}`;
      const publico = publicoDoEvento(ev);
      await notificar({
        tipo: 'CALENDARIO', acao: 'AVISO', titulo, mensagem,
        link: 'tab-calendario', refId: ev.id,
        ator: { id: 0, email: 'sistema' },
        email: false,
        papeis: publico.papeis,
        sininhoUsuarioIds: publico.usuarioIds
      });
      const chave = `${ev.visibilidade}|${ev.criadoPorId ?? ''}|${[...publico.emailsExtras].sort().join(',')}`;
      if (!grupos.has(chave)) grupos.set(chave, { publico, pendentes: [] });
      grupos.get(chave).pendentes.push({ id: ev.id, occStr, titulo, mensagem });
      total++;
    } catch (e) {
      console.error('Falha ao avisar evento do calendário', ev.id, e.message);
    }
  }
  if (!total) return 0;

  // Retenta só os grupos que falharam: um público com problema (SMTP recusando
  // um endereço avulso, por exemplo) não pode reenviar o e-mail dos outros nem
  // impedir que eles sejam marcados como avisados.
  let restantes = [...grupos.values()];
  for (let tentativa = 1; tentativa <= RETRY_EMAIL_LOTE_TENTATIVAS && restantes.length; tentativa++) {
    const falharam = [];
    for (const grupo of restantes) {
      const { publico, pendentes } = grupo;
      const tituloLote = pendentes.length === 1 ? pendentes[0].titulo : `${pendentes.length} avisos do calendário`;
      const blocos = pendentes.map((p) => ({ titulo: p.titulo, mensagem: p.mensagem }));
      const enviado = await notificarEmailLote({ titulo: tituloLote, tag: 'Calendário', blocos, ...publico });
      if (!enviado) { falharam.push(grupo); continue; }
      for (const p of pendentes) {
        await query('UPDATE dbo.EQUIPSTI_calendario_eventos SET ultimo_aviso_data = @occ WHERE id = @id',
          { occ: { type: sql.Date, value: p.occStr }, id: p.id });
      }
    }
    restantes = falharam;
    if (!restantes.length) break;
    const ultima = tentativa === RETRY_EMAIL_LOTE_TENTATIVAS;
    console.error(`Calendário: ${restantes.length} lote(s) de e-mail falharam (tentativa ${tentativa}/${RETRY_EMAIL_LOTE_TENTATIVAS})` +
      (ultima ? ' — desistindo, ultimo_aviso_data não marcado, tenta de novo amanhã.' : `, nova tentativa em ${RETRY_EMAIL_LOTE_ESPERA_MS / 60000} min.`));
    if (!ultima) await new Promise((r) => setTimeout(r, RETRY_EMAIL_LOTE_ESPERA_MS));
  }
  return total - restantes.reduce((n, g) => n + g.pendentes.length, 0);
}

// Nota: existia aqui um GET /api/calendario/lembretes/run, gatilho para o
// Vercel Cron chamar de fora. Ele dependia de CRON_SECRET, que nunca foi
// definida — então respondia 404 desde sempre. Quem dispara os lembretes é o
// agendador interno, no fim deste arquivo.

// ===================== CATÁLOGO DE E-MAILS =====================
// GET /api/emails é o buscador de /emails: exige login, mas NÃO exige
// permissão de aba — é para a empresa inteira, como o portal de chamados.
// O resto é manutenção do catálogo e fica atrás de aba_emails.
app.get('/api/emails', exigirAuth, wrap(async (req, res) => {
  res.json(await emailsRepo.listarPublico({
    q: trim(req.query.q) || null,
    tipo: trim(req.query.tipo).toUpperCase() || null
  }));
}));

app.get('/api/emails/admin', exigirAuth, exigirPermissao('aba_emails'), wrap(async (req, res) => {
  res.json(await emailsRepo.listarAdmin({ q: trim(req.query.q) || null }));
}));

// Aceita só o que a TI digita: da Locaweb vem tudo pela importação.
function lerEmail(body) {
  return {
    tipo: trim(body.tipo).toUpperCase(),
    email: trim(body.email).toLowerCase(),
    nome: trim(body.nome) || null,
    descricao: trim(body.descricao) || null,
    oculto: !!body.oculto
  };
}

function validarEmailCatalogo(d) {
  if (!emailsRepo.TIPOS.includes(d.tipo)) return 'Tipo inválido (esperado GRUPO, CAIXA ou CONTATO).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return 'E-mail inválido.';
  return null;
}

app.post('/api/emails', exigirAuth, exigirPermissao('aba_emails'), wrap(async (req, res) => {
  const d = lerEmail(req.body);
  const erroValidacao = validarEmailCatalogo(d);
  if (erroValidacao) return res.status(400).json({ error: erroValidacao });
  if (await emailsRepo.existeEmail(d.email)) return res.status(409).json({ error: 'Esse e-mail já está no catálogo.' });

  const criado = await emailsRepo.criar(d, req.user.email);
  await registrarLog({
    modulo: 'EMAILS', entidadeId: String(criado.id), entidadeRotulo: criado.email,
    acao: 'CRIADO', valorNovo: [criado.tipo, criado.nome].filter(Boolean).join(' · '),
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json(criado);
}));

app.put('/api/emails/:id', exigirAuth, exigirPermissao('aba_emails'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = lerEmail(req.body);
  const erroValidacao = validarEmailCatalogo(d);
  if (erroValidacao) return res.status(400).json({ error: erroValidacao });

  const antes = await emailsRepo.obter(id);
  if (!antes) return res.status(404).json({ error: 'E-mail não encontrado.' });
  if (await emailsRepo.existeEmail(d.email, id)) return res.status(409).json({ error: 'Esse e-mail já está no catálogo.' });

  const depois = await emailsRepo.atualizar(id, d, req.user.email);
  const campos = [
    ['E-MAIL', antes.email, depois.email],
    ['TIPO', antes.tipo, depois.tipo],
    ['NOME', antes.nome, depois.nome],
    ['DESCRIÇÃO', antes.descricao, depois.descricao],
    ['VISÍVEL NO BUSCADOR', antes.oculto ? 'Não' : 'Sim', depois.oculto ? 'Não' : 'Sim']
  ];
  for (const [campo, de, para] of campos) {
    if (!logMudou(de, para)) continue;
    await registrarLog({
      modulo: 'EMAILS', entidadeId: String(id), entidadeRotulo: depois.email,
      acao: 'ATUALIZADO', campo, valorAnterior: de, valorNovo: para,
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
  res.json(depois);
}));

app.delete('/api/emails/:id', exigirAuth, exigirPermissao('aba_emails'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const antes = await emailsRepo.obter(id);
  if (!antes) return res.status(404).json({ error: 'E-mail não encontrado.' });

  await emailsRepo.excluir(id);
  await registrarLog({
    modulo: 'EMAILS', entidadeId: String(id), entidadeRotulo: antes.email,
    acao: 'EXCLUIDO', valorAnterior: [antes.tipo, antes.nome].filter(Boolean).join(' · '),
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ ok: true });
}));

// Importação assistida: o login do painel da Locaweb é CAS com reCAPTCHA de
// imagem, então quem já está logado no navegador cola aqui o HTML. Nenhuma
// credencial da Locaweb passa por este servidor.
//
// Aceita as DUAS páginas e reconhece sozinho qual chegou — quem importa não
// precisa dizer o que copiou. Cada uma completa a outra: grupos traz os grupos
// e seus integrantes, caixas postais traz o nome e o "Desativada" das caixas.
app.post('/api/emails/importar', exigirAuth, exigirPermissao('aba_emails'), wrap(async (req, res) => {
  const conteudo = String(req.body?.conteudo || '');
  if (!conteudo.trim()) return res.status(400).json({ error: 'Cole o conteúdo copiado do painel da Locaweb.' });

  let dados;
  try {
    dados = parsePainelLocaweb(conteudo);
  } catch (err) {
    // Erro de conteúdo, não do servidor: a mensagem do parser diz o que fazer.
    return res.status(400).json({ error: err.message });
  }

  const resumo = await emailsRepo.importarLocaweb(dados, req.user.email);
  // Uma linha de auditoria por importação — não uma por endereço.
  const detalhe = dados.pagina === 'CAIXAS'
    ? `${resumo.caixas} caixas (${resumo.comNome} com nome, ${resumo.desativadas} desativadas)`
    : `${resumo.grupos} grupos, ${resumo.caixas} caixas`;
  await registrarLog({
    modulo: 'EMAILS', entidadeRotulo: dados.dominio, acao: 'IMPORTADO',
    campo: dados.pagina === 'CAIXAS' ? 'CAIXAS POSTAIS' : 'GRUPOS',
    valorNovo: `${detalhe} · ${resumo.novos} novos, ${resumo.atualizados} atualizados, `
      + `${resumo.inativados} inativados`,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ ...resumo, dominio: dados.dominio });
}));

// ===================== PATs (origem dos empréstimos) =====================
// Só lista PATs que já passaram pela aba Empréstimos (EQUIPSTI_emprestimos).
// Isso obriga o cadastro correto do empréstimo antes de usá-lo como backup no INTECS vs MSA.
app.get('/api/pats', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
  const r = await query(`SELECT DISTINCT pat FROM dbo.EQUIPSTI_emprestimos
    WHERE pat IS NOT NULL AND LTRIM(RTRIM(pat)) <> '' ORDER BY pat`);
  res.json(r.recordset.map((row) => row.pat));
}));

app.get('/api/pats/:pat/info', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
  const pat = trim(req.params.pat);
  const r = await query(
    `SELECT TOP 1 equipamento, ns FROM dbo.EQUIPSTI_registros
      WHERE pat = @pat ORDER BY criado_em DESC`,
    { pat: S(pat) });
  const row = r.recordset[0];
  res.json(row ? { equipamento: row.equipamento || '', ns: row.ns || '' } : { equipamento: '', ns: '' });
}));

// NS distintos para um PAT (para popular o select de NS no form de empréstimo).
app.get('/api/pats/:pat/ns', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
  const pat = trim(req.params.pat);
  const r = await query(
    `SELECT DISTINCT ns FROM dbo.EQUIPSTI_registros
      WHERE pat = @pat AND ns IS NOT NULL AND LTRIM(RTRIM(ns)) <> ''
      ORDER BY ns`,
    { pat: S(pat) });
  res.json(r.recordset.map((row) => row.ns));
}));

// Histórico completo de um PAT (+NS opcional): unidade(s) de origem + linha do tempo de empréstimos.
app.get('/api/pats/:pat/history', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
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

app.get('/api/pats/:pat/lookup', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
  res.json(await lookupEquip(req.params.pat, req.query.ns));
}));

// ===================== EMPRÉSTIMOS =====================
app.get('/api/loans', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
  const r = await query(`SELECT id, pat, ns, unidade,
    CONVERT(varchar(10), data_emprestimo, 23) AS data,
    status,
    CONVERT(varchar(10), data_devolucao, 23) AS dataDevolucao,
    obs
    FROM dbo.EQUIPSTI_emprestimos
    ORDER BY CASE status WHEN 'EMPRESTADO' THEN 0 ELSE 1 END, id DESC`);
  res.json(r.recordset);
}));

app.post('/api/loans', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
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
    await registrarLog({
      modulo: 'EMPRESTIMOS', entidadeRotulo: `PAT ${pat}${equipamento ? ' · ' + equipamento : ''}`,
      acao: 'DEVOLVIDO', campo: 'UNIDADE', valorNovo: unidade,
      usuario: req.user.email, usuarioId: req.user.sub
    });
    await notificar({
      tipo: 'EMPRESTIMO', acao: 'DEVOLVIDO', link: 'tab-emprestimos', email: true,
      ator: { id: req.user.sub, email: req.user.email },
      titulo: 'Devolução de empréstimo',
      mensagem: `${equipamento || 'Equipamento'} — PAT ${pat} devolvido a ${unidade}`
    });
    return res.status(201).json({ ok: true, devolvido: true });
  }

  const rotuloEmp = `PAT ${pat}${equipamento ? ' · ' + equipamento : ''}`;

  // Fecha empréstimo aberto anterior como TRANSFERIDO (suporta cadeia 1→2→3→1).
  const transf = await query(
    `UPDATE dbo.EQUIPSTI_emprestimos
       SET status = 'TRANSFERIDO', data_devolucao = CAST(GETDATE() AS date)
     WHERE pat = @pat AND status = 'EMPRESTADO'
       ${ns ? 'AND (ns = @ns OR ns IS NULL)' : ''}`,
    ns ? { pat: S(pat), ns: S(ns) } : { pat: S(pat) });
  if (transf.rowsAffected[0] > 0) {
    await registrarLog({
      modulo: 'EMPRESTIMOS', entidadeRotulo: rotuloEmp,
      acao: 'TRANSFERIDO', campo: 'UNIDADE', valorAnterior: unidadeOriginal, valorNovo: unidade,
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }

  const insLoan = await query(
    `INSERT INTO dbo.EQUIPSTI_emprestimos (pat, ns, unidade, data_emprestimo, status, obs)
      OUTPUT INSERTED.id
      VALUES (@pat, @ns, @unidade, @data, 'EMPRESTADO', @obs)`,
    { pat: S(pat), ns: S(ns || null), unidade: S(unidade), data: S(data || null), obs: S(obs) });
  const loanId = insLoan.recordset[0]?.id;
  await registrarLog({
    modulo: 'EMPRESTIMOS', entidadeId: loanId != null ? String(loanId) : null, entidadeRotulo: rotuloEmp,
    acao: 'EMPRESTADO', campo: 'UNIDADE', valorAnterior: unidadeOriginal, valorNovo: unidade,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  await notificar({
    tipo: 'EMPRESTIMO', acao: 'CRIADO', link: 'tab-emprestimos', email: true,
    refId: loanId,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: 'Novo empréstimo',
    mensagem: `${equipamento || 'Equipamento'} — PAT ${pat} → ${unidade}`
  });
  res.status(201).json({ ok: true });
}));

app.put('/api/loans/:id/status', exigirAuth, exigirPermissao('aba_emprestimos'), wrap(async (req, res) => {
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
  if (statusAntigo && statusAntigo !== status) {
    await registrarLog({
      modulo: 'EMPRESTIMOS', entidadeId: String(id),
      entidadeRotulo: `PAT ${aPat}${eq.equipamento ? ' · ' + eq.equipamento : ''}`,
      acao: status, campo: 'STATUS', valorAnterior: statusAntigo, valorNovo: status,
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
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
  // Passa pelo mesmo cache de /api/chamados: é a mesma lista, e não faz sentido
  // duas entradas raspando o eurosa com segundos de diferença.
  const { lista } = await chamadosMsa();

  // Associação unidade da MSA -> unidade do sistema (EQUIPSTI_opcoes.detalhe).
  const assocRows = await query(
    "SELECT valor, detalhe FROM dbo.EQUIPSTI_opcoes WHERE lista = 'UNIDADE' AND detalhe IS NOT NULL AND detalhe <> ''");
  const assoc = {};
  assocRows.recordset.forEach((r) => { assoc[trim(r.detalhe)] = r.valor; });

  // Linhas existentes (para saber o status atual e quais ainda não têm unidade).
  const existRows = await query(
    'SELECT numero_chamado_msa, unidade, status_msa FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE numero_chamado_msa IS NOT NULL');
  const existente = {};
  existRows.recordset.forEach((r) => { existente[r.numero_chamado_msa] = r; });

  const semUnidade = [];   // { codigo, chave } a buscar o detalhe
  for (const ch of lista) {
    const codigo = trim(ch.Codigo);
    if (!codigo) continue;
    // Chamado que já está Finalizado aqui não muda mais (o eurosa não reabre),
    // então não há status para refrescar nem unidade para buscar. É o que tira
    // a maior parte das idas ao banco: o laço abaixo é serial, e hoje 65 dos
    // 72 chamados estão nesse estado.
    const ja = existente[codigo];
    if (ja && trim(ja.status_msa) === 'Finalizado') continue;
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
    const temUnidade = !inseriu && trim(ja?.unidade);
    if (!temUnidade && ch.Chave) semUnidade.push({ codigo, chave: ch.Chave });
  }

  // Preenche a unidade buscando o detalhe (campo 19024) e mapeando para o sistema.
  // Em lotes concorrentes (em vez de um HTTP por vez) — mesmo resultado, mais rápido.
  const aBuscar = semUnidade.slice(0, SYNC_MAX_DETALHE);
  const LOTE_DETALHE = 8;
  for (let i = 0; i < aBuscar.length; i += LOTE_DETALHE) {
    await Promise.all(aBuscar.slice(i, i + LOTE_DETALHE).map(async ({ codigo, chave }) => {
      try {
        const lst = await eurosaCamposExtras(chave);
        const campo = lst.find((e) => Number(e.codcampoextra) === 19024);
        const msaUnidade = campo?.valcampoextra ? trim(String(campo.valcampoextra)) : '';
        if (!msaUnidade) return;
        const unidadeSistema = assoc[msaUnidade] || msaUnidade;
        await query(
          `UPDATE dbo.EQUIPSTI_chamados_intecsmsa SET unidade = @u
             WHERE numero_chamado_msa = @c AND (unidade IS NULL OR unidade = '')`,
          { u: S(unidadeSistema), c: S(codigo) });
      } catch (e) { console.warn('[intecs-msa unidade] chamado', codigo, '->', e.message); }
    }));
  }
}

app.get('/api/intecs-msa', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
  // ?cache=1: responde só com o que está no banco, sem sincronizar com a MSA —
  // instantâneo. A sub-aba abre com o cache e dispara a sincronização de
  // verdade (sem o parâmetro) em segundo plano (mesmo padrão da Conexão Remota).
  if (req.query.cache !== '1') {
    try { await sincronizarIntecsMsa(); }
    catch (e) { console.warn('[intecs-msa sync] falhou:', e.message); }
  }
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
    FROM dbo.EQUIPSTI_chamados_intecsmsa ORDER BY data_solicitacao DESC, id DESC`);
  res.json(r.recordset);
}));

app.post('/api/intecs-msa', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
  const d = lerIntecsMsa(req.body);
  const insM = await query(`INSERT INTO dbo.EQUIPSTI_chamados_intecsmsa
    (data_solicitacao, numero_chamado_msa, problema, unidade, glpi, status_intecs,
     patrimonio_msa, ns, ponto_instalacao, descricao_equip, data_retirada_equip, data_entrega_equip,
     patrimonio_bkp_intecs, bkp_unidade, observacao, criado_por)
    OUTPUT INSERTED.id
    VALUES (@data_solicitacao, @numero_chamado_msa, @problema, @unidade, @glpi, @status_intecs,
     @patrimonio_msa, @ns, @ponto_instalacao, @descricao_equip, @data_retirada_equip, @data_entrega_equip,
     @patrimonio_bkp_intecs, @bkp_unidade, @observacao, @criado_por)`,
    { ...paramsIntecsMsa(d), criado_por: S(req.user.email) });
  await registrarLog({
    modulo: 'CHAMADOS_MSA', entidadeId: String(insM.recordset[0].id),
    entidadeRotulo: `Nº MSA ${d.numero_chamado_msa || '—'} · PAT ${d.patrimonio_msa || '—'}`,
    acao: 'CRIADO', valorNovo: d.problema,
    usuario: req.user.email, usuarioId: req.user.sub
  });

  const eqNovo = await lookupEquip(d.patrimonio_msa, d.ns);
  await notificar({
    tipo: 'CHAMADO', acao: 'CRIADO', link: 'tab-chamados', refId: insM.recordset[0].id, email: true,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: d.numero_chamado_msa ? `Chamado criado — nº MSA ${d.numero_chamado_msa}` : 'Chamado criado',
    mensagem: (d.numero_chamado_msa ? `nº ${d.numero_chamado_msa} · ` : '')
            + `${eqNovo.equipamento || 'Equipamento'} — PAT ${d.patrimonio_msa || '—'}`
  });

  res.status(201).json({ ok: true });
}));

app.put('/api/intecs-msa/:id', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
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

  const rotuloMsa = `Nº MSA ${d.numero_chamado_msa || '—'} · PAT ${d.patrimonio_msa || '—'}`;
  for (const m of mudancasCh) {
    await registrarLog({
      modulo: 'CHAMADOS_MSA', entidadeId: String(id), entidadeRotulo: rotuloMsa,
      acao: 'ATUALIZADO', campo: m.campo, valorAnterior: m.de, valorNovo: m.para,
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }

  const eqUpd = await lookupEquip(d.patrimonio_msa, d.ns);
  await notificar({
    tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', refId: id, email: true,
    ator: { id: req.user.sub, email: req.user.email },
    titulo: d.numero_chamado_msa ? `Chamado atualizado — nº MSA ${d.numero_chamado_msa}` : 'Chamado atualizado',
    mensagem: `${eqUpd.equipamento || 'Equipamento'} — PAT ${d.patrimonio_msa || '—'}`
            + (d.numero_chamado_msa ? ` · nº ${d.numero_chamado_msa}` : ''),
    mudancas: mudancasCh
  });
  res.json({ ok: true });
}));

app.delete('/api/intecs-msa/:id', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const prev = await query(
    'SELECT numero_chamado_msa, patrimonio_msa, ns FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE id = @id', { id });
  await query('DELETE FROM dbo.EQUIPSTI_chamados_intecsmsa WHERE id = @id', { id });
  const c = prev.recordset[0];
  if (c) {
    await registrarLog({
      modulo: 'CHAMADOS_MSA', entidadeId: String(id),
      entidadeRotulo: `Nº MSA ${c.numero_chamado_msa || '—'} · PAT ${c.patrimonio_msa || '—'}`,
      acao: 'EXCLUIDO',
      valorAnterior: `Nº MSA ${c.numero_chamado_msa || '—'} · PAT ${c.patrimonio_msa || '—'} · N/S ${c.ns || '—'}`,
      usuario: req.user.email, usuarioId: req.user.sub
    });
    const eqDel = await lookupEquip(c.patrimonio_msa, c.ns);
    await notificar({
      tipo: 'CHAMADO', acao: 'EXCLUIDO', link: 'tab-chamados', refId: id, email: true,
      ator: { id: req.user.sub, email: req.user.email },
      titulo: c.numero_chamado_msa ? `Chamado excluído — nº MSA ${c.numero_chamado_msa}` : 'Chamado excluído',
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

async function eurosaFetchChamados(teto = EUROSA_TETO_PAGINA) {
  // Body espelhado exatamente do que o browser envia (HAR capturado em 2026-06-16),
  // mais Tudo/Tatual para não vir cortado em 15 (ver eurosaFetchTodosChamados).
  const body = new URLSearchParams({
    Dados: JSON.stringify({
      Pesquisa: '', Ativo: '', Ordem: [],
      Tudo: 'true', Tatual: String(teto),
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

// /Chamados/lista devolve só 15 registros por padrão. Quem levanta esse teto
// são dois campos que a própria tela do eurosa usa no botão "carregar mais":
// 'Tatual' (quantos registros pular) e 'Tudo: true' (devolver tudo até esse
// número numa resposta só). Achados no App_v2.js do portal, no handler da
// classe .Mais:
//
//     tAtual = '"Tatual":"' + attrA.find('.TbodyC .TrC').length + '",';
//     carregaGridPadrao(h, '"Tudo":"true","Tatual":"' + valA + '",');
//
// Com eles, uma requisição traz o histórico inteiro. Antes disto o contorno
// era varrer mês a mês pelo prefixo do código (uma requisição por mês, sempre
// crescendo) — desnecessário agora.
//
// O teto é alto de propósito: o valor não muda o tempo de resposta. Medido com
// 72, 1.000, 10.000, 100.000 e 1.000.000 — sempre ~450ms e os mesmos 56 KB.
// Age como um LIMIT do SQL, não como tamanho de buffer.
const EUROSA_TETO_PAGINA = 10000;

async function eurosaFetchTodosChamados() {
  if (!eurosaCookie) await eurosaLogin();

  const buscar = async (teto) => {
    const result = await eurosaCall(() => eurosaFetchChamados(teto));
    const data = result.data;
    const lista = Array.isArray(data) ? data : (data?.root ?? data?.Lista ?? data?.lista ?? []);
    return { lista, total: Number(data?.total) };
  };

  let { lista, total } = await buscar(EUROSA_TETO_PAGINA);
  // 'total' vem com a contagem real mesmo quando o array é cortado. Se um dia
  // o volume passar do teto, ele denuncia e a segunda tentativa já pede o
  // número exato — em vez de perder chamado em silêncio, como acontecia
  // quando o corte em 15 era invisível.
  if (Number.isFinite(total) && total > lista.length) {
    console.warn('[chamados] teto de', EUROSA_TETO_PAGINA, 'estourado:', total,
      'chamados no eurosa. Refazendo a busca com o total exato.');
    ({ lista } = await buscar(total));
  }
  return lista;
}

// Cache do scraping. Sem ele, cada abertura do dashboard, cada abertura da aba
// Chamados e cada sync do Intecs vs MSA dispara um POST /Chamados/lista — e o
// cockpit, que fica aberto numa tela o dia inteiro, viraria um fluxo contínuo
// contra um portal de terceiro. Com 15 min o teto é de 4 buscas/hora, não
// importa quantas telas estejam abertas. Mesmo padrão do uptimerobot/service.js.
//
// Efeito colateral bom: o cookie do eurosa esfria menos, então o login de 3 hops
// roda menos vezes do que hoje.
const EUROSA_CACHE_MS = 15 * 60 * 1000;
let _msaCache = { ts: 0, lista: null, buscando: null };

// Falha do eurosa NÃO descarta o que já está em mãos: devolve o último
// resultado bom carimbado com a hora em que foi obtido, e quem exibe mostra
// essa hora. Só propaga o erro quando não há nada em cache.
async function chamadosMsa({ forcar = false } = {}) {
  const servirCache = () => ({
    lista: _msaCache.lista,
    atualizadoEm: uptimeRobot.dataUtc(Math.floor(_msaCache.ts / 1000)),
    doCache: true
  });

  // Busca em voo atende todo mundo, inclusive quem pediu forcar: ela JÁ é a
  // versão nova. Sem isto, dashboard e cockpit abrindo juntos com o cache frio
  // viram duas raspagens — e um clique repetido no atualizar, várias.
  if (_msaCache.buscando) return _msaCache.buscando;
  if (!forcar && _msaCache.lista && Date.now() - _msaCache.ts < EUROSA_CACHE_MS) return servirCache();

  _msaCache.buscando = (async () => {
    try {
      const lista = await eurosaFetchTodosChamados();
      _msaCache = { ..._msaCache, ts: Date.now(), lista };
      return { lista, atualizadoEm: uptimeRobot.dataUtc(Math.floor(_msaCache.ts / 1000)), doCache: false };
    } catch (err) {
      if (!_msaCache.lista) throw err;
      console.warn('[chamados] eurosa falhou (' + err.message + ') — servindo cache de',
        new Date(_msaCache.ts).toISOString());
      return servirCache();
    } finally {
      _msaCache.buscando = null;
    }
  })();
  return _msaCache.buscando;
}

app.get('/api/chamados', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
  const { lista, atualizadoEm, doCache } = await chamadosMsa({ forcar: req.query.forcar === '1' });
  res.json({ root: lista, total: lista.length, atualizadoEm });
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

app.get('/api/chamados/assuntos', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
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

app.get('/api/chamados/:chave', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
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

app.post('/api/chamados/:chave/interacao', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
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

  await registrarLog({
    modulo: 'CHAMADOS_MSA', entidadeId: codigo || chave,
    entidadeRotulo: `Chamado MSA ${codigo || chave}`,
    acao: 'INTERACAO', valorNovo: descricao,
    usuario: req.user.email, usuarioId: req.user.sub
  });

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

app.post('/api/chamados', exigirAuth, exigirPermissao('aba_chamados'), wrap(async (req, res) => {
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
      problema:   descricao || assuntoText,
      unidade:    unidadeSistema,
      patrimonio: patChamado,
      ns:         nsChamado,
      criadoPor:  req.user.email,
    });
  } catch (e) { console.warn('[intecs-msa enrich] falhou:', e.message); }

  await registrarLog({
    modulo: 'CHAMADOS_MSA', entidadeId: codigo || null,
    entidadeRotulo: `Chamado MSA ${codigo || 'novo'}`,
    acao: 'CRIADO', valorNovo: assuntoText || descricao,
    usuario: req.user.email, usuarioId: req.user.sub
  });

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
app.get('/api/dashboard', exigirAuth, exigirPermissao('aba_dashboard'), wrap(async (req, res) => {
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

app.get('/api/tactical-agents', exigirAuth, exigirPermissao('aba_conexao'), wrap(async (req, res) => {
  // ?cache=1: responde só com o que está no banco, sem consultar o Tactical
  // RMM — instantâneo. A aba Conexão Remota abre com o cache e dispara a
  // sincronização de verdade (sem o parâmetro) em segundo plano.
  const agentes = req.query.cache === '1'
    ? await deviceIntecsRepo.listTacticalAgents()
    : await deviceService.listarAgentesDisponiveis();
  res.json(agentes);
}));

// Acesso remoto da aba "Conexão Remota" do admin: devolve as URLs do
// MeshCentral (controle de tela, terminal e arquivos) com token efêmero.
// Só TECNICO/MASTER — é literalmente assumir a máquina de alguém.
app.get('/api/tactical-agents/:agentId/conexao-remota', exigirAuth, carregarPerfilChamados, exigirPermissao('aba_conexao'), exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const agentId = trim(req.params.agentId || '');
  if (!agentId) return res.status(400).json({ error: 'Informe o agente.' });
  // Tipo de acesso escolhido no front (?tipo=control|terminal|file). Sem isso
  // (HTML antigo em cache) loga com tipo nulo — nunca vira erro.
  const tipoConexao = ['control', 'terminal', 'file'].includes(req.query.tipo) ? req.query.tipo : null;
  try {
    const conexao = await deviceService.getConexaoRemota(agentId);
    if (!conexao) return res.status(404).json({ error: 'Agente não encontrado no Tactical RMM.' });
    const cache = await deviceIntecsRepo.getAgenteCache(agentId).catch(() => null);
    await registrarLog({
      modulo: 'CONEXAO_REMOTA', entidadeId: agentId,
      entidadeRotulo: cache?.hostname
        ? cache.hostname + (cache.site_name ? ` (${cache.site_name})` : '')
        : (conexao.hostname || agentId),
      acao: 'CONEXAO', campo: 'TIPO', valorNovo: tipoConexao,
      usuario: req.user.email, usuarioId: req.user.sub
    });
    res.json(conexao);
  } catch (err) {
    res.status(502).json({ error: 'Tactical RMM indisponível: ' + err.message });
  }
}));

// Scripts favoritos do Tactical RMM (estrela do modal Conexão Remota).
// Mesma régua da conexão remota: só TECNICO/MASTER.
app.get('/api/tactical-scripts/favoritos', exigirAuth, carregarPerfilChamados, exigirPermissao('aba_conexao'), exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  try {
    res.json(await deviceService.listarScriptsFavoritos());
  } catch (err) {
    res.status(502).json({ error: 'Tactical RMM indisponível: ' + err.message });
  }
}));

// Roda um script favorito na máquina — é executar código na máquina de
// alguém, então só TECNICO/MASTER e só scripts marcados como favoritos.
app.post('/api/tactical-agents/:agentId/rodar-script', exigirAuth, carregarPerfilChamados, exigirPermissao('aba_conexao'), exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const agentId = trim(req.params.agentId || '');
  const scriptId = Number(req.body?.script_id);
  if (!agentId || !Number.isInteger(scriptId) || scriptId <= 0) {
    return res.status(400).json({ error: 'Informe o agente e o script.' });
  }
  // Argumentos opcionais digitados na confirmação (ex.: o novo hostname).
  const args = Array.isArray(req.body?.args)
    ? req.body.args.map((a) => trim(String(a))).filter(Boolean).slice(0, 32)
    : [];
  try {
    const favoritos = await deviceService.listarScriptsFavoritos();
    const script = favoritos.find((s) => s.id === scriptId);
    if (!script) {
      return res.status(400).json({ error: 'Script não está entre os favoritos do Tactical RMM.' });
    }
    // Registra ANTES de rodar — fica auditado mesmo se o script estourar timeout.
    const cache = await deviceIntecsRepo.getAgenteCache(agentId).catch(() => null);
    await registrarLog({
      modulo: 'CONEXAO_REMOTA', entidadeId: agentId,
      entidadeRotulo: cache?.hostname
        ? cache.hostname + (cache.site_name ? ` (${cache.site_name})` : '')
        : agentId,
      acao: 'SCRIPT_EXECUTADO', campo: script.name || `Script #${scriptId}`,
      valorNovo: args.join(' ') || null,
      usuario: req.user.email, usuarioId: req.user.sub
    });
    res.json(await deviceService.rodarScriptFavorito(agentId, scriptId, args));
  } catch (err) {
    res.status(502).json({ error: 'Falha ao executar o script: ' + err.message });
  }
}));

// Máquinas que o portal /chamados oferece no select "Selecione a máquina...".
// A unidade da máquina é o SITE do Tactical RMM (client INTECS → SEDE e
// servidores; client UNIDADES → um site por loja). A regra fica aqui no
// servidor e o front só obedece ao "modo":
//   permissão chamados_ver_todas_maquinas (TECNICO por padrão; nos demais é
//   toggle por usuário) → lista completa de agentes;
//   SEDE ou sem unidade → lista vazia: o portal mostra apenas a máquina
//             detectada (e, sem detecção, permite abrir sem equipamento);
//   UNIDADE → só as máquinas do site da unidade do usuário (site ainda não
//             criado no RMM → lista vazia, mesmo caminho da detecção).
app.get('/api/chamados-intecs/maquinas', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const norm = (v) => trim(v).toUpperCase();
  const unidade = norm(req.perfilCI.unidade);
  const agentes = await deviceService.listarAgentesDisponiveis();
  const item = (a) => ({
    tactical_agent_id: a.tactical_agent_id,
    hostname: a.hostname,
    unidade: a.site_name,
    status_online: !!a.status_online,
    logged_username: a.logged_username || null
  });

  if (req.perfilCI.permissoesEfetivas.chamados_ver_todas_maquinas) {
    return res.json({ modo: 'UNIDADE', maquinas: agentes.map(item) });
  }
  if (unidade === 'SEDE' || !unidade) return res.json({ modo: 'SEDE', maquinas: [] });

  const daUnidade = agentes.filter((a) => norm(a.site_name) === unidade);
  res.json({ modo: 'UNIDADE', maquinas: daUnidade.map(item) });
}));

// ===================== NOTIFICAÇÕES DOS CHAMADOS INTECS =====================
// O sininho só existe no admin, e só TECNICO/MASTER usam o admin. BASICO e
// GESTOR trabalham no portal /chamados, que não tem sininho — para eles o
// e-mail é o único canal.
const SININHO_CHAMADOS = ['TECNICO', 'MASTER'];

// Nome legível do equipamento vinculado, para a ficha do e-mail.
// Falha de RMM/banco não pode impedir o aviso: no pior caso vai sem o campo.
async function nomeEquipamentoDoChamado(chamado) {
  if (!chamado?.device_id) return '';
  try {
    const d = await deviceIntecsRepo.getDeviceById(chamado.device_id);
    if (!d) return '';
    const nome = d.nome_amigavel || d.tactical_agent_id || '';
    return d.patrimonio ? `${nome} — PAT ${d.patrimonio}` : nome;
  } catch {
    return '';
  }
}

// Manchete e frase de abertura que o SOLICITANTE lê, por status novo. Status
// customizado cai no genérico — o aviso continua saindo, só sem texto próprio.
// 'tile' escolhe o ícone e a cor do topo do e-mail (ver emailChamado.js).
const TEXTO_SOLICITANTE = {
  EM_ATENDIMENTO: {
    tile: 'resposta',
    titulo: 'Seu chamado está em atendimento',
    chamada: 'Um técnico já está cuidando disso. Avisamos assim que houver novidade.'
  },
  AGUARDANDO_USUARIO: {
    tile: 'aguardando',
    titulo: 'Precisamos de uma informação sua',
    chamada: 'A equipe de TI respondeu e está aguardando seu retorno para continuar o atendimento.'
  },
  RESOLVIDO: {
    tile: 'resolvido',
    titulo: 'Seu chamado foi resolvido',
    chamada: 'Se o problema voltar a acontecer, é só responder pelo portal que reabrimos o atendimento.'
  },
  FECHADO: {
    tile: 'fechado',
    titulo: 'Seu chamado foi encerrado',
    chamada: 'O atendimento foi concluído e o chamado está fechado.'
  },
  CANCELADO: {
    tile: 'cancelado',
    titulo: 'Seu chamado foi cancelado',
    chamada: 'Se ainda precisar de ajuda, abra um novo chamado pelo portal.'
  }
};
const tituloParaSolicitante = (status) =>
  TEXTO_SOLICITANTE[status]?.titulo || `Seu chamado está como ${rotular(status)}`;
const chamadaParaSolicitante = (status) =>
  TEXTO_SOLICITANTE[status]?.chamada || 'O status do seu chamado foi atualizado pela equipe de TI.';
const tileParaSolicitante = (status) => TEXTO_SOLICITANTE[status]?.tile || 'generico';

// Identificação da máquina pelo AgentID que o próprio agente Tactical grava em
// HKLM\SOFTWARE\TacticalRMM. Chega ao front pelo atalho ?agent= distribuído por
// script do RMM. É exato — ao contrário do IP, que atrás de NAT aponta para a
// rede inteira. Caminho preferencial; o verificar-maquina abaixo é o fallback.
app.get('/api/chamados-intecs/agente/:agentId', exigirAuth, wrap(async (req, res) => {
  const agentId = trim(req.params.agentId || '');
  if (!agentId) return res.status(400).json({ error: 'Informe o agente.' });
  const resumo = await deviceService.getResumoAgente(agentId);
  if (!resumo) return res.status(404).json({ error: 'Agente não encontrado no Tactical RMM.' });
  res.json(resumo);
}));

// Detecção da máquina do usuário no momento da abertura do chamado, por IP
// da requisição (sem vínculo fixo usuário<->equipamento).
app.post('/api/chamados-intecs/verificar-maquina', exigirAuth, wrap(async (req, res) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket.remoteAddress || '';
  // x-forwarded-for é enviado pelo cliente: sem esse filtro, um "%" viraria
  // curinga no LIKE da busca e devolveria a lista inteira de agentes.
  const ipLimpo = /^[0-9a-fA-F:.]+$/.test(ip) ? ip.replace('::ffff:', '') : '';
  const matches = ipLimpo ? await deviceService.detectarAgentesPorIp(ipLimpo) : [];
  res.json({ ip: ipLimpo, matches });
}));

app.get('/api/chamados-intecs/meu-perfil', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  res.json({
    id: req.perfilCI.id, email: req.perfilCI.email, role: req.perfilCI.role,
    unidade: req.perfilCI.unidade, setor: req.perfilCI.setor,
    permissoes: req.perfilCI.permissoesEfetivas
  });
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
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'CATEGORIA_CRIADA',
    entidadeRotulo: `Categoria "${nome}"`, valorNovo: nome,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json(categoria);
}));

app.post('/api/chamados-intecs/subcategorias', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const nome = trim(req.body.nome || '');
  const categoriaId = Number(req.body.categoria_id);
  if (!nome || !categoriaId) return res.status(400).json({ error: 'Informe categoria e nome da subcategoria.' });
  const subcategoria = await chamadosIntecsRepo.criarSubcategoria(categoriaId, nome);
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'SUBCATEGORIA_CRIADA',
    entidadeRotulo: `Subcategoria "${nome}"`, valorNovo: nome,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json(subcategoria);
}));

app.delete('/api/chamados-intecs/categorias/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const nomeCat = (await query('SELECT nome FROM dbo.EQUIPSTI_chamados_intecs_categorias WHERE id = @id', { id })).recordset[0]?.nome;
  await chamadosIntecsRepo.removerCategoria(req.params.id);
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'CATEGORIA_EXCLUIDA',
    entidadeRotulo: `Categoria "${nomeCat || id}"`, valorAnterior: nomeCat || String(id),
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ ok: true });
}));

app.delete('/api/chamados-intecs/subcategorias/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const nomeSub = (await query('SELECT nome FROM dbo.EQUIPSTI_chamados_intecs_subcategorias WHERE id = @id', { id })).recordset[0]?.nome;
  await chamadosIntecsRepo.removerSubcategoria(req.params.id);
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'SUBCATEGORIA_EXCLUIDA',
    entidadeRotulo: `Subcategoria "${nomeSub || id}"`, valorAnterior: nomeSub || String(id),
    usuario: req.user.email, usuarioId: req.user.sub
  });
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
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'PRIORIDADE_CRIADA',
    entidadeRotulo: `Prioridade "${nome}"`,
    valorNovo: `resposta ${slaResposta}h · conclusão ${slaConclusao}h`,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json(prioridade);
}));

app.put('/api/chamados-intecs/prioridades/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const slaResposta = Number(req.body.sla_resposta_horas);
  const slaConclusao = Number(req.body.sla_conclusao_horas);
  if (!slaResposta || !slaConclusao) return res.status(400).json({ error: 'Informe horas de resposta e conclusão.' });
  const antesP = (await query('SELECT nome, sla_resposta_horas, sla_conclusao_horas, ordem FROM dbo.EQUIPSTI_chamados_intecs_prioridades WHERE id = @id', { id })).recordset[0] || {};
  await chamadosIntecsRepo.atualizarPrioridade(req.params.id, {
    sla_resposta_horas: slaResposta, sla_conclusao_horas: slaConclusao,
    cor: trim(req.body.cor || ''), ordem: Number(req.body.ordem) || 0
  });
  const resumoP = (r) => `resposta ${r.sla_resposta_horas ?? '—'}h · conclusão ${r.sla_conclusao_horas ?? '—'}h · ordem ${r.ordem ?? '—'}`;
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'PRIORIDADE_ATUALIZADA',
    entidadeRotulo: `Prioridade "${antesP.nome || id}"`,
    valorAnterior: resumoP(antesP),
    valorNovo: resumoP({ sla_resposta_horas: slaResposta, sla_conclusao_horas: slaConclusao, ordem: Number(req.body.ordem) || 0 }),
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ ok: true });
}));

app.delete('/api/chamados-intecs/prioridades/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const nomeP = (await query('SELECT nome FROM dbo.EQUIPSTI_chamados_intecs_prioridades WHERE id = @id', { id })).recordset[0]?.nome;
  await chamadosIntecsRepo.removerPrioridade(req.params.id);
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'PRIORIDADE_EXCLUIDA',
    entidadeRotulo: `Prioridade "${nomeP || id}"`, valorAnterior: nomeP || String(id),
    usuario: req.user.email, usuarioId: req.user.sub
  });
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
    nome, tipo_sistema: tipoSistema, cor: trim(req.body.cor || ''), ordem: Number(req.body.ordem) || 0,
    notifica_solicitante: req.body.notifica_solicitante === true
  });
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'STATUS_CRIADO',
    entidadeRotulo: `Status "${nome}"`, valorNovo: `${nome} (${tipoSistema})`,
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.status(201).json(status);
}));

app.put('/api/chamados-intecs/status-config/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const tipoSistema = trim(req.body.tipo_sistema || '');
  const tiposValidos = ['ABERTO', 'ANDAMENTO', 'RESOLVIDO', 'FECHADO', 'CANCELADO'];
  if (!tiposValidos.includes(tipoSistema)) return res.status(400).json({ error: 'Tipo de sistema inválido.' });
  const antesS = (await query('SELECT nome, tipo_sistema, ordem FROM dbo.EQUIPSTI_chamados_intecs_status WHERE id = @id', { id })).recordset[0] || {};
  await chamadosIntecsRepo.atualizarStatus(req.params.id, {
    tipo_sistema: tipoSistema, cor: trim(req.body.cor || ''), ordem: Number(req.body.ordem) || 0,
    notifica_solicitante: req.body.notifica_solicitante // undefined = preserva o valor atual
  });
  const resumoS = (r) => `${r.tipo_sistema || '—'} · ordem ${r.ordem ?? '—'}`;
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'STATUS_ATUALIZADO',
    entidadeRotulo: `Status "${antesS.nome || id}"`,
    valorAnterior: resumoS(antesS),
    valorNovo: resumoS({ tipo_sistema: tipoSistema, ordem: Number(req.body.ordem) || 0 }),
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ ok: true });
}));

app.delete('/api/chamados-intecs/status-config/:id', exigirAuth, carregarPerfilChamados, exigirPapel('TECNICO', 'MASTER'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const nomeS = (await query('SELECT nome FROM dbo.EQUIPSTI_chamados_intecs_status WHERE id = @id', { id })).recordset[0]?.nome;
  await chamadosIntecsRepo.removerStatus(req.params.id);
  await registrarLog({
    modulo: 'CHAMADOS_INTECS', acao: 'STATUS_EXCLUIDO',
    entidadeRotulo: `Status "${nomeS || id}"`, valorAnterior: nomeS || String(id),
    usuario: req.user.email, usuarioId: req.user.sub
  });
  res.json({ ok: true });
}));

// ---------- Administração (só Master) ----------

// Catálogo de permissões (chaves, rótulos e padrões por papel) — o modal
// de edição usa para montar os switches e resetá-los ao trocar o papel.
app.get('/api/chamados-intecs/permissoes/catalogo', exigirAuth, carregarPerfilChamados, exigirPapel('MASTER'), wrap(async (req, res) => {
  res.json({ chaves: CHAVES_PERMISSOES, padroes: PADROES_POR_PAPEL, rotulos: ROTULOS });
}));

app.get('/api/chamados-intecs/usuarios', exigirAuth, carregarPerfilChamados, exigirPapel('MASTER'), exigirPermissao('aba_usuarios'), wrap(async (req, res) => {
  const usuarios = await chamadosIntecsRepo.listarUsuariosComPapel();
  // Nunca vaza o JSON cru de overrides: o front recebe as efetivas + o flag "PAPEL+".
  res.json(usuarios.map((u) => ({
    id: u.id, email: u.email, role: u.role, unidade: u.unidade, setor: u.setor, ativo: u.ativo,
    permissoes: permissoesEfetivas(u.role, u.permissoes),
    permissoes_customizadas: isCustomizado(u.role, u.permissoes)
  })));
}));

app.put('/api/chamados-intecs/usuarios/:id', exigirAuth, carregarPerfilChamados, exigirPapel('MASTER'), exigirPermissao('aba_usuarios'), wrap(async (req, res) => {
  const role = trim(req.body.role || 'BASICO');
  if (!papelValido(role)) return res.status(400).json({ error: 'Papel inválido: ' + role });
  const unidade = trim(req.body.unidade || '') || null;
  const setor = trim(req.body.setor || '') || null;

  const atual = (await query(
    'SELECT email, role, unidade, setor, permissoes FROM dbo.EQUIPSTI_usuarios WHERE id = @id',
    { id: { type: sql.Int, value: Number(req.params.id) } }
  )).recordset[0];
  if (!atual) return res.status(404).json({ error: 'Usuário não encontrado.' });

  // O front manda o estado COMPLETO dos switches; grava-se só o diff vs. o
  // padrão do papel (NULL = padrão puro). Sem `permissoes` no body: mantém os
  // overrides atuais — a menos que o papel mude (aí reseta, para não sobrar
  // override órfão calculado contra o papel antigo).
  let permissoesJson = null;
  if (req.body.permissoes !== undefined) {
    const v = validarPermissoes(req.body.permissoes);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    const overrides = calcularOverrides(role, req.body.permissoes);
    permissoesJson = overrides ? JSON.stringify(overrides) : null;
  } else if (role === atual.role) {
    permissoesJson = atual.permissoes;
  }

  await chamadosIntecsRepo.atualizarPapelUsuario(req.params.id, { role, unidade, setor, permissoesJson });

  // Auditoria: papel, unidade, setor e o diff de permissões efetivas (que cobre
  // o toggle "ver todas as máquinas"). Rótulo = e-mail do usuário afetado.
  const idAlvo = String(Number(req.params.id));
  const rotuloAlvo = atual.email || `Usuário #${idAlvo}`;
  const logCampoUser = async (campo, de, para) => {
    if (logMudou(de, para)) {
      await registrarLog({
        modulo: 'USUARIOS', entidadeId: idAlvo, entidadeRotulo: rotuloAlvo,
        acao: 'ATUALIZADO', campo, valorAnterior: de, valorNovo: para,
        usuario: req.user.email, usuarioId: req.user.sub
      });
    }
  };
  await logCampoUser('PAPEL', atual.role, role);
  await logCampoUser('UNIDADE', atual.unidade, unidade);
  await logCampoUser('SETOR', atual.setor, setor);

  const efAntes = permissoesEfetivas(atual.role, atual.permissoes);
  const efDepois = permissoesEfetivas(role, permissoesJson);
  const chavesMud = Object.keys(efDepois).filter((k) => efAntes[k] !== efDepois[k]);
  if (chavesMud.length) {
    const fmt = (ef) => chavesMud.map((k) => `${ROTULOS[k] || k}: ${ef[k] ? 'SIM' : 'NÃO'}`).join('; ');
    await registrarLog({
      modulo: 'USUARIOS', entidadeId: idAlvo, entidadeRotulo: rotuloAlvo,
      acao: 'ATUALIZADO', campo: 'PERMISSÕES',
      valorAnterior: fmt(efAntes), valorNovo: fmt(efDepois),
      usuario: req.user.email, usuarioId: req.user.sub
    });
  }
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
      ({ device, snapshotId } = await deviceService.vincularEquipamento(tacticalAgentId, req.user.sub));
    } catch (err) {
      // RMM fora do ar não pode impedir a abertura do chamado.
      console.error('[chamados-intecs] falha ao vincular equipamento:', err.message);
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

  await chamadosIntecsRepo.registrarHistorico(chamado.id, req.user.sub, 'CRIADO', null, null, titulo, req.user.email, titulo);

  const ator = { id: req.user.sub, email: req.user.email };
  const chamadoCompleto = await chamadosIntecsRepo.getChamadoIntecs(chamado.id);
  const equipamento = await nomeEquipamentoDoChamado(chamadoCompleto);

  await notificar({
    tipo: 'CHAMADO', acao: 'CRIADO', link: 'tab-chamados', refId: chamado.id,
    papeis: SININHO_CHAMADOS, email: true,
    emailPapeis: ['TECNICO', 'MASTER'], // quem atende — usuários básicos não recebem
    ator,
    titulo: 'Novo chamado INTECS',
    mensagem: `${req.user.email} abriu o chamado "${titulo}".`,
    corpo: emailParaEquipe({
      chamado: chamadoCompleto, equipamento, autor: req.user.email,
      tile: 'recibo', titulo: 'Novo chamado INTECS',
      chamada: `${req.user.email} abriu um chamado.`
    })
  });

  // Recibo para quem abriu. notificarSolicitante() pula quando o autor é o
  // próprio dono, então aqui o envio é direto — é justamente para ele.
  await notificarSolicitante({
    chamado: chamadoCompleto, ator: { id: 0, email: req.user.email }, equipamento,
    tile: 'recibo',
    titulo: 'Recebemos seu chamado', // o nº já vai no assunto, via emailParaSolicitante
    chamada: 'A equipe de TI já foi avisada. Você recebe um e-mail a cada resposta ou mudança de status.'
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

// Só título + status dos mais urgentes — o cockpit lista linhas, não a
// tabela inteira (isso já existe em /api/chamados-intecs).
app.get('/api/chamados-intecs/recentes', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const { role, unidade, setor } = req.perfilCI;
  if (role === 'BASICO') return res.status(403).json({ error: 'Sem acesso.' });
  if (role === 'GESTOR') {
    const equipes = (unidade && setor) ? [{ unidade, setor }] : [];
    const usuarioIds = await chamadosIntecsRepo.getUsuarioIdsDaEquipe(equipes);
    return res.json(await chamadosIntecsRepo.getRecentesAbertos(usuarioIds));
  }
  res.json(await chamadosIntecsRepo.getRecentesAbertos());
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
      await chamadosIntecsRepo.registrarHistorico(chamado.id, req.user.sub, acao, campo, antes, depois, req.user.email, chamado.titulo);
    }
  }

  const atualizado = await chamadosIntecsRepo.getChamadoIntecs(chamado.id);

  // Notifica POR TIPO de mudança, e não uma vez só para o lote: status importa
  // ao solicitante, responsável importa a quem assumiu, prioridade e categoria
  // são triagem interna e ficam só no sininho.
  if (historicoEntradas.length) {
    const ator = { id: req.user.sub, email: req.user.email };
    const mudouStatus = historicoEntradas.find(([acao]) => acao === 'STATUS');
    const mudouResponsavel = historicoEntradas.find(([acao]) => acao === 'RESPONSAVEL');
    const equipamento = await nomeEquipamentoDoChamado(atualizado);

    if (mudouStatus) {
      const [, , statusAntes, statusDepois] = mudouStatus;
      const mudancas = [{ campo: 'Status', de: statusAntes, para: statusDepois }];
      await notificar({
        tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', refId: chamado.id,
        papeis: SININHO_CHAMADOS, email: false, ator,
        titulo: 'Status do chamado alterado',
        mensagem: `#${chamado.id} "${chamado.titulo}": ${statusAntes} → ${statusDepois}.`
      });
      // Só avisa o solicitante quando o status novo está marcado para isso
      // (coluna notifica_solicitante) — evita e-mail de troca interna de fila.
      if (await chamadosIntecsRepo.statusNotificaSolicitante(statusDepois)) {
        await notificarSolicitante({
          chamado: atualizado, ator, equipamento, mudancas,
          tile: tileParaSolicitante(statusDepois),
          titulo: tituloParaSolicitante(statusDepois),
          chamada: chamadaParaSolicitante(statusDepois)
        });
      }
    }

    if (mudouResponsavel && atualizado.responsavel_id) {
      await notificar({
        tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', refId: chamado.id,
        papeis: SININHO_CHAMADOS, email: true,
        emailPapeis: [], emailUsuarioIds: [atualizado.responsavel_id], ator,
        titulo: 'Chamado atribuído a você',
        mensagem: `#${chamado.id} "${chamado.titulo}" está sob sua responsabilidade.`,
        corpo: emailParaEquipe({
          chamado: atualizado, equipamento, autor: req.user.email,
          tile: 'generico', titulo: 'Chamado atribuído a você',
          chamada: `${req.user.email} atribuiu este chamado a você.`
        })
      });
    }

    // Prioridade e categoria: só sininho da equipe, sem e-mail para ninguém.
    const soTriagem = historicoEntradas.filter(([acao]) => ['PRIORIDADE', 'CATEGORIA'].includes(acao));
    if (soTriagem.length) {
      const resumo = soTriagem.map(([acao, , antes, depois]) => `${acao.toLowerCase()}: ${antes ?? '—'} → ${depois ?? '—'}`).join('; ');
      await notificar({
        tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', refId: chamado.id,
        papeis: SININHO_CHAMADOS, email: false, ator,
        titulo: 'Chamado reclassificado',
        mensagem: `#${chamado.id} "${chamado.titulo}" — ${resumo}.`
      });
    }
  }

  res.json(atualizado);
}));

app.post('/api/chamados-intecs/:id/comentarios', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const chamado = await chamadosIntecsRepo.getChamadoIntecs(req.params.id);
  if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
  // Atendente só comenta no chamado atribuído a ele (mesmo sendo o solicitante);
  // solicitante comum comenta no próprio chamado, como sempre.
  const daEquipe = ['TECNICO', 'MASTER'].includes(req.perfilCI.role);
  const podeComentar = daEquipe
    ? chamado.responsavel_id === req.perfilCI.id
    : chamado.usuario_id === req.perfilCI.id;
  if (!podeComentar) {
    return res.status(403).json({ error: daEquipe
      ? 'Atribua o chamado a você para enviar um comentário.'
      : 'Sem permissão para comentar neste chamado.' });
  }
  const texto = trim(req.body.texto || '');
  if (!texto) return res.status(400).json({ error: 'Escreva um comentário.' });

  const comentario = await chamadosIntecsRepo.criarComentario(chamado.id, req.user.sub, texto);
  await chamadosIntecsRepo.registrarHistorico(chamado.id, req.user.sub, 'COMENTARIO', null, null, texto.slice(0, 200), req.user.email, chamado.titulo);
  if (!chamado.sla_respondido_em) {
    await chamadosIntecsRepo.atualizarCamposChamado(chamado.id, { sla_respondido_em: new Date() });
  }
  const ator = { id: req.user.sub, email: req.user.email };
  const chamadoCompleto = await chamadosIntecsRepo.getChamadoIntecs(chamado.id);
  const equipamento = await nomeEquipamentoDoChamado(chamadoCompleto);

  // Sininho é sempre da equipe. O e-mail vai na direção contrária a quem
  // escreveu: solicitante escreveu -> avisa quem atende; equipe respondeu ->
  // o solicitante recebe o e-mail dele (abaixo) e, entre a equipe, só o
  // responsável é avisado, para o resto não virar cópia de conversa alheia.
  // O responsável entra por id porque pode não ter papel TECNICO.
  await notificar({
    tipo: 'CHAMADO', acao: 'ATUALIZADO', link: 'tab-chamados', refId: chamado.id,
    papeis: SININHO_CHAMADOS, ator,
    email: true,
    emailPapeis: daEquipe ? [] : ['TECNICO', 'MASTER'],
    emailUsuarioIds: chamado.responsavel_id ? [chamado.responsavel_id] : [],
    titulo: 'Novo comentário no chamado INTECS',
    mensagem: `${req.user.email} comentou no chamado "${chamado.titulo}".`,
    corpo: emailParaEquipe({
      chamado: chamadoCompleto, equipamento, autor: req.user.email, comentario: texto,
      tile: 'resposta', titulo: 'Novo comentário no chamado INTECS',
      chamada: 'Novo comentário no chamado.'
    })
  });

  if (daEquipe) {
    await notificarSolicitante({
      chamado: chamadoCompleto, ator, equipamento, comentario: texto,
      tile: 'resposta',
      titulo: 'A equipe de TI respondeu seu chamado',
      chamada: 'Você pode responder pelo portal, no próprio chamado.'
    });
  }

  res.status(201).json(comentario);
}));

app.get('/api/chamados-intecs/:id/equipamento', exigirAuth, carregarPerfilChamados, wrap(async (req, res) => {
  const chamado = await chamadosIntecsRepo.getChamadoIntecs(req.params.id);
  if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
  if (!(await podeVerChamado(req.perfilCI, chamado))) return res.status(403).json({ error: 'Sem acesso a este chamado.' });
  if (!chamado.device_id) return res.json(null);
  const resumo = await deviceService.getDeviceSummary(chamado.device_id);
  if (!resumo) return res.json(null);

  // Identifica a máquina vinculada para o front oferecer a conexão remota
  // (Conectar/Terminal/Arquivos) direto do detalhe do chamado. Hostname e
  // status vêm do cache de agentes (mesma fonte da aba Conexão Remota);
  // fallback para o nome do device e o status do snapshot.
  const device = await deviceIntecsRepo.getDeviceById(chamado.device_id);
  const agente = device?.tactical_agent_id ? await deviceIntecsRepo.getAgenteCache(device.tactical_agent_id) : null;
  res.json({
    ...resumo,
    tactical_agent_id: device?.tactical_agent_id || null,
    maquina: {
      hostname: agente?.hostname || device?.nome_amigavel || null,
      status_online: agente ? !!agente.status_online : !!resumo.status_online,
      site_name: agente?.site_name || null,
      // Linux só conecta pelo terminal (Remote Background) — o front esconde o resto.
      plat: agente?.plat || null
    }
  });
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

// ===================== LOGS (auditoria unificada) =====================
// Aba "Logs" global + ícones de histórico por aba. Só quem tem aba_logs (MASTER
// por padrão; liberável por usuário). exigirPermissao carrega o perfil sozinho.
app.get('/api/logs', exigirAuth, exigirPermissao('aba_logs'), wrap(async (req, res) => {
  const modulo = MODULOS_LOG.includes(req.query.modulo) ? req.query.modulo : null;
  const q = trim(req.query.q || '') || null;
  const de = req.query.de ? new Date(req.query.de) : null;
  const ate = req.query.ate ? new Date(req.query.ate) : null;
  // ?seguranca=alerta|todos — recorte usado pelo card de avisos do dashboard
  // e do cockpit. Valor fora da whitelist é ignorado (vira listagem normal).
  const seguranca = NIVEIS_SEGURANCA.includes(req.query.seguranca) ? req.query.seguranca : null;
  const linhas = await listarLogs({
    modulo, q, seguranca,
    de: de && !isNaN(de) ? de : null,
    ate: ate && !isNaN(ate) ? ate : null,
    limit: parseInt(req.query.limit, 10) || 50,
    offset: parseInt(req.query.offset, 10) || 0
  });
  res.json(linhas);
}));

// ===================== LOGS DO GOOGLE DRIVE (Admin SDK Reports) =====================
// Fonte "Google Drive" da aba Logs. Mesma régua da auditoria interna
// (aba_logs, MASTER por padrão) — é log de quem mexeu em arquivo de quem.
// Falta de setup no servidor é 503 (igual à aba Senhas sem SENHAS_CHAVE);
// falha ao falar com o Google é 502, como nas outras integrações externas.
const SEM_GOOGLE = 'Google Workspace não configurado: preencha GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY e GOOGLE_ADMIN_SUBJECT no .env.';
const erroDrive = (res, err) => {
  console.warn('[googledrive]', err.message);
  res.status(502).json({ error: err.message });
};

// Lê o que já está gravado. Nunca fala com o Google — a tela abre instantânea
// e o sync vem atrás (mesmo padrão da Conexão Remota).
app.get('/api/drive-logs', exigirAuth, exigirPermissao('aba_logs'), wrap(async (req, res) => {
  const de = req.query.de ? new Date(req.query.de) : null;
  const ate = req.query.ate ? new Date(req.query.ate) : null;
  const eventos = trim(req.query.eventos)
    ? trim(req.query.eventos).split(',').map((e) => e.trim()).filter(Boolean)
    : null;

  const linhas = await googleDrive.listarEventos({
    q: trim(req.query.q) || null,
    eventos,
    proprietario: trim(req.query.proprietario) || null,
    de: de && !isNaN(de) ? de : null,
    ate: ate && !isNaN(ate) ? ate : null,
    limit: parseInt(req.query.limit, 10) || 50,
    offset: parseInt(req.query.offset, 10) || 0
  });
  res.json(linhas);
}));

// Donos distintos, para o select da toolbar.
app.get('/api/drive-logs/proprietarios', exigirAuth, exigirPermissao('aba_logs'), wrap(async (req, res) => {
  res.json(await googleDrive.listarProprietarios());
}));

// Puxa o que falta desde o último evento gravado. ?forcar=1 ignora o TTL de
// 5 min (é o botão "Atualizar" da toolbar).
app.post('/api/drive-logs/sync', exigirAuth, exigirPermissao('aba_logs'), wrap(async (req, res) => {
  if (!googleDrive.configurado()) return res.status(503).json({ error: SEM_GOOGLE });
  try {
    const r = await googleDrive.sincronizar({ forcar: req.query.forcar === '1' });
    res.json(r);
  } catch (err) {
    erroDrive(res, err);
  }
}));

// Visualizações (eventName=view): consulta ao vivo, nada é gravado.
app.get('/api/drive-logs/visualizacoes', exigirAuth, exigirPermissao('aba_logs'), wrap(async (req, res) => {
  if (!googleDrive.configurado()) return res.status(503).json({ error: SEM_GOOGLE });
  const de = req.query.de ? new Date(req.query.de) : null;
  const ate = req.query.ate ? new Date(req.query.ate) : null;
  if (!de || isNaN(de) || !ate || isNaN(ate)) {
    return res.status(400).json({ error: 'Informe o período (de/até) para consultar as visualizações.' });
  }
  if (ate - de > googleDrive.MAX_DIAS_AO_VIVO * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: `A consulta de visualizações cobre no máximo ${googleDrive.MAX_DIAS_AO_VIVO} dias.` });
  }
  try {
    const r = await googleDrive.listarVisualizacoes({ de, ate, pageToken: trim(req.query.pageToken) || null });
    res.json(r);
  } catch (err) {
    erroDrive(res, err);
  }
}));

// Amostra crua da API: confere quais parâmetros este domínio realmente manda
// (em especial se existe client_type) e quais originating_app_id aparecem —
// é daí que sai o mapa APPS_CONHECIDOS do service.
app.get('/api/drive-logs/diagnostico', exigirAuth, exigirPermissao('aba_logs'), wrap(async (req, res) => {
  if (!googleDrive.configurado()) return res.status(503).json({ error: SEM_GOOGLE });
  try {
    res.json(await googleDrive.amostraDiagnostico({ horas: req.query.horas }));
  } catch (err) {
    erroDrive(res, err);
  }
}));

// ===================== ESTÁTICO (front-end vanilla) =====================
app.get('/chamados', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chamados.html')));
// Painel de parede: tela cheia, sem interação, aberto em aba própria pelo
// dashboard. Sem gate aqui — os blocos herdam a permissão de cada endpoint.
app.get('/cockpit', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cockpit.html')));
// Buscador do catálogo de e-mails: como /chamados, a rota é aberta e quem
// exige login é o conteúdo (GET /api/emails).
app.get('/emails', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'emails.html')));
app.use(express.static(PUBLIC_DIR));

// ===================== AGENDAMENTO =====================
// Milissegundos até a próxima ocorrência de HH:00 no fuso de São Paulo. O
// processo roda em UTC de propósito (ver Dockerfile), então o horário local
// precisa vir do Intl — getHours() daria a hora UTC. É a mesma razão de
// hojeEmSaoPaulo() lá em cima.
function msAteHoraSaoPaulo(hora) {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const valor = (tipo) => Number(partes.find((p) => p.type === tipo).value);
  const agora = valor('hour') * 3600 + valor('minute') * 60 + valor('second');
  const faltam = (hora * 3600 - agora + 86400) % 86400;
  // faltam === 0 significa "é exatamente a hora agora": agenda para amanhã,
  // senão o timer dispararia em rajada dentro do mesmo segundo.
  return (faltam || 86400) * 1000;
}

// Roda fn todo dia na hora indicada. Reagenda a cada disparo em vez de usar
// setInterval de 24h: assim não acumula desvio e acompanha o fuso se o horário
// de verão voltar algum dia.
function agendarDiario(hora, fn) {
  const proximo = () => setTimeout(() => { fn(); proximo(); }, msAteHoraSaoPaulo(hora));
  proximo();
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API + app em http://localhost:${PORT}`);
});

// Avisos do calendário às 07h de Brasília. Antes era "a cada 6h a partir do
// boot", o que fazia cada deploy embaralhar o horário — um aviso de "vence
// hoje" podia sair às 03h da manhã. Não há disparo no boot de propósito, pelo
// mesmo motivo; rodarLembretesCalendario() é idempotente (ultimo_aviso_data),
// então um dia perdido por deploy exatamente às 07h se resolve no dia seguinte.
const HORA_LEMBRETES = 7;
agendarDiario(HORA_LEMBRETES, () => rodarLembretesCalendario()
  .then((n) => { if (n) console.log(`Calendário: ${n} aviso(s) enviado(s).`); })
  .catch((e) => console.error('Lembretes calendário:', e.message)));
console.log(`Lembretes do calendário: próximo disparo em ${Math.round(msAteHoraSaoPaulo(HORA_LEMBRETES) / 60000)} min (${HORA_LEMBRETES}h de Brasília).`);

// Expurgo das notificações antigas, de madrugada. O sininho só enxerga os
// últimos 3 dias, mas nada nunca apagava o resto: a tabela só crescia. 90 dias
// é folga generosa sobre a janela de leitura.
agendarDiario(3, () => query(
  'DELETE FROM dbo.EQUIPSTI_notificacoes WHERE criado_em < DATEADD(day, -90, SYSUTCDATETIME())')
  .then((r) => {
    const n = r.rowsAffected?.[0] || 0;
    if (n) console.log(`Notificações: ${n} linha(s) antiga(s) removida(s).`);
  })
  .catch((e) => console.error('Expurgo de notificações:', e.message)));

// Auditoria do Drive: o Google só guarda 6 meses, então não dá para depender
// só de alguém abrir a aba. Aqui o horário não importa (é sincronização de
// dados, não aviso para gente), então segue relativo ao boot.
if (googleDrive.configurado()) {
  const sincronizarDrive = () => googleDrive.sincronizar()
    .then((r) => { if (r.inseridos) console.log(`Google Drive: ${r.inseridos} evento(s) novo(s).`); })
    .catch((e) => console.error('Sync Google Drive:', e.message));
  setTimeout(sincronizarDrive, 60_000);
  setInterval(sincronizarDrive, 6 * 60 * 60 * 1000);
}
