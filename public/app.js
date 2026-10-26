const REACTIONS = ['♥', '★', '✧', '✓']
const ROOM_KEY = 'chatbox:room'
const VOLUME_KEY = 'chatbox:music-volume'
const UPLOAD_LIMITS = {
  image: 8 * 1024 * 1024,
  video: 40 * 1024 * 1024,
  audio: 15 * 1024 * 1024
}
const AVATAR_SOURCE_LIMIT = 20 * 1024 * 1024
const UPLOAD_TYPES = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac']
}
const AVATAR_COLORS = 8
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

const state = {
  me: null,
  users: [],
  rooms: [],
  messages: [],
  notices: [],
  currentRoom: localStorage.getItem(ROOM_KEY) || 'geral',
  slowmode: {},
  unread: {},
  unseen: 0,
  typing: new Map(),
  source: null,
  connected: false,
  admin: { isAdmin: false, passwordIsDefault: false },
  overview: null,
  myReactions: new Map(),
  animateId: null,
  blocked: false,
  adminTab: 'actions',
  lastTypingSent: 0,
  sending: false,
  pending: null,
  uploading: false,
  uploadXhr: null,
  music: {},
  musicKey: null,
  musicPaused: false,
  musicNeedsGesture: false
}

let avatarUploading = false

const $ = id => document.getElementById(id)
const messageScroll = $('message-scroll')
const messageList = $('message-list')
const messageInput = $('message-input')
const sendButton = $('send-btn')
const uploadPreview = $('upload-preview')
const uploadThumb = $('upload-thumb')
const uploadName = $('upload-name')
const uploadStatus = $('upload-status')
const uploadProgress = $('upload-progress')
const uploadCancel = $('upload-cancel')
const musicDock = $('music-dock')
const musicAudio = $('music-audio')
const musicTitle = $('music-title')
const musicBy = $('music-by')
const musicClock = $('music-clock')
const musicToggle = $('music-toggle')
const musicToggleIcon = $('music-toggle-icon')
const musicStop = $('music-stop')
const musicLink = $('music-link')

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className)
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#${name}`)
  svg.append(use)
  return svg
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function initial(name) {
  const characters = Array.from(String(name || '?'))
  return (characters[0] || '?').toLocaleUpperCase('pt-BR')
}

function applyAvatar(node, user = {}) {
  if (!node) return
  for (let index = 0; index < AVATAR_COLORS; index += 1) node.classList.remove(`avatar-${index}`)
  node.classList.add(`avatar-${user.color ?? 0}`)
  node.classList.toggle('has-photo', Boolean(user.avatar))
  if (user.avatar) {
    node.textContent = ''
    node.style.backgroundImage = `url(${JSON.stringify(user.avatar)})`
  } else {
    node.style.backgroundImage = ''
    node.textContent = initial(user.name)
  }
  if (user.name) node.title = user.name
}

const saveData = Boolean(navigator.connection && navigator.connection.saveData)
const lazyVideos = new Set()
let videoCheckTimer = 0
let videoCheckSuppressed = false
let videoCheckReleaseTimer = 0

function suppressVideoChecks() {
  videoCheckSuppressed = true
  clearTimeout(videoCheckReleaseTimer)
  videoCheckReleaseTimer = setTimeout(releaseVideoChecks, 1200)
}

function releaseVideoChecks() {
  videoCheckSuppressed = false
  clearTimeout(videoCheckReleaseTimer)
  scheduleVideoCheck()
}

function loadVideoPreview(video) {
  if (!video || !video.isConnected || video.dataset.started || video.preload !== 'none') return
  video.preload = 'metadata'
  video.load()
}

function checkVisibleVideos() {
  videoCheckTimer = 0
  if (saveData || videoCheckSuppressed) return
  const margin = 360
  const height = window.innerHeight
  for (const video of [...lazyVideos]) {
    if (!video.isConnected) {
      lazyVideos.delete(video)
      continue
    }
    if (video.dataset.started || video.preload !== 'none') {
      lazyVideos.delete(video)
      continue
    }
    const rect = video.getBoundingClientRect()
    if (rect.bottom < -margin || rect.top > height + margin) continue
    lazyVideos.delete(video)
    loadVideoPreview(video)
  }
}

function scheduleVideoCheck() {
  clearTimeout(videoCheckTimer)
  videoCheckTimer = setTimeout(checkVisibleVideos, 140)
}

function prepareVideo(video) {
  video.width = 640
  video.height = 360
  video.addEventListener('loadedmetadata', () => {
    lazyVideos.delete(video)
    if (!video.videoWidth || !video.videoHeight) return
    video.width = video.videoWidth
    video.height = video.videoHeight
  }, { once: true })
  video.addEventListener('pointerdown', () => {
    lazyVideos.delete(video)
    loadVideoPreview(video)
  }, { once: true, passive: true })
  video.addEventListener('play', () => {
    video.dataset.started = '1'
    lazyVideos.delete(video)
  }, { once: true })
  if (!saveData) {
    lazyVideos.add(video)
    scheduleVideoCheck()
  }
}

if (messageScroll) {
  messageScroll.addEventListener('scroll', scheduleVideoCheck, { passive: true })
  messageScroll.addEventListener('scrollend', releaseVideoChecks, { passive: true })
}
window.addEventListener('resize', scheduleVideoCheck, { passive: true })

const videoListObserver = new MutationObserver(scheduleVideoCheck)
videoListObserver.observe(messageList, { childList: true })

function timeOf(ts) {
  try {
    return timeFormat.format(new Date(ts))
  } catch {
    return ''
  }
}

function fullTime(ts) {
  try {
    return dateTimeFormat.format(new Date(ts))
  } catch {
    return ''
  }
}

function untilLabel(ts) {
  if (!ts) return 'permanente'
  const remaining = ts - Date.now()
  if (remaining <= 0) return 'expirado'
  const minutes = Math.ceil(remaining / 60000)
  if (minutes < 60) return `mais ${minutes}min`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `mais ${hours}h`
  return `até ${dateTimeFormat.format(new Date(ts))}`
}

function toast(message, level = 'info', timeout = 4200) {
  if (!message) return
  const node = element('div', `toast is-${level}`)
  node.append(element('span', 'toast-dot'))
  node.append(element('span', '', message))
  $('toast-stack').append(node)
  setTimeout(() => {
    node.classList.add('is-leaving')
    setTimeout(() => node.remove(), 220)
  }, timeout)
}

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'chatbox' }
  }
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(path, init)
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok) {
    const error = new Error(data?.message || `Falha na requisição (${response.status})`)
    error.status = response.status
    error.data = data || {}
    throw error
  }
  return data
}

function isNearBottom() {
  return messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight < 130
}

function scrollToBottom(behavior = 'auto') {
  messageScroll.scrollTo({ top: messageScroll.scrollHeight, behavior })
}

function visibleMessages() {
  return state.messages.filter(message => message.kind === 'notice' || message.room === state.currentRoom)
}

function ownMessage(message) {
  return Boolean(state.me && message.user && message.user.id === state.me.id)
}

function reactionSet(messageId) {
  if (!state.myReactions.has(messageId)) state.myReactions.set(messageId, new Set())
  return state.myReactions.get(messageId)
}

function linkify(text) {
  const fragment = document.createDocumentFragment()
  const pattern = /https?:\/\/[^\s<>"']+/gi
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)))
    let label = match[0]
    let trailing = ''
    while (/[.,;:!?)]$/.test(label)) {
      trailing = label.slice(-1) + trailing
      label = label.slice(0, -1)
    }
    try {
      const url = new URL(label)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const anchor = element('a', '', label)
        anchor.href = url.href
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer nofollow'
        fragment.append(anchor)
      } else {
        fragment.append(document.createTextNode(label))
      }
    } catch {
      fragment.append(document.createTextNode(label))
    }
    if (trailing) fragment.append(document.createTextNode(trailing))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)))
  return fragment
}

