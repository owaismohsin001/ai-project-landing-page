import crypto from "crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

/** Name of the httpOnly session cookie. */
export const SESSION_COOKIE = "session";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, in seconds

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET is not set (must be a long random string).");
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  /** User id. */
  sub: string;
  email: string;
  name: string;
  plan: string;
}

/* ── Passwords ──────────────────────────────────────────────────────── */

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/* ── Session tokens (JWT) ───────────────────────────────────────────── */

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({
    email: payload.email,
    name: payload.name,
    plan: payload.plan,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      plan: String(payload.plan ?? ""),
    };
  } catch {
    return null;
  }
}

/** Reads and verifies the current session from the request cookies. */
export async function getSessionUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Cookie options for an active session. */
export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE,
};

/* ── Password-reset tokens ──────────────────────────────────────────── */

/** A random, URL-safe token to email to the user. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** SHA-256 hash — only the hash is stored, never the raw token. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
