'use client'

/** Tiny fetch wrapper for the MIRTT API (same-origin, cookie auth). */
export class ApiError extends Error {
  status: number
  data: any
  constructor(message: string, status: number, data?: any) {
    super(message)
    this.status = status
    this.data = data
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  // WebAuthn endpoints need the browser's real origin: gateways/preview proxies
  // can rewrite the Host chain, and a mismatched RP ID makes Safari reject the
  // ceremony with SecurityError. The browser's own origin is the ground truth.
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (path.includes('/webauthn/') && typeof window !== 'undefined') {
    headers['x-webauthn-origin'] = window.location.origin
  }
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: opts.signal,
  })
  let data: any = null
  try {
    data = await res.json()
  } catch {
    /* empty body (e.g. CSV) */
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data)
  }
  return data as T
}

/** VAPID public key (base64url) → bytes for pushManager.subscribe. */
export function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
