// ============================================================
//  Página standalone /emails — buscador do catálogo de e-mails.
//  Reaproveita o mesmo token/login do app principal (localStorage 'token'),
//  como o portal /chamados. Quem alimenta o catálogo é a aba "E-mails" do
//  Gestão TI; aqui é só leitura.
// ============================================================
const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem('token') || '';

let _tipo = '';        // '' | GRUPO | CAIXA | CONTATO
let _busca = '';
let _debounce = null;
let _requisicao = 0;   // descarta resposta de busca antiga que chega atrasada

const TIPO_LABEL = { GRUPO: 'Grupo', CAIXA: 'Caixa', CONTATO: 'Contato' };
const TIPO_ICONE = { GRUPO: 'ph-users-three', CAIXA: 'ph-envelope-simple', CONTATO: 'ph-address-book' };
const TIPO_CLASSE = { GRUPO: 'ic-grupo', CAIXA: 'ic-caixa', CONTATO: 'ic-contato' };

function trim(v) { return String(v == null ? '' : v).trim(); }
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function iniciais(email) {
  const prefixo = trim(email).split('@')[0] || '';
  const partes = prefixo.split(/[._-]+/).filter(Boolean);
  const ini = partes.length >= 2 ? partes[0][0] + partes[1][0] : prefixo.slice(0, 2);
  return (ini || '?').toUpperCase();
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

function sair() {
  localStorage.removeItem('token');
  TOKEN = '';
  location.reload();
}

function mostrarApp(mostrar) {
  $('loginBox').style.display = mostrar ? 'none' : '';
  $('appBox').style.display = mostrar ? '' : 'none';
}

// ---- Toast (feedback não-bloqueante) ----
// Teto de 3 na tela: copiar vários endereços em sequência empilhava avisos
// até o topo da janela, cobrindo a própria lista. O mais antigo sai para o
// novo entrar, que é o que interessa ver.
const MAX_TOASTS = 3;

function toast(msg, tipo = 'ok') {
  const zona = $('toastZone');
  while (zona.children.length >= MAX_TOASTS) zona.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = 'toastx' + (tipo === 'erro' ? ' toastx-erro' : '');
  el.innerHTML = '<i class="ph ' + (tipo === 'erro' ? 'ph-warning-circle' : 'ph-check-circle') + '"></i><span>' + escapeHtml(msg) + '</span>';
  zona.appendChild(el);
  setTimeout(() => el.classList.add('saindo'), 3400);
  setTimeout(() => el.remove(), 3800);
}

// ---------- Render ----------
function skeleton(n = 6) {
  return Array.from({ length: n }, () =>
    '<div class="sk-card"><span class="sk sk-pill"></span>'
    + '<span class="sk-col"><span class="sk sk-lg"></span><span class="sk sk-md"></span></span>'
    + '<span class="sk sk-pill"></span></div>'
  ).join('');
}

function cardMembros(item) {
  if (item.tipo !== 'GRUPO' || !item.membros.length) return '';
  // Cada integrante copia o PRÓPRIO endereço: sem isso, clicar num deles
  // copiaria o do grupo, que é o data-copiar do card em volta.
  const chips = item.membros.map((m) =>
    '<span class="membro' + (m.tipo === 'external' ? ' externo' : '') + '"'
    + ' data-copiar="' + escapeHtml(m.email) + '" title="Clique para copiar">'
    + escapeHtml(m.email) + '</span>'
  ).join('');
  const n = item.membros.length;
  return '<button type="button" class="membros-toggle" aria-expanded="false" data-membros="' + item.id + '">'
    + '<i class="ph ph-caret-down"></i>' + n + (n === 1 ? ' integrante' : ' integrantes')
    + '</button>'
    + '<div class="membros" id="membros-' + item.id + '">' + chips + '</div>';
}

function card(item, i) {
  const tipo = TIPO_LABEL[item.tipo] ? item.tipo : 'CONTATO';
  const linhas = [];
  if (item.nome) linhas.push('<div class="email-nome">' + escapeHtml(item.nome) + '</div>');
  if (item.descricao) linhas.push('<div class="email-desc">' + escapeHtml(item.descricao) + '</div>');

  // O card inteiro copia o endereço: é o que a pessoa vem fazer aqui. O botão
  // continua, como pista visual de que dá para copiar.
  return '<article class="email-row entra" role="button" tabindex="0"'
    + ' data-copiar="' + escapeHtml(item.email) + '"'
    + ' title="Clique para copiar ' + escapeHtml(item.email) + '"'
    + ' style="--i:' + Math.min(i, 10) + '">'
    + '<span class="email-icon ' + TIPO_CLASSE[tipo] + '" aria-hidden="true"><i class="ph ' + TIPO_ICONE[tipo] + '"></i></span>'
    + '<div class="email-main">'
    +   '<div class="email-addr">' + escapeHtml(item.email) + '</div>'
    +   linhas.join('')
    +   cardMembros(item)
    + '</div>'
    + '<div class="email-side">'
    +   '<button type="button" class="btn-icone" data-copiar="' + escapeHtml(item.email) + '" '
    +     'title="Copiar endereço" aria-label="Copiar ' + escapeHtml(item.email) + '"><i class="ph ph-copy"></i></button>'
    + '</div>'
    + '</article>';
}

function resumo(itens) {
  if (_busca) return itens.length + (itens.length === 1 ? ' resultado' : ' resultados') + ' para "' + _busca + '"';
  const conta = (t) => itens.filter((x) => x.tipo === t).length;
  return [
    [conta('GRUPO'), 'grupos'], [conta('CAIXA'), 'caixas'], [conta('CONTATO'), 'contatos']
  ].filter(([n]) => n > 0).map(([n, r]) => n + ' ' + r).join(' · ');
}

function vazio() {
  const dica = _busca
    ? 'Nada com "' + escapeHtml(_busca) + '". Tente parte do endereço, o setor ou o nome de quem recebe.'
    : 'O catálogo ainda não tem endereços deste tipo. A equipe de TI alimenta essa lista pelo Gestão TI.';
  return '<div class="empty-state"><i class="ph ph-magnifying-glass"></i>'
    + '<h3>Nenhum e-mail encontrado</h3><p>' + dica + '</p></div>';
}

async function carregar() {
  const meu = ++_requisicao;
  $('lista').innerHTML = skeleton();
  $('listaStatus').textContent = '';

  let itens;
  try {
    const params = new URLSearchParams();
    if (_busca) params.set('q', _busca);
    if (_tipo) params.set('tipo', _tipo);
    itens = await api('GET', '/api/emails' + (params.toString() ? '?' + params : ''));
  } catch (err) {
    if (meu !== _requisicao) return;
    $('lista').innerHTML = '<div class="empty-state"><i class="ph ph-warning-circle"></i>'
      + '<h3>Não deu para carregar</h3><p>' + escapeHtml(err.message) + '</p></div>';
    return;
  }

  // Busca antiga que chegou depois da nova: descarta, senão a tela "volta".
  if (meu !== _requisicao) return;

  $('listaStatus').textContent = itens.length ? resumo(itens) : '';
  $('lista').innerHTML = itens.length ? itens.map(card).join('') : vazio();
}

// ---------- Interação ----------
async function copiar(texto, botao) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    // clipboard API exige contexto seguro; em HTTP simples cai aqui.
    const campo = document.createElement('textarea');
    campo.value = texto;
    campo.style.position = 'fixed';
    campo.style.opacity = '0';
    document.body.appendChild(campo);
    campo.select();
    try { document.execCommand('copy'); } catch { toast('Não foi possível copiar.', 'erro'); }
    campo.remove();
  }
  botao.classList.add('copiado');
  botao.innerHTML = '<i class="ph ph-check"></i>';
  setTimeout(() => {
    botao.classList.remove('copiado');
    botao.innerHTML = '<i class="ph ph-copy"></i>';
  }, 1400);
  toast(texto + ' copiado');
}

