const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  installUpdate: () => ipcRenderer.send('install-update'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, status) => callback(status))
  },
  onKeybind: (callback) => {
    ipcRenderer.on('keybind', (_event, action) => callback(action))
  },
})

// Inject titlebar on login/auth pages (not in app)
window.addEventListener('DOMContentLoaded', () => {
  const isAppPage = window.location.pathname.startsWith('/app')
  if (isAppPage) return

  const style = document.createElement('style')
  style.innerHTML = `
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

  if (!document.getElementById('voyd-titlebar')) {
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
  }
})
