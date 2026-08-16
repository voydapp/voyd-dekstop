// Rich Presence process-detection module. Polls running processes, matches
// against the game_executables catalog (voyd-web's Supabase project),
// debounces before treating a match as "now playing", and reports
// confirmed changes back to main.js to relay to the renderer.
//
// Runs entirely in the main process -- the renderer (loaded live from
// joinvoyd.com) has no OS-level process access, and the main process has no
// Supabase auth session, so the split is: main process detects, renderer
// writes (via the IPC bridge in preload.js + useGameDetection in voyd-web).

const { execFile } = require('child_process')

// Public anon key -- same one already shipped in every joinvoyd.com page
// load and gated entirely by RLS (game_executables is publicly readable).
// Not a secret; nothing here needs service-role access.
const SUPABASE_URL = 'https://fjvijrbfbzdjsyiwqwfd.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqdmlqcmJmYnpkanN5aXdxd2ZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyNzk2ODEsImV4cCI6MjA4Njg1NTY4MX0.wlrIINkapREqdR-17QYBhB3PUa1mnyMsILaNN5F3LBI'

const POLL_INTERVAL_MS = 12_000
const DEBOUNCE_MS = 45_000 // how long a candidate match must persist before being confirmed
const CLEAR_GRACE_MISSES = 2 // consecutive empty polls before clearing a confirmed game
const EXECUTABLES_REFRESH_MS = 30 * 60 * 1000

// Executable names that map to more than one real-world program (a generic
// runtime, or an engine shared across unrelated titles) -- resolved via a
// secondary signal (full command line) rather than name alone.
const AMBIGUOUS_EXECUTABLES = new Set(['javaw.exe', 'hl2.exe'])

let executableMap = new Map() // lowercase executable_name -> { gameId, gameName }
let lastExecutablesFetch = 0

let pollTimer = null
let enabled = false
let onChangeCallback = null

let candidate = null // { gameId, gameName, firstSeenAt }
let confirmed = null // { gameId, gameName }
let missCount = 0

async function fetchExecutables() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/game_executables?select=executable_name,game_id,games(name)`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
    )
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const rows = await res.json()
    const map = new Map()
    for (const row of rows) {
      map.set(row.executable_name.toLowerCase(), {
        gameId: row.game_id,
        gameName: row.games?.name ?? row.executable_name,
      })
    }
    executableMap = map
    lastExecutablesFetch = Date.now()
    console.log('[gameDetection] loaded', map.size, 'executable mappings')
  } catch (err) {
    console.error('[gameDetection] failed to fetch game_executables:', err.message)
  }
}

// ps-list doesn't expose the command line on Windows (only pid/name/ppid
// there), so ambiguous matches are resolved with a direct WMI query for
// that one PID -- only called for the two known-ambiguous executables, not
// every process on every poll.
function getWindowsCommandLine(pid) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? '' : (stdout || '').trim()),
    )
  })
}

async function resolveAmbiguous(name, pid, cmdFromPsList) {
  const cmd = cmdFromPsList || (process.platform === 'win32' ? await getWindowsCommandLine(pid) : '')
  const lower = cmd.toLowerCase()

  if (name === 'javaw.exe') {
    // Minecraft's launcher invokes javaw.exe with "minecraft" somewhere in
    // the jar path / main class / launcher-brand args. Not airtight against
    // an unrelated Java app that happens to mention Minecraft, but a real
    // false positive here is very unlikely in practice.
    return lower.includes('minecraft') ? executableMap.get('javaw.exe') : null
  }

  if (name === 'hl2.exe') {
    // Every Source engine game shares hl2.exe; -game <mod folder> is how
    // the engine itself picks which game to run, so this is a definitive
    // signal from the engine, not a heuristic -- "garrysmod" is Garry's
    // Mod's actual mod-folder name.
    return lower.includes('-game garrysmod') || lower.includes('-game "garrysmod"')
      ? executableMap.get('hl2.exe')
      : null
  }

  return null
}

async function findMatch(processes) {
  for (const proc of processes) {
    const name = (proc.name || '').toLowerCase()
    if (!name || !executableMap.has(name)) continue

    if (AMBIGUOUS_EXECUTABLES.has(name)) {
      const resolved = await resolveAmbiguous(name, proc.pid, proc.cmd)
      if (resolved) return resolved
      continue // name matched but failed the secondary signal -- not this game
    }

    return executableMap.get(name)
  }
  return null
}

async function poll() {
  if (Date.now() - lastExecutablesFetch > EXECUTABLES_REFRESH_MS) await fetchExecutables()
  if (executableMap.size === 0) return

  let processes
  try {
    const psList = (await import('ps-list')).default
    processes = await psList()
  } catch (err) {
    console.error('[gameDetection] process list failed:', err.message)
    return
  }

  const match = await findMatch(processes)

  if (match) {
    missCount = 0
    if (confirmed?.gameId === match.gameId) return // already confirmed, nothing changed

    if (candidate?.gameId === match.gameId) {
      if (Date.now() - candidate.firstSeenAt >= DEBOUNCE_MS) {
        confirmed = { gameId: match.gameId, gameName: match.gameName }
        candidate = null
        onChangeCallback?.(confirmed)
      }
    } else {
      candidate = { gameId: match.gameId, gameName: match.gameName, firstSeenAt: Date.now() }
    }
    return
  }

  candidate = null
  if (confirmed) {
    missCount++
    if (missCount >= CLEAR_GRACE_MISSES) {
      confirmed = null
      missCount = 0
      onChangeCallback?.(null)
    }
  }
}

async function start() {
  if (pollTimer) return
  await fetchExecutables()
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  poll()
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  candidate = null
  missCount = 0
  if (confirmed) {
    confirmed = null
    onChangeCallback?.(null) // clear presence when detection turns off
  }
}

function init(callback) {
  onChangeCallback = callback
}

function setEnabled(next) {
  next = !!next
  if (next === enabled) return
  enabled = next
  if (enabled) start()
  else stop()
}

module.exports = { init, setEnabled }