function renderAttachment(attachment) {
  const wrap = element('div', 'msg-attachment')
  if (!attachment || !attachment.url) return wrap
  if (attachment.type === 'image') {
    const link = element('a', 'attach-image')
    link.href = attachment.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    const image = element('img')
    image.src = attachment.url
    image.alt = attachment.name || 'Imagem enviada'
    image.loading = 'lazy'
    image.decoding = 'async'
    link.append(image)
    wrap.append(link)
    return wrap
  }
  if (attachment.type === 'video') {
    wrap.classList.add('has-video')
    const video = element('video')
    video.controls = true
    video.preload = 'none'
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.src = attachment.url
    video.title = attachment.name || 'Vídeo enviado'
    video.setAttribute('aria-label', attachment.name || 'Vídeo enviado')
    wrap.append(video)
    prepareVideo(video)
    return wrap
  }
  if (attachment.type === 'audio') {
    const player = element('div', 'attach-audio')
    const audio = element('audio')
    audio.controls = true
    audio.preload = 'metadata'
    audio.src = attachment.url
    const play = element('button', 'attach-play')
    play.type = 'button'
    play.dataset.playMusic = attachment.id || ''
    play.dataset.musicUrl = attachment.url
    play.dataset.musicTitle = (attachment.name || 'Áudio').replace(/\.[^.]+$/, '')
    play.title = 'Tocar este áudio para todos na sala'
    play.append(icon('i-music'))
    play.append(document.createTextNode('Tocar no chat'))
    player.append(audio, play)
    wrap.append(player)
    const meta = element('div', 'attach-meta')
    meta.append(element('span', '', attachment.name || 'Áudio'))
    meta.append(element('span', '', formatBytes(attachment.size)))
    wrap.append(meta)
  }
  return wrap
}

function renderMessage(message, previous) {
  if (message.kind === 'notice') {
    const row = element('div', 'msg-notice')
    const pill = element('span', `notice-pill is-${message.level || 'info'}`)
    pill.append(icon(message.level === 'admin' ? 'i-shield' : 'i-spark'))
    pill.append(element('span', '', message.text))
    pill.title = fullTime(message.ts)
    row.append(pill)
    return row
  }

  const compact = Boolean(
    previous &&
    previous.kind === 'chat' &&
    previous.user && message.user &&
    previous.user.id === message.user.id &&
    message.ts - previous.ts < 5 * 60 * 1000 &&
    !message.deleted && !previous.deleted
  )

  const row = element('div', `msg${ownMessage(message) ? ' is-me' : ''}${compact ? ' is-compact' : ''}`)
  if (state.animateId === message.id) row.classList.add('is-new')
  row.dataset.messageId = message.id

  const avatarSlot = element('div', 'msg-avatar-slot')
  if (compact) {
    avatarSlot.append(element('span', 'compact-time', timeOf(message.ts)))
  } else {
    const avatar = element('span', 'avatar avatar-lg')
    applyAvatar(avatar, message.user)
    if (message.user?.id) avatar.dataset.userId = message.user.id
    avatarSlot.append(avatar)
  }
  row.append(avatarSlot)

  const body = element('div', 'msg-body')
  if (!compact) {
    const head = element('div', 'msg-head')
    head.append(element('span', 'msg-author', message.user?.name || 'Anônimo'))
    if (message.user?.admin) head.append(element('span', 'admin-tag', 'ADMIN'))
    const stamp = element('span', 'msg-time', timeOf(message.ts))
    stamp.title = fullTime(message.ts)
    head.append(stamp)
    body.append(head)
  }

  if (message.deleted) {
    const text = element('div', 'msg-text is-deleted', 'Mensagem removida pela moderação.')
    body.append(text)
  } else if (message.text) {
    const text = element('div', 'msg-text')
    text.append(linkify(message.text))
    body.append(text)
  }
  if (!message.deleted && message.attachment) body.append(renderAttachment(message.attachment))

  const reactions = message.reactions || {}
  const mine = reactionSet(message.id)
  const symbols = Object.keys(reactions)
  if (symbols.length) {
    const bar = element('div', 'reactions')
    for (const symbol of symbols) {
      const mineReaction = mine.has(symbol) || Boolean(message.mine?.includes(symbol))
      const pill = element('button', `reaction-pill${mineReaction ? ' is-mine' : ''}`)
      pill.type = 'button'
      pill.dataset.react = symbol
      pill.dataset.messageId = message.id
      pill.title = mineReaction ? 'Remover reação' : 'Reagir'
      pill.append(element('span', '', symbol))
      pill.append(element('span', 'reaction-count', String(reactions[symbol])))
      bar.append(pill)
    }
    body.append(bar)
  }

  row.append(body)

  const actions = element('div', 'msg-actions')
  if (!message.deleted) {
    for (const symbol of REACTIONS) {
      const button = element('button', 'react-btn', symbol)
      button.type = 'button'
      button.dataset.react = symbol
      button.dataset.messageId = message.id
      button.title = `Reagir com ${symbol}`
      actions.append(button)
    }
  }
  if (state.admin.isAdmin && !message.deleted) {
    const remove = element('button', 'del-btn')
    remove.type = 'button'
    remove.dataset.delete = message.id
    remove.title = 'Remover mensagem'
    remove.append(icon('i-trash', 'icon icon-small'))
    actions.append(remove)
  }
  if (actions.childElementCount) row.append(actions)

  return row
}

function renderMessages({ scroll = false, smooth = false } = {}) {
  const nearBottom = isNearBottom()
  const visible = visibleMessages()
  messageList.replaceChildren()

  const fragment = document.createDocumentFragment()
  let previous = null
  for (const message of visible) {
    fragment.append(renderMessage(message, previous))
    previous = message.kind === 'notice' ? null : message
  }
  messageList.append(fragment)

  const hasChat = visible.some(message => message.kind === 'chat')
  $('empty-state').hidden = hasChat
  state.animateId = null

  if (scroll || nearBottom) {
    suppressVideoChecks()
    scrollToBottom(smooth ? 'smooth' : 'auto')
  }
  updateJumpButton()
}

function updateJumpButton() {
  const button = $('jump-latest')
  if (state.unseen > 0) {
    button.hidden = false
    $('jump-count').textContent = String(state.unseen)
  } else {
    button.hidden = true
  }
}

function renderRoomList() {
  const list = $('room-list')
  list.replaceChildren()
  for (const room of state.rooms) {
    const button = element('button', `room-btn${room.id === state.currentRoom ? ' is-active' : ''}`)
    button.type = 'button'
    button.dataset.room = room.id
    button.append(element('span', 'room-hash', '#'))
    const copy = element('span', 'room-copy')
    copy.append(element('strong', '', room.label))
    copy.append(element('small', '', room.description))
    button.append(copy)
    if (state.slowmode[room.id] > 0) {
      button.append(element('span', 'room-badge', `${state.slowmode[room.id]}s`))
    } else if (state.unread[room.id] > 0) {
      button.append(element('span', 'count-pill', String(state.unread[room.id])))
    }
    list.append(button)
  }
}

function renderUsers() {
  const list = $('user-list')
  list.replaceChildren()
  $('online-count').textContent = String(state.users.length)
  if (!state.users.length) {
    list.append(element('li', 'empty-list', 'Ninguém online ainda.'))
    return
  }
  for (const user of state.users) {
    const item = element('li', `user-item${state.admin.isAdmin ? ' is-clickable' : ''}`)
    if (state.admin.isAdmin) {
      item.tabIndex = 0
      item.dataset.target = user.name
      item.title = `Selecionar ${user.name} no painel`
    }
    const avatar = element('span', 'avatar avatar-sm')
    applyAvatar(avatar, user)
    avatar.dataset.userId = user.id
    item.append(avatar)
    const copy = element('span', 'user-copy')
    const name = element('strong')
    name.append(document.createTextNode(user.name))
    if (user.isAdmin) name.append(element('span', 'admin-tag', 'ADMIN'))
    if (user.muted) name.append(element('span', 'muted-tag', 'MUTADO'))
    if (state.me && user.id === state.me.id) name.append(element('span', 'self-tag', 'você'))
    copy.append(name)
    copy.append(element('small', '', user.muted ? 'silenciado' : 'online agora'))
    item.append(copy)
    list.append(item)
  }
}

function setConnection(online) {
  state.connected = online
  const pill = $('connection-pill')
  pill.classList.toggle('is-offline', !online)
  $('connection-text').textContent = online ? 'ao vivo' : 'reconectando'
}

function applyMe(you) {
  if (!you) return
  state.me = you
  $('me-name').textContent = you.name
  applyAvatar($('me-avatar'), you)
  applyAvatar($('profile-avatar-preview'), you)
  let role = 'online'
  if (you.isAdmin) role = 'administrador'
  else if (you.muted) role = 'silenciado'
  $('me-role').textContent = role
  updateComposer()
}

