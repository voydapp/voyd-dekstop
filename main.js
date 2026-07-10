const { app, BrowserWindow, shell, globalShortcut, ipcMain, Tray, Menu, nativeImage, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')

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
autoUpdater.forceDevUpdateConfig = false
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.autoRunAppAfterInstall = true
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'voydapp',
  repo: 'voyd-dekstop',
  private: false
})

autoUpdater.on('checking-for-update', () => {
  mainWindow?.webContents.send('update-status', 'checking')
})

autoUpdater.on('update-available', () => {
  mainWindow?.webContents.send('update-status', 'available')
})

autoUpdater.on('update-not-available', () => {
  mainWindow?.webContents.send('update-status', 'not-available')
})

autoUpdater.on('download-progress', (progress) => {
  mainWindow?.webContents.send('update-status', 'downloading', { percent: Math.round(progress.percent) })
})

autoUpdater.on('update-downloaded', () => {
  console.log('[updater] update-downloaded')
  console.log('[updater] PORTABLE_EXECUTABLE_DIR:', process.env.PORTABLE_EXECUTABLE_DIR)
  console.log('[updater] execPath:', process.execPath)
  mainWindow?.webContents.send('update-status', 'ready')
})

autoUpdater.on('error', (err) => {
  mainWindow?.webContents.send('update-status', 'error', { message: err?.message || 'Update check failed' })
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

let isInstalling = false
ipcMain.on('install-update', () => {
  if (isInstalling) return
  isInstalling = true

  app.isQuitting = true

  try { tray?.destroy() } catch(e) {}
  tray = null

  const downloadedFile = autoUpdater.downloadedUpdateHelper?.downloadedFile
  const currentExe = process.execPath

  if (downloadedFile && fs.existsSync(downloadedFile)) {
    // Portable build: quitAndInstall won't replace the exe automatically.
    // Write a batch script that waits for us to exit, copies the new exe
    // over the old one, then relaunches.
    const updateScript = path.join(path.dirname(currentExe), 'voyd-update.bat')
    fs.writeFileSync(updateScript,
      `@echo off\r\ntimeout /t 2 /nobreak >nul\r\ncopy /y "${downloadedFile}" "${currentExe}"\r\nstart "" "${currentExe}"\r\ndel "%~f0"\r\n`
    )
    require('child_process').spawn('cmd.exe', ['/c', updateScript], {
      detached: true,
      stdio: 'ignore'
    }).unref()
    app.quit()
  } else {
    // Fallback: let electron-updater handle it (works if PORTABLE_EXECUTABLE_DIR is set)
    BrowserWindow.getAllWindows().forEach(w => w.destroy())
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 500)
  }
})

// FIX 4: Version via IPC instead of executeJavaScript
ipcMain.handle('get-version', () => app.getVersion())

ipcMain.handle('get-portable-dir', () => ({
  portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  execPath: process.execPath
}))

// Manual update check from renderer
ipcMain.on('check-for-updates', () => {
  autoUpdater.checkForUpdates()
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
      partition: 'persist:voyd',
    },
    frame: false,
  })

  mainWindow.loadURL('https://joinvoyd.com/app')

  const VOYD_CSP = [
    "default-src 'self' https://joinvoyd.com https://*.joinvoyd.com",
    "script-src 'self' https://joinvoyd.com https://*.joinvoyd.com 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com",
    "connect-src 'self' https://joinvoyd.com https://*.joinvoyd.com https://*.supabase.co wss://*.supabase.co wss://fjvijrbfbzdjsyiwqwfd.supabase.co https://*.agora.io wss://*.agora.io https://livekit.io wss://*.livekit.io",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "style-src 'self' 'unsafe-inline' https://joinvoyd.com https://*.joinvoyd.com",
    "font-src 'self' data: https:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {}
    // Always override server CSP with our hardcoded policy
    const filtered = Object.fromEntries(
      Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-security-policy')
    )
    callback({
      responseHeaders: {
        ...filtered,
        'Content-Security-Policy': [VOYD_CSP]
      }
    })
  })

  // FIX 10: Restrict permissions to only what VOYD needs
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = ['media', 'notifications']
    callback(allowedPermissions.includes(permission))
  })

  // DevTools toggle — Ctrl+Shift+I toggles open/close (disabled in production)
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools()
        } else {
          mainWindow.webContents.openDevTools()
        }
        _event.preventDefault()
      }
    })
  }

  // Inject desktop app version into the web app's window object
  mainWindow.webContents.on('did-finish-load', () => {
    const version = app.getVersion()
    mainWindow.webContents.executeJavaScript(`window.__VOYD_VERSION__ = "${version}";`)
  })

  // Allowed origins for in-app navigation (OAuth providers + Supabase auth)
  const allowedNavigationOrigins = [
    'https://joinvoyd.com',
    'https://accounts.google.com',
    'https://github.com',
    'https://discord.com',
  ]

  // Handle new window requests — OAuth popups open in system browser, joinvoyd.com stays in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.origin === 'https://joinvoyd.com') {
        return { action: 'allow' }
      }
      // OAuth provider URLs — open in system browser so sign-in works
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url)
      }
    } catch {
      // Invalid URL, deny silently
    }
    return { action: 'deny' }
  })

  // Restrict in-window navigation to joinvoyd.com + OAuth providers
  // OAuth flows redirect back to joinvoyd.com after auth, so the provider origins must be allowed
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url)
      // Allow Supabase auth callbacks (joinvoyd.com/auth/callback etc.)
      if (allowedNavigationOrigins.some(origin => parsed.origin === origin)) {
        return
      }
      // Allow Supabase auth URLs (e.g. *.supabase.co for OAuth flow)
      if (parsed.hostname.endsWith('.supabase.co')) {
        return
      }
      event.preventDefault()
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
