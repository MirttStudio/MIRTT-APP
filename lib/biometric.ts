/**
 * WebAuthn ceremony guard.
 *
 * Some devices/browsers start the ceremony but NEVER display the system
 * Face ID / Touch ID window (older iOS, WebKit quirks, device restrictions,
 * or a browser bug). The `navigator.credentials.create/get` promise then
 * stays pending forever and the UI is stuck on "Waiting for scan…".
 *
 * withScanTimeout() bounds the wait so the UI can always recover with
 * actionable guidance instead of trapping the user.
 */

export class CeremonyTimeoutError extends Error {
  constructor() {
    super('The Face ID window never appeared')
    this.name = 'CeremonyTimeoutError'
  }
}

/** Real devices show the OS prompt in under a second when it works — 20s is generous. */
const DEFAULT_TIMEOUT_MS = 20_000

/** Debug/E2E hook: localStorage.mirtt_scan_timeout_ms overrides the default (min 1s). */
export function scanTimeoutMs(): number {
  if (typeof window === 'undefined') return DEFAULT_TIMEOUT_MS
  const v = Number(localStorage.getItem('mirtt_scan_timeout_ms'))
  return Number.isFinite(v) && v >= 1_000 ? v : DEFAULT_TIMEOUT_MS
}

export function withScanTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  const limit = ms ?? scanTimeoutMs()
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new CeremonyTimeoutError()), limit)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

/** One-line support context: where the ceremony ran + the raw error name. */
export function biometricDiag(e: unknown): string {
  if (typeof window === 'undefined') return String((e as any)?.name || 'Error')
  const top = (() => { try { return window.self === window.top } catch { return false } })()
  const host = window.location.host
  const secure = window.isSecureContext ? 'secure' : 'NOT secure'
  const name = (e as any)?.name || 'Error'
  return `${host} · ${secure} · ${top ? 'top window' : 'embedded'} · ${name}`
}
