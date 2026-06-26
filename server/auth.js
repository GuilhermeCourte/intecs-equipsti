// ============================================================
//  Autenticação JWT
// ============================================================
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'troque-este-segredo';
const EXPIRES_HOURS = Number(process.env.JWT_EXPIRES_HOURS || 12);

// Configuração WebAuthn (biometria no celular).
export const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
export const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000';
export const RP_NAME = 'Revalidação de Inventário TI';

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
