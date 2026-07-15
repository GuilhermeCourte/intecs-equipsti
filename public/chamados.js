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

// Estado da lista (filtros/busca/paginação são só de apresentação, client-side)
const PAGE_SIZE = 8;
const STATUS_CONCLUIDOS = ['RESOLVIDO', 'FECHADO', 'CANCELADO'];
let _listaCache = [];
let _filtro = 'todos';
let _busca = '';
let _pagina = 1;
let _primeiraRender = true; // entrance com stagger só na primeira pintura; filtros não re-animam

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
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function fmtDataCurta(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return '';
  return String(d.getDate()).padStart(2, '0') + ' ' + MESES_CURTOS[d.getMonth()] + ' ' + d.getFullYear();
}
function primeiroNome(email) {
  const prefixo = trim(email).split('@')[0] || '';
  const parte = prefixo.split(/[._-]+/).filter(Boolean)[0] || prefixo;
  return parte ? parte.charAt(0).toUpperCase() + parte.slice(1) : '';
}
function iniciais(email) {
  const prefixo = trim(email).split('@')[0] || '';
  const partes = prefixo.split(/[._-]+/).filter(Boolean);
  const ini = partes.length >= 2 ? partes[0][0] + partes[1][0] : prefixo.slice(0, 2);
  return (ini || '?').toUpperCase();
}
function statusClasse(s) { return 'st-' + String(s || '').replace(/[^A-Za-z0-9_-]/g, ''); }
function prioClasse(p) { return 'prio-' + String(p || '').replace(/[^A-Za-z0-9_-]/g, ''); }
function classifica(c) {
  if (STATUS_CONCLUIDOS.includes(c.status)) return 'concluidos';
  if (c.status === 'AGUARDANDO_USUARIO') return 'voce';
  return 'andamento';
}
function rotuloChamados(n) { return n === 1 ? ' chamado' : ' chamados'; }

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

// ---- Toast (feedback não-bloqueante) ----
function ensureToastZone() {
  let zona = $('toastZone');
  if (!zona) {
    zona = document.createElement('div');
    zona.id = 'toastZone';
    zona.className = 'toast-zone';
    document.body.appendChild(zona);
  }
  return zona;
}

function toast(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = 'toastx' + (tipo === 'erro' ? ' toastx-erro' : '');
  el.innerHTML = '<i class="ph ' + (tipo === 'erro' ? 'ph-warning-circle' : 'ph-check-circle') + '"></i><span>' + escapeHtml(msg) + '</span>';
  ensureToastZone().appendChild(el);
  setTimeout(() => el.classList.add('saindo'), 3400);
  setTimeout(() => el.remove(), 3800);
}

async function entrar() {
  _perfil = await api('GET', '/api/chamados-intecs/meu-perfil');
  mostrarApp(true);
  $('userEmailChamados').textContent = _perfil.email || '';
  $('userAvatar').textContent = iniciais(_perfil.email);
  const nome = primeiroNome(_perfil.email);
  $('heroTitulo').textContent = nome ? 'Olá, ' + nome + '!' : 'Olá!';
  const unidade = String(_perfil.unidade || '').toLowerCase();
  $('brandArmazem').style.display = unidade.includes('armaz') ? '' : 'none';
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
  $('listaStatus').textContent = '';
  $('listaPaginacao').innerHTML = '';
  const skCard = `
    <div class="sk-card">
      <div class="sk-col"><span class="sk sk-sm"></span><span class="sk sk-lg"></span><span class="sk sk-md"></span></div>
      <div class="sk-col sk-right"><span class="sk sk-pill"></span><span class="sk sk-pill"></span></div>
    </div>`;
  $('listaChamados').innerHTML = skCard.repeat(3);
  if (!_listaCache.length) $('statsGrid').innerHTML = '<div class="sk-stat"></div>'.repeat(4);
  try {
    const lista = await api('GET', '/api/chamados-intecs');
    _listaCache = Array.isArray(lista) ? lista : [];
    renderStats();
    renderLista();
  } catch (err) {
    _listaCache = [];
    $('statsGrid').innerHTML = '';
    $('listaChamados').innerHTML = `
      <div class="empty-state">
        <i class="ph ph-warning-circle"></i>
        <h3>Não foi possível carregar</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>`;
    $('listaStatus').textContent = '';
  }
}