function applyAvatarUpdate(user) {
  if (!user?.id) return
  if (state.me?.id === user.id) {
    state.me = { ...state.me, ...user }
    applyMe(state.me)
  } else {
    const known = state.users.find(item => item.id === user.id)
    if (known) Object.assign(known, user)
  }
  for (const message of state.messages) {
    if (message.user?.id !== user.id) continue
    message.user = { ...message.user, avatar: user.avatar, name: user.name || message.user.name, color: user.color ?? message.user.color }
  }
  for (const node of document.querySelectorAll('.avatar[data-user-id]')) {
    if (node.dataset.userId === user.id) applyAvatar(node, user)
  }
}

function isMuted() {
  if (!state.me?.muted) return false
  if (state.me.mutedUntil && state.me.mutedUntil <= Date.now()) return false
  return true
}

function updateComposer() {
  const muted = isMuted()
  if (!state.me) {
    messageInput.disabled = true
    sendButton.disabled = true
    for (const button of document.querySelectorAll('.tool-btn')) button.disabled = true
    return
  }
  messageInput.disabled = muted
  messageInput.placeholder = muted
    ? `Silenciado ${state.me.mutedUntil ? untilLabel(state.me.mutedUntil) : 'permanentemente'} — fale com um administrador`
    : 'Escreva uma mensagem...'
  sendButton.disabled = muted || state.sending || state.uploading || (!messageInput.value.trim() && !state.pending)
  for (const button of document.querySelectorAll('.tool-btn')) button.disabled = muted || state.uploading
  $('char-count').textContent = `${Array.from(messageInput.value).length}/1000`
}

function selectRoom(roomId) {
  if (!state.rooms.some(room => room.id === roomId)) roomId = 'geral'
  state.currentRoom = roomId
  state.unread[roomId] = 0
  state.unseen = 0
  localStorage.setItem(ROOM_KEY, roomId)
  const room = state.rooms.find(item => item.id === roomId)
  if (room) {
    $('room-title').textContent = room.label
    $('room-description').textContent = room.description
  }
  renderRoomList()
  renderMessages({ scroll: true })
  renderMusic()
  closeMobileSidebar()
  messageInput.focus()
}

function syncHello(data) {
  state.rooms = data.rooms || state.rooms
  state.slowmode = data.slowmode || {}
  state.users = data.users || []
  state.admin.isAdmin = Boolean(data.admin?.isAdmin)
  state.admin.passwordIsDefault = Boolean(data.admin?.passwordIsDefault)
  applyMe(data.you)
  state.music = {}
  for (const [room, track] of Object.entries(data.music || {})) {
    state.music[room] = track ? { ...track, _receivedAt: Date.now() } : null
  }

  const all = []
  state.myReactions.clear()
  for (const room of state.rooms) {
    for (const message of data.messages?.[room.id] || []) {
      all.push(message)
      state.myReactions.set(message.id, new Set(message.mine || []))
    }
  }
  state.notices = (data.notices || []).map(notice => ({ ...notice }))
  all.push(...state.notices)
  all.sort((a, b) => a.seq - b.seq)
  state.messages = all
  state.unseen = 0
  updateAdminUi()
  renderRoomList()
  renderUsers()
  renderMessages({ scroll: true })
  renderMusic()
  updateJumpButton()
  setConnection(true)
}

function upsertMessage(message) {
  const index = state.messages.findIndex(item => item.id === message.id)
  if (index >= 0) {
    state.messages[index] = message
    return false
  }
  state.messages.push(message)
  state.messages.sort((a, b) => a.seq - b.seq)
  if (state.messages.length > 700) state.messages.splice(0, state.messages.length - 700)
  return true
}

function appendMessageRow(message) {
  const visible = visibleMessages()
  const previous = visible.length > 1 ? visible[visible.length - 2] : null
  messageList.append(renderMessage(message, previous))
  const hasChat = visible.some(item => item.kind === 'chat')
  $('empty-state').hidden = hasChat
}

function handleIncoming(message) {
  const added = upsertMessage(message)
  const relevant = message.kind === 'notice' || message.room === state.currentRoom
  if (!relevant) {
    if (added && message.kind === 'chat') {
      state.unread[message.room] = (state.unread[message.room] || 0) + 1
      renderRoomList()
    }
    return
  }
  if (!added) return

  const visible = visibleMessages()
  const isLast = visible[visible.length - 1]?.id === message.id
  const canAppend = isLast && messageList.childElementCount === visible.length - 1
  if (canAppend) {
    const wasNear = isNearBottom()
    const mine = ownMessage(message)
    state.animateId = message.id
    appendMessageRow(message)
    state.animateId = null
    if (wasNear || mine) {
      scrollToBottom('auto')
    } else if (message.kind === 'chat') {
      state.unseen += 1
    }
    updateJumpButton()
    return
  }

  const wasNear = isNearBottom()
  const mine = ownMessage(message)
  if (wasNear || mine) {
    state.animateId = message.id
    renderMessages({ scroll: true })
  } else {
    state.animateId = message.id
    renderMessages()
    if (message.kind === 'chat') state.unseen += 1
    updateJumpButton()
  }
}

let reconnectTimer = null
let wsFailures = 0
let preferStream = false

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect(delay = 2500) {
  if (state.blocked) return
  clearReconnect()
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (state.blocked) return
    try {
      await api('/api/me')
      connect()
    } catch (error) {
      if (error.data?.error === 'banned' || error.data?.error === 'kicked') showBlocked(error.data)
      else scheduleReconnect(5000)
    }
  }, delay)
}

function dispatchEvent(type, data) {
  if (!data) return
  switch (type) {
    case 'hello':
      syncHello(data)
      break
    case 'message':
      if (data.message) handleIncoming(data.message)
      break
    case 'notice':
      handleIncoming(data)
      if (['warn', 'danger', 'success', 'admin'].includes(data.level)) {
        toast(data.text, data.level === 'admin' ? 'admin' : data.level)
      }
      break
    case 'message:update': {
      const index = state.messages.findIndex(item => item.id === data.id)
      if (index >= 0) {
        state.messages[index] = { ...state.messages[index], ...data, mine: [] }
        renderMessages()
      }
      break
    }
    case 'users':
      state.users = data.users || []
      renderUsers()
      if (state.overview) fillTargets()
      break
    case 'avatar':
      applyAvatarUpdate(data.user)
      break
    case 'typing':
      if (!data.user || data.room !== state.currentRoom) return
      state.typing.set(data.user.id, { name: data.user.name, at: Date.now(), room: data.room })
      renderTyping()
      break
    case 'you':
      if (data.you) applyMe(data.you)
      renderUsers()
      break
    case 'state':
      if (data.slowmode) {
        state.slowmode = data.slowmode
        renderRoomList()
      }
      break
    case 'music':
      handleMusicEvent(data)
      break
    case 'cleared':
      state.messages = state.messages.filter(message => {
        if (message.kind !== 'chat') return true
        return data.room === 'all' ? false : message.room !== data.room
      })
      renderMessages()
      break
    case 'banned':
      showBlocked({ error: 'banned', message: 'Seu acesso foi bloqueado por um administrador.', ...data })
      break
    case 'kicked':
      showBlocked({ error: 'kicked', message: 'Você foi expulso da sala por um administrador.', ...data })
      break
    default:
      break
  }
}

function connect() {
  if (state.blocked) return
  clearReconnect()
  if (state.source) {
    try {
      state.source.close()
    } catch {
      // Already closed.
    }
    state.source = null
  }
  setConnection(false)
  if (!preferStream && typeof WebSocket === 'function') connectSocket()
  else connectStream()
}

function connectSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  let socket
  try {
    socket = new WebSocket(`${protocol}//${location.host}/api/ws`)
  } catch {
    preferStream = true
    connectStream()
    return
  }
  state.source = socket
  let opened = false
  const openTimer = setTimeout(() => {
    if (opened || state.source !== socket) return
    wsFailures += 1
    if (wsFailures >= 2) preferStream = true
    try {
      state.source = null
      socket.close()
    } catch {
      // Already closed.
    }
    scheduleReconnect(1200)
  }, 6000)

  socket.addEventListener('open', () => {
    opened = true
    wsFailures = 0
    clearTimeout(openTimer)
    setConnection(true)
  })

  socket.addEventListener('message', event => {
    try {
      const packet = JSON.parse(event.data)
      if (packet && packet.type) dispatchEvent(packet.type, packet.data)
    } catch {
      // Ignore malformed packets.
    }
  })

  socket.addEventListener('close', () => {
    clearTimeout(openTimer)
    if (state.source !== socket) return
    state.source = null
    setConnection(false)
    if (!opened) {
      wsFailures += 1
      if (wsFailures >= 2) preferStream = true
    }
    if (!state.blocked) scheduleReconnect(opened ? 2000 : 1200)
  })

  socket.addEventListener('error', () => {
    if (!opened) {
      clearTimeout(openTimer)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
  })
}

