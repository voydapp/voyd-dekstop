const { app, BrowserWindow, shell, globalShortcut, ipcMain, Tray, Menu, nativeImage, session, screen, Notification, desktopCapturer, dialog, systemPreferences } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')
const gameDetection = require('./gameDetection')
const { setup: setupPushReceiver } = require('@superhuman/electron-push-receiver')

// Native key-hook dependency for push-to-talk (see PTT section below for why
// globalShortcut can't do this). Ships prebuilt N-API binaries for every
// platform/arch this app targets (win32-x64, darwin-x64/arm64, linux-x64) so
// there's no compile step -- but require() can still fail on some exotic
// host (an unsupported arch, a corrupted install), and PTT is a nice-to-have,
// not core functionality. Guarded so a failure here degrades to "PTT global
// hook unavailable" instead of taking the whole app down.
let uIOhook = null
let UiohookKey = null
try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'))
} catch (err) {
  console.error('[main] uiohook-napi unavailable -- push-to-talk global hook disabled:', err?.message)
}

// Minimal inline .env loader (KEY=VALUE per line, '#' comments, blank lines
// skipped) -- avoids an extra dependency for what's only ever two values.
// Never overwrites a var already set some other way.
function loadEnvFile(filePath) {
  let contents
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    logUpdate(`no .env found at ${filePath} -- GOOGLE_DEFAULT_CLIENT_ID/SECRET unset, push registration will fail until it's created`)
    return
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim()
  }
}

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

