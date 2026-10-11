import { getPool, withTransaction } from '../db/pool.js';
import { UNIQUE_VIOLATION, pgErrorCode } from '../db/util.js';
import { AppError, conflict, gone, notFound, unauthorized } from '../http/errors.js';
import { integrations } from '../integrations/registry.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import { maskEmail } from '../lib/maskEmail.js';
import { frontendUrl } from '../lib/mailer.js';
import * as activity from '../repositories/activity.js';
import * as invites from '../repositories/projectInvites.js';
import type { InvitableRole, InviteRow } from '../repositories/projectInvites.js';
import * as members from '../repositories/projectMembers.js';
import type { MemberRow } from '../repositories/projectMembers.js';
import * as projects from '../repositories/projects.js';
import type { ProjectVisibility } from '../repositories/projects.js';
import * as users from '../repositories/users.js';
import { requireProject, type Actor } from './access.js';
import { projectDetail } from './projects.js';

const DAY = 24 * 60 * 60 * 1000;

export function toMembersResponse(rows: MemberRow[]) {
  return { items: rows };
}

const shareUrl = (token: string) => frontendUrl(`/shared/${token}`);

function sharingView(project: { visibility: ProjectVisibility; shareToken: string | null }) {
  return {
    visibility: project.visibility,
    shareToken: project.shareToken,
    shareUrl: project.shareToken ? shareUrl(project.shareToken) : null,
  };
}

// ---- share link ---------------------------------------------------------------------------------------------------

export async function getSharing(actor: Actor, projectId: string) {
  const { project } = await requireProject(getPool(), projectId, actor, { min: 'owner' });
  return sharingView(project);
}

export async function setSharing(actor: Actor, projectId: string, visibility: ProjectVisibility) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'owner' });
  if (project.visibility !== visibility) {
    await withTransaction(async (tx) => {
      // Turning the link on creates a token the first time; turning it off keeps the token but disables it.
      const token = visibility === 'link_view' && !project.shareToken ? randomToken(24) : undefined;
      await projects.setSharing(tx, projectId, { visibility, shareToken: token });
      await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'project.visibility_changed', targetType: 'project', targetId: projectId, metadata: { from: project.visibility, to: visibility } });
    });
  }
  return sharingView((await projects.findById(db, projectId))!);
}

export async function rotateShareToken(actor: Actor, projectId: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'owner' });
  await withTransaction(async (tx) => {
    await projects.setSharing(tx, projectId, { visibility: project.visibility, shareToken: randomToken(24) });
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'project.share_link_rotated', targetType: 'project', targetId: projectId });
  });
  return sharingView((await projects.findById(db, projectId))!);
}

export async function getSharedProject(token: string) {
  const db = getPool();
  const project = await projects.findByShareToken(db, token);
  if (!project) throw notFound('Shared project');
  return projectDetail(db, project, { myRole: null });
}

// ---- members -------------------------------------------------------------------------------------------------------

export async function listMembers(actor: Actor, projectId: string) {
  const db = getPool();
  await requireProject(db, projectId, actor); // share links don't reveal who is on the team
  return toMembersResponse(await members.list(db, projectId));
}

export async function updateMemberRole(actor: Actor, projectId: string, userId: string, role: InvitableRole) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'owner' });
  return withTransaction(async (tx) => {
    await projects.lockById(tx, projectId);
    const target = await members.find(tx, projectId, userId);
    if (!target) throw notFound('Member');
    if (target.role === 'owner') throw conflict('owner_role_fixed', "The owner's role can't be changed; transfer ownership instead.");
    if (target.role !== role) {
      await members.updateRole(tx, projectId, userId, role);
      await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'member.role_changed', targetType: 'user', targetId: userId, metadata: { user: target.user.username, from: target.role, to: role } });
    }
    return (await members.find(tx, projectId, userId))!;
  });
}

export async function removeMember(actor: Actor, projectId: string, userId: string): Promise<void> {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'owner' });
  await withTransaction(async (tx) => {
    const target = await members.find(tx, projectId, userId);
    if (!target) throw notFound('Member');
    if (target.role === 'owner') throw conflict('cannot_remove_owner', 'The owner cannot be removed; transfer ownership first.');
    await members.remove(tx, projectId, userId);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'member.removed', targetType: 'user', targetId: userId, metadata: { user: target.user.username, role: target.role } });
  });
}

// ---- invitations ------------------------------------------------------------------------------------------------------

function toInvite(row: InviteRow) {
  return { id: row.id, email: row.email, role: row.role, invitedBy: row.invitedBy, expiresAt: row.expiresAt, createdAt: row.createdAt };
}

export async function listInvites(actor: Actor, projectId: string) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'owner' });
  return { items: (await invites.listPending(db, projectId)).map(toInvite) };
}

