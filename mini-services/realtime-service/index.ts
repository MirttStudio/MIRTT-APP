/**
 * MIRTT Manager — Realtime service (socket.io, port 3003)
 *
 * - Every connection is authenticated: the client passes the session JWT
 *   in the handshake auth payload; roles/rooms are derived server-side.
 * - Authorization: rooms per role (role:admin / role:staff) and per user
 *   (user:{id}). Events are only ever emitted into rooms the audience
 *   allows — the Next.js backend decides the audience per committed event.
 * - POST /emit on the INTERNAL control port (3013, shared-secret protected)
 *   is the only ingress; the backend calls it AFTER a DB commit succeeded.
 */
import { createServer } from 'http'
import { Server } from 'socket.io'
import { jwtVerify } from 'jose'

const PORT = 3003
const CONTROL_PORT = 3013
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'insecure-dev-secret-change-me')
const EMIT_SECRET = process.env.INTERNAL_EVENT_SECRET || ''

type RtEvent = {
  id: string
  type: string
  at: string
  audience: { roles?: string[]; users?: string[] }
  payload: Record<string, unknown>
}

/** Ring buffer for missed-event replay. */
const RING_MAX = 300
const ring: RtEvent[] = []

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path — Caddy forwards using XTransformPort
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

function deliver(event: RtEvent) {
  if (!event?.type) return
  ring.push(event)
  if (ring.length > RING_MAX) ring.shift()

  const envelope = { id: event.id, type: event.type, at: event.at, payload: event.payload }
  const rooms: string[] = []
  if (event.audience?.users?.length) for (const u of event.audience.users) rooms.push(`user:${u}`)
  if (event.audience?.roles?.length) for (const r of event.audience.roles) rooms.push(`role:${r}`)
  for (const room of rooms) io.to(room).emit('rt', envelope)
}

io.use(async (socket, next) => {
  try {
    // Auth via the HttpOnly session cookie (forwarded by the gateway on the
    // same-origin handshake) — with an optional auth.token fallback.
    const cookieHeader = socket.handshake.headers.cookie || ''
    let token: string | undefined = socket.handshake.auth?.token
    if (!token) {
      for (const part of cookieHeader.split(';')) {
        const [k, ...rest] = part.trim().split('=')
        if (k === 'mirtt_session') { token = decodeURIComponent(rest.join('=')); break }
      }
    }
    if (!token) return next(new Error('unauthorized'))
    const { payload } = await jwtVerify(token, SECRET)
    if (!payload.sub) return next(new Error('unauthorized'))
    socket.data.userId = String(payload.sub)
    socket.data.role = payload.role === 'admin' ? 'admin' : 'staff'
    socket.data.name = String(payload.name || '')
    next()
  } catch {
    next(new Error('unauthorized'))
  }
})

io.on('connection', (socket) => {
  const { userId, role } = socket.data
  socket.join(`user:${userId}`)
  socket.join(`role:${role}`)
  socket.emit('hello', { serverTime: new Date().toISOString() })

  socket.on('ping-rt', (cb) => {
    if (typeof cb === 'function') cb({ t: Date.now() })
  })
})

httpServer.listen(PORT, () => {
  console.log(`[mirtt-realtime] websocket on :${PORT}`)
})

// ── Internal control server (backend → service, never exposed via Caddy) ──
const controlServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, clients: io.engine.clientsCount }))
    return
  }
  if (req.method === 'POST' && req.url === '/emit') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy() })
    req.on('end', () => {
      try {
        const { secret, event } = JSON.parse(body)
        if (!EMIT_SECRET || secret !== EMIT_SECRET) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'forbidden' }))
          return
        }
        deliver(event)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, id: event?.id }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad request' }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

controlServer.listen(CONTROL_PORT, () => {
  console.log(`[mirtt-realtime] control on :${CONTROL_PORT}`)
})
