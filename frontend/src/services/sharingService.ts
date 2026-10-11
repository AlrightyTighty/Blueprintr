// Members, invitations and the read-only share link. See "Sharing" in backend/openapi.yaml.
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../api';
import type {
  InvitableRole,
  InviteCreated,
  InvitePreview,
  ProjectDetail,
  ProjectInvite,
  ProjectMember,
  ProjectVisibility,
  Sharing,
} from '../core/accounts/types';

export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  const { items } = await apiGet<{ items: ProjectMember[] }>(`/projects/${projectId}/members`);
  return items;
}

export function updateMemberRole(projectId: string, userId: string, role: InvitableRole): Promise<ProjectMember> {
  return apiPatch<ProjectMember>(`/projects/${projectId}/members/${userId}`, { role });
}

export function removeMember(projectId: string, userId: string): Promise<void> {
  return apiDelete(`/projects/${projectId}/members/${userId}`);
}

export async function transferOwnership(projectId: string, userId: string): Promise<ProjectMember[]> {
  const { items } = await apiPost<{ items: ProjectMember[] }>(`/projects/${projectId}/transfer-ownership`, { userId });
  return items;
}

export function leaveProject(projectId: string): Promise<void> {
  return apiPost<void>(`/projects/${projectId}/leave`);
}

export async function listInvites(projectId: string): Promise<ProjectInvite[]> {
  const { items } = await apiGet<{ items: ProjectInvite[] }>(`/projects/${projectId}/invites`);
  return items;
}

export function createInvite(projectId: string, email: string, role: InvitableRole): Promise<InviteCreated> {
  return apiPost<InviteCreated>(`/projects/${projectId}/invites`, { email, role });
}

export function revokeInvite(projectId: string, inviteId: string): Promise<void> {
  return apiDelete(`/projects/${projectId}/invites/${inviteId}`);
}

export function previewInvite(token: string): Promise<InvitePreview> {
  return apiGet<InvitePreview>(`/invites/${encodeURIComponent(token)}`);
}

export function acceptInvite(token: string): Promise<ProjectDetail> {
  return apiPost<ProjectDetail>(`/invites/${encodeURIComponent(token)}/accept`);
}

export function getSharing(projectId: string): Promise<Sharing> {
  return apiGet<Sharing>(`/projects/${projectId}/sharing`);
}

export function setSharing(projectId: string, visibility: ProjectVisibility): Promise<Sharing> {
  return apiPut<Sharing>(`/projects/${projectId}/sharing`, { visibility });
}

/** Replaces the share token, so the old link stops working. */
export function rotateShareToken(projectId: string): Promise<Sharing> {
  return apiPost<Sharing>(`/projects/${projectId}/sharing/rotate`);
}

/** Opens a project through its read-only share link. No account needed. */
export function getSharedProject(shareToken: string): Promise<ProjectDetail> {
  return apiGet<ProjectDetail>(`/shared/${encodeURIComponent(shareToken)}`);
}
