// ============================================================
//  App de Gestão TI — cliente da API (Node + SQL Server)
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
  if (res.status === 401 && TOKEN) { sairDoApp(); throw new Error('Sessão expirada. Entre novamente.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
  return data;
}

// ---------- Constantes de domínio ----------
const OPTION_LISTS = ['UNIDADE', 'STATUS', 'SETOR', 'EQUIPAMENTO', 'INSUMOS'];
const FORM_SELECTS = ['unidade', 'status', 'setor', 'equipamento'];
const SELECT_TO_LIST = { unidade: 'UNIDADE', status: 'STATUS', setor: 'SETOR', equipamento: 'EQUIPAMENTO' };
const SEARCHABLE = new Set(['setor', 'edit_setor', 'equipamento', 'edit_equipamento', 'emp_pat', 'nc_assunto', 'nc_unidade', 'nc_patrimonio', 'nc_ns', 'im_unidade', 'im_bkp_pat']);
const CHOICES_IDS = [
  'unidade', 'status', 'setor', 'equipamento',
  'edit_unidade', 'edit_status', 'edit_setor', 'edit_equipamento',
  'insumo', 'edit_insumo',
  'listaAlvo', 'emp_pat', 'emp_unidade',
  'nc_assunto', 'nc_unidade', 'nc_patrimonio', 'nc_ns',
  'im_unidade', 'im_bkp_pat'
];

// ---------- Estado em memória ----------
let OPTIONS = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [], INSUMOS: [] };
let HIDDEN = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [], INSUMOS: [] };
let EQUIP_DETALHE = {};
let EQUIP_PRECO = {};
let EQUIP_TIPO = {};
let EQUIP_QTD_REG = {};
let UNIDADE_MSA = {};      // UNIDADE do sistema -> unidade correspondente na MSA (col. detalhe)
let MSA_UNIDADES = [];     // lista fixa de unidades da MSA (CHAMADO_UNIDADES)
let INSUMO_QTD = {};
let INSUMOS = [];
let REGISTROS = [];
let modalEditar = null;
let modalMsg = null;
let modalAsk = null;
let askResolve = null;
let askSelect2Ativo = false;   // campo 2 do uiAsk está em modo lista (select)?
const fpMap = {};
let modalHistorico = null;
let modalRegistrar = null;
let modalLog = null;
let modalNovoChamado = null;
let modalChamadoDetalhe = null;
let _chamadoDetalheAtual = null;
const choicesMap = {};

// --- Filtros de coluna ---
let colFilters  = {};   // col(string) → Set<string>; ausente = sem filtro
let _fdCol      = -1;
let _fdPendente = null;
let _fdAllVals  = [];
let _fdEl       = null;
let _fdOutside  = null;
let _fdScroll   = null;
let _fdActive   = null; // contexto (tabela) ativo do dropdown
let _fdScrollEl = null; // container rolável da tabela ativa

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
let askOnOk = null; // async handler — quando definido, OK não fecha o dialog direto

function uiAsk({ title, message, input, value, input2Label, value2, input2Select, input3Label, value3, input4Label, value4, okText, danger, transfer, onOk }) {
  return new Promise((resolve) => {
    askResolve = resolve;
    askOnOk = onOk || null;
    $('askTitle').textContent = title || '';
    $('askText').textContent = message || '';
    const trans = $('askTransfer');
    if (transfer) {
      $('askTransferFromLabel').textContent = transfer.fromLabel || 'Emprestado em';
      $('askTransferToLabel').textContent = transfer.toLabel || 'Devolver para';
      $('askTransferFrom').textContent = transfer.from;
      $('askTransferTo').textContent = transfer.to;
      trans.classList.remove('hidden');
    } else {
      trans.classList.add('hidden');
    }
    const inp = $('askInput');
    if (input) { inp.classList.remove('hidden'); inp.value = value || ''; }
    else { inp.classList.add('hidden'); }
    const wrap2 = $('askInput2Wrap');
    const inp2 = $('askInput2');
    const sel2 = $('askSelect2');
    askSelect2Ativo = false;
    if (input2Label !== undefined) {
      $('askInput2Label').textContent = input2Label;
      if (Array.isArray(input2Select)) {
        // Campo 2 vira uma lista (select) com o visual padrão do sistema (Choices.js).
        askSelect2Ativo = true;
        if (typeof Choices !== 'undefined' && !choicesMap['askSelect2']) {
          choicesMap['askSelect2'] = new Choices(sel2, {
            searchEnabled: false, itemSelectText: '', shouldSort: false,
            allowHTML: false, placeholder: true, placeholderValue: 'Selecione...',
          });
        }
        const inst = choicesMap['askSelect2'];
        const itens = [{ value: '', label: '— não associada —', placeholder: true, selected: !value2 }]
          .concat(input2Select.map((o) => ({ value: o, label: o, selected: o === value2 })));
        if (inst) {
          inst.setChoices(itens, 'value', 'label', true);
          if (value2) inst.setChoiceByValue(value2);
        } else {
          sel2.innerHTML = itens.map((o) =>
            '<option value="' + escapeHtml(o.value) + '"' + (o.selected ? ' selected' : '') +
            '>' + escapeHtml(o.label) + '</option>').join('');
        }
        const choicesEl = inst ? sel2.closest('.choices') : sel2;
        if (choicesEl) choicesEl.classList.remove('hidden');
        inp2.classList.add('hidden');
      } else {
        inp2.value = value2 || '';
        inp2.classList.remove('hidden');
        const inst = choicesMap['askSelect2'];
        const choicesEl = inst ? sel2.closest('.choices') : sel2;
        if (choicesEl) choicesEl.classList.add('hidden');
      }
      wrap2.classList.remove('hidden');
    } else {
      wrap2.classList.add('hidden');
    }
    const wrap3 = $('askInput3Wrap');
    if (input3Label !== undefined) {
      $('askInput3Label').textContent = input3Label;
      $('askInput3').value = value3 != null ? value3 : '';
      wrap3.classList.remove('hidden');
    } else {
      wrap3.classList.add('hidden');
    }
    const wrap4 = $('askInput4Wrap');
    if (input4Label !== undefined) {
      $('askInput4Label').textContent = input4Label;
      $('askInput4').value = value4 || '';
      wrap4.classList.remove('hidden');
    } else {
      wrap4.classList.add('hidden');
    }
    const ok = $('askOk');
    ok.textContent = okText || 'OK';
    ok.className = 'btn ' + (danger ? 'btn-outline-danger' : 'btn-primary');
    $('askOverlay').classList.add('show');
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 100);
  });
}

function askClose(result) {
  const r = askResolve; askResolve = null; askOnOk = null;
  askClearError();
  $('askOverlay').classList.remove('show');
  r(result);
}

async function finishAsk(confirmado) {
  if (!askResolve) return;
  const inputVisivel = !$('askInput').classList.contains('hidden');
  const input2Visivel = !$('askInput2Wrap').classList.contains('hidden');
  const input3Visivel = !$('askInput3Wrap').classList.contains('hidden');

  if (!confirmado) { askClose(inputVisivel ? null : false); return; }

  const input4Visivel = !$('askInput4Wrap').classList.contains('hidden');
  const detalhe2 = askSelect2Ativo ? $('askSelect2').value : $('askInput2').value;
  const result = !inputVisivel ? true
    : input2Visivel
      ? { valor: $('askInput').value, detalhe: detalhe2,
          preco: input3Visivel ? ($('askInput3').value !== '' ? $('askInput3').value : null) : undefined,
          tipo: input4Visivel ? ($('askInput4').value || null) : undefined }
      : $('askInput').value;

  if (askOnOk) {
    const btn = $('askOk');
    btn.disabled = true;
    try {
      await askOnOk(result);
      askClose(result);
    } catch (err) {
      askShowError(err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  askClose(result);
}

function uiConfirm(message, opts = {}) {
  return uiAsk({
    title: opts.title || 'Confirmar', message,
    okText: opts.okText || 'Confirmar', danger: opts.danger !== false,
    transfer: opts.transfer
  });
}

function uiPrompt(message, opts = {}) {
  return uiAsk({
    title: opts.title || '', message,
    input: true, value: opts.value || '', okText: opts.okText || 'Salvar'
  });
}

function uiPrompt2(message, opts = {}) {
  if (opts.error) askShowError(opts.error);
  return uiAsk({
    title: opts.title || '', message,
    input: true, value: opts.value || '',
    input2Label: opts.label2 || '', value2: opts.value2 || '',
    okText: opts.okText || 'Salvar'
  });
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trim(v) { return String(v == null ? '' : v).trim(); }

function formatarMoeda(val) {
  if (val === '' || val == null) return '';
  const num = Number(val);
  if (isNaN(num)) return '';
  return 'R$ ' + num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseMoeda(str) {
  if (!str) return null;
  const clean = String(str).replace(/R\$\s?/g, '').replace(/\./g, '').replace(',', '.').trim();
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
}

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

function initFlatpickr() {
  if (typeof window.flatpickr === 'undefined') return;
  const flatpickr = window.flatpickr;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const cfg = {
    locale: 'pt',
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'd/m/Y',
    allowInput: true,
    disableMobile: true,
    closeOnSelect: !isTouch,
    minDate: 'today',
    monthSelectorType: 'static',
    onReady(_d, _s, fp) {
      fp.altInput.classList.add('form-control');
      if (isTouch) {
        fp.altInput.setAttribute('readonly', true);
        const lbl = document.querySelector('label[for="' + fp.input.id + '"]');
        const titulo = lbl ? lbl.textContent.replace('*', '').trim() : 'DATA';
        const header = document.createElement('div');
        header.className = 'fp-mobile-header';
        header.textContent = titulo;
        fp.calendarContainer.insertBefore(header, fp.calendarContainer.firstChild);
      }

      // Torna o input do ano somente leitura (como o mês estático)
      const yearInput = fp.calendarContainer.querySelector('.cur-year');
      if (yearInput) yearInput.setAttribute('readonly', true);

      // Substitui SVGs das setas de mês por ícones Phosphor
      const prev = fp.calendarContainer.querySelector('.flatpickr-prev-month');
      const next = fp.calendarContainer.querySelector('.flatpickr-next-month');
      if (prev) prev.innerHTML = '<i class="ph ph-caret-left"></i>';
      if (next) next.innerHTML = '<i class="ph ph-caret-right"></i>';

      // Máscara dd/mm/aaaa
      fp.altInput.addEventListener('input', (ev) => {
        const input = ev.target;
        const digits = input.value.replace(/\D/g, '').slice(0, 8);
        let masked = digits;
        if (digits.length > 4) masked = digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4);
        else if (digits.length > 2) masked = digits.slice(0, 2) + '/' + digits.slice(2);
        input.value = masked;
        if (digits.length === 8) fp.setDate(masked, false, 'd/m/Y');
      });

      // Botão "Hoje" no rodapé do calendário
      const footer = document.createElement('div');
      footer.className = 'fp-footer';
      footer.style.cssText = 'padding:6px 8px;border-top:1px solid var(--line);text-align:center;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Hoje';
      btn.style.cssText =
        'width:100%;padding:6px;border:none;border-radius:8px;' +
        'background:var(--ink);color:#fff;font-family:inherit;font-size:.85rem;' +
        'font-weight:600;cursor:pointer;letter-spacing:.3px;';
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--ink-2)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--ink)'; });
      btn.addEventListener('click', () => {
        fp.setDate(new Date(), false);
        if (isTouch) fp._fechandoPorSelecao = true;
        fp.close();
      });
      footer.appendChild(btn);
      fp.calendarContainer.appendChild(footer);
    },
    onChange(_d, _s, fp) {
      if (isTouch) {
        fp._fechandoPorSelecao = true;
        fp.close();
      }
    },
    onOpen(_d, _s, fp) {
      if (!isTouch) return;
      fp._fechandoPorSelecao = false;
      fp._blocker = (e) => {
        if (fp.isOpen && !fp.calendarContainer.contains(e.target)) {
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      };
      ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach((ev) => {
        document.addEventListener(ev, fp._blocker, true);
      });
      let bd = document.getElementById('fp-backdrop');
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'fp-backdrop';
        document.body.appendChild(bd);
      }
      bd.classList.add('fp-backdrop--visible');
    },
    onClose(_d, _s, fp) {
      if (!isTouch) return;
      if (fp._blocker) {
        ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach((ev) => {
          document.removeEventListener(ev, fp._blocker, true);
        });
        fp._blocker = null;
      }
      const bd = document.getElementById('fp-backdrop');
      if (bd) bd.classList.remove('fp-backdrop--visible');
    },
  };
  ['dataRecebimento', 'edit_dataRecebimento', 'emp_data'].forEach((id) => {
    const el = $(id);
    if (el && !fpMap[id]) fpMap[id] = flatpickr(el, cfg);
  });
}

// Valor sentinela do item "Adicionar nova opção...".
const NEW_OPTION_VALUE = '__novo__';
const NEW_OPTION_LABEL = '+ Adicionar nova opção...';

function fillSelect(selectId, values, selected, addNew) {
  const sel = $(selectId);
  const alvo = (selected !== undefined && selected !== null) ? String(selected) : (sel.value || '');
  // Nunca preserva o sentinela como seleção.
  const alvoFinal = alvo === NEW_OPTION_VALUE ? '' : alvo;
  const inst = choicesMap[selectId];

  if (inst) {
    const lista = [{ value: '', label: 'Selecione...', placeholder: true, selected: !alvoFinal }]
      .concat(values.map((v) => ({ value: v, label: v, selected: alvoFinal === v })));
    if (addNew) lista.push({ value: NEW_OPTION_VALUE, label: NEW_OPTION_LABEL });
    inst.setChoices(lista, 'value', 'label', true);
    if (alvoFinal && values.indexOf(alvoFinal) !== -1) inst.setChoiceByValue(alvoFinal);
    return;
  }
  sel.innerHTML = '<option value="">Selecione...</option>';
  values.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  });
  if (addNew) {
    const opt = document.createElement('option');
    opt.value = NEW_OPTION_VALUE; opt.textContent = NEW_OPTION_LABEL;
    sel.appendChild(opt);
  }
  if (alvoFinal && values.indexOf(alvoFinal) !== -1) sel.value = alvoFinal;
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
  FORM_SELECTS.forEach((id) => fillSelect(id, activeValues(SELECT_TO_LIST[id]), undefined, true));
}

function clearFormSelects() {
  FORM_SELECTS.forEach((id) => fillSelect(id, activeValues(SELECT_TO_LIST[id]), '', true));
}

// Ao escolher "+ Adicionar nova opção...", abre o modal de prompt e cadastra.
function askShowError(msg) {
  const el = $('askAlert');
  el.innerHTML = '<div class="alert alert-danger py-2 mb-0 mt-2">' + escapeHtml(msg) + '</div>';
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => askClearError(), 5000);
}
function askClearError() {
  const el = $('askAlert');
  el.innerHTML = '';
  el.classList.add('hidden');
}