// Real, observed gap: an uncaught exception (e.g. tonight's "Object has
// been destroyed" crash calling a method on an already-closed mainWindow)
// previously only surfaced as an OS-level Electron error dialog, with
// nothing written to any log this project actually has tooling to read.
// Registered as early as possible so it also catches anything thrown
// during startup, not just once the window is up.
process.on('uncaughtException', (err) => {
  logUpdate('[uncaughtException] ' + (err?.stack || err?.message || err))
})

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
    // isDestroyed() check is defense-in-depth on top of the real fix
    // (mainWindow now gets reset to null on 'closed') -- belt and braces
    // against any other path that could still leave a stale reference.
    if (mainWindow && !mainWindow.isDestroyed()) {
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

// Root-cause fix for a real, observed failure: a second checkForUpdates()
// call fired (~1 minute into an in-flight install, cause not fully
// pinned down -- possibly a manual "check for updates" click, possibly a
// renderer reload) while the FIRST install's batch script was still
// waiting on the old process to exit. That second check re-downloaded to
// the same shared pending/VOYD.exe path out from under the first attempt,
// and the eventual copy failed 5/5 times against a file that had been
// rewritten mid-flight. Neither call site below previously checked
// whether an install was already staged or in progress before proceeding.
//
// Guards on downloadedFilePath (set only once THIS process's own
// update-downloaded fires, reset to null on every fresh process start),
// not on getExpectedDownloadPath()'s file existing on disk -- a stale
// leftover file from a past failed attempt must NOT permanently block
// every future check in a brand-new process, only a check racing an
// install already in flight within the SAME process.
function canCheckForUpdates() {
  if (isInstalling) {
    logUpdate('skipping update check: install already in progress')
    return false
  }
  if (downloadedFilePath) {
    logUpdate('skipping update check: a downloaded update is already staged and awaiting install')
    return false
  }
  return true
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

// Shared by the manual "click to install" path (header icon, kept for
// anyone who does notice it) and the automatic before-quit path below --
// previously only the manual click ever ran this, and almost nobody
// noticed the icon, so downloaded updates effectively never got applied.
// Guarded by isInstalling so both callers (and a before-quit re-entry once
// this function's own app.quit() fires) are safe to call unconditionally.
function performInstallUpdate() {
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
    //
    // Uses `ping -n N 127.0.0.1 >nul` for delays, not `timeout /t`, which is
    // a documented Windows gotcha: timeout tries to read the console input
    // buffer to let a keypress skip the wait, and can behave unreliably
    // when run detached/non-interactively (as this script always is) --
    // ping has no such dependency.
    const updateScript = path.join(path.dirname(targetExe), 'voyd-update.bat')
    const vbsLauncher = path.join(path.dirname(targetExe), 'voyd-update-launcher.vbs')
    const logPath = UPDATE_LOG_PATH
    const failMarkerPath = UPDATE_FAILURE_MARKER_PATH
    fs.writeFileSync(updateScript,
      `@echo off\r\n` +
      `setlocal enabledelayedexpansion\r\n` +
      `set LOGFILE="${logPath}"\r\n` +
      `set FAILMARKER="${failMarkerPath}"\r\n` +
      `set SRC="${downloadedFile}"\r\n` +
      `set DST="${targetExe}"\r\n` +
      `set VBS="${vbsLauncher}"\r\n` +
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
      `  ping -n 2 127.0.0.1 >nul\r\n` +
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
      `  ping -n 3 127.0.0.1 >nul\r\n` +
      `  goto copyloop\r\n` +
      `)\r\n` +
      `echo [%date% %time%] copy succeeded on attempt !copyattempt! >> %LOGFILE%\r\n` +
      `if exist %FAILMARKER% del %FAILMARKER%\r\n` +
      `del %SRC% >nul 2>&1\r\n` +
      `echo [%date% %time%] removed staged pending file >> %LOGFILE%\r\n` +
      `start "" %DST%\r\n` +
      `if exist %VBS% del %VBS%\r\n` +
      `del "%~f0"\r\n` +
      `exit /b 0\r\n` +
      `:fail\r\n` +
      `start "" %DST%\r\n` +
      `if exist %VBS% del %VBS%\r\n` +
      `del "%~f0"\r\n` +
      `exit /b 1\r\n`
    )
    // windowsHide on the outer spawn only hides THIS process's own window --
    // it does nothing about the console windows cmd.exe's own children
    // (tasklist, find, ping, copy) can independently flash, which is a
    // documented Windows/Node limitation, not something windowsHide can
    // reach into a batch script and fix. A VBScript wrapper using
    // WScript.Shell.Run(..., 0, False) is the standard, reliable way to
    // launch a batch file with its entire process tree genuinely hidden --
    // every child process a hidden-window cmd.exe spawns shares that same
    // hidden console rather than opening a new visible one of its own.
    fs.writeFileSync(vbsLauncher,
      `Set objShell = CreateObject("WScript.Shell")\r\n` +
      `objShell.Run Chr(34) & "${updateScript}" & Chr(34), 0, False\r\n`
    )
    logUpdate('spawning voyd-update.bat via hidden VBScript launcher: ' + vbsLauncher)
    require('child_process').spawn('wscript.exe', [vbsLauncher], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
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
}

ipcMain.on('install-update', () => {
  performInstallUpdate()
})

// Install automatically on the next natural quit instead of requiring the
// user to notice and click the header icon -- only fires when the user is
// already quitting (tray "Quit VOYD"), never mid-session: closing the main
// window alone just hides it to tray (see the window-close IPC handler)
// and doesn't reach here at all. Quitting already ends any active call
// regardless of whether an update happens to be staged, so this doesn't
// introduce a new interruption risk beyond what quitting already means.
//
// autoInstallOnAppQuit is deliberately left false -- that's
// electron-updater's own built-in quit-install mechanism, which doesn't
// know how to replace this portable build's permanent copy at
// CANONICAL_INSTALL_DIR (it's the "fallback" branch inside
// performInstallUpdate above, logged and left as a last resort, not treated
// as equivalent). The isInstalling guard inside performInstallUpdate makes
// the app.quit() it calls at the end safe to re-enter this same handler --
// on that second pass, isInstalling is already true, so it falls through
// and lets the real quit proceed.
app.on('before-quit', (event) => {
  if (isInstalling) return
  const hasStagedUpdate = (downloadedFilePath && fs.existsSync(downloadedFilePath)) || fs.existsSync(getExpectedDownloadPath())
  if (!hasStagedUpdate) return
  logUpdate('before-quit: staged update detected, installing automatically instead of a plain quit')
  event.preventDefault()
  performInstallUpdate()
})

// FIX 4: Version via IPC instead of executeJavaScript
ipcMain.handle('get-version', () => app.getVersion())

ipcMain.handle('get-portable-dir', () => ({
  portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  execPath: process.execPath
}))

// Manual update check from renderer
ipcMain.on('check-for-updates', () => {
  if (!canCheckForUpdates()) return
  autoUpdater.checkForUpdates()
})

// Web build version check -- separate from the app-itself autoUpdater above.
// mainWindow always loads https://joinvoyd.com/app live (this desktop app
// never bundles web assets), so a Coolify deploy to that site is invisible
// to electron-updater entirely -- it only knows about new *desktop app*
// releases. Real, observed bug: the custom window-close handler just hides
// to tray instead of quitting, and requestSingleInstanceLock means
// re-opening the icon/tray just shows the same already-running window
// rather than starting fresh -- none of those re-show paths ever reload,
// so the renderer can keep running JS from long before the latest web
// deploy indefinitely. There's no push signal for a web deploy, so this
// polls for the one thing already used tonight to hand-confirm a deploy had
// gone live: the content-hashed bundle filename in /app's HTML (e.g.
// /assets/index-FbTKZLVi.js) -- a changed hash means new JS is live that
// this renderer has not loaded.
const VERSION_CHECK_INTERVAL_MS = 10 * 60 * 1000 // not latency sensitive -- no reason to poll more often than this

let knownBundleHash = null   // the hash this renderer actually has loaded (the "known good" baseline)
let lastPromptedHash = null  // last hash already prompted about -- kept separate from knownBundleHash so picking "Later" doesn't re-nag every single poll for the same deploy, only on the NEXT distinct hash change
let versionCheckStarted = false
let lastVoiceState = null    // see isInVoiceCall() below

// Plain global fetch (Electron 40's bundled Node has it built in), not
// routed through voydSession/'persist:voyd' the way mainWindow's own
// requests are -- that partition's cookie jar and the CSP override
// registered on it further down are both scoped to mainWindow's
// webContents, not to this process's own fetch calls, so neither applies
// or matters here. All that's needed is the same public, unauthenticated
// /app HTML a plain browser would get, just to read the bundle filename
// out of it.
async function fetchLiveBundleHash() {
  try {
    const res = await fetch('https://joinvoyd.com/app')
    if (!res.ok) {
      logUpdate(`[version-check] fetch returned HTTP ${res.status}`)
      return null
    }
    const html = await res.text()
    const match = html.match(/\/assets\/index-[^"]+\.js/)
    return match ? match[0] : null
  } catch (e) {
    // Network hiccup / transient DNS issue -- just try again next interval,
    // this must never throw unhandled or take down the main process.
    logUpdate('[version-check] fetch failed: ' + (e?.message || e))
    return null
  }
}

// The one existing signal in this process for "a call is active right now":
// the renderer's VoiceContext already pushes its own voice state here (see
// voice-state-update below) purely to relay to the overlay window, and sets
// channelName back to null when the user leaves. Reused as-is rather than
// adding any new renderer->main IPC just for this dialog.
function isInVoiceCall() {
  return !!lastVoiceState?.channelName
}

// Guards the dialog itself, not just the hash bookkeeping. Without this, a
// dialog left open across a poll boundary (10 min is easily longer than a
// user takes to notice a background window) let a second, later poll open a
// SECOND dialog.showMessageBox on the same mainWindow. Windows stacks those
// silently -- the older one keeps waiting on its own unresolved promise
// underneath the newer one. Clicking "Reload Now" on the dialog actually
// visible only ever resolves the top one; the other stays pending and pops
// back up the moment the first is dismissed, which matches the reported
// "dialog keeps recurring and Reload Now does nothing." Found by code
// inspection (no re-entrancy guard existed anywhere on this path) -- not
// independently reproduced live, since the actual bug requires two genuine
// production hash changes spanning a >10min gap with the dialog left open.
let updatePromptOpen = false

async function checkForNewWebBuild() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (updatePromptOpen) return

  const hash = await fetchLiveBundleHash()
  if (!hash) return

  if (!knownBundleHash) {
    // Baseline wasn't established yet (e.g. the initial fetch on load
    // failed) -- establish it now rather than comparing against nothing.
    knownBundleHash = hash
    logUpdate('[version-check] baseline bundle hash established: ' + hash)
    return
  }

  if (hash === knownBundleHash) return
  if (hash === lastPromptedHash) return // already asked about this exact deploy -- don't nag every poll

  if (isInVoiceCall()) {
    logUpdate('[version-check] new build detected but deferring prompt -- voice call in progress')
    return
  }

  lastPromptedHash = hash
  logUpdate(`[version-check] new build detected (${knownBundleHash} -> ${hash}), prompting user`)

  updatePromptOpen = true
  let response
  try {
    ;({ response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Reload Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: 'A new version of VOYD is available.',
      detail: 'Reload now to get the latest version, or keep working and reload later.',
    }))
  } finally {
    updatePromptOpen = false
  }

  if (response === 0) {
    logUpdate('[version-check] user chose Reload Now -- reloading')
    knownBundleHash = hash
    mainWindow.webContents.reload()
  } else {
    logUpdate('[version-check] user chose Later -- will not re-prompt until the next distinct hash change')
  }
}

function startVersionCheckPolling() {
  if (versionCheckStarted) return
  versionCheckStarted = true
  setInterval(() => {
    checkForNewWebBuild().catch((e) => logUpdate('[version-check] unexpected error: ' + (e?.message || e)))
  }, VERSION_CHECK_INTERVAL_MS)
}

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
  lastVoiceState = state // also used by isInVoiceCall() to defer the web-build reload prompt during a call
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

// Phase 3 — Streamer Mode. Persisted per-account (user_settings.streamer_mode),
// pushed here the same way as keybind/position. Scope is overlay-visibility
// suppression ONLY: it never touches the keybind, position, or anything else.
// createOverlayWindow() already always creates the window with show:false, so
// there is nothing extra to do for "starts hidden on launch" today — the
// actual job of this flag is gating any FUTURE automatic-show call (see
// autoShowOverlayWindow below) so a later feature can't accidentally defeat
// Streamer Mode just by forgetting to check it.
let streamerMode = false

// Phase 4 — Camera Tiles. Mirrors the DB default (overlay_show_camera_tiles
// defaults true, opt-out) until the renderer's first settings push arrives.
// Kept here as a defense-in-depth gate on the RELAY side too (see
// camera-frames-update below) — the renderer already gates capture at the
// source when this is off, but the overlay must never trust the sender
// alone to have done that.
let overlayShowCameraTiles = true

// user_keybinds sync (Settings > Keybinds tab). Two actions genuinely need
// OS-level global registration (must fire while a game/other app has OS
// focus, same reason overlayKeybind is global): toggle_mute, toggle_deafen.
// The rest (quick_switcher, navigate_up, navigate_down) only ever needed to
// work while VOYD itself is focused, matching the existing focus/blur
// register-on-demand pattern below -- kept that way rather than promoting
// them to always-global, which would let them clash with other apps'
// shortcuts the moment VOYD is in the background.
//
// push_to_talk is deliberately NOT included here: Electron's globalShortcut
// only fires on key-down, with no matching key-up/release event, so it
// cannot express "hold" semantics -- there is no accelerator-based way to
// know when the user lets go. Handled instead by the uIOhook-based PTT
// section further down, which is a genuinely separate mechanism (a raw
// key-hook, not an accelerator registration) rather than a variant of this
// table.
const GLOBAL_KEYBIND_ACTIONS = ['toggle_mute', 'toggle_deafen']
const FOCUS_ONLY_KEYBIND_ACTIONS = ['quick_switcher', 'navigate_up', 'navigate_down']

// Hardcoded fallbacks -- same "brief window before the renderer's first
// push arrives, or a fresh install with no saved rows yet" role as
// overlayKeybind above. Matches this table's pre-existing hardcoded
// defaults so a user who has never touched Settings > Keybinds sees no
// behavior change.
const globalKeybindAccelerators = {
  toggle_mute: 'CommandOrControl+Shift+M',
  toggle_deafen: 'CommandOrControl+Shift+D',
}
const focusOnlyKeybindAccelerators = {
  quick_switcher: 'CommandOrControl+K',
  navigate_up: 'Alt+Up',
  navigate_down: 'Alt+Down',
}

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

// Manual toggle — the keybind. Deliberately bypasses Streamer Mode entirely:
// per the Phase 3 spec, Streamer Mode only removes AUTOMATIC default
// visibility, it never disables manual control. A streamer can always bring
// the overlay up mid-session via this same keybind, Streamer Mode or not.
function toggleOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (overlayWindow.isVisible()) {
    overlayWindow.hide()
  } else {
    // showInactive, not show — the overlay must never steal focus from the game underneath.
    overlayWindow.showInactive()
  }
}

// The ONE path any future automatic/conditional overlay-show trigger should
// call (e.g. a later "show on voice activity" or "show on notification"
// feature) — never call overlayWindow.showInactive() directly for a
// non-manual reason. Streamer Mode suppresses it unconditionally; the manual
// keybind (toggleOverlayWindow above) is the one thing it never touches.
// No current call site uses this yet (Phase 1/2 never auto-show), but it
// exists now so Streamer Mode is safe by construction for whatever gets
// built next, rather than something every future feature has to remember.
function autoShowOverlayWindow() {
  if (streamerMode) return
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.showInactive()
}

// Re-registerable so a keybind change while the app is running takes effect
// immediately, no restart. Registers the NEW accelerator before unregistering
// the old one — if the new one is invalid or already claimed by something
// else on the OS, globalShortcut.register returns false and the existing
// binding is left alone rather than leaving the user with no overlay
// shortcut at all.
function registerOverlayShortcut(accelerator) {
  if (accelerator === overlayKeybind && globalShortcut.isRegistered(accelerator)) return true

  // globalShortcut.register() has two distinct failure modes: an accelerator
  // that's syntactically valid but already claimed (by this app or another)
  // returns false, but one containing a token its parser doesn't recognize
  // at all (e.g. a stale saved value using a DOM key name like 'ArrowUp'
  // instead of Electron's 'Up') throws synchronously instead. Both are
  // treated the same way here -- leave the existing binding alone -- rather
  // than letting the throw propagate past the !registered check below.
  let registered = false
  try {
    registered = globalShortcut.register(accelerator, toggleOverlayWindow)
  } catch (err) {
    console.error('[main] overlay keybind registration threw (unrecognized accelerator):', accelerator, err?.message)
  }
  if (!registered) {
    console.error('[main] overlay keybind registration failed (invalid or already in use):', accelerator)
    return false
  }
  if (overlayKeybind && overlayKeybind !== accelerator) {
    // Same unrecognized-token-throws behavior as register() -- guarded so a
    // stale bad overlayKeybind value can't abort this function before
    // overlayKeybind gets reassigned below (which would leave the new
    // accelerator registered at the OS level but never reflected in state,
    // and the old one never actually released).
    try {
      globalShortcut.unregister(overlayKeybind)
    } catch (err) {
      console.error('[main] overlay keybind unregistration threw (unrecognized accelerator):', overlayKeybind, err?.message)
    }
  }
  overlayKeybind = accelerator
  return true
}

// Same register-new-before-unregister-old safety as registerOverlayShortcut:
// an invalid or OS-claimed accelerator leaves the previous binding intact
// instead of leaving the action with no shortcut at all.
function registerGlobalKeybind(action, accelerator) {
  if (accelerator === globalKeybindAccelerators[action] && globalShortcut.isRegistered(accelerator)) return true

  // See registerOverlayShortcut's comment above -- an unrecognized-token
  // accelerator throws instead of returning false, and needs the same
  // "leave the existing binding alone" treatment.
  let registered = false
  try {
    registered = globalShortcut.register(accelerator, () => {
      mainWindow?.webContents.send('keybind', action)
    })
  } catch (err) {
    console.error('[main] keybind registration threw (unrecognized accelerator):', action, accelerator, err?.message)
  }
  if (!registered) {
    console.error('[main] keybind registration failed (invalid or already in use):', action, accelerator)
    return false
  }
  const previous = globalKeybindAccelerators[action]
  if (previous && previous !== accelerator) {
    // See registerOverlayShortcut's matching unregister guard above.
    try {
      globalShortcut.unregister(previous)
    } catch (err) {
      console.error('[main] keybind unregistration threw (unrecognized accelerator):', action, previous, err?.message)
    }
  }
  globalKeybindAccelerators[action] = accelerator
  return true
}

// FIX 7 (moved to module scope so it's reachable from user-keybinds-update
// below, not just from inside createWindow): local shortcuts only active
// while the VOYD window itself is focused. quick_switcher/navigate_up/
// navigate_down read the user's saved combo; open_settings and the two
// navigate_unread_* actions aren't user-configurable (no user_keybinds row
// for them) and stay on their original hardcoded combos.
function getLocalShortcutsList() {
  return [
    { key: focusOnlyKeybindAccelerators.quick_switcher, action: 'quick_switcher' },
    { key: 'CommandOrControl+,', action: 'open_settings' },
    { key: focusOnlyKeybindAccelerators.navigate_up, action: 'navigate_up' },
    { key: focusOnlyKeybindAccelerators.navigate_down, action: 'navigate_down' },
    { key: 'Alt+Shift+Up', action: 'navigate_unread_up' },
    { key: 'Alt+Shift+Down', action: 'navigate_unread_down' },
  ]
}

function registerLocalShortcuts() {
  getLocalShortcutsList().forEach(({ key, action }) => {
    // Per-binding try/catch is load-bearing here, not just tidiness: an
    // unrecognized-token accelerator (see registerOverlayShortcut's comment)
    // throws synchronously, and .forEach() does not catch exceptions from
    // its callback -- an uncaught throw on any one entry aborts the entire
    // loop, silently skipping every entry after it in getLocalShortcutsList's
    // fixed order, not just the bad one. Confirmed live: a saved navigate_up
    // accelerator of 'ArrowUp' (a DOM key name, not a valid Electron
    // accelerator token) broke navigate_down and both navigate_unread_*
    // shortcuts too, every single time this ran (on launch and on every
    // window focus), with nothing surfaced anywhere.
    try {
      globalShortcut.register(key, () => {
        mainWindow?.webContents.send('keybind', action)
      })
    } catch (err) {
      console.error('[main] local shortcut registration threw (unrecognized accelerator) -- other shortcuts still applied:', action, key, err?.message)
    }
  })
}

function unregisterLocalShortcuts() {
  getLocalShortcutsList().forEach(({ key }) => {
    // Same throw-on-unrecognized-token behavior as register() (see
    // registerLocalShortcuts above) -- confirmed live: unregister('ArrowUp')
    // throws too, and this runs on every window 'blur' event, so a bad saved
    // accelerator was firing an uncaught exception on every single focus
    // change, not just once. Same per-binding guard for the same reason.
    try {
      globalShortcut.unregister(key)
    } catch (err) {
      console.error('[main] local shortcut unregistration threw (unrecognized accelerator) -- other shortcuts still applied:', key, err?.message)
    }
  })
}

// Renderer pushes the user's saved user_keybinds rows here (useDesktopKeybindsSync,
// on load and after every Settings > Keybinds save). Applies live, no restart --
// same reasoning as overlay-settings-update below.
ipcMain.on('user-keybinds-update', (_event, keybinds) => {
  if (!Array.isArray(keybinds)) return

  // Unregister focus-only shortcuts using the CURRENT (old) accelerators
  // before mutating focusOnlyKeybindAccelerators below -- otherwise
  // unregister() would be called with the already-new key, which was never
  // registered, silently leaking the real old registration.
  const wasFocused = !!mainWindow?.isFocused()
  if (wasFocused) unregisterLocalShortcuts()

  for (const kb of keybinds) {
    if (!kb || kb.is_enabled === false || !kb.key_combination) continue

    if (GLOBAL_KEYBIND_ACTIONS.includes(kb.action)) {
      // registerGlobalKeybind does its own old/new swap internally --
      // safe regardless of focus state, since these are always registered.
      registerGlobalKeybind(kb.action, kb.key_combination)
    } else if (FOCUS_ONLY_KEYBIND_ACTIONS.includes(kb.action)) {
      focusOnlyKeybindAccelerators[kb.action] = kb.key_combination
    }
  }

  if (wasFocused) registerLocalShortcuts()
})

// ── Push-to-talk (uIOhook global key hook) ──────────────────────────────────
//
// Why this can't reuse the globalShortcut table above: PTT needs to know the
// instant the key is RELEASED, not just that it was pressed. globalShortcut
// only ever fires once per press with no matching release event -- there is
// no accelerator API for "and tell me when they let go". uIOhook is a raw
// low-level key hook (keydown AND keyup, like a game's input layer) that
// works whether or not any Electron window has OS focus, same requirement
// overlayKeybind/toggle_mute/toggle_deafen have. It's intentionally NOT
// merged into the 'keybind' IPC channel those use: that channel is a single
// fire-once action string (mainWindow.send('keybind', 'toggle_mute')) with
// no notion of a press/release pair, and PTT's state (is the key currently
// held) lives entirely in the renderer's VoiceContext already -- forcing PTT
// through the same channel would mean inventing 'push_to_talk_down' /
// 'push_to_talk_up' pseudo-actions on a channel modeled around a different
// shape, for no real benefit. A dedicated 'push-to-talk' channel carrying a
// boolean is a truer fit and keeps the two mechanisms from being confused
// with each other.
//
// Only started/stopped on demand (not left running for the app's whole
// lifetime) for two reasons: it's a global key-hook, so idling it whenever
// PTT is off is the considerate default privacy/perf-wise, and starting it
// is also the trigger point for the macOS Accessibility permission check
// below -- we want that check to happen right when it's actually needed
// (PTT turned on), not unconditionally on every launch.
let pttEnabled = false
let pttUiohookKeycode = null // resolved via domCodeToUiohookKey, or null if unmapped/unset
let pttKeyIsDown = false // suppresses OS key-repeat re-firing 'down' on every autorepeat tick
let uiohookRunning = false

// push_to_talk_key (Settings > Voice) is stored as a browser
// KeyboardEvent.code string (e.g. 'Space', 'KeyA', 'Digit1', 'F5') -- see
// PttKeyBinder in UserSettingsPanel.tsx. uIOhook's UiohookKey enum uses its
// own naming, but for the overwhelming majority of keys the names are
// identical to the DOM `code` value (Space, ArrowUp, F1-F24, Numpad*,
// punctuation names like Semicolon/Comma/Slash all match as-is). The only
// systematic mismatches: DOM prefixes letters/digits with Key/Digit
// ('KeyA', 'Digit5'), and DOM's Left-side modifier names carry a 'Left'
// suffix uIOhook doesn't use ('ControlLeft' -> Ctrl, not CtrlLeft). PTT can
// never actually be bound to a bare modifier key (PttKeyBinder's recorder
// filters out a lone Control/Shift/Alt/Meta press while listening), but the
// map below covers them anyway rather than leaving a silent gap.
const PTT_MODIFIER_CODE_MAP = {
  ControlLeft: 'Ctrl', ControlRight: 'CtrlRight',
  AltLeft: 'Alt', AltRight: 'AltRight',
  ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
  MetaLeft: 'Meta', MetaRight: 'MetaRight',
}

function domCodeToUiohookKey(code) {
  if (!code || !UiohookKey) return null
  if (/^Key[A-Z]$/.test(code)) return UiohookKey[code.slice(3)] ?? null
  if (/^Digit[0-9]$/.test(code)) return UiohookKey[code.slice(5)] ?? null
  if (PTT_MODIFIER_CODE_MAP[code]) return UiohookKey[PTT_MODIFIER_CODE_MAP[code]] ?? null
  return UiohookKey[code] ?? null
}

// macOS gates any global key-capture behind Accessibility (or, on newer
// macOS, Input Monitoring, which the same Accessibility trust check covers
// for CGEventTap-based hooks like libuiohook's) -- without it, uIOhook.start()
// does not throw or error, it just runs and silently receives no events. That
// silent-failure shape is exactly what the renderer needs to be able to tell
// apart from "PTT is on and working": startUiohookIfNeeded() below checks
// permission BEFORE starting and tells the renderer explicitly when it's
// blocked on this, rather than starting anyway and leaving the user to
// wonder why holding the key does nothing. Windows and Linux have no
// equivalent gate -- isAccessibilityGated() is false there and this whole
// path is skipped.
function isAccessibilityGated() {
  return process.platform === 'darwin'
}

function hasAccessibilityPermission() {
  if (!isAccessibilityGated()) return true
  return systemPreferences.isTrustedAccessibilityClient(false)
}

function startUiohookIfNeeded() {
  if (uiohookRunning || !uIOhook) return
  if (isAccessibilityGated() && !hasAccessibilityPermission()) {
    mainWindow?.webContents.send('push-to-talk-permission-needed')
    return
  }
  try {
    uIOhook.start()
    uiohookRunning = true
  } catch (err) {
    console.error('[main] uIOhook.start() failed -- push-to-talk will not fire:', err?.message)
  }
}

function stopUiohookIfRunning() {
  if (!uiohookRunning || !uIOhook) return
  uIOhook.stop()
  uiohookRunning = false
  pttKeyIsDown = false
}

function applyPushToTalkState() {
  if (pttEnabled && pttUiohookKeycode != null) {
    startUiohookIfNeeded()
  } else {
    stopUiohookIfRunning()
  }
}

// Matches on keycode only, ignoring e.ctrlKey/shiftKey/altKey/metaKey --
// correct for a PTT key, which is always a single physical key (never a
// modifier combo, see domCodeToUiohookKey's comment above), the same way a
// game's "hold to talk" binding cares only about the key, not what else is
// held alongside it. This can never fight with globalShortcut's OS-level
// hotkey registrations (toggle_mute's Ctrl+Shift+M, etc.): uIOhook is a
// passive raw-input tap (CGEventTap / WH_KEYBOARD_LL / XRecord depending on
// platform), not a hotkey claim, so it never blocks or is blocked by
// whatever globalShortcut has registered -- they observe the same key
// events through entirely separate OS mechanisms. The one thing to be aware
// of: if a user's PTT key happens to be a bare key that's also part of
// another combo they've bound (e.g. PTT on 'M' while toggle_mute is still
// Ctrl+Shift+M), pressing that combo fires BOTH -- expected given PTT is
// modifier-agnostic by design, not a bug in either mechanism.
if (uIOhook) {
  uIOhook.on('keydown', (e) => {
    if (!pttEnabled || pttUiohookKeycode == null || e.keycode !== pttUiohookKeycode) return
    if (pttKeyIsDown) return // key-repeat autofire while held -- already told the renderer once
    pttKeyIsDown = true
    mainWindow?.webContents.send('push-to-talk', true)
  })
  uIOhook.on('keyup', (e) => {
    if (!pttEnabled || pttUiohookKeycode == null || e.keycode !== pttUiohookKeycode) return
    if (!pttKeyIsDown) return
    pttKeyIsDown = false
    mainWindow?.webContents.send('push-to-talk', false)
  })
}

// Renderer pushes { enabled, key } here (useDesktopPushToTalkSync) on load
// and on every Settings > Voice change to push_to_talk / push_to_talk_key.
// A key that fails to resolve (domCodeToUiohookKey returns null -- shouldn't
// happen for anything PttKeyBinder can actually record, but a DB row could
// in principle hold something stale) leaves the hook stopped rather than
// starting it with a keycode of null, which would silently never match
// any real key event.
ipcMain.on('push-to-talk-settings-update', (_event, settings) => {
  pttEnabled = !!settings?.enabled
  pttUiohookKeycode = pttEnabled ? domCodeToUiohookKey(settings?.key) : null
  applyPushToTalkState()
})

// Settings UI's permission prompt (shown after a 'push-to-talk-permission-needed'
// push above) calls this on its "Retry" action -- re-checks current trust
// status and, if now granted, actually starts the hook rather than making
// the user re-toggle the PTT setting off/on to retrigger applyPushToTalkState.
ipcMain.handle('push-to-talk-recheck-permission', () => {
  const granted = hasAccessibilityPermission()
  if (granted) applyPushToTalkState()
  return granted
})

// Triggers macOS's native "VOYD would like to control this computer using
// Accessibility features" system prompt (only fires once per app install --
// isTrustedAccessibilityClient(true) is a no-op if the user already
// answered it, which is exactly why the Settings UI also needs the
// System Settings deep-link below for the retry path after a denial).
ipcMain.handle('push-to-talk-request-permission', () => {
  if (!isAccessibilityGated()) return true
  return systemPreferences.isTrustedAccessibilityClient(true)
})

ipcMain.on('push-to-talk-open-system-settings', () => {
  if (process.platform !== 'darwin') return
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
})

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
  if (typeof settings?.streamerMode === 'boolean' && settings.streamerMode !== streamerMode) {
    streamerMode = settings.streamerMode

    // Decision: switching Streamer Mode ON force-hides the overlay
    // immediately if it happens to be visible right now, rather than only
    // taking effect on the next launch. Streamer Mode is a privacy control —
    // someone flipping it on almost always means "hide this right now,
    // I need it off screen this instant" (e.g. they just realized they're
    // live), not "hide it starting next time I open the app." Waiting for a
    // restart would leave exactly the content they just asked to suppress
    // on screen at the one moment it matters most. This mirrors the existing
    // pattern in this handler: keybind/position changes already apply live,
    // no restart required.
    //
    // Turning it OFF is the mirror case and does NOT force-show anything —
    // it only lifts the suppression going forward. The overlay stays exactly
    // as visible/hidden as it already was; the user can always bring it up
    // with the keybind if they want it.
    if (streamerMode && overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide()
    }
  }
  if (typeof settings?.showCameraTiles === 'boolean' && settings.showCameraTiles !== overlayShowCameraTiles) {
    overlayShowCameraTiles = settings.showCameraTiles
    // Clear any tiles already on screen the instant this turns off, rather
    // than leaving stale frames visible until the next camera-frames-update
    // tick (which won't come — the renderer stops sending as soon as it
    // sees the same setting change). Turning it back on doesn't need an
    // equivalent push here: the renderer's own capture loop naturally
    // resumes sending real frames on its next tick.
    if (!overlayShowCameraTiles) {
      overlayWindow?.webContents.send('camera-frames', [])
    }
  }
})

