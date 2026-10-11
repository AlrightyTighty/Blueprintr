/** Query parameters that carry a secret or a one-time code. */
const SECRET_PARAMETERS = new Set(['token', 'code', 'state']);

/**
 * Hides secrets in a request URL before it is logged. Invitation and share links carry their secret in the
 * path (/invites/<token>, /shared/<token>), and reset, verification and OAuth links carry one in the query,
 * and logs are read by far more people (and kept far longer) than the links themselves are meant to be.
 */
export function redactUrl(url: string): string {
  const questionMark = url.indexOf('?');
  const path = questionMark === -1 ? url : url.slice(0, questionMark);
  const query = questionMark === -1 ? undefined : url.slice(questionMark + 1);
  const safePath = path.replace(/^(\/(?:invites|shared)\/)[^/]+/, '$1[redacted]');
  if (query === undefined) return safePath;
  const safeQuery = query
    .split('&')
    .map((pair) => {
      const [name] = pair.split('=', 1);
      return SECRET_PARAMETERS.has(name) ? `${name}=[redacted]` : pair;
    })
    .join('&');
  return `${safePath}?${safeQuery}`;
}
