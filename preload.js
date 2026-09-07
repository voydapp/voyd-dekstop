const { contextBridge, ipcRenderer } = require('electron')

// Hardcoded rather than required from '@superhuman/electron-push-receiver/src/constants':
// this sandboxed preload script can only require Electron's own built-ins, not arbitrary
// npm packages -- requiring that path threw and silently killed this entire preload script
// (confirmed live: window.electronAPI never got defined, breaking drag/minimize/etc. too,
// not just push). Must stay in sync with the package's src/constants/index.js values.
const START_NOTIFICATION_SERVICE = 'PUSH_RECEIVER:::START_NOTIFICATION_SERVICE'
const NOTIFICATION_SERVICE_STARTED = 'PUSH_RECEIVER:::NOTIFICATION_SERVICE_STARTED'
const NOTIFICATION_SERVICE_ERROR = 'PUSH_RECEIVER:::NOTIFICATION_SERVICE_ERROR'
const NOTIFICATION_RECEIVED = 'PUSH_RECEIVER:::NOTIFICATION_RECEIVED'
const TOKEN_UPDATED = 'PUSH_RECEIVER:::TOKEN_UPDATED'

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  installUpdate: () => ipcRenderer.send('install-update'),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getPortableDir: () => ipcRenderer.invoke('get-portable-dir'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, status, data) => callback(status, data))
  },
  onKeybind: (callback) => {
    ipcRenderer.on('keybind', (_event, action) => callback(action))
  },
  setActivityDetectionEnabled: (enabled) => ipcRenderer.send('set-activity-detection-enabled', enabled),
  onGameDetected: (callback) => {
    ipcRenderer.on('game-detected', (_event, game) => callback(game))
  },
  sendVoiceState: (state) => ipcRenderer.send('voice-state-update', state),
  sendOverlaySettings: (settings) => ipcRenderer.send('overlay-settings-update', settings),
  sendUserKeybinds: (keybinds) => ipcRenderer.send('user-keybinds-update', keybinds),
  sendCameraFrames: (frames) => ipcRenderer.send('camera-frames-update', frames),
  sendPushToTalkSettings: (settings) => ipcRenderer.send('push-to-talk-settings-update', settings),
  onPushToTalk: (callback) => {
    ipcRenderer.on('push-to-talk', (_event, isDown) => callback(isDown))
  },
  onPushToTalkPermissionNeeded: (callback) => {
    ipcRenderer.on('push-to-talk-permission-needed', () => callback())
  },
  requestPushToTalkPermission: () => ipcRenderer.invoke('push-to-talk-request-permission'),
  recheckPushToTalkPermission: () => ipcRenderer.invoke('push-to-talk-recheck-permission'),
  openPushToTalkSystemSettings: () => ipcRenderer.send('push-to-talk-open-system-settings'),
  startPushNotificationService: (config) => ipcRenderer.send(START_NOTIFICATION_SERVICE, config),
  onPushServiceStarted: (callback) => {
    ipcRenderer.on(NOTIFICATION_SERVICE_STARTED, (_event, token) => callback(token))
  },
  onPushServiceError: (callback) => {
    ipcRenderer.on(NOTIFICATION_SERVICE_ERROR, (_event, error) => callback(error))
  },
  onPushTokenUpdated: (callback) => {
    ipcRenderer.on(TOKEN_UPDATED, (_event, token) => callback(token))
  },
  onPushNotificationReceived: (callback) => {
    ipcRenderer.on(NOTIFICATION_RECEIVED, (_event, notification) => callback(notification))
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

// Bridge voyd-show-and-focus CustomEvent (from a clicked OS notification) to IPC —
// the window may be hidden in the tray, which only the main process can undo.
window.addEventListener('voyd-show-and-focus', () => {
  ipcRenderer.send('show-and-focus-window')
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
      right: 120px;
      height: 32px;
      -webkit-app-region: drag;
      z-index: 99998;
      pointer-events: none;
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
      pointer-events: none;
    }
    #voyd-titlebar.voyd-app-mode {
      left: 0;
      -webkit-app-region: no-drag;
    }
    #voyd-titlebar button {
      -webkit-app-region: no-drag;
      pointer-events: auto;
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

// voyd-app-mode: extends titlebar to full width on /app routes
// Dragging is handled exclusively by #voyd-drag-region on all routes
// Defined outside DOMContentLoaded so the second listener below can call it
// after bar/dragRegion are injected (listeners fire in registration order).
function updateTitlebar() {
  const bar = document.getElementById('voyd-titlebar')
  const dragRegion = document.getElementById('voyd-drag-region')
  if (!bar) return
  const onApp = window.location.pathname.startsWith('/app')
  bar.classList.toggle('voyd-app-mode', onApp)
  // On /app routes, CommunicationHeader provides its own drag region — hide ours
  // so it doesn't intercept clicks on header icon buttons
  if (dragRegion) dragRegion.style.display = onApp ? 'none' : ''
}

document.addEventListener('DOMContentLoaded', () => {
  updateTitlebar()

  // Poll every 100ms for 5 seconds to catch React Router redirects
  let polls = 0
  const interval = setInterval(() => {
    updateTitlebar()
    polls++
    if (polls >= 50) clearInterval(interval)
  }, 100)
})