// Phase 4 — camera tile frames. The renderer (which has the real LiveKit/
// Agora video elements) captures a low-res JPEG snapshot per camera-sharing
// participant and pushes the whole set here each tick; we just relay it to
// the overlay window, same split as voice-state-update. overlayShowCameraTiles
// is checked again here (defense in depth) even though the renderer already
// gates its own capture loop on the same setting — the overlay must never
// depend solely on the sender having done that.
ipcMain.on('camera-frames-update', (_event, frames) => {
  if (!overlayShowCameraTiles) return
  overlayWindow?.webContents.send('camera-frames', Array.isArray(frames) ? frames : [])
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
      // Own in-memory session, deliberately not mainWindow's 'persist:voyd'
      // session — keeps it out of reach of the CSP/permission/display-media
      // overrides below, which are scoped to that partition and target
      // joinvoyd.com, not this window's local static content.
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

// Windows/Linux screen-share source picker -- useSystemPicker (macOS 15+
// only) is a no-op on these platforms, so setDisplayMediaRequestHandler's
// fallback would otherwise silently auto-pick the first available source
// with no user choice at all. This shows a real chooser with real
// thumbnails and only resolves once the user actually picks something
// (or cancels, which resolves null). Does not affect the macOS path.
function showSourcePicker(sources) {
  return new Promise((resolve) => {
    const pickerWindow = new BrowserWindow({
      width: 760,
      height: 560,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      title: 'Choose what to share',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'source-picker-preload.js'),
        // Own in-memory session, same isolation reasoning as overlayWindow.
        partition: 'source-picker-window',
      },
    })

    let settled = false
    const finish = (sourceId) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('source-picker-select', onSelect)
      ipcMain.removeListener('source-picker-cancel', onCancel)
      if (!pickerWindow.isDestroyed()) pickerWindow.close()
      resolve(sourceId)
    }
    const onSelect = (_event, sourceId) => finish(sourceId)
    const onCancel = () => finish(null)

    ipcMain.on('source-picker-select', onSelect)
    ipcMain.on('source-picker-cancel', onCancel)
    pickerWindow.on('closed', () => finish(null))

    pickerWindow.loadFile(path.join(__dirname, 'source-picker.html'))
    pickerWindow.webContents.once('did-finish-load', () => {
      const payload = sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
      }))
      pickerWindow.webContents.send('source-picker-sources', payload)
    })
  })
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
    {
      // Manual fallback the user can always reach regardless of the
      // periodic web-build version check above -- e.g. if the poll hasn't
      // fired yet, or a call is deferring its prompt.
      label: 'Reload',
      click: () => mainWindow?.webContents.reload()
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

  // Must be registered before the renderer's START_NOTIFICATION_SERVICE send
  // (on did-finish-load) -- electron-push-receiver implements FCM's own
  // registration/MCS protocol directly over Node, since Electron's Chromium
  // build has no Push API/PushManager (getToken()'s pushManager.subscribe()
  // always throws AbortError there, confirmed via electron/electron#6697).
  setupPushReceiver(mainWindow.webContents)

  mainWindow.loadURL('https://joinvoyd.com/app')

  // Real crash fixed here: mainWindow was never reset to null when the
  // window closed (unlike overlayWindow, which already does this), so any
  // later code touching the stale reference -- e.g. second-instance below --
  // could throw "Object has been destroyed" calling a method on an already-
  // destroyed native window, an uncaught exception that crashed the whole
  // main process with no window ever opening. Every mainWindow?.foo call
  // elsewhere in this file becomes a safe no-op once this actually runs.
  mainWindow.on('closed', () => { mainWindow = null })

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

  // Packaged builds have DevTools disabled entirely (see the toggle below),
  // so renderer-side console.error/warn (e.g. VoiceContext's screen-share
  // error logging) is otherwise completely invisible -- there is no other
  // way to see it. Routed into the same durable log file the updater uses
  // rather than a separate one, since the tooling to read it already
  // exists. level: 0=verbose,1=info,2=warning,3=error, per this Electron
  // version's own MessageDetails type (checked directly against
  // node_modules/electron/electron.d.ts, not assumed) -- only capturing
  // warning/error so routine app chatter doesn't drown it out.
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (details.level >= 2) {
      logUpdate(`[renderer console] ${details.message} (${details.sourceUrl}:${details.lineNumber})`)
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    reloadIfNotLooping('renderer unresponsive')
  })

  const VOYD_CSP = [
    "default-src 'self' https://joinvoyd.com https://*.joinvoyd.com",
    // https://www.gstatic.com is required here (not just connect-src) because
    // /firebase-messaging-sw.js runs importScripts() against two gstatic.com
    // URLs -- importScripts inside a service worker is governed by script-src,
    // not worker-src (worker-src only gates the SW's own registration URL,
    // which is same-origin). Without this, this session's own CSP override
    // silently blocked those imports, throwing inside the SW's top-level
    // script and surfacing as "ServiceWorker script evaluation failed" --
    // invisible to a plain curl/browser check since nginx sends no CSP at all;
    // this session-level override is Electron-only.
    // cdn.jsdelivr.net is @livekit/track-processors' background-blur path:
    // BackgroundTransformer.init() loads @mediapipe/tasks-vision's wasm
    // loader script from there (FilesetResolver.forVisionTasks) -- without
    // it, that load is blocked outright and blur fails immediately, before
    // any model/segmentation code runs.
    "script-src 'self' https://joinvoyd.com https://*.joinvoyd.com 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com https://www.gstatic.com https://cdn.jsdelivr.net",
    // connect-src previously allowed https://*.joinvoyd.com but never the wss:
    // scheme for that same wildcard -- CSP schemes are matched independently,
    // so a wildcard covering the https: version of a domain does NOT also
    // cover wss: to it. VOYD self-hosts LiveKit at voice.joinvoyd.com (a
    // subdomain, not the *.agora.io/*.livekit.io third-party hosts already
    // listed below), which was a real, total block on voice chat.
    // firebaseinstallations/fcmregistrations are the two Google endpoints
    // firebase/messaging's getToken() itself fetches -- needed once SW
    // registration succeeds, or getToken() fails next with its own CSP block.
    // cdn.jsdelivr.net (again, for the wasm binary itself, fetched not
    // script-tag-loaded) and storage.googleapis.com (the actual
    // selfie_segmenter .tflite model binary ImageSegmenter fetches) are the
    // other two hosts BackgroundTransformer.init() hits for background blur.
    "connect-src 'self' https://joinvoyd.com https://*.joinvoyd.com wss://*.joinvoyd.com https://*.supabase.co wss://*.supabase.co wss://fjvijrbfbzdjsyiwqwfd.supabase.co https://*.agora.io wss://*.agora.io https://livekit.io wss://*.livekit.io https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com https://cdn.jsdelivr.net https://storage.googleapis.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    // style-src is a strict allowlist (unlike font-src/img-src below, which
    // already allow broad https:), so Google Fonts' stylesheet host needs an
    // explicit entry -- font-src's existing https: wildcard already covers
    // the actual font files from fonts.gstatic.com, so no change needed there.
    "style-src 'self' 'unsafe-inline' https://joinvoyd.com https://*.joinvoyd.com https://fonts.googleapis.com",
    "font-src 'self' data: https:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:"
  ].join('; ')

  // Real bug fixed here: mainWindow's webPreferences.partition ('persist:voyd')
  // makes it use a session.fromPartition() instance, NOT session.defaultSession --
  // these are separate Session objects in Electron. Every handler below was
  // previously registered on session.defaultSession, which mainWindow's actual
  // webContents never touches, so none of them ever fired for this window. This
  // was the real, confirmed (zero [screenshare] log lines ever, across every
  // real attempt) root cause of screen sharing's NotSupportedError -- registering
  // a display-media handler on the wrong session is equivalent to not
  // registering one at all.
  const voydSession = session.fromPartition('persist:voyd')

  voydSession.webRequest.onHeadersReceived((details, callback) => {
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
  voydSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = ['media', 'notifications']
    callback(allowedPermissions.includes(permission))
  })

  // Screen sharing has never worked in this app -- getDisplayMedia() (which
  // LiveKit's setScreenShareEnabled calls) rejects immediately in Electron
  // unless a handler is explicitly registered here; setPermissionRequestHandler
  // above only gates plain getUserMedia (mic/camera), a separate permission
  // path that was already correctly wired.
  //
  // useSystemPicker is documented as macOS 15+ only and experimental --
  // verified directly against Electron's docs, not assumed. It does NOT
  // delegate to Windows' Graphics Capture picker or anything else on
  // Windows; on that platform it's simply a no-op and the handler below
  // always runs. Left enabled (harmless, correct for macOS) -- the branch
  // below is an ADDITIONAL Windows/Linux-specific in-app picker, not a
  // replacement for the macOS system picker, which stays exactly as it was.
  voydSession.setDisplayMediaRequestHandler((request, callback) => {
    logUpdate(`[screenshare] handler invoked, videoRequested=${request?.videoRequested} audioRequested=${request?.audioRequested}`)
    desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } })
      .then((sources) => {
        logUpdate(`[screenshare] desktopCapturer found ${sources.length} source(s): ${sources.map((s) => s.id).join(', ')}`)

        // macOS: useSystemPicker above already handles the real UI in the
        // normal case, so this path is only a rare fallback there --
        // unchanged, same auto-pick-first-screen behavior as before.
        if (process.platform === 'darwin') {
          const fallback = sources.find((s) => s.id.startsWith('screen:')) || sources[0]
          callback(fallback ? { video: fallback, audio: 'loopback' } : {})
          return
        }

        // Windows/Linux: useSystemPicker is a no-op, so this is genuinely
        // always what runs -- show a real in-app chooser instead of
        // auto-picking. Only calls back once the user actually chooses.
        if (sources.length === 0) {
          logUpdate('[screenshare] no sources available at all -- calling back with empty streams')
          callback({})
          return
        }
        showSourcePicker(sources)
          .then((chosenId) => {
            const chosen = sources.find((s) => s.id === chosenId)
            if (!chosen) {
              logUpdate('[screenshare] user cancelled the source picker')
              callback({})
              return
            }
            logUpdate(`[screenshare] user picked source: ${chosen.id} (${chosen.name})`)
            callback({ video: chosen, audio: 'loopback' })
          })
      })
      .catch((err) => {
        logUpdate(`[screenshare] desktopCapturer.getSources failed: ${err?.message || err}`)
        callback({})
      })
  }, { useSystemPicker: true })

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
  // Global shortcuts for mute/deafen (need to work when window is unfocused).
  // Registers the Phase-1-style hardcoded defaults; the renderer's first
  // user-keybinds-update push (useDesktopKeybindsSync) re-applies the user's
  // actual saved combo on top of this, same pattern as registerOverlayShortcut.
  registerGlobalKeybind('toggle_mute', globalKeybindAccelerators.toggle_mute)
  registerGlobalKeybind('toggle_deafen', globalKeybindAccelerators.toggle_deafen)

  // FIX 7: Local shortcuts for app-specific actions (only active when window is focused).
  // registerLocalShortcuts/unregisterLocalShortcuts are module-level now (see
  // user-keybinds-update above) so they can be re-applied live on a combo change.
  mainWindow.on('focus', registerLocalShortcuts)
  mainWindow.on('blur', unregisterLocalShortcuts)

  // Register immediately if window is already focused
  if (mainWindow.isFocused()) registerLocalShortcuts()

  // Check for updates after load
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!canCheckForUpdates()) return
      autoUpdater.checkForUpdatesAndNotify()
    }, 5000)

    // Establish the web-build "known good" bundle hash baseline right after
    // the first successful load -- see the Web build version check section
    // above. Re-fetched fresh via Node rather than trusting anything read
    // out of this webContents directly, so the baseline reflects the actual
    // HTTP response, not whatever the renderer happens to believe.
    fetchLiveBundleHash().then((hash) => {
      if (hash) {
        knownBundleHash = hash
        logUpdate('[version-check] baseline bundle hash: ' + hash)
      } else {
        logUpdate('[version-check] could not establish baseline bundle hash on startup -- will retry on next poll')
      }
      startVersionCheckPolling()
    })
  })
}

