// Service Worker — estratégia network-first para conteúdo da própria origem
// (mantém o app sempre atualizado) com fallback para cache quando offline.
const CACHE = 'inv-cache-v14';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  // O cockpit fica ligado numa tela o dia inteiro: precisa sobreviver a uma
  // queda de rede mostrando o último estado, e não a tela de offline.
  './cockpit.html',
  './cockpit.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Deixa requisições externas (CDNs de Bootstrap, Choices, Phosphor) irem direto à rede.
  if (url.origin !== self.location.origin) return;
  // Nunca cachear /api/*: resposta autenticada não deve persistir no disco —
  // e, sendo network-first, esse cache nunca acelerava o caminho online.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      // /cockpit é servido pelo Node a partir de cockpit.html — sem este desvio
      // a tela de parede cairia no index.html offline, que é o app inteiro.
      .catch(() => caches.match(req).then((r) =>
        r || caches.match(url.pathname === '/cockpit' ? './cockpit.html' : './index.html')))
  );
});
