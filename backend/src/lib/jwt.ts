import { SignJWT, jwtVerify, errors } from 'jose';
import { getConfig } from '../config.js';
import { AppError, unauthorized } from '../http/errors.js';

/** What a token is for. A token of one type is never accepted as another. */
export type TokenType = 'access' | 'voice_tool' | 'gh_state' | 'gh_register';

const ISSUER = 'ripplemap';

function secret(): Uint8Array {
  return new TextEncoder().encode(getConfig().JWT_SECRET);
}

export async function signToken(
  type: TokenType,
  claims: Record<string, unknown>,
  ttlSeconds: number,
  subject?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  let jwt = new SignJWT({ ...claims, typ: type })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000));
  if (subject) jwt = jwt.setSubject(subject);
  return { token: await jwt.sign(secret()), expiresAt };
}

export async function verifyToken<T extends object>(
  token: string,
  type: TokenType,
): Promise<T & { sub?: string }> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, algorithms: ['HS256'] });
    if (payload['typ'] !== type) throw unauthorized('Wrong kind of token.', 'invalid_token');
    return payload as unknown as T & { sub?: string };
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw unauthorized('The token has expired.', 'token_expired');
    if (err instanceof AppError) throw err;
    throw unauthorized('The token is invalid.', 'invalid_token');
  }
}
