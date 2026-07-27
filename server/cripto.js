// ============================================================
//  Cifra simétrica (AES-256-GCM) para dados que precisam voltar
//  legíveis (senhas de acesso físico das portas — hash não serve
//  aqui, o técnico precisa ler o valor para digitar no teclado).
//
//  Chave: SENHAS_CHAVE no .env, 32 bytes em hex (64 caracteres).
//  Gerar com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
//  Pacote cifrado: "ivB64:tagB64:ciphertextB64".
// ============================================================
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITMO = 'aes-256-gcm';

function lerChave() {
  const hex = process.env.SENHAS_CHAVE || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

export function chaveConfigurada() {
  return lerChave() !== null;
}

export function cifrar(texto) {
  const chave = lerChave();
  if (!chave) throw new Error('SENHAS_CHAVE não configurada no .env.');
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv(ALGORITMO, chave, iv);
  const ciphertext = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decifrar(pacote) {
  const chave = lerChave();
  if (!chave) throw new Error('SENHAS_CHAVE não configurada no .env.');
  const [ivB64, tagB64, ctB64] = String(pacote || '').split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Pacote cifrado inválido.');
  const decifra = crypto.createDecipheriv(ALGORITMO, chave, Buffer.from(ivB64, 'base64'));
  decifra.setAuthTag(Buffer.from(tagB64, 'base64'));
  const texto = Buffer.concat([decifra.update(Buffer.from(ctB64, 'base64')), decifra.final()]);
  return texto.toString('utf8');
}
