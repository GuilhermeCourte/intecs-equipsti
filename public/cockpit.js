// ============================================================
//  Cockpit — painel de parede da Gestão TI.
//
//  Reaproveita o mesmo token/login do app principal (localStorage 'token'),
//  igual chamados.js. Por ser página autônoma (sem bundler e sem módulos),
//  alguns helpers curtos aparecem aqui de novo — é a convenção que a página
//  de chamados já estabeleceu.
//
//  Três regras que valem para tudo aqui:
//  1. Nunca rolar e nunca abrir modal: é tela sem teclado nem mouse.
//  2. Bloco que falha mantém o último valor bom e troca o carimbo por
//     "às HH:MM". Um painel que apaga a informação ao primeiro soluço de rede
//     é pior que um painel com dado de 5 minutos atrás, desde que datado.
//  3. Bloco que devolve 403 some de vez: quem está logado não tem a aba de
//     origem daquele dado, e insistir só geraria erro a cada ciclo.
// ============================================================

const $ = (id) => document.getElementById(id);
const API = '';

let TOKEN = localStorage.getItem('token') || '';
let _sessaoMorta = false;

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Erro carrega o status para o chamador distinguir 401 (sessão) de 403
// (permissão) de 502 (integração externa fora do ar).
async function api(path) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || ('Erro ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

// criado_em/desde vêm em UTC no formato "YYYY-MM-DD HH:MM:SS" (sem 'Z').
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
  return `há ${Math.floor(h / 24)} d`;
}

const hhmm = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtMoeda = (v) => Number(v || 0).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0 });

const MESES_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Cópia da mesma regra que roda em app.js (renderEventosDoMes) e, com clamp de
// fim de mês, em server/index.js (proximaOcorrencia). Se a recorrência mudar,
// mudar nos três.
function proximaOcorrencia(evt) {
  const [ano, mes, dia] = evt.data.split('-').map(Number);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  if (evt.recorrencia === 'NENHUMA') return new Date(ano, mes - 1, dia);
  if (evt.recorrencia === 'ANUAL') {
    let d = new Date(hoje.getFullYear(), mes - 1, dia);
    if (d < hoje) d = new Date(hoje.getFullYear() + 1, mes - 1, dia);
    return d;
  }
  let d = new Date(hoje.getFullYear(), hoje.getMonth(), dia);
  if (d < hoje) d = new Date(hoje.getFullYear(), hoje.getMonth() + 1, dia);
  return d;
}

// ============================================================
//  Renderizadores
// ============================================================

const CX_ROTULO = { DOWN: 'offline', INSTAVEL: 'instável' };

function renderUnidades(r) {
  const comMonitor = (r.unidades || []).filter((u) => u.status !== 'SEM_MONITOR');
  const problema = comMonitor.filter((u) => u.status === 'DOWN' || u.status === 'INSTAVEL');
  const online = comMonitor.filter((u) => u.status === 'UP');

  $('blocoUnidades').classList.toggle('alerta', problema.length > 0);

  const html = [`<div class="cp-unid-num ${problema.length ? 'mal' : 'ok'}">
      ${online.length}<small>/ ${comMonitor.length} ONLINE</small>
    </div>`];

  if (problema.length) {
    html.push('<div class="cp-fora">' + problema.map((u) => `
      <div class="cp-fora-item ${u.status === 'INSTAVEL' ? 'instavel' : ''}">
        <i class="ph ${u.status === 'INSTAVEL' ? 'ph-warning-circle' : 'ph-x-circle'}"></i>
        ${escapeHtml(u.monitor || u.unidade)}
        <span class="cp-fora-quando">${CX_ROTULO[u.status]} ${escapeHtml(tempoRelativo(u.desde))}</span>
      </div>`).join('') + '</div>');
  }

  if (online.length) {
    html.push('<div class="cp-online">' + online.map((u) =>
      `<span><i class="cp-ponto"></i>${escapeHtml(u.monitor || u.unidade)}</span>`).join('') + '</div>');
  }
  $('cpUnidades').innerHTML = html.join('');
}

