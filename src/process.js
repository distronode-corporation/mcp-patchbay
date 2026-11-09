// Process-tree killing, pidfiles and reaping of leftovers. See SPEC.md §9.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** A per-user id usable in a directory name. */
function userTag() {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  let name = 'user';
  try { name = os.userInfo().username; } catch { /* keep default */ }
  return name.replace(/[^A-Za-z0-9_-]/g, '_') || 'user';
}

/**
 * `${XDG_RUNTIME_DIR or os.tmpdir()}/mcp-patchbay-<uid>`
 * @param {NodeJS.ProcessEnv} [env]
 */
export function pidDirFor(env = process.env) {
  const base = env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, `mcp-patchbay-${userTag()}`);
}

/**
 * The command line of a running process as the OS reports it, or null.
 * @param {number} pid
 * @returns {string | null}
 */
export function commandLineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      const s = raw.toString('utf8').split('\0').filter((x) => x !== '').join(' ');
      return s || null;
    }
    if (IS_WINDOWS) {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
      return out.trim() || null;
    }
    const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** @param {string} s */
export function hashCommandLine(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Linux: the process start time (field 22 of /proc/<pid>/stat, clock ticks since boot) and its
 * process group id (field 5). Elsewhere, or if the process is gone: null.
 * @param {number} pid
 * @returns {{start: string, pgid: number} | null}
 */
export function procStat(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) is in parentheses and may contain spaces; fields after it are
    // plain. parts[0] is field 3.
    const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pgid: Number(parts[2]), start: parts[19] };
  } catch {
    return null;
  }
}

/** @param {number} pid @returns {string | undefined} Linux only */
export function processStartTime(pid) {
  return procStat(pid)?.start;
}

/** @param {number} pid */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM';
  }
}

/**
 * Kills a child's whole tree, synchronously as far as the OS allows.
 * POSIX: signal the process group (the child leads its own group, spawned detached).
 * Windows: a detached, unref'd `taskkill /T /F /PID` (it outlives us if we exit next).
 * @param {number} pid
 * @param {NodeJS.Signals} [signal]
 * @param {{bare?: boolean}} [o] bare: false never falls back to signalling the bare pid
 * @returns {boolean} whether anything was signalled
 */
