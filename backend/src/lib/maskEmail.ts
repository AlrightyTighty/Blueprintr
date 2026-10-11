/**
 * Hides most of an email address while keeping enough to recognise it: "jordan@example.com" becomes
 * "j***@example.com". Used wherever an address is shown to someone who has not proved it is theirs.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(Math.max(local.length - 1, 2), 5))}${email.slice(at)}`;
}