// Mesmos rótulos do VPS_ESTADO_LABEL em app.js — cockpit.js não importa
// nada de lá (painel autônomo, sem bundler), então duplica só o necessário.
const VPS_ESTADO_LABEL = {
  running: 'Online', stopped: 'Desligada', error: 'Erro', destroyed: 'Destruída', suspended: 'Suspensa',
  starting: 'Iniciando', stopping: 'Parando', creating: 'Criando', recreating: 'Recriando',
  restoring: 'Restaurando', recovery: 'Recuperação', stopping_recovery: 'Saindo da recuperação',
  initial: 'Inicial', suspending: 'Suspendendo', unsuspending: 'Reativando', destroying: 'Destruindo'
};

// Mostra só a VM principal (a maioria das contas tem uma só) — se houver
// problema em qualquer uma, o item vira vermelho e mostra o estado dela.
function renderVps(lista) {
  if (!lista || !lista.length) return;
  const problema = lista.find((vm) => vm.estadoCor !== 'ok');
  $('cpVpsItem').classList.toggle('alerta', !!problema);
  $('cpVpsEstado').textContent = problema
    ? (VPS_ESTADO_LABEL[problema.state] || problema.state || 'indisponível')
    : `${lista[0].cpu != null ? lista[0].cpu.toFixed(0) + '% CPU' : '—'} · ${lista[0].ramPercent != null ? lista[0].ramPercent.toFixed(0) + '% RAM' : '—'}`;
}

// Recebe os dois de uma vez porque dividem o mesmo bloco: cada um chega no seu
// ritmo (Intecs a cada minuto, MSA a cada 15) e o último valor bom do outro
// tem que continuar na tela.
let _ci = null, _msa = null;

function renderChamados() {
  const linhas = [];
  const nums = [];
  if (_ci) nums.push(`<div class="cp-num-bloco"><div class="cp-num">${_ci.abertos ?? 0}</div><div class="cp-num-rot">INTECS</div></div>`);
  if (_msa) nums.push(`<div class="cp-num-bloco"><div class="cp-num">${_msa.abertos}</div><div class="cp-num-rot">MSA</div></div>`);
  linhas.push(`<div class="cp-chamados">${nums.join('')}</div>`);

  if (_ci) {
    const tags = [];
    if (_ci.vencidos) tags.push(`<span class="cp-tag mal">${_ci.vencidos} vencido${_ci.vencidos > 1 ? 's' : ''}</span>`);
    if (_ci.sla_proximos_vencimento) tags.push(`<span class="cp-tag atencao">${_ci.sla_proximos_vencimento} vence em 2h</span>`);
    if (_ci.em_andamento) tags.push(`<span class="cp-tag">${_ci.em_andamento} em andamento</span>`);
    if (_ci.resolvidos_hoje) tags.push(`<span class="cp-tag">${_ci.resolvidos_hoje} resolvido${_ci.resolvidos_hoje > 1 ? 's' : ''} hoje</span>`);
    if (tags.length) linhas.push(`<div class="cp-chamados-det">${tags.join('')}</div>`);
  }
  $('cpChamados').innerHTML = linhas.join('');
}

const AVISO_ROTULO = {
  LOGIN_BLOQUEADO: 'Login bloqueado',
  SENHA_REVELADA: 'Senha revelada',
  SENHA_REDEFINIDA: 'Senha redefinida',
  CONEXAO: 'Conexão remota',
  SCRIPT_EXECUTADO: 'Script executado'
};