async function aoEscolherNovo(selectId) {
  const lista = SELECT_TO_LIST[selectId];

  if (lista === 'EQUIPAMENTO') {
    const detId = selectId === 'equipamento' ? 'equipamento_detalhe' : 'edit_equipamento_detalhe';
    const res = await uiAsk({
      title: 'Nova opção', message: 'Nome do equipamento:',
      input: true, input2Label: 'Equipamento detalhe (opcional)',
      input3Label: 'Valor padrão (R$, opcional)',
      input4Label: 'Comprado/Locado',
      okText: 'Salvar',
      onOk: async ({ valor: v, detalhe: d, preco: p, tipo: t }) => {
        const valor = trim(v).toUpperCase();
        if (!valor) throw new Error('O nome não pode ser vazio.');
        const detalhe = trim(d) || null;
        const preco = p !== null && p !== '' && p !== undefined ? Number(String(p).replace(',', '.')) : null;
        await api('POST', '/api/options', { lista, valor, detalhe, preco: !isNaN(preco) ? preco : null, tipo_aquisicao: t || null });
        await loadOptions();
        fillSelect(selectId, activeValues(lista), valor, true);
        atualizarEquipDetalhe(valor, detId);
      }
    });
    if (res === null) fillSelect(selectId, activeValues(lista), '', true);
  } else {
    const novo = await uiPrompt('Nova opção para ' + lista + ':', { title: 'Nova opção' });
    if (!novo || !trim(novo)) { fillSelect(selectId, activeValues(lista), '', true); return; }
    const valor = trim(novo).toUpperCase();
    try {
      await api('POST', '/api/options', { lista, valor });
      await loadOptions();
      fillSelect(selectId, activeValues(lista), valor, true);
      showAlert('alertRegistrar', 'success', 'Opção "' + valor + '" adicionada a ' + lista + '.');
    } catch (err) {
      fillSelect(selectId, activeValues(lista), '', true);
      showAlert('alertRegistrar', 'danger', err.message);
    }
  }
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
  EQUIP_DETALHE = {};
  EQUIP_PRECO = {};
  EQUIP_TIPO = {};
  EQUIP_QTD_REG = {};
  (data['EQUIPAMENTO'] || []).forEach((o) => {
    if (o.detalhe) EQUIP_DETALHE[o.valor] = o.detalhe;
    if (o.preco != null) EQUIP_PRECO[o.valor] = o.preco;
    if (o.tipo_aquisicao) EQUIP_TIPO[o.valor] = o.tipo_aquisicao;
    EQUIP_QTD_REG[o.valor] = o.qtd_registros ?? 0;
  });
  UNIDADE_MSA = {};
  (data['UNIDADE'] || []).forEach((o) => { if (o.detalhe) UNIDADE_MSA[o.valor] = o.detalhe; });
  if (!MSA_UNIDADES.length) {
    try { MSA_UNIDADES = await api('GET', '/api/chamados/unidades'); }
    catch { MSA_UNIDADES = []; }
  }
  INSUMO_QTD = {};
  (data['INSUMOS'] || []).forEach((o) => { INSUMO_QTD[o.valor] = o.quantidade ?? 0; });
  INSUMOS = (data['INSUMOS'] || []).filter((o) => !o.oculto).map((o) => o.valor);
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
  const isEquip = lista === 'EQUIPAMENTO';
  const isInsumo = lista === 'INSUMOS';
  const isUnidade = lista === 'UNIDADE';

  const linhas = values.map((v) => {
    const ativo = hidden.indexOf(v) === -1;
    const vEsc = escapeHtml(v);
    const detalhe = isEquip ? (EQUIP_DETALHE[v] || '') : isUnidade ? (UNIDADE_MSA[v] || '') : '';
    const preco = isEquip && EQUIP_PRECO[v] != null
      ? 'R$ ' + Number(EQUIP_PRECO[v]).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
      : '';
    const tipo = isEquip ? (EQUIP_TIPO[v] || '') : '';
    let nomeCell = vEsc;
    if (isEquip) {
      const sub = [detalhe ? escapeHtml(detalhe) : '', preco ? escapeHtml(preco) : '', tipo ? escapeHtml(tipo) : ''].filter(Boolean).join(' · ');
      nomeCell = vEsc + (sub ? '<br><small class="text-muted">' + sub + '</small>' : '');
    } else if (isUnidade && detalhe) {
      nomeCell = vEsc + '<br><small class="text-muted">' + escapeHtml(detalhe) + '</small>';
    }
    const status = ativo
      ? '<span class="badge-status badge-ativo">ATIVO</span>'
      : '<span class="badge-status badge-inativo">INATIVO</span>';
    const toggle = ativo
      ? '<button type="button" class="acao-link acao-ocultar" data-toggle-opt data-val="' +
        vEsc + '" data-hide="1"><i class="ph ph-eye-slash"></i> Ocultar</button>'
      : '<button type="button" class="acao-link acao-exibir" data-toggle-opt data-val="' +
        vEsc + '" data-hide="0"><i class="ph ph-eye"></i> Exibir</button>';
    const precoAttr = isEquip && EQUIP_PRECO[v] != null ? ' data-preco="' + EQUIP_PRECO[v] + '"' : '';
    const tipoAttr = isEquip && EQUIP_TIPO[v] ? ' data-tipo="' + escapeHtml(EQUIP_TIPO[v]) + '"' : '';
    const editar = '<button type="button" class="acao-link acao-editar ms-3" ' +
      'data-edit-opt data-val="' + vEsc + '" data-detalhe="' + escapeHtml(detalhe) + '"' + precoAttr + tipoAttr + '>' +
      '<i class="ph ph-pencil-simple"></i> Editar</button>';

    let qtdCell = '';
    if (isInsumo) {
      const qtd = INSUMO_QTD[v] ?? 0;
      qtdCell = '<td><div class="d-flex align-items-center gap-1" style="width:110px">' +
        '<input type="number" class="form-control form-control-sm text-center" min="0" ' +
        'data-qtd-insumo data-val="' + vEsc + '" value="' + qtd + '" style="width:70px">' +
        '<span class="text-muted small">un</span></div></td>';
    } else if (isEquip) {
      const cnt = EQUIP_QTD_REG[v] ?? 0;
      qtdCell = '<td><span class="badge bg-secondary bg-opacity-10 text-secondary fw-normal">' +
        cnt + '</span></td>';
    } else {
      qtdCell = '<td></td>';
    }

    return '<tr><td class="opt-nome">' + nomeCell + '</td>' +
      qtdCell +
      '<td>' + status + '</td>' +
      '<td class="text-end">' + toggle + editar + '</td></tr>';
  }).join('');

  const qtdHeader = isInsumo ? '<th>Qtd. em estoque</th>' : isEquip ? '<th>Registros</th>' : '<th></th>';
  container.innerHTML =
    '<div class="table-responsive"><table class="table table-striped align-middle tabela-opcoes mb-0">' +
    '<thead><tr><th>Opção</th>' + qtdHeader + '<th>Status</th><th class="text-end">Ação</th></tr></thead>' +
    '<tbody>' + linhas + '</tbody></table></div>';
}

// ============================================================
//  Registros
// ============================================================
function dadosFormulario(prefix) {
  const g = (campo) => $((prefix || '') + campo).value;
  return {
    unidade: trim(g('unidade')), status: trim(g('status')), setor: trim(g('setor')),
    usuario: trim(g('usuario')), ns: trim(g('ns')),
    pat: trim(g('pat')), equipamento: trim(g('equipamento')),
    equipamento_detalhe: trim(g('equipamento_detalhe')) || null,
    obs: trim(g('obs')),
    protocolo: trim(g('protocolo')),
    dataRecebimento: trim(g('dataRecebimento')) || null,
    valor: parseMoeda(g('valor')),
    insumo: trim(g('insumo')) || null,
    tipo_aquisicao: trim(g('tipo_aquisicao')) || null,
    imagem_base64:  g('foto_1_base64') || null,
    imagem2_base64: g('foto_2_base64') || null,
    imagem3_base64: g('foto_3_base64') || null
  };
}

const PAGE_SIZE = 50;
let _recOffset = 0;
let _recLoading = false;
let _recAllLoaded = false;
let _todosRegistros = [];
let _todosCarregados = false;
let _todosCarregando = null;

async function carregarTodosParaFiltro() {
  if (_todosCarregados) return;
  if (_todosCarregando) return _todosCarregando;
  _todosCarregando = api('GET', '/api/records?all=1').then(r => {
    _todosRegistros = r;
    _todosCarregados = true;
    _todosCarregando = null;
  }).catch(() => { _todosCarregando = null; });
  return _todosCarregando;
}

function invalidarCacheTodos() {
  _todosRegistros = [];
  _todosCarregados = false;
  _todosCarregando = null;
}

async function loadRecords(reset = true) {
  if (_recLoading) return;
  if (!reset && _recAllLoaded) return;

  if (reset) {
    _recOffset = 0;
    _recAllLoaded = false;
    REGISTROS = [];
    $('corpoTabela').innerHTML = '<tr><td colspan="14" class="text-muted">Carregando...</td></tr>';
    $('sentinelTabela').classList.add('d-none');
  }

  _recLoading = true;
  try {
    const novos = await api('GET', '/api/records?limit=' + PAGE_SIZE + '&offset=' + _recOffset);
    if (reset) {
      REGISTROS = novos;
      renderTabela();
    } else {
      REGISTROS = [...REGISTROS, ...novos];
      appendTabela(novos);
    }
    _recOffset += novos.length;
    _recAllLoaded = novos.length < PAGE_SIZE;
    $('sentinelTabela').classList.toggle('d-none', _recAllLoaded);
  } catch (err) {
    showAlert('alertRegistros', 'danger', 'Erro ao carregar registros: ' + err.message);
    if (reset) $('corpoTabela').innerHTML = '<tr><td colspan="14" class="text-danger">Falha ao carregar.</td></tr>';
  } finally {
    _recLoading = false;
  }
}

// Renderiza um PAT como botão que abre o histórico (ou vazio se não houver).
function patLink(pat, ns) {
  if (!pat) return '';
  const e = escapeHtml(pat);
  const nsAttr = ns ? ' data-ns="' + escapeHtml(ns) + '"' : '';
  return '<button type="button" class="pat-link" data-hist="' + e + '"' + nsAttr + '>' + e + '</button>';
}

function rowHtml(r) {
  return '<tr>' +
    '<td title="' + escapeHtml(r.unidade) + '">' + escapeHtml(r.unidade) + '</td>' +
    '<td>' + escapeHtml(r.status) + '</td>' +
    '<td>' + escapeHtml(r.setor) + '</td>' +
    '<td>' + escapeHtml(r.usuario) + '</td>' +
    '<td>' + escapeHtml(r.ns) + '</td>' +
    '<td>' + patLink(r.pat, r.ns) + '</td>' +
    '<td>' + escapeHtml(r.equipamento) + '</td>' +
    '<td>' + escapeHtml(r.protocolo) + '</td>' +
    '<td>' + fmtData(r.dataRecebimento) + '</td>' +
    '<td title="' + escapeHtml(r.obs) + '">' + escapeHtml(r.obs) + '</td>' +
    '<td class="text-center">' + (r.temFoto ? '<i class="ph ph-camera-fill text-primary"></i>' : '<span class="text-muted">—</span>') + '</td>' +
    '<td class="text-end">' +
      '<button type="button" class="btn btn-sm btn-outline-primary" data-edit="' +
        escapeHtml(r.id) + '">Editar</button>' +
    '</td></tr>';
}

function renderTabela() {
  const corpo = $('corpoTabela');
  const temFiltro = Object.keys(colFilters).length > 0;
  const fonte = temFiltro && _todosCarregados ? _todosRegistros : REGISTROS;
  const filtered = temFiltro ? fonte.filter(passaFiltros) : REGISTROS;
  $('sentinelTabela').classList.toggle('d-none', _recAllLoaded || temFiltro);
  if (!filtered.length) {
    const msg = temFiltro
      ? 'Nenhum registro corresponde ao filtro ativo.'
      : 'Nenhum registro cadastrado.';
    corpo.innerHTML = '<tr><td colspan="12" class="text-muted">' + msg + '</td></tr>';
    return;
  }
  corpo.innerHTML = filtered.map(rowHtml).join('');
  atualizarThFiltro();
}

function appendTabela(registros) {
  if (Object.keys(colFilters).length > 0) return;
  $('corpoTabela').insertAdjacentHTML('beforeend', registros.map(rowHtml).join(''));
}

function carregarFotosEdicao(id) {
  [1, 2, 3].forEach((n) => resetSlotFoto('edit_', n));
  $('edit_foto_1_slot').classList.add('d-none');
  $('edit_foto_2_slot').classList.add('d-none');
  $('edit_foto_3_slot').classList.add('d-none');
  $('edit_btnAddFoto').classList.remove('d-none');
  api('GET', '/api/records/' + id + '/imagem').then((data) => {
    ['imagem_base64', 'imagem2_base64', 'imagem3_base64'].forEach((campo, i) => {
      const n = i + 1;
      if (data[campo]) {
        $(`edit_foto_${n}_base64`).value = data[campo];
        $(`edit_foto_${n}_thumb`).src = data[campo];
        $(`edit_foto_${n}_preview`).classList.remove('d-none');
        $(`edit_foto_${n}_slot`).classList.remove('d-none');
      }
    });
    atualizarBtnAddFoto('edit_');
  }).catch(() => {});
}

function abrirEdicao(id) {
  const r = REGISTROS.filter((x) => String(x.id) === String(id))[0];
  if (!r) return;
  $('edit_id').value = r.id;
  fillSelect('edit_unidade', valsParaEdicao('UNIDADE', r.unidade), r.unidade);
  fillSelect('edit_status', valsParaEdicao('STATUS', r.status), r.status);
  fillSelect('edit_setor', valsParaEdicao('SETOR', r.setor), r.setor);
  fillSelect('edit_equipamento', valsParaEdicao('EQUIPAMENTO', r.equipamento), r.equipamento);
  const edEl = $('edit_equipamento_detalhe');
  edEl.value = r.equipamentoDetalhe || '';
  edEl.readOnly = true;
  $('edit_tipo_aquisicao').value = r.tipoAquisicao || '';
  const isImp = ehImpressora(r.equipamento);
  $('edit_insumo_grupo').classList.toggle('hidden', !isImp);
  fillSelect('edit_insumo', isImp ? INSUMOS : [], r.insumo || '');
  $('edit_usuario').value = r.usuario || '';
  $('edit_ns').value = r.ns || '';
  $('edit_pat').value = r.pat || '';
  $('edit_protocolo').value = r.protocolo || '';
  if (fpMap['edit_dataRecebimento']) {
    fpMap['edit_dataRecebimento'].setDate(r.dataRecebimento || '', false);
  } else {
    $('edit_dataRecebimento').value = r.dataRecebimento || '';
  }
  $('edit_valor').value = r.valor != null ? formatarMoeda(r.valor) : '';
  $('edit_obs').value = r.obs || '';
  carregarFotosEdicao(r.id);
  $('edit_criadoPor').value = r.criadoPor || '—';
  $('edit_atualizadoPor').value = r.atualizadoPor || '—';
  const jEl = $('edit_justificativa');
  jEl.value = '';
  jEl.disabled = true;
  jEl.required = false;
  jEl.placeholder = '';
  $('formEditar').classList.remove('was-validated');
  modalEditar.show();
}

// ============================================================
//  Filtros de coluna (tabela Registros)
// ============================================================
const COL_FIELDS = ['unidade','status','setor','usuario','ns','pat','equipamento','protocolo','dataRecebimento','obs','temFoto'];

function colVal(r, col) {
  const f = COL_FIELDS[col];
  if (!f) return '';
  const v = r[f];
  if (v == null || String(v).trim() === '') return '';
  if (f === 'dataRecebimento') return fmtData(v);
  if (f === 'temFoto') return Number(v) ? 'Sim' : 'Não';
  return String(v);
}

function passaFiltros(r) {
  for (const [k, sel] of Object.entries(colFilters)) {
    if (!sel.has(colVal(r, Number(k)))) return false;
  }
  return true;
}

function atualizarThFiltro() {
  document.querySelectorAll('#tabelaScroll thead th[data-col]').forEach(th => {
    const ativo = colFilters[th.getAttribute('data-col')] != null;
    th.classList.toggle('col-filter-ativo', ativo);
  });
  const btnLimpar = $('btnLimparFiltros');
  if (btnLimpar) btnLimpar.classList.toggle('filtro-on', Object.keys(colFilters).length > 0);
}

