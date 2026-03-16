const { app, BrowserWindow, shell, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')

let tray = null
let mainWindow = null

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

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
  mainWindow?.webContents.send('update-status', 'available')
})

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('update-status', 'ready')
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

// FIX 3: Validate sender origin and add confirmation before installing updates
ipcMain.on('install-update', (event) => {
  const senderUrl = event.senderFrame?.url || ''
  try {
    const parsed = new URL(senderUrl)
    if (parsed.origin !== 'https://joinvoyd.com') return
  } catch {
    return
  }

  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'A new version is ready. Restart now to apply the update?',
    buttons: ['Restart', 'Later']
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall()
  })
})

// FIX 4: Version via IPC instead of executeJavaScript
ipcMain.handle('get-version', () => app.getVersion())

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

  // FIX 6: Enforce a fallback CSP if the server doesn't provide one
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {}
    const hasCSP = Object.keys(headers).some(k => k.toLowerCase() === 'content-security-policy')
    if (!hasCSP) {
      callback({
        responseHeaders: {
          ...headers,
          'Content-Security-Policy': [
            "default-src 'self' https://joinvoyd.com https://*.joinvoyd.com; " +
            "script-src 'self' https://joinvoyd.com https://*.joinvoyd.com 'unsafe-inline' 'unsafe-eval'; " +
            "style-src 'self' https://joinvoyd.com https://*.joinvoyd.com 'unsafe-inline'; " +
            "img-src * data: blob:; " +
            "media-src * data: blob:; " +
            "connect-src *; " +
            "font-src * data:; " +
            "frame-src 'self' https://joinvoyd.com https://*.joinvoyd.com;"
          ]
        }
      })
    } else {
      callback({ responseHeaders: headers })
    }
  })

  // FIX 10: Restrict permissions to only what VOYD needs
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = ['media', 'notifications']
    callback(allowedPermissions.includes(permission))
  })

  // FIX 11: Disable DevTools in production builds
  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools()
    })
  }

  // Inject desktop app version into the web app's window object
  mainWindow.webContents.on('did-finish-load', () => {
    const version = app.getVersion()
    mainWindow.webContents.executeJavaScript(`window.__VOYD_VERSION__ = "${version}";`)
  })

  // FIX 2: Proper URL validation using URL parsing instead of startsWith
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.origin === 'https://joinvoyd.com') {
        return { action: 'allow' }
      }
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url)
      }
    } catch {
      // Invalid URL, deny silently
    }
    return { action: 'deny' }
  })

  // FIX 1: Restrict navigation to joinvoyd.com origin only
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url)
      if (parsed.origin !== 'https://joinvoyd.com') {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
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

  // FIX 4: Keybinds via IPC instead of executeJavaScript
  // Global shortcuts for mute/deafen (need to work when window is unfocused)
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    mainWindow?.webContents.send('keybind', 'toggle_mute')
  })

  globalShortcut.register('CommandOrControl+Shift+D', () => {
    mainWindow?.webContents.send('keybind', 'toggle_deafen')
  })

  // FIX 7: Local shortcuts for app-specific actions (only active when window is focused)
  const localShortcuts = [
    { key: 'CommandOrControl+K', action: 'quick_switcher' },
    { key: 'CommandOrControl+,', action: 'open_settings' },
    { key: 'Alt+Up', action: 'navigate_up' },
    { key: 'Alt+Down', action: 'navigate_down' },
    { key: 'Alt+Shift+Up', action: 'navigate_unread_up' },
    { key: 'Alt+Shift+Down', action: 'navigate_unread_down' },
  ]

  const registerLocalShortcuts = () => {
    localShortcuts.forEach(({ key, action }) => {
      globalShortcut.register(key, () => {
        mainWindow?.webContents.send('keybind', action)
      })
    })
  }

  const unregisterLocalShortcuts = () => {
    localShortcuts.forEach(({ key }) => {
      globalShortcut.unregister(key)
    })
  }

  mainWindow.on('focus', registerLocalShortcuts)
  mainWindow.on('blur', unregisterLocalShortcuts)

  // Register immediately if window is already focused
  if (mainWindow.isFocused()) registerLocalShortcuts()

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