function connectStream() {
  if (state.blocked) return
  const source = new EventSource('/api/events')
  state.source = source
  source.addEventListener('open', () => setConnection(true))
  const events = ['hello', 'message', 'notice', 'message:update', 'users', 'avatar', 'typing', 'you', 'state', 'music', 'cleared', 'banned', 'kicked']
  for (const name of events) {
    source.addEventListener(name, event => {
      try {
        dispatchEvent(name, JSON.parse(event.data))
      } catch {
        // Ignore malformed packets.
      }
    })
  }
  source.addEventListener('error', () => {
    setConnection(false)
    if (source.readyState === EventSource.CLOSED && state.source === source) {
      state.source = null
      scheduleReconnect(3000)
    }
  })
}

async function startAudioForRoom(attachment, room) {
  try {
    await api('/api/music', {
      method: 'POST',
      body: {
        action: 'play',
        room,
        attachmentId: attachment.id || '',
        url: attachment.url,
        title: (attachment.name || 'Áudio').replace(/\.[^.]+$/, '')
      }
    })
  } catch (error) {
    if (['banned', 'kicked'].includes(error.data?.error)) return
    toast(`Áudio enviado, mas não foi possível tocar: ${error.message}`, 'warn')
  }
}

async function playAttachmentTrack(button) {
  const attachmentId = button.dataset.playMusic || ''
  const url = button.dataset.musicUrl || ''
  const title = button.dataset.musicTitle || ''
  try {
    const data = await api('/api/music', {
      method: 'POST',
      body: { action: 'play', room: state.currentRoom, attachmentId, url, title }
    })
    toast(data.message || 'Tocando no chat.', 'success')
    focusComposer()
  } catch (error) {
    if (['banned', 'kicked'].includes(error.data?.error)) return showBlocked(error.data)
    toast(error.message, 'danger')
  }
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  const rest = String(total % 60).padStart(2, '0')
  return `${minutes}:${rest}`
}

function musicTrackKey(track) {
  return track ? `${track.room}:${track.id || track.startedAt}:${track.url}` : null
}

function updateMusicClock() {
  const track = state.music[state.currentRoom]
  if (!track) return
  const offset = (track.serverTime || Date.now()) - (track._receivedAt || Date.now())
  const elapsed = Math.max(0, (Date.now() + offset - track.startedAt) / 1000)
  const duration = Number.isFinite(musicAudio.duration) && musicAudio.duration > 0 ? musicAudio.duration : null
  const position = duration ? elapsed % duration : elapsed
  musicClock.textContent = formatClock(position)
  musicClock.title = 'Sincronizado ao vivo'
}

function updateMusicUi() {
  const track = state.music[state.currentRoom]
  if (!track) return
  const playing = !musicAudio.paused && !musicAudio.ended && !state.musicPaused
  musicDock.classList.toggle('is-paused', !playing)
  musicDock.classList.toggle('needs-gesture', state.musicNeedsGesture)
  musicToggleIcon.setAttribute('href', playing ? '#i-pause' : '#i-play')
  const canStop = state.admin.isAdmin || (state.me && track.by?.id === state.me.id)
  musicStop.hidden = !canStop
  updateMusicClock()
}

function tryPlayMusic() {
  if (state.musicPaused) return
  const promise = musicAudio.play()
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      if (state.musicPaused) return
      state.musicNeedsGesture = true
      updateMusicUi()
    })
  }
}

function retryMusicFromGesture(event) {
  if (!state.musicNeedsGesture || state.musicPaused) return
  const target = event.target
  if (target instanceof Element && target.closest('#music-dock')) return
  if (!state.music[state.currentRoom]) return
  tryPlayMusic()
}

function syncMusic() {
  const track = state.music[state.currentRoom]
  if (!track || state.musicPaused) return
  const offset = (track.serverTime || Date.now()) - (track._receivedAt || Date.now())
  const elapsed = Math.max(0, (Date.now() + offset - track.startedAt) / 1000)
  if (musicAudio.readyState >= 1) {
    const duration = Number.isFinite(musicAudio.duration) && musicAudio.duration > 0 ? musicAudio.duration : null
    const target = duration ? elapsed % duration : elapsed
    if (Math.abs(musicAudio.currentTime - target) > 2.5) {
      try {
        musicAudio.currentTime = target
      } catch {
        // Some streams do not allow seeking.
      }
    }
  }
  tryPlayMusic()
}

function renderMusic() {
  const track = state.music[state.currentRoom]
  if (!track) {
    musicDock.hidden = true
    musicAudio.pause()
    musicAudio.removeAttribute('src')
    musicAudio.load()
    state.musicKey = null
    state.musicNeedsGesture = false
    return
  }
  musicDock.hidden = false
  musicTitle.textContent = track.title || 'Música ao vivo'
  musicTitle.title = track.title || ''
  const roomLabel = state.rooms.find(room => room.id === track.room)?.label || track.room
  musicBy.textContent = `por ${track.by?.name || 'alguém'} · ${roomLabel}`
  musicLink.href = track.url
  const key = musicTrackKey(track)
  if (key !== state.musicKey) {
    state.musicKey = key
    state.musicPaused = false
    state.musicNeedsGesture = false
    musicAudio.loop = true
    musicAudio.src = track.url
    musicAudio.load()
  }
  updateMusicUi()
  syncMusic()
}

function handleMusicEvent(data) {
  if (!data || !data.room) return
  if (data.room === state.currentRoom && state.music[data.room] && !data.track) {
    state.musicKey = null
  }
  state.music[data.room] = data.track ? { ...data.track, _receivedAt: Date.now() } : null
  if (data.room === state.currentRoom) renderMusic()
}

function toggleMusic() {
  const track = state.music[state.currentRoom]
  if (!track) return
  if (musicAudio.paused || musicAudio.ended || state.musicPaused) {
    state.musicPaused = false
    state.musicNeedsGesture = false
    syncMusic()
  } else {
    state.musicPaused = true
    musicAudio.pause()
  }
  updateMusicUi()
  focusComposer()
}

async function stopCurrentMusic() {
  const track = state.music[state.currentRoom]
  if (!track) return
  try {
    const data = await api('/api/music', { method: 'POST', body: { action: 'stop', room: state.currentRoom } })
    toast(data.message || 'Música parada.', 'info')
  } catch (error) {
    toast(error.message, 'danger')
  }
}

