// ============================================================
//  Conteúdo da pasta de utilitários no Drive (Drive API v3) — o que a
//  aba "Utilitários" do Gestão TI mostra. Só leitura: o GTI lista, e
//  quem publica arquivo continua fazendo isso pelo Drive.
//
//  Mesmo desenho do client.js da Reports API: fetch nativo, timeout e
//  retry curto. Duas diferenças que valem o comentário:
//   - o escopo aqui é o drive.readonly, que tem token próprio (ver auth.js);
//   - toda chamada leva supportsAllDrives/includeItemsFromAllDrives, senão a
//     pasta some da resposta caso um dia ela vá para um Drive compartilhado.
// ============================================================
import { getAccessToken, invalidarToken, ESCOPO_DRIVE } from './auth.js';

const BASE_URL = 'https://www.googleapis.com/drive/v3';
const MIME_PASTA = 'application/vnd.google-apps.folder';

// 200 já traz a pasta inteira numa tacada no uso real; a paginação existe
// para não depender disso.
const PAGE_SIZE = 200;

// Teto de saltos ao subir pelos parents. Protege contra pasta muito aninhada
// (e contra um ciclo, que o Drive não deveria produzir, mas sai barato cobrir).
const MAX_SALTOS = 10;

// Aceita tanto o ID puro quanto a URL da pasta colada do navegador — é o erro
// de digitação mais provável no .env.
export const RAIZ = String(process.env.GOOGLE_DRIVE_UTILS_FOLDER_ID || '')
  .trim()
  .replace(/^.*\/folders\//, '')
  .split(/[?#]/)[0];

export function raizConfigurada() {
  return Boolean(RAIZ);
}

export function urlDaPasta(id = RAIZ) {
  return id ? 'https://drive.google.com/drive/folders/' + id : null;
}

async function driveRequest(caminho, params, { retry5xx = true, retryAuth = true } = {}) {
  const token = await getAccessToken(ESCOPO_DRIVE);
  const url = BASE_URL + caminho + '?' + new URLSearchParams({
    supportsAllDrives: 'true',
    ...params
  }).toString();

  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });

  // Token expirado em voo: joga fora o que está em cache (só o do Drive) e
  // tenta uma vez com um token novo.
  if (res.status === 401 && retryAuth) {
    invalidarToken(ESCOPO_DRIVE);
    return driveRequest(caminho, params, { retry5xx, retryAuth: false });
  }
  if (res.status >= 500 && retry5xx) {
    return driveRequest(caminho, params, { retry5xx: false, retryAuth });
  }

  const texto = await res.text();
  let data;
  try { data = texto ? JSON.parse(texto) : null; } catch { data = null; }

  if (!res.ok) {
    const detalhe = data?.error?.message || `erro ${res.status}`;
    // As duas falhas de setup que realmente acontecem aqui.
    const dica = res.status === 403
      ? ' — confira se o escopo drive.readonly está liberado na delegação em todo o domínio'
      : res.status === 404
        ? ' — confira o GOOGLE_DRIVE_UTILS_FOLDER_ID e se a pasta está compartilhada'
        : '';
    throw new Error(`Google Drive API: ${detalhe}${dica}`);
  }

  return data || {};
}

// Arquivos nativos do Google (Docs/Sheets) não têm webContentLink: para eles o
// "baixar" vira "abrir no Drive", que é o comportamento honesto. Pasta também
// não tem: o zip de uma pasta é montado pela interface do Drive.
function normalizar(f) {
  const pasta = f.mimeType === MIME_PASTA;
  return {
    id: f.id,
    nome: f.name || '(sem nome)',
    tipo: pasta ? 'pasta' : 'arquivo',
    mime: f.mimeType || '',
    tamanho: f.size ? Number(f.size) : null,
    modificadoEm: f.modifiedTime || null,
    url: pasta ? (f.webViewLink || null) : (f.webContentLink || f.webViewLink || null),
    // false = o link abre no Drive em vez de baixar direto.
    direto: Boolean(f.webContentLink)
  };
}

/** Conteúdo de uma pasta, pastas primeiro e em ordem natural de nome. */
export async function listarPasta(pastaId) {
  const itens = [];
  let pageToken = null;

  do {
    const data = await driveRequest('/files', {
      q: `'${pastaId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink)',
      orderBy: 'folder,name_natural',
      pageSize: String(PAGE_SIZE),
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {})
    });
    for (const f of data.files || []) itens.push(normalizar(f));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return itens;
}

// ---------- Busca em toda a árvore ----------
// A Drive API não sabe filtrar "descendentes de X": o `in parents` é de um nível
// só. Então a busca varre a árvore inteira uma vez e guarda o resultado; sem o
// cache, cada tecla digitada custaria uma chamada por pasta.
const TTL_INDICE_MS = 5 * 60 * 1000;
const MAX_PASTAS = 300;      // teto de segurança contra uma árvore fora do normal
const MAX_RESULTADOS = 200;

let _indice = { em: 0, itens: [] };

async function indexar(forcar = false) {
  if (!forcar && _indice.itens.length && Date.now() - _indice.em < TTL_INDICE_MS) {
    return _indice.itens;
  }

  const itens = [];
  const fila = [{ id: RAIZ, caminho: [] }];
  let visitadas = 0;

  while (fila.length && visitadas < MAX_PASTAS) {
    const atual = fila.shift();
    visitadas++;
    const conteudo = await listarPasta(atual.id);
    for (const item of conteudo) {
      itens.push({ ...item, caminho: atual.caminho.join(' / ') });
      if (item.tipo === 'pasta') fila.push({ id: item.id, caminho: [...atual.caminho, item.nome] });
    }
  }

  _indice = { em: Date.now(), itens };
  return itens;
}

/** Busca por nome em todas as pastas abaixo da raiz. */
export async function buscar(termo, { forcar = false } = {}) {
  const itens = await indexar(forcar);
  const alvo = termo.toLowerCase();
  return itens
    .filter((i) => i.nome.toLowerCase().includes(alvo))
    .slice(0, MAX_RESULTADOS);
}

export async function obterPasta(pastaId) {
  return driveRequest(`/files/${encodeURIComponent(pastaId)}`, {
    fields: 'id,name,mimeType,parents,webViewLink'
  });
}

/**
 * Caminho da raiz até a pasta pedida, para a trilha — e, de quebra, a prova de
 * que a pasta descende da raiz. Sem isto o endpoint viraria um navegador livre
 * do Drive para quem tivesse token.
 * @returns {Promise<Array<{id:string,nome:string,url:string|null}>|null>} null se não descende.
 */
export async function caminhoAteRaiz(pastaId, raizId = RAIZ) {
  const caminho = [];
  let atual = pastaId;

  for (let i = 0; i < MAX_SALTOS; i++) {
    const f = await obterPasta(atual);
    if (f.mimeType !== MIME_PASTA) return null;
    caminho.unshift({ id: f.id, nome: f.name || '(sem nome)', url: f.webViewLink || null });
    if (f.id === raizId) return caminho;
    const pai = (f.parents || [])[0];
    if (!pai) return null;
    atual = pai;
  }
  return null;
}
