// Service Worker — estratégia network-first para conteúdo da própria origem
// (mantém o app sempre atualizado) com fallback para cache quando offline.
const CACHE = 'inv-cache-v15';
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

// Push real (Web Push/VAPID) — chega mesmo com o app fechado. Payload é o
// JSON montado em server/push.js: { title, body, url }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Gestão TI', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Gestão TI', {
    body: data.body || '',
    icon: 'icons/icon-192.png?v=4',
    // O badge é a silhueta da status bar do Android: só o canal alpha é usado e
    // pintado de branco. Com o icon-192 (quadrado opaco) virava um borrão sólido,
    // por isso existe um PNG monocromático com fundo transparente só pra isso.
    badge: 'icons/badge-96.png?v=2',
    // Sem vibrate + renotify o Android agrupa e entrega em silêncio a partir da
    // segunda notificação; tag único garante que um alerta não engula o outro.
    vibrate: [200, 100, 200],
    tag: `gti-${Date.now()}`,
    renotify: true,
    silent: false,
    requireInteraction: true,
    timestamp: Date.now(),
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientes) => {
      const existente = clientes.find((c) => 'focus' in c);
      if (existente) return existente.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
