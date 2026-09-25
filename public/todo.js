// ============================================================
//  TODO — tela compartilhada pela aba "TODO" do admin (index.html) e pela
//  página /todo (todo.html). Só a casca muda; a lógica e a renderização são
//  estas, para as duas entradas nunca divergirem.
//
//  Uso:  TodoTela.montar(elementoRaiz, {
//          obterToken: () => string,     // JWT atual (as duas casas guardam em localStorage 'token')
//          aoExpirar:  () => void,       // 401: a casca volta para o login
//          avisar:     (tipo, msg) => void   // opcional; sem ele o erro aparece na própria tela
//        });
//        TodoTela.recarregar();          // ao entrar na aba / abrir a página
//
//  Regras de quem pode o quê vivem no servidor (server/index.js, /api/todo/*).
//  Aqui só se esconde o que o servidor ia negar de qualquer jeito.
// ============================================================
(function () {
  'use strict';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const hojeYmd = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const somaDias = (ymd, n) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };
  const ymdParaBR = (s) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };

  let raiz = null;
  let cfg = {};
  let modais = null; // { editar, compartilhar, apagar } — instâncias do Bootstrap
  const st = {
    eu: null,          // { id, email }
    usuarios: [],      // quem mais participa do TODO (dropdown, atribuição, liberação)
    alvoId: null,      // null = a minha lista
    dados: null,       // resposta de GET /api/todo/lista
    aba: 'trabalho',
    tarefaAberta: null // task em edição / liberação / exclusão
  };

  // ---------- API ----------
  async function api(method, path, body) {
    const token = cfg.obterToken ? cfg.obterToken() : '';
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
    }
    if (res.status === 401) {
      if (cfg.aoExpirar) cfg.aoExpirar();
      const e = new Error('Sessão expirada. Entre novamente.');
      e.sessao = true;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || ('Erro ' + res.status));
      e.status = res.status;
      throw e;
    }
    return data;
  }

  function avisar(msg) {
    if (cfg.avisar) return cfg.avisar('danger', msg);
    const box = raiz.querySelector('#tdAviso');
    box.innerHTML = `<div class="alert alert-danger py-2 mb-3">${esc(msg)}</div>`;
  }
  const limparAviso = () => { const b = raiz && raiz.querySelector('#tdAviso'); if (b) b.innerHTML = ''; };

  // Roda uma ação, mostra o erro (exceto sessão vencida, que a casca já trata) e devolve se deu certo.
  async function tentar(fn) {
    try { await fn(); return true; } catch (e) { if (!e.sessao) avisar(e.message); return false; }
  }

  // ---------- Dados ----------
  async function carregarLista() {
    const q = st.alvoId ? `?usuarioId=${st.alvoId}` : '';
    try {
      st.dados = await api('GET', '/api/todo/lista' + q);
    } catch (e) {
      // Pessoa da lista que perdeu o acesso (ou sumiu) entre abrir e escolher: volta para a minha.
      if (st.alvoId && e.status === 404) { st.alvoId = null; st.dados = await api('GET', '/api/todo/lista'); }
      else throw e;
    }
    if (!abasVisiveis().includes(st.aba)) st.aba = 'trabalho';
  }

  async function recarregar() {
    if (!raiz) return;
    limparAviso();
    const ok = await tentar(async () => {
      const antes = st.eu && st.eu.id;
      st.eu = await api('GET', '/api/auth/me');
      if (antes !== st.eu.id) { st.alvoId = null; st.aba = 'trabalho'; } // outra pessoa entrou nesta página
      st.usuarios = await api('GET', '/api/todo/usuarios');
      await carregarLista();
    });
    if (ok) render();
    else raiz.querySelector('#tdConteudo').innerHTML = '<div class="text-muted">Não foi possível carregar o TODO.</div>';
  }

  async function recarregarLista() {
    if (await tentar(carregarLista)) render();
  }

  // ---------- Render ----------
  const abasVisiveis = () => {
    const d = st.dados;
    if (!d) return ['trabalho'];
    return d.propria ? ['trabalho', 'pessoal', 'atribuidas'] : (d.pessoalVisivel ? ['trabalho', 'pessoal'] : ['trabalho']);
  };
  const ABAS = {
    trabalho: { rotulo: 'Trabalho', icone: 'ph-briefcase' },
    pessoal: { rotulo: 'Pessoal', icone: 'ph-user' },
    atribuidas: { rotulo: 'Atribuídas por mim', icone: 'ph-paper-plane-tilt' }
  };

  function chipPrazo(t) {
    if (!t.prazo) return '';
    if (t.concluida) return `<span class="td-chip"><i class="ph ph-calendar-blank"></i>${ymdParaBR(t.prazo)}</span>`;
    const hoje = hojeYmd();
    if (t.prazo < hoje) return `<span class="td-chip atrasada"><i class="ph ph-warning"></i>Atrasada · ${ymdParaBR(t.prazo)}</span>`;
    if (t.prazo === hoje) return '<span class="td-chip hoje"><i class="ph ph-alarm"></i>Vence hoje</span>';
    if (t.prazo === somaDias(hoje, 1)) return '<span class="td-chip hoje"><i class="ph ph-alarm"></i>Vence amanhã</span>';
    return `<span class="td-chip"><i class="ph ph-calendar-blank"></i>${ymdParaBR(t.prazo)}</span>`;
  }

  function linhaTarefa(t, pane) {
    const eu = st.eu.id;
    const leitura = !st.dados.propria;
    const podeConcluir = !leitura && pane !== 'atribuidas' && t.donoId === eu;
    const podeEditar = !leitura && t.criadoPorId === eu;
    const podeLiberar = !leitura && t.lista === 'PESSOAL' && t.donoId === eu && t.criadoPorId === eu;

    const chips = [chipPrazo(t)];
    if (pane === 'atribuidas') {
      chips.push(`<span class="td-chip"><i class="ph ph-user-circle"></i>para ${esc(t.donoEmail)}</span>`);
      chips.push(t.concluida
        ? '<span class="td-chip ok"><i class="ph ph-check-circle"></i>Concluída</span>'
        : '<span class="td-chip"><i class="ph ph-hourglass-medium"></i>Pendente</span>');
    } else if (t.atribuida) {
      chips.push(`<span class="td-chip"><i class="ph ph-paper-plane-tilt"></i>de ${esc(t.criadoPorEmail)}</span>`);
    }
    if (podeLiberar && t.compartilhadoCom && t.compartilhadoCom.length) {
      chips.push(`<span class="td-chip"><i class="ph ph-users"></i>Liberada para ${t.compartilhadoCom.length}</span>`);
    }

    const acoes = [];
    if (podeLiberar) acoes.push(`<button type="button" class="btn btn-link btn-sm text-muted p-1" data-td="compartilhar" title="Liberar para outras pessoas"><i class="ph ph-users fs-5"></i></button>`);
    if (podeEditar) acoes.push(`<button type="button" class="btn btn-link btn-sm text-muted p-1" data-td="editar" title="Editar"><i class="ph ph-pencil-simple fs-5"></i></button>`);
    if (podeEditar) acoes.push(`<button type="button" class="btn btn-link btn-sm text-muted p-1" data-td="apagar" title="Apagar"><i class="ph ph-trash fs-5"></i></button>`);

    const marca = t.concluida ? 'ph-check-circle' : 'ph-circle';
    const titCheck = podeConcluir ? (t.concluida ? 'Reabrir' : 'Concluir') : (t.concluida ? 'Concluída' : 'Pendente');
    return `<li class="td-item ${t.concluida ? 'td-feita' : ''}" data-id="${t.id}">
      <button type="button" class="td-check" data-td="alternar" title="${titCheck}" aria-label="${titCheck}" ${podeConcluir ? '' : 'disabled'}><i class="ph ${marca}"></i></button>
      <div class="td-corpo">
        <div class="td-titulo">${esc(t.titulo)}</div>
        ${chips.filter(Boolean).length ? `<div class="td-meta">${chips.filter(Boolean).join('')}</div>` : ''}
      </div>
      ${acoes.length ? `<div class="td-acoes">${acoes.join('')}</div>` : ''}
    </li>`;
  }

  function listaTarefas(tarefas, pane, vazio) {
    const pend = tarefas.filter((t) => !t.concluida);
    const feitas = tarefas.filter((t) => t.concluida);
    if (!tarefas.length) return `<div class="td-vazio text-muted">${vazio}</div>`;
    let html = pend.length ? `<ul class="td-lista">${pend.map((t) => linhaTarefa(t, pane)).join('')}</ul>` : '';
    if (feitas.length) {
      html += `<div class="td-secao-tit">Concluídas · ${feitas.length}</div>
        <ul class="td-lista">${feitas.map((t) => linhaTarefa(t, pane)).join('')}</ul>`;
    }
    return html;
  }

  function formNova(lista) {
    return `<form class="td-add" data-td-form="nova" data-lista="${lista}" autocomplete="off">
      <input type="text" class="form-control form-control-sm td-texto" name="titulo" maxlength="500" required
        placeholder="${lista === 'PESSOAL' ? 'Nova tarefa pessoal...' : 'Nova tarefa de trabalho...'}" aria-label="Tarefa">
      <input type="date" class="form-control form-control-sm td-prazo" name="prazo" title="Prazo (opcional)" aria-label="Prazo">
      <button type="submit" class="btn btn-primary btn-sm"><i class="ph ph-plus"></i> Adicionar</button>
    </form>`;
  }

  function formAtribuir() {
    const opcoes = st.usuarios.map((u) => `<option value="${u.id}">${esc(u.email)}</option>`).join('');
    return `<form class="td-add" data-td-form="atribuir" autocomplete="off">
      <input type="text" class="form-control form-control-sm td-texto" name="titulo" maxlength="500" required
        placeholder="Tarefa para outra pessoa..." aria-label="Tarefa">
      <select class="form-select form-select-sm td-dest" name="destinatarioId" required aria-label="Destinatário">
        <option value="">Para quem...</option>${opcoes}
      </select>
      <input type="date" class="form-control form-control-sm td-prazo" name="prazo" required title="Prazo (obrigatório)" aria-label="Prazo">
      <button type="submit" class="btn btn-primary btn-sm"><i class="ph ph-paper-plane-tilt"></i> Atribuir</button>
    </form>`;
  }

  function render() {
    const d = st.dados;
    if (!d) return;
    // Dropdown de listas.
    const sel = raiz.querySelector('#tdDono');
    sel.innerHTML = `<option value="">Minha lista</option>`
      + st.usuarios.map((u) => `<option value="${u.id}">${esc(u.email)}</option>`).join('');
    sel.value = st.alvoId ? String(st.alvoId) : '';
    raiz.querySelector('#tdSoLeitura').classList.toggle('d-none', d.propria);

    // Sub-abas.
    const visiveis = abasVisiveis();
    raiz.querySelector('#tdAbas').innerHTML = visiveis.map((k) => `
      <li class="nav-item" role="presentation">
        <button class="nav-link ${st.aba === k ? 'active' : ''}" type="button" role="tab" data-td="aba" data-aba="${k}">
          <i class="ph ${ABAS[k].icone}"></i> ${ABAS[k].rotulo}
        </button>
      </li>`).join('');

    // Conteúdo da aba ativa.
    let html = '';
    if (st.aba === 'trabalho') {
      html = (d.propria ? formNova('TRABALHO') : '')
        + listaTarefas(d.trabalho, 'trabalho', 'Nenhuma tarefa de trabalho.');
    } else if (st.aba === 'pessoal') {
      html = (d.propria ? formNova('PESSOAL') : `<p class="text-muted small mb-2">Só as tarefas que ${esc(d.dono.email)} liberou para você.</p>`)
        + listaTarefas(d.pessoal, 'pessoal', 'Nenhuma tarefa pessoal.');
    } else {
      html = formAtribuir() + listaTarefas(d.atribuidas, 'atribuidas', 'Você ainda não atribuiu tarefas a outras pessoas.');
    }
    raiz.querySelector('#tdConteudo').innerHTML = html;
  }

  // ---------- Modais (criados uma vez, no body) ----------
  function montarModais() {
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal fade" id="tdModalEditar" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered"><div class="modal-content">
          <form id="tdFormEditar" autocomplete="off">
            <div class="modal-header bg-primary text-white">
              <h5 class="modal-title"><i class="ph ph-pencil-simple me-2"></i>Editar tarefa</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Fechar"></button>
            </div>
            <div class="modal-body">
              <div id="tdEditarAviso"></div>
              <div class="mb-3">
                <label class="form-label" for="tdEditarTitulo">Tarefa</label>
                <input type="text" class="form-control" id="tdEditarTitulo" maxlength="500" required>
              </div>
              <div>
                <label class="form-label" for="tdEditarPrazo">Prazo <span class="text-muted fw-normal" id="tdEditarPrazoDica">(opcional)</span></label>
                <input type="date" class="form-control" id="tdEditarPrazo">
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancelar</button>
              <button type="submit" class="btn btn-primary"><i class="ph ph-check me-1"></i> Salvar</button>
            </div>
          </form>
        </div></div>
      </div>
      <div class="modal fade" id="tdModalCompartilhar" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable"><div class="modal-content">
          <div class="modal-header bg-primary text-white">
            <h5 class="modal-title"><i class="ph ph-users me-2"></i>Liberar tarefa</h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Fechar"></button>
          </div>
          <div class="modal-body">
            <div id="tdCompartilharAviso"></div>
            <p class="text-muted small mb-2">Quem marcar poderá <strong>ver</strong> esta tarefa na sua aba Pessoal. Ninguém edita.</p>
            <div id="tdCompartilharLista" class="d-flex flex-column gap-2"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="tdCompartilharSalvar"><i class="ph ph-check me-1"></i> Salvar</button>
          </div>
        </div></div>
      </div>
      <div class="modal fade" id="tdModalApagar" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered modal-sm"><div class="modal-content">
          <div class="modal-body text-center p-4">
            <div class="msg-icon msg-warning mb-3"><i class="ph ph-trash"></i></div>
            <h5 class="mb-2">Apagar tarefa?</h5>
            <p class="text-muted mb-4" id="tdApagarTexto"></p>
            <div class="d-flex gap-2 justify-content-center">
              <button type="button" class="btn btn-light px-3" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-outline-danger px-3" id="tdApagarOk">Apagar</button>
            </div>
          </div>
        </div></div>
      </div>`;
    document.body.append(...div.children);
    const inst = (id) => window.bootstrap.Modal.getOrCreateInstance(document.getElementById(id));
    modais = { editar: inst('tdModalEditar'), compartilhar: inst('tdModalCompartilhar'), apagar: inst('tdModalApagar') };

    document.getElementById('tdFormEditar').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const t = st.tarefaAberta;
      const prazo = document.getElementById('tdEditarPrazo').value;
      if (t.atribuida && !prazo) { document.getElementById('tdEditarAviso').innerHTML = '<div class="alert alert-danger py-2">Informe o prazo.</div>'; return; }
      const ok = await tentarNoModal('tdEditarAviso', () => api('PUT', `/api/todo/${t.id}`, {
        titulo: document.getElementById('tdEditarTitulo').value, prazo
      }));
      if (ok) { modais.editar.hide(); await recarregarLista(); }
    });
    document.getElementById('tdCompartilharSalvar').addEventListener('click', async () => {
      const t = st.tarefaAberta;
      const ids = [...document.querySelectorAll('#tdCompartilharLista input:checked')].map((i) => Number(i.value));
      const ok = await tentarNoModal('tdCompartilharAviso', () => api('PUT', `/api/todo/${t.id}/compartilhar`, { usuarioIds: ids }));
      if (ok) { modais.compartilhar.hide(); await recarregarLista(); }
    });
    document.getElementById('tdApagarOk').addEventListener('click', async () => {
      const t = st.tarefaAberta;
      modais.apagar.hide();
      if (await tentar(() => api('DELETE', `/api/todo/${t.id}`))) await recarregarLista();
    });
  }

  async function tentarNoModal(avisoId, fn) {
    try { await fn(); return true; } catch (e) {
      if (!e.sessao) document.getElementById(avisoId).innerHTML = `<div class="alert alert-danger py-2">${esc(e.message)}</div>`;
      return false;
    }
  }

  function tarefaDaLinha(el) {
    const li = el.closest('.td-item');
    if (!li) return null;
    const id = Number(li.dataset.id);
    const d = st.dados;
    return [...d.trabalho, ...d.pessoal, ...(d.atribuidas || [])].find((t) => t.id === id) || null;
  }

  function abrirEditar(t) {
    st.tarefaAberta = t;
    document.getElementById('tdEditarAviso').innerHTML = '';
    document.getElementById('tdEditarTitulo').value = t.titulo;
    document.getElementById('tdEditarPrazo').value = t.prazo || '';
    document.getElementById('tdEditarPrazo').required = t.atribuida;
    document.getElementById('tdEditarPrazoDica').textContent = t.atribuida ? '(obrigatório)' : '(opcional)';
    modais.editar.show();
  }

  function abrirCompartilhar(t) {
    st.tarefaAberta = t;
    document.getElementById('tdCompartilharAviso').innerHTML = '';
    const marcados = new Set(t.compartilhadoCom || []);
    document.getElementById('tdCompartilharLista').innerHTML = st.usuarios.length
      ? st.usuarios.map((u) => `<div class="form-check">
          <input class="form-check-input" type="checkbox" value="${u.id}" id="tdLib${u.id}" ${marcados.has(u.id) ? 'checked' : ''}>
          <label class="form-check-label" for="tdLib${u.id}">${esc(u.email)}</label></div>`).join('')
      : '<span class="text-muted">Não há outras pessoas com acesso ao TODO.</span>';
    modais.compartilhar.show();
  }

  function abrirApagar(t) {
    st.tarefaAberta = t;
    document.getElementById('tdApagarTexto').textContent = t.lista === 'PESSOAL' ? 'Esta tarefa pessoal será removida.' : t.titulo;
    modais.apagar.show();
  }

  // ---------- Eventos ----------
  function ligarEventos() {
    raiz.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-td]');
      if (!btn || !raiz.contains(btn)) return;
      const acao = btn.dataset.td;
      if (acao === 'aba') { st.aba = btn.dataset.aba; limparAviso(); render(); return; }
      if (acao === 'atualizar') { recarregar(); return; }
      const t = tarefaDaLinha(btn);
      if (!t) return;
      if (acao === 'alternar') {
        limparAviso();
        if (await tentar(() => api('PUT', `/api/todo/${t.id}/concluir`, { concluida: !t.concluida }))) await recarregarLista();
      } else if (acao === 'editar') abrirEditar(t);
      else if (acao === 'compartilhar') abrirCompartilhar(t);
      else if (acao === 'apagar') abrirApagar(t);
    });

    raiz.addEventListener('submit', async (ev) => {
      const form = ev.target.closest('[data-td-form]');
      if (!form) return;
      ev.preventDefault();
      limparAviso();
      const f = new FormData(form);
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      let ok;
      if (form.dataset.tdForm === 'nova') {
        ok = await tentar(() => api('POST', '/api/todo', { titulo: f.get('titulo'), prazo: f.get('prazo'), lista: form.dataset.lista }));
      } else {
        ok = await tentar(() => api('POST', '/api/todo/atribuir', {
          titulo: f.get('titulo'), prazo: f.get('prazo'), destinatarioId: Number(f.get('destinatarioId'))
        }));
      }
      btn.disabled = false;
      if (ok) {
        await recarregarLista();
        const campo = raiz.querySelector('#tdConteudo .td-texto');
        if (campo) campo.focus();
      }
    });

    raiz.querySelector('#tdDono').addEventListener('change', async (ev) => {
      st.alvoId = ev.target.value ? Number(ev.target.value) : null;
      st.aba = 'trabalho';
      limparAviso();
      await recarregarLista();
    });
  }

  function montar(elemento, opcoes) {
    raiz = elemento;
    cfg = opcoes || {};
    raiz.innerHTML = `
      <div class="td-tela">
        <div class="td-toolbar">
          <div class="td-dono">
            <label for="tdDono"><i class="ph ph-users"></i> Lista de</label>
            <select class="form-select form-select-sm" id="tdDono"><option value="">Minha lista</option></select>
            <span class="td-chip d-none" id="tdSoLeitura"><i class="ph ph-eye"></i> Somente leitura</span>
          </div>
          <button type="button" class="btn btn-link btn-sm text-muted p-1" data-td="atualizar" title="Atualizar">
            <i class="ph ph-arrow-clockwise fs-5"></i>
          </button>
        </div>
        <div id="tdAviso"></div>
        <ul class="nav sub-tabs" role="tablist" id="tdAbas"></ul>
        <div id="tdConteudo"><div class="text-muted">Carregando...</div></div>
      </div>`;
    if (!modais) montarModais();
    ligarEventos();
    return recarregar();
  }

  // Esvazia tudo (logout): a próxima pessoa que entrar não pode ver, nem por um
  // instante, o que a anterior deixou na tela.
  function limpar() {
    st.eu = null; st.usuarios = []; st.alvoId = null; st.dados = null; st.aba = 'trabalho'; st.tarefaAberta = null;
    if (!raiz) return;
    limparAviso();
    raiz.querySelector('#tdAbas').innerHTML = '';
    raiz.querySelector('#tdConteudo').innerHTML = '<div class="text-muted">Carregando...</div>';
    raiz.querySelector('#tdDono').innerHTML = '<option value="">Minha lista</option>';
    raiz.querySelector('#tdSoLeitura').classList.add('d-none');
  }

  window.TodoTela = { montar, recarregar, limpar };
})();
