/**
 * MIRTT Manager — seed script
 * Provisions initial accounts (Admin 2026 / Staff 20060) with scrypt-hashed
 * PINs, catalog, 45 days of orders, returns, notifications and audit entries.
 * Run: bun scripts/seed.ts
 */
import { PrismaClient } from '@prisma/client'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

const db = new PrismaClient()

export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('base64url')
  const hash = scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')
  return { hash, salt }
}

const daysAgo = (d: number, h = 12, m = 0) => {
  const t = new Date()
  t.setDate(t.getDate() - d)
  t.setHours(h, m, Math.floor(Math.random() * 60), 0)
  return t
}

const FIRST = ['Ahmed', 'Sara', 'Mohamed', 'Nour', 'Youssef', 'Mariam', 'Omar', 'Salma', 'Karim', 'Hana', 'Ali', 'Dina', 'Mostafa', 'Farida', 'Tarek', 'Aya', 'Hassan', 'Menna', 'Khaled', 'Laila']
const LAST = ['Mohamed', 'Ali', 'Hassan', 'Ibrahim', 'Tarek', 'Adel', 'Khaled', 'Fathy', 'Nasser', 'Mostafa', 'Gamal', 'Samir', 'ElSayed', 'Fouad', 'Zaki']
const GOVS = [
  { name: 'Cairo', fee: 30, cities: ['Nasr City', 'Maadi', 'Zamalek', 'Heliopolis', 'New Cairo'] },
  { name: 'Giza', fee: 35, cities: ['Dokki', 'Mohandessin', '6th of October', 'Sheikh Zayed', 'Imbaba'] },
  { name: 'Alexandria', fee: 40, cities: ['Smouha', 'Gleem', 'San Stefano', 'Miami'] },
  { name: 'Delta', fee: 50, cities: ['Mansoura', 'Tanta', 'Zagazig'] },
  { name: 'Upper Egypt', fee: 50, cities: ['Assiut', 'Sohag', 'Minya'] },
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

async function main() {
  console.log('── Clearing …')
  await db.deleteManyInOrder?.().catch(() => {})
  for (const m of ['auditLog', 'notificationPref', 'pushSubscription', 'notification', 'stockMovement', 'returnRequest', 'orderNote', 'orderEvent', 'orderItem', 'order', 'productImage', 'productVariant', 'product', 'collection', 'webAuthnCredential', 'session', 'user']) {
    // @ts-extract-any
    await (db as any)[m].deleteMany()
  }

  console.log('── Users …')
  const admin = await db.user.create({
    data: {
      fullName: 'Mirtt Admin',
      role: 'admin',
      email: 'admin@mirtt.eg',
      ...(() => { const h = hashPin('2026'); return { pinHash: h.hash, pinSalt: h.salt } })(),
    },
  })
  const staffAhmed = await db.user.create({
    data: {
      fullName: 'Ahmed Samir',
      role: 'staff',
      email: 'ahmed@mirtt.eg',
      ...(() => { const h = hashPin('20060'); return { pinHash: h.hash, pinSalt: h.salt } })(),
    },
  })
  const staffSara = await db.user.create({
    data: {
      fullName: 'Sara Ali',
      role: 'staff',
      email: 'sara@mirtt.eg',
      ...(() => { const h = hashPin('20060'); return { pinHash: h.hash, pinSalt: h.salt } })(),
    },
  })
  for (const u of [admin, staffAhmed, staffSara]) {
    await db.notificationPref.create({ data: { userId: u.id } })
  }

  console.log('── Catalog …')
  const collWinter = await db.collection.create({ data: { name: 'Winter 2025', slug: 'winter-2025', description: 'Heavyweight essentials for cold Cairo nights.' } })
  await db.collection.create({ data: { name: 'Essentials', slug: 'essentials', description: 'Everyday streetwear staples.' } })
  await db.collection.create({ data: { name: 'Denim', slug: 'denim', description: 'Raw and washed denim.' } })

  async function product(p: {
    name: string, slug: string, category: string, sku: string, price: number, salePrice?: number, discountActive?: boolean,
    sizeType: 'letters' | 'numbers' | null, threshold: number, collId?: string, lowThreshold?: number,
    variants: { color: string, hex: string, sizes: [string, number][] }[]
  }) {
    let total = 0
    for (const v of p.variants) for (const [, s] of v.sizes) total += s
    const prod = await db.product.create({
      data: {
        name: p.name, slug: p.slug, category: p.category, sku: p.sku,
        price: p.price, salePrice: p.salePrice ?? null, discountActive: p.discountActive ?? false,
        sizeType: p.sizeType, lowStockThreshold: p.lowThreshold ?? 10, stockTotal: total,
        collectionId: undefined,
      },
    })
    for (const v of p.variants) {
      for (const [size, stock] of v.sizes) {
        await db.productVariant.create({
          data: {
            productId: prod.id, colorName: v.color, colorHex: v.hex, size,
            stock, sku: `${p.sku}-${v.color.slice(0, 2).toUpperCase()}${size}`,
          },
        })
      }
    }
    return prod
  }

  const leather = await product({
    name: 'Leather Jacket', slug: 'leather-jacket', category: 'Outerwear', sku: 'LJ001',
    price: 4500, sizeType: 'letters', lowThreshold: 10, collId: collWinter.id,
    variants: [
      { color: 'Black', hex: '#171717', sizes: [['S', 6], ['M', 12], ['L', 14], ['XL', 8]] },
      { color: 'Earth Brown', hex: '#3A3128', sizes: [['S', 4], ['M', 7], ['L', 5], ['XL', 2]] },
    ],
  })
  const hoodie = await product({
    name: 'Oversized Hoodie', slug: 'oversized-hoodie', category: 'Tops', sku: 'H002',
    price: 1350, sizeType: 'letters', lowThreshold: 50, collId: collWinter.id,
    variants: [
      { color: 'Black', hex: '#171717', sizes: [['S', 8], ['M', 12], ['L', 10], ['XL', 5]] },
      { color: 'Sand', hex: '#C9B89A', sizes: [['S', 4], ['M', 4], ['L', 2], ['XL', 0]] },
      { color: 'Olive', hex: '#4A4F3A', sizes: [['S', 0], ['M', 0], ['L', 0], ['XL', 0]] },
    ],
  })
  const jeans = await product({
    name: 'Straight Jeans', slug: 'straight-jeans', category: 'Bottoms', sku: 'J003',
    price: 1600, sizeType: 'numbers', lowThreshold: 10,
    variants: [
      { color: 'Raw Blue', hex: '#2E3A4E', sizes: [['28', 0], ['30', 0], ['32', 0], ['34', 0], ['36', 0], ['38', 0]] },
    ],
  })
  const tee = await product({
    name: 'Boxy Tee', slug: 'boxy-tee', category: 'Tops', sku: 'T004',
    price: 750, sizeType: 'letters', lowThreshold: 15,
    variants: [
      { color: 'Black', hex: '#171717', sizes: [['S', 20], ['M', 30], ['L', 26], ['XL', 14]] },
      { color: 'Stone', hex: '#D9D5CC', sizes: [['S', 12], ['M', 18], ['L', 15], ['XL', 9]] },
    ],
  })
  const cargo = await product({
    name: 'Cargo Pants', slug: 'cargo-pants', category: 'Bottoms', sku: 'C005',
    price: 1850, sizeType: 'letters', lowThreshold: 12,
    variants: [
      { color: 'Olive', hex: '#4A4F3A', sizes: [['S', 6], ['M', 9], ['L', 7], ['XL', 3]] },
      { color: 'Black', hex: '#171717', sizes: [['S', 5], ['M', 8], ['L', 6], ['XL', 4]] },
    ],
  })
  const cap = await product({
    name: 'MIRTT Cap', slug: 'mirtt-cap', category: 'Accessories', sku: 'A006',
    price: 550, sizeType: null, lowThreshold: 8,
    variants: [
      { color: 'Black', hex: '#171717', sizes: [['OS', 24]] },
      { color: 'Sand', hex: '#C9B89A', sizes: [['OS', 11]] },
    ],
  })
  void tee; void cargo; void cap; void jeans

  console.log('── Orders …')
  const inStock: { productId: string, name: string, color: string, size: string, price: number }[] = []
  for (const p of [leather, hoodie, tee, cargo, cap]) {
    const variants = await db.productVariant.findMany({ where: { productId: p.id } })
    for (const v of variants) {
      if (v.stock > 0) inStock.push({
        productId: p.id, name: p.name, color: v.colorName || '', size: v.size || '',
        price: p.discountActive && p.salePrice ? p.salePrice : p.price,
      })
    }
  }

  const STATUSES: [string, number][] = [
    ['pending', 8], ['confirmed', 5], ['preparing', 5], ['shipped', 8],
    ['delivered', 42], ['completed', 20], ['cancelled', 4], ['returned', 3],
  ]
  const statusPool: string[] = []
  for (const [s, w] of STATUSES) for (let i = 0; i < w; i++) statusPool.push(s)

  let seq = 100000
  const ordersToCreate: {
    orderNumber: string, customerName: string, phone: string, address: string, governorate: string, city: string,
    status: string, subtotal: number, shippingFee: number, discountAmount: number, total: number,
    couponCode: string | null, createdAt: Date, isRead: boolean, paymentMethod: string, shippingMethod: string,
    items: { productId: string, productNameSnapshot: string, colorName: string, size: string, quantity: number, unitPrice: number, lineTotal: number }[]
  }[] = []

  for (let i = 0; i < 185; i++) {
    seq++
    const dayOffset = Math.floor(Math.pow(Math.random(), 0.7) * 45) // weighted recent
    const created = daysAgo(dayOffset, 9 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60))
    let status = dayOffset > 7 ? pick(['delivered', 'delivered', 'completed', 'completed', 'delivered', 'cancelled', 'returned', 'shipped']) : pick(statusPool)
    if (dayOffset <= 1) status = pick(['pending', 'pending', 'confirmed', 'preparing', 'shipped'])
    const name = `${pick(FIRST)} ${pick(LAST)}`
    const phone = `01${pick(['0', '1', '2', '5'])}${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`
    const g = Math.random() < 0.42 ? GOVS[0] : Math.random() < 0.6 ? GOVS[1] : pick(GOVS)
    const nItems = Math.random() < 0.55 ? 1 : Math.random() < 0.85 ? 2 : 3
    const items = []
    let subtotal = 0
    for (let j = 0; j < nItems; j++) {
      const it = pick(inStock)
      const qty = Math.random() < 0.75 ? 1 : 2
      const line = it.price * qty
      subtotal += line
      items.push({
        productId: it.productId, productNameSnapshot: it.name, colorName: it.color, size: it.size,
        quantity: qty, unitPrice: it.price, lineTotal: line,
      })
    }
    const hasCoupon = Math.random() < 0.18
    const discount = hasCoupon ? Math.round(subtotal * 0.1 * 100) / 100 : 0
    const express = Math.random() < 0.12
    const shipping = express ? 120 : g.fee
    const total = Math.max(subtotal - discount, 0) + shipping
    ordersToCreate.push({
      orderNumber: `MRT-${seq}`, customerName: name, phone,
      address: `${Math.floor(Math.random() * 90) + 1} ${pick(['St.', 'Road', 'Ave.'])}, ${pick(['Bldg 4', 'Apartment 7', 'Floor 3', ''])}`.trim(),
      governorate: g.name, city: pick(g.cities), status, subtotal,
      shippingFee: shipping, discountAmount: discount, total,
      couponCode: hasCoupon ? 'MIRTT10' : null, createdAt: created,
      isRead: dayOffset > 2, paymentMethod: 'cod',
      shippingMethod: express ? 'express' : 'standard',
      items,
    })
  }

  for (const o of ordersToCreate) {
    const { items, ...orderData } = o
    const order = await db.order.create({ data: { ...orderData, offerTitles: '[]' } })
    for (const it of o.items) {
      // resolve the exact variant so returns/restocks can map back to stock
      const variant = await db.productVariant.findFirst({
        where: { productId: it.productId, colorName: it.colorName, size: it.size },
      })
      await db.orderItem.create({ data: { ...it, orderId: order.id, variantId: variant?.id } })
    }
    // status history
    const chain: Record<string, string[]> = {
      pending: [], confirmed: ['pending'], preparing: ['pending', 'confirmed'], shipped: ['pending', 'confirmed', 'preparing'],
      delivered: ['pending', 'confirmed', 'preparing', 'shipped'], completed: ['pending', 'confirmed', 'preparing', 'shipped', 'delivered'],
      cancelled: ['pending'], returned: ['pending', 'confirmed', 'preparing', 'shipped', 'delivered'],
    }
    const steps = chain[o.status] || []
    let prev: string | null = null
    let t = new Date(o.createdAt)
    for (const st of [...steps, ...(o.status === 'cancelled' ? ['cancelled'] : [])]) {
      t = new Date(t.getTime() + (5 + Math.floor(Math.random() * 30)) * 3600 * 1000)
      if (t.getTime() > Date.now()) t = new Date(Date.now() - 3600 * 1000)
      await db.orderEvent.create({
        data: { orderId: order.id, type: 'status_change', fromStatus: prev, toStatus: st, actorName: 'Mirtt Admin', createdAt: t },
      })
      prev = st
    }
    // occasional failed delivery on shipped/delivered orders
    if ((o.status === 'delivered' || o.status === 'returned') && Math.random() < 0.18) {
      await db.orderEvent.create({
        data: {
          orderId: order.id, type: 'delivery_failed',
          meta: JSON.stringify({ reason: pick(['Customer unreachable', 'Wrong address', 'Customer refused']) }),
          actorName: 'Courier', createdAt: new Date(o.createdAt.getTime() + 4 * 86400000),
        },
      })
    }
  }

  console.log('── Returns …')
  const deliveredOrders = await db.order.findMany({
    where: { status: { in: ['delivered', 'returned', 'completed'] } },
    take: 40, orderBy: { createdAt: 'desc' },
  })
  const reasons = ['Wrong size', 'Changed mind', 'Item not as described', 'Received wrong item', 'Defective stitch']
  const conditions = ['pristine', 'used', 'damaged']
  let retCount = 0
  for (const o of deliveredOrders) {
    if (retCount >= 12) break
    if (retCount > 6 && Math.random() < 0.7) continue
    const items = await db.orderItem.findMany({ where: { orderId: o.id }, take: 1 })
    if (!items.length) continue
    const status = retCount < 4 ? 'requested' : retCount < 7 ? 'received' : retCount < 9 ? 'restocked' : pick(['requested', 'received', 'restocked', 'rejected'])
    const retCreatedAt = new Date(Math.min(o.createdAt.getTime() + 3 * 86400000, Date.now() - 10 * 60000))
    const ret = await db.returnRequest.create({
      data: {
        orderId: o.id, reason: pick(reasons), condition: pick(conditions),
        status, createdAt: retCreatedAt,
        processedBy: ['received', 'restocked', 'rejected'].includes(status) ? 'Mirtt Admin' : null,
        restockedAt: status === 'restocked' ? new Date(Math.min(o.createdAt.getTime() + 5 * 86400000, Date.now() - 5 * 60000)) : null,
        notes: Math.random() < 0.4 ? 'Customer contacted via WhatsApp.' : null,
      },
    })
    void ret
    retCount++
  }

  console.log('── Notifications …')
  const recentOrder = await db.order.findFirst({ orderBy: { createdAt: 'desc' } })
  const hoodieLow = await db.productVariant.findFirst({ where: { productId: hoodie.id, colorName: 'Sand', size: 'L' } })
  if (recentOrder && hoodieLow) {
    const notifs = [
      { userId: admin.id, type: 'new_order', category: 'orders', title: 'New Order Received', body: `${recentOrder.orderNumber} · ${recentOrder.customerName}`, entityType: 'order', entityId: recentOrder.id, url: `#/orders/${recentOrder.id}`, createdAt: new Date(Date.now() - 2 * 60000) },
      { userId: admin.id, type: 'low_stock', category: 'stock', title: 'Low Stock Alert', body: `Oversized Hoodie — Sand · L (${hoodieLow.stock} left)`, entityType: 'variant', entityId: hoodieLow.id, url: `#/inventory/${hoodie.id}`, createdAt: new Date(Date.now() - 15 * 60000) },
      { userId: admin.id, type: 'order_update', category: 'delivery', title: 'Order Delivered', body: 'MRT-101180 was delivered successfully', entityType: 'order', entityId: recentOrder.id, url: `#/orders/${recentOrder.id}`, createdAt: new Date(Date.now() - 30 * 60000), isRead: true, readAt: new Date() },
    ]
    for (const n of notifs) {
      const { isRead, readAt, ...data } = n as any
      await db.notification.create({ data: { ...data, isRead: isRead ?? false, readAt: readAt ?? null } })
    }
    await db.notification.create({
      data: {
        userId: staffAhmed.id, type: 'return_request', category: 'returns', title: 'Return Request',
        body: 'A customer requested a return — awaiting pickup', entityType: 'return', url: '#/returns', createdAt: new Date(Date.now() - 60 * 60000),
      },
    })
  }

  console.log('── Audit …')
  await db.auditLog.createMany({
    data: [
      { actorName: 'system', action: 'seed', tableName: 'database', newValue: JSON.stringify({ note: 'Initial provisioning' }) },
      { actorId: admin.id, actorName: 'Mirtt Admin', action: 'credential_provision', tableName: 'profiles', recordId: admin.id, newValue: JSON.stringify({ role: 'admin', note: 'Initial Admin PIN provisioned (hashed)' }) },
    ],
  })

  const counts = {
    users: await db.user.count(), products: await db.product.count(), variants: await db.productVariant.count(),
    orders: await db.order.count(), items: await db.orderItem.count(), returns: await db.returnRequest.count(),
    notifications: await db.notification.count(), events: await db.orderEvent.count(),
  }
  console.log('── Done ✓', counts)
}

main().finally(() => db.$disconnect())
