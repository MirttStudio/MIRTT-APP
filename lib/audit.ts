/** Audit trail writer — never records credentials or tokens. */
import { db } from '@/lib/db'

export type AuditInput = {
  actorId?: string | null
  actorName?: string | null
  action: string
  tableName?: string | null
  recordId?: string | null
  oldValue?: unknown
  newValue?: unknown
}

export async function audit(input: AuditInput) {
  try {
    await db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        action: input.action,
        tableName: input.tableName ?? null,
        recordId: input.recordId ?? null,
        oldValue: input.oldValue === undefined ? null : JSON.stringify(sanitize(input.oldValue)),
        newValue: input.newValue === undefined ? null : JSON.stringify(sanitize(input.newValue)),
      },
    })
  } catch (e) {
    console.error('[audit] failed:', (e as Error).message)
  }
}

/** Defense-in-depth: strip anything that looks like a credential from audit JSON. */
const FORBIDDEN_KEYS = ['pin', 'pinhash', 'pinsalt', 'password', 'token', 'secret', 'auth', 'p256dh']
function sanitize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitize)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) { out[k] = '[redacted]'; continue }
    out[k] = sanitize(v)
  }
  return out
}
