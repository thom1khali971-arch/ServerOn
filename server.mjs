import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

const ROOT = import.meta.dirname
const PUBLIC_DIR = join(ROOT, 'public')
const DATA_DIR = join(ROOT, 'data')
const STATE_FILE = join(DATA_DIR, 'state.json')
const MESSAGES_FILE = join(DATA_DIR, 'messages.json')
const UPLOADS_DIR = join(DATA_DIR, 'uploads')
const PORT = Number(process.env.PORT || 3000)
const HOST = '0.0.0.0'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'chatbox-admin'
const PASSWORD_IS_DEFAULT = !process.env.ADMIN_PASSWORD
const ADMIN_HASH = createHash('sha256').update(ADMIN_PASSWORD).digest()
const SESSION_TTL = 12 * 60 * 60 * 1000
const ADMIN_TTL = 2 * 60 * 60 * 1000
const KICK_COOLDOWN = 2 * 60 * 1000
const MAX_MESSAGE = 1000
const MAX_BODY = 64 * 1024
const MAX_UPLOAD = 40 * 1024 * 1024
const MAX_HISTORY = 200
const MAX_NOTICES = 80
const MAX_REACTION_DEVICES = 2000
const REACTIONS = ['♥', '★', '✧', '✓']
const RESERVED = new Set(['admin', 'administrador', 'moderador', 'sistema', 'system', 'chatbox', 'suporte', 'staff'])

const ROOMS = [
  { id: 'geral', label: 'Geral', description: 'Assunto livre para toda a comunidade.' },
  { id: 'tecnologia', label: 'Tecnologia', description: 'Código, gadgets e novidades.' },
  { id: 'off-topic', label: 'Off-topic', description: 'Música, memes e conversa solta.' }
]
const ROOM_IDS = new Set(ROOMS.map(room => room.id))
const COLORS = 8

const UPLOAD_TYPES = {
  'image/png': { kind: 'image', ext: '.png', max: 8 * 1024 * 1024 },
  'image/jpeg': { kind: 'image', ext: '.jpg', max: 8 * 1024 * 1024 },
  'image/gif': { kind: 'image', ext: '.gif', max: 8 * 1024 * 1024 },
  'image/webp': { kind: 'image', ext: '.webp', max: 8 * 1024 * 1024 },
  'image/avif': { kind: 'image', ext: '.avif', max: 8 * 1024 * 1024 },
  'video/mp4': { kind: 'video', ext: '.mp4', max: MAX_UPLOAD },
  'video/webm': { kind: 'video', ext: '.webm', max: MAX_UPLOAD },
  'video/ogg': { kind: 'video', ext: '.ogv', max: MAX_UPLOAD },
  'video/quicktime': { kind: 'video', ext: '.mov', max: MAX_UPLOAD },
  'audio/mpeg': { kind: 'audio', ext: '.mp3', max: 15 * 1024 * 1024 },
  'audio/mp3': { kind: 'audio', ext: '.mp3', max: 15 * 1024 * 1024 },
  'audio/ogg': { kind: 'audio', ext: '.oga', max: 15 * 1024 * 1024 },
  'audio/wav': { kind: 'audio', ext: '.wav', max: 15 * 1024 * 1024 },
  'audio/x-wav': { kind: 'audio', ext: '.wav', max: 15 * 1024 * 1024 },
  'audio/webm': { kind: 'audio', ext: '.weba', max: 15 * 1024 * 1024 },
  'audio/mp4': { kind: 'audio', ext: '.m4a', max: 15 * 1024 * 1024 },
  'audio/x-m4a': { kind: 'audio', ext: '.m4a', max: 15 * 1024 * 1024 },
  'audio/aac': { kind: 'audio', ext: '.aac', max: 15 * 1024 * 1024 },
  'audio/flac': { kind: 'audio', ext: '.flac', max: 15 * 1024 * 1024 }
}
const UPLOAD_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac'
}
const UPLOAD_PATTERN = /^[a-f0-9]{24}\.[a-z0-9]{2,4}$/

const sessions = new Map()
const connections = new Map()
const messages = new Map(ROOMS.map(room => [room.id, []]))
const uploads = new Map()
const musicByRoom = new Map()
const notices = []
const bans = new Map()
const mutes = new Map()
const kickCooldowns = new Map()
const loginAttempts = new Map()
const rateBuckets = new Map()
const auditLog = []
const slowmode = Object.fromEntries(ROOMS.map(room => [room.id, 0]))
const startedAt = Date.now()
let sequence = 0
let saveTimer = null

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, publicMessage: message, extra })
}

function now() {
  return Date.now()
}

function normalizeName(raw, { strict = true, min = 3 } = {}) {
  if (typeof raw !== 'string') throw httpError(400, 'invalid_name', 'Informe um nome válido.')
  const value = raw.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const length = Array.from(value).length
  if (length < min || length > 20) throw httpError(400, 'invalid_name', 'O nome deve ter entre 3 e 20 caracteres.')
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u.test(value)) {
    throw httpError(400, 'invalid_name', 'Use letras, números, espaço, ponto, hífen ou sublinhado.')
  }
  if (strict && RESERVED.has(value.toLocaleLowerCase('pt-BR'))) {
    throw httpError(400, 'reserved_name', 'Esse nome é reservado. Escolha outro.')
  }
  return value
}

function cleanMessage(raw, { allowEmpty = false } = {}) {
  if (typeof raw !== 'string') {
    if (!allowEmpty) throw httpError(400, 'invalid_message', 'Mensagem inválida.')
    raw = ''
  }
  const text = raw.replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text && !allowEmpty) throw httpError(400, 'empty_message', 'Escreva uma mensagem.')
  if (Array.from(text).length > MAX_MESSAGE) {
    throw httpError(413, 'message_too_long', `A mensagem pode ter no máximo ${MAX_MESSAGE} caracteres.`)
  }
  return text
}

function cleanReason(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
}

function clientIp(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return (forwarded || req.socket.remoteAddress || '0.0.0.0').slice(0, 64)
}

function originFor(req) {
  const host = req.headers.host || 'localhost'
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const proto = forwarded || (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host) ? 'http' : 'https')
  return `${proto}://${host}`
}

function parseCookies(header = '') {
  const result = {}
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    if (!key) continue
    try {
      result[key] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      result[key] = part.slice(index + 1).trim()
    }
  }
  return result
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie')
  if (!existing) res.setHeader('Set-Cookie', [cookie])
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie])
  else res.setHeader('Set-Cookie', [existing, cookie])
}

