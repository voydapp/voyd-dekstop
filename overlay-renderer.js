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

// ── Camera tiles (Phase 4) ─────────────────────────────────────────────────
// Kept as a separate top-level container from #panel deliberately — #panel's
// innerHTML is fully replaced on every voice-state tick, which would tear
// down and rebuild every <img> (and re-decode every frame) up to 4x/sec if
// tiles lived inside it. Tile elements here are created once per userId and
// updated in place (img.src only) for the life of that camera track.
const cameraTilesEl = document.getElementById('camera-tiles')
const cameraTileEls = new Map() // userId -> { wrapper, img, label }

function renderCameraFrames(frames) {
  const list = Array.isArray(frames) ? frames : []
  const seen = new Set()

  list.forEach((f) => {
    if (!f || typeof f.userId !== 'string' || typeof f.dataUrl !== 'string') return
    if (!f.dataUrl.startsWith('data:image/')) return // defense in depth — only ever accept image data URLs
    seen.add(f.userId)

    let entry = cameraTileEls.get(f.userId)
    if (!entry) {
      const wrapper = document.createElement('div')
      wrapper.className = 'cam-tile'
      const img = document.createElement('img')
      img.className = 'cam-img'
      const label = document.createElement('div')
      label.className = 'cam-label'
      wrapper.appendChild(img)
      wrapper.appendChild(label)
      cameraTilesEl.appendChild(wrapper)
      entry = { wrapper, img, label }
      cameraTileEls.set(f.userId, entry)
    }
    entry.img.src = f.dataUrl
    entry.label.textContent = f.displayName || '' // textContent — no innerHTML, no escaping needed
  })

  // Remove tiles for users no longer present this tick — camera turned off,
  // participant left, or tiles were toggled off (an empty array clears everything).
  cameraTileEls.forEach((entry, userId) => {
    if (!seen.has(userId)) {
      entry.wrapper.remove()
      cameraTileEls.delete(userId)
    }
  })

  cameraTilesEl.classList.toggle('visible', cameraTileEls.size > 0)
}

window.overlayAPI?.onCameraFrames(renderCameraFrames)
