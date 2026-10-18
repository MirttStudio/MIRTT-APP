import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, requireAuth } from '@/lib/api-helpers'
import { parseRange } from '@/app/api/dashboard/route'

/**
 * Analytics — real DB data, documented formulas (see README §Formulas):
 *  Gross Sales   = Σ subtotal (non-cancelled)
 *  Discounts     = Σ discount_amount
 *  Net Sales     = Gross − Discounts
 *  Revenue       = Σ total (Net Sales + shipping, COD collected)
 *  AOV           = Net Sales / non-cancelled orders
 *  Delivery rate = (delivered+completed) / (shipped+delivered+completed+returned)
 *  Cancel rate   = cancelled / all orders
 *  Return rate   = return requests / non-cancelled orders
 *  Processing    = median hours from created→delivered (orders with both events)
 */
export const GET = requireAuth(['admin'], async (req: NextRequest) => {
  const { from, to } = parseRange(req)

  const [orders, returns, items] = await Promise.all([
    db.order.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: {
        id: true, status: true, subtotal: true, total: true, shippingFee: true,
        discountAmount: true, phone: true, createdAt: true,
      },
    }),
    db.returnRequest.count({ where: { createdAt: { gte: from, lte: to } } }),
    db.orderItem.findMany({
      where: { order: { createdAt: { gte: from, lte: to }, status: { not: 'cancelled' } } },
      select: { productNameSnapshot: true, colorName: true, size: true, quantity: true, lineTotal: true, productId: true },
    }),
  ])

  const active = orders.filter((o) => o.status !== 'cancelled')
  const gross = active.reduce((s, o) => s + o.subtotal, 0)
  const discounts = active.reduce((s, o) => s + o.discountAmount, 0)
  const netSales = gross - discounts
  const revenue = active.reduce((s, o) => s + o.total, 0)
  const aov = active.length ? netSales / active.length : 0

  const byStatus: Record<string, number> = {}
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1
  const deliveredOk = (byStatus.delivered || 0) + (byStatus.completed || 0)
  const deliveryBase = deliveredOk + (byStatus.shipped || 0) + (byStatus.returned || 0)

  // daily series
  const series: { date: string; revenue: number; orders: number }[] = []
  const dayMap = new Map<string, { revenue: number; orders: number }>()
  for (const o of active) {
    const key = o.createdAt.toISOString().slice(0, 10)
    const e = dayMap.get(key) || { revenue: 0, orders: 0 }
    e.revenue += o.total
    e.orders += 1
    dayMap.set(key, e)
  }
  const cursor = new Date(from)
  while (cursor <= to) {
    const key = cursor.toISOString().slice(0, 10)
    const e = dayMap.get(key) || { revenue: 0, orders: 0 }
    series.push({ date: key, ...e })
    cursor.setDate(cursor.getDate() + 1)
  }

  // top products / sizes / colors
  const prodMap = new Map<string, { name: string; units: number; revenue: number }>()
  const sizeMap = new Map<string, number>()
  const colorMap = new Map<string, number>()
  for (const it of items) {
    const p = prodMap.get(it.productNameSnapshot) || { name: it.productNameSnapshot, units: 0, revenue: 0 }
    p.units += it.quantity
    p.revenue += it.lineTotal
    prodMap.set(it.productNameSnapshot, p)
    if (it.size) sizeMap.set(it.size, (sizeMap.get(it.size) || 0) + it.quantity)
    if (it.colorName) colorMap.set(it.colorName, (colorMap.get(it.colorName) || 0) + it.quantity)
  }
  const topProducts = [...prodMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8)

  // new vs returning customers (by phone)
  const phones = new Set(active.map((o) => o.phone))
  let returning = 0
  for (const phone of phones) {
    const first = await db.order.findFirst({ where: { phone }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    if (first && first.createdAt < from) returning++
  }
  const newCustomers = Math.max(0, phones.size - returning)

  // avg processing time (created → delivered)
  const deliveredOrders = await db.order.findMany({
    where: { status: { in: ['delivered', 'completed'] }, createdAt: { gte: from, lte: to } },
    select: { createdAt: true, events: { where: { toStatus: 'delivered' }, select: { createdAt: true }, take: 1, orderBy: { createdAt: 'desc' } } },
  })
  const durations = deliveredOrders
    .filter((o) => o.events.length > 0)
    .map((o) => (o.events[0].createdAt.getTime() - o.createdAt.getTime()) / 3600000)
    .sort((a, b) => a - b)
  const avgProcessing = durations.length
    ? Math.round((durations.reduce((s, d) => s + d, 0) / durations.length) * 10) / 10
    : null

  return ok({
    totals: {
      grossSales: Math.round(gross * 100) / 100,
      discounts: Math.round(discounts * 100) / 100,
      netSales: Math.round(netSales * 100) / 100,
      revenue: Math.round(revenue * 100) / 100,
      orders: orders.length,
      aov: Math.round(aov * 100) / 100,
      deliveryRate: deliveryBase ? Math.round((deliveredOk / deliveryBase) * 1000) / 10 : null,
      cancelRate: orders.length ? Math.round(((byStatus.cancelled || 0) / orders.length) * 1000) / 10 : 0,
      returnRate: active.length ? Math.round((returns / active.length) * 1000) / 10 : 0,
      avgProcessingHours: avgProcessing,
      customers: phones.size,
      newCustomers,
      returningCustomers: returning,
      repeatRate: phones.size ? Math.round((returning / phones.size) * 1000) / 10 : 0,
    },
    series,
    byStatus,
    topProducts,
    topSizes: [...sizeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([size, units]) => ({ size, units })),
    topColors: [...colorMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([color, units]) => ({ color, units })),
  })
})