function criarFilterDropdown() {
  if (_fdEl) return;
  _fdEl = document.createElement('div');
  _fdEl.id = 'colFilterDropdown';
  _fdEl.style.display = 'none';
  _fdEl.innerHTML =
    '<div style="padding:.75rem .75rem .5rem">' +
      '<div class="input-group input-group-sm mb-2">' +
        '<span class="input-group-text"><i class="ph ph-magnifying-glass"></i></span>' +
        '<input type="text" class="form-control" id="fdSearch" placeholder="Buscar...">' +
      '</div>' +
      '<div class="d-flex justify-content-between align-items-center" style="font-size:.8rem">' +
        '<a href="#" id="fdSelAll" class="text-decoration-none fw-semibold">Selecionar tudo</a>' +
        '<a href="#" id="fdClear" class="text-decoration-none">Limpar</a>' +
      '</div>' +
    '</div>' +
    '<hr class="my-0">' +
    '<div id="fdList"></div>' +
    '<hr class="my-0">' +
    '<div style="padding:.6rem .75rem;display:flex;justify-content:flex-end;gap:.5rem">' +
      '<button type="button" class="btn btn-outline-secondary btn-sm" id="fdCancel">Cancelar</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="fdOk">OK</button>' +
    '</div>';
  document.body.appendChild(_fdEl);

  _fdEl.querySelector('#fdSearch').addEventListener('input', fdRenderList);
  _fdEl.querySelector('#fdSelAll').addEventListener('click', (e) => {
    e.preventDefault();
    _fdAllVals.forEach(v => _fdPendente.add(v));
    fdRenderList();
  });
  _fdEl.querySelector('#fdClear').addEventListener('click', (e) => {
    e.preventDefault();
    _fdPendente.clear();
    fdRenderList();
  });
  _fdEl.querySelector('#fdOk').addEventListener('click', fdAplicar);
  _fdEl.querySelector('#fdCancel').addEventListener('click', fdFechar);
}

function fdRenderList() {
  const busca = _fdEl.querySelector('#fdSearch').value.toLowerCase();
  const visiveis = busca
    ? _fdAllVals.filter(v => (v === '' ? '(espaços em branco)' : v.toLowerCase()).includes(busca))
    : _fdAllVals.slice();
  const lista = _fdEl.querySelector('#fdList');
  lista.innerHTML = visiveis.map((v, i) => {
    const chk = _fdPendente.has(v) ? ' checked' : '';
    const lbl = v === '' ? '<em class="text-muted">(Espaços em branco)</em>' : escapeHtml(v);
    return '<label class="col-filter-item"><input type="checkbox" data-idx="' + i + '"' + chk + '> ' + lbl + '</label>';
  }).join('');
  lista.querySelectorAll('input[type=checkbox]').forEach(cb => {
    const v = visiveis[Number(cb.dataset.idx)];
    cb.addEventListener('change', () => { if (cb.checked) _fdPendente.add(v); else _fdPendente.delete(v); });
  });
}

// --- Filtro de coluna genérico (funciona em qualquer tabela via "contexto") ---
// ctx = { theadSel, getRows(), colVal(r,col), filters{}, onApply(), beforeOpen? }
function ctxUnique(ctx, col) {
  const seen = new Set(), out = [];
  for (const r of ctx.getRows()) {
    const v = ctx.colVal(r, col);
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out.sort((a, b) => a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'pt-BR'));
}

function ctxPassa(ctx, r) {
  for (const [k, sel] of Object.entries(ctx.filters)) {
    if (!sel.has(ctx.colVal(r, Number(k)))) return false;
  }
  return true;
}

function ctxAtualizarTh(ctx) {
  document.querySelectorAll(ctx.theadSel).forEach((th) => {
    th.classList.toggle('col-filter-ativo', ctx.filters[th.getAttribute('data-col')] != null);
  });
  if (ctx.clearBtnId) {
    const btn = $(ctx.clearBtnId);
    if (btn) btn.classList.toggle('filtro-on', Object.keys(ctx.filters).length > 0);
  }
}

async function fdAbrir(ctx, col, thEl) {
  criarFilterDropdown();
  if (_fdOutside) { document.removeEventListener('mousedown', _fdOutside); _fdOutside = null; }
  if (ctx.beforeOpen) await ctx.beforeOpen();
  _fdActive = ctx;
  _fdCol = col;
  _fdAllVals = ctxUnique(ctx, col);
  const atual = ctx.filters[String(col)];
  _fdPendente = atual ? new Set(atual) : new Set(_fdAllVals);
  _fdEl.querySelector('#fdSearch').value = '';
  fdRenderList();
  const rect = thEl.getBoundingClientRect();
  _fdEl.style.display = 'flex';
  _fdEl.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 290)) + 'px';
  _fdEl.style.top = (rect.bottom + 4) + 'px';
  // Limita a quantidade de itens visíveis (ex.: 4) quando o contexto pedir.
  const _list = _fdEl.querySelector('#fdList');
  const _item = _list.querySelector('.col-filter-item');
  _list.style.maxHeight = (ctx.maxItems && _item) ? (_item.offsetHeight * ctx.maxItems) + 'px' : '';
  _fdScrollEl = thEl.closest('.table-scroll-x, .table-responsive');
  setTimeout(() => {
    _fdOutside = (e) => {
      if (!_fdEl.contains(e.target) && !e.target.closest('th[data-col]')) fdFechar();
    };
    document.addEventListener('mousedown', _fdOutside);
    _fdScroll = () => fdFechar();
    window.addEventListener('scroll', _fdScroll, { passive: true });
    if (_fdScrollEl) _fdScrollEl.addEventListener('scroll', _fdScroll, { passive: true });
  }, 10);
}

function fdFechar() {
  if (_fdEl) _fdEl.style.display = 'none';
  if (_fdOutside) { document.removeEventListener('mousedown', _fdOutside); _fdOutside = null; }
  if (_fdScroll) {
    window.removeEventListener('scroll', _fdScroll);
    if (_fdScrollEl) _fdScrollEl.removeEventListener('scroll', _fdScroll);
    _fdScroll = null;
  }
  _fdScrollEl = null; _fdCol = -1; _fdPendente = null;
}

function fdAplicar() {
  const ctx = _fdActive, col = String(_fdCol);
  if (_fdPendente.size === 0) {
    ctx.filters[col] = new Set(); // mostra nada
  } else if (_fdPendente.size >= _fdAllVals.length) {
    delete ctx.filters[col]; // todos selecionados = sem filtro
  } else {
    ctx.filters[col] = new Set(_fdPendente);
  }
  fdFechar();
  ctx.onApply();
  ctxAtualizarTh(ctx);
}

// Liga o filtro de coluna ao <thead> de uma tabela.
function wireCtxFiltro(ctx, theadEl) {
  if (!theadEl) return;
  theadEl.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = Number(th.getAttribute('data-col'));
    if (_fdCol === col && _fdActive === ctx) { fdFechar(); return; }
    fdFechar();
    fdAbrir(ctx, col, th);
  });
}

// Cabeçalho com colunas filtráveis (ícone de funil) a partir de um array de COLS.
function thFiltravel(cols) {
  return cols.map((c, i) => '<th class="th-filterable" data-col="' + i + '">' +
    escapeHtml(c.label) + ' <i class="ph ph-funnel-simple col-filter-icon"></i></th>').join('');
}

// Contexto da tabela de Registros (mantém o comportamento existente).
const registrosFilterCtx = {
  theadSel: '#tabelaScroll thead th[data-col]',
  getRows: () => (_todosCarregados ? _todosRegistros : REGISTROS),
  colVal,
  filters: colFilters,
  onApply: renderTabela,
  beforeOpen: carregarTodosParaFiltro,
};

// Alterna a visão da tabela de Registros: 'detalhada' (todas as colunas) ou
// 'simples' (esconde Usuário, Protocolo, Recebimento, Obs e Foto via CSS).
function setRegistrosView(view) {
  const simples = view === 'simples';
  $('tabelaScroll').classList.toggle('view-simples', simples);
  $('btnViewSimples').classList.toggle('active', simples);
  $('btnViewDetalhada').classList.toggle('active', !simples);
  localStorage.setItem('registrosView', simples ? 'simples' : 'detalhada');
}

function configurarFiltrosTabela() {
  wireCtxFiltro(registrosFilterCtx, document.querySelector('#tabelaScroll thead'));
}

// ============================================================
//  Planilha — Importar / Exportar (XLSX via SheetJS)
// ============================================================
const COLUNAS_XLSX = [
  { header: 'UNIDADE',                    field: 'unidade' },
  { header: 'STATUS',                     field: 'status' },
  { header: 'SETOR',                      field: 'setor' },
  { header: 'USUARIO',                    field: 'usuario' },
  { header: 'N/S',                        field: 'ns' },
  { header: 'PAT',                         field: 'pat' },
  { header: 'EQUIPAMENTO',                field: 'equipamento' },
  { header: 'EQUIPAMENTO DETALHE',        field: 'equipamentoDetalhe' },
  { header: 'COMPRADO/LOCADO',            field: 'tipoAquisicao' },
  { header: 'PROTOCOLO',                  field: 'protocolo' },
  { header: 'DATA RECEBIMENTO',           field: 'dataRecebimento' },
  { header: 'OBS',                        field: 'obs' },
];

const COLUNAS_EXPORT_EXTRA = [
  { header: 'VALOR',            field: 'valor' },
  { header: 'CRIADO EM',        field: 'criadoEm' },
  { header: 'ATUALIZADO EM',    field: 'atualizadoEm' },
];

function isoParaBr(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : s;
}

function brParaIso(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : s;
}

function baixarModelo() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([COLUNAS_XLSX.map((c) => c.header)]);
  ws['!cols'] = COLUNAS_XLSX.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Inventário');
  XLSX.writeFile(wb, 'modelo_inventario.xlsx');
}

