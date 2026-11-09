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
 * @returns {boolean} whether anything was signalled
 */
export function killTree(pid, signal = 'SIGTERM') {
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
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
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
        fs.writeFileSync(f, JSON.stringify({ v: 1, owner: process.pid, pid, cmd: hashCommandLine(cmd), created: new Date().toISOString() }), { mode: 0o600 });
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

  /** Synchronously removes every pidfile of this process (used during shutdown). */
  removeAllSync() {
    for (const f of this.mine) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    this.mine.clear();
  }

  /**
   * Kills leftovers of patchbay processes that died without cleaning up. A leftover is killed only
   * if its owner is gone, it is still alive, and its command line hashes to the recorded value.
   * @returns {number} how many trees were killed
   */
  reap() {
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
      if (pidAlive(pid)) {
        const cmd = commandLineOf(pid);
        if (cmd && typeof rec.cmd === 'string' && hashCommandLine(cmd) === rec.cmd) {
          killTree(pid, 'SIGTERM');
          killed++;
          this.log.info(`reaped leftover child pid ${pid} of dead patchbay pid ${owner}`);
        }
      }
      try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
    }
    return killed;
  }
}
