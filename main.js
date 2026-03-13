const { app, BrowserWindow, shell, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron')
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
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    mainWindow?.webContents.send('keybind', 'toggle_mute')
  })

  globalShortcut.register('CommandOrControl+Shift+D', () => {
    mainWindow?.webContents.send('keybind', 'toggle_deafen')
  })

  globalShortcut.register('CommandOrControl+K', () => {
    mainWindow?.webContents.send('keybind', 'quick_switcher')
  })

  globalShortcut.register('CommandOrControl+,', () => {
    mainWindow?.webContents.send('keybind', 'open_settings')
  })

  globalShortcut.register('Alt+Up', () => {
    mainWindow?.webContents.send('keybind', 'navigate_up')
  })

  globalShortcut.register('Alt+Down', () => {
    mainWindow?.webContents.send('keybind', 'navigate_down')
  })

  globalShortcut.register('Alt+Shift+Up', () => {
    mainWindow?.webContents.send('keybind', 'navigate_unread_up')
  })

  globalShortcut.register('Alt+Shift+Down', () => {
    mainWindow?.webContents.send('keybind', 'navigate_unread_down')
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