function renderTyping() {
  const bar = $('typing-bar')
  const now = Date.now()
  const names = []
  for (const [id, entry] of state.typing) {
    if (now - entry.at > 3600) {
      state.typing.delete(id)
      continue
    }
    if (entry.room === state.currentRoom) names.push(entry.name)
  }
  bar.replaceChildren()
  if (!names.length) {
    bar.classList.remove('is-active')
    return
  }
  bar.classList.add('is-active')
  const dots = element('span', 'typing-dots')
  dots.append(element('i'), element('i'), element('i'))
  bar.append(dots)
  bar.append(document.createTextNode(
    names.length === 1
      ? `${names[0]} está digitando...`
      : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` e mais ${names.length - 2}` : ''} estão digitando...`
  ))
}

async function sendMessage() {
  if (state.sending || state.uploading || isMuted() || !state.me) return
  const text = messageInput.value.trim()
  const pending = state.pending?.attachment ? state.pending : null
  if (!text && !pending) return

  if (text.startsWith('/') && !pending) {
    if (/^\/(play|music|musica|música|stop|parar)(\s|$)/i.test(text)) {
      messageInput.value = ''
      updateComposer()
      autoResize()
      await runMusicCommand(text)
      return
    }
    if (!state.admin.isAdmin) {
      toast('Comandos administrativos exigem login no painel.', 'warn')
      return
    }
    messageInput.value = ''
    updateComposer()
    autoResize()
    await runAdminCommand(text)
    return
  }

  if (Array.from(text).length > 1000) {
    toast('Sua mensagem passou de 1000 caracteres.', 'warn')
    return
  }

  state.sending = true
  updateComposer()
  try {
    const body = { text, room: state.currentRoom }
    if (pending) body.attachmentId = pending.attachment.id
    const audio = pending?.attachment?.type === 'audio' ? pending.attachment : null
    const data = await api('/api/messages', { method: 'POST', body })
    messageInput.value = ''
    autoResize()
    clearPending()
    updateComposer()
    if (data?.message) {
      handleIncoming(data.message)
      if (audio) startAudioForRoom(audio, data.message.room || body.room)
    }
  } catch (error) {
    if (['banned', 'kicked'].includes(error.data?.error)) return showBlocked(error.data)
    if (error.data?.error === 'muted') {
      state.me.muted = true
      state.me.mutedUntil = error.data.until
      state.me.mutedReason = error.data.reason
      updateComposer()
    }
    toast(error.message, 'danger')
  } finally {
    state.sending = false
    updateComposer()
  }
}

async function runMusicCommand(text) {
  const match = text.match(/^\/(\S+)\s*([\s\S]*)$/)
  if (!match) return
  const command = match[1].toLowerCase()
  const rest = match[2].trim()
  const action = ['stop', 'parar'].includes(command) ? 'stop' : 'play'
  if (action === 'play' && !rest) {
    toast('Uso: /play <link direto de áudio> [| título]', 'warn')
    return
  }
  const [rawUrl, ...titleParts] = action === 'play' ? rest.split('|') : ['']
  try {
    const data = await api('/api/music', {
      method: 'POST',
      body: { action, room: state.currentRoom, url: rawUrl.trim(), title: titleParts.join('|').trim() }
    })
    toast(data.message || (action === 'stop' ? 'Música parada.' : 'Música iniciada.'), action === 'stop' ? 'info' : 'success')
  } catch (error) {
    if (['banned', 'kicked'].includes(error.data?.error)) return showBlocked(error.data)
    if (error.data?.error === 'muted') {
      state.me.muted = true
      state.me.mutedUntil = error.data.until
      state.me.mutedReason = error.data.reason
      updateComposer()
    }
    toast(error.message, 'danger')
  }
}

function focusComposer() {
  if (!messageInput || messageInput.disabled || state.blocked) return
  try {
    messageInput.focus({ preventScroll: true })
  } catch {
    messageInput.focus()
  }
}

function isTextEntry(element) {
  if (!element) return false
  if (element.isContentEditable) return true
  if (element.matches('textarea, select')) return true
  if (element.matches('input')) {
    const type = (element.getAttribute('type') || 'text').toLowerCase()
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color'].includes(type)
  }
  return false
}

function typeIntoComposer(text) {
  if (!text) return
  const start = messageInput.selectionStart ?? messageInput.value.length
  const end = messageInput.selectionEnd ?? start
  messageInput.setRangeText(text, start, end, 'end')
  focusComposer()
  autoResize()
  updateComposer()
  typed()
}

function autoResize() {
  messageInput.style.height = 'auto'
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 150)}px`
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

function inferMime(file, kind) {
  if (file.type) return file.type.toLowerCase()
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mp4: kind === 'audio' ? 'audio/mp4' : 'video/mp4',
    webm: kind === 'audio' ? 'audio/webm' : 'video/webm',
    ogg: kind === 'audio' ? 'audio/ogg' : 'video/ogg',
    ogv: 'video/ogg', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', oga: 'audio/ogg'
  }
  return map[ext] || ''
}

function renderUploadPreview(status, progress) {
  if (!state.pending) {
    uploadPreview.hidden = true
    return
  }
  uploadPreview.hidden = false
  uploadName.textContent = state.pending.name
  uploadStatus.textContent = status
  uploadProgress.style.width = `${Math.max(0, Math.min(100, progress))}%`
  uploadThumb.replaceChildren()
  if (state.pending.kind === 'image' && state.pending.previewUrl) {
    const image = element('img')
    image.src = state.pending.previewUrl
    image.alt = ''
    uploadThumb.append(image)
  } else {
    uploadThumb.append(icon(state.pending.kind === 'video' ? 'i-video' : 'i-audio'))
  }
}

function clearPending() {
  if (state.uploadXhr) {
    state.uploadXhr.abort()
    state.uploadXhr = null
  }
  if (state.pending?.previewUrl) URL.revokeObjectURL(state.pending.previewUrl)
  state.pending = null
  state.uploading = false
  uploadPreview.hidden = true
  uploadProgress.style.width = '0%'
  updateComposer()
}

function failUpload(message) {
  state.uploading = false
  state.uploadXhr = null
  if (state.pending) renderUploadPreview(message || 'Falha no envio', 0)
  updateComposer()
}

function startUpload(file, kind) {
  if (!file) return
  if (!state.me || isMuted()) {
    toast('Você não pode enviar mídia agora.', 'warn')
    return
  }
  const mime = inferMime(file, kind)
  if (!UPLOAD_TYPES[kind]?.includes(mime)) {
    toast(kind === 'image' ? 'Formato de imagem não suportado.' : kind === 'video' ? 'Formato de vídeo não suportado.' : 'Formato de áudio não suportado.', 'danger')
    return
  }
  if (file.size > UPLOAD_LIMITS[kind]) {
    toast(`O limite para ${kind === 'image' ? 'imagens' : kind === 'video' ? 'vídeos' : 'áudios'} é ${formatBytes(UPLOAD_LIMITS[kind])}.`, 'danger')
    return
  }
  if (state.uploading) {
    toast('Aguarde o envio atual terminar.', 'warn')
    return
  }
  clearPending()
  const previewUrl = kind === 'image' ? URL.createObjectURL(file) : ''
  state.pending = { name: file.name || 'arquivo', kind, previewUrl, attachment: null, size: file.size }
  renderUploadPreview(`Enviando... ${formatBytes(file.size)}`, 0)
  state.uploading = true
  updateComposer()

  const xhr = new XMLHttpRequest()
  state.uploadXhr = xhr
  xhr.open('POST', '/api/upload')
  xhr.setRequestHeader('x-requested-with', 'chatbox')
  xhr.setRequestHeader('content-type', mime)
  xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'arquivo'))
  xhr.upload.addEventListener('progress', event => {
    if (!event.lengthComputable || !state.pending) return
    const percent = Math.min(99, Math.round((event.loaded / event.total) * 100))
    renderUploadPreview(`Enviando... ${formatBytes(event.loaded)} de ${formatBytes(event.total)}`, percent)
  })
  xhr.addEventListener('load', () => {
    state.uploading = false
    state.uploadXhr = null
    let data = null
    try {
      data = JSON.parse(xhr.responseText)
    } catch {
      data = null
    }
    if (xhr.status >= 200 && xhr.status < 300 && data?.attachment) {
      state.pending.attachment = data.attachment
      renderUploadPreview(`Pronto para enviar · ${formatBytes(data.attachment.size)}`, 100)
      updateComposer()
    } else {
      failUpload(data?.message || 'Falha ao enviar o arquivo.')
      toast(data?.message || 'Falha ao enviar o arquivo.', 'danger')
    }
  })
  xhr.addEventListener('error', () => {
    failUpload('Falha de conexão.')
    toast('Falha de conexão ao enviar o arquivo.', 'danger')
  })
  xhr.addEventListener('abort', () => {
    state.uploading = false
    state.uploadXhr = null
  })
  xhr.send(file)
}

function setAvatarFeedback(message = '', error = false) {
  const status = $('avatar-status')
  const box = $('avatar-error')
  if (box) {
    box.textContent = error ? message : ''
    box.hidden = !error
  }
  if (status && !error) status.textContent = message || 'PNG, JPG, GIF, WebP ou AVIF · recorte e otimização automáticos'
}

async function prepareAvatarImage(file) {
  if (!('createImageBitmap' in window)) return file
  let bitmap = null
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      return file
    }
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    if (!side) return file
    const size = Math.max(1, Math.min(512, side))
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9))
    if (!blob || blob.type !== 'image/webp') return file
    return new File([blob], 'avatar.webp', { type: 'image/webp' })
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

