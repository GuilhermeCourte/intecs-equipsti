// ============================================================
//  App de Revalidação de Inventário — cliente da API (Node + SQL Server)
// ============================================================

// Mesma origem: localmente o Node serve front + API (porta 3000) e na Vercel
// o front e a função /api ficam no mesmo domínio. Por isso, caminho relativo.
const API = '';

let TOKEN = localStorage.getItem('token') || '';

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { sairDoApp(); throw new Error('Sessão expirada. Entre novamente.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
  return data;
}

// ---------- Constantes de domínio ----------
const OPTION_LISTS = ['UNIDADE', 'STATUS', 'SETOR', 'EQUIPAMENTO'];
const FORM_SELECTS = ['unidade', 'status', 'setor', 'equipamento'];
const SELECT_TO_LIST = { unidade: 'UNIDADE', status: 'STATUS', setor: 'SETOR', equipamento: 'EQUIPAMENTO' };
const SEARCHABLE = new Set(['setor', 'edit_setor', 'equipamento', 'edit_equipamento']);
const CHOICES_IDS = [
  'unidade', 'status', 'setor', 'equipamento',
  'edit_unidade', 'edit_status', 'edit_setor', 'edit_equipamento',
  'listaAlvo'
];

// ---------- Estado em memória ----------
let OPTIONS = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [] };
let HIDDEN = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [] };
let REGISTROS = [];
let modalEditar = null;
let modalMsg = null;
let modalAsk = null;
let askResolve = null;
const choicesMap = {};

// ============================================================
//  Utilidades de UI
// ============================================================
const $ = (id) => document.getElementById(id);

// Exibe a mensagem num modal de notificação (substitui os alerts inline).
// O 1º parâmetro (containerId) é mantido por compatibilidade e ignorado.
function showAlert(_containerId, type, message) {
  const cfg = ({
    success: { title: 'Sucesso', icon: 'ph-check-circle', cls: 'msg-success' },
    danger: { title: 'Erro', icon: 'ph-x-circle', cls: 'msg-danger' },
    warning: { title: 'Atenção', icon: 'ph-warning', cls: 'msg-warning' }
  })[type] || { title: 'Aviso', icon: 'ph-info', cls: 'msg-info' };

  $('modalMsgIcon').className = 'msg-icon mb-3 ' + cfg.cls;
  $('modalMsgIcon').innerHTML = '<i class="ph ' + cfg.icon + '"></i>';
  $('modalMsgTitle').textContent = cfg.title;
  $('modalMsgText').textContent = message;

  // Se houver outro modal aberto, espera ele fechar antes de exibir (evita
  // conflito de backdrop entre modais).
  const aberto = document.querySelector('.modal.show');
  if (aberto && aberto.id !== 'modalMsg') {
    aberto.addEventListener('hidden.bs.modal', () => modalMsg.show(), { once: true });
    bootstrap.Modal.getInstance(aberto)?.hide();
  } else {
    modalMsg.show();
  }
}

// ---------- Confirmar / perguntar via modal (substitui confirm/prompt) ----------
function uiAsk({ title, message, input, value, okText, danger }) {
  return new Promise((resolve) => {
    askResolve = resolve;
    $('askTitle').textContent = title || '';
    $('askText').textContent = message || '';
    const inp = $('askInput');
    if (input) { inp.classList.remove('hidden'); inp.value = value || ''; }
    else { inp.classList.add('hidden'); }
    const ok = $('askOk');
    ok.textContent = okText || 'OK';
    ok.className = 'btn ' + (danger ? 'btn-outline-danger' : 'btn-primary');
    modalAsk.show();
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 250);
  });
}

function finishAsk(confirmado) {
  if (!askResolve) return;
  const r = askResolve; askResolve = null;
  const inputVisivel = !$('askInput').classList.contains('hidden');
  r(inputVisivel ? (confirmado ? $('askInput').value : null) : !!confirmado);
  modalAsk.hide();
}

function uiConfirm(message, opts = {}) {
  return uiAsk({
    title: opts.title || 'Confirmar', message,
    okText: opts.okText || 'Confirmar', danger: opts.danger !== false
  });
}

