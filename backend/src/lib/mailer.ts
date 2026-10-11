import { getConfig } from '../config.js';

export interface Mailer {
  sendEmailVerification(to: string, link: string): Promise<void>;
  sendPasswordReset(to: string, link: string): Promise<void>;
}

/**
 * Placeholder mailer: logs the link instead of sending anything. Swap in SES (or any provider)
 * by implementing `Mailer` and passing it to `buildApp`.
 */
export class LogMailer implements Mailer {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async sendEmailVerification(to: string, link: string): Promise<void> {
    this.log(`[mail] verify email for ${to}: ${link}`);
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.log(`[mail] password reset for ${to}: ${link}`);
  }
}

export function frontendUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, getConfig().FRONTEND_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
