/**
 * Shared API helpers: auth guard for route handlers + typed JSON responses.
 * RBAC is enforced HERE (backend) on every protected endpoint — never in UI.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, renewSessionIfNeeded, SESSION_COOKIE, type SessionUser } from '@/lib/auth'

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data as any, { status: init ?? 200 })
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra || {}) }, { status })
}

export const GENERIC_ERROR = 'Something went wrong. Please try again.'

/**
 * Wraps a route handler behind server-side auth + optional role allow-list.
 * Deny by default when the session or role is absent/unknown.
 */
export function requireAuth(
  roles: Array<'admin' | 'staff'>,
  handler: (req: NextRequest, user: SessionUser, ctx: any) => Promise<NextResponse> | NextResponse
) {
  return async (req: NextRequest, ctx?: any) => {
    const token = req.cookies.get(SESSION_COOKIE)?.value
    const user = await getSessionUser()
    if (!user) return fail('Authentication required', 401)
    if (roles.length > 0 && !roles.includes(user.role)) {
      return fail('You do not have permission to perform this action', 403)
    }
    try {
      const res = await handler(req, user, ctx)
      // rolling renewal: any successful authenticated call slides the session window forward,
      // so the app stays logged in across restarts as long as it is used at least weekly
      if (token && res?.ok) {
        const renewed = await renewSessionIfNeeded(token)
        if (renewed) {
          res.cookies.set(SESSION_COOKIE, renewed.token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            path: '/',
            expires: renewed.expiresAt,
          })
        }
      }
      return res
    } catch (e) {
      console.error('[api]', (e as Error).message)
      return fail(GENERIC_ERROR, 500)
    }
  }
}

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'local'
  )
}

/** Parse + validate a JSON body with a size cap. */
export async function readJson<T = any>(req: NextRequest, maxBytes = 20_000): Promise<T | null> {
  const text = await req.text()
  if (text.length > maxBytes) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
