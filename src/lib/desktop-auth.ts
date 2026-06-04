import { SignJWT, jwtVerify } from "jose";

/**
 * Bearer tokens for the desktop app (Phase 6 — automated tunnel grant).
 *
 * Issued by `/desktop/auth` after a successful Platform sign-in and
 * embedded in the `aiide://workspace?…&token=<jwt>` deep link. The Electron
 * app stores it in its config.json and presents it as `Authorization:
 * Bearer …` against `/api/desktop/tunnel-grant`.
 *
 * Separate from the web session cookie (`SESSION_COOKIE` / `JWT_SECRET`
 * usage in `lib/auth.ts`) so we can rotate the desktop key independently
 * — leaking one channel does not compromise the other.
 *
 * TTL: 30 days, refreshed on every successful tunnel grant. Idle users
 * (no app launch for 30+ days) re-auth via the connect window flow.
 */

const DESKTOP_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecret(): Uint8Array {
  // Reuse JWT_SECRET if a dedicated DESKTOP_JWT_SECRET isn't set. Lets
  // staging spin up without an extra env var; production should set the
  // dedicated key so the two channels are cryptographically independent.
  const secret = process.env.DESKTOP_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "DESKTOP_JWT_SECRET (or JWT_SECRET) is not set (must be a long random string)."
    );
  }
  return new TextEncoder().encode(secret);
}

export interface DesktopTokenPayload {
  /** User id (Mongo _id stringified). Used to look up workspace + IAM keys. */
  sub: string;
}

export async function createDesktopToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${DESKTOP_TOKEN_TTL_SECONDS}s`)
    .setAudience("desktop")
    .sign(getSecret());
}

/** Returns null if the token is invalid, expired, or for the wrong audience. */
export async function verifyDesktopToken(
  token: string
): Promise<DesktopTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      audience: "desktop",
    });
    if (!payload.sub) return null;
    return { sub: String(payload.sub) };
  } catch {
    return null;
  }
}

export { DESKTOP_TOKEN_TTL_SECONDS };