function uploadAvatar(file) {
  if (!file || avatarUploading) return
  setAvatarFeedback('')
  const sourceMime = inferMime(file, 'image')
  if (!UPLOAD_TYPES.image.includes(sourceMime)) {
    setAvatarFeedback('Escolha uma imagem PNG, JPG, GIF, WebP ou AVIF.', true)
    return
  }
  if (file.size > AVATAR_SOURCE_LIMIT) {
    setAvatarFeedback('A foto pode ter no máximo 20 MB antes do ajuste.', true)
    return
  }

  const pick = $('avatar-pick')
  const input = $('avatar-file')
  avatarUploading = true
  if (pick) pick.disabled = true
  setAvatarFeedback('Preparando foto...')

  ;(async () => {
    const prepared = await prepareAvatarImage(file)
    if (!prepared || prepared.size > UPLOAD_LIMITS.image) {
      throw new Error('Não foi possível ajustar essa foto. Tente outra imagem.')
    }
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/profile/avatar')
      xhr.setRequestHeader('x-requested-with', 'chatbox')
      xhr.setRequestHeader('content-type', prepared.type || 'image/jpeg')
      xhr.setRequestHeader('x-file-name', encodeURIComponent(prepared.name || 'avatar.webp'))
      xhr.upload.addEventListener('progress', event => {
        if (!event.lengthComputable) return
        const percent = Math.min(99, Math.round((event.loaded / event.total) * 100))
        setAvatarFeedback(`Enviando foto... ${percent}%`)
      })
      xhr.addEventListener('load', () => {
        let data = null
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          data = null
        }
        if (xhr.status >= 200 && xhr.status < 300 && data?.you) resolve(data)
        else reject(new Error(data?.message || 'Não foi possível trocar a foto.'))
      })
      xhr.addEventListener('error', () => reject(new Error('Falha de conexão ao enviar a foto.')))
      xhr.addEventListener('abort', () => reject(new Error('Envio da foto cancelado.')))
      xhr.send(prepared)
    }).then(data => {
      applyAvatarUpdate(data.you)
      renderUsers()
      setAvatarFeedback('Foto atualizada.')
      toast('Foto de perfil atualizada.', 'success')
    }).catch(error => {
      setAvatarFeedback(error.message || 'Não foi possível trocar a foto.', true)
    }).finally(() => {
      avatarUploading = false
      if (pick) pick.disabled = false
      if (input) input.value = ''
    })
  })().catch(error => {
    setAvatarFeedback(error.message || 'Não foi possível trocar a foto.', true)
    avatarUploading = false
    if (pick) pick.disabled = false
    if (input) input.value = ''
  })
}

function typed() {
  const now = Date.now()
  if (now - state.lastTypingSent < 1600 || isMuted()) return
  state.lastTypingSent = now
  api('/api/typing', { method: 'POST', body: { room: state.currentRoom } }).catch(() => {})
}

async function toggleReaction(messageId, symbol) {
  const message = state.messages.find(item => item.id === messageId)
  if (!message) return
  const mine = reactionSet(messageId)
  const had = mine.has(symbol)
  if (had) mine.delete(symbol)
  else mine.add(symbol)
  const reactions = { ...(message.reactions || {}) }
  reactions[symbol] = Math.max(0, (reactions[symbol] || 0) + (had ? -1 : 1))
  if (!reactions[symbol]) delete reactions[symbol]
  message.reactions = reactions
  renderMessages()
  try {
    const data = await api('/api/reactions', { method: 'POST', body: { messageId, symbol } })
    const fresh = data.message
    const index = state.messages.findIndex(item => item.id === messageId)
    if (index >= 0 && fresh) {
      state.messages[index] = { ...state.messages[index], reactions: fresh.reactions, mine: fresh.mine }
      state.myReactions.set(messageId, new Set(fresh.mine || []))
    }
    renderMessages()
  } catch (error) {
    if (had) mine.add(symbol)
    else mine.delete(symbol)
    message.reactions = { ...(message.reactions || {}) }
    message.reactions[symbol] = Math.max(0, (message.reactions[symbol] || 0) + (had ? 1 : -1))
    if (!message.reactions[symbol]) delete message.reactions[symbol]
    renderMessages()
    toast(error.message, 'danger')
  }
}

async function removeMessage(messageId) {
  if (!state.admin.isAdmin) return
  if (!window.confirm('Remover esta mensagem para todos?')) return
  try {
    const data = await api('/api/admin/action', { method: 'POST', body: { action: 'delete', messageId } })
    toast(data.message, 'success')
  } catch (error) {
    toast(error.message, 'danger')
  }
}

function showModal(name) {
  const modal = $(`${name}-modal`)
  if (!modal) return
  modal.hidden = false
  const input = modal.querySelector('input')
  if (input) {
    input.focus()
    input.select?.()
  }
}

function hideModal(name) {
  const modal = $(`${name}-modal`)
  if (modal) modal.hidden = true
}

function openMobileSidebar() {
  $('sidebar').classList.add('is-open')
  $('sidebar-scrim').hidden = false
}

function closeMobileSidebar() {
  $('sidebar').classList.remove('is-open')
  $('sidebar-scrim').hidden = true
}

function openAdmin() {
  if (state.blocked) return
  const drawer = $('admin-drawer')
  const scrim = $('drawer-scrim')
  drawer.hidden = false
  scrim.hidden = false
  requestAnimationFrame(() => drawer.classList.add('is-open'))
  if (state.admin.isAdmin) {
    $('admin-login').hidden = true
    $('admin-panel').hidden = false
    loadOverview()
  } else {
    $('admin-login').hidden = false
    $('admin-panel').hidden = true
    setTimeout(() => $('admin-password').focus(), 220)
  }
  renderAdminHint()
}

function closeAdmin() {
  const drawer = $('admin-drawer')
  drawer.classList.remove('is-open')
  $('drawer-scrim').hidden = true
  setTimeout(() => {
    if (!drawer.classList.contains('is-open')) drawer.hidden = true
  }, 300)
}

function renderAdminHint() {
  const hint = $('admin-password-hint')
  hint.replaceChildren()
  hint.hidden = state.admin.passwordIsDefault
  if (!state.admin.passwordIsDefault) {
    hint.textContent = 'Use a senha definida na variável de ambiente ADMIN_PASSWORD.'
  }
}

function switchAdminTab(tab) {
  state.adminTab = tab
  for (const button of document.querySelectorAll('.admin-tab')) {
    button.classList.toggle('is-active', button.dataset.tab === tab)
  }
  for (const panel of document.querySelectorAll('.admin-section')) {
    panel.hidden = panel.dataset.panel !== tab
  }
  if (tab === 'console') setTimeout(() => $('console-input').focus(), 50)
}

function updateAdminUi() {
  $('admin-open').title = state.admin.isAdmin ? 'Abrir painel administrativo' : 'Entrar na administração'
  if (!state.admin.isAdmin) {
    $('admin-panel').hidden = true
    $('admin-login').hidden = false
    state.overview = null
  }
  renderAdminHint()
  renderUsers()
}

async function loadOverview() {
  if (!state.admin.isAdmin) return
  try {
    const data = await api('/api/admin/overview')
    state.overview = data
    state.slowmode = data.slowmode || state.slowmode
    fillTargets()
    renderSanctions()
    renderAudit()
    renderAdminStats()
    fillRoomControls()
    renderRoomList()
  } catch (error) {
    if (error.status === 403) {
      state.admin.isAdmin = false
      updateAdminUi()
      toast('Sessão administrativa expirada. Entre novamente.', 'warn')
    } else {
      toast(error.message, 'danger')
    }
  }
}

function fillTargets() {
  const list = $('target-names')
  list.replaceChildren()
  for (const user of state.users) {
    const option = document.createElement('option')
    option.value = user.name
    option.label = `#${user.id}${user.isAdmin ? ' · admin' : ''}`
    list.append(option)
  }
}

function renderSanctions() {
  const data = state.overview
  if (!data) return
  $('ban-count').textContent = String(data.bans.length)
  $('mute-count').textContent = String(data.mutes.length)

  const bans = $('bans-list')
  bans.replaceChildren()
  if (!data.bans.length) {
    bans.append(element('li', 'empty-list', 'Nenhum banimento ativo.'))
  } else {
    for (const ban of data.bans) {
      const item = element('li', 'sanction-item')
      const copy = element('div', 'sanction-copy')
      copy.append(element('strong', '', ban.name))
      copy.append(element('p', '', `${ban.until ? `expira ${untilLabel(ban.until)}` : 'permanente'}${ban.reason ? ` · ${ban.reason}` : ''}${ban.by ? ` · por ${ban.by}` : ''}`))
      item.append(copy)
      const button = element('button', 'btn btn-soft', 'Remover')
      button.type = 'button'
      button.dataset.revoke = 'unban'
      button.dataset.id = ban.id
      item.append(button)
      bans.append(item)
    }
  }

  const mutes = $('mutes-list')
  mutes.replaceChildren()
  if (!data.mutes.length) {
    mutes.append(element('li', 'empty-list', 'Nenhum silenciamento ativo.'))
  } else {
    for (const mute of data.mutes) {
      const item = element('li', 'sanction-item')
      const copy = element('div', 'sanction-copy')
      copy.append(element('strong', '', mute.name))
      copy.append(element('p', '', `${mute.until ? `expira ${untilLabel(mute.until)}` : 'permanente'}${mute.reason ? ` · ${mute.reason}` : ''}${mute.by ? ` · por ${mute.by}` : ''}`))
      item.append(copy)
      const button = element('button', 'btn btn-soft', 'Remover')
      button.type = 'button'
      button.dataset.revoke = 'unmute'
      button.dataset.id = mute.id
      item.append(button)
      mutes.append(item)
    }
  }
}

