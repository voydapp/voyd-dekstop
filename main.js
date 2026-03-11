const { app, BrowserWindow, shell, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')

let tray = null
let mainWindow = null

// Auto updater config
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'voydapp',
  repo: 'voyd-dekstop',
  private: false
})

autoUpdater.on('update-available', () => {
  mainWindow?.webContents.executeJavaScript(`
    window.dispatchEvent(new CustomEvent('voyd-update', { detail: { status: 'available' } }))
  `)
})

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.executeJavaScript(`
    window.dispatchEvent(new CustomEvent('voyd-update', { detail: { status: 'ready' } }))
  `)
})

// IPC window controls
ipcMain.on('window-minimize', () => {
  mainWindow?.minimize()
})

ipcMain.on('window-maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})

ipcMain.on('window-close', () => {
  mainWindow?.hide()
})

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall()
})

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open VOYD',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    { type: 'separator' },
    {
      label: `Version ${app.getVersion()}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit VOYD',
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('VOYD')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    title: 'VOYD',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    frame: false,
    titleBarStyle: 'hidden',
  })

  mainWindow.loadURL('https://joinvoyd.com/app')

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://joinvoyd.com')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      tray?.displayBalloon({
        title: 'VOYD',
        content: 'VOYD is still running in the background.',
        iconType: 'info'
      })
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window.__VOYD_VERSION__ = '${app.getVersion()}';
    `)

    mainWindow.webContents.insertCSS(`
      #voyd-titlebar {
        position: fixed;
        top: 1px;
        left: 0;
        right: 0;
        height: 28px;
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
    `)

    mainWindow.webContents.executeJavaScript(`
      if (!document.getElementById('voyd-titlebar')) {
        const bar = document.createElement('div');
        bar.id = 'voyd-titlebar';
        bar.innerHTML = \`
          <button id="voyd-min" title="Minimize">&#8211;</button>
          <button id="voyd-max" title="Maximize">&#9633;</button>
          <button id="voyd-close" title="Close">&#10005;</button>
        \`;
        document.body.prepend(bar);
        document.getElementById('voyd-min').addEventListener('click', () => window.electronAPI?.minimize());
        document.getElementById('voyd-max').addEventListener('click', () => window.electronAPI?.maximize());
        document.getElementById('voyd-close').addEventListener('click', () => window.electronAPI?.close());
      }
    `)
  })

  // Global keybinds
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'toggle_mute' } }))`
    )
  })

  globalShortcut.register('CommandOrControl+Shift+D', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'toggle_deafen' } }))`
    )
  })

  globalShortcut.register('CommandOrControl+K', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'quick_switcher' } }))`
    )
  })

  globalShortcut.register('CommandOrControl+,', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'open_settings' } }))`
    )
  })

  globalShortcut.register('Alt+Up', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'navigate_up' } }))`
    )
  })

  globalShortcut.register('Alt+Down', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'navigate_down' } }))`
    )
  })

  globalShortcut.register('Alt+Shift+Up', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'navigate_unread_up' } }))`
    )
  })

  globalShortcut.register('Alt+Shift+Down', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('voyd-keybind', { detail: { action: 'navigate_unread_down' } }))`
    )
  })

  // Check for updates after load
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify()
    }, 5000)
  })
}

app.whenReady().then(() => {
  createTray()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Stay in tray
  }
})