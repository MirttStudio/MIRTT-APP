'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MirttLogo } from './logo'
import { BRAND } from '@/lib/brand'
import { api, ApiError } from '@/lib/client-api'
import { withScanTimeout } from '@/lib/biometric'
import { useApp, type SessionUser } from '@/store/app'
import { Spinner } from './bits'

/* ───────────────────────────── Splash ───────────────────────────── */

export function SplashScreen() {
  return (
    <div className="mirtt-paper flex min-h-dvh flex-col items-center justify-center" style={{ background: BRAND.black }}>
      <MirttLogo size={54} color={BRAND.stone} />
    </div>
  )
}

/* ───────────────────────────── Login ───────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function PinDots({ count, expected, error }: { count: number; expected: number; error: boolean }) {
  return (
    <div
      data-testid="pin-dots"
      className={`flex items-center justify-center gap-4 ${error ? 'animate-[mirtt-shake_0.4s_ease]' : ''}`}
    >
      {Array.from({ length: expected }).map((_, i) => (
        <span
          key={i}
          className={`h-3.5 w-3.5 rounded-full border transition-all duration-150 ${
            i < count
              ? 'border-[#17150F] bg-[#17150F]'
              : 'border-[#C9B89A] bg-transparent'
          }`}
        />
      ))}
    </div>
  )
}

function Key({
  label, onPress, disabled, ariaLabel,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel || `key ${label}`}
      className="flex h-16 items-center justify-center rounded-2xl bg-[#E6DFD6]/70 text-2xl font-semibold text-[#17150F] transition active:scale-95 active:bg-[#D9D5CC] disabled:opacity-40"
    >
      {label}
    </button>
  )
}

type BioProbe = 'supported' | 'embedded' | 'insecure' | 'unsupported'

export function LoginScreen({ onLoggedIn }: { onLoggedIn: (u: SessionUser) => void }) {
  const [role, setRole] = useState<'admin' | 'staff'>('admin')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const [bioProbe, setBioProbe] = useState<BioProbe | null>(null)
  const [biometricBusy, setBiometricBusy] = useState(false)
  const [bioSheet, setBioSheet] = useState<null | 'setup' | 'blocked'>(null)
  const [, setTick] = useState(0)
  const router = useRouter()
  const submitting = useRef(false)
  const authLibRef = useRef<any>(null)
  const authOptsRef = useRef<any>(null)

  const expectedLen = role === 'admin' ? 4 : 5
  const biometricDevice = typeof window !== 'undefined' && localStorage.getItem('mirtt_biometric_device') === '1'

  // tier probe: the Face ID button is ALWAYS offered on the login screen —
  // enrolled devices scan, un-enrolled devices get setup guidance, embedded
  // frames get "open in own tab" guidance (browsers block WebAuthn in iframes)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!window.isSecureContext) { setBioProbe('insecure'); return }
    if (window.self !== window.top) { setBioProbe('embedded'); return }
    const pk = (window as any).PublicKeyCredential
    if (!pk?.isUserVerifyingPlatformAuthenticatorAvailable) { setBioProbe('unsupported'); return }
    pk.isUserVerifyingPlatformAuthenticatorAvailable()
      .then((ok: boolean) => setBioProbe(ok ? 'supported' : 'unsupported'))
      .catch(() => setBioProbe('unsupported'))
  }, [])

  // pre-warm the unlock ceremony so the Face ID prompt opens instantly on tap (iOS requirement).
  // runs for EVERY supported device — not only flagged ones: un-flagged taps attempt the
  // ceremony too (a passkey may exist from another browser context), and importing the
  // library / fetching the challenge inside the tap would let the iOS activation expire.
  useEffect(() => {
    if (bioProbe !== 'supported') return
    ;(async () => {
      authLibRef.current = await import('@simplewebauthn/browser')
      try {
        authOptsRef.current = await api<any>('/auth/webauthn/auth-options', { method: 'POST' })
      } catch {
        /* fetched on tap instead */
      }
    })()
  }, [bioProbe])

  useEffect(() => {
    if (lockedUntil <= 0) return
    const t = setInterval(() => {
      setTick((x) => x + 1)
      if (Date.now() >= lockedUntil) setLockedUntil(0)
    }, 500)
    return () => clearInterval(t)
  }, [lockedUntil])

  const submit = useCallback(
    async (value: string) => {
      if (submitting.current) return
      submitting.current = true
      setBusy(true)
      setError(null)
      try {
        const res = await api<{ user: SessionUser }>('/auth/login', {
          method: 'POST',
          body: { role, pin: value },
        })
        onLoggedIn(res.user)
      } catch (e) {
        const ae = e as ApiError
        if (ae.status === 429) {
          setLockedUntil(Date.now() + (ae.data?.retryAfter || 60) * 1000)
          setError(ae.message)
        } else {
          setError(ae.message || 'Incorrect PIN')
          await sleep(250)
          setPin('')
        }
      } finally {
        setBusy(false)
        submitting.current = false
      }
    },
    [role, onLoggedIn]
  )

  const press = (d: string) => {
    if (busy || lockedUntil > 0) return
    setError(null)
    // PINs are exact-length per role (admin 4 / staff 5) — cap input there
    const next = (pin + d).slice(0, expectedLen)
    setPin(next)
    if (next.length === expectedLen) {
      setTimeout(() => submit(next), 280)
    }
  }

  const unlockWithBiometric = async (fallbackToGuide = false) => {
    setBiometricBusy(true)
    setError(null)
    try {
      let assertion: any
      if (authLibRef.current?.startAuthentication && authOptsRef.current) {
        // cached — the prompt opens instantly inside the tap
        assertion = await withScanTimeout(authLibRef.current.startAuthentication({ optionsJSON: authOptsRef.current }))
      } else {
        const { startAuthentication } = await import('@simplewebauthn/browser')
        const options = await api<any>('/auth/webauthn/auth-options', { method: 'POST' })
        assertion = await withScanTimeout(startAuthentication({ optionsJSON: options }))
      }
      const res = await api<{ user: SessionUser }>('/auth/webauthn/auth-verify', {
        method: 'POST',
        body: assertion,
      })
      // self-heal the per-device flag: a working passkey answered here, so this
      // browser context is enrolled even if it never ran the setup sheet
      try { localStorage.setItem('mirtt_biometric_device', '1') } catch {}
      onLoggedIn(res.user)
    } catch (e: any) {
      if ((e?.message || '').includes('Challenge expired')) authOptsRef.current = null
      if (fallbackToGuide && (e?.name === 'NotAllowedError' || e?.name === 'CeremonyTimeoutError')) {
        // no usable passkey answered on this device — guide the user into setup
        setBioSheet('setup')
      } else if (e?.name === 'CeremonyTimeoutError') {
        setError('Face ID didn\u2019t respond — use your PIN, or tap the fingerprint button to retry')
      } else {
        setError(e?.name === 'NotAllowedError' ? 'Biometric cancelled — use your PIN' : (e.message || 'Biometric failed'))
      }
    } finally {
      setBiometricBusy(false)
    }
  }

  const onFaceIdPress = () => {
    if (bioProbe === 'embedded' || bioProbe === 'insecure') { setBioSheet('blocked'); return }
    if (biometricDevice) { unlockWithBiometric(); return }
    // no local flag — but a passkey may still exist on this device (e.g. enrolled
    // from another browser context on the same domain, or an older install).
    // Try the ceremony first: the OS knows best. Fall back to setup guidance
    // only when no passkey answers.
    unlockWithBiometric(true)
  }

  const remainingSec = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000))

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--background)] px-6 pb-10 pt-[max(28px,env(safe-area-inset-top))]">
      <div className="mt-8 flex flex-col items-center">
        <MirttLogo size={40} />
      </div>

      <div className="mt-10 text-center">
        <h1 className="text-xl font-bold text-[var(--foreground)]">Welcome Back</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">Please enter your {expectedLen}-digit PIN</p>
      </div>

      {/* role selector */}
      <div className="mx-auto mt-5 flex rounded-full bg-[#E6DFD6]/60 p-1">
        {(['admin', 'staff'] as const).map((r) => (
          <button
            key={r}
            onClick={() => { setRole(r); setPin(''); setError(null) }}
            className={`h-9 rounded-full px-6 text-[13px] font-semibold capitalize transition ${
              role === r ? 'bg-[#17150F] text-[#E6DFD6] shadow' : 'text-[#5C564A]'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="mt-8">
        <PinDots count={pin.length} expected={expectedLen} error={!!error} />
        <div className="mt-3 h-5 text-center text-[13px] font-medium text-[#B4573E]" role="alert">
          {error || (remainingSec > 0 ? `Locked — try again in ${remainingSec}s` : '\u00A0')}
        </div>
      </div>

      <div className="mx-auto mt-4 grid w-full max-w-[320px] grid-cols-3 gap-3" aria-label="PIN keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Key key={d} label={d} onPress={() => press(d)} disabled={lockedUntil > 0} />
        ))}
        <Key
          label="✓"
          ariaLabel="submit PIN"
          onPress={() => pin.length === expectedLen && submit(pin)}
          disabled={pin.length !== expectedLen || busy || lockedUntil > 0}
        />
        <Key label="0" onPress={() => press('0')} disabled={lockedUntil > 0} />
        <Key
          label="⌫"
          ariaLabel="delete"
          onPress={() => setPin((p) => p.slice(0, -1))}
          disabled={lockedUntil > 0}
        />
      </div>

      <div className="mt-auto flex flex-col items-center gap-3 pt-8">
        {busy && <Spinner className="h-4 w-4" />}
        {bioProbe && bioProbe !== 'unsupported' && (
          <button
            onClick={onFaceIdPress}
            disabled={biometricBusy}
            className="flex flex-col items-center gap-1.5 text-[var(--muted-foreground)] transition active:scale-95"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#E6DFD6]/70">
              {biometricBusy ? (
                <Spinner className="h-5 w-5" />
              ) : (
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="#3A3128" strokeWidth="1.6" aria-hidden>
                  <path d="M12 11c0 3-.5 5.5-1.5 7.5M12 11c0-1.5-.8-2.5-2-2.5S8 9.5 8 11c0 3.5.3 6-.5 8M12 11c0-1.5.8-2.5 2-2.5s2 1 2 2.5c0 2.5-.2 4.5.3 6.5M4.8 7a9 9 0 0 1 14.4 0M6.5 20c-.4-1.7-.5-4-.5-6" strokeLinecap="round" />
                </svg>
              )}
            </span>
            <span className="text-xs font-semibold">or use Face ID</span>
          </button>
        )}
        {bioProbe === 'supported' && (
          <p className="max-w-[280px] text-center text-[10px] leading-relaxed text-[#A79D8A]">
            The iPhone shows its own quick “Continue” step first — that’s Apple’s passkey security — then Face ID scans.
          </p>
        )}
        <p className="text-[10px] text-[#A79D8A]">
          Secured session · {expectedLen}-digit initial PIN · attempts are rate-limited
        </p>
      </div>

      <FaceIdLoginSheet
        open={!!bioSheet}
        mode={bioSheet || 'setup'}
        onClose={() => setBioSheet(null)}
      />
    </div>
  )
}

/* ───────────────────── Face ID guidance on the login screen ───────────────────── */

function FaceIdLoginSheet({
  open, mode, onClose,
}: {
  open: boolean
  mode: 'setup' | 'blocked'
  onClose: () => void
}) {
  if (!open) return null
  const enableWant = () => {
    // remember the intent: right after the next PIN login, the enrollment offer
    // pops even if it was dismissed in the past
    try { localStorage.setItem('mirtt_biometric_want', '1') } catch {}
    onClose()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal aria-label="Face ID">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="pop-in relative w-full max-w-md rounded-t-3xl bg-[var(--card)] p-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#D9D5CC]" />
        {mode === 'setup' ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#E6DFD6]/70">
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="#3A3128" strokeWidth="1.5" aria-hidden>
                <path d="M12 11c0 3-.5 5.5-1.5 7.5M12 11c0-1.5-.8-2.5-2-2.5S8 9.5 8 11c0 3.5.3 6-.5 8M12 11c0-1.5.8-2.5 2-2.5s2 1 2 2.5c0 2.5-.2 4.5.3 6.5M4.8 7a9 9 0 0 1 14.4 0M6.5 20c-.4-1.7-.5-4-.5-6" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="mt-4 text-center text-base font-bold text-[var(--foreground)]">
              Sign in with Face ID
            </h3>
            <p className="mx-auto mt-2 max-w-[290px] text-center text-[13px] leading-relaxed text-[var(--muted-foreground)]">
              Face ID isn&apos;t set up on this device yet. Sign in with your PIN now — right after,
              MIRTT will offer to enable Face ID so next time you log in with just a glance.
            </p>
            <p className="mx-auto mt-3 max-w-[290px] text-center text-[11px] leading-relaxed text-[#A79D8A]">
              Note: each unlock shows a quick “Continue” step before the scan — that&apos;s the
              iPhone&apos;s own passkey confirmation, required by Apple for every website.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={onClose}
                className="h-12 flex-1 rounded-full border border-[var(--border)] bg-white text-sm font-semibold text-[#3A3128]"
              >
                Not now
              </button>
              <button
                onClick={enableWant}
                className="h-12 flex-1 rounded-full bg-[#17150F] text-sm font-semibold text-[#E6DFD6]"
              >
                Log in &amp; enable
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#F3E3C3]">
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="#8A6A1F" strokeWidth="1.5" aria-hidden>
                <path d="M12 11c0 3-.5 5.5-1.5 7.5M12 11c0-1.5-.8-2.5-2-2.5S8 9.5 8 11c0 3.5.3 6-.5 8M12 11c0-1.5.8-2.5 2-2.5s2 1 2 2.5c0 2.5-.2 4.5.3 6.5M4.8 7a9 9 0 0 1 14.4 0M6.5 20c-.4-1.7-.5-4-.5-6" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="mt-4 text-center text-base font-bold text-[var(--foreground)]">
              Open the app in its own tab first
            </h3>
            <p className="mx-auto mt-2 max-w-[290px] text-center text-[13px] leading-relaxed text-[var(--muted-foreground)]">
              Browsers block Face ID inside embedded previews and on insecure connections. Open
              MIRTT Manager in a separate browser tab (or from your Home Screen icon) — Face ID
              works there.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <a
                href="/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-12 items-center justify-center rounded-full bg-[#17150F] text-sm font-semibold text-[#E6DFD6]"
              >
                Open in new tab
              </a>
              <button
                onClick={onClose}
                className="h-12 rounded-full border border-[var(--border)] bg-white text-sm font-semibold text-[#3A3128]"
              >
                Got it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ───────────────────────────── Biometric unlock ───────────────────────────── */

export function UnlockScreen({ onLoggedIn, onFallback }: { onLoggedIn: (u: SessionUser) => void; onFallback: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const libRef = useRef<any>(null)
  const optsRef = useRef<any>(null)

  // pre-warm: import the library + fetch the challenge so the tap-to-retry starts instantly
  useEffect(() => {
    ;(async () => {
      libRef.current = await import('@simplewebauthn/browser')
      try {
        optsRef.current = await api<any>('/auth/webauthn/auth-options', { method: 'POST' })
      } catch {
        /* fetched on tap instead */
      }
    })()
  }, [])

  const tryUnlock = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      let assertion: any
      if (libRef.current?.startAuthentication && optsRef.current) {
        assertion = await withScanTimeout(libRef.current.startAuthentication({ optionsJSON: optsRef.current }))
      } else {
        const { startAuthentication } = await import('@simplewebauthn/browser')
        const options = await api<any>('/auth/webauthn/auth-options', { method: 'POST' })
        assertion = await withScanTimeout(startAuthentication({ optionsJSON: options }))
      }
      const res = await api<{ user: SessionUser }>('/auth/webauthn/auth-verify', { method: 'POST', body: assertion })
      onLoggedIn(res.user)
    } catch (e: any) {
      if ((e?.message || '').includes('Challenge expired')) optsRef.current = null
      if (e?.name === 'CeremonyTimeoutError') {
        setError('Face ID didn\u2019t respond — tap the icon to retry or use your PIN')
      } else {
        setError(e?.name === 'NotAllowedError' ? 'Unlock cancelled' : e.message || 'Unlock failed')
      }
    } finally {
      setBusy(false)
    }
  }, [onLoggedIn])

  useEffect(() => {
    // if biometrics can't run here (embedded preview / insecure context), go straight to the PIN pad
    if (typeof window !== 'undefined' && (window.self !== window.top || !window.isSecureContext)) {
      onFallback()
      return
    }
    const t = setTimeout(tryUnlock, 600)
    return () => clearTimeout(t)
  }, [tryUnlock, onFallback])

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-[var(--background)] px-8">
      <button
        onClick={tryUnlock}
        disabled={busy}
        className="flex h-28 w-28 items-center justify-center rounded-full bg-[#E6DFD6]/60 transition active:scale-95"
        aria-label="Unlock with biometrics"
      >
        {busy ? (
          <Spinner className="h-8 w-8" />
        ) : (
          <svg viewBox="0 0 24 24" className="h-14 w-14" fill="none" stroke="#3A3128" strokeWidth="1.4" aria-hidden>
            <path d="M12 11c0 3-.5 5.5-1.5 7.5M12 11c0-1.5-.8-2.5-2-2.5S8 9.5 8 11c0 3.5.3 6-.5 8M12 11c0-1.5.8-2.5 2-2.5s2 1 2 2.5c0 2.5-.2 4.5.3 6.5M4.8 7a9 9 0 0 1 14.4 0M6.5 20c-.4-1.7-.5-4-.5-6" strokeLinecap="round" />
          </svg>
        )}
      </button>
      <h1 className="mt-7 text-center text-lg font-bold leading-snug text-[var(--foreground)]">
        Unlock with Face ID
        <br />or Fingerprint
      </h1>
      {error && <p className="mt-2 text-sm text-[#B4573E]">{error}</p>}
      <button
        onClick={onFallback}
        className="mt-10 h-12 w-full max-w-xs rounded-full bg-[#17150F] text-sm font-semibold text-[#E6DFD6]"
      >
        Use PIN instead
      </button>
    </div>
  )
}

/* ───────────────────────────── Biometric enrollment offer ───────────────────────────── */

export function BiometricEnrollSheet({
  open, onDone,
}: {
  open: boolean
  onDone: (enrolled: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [supported, setSupported] = useState(true)
  const [ready, setReady] = useState(false)
  const libRef = useRef<any>(null)
  const optionsRef = useRef<any>(null)
  const fetchedAtRef = useRef(0)

  const fetchOptions = useCallback(async () => {
    if (optionsRef.current && Date.now() - fetchedAtRef.current < 55_000) return
    try {
      optionsRef.current = await api<any>('/auth/webauthn/register-options', { method: 'POST' })
      fetchedAtRef.current = Date.now()
      setReady(true)
    } catch {
      /* retried by the interval below */
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const pk = (window as any).PublicKeyCredential
    const blocked = window.self !== window.top || !window.isSecureContext || !pk?.isUserVerifyingPlatformAuthenticatorAvailable
    if (blocked) {
      setSupported(false)
      return
    }
    pk.isUserVerifyingPlatformAuthenticatorAvailable()
      .then(async (ok: boolean) => {
        setSupported(!!ok)
        if (ok) {
          // pre-warm so the Enable tap starts the scan instantly (iOS requirement)
          libRef.current = await import('@simplewebauthn/browser')
          fetchOptions()
        }
      })
      .catch(() => setSupported(false))
    const t = setInterval(fetchOptions, 5_000)
    return () => clearInterval(t)
  }, [open, fetchOptions])

  if (!open) return null

  const enroll = async () => {
    setBusy(true)
    try {
      // starts inside the tap gesture — required for iOS to show the prompt
      const attestation = await withScanTimeout(
        libRef.current.startRegistration({ optionsJSON: optionsRef.current }),
      )
      await api('/auth/webauthn/register-verify', { method: 'POST', body: attestation })
      localStorage.setItem('mirtt_biometric_device', '1')
      toast.success('Biometric unlock enabled on this device')
      onDone(true)
    } catch (e: any) {
      if (e?.name === 'InvalidStateError') {
        localStorage.setItem('mirtt_biometric_device', '1') // self-heal the per-device flag
        toast('This device is already enrolled')
        onDone(true)
      } else if (e?.name === 'CeremonyTimeoutError') {
        toast.error('The Face ID window never appeared — open the app in its own Safari tab and try again from Settings')
        onDone(false)
      } else {
        toast.error('Enrollment failed — you can enable it later in Settings')
        onDone(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal aria-label="Enable biometric unlock">
      <div className="absolute inset-0 bg-black/45" />
      <div className="pop-in relative w-full max-w-md rounded-t-3xl bg-[var(--card)] p-6 pb-[max(24px,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#D9D5CC]" />
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#E6DFD6]/70">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="#3A3128" strokeWidth="1.5" aria-hidden>
            <path d="M12 11c0 3-.5 5.5-1.5 7.5M12 11c0-1.5-.8-2.5-2-2.5S8 9.5 8 11c0 3.5.3 6-.5 8M12 11c0-1.5.8-2.5 2-2.5s2 1 2 2.5c0 2.5-.2 4.5.3 6.5M4.8 7a9 9 0 0 1 14.4 0M6.5 20c-.4-1.7-.5-4-.5-6" strokeLinecap="round" />
          </svg>
        </div>
        <h3 className="mt-4 text-center text-base font-bold text-[var(--foreground)]">
          Enable Face ID / Biometric unlock?
        </h3>
        <p className="mx-auto mt-2 max-w-[280px] text-center text-[13px] leading-relaxed text-[var(--muted-foreground)]">
          Unlock MIRTT Manager with your device&apos;s Face ID or fingerprint after your first login.
          Verification is handled securely by your device — {supported ? 'it looks supported here.' : 'it may not be supported on this device.'}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => {
              // remember the decline per device so the offer never blocks the app again
              try { localStorage.setItem('mirtt_biometric_dismissed', '1') } catch {}
              onDone(false)
            }}
            className="h-12 flex-1 rounded-full border border-[var(--border)] bg-white text-sm font-semibold text-[#3A3128]"
            disabled={busy}
          >
            Not now
          </button>
          <button
            onClick={enroll}
            className="h-12 flex-1 rounded-full bg-[#17150F] text-sm font-semibold text-[#E6DFD6] disabled:opacity-60"
            disabled={busy || !supported || !ready}
          >
            {busy ? 'Setting up…' : ready ? 'Enable' : 'Preparing…'}
          </button>
        </div>
      </div>
    </div>
  )
}