async function exportarXlsx() {
  const btnExport = $('btnExportarXlsx');
  const textoOriginal = btnExport.innerHTML;
  btnExport.disabled = true;
  btnExport.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Exportando...';
  try {
    const todos = await api('GET', '/api/records?all=1');
    if (!todos.length) {
      showAlert('alertRegistros', 'warning', 'Nenhum registro para exportar.');
      return;
    }
    const todasColunas = [...COLUNAS_XLSX, ...COLUNAS_EXPORT_EXTRA];
    const camposData = new Set(['dataRecebimento', 'criadoEm', 'atualizadoEm']);
    const linhas = todos.map((r) => todasColunas.map((c) => {
      const v = r[c.field];
      if (v == null || v === '') return '';
      if (camposData.has(c.field)) return isoParaBr(String(v));
      return v;
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([todasColunas.map((c) => c.header), ...linhas]);
    ws['!cols'] = todasColunas.map(() => ({ wch: 22 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Inventário');
    const agora = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const nome = 'inventario_' + agora.getFullYear() + pad(agora.getMonth() + 1) +
      pad(agora.getDate()) + '_' + pad(agora.getHours()) + pad(agora.getMinutes()) + '.xlsx';
    XLSX.writeFile(wb, nome);
    showAlert('alertRegistros', 'success', 'Exportado: ' + todos.length + ' registros.');
  } catch (err) {
    showAlert('alertRegistros', 'danger', 'Erro ao exportar: ' + err.message);
  } finally {
    btnExport.disabled = false;
    btnExport.innerHTML = textoOriginal;
  }
}

async function importarXlsx() {
  const file = $('inputArquivoXlsx').files[0];
  if (!file) {
    $('alertImport').innerHTML =
      '<div class="alert alert-warning py-1 mb-0">Selecione um arquivo .xlsx.</div>';
    setTimeout(() => { $('alertImport').innerHTML = ''; }, 5000);
    return;
  }
  $('alertImport').innerHTML = '';
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (!rows.length) {
    $('alertImport').innerHTML =
      '<div class="alert alert-danger py-1 mb-0">Planilha vazia.</div>';
    return;
  }

  const headerRow = rows[0].map((h) => String(h).trim().toUpperCase());
  const colIdx = {};
  COLUNAS_XLSX.forEach((c) => {
    const i = headerRow.indexOf(c.header.toUpperCase());
    if (i !== -1) colIdx[c.field] = i;
  });

  const obrigatorios = ['unidade', 'status', 'setor', 'ns', 'pat', 'equipamento', 'tipoAquisicao', 'protocolo', 'dataRecebimento'];
  const faltando = obrigatorios.filter((f) => colIdx[f] === undefined);
  if (faltando.length) {
    $('alertImport').innerHTML =
      '<div class="alert alert-danger py-1 mb-0">Colunas não encontradas: ' +
      faltando.join(', ') + '</div>';
    return;
  }

  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!dataRows.length) {
    $('alertImport').innerHTML =
      '<div class="alert alert-warning py-1 mb-0">Nenhuma linha de dados encontrada.</div>';
    setTimeout(() => { $('alertImport').innerHTML = ''; }, 5000);
    return;
  }

  const btnImportar = $('btnImportar');
  btnImportar.disabled = true;
  $('progressImport').classList.remove('hidden');
  $('alertImport').innerHTML = '';

  let nsExistentes;
  try {
    const atual = await api('GET', '/api/records');
    nsExistentes = new Set(atual.map((r) =>
      String(r.ns).trim().toUpperCase() + '|' + String(r.pat || '').trim().toUpperCase()
    ));
  } catch (err) {
    $('alertImport').innerHTML =
      '<div class="alert alert-danger py-1 mb-0">Erro ao consultar registros existentes: ' + escapeHtml(err.message) + '</div>';
    btnImportar.disabled = false;
    $('progressImport').classList.add('hidden');
    return;
  }

  let ok = 0, pulados = 0;
  const errosDetalhes = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const linhaXlsx = i + 2; // +2: 1 de header + 1 de base-1
    const pct = Math.round(((i + 1) / dataRows.length) * 100);
    $('progressImportBar').style.width = pct + '%';
    $('progressImportLabel').textContent = (i + 1) + ' / ' + dataRows.length;

    const cel = (field) => {
      const v = row[colIdx[field]];
      if (v instanceof Date) {
        const pad = (n) => String(n).padStart(2, '0');
        return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
      }
      return String(v == null ? '' : v).trim();
    };

    const chave = cel('ns').toUpperCase() + '|' + cel('pat').toUpperCase();
    if (nsExistentes.has(chave)) {
      pulados++;
      errosDetalhes.push({ linha: linhaXlsx, msg: 'N/S "' + cel('ns') + '" + PAT "' + cel('pat') + '" já está cadastrado no banco — ignorado.' });
      continue;
    }

    const errosLinha = [];

    let dataRaw = cel('dataRecebimento');
    if (dataRaw) {
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(dataRaw)) {
        dataRaw = brParaIso(dataRaw);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataRaw)) {
        errosLinha.push('DATA RECEBIMENTO inválida ("' + dataRaw + '") — use DD/MM/AAAA ou uma célula de data no Excel');
      }
    }

    if (errosLinha.length) {
      errosDetalhes.push({ linha: linhaXlsx, msg: errosLinha.join(' · ') });
      continue;
    }

    const equipNome = cel('equipamento');
    const registro = {
      unidade: cel('unidade'), status: cel('status'), setor: cel('setor'),
      usuario: cel('usuario'), ns: cel('ns'), pat: cel('pat'),
      equipamento: equipNome,
      equipamento_detalhe: colIdx['equipamentoDetalhe'] !== undefined ? cel('equipamentoDetalhe') : null,
      tipo_aquisicao: cel('tipoAquisicao') || null,
      protocolo: cel('protocolo'),
      dataRecebimento: dataRaw || null,
      valor: EQUIP_PRECO[equipNome] ?? null,
      obs: cel('obs'),
    };

    try {
      await api('POST', '/api/records', registro);
      ok++;
    } catch (err) {
      errosDetalhes.push({ linha: linhaXlsx, msg: err.message });
    }
  }

  $('progressImport').classList.add('hidden');
  btnImportar.disabled = false;
  $('inputArquivoXlsx').value = '';

  const erros = errosDetalhes.filter((e) => !e.msg.includes('já está cadastrado'));
  const resumo = 'Importados: ' + ok +
    (pulados ? ' &nbsp;·&nbsp; Já existiam: ' + pulados : '') +
    (erros.length ? ' &nbsp;·&nbsp; Erros: ' + erros.length : '');
  if (!errosDetalhes.length) {
    $('alertImport').innerHTML =
      '<div class="alert alert-success py-1 mb-0">Importados com sucesso: ' + ok + ' registros.</div>';
    setTimeout(() => { $('alertImport').innerHTML = ''; }, 5000);
  } else {
    const listaErros = errosDetalhes.map((e) =>
      '<li><strong>Linha ' + e.linha + ':</strong> ' + escapeHtml(e.msg) + '</li>'
    ).join('');
    const tipo = erros.length ? 'alert-warning' : 'alert-info';
    $('alertImport').innerHTML =
      '<div class="alert ' + tipo + ' mb-0">' +
      '<strong>' + resumo + '</strong>' +
      '<ul class="mt-2 mb-0 ps-3 small">' + listaErros + '</ul>' +
      '</div>';
  }
  invalidarCacheTodos(); await loadRecords(true);
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
      const atIdx = u.email.indexOf('@');
      const emailHtml = atIdx > -1
        ? escapeHtml(u.email.slice(0, atIdx)) + '<span class="email-dominio">@' + escapeHtml(u.email.slice(atIdx + 1)) + '</span>'
        : emailEsc;
      const status = ativo
        ? '<span class="badge-status badge-ativo">ATIVO</span>'
        : '<span class="badge-status badge-inativo">INATIVO</span>';
      const toggle = ativo
        ? '<button type="button" class="acao-link acao-ocultar ms-3" data-user-ativo="' + u.id +
          '" data-to="0" data-email="' + emailEsc + '"><i class="ph ph-prohibit"></i> Inativar</button>'
        : '<button type="button" class="acao-link acao-exibir ms-3" data-user-ativo="' + u.id +
          '" data-to="1" data-email="' + emailEsc + '"><i class="ph ph-check-circle"></i> Reativar</button>';
      return '<tr><td class="opt-nome">' + emailHtml + '</td>' +
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
//  Empréstimos
// ============================================================
// Preenche os selects do formulário de empréstimo (PAT vem dos registros).
async function loadEmprestimoForm() {
  fillSelect('emp_unidade', activeValues('UNIDADE'), '');
  try {
    const pats = await api('GET', '/api/pats');
    fillSelect('emp_pat', pats);
  } catch (err) {
    showAlert('alertEmprestimos', 'danger', 'Erro ao carregar PATs: ' + err.message);
  }
  $('emp_ns_grupo').style.display = 'none';
  $('emp_ns').required = false;
  fillSelect('emp_ns', []);
  // Data padrão = hoje.
  const hoje = new Date();
  if (fpMap['emp_data']) {
    fpMap['emp_data'].setDate(hoje, false);
  } else {
    const pad = (n) => String(n).padStart(2, '0');
    $('emp_data').value = hoje.getFullYear() + '-' + pad(hoje.getMonth() + 1) + '-' + pad(hoje.getDate());
  }
}

async function atualizarNsEmprestimo(pat) {
  $('emp_ns_grupo').style.display = 'none';
  $('emp_ns').required = false;
  fillSelect('emp_ns', []);
  if (!pat) return;
  try {
    const nsList = await api('GET', '/api/pats/' + encodeURIComponent(pat) + '/ns');
    if (nsList.length <= 1) {
      // Apenas 1 NS (ou nenhum): auto-seleciona e esconde o campo.
      if (nsList.length === 1) {
        fillSelect('emp_ns', nsList);
        $('emp_ns').value = nsList[0];
      }
      return;
    }
    fillSelect('emp_ns', nsList);
    $('emp_ns').required = true;
    $('emp_ns_grupo').style.display = '';
  } catch (err) {
    showAlert('alertEmprestimos', 'danger', 'Erro ao carregar N/S: ' + err.message);
  }
}

function fmtData(d) {
  if (!d) return '—';
  const partes = String(d).split('-'); // yyyy-mm-dd
  return partes.length === 3 ? partes[2] + '/' + partes[1] + '/' + partes[0] : d;
}

async function loadEmprestimos() {
  const container = $('listaEmprestimos');
  if (!container) return;
  container.innerHTML = '<span class="text-muted">Carregando...</span>';
  try {
    const ativos = (await api('GET', '/api/loans')).filter((e) => e.status === 'EMPRESTADO');
    if (!ativos.length) {
      container.innerHTML = '<span class="text-muted">Nenhum empréstimo em aberto.</span>';
      return;
    }
    const linhas = ativos.map((e) => {
      const nsAttr = e.ns ? ' data-ns="' + escapeHtml(e.ns) + '"' : '';
      const acao = '<button type="button" class="acao-link acao-exibir" data-loan-id="' + e.id +
        '" data-to="DEVOLVIDO" data-pat="' + escapeHtml(e.pat) + '"' + nsAttr +
        ' data-unidade="' + escapeHtml(e.unidade) +
        '"><i class="ph ph-arrow-u-down-left"></i> Devolver</button>';
      return '<tr>' +
        '<td>' + patLink(e.pat, e.ns) + '</td>' +
        '<td>' + escapeHtml(e.ns || '—') + '</td>' +
        '<td>' + escapeHtml(e.unidade) + '</td>' +
        '<td>' + fmtData(e.data) + '</td>' +
        '<td title="' + escapeHtml(e.obs) + '">' + escapeHtml(e.obs) + '</td>' +
        '<td class="text-end">' + acao + '</td></tr>';
    }).join('');
    container.innerHTML =
      '<div class="table-responsive"><table class="table table-striped align-middle mb-0">' +
      '<thead><tr><th>PAT</th><th>N/S</th><th>UNIDADE</th><th>DATA</th><th>OBS</th><th class="text-end">Ação</th></tr></thead>' +
      '<tbody>' + linhas + '</tbody></table></div>';
  } catch (err) {
    container.innerHTML = '<span class="text-danger">Erro ao carregar: ' + escapeHtml(err.message) + '</span>';
  }
}

function configurarFormEmprestimo() {
  const form = $('formEmprestimo');
  $('emp_pat').addEventListener('change', (ev) => atualizarNsEmprestimo(ev.target.value));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const dados = {
      pat: trim($('emp_pat').value),
      ns: trim($('emp_ns').value) || null,
      unidade: trim($('emp_unidade').value),
      data: $('emp_data').value,
      obs: trim($('emp_obs').value)
    };
    const btn = $('btnEmprestar');

    // Pré-verificação: busca origem e empréstimo ativo para mostrar modal correto.
    btn.disabled = true; btn.textContent = 'Verificando...';
    let confirmado = false;
    try {
      const qs = dados.ns ? '?ns=' + encodeURIComponent(dados.ns) : '';
      const hist = await api('GET', '/api/pats/' + encodeURIComponent(dados.pat) + '/history' + qs);
      const unidadeOriginal = hist.origens && hist.origens.length ? hist.origens[0].unidade : null;
      const loans = await api('GET', '/api/loans');
      const ativo = loans.find((e) => e.status === 'EMPRESTADO' &&
        e.pat === dados.pat && (!dados.ns || !e.ns || e.ns === dados.ns));

      const destino = dados.unidade;
      const eOrigem = unidadeOriginal && destino.toUpperCase() === unidadeOriginal.toUpperCase();

      if (eOrigem) {
        confirmado = await uiConfirm(
          'Emprestar para a unidade original registra\ncomo devolução do equipamento.',
          { title: 'Devolver equipamento', okText: 'Confirmar devolução', danger: false,
            transfer: { fromLabel: 'Atualmente em', toLabel: 'Devolver para',
              from: ativo ? ativo.unidade : (unidadeOriginal || '—'), to: destino } });
      } else if (ativo) {
        confirmado = await uiConfirm(
          'Este equipamento está em ' + ativo.unidade + '.\nDeseja transferi-lo para ' + destino + '?',
          { title: 'Transferir equipamento', okText: 'Transferir', danger: false,
            transfer: { fromLabel: 'Atualmente em', toLabel: 'Transferir para',
              from: ativo.unidade, to: destino } });
      } else {
        confirmado = await uiConfirm(
          'Emprestar PAT ' + dados.pat + ' para ' + destino + '?',
          { title: 'Novo empréstimo', okText: 'Emprestar', danger: false,
            transfer: { fromLabel: 'Unidade original', toLabel: 'Emprestar para',
              from: unidadeOriginal || '—', to: destino } });
      }
    } catch (err) {
      showAlert('alertEmprestimos', 'danger', err.message);
      btn.disabled = false; btn.textContent = 'Emprestar';
      return;
    }

    if (!confirmado) { btn.disabled = false; btn.textContent = 'Emprestar'; return; }

    btn.textContent = 'Emprestando...';
    try {
      const res = await api('POST', '/api/loans', dados);
      form.reset();
      form.classList.remove('was-validated');
      await loadEmprestimoForm();
      showAlert('alertEmprestimos', 'success', res.devolvido ? 'Equipamento devolvido à unidade original.' : 'Empréstimo registrado.');
      await loadEmprestimos();
    } catch (err) {
      showAlert('alertEmprestimos', 'danger', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Emprestar';
    }
  });

  // Histórico do PAT + Devolver / Reabrir (delegação na tabela).
  $('listaEmprestimos').addEventListener('click', async (ev) => {
    const hist = ev.target.closest('[data-hist]');
    if (hist) { abrirHistoricoPat(hist.getAttribute('data-hist'), hist.getAttribute('data-ns')); return; }
    const btn = ev.target.closest('[data-loan-id]');
    if (!btn) return;
    const id = btn.getAttribute('data-loan-id');
    const to = btn.getAttribute('data-to');
    const pat = btn.getAttribute('data-pat');
    const ns = btn.getAttribute('data-ns');
    const unidade = btn.getAttribute('data-unidade');

    let origem = '';
    try {
      const qs = ns ? '?ns=' + encodeURIComponent(ns) : '';
      const h = await api('GET', '/api/pats/' + encodeURIComponent(pat) + '/history' + qs);
      origem = h.origens && h.origens.length ? h.origens[0].unidade : '';
    } catch (err) {
      showAlert('alertEmprestimos', 'danger', err.message);
      return;
    }
    if (!(await uiConfirm(
      'Tem certeza que deseja\ndevolver o PAT ' + pat + '?',
      {
        title: 'Devolver empréstimo', okText: 'Devolver',
        transfer: { from: unidade, to: origem || '—' }
      }))) return;

    btn.disabled = true;
    try {
      await api('PUT', '/api/loans/' + id + '/status', { status: to });
      await loadEmprestimos();
    } catch (err) {
      showAlert('alertEmprestimos', 'danger', err.message);
      btn.disabled = false;
    }
  });
}

// ============================================================
//  Histórico do PAT (linha do tempo)
// ============================================================
async function abrirHistoricoPat(pat, ns) {
  $('histPat').textContent = pat;
  $('histBody').innerHTML = '<span class="text-muted">Carregando...</span>';
  modalHistorico.show();
  try {
    const qs = ns ? '?ns=' + encodeURIComponent(ns) : '';
    const h = await api('GET', '/api/pats/' + encodeURIComponent(pat) + '/history' + qs);
    $('histBody').innerHTML = renderTimeline(h);
  } catch (err) {
    $('histBody').innerHTML = '<span class="text-danger">Erro: ' + escapeHtml(err.message) + '</span>';
  }
}

function tlItem(tipo, icon, titulo, sub, data) {
  return '<div class="tl-item">' +
    '<span class="tl-dot ' + tipo + '"><i class="ph ' + icon + '"></i></span>' +
    (data ? '<div class="tl-date">' + fmtData(data) + '</div>' : '') +
    '<div class="tl-title">' + titulo + '</div>' +
    (sub ? '<div class="tl-sub">' + sub + '</div>' : '') +
    '</div>';
}

function renderTimeline(h) {
  const itens = [];
  if (h.origens && h.origens.length) {
    h.origens.forEach((o) => {
      const eq = o.equipamento ? ' · ' + escapeHtml(o.equipamento) : '';
      const ns = o.ns ? ' · N/S ' + escapeHtml(o.ns) : '';
      itens.push(tlItem('origem', 'ph-house-line',
        'Unidade de origem: ' + escapeHtml(o.unidade),
        'Equipamento' + eq + ns, o.criadoEm));
    });
  } else {
    itens.push(tlItem('origem', 'ph-house-line', 'Sem registro de origem',
      'Este PAT não consta na lista de Registros.', null));
  }
  (h.emprestimos || []).forEach((e, idx, arr) => {
    itens.push(tlItem('emprestado', 'ph-arrow-up-right',
      'Emprestado para ' + escapeHtml(e.unidade), e.obs ? escapeHtml(e.obs) : '', e.data));
    if (e.status === 'DEVOLVIDO') {
      itens.push(tlItem('devolvido', 'ph-arrow-u-down-left',
        'Devolvido para Unidade de origem', '', e.dataDevolucao));
    } else if (e.status === 'TRANSFERIDO') {
      const proximo = arr[idx + 1];
      const destino = proximo ? ' para ' + escapeHtml(proximo.unidade) : '';
      itens.push(tlItem('transferido', 'ph-arrows-left-right',
        'Transferido' + destino, '', e.dataDevolucao));
    } else {
      itens.push(tlItem('aberto', 'ph-clock',
        'Empréstimo em aberto', 'Atualmente em ' + escapeHtml(e.unidade), null));
    }
  });
  return '<div class="timeline">' + itens.join('') + '</div>';
}

// ============================================================
//  Wiring dos formulários
// ============================================================
function configurarAuth() {
  $('iconVerSenha').addEventListener('click', () => {
    const inp = $('auth_senha');
    const icon = $('iconVerSenha');
    const mostrar = inp.type === 'password';
    inp.type = mostrar ? 'text' : 'password';
    icon.className = mostrar ? 'ph ph-eye-slash' : 'ph ph-eye';
  });

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
      await entrarNoApp(data.email, false);
    } catch (err) {
      showAlert('alertAuth', 'danger', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  });
  $('btnSair').addEventListener('click', sairDoApp);
}

function ehImpressora(equipVal) {
  const v = String(equipVal || '').toUpperCase();
  return v.includes('IMPRESSORA PRETO/BRANCO') || v.includes('IMPRESSORA COLORIDA');
}

function atualizarEquipDetalhe(equipVal, detId) {
  const el = $(detId);
  if (!el) return;
  el.value = EQUIP_DETALHE[equipVal] || '';
  el.readOnly = true;

  const precoId = detId === 'equipamento_detalhe' ? 'valor' : 'edit_valor';
  const precoEl = $(precoId);
  if (precoEl) {
    precoEl.value = EQUIP_PRECO[equipVal] != null ? formatarMoeda(EQUIP_PRECO[equipVal]) : '';
    precoEl.readOnly = true;
  }

  const tipoId = detId === 'equipamento_detalhe' ? 'tipo_aquisicao' : 'edit_tipo_aquisicao';
  const tipoEl = $(tipoId);
  if (tipoEl) { tipoEl.value = EQUIP_TIPO[equipVal] || ''; tipoEl.readOnly = true; }

  const grupoId = detId === 'equipamento_detalhe' ? 'insumo_grupo' : 'edit_insumo_grupo';
  const insumoId = detId === 'equipamento_detalhe' ? 'insumo' : 'edit_insumo';
  const isImp = ehImpressora(equipVal);
  $(grupoId).classList.toggle('hidden', !isImp);
  fillSelect(insumoId, isImp ? INSUMOS : [], '');
}

// ── Câmera Overlay ────────────────────────────────────────────────────────
let _camStream = null;
let _camCtx = null; // { prefix, n, isNew }
let _camCapturado = null;

function _camModoCaptura() {
  $('cameraOverlayVideo').classList.remove('d-none');
  $('cameraOverlayPreview').classList.add('d-none');
  $('btnCapturarOverlayFoto').classList.remove('d-none');
  $('btnTirarOutraFoto').classList.add('d-none');
  $('btnEnviarFoto').classList.add('d-none');
  _camCapturado = null;
}

function _camModoPreview(b64) {
  _camCapturado = b64;
  $('cameraOverlayPreview').src = b64;
  $('cameraOverlayVideo').classList.add('d-none');
  $('cameraOverlayPreview').classList.remove('d-none');
  $('btnCapturarOverlayFoto').classList.add('d-none');
  $('btnTirarOutraFoto').classList.remove('d-none');
  $('btnEnviarFoto').classList.remove('d-none');
}

function mostrarCameraOverlay(show) {
  $('cameraOverlay').classList.toggle('d-none', !show);
  document.body.style.overflow = show ? 'hidden' : '';
}

function resetSlotFoto(prefix, n) {
  $(prefix + 'foto_' + n + '_base64').value = '';
  $(prefix + 'foto_' + n + '_thumb').src = '';
  $(prefix + 'foto_' + n + '_preview').classList.add('d-none');
}

function atualizarBtnAddFoto(p) {
  const slot3Visivel = !$(p + 'foto_3_slot').classList.contains('d-none');
  $(p + 'btnAddFoto').classList.toggle('d-none', slot3Visivel);
}

function deletarFoto(prefix, n) {
  // Desloca fotos dos slots superiores para baixo
  for (let i = n; i <= 2; i++) {
    const src = $(prefix + 'foto_' + (i + 1) + '_base64').value;
    if (src) {
      $(prefix + 'foto_' + i + '_base64').value = src;
      $(prefix + 'foto_' + i + '_thumb').src = $(prefix + 'foto_' + (i + 1) + '_thumb').src;
      $(prefix + 'foto_' + i + '_preview').classList.remove('d-none');
    } else {
      resetSlotFoto(prefix, i);
      $(prefix + 'foto_' + i + '_slot').classList.add('d-none');
    }
  }
  // Limpa e esconde sempre o último slot
  resetSlotFoto(prefix, 3);
  $(prefix + 'foto_3_slot').classList.add('d-none');
  // Dispara change para habilitar justificativa no form de edição
  $(prefix + 'foto_1_base64').dispatchEvent(new Event('change', { bubbles: true }));
  atualizarBtnAddFoto(prefix);
}

function fecharCameraOverlay(captured) {
  if (_camStream) { _camStream.getTracks().forEach((t) => t.stop()); _camStream = null; }
  if (!captured && _camCtx && _camCtx.isNew) {
    $(_camCtx.prefix + 'foto_' + _camCtx.n + '_slot').classList.add('d-none');
    atualizarBtnAddFoto(_camCtx.prefix);
  }
  _camCtx = null;
  mostrarCameraOverlay(false);
}

async function abrirCameraOverlay(prefix, n, isNew) {
  _camCtx = { prefix, n, isNew };
  $('cameraOverlayTitulo').textContent = 'Foto ' + n;
  try {
    _camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    $('cameraOverlayVideo').srcObject = _camStream;
    _camModoCaptura();
    mostrarCameraOverlay(true);
  } catch {
    alert('Não foi possível acessar a câmera. Verifique as permissões do navegador.');
    if (isNew) {
      $(prefix + 'foto_' + n + '_slot').classList.add('d-none');
      atualizarBtnAddFoto(prefix);
    }
    _camCtx = null;
  }
}

function inicializarCameraOverlay() {
  $('btnFecharCameraOverlay').addEventListener('click', () => fecharCameraOverlay(false));

  $('btnCapturarOverlayFoto').addEventListener('click', () => {
    if (!_camStream || !_camCtx) return;
    const video = $('cameraOverlayVideo');
    const canvas = $('cameraOverlayCanvas');
    const MAX = 800;
    let w = video.videoWidth, h = video.videoHeight;
    if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    const b64 = canvas.toDataURL('image/jpeg', 0.7);
    _camStream.getTracks().forEach((t) => t.stop()); _camStream = null;
    _camModoPreview(b64);
  });

  $('btnTirarOutraFoto').addEventListener('click', async () => {
    if (!_camCtx) return;
    try {
      _camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      $('cameraOverlayVideo').srcObject = _camStream;
      _camModoCaptura();
    } catch {
      alert('Não foi possível acessar a câmera. Verifique as permissões do navegador.');
    }
  });

  $('btnEnviarFoto').addEventListener('click', () => {
    if (!_camCtx || !_camCapturado) return;
    const { prefix, n } = _camCtx;
    $(prefix + 'foto_' + n + '_base64').value = _camCapturado;
    $(prefix + 'foto_' + n + '_base64').dispatchEvent(new Event('change', { bubbles: true }));
    $(prefix + 'foto_' + n + '_thumb').src = _camCapturado;
    $(prefix + 'foto_' + n + '_preview').classList.remove('d-none');
    fecharCameraOverlay(true);
    atualizarBtnAddFoto(prefix);
  });
}

function configurarCameraNovoRegistro() {
  [1, 2, 3].forEach((n) => {
    $('btnRefazerFoto_' + n).addEventListener('click', async () => {
      await abrirCameraOverlay('', n, false);
    });
    $('btnDeletarFoto_' + n).addEventListener('click', () => deletarFoto('', n));
  });
  $('btnAddFoto').addEventListener('click', async () => {
    if (_camStream) return;
    const n = $('foto_1_slot').classList.contains('d-none') ? 1
            : $('foto_2_slot').classList.contains('d-none') ? 2 : 3;
    $('foto_' + n + '_slot').classList.remove('d-none');
    atualizarBtnAddFoto('');
    await abrirCameraOverlay('', n, true);
  });
}

function configurarCameraEdicao() {
  [1, 2, 3].forEach((n) => {
    $('edit_btnRefazerFoto_' + n).addEventListener('click', async () => {
      await abrirCameraOverlay('edit_', n, false);
    });
    $('edit_btnDeletarFoto_' + n).addEventListener('click', () => deletarFoto('edit_', n));
  });
  $('edit_btnAddFoto').addEventListener('click', async () => {
    if (_camStream) return;
    const n = $('edit_foto_1_slot').classList.contains('d-none') ? 1
            : $('edit_foto_2_slot').classList.contains('d-none') ? 2 : 3;
    $('edit_foto_' + n + '_slot').classList.remove('d-none');
    atualizarBtnAddFoto('edit_');
    await abrirCameraOverlay('edit_', n, true);
  });
}
// ── Fim Câmera ────────────────────────────────────────────────────────────

function configurarFormInventario() {
  const form = $('formInventario');

  $('equipamento').addEventListener('change', (ev) => {
    atualizarEquipDetalhe(ev.target.value, 'equipamento_detalhe');
  });

  // "+ Adicionar nova opção..." em cada select abre o modal de cadastro.
  FORM_SELECTS.forEach((id) => {
    const el = $(id);
    el.addEventListener('change', (ev) => {
      if (ev.target.value === NEW_OPTION_VALUE) aoEscolherNovo(id);
    });
    // Nos selects com busca, o item "novo" não participa do filtro: some
    // enquanto há texto digitado e reaparece quando a busca está vazia.
    if (SEARCHABLE.has(id)) {
      const wrap = el.closest('.choices');
      if (wrap) {
        // Ouve o campo de busca interno (detecta inclusive quando esvazia).
        wrap.addEventListener('input', (ev) => {
          if (ev.target.classList.contains('choices__input')) {
            wrap.classList.toggle('is-buscando', ev.target.value.trim().length > 0);
          }
        });
        el.addEventListener('showDropdown', () => wrap.classList.remove('is-buscando'));
        el.addEventListener('hideDropdown', () => wrap.classList.remove('is-buscando'));
      }
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const btn = $('btnEnviar');
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      await api('POST', '/api/records', dadosFormulario(''));
      form.reset();
      if (fpMap['dataRecebimento']) fpMap['dataRecebimento'].clear();
      clearFormSelects();
      form.classList.remove('was-validated');
      fecharCameraOverlay(true);
      [1, 2, 3].forEach((n) => resetSlotFoto('', n));
      $('foto_1_slot').classList.add('d-none');
      $('foto_2_slot').classList.add('d-none');
      $('foto_3_slot').classList.add('d-none');
      $('btnAddFoto').classList.remove('d-none');
      modalRegistrar.hide();
      invalidarCacheTodos(); await loadRecords(true);
    } catch (err) {
      showAlert('alertRegistrar', 'danger', 'Erro ao salvar: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Registrar';
    }
  });
}

function configurarFormOpcao() {
  $('listaAlvo').addEventListener('change', renderListaOpcoes);

  $('btnAdicionar').addEventListener('click', async () => {
    const lista = $('listaAlvo').value;
    if (lista === 'EQUIPAMENTO') {
      await uiAsk({
        title: 'Nova opção', message: 'Nome do equipamento:',
        input: true, input2Label: 'Equipamento detalhe (opcional)',
        input3Label: 'Valor padrão (R$, opcional)',
        input4Label: 'Comprado/Locado',
        okText: 'Adicionar',
        onOk: async ({ valor: v, detalhe: d, preco: p, tipo: t }) => {
          const valor = trim(v).toUpperCase();
          if (!valor) throw new Error('O nome não pode ser vazio.');
          const preco = p !== null && p !== '' && p !== undefined ? Number(String(p).replace(',', '.')) : null;
          await api('POST', '/api/options', { lista, valor, detalhe: trim(d) || null, preco: !isNaN(preco) ? preco : null, tipo_aquisicao: t || null });
          await loadOptions();
          showAlert('alertGerenciar', 'success', 'Opção "' + valor + '" adicionada.');
        }
      });
    } else {
      const novo = await uiPrompt('Nova opção para ' + lista + ':', { title: 'Nova opção', okText: 'Adicionar' });
      if (!novo || !trim(novo)) return;
      const valor = trim(novo).toUpperCase();
      try {
        await api('POST', '/api/options', { lista, valor });
        await loadOptions();
        showAlert('alertGerenciar', 'success', 'Opção "' + valor + '" adicionada.');
      } catch (err) {
        showAlert('alertGerenciar', 'danger', 'Erro: ' + err.message);
      }
    }
  });

  $('listaOpcoes').addEventListener('change', async (ev) => {
    const input = ev.target.closest('[data-qtd-insumo]');
    if (!input) return;
    const val = input.getAttribute('data-val');
    const qtd = parseInt(input.value, 10);
    if (isNaN(qtd) || qtd < 0) { input.value = INSUMO_QTD[val] ?? 0; return; }
    try {
      await api('PUT', '/api/options/quantidade', { valor: val, quantidade: qtd });
      INSUMO_QTD[val] = qtd;
    } catch (err) {
      showAlert('alertGerenciar', 'danger', 'Erro ao salvar quantidade: ' + err.message);
      input.value = INSUMO_QTD[val] ?? 0;
    }
  });

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
      const detalheAtual = btnEdit.getAttribute('data-detalhe') || '';
      const precoAtual = btnEdit.getAttribute('data-preco');

      let limpo, novoDetalhe, novoPreco, novoTipo;
      if (lista === 'EQUIPAMENTO') {
        const tipoAtual = btnEdit.getAttribute('data-tipo') || '';
        const res = await uiAsk({
          title: 'Editar opção', message: 'Nome do equipamento:',
          input: true, value: val,
          input2Label: 'Equipamento detalhe (opcional)', value2: detalheAtual,
          input3Label: 'Valor padrão (R$, opcional)', value3: precoAtual != null ? precoAtual : '',
          input4Label: 'Comprado/Locado', value4: tipoAtual,
          okText: 'Salvar'
        });
        if (res === null) return;
        limpo = trim(res.valor).toUpperCase();
        novoDetalhe = trim(res.detalhe) || null;
        const precoRaw = res.preco !== null && res.preco !== '' && res.preco !== undefined
          ? Number(String(res.preco).replace(',', '.')) : null;
        novoPreco = precoRaw != null && !isNaN(precoRaw) ? precoRaw : null;
        novoTipo = res.tipo || null;
      } else if (lista === 'UNIDADE') {
        const res = await uiAsk({
          title: 'Editar unidade', message: 'Nome da unidade:',
          input: true, value: val,
          input2Label: 'Unidade na MSA (opcional)', value2: detalheAtual, input2Select: MSA_UNIDADES,
          okText: 'Salvar'
        });
        if (res === null) return;
        limpo = trim(res.valor).toUpperCase();
        novoDetalhe = trim(res.detalhe) || null;
      } else {
        const novo = await uiPrompt('Editar opção:', { title: 'Editar opção', value: val });
        if (novo === null) return;
        limpo = trim(novo).toUpperCase();
      }

      if (!limpo) { showAlert('alertGerenciar', 'warning', 'O valor não pode ser vazio.'); return; }
      btnEdit.disabled = true;
      try {
        if (limpo !== val) {
          await api('PUT', '/api/options/rename', { lista, valor: val, novoValor: limpo });
        }
        if (lista === 'EQUIPAMENTO') {
          await api('PUT', '/api/options/detalhe', { lista, valor: limpo, detalhe: novoDetalhe, preco: novoPreco, tipo_aquisicao: novoTipo });
        } else if (lista === 'UNIDADE') {
          await api('PUT', '/api/options/detalhe', { lista, valor: limpo, detalhe: novoDetalhe, preco: null, tipo_aquisicao: null });
        }
        await loadOptions();
        showAlert('alertGerenciar', 'success', 'Opção atualizada.');
      } catch (err) {
        showAlert('alertGerenciar', 'danger', 'Erro: ' + err.message);
        btnEdit.disabled = false;
      }
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
        if (ativar && !(await uiConfirm(
          'Reativar o acesso de ' + email + '? Ele voltará a conseguir entrar no sistema.',
          { title: 'Reativar usuário', okText: 'Reativar' }))) return;
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

  function habilitarJustificativa() {
    const jEl = $('edit_justificativa');
    if (jEl.disabled) {
      jEl.disabled = false;
      jEl.required = true;
      jEl.placeholder = 'Descreva o motivo da alteração...';
    }
  }

  form.addEventListener('input', (ev) => {
    if (ev.target.id !== 'edit_justificativa') habilitarJustificativa();
  });
  form.addEventListener('change', (ev) => {
    if (ev.target.id !== 'edit_justificativa') habilitarJustificativa();
  });

  $('edit_equipamento').addEventListener('change', (ev) => {
    atualizarEquipDetalhe(ev.target.value, 'edit_equipamento_detalhe');
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const id = $('edit_id').value;
    const justificativa = trim($('edit_justificativa').value);
    const btn = $('btnSalvarEdicao');
    btn.disabled = true; btn.textContent = 'Salvando...';
    try {
      await api('PUT', '/api/records/' + id, { ...dadosFormulario('edit_'), justificativa });
      const jEl = $('edit_justificativa');
      jEl.value = '';
      jEl.disabled = true;
      jEl.required = false;
      jEl.placeholder = '';
      $('formEditar').classList.remove('was-validated');
      $('alertEditar').innerHTML = '<div class="alert alert-success py-2 mb-0">Registro atualizado com sucesso!</div>';
      setTimeout(() => { $('alertEditar').innerHTML = ''; }, 4000);
      invalidarCacheTodos(); await loadRecords(true);
    } catch (err) {
      showAlert('alertRegistros', 'danger', 'Erro ao salvar: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Salvar';
    }
  });

  $('btnVerLog').addEventListener('click', () => {
    const id = $('edit_id').value;
    if (!id) return;
    abrirLog(id);
  });

  $('corpoTabela').addEventListener('click', (ev) => {
    const hist = ev.target.closest('[data-hist]');
    if (hist) { abrirHistoricoPat(hist.getAttribute('data-hist'), hist.getAttribute('data-ns')); return; }
    const btn = ev.target.closest('[data-edit]');
    if (btn) abrirEdicao(btn.getAttribute('data-edit'));
  });
}

async function abrirLog(registroId) {
  $('logCorpo').innerHTML = '<span class="text-muted">Carregando...</span>';
  modalEditar.hide();
  modalLog.show();
  try {
    const logs = await api('GET', '/api/records/' + registroId + '/log');
    if (!logs.length) {
      $('logCorpo').innerHTML = '<span class="text-muted">Nenhuma alteração registrada.</span>';
      return;
    }
    const linhas = logs.map((l) => {
      const mDH = l.dataHora ? String(l.dataHora).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/) : null;
      const data = mDH ? mDH[3] + '/' + mDH[2] + '/' + mDH[1] + ' ' + mDH[4] : (l.dataHora || '—');
      if (l.acao === 'CRIADO') {
        return '<tr><td>' + escapeHtml(data) + '</td><td><span class="badge bg-success">CRIADO</span></td>' +
          '<td colspan="2" class="text-muted">—</td><td>' + escapeHtml(l.usuario) + '</td></tr>';
      }
      const tip = l.justificativa
        ? ' data-bs-toggle="tooltip" data-bs-placement="right" data-bs-title="' + escapeHtml(l.justificativa) + '" style="cursor:help"'
        : '';
      const fmtVal = (v) => isoParaBr(v) || v || '';
      return '<tr><td>' + escapeHtml(data) + '</td>' +
        '<td><span class="badge bg-warning text-dark"' + tip + '>ATUALIZADO' +
        (l.justificativa ? ' <i class="ph ph-chat-text"></i>' : '') +
        '</span></td>' +
        '<td>' + escapeHtml(l.campo || '') + '</td>' +
        '<td><span class="text-danger text-decoration-line-through">' + escapeHtml(fmtVal(l.valorAnterior)) + '</span>' +
        ' <i class="ph ph-arrow-right"></i> ' +
        '<span class="text-success">' + escapeHtml(fmtVal(l.valorNovo)) + '</span></td>' +
        '<td>' + escapeHtml(l.usuario) + '</td></tr>';
    }).join('');
    $('logCorpo').innerHTML =
      '<table class="table table-sm align-middle mb-0">' +
      '<thead><tr><th>DATA/HORA</th><th>AÇÃO</th><th>CAMPO</th><th>ALTERAÇÃO</th><th>USUÁRIO</th></tr></thead>' +
      '<tbody>' + linhas + '</tbody></table>';
    $('logCorpo').querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
      new bootstrap.Tooltip(el, { trigger: 'hover' });
    });
  } catch (err) {
    $('logCorpo').innerHTML = '<span class="text-danger">Erro: ' + escapeHtml(err.message) + '</span>';
  }
}

