/**
 * Live push-delivery probe: sends a real Web Push to EVERY stored subscription
 * and prints the per-device result (HTTP status from fcm/web.push.apple.com).
 * Usage: bun scripts/push_probe.ts
 */
import webpush from 'web-push'
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'

const env = readFileSync('/home/z/my-project/.env', 'utf8')
const pub = env.match(/VAPID_PUBLIC_KEY=(.+)/)?.[1]?.trim()
const priv = env.match(/VAPID_PRIVATE_KEY=(.+)/)?.[1]?.trim()
if (!pub || !priv) { console.error('NO VAPID KEYS'); process.exit(1) }
webpush.setVapidDetails('mailto:admin@mirtt.eg', pub, priv)

const db = new PrismaClient()
const subs = await db.pushSubscription.findMany()
console.log('subs:', subs.length)
for (const s of subs) {
  const isApple = s.endpoint.includes('web.push.apple.com')
  try {
    const res = await webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify({
        id: 'probe-' + Date.now(),
        title: 'MIRTT — delivery probe',
        body: isApple ? 'iOS/Apple push device' : 'FCM (Chrome-family iOS) device',
        tag: 'probe',
      }),
      { TTL: 300 }
    )
    console.log('OK  ', res.statusCode, s.endpoint.slice(8, 40), '| ua:', (s.userAgent || '').slice(5, 40))
  } catch (e: any) {
    console.log('FAIL', s.endpoint.slice(8, 40),
      '| status:', e?.statusCode,
      '| body:', String(e?.body || e?.message).slice(0, 160),
      '| ua:', (s.userAgent || '').slice(5, 40))
  }
}
await db.$disconnect()
