// ============================================================
//  TODO: tarefas por usuário (dbo.EQUIPSTI_todo_tarefas + _compartilhos).
//
//  Modelo em uma frase: 'dono_id' é de quem é a lista onde a task aparece e
//  'criado_por_id' é quem a criou. Iguais = task própria; diferentes = task
//  atribuída por outra pessoa (sempre em TRABALHO e sempre com prazo — a
//  regra do prazo obrigatório vive na rota, aqui só se grava).
//
//  Quem pode fazer o quê NÃO é decidido aqui: as rotas (server/index.js)
//  aplicam a regra e este módulo só lê e grava.
// ============================================================
import { query, sql } from './db.js';
import { permissoesEfetivas } from './permissoes.js';
import { notificar } from './notificacoes.js';

export const LISTAS = ['TRABALHO', 'PESSOAL'];

const I = (v) => ({ type: sql.Int, value: v == null ? null : Number(v) });
const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });

// prazo/datas saem como texto (YYYY-MM-DD) para não passar por fuso no JSON.
const SELECT_TAREFA = `
  SELECT t.id, t.dono_id AS donoId, t.criado_por_id AS criadoPorId, t.lista, t.titulo,
         CONVERT(varchar(10), t.prazo, 120) AS prazo, t.concluida,
         CONVERT(varchar(19), t.concluida_em, 120) AS concluidaEm,
         CONVERT(varchar(19), t.criado_em, 120) AS criadoEm,
         d.email AS donoEmail, c.email AS criadoPorEmail
    FROM dbo.EQUIPSTI_todo_tarefas t
    JOIN dbo.EQUIPSTI_usuarios d ON d.id = t.dono_id
    JOIN dbo.EQUIPSTI_usuarios c ON c.id = t.criado_por_id`;

// Pendentes primeiro; dentro delas, as com prazo mais próximo, e sem prazo por último.
const ORDEM = `ORDER BY t.concluida, CASE WHEN t.prazo IS NULL THEN 1 ELSE 0 END, t.prazo, t.id DESC`;

const mapTarefa = (row) => ({ ...row, atribuida: row.donoId !== row.criadoPorId });

// Usuários ativos cuja permissão efetiva inclui a aba TODO. É a única fonte de
// "quem participa": dropdown de listas, destinatários de atribuição e
// compartilhamento. Filtra em JS porque a permissão é padrão do papel + JSON de
// overrides — não dá para decidir isso no WHERE.
export async function usuariosComTodo() {
  const r = await query('SELECT id, email, role, permissoes FROM dbo.EQUIPSTI_usuarios WHERE ativo = 1 ORDER BY email');
  return r.recordset
    .filter((u) => permissoesEfetivas(u.role, u.permissoes).aba_todo)
    .map((u) => ({ id: u.id, email: u.email }));
}

export async function usuarioComTodo(id) {
  return (await usuariosComTodo()).find((u) => u.id === Number(id)) || null;
}

async function comCompartilhos(tarefas) {
  const pessoais = tarefas.filter((t) => t.lista === 'PESSOAL');
  if (!pessoais.length) return tarefas;
  const params = {};
  const nomes = pessoais.map((t, i) => { params['t' + i] = I(t.id); return '@t' + i; });
  const r = await query(
    `SELECT tarefa_id AS tarefaId, usuario_id AS usuarioId FROM dbo.EQUIPSTI_todo_compartilhos
      WHERE tarefa_id IN (${nomes.join(',')})`, params);
  const porTarefa = new Map();
  for (const c of r.recordset) {
    if (!porTarefa.has(c.tarefaId)) porTarefa.set(c.tarefaId, []);
    porTarefa.get(c.tarefaId).push(c.usuarioId);
  }
  return tarefas.map((t) => (t.lista === 'PESSOAL' ? { ...t, compartilhadoCom: porTarefa.get(t.id) || [] } : t));
}

// A lista do próprio usuário: as duas abas + "Atribuídas por mim".
export async function listaPropria(meId) {
  const minhas = (await query(`${SELECT_TAREFA} WHERE t.dono_id = @me ${ORDEM}`, { me: I(meId) })).recordset.map(mapTarefa);
  const atribuidas = (await query(
    `${SELECT_TAREFA} WHERE t.criado_por_id = @me AND t.dono_id <> @me ${ORDEM}`, { me: I(meId) })).recordset.map(mapTarefa);
  return {
    trabalho: minhas.filter((t) => t.lista === 'TRABALHO'),
    pessoal: await comCompartilhos(minhas.filter((t) => t.lista === 'PESSOAL')),
    atribuidas
  };
}

// A lista de outra pessoa, do ponto de vista de quem olha (meId). O filtro da
// aba Pessoal é AQUI, no WHERE — o front nunca recebe uma task não liberada.
export async function listaDeOutro(meId, alvoId) {
  const params = { me: I(meId), alvo: I(alvoId) };
  const trabalho = (await query(
    `${SELECT_TAREFA} WHERE t.dono_id = @alvo AND t.lista = 'TRABALHO' ${ORDEM}`, params)).recordset.map(mapTarefa);
  const pessoal = (await query(
    `${SELECT_TAREFA} WHERE t.dono_id = @alvo AND t.lista = 'PESSOAL'
        AND EXISTS (SELECT 1 FROM dbo.EQUIPSTI_todo_compartilhos c WHERE c.tarefa_id = t.id AND c.usuario_id = @me)
      ${ORDEM}`, params)).recordset.map(mapTarefa);
  return { trabalho, pessoal, pessoalVisivel: pessoal.length > 0 };
}

