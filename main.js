const { app, BrowserWindow, shell, globalShortcut, ipcMain, Tray, Menu, nativeImage, session, screen, Notification } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const gameDetection = require('./gameDetection')

let tray = null
let mainWindow = null
let overlayWindow = null

// The one canonical permanent install location this app's self-replace step
// always targets — confirmed Aug 17 by locating the real Desktop shortcut's
// target before it was deleted, and matching the pre-existing hardcoded
// fallback already in this file. Checked FIRST (not last) in possibleDirs
// below specifically so a stray folder that also happens to contain a
// VOYD.exe (a test copy, an old extraction, anything) can never get
// self-replaced into a second "real" install instead of this one.
const CANONICAL_INSTALL_DIR = 'C:\\VOYD'

const UPDATER_CACHE_DIR = path.join(app.getPath('appData').replace('Roaming', 'Local'), 'voyd-dekstop-updater')
const UPDATE_LOG_PATH = path.join(UPDATER_CACHE_DIR, 'update.log')
const UPDATE_FAILURE_MARKER_PATH = path.join(UPDATER_CACHE_DIR, 'last-replace-failed.txt')

// Real file-based logging for the self-replace path specifically — console
// output alone isn't visible during the actual replace moment (the batch
// script runs after this process has already quit), so a silent failure
// there leaves nothing to diagnose from. Every step of the update/install
// flow logs here, not just errors, so a full timeline exists after the fact.
function logUpdate(message) {
  try {
    fs.mkdirSync(UPDATER_CACHE_DIR, { recursive: true })
    fs.appendFileSync(UPDATE_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`)
  } catch (e) {
    console.error('[updater] failed to write update log:', e?.message || e)
  }
  console.log('[updater]', message)
}

// electron-builder's portable NSIS target self-extracts to a fresh
// ns????.tmp\7z-out folder in %TEMP% on EVERY launch and never cleans them
// up itself — confirmed Aug 17: 16 of these had accumulated (~214MB each,
// ~3.4GB total) from testing across two days. Best-effort cleanup on
// startup, skipping whatever we're actually running from right now.
function cleanupOrphanedExtractionFolders() {
  try {
    const tempDir = app.getPath('temp')
    const currentDir = path.dirname(process.execPath).toLowerCase()
    const entries = fs.readdirSync(tempDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^ns[a-z0-9]+\.tmp$/i.test(entry.name)) continue
      const fullPath = path.join(tempDir, entry.name)
      if (currentDir.startsWith(fullPath.toLowerCase())) continue // never touch our own running copy
      try {
        fs.rmSync(fullPath, { recursive: true, force: true })
        logUpdate(`cleaned up orphaned extraction folder: ${fullPath}`)
      } catch (e) {
        // Still in use by something else, or a permissions hiccup — fine to
        // skip, it'll either get cleaned up next launch or isn't worth
        // failing startup over.
      }
    }
  } catch (e) {
    console.error('[main] orphaned extraction cleanup failed:', e?.message || e)
  }
}

// If the batch script's self-replace failed last time, it leaves a marker
// with why. Without this, a failed update degrades silently back to "user
// has to manually chase down a new exe" with zero indication anything went
// wrong — this surfaces it for real, both as an OS notification and as the
// same update-status channel the in-app UI already listens to.
function checkForPreviousReplaceFailure() {
  try {
    if (!fs.existsSync(UPDATE_FAILURE_MARKER_PATH)) return
    const reason = fs.readFileSync(UPDATE_FAILURE_MARKER_PATH, 'utf8').trim()
    fs.unlinkSync(UPDATE_FAILURE_MARKER_PATH)
    logUpdate('previous self-replace failure detected on startup: ' + reason)

    if (Notification.isSupported()) {
      new Notification({
        title: 'VOYD update failed to install',
        body: reason || 'The last update could not be installed automatically.',
      }).show()
    }

    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('update-status', 'error', { message: reason })
    })
  } catch (e) {
    console.error('[main] failed to check for previous replace failure:', e?.message || e)
  }
}

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
  logUpdate('checking-for-update')
  mainWindow?.webContents.send('update-status', 'checking')
})

autoUpdater.on('update-available', (info) => {
  logUpdate('update-available ' + info?.version)
  mainWindow?.webContents.send('update-status', 'available')
})

autoUpdater.on('update-not-available', (info) => {
  logUpdate('update-not-available, current is latest: ' + info?.version)
  mainWindow?.webContents.send('update-status', 'not-available')
})

autoUpdater.on('download-progress', (progress) => {
  console.log('[updater] download-progress', Math.round(progress.percent) + '%') // too noisy for the persistent log file
  mainWindow?.webContents.send('update-status', 'downloading', { percent: Math.round(progress.percent) })
})

let downloadedFilePath = null

// electron-updater doesn't reliably expose the downloaded path via
// downloadedUpdateHelper, so this is resolved from the known cache location
// instead. Kept as a function (not resolved once and cached) because it's
// deliberately re-checked fresh at install time, not just at download time —
// see the comment in the install-update handler for why.
function getExpectedDownloadPath() {
  return path.join(UPDATER_CACHE_DIR, 'pending', 'VOYD.exe')
}

autoUpdater.on('update-downloaded', (info) => {
  logUpdate(`update-downloaded ${info?.version} (PORTABLE_EXECUTABLE_DIR=${process.env.PORTABLE_EXECUTABLE_DIR}, execPath=${process.execPath})`)

  const expectedFile = getExpectedDownloadPath()
  if (fs.existsSync(expectedFile)) {
    downloadedFilePath = expectedFile
    logUpdate('downloadedFilePath: ' + downloadedFilePath)
  } else {
    // Real, observed race: electron-updater can fire this event a moment
    // before the file is fully written/renamed into place, so a miss here
    // doesn't mean the download failed — install-update re-checks this same
    // path fresh (by which point the gap has long closed) rather than
    // trusting this one-shot result and silently falling back to
    // quitAndInstall(), which doesn't know how to replace a portable exe's
    // permanent copy at all.
    logUpdate('expected file not found yet at: ' + expectedFile + ' (will re-check at install time)')
  }

  mainWindow?.webContents.send('update-status', 'ready')
})

autoUpdater.on('error', (err) => {
  logUpdate('error: ' + (err?.message || err))
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

// A clicked OS notification asks us to restore the window — it may be hidden
// in the tray or minimized, neither of which the renderer's own window.focus()
// can undo by itself.
ipcMain.on('show-and-focus-window', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
})

let isInstalling = false
ipcMain.on('install-update', () => {
  if (isInstalling) return
  isInstalling = true

  app.isQuitting = true

  try { tray?.destroy() } catch(e) {}
  tray = null

  // Re-check fresh rather than trusting only the snapshot taken when
  // update-downloaded fired — that check can race electron-updater's own
  // file write/rename (see comment there). By the time the user has
  // actually clicked install, the download is long finished either way.
  const downloadedFile = (downloadedFilePath && fs.existsSync(downloadedFilePath))
    ? downloadedFilePath
    : (fs.existsSync(getExpectedDownloadPath()) ? getExpectedDownloadPath() : null)

  // CANONICAL_INSTALL_DIR is checked FIRST, not last — see its comment.
  // PORTABLE_EXECUTABLE_DIR / INIT_CWD are only consulted as a fallback for
  // a real install that genuinely isn't at the canonical path.
  const possibleDirs = [
    CANONICAL_INSTALL_DIR,
    process.env.PORTABLE_EXECUTABLE_DIR,
    path.dirname(process.env.INIT_CWD || ''),
  ].filter(Boolean)

  const targetDir = possibleDirs.find(d => {
    try { return fs.existsSync(path.join(d, 'VOYD.exe')) }
    catch { return false }
  }) || CANONICAL_INSTALL_DIR

  const targetExe = path.join(targetDir, 'VOYD.exe')

  logUpdate(`install-update: downloadedFile=${downloadedFile} targetExe=${targetExe}`)

  if (downloadedFile && fs.existsSync(downloadedFile)) {
    // Portable build: write a batch script that waits for us to exit,
    // retries the copy in case the file handle takes a moment to release
    // even after the process is gone, and relaunches. Every step logs to
    // UPDATE_LOG_PATH so a silent failure has an actual timeline to
    // diagnose from afterward instead of just "it didn't work" — the main
    // process is gone by the time any of this runs, so this file is the
    // only record that exists.
    const updateScript = path.join(path.dirname(targetExe), 'voyd-update.bat')
    const logPath = UPDATE_LOG_PATH
    const failMarkerPath = UPDATE_FAILURE_MARKER_PATH
    fs.writeFileSync(updateScript,
      `@echo off\r\n` +
      `setlocal enabledelayedexpansion\r\n` +
      `set LOGFILE="${logPath}"\r\n` +
      `set FAILMARKER="${failMarkerPath}"\r\n` +
      `set SRC="${downloadedFile}"\r\n` +
      `set DST="${targetExe}"\r\n` +
      `echo [%date% %time%] voyd-update.bat starting, waiting for VOYD.exe to exit >> %LOGFILE%\r\n` +
      `set /a waitcount=0\r\n` +
      `:waitloop\r\n` +
      `tasklist /fi "imagename eq VOYD.exe" 2>nul | find /i "VOYD.exe" >nul\r\n` +
      `if not errorlevel 1 (\r\n` +
      `  set /a waitcount+=1\r\n` +
      `  if !waitcount! GEQ 30 (\r\n` +
      `    echo [%date% %time%] gave up waiting for VOYD.exe to exit after 30s >> %LOGFILE%\r\n` +
      `    echo VOYD.exe never fully exited after 30 seconds, update was not installed. > %FAILMARKER%\r\n` +
      `    goto fail\r\n` +
      `  )\r\n` +
      `  timeout /t 1 /nobreak >nul\r\n` +
      `  goto waitloop\r\n` +
      `)\r\n` +
      `echo [%date% %time%] VOYD.exe exited after !waitcount!s, attempting copy >> %LOGFILE%\r\n` +
      `set /a copyattempt=0\r\n` +
      `:copyloop\r\n` +
      `set /a copyattempt+=1\r\n` +
      `copy /y %SRC% %DST% >nul 2>&1\r\n` +
      `if errorlevel 1 (\r\n` +
      `  if !copyattempt! GEQ 5 (\r\n` +
      `    echo [%date% %time%] copy failed after 5 attempts >> %LOGFILE%\r\n` +
      `    echo Could not copy the new version into place after 5 attempts ^(file may still have been locked^), update was not installed. > %FAILMARKER%\r\n` +
      `    goto fail\r\n` +
      `  )\r\n` +
      `  echo [%date% %time%] copy attempt !copyattempt! failed, retrying >> %LOGFILE%\r\n` +
      `  timeout /t 2 /nobreak >nul\r\n` +
      `  goto copyloop\r\n` +
      `)\r\n` +
      `echo [%date% %time%] copy succeeded on attempt !copyattempt! >> %LOGFILE%\r\n` +
      `if exist %FAILMARKER% del %FAILMARKER%\r\n` +
      `start "" %DST%\r\n` +
      `del "%~f0"\r\n` +
      `exit /b 0\r\n` +
      `:fail\r\n` +
      `start "" %DST%\r\n` +
      `del "%~f0"\r\n` +
      `exit /b 1\r\n`
    )
    logUpdate('spawning voyd-update.bat: ' + updateScript)
    require('child_process').spawn('cmd.exe', ['/c', updateScript], {
      detached: true,
      stdio: 'ignore'
    }).unref()
    app.quit()
  } else {
    // Fallback: let electron-updater handle it (works if PORTABLE_EXECUTABLE_DIR is set).
    // This does NOT replace the permanent copy at CANONICAL_INSTALL_DIR — it's
    // a last resort, not a silent equivalent, so it's logged as such and
    // leaves a marker the same way a failed batch-copy would, rather than
    // quietly appearing to have worked.
    logUpdate('no valid downloadedFile at install time — falling back to autoUpdater.quitAndInstall (does not update ' + targetExe + ')')
    try {
      fs.mkdirSync(UPDATER_CACHE_DIR, { recursive: true })
      fs.writeFileSync(UPDATE_FAILURE_MARKER_PATH, `Automatic update could not confirm the downloaded file — ${targetExe} was not updated. The app relaunched from its update cache instead; it will try again on the next update.`)
    } catch (e) {}
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

// Rich Presence — process detection. The renderer (web app) controls on/off
// via show_activity_status; confirmed detections/clears are relayed back to
// it, which writes through the presence table the same way manual_status does.
gameDetection.init((game) => {
  mainWindow?.webContents.send('game-detected', game)
})

ipcMain.on('set-activity-detection-enabled', (_event, enabled) => {
  gameDetection.setEnabled(enabled)
})

// Overlay — voice channel state. The renderer (web app) owns VoiceContext
// and pushes participant snapshots down; we just relay them to the overlay
// window, which has no Supabase session of its own (same split as Rich
// Presence: renderer knows state, main process only routes it).
ipcMain.on('voice-state-update', (_event, state) => {
  overlayWindow?.webContents.send('voice-state', state)
})

const OVERLAY_WIDTH = 280
const OVERLAY_HEIGHT = 400
const OVERLAY_MARGIN = 16

// Phase 1 hardcoded defaults — still what's used until the renderer's first
// overlay-settings-update push arrives (fresh launch before login finishes,
// or a user_settings row that predates this phase), and what a brand new
// account with no saved row falls back to.
let overlayKeybind = 'CommandOrControl+Shift+O'
let overlayPosition = 'top-right'

// Named corner anchors, not raw x/y — recomputed against whatever the
// primary display's current work area is, so this is correct across
// resolution/monitor changes rather than pinning to a coordinate that may
// not even be on-screen next time.
function computeOverlayBounds(position) {
  const { x: waX, y: waY, width: waWidth, height: waHeight } = screen.getPrimaryDisplay().workArea
  const left = Math.round(waX + OVERLAY_MARGIN)
  const right = Math.round(waX + waWidth - OVERLAY_WIDTH - OVERLAY_MARGIN)
  const top = Math.round(waY + OVERLAY_MARGIN)
  const bottom = Math.round(waY + waHeight - OVERLAY_HEIGHT - OVERLAY_MARGIN)

  switch (position) {
    case 'top-left': return { x: left, y: top, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }
    case 'bottom-left': return { x: left, y: bottom, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }
    case 'bottom-right': return { x: right, y: bottom, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }
    case 'top-right':
    default: return { x: right, y: top, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }
  }
}

function repositionOverlayWindow(position) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.setBounds(computeOverlayBounds(position))
}

function toggleOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (overlayWindow.isVisible()) {
    overlayWindow.hide()
  } else {
    // showInactive, not show — the overlay must never steal focus from the game underneath.
    overlayWindow.showInactive()
  }
}

// Re-registerable so a keybind change while the app is running takes effect
// immediately, no restart. Registers the NEW accelerator before unregistering
// the old one — if the new one is invalid or already claimed by something
// else on the OS, globalShortcut.register returns false and the existing
// binding is left alone rather than leaving the user with no overlay
// shortcut at all.
function registerOverlayShortcut(accelerator) {
  if (accelerator === overlayKeybind && globalShortcut.isRegistered(accelerator)) return true

  const registered = globalShortcut.register(accelerator, toggleOverlayWindow)
  if (!registered) {
    console.error('[main] overlay keybind registration failed (invalid or already in use):', accelerator)
    return false
  }
  if (overlayKeybind && overlayKeybind !== accelerator) {
    globalShortcut.unregister(overlayKeybind)
  }
  overlayKeybind = accelerator
  return true
}

// Phase 2 — the renderer (which has the Supabase session) reads
// overlay_keybind/overlay_position from user_settings and pushes them here,
// same split as voice-state-update: renderer knows state, main process only
// applies it. Fires on initial load too, so this is also how a fresh
// install picks up a real user's saved preference instead of staying on the
// Phase 1 hardcoded defaults forever.
ipcMain.on('overlay-settings-update', (_event, settings) => {
  if (settings?.keybind && settings.keybind !== overlayKeybind) {
    registerOverlayShortcut(settings.keybind)
  }
  if (settings?.position && settings.position !== overlayPosition) {
    overlayPosition = settings.position
    repositionOverlayWindow(overlayPosition)
  }
})

function createOverlayWindow() {
  const bounds = computeOverlayBounds(overlayPosition)

  overlayWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.js'),
      // Own in-memory session, deliberately not the app's default session —
      // keeps it out of reach of the CSP/permission overrides below, which
      // are scoped to session.defaultSession and target joinvoyd.com, not
      // this window's local static content.
      partition: 'overlay-window',
    },
  })

  // 'screen-saver' level (not just alwaysOnTop:true) is what actually keeps
  // an Electron window above most borderless/windowed-fullscreen games —
  // plain always-on-top alone frequently loses to the game's own surface.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))

  // No interactive elements in this phase (read-only participant list), so
  // click-through can just be permanent rather than toggled — see report.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  overlayWindow.on('closed', () => { overlayWindow = null })
}

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

  // Notifications (and everything else) live entirely in the renderer's own
  // Realtime subscription — if it crashes or hangs, reload rather than sitting
  // silently dead in the tray. Guarded against reload-looping a persistently
  // broken renderer: only auto-reload if the last one was >30s ago.
  let lastAutoReload = 0
  const RELOAD_COOLDOWN_MS = 30000
  const reloadIfNotLooping = (reason) => {
    const now = Date.now()
    if (now - lastAutoReload < RELOAD_COOLDOWN_MS) {
      console.error('[main]', reason, '— skipping reload, still within cooldown from last auto-reload')
      return
    }
    lastAutoReload = now
    console.error('[main]', reason, '— reloading')
    if (!app.isQuitting) mainWindow?.webContents.reload()
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    reloadIfNotLooping('renderer process gone: ' + details.reason)
  })

  mainWindow.webContents.on('unresponsive', () => {
    reloadIfNotLooping('renderer unresponsive')
  })

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
  cleanupOrphanedExtractionFolders()
  createTray()
  createWindow()
  createOverlayWindow()
  checkForPreviousReplaceFailure()

  // Overlay toggle — global so it works while a game window has focus.
  // Confirmed against existing globalShortcut registrations (Shift+M,
  // Shift+D, K, comma, Alt+arrows) before picking Shift+O: no conflict.
  // Registers the Phase 1 default (or whatever overlayKeybind already is);
  // the renderer's first overlay-settings-update push after login re-applies
  // the user's actual saved preference on top of this.
  registerOverlayShortcut(overlayKeybind)

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