function configurar() {
  $('busca').addEventListener('input', (ev) => {
    _busca = trim(ev.target.value);
    clearTimeout(_debounce);
    _debounce = setTimeout(carregar, 250);
  });

  $('filtroTipo').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    _tipo = chip.getAttribute('data-tipo') || '';
    [...$('filtroTipo').children].forEach((c) => c.classList.toggle('active', c === chip));
    carregar();
  });

  // "Ver integrantes" vem antes: o botão está dentro do card, que copia — sem
  // esta ordem, expandir a lista copiaria o endereço do grupo.
  function cliqueNaLista(ev) {
    const toggle = ev.target.closest('[data-membros]');
    if (toggle) {
      const alvo = $('membros-' + toggle.getAttribute('data-membros'));
      const aberto = alvo.classList.toggle('aberto');
      toggle.setAttribute('aria-expanded', String(aberto));
      return;
    }

    const origem = ev.target.closest('[data-copiar]');
    if (!origem) return;
    // O feedback (ícone virando check) é sempre no botão do card, mesmo quando
    // o clique veio do card inteiro — trocar o HTML do <article> o apagaria.
    const card = origem.closest('.email-row');
    copiar(origem.getAttribute('data-copiar'), (card || origem).querySelector('.btn-icone') || origem);
  }

  $('lista').addEventListener('click', cliqueNaLista);
  // O card é role="button": teclado tem que fazer o mesmo que o mouse.
  $('lista').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (!ev.target.closest('.email-row')) return;
    ev.preventDefault();
    cliqueNaLista(ev);
  });

  // "/" foca a busca — mesmo atalho do portal de chamados.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const alvo = ev.target;
    if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.isContentEditable)) return;
    ev.preventDefault();
    $('busca').focus();
  });

  $('btnSair').addEventListener('click', sair);

  window.addEventListener('resize', medirTopbar);
  // As fontes do Google chegam depois do primeiro paint e mudam a altura.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(medirTopbar);
}

// A toolbar gruda logo abaixo da topbar, cuja altura vem do conteúdo (muda com
// a fonte carregada e com o breakpoint). Medir evita chutar o valor.
// Só vale depois do login: antes disso o #appBox está com display:none e a
// topbar mede 0 — que faria a toolbar grudar atrás dela.
function medirTopbar() {
  const topbar = document.querySelector('.topbar');
  if (!topbar || !topbar.offsetHeight) return;
  document.documentElement.style.setProperty('--h-topbar', topbar.offsetHeight + 'px');
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

  // Olho de mostrar/ocultar senha (mesmo comportamento do login da Gestão TI)
  const olho = $('olhoSenha');
  if (olho) olho.addEventListener('click', () => {
    const campo = $('loginSenha');
    const mostrar = campo.type === 'password';
    campo.type = mostrar ? 'text' : 'password';
    olho.classList.toggle('ph-eye', !mostrar);
    olho.classList.toggle('ph-eye-slash', mostrar);
    olho.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
  });
}

async function entrar() {
  const perfil = await api('GET', '/api/chamados-intecs/meu-perfil');
  mostrarApp(true);
  $('userEmail').textContent = perfil.email || '';
  $('userAvatar').textContent = iniciais(perfil.email);
  medirTopbar();   // só agora a topbar existe na tela e tem altura
  await carregar();
}

document.addEventListener('DOMContentLoaded', async () => {
  configurarLogin();
  configurar();
  if (TOKEN) {
    try { await entrar(); } catch { sair(); }
  } else {
    mostrarApp(false);
  }
});
