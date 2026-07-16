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
const SEARCHABLE = new Set(['setor', 'edit_setor', 'equipamento', 'edit_equipamento', 'emp_pat', 'nc_assunto', 'nc_unidade', 'nc_patrimonio', 'nc_ns', 'im_unidade', 'im_bkp_pat', 'internet_unidade', 'internet_contrato']);
const CHOICES_IDS = [
  'unidade', 'status', 'setor', 'equipamento',
  'edit_unidade', 'edit_status', 'edit_setor', 'edit_equipamento',
  'insumo', 'edit_insumo',
  'listaAlvo', 'emp_pat', 'emp_unidade',
  'nc_assunto', 'nc_unidade', 'nc_patrimonio', 'nc_ns',
  'im_unidade', 'im_bkp_pat',
  'imFiltroStatus', 'chamadosFiltroStatus',
  'internet_unidade', 'internet_contrato',
  'ci_categoria', 'ci_subcategoria', 'ci_prioridade',
  'ci_unidade', 'ci_departamento', 'ciMaquinaSelect',
  'ciFiltroCategoria', 'ciFiltroPrioridade', 'ciFiltroStatus', 'ciFiltroResponsavel'
];
// Filtros de status (Choices.js sem placeholder — "Todos" é uma opção normal).
const FILTRO_STATUS_IDS = new Set([
  'imFiltroStatus', 'chamadosFiltroStatus',
  'ciFiltroCategoria', 'ciFiltroPrioridade', 'ciFiltroStatus', 'ciFiltroResponsavel'
]);

// ---------- Estado em memória ----------
let OPTIONS = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [], INSUMOS: [] };
let HIDDEN = { UNIDADE: [], STATUS: [], SETOR: [], EQUIPAMENTO: [], INSUMOS: [] };
let EQUIP_DETALHE = {};
let EQUIP_PRECO = {};
let EQUIP_TIPO = {};
let EQUIP_QTD_REG = {};
let UNIDADE_MSA = {};      // UNIDADE do sistema -> unidade correspondente na MSA (col. detalhe)
let UNIDADE_CNPJ = {};     // UNIDADE do sistema -> CNPJ (col. cnpj)
let UNIDADE_ENDERECO = {}; // UNIDADE do sistema -> endereço (col. endereco)
let MSA_UNIDADES = [];     // lista fixa de unidades da MSA (CHAMADO_UNIDADES)
let INSUMO_QTD = {};
let INSUMOS = [];
let REGISTROS = [];
let modalEditar = null;
let modalMsg = null;
let modalAsk = null;
let askResolve = null;
let askSelect2Ativo = false;   // campo 2 do uiAsk está em modo lista (select)?
let askInput3Mask = null;      // máscara ativa do campo 3 do uiAsk (ex.: 'cnpj')
const fpMap = {};
let modalHistorico = null;
let modalRegistrar = null;
let modalLog = null;
let modalOpcao = null;
let modalEmprestimo = null;
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
let _fdTh       = null; // <th> que abriu o dropdown (para o retry do estado de erro)
let _fdToken    = 0;    // invalida aberturas em voo quando o dropdown fecha/reabre

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

function uiAsk({ title, message, input, value, input2Label, value2, input2Select, input3Label, value3, input3Mask, input4Label, value4, input5Label, value5, okText, danger, transfer, onOk }) {
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
    const inp3 = $('askInput3');
    askInput3Mask = input3Mask || null;
    // O campo 3 é <input type="number"> (preço). No modo CNPJ vira texto para aceitar a máscara.
    if (askInput3Mask === 'cnpj') { inp3.type = 'text'; inp3.setAttribute('inputmode', 'numeric'); }
    else { inp3.type = 'number'; inp3.removeAttribute('inputmode'); }
    if (input3Label !== undefined) {
      $('askInput3Label').textContent = input3Label;
      inp3.value = value3 != null ? value3 : '';
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
    const wrap5 = $('askInput5Wrap');
    if (input5Label !== undefined) {
      $('askInput5Label').textContent = input5Label;
      $('askInput5').value = value5 != null ? value5 : '';
      wrap5.classList.remove('hidden');
    } else {
      wrap5.classList.add('hidden');
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
  const input5Visivel = !$('askInput5Wrap').classList.contains('hidden');
  const detalhe2 = askSelect2Ativo ? $('askSelect2').value : $('askInput2').value;
  const result = !inputVisivel ? true
    : input2Visivel
      ? { valor: $('askInput').value, detalhe: detalhe2,
          preco: input3Visivel ? ($('askInput3').value !== '' ? $('askInput3').value : null) : undefined,
          input3: input3Visivel ? $('askInput3').value : undefined,
          tipo: input4Visivel ? ($('askInput4').value || null) : undefined,
          input5: input5Visivel ? $('askInput5').value : undefined }
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

// Só os dígitos do CNPJ (para validar o comprimento de 14).
function cnpjDigits(val) {
  return String(val == null ? '' : val).replace(/\D/g, '');
}

// Máscara de CNPJ: formata progressivamente como XX.XXX.XXX/XXXX-XX (até 14 dígitos).
function maskCNPJ(val) {
  const d = cnpjDigits(val).slice(0, 14);
  if (d.length > 12) return d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '/' + d.slice(8, 12) + '-' + d.slice(12);
  if (d.length > 8) return d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '/' + d.slice(8);
  if (d.length > 5) return d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5);
  if (d.length > 2) return d.slice(0, 2) + '.' + d.slice(2);
  return d;
}

// Máscara de telefone BR: fixo (XX) XXXX-XXXX (10 díg.) ou celular (XX) XXXXX-XXXX (11 díg.).
function maskTelefone(val) {
  const d = String(val == null ? '' : val).replace(/\D/g, '').slice(0, 11);
  if (!d.length) return '';
  if (d.length <= 2) return '(' + d;
  const ddd = d.slice(0, 2);
  const resto = d.slice(2);
  if (resto.length <= 4) return '(' + ddd + ') ' + resto;
  if (d.length <= 10) return '(' + ddd + ') ' + resto.slice(0, 4) + '-' + resto.slice(4);
  return '(' + ddd + ') ' + resto.slice(0, 5) + '-' + resto.slice(5);
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
      placeholder: !FILTRO_STATUS_IDS.has(id),
      placeholderValue: 'Selecione...'
    });
  });
}

// Quando true, os listeners de 'change' dos filtros de status ignoram o evento
// (o Choices.js dispara 'change' ao definir o valor por código, o nativo não).
let _suprimirChangeFiltro = false;

