// ============================================================
//  Autenticação no Google Workspace: Service Account com
//  delegação em todo o domínio (Domain-Wide Delegation).
//
//  Duas coisas costumam confundir aqui:
//   - a Service Account NÃO tem identidade no Workspace. Sem o "sub"
//     (o admin impersonado) o token até sai, mas a Reports API responde
//     403. Por isso GOOGLE_ADMIN_SUBJECT é obrigatório.
//   - a delegação é liberada no Admin Console (Controles de API >
//     Delegação em todo o domínio), pelo Client ID NUMÉRICO da conta de
//     serviço, e não no GCP. Se faltar, o /token volta
//     "unauthorized_client".
//
//  Sem google-auth-library de propósito: o fluxo JWT-bearer é um POST e
//  uma assinatura RS256, e o jsonwebtoken já é dependência do projeto.
// ============================================================
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ESCOPO = 'https://www.googleapis.com/auth/admin.reports.audit.readonly';

const CLIENT_EMAIL = process.env.GOOGLE_SA_CLIENT_EMAIL || '';
const ADMIN_SUBJECT = process.env.GOOGLE_ADMIN_SUBJECT || '';
// No .env a chave vive em uma linha só, com "\n" literais; se vier com
// quebras de verdade (dotenv multilinha) o replace não faz nada.
const PRIVATE_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Usado pelas rotas e pelo sync periódico para não tentar falar com o
// Google quando ninguém configurou nada ainda.
export function configurado() {
  return Boolean(CLIENT_EMAIL && ADMIN_SUBJECT && PRIVATE_KEY);
}

function exigirConfig() {
  if (!configurado()) {
    throw new Error('Google Workspace não configurado: preencha GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY e GOOGLE_ADMIN_SUBJECT no .env');
  }
}

// { token, expiraEm } — expiraEm em ms (epoch), já com a folga descontada.
let _cache = { token: null, expiraEm: 0 };

// Descarta o token em cache. O cliente chama isto ao levar 401: o token
// pode ter expirado em voo (ou o admin impersonado perdeu o privilégio).
export function invalidarToken() {
  _cache = { token: null, expiraEm: 0 };
}

export async function getAccessToken() {
  exigirConfig();
  if (_cache.token && Date.now() < _cache.expiraEm) return _cache.token;

  const agora = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: CLIENT_EMAIL,
      sub: ADMIN_SUBJECT,   // quem a conta de serviço "vira" no domínio
      scope: ESCOPO,
      aud: TOKEN_URL,
      iat: agora,
      exp: agora + 3600     // o máximo aceito pelo Google
    },
    PRIVATE_KEY,
    { algorithm: 'RS256' }
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }),
    signal: AbortSignal.timeout(20000)
  });

  const texto = await res.text();
  let data;
  try { data = texto ? JSON.parse(texto) : null; } catch { data = null; }

  if (!res.ok || !data?.access_token) {
    // O corpo de erro do Google é { error, error_description } e costuma ser
    // específico o bastante para resolver sozinho ("unauthorized_client" =
    // falta liberar o Client ID na delegação; "invalid_grant" = o e-mail do
    // sub não existe ou não é admin).
    const detalhe = data?.error_description || data?.error || texto.slice(0, 200);
    throw new Error(`Google: falha ao autenticar a conta de serviço (${detalhe})`);
  }

  const validade = Number(data.expires_in) || 3600;
  _cache = { token: data.access_token, expiraEm: Date.now() + (validade - 60) * 1000 };
  return _cache.token;
}
