// ============================================================
//  Canal de tempo real (SSE) — trafega SINAL, nunca dado
// ============================================================
//  O servidor só avisa "mudou alguma coisa pra você"; quem decide o que
//  recarregar é o cliente, chamando as rotas que já existem. Duas
//  consequências boas: nenhum dado autenticado passa por aqui, e recuperar
//  de uma queda é de graça — o cliente recarrega uma vez e está em dia, sem
//  Last-Event-ID nem buffer de replay.
//
//  ATENÇÃO: o mapa de conexões vive na memória do processo, então isto só
//  funciona com UMA instância. É a mesma restrição já documentada no
//  docker-compose.yml (challenges WebAuthn, cookie do eurosa, lock do Drive).
//  Com duas cópias do processo, cada uma só alcançaria quem está conectada
//  nela.
// ============================================================

const canais = new Map(); // usuarioId -> Set<res>

// Escrita defensiva: o socket pode ter morrido entre o último evento e agora.
// Um write num response destruído emite 'error' sem ouvinte, e no Node 22 isso
// derruba o processo inteiro. A limpeza de verdade acontece no req.on('close')
// da rota; aqui é só não explodir na janela entre uma coisa e outra.
function escrever(res, texto) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write(texto); } catch { /* conexão já foi embora */ }
}

// O nginx corta a conexão em proxy_read_timeout 150s sem tráfego
// (nginx/gestaoti.conf), e proxy corporativo costuma cortar em 60s. Um
// comentário SSE (linha iniciada por ':') mantém o cano vivo sem disparar
// evento nenhum no cliente.
const ping = setInterval(() => {
  for (const conexoes of canais.values()) {
    for (const res of conexoes) escrever(res, ': ping\n\n');
  }
}, 25_000);
ping.unref(); // heartbeat não é motivo para o processo continuar vivo

/**
 * Registra uma conexão SSE e devolve a função que a remove — quem inscreve não
 * precisa conhecer a estrutura interna.
 * @param {number} usuarioId
 * @param {import('node:http').ServerResponse} res
 * @returns {() => void}
 */
export function inscrever(usuarioId, res) {
  const id = Number(usuarioId) || 0;
  if (!id) return () => {};
  let conexoes = canais.get(id);
  if (!conexoes) { conexoes = new Set(); canais.set(id, conexoes); }
  conexoes.add(res);
  return () => {
    const c = canais.get(id);
    if (!c) return;
    c.delete(res);
    if (!c.size) canais.delete(id); // senão o Map vira cemitério de Set vazio
  };
}

// O 'data:' é obrigatório: por spec, um frame sem data não dispara listener
// nenhum no navegador. O valor em si não importa — é o rótulo do evento que
// diz ao cliente o que recarregar.
const frameDe = (evento) => `event: ${evento}\ndata: 1\n\n`;

/**
 * Sinaliza todo mundo que está conectado. É o certo para o sininho: quem
 * realmente tem notificação nova é decidido pelo GET /api/notifications, que
 * filtra pelo usuário do token. Ninguém enxerga nada a mais por causa disto.
 * @param {string} evento
 */
export function emitirTodos(evento) {
  const frame = frameDe(evento);
  for (const conexoes of canais.values()) {
    for (const res of conexoes) escrever(res, frame);
  }
}

/**
 * Sinaliza só os usuários indicados — usado pelo portal /chamados, onde o
 * destinatário é o dono do chamado e mais ninguém.
 * @param {number[]} usuarioIds
 * @param {string} evento
 */
export function emitirPara(usuarioIds, evento) {
  const frame = frameDe(evento);
  for (const uid of new Set((usuarioIds || []).map(Number))) {
    for (const res of canais.get(uid) || []) escrever(res, frame);
  }
}
