import { describe, expect, it } from 'vitest';
import { SesMailer, type OutgoingEmail } from '../src/lib/sesMailer.js';

describe('SesMailer', () => {
  const sent: OutgoingEmail[] = [];
  const mailer = new SesMailer('Ripplemap <no-reply@ripplemap.wiki>', async (email) => void sent.push(email));

  it('counts as real mail delivery', () => {
    expect(mailer.isDeliverable()).toBe(true);
  });

  it('puts the link in each kind of message, from the configured address', async () => {
    await mailer.sendEmailVerification('a@example.com', 'https://ripplemap.wiki/verify-email?token=v1');
    await mailer.sendPasswordReset('a@example.com', 'https://ripplemap.wiki/reset-password?token=r1');
    await mailer.sendInvitation('a@example.com', { inviterName: 'olive', projectName: 'Orders', role: 'editor', link: 'https://ripplemap.wiki/invites/i1' });
    expect(sent.map((email) => email.from)).toEqual(Array(3).fill('Ripplemap <no-reply@ripplemap.wiki>'));
    expect(sent[0].text).toContain('token=v1');
    expect(sent[1].text).toContain('token=r1');
    expect(sent[2].text).toContain('invites/i1');
    expect(sent[2].subject).toBe('olive invited you to Orders on Ripplemap');
    expect(sent[2].text).toContain('a@example.com');
  });
});