// ============================================================
//  Detalhe + Interação do Chamado
// ============================================================
function renderDetalheChamado(data) {
  const tc   = data.TChamado || {};
  const conv = (data.TConversa?.root) || [];

  // --- Cabeçalho ---
  let html = '<div class="p-3" style="background:var(--bg-soft);border-bottom:1px solid var(--line)">';
  html += '<div class="row g-2 small">';
  const info = [
    ['Código',      tc.Codigo],
    ['PAT',         data._pat || ''],
    ['Status',      data._st || tc.AcaoStatus || ''],
    ['Assunto',     tc.Assunto],
    ['Equipamento', data._equipamento || ''],
    ['Criado em',   tc.DataCriacao ? tc.DataCriacao + ' ' + (tc.HoraCriacao || '') : ''],
  ];
  info.forEach(([l, v]) => {
    if (!v) return;
    html += `<div class="col-6 col-md-4"><span class="text-muted">${escapeHtml(l)}</span><div class="fw-600">${escapeHtml(v)}</div></div>`;
  });
  html += '</div></div>';

  // --- Chat ---
  html += '<div class="p-3 d-flex flex-column gap-3">';

  // Bolha auxiliar — tecnico=direita, cliente=esquerda
  function bubble(lado, icone, quem, dt, conteudo, extra) {
    const dir = lado === 'tecnico' ? 'align-self-end' : 'align-self-start';
    const bg  = lado === 'tecnico' ? 'background:#e9fbe9;border-color:#a3d9a5'
                                   : lado === 'cliente' ? 'background:#e8f0fe;border-color:#b3c7f7'
                                   : 'background:#f8f9fa;border-color:#dee2e6';
    const dtHtml = dt ? `<span class="text-muted" style="font-size:.75rem">${escapeHtml(dt)}</span>` : '';
    const metaDir = lado === 'tecnico' ? 'justify-content-end' : '';
    return `<div class="${dir}" style="max-width:85%">
      <div class="d-flex align-items-center gap-1 mb-1 ${metaDir}">
        <i class="ph ${icone}" style="font-size:.85rem;opacity:.6"></i>
        <span class="fw-600 small">${escapeHtml(quem)}</span>
        ${dtHtml}
      </div>
      <div class="rounded border p-2 small" style="${bg};overflow-x:auto">${conteudo}</div>
      ${extra || ''}
    </div>`;
  }

  const bubbles = [];

  // Abertura do chamado (cliente — esquerda)
  if (tc.Descricao) {
    const dtAbertura = tc.DataCriacao
      ? tc.DataCriacao + (tc.HoraCriacao ? ' ' + tc.HoraCriacao.slice(0, 5) : '')
      : '';
    bubbles.push(bubble('cliente', 'ph-user', tc.Usuario || 'Cliente', dtAbertura,
      `<pre style="white-space:pre-wrap;margin:0;font-family:inherit">${escapeHtml(tc.Descricao)}</pre>`));
  }

  // Interações do portal (TConversa) — cliente=esquerda, tecnico=direita
  conv.forEach(item => {
    const isCliente = !item.Operador || item.Solicitacao === 'Portal';
    const lado = isCliente ? 'cliente' : 'tecnico';
    const icone = isCliente ? 'ph-user' : 'ph-wrench';
    const quem = item.Operador || 'Cliente';
    const dt = (item.DataCriacao || '') + (item.HoraCriacao ? ' ' + String(item.HoraCriacao).slice(0, 5) : '');
    const corpo = item.Descricao
      ? `<pre style="white-space:pre-wrap;margin:0;font-family:inherit">${escapeHtml(item.Descricao)}</pre>`
      : '';
    bubbles.push(bubble(lado, icone, quem, dt, corpo));
  });

  // Última ação do técnico (direita)
  const acaoHtml = (tc.AcaoDescricao || '').replace(/<p>(\s|&nbsp;)*<\/p>/gi, '').trim();
  if (acaoHtml) {
    const quemTec = tc.AcaoOperador || 'Técnico';
    const dtTec   = tc.DataAcao
      ? tc.DataAcao + (tc.HoraAcaoInicio ? ' ' + tc.HoraAcaoInicio.slice(0, 5) : '')
      : '';
    const extra = tc.AcaoStatus
      ? `<div class="small text-muted mt-1 text-end"><i class="ph ph-flag me-1"></i>${escapeHtml(tc.AcaoStatus)}</div>`
      : '';
    bubbles.push(bubble('tecnico', 'ph-wrench', quemTec, dtTec, acaoHtml, extra));
  }

  // Mais recente primeiro
  bubbles.reverse().forEach(b => { html += b; });

  if (!bubbles.length) {
    html += '<div class="text-muted small text-center py-3">Sem interações registradas.</div>';
  }

  html += '</div>';
  return html;
}