function uiPrompt(message, opts = {}) {
  return uiAsk({
    title: opts.title || '', message,
    input: true, value: opts.value || '', okText: opts.okText || 'Salvar'
  });
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trim(v) { return String(v == null ? '' : v).trim(); }

function initChoices() {
  if (typeof Choices === 'undefined') return;
  CHOICES_IDS.forEach((id) => {
    const el = $(id);
    if (!el || choicesMap[id]) return;
    choicesMap[id] = new Choices(el, {
      searchEnabled: SEARCHABLE.has(id),
      searchPlaceholderValue: 'Buscar...',
      noResultsText: 'Nenhuma opção encontrada',
      noChoicesText: 'Sem opções cadastradas',
      itemSelectText: '',
      shouldSort: false,
      allowHTML: false,
      placeholder: true,
      placeholderValue: 'Selecione...'
    });
  });
}

function fillSelect(selectId, values, selected) {
  const sel = $(selectId);
  const alvo = (selected !== undefined && selected !== null) ? String(selected) : (sel.value || '');
  const inst = choicesMap[selectId];

  if (inst) {
    const lista = [{ value: '', label: 'Selecione...', placeholder: true, selected: !alvo }]
      .concat(values.map((v) => ({ value: v, label: v, selected: alvo === v })));
    inst.setChoices(lista, 'value', 'label', true);
    if (alvo && values.indexOf(alvo) !== -1) inst.setChoiceByValue(alvo);
    return;
  }
  sel.innerHTML = '<option value="">Selecione...</option>';
  values.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
  if (alvo && values.indexOf(alvo) !== -1) sel.value = alvo;
}

// Valores ATIVOS (cadastrados e não ocultos).
function activeValues(list) {
  const hidden = HIDDEN[list] || [];
  return (OPTIONS[list] || []).filter((v) => hidden.indexOf(v) === -1);
}

// Valores para edição: ativos + o valor atual (mesmo que inativo).
function valsParaEdicao(list, atual) {
  const vals = activeValues(list).slice();
  if (atual && vals.indexOf(atual) === -1) vals.unshift(atual);
  return vals;
}

function renderAllSelects() {
  FORM_SELECTS.forEach((id) => fillSelect(id, activeValues(SELECT_TO_LIST[id])));
}

function clearFormSelects() {
  FORM_SELECTS.forEach((id) => fillSelect(id, activeValues(SELECT_TO_LIST[id]), ''));
}

// ============================================================
//  Opções
// ============================================================
async function loadOptions() {
  const data = await api('GET', '/api/options');
  OPTION_LISTS.forEach((l) => {
    const arr = data[l] || [];
    OPTIONS[l] = arr.map((o) => o.valor);
    HIDDEN[l] = arr.filter((o) => o.oculto).map((o) => o.valor);
  });
  renderAllSelects();
  renderListaOpcoes();
}

function renderListaOpcoes() {
  const lista = $('listaAlvo').value;
  $('rotuloLista').textContent = lista;
  const container = $('listaOpcoes');
  const values = OPTIONS[lista] || [];
  if (!values.length) {
    container.innerHTML = '<span class="text-muted">Nenhuma opção cadastrada.</span>';
    return;
  }
  const hidden = HIDDEN[lista] || [];

  const linhas = values.map((v) => {
    const ativo = hidden.indexOf(v) === -1;
    const vEsc = escapeHtml(v);
    const status = ativo
      ? '<span class="badge-status badge-ativo">ATIVO</span>'
      : '<span class="badge-status badge-inativo">INATIVO</span>';
    const toggle = ativo
      ? '<button type="button" class="acao-link acao-ocultar" data-toggle-opt data-val="' +
        vEsc + '" data-hide="1"><i class="ph ph-eye-slash"></i> Ocultar</button>'
      : '<button type="button" class="acao-link acao-exibir" data-toggle-opt data-val="' +
        vEsc + '" data-hide="0"><i class="ph ph-eye"></i> Exibir</button>';
    const editar = '<button type="button" class="acao-link acao-editar ms-3" ' +
      'data-edit-opt data-val="' + vEsc + '"><i class="ph ph-pencil-simple"></i> Editar</button>';
    return '<tr><td class="opt-nome">' + vEsc + '</td>' +
      '<td>' + status + '</td>' +
      '<td class="text-end">' + toggle + editar + '</td></tr>';
  }).join('');

  container.innerHTML =
    '<div class="table-responsive"><table class="table table-striped align-middle tabela-opcoes mb-0">' +
    '<thead><tr><th>Opção</th><th>Status</th><th class="text-end">Ação</th></tr></thead>' +
    '<tbody>' + linhas + '</tbody></table></div>';
}

// ============================================================
//  Registros
// ============================================================
function dadosFormulario(prefix) {
  const g = (campo) => $((prefix || '') + campo).value;
  return {
    unidade: trim(g('unidade')), status: trim(g('status')), setor: trim(g('setor')),
    usuario: trim(g('usuario')), ns: trim(g('ns')), patAntigo: trim(g('patAntigo')),
    patNovo: trim(g('patNovo')), equipamento: trim(g('equipamento')), obs: trim(g('obs'))
  };
}

async function loadRecords() {
  const corpo = $('corpoTabela');
  corpo.innerHTML = '<tr><td colspan="10" class="text-muted">Carregando...</td></tr>';
  try {
    REGISTROS = await api('GET', '/api/records');
    renderTabela();
  } catch (err) {
    showAlert('alertRegistros', 'danger', 'Erro ao carregar registros: ' + err.message);
    corpo.innerHTML = '<tr><td colspan="10" class="text-danger">Falha ao carregar.</td></tr>';
  }
}

function renderTabela() {
  const corpo = $('corpoTabela');
  if (!REGISTROS.length) {
    corpo.innerHTML = '<tr><td colspan="10" class="text-muted">Nenhum registro cadastrado.</td></tr>';
    return;
  }
  corpo.innerHTML = REGISTROS.map((r) =>
    '<tr>' +
    '<td title="' + escapeHtml(r.unidade) + '">' + escapeHtml(r.unidade) + '</td>' +
    '<td>' + escapeHtml(r.status) + '</td>' +
    '<td>' + escapeHtml(r.setor) + '</td>' +
    '<td>' + escapeHtml(r.usuario) + '</td>' +
    '<td>' + escapeHtml(r.ns) + '</td>' +
    '<td>' + escapeHtml(r.patAntigo) + '</td>' +
    '<td>' + escapeHtml(r.patNovo) + '</td>' +
    '<td>' + escapeHtml(r.equipamento) + '</td>' +
    '<td title="' + escapeHtml(r.obs) + '">' + escapeHtml(r.obs) + '</td>' +
    '<td class="text-end">' +
      '<button type="button" class="btn btn-sm btn-outline-primary" data-edit="' +
        escapeHtml(r.id) + '">Editar</button>' +
    '</td></tr>'
  ).join('');
}

function abrirEdicao(id) {
  const r = REGISTROS.filter((x) => String(x.id) === String(id))[0];
  if (!r) return;
  $('edit_id').value = r.id;
  fillSelect('edit_unidade', valsParaEdicao('UNIDADE', r.unidade), r.unidade);
  fillSelect('edit_status', valsParaEdicao('STATUS', r.status), r.status);
  fillSelect('edit_setor', valsParaEdicao('SETOR', r.setor), r.setor);
  fillSelect('edit_equipamento', valsParaEdicao('EQUIPAMENTO', r.equipamento), r.equipamento);
  $('edit_usuario').value = r.usuario || '';
  $('edit_ns').value = r.ns || '';
  $('edit_patAntigo').value = r.patAntigo || '';
  $('edit_patNovo').value = r.patNovo || '';
  $('edit_obs').value = r.obs || '';
  $('formEditar').classList.remove('was-validated');
  modalEditar.show();
}

// Exporta os registros atuais para .csv (UTF-8) — abre no Sheets/Excel.
function exportarCSV() {
  if (!REGISTROS.length) {
    showAlert('alertRegistros', 'warning', 'Nenhum registro para exportar.');
    return;
  }
  const cabecalho = ['UNIDADE', 'STATUS', 'SETOR', 'USUARIO', 'N/S',
    'PAT_MSA - ANTIGO', 'PAT_MSA - NOVO', 'EQUIPAMENTO', 'OBS'];
  const campo = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const linhas = REGISTROS.map((r) => [
    r.unidade, r.status, r.setor, r.usuario, r.ns,
    r.patAntigo, r.patNovo, r.equipamento, r.obs
  ].map(campo).join(','));
  const csv = '﻿' + [cabecalho.map(campo).join(','), ...linhas].join('\r\n');

  const agora = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const nome = 'inventario_' + agora.getFullYear() + pad(agora.getMonth() + 1) +
    pad(agora.getDate()) + '_' + pad(agora.getHours()) + pad(agora.getMinutes()) + '.csv';

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showAlert('alertRegistros', 'success',
    'Planilha exportada (' + REGISTROS.length + ' registros).');
}

// ============================================================
//  Usuários
// ============================================================
async function loadUsuarios() {
  const container = $('listaUsuarios');
  if (!container) return;
  container.innerHTML = '<span class="text-muted">Carregando...</span>';
  try {
    const usuarios = await api('GET', '/api/users');
    if (!usuarios.length) {
      container.innerHTML = '<span class="text-muted">Nenhum usuário cadastrado.</span>';
      return;
    }
    const linhas = usuarios.map((u) => {
      const dt = u.criado_em ? new Date(u.criado_em) : null;
      const quando = dt
        ? dt.toLocaleDateString('pt-BR') + ' ' +
          dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '—';
      const ativo = !!u.ativo;
      const emailEsc = escapeHtml(u.email);
      const status = ativo
        ? '<span class="badge-status badge-ativo">ATIVO</span>'
        : '<span class="badge-status badge-inativo">INATIVO</span>';
      const toggle = ativo
        ? '<button type="button" class="acao-link acao-ocultar ms-3" data-user-ativo="' + u.id +
          '" data-to="0" data-email="' + emailEsc + '"><i class="ph ph-prohibit"></i> Inativar</button>'
        : '<button type="button" class="acao-link acao-exibir ms-3" data-user-ativo="' + u.id +
          '" data-to="1" data-email="' + emailEsc + '"><i class="ph ph-check-circle"></i> Reativar</button>';
      return '<tr><td class="opt-nome">' + emailEsc + '</td>' +
        '<td>' + quando + '</td>' +
        '<td>' + status + '</td>' +
        '<td class="text-end">' +
          '<button type="button" class="acao-link acao-editar" data-user-email="' + u.id +
            '"><i class="ph ph-envelope"></i> E-mail</button>' +
          '<button type="button" class="acao-link acao-editar ms-3" data-user-senha="' + u.id +
            '"><i class="ph ph-key"></i> Senha</button>' +
          toggle +
        '</td></tr>';
    }).join('');
    container.innerHTML =
      '<div class="table-responsive"><table class="table table-striped align-middle mb-0">' +
      '<thead><tr><th>E-mail</th><th>Criado em</th><th>Status</th><th class="text-end">Ação</th></tr></thead>' +
      '<tbody>' + linhas + '</tbody></table></div>';
  } catch (err) {
    container.innerHTML = '<span class="text-danger">Erro ao carregar: ' + escapeHtml(err.message) + '</span>';
  }
}

// ============================================================
//  Wiring dos formulários
// ============================================================
function configurarAuth() {
  const form = $('formAuth');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const email = trim($('auth_email').value);
    const senha = $('auth_senha').value;
    const btn = $('btnEntrar');
    btn.disabled = true; btn.textContent = 'Entrando...';
    try {
      const data = await api('POST', '/api/auth/login', { email, senha });
      TOKEN = data.token;
      localStorage.setItem('token', TOKEN);
      await entrarNoApp(data.email);
    } catch (err) {
      showAlert('alertAuth', 'danger', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  });
  $('btnSair').addEventListener('click', sairDoApp);
}

function configurarFormInventario() {
  const form = $('formInventario');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const btn = $('btnEnviar');
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      await api('POST', '/api/records', dadosFormulario(''));
      showAlert('alertRegistrar', 'success', 'Registro salvo com sucesso!');
      form.reset();
      clearFormSelects();
      form.classList.remove('was-validated');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showAlert('alertRegistrar', 'danger', 'Erro ao salvar: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Registrar';
    }
  });
}

