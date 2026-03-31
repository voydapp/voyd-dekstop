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
      height: 32px;
      -webkit-app-region: drag;
      z-index: 99999;
      pointer-events: none;
    }
    #voyd-titlebar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 32px;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      -webkit-app-region: drag;
      z-index: 999999;
    }
    #voyd-titlebar.voyd-hidden { display: none; }
    #voyd-titlebar button {
      -webkit-app-region: no-drag;
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.5);
      width: 32px;
      height: 22px;
      font-size: 13px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      margin-right: 2px;
    }
    #voyd-titlebar button:hover { background: rgba(255,255,255,0.1); color: white; }
    #voyd-titlebar #voyd-close:hover { background: #e81123; color: white; }
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
  document.getElementById('voyd-min').addEventListener('click', () => ipcRenderer.send('window-minimize'))
  document.getElementById('voyd-max').addEventListener('click', () => ipcRenderer.send('window-maximize'))
  document.getElementById('voyd-close').addEventListener('click', () => ipcRenderer.send('window-close'))

  // Toggle titlebar visibility based on route — hide on /app (CommunicationHeader
  // provides its own controls there), show everywhere else
  function updateTitlebarVisibility() {
    const onAppPage = window.location.pathname.startsWith('/app')
    bar.classList.toggle('voyd-hidden', onAppPage)
  }

  updateTitlebarVisibility()

  // React Router uses pushState/replaceState for navigation, so listen for those
  const origPushState = history.pushState.bind(history)
  const origReplaceState = history.replaceState.bind(history)
  history.pushState = function (...args) {
    origPushState(...args)
    updateTitlebarVisibility()
  }
  history.replaceState = function (...args) {
    origReplaceState(...args)
    updateTitlebarVisibility()
  }
  window.addEventListener('popstate', updateTitlebarVisibility)
})
