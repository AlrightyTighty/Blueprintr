import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import ConfirmDialog from '../../components/ConfirmDialog';
import CopyField from '../../components/CopyField';
import Modal from '../../components/Modal';
import SoftBreak from '../../components/SoftBreak';
import { formatDateTime, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui';
import type { InvitableRole, ProjectDetail, ProjectInvite, ProjectMember, Sharing } from '../../core/accounts/types';
import {
  createInvite,
  getSharing,
  leaveProject,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  rotateShareToken,
  setSharing,
  transferOwnership,
  updateMemberRole,
} from '../../services/sharingService';
import { useAuthStore } from '../auth/useAuthStore';

interface ShareDialogProps {
  project: ProjectDetail;
  onClose: () => void;
  /** Called after something changes the current user's own access, so the page can reload. */
  onProjectChanged: () => void;
  /** Called after the current user leaves the project. */
  onLeft: () => void;
}

type PendingConfirm =
  | { kind: 'remove'; member: ProjectMember }
  | { kind: 'owner'; member: ProjectMember }
  | { kind: 'leave' }
  | { kind: 'reset-link' };

const smallButtonClass = 'rounded bg-indigo-950 px-2.5 py-1 text-xs text-indigo-200 transition-colors hover:bg-indigo-900 disabled:opacity-50';
const ROLE_LABELS: Record<InvitableRole, string> = { editor: 'Editor', viewer: 'Viewer' };
const ROLE_HELP = 'Editors can analyse, upload plans and use the guide. Viewers can only look.';

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.friendlyMessage;
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function displayName(member: ProjectMember): string {
  return member.user.displayName || member.user.username;
}

export default function ShareDialog({ project, onClose, onProjectChanged, onLeft }: ShareDialogProps) {
  const currentUserId = useAuthStore((state) => state.session?.user.id);
  const isOwner = project.myRole === 'owner';

  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [invites, setInvites] = useState<ProjectInvite[]>([]);
  const [sharing, setSharingState] = useState<Sharing | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('editor');
  // The link is only returned when an invite is made, so keep the ones made in this dialog to copy later.
  const [linkByInviteId, setLinkByInviteId] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [loadedMembers, loadedInvites, loadedSharing] = await Promise.all([
        listMembers(project.id),
        isOwner ? listInvites(project.id) : Promise.resolve([]),
        isOwner ? getSharing(project.id) : Promise.resolve(null),
      ]);
      setMembers(loadedMembers);
      setInvites(loadedInvites);
      setSharingState(loadedSharing);
    } catch (error) {
      setErrorMessage(errorText(error));
    }
  }, [project.id, isOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one action with the dialog's busy state and error banner. */
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setErrorMessage(null);
    try {
      await action();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    await perform(async () => {
      const created = await createInvite(project.id, email.trim(), role);
      setLinkByInviteId((links) => ({ ...links, [created.id]: created.inviteUrl }));
      setInvites((current) => [created, ...current]);
      setNoticeMessage(created.emailSent ? `We emailed the invitation to ${created.email}.` : 'Copy the invitation link below and send it to them yourself.');
      setEmail('');
    });
  }

  function handleRoleChange(member: ProjectMember, newRole: InvitableRole) {
    void perform(async () => {
      const updated = await updateMemberRole(project.id, member.user.id, newRole);
      setMembers((current) => current?.map((candidate) => (candidate.user.id === updated.user.id ? updated : candidate)) ?? current);
    });
  }

  function handleToggleLink(enabled: boolean) {
    void perform(async () => setSharingState(await setSharing(project.id, enabled ? 'link_view' : 'private')));
  }

  function handleRevoke(invite: ProjectInvite) {
    void perform(async () => {
      await revokeInvite(project.id, invite.id);
      setInvites((current) => current.filter((candidate) => candidate.id !== invite.id));
    });
  }

  async function handleConfirm(confirm: PendingConfirm) {
    switch (confirm.kind) {
      case 'remove':
        await removeMember(project.id, confirm.member.user.id);
        setMembers((current) => current?.filter((member) => member.user.id !== confirm.member.user.id) ?? current);
        break;
      case 'owner':
        setMembers(await transferOwnership(project.id, confirm.member.user.id));
        onProjectChanged();
        break;
      case 'leave':
        await leaveProject(project.id);
        onLeft();
        return;
      case 'reset-link':
        setSharingState(await rotateShareToken(project.id));
        break;
    }
    setPending(null);
  }

  const confirmCopy: Record<PendingConfirm['kind'], { title: string; label: string; danger: boolean }> = {
    remove: { title: 'Remove this person?', label: 'Remove', danger: true },
    owner: { title: 'Make this person the owner?', label: 'Make owner', danger: true },
    leave: { title: 'Leave this project?', label: 'Leave', danger: true },
    'reset-link': { title: 'Reset the share link?', label: 'Reset link', danger: true },
  };

  const isLinkOn = sharing?.visibility === 'link_view' && Boolean(sharing.shareUrl);

  return (
    <>
      <Modal title={`Share “${project.name}”`} onClose={onClose} wide>
        <div className="flex flex-col gap-7 text-sm">
          {errorMessage && <p className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-rose-300">{errorMessage}</p>}
          {noticeMessage && !errorMessage && <p className="rounded border border-indigo-900 bg-indigo-950/40 px-3 py-2 text-indigo-200">{noticeMessage}</p>}

          <section>
            <h3 className="mb-2 font-medium text-indigo-200">People with access</h3>
            {members === null ? (
              <p className="text-indigo-300">Loading…</p>
            ) : (
              <ul className="divide-y divide-indigo-900 rounded border border-indigo-900">
                {members.map((member) => {
                  const isYou = member.user.id === currentUserId;
                  const canManage = isOwner && member.role !== 'owner';
                  return (
                    <li key={member.user.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-slate-100 [overflow-wrap:anywhere]">
                          {displayName(member)}
                          {isYou && <span className="ml-2 text-xs text-slate-500">(you)</span>}
                        </p>
                        {member.user.displayName && <p className="text-xs text-slate-500">@{member.user.username}</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        {member.role === 'owner' && (
                          <span className="rounded bg-violet-950 px-2 py-0.5 text-xs text-violet-300">Owner</span>
                        )}
                        {canManage && (
                          <>
                            <select
                              aria-label={`Role for ${displayName(member)}`}
                              className="rounded border border-indigo-900 bg-indigo-950 px-2 py-1 text-xs text-slate-100"
                              value={member.role}
                              disabled={busy}
                              onChange={(event) => handleRoleChange(member, event.target.value as InvitableRole)}
                            >
                              {(Object.keys(ROLE_LABELS) as InvitableRole[]).map((value) => (
                                <option key={value} value={value}>
                                  {ROLE_LABELS[value]}
                                </option>
                              ))}
                            </select>
                            <button type="button" className={smallButtonClass} disabled={busy} onClick={() => setPending({ kind: 'owner', member })}>
                              Make owner
                            </button>
                            <button type="button" className={smallButtonClass} disabled={busy} onClick={() => setPending({ kind: 'remove', member })}>
                              Remove
                            </button>
                          </>
                        )}
                        {!isOwner && member.role !== 'owner' && (
                          <span className="rounded bg-indigo-950 px-2 py-0.5 text-xs text-indigo-200">{ROLE_LABELS[member.role as InvitableRole] ?? member.role}</span>
                        )}
                        {isYou && !isOwner && (
                          <button type="button" className={smallButtonClass} disabled={busy} onClick={() => setPending({ kind: 'leave' })}>
                            Leave
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {isOwner && <p className="mt-2 text-xs text-slate-500">To leave your own project, make someone else the owner first.</p>}
            {!isOwner && <p className="mt-2 text-xs text-slate-500">Only the owner can invite people or change sharing.</p>}
          </section>

          {isOwner && (
            <section>
              <h3 className="mb-2 font-medium text-indigo-200">Invite someone</h3>
              <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <label htmlFor="invite-email" className={labelClass}>
                    Email
                  </label>
                  <input
                    id="invite-email"
                    type="email"
                    required
                    className={inputClass}
                    placeholder="teammate@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="invite-role" className={labelClass}>
                    Can
                  </label>
                  <select
                    id="invite-role"
                    className={`${inputClass} w-auto`}
                    value={role}
                    onChange={(event) => setRole(event.target.value as InvitableRole)}
                  >
                    <option value="editor">Edit</option>
                    <option value="viewer">View</option>
                  </select>
                </div>
                <button type="submit" className={primaryButtonClass} disabled={busy || !email.trim()}>
                  Create invite
                </button>
              </form>
              <p className="mt-2 text-xs text-slate-500">
                {ROLE_HELP} An invitation only works for the email address you enter: they have to sign in or sign up with
                that address, so forwarding the link doesn't let anyone else in. Copy the link and send it to them; it is
                shown only once, here.
              </p>

              {invites.length > 0 && (
                <ul className="mt-3 flex flex-col gap-2">
                  {invites.map((invite) => (
                    <li key={invite.id} className="rounded border border-indigo-900 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-slate-100 [overflow-wrap:anywhere]">
                          <SoftBreak text={invite.email} />{' '}
                          <span className="text-xs text-slate-500">
                            as {ROLE_LABELS[invite.role]} · expires {formatDateTime(invite.expiresAt)}
                          </span>
                        </p>
                        <button type="button" className={smallButtonClass} disabled={busy} onClick={() => handleRevoke(invite)}>
                          Revoke
                        </button>
                      </div>
                      {linkByInviteId[invite.id] ? (
                        <div className="mt-2">
                          <CopyField value={linkByInviteId[invite.id]} label={`Invite link for ${invite.email}`} />
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-slate-500">Pending. Its link was only shown when it was created; revoke it and make a new one if it was lost.</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {isOwner && (
            <section>
              <h3 className="mb-2 font-medium text-indigo-200">Public read-only link</h3>
              <label className="flex items-center gap-2 text-slate-200">
                <input
                  type="checkbox"
                  checked={sharing?.visibility === 'link_view'}
                  disabled={busy || sharing === null}
                  onChange={(event) => handleToggleLink(event.target.checked)}
                />
                Turn on the read-only link
              </label>
              <p className="mt-1 text-xs text-slate-500">
                <strong className="text-amber-300">Anyone who has this link can view the project, with no sign-in and no email check.</strong>{' '}
                They can see the graph, findings and tours, but can't change anything or use the AI features. To share with
                specific people only, leave this off and invite them above.
              </p>
              {isLinkOn && sharing?.shareUrl && (
                <div className="mt-3 flex flex-col gap-2">
                  <CopyField value={sharing.shareUrl} label="Read-only share link" />
                  <div>
                    <button type="button" className={smallButtonClass} disabled={busy} onClick={() => setPending({ kind: 'reset-link' })}>
                      Reset link
                    </button>
                    <span className="ml-2 text-xs text-slate-500">Makes a new link and stops the old one working.</span>
                  </div>
                </div>
              )}
            </section>
          )}

          <div className="flex justify-end">
            <button type="button" className={secondaryButtonClass} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>

      {pending && (
        <ConfirmDialog
          title={confirmCopy[pending.kind].title}
          confirmLabel={confirmCopy[pending.kind].label}
          danger={confirmCopy[pending.kind].danger}
          onCancel={() => setPending(null)}
          onConfirm={() => handleConfirm(pending)}
        >
          {pending.kind === 'remove' && (
            <p>{displayName(pending.member)} will lose access to this project straight away. You can invite them again later.</p>
          )}
          {pending.kind === 'owner' && (
            <p>
              {displayName(pending.member)} becomes the owner. You become an editor, so you can no longer manage sharing, delete the
              project or change roles.
            </p>
          )}
          {pending.kind === 'leave' && <p>You will lose access to “{project.name}”. The owner can invite you back.</p>}
          {pending.kind === 'reset-link' && <p>The current link stops working for everyone who has it. You'll get a new link to share.</p>}
        </ConfirmDialog>
      )}
    </>
  );
}
