import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const subs = await db.pushSubscription.findMany()
  console.log('TOTAL SUBS:', subs.length)
  for (const s of subs) {
    console.log(JSON.stringify({
      id: s.id,
      userId: s.userId,
      endpoint: s.endpoint.slice(0, 70),
      ua: s.userAgent?.slice(0, 90),
      lastErrorAt: s.lastErrorAt,
      createdAt: s.createdAt,
    }))
  }
  const users = await db.user.findMany({ select: { id: true, fullName: true, role: true } })
  console.log('USERS:', JSON.stringify(users))
}
main().finally(() => db.$disconnect())
