// ============================================================
//  Página /todo — casca do TODO instalável (PWA). A tela em si é a do
//  todo.js, a mesma da aba do admin; aqui só entram: login, sessão, tema e
//  o botão Sair.
//
//  Sessão: usa a MESMA chave 'token' do Gestão TI (mesma origem, mesmo
//  localStorage). Quem já entrou no admin abre o /todo direto, e vice-versa.
//  O JWT vale JWT_EXPIRES_HOURS (12h por padrão): passado isso, a próxima
//  abertura pede login de novo — por biometria, se o celular tiver uma
//  credencial cadastrada pelo Gestão TI (o cadastro continua sendo lá).
//  Sair aqui, portanto, também sai do admin.
// ============================================================
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const lerToken = () => { try { return localStorage.getItem('token') || ''; } catch { return ''; } };
  const guardarToken = (t) => { try { localStorage.setItem('token', t); } catch { /* sem storage: vale só nesta aba */ } };
  const apagarToken = () => { try { localStorage.removeItem('token'); } catch { /* idem */ } };
  let montado = false;

  async function postar(path, corpo) {
    const res = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || ('Erro ' + res.status)); e.status = res.status; throw e; }
    return data;
  }

  function erroLogin(msg) {
    $('alertAuth').innerHTML = `<div class="alert alert-danger py-2"></div>`;
    $('alertAuth').firstChild.textContent = msg;
  }

  function mostrarLogin() {
    document.documentElement.classList.remove('sessao-ativa');
    $('appView').classList.add('hidden');
    $('authView').classList.remove('hidden');
    $('formAuth').classList.remove('hidden');
    $('boxNegado').classList.add('hidden');
    $('formAuth').reset();
    prepararBiometria();
  }

  function sair() {
    apagarToken();
    if (window.TodoTela) window.TodoTela.limpar();
    mostrarLogin();
  }

  // Valida o token guardado e decide entre app, login e "sem acesso".
  async function entrar() {
    const token = lerToken();
    if (!token) return mostrarLogin();
    let res;
    try {
      res = await fetch('/api/chamados-intecs/meu-perfil', { headers: { Authorization: 'Bearer ' + token } });
    } catch {
      // Sem rede: não descarta a sessão à toa — deixa a tela de login com o aviso.
      document.documentElement.classList.remove('sessao-ativa');
      $('authView').classList.remove('hidden');
      return erroLogin('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
    }
    if (res.status === 401) { apagarToken(); return mostrarLogin(); }
    const perfil = await res.json().catch(() => ({}));
    if (!res.ok) { document.documentElement.classList.remove('sessao-ativa'); $('authView').classList.remove('hidden'); return erroLogin(perfil.error || ('Erro ' + res.status)); }

    if (!perfil.permissoes || !perfil.permissoes.aba_todo) {
      document.documentElement.classList.remove('sessao-ativa');
      $('appView').classList.add('hidden');
      $('authView').classList.remove('hidden');
      $('formAuth').classList.add('hidden');
      $('bioOpcao').classList.add('hidden');
      $('negadoEmail').textContent = perfil.email || '';
      $('boxNegado').classList.remove('hidden');
      return;
    }

    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('userEmail').textContent = perfil.email || '';
    if (!montado) {
      montado = true;
      window.TodoTela.montar($('todoRaiz'), { obterToken: lerToken, aoExpirar: sair });
    } else {
      window.TodoTela.recarregar();
    }
  }

  // ---- Biometria (mesmo fluxo do Gestão TI; o cadastro da credencial é lá) ----
  const WA = () => window.SimpleWebAuthnBrowser;
  async function celularComBiometria() {
    const uaMobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    let temPlataforma = false;
    try {
      temPlataforma = !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { temPlataforma = false; }
    return uaMobile && temPlataforma && !!WA();
  }

  async function prepararBiometria() {
    let credId = '';
    try { credId = localStorage.getItem('biometria_cred_id') || ''; } catch { /* sem storage */ }
    if (credId && await celularComBiometria()) {
      $('bioOpcao').classList.remove('hidden');
      entrarComBiometria(true);
    }
  }

  async function entrarComBiometria(automatico) {
    const btn = $('btnEntrarBio');
    btn.disabled = true;
    try {
      const credId = localStorage.getItem('biometria_cred_id') || '';
      const { flowId, options } = await postar('/api/biometric/auth/options', { credId });
      const resposta = await WA().startAuthentication({ optionsJSON: options });
      const data = await postar('/api/biometric/auth/verify', { flowId, response: resposta });
      guardarToken(data.token);
      await entrar();
    } catch (err) {
      if (err && err.status === 404) {
        // Credencial que o servidor não conhece mais: não insiste num botão que sempre falha.
        try { localStorage.removeItem('biometria_cred_id'); } catch { /* sem storage */ }
        $('bioOpcao').classList.add('hidden');
        erroLogin('Essa biometria não está mais cadastrada. Entre com e-mail e senha e ative a biometria de novo no Gestão TI.');
      } else if (!automatico) {
        erroLogin(err && err.name === 'NotAllowedError' ? 'Autenticação cancelada.' : ((err && err.message) || 'Falha na biometria. Use e-mail e senha.'));
      }
    } finally {
      btn.disabled = false;
    }
  }

  function configurar() {
    $('formAuth').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      $('alertAuth').innerHTML = '';
      const email = $('auth_email').value.trim();
      const senha = $('auth_senha').value;
      if (!email || !senha) return erroLogin('Informe e-mail e senha.');
      const btn = $('btnEntrar');
      btn.disabled = true;
      try {
        const data = await postar('/api/auth/login', { email, senha });
        guardarToken(data.token);
        $('auth_senha').value = '';
        await entrar();
      } catch (err) {
        erroLogin(err.message);
      } finally {
        btn.disabled = false;
      }
    });
    $('btnEntrarBio').addEventListener('click', () => entrarComBiometria(false));
    $('btnSair').addEventListener('click', sair);
    $('btnOutraConta').addEventListener('click', sair);

    $('iconVerSenha').addEventListener('click', () => {
      const campo = $('auth_senha');
      const mostrar = campo.type === 'password';
      campo.type = mostrar ? 'text' : 'password';
      $('iconVerSenha').className = mostrar ? 'ph ph-eye-slash' : 'ph ph-eye';
    });

    // Tema: mesma chave e mesmo ícone do Gestão TI.
    const atualizarIcone = () => {
      const escuro = document.documentElement.getAttribute('data-theme') === 'dark';
      $('iconTema').className = escuro ? 'ph ph-sun' : 'ph ph-moon';
      $('btnTemaToggle').title = escuro ? 'Tema claro' : 'Tema escuro';
      $('btnTemaToggle').setAttribute('aria-pressed', String(escuro));
    };
    atualizarIcone();
    $('btnTemaToggle').addEventListener('click', () => {
      const escuro = document.documentElement.getAttribute('data-theme') === 'dark';
      const novo = escuro ? 'light' : 'dark';
      try { localStorage.setItem('tema', novo); } catch { /* sem storage */ }
      window.aplicarTema(novo);
      atualizarIcone();
    });

    // Voltou para o app (ou a aba do admin mudou o token): confere a sessão de novo.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && montado && !$('appView').classList.contains('hidden')) {
        if (!lerToken()) return sair();
        window.TodoTela.recarregar();
      }
    });
  }

  // Service worker: o mesmo do Gestão TI (escopo "/"), que é o que torna a página instalável.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/service-worker.js').catch(() => {}); });
  }

  document.addEventListener('DOMContentLoaded', () => { configurar(); entrar(); });
})();
