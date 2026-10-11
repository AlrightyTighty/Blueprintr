import { getPool, withTransaction } from '../db/pool.js';
import { UNIQUE_VIOLATION, pgConstraint, pgErrorCode } from '../db/util.js';
import { badRequest, conflict, notFound, unauthorized } from '../http/errors.js';
import { integrations } from '../integrations/registry.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import * as activity from '../repositories/activity.js';
import * as connections from '../repositories/githubConnections.js';
import * as members from '../repositories/projectMembers.js';
import * as users from '../repositories/users.js';
import { createSession, githubTokenFor, sendVerificationEmail } from './auth.js';
import { toGithubConnection, toUser } from './presenters.js';

async function currentUser(userId: string) {
  const user = await users.findById(getPool(), userId);
  if (!user) throw unauthorized('This account no longer exists.');
  return user;
}

export async function getMe(userId: string) {
  return toUser(await currentUser(userId));
}

export async function updateMe(
  userId: string,
  patch: { username?: string; email?: string; displayName?: string | null; avatarUrl?: string | null },
) {
  const before = await currentUser(userId);
  const emailChanged = patch.email !== undefined && patch.email.toLowerCase() !== before.email.toLowerCase();
  const updated = await withTransaction(async (tx) => {
    let row;
    try {
      row = await users.update(tx, userId, {
        username: patch.username,
        email: patch.email?.toLowerCase(),
        displayName: patch.displayName,
        avatarUrl: patch.avatarUrl,
        ...(emailChanged ? { emailVerifiedAt: null } : {}),
      });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) {
        throw pgConstraint(err) === 'users_username_key'
          ? conflict('username_taken', 'That username is already taken.')
          : conflict('email_taken', 'An account with that email already exists.');
      }
      throw err;
    }
    if (row && emailChanged) await sendVerificationEmail(tx, row);
    return row;
  });
  return toUser(updated ?? before);
}

/** Changes the password and ends every other sign-in; returns a fresh session so this device stays signed in. */
export async function changePassword(userId: string, input: { currentPassword: string; newPassword: string }) {
  const user = await currentUser(userId);
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw unauthorized('The current password is wrong.', 'invalid_credentials');
  }
  const hash = await hashPassword(input.newPassword);
  await withTransaction(async (tx) => {
    await users.setPassword(tx, userId, hash);
    await activity.insert(tx, { actorUserId: userId, action: 'user.password_changed', targetType: 'user', targetId: userId, metadata: { via: 'settings' } });
  });
  return createSession(await currentUser(userId));
}

/** "Sign out everywhere": ends every sign-in, this one included, and returns a fresh session for this device. */
export async function signOutEverywhere(userId: string) {
  await withTransaction(async (tx) => {
    await users.revokeSessions(tx, userId);
    await activity.insert(tx, { actorUserId: userId, action: 'user.sessions_revoked', targetType: 'user', targetId: userId, metadata: {} });
  });
  return createSession(await currentUser(userId));
}

export async function deleteMe(userId: string, password: string): Promise<void> {
  const user = await currentUser(userId);
  if (!(await verifyPassword(password, user.passwordHash))) throw unauthorized('The password is wrong.', 'invalid_credentials');
  await withTransaction(async (tx) => {
    if ((await members.countOwnedProjects(tx, userId)) > 0) {
      throw conflict('owns_projects', 'Transfer or delete the projects you own before deleting your account.');
    }
    // GitHub connections hold tokens and block the GitHub account from being reused, so they go first.
    await connections.removeAllForUser(tx, userId);
    await members.removeAllForUser(tx, userId);
    await users.softDelete(tx, userId);
    await activity.insert(tx, { actorUserId: userId, action: 'user.deleted', targetType: 'user', targetId: userId, metadata: { username: user.username } });
  });
}

export async function listGithubConnections(userId: string) {
  return (await connections.listForUser(getPool(), userId)).map(toGithubConnection);
}

export async function deleteGithubConnection(userId: string, connectionId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const connection = await connections.findByIdForUser(tx, connectionId, userId);
    if (!connection) throw notFound('GitHub connection');
    await connections.remove(tx, connectionId, userId);
    await activity.insert(tx, { actorUserId: userId, action: 'github.disconnected', targetType: 'github_connection', targetId: connectionId, metadata: { githubLogin: connection.githubLogin } });
  });
}

export async function listGithubRepositories(userId: string, connectionId: string, query: { q?: string; cursor?: string }) {
  const db = getPool();
  const connection = await connections.findByIdForUser(db, connectionId, userId);
  if (!connection) throw notFound('GitHub connection');
  const page = query.cursor ? Number(query.cursor) : 1;
  if (!Number.isInteger(page) || page < 1) throw badRequest('invalid_cursor', 'The cursor is not valid.');
  const result = await integrations().github.listRepositories(await githubTokenFor(db, connection), { page, q: query.q });
  return { items: result.items, nextCursor: result.nextPage ? String(result.nextPage) : null };
}

export async function listMyActivity(userId: string, query: { limit: number; cursor?: string }) {
  return activity.listForUser(getPool(), userId, query);
}
