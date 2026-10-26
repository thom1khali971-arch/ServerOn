function toast(message, level = 'info') {
  const stack = document.getElementById('toast-stack')
  if (!stack) return
  const node = document.createElement('div')
  node.className = `toast is-${level}`
  const dot = document.createElement('span')
  dot.className = 'toast-dot'
  const text = document.createElement('span')
  text.textContent = message
  node.append(dot, text)
  stack.append(node)
  setTimeout(() => {
    node.classList.add('is-leaving')
    setTimeout(() => node.remove(), 220)
  }, 3800)
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

async function loadInfo() {
  const urlInput = document.getElementById('download-url')
  try {
    const response = await fetch('/api/info', { headers: { 'x-requested-with': 'chatbox' } })
    if (!response.ok) throw new Error('info')
    const data = await response.json()
    urlInput.value = data.downloadUrl
    document.getElementById('download-btn').href = data.downloadUrl
    document.getElementById('stat-online').textContent = String(data.stats.online)
    document.getElementById('stat-messages').textContent = String(data.stats.messages)
    document.getElementById('stat-bans').textContent = String(data.stats.bans)
    document.getElementById('stat-rooms').textContent = String(data.stats.rooms)
    document.getElementById('password-warning').hidden = !data.passwordIsDefault
  } catch {
    urlInput.value = `${location.origin}/api/download`
    toast('Não foi possível carregar as estatísticas agora.', 'warn')
  }
}

document.getElementById('copy-link').addEventListener('click', async () => {
  const input = document.getElementById('download-url')
  const value = input.value
  if (!value || value === 'carregando...') return
  const copied = await copyText(value)
  if (copied) {
    toast('Link de download copiado.', 'success')
    return
  }
  input.focus()
  input.select()
  toast('Selecione o link e copie com Ctrl+C.', 'warn')
})

loadInfo()
setInterval(loadInfo, 30000)
