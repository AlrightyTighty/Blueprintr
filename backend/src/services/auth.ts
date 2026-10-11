import { getConfig } from '../config.js';
import { getPool, withTransaction, type Db } from '../db/pool.js';
import { UNIQUE_VIOLATION, pgConstraint, pgErrorCode } from '../db/util.js';
import { AppError, badRequest, conflict, unauthorized } from '../http/errors.js';
import { integrations } from '../integrations/registry.js';
import { decryptSecret, dummyPasswordCheck, encryptSecret, hashPassword, hashToken, randomToken, verifyPassword } from '../lib/crypto.js';
import { signToken, verifyToken } from '../lib/jwt.js';
import { frontendUrl } from '../lib/mailer.js';
import * as activity from '../repositories/activity.js';
import * as authTokens from '../repositories/authTokens.js';
import * as connections from '../repositories/githubConnections.js';
import * as users from '../repositories/users.js';
import type { UserRow } from '../repositories/users.js';
import { toGithubConnection, toUser } from './presenters.js';

const HOUR = 60 * 60 * 1000;

export async function createSession(user: UserRow) {
  const { token, expiresAt } = await signToken('access', {}, getConfig().JWT_TTL_SECONDS, user.id);
  return { token, expiresAt: expiresAt.toISOString(), user: toUser(user) };
}

/** Turns a unique-violation on users into the right 409. */
function mapUserConflict(err: unknown): never {
  if (pgErrorCode(err) === UNIQUE_VIOLATION) {
    const constraint = pgConstraint(err);
    if (constraint === 'users_username_key') throw conflict('username_taken', 'That username is already taken.');
    if (constraint === 'users_email_key') throw conflict('email_taken', 'An account with that email already exists.');
    if (constraint === 'github_connections_github_user_id_key') throw conflict('github_account_taken', 'That GitHub account is already linked to another user.');
  }
  throw err;
}

export async function sendVerificationEmail(db: Db, user: UserRow): Promise<void> {
  const token = randomToken();
  await authTokens.create(db, { userId: user.id, purpose: 'email_verify', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 48 * HOUR) });
  await integrations().mailer.sendEmailVerification(user.email, frontendUrl('/verify-email', { token }));
}

export async function register(input: { username: string; email: string; password: string; displayName?: string }) {
  const passwordHash = await hashPassword(input.password);
  const user = await withTransaction(async (tx) => {
    let created: UserRow;
    try {
      created = await users.create(tx, { username: input.username, email: input.email.toLowerCase(), passwordHash, displayName: input.displayName });
    } catch (err) {
      mapUserConflict(err);
    }
    await sendVerificationEmail(tx, created);
    await activity.insert(tx, { actorUserId: created.id, action: 'user.signed_in', targetType: 'user', targetId: created.id, metadata: { method: 'password', registered: true } });
    return created;
  });
  return createSession(user);
}

export async function login(input: { identifier: string; password: string }) {
  const db = getPool();
  const user = await users.findByIdentifier(db, input.identifier.trim());
  if (!user) {
    await dummyPasswordCheck(input.password);
    throw unauthorized('Wrong username/email or password.', 'invalid_credentials');
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw unauthorized('Wrong username/email or password.', 'invalid_credentials');
  }
  await activity.insert(db, { actorUserId: user.id, action: 'user.signed_in', targetType: 'user', targetId: user.id, metadata: { method: 'password' } });
  return createSession(user);
}

// ---- GitHub OAuth ----------------------------------------------------------------------------------------------

type Intent = 'login' | 'signup' | 'link';

export async function githubAuthorize(intent: Intent, userId: string | null) {
  if (intent === 'link' && !userId) throw unauthorized('Sign in before linking a GitHub account.');
  const { token: state } = await signToken('gh_state', { intent, uid: intent === 'link' ? userId : null }, 10 * 60);
  return { authorizeUrl: integrations().github.authorizeUrl(state), state };
}

/** GitHub logins allow "-" but not "_"; Blueprint usernames allow both. Make a valid, free suggestion. */
async function suggestUsername(db: Db, login: string): Promise<string> {
  let base = login.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 34);
  if (base.length < 3) base = `${base}user`.slice(0, 34);
  if (!(await users.usernameExists(db, base))) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await users.usernameExists(db, candidate))) return candidate;
  }
  return `${base}${randomToken(3).replace(/[^A-Za-z0-9]/g, 'x')}`.slice(0, 39);
}

interface RegistrationClaims {
  ghId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  tok: string;
  scopes: string[];
}

