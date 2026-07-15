// ============================================================
//  Página standalone /chamados — abrir e acompanhar chamados INTECS.
//  Reaproveita o mesmo token/login do app principal (localStorage 'token').
// ============================================================
const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem('token') || '';
let _perfil = null;
let _categorias = [];
let _maquinaId = null;
let _chamadoAtual = null;
let modalNovo, modalDetalhe;
const choicesMap = {};

function initChoicesSelect(id, extra = {}) {
  if (choicesMap[id] || typeof Choices === 'undefined') return choicesMap[id];
  choicesMap[id] = new Choices($(id), {
    searchEnabled: false, itemSelectText: '', shouldSort: false, allowHTML: false,
    placeholder: true, placeholderValue: 'Selecione...', ...extra
  });
  return choicesMap[id];
}

function setChoicesOptions(id, opcoes, valorSelecionado) {
  const c = choicesMap[id];
  if (!c) return;
  c.clearChoices();
  c.setChoices(
    [{ value: '', label: 'Selecione...', placeholder: true }, ...opcoes],
    'value', 'label', true
  );
  if (valorSelecionado != null) c.setChoiceByValue(String(valorSelecionado));
}

function trim(v) { return String(v == null ? '' : v).trim(); }
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDataHora(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleString('pt-BR');
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && TOKEN) { sair(); throw new Error('Sessão expirada.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
  return data;
}

let STATUS_LABEL = {
  ABERTO: 'Aberto', EM_ANALISE: 'Em análise', AGUARDANDO_USUARIO: 'Aguardando usuário',
  EM_ATENDIMENTO: 'Em atendimento', AGUARDANDO_FORNECEDOR: 'Aguardando fornecedor',
  RESOLVIDO: 'Resolvido', FECHADO: 'Fechado', CANCELADO: 'Cancelado'
};
let PRIORIDADE_LABEL = { BAIXA: 'Baixa', MEDIA: 'Média', ALTA: 'Alta', CRITICA: 'Crítica' };

async function carregarPrioridadesEStatus() {
  try {
    const [prioridades, statusList] = await Promise.all([
      api('GET', '/api/chamados-intecs/prioridades'),
      api('GET', '/api/chamados-intecs/status-config')
    ]);
    prioridades.forEach((p) => { if (!PRIORIDADE_LABEL[p.nome]) PRIORIDADE_LABEL[p.nome] = p.nome; });
    statusList.forEach((s) => { if (!STATUS_LABEL[s.nome]) STATUS_LABEL[s.nome] = s.nome; });

    const itens = prioridades.map((p) => ({ value: p.nome, label: PRIORIDADE_LABEL[p.nome] || p.nome }));
    const inst = choicesMap['nc_prioridade'];
    if (inst) {
      inst.clearChoices();
      inst.setChoices(itens, 'value', 'label', true);
      inst.setChoiceByValue('MEDIA');
    }
  } catch { /* mantém os rótulos padrão em caso de erro */ }
}

function slaInfo(c) {
  if (['RESOLVIDO', 'FECHADO', 'CANCELADO'].includes(c.status)) return { texto: 'Concluído', classe: 'bg-secondary' };
  if (!c.sla_conclusao_prazo) return { texto: '-', classe: 'bg-secondary' };
  const agora = Date.now();
  const criado = new Date(c.criado_em).getTime();
  const prazo = new Date(c.sla_conclusao_prazo).getTime();
  if (agora > prazo) return { texto: 'Expirado', classe: 'bg-danger' };
  const pct = (agora - criado) / (prazo - criado);
  if (pct >= 0.8) return { texto: 'Vermelho', classe: 'bg-danger' };
  if (pct >= 0.5) return { texto: 'Amarelo', classe: 'bg-warning text-dark' };
  return { texto: 'Verde', classe: 'bg-success' };
}

function sair() {
  localStorage.removeItem('token');
  TOKEN = '';
  location.reload();
}

function mostrarApp(mostrar) {
  $('loginBox').style.display = mostrar ? 'none' : '';
  $('appBox').style.display = mostrar ? '' : 'none';
  $('btnSairChamados').style.display = mostrar ? '' : 'none';
}

async function entrar() {
  _perfil = await api('GET', '/api/chamados-intecs/meu-perfil');
  mostrarApp(true);
  $('userEmailChamados').textContent = _perfil.email || '';
  await carregarCategorias();
  await carregarPrioridadesEStatus();
  await carregarChamados();
}

function configurarLogin() {
  $('formLogin').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = trim($('loginEmail').value);
    const senha = $('loginSenha').value;
    const btn = $('btnLogin');
    btn.disabled = true;
    $('alertLogin').innerHTML = '';
    try {
      const data = await api('POST', '/api/auth/login', { email, senha });
      TOKEN = data.token;
      localStorage.setItem('token', TOKEN);
      await entrar();
    } catch (err) {
      $('alertLogin').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    } finally {
      btn.disabled = false;
    }
  });
  $('btnSairChamados').addEventListener('click', sair);
}