function renderAvisos(logs) {
  if (!logs.length) {
    $('cpAvisos').innerHTML = '<div class="cp-vazio"><i class="ph ph-shield-check"></i> Nada nos últimos 7 dias</div>';
    return;
  }
  $('cpAvisos').innerHTML = logs.map((l) => {
    // ATUALIZADO só chega aqui vindo do par (USUARIOS, campo PAPEL|PERMISSÕES).
    const rotulo = l.acao === 'ATUALIZADO'
      ? (l.campo === 'PAPEL' ? 'Papel alterado' : 'Permissões alteradas')
      : (AVISO_ROTULO[l.acao] || l.acao);
    const alerta = l.acao === 'LOGIN_BLOQUEADO';
    const sub = [l.usuario, l.valorNovo || l.campo].filter(Boolean).join(' · ');
    return `<div class="cp-li ${alerta ? 'alerta' : ''}">
      <span class="cp-li-quando">${hhmm(new Date(l.dataHora))}</span>
      <span class="cp-li-ico"><i class="ph ${alerta ? 'ph-warning' : 'ph-dot-outline'}"></i></span>
      <span class="cp-li-corpo">
        <div class="cp-li-tit">${escapeHtml(rotulo)}${l.entidadeRotulo ? ' · ' + escapeHtml(l.entidadeRotulo) : ''}</div>
        ${sub ? `<div class="cp-li-sub">${escapeHtml(sub)}</div>` : ''}
      </span>
    </div>`;
  }).join('');
}

function itemEvento(x, vencido) {
  const d = x.data;
  const rec = x.evt.recorrencia;
  const sub = [x.evt.tipo, rec === 'MENSAL' ? 'mensal' : (rec === 'ANUAL' ? 'anual' : null)]
    .filter(Boolean).join(' · ');
  return `<div class="cp-li">
    <span class="cp-li-quando">${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}</span>
    <span class="cp-dot-evt ${rec}"></span>
    <span class="cp-li-corpo">
      <div class="cp-li-tit">${escapeHtml(x.evt.titulo)}${vencido ? ' <span class="cp-badge-venc">VENCIDO</span>' : ''}</div>
      ${sub ? `<div class="cp-li-sub">${escapeHtml(sub)}</div>` : ''}
    </span>
    ${x.evt.valor ? `<span class="cp-li-val">${fmtMoeda(x.evt.valor)}</span>` : ''}
  </div>`;
}

// Ocorrência dentro de um mês específico (null se não cai nele), com clamp de
// fim de mês. Espelha ocorrenciaNoMes() do app.js — mudou lá, muda aqui.
function ocorrenciaNoMes(evt, ano, mes) {
  const [a, m, d] = evt.data.split('-').map(Number);
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();
  if (evt.recorrencia === 'MENSAL') return new Date(ano, mes, Math.min(d, ultimoDia));
  if (evt.recorrencia === 'ANUAL')  return (m - 1 === mes) ? new Date(ano, mes, Math.min(d, ultimoDia)) : null;
  return (a === ano && m - 1 === mes) ? new Date(ano, mes, d) : null;
}

let _eventos = [];
let _mesOffset = 0;
let _voltarMesTimer = null;

// Painel de parede: se alguém navegar e sair de perto, ele não pode ficar
// preso em dezembro. Volta sozinho ao mês corrente depois de 5 min.
function agendarVoltaAoMesCorrente() {
  clearTimeout(_voltarMesTimer);
  if (!_mesOffset) return;
  _voltarMesTimer = setTimeout(() => { _mesOffset = 0; desenharEventos(); }, 5 * 60_000);
}

function renderEventos(eventos) {
  _eventos = eventos;
  desenharEventos();   // preserva o mês em que a tela está entre os refreshes
}