function configurarFormOpcao() {
  const form = $('formOpcao');
  $('listaAlvo').addEventListener('change', renderListaOpcoes);

  $('listaOpcoes').addEventListener('click', async (ev) => {
    const lista = $('listaAlvo').value;

    const btnToggle = ev.target.closest('[data-toggle-opt]');
    if (btnToggle) {
      const val = btnToggle.getAttribute('data-val');
      const hide = btnToggle.getAttribute('data-hide') === '1';
      btnToggle.disabled = true;
      try {
        await api('PUT', '/api/options/hidden', { lista, valor: val, oculto: hide });
        await loadOptions();
      } catch (err) {
        showAlert('alertGerenciar', 'danger', 'Erro: ' + err.message);
        btnToggle.disabled = false;
      }
      return;
    }

    const btnEdit = ev.target.closest('[data-edit-opt]');
    if (btnEdit) {
      const val = btnEdit.getAttribute('data-val');
      const novo = await uiPrompt('Editar opção da lista ' + lista + ':',
        { title: 'Editar opção', value: val });
      if (novo === null) return;
      const limpo = trim(novo).toUpperCase();
      if (!limpo) { showAlert('alertGerenciar', 'warning', 'O valor não pode ser vazio.'); return; }
      if (limpo === val) return;
      btnEdit.disabled = true;
      try {
        await api('PUT', '/api/options/rename', { lista, valor: val, novoValor: limpo });
        await loadOptions();
        showAlert('alertGerenciar', 'success', 'Opção atualizada para "' + limpo + '".');
      } catch (err) {
        showAlert('alertGerenciar', 'danger', 'Erro: ' + err.message);
        btnEdit.disabled = false;
      }
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const lista = $('listaAlvo').value;
    const valor = $('novoValor').value;
    if (!trim(valor)) { showAlert('alertGerenciar', 'warning', 'Digite um valor.'); return; }
    const btn = $('btnAdicionar');
    btn.disabled = true; btn.textContent = 'Adicionando...';
    try {
      await api('POST', '/api/options', { lista, valor });
      await loadOptions();
      $('novoValor').value = '';
      showAlert('alertGerenciar', 'success', 'Opção adicionada a ' + lista + '.');
    } catch (err) {
      showAlert('alertGerenciar', 'danger', 'Erro: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Adicionar';
    }
  });
}

function configurarFormUsuario() {
  const form = $('formUsuario');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const email = trim($('novo_email').value);
    const senha = $('novo_senha').value;
    const btn = $('btnCriarUsuario');
    btn.disabled = true; btn.textContent = 'Criando...';
    try {
      await api('POST', '/api/users', { email, senha });
      form.reset();
      form.classList.remove('was-validated');
      showAlert('alertUsuarios', 'success', 'Usuário ' + email + ' criado com sucesso.');
      await loadUsuarios();
    } catch (err) {
      showAlert('alertUsuarios', 'danger', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Criar usuário';
    }
  });

  // Editar e-mail / senha e excluir (delegação na tabela).
  $('listaUsuarios').addEventListener('click', async (ev) => {
    const bEmail = ev.target.closest('[data-user-email]');
    const bSenha = ev.target.closest('[data-user-senha]');
    const bAtivo = ev.target.closest('[data-user-ativo]');

    try {
      if (bEmail) {
        const id = bEmail.getAttribute('data-user-email');
        const novo = trim(await uiPrompt('Novo e-mail:', { title: 'Editar e-mail' }) || '');
        if (!novo) return;
        await api('PUT', '/api/users/' + id, { email: novo });
        showAlert('alertUsuarios', 'success', 'E-mail atualizado.');
        await loadUsuarios();
      } else if (bSenha) {
        const id = bSenha.getAttribute('data-user-senha');
        const nova = await uiPrompt('Nova senha (mínimo 6 caracteres):', { title: 'Editar senha' }) || '';
        if (!nova) return;
        await api('PUT', '/api/users/' + id, { senha: nova });
        showAlert('alertUsuarios', 'success', 'Senha atualizada.');
      } else if (bAtivo) {
        const id = bAtivo.getAttribute('data-user-ativo');
        const email = bAtivo.getAttribute('data-email');
        const ativar = bAtivo.getAttribute('data-to') === '1';
        if (!ativar && !(await uiConfirm(
          'Inativar o acesso de ' + email + '? Ele não conseguirá mais entrar.',
          { title: 'Inativar usuário', okText: 'Inativar' }))) return;
        await api('PUT', '/api/users/' + id, { ativo: ativar });
        showAlert('alertUsuarios', 'success', ativar ? 'Usuário reativado.' : 'Usuário inativado.');
        await loadUsuarios();
      }
    } catch (err) {
      showAlert('alertUsuarios', 'danger', err.message);
    }
  });
}

function configurarFormEditar() {
  const form = $('formEditar');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const id = $('edit_id').value;
    const btn = $('btnSalvarEdicao');
    btn.disabled = true; btn.textContent = 'Salvando...';
    try {
      await api('PUT', '/api/records/' + id, dadosFormulario('edit_'));
      modalEditar.hide();
      showAlert('alertRegistros', 'success', 'Registro atualizado com sucesso!');
      await loadRecords();
    } catch (err) {
      showAlert('alertRegistros', 'danger', 'Erro ao salvar: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Salvar';
    }
  });

  $('btnExcluir').addEventListener('click', async () => {
    const id = $('edit_id').value;
    if (!id) return;
    if (!(await uiConfirm('Excluir este registro definitivamente?',
      { title: 'Excluir registro', okText: 'Excluir' }))) return;
    const btn = $('btnExcluir');
    btn.disabled = true; btn.textContent = 'Excluindo...';
    try {
      await api('DELETE', '/api/records/' + id);
      modalEditar.hide();
      showAlert('alertRegistros', 'success', 'Registro excluído.');
      await loadRecords();
    } catch (err) {
      showAlert('alertRegistros', 'danger', 'Erro ao excluir: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Excluir';
    }
  });

  $('corpoTabela').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-edit]');
    if (btn) abrirEdicao(btn.getAttribute('data-edit'));
  });
}

