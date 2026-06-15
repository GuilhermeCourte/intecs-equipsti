// ============================================================
//  Autenticação JWT
// ============================================================
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'troque-este-segredo';
const EXPIRES_HOURS = Number(process.env.JWT_EXPIRES_HOURS || 12);

export function gerarToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, email: usuario.email },
    SECRET,
    { expiresIn: EXPIRES_HOURS * 3600 }
  );
}

// Middleware: exige um Bearer token válido.
export function exigirAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada ou inválida.' });
  }
}