// Define o valor de um select que pode estar embrulhado pelo Choices.js.
function setSelectVal(id, val) {
  const c = choicesMap[id];
  if (c) {
    _suprimirChangeFiltro = true;
    try { c.setChoiceByValue(val); } finally { _suprimirChangeFiltro = false; }
  } else {
    $(id).value = val;
  }
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

// ===================== INTERNET =====================
let INTERNET = [];
let modalInternet = null;

async function carregarInternet() {
  const cont = $('corpoTabelaInternet');
  try {
    if (!OPTIONS.UNIDADE || !OPTIONS.UNIDADE.length) { try { await loadOptions(); } catch {} }
    INTERNET = await api('GET', '/api/internet');
    renderTabelaInternet();
  } catch (err) {
    cont.innerHTML = '<tr><td colspan="5" class="text-danger">Erro: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function linkCellInternet(url) {
  const u = trim(url);
  if (!u) return '<span class="text-muted">—</span>';
  const href = /^https?:\/\//i.test(u) ? u : 'http://' + u;
  return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener" title="' + escapeHtml(u) + '">' + escapeHtml(u) + '</a>';
}

function rowHtmlInternet(r) {
  const muted = (v) => v ? escapeHtml(v) : '<span class="text-muted">—</span>';
  return '<tr class="row-internet" data-id="' + escapeHtml(r.id) + '" style="cursor:pointer">' +
    '<td title="' + escapeHtml(r.unidade) + '">' + escapeHtml(r.unidade) + '</td>' +
    '<td>' + muted(r.empresa) + '</td>' +
    '<td>' + muted(r.ipInternet) + '</td>' +
    '<td>' + muted(r.upDown) + '</td>' +
    '<td>' + linkCellInternet(r.linkAcesso) + '</td>' +
    '</tr>';
}

function renderTabelaInternet() {
  const cont = $('corpoTabelaInternet');
  if (!INTERNET.length) {
    cont.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">Nenhum contrato de internet cadastrado.</td></tr>';
    return;
  }
  cont.innerHTML = INTERNET.map(rowHtmlInternet).join('');
}

// Popula o select CONTRATO com os CNPJs cadastrados nas unidades (Opções).
function preencherContratoSelect(atual) {
  const pares = Object.keys(UNIDADE_CNPJ)
    .filter((u) => UNIDADE_CNPJ[u])
    .map((u) => ({ cnpj: UNIDADE_CNPJ[u], unidade: u }))
    .sort((a, b) => a.unidade.localeCompare(b.unidade));
  const itens = [{ value: '', label: 'Selecione...', placeholder: true, selected: !atual }]
    .concat(pares.map((p) => ({ value: p.cnpj, label: p.cnpj + ' (' + p.unidade + ')', selected: p.cnpj === atual })));
  const inst = choicesMap['internet_contrato'];
  if (inst) {
    inst.setChoices(itens, 'value', 'label', true);
    if (atual) inst.setChoiceByValue(atual);
  } else {
    $('internet_contrato').innerHTML = itens.map((o) =>
      '<option value="' + escapeHtml(o.value) + '"' + (o.selected ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>').join('');
  }
}

// CNPJ e endereço são derivados da unidade escolhida (somente leitura).
function aplicarUnidadeInternet(unidade) {
  $('internet_cnpj').value = UNIDADE_CNPJ[unidade] || '';
  $('internet_endereco').value = UNIDADE_ENDERECO[unidade] || '';
}

// Alterna o modal de internet entre visualização (campos travados) e edição.
function setInternetModo(editavel) {
  const inputs = ['internet_empresa', 'internet_ip', 'internet_up_down', 'internet_valor', 'internet_vencimento', 'internet_telefone', 'internet_linha_acesso', 'internet_link_acesso', 'internet_email_contas', 'internet_observacao'];
  inputs.forEach((id) => { $(id).disabled = !editavel; });
  ['internet_unidade', 'internet_contrato'].forEach((id) => {
    const c = choicesMap[id];
    if (c) { if (editavel) c.enable(); else c.disable(); }
    else $(id).disabled = !editavel;
  });
  const temId = !!$('internet_id').value;
  $('internetModalTitle').textContent = editavel ? (temId ? 'Editar contrato de internet' : 'Novo contrato de internet') : 'Contrato de internet';
  $('btnEditarInternet').classList.toggle('d-none', editavel);
  $('btnSalvarInternet').classList.toggle('d-none', !editavel);
  $('btnExcluirInternet').classList.toggle('d-none', !(editavel && temId));
}

function abrirInternet(id) {
  const r = id != null ? INTERNET.find((x) => String(x.id) === String(id)) : null;
  $('alertInternetModal').innerHTML = '';
  $('formInternet').classList.remove('was-validated');
  $('internet_id').value = r ? r.id : '';

  fillSelect('internet_unidade', valsParaEdicao('UNIDADE', r ? r.unidade : ''), r ? r.unidade : '');
  preencherContratoSelect(r ? r.contratoCnpj : '');
  $('internet_empresa').value = r ? (r.empresa || '') : '';
  $('internet_ip').value = r ? (r.ipInternet || '') : '';
  $('internet_up_down').value = r ? (r.upDown || '') : '';
  $('internet_valor').value = r && r.valor != null ? formatarMoeda(r.valor) : '';
  $('internet_vencimento').value = r && r.vencimentoDia != null ? r.vencimentoDia : '';
  $('internet_telefone').value = maskTelefone(r ? (r.telefoneSuporte || '') : '');
  $('internet_linha_acesso').value = r ? (r.linhaAcesso || '') : '';
  $('internet_link_acesso').value = r ? (r.linkAcesso || '') : '';
  $('internet_email_contas').value = r ? (r.emailContas || '') : '';
  $('internet_observacao').value = r ? (r.observacao || '') : '';
  aplicarUnidadeInternet(r ? r.unidade : '');
  setInternetModo(id == null);
  modalInternet.show();
}

function dadosInternet() {
  return {
    unidade: trim($('internet_unidade').value),
    empresa: trim($('internet_empresa').value),
    contratoCnpj: trim($('internet_contrato').value),
    ipInternet: trim($('internet_ip').value),
    upDown: trim($('internet_up_down').value),
    valor: parseMoeda($('internet_valor').value),
    vencimentoDia: $('internet_vencimento').value !== '' ? parseInt($('internet_vencimento').value, 10) : null,
    telefoneSuporte: trim($('internet_telefone').value),
    linhaAcesso: trim($('internet_linha_acesso').value),
    linkAcesso: trim($('internet_link_acesso').value),
    emailContas: trim($('internet_email_contas').value),
    observacao: trim($('internet_observacao').value)
  };
}

async function salvarInternet(ev) {
  ev.preventDefault();
  const form = $('formInternet');
  if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
  const id = $('internet_id').value;
  const btn = $('btnSalvarInternet');
  btn.disabled = true;
  try {
    if (id) await api('PUT', '/api/internet/' + id, dadosInternet());
    else await api('POST', '/api/internet', dadosInternet());
    modalInternet.hide();
    await carregarInternet();
    showAlert('alertInternet', 'success', 'Contrato salvo.');
  } catch (err) {
    showAlert('alertInternetModal', 'danger', 'Erro: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function excluirInternet() {
  const id = $('internet_id').value;
  if (!id) return;
  const ok = await uiConfirm('Excluir este contrato de internet?', { title: 'Excluir', okText: 'Excluir' });
  if (!ok) return;
  try {
    await api('DELETE', '/api/internet/' + id);
    modalInternet.hide();
    await carregarInternet();
    showAlert('alertInternet', 'success', 'Contrato excluído.');
  } catch (err) {
    showAlert('alertInternetModal', 'danger', 'Erro: ' + err.message);
  }
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
  // Dispara em paralelo: /api/chamados/unidades independe de /api/options.
  const pMsaUnidades = MSA_UNIDADES.length ? null : api('GET', '/api/chamados/unidades').catch(() => []);
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
  UNIDADE_CNPJ = {};
  UNIDADE_ENDERECO = {};
  (data['UNIDADE'] || []).forEach((o) => {
    if (o.detalhe) UNIDADE_MSA[o.valor] = o.detalhe;
    if (o.cnpj) UNIDADE_CNPJ[o.valor] = o.cnpj;
    if (o.endereco) UNIDADE_ENDERECO[o.valor] = o.endereco;
  });
  if (pMsaUnidades) MSA_UNIDADES = await pMsaUnidades;
  INSUMO_QTD = {};
  (data['INSUMOS'] || []).forEach((o) => { INSUMO_QTD[o.valor] = o.quantidade ?? 0; });
  INSUMOS = (data['INSUMOS'] || []).filter((o) => !o.oculto).map((o) => o.valor);
  renderAllSelects();
  renderListaOpcoes();
}

function renderListaOpcoes() {
  const lista = $('listaAlvo').value;
  if (lista === 'CHAMADOS') {
    $('opcoesGenericoView').style.display = 'none';
    $('btnAdicionar').style.display = 'none';
    $('ciCategoriasPainel').style.display = '';
    carregarCategoriasPainel().catch((err) => {
      $('alertCategoriasIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    });
    return;
  }
  $('opcoesGenericoView').style.display = '';
  $('btnAdicionar').style.display = '';
  $('ciCategoriasPainel').style.display = 'none';

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

  const visiveis = values.filter((v) => ctxPassa(opcoesFilterCtx, v));
  if (!visiveis.length) {
    container.innerHTML =
      '<div class="table-responsive"><table class="table table-striped align-middle tabela-opcoes mb-0">' +
      '<thead><tr>' + opcoesThead(lista) + '</tr></thead>' +
      '<tbody><tr><td colspan="3" class="text-muted text-center py-3">' +
      'Nenhuma opção corresponde ao filtro.</td></tr></tbody></table></div>';
    ctxAtualizarTh(opcoesFilterCtx);
    return;
  }

  const linhas = visiveis.map((v) => {
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

    let qtdCell = '';
    if (isInsumo) {
      const qtd = INSUMO_QTD[v] ?? 0;
      qtdCell = '<td>' + qtd + ' <span class="text-muted small">un</span></td>';
    } else if (isEquip) {
      const cnt = EQUIP_QTD_REG[v] ?? 0;
      qtdCell = '<td><span class="badge bg-secondary bg-opacity-10 text-secondary fw-normal">' +
        cnt + '</span></td>';
    } else if (isUnidade) {
      const cnpj = UNIDADE_CNPJ[v] || '';
      const endereco = UNIDADE_ENDERECO[v] || '';
      const cnpjLine = cnpj ? escapeHtml(cnpj) : '<span class="text-muted">—</span>';
      const endLine = endereco ? '<br><small class="text-muted">' + escapeHtml(endereco) + '</small>' : '';
      qtdCell = '<td>' + cnpjLine + endLine + '</td>';
    } else {
      qtdCell = '<td></td>';
    }

    // Linha clicável: as ações (renomear, ocultar/exibir, detalhes) ficam no
    // modal de edição, aberto ao clicar em qualquer ponto da linha.
    return '<tr class="row-clicavel" data-opt="' + vEsc + '">' +
      '<td class="opt-nome">' + nomeCell + '</td>' +
      qtdCell +
      '<td>' + status + '</td></tr>';
  }).join('');

  container.innerHTML =
    '<div class="table-responsive"><table class="table table-striped align-middle tabela-opcoes mb-0">' +
    '<thead><tr>' + opcoesThead(lista) + '</tr></thead>' +
    '<tbody>' + linhas + '</tbody></table></div>';
  ctxAtualizarTh(opcoesFilterCtx);
}

// Cabeçalho da tabela de Opções com colunas filtráveis (funil).
function opcoesThead(lista) {
  const isEquip = lista === 'EQUIPAMENTO';
  const isInsumo = lista === 'INSUMOS';
  const isUnidade = lista === 'UNIDADE';
  const th = (col, label) => '<th class="th-filterable" data-col="' + col + '">' +
    escapeHtml(label) + ' <i class="ph ph-funnel-simple col-filter-icon"></i></th>';
  const qtdHeader = isInsumo ? th(1, 'Qtd. em estoque') : isEquip ? th(1, 'Registros') : isUnidade ? th(1, 'CNPJ / Endereço') : '<th></th>';
  return th(0, 'Opção') + qtdHeader + th(2, 'Status');
}

// Valor de uma coluna da tabela de Opções (para o filtro de cabeçalho).
function opcoesColVal(v, col) {
  const lista = $('listaAlvo').value;
  if (col === 0) return String(v);
  if (col === 2) return (HIDDEN[lista] || []).indexOf(v) === -1 ? 'Ativo' : 'Inativo';
  if (col === 1) {
    if (lista === 'INSUMOS') return String(INSUMO_QTD[v] ?? 0);
    if (lista === 'EQUIPAMENTO') return String(EQUIP_QTD_REG[v] ?? 0);
    if (lista === 'UNIDADE') return UNIDADE_CNPJ[v] || '';
  }
  return '';
}

const opcoesFilterCtx = {
  theadSel: '#listaOpcoes thead th[data-col]',
  getRows: () => OPTIONS[$('listaAlvo').value] || [],
  colVal: opcoesColVal,
  filters: {},
  maxItems: 4,
  radioCols: [2],
  onApply: renderListaOpcoes,
};

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
let _facets = null;          // valores únicos por coluna (GET /api/records/facets)
let _facetsCarregando = null;

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
  _facets = null;
  _facetsCarregando = null;
}

// Facetas: valores únicos por coluna direto do servidor (SELECT DISTINCT) —
// poucos KB no lugar do dump completo só para montar o dropdown do funil.
// campos: array para busca sob demanda (ex.: ['obs']) ou null para o pacote
// padrão (todas as colunas exceto obs, quase única por linha).
function carregarFacetas(campos) {
  const faltando = (campos || COL_FIELDS.filter((f) => f !== 'obs'))
    .filter((f) => !_facets || !(f in _facets));
  if (!faltando.length) return Promise.resolve();
  if (!campos && _facetsCarregando) return _facetsCarregando;
  const p = api('GET', '/api/records/facets' + (campos ? '?campo=' + faltando.join(',') : ''))
    .then((d) => { _facets = { ...(_facets || {}), ...d }; })
    .finally(() => { if (!campos) _facetsCarregando = null; });
  if (!campos) _facetsCarregando = p;
  return p; // sem catch: fdAbrir mostra o estado de erro com retry
}

// Opções do dropdown a partir das facetas, formatadas exatamente como colVal
// formata as linhas (fmtData, Sim/Não, brancos) — paridade com ctxUnique.
function facetVals(col) {
  const f = COL_FIELDS[col];
  const brutos = (_facets && _facets[f]) || [];
  const seen = new Set(), out = [];
  for (const raw of brutos) {
    const v = colVal({ [f]: raw }, col);
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out.sort((a, b) => a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'pt-BR'));
}

// Recarrega a lista descartando o cache; com filtro ativo, rebaixa todos os
// registros para que renderTabela não caia no fallback da página atual.
async function recarregarRegistros() {
  invalidarCacheTodos();
  await loadRecords(true);
  if (Object.keys(colFilters).length > 0 || buscaRegistros() !== '') {
    await carregarTodosParaFiltro();
    renderTabela();
  }
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
  return '<tr class="row-registro" data-ver="' + escapeHtml(r.id) + '">' +
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
    '</tr>';
}

function renderTabela() {
  const corpo = $('corpoTabela');
  const busca = buscaRegistros();
  const temFiltro = Object.keys(colFilters).length > 0 || busca !== '';
  const fonte = temFiltro && _todosCarregados ? _todosRegistros : REGISTROS;
  const filtered = temFiltro
    ? fonte.filter((r) => passaFiltros(r) && (!busca || matchBuscaRegistro(r, busca)))
    : REGISTROS;
  $('sentinelTabela').classList.toggle('d-none', _recAllLoaded || temFiltro);
  if (!filtered.length) {
    const msg = temFiltro
      ? 'Nenhum registro corresponde ao filtro ativo.'
      : 'Nenhum registro cadastrado.';
    corpo.innerHTML = '<tr><td colspan="11" class="text-muted">' + msg + '</td></tr>';
    atualizarThFiltro();
    return;
  }
  corpo.innerHTML = filtered.map(rowHtml).join('');
  atualizarThFiltro();
}

function appendTabela(registros) {
  if (Object.keys(colFilters).length > 0 || buscaRegistros() !== '') return;
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
  const fonte = _todosCarregados ? _todosRegistros : REGISTROS;
  const r = fonte.find((x) => String(x.id) === String(id));
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
  setModalEditarModo(false);
  modalEditar.show();
}

// Alterna o modal de registro entre visualização (editavel=false) e edição.
function setModalEditarModo(editavel) {
  ['edit_unidade', 'edit_status', 'edit_setor', 'edit_equipamento', 'edit_insumo']
    .forEach((id) => {
      $(id).disabled = !editavel;
      const c = choicesMap[id];
      if (c) { editavel ? c.enable() : c.disable(); }
    });
  ['edit_usuario', 'edit_pat', 'edit_ns', 'edit_protocolo', 'edit_obs']
    .forEach((id) => { $(id).readOnly = !editavel; });
  const fpData = fpMap['edit_dataRecebimento'];
  if (fpData) {
    fpData.set('clickOpens', editavel);
    if (fpData.altInput) fpData.altInput.readOnly = !editavel;
  }
  $('edit_btnAddFotoCol').classList.toggle('d-none', !editavel);
  document.querySelectorAll('#formEditar .foto-edit-only')
    .forEach((b) => b.classList.toggle('d-none', !editavel));
  if (editavel) atualizarBtnAddFoto('edit_');
  const jEl = $('edit_justificativa');
  jEl.value = '';
  jEl.disabled = true;
  jEl.required = false;
  jEl.placeholder = editavel ? 'Descreva o motivo da alteração...' : '';
  $('edit_justificativa_grupo').classList.toggle('d-none', !editavel);
  $('btnSalvarEdicao').classList.toggle('d-none', !editavel);
  $('btnEditarRegistro').classList.toggle('d-none', editavel);
  $('modalEditarTitulo').textContent = editavel ? 'Editar Registro' : 'Visualizar Registro';
  $('formEditar').classList.remove('was-validated');
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

// Busca da lupa: termo (já normalizado) contra QUALQUER coluna do registro.
function buscaRegistros() { return buscaNorm(trim($('regBusca').value)); }
function matchBuscaRegistro(r, termo) {
  for (let i = 0; i < COL_FIELDS.length; i++) {
    if (buscaNorm(colVal(r, i)).includes(termo)) return true;
  }
  return false;
}

function atualizarThFiltro() {
  document.querySelectorAll('#tabelaScroll thead th[data-col]').forEach(th => {
    const ativo = colFilters[th.getAttribute('data-col')] != null;
    th.classList.toggle('col-filter-ativo', ativo);
  });
  const btnLimpar = $('btnLimparFiltros');
  if (btnLimpar) btnLimpar.classList.toggle('filtro-on', Object.keys(colFilters).length > 0 || buscaRegistros() !== '');
}

function criarFilterDropdown() {
  if (_fdEl) return;
  _fdEl = document.createElement('div');
  _fdEl.id = 'colFilterDropdown';
  _fdEl.style.display = 'none';
  _fdEl.innerHTML =
    '<div id="fdTools" style="padding:.75rem .75rem .5rem">' +
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
    '<div id="fdFooter" style="padding:.6rem .75rem;display:flex;justify-content:flex-end;gap:.5rem">' +
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

function fdIsRadio() {
  return !!(_fdActive && _fdActive.radioCols && _fdActive.radioCols.includes(_fdCol));
}

function fdRenderList() {
  const lista = _fdEl.querySelector('#fdList');

  // Coluna "um ou outro": exibe opções exclusivas (rádio) + "(Todos)".
  if (fdIsRadio()) {
    const todosChk = _fdPendente.size >= _fdAllVals.length ? ' checked' : '';
    let html = '<label class="col-filter-item"><input type="radio" name="fdRadio" data-idx="-1"' + todosChk + '> <em class="text-muted">(Todos)</em></label>';
    html += _fdAllVals.map((v, i) => {
      const chk = (_fdPendente.size < _fdAllVals.length && _fdPendente.has(v)) ? ' checked' : '';
      const lbl = v === '' ? '<em class="text-muted">(Espaços em branco)</em>' : escapeHtml(v);
      return '<label class="col-filter-item"><input type="radio" name="fdRadio" data-idx="' + i + '"' + chk + '> ' + lbl + '</label>';
    }).join('');
    lista.innerHTML = html;
    lista.querySelectorAll('input[type=radio]').forEach(rb => {
      rb.addEventListener('change', () => {
        const idx = Number(rb.dataset.idx);
        _fdPendente.clear();
        if (idx < 0) _fdAllVals.forEach(v => _fdPendente.add(v));
        else _fdPendente.add(_fdAllVals[idx]);
        fdAplicar(); // aplica e fecha na hora, sem precisar de OK
      });
    });
    return;
  }

  const busca = _fdEl.querySelector('#fdSearch').value.toLowerCase();
  const visiveis = busca
    ? _fdAllVals.filter(v => (v === '' ? '(espaços em branco)' : v.toLowerCase()).includes(busca))
    : _fdAllVals.slice();
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
// ctx = { theadSel, getRows(), colVal(r,col), filters{}, onApply(), beforeOpen?(col), uniqueVals?(col) }
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
    const buscaAtiva = ctx.buscaId && trim($(ctx.buscaId).value) !== '';
    if (btn) btn.classList.toggle('filtro-on', Object.keys(ctx.filters).length > 0 || !!buscaAtiva);
  }
}

// Skeleton exibido no dropdown enquanto beforeOpen busca os dados.
function fdRenderCarregando() {
  _fdEl.querySelector('#fdTools').style.display = 'none';
  _fdEl.querySelector('#fdFooter').style.display = 'none';
  _fdEl.querySelector('#fdList').innerHTML =
    '<div class="text-muted text-center py-3" style="font-size:.85rem">' +
    '<i class="ph ph-circle-notch fd-spin" style="font-size:1.3rem"></i>' +
    '<div class="mt-1">Carregando opções...</div></div>';
}

// Falha ao buscar os dados do filtro: erro visível com retry (nada de lista
// vazia silenciosa — em rede lenta isso filtraria errado sem avisar).
function fdRenderErro(msg) {
  _fdEl.querySelector('#fdTools').style.display = 'none';
  _fdEl.querySelector('#fdFooter').style.display = 'none';
  _fdEl.querySelector('#fdList').innerHTML =
    '<div class="text-center py-3" style="font-size:.85rem">' +
    '<i class="ph ph-wifi-slash text-danger" style="font-size:1.3rem"></i>' +
    '<div class="text-muted my-1">' + escapeHtml(msg) + '</div>' +
    '<button type="button" class="btn btn-outline-secondary btn-sm" id="fdRetry">' +
    '<i class="ph ph-arrow-clockwise me-1"></i>Tentar novamente</button></div>';
  _fdEl.querySelector('#fdRetry').addEventListener('click', () => {
    const ctx = _fdActive, col = _fdCol, th = _fdTh;
    fdFechar();
    fdAbrir(ctx, col, th);
  });
}

async function fdAbrir(ctx, col, thEl) {
  criarFilterDropdown();
  if (_fdOutside) { document.removeEventListener('mousedown', _fdOutside); _fdOutside = null; }
  _fdActive = ctx;
  _fdCol = col;
  _fdTh = thEl;
  const token = ++_fdToken;
  // Posiciona e exibe imediatamente; se houver carga (beforeOpen), o usuário
  // vê o skeleton em vez de a UI congelar esperando a rede.
  const rect = thEl.getBoundingClientRect();
  _fdEl.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 290)) + 'px';
  _fdEl.style.top = (rect.bottom + 4) + 'px';
  _fdEl.style.display = 'flex';
  _fdScrollEl = thEl.closest('.table-scroll-x, .table-responsive');
  setTimeout(() => {
    if (token !== _fdToken) return;
    _fdOutside = (e) => {
      if (!_fdEl.contains(e.target) && !e.target.closest('th[data-col]')) fdFechar();
    };
    document.addEventListener('mousedown', _fdOutside);
    _fdScroll = () => {
      // iOS Safari dispara scroll ao abrir o teclado (foco no #fdSearch);
      // não fechar enquanto o foco estiver dentro do dropdown.
      if (_fdEl && _fdEl.contains(document.activeElement)) return;
      fdFechar();
    };
    window.addEventListener('scroll', _fdScroll, { passive: true });
    if (_fdScrollEl) _fdScrollEl.addEventListener('scroll', _fdScroll, { passive: true });
  }, 10);
  if (ctx.beforeOpen) {
    fdRenderCarregando();
    try {
      await ctx.beforeOpen(col);
    } catch {
      if (token === _fdToken) fdRenderErro('Falha ao carregar opções.');
      return;
    }
    if (token !== _fdToken) return; // fechado ou reaberto durante a carga
  }
  _fdAllVals = ctx.uniqueVals ? ctx.uniqueVals(col) : ctxUnique(ctx, col);
  const atual = ctx.filters[String(col)];
  _fdPendente = atual ? new Set(atual) : new Set(_fdAllVals);
  _fdEl.querySelector('#fdSearch').value = '';
  // Coluna "um ou outro" aplica na hora: sem busca, "selecionar tudo/limpar" nem OK/Cancelar.
  _fdEl.querySelector('#fdTools').style.display = fdIsRadio() ? 'none' : '';
  _fdEl.querySelector('#fdFooter').style.display = fdIsRadio() ? 'none' : 'flex';
  fdRenderList();
  // Limita a quantidade de itens visíveis (ex.: 4) quando o contexto pedir.
  const _list = _fdEl.querySelector('#fdList');
  const _item = _list.querySelector('.col-filter-item');
  _list.style.maxHeight = (ctx.maxItems && _item) ? (_item.offsetHeight * ctx.maxItems) + 'px' : '';
}

function fdFechar() {
  _fdToken++; // mata qualquer abertura em voo (skeleton aguardando rede)
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

// ============================================================
//  Busca de tabela (lupa) — filtra as linhas por QUALQUER coluna
// ============================================================
// Normaliza texto para comparação: minúsculas e sem acentos.
function buscaNorm(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

// Liga um input (lupa) a uma tabela: esconde as linhas do tbody cujo texto,
// somando todas as colunas, não contém o termo. Um MutationObserver re-aplica
// o termo quando a tabela é re-renderizada (innerHTML), então funciona tanto
// com tbody fixo quanto com containers que recriam a tabela inteira.
function wireBuscaTabela(inputId, alvoId, clearBtnId, extraOn) {
  const input = $(inputId), alvo = $(alvoId);
  if (!input || !alvo) return;
  // Acende o funil (preto) quando há busca ativa — igual ao de Registros.
  const atualizarBtn = () => {
    const btn = clearBtnId && $(clearBtnId);
    if (btn) btn.classList.toggle('filtro-on', trim(input.value) !== '' || !!(extraOn && extraOn()));
  };
  // Re-aplica o termo quando a tabela re-renderiza. Durante as escritas do
  // próprio aplicar() o observer fica desligado, senão a linha-aviso
  // realimentaria o observer em loop.
  const obs = new MutationObserver(() => aplicar());
  const observar = () => obs.observe(alvo, { childList: true, subtree: true });
  function aplicar() {
    const tbody = alvo.tagName === 'TBODY' ? alvo : alvo.querySelector('tbody');
    if (!tbody) return;
    obs.disconnect();
    const termo = buscaNorm(trim(input.value));
    let total = 0, visiveis = 0;
    for (const tr of tbody.rows) {
      if (tr.classList.contains('busca-sem-resultado')) continue;
      // Linha-mensagem (célula única com colspan: "Carregando...", vazio) não conta.
      const msg = tr.cells.length === 1 && tr.cells[0].hasAttribute('colspan');
      const mostra = msg || !termo || buscaNorm(tr.textContent).includes(termo);
      tr.classList.toggle('d-none', !mostra);
      if (!msg) { total++; if (mostra) visiveis++; }
    }
    let aviso = tbody.querySelector('tr.busca-sem-resultado');
    if (termo && total && !visiveis) {
      if (!aviso) {
        aviso = tbody.insertRow(-1);
        aviso.className = 'busca-sem-resultado';
        const td = aviso.insertCell(0);
        td.className = 'text-muted';
        td.colSpan = tbody.closest('table').querySelector('thead tr')?.cells.length || 1;
      }
      aviso.cells[0].textContent = 'Nenhuma linha corresponde a "' + trim(input.value) + '".';
    } else if (aviso) {
      aviso.remove();
    }
    atualizarBtn();
    observar();
  }
  input.addEventListener('input', aplicar);
  observar();
}

// Cabeçalho com colunas filtráveis (ícone de funil) a partir de um array de COLS.
function thFiltravel(cols) {
  // \n no label vira quebra de linha no cabeçalho (escapa antes, então só os
  // <br> injetados aqui são HTML — labels sem \n não mudam).
  return cols.map((c, i) => '<th class="th-filterable" data-col="' + i + '">' +
    escapeHtml(c.label).replace(/\n/g, '<br>') + ' <i class="ph ph-funnel-simple col-filter-icon"></i></th>').join('');
}

// Aplica o filtro da tabela de Registros (funil de coluna e/ou busca da lupa).
// O dropdown abre com as facetas (leves); o dump completo só é necessário
// aqui, para filtrar de verdade — e, se falhar, o erro fica visível em vez
// de filtrar só a página atual.
async function aplicarFiltroRegistros() {
  if ((Object.keys(colFilters).length || buscaRegistros() !== '') && !_todosCarregados) {
    $('corpoTabela').innerHTML =
      '<tr><td colspan="11" class="text-muted"><i class="ph ph-circle-notch fd-spin me-1"></i>Aplicando filtro...</td></tr>';
    await carregarTodosParaFiltro();
    if (!_todosCarregados) {
      showAlert('alertRegistros', 'danger', 'Não foi possível carregar todos os registros para filtrar. Tente novamente.');
      Object.keys(colFilters).forEach((k) => delete colFilters[k]);
      $('regBusca').value = '';
      renderTabela();
      atualizarThFiltro();
      return;
    }
  }
  renderTabela();
}

// Contexto da tabela de Registros: opções do funil vêm das facetas do
// servidor (obs só sob demanda); o dump completo fica para o apply.
const registrosFilterCtx = {
  theadSel: '#tabelaScroll thead th[data-col]',
  getRows: () => (_todosCarregados ? _todosRegistros : REGISTROS),
  colVal,
  filters: colFilters,
  onApply: aplicarFiltroRegistros,
  beforeOpen: (col) => carregarFacetas(COL_FIELDS[col] === 'obs' ? ['obs'] : null),
  uniqueVals: facetVals,
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
  await recarregarRegistros();
}

// ============================================================
//  Usuários
// ============================================================
let _souMasterCI = false;

let _usuariosCache = [];

async function loadUsuarios() {
  const container = $('listaUsuarios');
  if (!container) return;
  container.innerHTML = '<span class="text-muted">Carregando...</span>';

  try {
    const perfil = await api('GET', '/api/chamados-intecs/meu-perfil');
    _souMasterCI = perfil.role === 'MASTER';
  } catch { _souMasterCI = false; }

  try {
    const usuarios = await api('GET', _souMasterCI ? '/api/chamados-intecs/usuarios' : '/api/users');
    _usuariosCache = usuarios;
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
      const papel = _souMasterCI ? '<td>' + escapeHtml(u.role || '') + '</td>' : '';
      return '<tr class="row-clicavel" data-user-id="' + u.id + '">' +
        '<td class="opt-nome">' + emailHtml + '</td>' +
        papel +
        '<td>' + status + '</td>' +
        '<td>' + quando + '</td>' +
        '</tr>';
    }).join('');
    const theadPapel = _souMasterCI ? '<th>Papel</th>' : '';
    container.innerHTML =
      '<div class="table-responsive"><table class="table table-striped table-hover align-middle mb-0">' +
      '<thead><tr><th>E-mail</th>' + theadPapel + '<th>Status</th><th>Criado em</th></tr></thead>' +
      '<tbody>' + linhas + '</tbody></table></div>';
  } catch (err) {
    container.innerHTML = '<span class="text-danger">Erro ao carregar: ' + escapeHtml(err.message) + '</span>';
  }
}

let modalEditarUsuario = null;

async function abrirEditarUsuario(id) {
  const u = _usuariosCache.find((x) => String(x.id) === String(id));
  if (!u) return;
  $('eu_id').value = u.id;
  $('euTitulo').textContent = 'Editar ' + u.email;
  $('eu_email').value = u.email;
  $('eu_senha').value = '';
  $('eu_ativo').checked = !!u.ativo;
  $('alertEditarUsuario').innerHTML = '';

  $('eu_role_grupo').style.display = _souMasterCI ? '' : 'none';
  $('eu_unidade_grupo').style.display = _souMasterCI ? '' : 'none';
  $('eu_setor_grupo').style.display = _souMasterCI ? '' : 'none';
  if (_souMasterCI) {
    if (!OPTIONS.UNIDADE || !OPTIONS.UNIDADE.length) { try { await loadOptions(); } catch { /* ignora */ } }
    const unidades = activeValues('UNIDADE');
    const setores = activeValues('SETOR');
    $('eu_role').innerHTML = ['BASICO', 'GESTOR', 'TECNICO', 'MASTER']
      .map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('');
    $('eu_unidade').innerHTML = '<option value="">-</option>' +
      unidades.map((v) => `<option value="${escapeHtml(v)}" ${u.unidade === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    $('eu_setor').innerHTML = '<option value="">-</option>' +
      setores.map((v) => `<option value="${escapeHtml(v)}" ${u.setor === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  }
  modalEditarUsuario.show();
}

function configurarModalEditarUsuario() {
  $('listaUsuarios').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-user-id]');
    if (row) abrirEditarUsuario(row.getAttribute('data-user-id'));
  });

  $('btnSalvarEditarUsuario').addEventListener('click', async () => {
    const id = $('eu_id').value;
    const email = trim($('eu_email').value).toLowerCase();
    const senha = $('eu_senha').value;
    const ativo = $('eu_ativo').checked;
    const original = _usuariosCache.find((x) => String(x.id) === String(id));
    $('alertEditarUsuario').innerHTML = '';

    const btn = $('btnSalvarEditarUsuario');
    btn.disabled = true;
    try {
      if (email && email !== original.email) await api('PUT', '/api/users/' + id, { email });
      if (senha) {
        if (senha.length < 6) throw new Error('A senha deve ter ao menos 6 caracteres.');
        await api('PUT', '/api/users/' + id, { senha });
      }
      if (ativo !== !!original.ativo) await api('PUT', '/api/users/' + id, { ativo });
      if (_souMasterCI) {
        await api('PUT', '/api/chamados-intecs/usuarios/' + id, {
          role: $('eu_role').value, unidade: $('eu_unidade').value, setor: $('eu_setor').value
        });
      }
      modalEditarUsuario.hide();
      await loadUsuarios();
      showAlert('alertUsuarios', 'success', 'Usuário atualizado.');
    } catch (err) {
      $('alertEditarUsuario').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    } finally {
      btn.disabled = false;
    }
  });
}

// ============================================================
//  Empréstimos
// ============================================================
// Preenche os selects do formulário de empréstimo (PAT vem dos registros).
async function loadEmprestimoForm() {
  fillSelect('emp_unidade', activeValues('UNIDADE'), '');
  try {
    const pats = await api('GET', '/api/pats');
    fillSelect('emp_pat', pats, '');
  } catch (err) {
    showAlert('alertEmprestimos', 'danger', 'Erro ao carregar PATs: ' + err.message);
  }
  $('emp_ns_grupo').style.display = 'none';
  $('emp_ns').required = false;
  fillSelect('emp_ns', []);
  $('emp_pat_info').textContent = '';
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
  const info = $('emp_pat_info');
  $('emp_ns_grupo').style.display = 'none';
  $('emp_ns').required = false;
  fillSelect('emp_ns', []);
  info.textContent = '';
  if (!pat) return;
  info.textContent = 'Buscando...';
  try {
    const [nsList, d] = await Promise.all([
      api('GET', '/api/pats/' + encodeURIComponent(pat) + '/ns'),
      api('GET', '/api/pats/' + encodeURIComponent(pat) + '/info')
    ]);

    if (nsList.length <= 1) {
      // Apenas 1 NS (ou nenhum): auto-seleciona e esconde o campo.
      if (nsList.length === 1) {
        fillSelect('emp_ns', nsList);
        $('emp_ns').value = nsList[0];
      }
    } else {
      fillSelect('emp_ns', nsList);
      $('emp_ns').required = true;
      $('emp_ns_grupo').style.display = '';
    }

    const ns = nsList.length === 1 ? nsList[0] : '';
    info.innerHTML = d.equipamento
      ? `<i class="ph ph-desktop-tower me-1"></i><strong>${escapeHtml(d.equipamento)}</strong>` +
        (ns ? ` <span class="ms-2 text-secondary">N/S: ${escapeHtml(ns)}</span>` : '')
      : '';
  } catch (err) {
    info.textContent = '';
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
      showAlert('alertEmprestimoModal', 'danger', err.message);
      btn.disabled = false; btn.textContent = 'Emprestar';
      return;
    }

    if (!confirmado) { btn.disabled = false; btn.textContent = 'Emprestar'; return; }

    btn.textContent = 'Emprestando...';
    try {
      const res = await api('POST', '/api/loans', dados);
      form.reset();
      form.classList.remove('was-validated');
      modalEmprestimo.hide();
      await loadEmprestimoForm();
      showAlert('alertEmprestimos', 'success', res.devolvido ? 'Equipamento devolvido à unidade original.' : 'Empréstimo registrado.');
      await loadEmprestimos();
    } catch (err) {
      showAlert('alertEmprestimoModal', 'danger', err.message);
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
      talvezConvidarBiometria(data.email);
    } catch (err) {
      showAlert('alertAuth', 'danger', err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  });
  $('btnSair').addEventListener('click', sairDoApp);

  // ---- Biometria (celular) ----
  $('btnEntrarBio')?.addEventListener('click', entrarComBiometria);
  $('btnAtivarBio')?.addEventListener('click', ativarBiometria);
}

// ============================================================
//  Biometria (WebAuthn) — só no celular
// ============================================================
const WA = () => window.SimpleWebAuthnBrowser;
let _ehCelularCache = null;

// Celular = UA mobile E com autenticador de plataforma (digital/rosto) disponível.
async function ehCelular() {
  if (_ehCelularCache !== null) return _ehCelularCache;
  const uaMobile = navigator.userAgentData?.mobile ??
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  let temPlataforma = false;
  try {
    temPlataforma = !!(window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { temPlataforma = false; }
  _ehCelularCache = uaMobile && temPlataforma && !!WA();
  return _ehCelularCache;
}

// Exibe/oculta a opção "ou entrar com biometria" abaixo do formulário de senha.
function mostrarBioOpcao() { $('bioOpcao').classList.remove('hidden'); }
function ocultarBioOpcao() { $('bioOpcao').classList.add('hidden'); }

// Na abertura: se for celular e este aparelho já tem biometria, mostra a opção.
async function prepararTelaLogin() {
  if (localStorage.getItem('biometria_cred_id') && await ehCelular()) {
    mostrarBioOpcao();
  }
}

// Após o login por senha no celular: convida a cadastrar a biometria (se ainda não tem).
async function talvezConvidarBiometria(email) {
  if (!(await ehCelular())) return;
  try {
    // Vinculamos a biometria a ESTE aparelho (credencial guardada localmente).
    // Sem o marcador local, oferecemos o cadastro mesmo que o servidor tenha
    // uma credencial antiga (ex.: sincronizada no Google) de outro fluxo.
    if (localStorage.getItem('biometria_cred_id')) return;
    window._bioEmail = email;
    bootstrap.Modal.getOrCreateInstance($('modalBiometria')).show();
  } catch { /* silencioso */ }
}

// Cadastra a credencial biométrica deste aparelho.
async function ativarBiometria() {
  const btn = $('btnAtivarBio');
  btn.disabled = true;
  try {
    const options = await api('POST', '/api/biometric/register/options');
    const attResp = await WA().startRegistration({ optionsJSON: options });
    await api('POST', '/api/biometric/register/verify',
      { ...attResp, rotulo: navigator.userAgent.slice(0, 200) });
    localStorage.setItem('biometria_email', window._bioEmail || '');
    localStorage.setItem('biometria_cred_id', attResp.id);
    bootstrap.Modal.getOrCreateInstance($('modalBiometria')).hide();
    showAlert('alertAuth', 'success', 'Biometria ativada! Use-a no próximo acesso.');
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? 'Cadastro cancelado.' : (err.message || 'Não foi possível ativar a biometria.');
    showAlert('alertBiometria', 'danger', msg);
  } finally {
    btn.disabled = false;
  }
}

// Entra usando a biometria do aparelho.
async function entrarComBiometria() {
  const btn = $('btnEntrarBio');
  btn.disabled = true;
  try {
    const credId = localStorage.getItem('biometria_cred_id') || '';
    const { flowId, options } = await api('POST', '/api/biometric/auth/options', { credId });
    const authResp = await WA().startAuthentication({ optionsJSON: options });
    const data = await api('POST', '/api/biometric/auth/verify', { flowId, response: authResp });
    TOKEN = data.token;
    localStorage.setItem('token', TOKEN);
    localStorage.setItem('biometria_email', data.email);
    await entrarNoApp(data.email, true);
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? 'Autenticação cancelada.' : (err.message || 'Falha na biometria. Use e-mail e senha.');
    showAlert('alertAuth', 'danger', msg);
  } finally {
    btn.disabled = false;
  }
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
      await recarregarRegistros();
    } catch (err) {
      showAlert('alertRegistrar', 'danger', 'Erro ao salvar: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Registrar';
    }
  });
}

function configurarFormOpcao() {
  $('listaAlvo').addEventListener('change', () => {
    Object.keys(opcoesFilterCtx.filters).forEach((k) => delete opcoesFilterCtx.filters[k]);
    renderListaOpcoes();
  });
  wireCtxFiltro(opcoesFilterCtx, $('listaOpcoes'));

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

  // Linha clicável → abre o modal de edição da opção.
  $('listaOpcoes').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-opt]');
    if (row) abrirModalOpcao(row.getAttribute('data-opt'));
  });

  // Máscara de CNPJ no campo do modal.
  $('opcao_cnpj').addEventListener('input', (ev) => {
    ev.target.value = maskCNPJ(cnpjDigits(ev.target.value));
  });

  $('formOpcao').addEventListener('submit', salvarModalOpcao);
}

// Abre o modal de edição de uma opção, com os campos da lista atual
// (EQUIPAMENTO: detalhe/valor/tipo; UNIDADE: MSA/CNPJ/endereço; INSUMOS: qtd).
function abrirModalOpcao(val) {
  const lista = $('listaAlvo').value;
  const isEquip = lista === 'EQUIPAMENTO';
  const isUnidade = lista === 'UNIDADE';
  const isInsumo = lista === 'INSUMOS';

  $('opcaoModalTitle').textContent = 'Editar ' + lista.toLowerCase();
  $('alertOpcaoModal').innerHTML = '';
  $('formOpcao').classList.remove('was-validated');
  $('opcao_original').value = val;
  $('opcao_nome').value = val;

  $('opcao_detalhe_grupo').style.display = isEquip ? '' : 'none';
  $('opcao_preco_grupo').style.display = isEquip ? '' : 'none';
  $('opcao_tipo_grupo').style.display = isEquip ? '' : 'none';
  $('opcao_msa_grupo').style.display = isUnidade ? '' : 'none';
  $('opcao_cnpj_grupo').style.display = isUnidade ? '' : 'none';
  $('opcao_endereco_grupo').style.display = isUnidade ? '' : 'none';
  $('opcao_qtd_grupo').style.display = isInsumo ? '' : 'none';

  if (isEquip) {
    $('opcao_detalhe').value = EQUIP_DETALHE[val] || '';
    $('opcao_preco').value = EQUIP_PRECO[val] != null ? String(EQUIP_PRECO[val]).replace('.', ',') : '';
    $('opcao_tipo').value = EQUIP_TIPO[val] || '';
  }
  if (isUnidade) {
    $('opcao_msa').innerHTML = '<option value="">-</option>' +
      (MSA_UNIDADES || []).map((u) => '<option value="' + escapeHtml(u) + '"' +
        (UNIDADE_MSA[val] === u ? ' selected' : '') + '>' + escapeHtml(u) + '</option>').join('');
    $('opcao_cnpj').value = UNIDADE_CNPJ[val] || '';
    $('opcao_endereco').value = UNIDADE_ENDERECO[val] || '';
  }
  if (isInsumo) $('opcao_qtd').value = INSUMO_QTD[val] ?? 0;

  $('opcao_ativo').checked = (HIDDEN[lista] || []).indexOf(val) === -1;
  modalOpcao.show();
}

async function salvarModalOpcao(ev) {
  ev.preventDefault();
  const lista = $('listaAlvo').value;
  const original = $('opcao_original').value;
  const limpo = trim($('opcao_nome').value).toUpperCase();
  if (!limpo) {
    $('formOpcao').classList.add('was-validated');
    return;
  }
  let cnpj = null;
  if (lista === 'UNIDADE') {
    const dig = cnpjDigits($('opcao_cnpj').value);
    if (dig && dig.length !== 14) {
      $('alertOpcaoModal').innerHTML = '<div class="alert alert-warning py-2 mb-0">CNPJ inválido — informe 14 dígitos.</div>';
      return;
    }
    cnpj = dig ? maskCNPJ(dig) : null;
  }

  const btn = $('btnSalvarOpcao');
  btn.disabled = true; btn.innerHTML = '<i class="ph ph-circle-notch fd-spin"></i> Salvando...';
  try {
    if (limpo !== original) {
      await api('PUT', '/api/options/rename', { lista, valor: original, novoValor: limpo });
    }
    if (lista === 'EQUIPAMENTO') {
      const precoRaw = trim($('opcao_preco').value);
      // "1.234,56" e "1234,56" → 1234.56; "1234.56" (decimal com ponto) fica como está.
      const precoNorm = precoRaw.includes(',') ? precoRaw.replace(/\./g, '').replace(',', '.') : precoRaw;
      const preco = precoRaw !== '' ? Number(precoNorm) : null;
      await api('PUT', '/api/options/detalhe', {
        lista, valor: limpo,
        detalhe: trim($('opcao_detalhe').value) || null,
        preco: preco != null && !isNaN(preco) ? preco : null,
        tipo_aquisicao: $('opcao_tipo').value || null
      });
    } else if (lista === 'UNIDADE') {
      await api('PUT', '/api/options/detalhe', {
        lista, valor: limpo,
        detalhe: $('opcao_msa').value || null,
        preco: null, tipo_aquisicao: null,
        cnpj, endereco: trim($('opcao_endereco').value) || null
      });
    } else if (lista === 'INSUMOS') {
      const qtd = parseInt($('opcao_qtd').value, 10);
      if (!isNaN(qtd) && qtd >= 0 && qtd !== (INSUMO_QTD[original] ?? 0)) {
        await api('PUT', '/api/options/quantidade', { valor: limpo, quantidade: qtd });
      }
    }
    const ativo = $('opcao_ativo').checked;
    const eraAtivo = (HIDDEN[lista] || []).indexOf(original) === -1;
    if (ativo !== eraAtivo) {
      await api('PUT', '/api/options/hidden', { lista, valor: limpo, oculto: !ativo });
    }
    await loadOptions();
    modalOpcao.hide();
    showAlert('alertGerenciar', 'success', 'Opção atualizada.');
  } catch (err) {
    $('alertOpcaoModal').innerHTML = '<div class="alert alert-danger py-2 mb-0">Erro: ' + escapeHtml(err.message) + '</div>';
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="ph ph-check"></i> Salvar';
  }
}

let modalNovoUsuario = null;

async function abrirNovoUsuario() {
  $('formNovoUsuario').reset();
  $('formNovoUsuario').classList.remove('was-validated');
  $('alertNovoUsuario').innerHTML = '';
  ['novo_role_grupo', 'novo_unidade_grupo', 'novo_setor_grupo'].forEach((id) => { $(id).style.display = _souMasterCI ? '' : 'none'; });
  if (_souMasterCI) {
    if (!OPTIONS.UNIDADE || !OPTIONS.UNIDADE.length) { try { await loadOptions(); } catch { /* ignora */ } }
    const unidades = activeValues('UNIDADE');
    const setores = activeValues('SETOR');
    $('novo_unidade').innerHTML = '<option value="">-</option>' + unidades.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    $('novo_setor').innerHTML = '<option value="">-</option>' + setores.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  }
  modalNovoUsuario.show();
}

function configurarFormUsuario() {
  $('btnNovoUsuario').addEventListener('click', abrirNovoUsuario);

  const form = $('formNovoUsuario');
  $('btnCriarUsuario').addEventListener('click', async () => {
    if (!form.checkValidity()) { form.classList.add('was-validated'); return; }
    const email = trim($('novo_email').value);
    const senha = $('novo_senha').value;
    const role = $('novo_role').value;
    const unidade = $('novo_unidade').value;
    const setor = $('novo_setor').value;
    const btn = $('btnCriarUsuario');
    btn.disabled = true; btn.textContent = 'Criando...';
    try {
      const criado = await api('POST', '/api/users', { email, senha });
      if (_souMasterCI && (role !== 'BASICO' || unidade || setor)) {
        await api('PUT', '/api/chamados-intecs/usuarios/' + criado.id, { role, unidade, setor });
      }
      modalNovoUsuario.hide();
      showAlert('alertUsuarios', 'success', 'Usuário ' + email + ' criado com sucesso.');
      await loadUsuarios();
    } catch (err) {
      $('alertNovoUsuario').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = 'Criar';
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
    btn.disabled = true; btn.innerHTML = '<i class="ph ph-circle-notch fd-spin"></i> Salvando...';
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
      await recarregarRegistros();
    } catch (err) {
      showAlert('alertRegistros', 'danger', 'Erro ao salvar: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="ph ph-check"></i> Salvar';
    }
  });

  $('btnVerLog').addEventListener('click', () => {
    const id = $('edit_id').value;
    if (!id) return;
    abrirLog(id);
  });

  $('btnEditarRegistro').addEventListener('click', () => {
    setModalEditarModo(true);
  });

  $('corpoTabela').addEventListener('click', (ev) => {
    const hist = ev.target.closest('[data-hist]');
    if (hist) { abrirHistoricoPat(hist.getAttribute('data-hist'), hist.getAttribute('data-ns')); return; }
    const row = ev.target.closest('tr[data-ver]');
    if (row) abrirEdicao(row.getAttribute('data-ver'));
  });
}

async function abrirLog(registroId) {
  $('logBusca').value = ''; // busca da lupa não persiste entre registros
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
    const row = ev.target.closest('tr[data-ver-chave]');
    if (!row) return;
    abrirDetalheChamado(row.getAttribute('data-ver-chave'), row.getAttribute('data-ver-codigo'), row.getAttribute('data-ver-st') || '');
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
//  Chamados INTECS (interno) + equipamento (Tactical RMM)
// ============================================================
let modalNovoChamadoIntecs = null;
let modalChamadoIntecsDetalhe = null;
let _chamadosIntecs = [];
let _chamadoIntecsAtual = null;
let _ciCategorias = [];
let _ciUsuarios = [];
let _ciSort = { col: 'criado_em', dir: 'desc' };
let _ciCharts = {};

let CI_STATUS_LABEL = {
  ABERTO: 'Aberto', EM_ANALISE: 'Em análise', AGUARDANDO_USUARIO: 'Aguardando usuário',
  EM_ATENDIMENTO: 'Em atendimento', AGUARDANDO_FORNECEDOR: 'Aguardando fornecedor',
  RESOLVIDO: 'Resolvido', FECHADO: 'Fechado', CANCELADO: 'Cancelado'
};
let CI_PRIORIDADE_LABEL = { BAIXA: 'Baixa', MEDIA: 'Média', ALTA: 'Alta', CRITICA: 'Crítica' };
let _ciPrioridadesConfig = [];
let _ciStatusConfig = [];
const CI_ACAO_LABEL = {
  CRIADO: 'Criado', STATUS: 'Status alterado', RESPONSAVEL: 'Responsável alterado',
  PRIORIDADE: 'Prioridade alterada', CATEGORIA: 'Categoria alterada',
  COMENTARIO: 'Comentário', EDITADO: 'Editado'
};

function fmtDataHora(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleString('pt-BR');
}

function fmtMinutos(min) {
  if (min == null || isNaN(min)) return '-';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

// Indicador de SLA (verde/amarelo/vermelho/expirado) — calculado no cliente
// a partir do percentual de tempo decorrido até o prazo de conclusão.
function slaInfo(c) {
  if (['RESOLVIDO', 'FECHADO', 'CANCELADO'].includes(c.status)) {
    return { texto: 'Concluído', classe: 'bg-secondary' };
  }
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

async function carregarCategoriasIntecs() {
  _ciCategorias = await api('GET', '/api/chamados-intecs/categorias');
  const itens = _ciCategorias.map((c) => ({ value: String(c.id), label: c.nome }));

  const instCategoria = choicesMap['ci_categoria'];
  if (instCategoria) {
    instCategoria.clearChoices();
    instCategoria.setChoices([{ value: '', label: 'Selecione...', placeholder: true }, ...itens], 'value', 'label', true);
  } else {
    $('ci_categoria').innerHTML = '<option value="">Selecione...</option>' + itens.map((i) => `<option value="${i.value}">${escapeHtml(i.label)}</option>`).join('');
  }
  const instFiltro = choicesMap['ciFiltroCategoria'];
  if (instFiltro) {
    instFiltro.clearChoices();
    instFiltro.setChoices([{ value: '', label: 'Categoria (todas)' }, ...itens], 'value', 'label', true);
  } else {
    $('ciFiltroCategoria').innerHTML = '<option value="">Categoria (todas)</option>' + itens.map((i) => `<option value="${i.value}">${escapeHtml(i.label)}</option>`).join('');
  }
}

function popularSubcategoriasSelect(selectId, categoriaId, selecionadoId) {
  const cat = _ciCategorias.find((c) => String(c.id) === String(categoriaId));
  const subs = cat ? cat.subcategorias : [];
  const itens = subs.map((s) => ({ value: String(s.id), label: s.nome }));

  const inst = choicesMap[selectId];
  if (inst) {
    inst.clearChoices();
    inst.setChoices(
      itens.length ? [{ value: '', label: 'Selecione...', placeholder: true }, ...itens] : [{ value: '', label: 'Sem subcategorias', placeholder: true }],
      'value', 'label', true
    );
    if (selecionadoId != null) inst.setChoiceByValue(String(selecionadoId));
    return;
  }
  $(selectId).innerHTML = itens.length
    ? '<option value="">Selecione...</option>' + itens.map((i) => `<option value="${i.value}" ${i.value === String(selecionadoId) ? 'selected' : ''}>${escapeHtml(i.label)}</option>`).join('')
    : '<option value="">Sem subcategorias</option>';
}

async function carregarUsuariosIntecs() {
  if (!podeAtenderCI()) { _ciUsuarios = []; return; }
  try {
    _ciUsuarios = await api('GET', '/api/chamados-intecs/atendentes');
  } catch { _ciUsuarios = []; }
  const itens = _ciUsuarios.map((u) => ({ value: String(u.id), label: u.email }));
  const instFiltro = choicesMap['ciFiltroResponsavel'];
  if (instFiltro) {
    instFiltro.clearChoices();
    instFiltro.setChoices([{ value: '', label: 'Responsável (todos)' }, ...itens], 'value', 'label', true);
  } else {
    $('ciFiltroResponsavel').innerHTML = '<option value="">Responsável (todos)</option>' + itens.map((i) => `<option value="${i.value}">${escapeHtml(i.label)}</option>`).join('');
  }
  $('ciDetResponsavel').innerHTML = '<option value="">Ninguém</option>' + itens.map((i) => `<option value="${i.value}">${escapeHtml(i.label)}</option>`).join('');
}

// Prioridades/status configuráveis (Fase 5) — popula os selects que hoje
// tinham <option> fixos no HTML, e estende os rótulos amigáveis com
// qualquer nome customizado cadastrado no painel "Categorias".
async function carregarPrioridadesEStatusIntecs() {
  try {
    [_ciPrioridadesConfig, _ciStatusConfig] = await Promise.all([
      api('GET', '/api/chamados-intecs/prioridades'),
      api('GET', '/api/chamados-intecs/status-config')
    ]);
  } catch { return; }

  _ciPrioridadesConfig.forEach((p) => { if (!CI_PRIORIDADE_LABEL[p.nome]) CI_PRIORIDADE_LABEL[p.nome] = p.nome; });
  _ciStatusConfig.forEach((s) => { if (!CI_STATUS_LABEL[s.nome]) CI_STATUS_LABEL[s.nome] = s.nome; });

  const itensPrioridade = _ciPrioridadesConfig.map((p) => ({ value: p.nome, label: CI_PRIORIDADE_LABEL[p.nome] || p.nome }));
  const itensStatus = _ciStatusConfig.map((s) => ({ value: s.nome, label: CI_STATUS_LABEL[s.nome] || s.nome }));

  const setSelectPlano = (id, itens, comPlaceholder) => {
    $(id).innerHTML = (comPlaceholder ? `<option value="">${comPlaceholder}</option>` : '') +
      itens.map((i) => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`).join('');
  };
  const setSelectChoices = (id, itens, placeholderLabel) => {
    const inst = choicesMap[id];
    if (inst) {
      inst.clearChoices();
      inst.setChoices(
        placeholderLabel ? [{ value: '', label: placeholderLabel }, ...itens] : itens,
        'value', 'label', true
      );
    } else {
      setSelectPlano(id, itens, placeholderLabel);
    }
  };

  setSelectChoices('ci_prioridade', itensPrioridade, null);
  choicesMap['ci_prioridade']?.setChoiceByValue('MEDIA');
  setSelectChoices('ciFiltroPrioridade', itensPrioridade, 'Prioridade (todas)');
  setSelectChoices('ciFiltroStatus', itensStatus, 'Status (todos)');
  setSelectPlano('ciDetStatus', itensStatus, null);
  setSelectPlano('ciDetPrioridade', itensPrioridade, null);
}

async function carregarChamadosIntecs() {
  $('ciStatus').textContent = 'Carregando...';
  try {
    _chamadosIntecs = await api('GET', '/api/chamados-intecs');
    renderChamadosIntecs();
  } catch (err) {
    $('ciTbody').innerHTML = '<tr><td colspan="8" class="text-danger">Erro: ' + escapeHtml(err.message) + '</td></tr>';
    $('ciStatus').textContent = '';
  }
}

function renderChamadosIntecs() {
  const busca = trim($('ciBusca').value).toLowerCase();
  const fCategoria = $('ciFiltroCategoria').value;
  const fPrioridade = $('ciFiltroPrioridade').value;
  const fStatus = $('ciFiltroStatus').value;
  const fResponsavel = $('ciFiltroResponsavel').value;
  const fUnidade = trim($('ciFiltroUnidade').value).toLowerCase();
  const fDepartamento = trim($('ciFiltroDepartamento').value).toLowerCase();
  const fDataIni = $('ciFiltroDataInicial').value;
  const fDataFim = $('ciFiltroDataFinal').value;

  let rows = _chamadosIntecs.filter((c) => {
    if (busca) {
      // Lupa: procura em qualquer coluna exibida na tabela (nº, título,
      // categoria, prioridade, status, responsável, data) sem acento/caixa.
      const hay = buscaNorm([
        c.id, c.titulo, c.categoria_nome,
        CI_PRIORIDADE_LABEL[c.prioridade] || c.prioridade,
        CI_STATUS_LABEL[c.status] || c.status,
        c.responsavel_email, fmtDataHora(c.criado_em),
        c.unidade, c.departamento
      ].join(' '));
      if (!hay.includes(buscaNorm(busca))) return false;
    }
    if (fCategoria && String(c.categoria_id) !== fCategoria) return false;
    if (fPrioridade && c.prioridade !== fPrioridade) return false;
    if (fStatus && c.status !== fStatus) return false;
    if (fResponsavel && String(c.responsavel_id) !== fResponsavel) return false;
    if (fUnidade && !(c.unidade || '').toLowerCase().includes(fUnidade)) return false;
    if (fDepartamento && !(c.departamento || '').toLowerCase().includes(fDepartamento)) return false;
    if (fDataIni && new Date(c.criado_em) < new Date(fDataIni)) return false;
    if (fDataFim && new Date(c.criado_em) > new Date(fDataFim + 'T23:59:59')) return false;
    return true;
  });

  const { col, dir } = _ciSort;
  rows = rows.slice().sort((a, b) => {
    const va = a[col] ?? '';
    const vb = b[col] ?? '';
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : (va > vb ? 1 : va < vb ? -1 : 0);
    return dir === 'asc' ? cmp : -cmp;
  });

  const tbody = $('ciTbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-muted text-center py-3">Nenhum chamado encontrado.</td></tr>';
  } else {
    tbody.innerHTML = rows.map((c) => {
      const sla = slaInfo(c);
      return `
      <tr data-ci-id="${c.id}" style="cursor:pointer">
        <td>${c.id}</td>
        <td>${escapeHtml(c.titulo)}</td>
        <td>${escapeHtml(c.categoria_nome || '-')}</td>
        <td>${escapeHtml(CI_PRIORIDADE_LABEL[c.prioridade] || c.prioridade || '-')}</td>
        <td>${escapeHtml(CI_STATUS_LABEL[c.status] || c.status || '-')}</td>
        <td><span class="badge ${sla.classe}">${sla.texto}</span></td>
        <td>${escapeHtml(c.responsavel_email || '-')}</td>
        <td>${fmtDataHora(c.criado_em)}</td>
        <td>${podeAtenderCI() && c.responsavel_id !== _ciPerfil.id
          ? `<button type="button" class="btn btn-sm btn-outline-primary btn-pegar-chamado" data-ci-id="${c.id}" data-ci-titulo="${escapeHtml(c.titulo)}"><i class="ph ph-hand-palm"></i> Atribuir</button>`
          : ''}</td>
      </tr>
    `;
    }).join('');
  }
  $('ciStatus').textContent = `${rows.length} de ${_chamadosIntecs.length} chamado(s).`;
  // Funil aceso quando qualquer filtro (busca, selects, unidade/depto, datas) está ativo.
  $('btnLimparFiltrosIntecs').classList.toggle('filtro-on',
    !!(busca || fCategoria || fPrioridade || fStatus || fResponsavel || fUnidade || fDepartamento || fDataIni || fDataFim));
}

function configurarFiltrosChamadosIntecs() {
  ['ciBusca', 'ciFiltroCategoria', 'ciFiltroPrioridade', 'ciFiltroStatus', 'ciFiltroResponsavel',
    'ciFiltroUnidade', 'ciFiltroDepartamento', 'ciFiltroDataInicial', 'ciFiltroDataFinal'].forEach((id) => {
    $(id).addEventListener('input', renderChamadosIntecs);
    $(id).addEventListener('change', renderChamadosIntecs);
  });
  $('btnLimparFiltrosIntecs').addEventListener('click', () => {
    ['ciBusca', 'ciFiltroUnidade', 'ciFiltroDepartamento', 'ciFiltroDataInicial', 'ciFiltroDataFinal'].forEach((id) => { $(id).value = ''; });
    ['ciFiltroCategoria', 'ciFiltroPrioridade', 'ciFiltroStatus', 'ciFiltroResponsavel'].forEach((id) => {
      const inst = choicesMap[id];
      if (inst) inst.setChoiceByValue(''); else $(id).value = '';
    });
    renderChamadosIntecs();
  });
  $('btnRefreshChamadosIntecs').addEventListener('click', carregarChamadosIntecs);
  document.querySelectorAll('#tabelaChamadosIntecs th[data-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-sort');
      _ciSort = { col, dir: _ciSort.col === col && _ciSort.dir === 'asc' ? 'desc' : 'asc' };
      renderChamadosIntecs();
    });
  });
}

function renderCamposEquipamento(obj) {
  if (!obj || typeof obj !== 'object') return '<span class="text-muted">Sem dados.</span>';
  const linhas = Object.entries(obj).map(([k, v]) => {
    let valor;
    if (v == null || v === '') valor = '<span class="text-muted">-</span>';
    else if (Array.isArray(v) || typeof v === 'object') valor = '<pre class="mb-0 small">' + escapeHtml(JSON.stringify(v, null, 2)) + '</pre>';
    else valor = escapeHtml(String(v));
    return `<div class="row mb-1"><div class="col-5 text-muted small">${escapeHtml(k)}</div><div class="col-7">${valor}</div></div>`;
  });
  return linhas.join('') || '<span class="text-muted">Sem dados.</span>';
}

function renderDadosChamado(c) {
  const linhas = [
    ['Categoria', c.categoria_nome, c.subcategoria_nome ? `${c.categoria_nome || ''} / ${c.subcategoria_nome}` : c.categoria_nome],
    ['Unidade', c.unidade, c.unidade],
    ['Setor/Departamento', c.departamento, c.departamento],
    ['Localização', c.localizacao, c.localizacao],
    ['Telefone', c.telefone, c.telefone],
    ['Ramal', c.ramal, c.ramal],
    ['E-mail de contato', c.email_contato, c.email_contato],
    ['Aberto por', c.criado_por, c.criado_por],
    ['Aberto em', c.criado_em, fmtDataHora(c.criado_em)]
  ].filter(([, raw]) => raw != null && raw !== '');

  const camposHtml = linhas.map(([label, , valor]) =>
    `<div class="col-6 col-md-4"><div class="small text-muted">${escapeHtml(label)}</div><div>${escapeHtml(String(valor))}</div></div>`
  ).join('');

  $('ciDetDadosChamado').innerHTML = `
    <div class="mb-2">
      <div class="small text-muted">Descrição do chamado</div>
      <div class="border rounded p-2 bg-light">${c.descricao ? escapeHtml(c.descricao).replace(/\n/g, '<br>') : '<span class="text-muted">Sem descrição.</span>'}</div>
    </div>
    <div class="row g-2 mb-2">${camposHtml}</div>
  `;
}

function renderComentarios(lista) {
  $('ciComentariosLista').innerHTML = lista.length
    ? lista.map((co) => `
      <div class="border-bottom pb-2 mb-2">
        <div class="small text-muted">${escapeHtml(co.usuario_email || '')} · ${fmtDataHora(co.criado_em)}</div>
        <div>${escapeHtml(co.texto)}</div>
      </div>`).join('')
    : '<span class="text-muted">Nenhum comentário ainda.</span>';
}

function renderHistorico(lista) {
  $('ciHistoricoLista').innerHTML = lista.length
    ? '<ul class="list-unstyled mb-0">' + lista.map((h) => `
      <li class="border-bottom pb-2 mb-2">
        <div class="small text-muted">${fmtDataHora(h.criado_em)} · ${escapeHtml(h.usuario_email || 'sistema')}</div>
        <div>${escapeHtml(CI_ACAO_LABEL[h.acao] || h.acao)}${h.valor_novo ? ': ' + escapeHtml(String(h.valor_novo)) : ''}</div>
      </li>`).join('') + '</ul>'
    : '<span class="text-muted">Sem histórico.</span>';
}

async function abrirChamadoIntecsDetalhe(id) {
  _chamadoIntecsAtual = id;
  $('ciDetalheTitle').textContent = 'Carregando...';
  ['ci-eq-resumo', 'ci-eq-hardware', 'ci-eq-rede', 'ci-eq-seguranca'].forEach((elId) => {
    $(elId).innerHTML = '<span class="text-muted">Carregando...</span>';
  });
  $('ciComentariosLista').innerHTML = '';
  $('ciHistoricoLista').innerHTML = '';
  modalChamadoIntecsDetalhe.show();

  try {
    const data = await api('GET', '/api/chamados-intecs/' + encodeURIComponent(id));
    $('ciDetalheTitle').textContent = `#${data.id} — ${data.titulo}`;
    $('ciDetStatus').value = data.status;
    $('ciDetPrioridade').value = data.prioridade;
    $('ciDetResponsavel').value = data.responsavel_id || '';
    const sla = slaInfo(data);
    $('ciDetSlaBadge').innerHTML = `<span class="badge ${sla.classe}">${sla.texto}</span> <span class="text-muted">até ${fmtDataHora(data.sla_conclusao_prazo)}</span>`;
    renderDadosChamado(data);
    renderComentarios(data.comentarios || []);
    renderHistorico(data.historico || []);
    aplicarPermissoesDetalheChamado(data);
  } catch (err) {
    $('ciDetalheTitle').textContent = 'Erro ao carregar chamado';
  }

  await carregarEquipamentoDoChamado(id);
}

async function carregarEquipamentoDoChamado(id) {
  try {
    const resumo = await api('GET', '/api/chamados-intecs/' + encodeURIComponent(id) + '/equipamento');
    if (!resumo) {
      const msg = '<span class="text-muted">Nenhum equipamento vinculado a este chamado.</span>';
      ['ci-eq-resumo', 'ci-eq-hardware', 'ci-eq-rede', 'ci-eq-seguranca'].forEach((elId) => { $(elId).innerHTML = msg; });
      return;
    }
    $('ci-eq-resumo').innerHTML = renderCamposEquipamento({
      status: resumo.status_online ? 'Online' : 'Offline',
      'CPU (%)': resumo.cpu_pct, 'RAM (%)': resumo.ram_pct, 'Uptime (seg)': resumo.uptime_seg,
      'Coletado em': fmtDataHora(resumo.coletado_em)
    });
    $('ci-eq-hardware').innerHTML = renderCamposEquipamento({ ...resumo.hardware_info, ...resumo.os_info });
    $('ci-eq-rede').innerHTML = renderCamposEquipamento(resumo.rede_info);
    $('ci-eq-seguranca').innerHTML = renderCamposEquipamento(resumo.seguranca_info);
  } catch (err) {
    const msg = '<span class="text-danger">Erro: ' + escapeHtml(err.message) + '</span>';
    ['ci-eq-resumo', 'ci-eq-hardware', 'ci-eq-rede', 'ci-eq-seguranca'].forEach((elId) => { $(elId).innerHTML = msg; });
  }
}

async function atualizarCampoChamadoIntecs(campo, valor) {
  if (!_chamadoIntecsAtual) return;
  try {
    await api('PATCH', '/api/chamados-intecs/' + encodeURIComponent(_chamadoIntecsAtual), { [campo]: valor });
    await abrirChamadoIntecsDetalhe(_chamadoIntecsAtual);
    await carregarChamadosIntecs();
  } catch (err) {
    alert('Erro ao atualizar: ' + err.message);
  }
}

function configurarChamadosIntecs() {
  $('btnNovoChamadoIntecs').addEventListener('click', async () => {
    $('formNovoChamadoIntecs').reset();
    $('formNovoChamadoIntecs').classList.remove('was-validated');
    $('alertNovoChamadoIntecs').innerHTML = '';
    choicesMap['ci_categoria']?.setChoiceByValue('');
    const instSub = choicesMap['ci_subcategoria'];
    if (instSub) {
      instSub.clearChoices();
      instSub.setChoices([{ value: '', label: 'Selecione a categoria antes...', placeholder: true }], 'value', 'label', true);
    } else {
      $('ci_subcategoria').innerHTML = '<option value="">Selecione a categoria antes...</option>';
    }
    choicesMap['ci_prioridade']?.setChoiceByValue('MEDIA');
    _ciMaquinaDetectadaId = null;
    $('ciMaquinaDetectada').textContent = '';
    $('ciMaquinaSelectWrap').style.display = 'none';

    if (!OPTIONS.UNIDADE || !OPTIONS.UNIDADE.length) { try { await loadOptions(); } catch { /* ignora */ } }
    fillSelect('ci_unidade', activeValues('UNIDADE'), _ciPerfil?.unidade || '');
    fillSelect('ci_departamento', activeValues('SETOR'), _ciPerfil?.setor || '');

    modalNovoChamadoIntecs.show();
    verificarMaquinaAutomatico();
  });

  $('ci_categoria').addEventListener('change', () => {
    popularSubcategoriasSelect('ci_subcategoria', $('ci_categoria').value, null);
  });

  $('btnAbrirChamadoIntecs').addEventListener('click', async () => {
    const titulo = trim($('ci_titulo').value);
    const form = $('formNovoChamadoIntecs');
    if (!titulo) { form.classList.add('was-validated'); return; }

    const btn = $('btnAbrirChamadoIntecs');
    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner"></i> Abrindo...';
    $('alertNovoChamadoIntecs').innerHTML = '';
    try {
      await api('POST', '/api/chamados-intecs', {
        titulo,
        categoria_id: $('ci_categoria').value || null,
        subcategoria_id: $('ci_subcategoria').value || null,
        prioridade: $('ci_prioridade').value,
        unidade: trim($('ci_unidade').value),
        departamento: trim($('ci_departamento').value),
        localizacao: trim($('ci_localizacao').value),
        telefone: trim($('ci_telefone').value),
        ramal: trim($('ci_ramal').value),
        email_contato: trim($('ci_email_contato').value),
        descricao: trim($('ci_descricao').value),
        tactical_agent_id: _ciMaquinaDetectadaId || null
      });
      modalNovoChamadoIntecs.hide();
      await carregarChamadosIntecs();
    } catch (err) {
      $('alertNovoChamadoIntecs').innerHTML =
        '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ph ph-headset"></i> Abrir Chamado';
    }
  });

  $('ciTbody').addEventListener('click', async (ev) => {
    const btnPegar = ev.target.closest('.btn-pegar-chamado');
    if (btnPegar) {
      ev.stopPropagation();
      const id = btnPegar.getAttribute('data-ci-id');
      const titulo = btnPegar.getAttribute('data-ci-titulo');
      const ok = await uiConfirm('Atribuir o chamado "' + titulo + '" a você?', { title: 'Atribuir chamado', okText: 'Atribuir', danger: false });
      if (!ok) return;
      btnPegar.disabled = true;
      try {
        await api('PATCH', '/api/chamados-intecs/' + id, { responsavel_id: _ciPerfil.id });
        await carregarChamadosIntecs();
      } catch (err) {
        alert('Erro ao atribuir: ' + err.message);
        btnPegar.disabled = false;
      }
      return;
    }
    const row = ev.target.closest('tr[data-ci-id]');
    if (!row) return;
    abrirChamadoIntecsDetalhe(row.getAttribute('data-ci-id'));
  });

  $('ciDetStatus').addEventListener('change', () => atualizarCampoChamadoIntecs('status', $('ciDetStatus').value));
  $('ciDetPrioridade').addEventListener('change', () => atualizarCampoChamadoIntecs('prioridade', $('ciDetPrioridade').value));
  $('ciDetResponsavel').addEventListener('change', () => atualizarCampoChamadoIntecs('responsavel_id', $('ciDetResponsavel').value || null));
  $('btnAtribuirAMim').addEventListener('click', () => atualizarCampoChamadoIntecs('responsavel_id', _ciPerfil.id));

  $('btnEnviarComentarioIntecs').addEventListener('click', async () => {
    if (!_chamadoIntecsAtual) return;
    const texto = trim($('ciNovoComentario').value);
    if (!texto) return;
    const btn = $('btnEnviarComentarioIntecs');
    btn.disabled = true;
    try {
      await api('POST', '/api/chamados-intecs/' + encodeURIComponent(_chamadoIntecsAtual) + '/comentarios', { texto });
      $('ciNovoComentario').value = '';
      await abrirChamadoIntecsDetalhe(_chamadoIntecsAtual);
    } catch (err) {
      alert('Erro ao comentar: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('btnAtualizarEquipamentoIntecs').addEventListener('click', async () => {
    if (!_chamadoIntecsAtual) return;
    const btn = $('btnAtualizarEquipamentoIntecs');
    btn.disabled = true;
    try {
      await api('POST', '/api/chamados-intecs/' + encodeURIComponent(_chamadoIntecsAtual) + '/equipamento/atualizar');
      await carregarEquipamentoDoChamado(_chamadoIntecsAtual);
    } catch (err) {
      $('ci-eq-resumo').innerHTML = '<span class="text-danger">Erro ao atualizar: ' + escapeHtml(err.message) + '</span>';
    } finally {
      btn.disabled = false;
    }
  });
}

function renderBarChart(canvasId, labels, data, cor) {
  if (_ciCharts[canvasId]) _ciCharts[canvasId].destroy();
  const canvas = $(canvasId);
  if (!canvas) return;
  _ciCharts[canvasId] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: cor, borderRadius: 6, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

async function carregarDashboardIntecs() {
  try {
    const d = await api('GET', '/api/chamados-intecs/dashboard');
    $('ciDashAbertos').textContent = d.abertos ?? 0;
    $('ciDashAndamento').textContent = d.em_andamento ?? 0;
    $('ciDashResolvidosHoje').textContent = d.resolvidos_hoje ?? 0;
    $('ciDashFechados').textContent = d.fechados ?? 0;
    $('ciDashVencidos').textContent = d.vencidos ?? 0;
    $('ciDashProxVenc').textContent = d.sla_proximos_vencimento ?? 0;
    $('ciDashTempoAtend').textContent = fmtMinutos(d.tempo_medio_atendimento_min);
    $('ciDashTempoResol').textContent = fmtMinutos(d.tempo_medio_resolucao_min);

    renderBarChart('ciChartCategoria', d.por_categoria.map(r => r.categoria), d.por_categoria.map(r => r.total), '#4f7cf5');
    renderBarChart('ciChartPrioridade', d.por_prioridade.map(r => CI_PRIORIDADE_LABEL[r.prioridade] || r.prioridade), d.por_prioridade.map(r => r.total), '#ff8c42');
    renderBarChart('ciChartStatus', d.por_status.map(r => CI_STATUS_LABEL[r.status] || r.status), d.por_status.map(r => r.total), '#16a34a');
    renderBarChart('ciChartMes', d.por_mes.map(r => r.mes), d.por_mes.map(r => r.total), '#a259ff');
    renderBarChart('ciChartUnidade', d.por_unidade.map(r => r.unidade), d.por_unidade.map(r => r.total), '#0891b2');
  } catch (err) {
    console.error('[dashboard intecs] erro:', err.message);
  }
}

function mostrarViewDashboardIntecs() {
  $('ciDashboardPainel').style.display = '';
  $('ciChamadosView').style.display = 'none';
  $('btnDashboardIntecs').classList.replace('btn-outline-secondary', 'btn-dark');
  $('btnChamadosIntecsView').classList.replace('btn-dark', 'btn-outline-secondary');
}

function mostrarViewChamadosIntecs() {
  $('ciDashboardPainel').style.display = 'none';
  $('ciChamadosView').style.display = '';
  $('btnChamadosIntecsView').classList.replace('btn-outline-secondary', 'btn-dark');
  $('btnDashboardIntecs').classList.replace('btn-dark', 'btn-outline-secondary');
}

function configurarDashboardIntecs() {
  $('btnDashboardIntecs').addEventListener('click', async () => {
    mostrarViewDashboardIntecs();
    await carregarDashboardIntecs();
  });
  $('btnChamadosIntecsView').addEventListener('click', () => {
    mostrarViewChamadosIntecs();
  });
}

// ============================================================
//  Categorias / Prioridades / Status configuráveis — Fase 5
// ============================================================
const TIPO_SISTEMA_LABEL = {
  ABERTO: 'Aberto', ANDAMENTO: 'Em andamento', RESOLVIDO: 'Resolvido',
  FECHADO: 'Fechado', CANCELADO: 'Cancelado'
};

async function carregarCategoriasPainel() {
  const [categorias, prioridades, statusList] = await Promise.all([
    api('GET', '/api/chamados-intecs/categorias'),
    api('GET', '/api/chamados-intecs/prioridades'),
    api('GET', '/api/chamados-intecs/status-config')
  ]);

  $('catTbody').innerHTML = categorias.map((c) => `
    <tr data-cat-id="${c.id}">
      <td>${escapeHtml(c.nome)}</td>
      <td class="small text-muted">${c.subcategorias.map((s) => escapeHtml(s.nome)).join(', ') || '-'}</td>
      <td><button type="button" class="btn btn-sm btn-outline-danger btn-remover-categoria"><i class="ph ph-trash"></i></button></td>
    </tr>
  `).join('');
  $('subcatCategoria').innerHTML = '<option value="">Categoria...</option>' +
    categorias.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('');

  $('prTbody').innerHTML = prioridades.map((p) => `
    <tr data-pr-id="${p.id}">
      <td>${escapeHtml(p.nome)}</td>
      <td><input type="number" step="0.5" min="0" class="form-control form-control-sm pr-resposta" value="${p.sla_resposta_horas}" style="max-width:90px"></td>
      <td><input type="number" step="0.5" min="0" class="form-control form-control-sm pr-conclusao" value="${p.sla_conclusao_horas}" style="max-width:90px"></td>
      <td><button type="button" class="btn btn-sm btn-outline-primary btn-salvar-prioridade">Salvar</button></td>
      <td><button type="button" class="btn btn-sm btn-outline-danger btn-remover-prioridade"><i class="ph ph-trash"></i></button></td>
    </tr>
  `).join('');

  $('stTbody').innerHTML = statusList.map((s) => `
    <tr data-st-id="${s.id}">
      <td>${escapeHtml(s.nome)}</td>
      <td class="small text-muted">${escapeHtml(TIPO_SISTEMA_LABEL[s.tipo_sistema] || s.tipo_sistema)}</td>
      <td><button type="button" class="btn btn-sm btn-outline-danger btn-remover-status"><i class="ph ph-trash"></i></button></td>
    </tr>
  `).join('');
}

function configurarCategoriasIntecs() {

  $('btnAdicionarCategoria').addEventListener('click', async () => {
    const nome = trim($('catNovoNome').value);
    if (!nome) return;
    try {
      await api('POST', '/api/chamados-intecs/categorias', { nome });
      $('catNovoNome').value = '';
      await carregarCategoriasPainel();
      await carregarCategoriasIntecs();
    } catch (err) {
      $('alertCategoriasIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    }
  });

  $('catTbody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.btn-remover-categoria');
    if (!btn) return;
    try {
      await api('DELETE', '/api/chamados-intecs/categorias/' + btn.closest('tr[data-cat-id]').getAttribute('data-cat-id'));
      await carregarCategoriasPainel();
      await carregarCategoriasIntecs();
    } catch (err) {
      $('alertCategoriasIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    }
  });

  $('btnAdicionarSubcategoria').addEventListener('click', async () => {
    const categoriaId = $('subcatCategoria').value;
    const nome = trim($('subcatNovoNome').value);
    if (!categoriaId || !nome) return;
    try {
      await api('POST', '/api/chamados-intecs/subcategorias', { categoria_id: categoriaId, nome });
      $('subcatNovoNome').value = '';
      await carregarCategoriasPainel();
    } catch (err) {
      $('alertCategoriasIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    }
  });

  $('btnAdicionarPrioridade').addEventListener('click', async () => {
    const nome = trim($('prNovoNome').value);
    const resposta = $('prNovaResposta').value;
    const conclusao = $('prNovaConclusao').value;
    if (!nome || !resposta || !conclusao) {
      $('alertPrioridadesIntecs').innerHTML = '<div class="alert alert-warning py-2 mb-0">Informe nome e as duas horas de SLA.</div>';
      return;
    }
    try {
      await api('POST', '/api/chamados-intecs/prioridades', { nome, sla_resposta_horas: resposta, sla_conclusao_horas: conclusao });
      $('prNovoNome').value = ''; $('prNovaResposta').value = ''; $('prNovaConclusao').value = '';
      $('alertPrioridadesIntecs').innerHTML = '';
      await carregarCategoriasPainel();
      await carregarPrioridadesEStatusIntecs();
    } catch (err) {
      $('alertPrioridadesIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    }
  });

  $('prTbody').addEventListener('click', async (ev) => {
    const btnSalvar = ev.target.closest('.btn-salvar-prioridade');
    const btnRemover = ev.target.closest('.btn-remover-prioridade');
    if (btnSalvar) {
      const tr = btnSalvar.closest('tr[data-pr-id]');
      try {
        await api('PUT', '/api/chamados-intecs/prioridades/' + tr.getAttribute('data-pr-id'), {
          sla_resposta_horas: tr.querySelector('.pr-resposta').value,
          sla_conclusao_horas: tr.querySelector('.pr-conclusao').value
        });
      } catch (err) {
        $('alertPrioridadesIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
      }
    } else if (btnRemover) {
      try {
        await api('DELETE', '/api/chamados-intecs/prioridades/' + btnRemover.closest('tr[data-pr-id]').getAttribute('data-pr-id'));
        await carregarCategoriasPainel();
        await carregarPrioridadesEStatusIntecs();
      } catch (err) {
        $('alertPrioridadesIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
      }
    }
  });

  $('btnAdicionarStatus').addEventListener('click', async () => {
    const nome = trim($('stNovoNome').value);
    const tipo = $('stNovoTipo').value;
    if (!nome) return;
    try {
      await api('POST', '/api/chamados-intecs/status-config', { nome, tipo_sistema: tipo });
      $('stNovoNome').value = '';
      await carregarCategoriasPainel();
      await carregarPrioridadesEStatusIntecs();
    } catch (err) {
      $('alertStatusIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    }
  });

  $('stTbody').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.btn-remover-status');
    if (!btn) return;
    try {
      await api('DELETE', '/api/chamados-intecs/status-config/' + btn.closest('tr[data-st-id]').getAttribute('data-st-id'));
      await carregarCategoriasPainel();
      await carregarPrioridadesEStatusIntecs();
    } catch (err) {
      $('alertStatusIntecs').innerHTML = '<div class="alert alert-danger py-2 mb-0">' + escapeHtml(err.message) + '</div>';
    }
  });
}

// ============================================================
//  Detecção de máquina por IP ("Verificar Máquina") — Fase 3
// ============================================================
let _ciMaquinaDetectadaId = null;

async function verificarMaquinaAutomatico() {
  _ciMaquinaDetectadaId = null;
  $('ciMaquinaSelectWrap').style.display = 'none';
  $('ciMaquinaDetectada').innerHTML = '<i class="ph ph-spinner"></i> Detectando máquina...';
  try {
    const { matches } = await api('POST', '/api/chamados-intecs/verificar-maquina');
    if (matches.length === 1) {
      _ciMaquinaDetectadaId = matches[0].tactical_agent_id;
      $('ciMaquinaDetectada').textContent = 'Máquina detectada: ' + (matches[0].hostname || matches[0].tactical_agent_id);
    } else if (matches.length > 1) {
      $('ciMaquinaDetectada').textContent = 'Mais de uma máquina encontrada nessa rede — selecione a sua:';
      const itens = matches.map((a) => ({ value: a.tactical_agent_id, label: a.hostname || a.tactical_agent_id }));
      const inst = choicesMap['ciMaquinaSelect'];
      if (inst) {
        inst.clearChoices();
        inst.setChoices(itens, 'value', 'label', true);
      } else {
        $('ciMaquinaSelect').innerHTML = itens.map((i) => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`).join('');
      }
      $('ciMaquinaSelectWrap').style.display = '';
      _ciMaquinaDetectadaId = matches[0].tactical_agent_id;
    } else {
      $('ciMaquinaDetectada').textContent = 'Não foi possível detectar automaticamente — o chamado será aberto sem equipamento.';
    }
  } catch (err) {
    $('ciMaquinaDetectada').textContent = 'Erro ao verificar: ' + err.message;
  }
}

function configurarVerificarMaquina() {
  $('ciMaquinaSelect').addEventListener('change', () => {
    _ciMaquinaDetectadaId = $('ciMaquinaSelect').value;
  });
}

// ============================================================
//  Perfil/papéis do usuário no módulo Chamados Intecs — Fase 3
// ============================================================
let _ciPerfil = null;

async function carregarMeuPerfilCI() {
  _ciPerfil = await api('GET', '/api/chamados-intecs/meu-perfil');
  const podeDashboard = ['GESTOR', 'TECNICO', 'MASTER'].includes(_ciPerfil.role);
  $('btnDashboardIntecs').style.display = podeDashboard ? '' : 'none';
  $('btnChamadosIntecsView').style.display = '';
}

function podeAtenderCI() {
  return !!_ciPerfil && ['TECNICO', 'MASTER'].includes(_ciPerfil.role);
}

function aplicarPermissoesDetalheChamado(chamado) {
  const podeAtender = podeAtenderCI();
  const podeComentar = podeAtender || chamado.usuario_id === _ciPerfil.id;
  ['ciDetStatus', 'ciDetPrioridade', 'ciDetResponsavel'].forEach((id) => { $(id).disabled = !podeAtender; });
  $('btnAtualizarEquipamentoIntecs').style.display = podeAtender ? '' : 'none';
  $('ciNovoComentario').closest('.d-flex').style.display = podeComentar ? '' : 'none';
  const btnAtribuir = $('btnAtribuirAMim');
  btnAtribuir.style.display = podeAtender ? '' : 'none';
  btnAtribuir.disabled = chamado.responsavel_id === _ciPerfil.id;
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

// ---------- Notificações (sininho) ----------
const NOTIF_ICONES = { REGISTRO: 'ph-table', EMPRESTIMO: 'ph-hand-arrow-up', CHAMADO: 'ph-headset', TESTE: 'ph-flask' };

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// criado_em vem em UTC (SYSUTCDATETIME, formato "YYYY-MM-DD HH:MM:SS" sem 'Z').
function tempoRelativo(isoUtc) {
  if (!isoUtc) return '';
  const t = new Date(String(isoUtc).replace(' ', 'T') + 'Z');
  const seg = Math.floor((Date.now() - t.getTime()) / 1000);
  if (isNaN(seg)) return '';
  if (seg < 60) return 'agora';
  const min = Math.floor(seg / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} d`;
  return t.toLocaleDateString('pt-BR');
}

function renderNotificacoes({ itens = [], naoLidas = 0 } = {}) {
  const badge = $('notifBadge');
  if (badge) {
    badge.textContent = naoLidas > 99 ? '99+' : String(naoLidas);
    badge.style.display = naoLidas > 0 ? '' : 'none';
  }
  const lista = $('notifLista');
  if (!lista) return;
  if (!itens.length) {
    lista.innerHTML = '<div class="notif-vazio">Sem notificações.</div>';
    return;
  }
  lista.innerHTML = itens.map((n) => {
    const icone = NOTIF_ICONES[n.tipo] || 'ph-bell';
    const meta = [tempoRelativo(n.criadoEm), n.ator].filter(Boolean).join(' · ');
    return `<button type="button" class="notif-item ${n.lido ? '' : 'nao-lida'}" data-id="${n.id}" data-link="${escHtml(n.link || '')}">
      <div class="notif-titulo"><i class="ph ${icone}"></i>${escHtml(n.titulo)}</div>
      ${n.mensagem ? `<div class="notif-msg">${escHtml(n.mensagem)}</div>` : ''}
      <div class="notif-meta">${escHtml(meta)}</div>
    </button>`;
  }).join('');
}

async function carregarNotificacoes() {
  try {
    renderNotificacoes(await api('GET', '/api/notifications'));
  } catch (err) {
    console.error('Falha ao carregar notificações:', err);
  }
}

async function abrirNotificacao(id, link) {
  try { await api('PUT', `/api/notifications/${id}/read`, {}); } catch (e) { console.error(e); }
  const btn = $('btnNotificacoes');
  if (btn && window.bootstrap) bootstrap.Dropdown.getOrCreateInstance(btn).hide();
  if (link) {
    const abaEl = $(link);
    if (abaEl) bootstrap.Tab.getOrCreateInstance(abaEl).show();
  }
  carregarNotificacoes();
}

function initNotificacoes() {
  const lista = $('notifLista');
  if (lista) {
    lista.addEventListener('click', (e) => {
      const item = e.target.closest('.notif-item');
      if (item) abrirNotificacao(item.dataset.id, item.dataset.link);
    });
  }
  const btnMarcar = $('btnMarcarLidas');
  if (btnMarcar) {
    btnMarcar.addEventListener('click', async () => {
      try { await api('PUT', '/api/notifications/read-all', {}); carregarNotificacoes(); }
      catch (err) { console.error(err); }
    });
  }
}

async function entrarNoApp(email, restaurarAba = false) {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userEmail').textContent = email || '';
  carregarNotificacoes();
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
  invalidarCacheTodos(); // não herdar registros/facetas na próxima sessão da aba
  localStorage.removeItem('token');
  document.documentElement.classList.remove('sessao-ativa');
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  $('formAuth').reset();
  $('formAuth').classList.remove('was-validated');
  ocultarBioOpcao();
  prepararTelaLogin();
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
  buscaId: 'chamadosBusca',
  onApply: () => {
    // Ao usar o filtro de coluna, troca o status de cima para "Personalizado"
    // para não conflitar com o filtro da tabela.
    if (Object.keys(chamadosFilterCtx.filters).length) setSelectVal('chamadosFiltroStatus', 'custom');
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
    // Lupa: procura em qualquer coluna da tabela (valores como exibidos).
    if (busca && !buscaNorm(CHAMADOS_COLS.map((c, i) => chamadosColVal(r, i)).join(' ')).includes(buscaNorm(busca))) return false;
    if (!ctxPassa(chamadosFilterCtx, r)) return false;
    return true;
  });
  $('chamadosTbody').innerHTML = rows.map(r =>
    `<tr class="row-clicavel" data-ver-chave="${escapeHtml(String(r.Chave || ''))}" data-ver-codigo="${escapeHtml(r.Codigo || '')}" data-ver-st="${escapeHtml(r.St || '')}">${CHAMADOS_COLS.map(c => {
      if (c.key === 'St') return `<td>${imStatusBadge(c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? ''))}</td>`;
      return `<td>${escapeHtml(c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? ''))}</td>`;
    }).join('')}</tr>`
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
    $('chamadosThead').innerHTML = thFiltravel(CHAMADOS_COLS);

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
  { key: 'data_solicitacao',      label: 'DATA\nSOLICITACAO',      fmt: imDataBR },
  { key: 'unidade',               label: 'UNIDADE'               },
  { key: 'glpi',                  label: 'GLPI'                  },
  { key: 'patrimonio_msa',        label: 'PAT'                   },
  { key: 'ns',                    label: 'Nº SERIE'              },
  { key: 'ponto_instalacao',      label: 'PONTO DE\nINSTALAÇÃO'  },
  { key: 'descricao_equip',       label: 'EQUIPAMENTO'           },
  { key: 'patrimonio_bkp_intecs', label: 'PAT BKP'               },
  { key: 'bkp_unidade',           label: 'BKP\nUNIDADE'          },
  { key: 'status_intecs',         label: 'STATUS INTECS'         },
  { key: 'status_msa',            label: 'STATUS MSA'            },
  { key: 'numero_chamado_msa',    label: 'CHAMADO MSA'           },
  { key: 'data_retirada_equip',   label: 'DATA RETIRADA',          fmt: imDataBR },
  { key: 'data_entrega_equip',    label: 'DATA ENTREGA',           fmt: imDataBR },
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
  buscaId: 'imBusca',
  onApply: () => {
    if (Object.keys(intecsMsaFilterCtx.filters).length) setSelectVal('imFiltroStatus', 'custom');
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
      // Lupa: procura em qualquer coluna da tabela (valores como exibidos,
      // incluindo datas dd/mm/aaaa e os status derivados).
      const hay = buscaNorm(INTECSMSA_COLS.map((c, i) => intecsMsaColVal(r, i)).join(' '));
      if (!hay.includes(buscaNorm(busca))) return false;
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
    return `<tr class="row-clicavel" data-edit-im="${r.id}">${cells}</tr>`;
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
    $('imThead').innerHTML = thFiltravel(INTECSMSA_COLS);
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
    if (_suprimirChangeFiltro) return;
    // Mexer no filtro de cima sobrepõe o filtro de coluna do Status MSA.
    const i = INTECSMSA_COLS.findIndex((c) => c.key === 'status_msa');
    delete intecsMsaFilterCtx.filters[String(i)];
    renderIntecsMsa();
  });
  $('formIntecsMsa').addEventListener('submit', salvarIntecsMsa);
  $('imTbody').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-edit-im]');
    if (row) { abrirEdicaoIntecsMsa(row.getAttribute('data-edit-im')); }
  });
  $('im_patrimonio_msa').addEventListener('blur', lookupEquipIM);
  $('im_ns').addEventListener('blur', lookupEquipIM);
  $('im_bkp_pat').addEventListener('change', lookupBkpUnidade);
  $('im_data_retirada').addEventListener('change', atualizarStatusMsa);
  $('im_data_entrega').addEventListener('change', atualizarStatusMsa);
  wireCtxFiltro(intecsMsaFilterCtx, $('imThead'));
  $('btnLimparFiltrosIntecsMsa').addEventListener('click', () => {
    Object.keys(intecsMsaFilterCtx.filters).forEach((k) => delete intecsMsaFilterCtx.filters[k]);
    $('imBusca').value = '';
    if ($('imFiltroStatus').value === 'custom') setSelectVal('imFiltroStatus', 'aberto');
    renderIntecsMsa();
  });
}

/* =====================================================================
   Menu hambúrguer mobile — botão no canto superior esquerdo do
   cabeçalho abre a gaveta lateral com as abas (a barra de abas fica
   oculta no celular).
   ===================================================================== */
function configurarMenuMobile() {
  const painel = $('mobileMenu');
  if (!painel) return;
  const backdrop = $('mobileMenuBackdrop');
  const gatilho = $('btnMenuMobile');

  const sincronizarAtivo = () => {
    const ativo = document.querySelector('.app-tabs .nav-link.active');
    painel.querySelectorAll('.mm-item').forEach((b) => {
      b.classList.toggle('active', !!ativo && b.dataset.tab === ativo.id);
    });
  };
  const abrir = () => {
    sincronizarAtivo();
    painel.classList.add('show');
    backdrop.classList.add('show');
    document.body.classList.add('mm-open');
    gatilho.setAttribute('aria-expanded', 'true');
  };
  const fechar = () => {
    painel.classList.remove('show');
    backdrop.classList.remove('show');
    document.body.classList.remove('mm-open');
    gatilho.setAttribute('aria-expanded', 'false');
  };

  gatilho.addEventListener('click', abrir);
  $('btnFecharMenuMobile').addEventListener('click', fechar);
  backdrop.addEventListener('click', fechar);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && painel.classList.contains('show')) fechar();
  });

  painel.querySelectorAll('.mm-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      fechar();
      const alvo = $(btn.dataset.tab);
      if (alvo) bootstrap.Tab.getOrCreateInstance(alvo).show();
    });
  });
  document.querySelectorAll('.app-tabs .nav-link').forEach((btn) => {
    btn.addEventListener('shown.bs.tab', sincronizarAtivo);
  });
  // Voltando ao desktop, fecha a gaveta e reposiciona o slider da barra
  // de abas, que reaparece.
  window.matchMedia('(min-width: 768px)').addEventListener('change', (ev) => {
    if (!ev.matches) return;
    fechar();
    requestAnimationFrame(() => posicionarSlider(false));
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
  modalOpcao = new bootstrap.Modal($('modalOpcao'));
  modalEmprestimo = new bootstrap.Modal($('modalEmprestimo'));
  modalInternet = new bootstrap.Modal($('modalInternet'));
  modalNovoChamado = new bootstrap.Modal($('modalNovoChamado'));
  modalChamadoDetalhe = new bootstrap.Modal($('modalChamadoDetalhe'));
  modalIntecsMsa = new bootstrap.Modal($('modalIntecsMsa'));
  modalNovoChamadoIntecs = new bootstrap.Modal($('modalNovoChamadoIntecs'));
  modalChamadoIntecsDetalhe = new bootstrap.Modal($('modalChamadoIntecsDetalhe'));
  modalEditarUsuario = new bootstrap.Modal($('modalEditarUsuario'));
  modalNovoUsuario = new bootstrap.Modal($('modalNovoUsuario'));
  document.querySelectorAll('.modal').forEach(el => {
    el.addEventListener('hidePrevented.bs.modal', () => el.classList.remove('modal-static'));
  });
  initNotificacoes();
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
  $('askInput3').addEventListener('input', (ev) => { if (askInput3Mask === 'cnpj') ev.target.value = maskCNPJ(ev.target.value); });
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
  configurarModalEditarUsuario();
  configurarFormEmprestimo();
  configurarFormEditar();
  configurarFiltrosTabela();
  configurarDetalheChamado();
  configurarNovoChamado();
  configurarIntecsMsa();
  configurarChamadosIntecs();
  configurarFiltrosChamadosIntecs();
  configurarDashboardIntecs();
  configurarCategoriasIntecs();
  configurarVerificarMaquina();
  configurarMenuMobile();

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
  $('tab-registros').addEventListener('shown.bs.tab', () => {
    loadRecords(true);
    // Pré-carrega em background: facetas (KBs, abrem o funil na hora) e o dump
    // completo (para o OK do filtro), sem competir com a 1ª página da tabela.
    carregarFacetas().catch(() => {});
    setTimeout(carregarTodosParaFiltro, 800);
  });
  $('btnAtualizarLista').addEventListener('click', () => { recarregarRegistros(); });
  $('btnViewSimples').addEventListener('click', () => setRegistrosView('simples'));
  $('btnViewDetalhada').addEventListener('click', () => setRegistrosView('detalhada'));
  setRegistrosView(localStorage.getItem('registrosView') || 'simples');
  $('regBusca').addEventListener('input', aplicarFiltroRegistros);
  $('btnLimparFiltros').addEventListener('click', () => {
    Object.keys(colFilters).forEach((k) => delete colFilters[k]);
    $('regBusca').value = '';
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
  $('btnNovoEmprestimo').addEventListener('click', () => {
    $('alertEmprestimoModal').innerHTML = '';
    $('formEmprestimo').classList.remove('was-validated');
    loadEmprestimoForm().catch(() => {});
    modalEmprestimo.show();
  });
  $('tab-usuarios').addEventListener('shown.bs.tab', loadUsuarios);
  $('btnAtualizarUsuarios').addEventListener('click', loadUsuarios);
  $('tab-internet').addEventListener('shown.bs.tab', carregarInternet);
  $('btnAtualizarInternet').addEventListener('click', carregarInternet);
  $('btnNovoInternet').addEventListener('click', () => abrirInternet(null));
  $('btnExcluirInternet').addEventListener('click', excluirInternet);
  $('btnEditarInternet').addEventListener('click', () => setInternetModo(true));
  $('internet_unidade').addEventListener('change', (e) => aplicarUnidadeInternet(e.target.value));
  $('internet_telefone').addEventListener('input', (e) => { e.target.value = maskTelefone(e.target.value); });
  $('formInternet').addEventListener('submit', salvarInternet);
  $('corpoTabelaInternet').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) abrirInternet(tr.getAttribute('data-id'));
  });
  // Aba Chamados: sub-aba padrão é INTECS vs MSA; MSA (Eurosa) carrega ao abrir sua sub-aba.
  $('tab-chamados').addEventListener('shown.bs.tab', carregarIntecsMsa);
  $('sub-tab-intecsmsa').addEventListener('shown.bs.tab', carregarIntecsMsa);
  $('sub-tab-msa').addEventListener('shown.bs.tab', carregarChamados);
  $('sub-tab-intecs').addEventListener('shown.bs.tab', async () => {
    if (!_ciPerfil) await carregarMeuPerfilCI();
    if (!_ciCategorias.length) await carregarCategoriasIntecs();
    if (!_ciUsuarios.length) await carregarUsuariosIntecs();
    if (!_ciPrioridadesConfig.length) await carregarPrioridadesEStatusIntecs();
    carregarChamadosIntecs();
    if (_ciPerfil.role === 'BASICO') {
      mostrarViewChamadosIntecs();
    } else {
      mostrarViewDashboardIntecs();
      await carregarDashboardIntecs();
    }
  });
  $('btnRefreshChamados').addEventListener('click', carregarChamados);
  $('chamadosBusca').addEventListener('input', renderChamados);
  $('chamadosFiltroStatus').addEventListener('change', () => {
    if (_suprimirChangeFiltro) return;
    // Mexer no filtro de cima sobrepõe o filtro de coluna do Status.
    const i = CHAMADOS_COLS.findIndex((c) => c.key === 'St');
    delete chamadosFilterCtx.filters[String(i)];
    renderChamados();
  });
  // Lupa: busca em qualquer coluna, nas tabelas montadas no DOM. Registros e
  // as 3 tabelas de chamados filtram nos dados (renderTabela/render*).
  wireBuscaTabela('empBusca', 'listaEmprestimos', 'btnLimparFiltrosEmprestimos');
  wireBuscaTabela('opcoesBusca', 'listaOpcoes', 'btnLimparFiltrosOpcoes',
    () => Object.keys(opcoesFilterCtx.filters).length > 0);
  wireBuscaTabela('catBusca', 'catTbody');
  wireBuscaTabela('prBusca', 'prTbody');
  wireBuscaTabela('stBusca', 'stTbody');
  wireBuscaTabela('usuariosBusca', 'listaUsuarios', 'btnLimparFiltrosUsuarios');
  wireBuscaTabela('internetBusca', 'corpoTabelaInternet', 'btnLimparFiltrosInternet');
  wireBuscaTabela('logBusca', 'logCorpo', 'btnLimparFiltrosLog');

  // Botões de limpar filtro (funil-x) ao lado de cada lupa.
  const limparBusca = (id) => {
    const el = $(id);
    if (!el.value) return;
    el.value = '';
    el.dispatchEvent(new Event('input'));
  };
  $('btnLimparFiltrosEmprestimos').addEventListener('click', () => limparBusca('empBusca'));
  $('btnLimparFiltrosUsuarios').addEventListener('click', () => limparBusca('usuariosBusca'));
  $('btnLimparFiltrosInternet').addEventListener('click', () => limparBusca('internetBusca'));
  $('btnLimparFiltrosLog').addEventListener('click', () => limparBusca('logBusca'));
  $('btnLimparFiltrosOpcoes').addEventListener('click', () => {
    Object.keys(opcoesFilterCtx.filters).forEach((k) => delete opcoesFilterCtx.filters[k]);
    limparBusca('opcoesBusca');
    renderListaOpcoes();
  });
  $('btnAtualizarOpcoes').addEventListener('click', () => {
    loadOptions().catch((err) => showAlert('alertGerenciar', 'danger', 'Erro ao atualizar: ' + err.message));
  });

  wireCtxFiltro(chamadosFilterCtx, $('chamadosThead'));
  $('btnLimparFiltrosChamados').addEventListener('click', () => {
    Object.keys(chamadosFilterCtx.filters).forEach((k) => delete chamadosFilterCtx.filters[k]);
    $('chamadosBusca').value = '';
    if ($('chamadosFiltroStatus').value === 'custom') setSelectVal('chamadosFiltroStatus', 'aberto');
    renderChamados();
  });

  // Sessão persistida: valida o token salvo.
  if (TOKEN) {
    try {
      const me = await api('GET', '/api/auth/me');
      await entrarNoApp(me.email, true);
    } catch {
      sairDoApp();
      prepararTelaLogin();
    }
  } else {
    prepararTelaLogin();
  }
});

// ---------- Service Worker (PWA) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

/* ============================================================
   === LAYOUT OFICIAL: topbar fixo ===
   A classe layout-topbar-sticky é aplicada direto no #appView no
   index.html. Aqui apenas garantimos o reposicionamento do
   liquid-slider após o primeiro reflow.
   ============================================================ */
(function layoutOficial() {
  document.addEventListener('DOMContentLoaded', () => {
    // Limpa preferência de layout antiga do experimento, se existir.
    localStorage.removeItem('layoutExperimento');
    if (typeof posicionarSlider === 'function') {
      requestAnimationFrame(() => posicionarSlider(false));
    }
  });
})();
/* === FIM LAYOUT OFICIAL === */