async function abrirDetalheChamado(chave, codigo, st) {
  _chamadoDetalheAtual = { chave, codigo };
  $('detalheTitle').textContent = 'Chamado ' + codigo;
  $('detalheBody').innerHTML = '<div class="p-3 text-muted">Carregando...</div>';
  $('interacaoTexto').value = '';
  $('alertInteracao').innerHTML = '';
  modalChamadoDetalhe.show();
  try {
    const data = await api('GET', '/api/chamados/' + encodeURIComponent(chave));
    data._st = st || '';
    $('detalheBody').innerHTML = renderDetalheChamado(data);
  } catch (err) {
    $('detalheBody').innerHTML = '<div class="p-3 text-danger">Erro: ' + escapeHtml(err.message) + '</div>';
  }
}

function configurarDetalheChamado() {
  // Delegação de clique na tabela de chamados
  $('chamadosTbody').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-ver-chave]');
    if (!btn) return;
    abrirDetalheChamado(btn.getAttribute('data-ver-chave'), btn.getAttribute('data-ver-codigo'), btn.getAttribute('data-ver-st') || '');
  });

  $('btnEnviarInteracao').addEventListener('click', async () => {
    if (!_chamadoDetalheAtual) return;
    const descricao = trim($('interacaoTexto').value);
    if (!descricao) {
      $('alertInteracao').innerHTML =
        '<div class="alert alert-warning py-1 mb-0">Escreva a interação antes de enviar.</div>';
      return;
    }
    const btn = $('btnEnviarInteracao');
    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner"></i> Enviando...';
    $('alertInteracao').innerHTML = '';
    try {
      await api('POST', '/api/chamados/' + encodeURIComponent(_chamadoDetalheAtual.chave) + '/interacao', {
        codigo:    _chamadoDetalheAtual.codigo,
        descricao
      });
      $('interacaoTexto').value = '';
      // Recarrega o detalhe para mostrar a nova interação
      const data = await api('GET', '/api/chamados/' + encodeURIComponent(_chamadoDetalheAtual.chave));
      $('detalheBody').innerHTML = renderDetalheChamado(data);
      $('alertInteracao').innerHTML =
        '<div class="alert alert-success py-1 mb-0">Interação enviada com sucesso.</div>';
      setTimeout(() => { $('alertInteracao').innerHTML = ''; }, 4000);
    } catch (err) {
      $('alertInteracao').innerHTML =
        '<div class="alert alert-danger py-1 mb-0">' + escapeHtml(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ph ph-paper-plane-tilt"></i> Enviar Interação';
    }
  });
}

// ============================================================
//  Novo Chamado (Eurosa)
// ============================================================
const SEDE_LOCAL   = 'SEDE';
const SEDE_END     = 'Av. Paulista, 1159 - Jardim Paulista, São Paulo - SP, 01311-200';

function configurarNovoChamado() {
  $('btnNovoChamado').addEventListener('click', async () => {
    const form = $('formNovoChamado');
    form.reset();
    form.classList.remove('was-validated');
    $('alertNovoChamado').innerHTML = '';
    $('nc_patrimonio_info').textContent = '';
    $('nc_ns_grupo').style.display = 'none';
    const _cNs = choicesMap['nc_ns'];
    if (_cNs) _cNs.setChoices([], 'value', 'label', true);

    const cAssunto  = choicesMap['nc_assunto'];
    const cUnidade  = choicesMap['nc_unidade'];
    const cPat      = choicesMap['nc_patrimonio'];

    if (cAssunto)  { cAssunto.clearChoices();  cAssunto.setChoices([{ value: '', label: 'Carregando...', placeholder: true }], 'value', 'label', true); cAssunto.disable(); }
    if (cUnidade)  { cUnidade.clearChoices();  cUnidade.setChoices([{ value: '', label: 'Carregando...', placeholder: true }], 'value', 'label', true); cUnidade.disable(); }
    if (cPat)      { cPat.clearChoices();      cPat.setChoices([{ value: '', label: 'Selecione (opcional)...', placeholder: true }], 'value', 'label', true); }

    modalNovoChamado.show();

    try {
      const [assuntos, unidades, pats] = await Promise.all([
        api('GET', '/api/chamados/assuntos'),
        api('GET', '/api/chamados/unidades'),
        api('GET', '/api/pats')
      ]);

      if (cAssunto) {
        cAssunto.setChoices(
          [{ value: '', label: 'Selecione...', placeholder: true }]
            .concat(assuntos.map(a => ({ value: a.id, label: a.text }))),
          'value', 'label', true
        );
        cAssunto.enable();
      }

      if (cUnidade) {
        cUnidade.setChoices(
          [{ value: '', label: 'Selecione...', placeholder: true }]
            .concat(unidades.map(u => ({ value: u, label: u }))),
          'value', 'label', true
        );
        cUnidade.enable();
      }

      if (cPat) {
        cPat.setChoices(
          [{ value: '', label: 'Selecione (opcional)...', placeholder: true }]
            .concat(pats.map(p => ({ value: p, label: p }))),
          'value', 'label', true
        );
      }
    } catch (err) {
      if (cAssunto) { cAssunto.setChoices([{ value: '', label: 'Erro ao carregar', placeholder: true }], 'value', 'label', true); cAssunto.enable(); }
      if (cUnidade) { cUnidade.setChoices([{ value: '', label: 'Erro ao carregar', placeholder: true }], 'value', 'label', true); cUnidade.enable(); }
      $('alertNovoChamado').innerHTML =
        '<div class="alert alert-warning py-2 mb-0">Não foi possível carregar os dados: ' + escapeHtml(err.message) + '</div>';
    }
  });

  $('btnSede').addEventListener('click', () => {
    $('nc_local').value    = SEDE_LOCAL;
    $('nc_endereco').value = SEDE_END;
  });

  async function atualizarNsChamado(pat) {
    const info    = $('nc_patrimonio_info');
    const nsGrupo = $('nc_ns_grupo');
    const cNs     = choicesMap['nc_ns'];

    nsGrupo.style.display = 'none';
    if (cNs) cNs.setChoices([], 'value', 'label', true);
    info.textContent = '';

    if (!pat) return;
    info.textContent = 'Buscando...';
    try {
      const [nsList, d] = await Promise.all([
        api('GET', '/api/pats/' + encodeURIComponent(pat) + '/ns'),
        api('GET', '/api/pats/' + encodeURIComponent(pat) + '/info')
      ]);

      if (nsList.length > 1) {
        if (cNs) {
          cNs.setChoices(
            nsList.map(n => ({ value: n, label: n })),
            'value', 'label', true
          );
        } else {
          const sel = $('nc_ns');
          sel.innerHTML = nsList.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
        }
        nsGrupo.style.display = '';
      }

      const ns = nsList.length === 1 ? nsList[0] : '';
      info.innerHTML = d.equipamento
        ? `<i class="ph ph-desktop-tower me-1"></i><strong>${escapeHtml(d.equipamento)}</strong>` +
          (ns ? ` <span class="ms-2 text-secondary">N/S: ${escapeHtml(ns)}</span>` : '')
        : '';
    } catch { info.textContent = ''; }
  }

  $('nc_patrimonio').addEventListener('change', () => atualizarNsChamado($('nc_patrimonio').value));

  $('btnAbrirChamado').addEventListener('click', async () => {
    const form = $('formNovoChamado');
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }

    const btn = $('btnAbrirChamado');
    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner"></i> Abrindo...';
    $('alertNovoChamado').innerHTML = '';

    try {
      const assuntoSel = $('nc_assunto');
      const resultado = await api('POST', '/api/chamados', {
        codCatalogo:   trim(assuntoSel.value),
        assuntoText:   trim(assuntoSel.options[assuntoSel.selectedIndex]?.text || ''),
        descricao:     trim($('nc_descricao').value),
        localTrabalho: trim($('nc_local').value),
        endereco:      trim($('nc_endereco').value),
        unidade:       trim($('nc_unidade').value),
        patrimonio:    trim($('nc_patrimonio').value),
        ns:            trim($('nc_ns').value)
      });
      const codigo = resultado?.url?.text?.match(/\d{4}-\d{6}/)?.[0] || '';
      modalNovoChamado.hide();
      showAlert('alertRegistros', 'success', 'Chamado ' + (codigo ? codigo + ' ' : '') + 'aberto com sucesso!');
      if ($('tab-chamados').classList.contains('active')) await carregarChamados();
    } catch (err) {
      $('alertNovoChamado').innerHTML =
        '<div class="alert alert-danger py-2 mb-2">' + escapeHtml(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ph ph-headset"></i> Abrir Chamado';
    }
  });
}

// ============================================================
//  Dashboard
// ============================================================
let _chartUnidades = null;
let _dashData = null;
let _dashChamados = [];

function fmtMoeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

let _dashFiltroSelecionadas = new Set();

function getSelectedUnidades() {
  return Array.from(_dashFiltroSelecionadas);
}

function atualizarLabelFiltro() {
  const n = _dashFiltroSelecionadas.size;
  const el = $('dashFiltroLabel');
  if (n === 0) {
    el.textContent = 'Todas';
  } else if (n === 1) {
    el.textContent = Array.from(_dashFiltroSelecionadas)[0];
  } else {
    el.innerHTML = n + ' <span style="font-size:.7rem;opacity:.75">unidades</span>';
  }
}

function popularFiltroDashboard(unidades) {
  const menu = $('dashFiltroMenu');
  menu.innerHTML = '';

  // Opção "Todas"
  const liTodas = document.createElement('li');
  liTodas.innerHTML = `<label class="dash-check-item"><input type="checkbox" id="dashChkTodas" ${_dashFiltroSelecionadas.size === 0 ? 'checked' : ''}> Todas</label>`;
  menu.appendChild(liTodas);

  const divider = document.createElement('li');
  divider.innerHTML = '<div class="dash-check-divider"></div>';
  menu.appendChild(divider);

  unidades.forEach(u => {
    const val = u.unidade || '';
    const li = document.createElement('li');
    li.innerHTML = `<label class="dash-check-item"><input type="checkbox" data-unidade="${escapeHtml(val)}" ${_dashFiltroSelecionadas.has(val) ? 'checked' : ''}> ${escapeHtml(u.unidade || '(sem unidade)')}</label>`;
    menu.appendChild(li);
  });

  menu.addEventListener('change', (ev) => {
    const chk = ev.target;
    if (chk.id === 'dashChkTodas') {
      if (chk.checked) {
        _dashFiltroSelecionadas.clear();
        menu.querySelectorAll('[data-unidade]').forEach(c => c.checked = false);
      } else {
        chk.checked = true;
      }
    } else if (chk.dataset.unidade !== undefined) {
      if (chk.checked) _dashFiltroSelecionadas.add(chk.dataset.unidade);
      else _dashFiltroSelecionadas.delete(chk.dataset.unidade);
      $('dashChkTodas').checked = _dashFiltroSelecionadas.size === 0;
    }
    atualizarLabelFiltro();
    if (_dashData) renderDashboard(_dashData, getSelectedUnidades());
  }, { capture: false });
}

