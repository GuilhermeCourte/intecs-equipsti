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


// Atalho para o app: o cockpit é outra página, então a única forma de apontar
// para um registro de lá é a URL (?chamado=ID, ?ir=DESTINO&id=ID — ver DESTINOS
// em app.js). Devolve os atributos prontos para colar na abertura da linha; o
// cursor sai do próprio [data-app] no CSS, sem classe extra para não brigar
// com o class= que as linhas já têm.
const atalhoApp = (qs) => qs ? ` data-app="${escapeHtml(qs)}" title="Abrir no app"` : '';

const hhmm = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const ddmm = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
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

// DOWN/INSTAVEL primeiro (o que precisa de atenção salta aos olhos), UP depois.
const UNID_ORDEM = { DOWN: 0, INSTAVEL: 1, UP: 2 };
const UNID_CLASSE = { DOWN: 'down', INSTAVEL: 'instavel' };

function renderUnidades(r) {
  const comMonitor = (r.unidades || []).filter((u) => u.status !== 'SEM_MONITOR');
  const problema = comMonitor.filter((u) => u.status === 'DOWN' || u.status === 'INSTAVEL');

  $('blocoUnidades').classList.toggle('alerta', problema.length > 0);

  if (!comMonitor.length) {
    $('cpUnidades').innerHTML = '';
    return;
  }
  const ordenado = [...comMonitor].sort((a, b) => UNID_ORDEM[a.status] - UNID_ORDEM[b.status]);
  $('cpUnidades').innerHTML = `<div class="cp-online"><div class="cp-online-lista">${
    ordenado.map((u) => `<span class="${UNID_CLASSE[u.status] || ''}"${atalhoApp('conexoes')}><i class="cp-ponto"></i>${escapeHtml(u.monitor || u.unidade)}</span>`).join('')
  }</div></div>`;
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
let _vpsResumo = null;

function renderVps(lista) {
  if (!lista || !lista.length) return;
  _vpsResumo = lista;
  atualizarItemVps();
}

// O mesmo botão é "ver a VPS" e "voltar pro painel" — com a aba aberta ele
// vira seta, no lugar exato onde os dados estavam. Guarda o último resumo pra
// repor o texto na volta sem esperar o próximo ciclo (5 min).
function atualizarItemVps() {
  const item = $('cpVpsItem');
  $('cpVpsIcone').className = 'ph ' + (_vpsAberta ? 'ph-arrow-left' : 'ph-hard-drives');
  item.title = _vpsAberta ? 'Voltar ao painel (Esc)' : 'Ver detalhes da VPS';
  // O texto (CPU/RAM) continua o mesmo com a aba aberta: além de seguir útil,
  // é o que mantém a largura do botão — e a seta — parada no lugar.
  if (!_vpsResumo) { $('cpVpsEstado').textContent = '—'; return; }
  const problema = _vpsResumo.find((vm) => vm.estadoCor !== 'ok');
  item.classList.toggle('alerta', !!problema);
  $('cpVpsEstado').textContent = problema
    ? (VPS_ESTADO_LABEL[problema.state] || problema.state || 'indisponível')
    : `${_vpsResumo[0].cpu != null ? _vpsResumo[0].cpu.toFixed(0) + '% CPU' : '—'} · ${_vpsResumo[0].ramPercent != null ? _vpsResumo[0].ramPercent.toFixed(0) + '% RAM' : '—'}`;
}

// Renderiza os dois de uma vez porque dividem o mesmo bloco: cada um chega no
// seu ritmo (Intecs a cada minuto, MSA a cada 15) e o último valor bom do
// outro tem que continuar na tela.
let _ciLista = null, _msaLista = null;

// As duas colunas têm a mesma linha: unidade · ponto · PAT · equipamento ·
// assunto em cima, status embaixo. Campo que vier vazio some da linha em vez
// de deixar um separador solto — no INTECS, PAT e equipamento dependem de
// haver máquina vinculada ao chamado.
// Separada do HTML porque o aviso do Windows mostra a MESMA linha: se a tela e
// a notificação contarem histórias diferentes, quem chega perto duvida das duas.
function linhaChamado({ unidade, ponto, pat, equipamento, assunto }) {
  return [unidade, ponto, pat ? 'PAT ' + pat : null, equipamento, assunto]
    .filter(Boolean).join(' · ');
}

// Mesmo padrão dos eventos e dos avisos: o atalho fica no NOME, não na linha —
// clicar no ícone ou no status é leitura, não comando.
function itemChamado(c) {
  return `<div class="cp-li">
    <span class="cp-li-ico"><i class="ph ph-ticket"></i></span>
    <span class="cp-li-corpo">
      <div class="cp-li-tit"><span${atalhoApp(c.app)}>${escapeHtml(linhaChamado(c) || '(sem dados)')}</span></div>
      ${c.status ? `<div class="cp-li-sub">${escapeHtml(c.status)}</div>` : ''}
    </span>
  </div>`;
}

// De onde cada sistema tira os campos da linha. Um lugar só, usado pelo render
// e pelo aviso.
const CAMPOS_CI = (c) => ({
  unidade: c.unidade, ponto: c.ponto, pat: c.patrimonio, equipamento: c.equipamento,
  assunto: c.titulo, status: c.status,
  app: c.id ? 'chamado=' + encodeURIComponent(c.id) : null
});
const CAMPOS_MSA = (c) => ({
  unidade: c.unidade, ponto: c.ponto_instalacao, pat: c.patrimonio_msa,
  equipamento: c.descricao_equip, status: c.status_msa,
  app: c.id ? 'ir=msa&id=' + encodeURIComponent(c.id) : null
});

// O rótulo virou cabeçalho da coluna: sem os números grandes, é o que diz
// qual lista é de qual sistema — e, por isso, é o atalho para a sub-aba dela.
function colunaChamados(id, rotulo, destino, lista, mapear) {
  const corpo = lista && lista.length
    ? lista.map(mapear).join('')
    : '<div class="cp-vazio"><i class="ph ph-check-circle"></i> Nada em aberto</div>';
  return `<div class="cp-chamados-coluna">
    <div class="cp-chamados-rot"><span${atalhoApp(destino)}>${rotulo}</span></div>
    <div class="cp-lista" id="${id}">${corpo}</div>
  </div>`;
}

function renderChamados() {
  $('cpChamados').innerHTML = '<div class="cp-chamados-listas">'
    // Cada rótulo leva à sub-aba de onde a lista veio: INTECS ao chamado
    // interno, MSA à sub-aba INTECS vs MSA.
    + colunaChamados('cpChamListaCi', 'INTECS', 'ir=chamados', _ciLista, (c) => itemChamado(CAMPOS_CI(c)))
    + colunaChamados('cpChamListaMsa', 'MSA', 'ir=msa', _msaLista, (c) => itemChamado(CAMPOS_MSA(c)))
    + '</div>';
  limitarAltura($('cpChamListaCi'), 4);
  limitarAltura($('cpChamListaMsa'), 4);
}

const AVISO_ROTULO = {
  LOGIN_BLOQUEADO: 'Login bloqueado',
  SENHA_REVELADA: 'Senha revelada',
  SENHA_REDEFINIDA: 'Senha redefinida',
  CONEXAO: 'Conexão remota',
  SCRIPT_EXECUTADO: 'Script executado'
};

// Caixa mostra sempre n linhas de altura; o resto rola dentro dela (cp-lista
// já tem overflow-y: auto). Mede as linhas de verdade em vez de chutar altura
// fixa, porque o tamanho da fonte varia com a altura da tela (clamp em vh).
const _capadas = new Map();   // lista -> nº de linhas visíveis

function limitarAltura(lista, n) {
  if (!lista) return;
  _capadas.set(lista, n);
  aplicarLimite(lista, n);
}

// Fecha a caixa na base da última cp-li INTEIRA que couber: no máximo n
// linhas, e nunca mais do que o espaço que o flex deu à lista. Assim a caixa
// nunca corta uma linha ao meio — o que sobra fica no scroll.
// Mede por offsetTop (o gap e os divisores entram na conta sozinhos) em vez de
// somar alturas + um GAP chutado, que errava por um gap e cortava a última.
function aplicarLimite(lista, n) {
  lista.style.maxHeight = '';   // volta ao tamanho natural antes de medir
  const filhos = [...lista.children];
  if (!filhos.length) return;

  const disponivel = lista.clientHeight;
  const topo = filhos[0].offsetTop;
  let vistas = 0, altura = 0;
  for (const el of filhos) {
    if (!el.classList.contains('cp-li')) continue;
    const fim = el.offsetTop + el.offsetHeight - topo;
    if (fim > disponivel + 1) break;   // não cabe inteira: para na anterior
    altura = fim;
    if (++vistas >= n) break;
  }
  if (vistas) lista.style.maxHeight = `${Math.ceil(altura)}px`;
}

// A medida na hora do render é provisória: Poppins e os ícones vêm de CDN e
// só depois de carregados a linha tem a altura final; a altura da janela
// também entra (font-size das linhas é clamp em vh). Sem remedir, a caixa
// fica congelada num tamanho menor e corta a última linha.
function remedirListas() {
  for (const [lista, n] of _capadas) {
    if (lista.isConnected) aplicarLimite(lista, n);
    else _capadas.delete(lista);   // render novo trocou o elemento
  }
}

if (document.fonts?.ready) document.fonts.ready.then(remedirListas);
window.addEventListener('resize', remedirListas);

function renderAvisos(logs) {
  if (!logs.length) {
    $('cpAvisos').innerHTML = '<div class="cp-vazio"><i class="ph ph-shield-check"></i> Nada nos últimos 7 dias</div>';
    $('cpAvisos').style.maxHeight = '';
    return;
  }
  $('cpAvisos').innerHTML = logs.map((l) => {
    // ATUALIZADO só chega aqui vindo do par (USUARIOS, campo PAPEL|PERMISSÕES).
    const rotulo = l.acao === 'ATUALIZADO'
      ? (l.campo === 'PAPEL' ? 'Papel alterado' : 'Permissões alteradas')
      : (AVISO_ROTULO[l.acao] || l.acao);
    const alerta = l.acao === 'LOGIN_BLOQUEADO';
    const sub = [l.usuario, l.valorNovo || l.campo].filter(Boolean).join(' · ');
    const data = new Date(l.dataHora);
    // Mesmo padrão dos eventos: só o nome do aviso leva aos logs.
    return `<div class="cp-li ${alerta ? 'alerta' : ''}">
      <span class="cp-li-quando">${hhmm(data)}<small>${ddmm(data)}</small></span>
      <span class="cp-li-ico"><i class="ph ${alerta ? 'ph-warning' : 'ph-dot-outline'}"></i></span>
      <span class="cp-li-corpo">
        <div class="cp-li-tit"><span${atalhoApp('ir=logs&id=' + encodeURIComponent(l.modulo || ''))}>${escapeHtml(rotulo)}${l.entidadeRotulo ? ' · ' + escapeHtml(l.entidadeRotulo) : ''}</span></div>
        ${sub ? `<div class="cp-li-sub">${escapeHtml(sub)}</div>` : ''}
      </span>
    </div>`;
  }).join('');
  limitarAltura($('cpAvisos'), 4);
}

function itemEvento(x, vencido) {
  const d = x.data;
  const rec = x.evt.recorrencia;
  const sub = [x.evt.tipo, rec === 'MENSAL' ? 'mensal' : (rec === 'ANUAL' ? 'anual' : null)]
    .filter(Boolean).join(' · ');
  // O atalho fica no NOME, não na linha: data, recorrência e valor são leitura,
  // e clicar neles não pode disparar navegação sem querer.
  return `<div class="cp-li">
    <span class="cp-li-quando">${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}</span>
    <span class="cp-dot-evt ${rec}"></span>
    <span class="cp-li-corpo">
      <div class="cp-li-tit"><span${atalhoApp('ir=evento&id=' + encodeURIComponent(x.evt.id))}>${escapeHtml(x.evt.titulo)}</span>${vencido ? ' <span class="cp-badge-venc">VENCIDO</span>' : ''}</div>
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

  let doMes = _eventos
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
      const idsVencidos = new Set(vencidos.map((x) => x.evt.id));
      doMes = doMes.filter((x) => !idsVencidos.has(x.evt.id));
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
  limitarAltura($('cpEventos'), 4);
  agendarVoltaAoMesCorrente();
}

function configurarNavEventos() {
  $('cpMesAnt').addEventListener('click', () => { _mesOffset--; desenharEventos(); });
  $('cpMesProx').addEventListener('click', () => { _mesOffset++; desenharEventos(); });
}

// ============================================================
//  Aba VPS — mesma tela da aba VPS do admin, portada pro cockpit.
//
//  Espelha o comportamento de carregarVps()/carregarMetricasVps() do app.js.
//  Não importa nada de lá (painel autônomo, sem bundler), então duplica o que
//  precisa — mudou o formato da API, muda nos dois.
//  Diferenças de casca, não de conteúdo: o collapse do Docker e o select de
//  métrica são vanilla aqui (o cockpit não carrega Bootstrap nem Choices).
// ============================================================

const VPS_COR_ESTADO = { ok: 'var(--verde)', erro: 'var(--vermelho)', transicao: 'var(--laranja)' };

let _vpsCharts = {};
let _vpsMetricasCache = {};   // "id:faixa" -> resposta completa de /metricas
let _vpsCreatedAt = {};
let _vpsAberta = false;

const vpsMbParaGb = (mb) => (mb == null ? '—' : (mb / 1024).toFixed(1) + ' GB');
const vpsMbCont = (mb) => (mb == null ? '—' : (mb < 1 ? Math.round(mb * 1024) + ' KB' : mb.toFixed(1) + ' MB'));
const vpsEnderecos = (l) => (l && l.length ? l.map((ip) => escapeHtml(ip.address)).join(', ') : '—');

// created_at é fixo desde a criação da VPS — sozinho o uptime ficaria contando
// desde então mesmo depois de um restart. A ação de boot mais recente corrige.
const VPS_ACAO_BOOT_RE = /^(vm_)?(start|restart|resume|unsuspend)\b/i;

function formatarUptimeDesde(referenciaIso) {
  if (!referenciaIso) return '—';
  const horas = Math.floor((Date.now() - new Date(referenciaIso).getTime()) / 3_600_000);
  if (horas < 0) return '—';
  const dias = Math.floor(horas / 24);
  return dias < 1 ? '< 1 dia' : dias + (dias > 1 ? ' dias' : ' dia');
}

function referenciaUptimeVps(vmId, acoes) {
  const criadoEm = _vpsCreatedAt[vmId];
  const boot = acoes
    .filter((a) => a.state === 'success' && VPS_ACAO_BOOT_RE.test(a.name))
    .map((a) => a.createdAt).sort().pop();
  return boot && boot > criadoEm ? boot : criadoEm;
}

// Duração do docker ps ("Up 4 hours", "Exited (0) 3 hours ago") em PT.
const VPS_TEMPO_PT = {
  second: 'segundo', seconds: 'segundos', minute: 'minuto', minutes: 'minutos',
  hour: 'hora', hours: 'horas', day: 'dia', days: 'dias',
  week: 'semana', weeks: 'semanas', month: 'mês', months: 'meses',
  year: 'ano', years: 'anos'
};

function traduzirDuracaoVps(s) {
  const cercaDe = /^about\s+/i.test(s);
  s = s.replace(/^about\s+/i, '').replace(/^an?\s+/i, '1 ');
  return (cercaDe ? 'cerca de ' : '') + s;
}

function formatarStatusContainerVps(status) {
  if (!status) return '—';
  let s = status.replace(/\s*\((?:un)?healthy\)|\s*\(health:\s*starting\)/i, '').trim();
  if (/^up\s/i.test(s))            s = 'no ar há ' + traduzirDuracaoVps(s.replace(/^up\s+/i, ''));
  else if (/^exited/i.test(s))     s = 'parado há ' + traduzirDuracaoVps(s.replace(/^exited\s*\([^)]*\)\s*/i, '').replace(/\s*ago$/i, ''));
  else if (/^created$/i.test(s))   s = 'criado';
  else if (/^restarting/i.test(s)) s = 'reiniciando';
  return s.replace(/\b(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b/gi,
    (m) => VPS_TEMPO_PT[m.toLowerCase()] || m);
}

const pontoVps = (cor) => `<span class="cp-ponto" style="background:${cor}"></span>`;

function cardVps(vm) {
  return `
    <div class="cp-vps-card">
      <div class="cp-vps-card-topo"${atalhoApp('ir=vps')}>
        <img src="icons/hostinger.svg" alt="" width="18" height="18">
        VPS Hostinger · ${escapeHtml(vm.hostname)}
        <span class="cp-vps-selo ${vm.estadoCor}">${escapeHtml(VPS_ESTADO_LABEL[vm.state] || vm.state)}</span>
      </div>

      <div class="cp-vps-sec"><i class="ph ph-info"></i> Dados</div>
      <div class="cp-vps-specs">
        <div><span>Plano</span>${escapeHtml(vm.plan || '—')}</div>
        <div><span>SO</span>${escapeHtml(vm.template?.name || '—')}</div>
        <div><span>CPUs</span>${vm.cpus ?? '—'}</div>
        <div><span>RAM</span><i id="cpVpsRamSpec-${vm.id}">—</i> / ${vpsMbParaGb(vm.memory)}</div>
        <div><span>Disco</span><i id="cpVpsDiskSpec-${vm.id}">—</i> / ${vpsMbParaGb(vm.disk)}</div>
        <div><span>IPv4</span>${vpsEnderecos(vm.ipv4)}</div>
        <div><span>Uptime</span><i id="cpVpsUptime-${vm.id}">${formatarUptimeDesde(vm.createdAt)}</i></div>
      </div>

      <div class="cp-vps-sec"><i class="ph ph-chart-line"></i> Métricas principais</div>
      <div class="cp-vps-ctrl">
        <span class="cp-vps-faixa" data-vm="${vm.id}">
          <button type="button" class="ativo" data-faixa="24h">24h</button>
          <button type="button" data-faixa="7d">7d</button>
        </span>
      </div>
      <div class="cp-vps-graficos">
        <div>
          <div class="cp-vps-gtit">CPU <b id="cpVpsCpuAtual-${vm.id}">—</b></div>
          <div class="cp-vps-canvas"><canvas id="cpVpsChartCpu-${vm.id}"></canvas></div>
        </div>
        <div>
          <div class="cp-vps-gtit">RAM <b id="cpVpsRamAtual-${vm.id}">—</b></div>
          <div class="cp-vps-canvas"><canvas id="cpVpsChartRam-${vm.id}"></canvas></div>
        </div>
      </div>

      <div class="cp-vps-sec"><img src="icons/docker.svg" alt="" class="cp-vps-icone-docker"> Docker</div>
      <div id="cpVpsDocker-${vm.id}"><div class="cp-vps-vazio">Carregando...</div></div>
    </div>`;
}

async function carregarVps() {
  const grid = $('cpVpsCards');
  grid.innerHTML = '<div class="cp-vps-vazio">Carregando...</div>';
  try {
    const maquinas = await api('/api/vps');
    if (!maquinas.length) {
      grid.innerHTML = '<div class="cp-vps-vazio">Nenhuma VPS encontrada na conta Hostinger.</div>';
      return;
    }
    grid.innerHTML = maquinas.map(cardVps).join('');
    $('cpVpsAtualizadoEm').textContent = 'atualizado às ' + hhmm(new Date());
    for (const vm of maquinas) {
      _vpsCreatedAt[vm.id] = vm.createdAt;
      carregarMetricasVps(vm.id, '24h');
      atualizarUptimeVps(vm.id);
      carregarDockerVps(vm.id);
    }
  } catch (err) {
    if (err.status === 401) { pedirLogin(); return; }
    grid.innerHTML = `<div class="cp-vps-erro">Erro: ${escapeHtml(err.message)}</div>`;
  }
}

async function carregarMetricasVps(vmId, faixa) {
  const chave = vmId + ':' + faixa;
  try {
    let dados = _vpsMetricasCache[chave];
    if (!dados) {
      dados = await api('/api/vps/' + encodeURIComponent(vmId) + '/metricas?faixa=' + faixa);
      _vpsMetricasCache[chave] = dados;
    }
    graficoVps('cpVpsChartCpu-' + vmId, '%', dados.cpu_usage);
    graficoVps('cpVpsChartRam-' + vmId, 'MB', dados.ram_usage);

    const ultimo = (s) => (s && s.data.length ? s.data[s.data.length - 1] : null);
    const cpu = ultimo(dados.cpu_usage), ram = ultimo(dados.ram_usage), disco = ultimo(dados.disk_space);
    $('cpVpsCpuAtual-' + vmId).textContent = cpu == null ? '—' : cpu.toFixed(1) + '%';
    $('cpVpsRamAtual-' + vmId).textContent = ram == null ? '—' : vpsMbParaGb(ram);
    $('cpVpsRamSpec-' + vmId).textContent = ram == null ? '—' : vpsMbParaGb(ram);
    $('cpVpsDiskSpec-' + vmId).textContent = disco == null ? '—' : vpsMbParaGb(disco);
  } catch (err) {
    console.warn('[cockpit vps] métricas', vmId, err.message);
  }
}

// Mesmo gráfico do renderVpsChart() do app.js, incluindo as cores padrão do
// Chart.js na grade e nos eixos: no escuro elas quase somem, e é assim que a
// aba VPS do admin se parece. Pintar a grade com --line deixava as linhas bem
// mais fortes aqui do que lá.
function graficoVps(canvasId, unidade, serie) {
  if (_vpsCharts[canvasId]) _vpsCharts[canvasId].destroy();
  const canvas = $(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  serie = serie || { labels: [], data: [] };
  _vpsCharts[canvasId] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: serie.labels.map((l) => new Date(l).toLocaleString('pt-BR',
        { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
      datasets: [{
        data: serie.data, borderColor: '#4f7cf5', backgroundColor: 'rgba(79,124,245,.12)',
        fill: true, tension: .3, pointRadius: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: unidade } } }
    }
  });
}

// A lista de ações não é exibida aqui, mas continua sendo buscada: a página 1
// traz as mais recentes, e é nela que está o start/restart que corrige o
// Uptime (sem isso ele conta desde a criação da VPS — ver referenciaUptimeVps).
async function atualizarUptimeVps(vmId) {
  try {
    const resp = await api('/api/vps/' + encodeURIComponent(vmId) + '/acoes?page=1');
    $('cpVpsUptime-' + vmId).textContent = formatarUptimeDesde(referenciaUptimeVps(vmId, resp.data));
  } catch (err) {
    console.warn('[cockpit vps] uptime', vmId, err.message);
  }
}

async function carregarDockerVps(vmId) {
  const cont = $('cpVpsDocker-' + vmId);
  try {
    const projetos = await api('/api/vps/' + encodeURIComponent(vmId) + '/docker');
    cont.innerHTML = projetos.length
      ? projetos.map((p, i) => projetoDockerVps(p, vmId, i)).join('')
      : '<div class="cp-vps-vazio">Nenhum projeto Docker encontrado.</div>';
  } catch (err) {
    cont.innerHTML = `<div class="cp-vps-erro">Erro: ${escapeHtml(err.message)}</div>`;
  }
}

// Container com o mesmo nome do projeto repete o que o cabeçalho já diz — por
// isso a lista vem fechada, só abre se quiserem ver imagem/porta/stats.
function projetoDockerVps(p, vmId, idx) {
  const alvo = 'cpVpsDockerCont-' + vmId + '-' + idx;
  const itens = p.containers.length
    ? p.containers.map((c) => {
        const saude = c.health ? ' · ' + escapeHtml(c.health) : '';
        const stats = c.stats
          ? ` · CPU ${c.stats.cpuPercent.toFixed(1)}% · RAM ${c.stats.memPercent.toFixed(1)}% (${vpsMbCont(c.stats.memUsadaMb)}) · Rede ↓${vpsMbCont(c.stats.netEntradaMb)} ↑${vpsMbCont(c.stats.netSaidaMb)}`
          : '';
        return `
          <div class="cp-vps-cont">
            <div style="display:flex;align-items:center;gap:.5rem">
              ${pontoVps(VPS_COR_ESTADO[c.estadoCor] || 'var(--laranja)')}
              <b>${escapeHtml(c.name)}</b>
            </div>
            <div class="cp-vps-sub">${escapeHtml(formatarStatusContainerVps(c.status))}${saude}${stats}</div>
            <div class="cp-vps-sub">${c.portas.length ? escapeHtml(c.portas.join(', ')) : '—'}</div>
          </div>`;
      }).join('')
    : '<div class="cp-vps-vazio">Sem containers.</div>';
  return `
    <div>
      <button type="button" class="cp-vps-docker-btn" data-alvo="${alvo}" aria-expanded="false">
        ${pontoVps(VPS_COR_ESTADO[p.estadoCor] || 'var(--laranja)')}
        ${escapeHtml(p.name)}
        <i class="ph ph-caret-down cp-vps-chev"></i>
      </button>
      <div class="cp-vps-docker-itens" id="${alvo}" hidden>${itens}</div>
    </div>`;
}

function abrirVps() {
  _vpsAberta = true;
  $('cpPainel').classList.add('oculto');
  $('cpVpsCards').classList.remove('oculto');
  $('cpVpsBtnAtualizar').classList.remove('oculto');
  $('cpApp').classList.add('vps-aberta');
  atualizarItemVps();
  carregarVps();
}

function fecharVps() {
  // Descarta os gráficos: sem isso o Chart.js segura os canvas antigos e
  // vaza memória num painel que fica ligado o dia inteiro.
  Object.values(_vpsCharts).forEach((c) => c.destroy());
  _vpsCharts = {};
  _vpsMetricasCache = {};
  _vpsAberta = false;
  $('cpVpsCards').classList.add('oculto');
  $('cpVpsBtnAtualizar').classList.add('oculto');
  $('cpApp').classList.remove('vps-aberta');
  $('cpPainel').classList.remove('oculto');
  atualizarItemVps();
}

function configurarVps() {
  $('cpVpsItem').addEventListener('click', () => (_vpsAberta ? fecharVps() : abrirVps()));
  $('cpVpsBtnAtualizar').addEventListener('click', () => {
    _vpsMetricasCache = {};
    carregarVps();
  });

  $('cpVpsCards').addEventListener('click', (e) => {
    const btnFaixa = e.target.closest('.cp-vps-faixa button');
    if (btnFaixa) {
      const grupo = btnFaixa.closest('.cp-vps-faixa');
      grupo.querySelectorAll('button').forEach((b) => b.classList.toggle('ativo', b === btnFaixa));
      carregarMetricasVps(grupo.dataset.vm, btnFaixa.dataset.faixa);
      return;
    }
    const btnDocker = e.target.closest('.cp-vps-docker-btn');
    if (btnDocker) {
      const alvo = $(btnDocker.dataset.alvo);
      const abrindo = alvo.hidden;
      alvo.hidden = !abrindo;
      btnDocker.setAttribute('aria-expanded', String(abrindo));
    }
  });
}

// ============================================================
//  Alerta sonoro
//
//  Painel de parede não tem quem fique olhando: chamado que entra e unidade
//  que cai precisam se anunciar. Som é sintetizado no Web Audio em vez de vir
//  de arquivo — o painel fica semanas ligado e não pode depender de um .mp3
//  que o service worker não tinha cacheado quando a rede caiu.
// ============================================================

// Timbres de famílias diferentes de propósito: bipe eletrônico é chamado, tom
// de madeira é internet. Dá pra saber o que houve sem prestar atenção na
// melodia — só no material do som.
//
// Uma nota é a frequência em Hz; `gap` é o intervalo entre uma e a próxima
// (menor que `dur` = as notas se sobrepõem), e `oitava` é o volume do harmônico
// uma oitava acima, que é o que dá corpo de madeira — senoide sozinha soa oca.
const SONS = {
  // Par de tons repetido, como chamada de rádio, uma oitava acima da versão
  // grave. Filtro alto: cortado em 2400 sobraria só a fundamental e viraria
  // apito de senoide, sem a aspereza que faz a coisa soar como rádio.
  chamado: { onda: 'square', notas: [1760, 1174.66, 1760, 1174.66], dur: .09, gap: .13, ganho: .32, filtro: 5200 },
  caiu:    { onda: 'sine',   notas: [440, 293.66], dur: .55, gap: .16, ganho: 1, oitava: .3 },   // marimba descendo
  voltou:  { onda: 'sine',   notas: [587.33, 880], dur: .38, gap: .11, ganho: 1, oitava: .3 }    // marimba subindo
};

// Ganho base do painel; cada som ajusta o seu por cima disso. Os `ganho`
// relativos vieram da página de teste, então a mistura soa como foi aprovada.
const VOLUME = 0.18;

let _somLigado = true;
let _ctx = null;

// O navegador bloqueia áudio sem gesto do usuário — e o cockpit é justamente a
// tela em que ninguém toca. Qualquer clique ou tecla destrava (o próprio botão
// de som serve); até lá o botão fica vermelho dizendo que está mudo, porque
// alerta que não toca sem ninguém saber por quê é pior que alerta nenhum.
//
// Para a TV abrir já com som, sem ninguém clicar, o jeito é do lado do atalho
// do navegador — não tem como o código burlar a política:
//   chrome.exe --autoplay-policy=no-user-gesture-required --kiosk http://.../cockpit
// Instalar o painel como app (PWA) também libera: janela de app instalado não
// cai na política de autoplay.
function destravarSom() {
  if (_ctx && _ctx.state === 'running') return;
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { _ctx = new AC(); } catch (e) { return; }
  }
  _ctx.resume?.().then(atualizarBotaoSom, () => {});
  atualizarBotaoSom();
}

function voz(hz, t, som, oitava, ganho) {
  const osc = _ctx.createOscillator();
  const vol = _ctx.createGain();
  osc.type = som.onda;
  osc.frequency.value = hz * oitava;
  // Ataque e decay curtos: sem o envelope o oscilador estala nas pontas.
  vol.gain.setValueAtTime(0, t);
  vol.gain.linearRampToValueAtTime(VOLUME * som.ganho * ganho, t + 0.01);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + som.dur);
  osc.connect(vol);
  if (som.filtro) {
    // Quadrada crua vira zumbido de cigarra; o passa-baixa deixa com cara de
    // bipe de equipamento.
    const f = _ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = som.filtro;
    vol.connect(f).connect(_ctx.destination);
  } else {
    vol.connect(_ctx.destination);
  }
  osc.start(t);
  osc.stop(t + som.dur + 0.02);
}

function tocar(nome) {
  if (!_somLigado || !_ctx || _ctx.state !== 'running') return;
  const som = SONS[nome];
  som.notas.forEach((hz, i) => {
    const t = _ctx.currentTime + i * som.gap;
    voz(hz, t, som, 1, 1);
    if (som.oitava) voz(hz, t, som, 2, som.oitava);
  });
}

function atualizarBotaoSom() {
  const travado = _somLigado && (!_ctx || _ctx.state !== 'running');
  $('cpIconeSom').className = 'ph ' + (!_somLigado ? 'ph-speaker-slash'
    : travado ? 'ph-speaker-simple-x' : 'ph-speaker-high');
  $('cpBtnSom').classList.toggle('travado', travado);
  $('cpBtnSom').title = !_somLigado ? 'Som desligado'
    : travado ? 'Clique para ativar o som' : 'Som ligado';
}

function configurarSom() {
  try { _somLigado = localStorage.getItem('som-cockpit') !== 'off'; } catch (e) { /* modo anônimo */ }
  $('cpBtnSom').addEventListener('click', () => {
    // Travado: este clique é o gesto que o navegador estava esperando, e só
    // isso. O botão promete "ativar o som" — desligar a preferência aqui seria
    // fazer o contrário do que está escrito nele.
    if (_somLigado && (!_ctx || _ctx.state !== 'running')) { destravarSom(); return; }
    _somLigado = !_somLigado;
    try { localStorage.setItem('som-cockpit', _somLigado ? 'on' : 'off'); } catch (e) { /* idem */ }
    if (_somLigado) destravarSom();
    atualizarBotaoSom();
  });
  // Tema, tela cheia, tecla F, login: qualquer gesto na página já destrava.
  document.addEventListener('click', destravarSom);
  document.addEventListener('keydown', destravarSom);
  // Tenta de saída: num navegador em modo quiosque (o caso da TV) o áudio já
  // nasce liberado e o botão nunca chega a ficar vermelho.
  destravarSom();
}

// ============================================================
//  Aviso do Windows
//
//  O som avisa quem está na sala; a notificação alcança quem está de costas
//  ou noutra janela. Vale a ressalva: o Windows ESCONDE notificação enquanto
//  há app em tela cheia — que é como o painel costuma ficar. Nesse modo o
//  aviso vai direto pra Central de Ações, calado. Quem quiser o balão na tela
//  precisa liberar em Configurações → Sistema → Notificações.
// ============================================================

let _avisoLigado = true;

const permissaoAviso = () => ('Notification' in window ? Notification.permission : 'denied');

function avisar(evento, titulo, corpo) {
  if (!_avisoLigado || permissaoAviso() !== 'granted') return;
  try {
    new Notification(titulo, {
      body: corpo,
      icon: 'icons/icon-192.png',
      // Uma tag por evento: a queda de agora substitui a de cinco minutos
      // atrás em vez de empilhar balão em cima de balão numa tela de parede.
      tag: 'cockpit-' + evento,
      renotify: true,
      // O som é o nosso, sintetizado. Sem isso o Windows toca o dele por cima.
      silent: true
    });
  } catch (e) {
    console.warn('[cockpit] aviso falhou:', e.message);
  }
}

// Som e notificação são a mesma notícia em dois canais: saem sempre juntos.
function alertar(evento, titulo, corpo) {
  tocar(evento);
  avisar(evento, titulo, corpo);
}

function atualizarBotaoAviso() {
  const perm = permissaoAviso();
  const bloqueado = perm === 'denied';                        // negado no navegador
  const pendente = _avisoLigado && perm === 'default';        // falta um clique
  const travado = _avisoLigado && (bloqueado || pendente);
  $('cpIconeAviso').className = 'ph ' + (_avisoLigado && !bloqueado ? 'ph-bell' : 'ph-bell-slash');
  $('cpBtnAviso').classList.toggle('travado', travado);
  $('cpBtnAviso').title = bloqueado ? 'Avisos bloqueados nas permissões do navegador'
    : pendente ? 'Clique para permitir avisos do Windows'
    : _avisoLigado ? 'Avisos do Windows ligados' : 'Avisos do Windows desligados';
}

function configurarAviso() {
  try { _avisoLigado = localStorage.getItem('aviso-cockpit') !== 'off'; } catch (e) { /* modo anônimo */ }
  $('cpBtnAviso').addEventListener('click', () => {
    // Pedir permissão exige gesto do usuário — este clique é o gesto. Enquanto
    // ela não vier, o botão fica vermelho em vez de fingir que está ligado.
    if (_avisoLigado && permissaoAviso() === 'default') {
      Notification.requestPermission().then(atualizarBotaoAviso, () => {});
      return;
    }
    _avisoLigado = !_avisoLigado;
    try { localStorage.setItem('aviso-cockpit', _avisoLigado ? 'on' : 'off'); } catch (e) { /* idem */ }
    atualizarBotaoAviso();
  });
  atualizarBotaoAviso();
  pedirPermissaoAviso();
}

// Painel de parede não tem quem clique em "Permitir": pede de saída, no
// carregamento. Chrome e Edge aceitam o pedido sem gesto do usuário; o Firefox
// exige e devolve 'default' — aí o sino fica vermelho e o clique resolve.
function pedirPermissaoAviso() {
  if (!_avisoLigado || permissaoAviso() !== 'default') return;
  try {
    const p = Notification.requestPermission();
    if (p?.then) p.then(atualizarBotaoAviso, () => {});
  } catch (e) { /* navegador que só aceita com gesto: sobra o botão */ }
}

// Um chamado pode sair do TOP 6 (a lista vem ordenada por prazo de SLA) e
// voltar depois, então o conjunto acumula em vez de comparar com a lista
// anterior: re-entrada não é novidade. O teto evita crescer sem limite num
// painel que fica semanas ligado.
const VISTOS_MAX = 200;
const _vistosCI = { set: null }, _vistosMSA = { set: null };   // null = ainda não carregou

// Devolve os chamados inéditos. Na primeira carga só semeia e devolve vazio: o
// painel abrindo com chamados já em aberto não é notícia — som a cada F5 vira
// som desligado.
function novosChamados(estado, lista) {
  const primeira = estado.set === null;
  if (primeira) estado.set = new Set();
  const novos = [];
  for (const c of (Array.isArray(lista) ? lista : [])) {
    if (c.id == null) continue;
    const id = String(c.id);
    if (!primeira && !estado.set.has(id)) novos.push(c);
    estado.set.add(id);
  }
  // Set do JS mantém ordem de inserção: descarta sempre o mais antigo.
  while (estado.set.size > VISTOS_MAX) estado.set.delete(estado.set.values().next().value);
  return novos;
}

// Um alerta por ciclo, não um por chamado: o corpo mostra o primeiro e conta o
// resto, igual a caixa de entrada faz.
function alertarChamados(novos, campos) {
  if (!novos.length) return;
  const resto = novos.length - 1;
  alertar('chamado', novos.length > 1 ? `${novos.length} chamados novos` : 'Chamado novo',
    linhaChamado(campos(novos[0])) + (resto ? ` · e mais ${resto}` : ''));
}

let _unidStatus = null;   // Map<unidade, status> do ciclo anterior; null = primeira carga

// Só DOWN alarma. INSTAVEL é o "seems down" do UptimeRobot — falhou uma vez e
// ainda está confirmando; alarmar nele faria o painel apitar em toda oscilação
// passageira. Um bipe por ciclo, não um por unidade.
function detectarQuedas(unidades) {
  const antes = _unidStatus;
  _unidStatus = new Map(unidades.map((u) => [u.unidade, u.status]));
  if (!antes) return;
  const caiu = [], voltou = [];
  for (const u of unidades) {
    const anterior = antes.get(u.unidade);
    // Mesmo nome que aparece na tela: o aviso não pode chamar a loja de outro
    // jeito que a lista de unidades.
    if (u.status === 'DOWN' && anterior !== 'DOWN') caiu.push(u.monitor || u.unidade);
    else if (u.status === 'UP' && anterior === 'DOWN') voltou.push(u.monitor || u.unidade);
  }
  // Queda tem prioridade: é o que exige ação.
  if (caiu.length) alertar('caiu', caiu.length > 1 ? 'Unidades fora do ar' : 'Unidade fora do ar', caiu.join(', '));
  else if (voltou.length) alertar('voltou', voltou.length > 1 ? 'Unidades de volta' : 'Unidade de volta', voltou.join(', '));
}

// Um listener só para a tela inteira: cada linha diz para onde vai no
// data-app. Sempre em aba nova — o painel de parede não pode perder o ciclo de
// atualização por causa de um clique.
function configurarAtalhosApp() {
  $('cpApp').addEventListener('click', (e) => {
    // Setas de mês, botão da VPS, faixa 24h/7d e collapse do Docker ficam
    // dentro (ou ao lado) de elementos com data-app; clicar neles é comando do
    // painel, não navegação.
    if (e.target.closest('button, a, input, label')) return;
    const alvo = e.target.closest('[data-app]');
    if (alvo) window.open('/?' + alvo.dataset.app, '_blank', 'noopener');
  });
}

// ============================================================
//  Agendamento
// ============================================================

const BLOCOS = [
  {
    id: 'blocoUnidades', carimbo: 'cpUnidCarimbo', ms: 60_000,
    rota: () => '/api/conexoes',
    render: (d) => { renderUnidades(d); detectarQuedas(d.unidades || []); }
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
    rota: () => '/api/chamados-intecs/recentes',
    render: (d) => {
      _ciLista = d;
      alertarChamados(novosChamados(_vistosCI, d), CAMPOS_CI);
      renderChamados();
    }
  },
  {
    // Divide o bloco com o Intecs, então não tem carimbo próprio: um 403 aqui
    // esconde só a coluna do MSA, não o bloco inteiro.
    // cache=1 lê o banco local (a sub-aba INTECS vs MSA é quem sincroniza com
    // o eurosa) — o painel não raspa o portal de terceiro a cada ciclo.
    id: null, ms: 5 * 60_000,
    rota: () => '/api/intecs-msa?cache=1',
    render: (d) => {
      // Compara a lista de abertos INTEIRA, antes do corte: a rotação dos 6
      // primeiros não é chamado novo.
      const abertos = (Array.isArray(d) ? d : []).filter((c) => c.status_msa !== 'Finalizado');
      alertarChamados(novosChamados(_vistosMSA, abertos), CAMPOS_MSA);
      _msaLista = abertos.slice(0, 6);
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
configurarSom();
configurarAviso();
configurarNavEventos();
configurarVps();
configurarAtalhosApp();
configurarLogin();

// Tela cheia: pelo botão no cabeçalho ou pela tecla F.
function alternarTelaCheia() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

$('cpBtnTela').addEventListener('click', alternarTelaCheia);
document.addEventListener('keydown', (ev) => {
  if (document.activeElement?.tagName === 'INPUT') return;
  // Esc fecha a aba VPS. Em tela cheia o Esc é do navegador (sai da tela
  // cheia) e nem chega aqui — por isso não conflita.
  if (ev.key === 'Escape' && _vpsAberta) { fecharVps(); return; }
  if (ev.key === 'f' || ev.key === 'F') alternarTelaCheia();
});

// O ícone segue o estado real: sair com Esc também tem que virar a seta.
document.addEventListener('fullscreenchange', () => {
  $('cpIconeTela').className = 'ph ' + (document.fullscreenElement ? 'ph-corners-in' : 'ph-corners-out');
});

if (TOKEN) iniciarBlocos();
else pedirLogin();