function desenharEventos() {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const base = new Date(hoje.getFullYear(), hoje.getMonth() + _mesOffset, 1);
  const ano = base.getFullYear(), mes = base.getMonth();

  const doMes = _eventos
    .map((e) => ({ evt: e, data: ocorrenciaNoMes(e, ano, mes) }))
    .filter((x) => x.data)
    .sort((a, b) => a.data - b.data);

  const html = [];
  // Vencidos são pendências de hoje, não "eventos de agosto": só no mês
  // corrente e sob divisor próprio.
  if (!_mesOffset) {
    const vencidos = _eventos
      .filter((e) => e.recorrencia === 'NENHUMA')
      .map((e) => ({ evt: e, data: proximaOcorrencia(e) }))
      .filter((x) => x.data < hoje)
      .sort((a, b) => a.data - b.data);
    if (vencidos.length) {
      html.push('<div class="cp-divisor">VENCIDOS</div>');
      html.push(...vencidos.map((x) => itemEvento(x, true)));
      if (doMes.length) html.push(`<div class="cp-divisor">${MESES_PT[mes].toUpperCase()}</div>`);
    }
  }
  html.push(...doMes.map((x) => itemEvento(x, false)));

  $('cpEventosCarimbo').textContent = MESES_PT[mes] + (ano !== hoje.getFullYear() ? ' ' + ano : '');
  $('cpEventos').innerHTML = html.length
    ? html.join('')
    : `<div class="cp-vazio"><i class="ph ph-calendar-check"></i> Nenhum evento em ${MESES_PT[mes].toLowerCase()}</div>`;
  agendarVoltaAoMesCorrente();
}

function configurarNavEventos() {
  $('cpMesAnt').addEventListener('click', () => { _mesOffset--; desenharEventos(); });
  $('cpMesProx').addEventListener('click', () => { _mesOffset++; desenharEventos(); });
}

// ============================================================
//  Agendamento
// ============================================================

// Entre 06h e 21h. /api/chamados raspa o portal do eurosa (terceiro, sem
// contrato de rate limit); de madrugada ninguém olha o painel e um heartbeat
// 24/7 seria a parte mais visível do tráfego. Fora da janela o número
// congela com o carimbo da última busca.
const horarioComercial = () => { const h = new Date().getHours(); return h >= 6 && h < 21; };

const BLOCOS = [
  {
    id: 'blocoUnidades', carimbo: 'cpUnidCarimbo', ms: 60_000,
    rota: () => '/api/conexoes',
    render: (d) => renderUnidades(d)
  },
  {
    // 5 min = mesmo TTL do cache de métricas no backend (server/hostinger),
    // não adianta bater mais rápido que isso.
    id: 'cpVpsItem', ms: 5 * 60_000,
    rota: () => '/api/vps/resumo',
    render: (d) => renderVps(d)
  },
  {
    id: 'blocoChamados', carimbo: 'cpChamCarimbo', ms: 60_000,
    rota: () => '/api/chamados-intecs/dashboard',
    render: (d) => { _ci = d; renderChamados(); }
  },
  {
    // Divide o bloco com o Intecs, então não tem carimbo próprio: um 403 aqui
    // esconde só o número do MSA, não o bloco inteiro.
    id: null, ms: 15 * 60_000, quando: horarioComercial,
    rota: () => '/api/chamados',
    render: (d) => {
      const lista = Array.isArray(d) ? d : (d.root ?? d.Lista ?? d.lista ?? []);
      _msa = { abertos: lista.filter((c) => c.St !== 'Resolvido' && c.St !== 'Cancelado').length };
      renderChamados();
    }
  },
  {
    id: 'blocoAvisos', ms: 2 * 60_000,
    rota: () => {
      const de = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      return `/api/logs?seguranca=todos&limit=8&de=${encodeURIComponent(de)}`;
    },
    render: (d) => renderAvisos(d)
  },
  {
    id: 'blocoEventos', ms: 30 * 60_000,
    rota: () => '/api/calendario/eventos',
    render: (d) => renderEventos(d)
  },
  {
    // Estoque e empréstimos mudam em escala de dias — 30 min já é generoso.
    id: 'cpMini', ms: 30 * 60_000,
    rota: () => '/api/dashboard',
    render: (d) => {
      $('cpInsumos').textContent = d.geral?.total_insumos ?? '—';
      $('cpEmprestados').textContent = d.geral?.emprestados ?? '—';
    }
  }
];