function renderDashboard(d, filtros) {
  const ativos = Array.isArray(filtros) ? filtros : [];
  const unidades = ativos.length
    ? d.por_unidade.filter(u => ativos.includes(u.unidade || ''))
    : d.por_unidade;

  const g = ativos.length
    ? {
        total_equipamentos: unidades.reduce((s, u) => s + u.total, 0),
        locados:            unidades.reduce((s, u) => s + u.locados, 0),
        valor_locacao:      unidades.reduce((s, u) => s + u.valor_locacao, 0),
        emprestados:        unidades.reduce((s, u) => s + u.emprestados, 0),
        total_insumos:      d.geral.total_insumos,
      }
    : d.geral;

  // Stats
  $('dash-total-equip').textContent = g.total_equipamentos;

  $('dash-valor-locacao').textContent = fmtMoeda(g.valor_locacao);
  $('dash-emprestados').textContent = g.emprestados;
  $('dash-insumos').textContent = g.total_insumos;

  // Chamados MSA — total global
  {
    const abertos = _dashChamados.filter(c => c.St !== 'Resolvido' && c.St !== 'Cancelado').length;
    $('dash-chamados-abertos').innerHTML = _dashChamados.length
      ? `${abertos} <span style="font-size:.85rem;font-weight:500;color:var(--dash-orange)">em aberto</span>`
      : '—';
  }

  // Chart sub-label
  $('dashChartSub').textContent = unidades.length + (unidades.length === 1 ? ' unidade' : ' unidades');

  // Chart
  const labels    = unidades.map(u => u.unidade || '(sem unidade)');
  const dataEquip = unidades.map(u => u.total);
  const dataEmp   = unidades.map(u => u.emprestados);

  if (_chartUnidades) _chartUnidades.destroy();
  const ctx = $('chartUnidades').getContext('2d');
  _chartUnidades = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Equipamentos',
          data: dataEquip,
          backgroundColor: '#4f7cf5',
          borderRadius: 6,
          borderSkipped: false,
        },
        ...(dataEmp.some(v => v > 0) ? [{
          label: 'Emprestados',
          data: dataEmp,
          backgroundColor: '#ff8c42',
          borderRadius: 6,
          borderSkipped: false,
        }] : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      animations: {
        y: {
          easing: 'easeOutQuart',
          duration: 700,
          from: (ctx) => {
            if (ctx.type === 'data' && ctx.mode === 'default') {
              return ctx.chart.scales.y.getPixelForValue(0);
            }
          },
        },
        x:      { duration: 0 },
        radius: { duration: 0 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#fff',
          titleColor: '#2b2b2b',
          bodyColor: '#555',
          borderColor: '#e4e4e4',
          borderWidth: 1,
          padding: 10,
          bodyFont: { family: 'Poppins', size: 12 },
          titleFont: { family: 'Poppins', size: 12, weight: '700' },
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          offset: 2,
          font: { family: 'Poppins', size: 11, weight: '600' },
          color: '#2b2b2b',
          formatter: (v) => v > 0 ? v : '',
        },
      },
      scales: {
        x: {
          ticks: { font: { family: 'Poppins', size: 11 }, color: '#9a9a9a' },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          ticks: { font: { family: 'Poppins', size: 11 }, color: '#9a9a9a', precision: 0 },
          grid: { color: '#f0f0f0' },
          border: { display: false },
          beginAtZero: true,
        },
      },
    },
  });

  // Legenda clicável
  const legendEl = $('dashChartLegend');
  const newLegend = legendEl.cloneNode(true); // remove listeners anteriores
  legendEl.parentNode.replaceChild(newLegend, legendEl);
  newLegend.querySelectorAll('.dash-legend-item').forEach(item => {
    const idx = Number(item.dataset.idx);
    // Mostra apenas itens cujo dataset existe
    if (idx >= _chartUnidades.data.datasets.length) {
      item.style.display = 'none';
    } else {
      item.style.display = '';
      item.addEventListener('click', () => {
        const visible = _chartUnidades.isDatasetVisible(idx);
        _chartUnidades.setDatasetVisibility(idx, !visible);
        _chartUnidades.update();
        item.classList.toggle('is-hidden', visible);
      });
    }
  });

  // Table
  $('dashTbody').innerHTML = unidades.map(u => `
    <tr>
      <td class="fw-semibold">${escapeHtml(u.unidade || '(sem unidade)')}</td>
      <td class="text-end">${u.total}</td>
      <td class="text-end" style="color:var(--dash-blue)">${u.locados}</td>
      <td class="text-end" style="color:var(--dash-orange)">${u.emprestados}</td>
      <td class="text-end" style="color:var(--dash-green);font-weight:600">${fmtMoeda(u.valor_locacao)}</td>
    </tr>
  `).join('');
  $('dashTfoot').innerHTML = `
    <tr>
      <td>Total</td>
      <td class="text-end">${g.total_equipamentos}</td>
      <td class="text-end">${g.locados}</td>
      <td class="text-end">${g.emprestados}</td>
      <td class="text-end">${fmtMoeda(g.valor_locacao)}</td>
    </tr>
  `;
}

async function carregarDashboard() {
  $('dashboardLoading').classList.remove('hidden');
  $('dashboardContent').classList.add('hidden');
  $('alertDashboard').innerHTML = '';
  try {
    const [d, chamadosRaw] = await Promise.all([
      api('GET', '/api/dashboard'),
      api('GET', '/api/chamados').catch(() => null),
    ]);
    _dashData = d;

    // Armazena chamados globalmente para filtragem
    _dashChamados = chamadosRaw
      ? (Array.isArray(chamadosRaw) ? chamadosRaw : (chamadosRaw.root ?? chamadosRaw.Lista ?? chamadosRaw.lista ?? []))
      : [];

    // Popula o filtro de unidades
    popularFiltroDashboard(d.por_unidade);

    renderDashboard(d, getSelectedUnidades());

    $('dashboardLoading').classList.add('hidden');
    $('dashboardContent').classList.remove('hidden');
  } catch (err) {
    $('dashboardLoading').classList.add('hidden');
    showAlert('alertDashboard', 'danger', 'Erro ao carregar dashboard: ' + err.message);
  }
}


// ============================================================
//  Sessão / inicialização
// ============================================================
let dadosCarregados = false;

async function entrarNoApp(email, restaurarAba = false) {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userEmail').textContent = email || '';
  if (restaurarAba) {
    const abaId = localStorage.getItem('abaAtiva');
    if (abaId && abaId !== 'tab-dashboard') {
      const abaEl = $(abaId);
      if (abaEl) bootstrap.Tab.getOrCreateInstance(abaEl).show();
    }
  }
  requestAnimationFrame(() => posicionarSlider(false));
  if (dadosCarregados) return;
  dadosCarregados = true;
  try {
    await loadOptions();
    // Carrega dashboard se for a aba ativa (ou padrão)
    const abaAtiva = localStorage.getItem('abaAtiva') || 'tab-dashboard';
    if (!restaurarAba || abaAtiva === 'tab-dashboard') carregarDashboard();
    // Não pré-carrega registros na inicialização; são carregados ao entrar na aba
  } catch (err) {
    showAlert('alertDashboard', 'danger', 'Erro ao carregar dados: ' + err.message);
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

const CHAMADOS_COLS = [
  { key: 'Codigo',     label: 'N°'           },
  { key: 'Criacao',    label: 'Criação',      fmt: v => v ? v.split('-').reverse().join('/') : '' },
  { key: 'Assunto',    label: 'Assunto'       },
  { key: 'St',         label: 'Status',       fmt: v => v === 'Resolvido' ? 'Finalizado' : (v ?? '') },
  { key: 'Solicitante',label: 'Solicitante'   },
];

let _chamadosTodos = [];

function chamadosColVal(r, col) {
  const c = CHAMADOS_COLS[col];
  if (!c) return '';
  const v = c.fmt ? c.fmt(r[c.key]) : r[c.key];
  return (v == null || String(v).trim() === '') ? '' : String(v);
}

const chamadosFilterCtx = {
  theadSel: '#chamadosThead th[data-col]',
  getRows: () => _chamadosTodos,
  colVal: chamadosColVal,
  filters: {},
  maxItems: 4,
  clearBtnId: 'btnLimparFiltrosChamados',
  onApply: () => {
    // Ao usar o filtro de coluna, troca o status de cima para "Personalizado"
    // para não conflitar com o filtro da tabela.
    if (Object.keys(chamadosFilterCtx.filters).length) $('chamadosFiltroStatus').value = 'custom';
    renderChamados();
  },
};

function renderChamados() {
  const busca = ($('chamadosBusca').value ?? '').toLowerCase();
  const status = $('chamadosFiltroStatus').value;
  const statusAtivo = status && status !== 'custom';
  const rows = _chamadosTodos.filter(r => {
    if (statusAtivo) {
      if (status === 'aberto') { if (r.St === 'Resolvido' || r.St === 'Cancelado') return false; }
      else if (r.St !== status) return false;
    }
    if (busca && !`${r.Codigo} ${r.Assunto} ${r.Solicitante}`.toLowerCase().includes(busca)) return false;
    if (!ctxPassa(chamadosFilterCtx, r)) return false;
    return true;
  });
  $('chamadosTbody').innerHTML = rows.map(r =>
    `<tr>${CHAMADOS_COLS.map(c => `<td>${escapeHtml(c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? ''))}</td>`).join('')}` +
    `<td><button type="button" class="btn btn-sm btn-outline-primary" ` +
    `data-ver-chave="${escapeHtml(String(r.Chave || ''))}" data-ver-codigo="${escapeHtml(r.Codigo || '')}" data-ver-st="${escapeHtml(r.St || '')}">` +
    `<i class="ph ph-eye"></i> Ver</button></td></tr>`
  ).join('');
  $('chamadosStatus').textContent = `${rows.length} de ${_chamadosTodos.length} chamados.`;
  ctxAtualizarTh(chamadosFilterCtx);
}

async function carregarChamados() {
  $('chamadosStatus').textContent = 'Carregando…';
  $('chamadosThead').innerHTML = '';
  $('chamadosTbody').innerHTML = '';
  try {
    const data = await api('GET', '/api/chamados');
    _chamadosTodos = Array.isArray(data) ? data : (data.root ?? data.Lista ?? data.lista ?? []);
    if (!_chamadosTodos.length) {
      $('chamadosStatus').textContent = 'Nenhum chamado encontrado.';
      return;
    }
    $('chamadosThead').innerHTML = thFiltravel(CHAMADOS_COLS) + '<th></th>';

    renderChamados();
  } catch (e) {
    $('chamadosStatus').textContent = 'Erro: ' + e.message;
  }
}

// ============================================================
//  CHAMADOS — INTECS vs MSA (CRUD local em SQL Server)
// ============================================================
let modalIntecsMsa = null;
let _intecsMsaTodos = [];
const fpIM = {};

const INTECSMSA_COLS = [
  { key: 'data_solicitacao',   label: 'Solicitação', fmt: imDataBR },
  { key: 'numero_chamado_msa', label: 'Nº MSA'      },
  { key: 'unidade',            label: 'Unidade'     },
  { key: 'patrimonio_msa',     label: 'Patrimônio'  },
  { key: 'status_msa',         label: 'Status MSA'  },
  { key: 'status_intecs',      label: 'Status INTECS' },
];

function imDataBR(v) { return v ? v.split('-').reverse().join('/') : ''; }

// Regra de negócio do spec: STATUS MSA é derivado das datas de movimentação.
function statusMsaCalc(retirada, entrega) {
  if (trim(entrega)) return 'Finalizado';
  if (trim(retirada)) return 'Em Andamento';
  return 'Aberto';
}

// Status MSA exibido: usa o status real sincronizado do eurosa quando houver;
// senão cai no cálculo por datas (linhas criadas manualmente).
function statusMsaDe(r) {
  return trim(r.status_msa) || statusMsaCalc(r.data_retirada_equip, r.data_entrega_equip);
}

function imStatusBadge(st) {
  if (!st) return '';
  const dark = st === 'Finalizado';
  const estilo = dark
    ? 'background:var(--ink);color:#fff;'
    : 'background:var(--bg-soft);color:var(--ink);border:1px solid var(--line);';
  return `<span class="badge" style="${estilo}">${escapeHtml(st)}</span>`;
}

function intecsMsaColVal(r, col) {
  const c = INTECSMSA_COLS[col];
  if (!c) return '';
  let v;
  if (c.key === 'status_msa') v = statusMsaDe(r);
  else if (c.key === 'status_intecs') v = r.status_intecs || '';
  else v = c.fmt ? c.fmt(r[c.key]) : r[c.key];
  return (v == null || String(v).trim() === '') ? '' : String(v);
}

const intecsMsaFilterCtx = {
  theadSel: '#imThead th[data-col]',
  getRows: () => _intecsMsaTodos,
  colVal: intecsMsaColVal,
  filters: {},
  maxItems: 4,
  clearBtnId: 'btnLimparFiltrosIntecsMsa',
  onApply: () => {
    if (Object.keys(intecsMsaFilterCtx.filters).length) $('imFiltroStatus').value = 'custom';
    renderIntecsMsa();
  },
};

function renderIntecsMsa() {
  const busca = trim($('imBusca').value).toLowerCase();
  const fstatus = $('imFiltroStatus').value;
  const statusAtivo = fstatus && fstatus !== 'custom';
  const rows = _intecsMsaTodos.filter((r) => {
    const stMsa = statusMsaDe(r);
    // "Em Aberto" agrupa Aberto + Em Andamento (tudo que não está Finalizado),
    // igual ao filtro da aba Chamados MSA.
    if (statusAtivo) {
      if (fstatus === 'aberto') { if (stMsa === 'Finalizado') return false; }
      else if (stMsa !== fstatus) return false;
    }
    if (busca) {
      const hay = `${r.numero_chamado_msa || ''} ${r.unidade || ''} ${r.patrimonio_msa || ''} ${r.ns || ''} ${r.descricao_equip || ''}`.toLowerCase();
      if (!hay.includes(busca)) return false;
    }
    if (!ctxPassa(intecsMsaFilterCtx, r)) return false;
    return true;
  });
  $('imTbody').innerHTML = rows.map((r) => {
    const stMsa = statusMsaDe(r);
    const cells = INTECSMSA_COLS.map((c) => {
      if (c.key === 'status_msa') return `<td>${imStatusBadge(stMsa)}</td>`;
      if (c.key === 'status_intecs') return `<td>${imStatusBadge(r.status_intecs || '')}</td>`;
      const val = c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? '');
      return `<td>${escapeHtml(val)}</td>`;
    }).join('');
    return `<tr>${cells}<td class="text-end text-nowrap">` +
      `<button type="button" class="btn btn-sm btn-outline-primary me-1" data-edit-im="${r.id}"><i class="ph ph-pencil-simple"></i></button>` +
      `<button type="button" class="btn btn-sm btn-outline-danger" data-del-im="${r.id}"><i class="ph ph-trash"></i></button>` +
      `</td></tr>`;
  }).join('');
  $('imStatus').textContent = `${rows.length} de ${_intecsMsaTodos.length} registros.`;
  ctxAtualizarTh(intecsMsaFilterCtx);
}

async function carregarIntecsMsa() {
  $('imStatus').textContent = 'Sincronizando com a MSA…';
  $('imThead').innerHTML = '';
  $('imTbody').innerHTML = '';
  try {
    const data = await api('GET', '/api/intecs-msa');
    _intecsMsaTodos = Array.isArray(data) ? data : [];
    $('imThead').innerHTML = thFiltravel(INTECSMSA_COLS) + '<th></th>';
    if (!_intecsMsaTodos.length) { $('imStatus').textContent = 'Nenhum registro cadastrado.'; return; }
    renderIntecsMsa();
  } catch (e) {
    $('imStatus').textContent = 'Erro: ' + e.message;
  }
}

