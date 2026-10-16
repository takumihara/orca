import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { windowsSystem32Binary } from './windows-system-binary'

/**
 * `live` while taskkill is still walking the tree, `exited` once taskkill
 * reported the whole tree terminated, `unverifiable` when it failed or ran out
 * of time. Nothing short of a successful taskkill is reported as `exited`.
 */
export type WindowsTreeKillVerdict = 'live' | 'unverifiable' | 'exited'
export type SettledWindowsTreeKillVerdict = Exclude<WindowsTreeKillVerdict, 'live'>

/** How long one caller waits before treating the tree as unverifiable. */
export const WINDOWS_TASKKILL_WAIT_MS = 5_000
/**
 * How long the tracked taskkill may keep walking after its caller stops waiting.
 * Why so far past the wait: loaded windows-2022 runners measured 4.6-18 s, and
 * killing the root before taskkill reads it orphans the descendants it was
 * about to find.
 */
export const WINDOWS_TASKKILL_DEADLINE_MS = 60_000

export type WindowsTreeKill = {
  verdict: () => WindowsTreeKillVerdict
  settled: Promise<SettledWindowsTreeKillVerdict>
}

type TaskkillLauncher = (rootPid: number) => ChildProcess

const launchSystemTaskkill: TaskkillLauncher = (rootPid) =>
  nodeSpawn(windowsSystem32Binary('taskkill.exe'), ['/pid', String(rootPid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true,
    shell: false
  })

let launchTaskkill: TaskkillLauncher = launchSystemTaskkill

// Keyed by handle, not pid: a reused pid must never join another tree's kill.
const treeKills = new WeakMap<ChildProcess, WindowsTreeKill>()

/** The tree kill already in flight or proven for this child, if any. */
export function trackedWindowsTreeKill(child: ChildProcess): WindowsTreeKill | undefined {
  const kill = treeKills.get(child)
  return kill && kill.verdict() !== 'unverifiable' ? kill : undefined
}

/** Settles when this child's in-flight tree kill does; undefined when none is running. */
export function inFlightWindowsTreeKill(
  child: ChildProcess
): Promise<SettledWindowsTreeKillVerdict> | undefined {
  const kill = treeKills.get(child)
  return kill?.verdict() === 'live' ? kill.settled : undefined
}

/**
 * Start one tracked `taskkill /t /f` for this child's tree.
 *
 * The taskkill outlives every caller's wait and is only abandoned at the
 * deadline; the root is killed by handle only after taskkill has failed or been
 * abandoned, never while it may still be reading the tree.
 */
export function startWindowsTreeKill(
  child: ChildProcess,
  rootPid: number,
  killRoot: () => void
): WindowsTreeKill {
  const existing = trackedWindowsTreeKill(child)
  if (existing) {
    return existing
  }
  let verdict: WindowsTreeKillVerdict = 'live'
  let resolveSettled: (verdict: SettledWindowsTreeKillVerdict) => void = () => {}
  const settled = new Promise<SettledWindowsTreeKillVerdict>((resolve) => {
    resolveSettled = resolve
  })
  const kill: WindowsTreeKill = { verdict: () => verdict, settled }
  treeKills.set(child, kill)
  let deadline: ReturnType<typeof setTimeout> | undefined
  const finish = (next: SettledWindowsTreeKillVerdict): void => {
    if (verdict !== 'live') {
      return
    }
    verdict = next
    clearTimeout(deadline)
    if (next === 'unverifiable') {
      killRoot()
    }
    resolveSettled(next)
  }
  let killer: ChildProcess
  try {
    killer = launchTaskkill(rootPid)
  } catch {
    finish('unverifiable')
    return kill
  }
  killer.once('error', () => finish('unverifiable'))
  killer.once('close', (code) => finish(code === 0 ? 'exited' : 'unverifiable'))
  deadline = setTimeout(() => {
    try {
      killer.kill()
    } catch {
      /* already gone */
    }
    finish('unverifiable')
  }, WINDOWS_TASKKILL_DEADLINE_MS)
  deadline.unref?.()
  return kill
}

/** True when the tree is proven dead within this caller's wait; the kill keeps running either way. */
export function waitForWindowsTreeKill(
  kill: WindowsTreeKill,
  waitMs = WINDOWS_TASKKILL_WAIT_MS
): Promise<boolean> {
  if (kill.verdict() !== 'live') {
    return Promise.resolve(kill.verdict() === 'exited')
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs)
    timer.unref?.()
    void kill.settled.then((verdict) => {
      clearTimeout(timer)
      resolve(verdict === 'exited')
    })
  })
}

/** Test seam: swap the taskkill launch, e.g. for one that starts late like a loaded host's. */
export function _setWindowsTaskkillLauncherForTests(launcher: TaskkillLauncher | null): void {
  launchTaskkill = launcher ?? launchSystemTaskkill
}