// GOOGLE_API_KEY/GOOGLE_DEFAULT_CLIENT_ID/GOOGLE_DEFAULT_CLIENT_SECRET are Chromium
// env vars for its own Google integrations (sync, Safe Browsing, etc.) -- NOT what
// fixes push notifications. Electron's Chromium build has no Push API/PushManager
// implementation at all (confirmed via electron/electron#6697), so setting these
// alone can never make pushManager.subscribe() work; real push registration uses
// electron-push-receiver's own GCM/MCS client instead (see setupPushReceiver above).
// Kept set for Chromium's own benefit, harmless either way. GOOGLE_API_KEY reuses
// this app's own Firebase Web API key (src/lib/firebase.ts -- already public in the
// client bundle, same GCP project, not a new secret) so it's fine as a literal here.
// GOOGLE_DEFAULT_CLIENT_ID/SECRET come from a "Desktop app"-type OAuth 2.0 Client ID
// (Google Cloud Console, voydapp-dddc9 project) -- loaded from a git-ignored local
// .env instead of committed as literals: GitHub's push protection blocked the
// commit that had them inline, and while Google doesn't treat this client type's
// secret as confidential (RFC 8252 installed-app flow), keeping it out of git
// history avoids relying on every future contributor knowing that distinction.
process.env.GOOGLE_API_KEY = 'AIzaSyAuA2k4R0oDeJmTe45LhWgOdKlEY8pq9Fw'
loadEnvFile(path.join(__dirname, '.env'))

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
  stopUiohookIfRunning()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Stay in tray
  }
})
