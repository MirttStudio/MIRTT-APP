const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
;(async()=>{
  try {
    const u = await db.user.count()
    const p = await db.product.count()
    const o = await db.order.count()
    console.log(JSON.stringify({users:u, products:p, orders:o}))
  } catch(e) { console.log('ERR', e.message) }
  process.exit(0)
})()
