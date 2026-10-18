import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, requireAuth } from '@/lib/api-helpers'

export const GET = requireAuth(['admin'], async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams
  const action = sp.get('action')
  const limit = Math.min(200, Math.max(10, parseInt(sp.get('limit') || '80', 10) || 80))
  const logs = await db.auditLog.findMany({
    where: action && action !== 'all' ? { action } : {},
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  const actions = await db.auditLog.findMany({ distinct: ['action'], select: { action: true } })
  return ok({ logs, actions: actions.map((a) => a.action) })
})