function renderAudit() {
  const list = $('audit-list')
  list.replaceChildren()
  const entries = state.overview?.audit || []
  if (!entries.length) {
    list.append(element('li', 'empty-list', 'Nenhuma ação registrada.'))
    return
  }
  for (const entry of entries) {
    const item = element('li', 'audit-item')
    const copy = element('div', 'audit-copy')
    const line = element('p')
    line.append(element('span', 'audit-action', entry.action))
    line.append(document.createTextNode(` ${entry.actor}${entry.target ? ` → ${entry.target}` : ''}${entry.detail ? ` · ${entry.detail}` : ''}`))
    copy.append(line)
    item.append(copy)
    item.append(element('span', 'audit-time', timeOf(entry.ts)))
    list.append(item)
  }
}

function renderAdminStats() {
  const data = state.overview
  if (!data) return
  const stats = data.stats
  $('admin-stats').textContent = `${stats.online} online · ${stats.messages} mensagens · ${stats.bans} bans · ${stats.mutes} mutes`
}

function fillRoomControls() {
  const select = $('room-manage-select')
  const previous = select.value
  select.replaceChildren()
  for (const room of state.rooms) {
    const option = document.createElement('option')
    option.value = room.id
    option.textContent = room.label
    select.append(option)
  }
  if (state.rooms.some(room => room.id === previous)) select.value = previous
  updateSlowmodeInput()
}

function updateSlowmodeInput() {
  const room = $('room-manage-select').value
  $('slowmode-input').value = String(state.slowmode[room] || 0)
}

async function runAdminAction(body, successMessage) {
  try {
    const data = await api('/api/admin/action', { method: 'POST', body })
    if (successMessage) toast(successMessage, 'success')
    if (data.overview) {
      state.overview = data.overview
      state.slowmode = data.overview.slowmode || state.slowmode
      renderSanctions()
      renderAudit()
      renderAdminStats()
      renderRoomList()
    } else {
      loadOverview()
    }
    return data
  } catch (error) {
    if (error.status === 403) {
      state.admin.isAdmin = false
      updateAdminUi()
      toast('Sessão administrativa expirada.', 'warn')
    } else {
      toast(error.message, 'danger')
    }
    return null
  }
}

async function executeAction(action) {
  const target = $('target-input').value.trim()
  if (!target) {
    toast('Selecione ou digite o alvo.', 'warn')
    $('target-input').focus()
    return
  }
  const minutes = Number($('duration-select').value)
  const reason = $('reason-input').value.trim()
  if ((action === 'ban' || action === 'kick') && !window.confirm(`${action === 'ban' ? 'Banir' : 'Expulsar'} ${target}?`)) return
  const buttons = document.querySelectorAll('[data-action]')
  for (const button of buttons) button.disabled = true
  const result = await runAdminAction({ action, target, minutes, reason })
  for (const button of buttons) button.disabled = false
  if (result) {
    $('reason-input').value = ''
    $('target-input').value = ''
  }
}

async function runAdminCommand(command) {
  const value = command.startsWith('/') ? command : `/${command}`
  appendConsole(`> ${value}`, 'console-input')
  try {
    const data = await api('/api/admin/command', { method: 'POST', body: { command: value } })
    for (const line of data.lines || []) appendConsole(line)
    if (data.overview) {
      state.overview = data.overview
      state.slowmode = data.overview.slowmode || state.slowmode
      renderSanctions()
      renderAudit()
      renderAdminStats()
      renderRoomList()
    }
  } catch (error) {
    if (error.status === 403) {
      state.admin.isAdmin = false
      updateAdminUi()
    }
    appendConsole(error.message, 'console-error')
    toast(error.message, 'danger')
  }
}

function appendConsole(line, className = '') {
  const log = $('console-log')
  const paragraph = element('p', `console-line ${className}`.trim(), line)
  log.append(paragraph)
  log.scrollTop = log.scrollHeight
}

function showBlocked(data) {
  if (state.blocked) return
  state.blocked = true
  clearReconnect()
  if (state.source) {
    state.source.close()
    state.source = null
  }
  musicAudio.pause()
  musicDock.hidden = true
  hideModal('rename')
  closeAdmin()
  closeMobileSidebar()
  const screen = $('blocked-screen')
  screen.hidden = false
  const banned = data.error === 'banned'
  $('blocked-title').textContent = banned ? 'Você foi banido' : 'Você foi expulso'
  $('blocked-message').textContent = data.message || (banned ? 'Seu acesso foi bloqueado.' : 'Aguarde para voltar ao chat.')
  const detail = $('blocked-detail')
  detail.replaceChildren()
  if (data.reason) detail.append(document.createTextNode(`Motivo: ${data.reason}. `))
  if (banned) {
    detail.append(document.createTextNode(data.until ? `Banimento ${untilLabel(data.until)}.` : 'Banimento permanente.'))
    const retry = $('blocked-retry')
    retry.textContent = 'Tentar novamente'
    retry.onclick = () => window.location.reload()
  } else {
    const retry = $('blocked-retry')
    let remaining = Number(data.retryAfter) || Math.max(1, Math.ceil(((data.until || 0) - Date.now()) / 1000))
    const update = () => {
      if (remaining <= 0) {
        retry.disabled = false
        retry.textContent = 'Voltar ao chat'
        detail.textContent = 'Você já pode voltar ao chat.'
        return
      }
      retry.disabled = true
      retry.textContent = `Aguarde ${remaining}s`
      detail.textContent = `Você poderá voltar em ${remaining} segundo${remaining === 1 ? '' : 's'}.`
      remaining -= 1
      setTimeout(update, 1000)
    }
    update()
    retry.onclick = () => window.location.reload()
  }
}

function updateMutedCountdown() {
  if (state.me?.muted && state.me.mutedUntil && state.me.mutedUntil <= Date.now()) {
    state.me.muted = false
    state.me.mutedUntil = 0
    updateComposer()
    renderUsers()
  }
  if (state.me?.muted) updateComposer()
}