export async function buscarTarefa(id) {
  const r = await query(`${SELECT_TAREFA} WHERE t.id = @id`, { id: I(id) });
  return r.recordset[0] ? mapTarefa(r.recordset[0]) : null;
}

// Task PESSOAL que outra pessoa liberou para mim?
export async function liberadaPara(tarefaId, usuarioId) {
  const r = await query(
    'SELECT 1 AS ok FROM dbo.EQUIPSTI_todo_compartilhos WHERE tarefa_id = @t AND usuario_id = @u',
    { t: I(tarefaId), u: I(usuarioId) });
  return r.recordset.length > 0;
}

export async function criarTarefa({ donoId, criadoPorId, lista, titulo, prazo }) {
  const r = await query(
    `INSERT INTO dbo.EQUIPSTI_todo_tarefas (dono_id, criado_por_id, lista, titulo, prazo)
     OUTPUT INSERTED.id
     VALUES (@dono, @criador, @lista, @titulo, @prazo)`,
    { dono: I(donoId), criador: I(criadoPorId), lista: S(lista), titulo: S(titulo), prazo: S(prazo) });
  return r.recordset[0].id;
}

// Mudou o prazo → os lembretes valem de novo para a data nova.
export async function atualizarTarefa(id, { titulo, prazo, prazoMudou }) {
  await query(
    `UPDATE dbo.EQUIPSTI_todo_tarefas
        SET titulo = @titulo, prazo = @prazo, atualizado_em = SYSUTCDATETIME()
            ${prazoMudou ? ', aviso_vespera = 0, aviso_dia = 0' : ''}
      WHERE id = @id`,
    { id: I(id), titulo: S(titulo), prazo: S(prazo) });
}

export async function definirConclusao(id, concluida) {
  await query(
    `UPDATE dbo.EQUIPSTI_todo_tarefas
        SET concluida = @c, concluida_em = CASE WHEN @c = 1 THEN SYSUTCDATETIME() ELSE NULL END,
            atualizado_em = SYSUTCDATETIME()
      WHERE id = @id`,
    { id: I(id), c: { type: sql.Bit, value: concluida ? 1 : 0 } });
}

export async function excluirTarefa(id) {
  await query('DELETE FROM dbo.EQUIPSTI_todo_tarefas WHERE id = @id', { id: I(id) });
}

export async function idsCompartilhados(tarefaId) {
  const r = await query('SELECT usuario_id AS id FROM dbo.EQUIPSTI_todo_compartilhos WHERE tarefa_id = @t', { t: I(tarefaId) });
  return r.recordset.map((x) => x.id);
}

// Troca a lista de liberados por completo (o front manda o estado final).
export async function definirCompartilhos(tarefaId, usuarioIds) {
  await query('DELETE FROM dbo.EQUIPSTI_todo_compartilhos WHERE tarefa_id = @t', { t: I(tarefaId) });
  for (const uid of usuarioIds) {
    await query('INSERT INTO dbo.EQUIPSTI_todo_compartilhos (tarefa_id, usuario_id) VALUES (@t, @u)',
      { t: I(tarefaId), u: I(uid) });
  }
}

// ---- Lembretes de prazo --------------------------------------------------
// Toda a aritmética é sobre strings YYYY-MM-DD em UTC "puro", como no
// calendário: o processo roda em UTC (ver Dockerfile), mas o "hoje" que vale é
// o de São Paulo.
export function hojeEmSaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

const somaDias = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export const ymdParaBR = (s) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };

// Sininho (+ push, que segue o escopo dele) para o DONO da task, na véspera e
// no dia do prazo. Só para quem ainda tem a aba TODO. Idempotente: cada aviso
// tem a própria flag, então rodar duas vezes no mesmo dia não repete nada.
// `hoje` é parâmetro só para o teste poder simular outros dias.
export async function rodarLembretes({ hoje = hojeEmSaoPaulo() } = {}) {
  const amanha = somaDias(hoje, 1);
  const r = await query(
    `SELECT id, dono_id AS donoId, criado_por_id AS criadoPorId, titulo,
            CONVERT(varchar(10), prazo, 120) AS prazo
       FROM dbo.EQUIPSTI_todo_tarefas
      WHERE concluida = 0 AND prazo IS NOT NULL
        AND ((CONVERT(varchar(10), prazo, 120) = @amanha AND aviso_vespera = 0)
          OR (CONVERT(varchar(10), prazo, 120) = @hoje AND aviso_dia = 0))`,
    { hoje: S(hoje), amanha: S(amanha) });
  if (!r.recordset.length) return 0;

  const comAba = new Set((await usuariosComTodo()).map((u) => u.id));
  let enviados = 0;
  for (const t of r.recordset) {
    if (!comAba.has(t.donoId)) continue;
    const vespera = t.prazo === amanha;
    await notificar({
      tipo: 'TODO', acao: 'PRAZO',
      titulo: vespera ? 'Task vence amanhã' : 'Task vence hoje',
      mensagem: `${t.titulo}\nPrazo: ${ymdParaBR(t.prazo)}`,
      link: 'tab-todo', refId: t.id,
      ator: { id: 0, email: 'sistema' },
      email: false,
      sininhoUsuarioIds: [t.donoId]
    });
    await query(
      `UPDATE dbo.EQUIPSTI_todo_tarefas SET ${vespera ? 'aviso_vespera' : 'aviso_dia'} = 1 WHERE id = @id`,
      { id: I(t.id) });
    enviados++;
  }
  return enviados;
}
