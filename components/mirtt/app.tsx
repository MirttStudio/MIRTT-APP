'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Home, Package, ScanLine, Layers, Ellipsis, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { MirttLogo } from './logo'
import { useApp, type SessionUser } from '@/store/app'
import { api, urlB64ToUint8Array } from '@/lib/client-api'
import { useRealtime } from '@/hooks/use-realtime'
import { primeOrderSound } from '@/lib/order-sound'
import { SplashScreen, LoginScreen, UnlockScreen, BiometricEnrollSheet } from './auth-screens'
import { DashboardScreen } from './dashboard'
import { OrdersScreen, OrderDetailScreen } from './orders'
import { ScanScreen } from './scan'
import { InventoryScreen, ProductScreen } from './inventory'
import { ReturnsScreen, AnalyticsScreen, NotificationsScreen, SettingsScreen, AuditScreen, StaffScreen } from './more'
import { Avatar } from './bits'

type BootInfo = {
  user: SessionUser
  unread: number
  vapidPublicKey: string | null
  biometricEnrolled: boolean
}

export function MirttApp() {
  const {
    booted, session, route, unread, online, rt,
    setBooted, setSession, setUnread, setOnline, navigate, syncFromHash,
  } = useApp()
  useRealtime()

  // unlock the new-order sale sound: iOS allows programmatic audio only after
  // a user gesture, so the first tap anywhere primes a muted play/pause
  useEffect(() => {
    const prime = () => primeOrderSound()
    document.addEventListener('pointerdown', prime, { once: true, capture: true })
    return () => document.removeEventListener('pointerdown', prime, { capture: true })
  }, [])

  const [showEnroll, setShowEnroll] = useState(false)
  const [unlockMode, setUnlockMode] = useState(false)
  const enrollOffered = useRef(false)

  /* ── boot: session probe + service worker + connectivity ── */
  useEffect(() => {
    syncFromHash() // honor deep links on boot (e.g. #/orders/{id})
    const onHash = () => syncFromHash()
    window.addEventListener('hashchange', onHash)

    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    setOnline(navigator.onLine)

    // service worker (PWA install/offline/push) — skipped on localhost dev
    if ('serviceWorker' in navigator && !window.location.hostname.match(/^(localhost|127\.|0\.0\.0\.0)$/)) {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.error('[sw]', e))
    }

    ;(async () => {
      try {
        const me = await api<BootInfo>('/me')
        // Cold-open lock: a valid session cookie alone is NOT enough to enter
        // the app. The unlock flag lives in sessionStorage, which is wiped when
        // the app is fully closed — so every fresh open asks for the PIN (or
        // Face ID) again, while reloads inside the same session stay unlocked.
        if (sessionStorage.getItem('mirtt_unlocked') !== '1') {
          setSession(null)
        } else {
          setSession(me.user, {
            biometricEnrolled: me.biometricEnrolled,
            vapidPublicKey: me.vapidPublicKey,
          })
          setUnread(me.unread)
          healPushBinding(me.vapidPublicKey)
        }
      } catch {
        setSession(null)
      } finally {
        setBooted(true)
        // tell the raw-HTML SW-recovery watchdog that boot succeeded
        ;(window as any).__MIRTT_BOOTED = true
      }
    })()

    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
     
  }, [])

  /** Keep the server's push binding fresh + self-heal dead subscriptions:
   *  re-POSTs the device's existing subscription on every open (SW reinstalls
   *  and PWA re-installs silently invalidate the stored row), and if the OS
   *  permission is already granted but no subscription exists, quietly
   *  creates one — no prompts, no errors surfaced (Settings has diagnostics). */
  const healPushBinding = (vapid?: string | null) => {
    ;(async () => {
      try {
        if (!vapid || !('serviceWorker' in navigator) || !('PushManager' in window)) return
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('sw-timeout')), 8000)),
        ])
        let sub = await reg.pushManager.getSubscription()
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8Array(vapid),
          })
        }
        await api('/push/subscribe', {
          method: 'POST',
          body: { subscription: { endpoint: sub.endpoint, keys: sub.toJSON().keys } },
        })
      } catch {
        /* silent — push diagnostics live in Settings */
      }
    })()
  }

  const onLoggedIn = useCallback((user: SessionUser) => {
    // this session may enter the app — until it is fully closed again
    try { sessionStorage.setItem('mirtt_unlocked', '1') } catch {}
    ;(async () => {
      try {
        const me = await api<BootInfo>('/me')
        // merge the avatar from /me (login responses carry only id/name/role)
        setSession({ ...user, avatar: me.user.avatar ?? null }, {
          biometricEnrolled: me.biometricEnrolled,
          vapidPublicKey: me.vapidPublicKey,
        })
        setUnread(me.unread)
        healPushBinding(me.vapidPublicKey)
        // offer biometric enrollment on first login (per device) — never re-offer after a decline,
        // unless the user explicitly asked from the login screen (mirtt_biometric_want),
        // and never inside embedded previews where the browser blocks WebAuthn
        const inIframe = window.self !== window.top
        const enrolledDevice = localStorage.getItem('mirtt_biometric_device') === '1'
        const declinedDevice = localStorage.getItem('mirtt_biometric_dismissed') === '1'
        const wantDevice = localStorage.getItem('mirtt_biometric_want') === '1'
        if (!inIframe && !enrolledDevice && !enrollOffered.current && (!declinedDevice || wantDevice)) {
          enrollOffered.current = true
          if (wantDevice) { try { localStorage.removeItem('mirtt_biometric_want') } catch {} }
          setTimeout(() => setShowEnroll(true), 900)
        }
      } catch {
        setSession(user)
      }
    })()
  }, [setSession, setUnread])

  if (!booted) return <SplashScreen />

  if (!session) {
    if (unlockMode && localStorage.getItem('mirtt_biometric_device') === '1') {
      return (
        <UnlockScreen
          onLoggedIn={onLoggedIn}
          onFallback={() => setUnlockMode(false)}
        />
      )
    }
    return <LoginScreen onLoggedIn={onLoggedIn} />
  }

  const isAdmin = session.role === 'admin'

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-[var(--background)]">
      {!online && (
        <div className="flex items-center justify-center gap-2 bg-[#B4573E] py-1.5 text-[11px] font-semibold text-white">
          <WifiOff className="h-3.5 w-3.5" /> You are offline — changes wait for the network
        </div>
      )}

      <Header
        session={session}
        unread={unread}
        rt={rt}
        onBell={() => navigate('notifications')}
        onAvatar={() => navigate('settings')}
      />

      <main className="flex-1 px-4 pb-28 pt-2">
        {route.name === 'dashboard' && <DashboardScreen />}
        {route.name === 'orders' && <OrdersScreen />}
        {route.name === 'order' && <OrderDetailScreen id={route.params.id} />}
        {route.name === 'scan' && <ScanScreen />}
        {route.name === 'inventory' && <InventoryScreen />}
        {route.name === 'product' && <ProductScreen id={route.params.id} />}
        {route.name === 'returns' && <ReturnsScreen />}
        {route.name === 'analytics' && <AnalyticsScreen />}
        {route.name === 'notifications' && <NotificationsScreen />}
        {route.name === 'settings' && <SettingsScreen />}
        {route.name === 'audit' && <AuditScreen />}
        {route.name === 'staff' && <StaffScreen />}
      </main>

      <BottomNav route={route.name} isAdmin={isAdmin} onNavigate={navigate} />

      <BiometricEnrollSheet
        open={showEnroll}
        onDone={() => setShowEnroll(false)}
      />
    </div>
  )
}