export function killTree(pid, signal = 'SIGTERM', o = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WINDOWS) {
    try {
      const k = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { detached: true, stdio: 'ignore', windowsHide: true });
      k.on('error', () => {});
      k.unref();
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (o.bare === false) return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** Delay before the shutdown helper SIGKILLs the groups that survived SIGTERM. */
export const SHUTDOWN_KILL_DELAY_MS = 500;

// Runs in a detached `node -e` helper: argv[1] is the delay, argv[2] a JSON list of
// {pid, start, file}. After the delay it SIGKILLs each group whose leader is either gone
// (then the id is still reserved by the group's members, or unused) or still the same process
// (same start time, Linux). Then it removes the pidfiles of leaders that are gone.
const KILL_HELPER = `
const fs = require('fs');
const stat = (pid) => { try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const items = JSON.parse(process.argv[2]);
setTimeout(() => {
  for (const it of items) {
    if (alive(it.pid) && it.start && stat(it.pid) !== it.start) continue;
    try { process.kill(-it.pid, 'SIGKILL'); } catch {}
  }
  setTimeout(() => {
    for (const it of items) if (it.file && !alive(it.pid)) { try { fs.rmSync(it.file, { force: true }); } catch {} }
  }, 200);
}, Number(process.argv[1]));
`;

/**
 * POSIX: starts a detached helper that SIGKILLs the given process groups after `delayMs`, so
 * children that ignore SIGTERM do not outlive the patchbay. Returns at once; the helper is
 * unref'd and survives our exit.
 * @param {Array<{pid: number, start?: string, file?: string}>} items
 * @param {number} [delayMs]
 */
export function killGroupsLater(items, delayMs = SHUTDOWN_KILL_DELAY_MS) {
  if (IS_WINDOWS || !items.length) return;
  try {
    const h = spawn(process.execPath, ['-e', KILL_HELPER, String(delayMs), JSON.stringify(items)], { detached: true, stdio: 'ignore' });
    h.on('error', () => {});
    h.unref();
  } catch { /* the reaper of the next start is the fallback */ }
}

/** How long the reaper waits after SIGTERM before it sends SIGKILL. */
export const REAP_GRACE_MS = 1000;

/**
 * Is `pid` still the process a pidfile recorded?
 * @param {number} pid
 * @param {any} rec
 */
function isLeftover(pid, rec) {
  if (!pidAlive(pid)) return false;
  const cmd = commandLineOf(pid);
  return Boolean(cmd && typeof rec.cmd === 'string' && hashCommandLine(cmd) === rec.cmd);
}

/** Pidfiles for the children of this patchbay process. */
export class PidFiles {
  /**
   * @param {string} dir
   * @param {import('./log.js').Logger} log
   */
  constructor(dir, log) {
    this.dir = dir;
    this.log = log;
    this.enabled = this.#prepare();
    /** @type {Set<string>} */
    this.mine = new Set();
  }

  #prepare() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(this.dir);
      if (!st.isDirectory()) throw new Error('not a directory');
      if (!IS_WINDOWS) {
        const uid = process.getuid?.();
        if (uid !== undefined && st.uid !== uid) throw new Error(`owned by uid ${st.uid}`);
        if ((st.mode & 0o777) !== 0o700) fs.chmodSync(this.dir, 0o700);
      }
      return true;
    } catch (e) {
      this.log.warn(`pidfiles disabled: cannot use ${this.dir} (${/** @type {Error} */ (e).message})`);
      return false;
    }
  }

  /** @param {number} pid */
  file(pid) {
    return path.join(this.dir, `${process.pid}-${pid}.json`);
  }

  /**
   * Records a freshly spawned child. Reads its command line from the OS so the reaper can later
   * compare like with like; only the hash is stored.
   * @param {number} pid
   */
  record(pid) {
    if (!this.enabled) return;
    const write = (cmd) => {
      if (!cmd) return;
      const f = this.file(pid);
      try {
        const start = processStartTime(pid);
        fs.writeFileSync(f, JSON.stringify({ v: 2, owner: process.pid, pid, cmd: hashCommandLine(cmd), ...(start ? { start } : {}), created: new Date().toISOString() }), { mode: 0o600 });
        this.mine.add(f);
      } catch (e) {
        this.log.warn(`cannot write pidfile: ${/** @type {Error} */ (e).message}`);
      }
    };
    if (process.platform === 'linux') {
      write(commandLineOf(pid));
    } else {
      // ps / PowerShell are slow; do not block the event loop for them.
      setImmediate(() => write(commandLineOf(pid)));
    }
  }

  /** @param {number} pid */
  remove(pid) {
    const f = this.file(pid);
    this.mine.delete(f);
    try { fs.rmSync(f, { force: true }); } catch { /* already gone */ }
  }

  /**
   * Kills leftovers of patchbay processes that died without cleaning up. A leftover is killed only
   * if its owner is gone, it is still alive, and its command line hashes to the recorded value.
   * It gets SIGTERM, then SIGKILL after REAP_GRACE_MS if it is still the same process; its
   * pidfile is removed only after that, so a patchbay that dies meanwhile leaves it for the next.
   * @param {number} [graceMs]
   * @returns {number} how many trees were signalled
   */
  reap(graceMs = REAP_GRACE_MS) {
    if (!this.enabled) return 0;
    let killed = 0;
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return 0; }
    for (const f of files) {
      const m = /^(\d+)-(\d+)\.json$/.exec(f);
      if (!m) continue;
      const full = path.join(this.dir, f);
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      const owner = Number(rec.owner);
      const pid = Number(rec.pid);
      if (owner === process.pid || pidAlive(owner)) continue;
      if (isLeftover(pid, rec)) {
        killTree(pid, 'SIGTERM');
        killed++;
        this.log.info(`reaped leftover child pid ${pid} of dead patchbay pid ${owner}`);
        const t = setTimeout(() => {
          if (isLeftover(pid, rec)) {
            killTree(pid, 'SIGKILL');
            this.log.info(`leftover child pid ${pid} ignored SIGTERM; sent SIGKILL`);
          }
          try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
        }, graceMs);
        t.unref?.();
        continue;
      }
      try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
    }
    return killed;
  }
}
