// ============================================================
//  Serviços no Downdetector — tela pública (/status).
//
//  Catálogo de atalhos, sem login: GET /api/status/servicos é rota
//  aberta e devolve só nomes e links. Quem cadastra e remove é a
//  sub-aba Internet › Serviços do admin.
//
//  O status de cada serviço aparece no Downdetector, ao abrir o link —
//  o servidor não consulta aquele site (403 para qualquer cliente que
//  não seja navegador).
//
//  O desenhador de card é gêmeo do cardServico() de app.js e os dois
//  precisam andar juntos. A duplicação é de propósito: as páginas
//  standalone deste projeto (cockpit, chamados, emails, utils) não
//  compartilham JS, e criar um módulo só para isto obrigaria a mexer
//  no carregamento de todas elas.
// ============================================================
const $ = (id) => document.getElementById(id);

let SERVICOS = [];

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buscaNorm(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function card(s) {
  return '<a class="sv-card" href="' + escapeHtml(s.downdetectorUrl) + '" target="_blank" rel="noopener">' +
    '<span class="sv-nome">' + escapeHtml(s.nome) + '</span>' +
    '<span class="sv-slug">' + escapeHtml(s.slug) + '</span>' +
    '<span class="sv-cta"><i class="ph ph-arrow-square-out"></i> Ver no Downdetector</span>' +
    '</a>';
}

function render() {
  const grid = $('grid');
  if (!SERVICOS.length) {
    grid.innerHTML = '<div class="vazio">Nenhum serviço cadastrado ainda.</div>';
    return;
  }
  const termo = buscaNorm($('busca').value.trim());
  const lista = SERVICOS.filter((s) => !termo ||
    buscaNorm((s.nome || '') + ' ' + (s.slug || '')).includes(termo));
  grid.innerHTML = lista.length
    ? lista.map(card).join('')
    : '<div class="vazio">Nenhum serviço encontrado.</div>';
}

async function carregar() {
  try {
    const r = await fetch('/api/status/servicos', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    SERVICOS = (await r.json()).servicos || [];
    render();
  } catch (err) {
    // Erro inline, nunca modal: a tela é de consulta rápida.
    $('grid').innerHTML = '<div class="erro">Não consegui carregar agora: ' +
      escapeHtml(err.message) + '</div>';
  }
}

$('busca').addEventListener('input', render);
// Sem auto-refresh: a lista só muda quando alguém cadastra ou remove no admin.
carregar();