/* ───────────────────────────── Header ───────────────────────────── */

function Header({
  session, unread, rt, onBell, onAvatar,
}: {
  session: SessionUser
  unread: number
  rt: 'connecting' | 'live' | 'offline'
  onBell: () => void
  onAvatar: () => void
}) {
  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good Morning'
    if (h < 17) return 'Good Afternoon'
    return 'Good Evening'
  })()
  const rtColor = rt === 'live' ? 'bg-[#5A7D4E]' : rt === 'connecting' ? 'bg-[#C98A2D]' : 'bg-[#B4573E]'
  const rtLabel = rt === 'live' ? 'Live' : rt === 'connecting' ? 'Syncing' : 'Offline'

  return (
    <header className="sticky top-0 z-30 bg-[var(--background)]/95 px-4 pb-2 pt-[max(14px,env(safe-area-inset-top))] backdrop-blur">
      <div className="flex items-center justify-between">
        <MirttLogo size={24} />
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full bg-[var(--card)] px-2.5 py-1 text-[10px] font-semibold text-[var(--muted-foreground)] shadow-sm">
            <span className={`h-1.5 w-1.5 rounded-full ${rtColor}`} data-state={rt} />
            {rtLabel}
          </span>
          <button
            onClick={onBell}
            aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
            className="relative flex h-10 w-10 items-center justify-center rounded-full bg-[var(--card)] shadow-sm transition active:scale-95"
          >
            <Bell className="h-5 w-5 text-[#3A3128]" />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#B4573E] px-1 text-[10px] font-bold text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
          <button onClick={onAvatar} aria-label="Settings and profile" className="transition active:scale-95">
            <Avatar name={session.name} src={session.avatar} size={40} />
          </button>
        </div>
      </div>
      <div className="mt-1.5">
        <h1 className="text-[22px] font-bold leading-tight text-[var(--foreground)]">
          {greeting} <span aria-hidden>👋</span>
        </h1>
      </div>
    </header>
  )
}

