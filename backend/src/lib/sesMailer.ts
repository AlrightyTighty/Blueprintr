import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { getConfig } from '../config.js';
import type { Mailer } from './mailer.js';

/** One message, ready to hand to the mail service. */
export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (email: OutgoingEmail) => Promise<void>;

const sendThroughSes: SendEmail = async (email) => {
  const client = new SESv2Client({ region: getConfig().AWS_REGION });
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: email.from,
      Destination: { ToAddresses: [email.to] },
      Content: { Simple: { Subject: { Data: email.subject, Charset: 'UTF-8' }, Body: { Text: { Data: email.text, Charset: 'UTF-8' } } } },
    }),
  );
};

/** Sends real email through Amazon SES. `sender` is replaceable so the wording can be tested without AWS. */
export class SesMailer implements Mailer {
  constructor(
    private readonly fromAddress: string,
    private readonly sender: SendEmail = sendThroughSes,
  ) {}

  isDeliverable(): boolean {
    return true;
  }

  sendEmailVerification(to: string, link: string): Promise<void> {
    return this.send(to, 'Confirm your email for Ripplemap', `Confirm this email address for your Ripplemap account:\n\n${link}\n\nIf you did not create an account, ignore this message.`);
  }

  sendPasswordReset(to: string, link: string): Promise<void> {
    return this.send(to, 'Reset your Ripplemap password', `Choose a new Ripplemap password here:\n\n${link}\n\nIf you did not ask for this, ignore this message. Your password stays the same.`);
  }

  sendInvitation(to: string, details: { inviterName: string; projectName: string; role: string; link: string }): Promise<void> {
    return this.send(
      to,
      `${details.inviterName} invited you to ${details.projectName} on Ripplemap`,
      `${details.inviterName} invited you to join "${details.projectName}" as ${details.role}.\n\nSign in with this email address (${to}) to accept:\n\n${details.link}\n\nThe invitation works only for this address and expires in 14 days.`,
    );
  }

  private send(to: string, subject: string, text: string): Promise<void> {
    return this.sender({ from: this.fromAddress, to, subject, text });
  }
}
