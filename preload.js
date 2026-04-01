const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  installUpdate: () => ipcRenderer.send('install-update'),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, status, data) => callback(status, data))
  },
  onKeybind: (callback) => {
    ipcRenderer.on('keybind', (_event, action) => callback(action))
  },
})

// Bridge update-status IPC events to CustomEvents so the web app (App.tsx) can listen
ipcRenderer.on('update-status', (_event, status, data) => {
  window.dispatchEvent(new CustomEvent('voyd-update', { detail: { status, ...data } }))
})

// Bridge voyd-check-update CustomEvent (from UserSettingsPanel) to IPC
window.addEventListener('voyd-check-update', () => {
  ipcRenderer.send('check-for-updates')
})

// Inject drag region and titlebar for frameless window
// Both are always injected; the titlebar (with buttons) is hidden on /app where
// CommunicationHeader provides its own controls, and shown on all other pages
// (login, signup, reset-password, etc.) which have no built-in window controls.
window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style')
  style.innerHTML = `
    #voyd-drag-region {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 40px;
      -webkit-app-region: no-drag;
      z-index: 99998;
      pointer-events: none;
      display: none;
    }
    #voyd-drag-region.voyd-app-mode {
      display: block;
      -webkit-app-region: drag;
    }
    #voyd-titlebar {
      position: fixed;
      top: 0;
      right: 0;
      left: auto;
      height: 40px;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      -webkit-app-region: no-drag;
      z-index: 999999;
      padding: 0;
      margin: 0;
    }
    #voyd-titlebar.voyd-app-mode {
      left: 0;
    }
    #voyd-titlebar button {
      -webkit-app-region: no-drag;
      pointer-events: all;
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.5);
      width: 40px;
      height: 40px;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      margin: 0;
      padding: 0;
      flex-shrink: 0;
    }
    #voyd-titlebar button:hover { background: rgba(255,255,255,0.1) !important; color: white !important; }
    #voyd-titlebar #voyd-close:hover { background: rgba(232,17,35,0.9) !important; color: white !important; }
  `
  document.head.appendChild(style)

  // Drag region — always present for window dragging
  const dragRegion = document.createElement('div')
  dragRegion.id = 'voyd-drag-region'
  document.body.prepend(dragRegion)

  // Titlebar with window control buttons
  const bar = document.createElement('div')
  bar.id = 'voyd-titlebar'
  bar.innerHTML = `
    <button id="voyd-min" title="Minimize">&#8211;</button>
    <button id="voyd-max" title="Maximize">&#9633;</button>
    <button id="voyd-close" title="Close">&#10005;</button>
  `
  document.body.prepend(bar)
  document.getElementById('voyd-min').addEventListener('click', () => {
    console.log('minimize clicked')
    ipcRenderer.send('window-minimize')
  })
  document.getElementById('voyd-max').addEventListener('click', () => {
    console.log('maximize clicked')
    ipcRenderer.send('window-maximize')
  })
  document.getElementById('voyd-close').addEventListener('click', () => {
    console.log('close clicked')
    ipcRenderer.send('window-close')
  })

  const origPush = history.pushState.bind(history)
  const origReplace = history.replaceState.bind(history)
  history.pushState = function (...args) { origPush(...args); updateTitlebar() }
  history.replaceState = function (...args) { origReplace(...args); updateTitlebar() }
  window.addEventListener('popstate', updateTitlebar)
})

// voyd-app-mode: enables drag region and titlebar drag on /app routes
// On login/signup: buttons still visible but no drag interference
// Defined outside DOMContentLoaded so the second listener below can call it
// after bar/dragRegion are injected (listeners fire in registration order).
function updateTitlebar() {
  const bar = document.getElementById('voyd-titlebar')
  const dragRegion = document.getElementById('voyd-drag-region')
  if (!bar || !dragRegion) return
  const onApp = window.location.pathname.startsWith('/app')
  bar.classList.toggle('voyd-app-mode', onApp)
  dragRegion.classList.toggle('voyd-app-mode', onApp)
}

document.addEventListener('DOMContentLoaded', () => {
  updateTitlebar()
  setTimeout(updateTitlebar, 500)
})