// ---- Datas (flatpickr próprio, SEM minDate — aceita datas passadas) ----
function initIntecsMsaDatas() {
  if (typeof window.flatpickr === 'undefined') return;
  const cfg = {
    locale: 'pt', dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y',
    allowInput: true, disableMobile: true, monthSelectorType: 'static',
    onReady(_d, _s, fp) {
      fp.altInput.classList.add('form-control');
      const prev = fp.calendarContainer.querySelector('.flatpickr-prev-month');
      const next = fp.calendarContainer.querySelector('.flatpickr-next-month');
      if (prev) prev.innerHTML = '<i class="ph ph-caret-left"></i>';
      if (next) next.innerHTML = '<i class="ph ph-caret-right"></i>';
    },
  };
  ['im_data_solicitacao', 'im_data_retirada', 'im_data_entrega'].forEach((id) => {
    const el = $(id);
    if (!el || fpIM[id]) return;
    // DATA SOLICITAÇÃO é somente leitura: não abre o picker nem aceita digitação.
    const c = id === 'im_data_solicitacao'
      ? { ...cfg, clickOpens: false, allowInput: false }
      : cfg;
    fpIM[id] = window.flatpickr(el, c);
  });
}
function setDataIM(id, val) {
  const fp = fpIM[id];
  if (fp) { if (val) fp.setDate(val, false); else fp.clear(false); }
  else { $(id).value = val || ''; }
}
function getDataIM(id) { return trim($(id).value); }

function atualizarStatusMsa() {
  $('im_status_msa').value = statusMsaCalc($('im_data_retirada').value, $('im_data_entrega').value);
}

async function carregarPatsBackup(selected) {
  try {
    const pats = await api('GET', '/api/pats');
    fillSelect('im_bkp_pat', Array.isArray(pats) ? pats : [], selected || '');
  } catch { fillSelect('im_bkp_pat', [], selected || ''); }
}

function abrirEdicaoIntecsMsa(id) {
  const r = _intecsMsaTodos.find((x) => String(x.id) === String(id));
  if (!r) return;
  $('alertIntecsMsa').innerHTML = '';
  $('formIntecsMsa').reset();
  $('im_id').value = r.id;
  $('imModalTitle').innerHTML = '<i class="ph ph-git-diff me-2"></i>Editar — INTECS vs MSA';
  $('btnExcluirIntecsMsa').style.display = '';
  $('im_numero_chamado').value = r.numero_chamado_msa || '';
  $('im_problema').value = r.problema || '';
  $('im_glpi').value = r.glpi || '';
  $('im_status_intecs').value = r.status_intecs || '';
  $('im_patrimonio_msa').value = r.patrimonio_msa || '';
  $('im_ns').value = r.ns || '';
  $('im_ponto_instalacao').value = r.ponto_instalacao || '';
  $('im_descricao_equip').value = r.descricao_equip || '';
  $('im_bkp_unidade').value = r.bkp_unidade || '';
  $('im_observacao').value = r.observacao || '';
  setDataIM('im_data_solicitacao', r.data_solicitacao);
  setDataIM('im_data_retirada', r.data_retirada_equip);
  setDataIM('im_data_entrega', r.data_entrega_equip);
  fillSelect('im_unidade', activeValues('UNIDADE'), r.unidade || '');
  carregarPatsBackup(r.patrimonio_bkp_intecs || '');
  atualizarStatusMsa();
  modalIntecsMsa.show();
}

function dadosIntecsMsa() {
  return {
    data_solicitacao:      getDataIM('im_data_solicitacao'),
    numero_chamado_msa:    trim($('im_numero_chamado').value),
    problema:              trim($('im_problema').value),
    unidade:               trim($('im_unidade').value),
    glpi:                  trim($('im_glpi').value),
    status_intecs:         trim($('im_status_intecs').value),
    patrimonio_msa:        trim($('im_patrimonio_msa').value),
    ns:                    trim($('im_ns').value),
    ponto_instalacao:      trim($('im_ponto_instalacao').value),
    descricao_equip:       trim($('im_descricao_equip').value),
    data_retirada_equip:   getDataIM('im_data_retirada'),
    data_entrega_equip:    getDataIM('im_data_entrega'),
    patrimonio_bkp_intecs: trim($('im_bkp_pat').value),
    bkp_unidade:           trim($('im_bkp_unidade').value),
    observacao:            trim($('im_observacao').value),
  };
}

async function salvarIntecsMsa(ev) {
  if (ev) ev.preventDefault();
  const id = trim($('im_id').value);
  const dados = dadosIntecsMsa();
  const btn = $('btnSalvarIntecsMsa');
  btn.disabled = true;
  try {
    if (id) await api('PUT', '/api/intecs-msa/' + id, dados);
    else await api('POST', '/api/intecs-msa', dados);
    modalIntecsMsa.hide();
    await carregarIntecsMsa();
  } catch (e) {
    $('alertIntecsMsa').innerHTML = `<div class="alert alert-danger py-2 mb-3">${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function excluirIntecsMsa(id) {
  const ok = await uiConfirm('Excluir este registro de INTECS vs MSA? Esta ação não pode ser desfeita.',
    { title: 'Excluir registro', okText: 'Excluir' });
  if (!ok) return;
  try {
    await api('DELETE', '/api/intecs-msa/' + id);
    if (modalIntecsMsa) modalIntecsMsa.hide();
    await carregarIntecsMsa();
  } catch (e) {
    $('imStatus').textContent = 'Erro: ' + e.message;
  }
}

// Auto-preenche PONTO DE INSTALAÇÃO + DESCRIÇÃO EQUIP. pelo patrimônio MSA (+ Nº série).
async function lookupEquipIM() {
  const pat = trim($('im_patrimonio_msa').value);
  if (!pat) return;
  const ns = trim($('im_ns').value);
  try {
    const q = ns ? '?ns=' + encodeURIComponent(ns) : '';
    const info = await api('GET', '/api/pats/' + encodeURIComponent(pat) + '/lookup' + q);
    if (info.equipamento || info.setor) {
      $('im_ponto_instalacao').value = info.setor || '';
      $('im_descricao_equip').value = info.equipamento || '';
    }
  } catch { /* silencioso */ }
}

// Auto-preenche BKP UNIDADE pela unidade de origem do patrimônio de backup.
async function lookupBkpUnidade() {
  const pat = trim($('im_bkp_pat').value);
  if (!pat) { $('im_bkp_unidade').value = ''; return; }
  try {
    const info = await api('GET', '/api/pats/' + encodeURIComponent(pat) + '/lookup');
    $('im_bkp_unidade').value = info.unidade || '';
  } catch { /* silencioso */ }
}

function configurarIntecsMsa() {
  $('btnRefreshIntecsMsa').addEventListener('click', carregarIntecsMsa);
  $('imBusca').addEventListener('input', renderIntecsMsa);
  $('imFiltroStatus').addEventListener('change', () => {
    // Mexer no filtro de cima sobrepõe o filtro de coluna do Status MSA.
    const i = INTECSMSA_COLS.findIndex((c) => c.key === 'status_msa');
    delete intecsMsaFilterCtx.filters[String(i)];
    renderIntecsMsa();
  });
  $('formIntecsMsa').addEventListener('submit', salvarIntecsMsa);
  $('btnExcluirIntecsMsa').addEventListener('click', () => {
    const id = trim($('im_id').value);
    if (id) excluirIntecsMsa(id);
  });
  $('imTbody').addEventListener('click', (ev) => {
    const edit = ev.target.closest('[data-edit-im]');
    if (edit) { abrirEdicaoIntecsMsa(edit.getAttribute('data-edit-im')); return; }
    const del = ev.target.closest('[data-del-im]');
    if (del) { excluirIntecsMsa(del.getAttribute('data-del-im')); }
  });
  $('im_patrimonio_msa').addEventListener('blur', lookupEquipIM);
  $('im_ns').addEventListener('blur', lookupEquipIM);
  $('im_bkp_pat').addEventListener('change', lookupBkpUnidade);
  $('im_data_retirada').addEventListener('change', atualizarStatusMsa);
  $('im_data_entrega').addEventListener('change', atualizarStatusMsa);
  wireCtxFiltro(intecsMsaFilterCtx, $('imThead'));
  $('btnLimparFiltrosIntecsMsa').addEventListener('click', () => {
    Object.keys(intecsMsaFilterCtx.filters).forEach((k) => delete intecsMsaFilterCtx.filters[k]);
    if ($('imFiltroStatus').value === 'custom') $('imFiltroStatus').value = 'aberto';
    renderIntecsMsa();
  });
}

function posicionarSlider(animar = true) {
  const tabs = document.querySelector('.app-tabs');
  const slider = tabs?.querySelector('.liquid-slider');
  const active = tabs?.querySelector('.nav-link.active');
  if (!slider || !active) return;
  if (!animar) slider.style.transition = 'none';
  const tabsRect = tabs.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  slider.style.left = (activeRect.left - tabsRect.left + tabs.scrollLeft) + 'px';
  slider.style.width = activeRect.width + 'px';
  if (!animar) {
    requestAnimationFrame(() => {
      slider.style.transition = '';
      tabs.classList.add('slider-pronto');
    });
  } else {
    tabs.classList.add('slider-pronto');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);
  modalEditar = new bootstrap.Modal($('modalEditar'));
  modalMsg = new bootstrap.Modal($('modalMsg'));
  modalAsk = null; // substituído por dialog custom (#askOverlay)
  modalHistorico = new bootstrap.Modal($('modalHistorico'));
  modalLog = new bootstrap.Modal($('modalLog'));
  modalRegistrar = new bootstrap.Modal($('modalRegistrar'));
  modalNovoChamado = new bootstrap.Modal($('modalNovoChamado'));
  modalChamadoDetalhe = new bootstrap.Modal($('modalChamadoDetalhe'));
  modalIntecsMsa = new bootstrap.Modal($('modalIntecsMsa'));
  document.querySelectorAll('.modal').forEach(el => {
    el.addEventListener('hidePrevented.bs.modal', () => el.classList.remove('modal-static'));
  });
  $('btnVoltarLog').addEventListener('click', () => {
    const id = $('edit_id').value;
    modalLog.hide();
    modalEditar.show();
    if (id) carregarFotosEdicao(id);
  });
  $('askOk').addEventListener('click', () => finishAsk(true));
  $('askCancel').addEventListener('click', () => finishAsk(false));
  $('askOverlay').addEventListener('focusin', (e) => e.stopPropagation());
  $('askOverlay').addEventListener('mousedown', (e) => e.stopPropagation());
  ['modalRegistrar', 'modalEditar'].forEach((id) => {
    $(id).addEventListener('hide.bs.modal', (ev) => {
      if ($('askOverlay').classList.contains('show')) ev.preventDefault();
    });
  });
  $('modalRegistrar').addEventListener('hidden.bs.modal', () => {
    $('alertRegistrar').innerHTML = '';
    $('formInventario').classList.remove('was-validated');
    $('insumo_grupo').classList.add('hidden');
    fillSelect('insumo', [], '');
    fecharCameraOverlay(true);
    [1, 2, 3].forEach((n) => resetSlotFoto('', n));
    $('foto_1_slot').classList.add('d-none');
    $('foto_2_slot').classList.add('d-none');
    $('foto_3_slot').classList.add('d-none');
    $('btnAddFoto').classList.remove('d-none');
  });
  $('modalEditar').addEventListener('hidden.bs.modal', () => {
    fecharCameraOverlay(true);
    [1, 2, 3].forEach((n) => resetSlotFoto('edit_', n));
    $('edit_foto_1_slot').classList.add('d-none');
    $('edit_foto_2_slot').classList.add('d-none');
    $('edit_foto_3_slot').classList.add('d-none');
    $('edit_btnAddFoto').classList.remove('d-none');
  });
  $('modalPlanilha').addEventListener('hidden.bs.modal', () => {
    $('alertImport').innerHTML = '';
    $('inputArquivoXlsx').value = '';
    $('progressImport').classList.add('hidden');
  });
  $('askInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finishAsk(true); } });
  initChoices();
  initFlatpickr();
  initIntecsMsaDatas();
  configurarAuth();
  configurarFormInventario();
  inicializarCameraOverlay();
  configurarCameraNovoRegistro();
  configurarCameraEdicao();
  configurarFormOpcao();
  configurarFormUsuario();
  configurarFormEmprestimo();
  configurarFormEditar();
  configurarFiltrosTabela();
  configurarDetalheChamado();
  configurarNovoChamado();
  configurarIntecsMsa();

  document.querySelectorAll('.app-tabs .nav-link').forEach((btn) => {
    btn.addEventListener('shown.bs.tab', () => {
      posicionarSlider();
      localStorage.setItem('abaAtiva', btn.id);
    });
  });

  $('tab-dashboard').addEventListener('shown.bs.tab', carregarDashboard);
  $('btnAtualizarDashboard').addEventListener('click', carregarDashboard);
  window.addEventListener('scroll', () => {
    const btn = $('dashFiltroBtn');
    if (btn) bootstrap.Dropdown.getInstance(btn)?.hide();
  }, { passive: true });
  $('tab-registros').addEventListener('shown.bs.tab', () => loadRecords(true));
  $('btnAtualizarLista').addEventListener('click', () => { invalidarCacheTodos(); loadRecords(true); });
  $('btnViewSimples').addEventListener('click', () => setRegistrosView('simples'));
  $('btnViewDetalhada').addEventListener('click', () => setRegistrosView('detalhada'));
  setRegistrosView(localStorage.getItem('registrosView') || 'detalhada');
  $('btnLimparFiltros').addEventListener('click', () => {
    Object.keys(colFilters).forEach((k) => delete colFilters[k]);
    renderTabela();
  });
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadRecords(false);
  }, { root: $('tabelaScroll'), threshold: 0.1 }).observe($('sentinelTabela'));
  $('btnBaixarModelo').addEventListener('click', baixarModelo);
  $('btnExportarXlsx').addEventListener('click', exportarXlsx);
  $('btnImportar').addEventListener('click', importarXlsx);
  $('tab-emprestimos').addEventListener('shown.bs.tab', () => { loadEmprestimoForm(); loadEmprestimos(); });
  $('btnAtualizarEmprestimos').addEventListener('click', loadEmprestimos);
  $('tab-usuarios').addEventListener('shown.bs.tab', loadUsuarios);
  $('btnAtualizarUsuarios').addEventListener('click', loadUsuarios);
  // Aba Chamados: sub-aba padrão é INTECS vs MSA; MSA (Eurosa) carrega ao abrir sua sub-aba.
  $('tab-chamados').addEventListener('shown.bs.tab', carregarIntecsMsa);
  $('sub-tab-intecsmsa').addEventListener('shown.bs.tab', carregarIntecsMsa);
  $('sub-tab-msa').addEventListener('shown.bs.tab', carregarChamados);
  $('btnRefreshChamados').addEventListener('click', carregarChamados);
  $('chamadosBusca').addEventListener('input', renderChamados);
  $('chamadosFiltroStatus').addEventListener('change', () => {
    // Mexer no filtro de cima sobrepõe o filtro de coluna do Status.
    const i = CHAMADOS_COLS.findIndex((c) => c.key === 'St');
    delete chamadosFilterCtx.filters[String(i)];
    renderChamados();
  });
  wireCtxFiltro(chamadosFilterCtx, $('chamadosThead'));
  $('btnLimparFiltrosChamados').addEventListener('click', () => {
    Object.keys(chamadosFilterCtx.filters).forEach((k) => delete chamadosFilterCtx.filters[k]);
    if ($('chamadosFiltroStatus').value === 'custom') $('chamadosFiltroStatus').value = 'aberto';
    renderChamados();
  });

  // Sessão persistida: valida o token salvo.
  if (TOKEN) {
    try {
      const me = await api('GET', '/api/auth/me');
      await entrarNoApp(me.email, true);
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