// ============================================================
//  Sessão / inicialização
// ============================================================
let dadosCarregados = false;

async function entrarNoApp(email) {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userEmail').textContent = email || '';
  if (dadosCarregados) return;
  dadosCarregados = true;
  try {
    await loadOptions();
    await loadRecords();
  } catch (err) {
    showAlert('alertRegistrar', 'danger', 'Erro ao carregar dados: ' + err.message);
  }
}

function sairDoApp() {
  dadosCarregados = false;
  TOKEN = '';
  localStorage.removeItem('token');
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  $('formAuth').reset();
  $('formAuth').classList.remove('was-validated');
}

document.addEventListener('DOMContentLoaded', async () => {
  modalEditar = new bootstrap.Modal($('modalEditar'));
  modalMsg = new bootstrap.Modal($('modalMsg'));
  modalAsk = new bootstrap.Modal($('modalAsk'));
  $('askOk').addEventListener('click', () => finishAsk(true));
  $('askCancel').addEventListener('click', () => finishAsk(false));
  $('modalAsk').addEventListener('hidden.bs.modal', () => finishAsk(false));
  $('askInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finishAsk(true); } });
  initChoices();
  configurarAuth();
  configurarFormInventario();
  configurarFormOpcao();
  configurarFormUsuario();
  configurarFormEditar();

  $('tab-registros').addEventListener('shown.bs.tab', loadRecords);
  $('btnAtualizarLista').addEventListener('click', loadRecords);
  $('btnExportar').addEventListener('click', exportarCSV);
  $('tab-usuarios').addEventListener('shown.bs.tab', loadUsuarios);
  $('btnAtualizarUsuarios').addEventListener('click', loadUsuarios);

  // Sessão persistida: valida o token salvo.
  if (TOKEN) {
    try {
      const me = await api('GET', '/api/auth/me');
      await entrarNoApp(me.email);
    } catch {
      sairDoApp();
    }
  }
});

// ---------- Service Worker (PWA) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