export async function githubCallback(input: { code: string; state: string }, currentUserId: string | null) {
  const state = await verifyToken<{ intent: Intent; uid: string | null }>(input.state, 'gh_state');
  const db = getPool();
  const github = integrations().github;

  if (state.intent === 'link' && (!currentUserId || state.uid !== currentUserId)) {
    throw unauthorized('Sign in as the same user who started linking GitHub.');
  }

  const { accessToken, scopes } = await github.exchangeCode(input.code);
  const profile = await github.getProfile(accessToken);
  const existing = await connections.findByGithubUserId(db, profile.id);
  const ciphertext = encryptSecret(accessToken);

  if (state.intent === 'link') {
    if (existing && existing.userId !== currentUserId) {
      throw conflict('github_account_taken', 'That GitHub account is already linked to another user.');
    }
    const connection = await withTransaction(async (tx) => {
      let row: connections.GithubConnectionRow;
      if (existing) {
        await connections.updateToken(tx, existing.id, { githubLogin: profile.login, accessTokenCiphertext: ciphertext, scopes });
        row = (await connections.findById(tx, existing.id))!;
      } else {
        try {
          row = await connections.insert(tx, { userId: currentUserId!, githubUserId: profile.id, githubLogin: profile.login, accessTokenCiphertext: ciphertext, scopes });
        } catch (err) {
          mapUserConflict(err);
        }
      }
      await activity.insert(tx, { actorUserId: currentUserId, action: 'github.connected', targetType: 'github_connection', targetId: row.id, metadata: { githubLogin: profile.login } });
      return row;
    });
    return { status: 'linked' as const, connection: toGithubConnection(connection) };
  }

  if (existing) {
    const user = await users.findById(db, existing.userId);
    if (user) {
      await connections.updateToken(db, existing.id, { githubLogin: profile.login, accessTokenCiphertext: ciphertext, scopes });
      await activity.insert(db, { actorUserId: user.id, action: 'user.signed_in', targetType: 'user', targetId: user.id, metadata: { method: 'github' } });
      return { status: 'authenticated' as const, session: await createSession(user) };
    }
  }

  const claims: RegistrationClaims = {
    ghId: profile.id,
    login: profile.login,
    name: profile.name,
    email: profile.email,
    avatar: profile.avatarUrl,
    tok: ciphertext.toString('base64'),
    scopes,
  };
  const { token } = await signToken('gh_register', claims as unknown as Record<string, unknown>, 15 * 60);
  return {
    status: 'registration_required' as const,
    registrationToken: token,
    prefill: {
      username: await suggestUsername(db, profile.login),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.name ? { displayName: profile.name } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
    },
  };
}

export async function githubComplete(input: { registrationToken: string; username: string; email: string; password: string; displayName?: string }) {
  const claims = await verifyToken<RegistrationClaims & Record<string, unknown>>(input.registrationToken, 'gh_register');
  const passwordHash = await hashPassword(input.password);
  const email = input.email.toLowerCase();
  // The address GitHub already verified doesn't need another round trip.
  const emailVerified = claims.email !== null && claims.email.toLowerCase() === email;

  const user = await withTransaction(async (tx) => {
    let created: UserRow;
    try {
      created = await users.create(tx, {
        username: input.username,
        email,
        passwordHash,
        displayName: input.displayName ?? claims.name,
        avatarUrl: claims.avatar,
        emailVerified,
      });
      await connections.insert(tx, {
        userId: created.id,
        githubUserId: claims.ghId,
        githubLogin: claims.login,
        accessTokenCiphertext: Buffer.from(claims.tok, 'base64'),
        scopes: claims.scopes,
      });
    } catch (err) {
      mapUserConflict(err);
    }
    if (!emailVerified) await sendVerificationEmail(tx, created);
    await activity.insert(tx, { actorUserId: created.id, action: 'user.signed_in', targetType: 'user', targetId: created.id, metadata: { method: 'github', registered: true } });
    await activity.insert(tx, { actorUserId: created.id, action: 'github.connected', targetType: 'user', targetId: created.id, metadata: { githubLogin: claims.login } });
    return created;
  });
  return createSession(user);
}

// ---- email + password flows ---------------------------------------------------------------------------------------

export async function verifyEmail(token: string): Promise<void> {
  const userId = await withTransaction(async (tx) => {
    const id = await authTokens.consume(tx, hashToken(token), 'email_verify');
    if (id) await users.markEmailVerified(tx, id);
    return id;
  });
  if (!userId) throw badRequest('invalid_token', 'That verification link is invalid or has expired.');
}

export async function resendVerification(userId: string): Promise<void> {
  const user = await users.findById(getPool(), userId);
  if (!user) throw unauthorized();
  if (user.emailVerifiedAt) throw conflict('already_verified', 'This email address is already verified.');
  await sendVerificationEmail(getPool(), user);
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await users.findByEmail(getPool(), email.toLowerCase());
  if (!user) return; // same response either way, so addresses can't be probed
  const token = randomToken();
  await authTokens.create(getPool(), { userId: user.id, purpose: 'password_reset', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + HOUR) });
  await integrations().mailer.sendPasswordReset(user.email, frontendUrl('/reset-password', { token }));
}

export async function resetPassword(input: { token: string; password: string }): Promise<void> {
  const passwordHash = await hashPassword(input.password);
  const ok = await withTransaction(async (tx) => {
    const userId = await authTokens.consume(tx, hashToken(input.token), 'password_reset');
    if (!userId) return false;
    await users.setPassword(tx, userId, passwordHash);
    await users.markEmailVerified(tx, userId); // they proved they control the inbox
    await activity.insert(tx, { actorUserId: userId, action: 'user.password_changed', targetType: 'user', targetId: userId, metadata: { via: 'reset' } });
    return true;
  });
  if (!ok) throw badRequest('invalid_token', 'That reset link is invalid or has expired.');
}

/** Used by services that need a user's GitHub token. */
export async function githubTokenFor(_db: Db, connection: connections.GithubConnectionRow): Promise<string> {
  try {
    return decryptSecret(connection.accessTokenCiphertext);
  } catch {
    throw new AppError(409, 'github_token_invalid', 'Conflict', 'The stored GitHub token could not be read. Reconnect your GitHub account.');
  }
}

