const panelEl = document.getElementById('panel')

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str ?? ''
  return div.innerHTML
}

function render(state) {
  const participants = state?.participants || []

  // No active voice channel — leave the overlay window fully transparent
  // rather than designing an empty state (Phase 1 scope).
  if (!state?.channelName || participants.length === 0) {
    panelEl.classList.remove('visible')
    panelEl.innerHTML = ''
    return
  }

  const rows = participants.map((p) => {
    const dotClass = p.isSpeaking ? 'dot speaking' : 'dot'
    const status = p.isDeafened ? 'Deafened' : p.isMuted ? 'Muted' : ''
    return `
      <div class="participant">
        <span class="${dotClass}"></span>
        <span class="name">${escapeHtml(p.displayName)}</span>
        ${status ? `<span class="status">${status}</span>` : ''}
      </div>
    `
  }).join('')

  panelEl.innerHTML = `<div id="channel-name">${escapeHtml(state.channelName)}</div>${rows}`
  panelEl.classList.add('visible')
}

window.overlayAPI?.onVoiceState(render)