function cookie(name, value, { maxAge, httpOnly = true, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax']
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`)
  return parts.join('; ')
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' https: http: blob:; object-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'")
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  securityHeaders(res)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendSse(res, type, payload) {
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // The client disconnected between write attempts.
  }
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_WS_FRAME = 1024 * 1024

function wsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

function sendClient(client, type, payload) {
  if (client.kind === 'sse') {
    sendSse(client.res, type, payload)
    return
  }
  try {
    client.socket.write(wsFrame(JSON.stringify({ type, data: payload })))
  } catch {
    // The socket closed between write attempts.
  }
}

function closeClient(client) {
  try {
    if (client.kind === 'sse') client.res.end()
    else {
      client.socket.write(Buffer.from([0x88, 0x00]))
      client.socket.end()
    }
  } catch {
    // Already closed.
  }
}

function registerClient(session, client) {
  let set = connections.get(session.sid)
  if (!set) {
    set = new Set()
    connections.set(session.sid, set)
  }
  set.add(client)
  session.online = true
  session.joined = true
  session.lastSeen = now()
  return set
}

function unregisterClient(session, set, client) {
  set.delete(client)
  if (!set.size) {
    connections.delete(session.sid)
    setTimeout(() => {
      if (!connections.has(session.sid) && sessions.get(session.sid) === session) {
        session.online = false
        broadcastUsers()
      }
    }, 4000)
  }
}

function helloPayload(session, deviceId) {
  const history = {}
  for (const room of ROOMS) {
    history[room.id] = messages.get(room.id).slice(-60).map(message => decorateMessage(message, deviceId))
  }
  return {
    you: profileFor(session),
    users: publicUsers(),
    rooms: ROOMS,
    slowmode,
    stats: stats(),
    messages: history,
    notices: notices.slice(-24).map(notice => decorateMessage(notice, deviceId)),
    music: musicState(),
    admin: { isAdmin: isAdmin(session), passwordIsDefault: PASSWORD_IS_DEFAULT },
    serverTime: now()
  }
}

function readJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) tooLarge = true
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return rejectBody(httpError(413, 'payload_too_large', 'Requisição muito grande.'))
      if (!size) return resolveBody({})
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
        resolveBody(value)
      } catch {
        rejectBody(httpError(400, 'invalid_json', 'JSON inválido.'))
      }
    })
    req.on('error', rejectBody)
  })
}

function getOrCreateClient(req, res) {
  const cookies = parseCookies(req.headers.cookie)
  const ip = clientIp(req)
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'

  let deviceId = cookies.cb_uid
  if (!deviceId || !/^[a-f0-9]{32}$/.test(deviceId)) {
    deviceId = randomBytes(16).toString('hex')
    appendCookie(res, cookie('cb_uid', deviceId, { maxAge: 365 * 24 * 60 * 60 * 1000, secure }))
  }

  let session = cookies.cb_sid ? sessions.get(cookies.cb_sid) : null
  if (session && now() - session.lastSeen > SESSION_TTL) {
    sessions.delete(session.sid)
    session = null
  }

  if (!session) {
    const sid = randomBytes(24).toString('hex')
    session = {
      sid,
      publicId: randomBytes(4).toString('hex'),
      deviceId,
      ip,
      name: null,
      nameLower: null,
      avatar: null,
      color: colorFor(deviceId),
      joined: false,
      online: false,
      isAdmin: false,
      adminUntil: 0,
      mutedUntil: 0,
      mutedReason: '',
      createdAt: now(),
      lastSeen: now(),
      messageWindow: [],
      lastTyping: 0,
      roomLast: new Map()
    }
    sessions.set(sid, session)
    appendCookie(res, cookie('cb_sid', sid, { maxAge: SESSION_TTL, secure }))
  } else if (session.deviceId !== deviceId) {
    session.deviceId = deviceId
  }

  session.lastSeen = now()
  session.ip = ip
  return { session, deviceId, ip }
}

function colorFor(seed) {
  const digest = createHash('sha256').update(seed).digest()
  return digest[0] % COLORS
}

function isAdmin(session) {
  return Boolean(session?.isAdmin && session.adminUntil > now())
}

function profileFor(session) {
  return {
    id: session.publicId,
    name: session.name,
    avatar: session.avatar || null,
    color: session.color,
    isAdmin: isAdmin(session),
    muted: session.mutedUntil > now(),
    mutedUntil: session.mutedUntil > now()
      ? (session.mutedUntil === Number.MAX_SAFE_INTEGER ? null : session.mutedUntil)
      : 0,
    mutedReason: session.mutedUntil > now() ? session.mutedReason : '',
    online: session.online
  }
}

function publicUsers() {
  return [...sessions.values()]
    .filter(session => session.joined && session.online && !activeBanFor(session))
    .sort((a, b) => Number(isAdmin(b)) - Number(isAdmin(a)) || a.name.localeCompare(b.name, 'pt-BR'))
    .map(profileFor)
}

function activeBanFor({ deviceId, nameLower }) {
  for (const ban of bans.values()) {
    if (ban.until && ban.until <= now()) continue
    if ((deviceId && ban.deviceId === deviceId) || (nameLower && ban.nameLower === nameLower)) return ban
  }
  return null
}

function activeMuteFor({ deviceId, nameLower }) {
  for (const mute of mutes.values()) {
    if (mute.until && mute.until <= now()) continue
    if ((deviceId && mute.deviceId === deviceId) || (nameLower && mute.nameLower === nameLower)) return mute
  }
  return null
}

function activeKickFor(deviceId) {
  const record = kickCooldowns.get(deviceId)
  if (!record) return null
  if (record.until <= now()) {
    kickCooldowns.delete(deviceId)
    return null
  }
  return record
}

function refreshMute(session) {
  const mute = activeMuteFor(session)
  if (mute) {
    session.mutedUntil = mute.until ?? Number.MAX_SAFE_INTEGER
    session.mutedReason = mute.reason || ''
    return mute
  }
  session.mutedUntil = 0
  session.mutedReason = ''
  return null
}

function guestName() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const name = `Visitante-${randomBytes(2).toString('hex').toUpperCase()}`
    if (![...sessions.values()].some(session => session.nameLower === name.toLowerCase())) return name
  }
  return `Visitante-${randomBytes(3).toString('hex').toUpperCase()}`
}

function joinSession(session, name) {
  session.name = name
  session.nameLower = name.toLocaleLowerCase('pt-BR')
  session.color = colorFor(session.deviceId)
  session.joined = true
  refreshMute(session)
}

function safeFilename(raw, fallback = 'arquivo') {
  let value = String(raw || '')
  try {
    value = decodeURIComponent(value)
  } catch {
    // Keep the raw value when it is not URI encoded.
  }
  value = value.split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
  return value || fallback
}

function readBinary(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) tooLarge = true
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return rejectBody(httpError(413, 'file_too_large', 'Arquivo maior que o limite permitido.'))
      resolveBody(Buffer.concat(chunks))
    })
    req.on('error', rejectBody)
  })
}

function sniffMedia(buffer, mime) {
  if (!buffer.length) return false
  const head = buffer.subarray(0, 16)
  const ascii = (start, end) => buffer.toString('latin1', start, end)
  switch (mime) {
    case 'image/png':
      return head[0] === 0x89 && ascii(1, 4) === 'PNG'
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    case 'image/gif':
      return ascii(0, 4) === 'GIF8'
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    case 'image/avif':
      return ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))
    case 'video/mp4':
    case 'video/quicktime':
    case 'audio/mp4':
    case 'audio/x-m4a':
      return ascii(4, 8) === 'ftyp'
    case 'video/webm':
    case 'audio/webm':
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
    case 'video/ogg':
    case 'audio/ogg':
      return ascii(0, 4) === 'OggS'
    case 'audio/mpeg':
    case 'audio/mp3':
      return ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
    case 'audio/wav':
    case 'audio/x-wav':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
    case 'audio/flac':
      return ascii(0, 4) === 'fLaC'
    case 'audio/aac':
      return head[0] === 0xff && (head[1] & 0xf6) === 0xf0
    default:
      return false
  }
}

function publicUpload(record) {
  return {
    id: record.id,
    type: record.kind,
    url: record.url,
    name: record.name,
    size: record.size,
    mime: record.mime
  }
}

function storeUpload(session, buffer, mime, rawName) {
  const meta = UPLOAD_TYPES[mime]
  if (!meta) throw httpError(415, 'unsupported_media', 'Formato de mídia não suportado.')
  if (!buffer.length) throw httpError(400, 'empty_file', 'O arquivo está vazio.')
  if (buffer.length > meta.max) {
    throw httpError(413, 'file_too_large', `O limite para ${meta.kind === 'image' ? 'imagens' : meta.kind === 'video' ? 'vídeos' : 'áudios'} é ${Math.round(meta.max / 1024 / 1024)} MB.`)
  }
  if (!sniffMedia(buffer, mime)) {
    throw httpError(415, 'invalid_media', 'O conteúdo do arquivo não corresponde ao formato informado.')
  }
  mkdirSync(UPLOADS_DIR, { recursive: true })
  const id = randomBytes(12).toString('hex')
  const filename = `${id}${meta.ext}`
  const filePath = join(UPLOADS_DIR, filename)
  writeFileSync(filePath, buffer, { flag: 'wx' })
  const name = safeFilename(rawName, `arquivo${meta.ext}`)
  const record = {
    id,
    filename,
    url: `/uploads/${filename}`,
    kind: meta.kind,
    mime,
    name,
    size: buffer.length,
    sessionSid: session.sid,
    used: false,
    createdAt: now()
  }
  uploads.set(id, record)
  if (uploads.size > 400) {
    const oldest = [...uploads.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
    if (oldest) uploads.delete(oldest.id)
  }
  return record
}

function resolveAttachment(session, attachmentId) {
  const record = uploads.get(String(attachmentId || ''))
  if (!record || record.sessionSid !== session.sid || record.used) {
    throw httpError(400, 'invalid_attachment', 'Anexo inválido. Envie o arquivo novamente.')
  }
  record.used = true
  return publicUpload(record)
}

function cleanMediaUrl(raw) {
  const value = String(raw || '').trim().slice(0, 2000)
  if (!value) throw httpError(400, 'missing_music', 'Informe um link direto de áudio.')
  if (value.startsWith('/uploads/')) {
    const filename = value.slice('/uploads/'.length).split('?')[0]
    if (!UPLOAD_PATTERN.test(filename) || !existsSync(join(UPLOADS_DIR, filename))) {
      throw httpError(404, 'music_not_found', 'Esse áudio não está mais disponível.')
    }
    return `/uploads/${filename}`
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw httpError(400, 'invalid_music_url', 'Use um link http(s) direto para o áudio.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw httpError(400, 'invalid_music_url', 'Use um link http(s) direto para o áudio.')
  }
  if (/(^|\.)(youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|vimeo\.com|tiktok\.com|instagram\.com)$/i.test(url.hostname)) {
    throw httpError(400, 'unsupported_music', 'Use um link direto de áudio (mp3, ogg, wav, m4a), não uma página de streaming.')
  }
  return url.href
}

function musicTitle(url, custom) {
  const label = String(custom || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (label) return label
  if (url.startsWith('/uploads/')) {
    const filename = url.split('/').pop()
    const record = [...uploads.values()].find(item => item.filename === filename)
    if (record) return record.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Áudio enviado'
    return 'Áudio enviado'
  }
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    const last = decodeURIComponent(parts.pop() || '')
    const title = last.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
    return title.slice(0, 80) || 'Música ao vivo'
  } catch {
    return 'Música ao vivo'
  }
}

function musicPayload(room) {
  const track = musicByRoom.get(room)
  if (!track) return null
  return { ...track, serverTime: now() }
}

function musicState() {
  const stateMap = {}
  for (const [room, track] of musicByRoom) stateMap[room] = { ...track, serverTime: now() }
  return stateMap
}

function startMusic(actor, room, rawUrl, customTitle = '') {
  const targetRoom = ROOM_IDS.has(room) ? room : 'geral'
  const url = cleanMediaUrl(rawUrl)
  const track = {
    id: randomBytes(5).toString('hex'),
    room: targetRoom,
    url,
    title: musicTitle(url, customTitle),
    by: {
      id: actor.publicId,
      name: actor.name,
      color: actor.color,
      admin: isAdmin(actor)
    },
    startedAt: now()
  }
  musicByRoom.set(targetRoom, track)
  broadcast('music', { room: targetRoom, track: musicPayload(targetRoom) })
  audit(actor, 'play-music', targetRoom, track.title)
  return { message: `Tocando "${track.title}" na sala ${ROOMS.find(item => item.id === targetRoom)?.label || targetRoom}.`, track: musicPayload(targetRoom) }
}

function stopMusic(actor, room) {
  const targetRoom = ROOM_IDS.has(room) ? room : 'geral'
  const track = musicByRoom.get(targetRoom)
  if (!track) throw httpError(404, 'no_music', 'Nenhuma música tocando nesta sala.')
  if (!isAdmin(actor) && track.by.id !== actor.publicId) {
    throw httpError(403, 'not_music_owner', 'Apenas quem iniciou a música ou um administrador pode pará-la.')
  }
  musicByRoom.delete(targetRoom)
  broadcast('music', { room: targetRoom, track: null })
  audit(actor, 'stop-music', targetRoom, track.title)
  return { message: `Música parada na sala ${ROOMS.find(item => item.id === targetRoom)?.label || targetRoom}.` }
}

function decorateMessage(message, deviceId) {
  const reactions = {}
  for (const [symbol, devices] of Object.entries(message.reactions || {})) {
    if (devices.length) reactions[symbol] = devices.length
  }
  return {
    id: message.id,
    seq: message.seq,
    room: message.room,
    ts: message.ts,
    kind: message.kind,
    level: message.level || 'info',
    text: message.deleted ? '' : message.text,
    deleted: Boolean(message.deleted),
    user: message.user || null,
    attachment: message.deleted ? null : message.attachment || null,
    reactions,
    mine: deviceId
      ? Object.entries(message.reactions || {}).filter(([, devices]) => devices.includes(deviceId)).map(([symbol]) => symbol)
      : []
  }
}

function createMessage(session, room, text, attachment = null) {
  const message = {
    id: randomBytes(6).toString('hex'),
    seq: ++sequence,
    room,
    ts: now(),
    kind: 'chat',
    text,
    attachment,
    reactions: {},
    user: {
      id: session.publicId,
      name: session.name,
      avatar: session.avatar || null,
      color: session.color,
      admin: isAdmin(session)
    }
  }
  const list = messages.get(room)
  list.push(message)
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY)
  broadcast('message', { message: decorateMessage(message) })
  scheduleMessagesSave()
  return message
}

function createNotice(text, level = 'info', actor = null) {
  const notice = {
    id: randomBytes(6).toString('hex'),
    seq: ++sequence,
    room: '*',
    ts: now(),
    kind: 'notice',
    level,
    text,
    user: actor ? { name: actor.name, avatar: actor.avatar || null, color: actor.color, admin: isAdmin(actor) } : null
  }
  notices.push(notice)
  if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES)
  broadcast('notice', decorateMessage(notice))
  scheduleMessagesSave()
  return notice
}

function sendToSession(session, type, payload) {
  const set = connections.get(session.sid)
  if (!set) return
  for (const client of set) sendClient(client, type, payload)
}

function broadcast(type, payload, predicate = null) {
  for (const [sid, set] of connections) {
    const session = sessions.get(sid)
    if (!session || !session.joined) continue
    if (predicate && !predicate(session)) continue
    for (const client of set) sendClient(client, type, payload)
  }
}

let usersTimer = null
function broadcastUsers() {
  if (usersTimer) return
  usersTimer = setTimeout(() => {
    usersTimer = null
    broadcast('users', { users: publicUsers() })
  }, 80)
}

function audit(actor, action, target, detail = '') {
  const entry = {
    id: randomBytes(5).toString('hex'),
    ts: now(),
    actor: actor?.name || 'sistema',
    action,
    target: target || '',
    detail: cleanReason(detail)
  }
  auditLog.unshift(entry)
  if (auditLog.length > 120) auditLog.length = 120
  return entry
}

function stats() {
  let messageCount = 0
  for (const list of messages.values()) messageCount += list.length
  return {
    online: publicUsers().length,
    messages: messageCount,
    bans: [...bans.values()].filter(ban => !ban.until || ban.until > now()).length,
    mutes: [...mutes.values()].filter(mute => !mute.until || mute.until > now()).length,
    rooms: ROOMS.length,
    uptime: Math.floor((now() - startedAt) / 1000)
  }
}

function findSession(query) {
  const value = String(query || '').trim()
  if (!value) return null
  const lower = value.toLocaleLowerCase('pt-BR')
  return [...sessions.values()].find(session =>
    session.joined && (session.publicId === value || session.nameLower === lower)
  ) || null
}

function resolveTarget(query) {
  const value = String(query || '').trim()
  if (!value) throw httpError(400, 'missing_target', 'Informe o usuário alvo.')
  const session = findSession(value)
  if (session) {
    return {
      session,
      name: session.name,
      nameLower: session.nameLower,
      deviceId: session.deviceId,
      ip: session.ip
    }
  }
  const name = normalizeName(value, { strict: false, min: 2 })
  return { session: null, name, nameLower: name.toLocaleLowerCase('pt-BR'), deviceId: null, ip: null }
}

function terminateSession(session, event, payload) {
  const set = connections.get(session.sid)
  if (set) {
    for (const client of set) {
      sendClient(client, event, payload)
      closeClient(client)
    }
    connections.delete(session.sid)
  }
  session.online = false
  session.joined = false
  sessions.delete(session.sid)
}

function disconnectMatching(target, event, payload) {
  for (const session of [...sessions.values()]) {
    if (!session.joined) continue
    if ((target.deviceId && session.deviceId === target.deviceId) || session.nameLower === target.nameLower) {
      terminateSession(session, event, payload)
    }
  }
  broadcastUsers()
}

function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || minutes === 0) return 'permanente'
  if (minutes < 60) return `${minutes}min`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

function banTarget(actor, targetQuery, minutes, reason) {
  const target = resolveTarget(targetQuery)
  const until = minutes > 0 ? now() + minutes * 60000 : null
  for (const [id, ban] of bans) {
    const matches = (target.deviceId && ban.deviceId === target.deviceId) || ban.nameLower === target.nameLower
    if (matches) bans.delete(id)
  }
  const record = {
    id: randomBytes(5).toString('hex'),
    name: target.name,
    nameLower: target.nameLower,
    deviceId: target.deviceId,
    ip: target.ip,
    until,
    reason,
    by: actor.name,
    createdAt: now()
  }
  bans.set(record.id, record)
  disconnectMatching(target, 'banned', { reason, until })
  const message = `Admin ${actor.name} baniu ${target.name} (${formatDuration(minutes)})${reason ? `: ${reason}` : ''}.`
  createNotice(message, 'danger', actor)
  audit(actor, 'ban', target.name, `${formatDuration(minutes)}${reason ? ` — ${reason}` : ''}`)
  scheduleSave()
  return { message, record }
}

function unbanTarget(actor, query) {
  const value = String(query || '').trim()
  let removed = 0
  const removedNames = []
  for (const [id, ban] of bans) {
    if (id === value || ban.nameLower === value.toLocaleLowerCase('pt-BR')) {
      removedNames.push(ban.name)
      bans.delete(id)
      removed += 1
    }
  }
  if (!removed) throw httpError(404, 'ban_not_found', 'Nenhum banimento encontrado.')
  const label = removedNames[0] || value
  createNotice(`Admin ${actor.name} removeu o banimento de ${label}.`, 'success', actor)
  audit(actor, 'unban', label)
  scheduleSave()
  return { message: `Banimento removido (${removed}).` }
}

function muteTarget(actor, targetQuery, minutes, reason) {
  const target = resolveTarget(targetQuery)
  const until = minutes > 0 ? now() + minutes * 60000 : null
  for (const [id, mute] of mutes) {
    const matches = (target.deviceId && mute.deviceId === target.deviceId) || mute.nameLower === target.nameLower
    if (matches) mutes.delete(id)
  }
  const record = {
    id: randomBytes(5).toString('hex'),
    name: target.name,
    nameLower: target.nameLower,
    deviceId: target.deviceId,
    until,
    reason,
    by: actor.name,
    createdAt: now()
  }
  mutes.set(record.id, record)
  for (const session of sessions.values()) {
    if (!session.joined) continue
    if ((target.deviceId && session.deviceId === target.deviceId) || session.nameLower === target.nameLower) {
      session.mutedUntil = until || Number.MAX_SAFE_INTEGER
      session.mutedReason = reason
      sendToSession(session, 'you', { you: profileFor(session) })
    }
  }
  const message = `Admin ${actor.name} silenciou ${target.name} (${formatDuration(minutes)})${reason ? `: ${reason}` : ''}.`
  createNotice(message, 'warn', actor)
  audit(actor, 'mute', target.name, `${formatDuration(minutes)}${reason ? ` — ${reason}` : ''}`)
  scheduleSave()
  broadcastUsers()
  return { message, record }
}

function unmuteTarget(actor, query) {
  const value = String(query || '').trim()
  const lower = value.toLocaleLowerCase('pt-BR')
  const removedNames = new Set()
  const removedLabels = []
  let removed = 0
  for (const [id, mute] of mutes) {
    if (id === value || mute.nameLower === lower) {
      removedNames.add(mute.nameLower)
      removedLabels.push(mute.name)
      mutes.delete(id)
      removed += 1
    }
  }
  for (const session of sessions.values()) {
    if (!session.joined) continue
    const changed = session.mutedUntil > now() && (removedNames.has(session.nameLower) || !activeMuteFor(session))
    refreshMute(session)
    if (changed) sendToSession(session, 'you', { you: profileFor(session) })
  }
  if (!removed) throw httpError(404, 'mute_not_found', 'Nenhum silenciamento encontrado.')
  const label = removedLabels[0] || value
  createNotice(`Admin ${actor.name} removeu o silenciamento de ${label}.`, 'success', actor)
  audit(actor, 'unmute', label)
  scheduleSave()
  broadcastUsers()
  return { message: `Silenciamento removido (${removed}).` }
}

function kickTarget(actor, targetQuery, reason) {
  const target = resolveTarget(targetQuery)
  if (!target.session) throw httpError(404, 'user_not_online', 'Esse usuário não está online.')
  const until = now() + KICK_COOLDOWN
  if (target.deviceId) kickCooldowns.set(target.deviceId, { until, reason, name: target.name })
  disconnectMatching(target, 'kicked', { reason, until, retryAfter: Math.ceil(KICK_COOLDOWN / 1000) })
  const message = `Admin ${actor.name} expulsou ${target.name}${reason ? `: ${reason}` : ''}.`
  createNotice(message, 'warn', actor)
  audit(actor, 'kick', target.name, reason)
  return { message }
}

function clearRoom(actor, room) {
  if (room === 'all') {
    for (const id of ROOM_IDS) messages.get(id).length = 0
  } else {
    if (!ROOM_IDS.has(room)) throw httpError(400, 'invalid_room', 'Sala inválida.')
    messages.get(room).length = 0
  }
  broadcast('cleared', { room })
  const label = room === 'all' ? 'todas as salas' : ROOMS.find(item => item.id === room)?.label || room
  const message = `Admin ${actor.name} limpou ${label}.`
  createNotice(message, 'info', actor)
  audit(actor, 'clear', room, '')
  return { message }
}

function setSlowmode(actor, room, seconds) {
  if (!ROOM_IDS.has(room)) throw httpError(400, 'invalid_room', 'Sala inválida.')
  const value = Math.max(0, Math.min(300, Math.round(Number(seconds) || 0)))
  slowmode[room] = value
  broadcast('state', { slowmode, stats: stats() })
  const message = value
    ? `Admin ${actor.name} ativou slowmode de ${value}s em ${ROOMS.find(item => item.id === room)?.label}.`
    : `Admin ${actor.name} desativou o slowmode de ${ROOMS.find(item => item.id === room)?.label}.`
  createNotice(message, 'info', actor)
  audit(actor, 'slowmode', room, String(value))
  scheduleSave()
  return { message }
}

function announce(actor, text) {
  const value = cleanMessage(text)
  createNotice(`Aviso de ${actor.name}: ${value}`, 'admin', actor)
  audit(actor, 'announce', '', value)
  return { message: 'Aviso enviado.' }
}

function deleteMessage(actor, messageId) {
  const id = String(messageId || '')
  for (const list of messages.values()) {
    const message = list.find(item => item.id === id)
    if (!message) continue
    message.deleted = true
    message.text = ''
    message.reactions = {}
    broadcast('message:update', decorateMessage(message))
    scheduleMessagesSave()
    audit(actor, 'delete-message', message.user?.name || '', id)
    createNotice(`Admin ${actor.name} removeu uma mensagem de ${message.user?.name || 'um usuário'}.`, 'warn', actor)
    return { message: 'Mensagem removida.' }
  }
  throw httpError(404, 'message_not_found', 'Mensagem não encontrada.')
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveState()
  }, 300)
}

function saveState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const payload = {
      bans: [...bans.values()],
      mutes: [...mutes.values()],
      slowmode,
      savedAt: now()
    }
    const temp = `${STATE_FILE}.tmp`
    writeFileSync(temp, JSON.stringify(payload))
    renameSync(temp, STATE_FILE)
  } catch (error) {
    console.error(`[chatbox] não foi possível salvar o estado: ${error.message}`)
  }
}

function loadState() {
  try {
    const payload = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    for (const ban of payload.bans || []) if (ban?.id && ban?.nameLower) bans.set(ban.id, ban)
    for (const mute of payload.mutes || []) if (mute?.id && mute?.nameLower) mutes.set(mute.id, mute)
    for (const room of ROOMS) {
      const value = Number(payload.slowmode?.[room.id])
      if (Number.isFinite(value)) slowmode[room.id] = Math.max(0, Math.min(300, Math.round(value)))
    }
  } catch {
    // First run or unreadable state: start clean.
  }
}

let messagesSaveTimer = null

function scheduleMessagesSave() {
  if (messagesSaveTimer) clearTimeout(messagesSaveTimer)
  messagesSaveTimer = setTimeout(() => {
    messagesSaveTimer = null
    saveMessages()
  }, 300)
}

function saveMessages() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const payload = {
      version: 1,
      sequence,
      messages: Object.fromEntries([...messages].map(([room, list]) => [room, list])),
      notices,
      savedAt: now()
    }
    const temp = `${MESSAGES_FILE}.tmp`
    writeFileSync(temp, JSON.stringify(payload))
    renameSync(temp, MESSAGES_FILE)
  } catch (error) {
    console.error(`[chatbox] não foi possível salvar as mensagens: ${error.message}`)
  }
}

function normalizeReactions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const normalized = {}
  for (const [symbol, devices] of Object.entries(raw)) {
    if (!symbol || symbol.length > 16) continue
    if (Array.isArray(devices)) {
      const valid = devices.filter(device => typeof device === 'string' && device).slice(0, MAX_REACTION_DEVICES)
      if (valid.length) normalized[symbol] = valid
    } else {
      const count = Math.min(MAX_REACTION_DEVICES, Math.max(0, Math.floor(Number(devices) || 0)))
      if (count) normalized[symbol] = Array.from({ length: count }, (_, index) => `legacy:${index}`)
    }
  }
  return normalized
}

function loadMessages() {
  try {
    const payload = JSON.parse(readFileSync(MESSAGES_FILE, 'utf8'))
    for (const room of ROOMS) {
      const list = Array.isArray(payload.messages?.[room.id]) ? payload.messages[room.id] : []
      const valid = list
        .filter(message => message && message.id && Number.isFinite(Number(message.seq)))
        .map(message => ({
          ...message,
          seq: Number(message.seq),
          ts: Number(message.ts) || now(),
          reactions: normalizeReactions(message.reactions)
        }))
        .slice(-MAX_HISTORY)
      messages.set(room.id, valid)
    }
    if (Array.isArray(payload.notices)) {
      notices.length = 0
      notices.push(...payload.notices.filter(notice => notice && notice.id).slice(-MAX_NOTICES))
    }
    sequence = Number.isFinite(Number(payload.sequence)) ? Math.max(0, Math.floor(Number(payload.sequence))) : 0
    for (const list of messages.values()) {
      for (const message of list) sequence = Math.max(sequence, Number(message.seq) || 0)
    }
    for (const notice of notices) sequence = Math.max(sequence, Number(notice.seq) || 0)
  } catch {
    // First run or unreadable history: start with the welcome notice only.
  }
}

function rateLimit(key, limit, windowMs) {
  const at = now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.reset <= at) {
    rateBuckets.set(key, { count: 1, reset: at + windowMs })
    return { ok: true, retryAfter: 0 }
  }
  bucket.count += 1
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.reset - at) / 1000)) }
  }
  return { ok: true, retryAfter: 0 }
}

function checkPassword(input) {
  const digest = createHash('sha256').update(String(input ?? '')).digest()
  return timingSafeEqual(digest, ADMIN_HASH)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { time, day }
}

const ZIP_FILES = [
  'package.json',
  'server.mjs',
  'start.sh',
  'public/index.html',
  'public/styles.css',
  'public/app.js',
  'public/download.html',
  'public/download.js',
  'public/download.css',
  'public/favicon.svg'
]

function buildZip() {
  const date = dosDateTime(new Date())
  const files = ZIP_FILES.filter(file => existsSync(join(ROOT, file))).map(file => {
    const data = readFileSync(join(ROOT, file))
    return {
      name: Buffer.from(file, 'utf8'),
      data,
      compressed: deflateRawSync(data, { level: 9 }),
      crc: crc32(data)
    }
  })

  const localParts = []
  const centralParts = []
  let offset = 0

  for (const file of files) {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(date.time, 10)
    local.writeUInt16LE(date.day, 12)
    local.writeUInt32LE(file.crc, 14)
    local.writeUInt32LE(file.compressed.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(file.name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, file.name, file.compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(date.time, 12)
    central.writeUInt16LE(date.day, 14)
    central.writeUInt32LE(file.crc, 16)
    central.writeUInt32LE(file.compressed.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(file.name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, file.name)

    offset += local.length + file.name.length + file.compressed.length
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}

function requireMutation(req) {
  if (String(req.headers['x-requested-with'] || '').toLowerCase() !== 'chatbox') {
    throw httpError(403, 'invalid_request', 'Requisição não autorizada.')
  }
  const origin = req.headers.origin
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      throw httpError(403, 'invalid_origin', 'Origem inválida.')
    }
    if (originHost !== req.headers.host) throw httpError(403, 'invalid_origin', 'Origem não permitida.')
  }
}

function requireSession(session, { joined = true } = {}) {
  if (!session) throw httpError(401, 'no_session', 'Sessão não encontrada.')
  if (joined && !session.joined) throw httpError(403, 'not_joined', 'Entre no chat primeiro.')
  return session
}

function requireAdminSession(session) {
  if (!isAdmin(session)) throw httpError(403, 'not_admin', 'Acesso administrativo necessário.')
  return session
}

function parseMinutes(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw httpError(400, 'invalid_duration', 'Duração inválida.')
  return Math.min(525600, Math.round(number))
}

function durationToken(token) {
  if (token === undefined) return undefined
  const value = String(token).toLowerCase()
  if (value === 'perm' || value === 'permanente' || value === '0') return 0
  const match = /^(\d{1,6})(s|m|h|d)$/.exec(value)
  if (!match) return undefined
  const multiplier = { s: 1 / 60, m: 1, h: 60, d: 1440 }[match[2]]
  return Math.max(1, Math.round(Number(match[1]) * multiplier))
}

function runCommand(actor, raw) {
  const input = String(raw || '').trim()
  if (!input.startsWith('/')) return { lines: ['Digite um comando começando com / ou use o formulário de ações.'] }
  const parts = input.slice(1).split(/\s+/)
  const command = (parts.shift() || '').toLowerCase()
  const args = parts
  const lines = []

  switch (command) {
    case 'help':
      return {
        lines: [
          '/ban <usuário> [10m|2h|1d|perm] [motivo] — bane um usuário',
          '/mute <usuário> [10m|1h|perm] [motivo] — silencia um usuário',
          '/kick <usuário> [motivo] — expulsa (retorno em 2min)',
          '/unban <usuário|id> — remove banimento',
          '/unmute <usuário|id> — remove silenciamento',
          '/clear <sala|all> — limpa mensagens',
          '/slowmode <sala> <segundos> — limita o ritmo da sala',
          '/announce <texto> — aviso global',
          '/play [sala] <url> [| título] — toca música ao vivo',
          '/stop [sala] — para a música da sala',
          '/who, /bans, /mutes — listagens'
        ]
      }
    case 'ban': {
      if (!args[0]) throw httpError(400, 'missing_target', 'Uso: /ban <usuário> [duração] [motivo]')
      const duration = durationToken(args[1])
      const minutes = duration === undefined ? 0 : duration
      const reason = cleanReason(args.slice(duration === undefined ? 1 : 2).join(' '))
      const result = banTarget(actor, args[0], minutes, reason)
      return { lines: [result.message] }
    }
    case 'mute': {
      if (!args[0]) throw httpError(400, 'missing_target', 'Uso: /mute <usuário> [duração] [motivo]')
      const duration = durationToken(args[1])
      const minutes = duration === undefined ? 10 : duration
      const reason = cleanReason(args.slice(duration === undefined ? 1 : 2).join(' '))
      const result = muteTarget(actor, args[0], minutes, reason)
      return { lines: [result.message] }
    }
    case 'kick': {
      if (!args[0]) throw httpError(400, 'missing_target', 'Uso: /kick <usuário> [motivo]')
      const result = kickTarget(actor, args[0], cleanReason(args.slice(1).join(' ')))
      return { lines: [result.message] }
    }
    case 'unban':
      if (!args[0]) throw httpError(400, 'missing_target', 'Uso: /unban <usuário|id>')
      return { lines: [unbanTarget(actor, args[0]).message] }
    case 'unmute':
      if (!args[0]) throw httpError(400, 'missing_target', 'Uso: /unmute <usuário|id>')
      return { lines: [unmuteTarget(actor, args[0]).message] }
    case 'clear':
      return { lines: [clearRoom(actor, (args[0] || 'all').toLowerCase()).message] }
    case 'slowmode': {
      if (!args[0] || args[1] === undefined) throw httpError(400, 'missing_args', 'Uso: /slowmode <sala> <segundos>')
      return { lines: [setSlowmode(actor, args[0].toLowerCase(), args[1]).message] }
    }
    case 'announce':
    case 'aviso':
      if (!args.length) throw httpError(400, 'missing_text', 'Uso: /announce <texto>')
      return { lines: [announce(actor, args.join(' ')).message] }
    case 'play':
    case 'music':
    case 'musica':
    case 'música': {
      let room = 'geral'
      if (ROOM_IDS.has((args[0] || '').toLowerCase())) room = args.shift().toLowerCase()
      const joined = args.join(' ')
      const [rawUrl, ...titleParts] = joined.split('|')
      if (!rawUrl.trim()) throw httpError(400, 'missing_music', 'Uso: /play [sala] <url> [| título]')
      const result = startMusic(actor, room, rawUrl.trim(), titleParts.join('|').trim())
      return { lines: [result.message] }
    }
    case 'stop':
    case 'parar': {
      const room = ROOM_IDS.has((args[0] || '').toLowerCase()) ? args[0].toLowerCase() : 'geral'
      return { lines: [stopMusic(actor, room).message] }
    }
    case 'who':
      lines.push(`${publicUsers().length} online:`)
      for (const user of publicUsers()) lines.push(`• ${user.name}${user.isAdmin ? ' (admin)' : ''}${user.mutedUntil ? ' (mutado)' : ''}`)
      return { lines }
    case 'bans':
      if (!bans.size) return { lines: ['Nenhum banimento registrado.'] }
      for (const ban of bans.values()) lines.push(`• ${ban.name} — ${formatDuration(ban.until ? Math.max(1, Math.round((ban.until - now()) / 60000)) : 0)}${ban.reason ? ` — ${ban.reason}` : ''} [${ban.id}]`)
      return { lines }
    case 'mutes':
      if (!mutes.size) return { lines: ['Nenhum silenciamento registrado.'] }
      for (const mute of mutes.values()) lines.push(`• ${mute.name} — ${formatDuration(mute.until ? Math.max(1, Math.round((mute.until - now()) / 60000)) : 0)}${mute.reason ? ` — ${mute.reason}` : ''} [${mute.id}]`)
      return { lines }
    default:
      return { lines: [`Comando desconhecido: /${command}. Use /help.`] }
  }
}

function adminOverview(session) {
  return {
    isAdmin: isAdmin(session),
    passwordIsDefault: PASSWORD_IS_DEFAULT,
    users: publicUsers(),
    bans: [...bans.values()]
      .filter(ban => !ban.until || ban.until > now())
      .map(ban => ({ id: ban.id, name: ban.name, until: ban.until, reason: ban.reason, by: ban.by, createdAt: ban.createdAt })),
    mutes: [...mutes.values()]
      .filter(mute => !mute.until || mute.until > now())
      .map(mute => ({ id: mute.id, name: mute.name, until: mute.until, reason: mute.reason, by: mute.by, createdAt: mute.createdAt })),
    audit: auditLog.slice(0, 60),
    slowmode,
    rooms: ROOMS,
    stats: stats(),
    me: profileFor(session)
  }
}

function serveUpload(req, res, pathname) {
  const filename = decodeURIComponent(pathname.slice('/uploads/'.length))
  if (!UPLOAD_PATTERN.test(filename)) throw httpError(404, 'not_found', 'Arquivo não encontrado.')
  const filePath = join(UPLOADS_DIR, filename)
  let info
  try {
    info = statSync(filePath)
  } catch {
    throw httpError(404, 'not_found', 'Arquivo não encontrado.')
  }
  if (!info.isFile()) throw httpError(404, 'not_found', 'Arquivo não encontrado.')
  const body = readFileSync(filePath)
  const size = body.length
  const mime = UPLOAD_MIME[extname(filename).toLowerCase()] || 'application/octet-stream'
  const range = String(req.headers.range || '')
  securityHeaders(res)
  res.setHeader('Content-Type', mime)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (match) {
    let start = match[1] ? Number(match[1]) : null
    let end = match[2] ? Number(match[2]) : null
    if (start === null) {
      const suffix = end === null ? 0 : end
      start = Math.max(0, size - suffix)
      end = size - 1
    } else {
      end = end === null ? size - 1 : Math.min(end, size - 1)
    }
    if (start >= size || start > end) {
      res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
        'Content-Length': 0
      })
      return res.end()
    }
    res.writeHead(206, {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`
    })
    return res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1))
  }
  res.writeHead(200, { 'Content-Length': size })
  return res.end(req.method === 'HEAD' ? undefined : body)
}

