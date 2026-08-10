// ============================================================
//  Página /utils — encurtador com login para a pasta de instaladores
//  no Drive (a mesma do antigo bit.ly/prsistemas). Entrou, é redirecionado.
//
//  O destino NÃO fica no HTML de propósito: ele vem de
//  GET /api/utils/destino, que exige login e a permissão utils_acessar.
//  Se o link estivesse no fonte da página, o login seria decoração.
//
//  IMPORTANTE — esta tela é aberta no PC do colaborador. O token vive só
//  nesta variável: nada de localStorage/sessionStorage. Não copiar o
//  padrão do emails.js para cá.
// ============================================================
const $ = (id) => document.getElementById(id);
let TOKEN = '';

function trim(v) { return String(v == null ? '' : v).trim(); }
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, path) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
  return data;
}

async function login(email, senha) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, senha })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
  return data;
}

function erro(msg) {
  $('alertAuth').innerHTML = '<div class="alert alert-danger py-2">' + escapeHtml(msg) + '</div>';
}

// Troca o formulário pelo "Abrindo...". O título, o subtítulo e o aviso de
// sessão falam do formulário: sem ele na tela, viram ruído em volta do aviso
// de que está indo para o Drive.
function mostrarIndo(indo) {
  $('boxLogin').classList.toggle('hidden', indo);
  $('boxIndo').classList.toggle('hidden', !indo);
  for (const sel of ['.auth-title', '.auth-sub', '.auth-nota']) {
    document.querySelector(sel).classList.toggle('hidden', indo);
  }
}

async function entrar() {
  const perfil = await api('GET', '/api/chamados-intecs/meu-perfil');
  if (!perfil.permissoes || !perfil.permissoes.utils_acessar) {
    TOKEN = '';
    throw new Error('Sua conta não tem acesso aos utilitários. Fale com a TI.');
  }

  const destino = await api('GET', '/api/utils/destino');
  if (!destino.url) throw new Error('Pasta de utilitários não configurada. Fale com a TI.');

  // Some com o formulário antes de sair: em conexão lenta, a tela de login
  // parada dá a impressão de que o clique não pegou.
  mostrarIndo(true);
  // replace e não href: o /utils não fica no histórico, então o "voltar" do
  // navegador não devolve o colaborador para uma tela de login.
  location.replace(destino.url);
}

function configurarLogin() {
  const entrarClique = async () => {
    const email = trim($('auth_email').value);
    const senha = $('auth_senha').value;
    const btn = $('btnEntrar');
    $('alertAuth').innerHTML = '';
    if (!email || !senha) return erro('Informe e-mail e senha.');

    btn.disabled = true;
    try {
      const data = await login(email, senha);
      TOKEN = data.token;   // só aqui: nada vai para o disco da máquina
      $('auth_senha').value = '';
      await entrar();
    } catch (err) {
      TOKEN = '';
      mostrarIndo(false);   // deu errado no meio do caminho: formulário de volta
      erro(err.message);
    } finally {
      btn.disabled = false;
    }
  };

  $('btnEntrar').addEventListener('click', entrarClique);
  // Sem <form>, o Enter não submete sozinho — e é justamente o submit que faz o
  // navegador oferecer "salvar senha".
  for (const id of ['auth_email', 'auth_senha']) {
    $(id).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); entrarClique(); }
    });
  }

  const olho = $('iconVerSenha');
  olho.addEventListener('click', () => {
    const campo = $('auth_senha');
    const mostrar = campo.type === 'password';
    campo.type = mostrar ? 'text' : 'password';
    olho.classList.toggle('ph-eye', !mostrar);
    olho.classList.toggle('ph-eye-slash', mostrar);
    olho.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
  });
}

document.addEventListener('DOMContentLoaded', configurarLogin);