function renderStats() {
  const grid = $('statsGrid');
  if (!grid) return;
  let andamento = 0, voce = 0, concluidos = 0;
  _listaCache.forEach((c) => {
    const g = classifica(c);
    if (g === 'concluidos') concluidos++;
    else if (g === 'voce') voce++;
    else andamento++;
  });
  let seq = 0;
  const card = (icone, mod, valor, rotulo) => `
    <div class="stat-card${_primeiraRender ? ' entra' : ''}"${_primeiraRender ? ` style="--i:${seq++}"` : ''}>
      <span class="stat-icon ${mod}"><i class="ph ${icone}"></i></span>
      <span class="stat-info"><span class="stat-value">${valor}</span><span class="stat-label">${rotulo}</span></span>
    </div>`;
  grid.innerHTML =
    card('ph-ticket', 'ic-indigo', _listaCache.length, 'Total de chamados') +
    card('ph-circle-notch', 'ic-violet', andamento, 'Em andamento') +
    card('ph-user-focus', 'ic-orange', voce, 'Aguardando você') +
    card('ph-check-circle', 'ic-green', concluidos, 'Concluídos');
}

function aplicarFiltros() {
  const termo = _busca.trim().toLowerCase().replace(/^#/, '');
  return _listaCache.filter((c) => {
    if (_filtro !== 'todos' && classifica(c) !== _filtro) return false;
    if (!termo) return true;
    return String(c.titulo || '').toLowerCase().includes(termo) || String(c.id).includes(termo);
  });
}

function templateTicket(c, i) {
  const sla = slaInfo(c);
  return `
  <article class="ticket-row${_primeiraRender ? ' entra' : ''}" data-id="${c.id}"${_primeiraRender ? ` style="--i:${(i || 0) + 2}"` : ''}>
    <div class="ticket-main">
      <div class="ticket-top">
        <span class="ticket-num">#${c.id}</span>
        <span class="badge badge-prio ${prioClasse(c.prioridade)}">${escapeHtml(PRIORIDADE_LABEL[c.prioridade] || c.prioridade || '-')}</span>
      </div>
      <div class="ticket-title">${escapeHtml(c.titulo)}</div>
      <div class="ticket-meta">
        <span>${escapeHtml(c.categoria_nome || 'Sem categoria')}</span>
        <span class="dot"></span>
        <span>${fmtDataCurta(c.criado_em)}</span>
      </div>
    </div>
    <div class="ticket-side">
      <span class="badge badge-status ${statusClasse(c.status)}">${escapeHtml(STATUS_LABEL[c.status] || c.status)}</span>
      ${sla.texto !== '-' ? `<span class="badge ${sla.classe}">${sla.texto}</span>` : ''}
    </div>
    <i class="ph ph-caret-right ticket-chev"></i>
  </article>`;
}

function renderLista() {
  const box = $('listaChamados');
  const filtrados = aplicarFiltros();
  const totalPag = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
  if (_pagina > totalPag) _pagina = totalPag;

  if (!_listaCache.length) {
    box.innerHTML = `
      <div class="empty-state">
        <svg width="88" height="88" viewBox="0 0 88 88" fill="none" aria-hidden="true">
          <defs><linearGradient id="gradEmpty" x1="0" y1="0" x2="88" y2="88">
            <stop offset="0" stop-color="#F0731E"/><stop offset=".5" stop-color="#B0559E"/><stop offset="1" stop-color="#5B3DF0"/>
          </linearGradient></defs>
          <circle cx="44" cy="44" r="42" fill="url(#gradEmpty)" opacity=".1"/>
          <circle cx="44" cy="44" r="29" fill="url(#gradEmpty)" opacity=".16"/>
          <path d="M31 44.5 40 53l17-17" stroke="url(#gradEmpty)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <h3>Nenhum chamado ainda</h3>
        <p>Quando precisar da TI, clique em <strong>Novo chamado</strong> ali em cima — sua solicitação aparece aqui.</p>
      </div>`;
    $('listaStatus').textContent = '';
  } else if (!filtrados.length) {
    const termo = _busca.trim();
    box.innerHTML = `
      <div class="empty-state">
        <i class="ph ph-magnifying-glass"></i>
        <h3>Nada por aqui</h3>
        <p>${termo ? 'Nenhum chamado corresponde a "' + escapeHtml(termo) + '".' : 'Nenhum chamado corresponde aos filtros escolhidos.'}</p>
        <button type="button" class="chip" data-limpar>Limpar filtros</button>
      </div>`;
    const limpar = box.querySelector('[data-limpar]');
    if (limpar) limpar.addEventListener('click', () => {
      _busca = ''; _filtro = 'todos'; _pagina = 1;
      const campo = $('buscaChamados');
      if (campo) campo.value = '';
      document.querySelectorAll('#filtroStatus .chip').forEach((ch) => ch.classList.toggle('active', ch.dataset.filtro === 'todos'));
      renderLista();
    });
    $('listaStatus').textContent = '0 de ' + _listaCache.length + rotuloChamados(_listaCache.length);
  } else {
    const pagina = filtrados.slice((_pagina - 1) * PAGE_SIZE, _pagina * PAGE_SIZE);
    box.innerHTML = pagina.map(templateTicket).join('');
    $('listaStatus').textContent = (filtrados.length === _listaCache.length)
      ? _listaCache.length + rotuloChamados(_listaCache.length)
      : filtrados.length + ' de ' + _listaCache.length + rotuloChamados(_listaCache.length);
  }
  renderPaginacao(filtrados.length, totalPag);
  _primeiraRender = false;
}

function renderPaginacao(totalFiltrado, totalPag) {
  const nav = $('listaPaginacao');
  if (!nav) return;
  if (totalFiltrado <= PAGE_SIZE) { nav.innerHTML = ''; return; }
  const itens = [];
  for (let i = 1; i <= totalPag; i++) {
    if (i === 1 || i === totalPag || Math.abs(i - _pagina) <= 1) itens.push(i);
    else if (itens[itens.length - 1] !== '...') itens.push('...');
  }
  nav.innerHTML =
    `<button type="button" class="page-btn" data-pg="${_pagina - 1}" ${_pagina === 1 ? 'disabled' : ''} aria-label="Página anterior"><i class="ph ph-caret-left"></i></button>` +
    itens.map((p) => p === '...'
      ? '<span class="page-dots">…</span>'
      : `<button type="button" class="page-btn ${p === _pagina ? 'active' : ''}" data-pg="${p}">${p}</button>`).join('') +
    `<button type="button" class="page-btn" data-pg="${_pagina + 1}" ${_pagina === totalPag ? 'disabled' : ''} aria-label="Próxima página"><i class="ph ph-caret-right"></i></button>`;
}

function renderCampos(obj) {
  if (!obj || typeof obj !== 'object') return '<span class="det-vazio">Sem dados.</span>';
  const linhas = Object.entries(obj).filter(([, v]) => v != null && v !== '').map(([k, v]) => {
    const valor = (Array.isArray(v) || typeof v === 'object') ? JSON.stringify(v) : String(v);
    return `<div class="kv"><span class="kv-chave">${escapeHtml(k)}</span><span class="kv-valor">${escapeHtml(valor)}</span></div>`;
  });
  return linhas.length ? '<div class="kv-grid">' + linhas.join('') + '</div>' : '<span class="det-vazio">Sem dados.</span>';
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
      <div class="det-badges">
        <span class="badge badge-status ${statusClasse(data.status)}">${escapeHtml(STATUS_LABEL[data.status] || data.status)}</span>
        <span class="badge badge-prio ${prioClasse(data.prioridade)}">${escapeHtml(PRIORIDADE_LABEL[data.prioridade] || data.prioridade)}</span>
        ${sla.texto !== '-' ? `<span class="badge ${sla.classe}">SLA: ${sla.texto}</span>` : ''}
      </div>
      <div class="det-meta">Aberto em ${fmtDataHora(data.criado_em)}${data.responsavel_email ? ' · Responsável: ' + escapeHtml(data.responsavel_email) : ''}</div>
      <div class="det-desc">${data.descricao ? escapeHtml(data.descricao) : '<span class="det-vazio">Sem descrição.</span>'}</div>
    `;
    $('detComentarios').innerHTML = (data.comentarios || []).length
      ? data.comentarios.map((co) => {
          const meu = _perfil && co.usuario_email === _perfil.email;
          return `
        <div class="comment${meu ? ' comment--me' : ''}">
          <span class="comment-avatar" aria-hidden="true">${escapeHtml(iniciais(co.usuario_email))}</span>
          <div class="comment-bubble">
            <div class="comment-head">
              <span class="comment-autor">${meu ? 'Você' : escapeHtml(co.usuario_email || '')}</span>
              <span class="comment-data">${fmtDataHora(co.criado_em)}</span>
            </div>
            <div class="comment-texto">${escapeHtml(co.texto)}</div>
          </div>
        </div>`;
        }).join('')
      : '<div class="det-vazio">Nenhum comentário ainda. Assim que a equipe responder, aparece aqui.</div>';

    const podeComentar = ['TECNICO', 'MASTER'].includes(_perfil.role) || data.usuario_id === _perfil.id;
    $('detNovoComentarioBox').style.display = podeComentar ? '' : 'none';

    if (data.device_id) {
      const resumo = await api('GET', '/api/chamados-intecs/' + id + '/equipamento');
      $('detEquipamento').innerHTML = resumo
        ? renderCampos({ status: resumo.status_online ? 'Online' : 'Offline', ...resumo.hardware_info, ...resumo.os_info, ...resumo.rede_info })
        : '<span class="det-vazio">Sem dados de equipamento.</span>';
    } else {
      $('detEquipamento').innerHTML = '<span class="det-vazio">Nenhum equipamento vinculado a este chamado.</span>';
    }
  } catch (err) {
    $('detTitulo').textContent = 'Erro ao carregar';
  }
}

async function verificarMaquina() {
  _maquinaId = null;
  $('nc_maquina_select_wrap').style.display = 'none';
  $('nc_maquina').innerHTML = '<span class="spin" aria-hidden="true"></span> Detectando máquina...';
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
      toast('Chamado aberto com sucesso.');
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

  $('buscaChamados').addEventListener('input', () => {
    _busca = $('buscaChamados').value;
    _pagina = 1;
    renderLista();
  });

  // Atalho "/" foca a busca (só com o app visível e sem foco em campo/modal)
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/') return;
    const alvo = ev.target;
    if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.isContentEditable)) return;
    if (document.body.classList.contains('modal-open')) return;
    const campo = $('buscaChamados');
    if (!campo || !campo.offsetParent) return;
    ev.preventDefault();
    campo.focus();
  });

  $('filtroStatus').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip[data-filtro]');
    if (!chip) return;
    _filtro = chip.dataset.filtro;
    _pagina = 1;
    document.querySelectorAll('#filtroStatus .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderLista();
  });

  $('listaPaginacao').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-pg]');
    if (!btn || btn.disabled) return;
    const pg = Number(btn.getAttribute('data-pg'));
    if (!pg || pg === _pagina) return;
    _pagina = pg;
    renderLista();
    const comportamento = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    $('listaChamados').scrollIntoView({ behavior: comportamento, block: 'start' });
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
      toast('Erro ao comentar: ' + err.message, 'erro');
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