function bindEvents() {
  for (const button of document.querySelectorAll('[data-close-modal]')) {
    button.addEventListener('click', () => hideModal(button.dataset.closeModal))
  }

  $('rename-open').addEventListener('click', () => {
    $('rename-input').value = state.me?.name || ''
    $('rename-error').hidden = true
    $('avatar-error').hidden = true
    applyAvatar($('profile-avatar-preview'), state.me)
    setAvatarFeedback('')
    showModal('rename')
  })

  $('avatar-pick').addEventListener('click', () => {
    $('avatar-file').click()
  })

  $('avatar-file').addEventListener('change', event => {
    const file = event.target.files?.[0]
    if (file) uploadAvatar(file)
  })

  $('rename-form').addEventListener('submit', async event => {
    event.preventDefault()
    const input = $('rename-input')
    const errorBox = $('rename-error')
    errorBox.hidden = true
    try {
      const data = await api('/api/profile', { method: 'POST', body: { name: input.value } })
      applyMe(data.you)
      renderUsers()
      hideModal('rename')
      toast('Apelido atualizado.', 'success')
    } catch (error) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    }
  })

  messageInput.addEventListener('input', () => {
    autoResize()
    updateComposer()
    typed()
  })

  messageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  })

  $('composer').addEventListener('submit', event => {
    event.preventDefault()
    sendMessage()
  })

  $('jump-latest').addEventListener('click', () => {
    state.unseen = 0
    updateJumpButton()
    scrollToBottom('smooth')
  })

  messageScroll.addEventListener('scroll', () => {
    if (isNearBottom() && state.unseen) {
      state.unseen = 0
      updateJumpButton()
    }
  })

  $('room-list').addEventListener('click', event => {
    const button = event.target.closest('[data-room]')
    if (button) selectRoom(button.dataset.room)
  })

  $('user-list').addEventListener('click', event => {
    const item = event.target.closest('[data-target]')
    if (!item) return
    $('target-input').value = item.dataset.target
    openAdmin()
    if (state.admin.isAdmin) switchAdminTab('actions')
  })

  $('user-list').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    const item = event.target.closest('[data-target]')
    if (!item) return
    $('target-input').value = item.dataset.target
    openAdmin()
  })

  messageList.addEventListener('click', event => {
    const playMusic = event.target.closest('[data-play-music]')
    if (playMusic) {
      playAttachmentTrack(playMusic)
      return
    }
    const react = event.target.closest('[data-react]')
    if (react) {
      toggleReaction(react.dataset.messageId, react.dataset.react)
      return
    }
    const remove = event.target.closest('[data-delete]')
    if (remove) removeMessage(remove.dataset.delete)
  })

  for (const button of document.querySelectorAll('[data-upload]')) {
    button.addEventListener('click', () => {
      if (isMuted() || state.uploading) return
      $(`file-${button.dataset.upload}`)?.click()
    })
  }

  for (const kind of ['image', 'video', 'audio']) {
    const input = $(`file-${kind}`)
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.value = ''
      if (file) startUpload(file, kind)
    })
  }

  uploadCancel.addEventListener('click', clearPending)

  $('music-command').addEventListener('click', () => {
    if (!messageInput.value.startsWith('/play')) {
      messageInput.value = '/play '
      updateComposer()
      autoResize()
    }
    focusComposer()
    messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length)
  })

  const savedVolume = (() => {
    try {
      const value = Number(localStorage.getItem(VOLUME_KEY))
      return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.7
    } catch {
      return 0.7
    }
  })()
  musicAudio.volume = savedVolume
  $('music-volume').value = String(Math.round(savedVolume * 100))
  $('music-volume').addEventListener('input', event => {
    const volume = Math.max(0, Math.min(1, Number(event.target.value) / 100))
    musicAudio.volume = volume
    try {
      localStorage.setItem(VOLUME_KEY, String(volume))
    } catch {
      // Storage can be unavailable.
    }
  })

  document.addEventListener('pointerdown', retryMusicFromGesture, { capture: true, passive: true })
  document.addEventListener('click', retryMusicFromGesture, true)
  document.addEventListener('keydown', retryMusicFromGesture, true)
  musicToggle.addEventListener('click', toggleMusic)
  musicStop.addEventListener('click', stopCurrentMusic)
  musicAudio.addEventListener('play', () => {
    state.musicNeedsGesture = false
    updateMusicUi()
  })
  musicAudio.addEventListener('pause', updateMusicUi)
  musicAudio.addEventListener('timeupdate', updateMusicClock)
  musicAudio.addEventListener('canplay', syncMusic)
  musicAudio.addEventListener('error', () => {
    if (!musicAudio.getAttribute('src')) return
    if (musicAudio.dataset.errorFor === state.musicKey) return
    musicAudio.dataset.errorFor = state.musicKey || ''
    toast('Não foi possível tocar este áudio. Use um link direto (mp3, ogg, wav, m4a).', 'danger')
  })

  messageInput.addEventListener('paste', event => {
    const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'))
    if (!file) return
    event.preventDefault()
    startUpload(file, 'image')
  })

  $('sidebar-open').addEventListener('click', openMobileSidebar)
  $('sidebar-close').addEventListener('click', closeMobileSidebar)
  $('sidebar-scrim').addEventListener('click', closeMobileSidebar)

  $('admin-open').addEventListener('click', openAdmin)
  $('admin-open-top').addEventListener('click', openAdmin)
  $('admin-close').addEventListener('click', closeAdmin)
  $('drawer-scrim').addEventListener('click', closeAdmin)
  $('admin-hint-open').addEventListener('click', () => {
    openAdmin()
    if (state.admin.isAdmin) switchAdminTab('console')
  })

  $('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault()
    const errorBox = $('admin-login-error')
    errorBox.hidden = true
    const button = event.submitter
    if (button) button.disabled = true
    try {
      const data = await api('/api/admin/login', { method: 'POST', body: { password: $('admin-password').value } })
      state.admin.isAdmin = true
      state.admin.passwordIsDefault = Boolean(data.passwordIsDefault)
      applyMe(data.you)
      $('admin-password').value = ''
      $('admin-login').hidden = true
      $('admin-panel').hidden = false
      updateAdminUi()
      if (data.overview) {
        state.overview = data.overview
        state.slowmode = data.overview.slowmode || state.slowmode
        fillTargets()
        renderSanctions()
        renderAudit()
        renderAdminStats()
        fillRoomControls()
      }
      renderRoomList()
      switchAdminTab('actions')
      toast('Modo administrador ativado.', 'admin')
    } catch (error) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    } finally {
      if (button) button.disabled = false
    }
  })

  $('admin-logout').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' })
    } catch {
      // Session may already be gone.
    }
    state.admin.isAdmin = false
    state.overview = null
    updateAdminUi()
    toast('Modo administrador encerrado.', 'info')
  })

  for (const button of document.querySelectorAll('.admin-tab')) {
    button.addEventListener('click', () => switchAdminTab(button.dataset.tab))
  }

  for (const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('click', () => executeAction(button.dataset.action))
  }

  $('announce-form').addEventListener('submit', async event => {
    event.preventDefault()
    const input = $('announce-input')
    const text = input.value.trim()
    if (!text) return
    const result = await runAdminAction({ action: 'announce', target: text })
    if (result) input.value = ''
  })

  $('room-manage-select').addEventListener('change', updateSlowmodeInput)

  $('apply-slowmode').addEventListener('click', async () => {
    const room = $('room-manage-select').value
    const seconds = Number($('slowmode-input').value) || 0
    await runAdminAction({ action: 'slowmode', room, seconds })
  })

  $('clear-room').addEventListener('click', async () => {
    const room = $('room-manage-select').value
    const label = state.rooms.find(item => item.id === room)?.label || room
    if (!window.confirm(`Limpar todas as mensagens de ${label}?`)) return
    await runAdminAction({ action: 'clear', room })
  })

  $('bans-list').addEventListener('click', event => {
    const button = event.target.closest('[data-revoke]')
    if (!button) return
    runAdminAction({ action: button.dataset.revoke, id: button.dataset.id })
  })

  $('mutes-list').addEventListener('click', event => {
    const button = event.target.closest('[data-revoke]')
    if (!button) return
    runAdminAction({ action: button.dataset.revoke, id: button.dataset.id })
  })

  $('console-form').addEventListener('submit', async event => {
    event.preventDefault()
    const input = $('console-input')
    const value = input.value.trim()
    if (!value) return
    input.value = ''
    await runAdminCommand(value)
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hideModal('rename')
      closeAdmin()
      closeMobileSidebar()
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      focusComposer()
      return
    }
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
    if (event.key.length !== 1 || event.key === ' ') return
    if (!messageInput || messageInput.disabled || state.blocked) return
    if ($('admin-drawer') && !$('admin-drawer').hidden) return
    if ($('rename-modal') && !$('rename-modal').hidden) return
    if (isTextEntry(document.activeElement)) return
    event.preventDefault()
    typeIntoComposer(event.key)
  })
}

async function boot() {
  bindEvents()
  autoResize()
  setInterval(renderTyping, 900)
  setInterval(updateMutedCountdown, 15000)
  setInterval(() => {
    if (!musicDock.hidden) syncMusic()
  }, 20000)

  try {
    const data = await api('/api/me')
    state.rooms = data.rooms || []
    state.slowmode = data.slowmode || {}
    state.admin.passwordIsDefault = Boolean(data.passwordIsDefault)
    state.admin.isAdmin = Boolean(data.isAdmin)
    applyMe(data.you)
    state.music = {}
    for (const [room, track] of Object.entries(data.music || {})) {
      state.music[room] = track ? { ...track, _receivedAt: Date.now() } : null
    }
    state.users = data.you ? [data.you] : []
    state.messages = (data.notices || []).slice()
    renderAdminHint()
    renderRoomList()
    renderUsers()
    selectRoom(state.currentRoom)
    connect()
    if (location.pathname.startsWith('/admin')) setTimeout(openAdmin, 350)
  } catch (error) {
    if (['banned', 'kicked'].includes(error.data?.error)) showBlocked(error.data)
    else {
      toast(error.message || 'Não foi possível carregar o chat.', 'danger')
      setConnection(false)
    }
  }
}

window.addEventListener('beforeunload', () => {
  if (state.source) state.source.close()
})

boot()
