import { getConfig } from '../config.js';

export interface Mailer {
  /**
   * Whether mail really reaches people. When it does, an address counts as theirs only once they have
   * clicked the verification link, which is what lets invitations require a verified email.
   */
  isDeliverable(): boolean;
  sendEmailVerification(to: string, link: string): Promise<void>;
  sendPasswordReset(to: string, link: string): Promise<void>;
  /** Tells someone they were invited to a project. Failing to send must not fail the invitation. */
  sendInvitation(to: string, details: InvitationDetails): Promise<void>;
}

export interface InvitationDetails {
  inviterName: string;
  projectName: string;
  role: string;
  link: string;
}

/**
 * Placeholder mailer: logs the link instead of sending anything. Swap in SES (or any provider)
 * by implementing `Mailer` and passing it to `buildApp`.
 */
export class LogMailer implements Mailer {
  constructor(private readonly log: (message: string) => void = console.log) {}

  isDeliverable(): boolean {
    return false;
  }

  async sendEmailVerification(to: string, link: string): Promise<void> {
    this.log(`[mail] verify email for ${to}: ${link}`);
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.log(`[mail] password reset for ${to}: ${link}`);
  }

  async sendInvitation(to: string, details: InvitationDetails): Promise<void> {
    this.log(`[mail] invitation to ${details.projectName} for ${to}: ${details.link}`);
  }
}

export function frontendUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, getConfig().FRONTEND_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