export async function createInvite(actor: Actor, projectId: string, input: { email: string; role: InvitableRole }) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'owner' });
  const email = input.email.toLowerCase();
  const token = randomToken();

  const invite = await withTransaction(async (tx) => {
    const existingUser = await users.findByEmail(tx, email);
    if (existingUser && (await members.find(tx, projectId, existingUser.id))) {
      throw conflict('already_member', 'That person is already on this project.');
    }
    await invites.expireStale(tx, projectId, email);
    let created: InviteRow;
    try {
      created = await invites.create(tx, { projectId, email, role: input.role, tokenHash: hashToken(token), invitedBy: actor.userId!, expiresAt: new Date(Date.now() + 14 * DAY) });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) throw conflict('invite_pending', 'That email already has a pending invitation. Revoke it to send a new one.');
      throw err;
    }
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'invite.created', targetType: 'invite', targetId: created.id, metadata: { email, role: input.role } });
    return created;
  });
  const inviteUrl = frontendUrl(`/invites/${token}`);
  const emailSent = await emailInvitation(actor, projectId, email, input.role, inviteUrl);
  return { ...toInvite(invite), inviteUrl, emailSent };
}

/** Emails the invitation. A mail failure never fails the invitation: the owner can still copy the link. */
async function emailInvitation(actor: Actor, projectId: string, email: string, role: string, link: string): Promise<boolean> {
  const mailer = integrations().mailer;
  if (!mailer.isDeliverable()) return false;
  try {
    const db = getPool();
    const [inviter, project] = await Promise.all([users.findById(db, actor.userId!), projects.findById(db, projectId)]);
    await mailer.sendInvitation(email, { inviterName: inviter?.username ?? 'A teammate', projectName: project?.name ?? 'a project', role, link });
    return true;
  } catch {
    return false;
  }
}

export async function revokeInvite(actor: Actor, projectId: string, inviteId: string): Promise<void> {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'owner' });
  await withTransaction(async (tx) => {
    const existing = await invites.findById(tx, projectId, inviteId);
    if (!existing) throw notFound('Invitation');
    if (!(await invites.revoke(tx, projectId, inviteId))) throw conflict('invite_closed', 'That invitation was already accepted or revoked.');
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'invite.revoked', targetType: 'invite', targetId: inviteId, metadata: { email: existing.email } });
  });
}

async function usableInvite(token: string): Promise<InviteRow> {
  const invite = await invites.findByTokenHash(getPool(), hashToken(token));
  if (!invite) throw notFound('Invitation');
  if (invite.acceptedAt || invite.revokedAt || new Date(invite.expiresAt) <= new Date()) {
    throw gone('invite_unavailable', 'This invitation has expired, was revoked, or was already used.');
  }
  return invite;
}

export async function previewInvite(token: string) {
  const invite = await usableInvite(token);
  // Anyone holding the link can preview it, so show only enough of the address to know which one to use.
  return { projectName: invite.projectName, role: invite.role, email: maskEmail(invite.email), invitedBy: invite.invitedBy, expiresAt: invite.expiresAt };
}

export async function acceptInvite(userId: string | null, token: string) {
  if (!userId) throw unauthorized('Sign in to accept this invitation.');
  const invite = await usableInvite(token);
  const db = getPool();

  // An invitation is for one email address. Holding the link is not enough: forwarding it must not let someone else in.
  const account = await users.findById(db, userId);
  if (!account) throw unauthorized('Sign in to accept this invitation.');
  if (account.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new AppError(
      403,
      'invite_email_mismatch',
      'Forbidden',
      `This invitation was sent to ${maskEmail(invite.email)}. You are signed in with a different email address.`,
    );
  }
  // Once mail can really be delivered, an address only counts after its owner has clicked the verification link;
  // otherwise anyone could sign up with a known address and walk in.
  if (integrations().mailer.isDeliverable() && !account.emailVerifiedAt) {
    throw new AppError(403, 'email_not_verified', 'Forbidden', 'Verify your email address first (check your inbox for the link), then open the invitation again.');
  }

  await withTransaction(async (tx) => {
    if (await members.find(tx, invite.projectId, userId)) throw conflict('already_member', 'You are already on this project.');
    const user = await users.findById(tx, userId);
    await members.add(tx, { projectId: invite.projectId, userId, role: invite.role, addedBy: invite.invitedBy?.id ?? null });
    await invites.markAccepted(tx, invite.id);
    await activity.insert(tx, { projectId: invite.projectId, actorUserId: userId, action: 'invite.accepted', targetType: 'invite', targetId: invite.id, metadata: { email: invite.email, role: invite.role } });
    await activity.insert(tx, { projectId: invite.projectId, actorUserId: userId, action: 'member.added', targetType: 'user', targetId: userId, metadata: { user: user?.username, role: invite.role, via: 'invite' } });
  });
  const project = (await projects.findById(db, invite.projectId))!;
  return projectDetail(db, project, { myRole: invite.role });
}
