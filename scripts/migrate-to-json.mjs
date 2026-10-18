/**
 * One-off migration: dump the app-owned tables from the old local SQLite
 * (Prisma) into the shared `.data` folder as `pwa-*.json` files, so the app
 * keeps its accounts (PIN hashes), notifications, returns, stock movements
 * and audit trail after switching to the shared JSON store.
 *
 * Run:  node --env-file=.env scripts/migrate-to-json.mjs
 */
import { PrismaClient } from '@prisma/client'
import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'

const envText = await readFile('.env', 'utf8').catch(() => '')
const dataDir = (process.env.MIRTT_DATA_DIR
  || (envText.match(/^\s*MIRTT_DATA_DIR\s*=\s*(.+)$/m)?.[1] || '').trim()
  || path.join(process.cwd(), '.data')).replace(/^"|"$/g, '')

const prisma = new PrismaClient()

async function dump(model, file) {
  const rows = await prisma[model].findMany()
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, file), JSON.stringify(rows, null, 1), 'utf8')
  console.log(`  ${file.padEnd(28)} ${rows.length} rows`)
}

const jobs = [
  ['user', 'pwa-users.json'],
  ['session', 'pwa-sessions.json'],
  ['webAuthnCredential', 'pwa-webauthn.json'],
  ['notification', 'pwa-notifications.json'],
  ['pushSubscription', 'pwa-push-subscriptions.json'],
  ['notificationPref', 'pwa-notification-prefs.json'],
  ['returnRequest', 'pwa-returns.json'],
  ['stockMovement', 'pwa-stock-movements.json'],
  ['orderEvent', 'pwa-order-events.json'],
  ['orderNote', 'pwa-order-notes.json'],
  ['auditLog', 'pwa-audit-log.json'],
]

try {
  console.log(`Migrating local tables → ${dataDir}`)
  for (const [model, file] of jobs) {
    try { await dump(model, file) } catch (e) { console.log(`  ${file} skipped (${e.message})`) }
  }
  console.log('Done.')
} finally {
  await prisma.$disconnect()
}