/* ───────────────────────────── Bottom nav ───────────────────────────── */

function BottomNav({
  route, isAdmin, onNavigate,
}: {
  route: string
  isAdmin: boolean
  onNavigate: (name: any) => void
}) {
  const items: Array<{ key: string; label: string; icon: any; action: () => void }> = [
    { key: 'dashboard', label: 'Home', icon: Home, action: () => onNavigate('dashboard') },
    { key: 'orders', label: 'Orders', icon: Package, action: () => onNavigate('orders') },
    { key: 'scan', label: 'Scan', icon: ScanLine, action: () => onNavigate('scan') },
    { key: 'inventory', label: 'Inventory', icon: Layers, action: () => onNavigate('inventory') },
    { key: 'more', label: 'More', icon: Ellipsis, action: () => onNavigate('settings') },
  ]
  const activeFor = (key: string) =>
    key === 'more'
      ? ['settings', 'returns', 'analytics', 'notifications', 'audit', 'staff'].includes(route)
      : key === 'dashboard'
        ? route === 'dashboard'
        : route === key || (key === 'inventory' && route === 'product') || (key === 'orders' && route === 'order')

  return (
    <nav
      aria-label="Main navigation"
      className="fixed bottom-0 left-1/2 z-40 w-full max-w-md -translate-x-1/2 border-t border-[var(--border)] bg-[var(--card)]/95 backdrop-blur"
      style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}
    >
      <div className="grid grid-cols-5">
        {items.map(({ key, label, icon: Icon, action }) => {
          const active = activeFor(key)
          const isScan = key === 'scan'
          return (
            <button
              key={key}
              onClick={action}
              aria-current={active ? 'page' : undefined}
              className="flex flex-col items-center gap-0.5 pb-0.5 pt-2.5"
            >
              <span
                className={
                  isScan
                    ? `flex h-10 w-10 -mt-4 items-center justify-center rounded-full shadow-lg transition ${active ? 'bg-[#17150F] text-[#E6DFD6]' : 'bg-[#17150F] text-[#E6DFD6]'}`
                    : undefined
                }
              >
                <Icon
                  className={isScan ? 'h-5 w-5' : `h-[22px] w-[22px] transition ${active ? 'text-[#17150F]' : 'text-[#A79D8A]'}`}
                  strokeWidth={active ? 2.4 : 2}
                />
              </span>
              <span className={`text-[10px] font-semibold ${active ? 'text-[#17150F]' : 'text-[#A79D8A]'}`}>
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
