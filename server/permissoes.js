// ============================================================
//  Catálogo de permissões por usuário.
//  Cada papel (BASICO/GESTOR/TECNICO/MASTER) tem um conjunto padrão;
//  a coluna EQUIPSTI_usuarios.permissoes (JSON) guarda SÓ os overrides
//  do usuário em relação ao padrão do papel (NULL = padrão puro).
//  Usuário com override efetivo aparece como "PAPEL+" nas listagens.
// ============================================================

// Abas do admin (index.html) na ordem da nav.
const ABAS = [
  'aba_dashboard',
  'aba_registros',
  'aba_emprestimos',
  'aba_chamados',
  'aba_conexao',
  'aba_internet',
  'aba_calendario',
  'aba_gerenciar',
  'aba_usuarios',
  'aba_logs'
];

// Permissões funcionais (não são abas).
const FUNCIONAIS = ['chamados_ver_todas_maquinas'];

export const CHAVES_PERMISSOES = [...ABAS, ...FUNCIONAIS];

export const ROTULOS = {
  aba_dashboard: 'Dashboard',
  aba_registros: 'Registros',
  aba_emprestimos: 'Empréstimos',
  aba_chamados: 'GTI - Chamados',
  aba_conexao: 'Conexão Remota',
  aba_internet: 'Internet',
  aba_calendario: 'Calendário',
  aba_gerenciar: 'Opções',
  aba_usuarios: 'Usuários',
  aba_logs: 'Logs',
  chamados_ver_todas_maquinas: 'Ver todas as máquinas no portal de chamados'
};

const PAPEIS = ['BASICO', 'GESTOR', 'TECNICO', 'MASTER'];

function conjunto(abasLigadas, funcionaisLigadas = []) {
  const p = {};
  for (const k of ABAS) p[k] = abasLigadas.includes(k);
  for (const k of FUNCIONAIS) p[k] = funcionaisLigadas.includes(k);
  return p;
}

// MASTER: todas as abas. TECNICO: todas MENOS Logs (auditoria é sensível —
// altera usuários/permissões; libera-se por usuário, virando "TECNICO+").
// GESTOR/BASICO: só GTI - Chamados.
// Ver todas as máquinas no portal: só TECNICO por padrão (MASTER liga por usuário).
export const PADROES_POR_PAPEL = {
  BASICO: conjunto(['aba_chamados']),
  GESTOR: conjunto(['aba_chamados']),
  TECNICO: conjunto(ABAS.filter((k) => k !== 'aba_logs'), ['chamados_ver_todas_maquinas']),
  MASTER: conjunto(ABAS)
};

export function papelValido(role) {
  return PAPEIS.includes(role);
}

// Papel desconhecido cai no mais restritivo (BASICO).
export function padraoDoPapel(role) {
  return { ...(PADROES_POR_PAPEL[role] || PADROES_POR_PAPEL.BASICO) };
}

// Padrão do papel + overrides gravados (JSON). Ignora lixo: JSON inválido,
// chaves fora do catálogo e valores não-booleanos.
export function permissoesEfetivas(role, permissoesJson) {
  const efetivas = padraoDoPapel(role);
  if (permissoesJson) {
    try {
      const overrides = JSON.parse(permissoesJson);
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const [k, v] of Object.entries(overrides)) {
          if (CHAVES_PERMISSOES.includes(k) && typeof v === 'boolean') efetivas[k] = v;
        }
      }
    } catch { /* JSON inválido no banco → usa o padrão */ }
  }
  return efetivas;
}

// Diff entre o desejado e o padrão do papel; null se não há diferença
// (aí a coluna volta a NULL e o usuário deixa de ser "PAPEL+").
export function calcularOverrides(role, efetivasDesejadas) {
  const padrao = padraoDoPapel(role);
  const diff = {};
  for (const k of CHAVES_PERMISSOES) {
    if (typeof efetivasDesejadas[k] === 'boolean' && efetivasDesejadas[k] !== padrao[k]) {
      diff[k] = efetivasDesejadas[k];
    }
  }
  return Object.keys(diff).length ? diff : null;
}

export function validarPermissoes(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, erro: 'permissoes deve ser um objeto.' };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!CHAVES_PERMISSOES.includes(k)) return { ok: false, erro: `Permissão desconhecida: ${k}` };
    if (typeof v !== 'boolean') return { ok: false, erro: `Valor inválido em ${k} (esperado true/false).` };
  }
  return { ok: true };
}

// "PAPEL+": há override efetivo? Recalcula o diff em vez de olhar só
// IS NOT NULL — JSON que coincide com o padrão não conta como customizado.
export function isCustomizado(role, permissoesJson) {
  return calcularOverrides(role, permissoesEfetivas(role, permissoesJson)) !== null;
}
