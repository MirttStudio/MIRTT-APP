import { createDb } from '@/lib/json-store'

/**
 * The app now runs on the SAME local JSON store the storefront (website) and
 * the Manager use (MIRTT_DATA_DIR): products/collections in `catalog.json`,
 * orders in `orders.json`, plus app-owned `pwa-*.json` files for accounts,
 * notifications, returns, stock movements and audit. `createDb()` exposes a
 * Prisma-shaped client so every route/lib keeps working unchanged.
 */
const globalForDb = globalThis as unknown as { __mirttDb: ReturnType<typeof createDb> | undefined }

export const db = globalForDb.__mirttDb ?? createDb()

if (process.env.NODE_ENV !== 'production') globalForDb.__mirttDb = db
