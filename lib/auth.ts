/**
 * MIRTT Manager — authentication core (server-only).
 * - PIN hashing: scrypt (N=16384) with unique random salt, timing-safe compare.
 * - Sessions: JWT (HS256, jose) in HttpOnly SameSite cookie + DB-backed
 *   revocation (Session rows). Never trusts client role claims.
 */
import { SignJWT, jwtVerify } from 'jose'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'insecure-dev-secret-change-me'
)
export const SESSION_COOKIE = 'mirtt_session'
/** Sessions persist across app restarts; every authenticated request slides the window forward. */
export const SESSION_TTL_DAYS = 30
/** When fewer than this many days remain, the next request silently renews the session. */
const SESSION_RENEW_BEFORE_DAYS = 7

const sessionTtlMs = () => SESSION_TTL_DAYS * 24 * 3600 * 1000

// ── PIN policy: admin = exactly 4 digits, staff = exactly 5 ─────────────────

export const PIN_LENGTHS: Record<'admin' | 'staff', number> = { admin: 4, staff: 5 }

/** Expected PIN length for a role (defaults to the admin length on unknown roles). */
export function pinLengthFor(role: string): number {
  return PIN_LENGTHS[role as 'admin' | 'staff'] ?? PIN_LENGTHS.admin
}

/** Exact-length numeric PIN validation for the given role. */
export function isValidPinFor(role: string, pin: string): boolean {
  const len = PIN_LENGTHS[role as 'admin' | 'staff']
  if (!len) return false
  return new RegExp(`^[0-9]{${len}}$`).test(pin)
}

// ── PIN hashing (scrypt) ────────────────────────────────────────────────────

export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('base64url')
  const hash = scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')
  return { hash, salt }
}

export function verifyPin(pin: string, salt: string, expected: string): boolean {
  try {
    const actual = scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 })
    const expectedBuf = Buffer.from(expected, 'base64url')
    return actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf)
  } catch {
    return false
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

export type SessionUser = {
  id: string
  name: string
  role: 'admin' | 'staff'
  avatar?: string | null
}

export async function createSession(
  userId: string,
  role: string,
  name: string,
  userAgent?: string
): Promise<{ token: string; expiresAt: Date }> {
  const jti = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionTtlMs())
  const token = await new SignJWT({ role, name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(SECRET)

  await db.session.create({
    data: { jti, userId, userAgent: userAgent?.slice(0, 250), expiresAt },
  })
  return { token, expiresAt }
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    if (!payload.sub || !payload.jti) return null
    const session = await db.session.findUnique({ where: { jti: payload.jti as string } })
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null
    const user = await db.user.findUnique({ where: { id: payload.sub } })
    if (!user || !user.isActive) return null
    return { id: user.id, name: user.fullName, role: user.role as 'admin' | 'staff', avatar: user.avatar }
  } catch {
    return null
  }
}

/** Reads the session from the request cookie store (server components/route handlers). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySessionToken(token)
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })
}

export async function clearSessionCookie() {
  const store = await cookies()
  store.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
}

export async function revokeSession(token: string) {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    if (payload.jti) {
      await db.session.updateMany({
        where: { jti: payload.jti as string },
        data: { revokedAt: new Date() },
      })
    }
  } catch {
    /* already invalid */
  }
}

/**
 * Rolling renewal — keeps active users logged in even after closing the app.
 * If the session is valid but close to expiry, extends it and re-signs the JWT
 * (same jti) so the caller can refresh the cookie. Returns null when no
 * renewal is needed or the session is already invalid.
 */
export async function renewSessionIfNeeded(
  token: string
): Promise<{ token: string; expiresAt: Date } | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    if (!payload.jti || !payload.sub) return null
    const session = await db.session.findUnique({ where: { jti: payload.jti as string } })
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null

    const remaining = session.expiresAt.getTime() - Date.now()
    if (remaining > SESSION_RENEW_BEFORE_DAYS * 24 * 3600 * 1000) return null

    const expiresAt = new Date(Date.now() + sessionTtlMs())
    await db.session.update({ where: { jti: session.jti }, data: { expiresAt } })

    const refreshed = await new SignJWT({ role: payload.role as string, name: payload.name as string })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub as string)
      .setJti(session.jti)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(SECRET)
    return { token: refreshed, expiresAt }
  } catch {
    return null
  }
}

/** Revoke every active session of a user (credential/permission changes). */
export async function revokeAllUserSessions(userId: string) {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