async function carregarCategorias() {
  _categorias = await api('GET', '/api/chamados-intecs/categorias');
  setChoicesOptions('nc_categoria', _categorias.map((c) => ({ value: String(c.id), label: c.nome })));
}

function popularSubcategorias(categoriaId) {
  const cat = _categorias.find((c) => String(c.id) === String(categoriaId));
  const subs = cat ? cat.subcategorias : [];
  setChoicesOptions('nc_subcategoria', subs.map((s) => ({ value: String(s.id), label: s.nome })));
}

async function carregarChamados() {
  $('listaStatus').textContent = 'Carregando...';
  try {
    const lista = await api('GET', '/api/chamados-intecs');
    if (!lista.length) {
      $('listaChamados').innerHTML = '<div class="text-muted text-center py-4">Nenhum chamado ainda.</div>';
    } else {
      $('listaChamados').innerHTML = lista.map((c) => {
        const sla = slaInfo(c);
        return `
        <div class="ticket-row p-3 d-flex flex-row justify-content-between align-items-center" data-id="${c.id}">
          <div>
            <div class="fw-semibold">${escapeHtml(c.titulo)}</div>
            <div class="small text-muted">${escapeHtml(c.categoria_nome || '-')} · ${escapeHtml(PRIORIDADE_LABEL[c.prioridade] || c.prioridade)} · ${fmtDataHora(c.criado_em)}</div>
          </div>
          <div class="text-end">
            <span class="badge ${sla.classe} mb-1">${sla.texto}</span>
            <div class="small">${escapeHtml(STATUS_LABEL[c.status] || c.status)}</div>
          </div>
        </div>`;
      }).join('');
    }
    $('listaStatus').textContent = lista.length + ' chamado(s).';
  } catch (err) {
    $('listaChamados').innerHTML = '<div class="text-danger">Erro: ' + escapeHtml(err.message) + '</div>';
    $('listaStatus').textContent = '';
  }
}

function renderCampos(obj) {
  if (!obj || typeof obj !== 'object') return '<span class="text-muted">Sem dados.</span>';
  const linhas = Object.entries(obj).filter(([, v]) => v != null && v !== '').map(([k, v]) => {
    const valor = (Array.isArray(v) || typeof v === 'object') ? JSON.stringify(v) : String(v);
    return `<div class="row mb-1"><div class="col-5 text-muted">${escapeHtml(k)}</div><div class="col-7">${escapeHtml(valor)}</div></div>`;
  });
  return linhas.join('') || '<span class="text-muted">Sem dados.</span>';
}

async function abrirDetalhe(id) {
  _chamadoAtual = id;
  $('detTitulo').textContent = 'Carregando...';
  $('detResumo').innerHTML = '';
  $('detEquipamento').innerHTML = '';
  $('detComentarios').innerHTML = '';
  modalDetalhe.show();
  try {
    const data = await api('GET', '/api/chamados-intecs/' + id);
    $('detTitulo').textContent = `#${data.id} — ${data.titulo}`;
    const sla = slaInfo(data);
    $('detResumo').innerHTML = `
      <div><span class="badge ${sla.classe}">${sla.texto}</span> ${escapeHtml(STATUS_LABEL[data.status] || data.status)} · ${escapeHtml(PRIORIDADE_LABEL[data.prioridade] || data.prioridade)}</div>
      <div class="small text-muted mt-1">Aberto em ${fmtDataHora(data.criado_em)}${data.responsavel_email ? ' · Responsável: ' + escapeHtml(data.responsavel_email) : ''}</div>
      <div class="mt-2">${escapeHtml(data.descricao || '')}</div>
    `;
    $('detComentarios').innerHTML = (data.comentarios || []).length
      ? data.comentarios.map((co) => `<div class="border-bottom pb-2 mb-2"><div class="small text-muted">${escapeHtml(co.usuario_email || '')} · ${fmtDataHora(co.criado_em)}</div><div>${escapeHtml(co.texto)}</div></div>`).join('')
      : '<span class="text-muted">Nenhum comentário ainda.</span>';

    const podeComentar = ['TECNICO', 'MASTER'].includes(_perfil.role) || data.usuario_id === _perfil.id;
    $('detNovoComentarioBox').style.display = podeComentar ? '' : 'none';

    if (data.device_id) {
      const resumo = await api('GET', '/api/chamados-intecs/' + id + '/equipamento');
      $('detEquipamento').innerHTML = resumo
        ? renderCampos({ status: resumo.status_online ? 'Online' : 'Offline', ...resumo.hardware_info, ...resumo.os_info, ...resumo.rede_info })
        : '<span class="text-muted">Sem dados de equipamento.</span>';
    } else {
      $('detEquipamento').innerHTML = '<span class="text-muted">Nenhum equipamento vinculado a este chamado.</span>';
    }
  } catch (err) {
    $('detTitulo').textContent = 'Erro ao carregar';
  }
}

