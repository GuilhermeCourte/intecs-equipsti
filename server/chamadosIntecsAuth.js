// ============================================================
//  Papéis/permissões: papel (Básico/Gestor/Técnico/Master) do módulo
//  Chamados Intecs + permissões por usuário (abas do admin e afins),
//  estas usadas pelo app inteiro via exigirPermissao().
// ============================================================
import { query, sql } from './db.js';
import { permissoesEfetivas } from './permissoes.js';

const N = (v) => ({ type: sql.Int, value: v == null ? null : Number(v) });

// Busca o perfil do usuário do token e anexa as permissões efetivas
// (padrão do papel + overrides da coluna permissoes).
async function carregarPerfil(req) {
  const r = await query(
    'SELECT id, email, role, unidade, setor, permissoes FROM dbo.EQUIPSTI_usuarios WHERE id = @id',
    { id: N(req.user.sub) }
  );
  const usuario = r.recordset[0];
  if (!usuario) return null;
  usuario.permissoesEfetivas = permissoesEfetivas(usuario.role, usuario.permissoes);
  return usuario;
}

export async function carregarPerfilChamados(req, res, next) {
  try {
    const usuario = await carregarPerfil(req);
    if (!usuario) return res.status(401).json({ error: 'Usuário não encontrado.' });
    req.perfilCI = usuario;
    next();
  } catch (err) {
    next(err);
  }
}

// Middleware por permissão (aba do admin ou funcional). Auto-carrega o
// perfil quando a rota não passou por carregarPerfilChamados.
export function exigirPermissao(chave) {
  return async (req, res, next) => {
    try {
      if (!req.perfilCI) {
        const usuario = await carregarPerfil(req);
        if (!usuario) return res.status(401).json({ error: 'Usuário não encontrado.' });
        req.perfilCI = usuario;
      }
      if (!req.perfilCI.permissoesEfetivas?.[chave]) {
        return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function exigirPapel(...papeis) {
  return (req, res, next) => {
    if (!papeis.includes(req.perfilCI?.role)) {
      return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    }
    next();
  };
}

// Básico/Gestor só veem os próprios chamados + (Gestor) os de usuários da
// mesma unidade+setor cadastrados no próprio perfil do Gestor (sem tabela
// separada de atribuição — o gestor supervisiona a própria unidade/setor).
export async function podeVerChamado(perfil, chamado) {
  if (['TECNICO', 'MASTER'].includes(perfil.role)) return true;
  if (chamado.usuario_id === perfil.id) return true;
  if (perfil.role === 'GESTOR') {
    return isChamadoDaEquipeDoGestor(perfil, chamado);
  }
  return false;
}

async function isChamadoDaEquipeDoGestor(gestorPerfil, chamado) {
  if (!gestorPerfil.unidade || !gestorPerfil.setor) return false;
  const r = await query(
    'SELECT unidade, setor FROM dbo.EQUIPSTI_usuarios WHERE id = @id',
    { id: N(chamado.usuario_id) }
  );
  const abridor = r.recordset[0];
  return !!abridor && abridor.unidade === gestorPerfil.unidade && abridor.setor === gestorPerfil.setor;
}
