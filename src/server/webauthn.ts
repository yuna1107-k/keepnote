import { Buffer } from 'node:buffer';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { cfg } from './config.ts';
import { all, get, run, toBytes } from './db.ts';
import { getSettings } from './settings.ts';
import type { UserRow } from './users.ts';
import { fail, newId, now } from './util.ts';

const CHALLENGE_TTL = 5 * 60_000;

export type CredentialRow = {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  aaguid: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
};

export function publicCredential(c: CredentialRow) {
  return {
    id: c.id,
    name: c.name,
    deviceType: c.device_type,
    backedUp: !!c.backed_up,
    createdAt: c.created_at,
    lastUsedAt: c.last_used_at,
  };
}

async function saveChallenge(challenge: string, purpose: 'register' | 'login', userId?: string, tokenId?: string) {
  const id = newId();
  await run(
    'INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, token_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    challenge,
    purpose,
    userId ?? null,
    tokenId ?? null,
    now() + CHALLENGE_TTL,
  );
  return id;
}

/** チャレンジを取り出して即座に削除する（使い回し防止） */
async function consumeChallenge(id: string, purpose: 'register' | 'login') {
  const row = await get<{ challenge: string; purpose: string; user_id: string | null; token_id: string | null; expires_at: number }>(
    'SELECT * FROM webauthn_challenges WHERE id = ?',
    id,
  );
  await run('DELETE FROM webauthn_challenges WHERE id = ?', id);
  if (!row || row.purpose !== purpose || row.expires_at < now()) {
    fail(400, '認証の有効期限が切れました。もう一度お試しください');
  }
  return row;
}

export async function purgeExpiredChallenges() {
  await run('DELETE FROM webauthn_challenges WHERE expires_at < ?', now());
}

export async function startRegistration(user: UserRow, tokenId?: string) {
  const existing = await all<{ id: string; transports: string | null }>(
    'SELECT id, transports FROM credentials WHERE user_id = ?',
    user.id,
  );
  const options = await generateRegistrationOptions({
    rpName: (await getSettings()).serviceName,
    rpID: cfg.RP_ID,
    userName: user.username,
    userDisplayName: user.display_name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
  });
  const challengeId = await saveChallenge(options.challenge, 'register', user.id, tokenId);
  return { options, challengeId };
}

export async function finishRegistration(params: {
  user: UserRow;
  challengeId: string;
  response: RegistrationResponseJSON;
  name: string;
  tokenId?: string;
}) {
  const ch = await consumeChallenge(params.challengeId, 'register');
  if (ch.user_id !== params.user.id || (params.tokenId && ch.token_id !== params.tokenId)) {
    fail(400, '不正なリクエストです');
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: cfg.ORIGIN,
      expectedRPID: cfg.RP_ID,
      requireUserVerification: true,
    });
  } catch (err) {
    fail(400, `パスキーの検証に失敗しました: ${(err as Error).message}`);
  }
  if (!verification.verified) fail(400, 'パスキーの検証に失敗しました');
  const info = verification.registrationInfo;
  if (await get('SELECT 1 FROM credentials WHERE id = ?', info.credential.id)) {
    fail(409, 'このパスキーは既に登録されています');
  }
  await run(
    `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    info.credential.id,
    params.user.id,
    info.credential.publicKey,
    info.credential.counter,
    JSON.stringify(info.credential.transports ?? params.response.response.transports ?? []),
    info.credentialDeviceType,
    info.credentialBackedUp ? 1 : 0,
    info.aaguid,
    params.name.slice(0, 64) || 'パスキー',
    now(),
  );
  return info.credential.id;
}

export async function startLogin() {
  const options = await generateAuthenticationOptions({
    rpID: cfg.RP_ID,
    userVerification: 'required',
    allowCredentials: [],
  });
  const challengeId = await saveChallenge(options.challenge, 'login');
  return { options, challengeId };
}

export async function finishLogin(challengeId: string, response: AuthenticationResponseJSON) {
  const ch = await consumeChallenge(challengeId, 'login');
  const cred = await get<CredentialRow>('SELECT * FROM credentials WHERE id = ?', response.id);
  if (!cred) return { ok: false as const, reason: 'unknown_credential' };

  const user = (await get<UserRow>('SELECT * FROM users WHERE id = ?', cred.user_id))!;
  const userHandle = response.response.userHandle;
  if (userHandle) {
    const decoded = Buffer.from(userHandle, 'base64url').toString('utf8');
    if (decoded !== user.id) return { ok: false as const, reason: 'user_handle_mismatch', user };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: cfg.ORIGIN,
      expectedRPID: cfg.RP_ID,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: toBytes(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    });
  } catch {
    return { ok: false as const, reason: 'verification_error', user };
  }
  if (!verification.verified) return { ok: false as const, reason: 'not_verified', user };
  if (user.status !== 'active') return { ok: false as const, reason: 'user_' + user.status, user };

  await run(
    'UPDATE credentials SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ?',
    verification.authenticationInfo.newCounter,
    now(),
    verification.authenticationInfo.credentialBackedUp ? 1 : 0,
    cred.id,
  );
  return { ok: true as const, user, credentialId: cred.id };
}