async function serveStatic(req, res, pathname) {
  let filePath
  try {
    if (pathname === '/' || pathname === '/index.html' || pathname === '/admin') {
      filePath = join(PUBLIC_DIR, 'index.html')
    } else if (pathname === '/download' || pathname === '/download/') {
      filePath = join(PUBLIC_DIR, 'download.html')
    } else {
      const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
      if (!relative || relative.includes('\0')) throw new Error('not found')
      filePath = resolve(PUBLIC_DIR, relative)
      if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) throw new Error('not found')
    }
    const info = statSync(filePath)
    if (info.isDirectory()) filePath = join(filePath, 'index.html')
    const body = readFileSync(filePath)
    securityHeaders(res)
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache'
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    throw httpError(404, 'not_found', 'Página não encontrada.')
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  const method = req.method || 'GET'

  if (pathname.startsWith('/uploads/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      throw httpError(405, 'method_not_allowed', 'Método não permitido.')
    }
    return serveUpload(req, res, pathname)
  }

  if (pathname.startsWith('/api/')) {
    if (method === 'POST') requireMutation(req)
    const { session, deviceId } = getOrCreateClient(req, res)

    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, uptime: stats().uptime, online: stats().online })
    }

    if (pathname === '/api/info' && method === 'GET') {
      return sendJson(res, 200, {
        app: 'ChatBox',
        version: '1.1.0',
        downloadUrl: `${originFor(req)}/api/download`,
        appUrl: originFor(req),
        passwordIsDefault: PASSWORD_IS_DEFAULT,
        stats: stats(),
        rooms: ROOMS
      })
    }

    if (pathname === '/api/me' && method === 'GET') {
      const ban = activeBanFor(session)
      if (ban) {
        return sendJson(res, 403, {
          error: 'banned',
          message: 'Você foi banido deste chat.',
          reason: ban.reason || '',
          until: ban.until
        })
      }
      const kick = activeKickFor(deviceId)
      if (kick) {
        return sendJson(res, 429, {
          error: 'kicked',
          message: 'Você foi expulso temporariamente.',
          reason: kick.reason || '',
          retryAfter: Math.max(1, Math.ceil((kick.until - now()) / 1000))
        })
      }
      if (!session.joined) joinSession(session, guestName())
      refreshMute(session)
      return sendJson(res, 200, {
        you: profileFor(session),
        rooms: ROOMS,
        slowmode,
        stats: stats(),
        isAdmin: isAdmin(session),
        passwordIsDefault: PASSWORD_IS_DEFAULT,
        notices: notices.slice(-24).map(notice => decorateMessage(notice, deviceId)),
        music: musicState()
      })
    }

    if (pathname === '/api/profile/avatar' && method === 'POST') {
      requireSession(session)
      const ban = activeBanFor(session)
      if (ban) return sendJson(res, 403, { error: 'banned', message: 'Você foi banido deste chat.' })
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      const meta = UPLOAD_TYPES[mime]
      if (!meta || meta.kind !== 'image') {
        throw httpError(415, 'unsupported_avatar', 'Envie uma foto em PNG, JPG, GIF, WebP ou AVIF.')
      }
      const declared = Number(req.headers['content-length'] || 0)
      if (declared > meta.max) {
        throw httpError(413, 'file_too_large', `O limite para a foto de perfil é ${Math.round(meta.max / 1024 / 1024)} MB.`)
      }
      const perSession = rateLimit(`avatar:${session.sid}`, 6, 60000)
      if (!perSession.ok) throw httpError(429, 'avatar_slow_down', `Aguarde ${perSession.retryAfter}s para trocar a foto novamente.`)
      const perIp = rateLimit(`avatar-ip:${session.ip}`, 20, 10 * 60000)
      if (!perIp.ok) throw httpError(429, 'avatar_slow_down', 'Muitas trocas de foto. Aguarde um pouco.')
      const buffer = await readBinary(req, meta.max)
      const record = storeUpload(session, buffer, mime, req.headers['x-file-name'])
      record.used = true
      session.avatar = record.url
      for (const list of messages.values()) {
        for (const message of list) {
          if (message.user?.id === session.publicId) message.user.avatar = session.avatar
        }
      }
      broadcastUsers()
      broadcast('avatar', { user: profileFor(session) })
      scheduleMessagesSave()
      return sendJson(res, 200, { you: profileFor(session), avatar: session.avatar })
    }

    if (pathname === '/api/profile' && method === 'POST') {
      requireSession(session)
      const body = await readJson(req)
      const ban = activeBanFor(session)
      if (ban) return sendJson(res, 403, { error: 'banned', message: 'Você foi banido deste chat.' })
      const name = normalizeName(body.name)
      const lower = name.toLocaleLowerCase('pt-BR')
      const taken = [...sessions.values()].some(other => other.sid !== session.sid && other.joined && other.nameLower === lower)
      if (taken) throw httpError(409, 'name_taken', 'Esse nome já está em uso.')
      const nameBan = [...bans.values()].find(banItem => (!banItem.until || banItem.until > now()) && banItem.nameLower === lower)
      if (nameBan) throw httpError(403, 'name_banned', 'Esse nome está banido.')
      const previous = session.name
      session.name = name
      session.nameLower = lower
      refreshMute(session)
      createNotice(`${previous} agora se chama ${name}.`, 'info')
      broadcastUsers()
      return sendJson(res, 200, { you: profileFor(session) })
    }

    if (pathname === '/api/events' && method === 'GET') {
      requireSession(session)
      const ban = activeBanFor(session)
      if (ban) return sendJson(res, 403, { error: 'banned', message: 'Você foi banido deste chat.' })
      const kick = activeKickFor(deviceId)
      if (kick) return sendJson(res, 429, { error: 'kicked', message: 'Você foi expulso temporariamente.' })
      refreshMute(session)

      securityHeaders(res)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      res.write('retry: 2500\n\n')

      const client = { kind: 'sse', res }
      const set = registerClient(session, client)
      sendClient(client, 'hello', helloPayload(session, deviceId))
      broadcastUsers()

      const heartbeat = setInterval(() => {
        try {
          res.write(': keepalive\n\n')
        } catch {
          // Closed below.
        }
      }, 20000)

      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        clearInterval(heartbeat)
        unregisterClient(session, set, client)
      }
      req.on('close', cleanup)
      res.on('error', cleanup)
      return
    }

    if (pathname === '/api/messages' && method === 'POST') {
      requireSession(session)
      const ban = activeBanFor(session)
      if (ban) return sendJson(res, 403, { error: 'banned', message: 'Você foi banido deste chat.' })
      refreshMute(session)
      if (session.mutedUntil > now()) {
        return sendJson(res, 403, {
          error: 'muted',
          message: 'Você está silenciado.',
          reason: session.mutedReason,
          until: session.mutedUntil === Number.MAX_SAFE_INTEGER ? null : session.mutedUntil
        })
      }
      const body = await readJson(req)
      const room = ROOM_IDS.has(body.room) ? body.room : 'geral'
      const text = cleanMessage(body.text, { allowEmpty: Boolean(body.attachmentId) })

      const perSession = rateLimit(`msg:${session.sid}`, 5, 5000)
      if (!perSession.ok) throw httpError(429, 'slow_down', `Aguarde ${perSession.retryAfter}s antes de enviar outra mensagem.`)
      const perIp = rateLimit(`msg-ip:${session.ip}`, 18, 10000)
      if (!perIp.ok) throw httpError(429, 'slow_down', 'Muitas mensagens. Respire um pouco.')

      const cooldown = (slowmode[room] || 0) * 1000
      if (cooldown) {
        const last = session.roomLast.get(room) || 0
        const wait = cooldown - (now() - last)
        if (wait > 0) throw httpError(429, 'slowmode', `Slowmode ativo: aguarde ${Math.ceil(wait / 1000)}s.`)
      }
      const attachment = body.attachmentId ? resolveAttachment(session, body.attachmentId) : null
      if (!text && !attachment) throw httpError(400, 'empty_message', 'Escreva uma mensagem ou anexe uma mídia.')
      session.roomLast.set(room, now())
      const message = createMessage(session, room, text, attachment)
      return sendJson(res, 201, { message: decorateMessage(message, deviceId) })
    }

    if (pathname === '/api/typing' && method === 'POST') {
      requireSession(session)
      if (session.mutedUntil > now()) return sendJson(res, 204, {})
      const body = await readJson(req)
      const room = ROOM_IDS.has(body.room) ? body.room : 'geral'
      if (now() - session.lastTyping < 1500) return sendJson(res, 204, {})
      session.lastTyping = now()
      broadcast('typing', { room, user: profileFor(session) }, other => other.sid !== session.sid)
      return sendJson(res, 204, {})
    }

    if (pathname === '/api/upload' && method === 'POST') {
      requireSession(session)
      const ban = activeBanFor(session)
      if (ban) return sendJson(res, 403, { error: 'banned', message: 'Você foi banido deste chat.' })
      refreshMute(session)
      if (session.mutedUntil > now()) {
        return sendJson(res, 403, {
          error: 'muted',
          message: 'Você está silenciado e não pode enviar mídia.',
          reason: session.mutedReason,
          until: session.mutedUntil === Number.MAX_SAFE_INTEGER ? null : session.mutedUntil
        })
      }
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      const meta = UPLOAD_TYPES[mime]
      if (!meta) throw httpError(415, 'unsupported_media', 'Envie uma imagem, vídeo ou áudio em formato suportado.')
      const declared = Number(req.headers['content-length'] || 0)
      if (declared > MAX_UPLOAD) throw httpError(413, 'file_too_large', 'Arquivo maior que 40 MB.')
      const perSession = rateLimit(`upload:${session.sid}`, 8, 60000)
      if (!perSession.ok) throw httpError(429, 'upload_slow_down', `Aguarde ${perSession.retryAfter}s para enviar outro arquivo.`)
      const perIp = rateLimit(`upload-ip:${session.ip}`, 30, 10 * 60000)
      if (!perIp.ok) throw httpError(429, 'upload_slow_down', 'Muitos envios de mídia. Aguarde um pouco.')
      const buffer = await readBinary(req, MAX_UPLOAD)
      const record = storeUpload(session, buffer, mime, req.headers['x-file-name'])
      return sendJson(res, 201, { attachment: publicUpload(record) })
    }

    if (pathname === '/api/music' && method === 'POST') {
      requireSession(session)
      const ban = activeBanFor(session)
      if (ban) return sendJson(res, 403, { error: 'banned', message: 'Você foi banido deste chat.' })
      const body = await readJson(req)
      const room = ROOM_IDS.has(body.room) ? body.room : 'geral'
      const action = String(body.action || 'play').toLowerCase()
      if (action === 'stop') {
        const result = stopMusic(session, room)
        return sendJson(res, 200, { ok: true, ...result, music: musicPayload(room) })
      }
      if (action !== 'play') throw httpError(400, 'invalid_music_action', 'Ação de música inválida.')
      refreshMute(session)
      if (session.mutedUntil > now()) {
        return sendJson(res, 403, { error: 'muted', message: 'Você está silenciado e não pode tocar música.' })
      }
      const perSession = rateLimit(`music:${session.sid}`, 5, 60000)
      if (!perSession.ok) throw httpError(429, 'music_slow_down', `Aguarde ${perSession.retryAfter}s para tocar outra música.`)
      const perIp = rateLimit(`music-ip:${session.ip}`, 15, 60000)
      if (!perIp.ok) throw httpError(429, 'music_slow_down', 'Muitas músicas iniciadas. Aguarde um pouco.')

      let url = body.url
      if (body.attachmentId) {
        const record = uploads.get(String(body.attachmentId))
        if (record && (record.used || record.sessionSid === session.sid)) url = record.url
      }
      const result = startMusic(session, room, url, body.title)
      return sendJson(res, 200, { ok: true, ...result, music: musicPayload(room) })
    }

    if (pathname === '/api/reactions' && method === 'POST') {
      requireSession(session)
      const body = await readJson(req)
      const symbol = String(body.symbol || '')
      if (!REACTIONS.includes(symbol)) throw httpError(400, 'invalid_reaction', 'Reação inválida.')
      const id = String(body.messageId || '')
      for (const list of messages.values()) {
        const message = list.find(item => item.id === id)
        if (!message) continue
        if (message.deleted) throw httpError(409, 'deleted_message', 'Mensagem removida.')
        const devices = message.reactions[symbol] || []
        const index = devices.indexOf(deviceId)
        if (index >= 0) devices.splice(index, 1)
        else devices.push(deviceId)
        if (devices.length) message.reactions[symbol] = devices
        else delete message.reactions[symbol]
        const payload = decorateMessage(message, deviceId)
        broadcast('message:update', { ...decorateMessage(message), mine: [] })
        scheduleMessagesSave()
        return sendJson(res, 200, { message: payload })
      }
      throw httpError(404, 'message_not_found', 'Mensagem não encontrada.')
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      const ip = session.ip
      const attempt = loginAttempts.get(ip)
      if (attempt?.blockedUntil > now()) {
        throw httpError(429, 'login_blocked', `Muitas tentativas. Tente em ${Math.ceil((attempt.blockedUntil - now()) / 60000)}min.`)
      }
      const body = await readJson(req)
      if (!checkPassword(body.password)) {
        const record = attempt && attempt.reset > now() ? attempt : { count: 0, reset: now() + 10 * 60 * 1000, blockedUntil: 0 }
        record.count += 1
        if (record.count >= 5) record.blockedUntil = now() + 10 * 60 * 1000
        loginAttempts.set(ip, record)
        throw httpError(401, 'bad_password', 'Senha incorreta.')
      }
      loginAttempts.delete(ip)
      session.isAdmin = true
      session.adminUntil = now() + ADMIN_TTL
      audit(session, 'login', '', '')
      broadcastUsers()
      return sendJson(res, 200, {
        you: profileFor(session),
        passwordIsDefault: PASSWORD_IS_DEFAULT,
        overview: adminOverview(session)
      })
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      if (isAdmin(session)) audit(session, 'logout', '', '')
      session.isAdmin = false
      session.adminUntil = 0
      broadcastUsers()
      return sendJson(res, 200, { you: profileFor(session) })
    }

    if (pathname === '/api/admin/overview' && method === 'GET') {
      requireAdminSession(session)
      return sendJson(res, 200, adminOverview(session))
    }

    if (pathname === '/api/admin/action' && method === 'POST') {
      requireAdminSession(session)
      const body = await readJson(req)
      const action = String(body.action || '')
      const target = String(body.target || '').trim()
      const reason = cleanReason(body.reason)
      let result
      switch (action) {
        case 'ban':
          result = banTarget(session, target, parseMinutes(body.minutes, 0), reason)
          break
        case 'mute':
          result = muteTarget(session, target, parseMinutes(body.minutes, 10), reason)
          break
        case 'kick':
          result = kickTarget(session, target, reason)
          break
        case 'unban':
          result = unbanTarget(session, body.id || target)
          break
        case 'unmute':
          result = unmuteTarget(session, body.id || target)
          break
        case 'clear':
          result = clearRoom(session, String(body.room || 'all'))
          break
        case 'slowmode':
          result = setSlowmode(session, String(body.room || 'geral'), body.seconds)
          break
        case 'announce':
          result = announce(session, target || body.text)
          break
        case 'delete':
          result = deleteMessage(session, body.messageId)
          break
        default:
          throw httpError(400, 'unknown_action', 'Ação desconhecida.')
      }
      return sendJson(res, 200, { ok: true, message: result.message, overview: adminOverview(session) })
    }

    if (pathname === '/api/admin/command' && method === 'POST') {
      requireAdminSession(session)
      const body = await readJson(req)
      const result = runCommand(session, body.command)
      return sendJson(res, 200, { ok: true, lines: result.lines, overview: adminOverview(session) })
    }

    if (pathname === '/api/download' && method === 'GET') {
      const zip = buildZip()
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
      securityHeaders(res)
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="chatbox-${stamp}.zip"`,
        'Content-Length': zip.length,
        'Cache-Control': 'no-store'
      })
      return res.end(zip)
    }

    throw httpError(404, 'not_found', 'Endpoint não encontrado.')
  }

  if (method !== 'GET' && method !== 'HEAD') throw httpError(405, 'method_not_allowed', 'Método não permitido.')
  return serveStatic(req, res, pathname)
}

loadState()
loadMessages()
if (![...messages.values()].some(list => list.length) && !notices.length) {
  createNotice('Bem-vindo ao ChatBox: converse em tempo real, reaja às mensagens e use a área administrativa para moderar.', 'info')
}

if (process.env.OPENCODE_WEB_DIR) {
  try {
    writeFileSync(join(process.env.OPENCODE_WEB_DIR, 'deployment-output.json'), JSON.stringify({
      project: process.env.PROJECT_DIR ? resolve(process.env.PROJECT_DIR) : ROOT,
      directory: resolve(PUBLIC_DIR)
    }))
  } catch (error) {
    console.error(`[chatbox] não foi possível publicar deployment-output.json: ${error.message}`)
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        // Ignore.
      }
      return
    }
    const status = error.status || 500
    if (status >= 500) console.error(error)
    sendJson(res, status, {
      error: error.code || 'server_error',
      message: error.publicMessage || 'Erro interno do servidor.',
      ...(error.extra || {})
    })
  })
})


function attachWebSocket(session, set, client, socket, head) {
  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
  let finished = false

  const finish = () => {
    if (finished) return
    finished = true
    clearInterval(ping)
    unregisterClient(session, set, client)
  }

  const ping = setInterval(() => {
    try {
      socket.write(Buffer.from([0x89, 0x00]))
    } catch {
      finish()
    }
  }, 25000)
  ping.unref()

  const consume = () => {
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_WS_FRAME)) {
          socket.destroy()
          return
        }
        length = Number(big)
        offset = 10
      }
      if (length > MAX_WS_FRAME) {
        socket.destroy()
        return
      }
      if (!masked) {
        socket.destroy()
        return
      }
      if (buffer.length < offset + 4) return
      const mask = buffer.subarray(offset, offset + 4)
      offset += 4
      if (buffer.length < offset + length) return
      const raw = buffer.subarray(offset, offset + length)
      const payload = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) payload[index] = raw[index] ^ mask[index % 4]
      buffer = buffer.subarray(offset + length)

      if (!fin) {
        socket.destroy()
        return
      }
      if (opcode === 0x8) {
        try {
          socket.write(wsFrame(payload.subarray(0, 125), 0x8))
          socket.end()
        } catch {
          // Already closed.
        }
        finish()
        return
      }
      if (opcode === 0x9) {
        try {
          socket.write(wsFrame(payload.subarray(0, 125), 0xA))
        } catch {
          finish()
        }
        continue
      }
      if (opcode === 0x1) {
        try {
          const packet = JSON.parse(payload.toString())
          if (packet?.type === 'ping') sendClient(client, 'pong', { at: now() })
        } catch {
          // Ignore malformed or unsupported client messages.
        }
      }
    }
  }

  socket.on('data', chunk => {
    session.lastSeen = now()
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    if (buffer.length > MAX_WS_FRAME) {
      socket.destroy()
      return
    }
    consume()
  })
  socket.on('close', finish)
  socket.on('end', finish)
  socket.on('error', finish)
  consume()
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {})
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    const key = req.headers['sec-websocket-key']
    if (pathname !== '/api/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const origin = req.headers.origin
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        // Invalid origin.
      }
      if (originHost !== req.headers.host) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
    }
    const sid = parseCookies(req.headers.cookie).cb_sid
    const session = sid ? sessions.get(sid) : null
    if (!session || !session.joined || now() - session.lastSeen > SESSION_TTL) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    if (activeBanFor(session)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    if (activeKickFor(session.deviceId)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
      return
    }
    session.lastSeen = now()
    session.ip = clientIp(req)
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.setNoDelay(true)
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'))

    const client = { kind: 'ws', socket }
    const set = registerClient(session, client)
    sendClient(client, 'hello', helloPayload(session, session.deviceId))
    broadcastUsers()
    attachWebSocket(session, set, client, socket, head)
  } catch {
    socket.destroy()
  }
})

server.listen(PORT, HOST, () => {
  const label = PASSWORD_IS_DEFAULT ? 'padrão (defina ADMIN_PASSWORD em produção)' : 'personalizada'
  console.log(`[chatbox] online em http://localhost:${PORT}`)
  console.log(`[chatbox] senha admin: ${label}`)
})

const maintenance = setInterval(() => {
  const at = now()
  for (const [sid, session] of sessions) {
    if (at - session.lastSeen > SESSION_TTL) {
      const set = connections.get(sid)
      if (set) {
        for (const client of set) closeClient(client)
        connections.delete(sid)
      }
      sessions.delete(sid)
    }
  }
  for (const [id, ban] of bans) if (ban.until && ban.until <= at) bans.delete(id)
  for (const [id, mute] of mutes) if (mute.until && mute.until <= at) mutes.delete(id)
  for (const [device, record] of kickCooldowns) if (record.until <= at) kickCooldowns.delete(device)
  for (const [ip, attempt] of loginAttempts) if (attempt.reset <= at && attempt.blockedUntil <= at) loginAttempts.delete(ip)
  for (const [key, bucket] of rateBuckets) if (bucket.reset + 60000 < at) rateBuckets.delete(key)
}, 60000)
maintenance.unref()

function shutdown() {
  if (saveTimer) clearTimeout(saveTimer)
  if (messagesSaveTimer) clearTimeout(messagesSaveTimer)
  saveState()
  saveMessages()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
