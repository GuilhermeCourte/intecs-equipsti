// ============================================================
//  Parser da página de grupos do painel da Locaweb.
//
//  Por que existe: o login do painel é CAS com reCAPTCHA de imagem
//  obrigatório, então não há como o servidor buscar esses dados
//  sozinho. A coleta é assistida — a TI, já logada no navegador,
//  entrega o HTML de
//    painel-email.locaweb.com.br/domains/<dominio>/groups?per_page=200
//  e este módulo extrai dele TUDO que precisamos: os grupos (com
//  integrantes) e a lista completa de caixas postais, que a própria
//  página embute em <script> para alimentar o seletor de "adicionar
//  integrante".
//
//  Módulo puro (texto → objeto, sem I/O) para ser testável com o
//  HTML real capturado no HAR.
// ============================================================

// Os valores vêm dentro de aspas simples num <script>, escapados pelo
// escape_javascript do Rails.
function desescapar(v) {
  return String(v ?? '')
    .replace(/\\r\\n|\\n|\\r/g, ' ')
    .replace(/\\(['"\\/])/g, '$1')
    .trim();
}

// Texto que vem do HTML visível (nome da caixa, descrição do grupo) traz
// entidades: "D'Antonio" chega como "D&#39;Antonio". A tela escapa de novo ao
// exibir, então sem decodificar aqui o código aparece literal.
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodificarEntidades(v) {
  return desescapar(v).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (todo, dec, hex, nome) => {
    if (nome) return ENTIDADES[nome.toLowerCase()] ?? todo;
    return String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
  });
}

function dominioDe(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}

// Domínio do painel, tirado de qualquer link para /domains/<dominio>.
// Aceita href relativo (HTML cru, como vem do bookmarklet) e absoluto — o
// "Salvar página" do Chrome reescreve tudo para https://painel-email...
function dominioDaUrl(html) {
  return /\/domains\/([^/"'?#\s]+)/.exec(html)?.[1] || '';
}

// Domínio que mais aparece numa lista de endereços.
function dominioPredominante(emails) {
  const contagem = new Map();
  for (const e of emails) {
    const d = dominioDe(e);
    if (d) contagem.set(d, (contagem.get(d) || 0) + 1);
  }
  let vencedor = '';
  let max = 0;
  for (const [d, n] of contagem) if (n > max) { vencedor = d; max = n; }
  return vencedor;
}

// Layout atual do painel: sem <script> com window.groups; cada grupo é um
// bloco visível (messageInfo) com e-mail, descrição e a lista de integrantes.
const MARCO_GRUPO = /<span class="name"><strong>([^<]+)<\/strong><\/span>/g;

function ehLayoutNovoGrupos(html) {
  return /class="messageInfo/.test(html) && /<span class="name"><strong>/.test(html) && /id="list_\d+"/.test(html);
}

function parseGruposLayoutNovo(html) {
  const marcos = [...html.matchAll(MARCO_GRUPO)];
  const dominio = (dominioDaUrl(html)
    || dominioPredominante(marcos.map((m) => m[1].trim()))).toLowerCase();

  const grupos = marcos.map((m, i) => {
    const bloco = html.slice(m.index, i + 1 < marcos.length ? marcos[i + 1].index : html.length);
    const lista = /id="list_(\d+)"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/.exec(bloco);
    const email = desescapar(m[1]).toLowerCase();
    return {
      externoId: lista?.[1] || '',
      email,
      apelido: /\/groups\/([^/"?]+)\/edit/.exec(bloco)?.[1] || email.split('@')[0],
      nome: decodificarEntidades(/<span class="ellipsis">([^<]*)<\/span>/.exec(bloco)?.[1] || ''),
      membros: [...(lista?.[2] || '').matchAll(/<li>\s*([^<\s]+@[^<\s]+)\s*<\/li>/g)]
        .map((g) => g[1].trim().toLowerCase())
        .map((e) => ({ email: e, tipo: dominioDe(e) === dominio ? 'internal' : 'external' }))
    };
  }).filter((g) => g.email.includes('@'));

  if (!grupos.length) {
    throw new Error('Nenhum grupo reconhecido no conteúdo enviado — o painel da Locaweb pode ter mudado.');
  }
  // A página mostra "51 grupos" (total do domínio) mas só lista uma fatia
  // (per_page máx. 50). Fatia incompleta não pode inativar os grupos que estão
  // em outra página.
  const total = Number(/(\d+)\s+grupos\s*<\/span>/.exec(html)?.[1]) || grupos.length;
  return { dominio, dominioHospedagem: '', grupos, caixas: [], parcial: grupos.length < total };
}

/**
 * Lê o HTML (ou só o trecho de <script>) da página de grupos.
 *
 * @param {string} texto  HTML cru da página
 * @returns {{ dominio: string, dominioHospedagem: string,
 *   grupos: Array<{ externoId: string, email: string, nome: string, apelido: string,
 *                   membros: Array<{ email: string, tipo: 'internal'|'external' }> }>,
 *   caixas: Array<{ externoId: string, email: string }> }}
 * @throws se o conteúdo não for a página esperada — melhor estourar do que
 *   importar zero registro em silêncio e passar por "sincronizado".
 */
export function parsePainelGrupos(texto) {
  const html = String(texto || '');
  if (!html.includes('window.groups[') && ehLayoutNovoGrupos(html)) {
    return parseGruposLayoutNovo(html);
  }
  if (!html.includes('window.groups[')) {
    throw new Error('Conteúdo não parece a página de grupos do painel Locaweb. Abra /domains/<dominio>/groups?per_page=200 no painel e copie o HTML dessa página.');
  }

  // As caixas vêm do seletor de integrantes, no domínio interno de
  // hospedagem (ex.: fulano@intecsbr1.hospedagemdesites.ws).
  const caixasCruas = [...html.matchAll(/new MailboxObj\('([^']*)','([^']*)'\)/g)]
    .map((m) => ({ email: desescapar(m[1]).toLowerCase(), externoId: desescapar(m[2]) }))
    .filter((c) => c.email.includes('@'));

  // Cada grupo é um bloco "_group = new Group(); ... window.groups[<id>] = _group;".
  const gruposCrus = [...html.matchAll(/_group = new Group\(\);([\s\S]*?)window\.groups\[(\d+)\]\s*=\s*_group;/g)]
    .map((m) => {
      const bloco = m[1];
      const valor = (campo) => {
        const achou = new RegExp(`_group\\.group_${campo} = '((?:[^'\\\\]|\\\\.)*)'`).exec(bloco);
        return achou ? desescapar(achou[1]) : '';
      };
      return {
        externoId: m[2],
        email: valor('email').toLowerCase(),
        apelido: valor('name'),
        nome: valor('description'),
        membros: [...bloco.matchAll(/new GroupMember\('([^']*)','([^']*)','([^']*)'\)/g)]
          .map((g) => ({ email: desescapar(g[1]).toLowerCase(), tipo: desescapar(g[3]) || 'internal' }))
          .filter((g) => g.email.includes('@'))
      };
    })
    .filter((g) => g.email);

  if (!gruposCrus.length) {
    throw new Error('Nenhum grupo reconhecido no conteúdo enviado — o painel da Locaweb pode ter mudado.');
  }

  // Domínio público (intecsbr.org) vem de um link para /domains/<dominio>; se a
  // página mudar de layout, o domínio dos próprios e-mails de grupo é a reserva.
  const dominio = (dominioDaUrl(html)
    || dominioPredominante(gruposCrus.map((g) => g.email))).toLowerCase();

  // Domínio interno da hospedagem: é o que aparece nas caixas. Todo endereço
  // nele é o mesmo endereço no domínio público — é assim que a pessoa escreve.
  const dominioHospedagem = dominioPredominante(caixasCruas.map((c) => c.email));
  const publicar = (email) => (dominioHospedagem && dominioDe(email) === dominioHospedagem
    ? `${email.split('@')[0]}@${dominio}`
    : email);

  return {
    dominio,
    dominioHospedagem,
    grupos: gruposCrus.map((g) => ({
      ...g,
      membros: g.membros.map((m) => ({ ...m, email: publicar(m.email) }))
    })),
    // Aqui a caixa vem só com endereço e id: o nome e o "Desativada" existem
    // apenas na página de caixas postais (parsePainelCaixas).
    caixas: caixasCruas.map((c) => ({ ...c, email: publicar(c.email) }))
  };
}

/**
 * Lê o HTML da página de caixas postais
 * (/domains/<dominio>/mailboxes?per_page=200).
 *
 * É a única que traz duas coisas que a página de grupos não tem: o NOME da
 * caixa ("Assistente Administrativo CTJ") e o estado "Desativada" — conta que
 * ainda existe no painel mas não recebe mais e-mail, e portanto não pode ficar
 * no buscador.
 *
 * @param {string} texto HTML cru da página
 * @returns {{ dominio: string, caixas: Array<{ externoId, email, nome, desativada }> }}
 * @throws se não for a página esperada.
 */
export function parsePainelCaixas(texto) {
  const html = String(texto || '');
  if (!/check_for_action/.test(html) || !/Editar e-mail/.test(html)) {
    throw new Error('Conteúdo não parece a página de caixas postais do painel Locaweb. Abra /domains/<dominio>/mailboxes?per_page=200 no painel e copie o HTML dessa página.');
  }

  // O checkbox de ação é o marco estável de cada linha (o <tr> muda de formato
  // entre o HTML cru do servidor e o DOM serializado do navegador). Cada caixa
  // é o pedaço entre um checkbox e o próximo.
  // O value já foi um id numérico; hoje é o nome da caixa (waldir.carvalho).
  const marcos = [...html.matchAll(/<input[^>]*class="check_for_action"[^>]*value="([^"]+)"/g)];
  const caixas = marcos.map((m, i) => {
    const bloco = html.slice(m.index, i + 1 < marcos.length ? marcos[i + 1].index : html.length);
    return {
      externoId: m[1],
      // O aria-label do link "Editar" carrega o endereço completo e já no
      // domínio público — mais confiável que o texto solto da célula.
      email: (/aria-label="Editar e-mail ([^"]+)"/.exec(bloco)?.[1] || '').trim().toLowerCase(),
      nome: decodificarEntidades(/<strong[^>]*>\s*<a [^>]*>([^<]*)<\/a>/.exec(bloco)?.[1] || ''),
      desativada: /label[^>]*>\s*Desativada\s*</.test(bloco)
    };
  }).filter((c) => c.email.includes('@'));

  if (!caixas.length) {
    throw new Error('Nenhuma caixa postal reconhecida no conteúdo enviado — o painel da Locaweb pode ter mudado.');
  }

  return {
    dominio: (dominioDaUrl(html) || dominioPredominante(caixas.map((c) => c.email))).toLowerCase(),
    caixas
  };
}

/**
 * Reconhece qual das duas páginas do painel foi colada e devolve o resultado
 * já rotulado. Quem importa não precisa escolher: cola o que copiou.
 *
 * @returns {{ pagina: 'GRUPOS'|'CAIXAS', dominio: string, grupos: Array, caixas: Array }}
 */
export function parsePainelLocaweb(texto) {
  const html = String(texto || '');
  if (html.includes('window.groups[') || ehLayoutNovoGrupos(html)) {
    return { pagina: 'GRUPOS', grupos: [], caixas: [], ...parsePainelGrupos(html) };
  }
  if (/check_for_action/.test(html) && /Editar e-mail/.test(html)) {
    return { pagina: 'CAIXAS', grupos: [], ...parsePainelCaixas(html) };
  }
  throw new Error('Conteúdo não reconhecido. Cole o HTML da página de grupos (/groups?per_page=200) ou da de caixas postais (/mailboxes?per_page=200) do painel da Locaweb.');
}
