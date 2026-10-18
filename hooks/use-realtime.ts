'use client'

/**
 * Realtime hookup — authenticated socket.io via the same-origin gateway.
 * Handles live events (orders/stock/returns/notifications), connection
 * state indicators, and foreground consistency checks.
 */
import { useEffect } from 'react'
import { io, Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { useApp } from '@/store/app'
import { api } from '@/lib/client-api'
import { playNotifyBeep, playOrderSaleSound } from '@/lib/order-sound'

export function useRealtime() {
  const sessionId = useApp((s) => s.session?.id)

  useEffect(() => {
    if (!sessionId) return

    let socket: Socket | null = null
    let disposed = false
    const { setRt, bump, setUnread } = useApp.getState()

    // Web-Push fallback while the app is open: the SW suppresses the OS
    // banner + its default system tone for focused clients and forwards the
    // payload here instead. If the socket is already live it delivered this
    // event, so the message is ignored — otherwise it replays the cue.
    const onSwMessage = (e: MessageEvent) => {
      const data: any = e.data
      if (data?.type !== 'mirtt-push' || !data.payload) return
      if (useApp.getState().rt === 'live') return
      handleEvent(
        {
          id: String(data.payload.id || `push-${Date.now()}`),
          type: 'notification:new',
          at: new Date().toISOString(),
          payload: {
            type: data.payload.type,
            title: data.payload.title,
            body: data.payload.body,
            url: data.payload.url,
          },
        },
        { bump, setUnread, setRt }
      )
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onSwMessage)
    }

    const connect = () => {
      socket = io('/?XTransformPort=3003', {
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
        randomizationFactor: 0.5,
        timeout: 10000,
        withCredentials: true,
      })

      socket.on('connect', () => {
        setRt('live')
        // resync notification count after any gap
        api<{ unread: number }>('/notifications?filter=unread')
          .then((r) => setUnread(r.unread))
          .catch(() => {})
      })

      socket.on('reconnect_attempt', () => setRt('connecting'))
      socket.io.on('reconnect_attempt', () => setRt('connecting'))
      socket.on('disconnect', () => setRt('offline'))
      socket.on('connect_error', () => setRt('connecting'))

      socket.on('rt', (envelope: { id: string; type: string; at: string; payload: any }) => {
        if (!envelope?.type) return
        handleEvent(envelope, { bump, setUnread, setRt })
      })
    }

    connect()

    // Foreground consistency check (mobile OS may suspend the socket).
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (socket?.connected) {
        api<{ unread: number }>('/notifications?filter=unread')
          .then((r) => setUnread(r.unread))
          .catch(() => {})
        bump('dashboard')
      } else {
        setRt('connecting')
        socket?.connect()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisible)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage)
      }
      socket?.disconnect()
      socket = null
    }
  }, [sessionId])
}

function handleEvent(
  envelope: { id: string; type: string; at?: string; payload: any },
  ctx: { bump: (s: 'dashboard' | 'orders' | 'notif' | 'inventory' | 'returns') => void; setUnread: (n: number) => void; setRt: (v: 'connecting' | 'live' | 'offline') => void }
) {
  const { bump, setUnread } = ctx
  switch (envelope.type) {
    case 'order:created':
      bump('orders'); bump('dashboard')
      playOrderSaleSound() // cha-ching — new sale only, nothing else
      toast('New order received', {
        description: `${envelope.payload?.orderNumber || ''} — tap to open`,
        action: envelope.payload?.orderId
          ? { label: 'View', onClick: () => { window.location.hash = `#/orders/${envelope.payload.orderId}` } }
          : undefined,
      })
      break
    case 'order:updated':
      bump('orders'); bump('dashboard')
      if (envelope.payload?.kind === 'delivery_failed') {
        toast.warning('Failed delivery attempt', { description: envelope.payload?.orderNumber })
      }
      break
    case 'stock:updated':
      bump('inventory'); bump('dashboard')
      break
    case 'product:updated':
      bump('inventory')
      break
    case 'return:updated':
      bump('returns'); bump('dashboard')
      break
    case 'notification:new': {
      bump('notif')
      useApp.setState((s) => ({ unread: s.unread + 1 }))
      // sound scope: NEW orders → sale cha-ching; every other notification → beep
      if (envelope.payload?.type === 'new_order') playOrderSaleSound()
      else playNotifyBeep()
      if (envelope.payload?.title) {
        toast(envelope.payload.title, {
          description: envelope.payload.body,
          action: envelope.payload?.url
            ? { label: 'Open', onClick: () => { window.location.hash = String(envelope.payload.url).replace(/^#/, '#') } }
            : undefined,
        })
      }
      break
    }
    case 'notification:read':
      if (typeof envelope.payload?.unread === 'number') setUnread(envelope.payload.unread)
      break
    case 'dashboard:dirty':
      bump('dashboard')
      break
  }
}