function carimbar(b, texto) {
  if (b.carimbo && $(b.carimbo)) $(b.carimbo).textContent = texto;
}

async function rodar(b) {
  if (b.oculto || _sessaoMorta) return;
  // A janela de horário pula o ciclo, mas nunca a PRIMEIRA busca: quem abriu o
  // painel às 22h está olhando agora, e um bloco vazio sem explicação é pior
  // que uma raspagem. O que a janela evita é o heartbeat de madrugada.
  if (b.quando && !b.quando() && b.em) {
    carimbar(b, 'às ' + hhmm(b.em));
    return;
  }
  try {
    b.render(await api(b.rota()));
    b.em = new Date();
    carimbar(b, '');
  } catch (err) {
    if (err.status === 401) { pedirLogin(); return; }
    if (err.status === 403) {           // sem a aba de origem: some de vez
      b.oculto = true;
      if (b.id) $(b.id).classList.add('oculto');
      return;
    }
    // Mantém o último valor bom na tela, datado. Sem nada em mãos ainda,
    // avisa no lugar do carimbo em vez de deixar o bloco mudo.
    carimbar(b, b.em ? 'às ' + hhmm(b.em) : 'indisponível');
    console.warn('[cockpit]', b.rota(), err.message);
  }
}

// Idempotente: chamada no arranque e de novo depois de um relogin.
function iniciarBlocos() {
  for (const b of BLOCOS) {
    clearInterval(b.timer);
    rodar(b);
    b.timer = setInterval(() => rodar(b), b.ms);
  }
}

// ============================================================
//  Relógio, login e arranque
// ============================================================

function tiquetaque() {
  const agora = new Date();
  $('cpData').textContent = agora.toLocaleDateString('pt-BR',
    { weekday: 'short', day: '2-digit', month: '2-digit' });
  // Sem segundos: quem prova que o painel está vivo é o pulso ao lado.
  $('cpHora').textContent = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function aplicarTema(modo) {
  document.documentElement.setAttribute('data-theme', modo);
  $('cpIconeTema').className = 'ph ' + (modo === 'light' ? 'ph-moon' : 'ph-sun');
  try { localStorage.setItem('tema-cockpit', modo); } catch (e) { /* modo anônimo */ }
}

function configurarTema() {
  let modo = 'dark';
  try { modo = localStorage.getItem('tema-cockpit') === 'light' ? 'light' : 'dark'; } catch (e) { /* idem */ }
  aplicarTema(modo);
  $('cpBtnTema').addEventListener('click', () =>
    aplicarTema(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));
}

function pedirLogin() {
  _sessaoMorta = true;
  TOKEN = '';
  localStorage.removeItem('token');
  $('cpLogin').classList.remove('oculto');
  $('cpEmail').focus();
}

function configurarLogin() {
  $('cpFormLogin').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('cpBtnEntrar');
    btn.disabled = true;
    $('cpLoginErro').textContent = '';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('cpEmail').value.trim(), senha: $('cpSenha').value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
      TOKEN = data.token;
      localStorage.setItem('token', TOKEN);
      _sessaoMorta = false;
      $('cpSenha').value = '';
      $('cpLogin').classList.add('oculto');
      // Blocos que sumiram por 403 voltam a valer: quem entrou pode ser outra
      // pessoa, com outras permissões.
      for (const b of BLOCOS) {
        b.oculto = false;
        if (b.id) $(b.id).classList.remove('oculto');
      }
      iniciarBlocos();
    } catch (err) {
      $('cpLoginErro').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

tiquetaque();
setInterval(tiquetaque, 1000);   // 1s mesmo sem segundos: acerta a virada do minuto na hora
configurarTema();
configurarNavEventos();
configurarLogin();

// F alterna tela cheia — a única interação da página.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'f' && ev.key !== 'F') return;
  if (document.activeElement?.tagName === 'INPUT') return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

if (TOKEN) iniciarBlocos();
else pedirLogin();