async function verificarMaquina() {
  _maquinaId = null;
  $('nc_maquina_select_wrap').style.display = 'none';
  $('nc_maquina').innerHTML = '<i class="ph ph-spinner"></i> Detectando máquina...';
  try {
    const { matches } = await api('POST', '/api/chamados-intecs/verificar-maquina');
    if (matches.length === 1) {
      _maquinaId = matches[0].tactical_agent_id;
      $('nc_maquina').textContent = 'Máquina detectada: ' + (matches[0].hostname || matches[0].tactical_agent_id);
    } else if (matches.length > 1) {
      $('nc_maquina').textContent = 'Mais de uma máquina encontrada — selecione a sua:';
      const c = choicesMap['nc_maquina_select'];
      c.clearChoices();
      c.setChoices(matches.map((a) => ({ value: a.tactical_agent_id, label: a.hostname || a.tactical_agent_id })), 'value', 'label', true);
      $('nc_maquina_select_wrap').style.display = '';
      _maquinaId = matches[0].tactical_agent_id;
    } else {
      $('nc_maquina').textContent = 'Não foi possível detectar automaticamente — o chamado será aberto sem equipamento.';
    }
  } catch (err) {
    $('nc_maquina').textContent = 'Erro ao verificar: ' + err.message;
  }
}

function configurarChamados() {
  initChoicesSelect('nc_categoria');
  initChoicesSelect('nc_subcategoria');
  initChoicesSelect('nc_prioridade', { placeholder: false });
  initChoicesSelect('nc_maquina_select', { placeholder: false });

  $('btnNovo').addEventListener('click', () => {
    $('formNovo').reset();
    $('alertNovo').innerHTML = '';
    choicesMap['nc_categoria']?.setChoiceByValue('');
    setChoicesOptions('nc_subcategoria', []);
    choicesMap['nc_prioridade']?.setChoiceByValue('MEDIA');
    modalNovo.show();
    verificarMaquina();
  });

  $('nc_categoria').addEventListener('change', () => popularSubcategorias($('nc_categoria').value));
  $('nc_maquina_select').addEventListener('change', () => { _maquinaId = $('nc_maquina_select').value; });

  $('btnAbrir').addEventListener('click', async () => {
    const titulo = trim($('nc_titulo').value);
    if (!titulo) { $('alertNovo').innerHTML = '<div class="alert alert-warning py-2 mb-0">Informe um título.</div>'; return; }
    const btn = $('btnAbrir');
    btn.disabled = true;
    try {
      await api('POST', '/api/chamados-intecs', {
        titulo,
        categoria_id: $('nc_categoria').value || null,
        subcategoria_id: $('nc_subcategoria').value || null,
        prioridade: $('nc_prioridade').value,
        telefone: trim($('nc_telefone').value),
        descricao: trim($('nc_descricao').value),
        tactical_agent_id: _maquinaId || null
      });
      modalNovo.hide();
      await carregarChamados();
    } catch (err) {
      $('alertNovo').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    } finally {
      btn.disabled = false;
    }
  });

  $('listaChamados').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-id]');
    if (el) abrirDetalhe(el.getAttribute('data-id'));
  });

  $('btnComentar').addEventListener('click', async () => {
    const texto = trim($('detNovoComentario').value);
    if (!texto || !_chamadoAtual) return;
    const btn = $('btnComentar');
    btn.disabled = true;
    try {
      await api('POST', '/api/chamados-intecs/' + _chamadoAtual + '/comentarios', { texto });
      $('detNovoComentario').value = '';
      await abrirDetalhe(_chamadoAtual);
    } catch (err) {
      alert('Erro ao comentar: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  modalNovo = new bootstrap.Modal($('modalNovo'));
  modalDetalhe = new bootstrap.Modal($('modalDetalhe'));
  configurarLogin();
  configurarChamados();
  if (TOKEN) {
    try { await entrar(); } catch { sair(); }
  } else {
    mostrarApp(false);
  }
});
