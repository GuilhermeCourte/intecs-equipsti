// ============================================================
//  WebAuthn / FIDO2 — biometria (digital/rosto) no celular.
//  Wrappers do @simplewebauthn/server + store temporário de challenges.
// ============================================================
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server';

import { RP_ID, ORIGIN, RP_NAME } from './auth.js';

// Challenges pendentes: chave -> { challenge, expira }. TTL curto (5 min).
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();

function guardarChallenge(chave, challenge) {
  challenges.set(chave, { challenge, expira: Date.now() + CHALLENGE_TTL_MS });
}

function consumirChallenge(chave) {
  const item = challenges.get(chave);
  challenges.delete(chave);
  if (!item || item.expira < Date.now()) return null;
  return item.challenge;
}

// ---- base64url <-> Uint8Array ----
const b64 = (u8) => Buffer.from(u8).toString('base64url');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const userIdBytes = (id) => new Uint8Array(Buffer.from(String(id), 'utf8'));

// ===================== REGISTRO =====================
export async function opcoesRegistro(usuarioId, email, credenciaisExistentes) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: userIdBytes(usuarioId),
    userName: email,
    userDisplayName: email,
    attestationType: 'none',
    excludeCredentials: credenciaisExistentes.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? c.transports.split(',') : undefined
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required'
    }
  });
  guardarChallenge('reg:' + usuarioId, options.challenge);
  return options;
}

export async function verificarRegistro(usuarioId, response) {
  const expectedChallenge = consumirChallenge('reg:' + usuarioId);
  if (!expectedChallenge) throw new Error('Desafio expirado. Tente novamente.');

  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true
  });
  if (!verified || !registrationInfo) throw new Error('Não foi possível validar a biometria.');

  const { credential } = registrationInfo;
  return {
    credentialId: credential.id, // já é base64url
    publicKey: b64(credential.publicKey),
    counter: credential.counter || 0,
    transports: (credential.transports || []).join(',') || null
  };
}

// ===================== AUTENTICAÇÃO =====================
export async function opcoesAutenticacao() {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required'
    // sem allowCredentials: credencial descobrível (login sem digitar email)
  });
  const flowId = crypto.randomUUID();
  guardarChallenge('auth:' + flowId, options.challenge);
  return { flowId, options };
}

export async function verificarAutenticacao(flowId, response, cred) {
  const expectedChallenge = consumirChallenge('auth:' + flowId);
  if (!expectedChallenge) throw new Error('Desafio expirado. Tente novamente.');

  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential: {
      id: cred.credential_id,
      publicKey: fromB64(cred.public_key),
      counter: Number(cred.counter),
      transports: cred.transports ? cred.transports.split(',') : undefined
    }
  });
  if (!verified) throw new Error('Biometria não reconhecida.');
  return { newCounter: authenticationInfo.newCounter };
}
