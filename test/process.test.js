// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// process.js on its own: process lookups for pids that are gone or were never valid, and the
// pidfile directory and reaper when the file system says no. Each system takes its own
// branches here (/proc on Linux, ps on macOS, PowerShell and taskkill on Windows); CI merges
// the coverage of all three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../src/log.js';
import {
  commandLineOf,
  commandLineOfAsync,
  hashCommandLine,
  killGroupsLater,
  killTree,
  pidAlive,
  pidDirFor,
  PidFiles,
  processGroupOf,
  processStartTime,
  procStat,
} from '../src/process.js';
import { IS_WINDOWS, POSIX_ONLY, tmpdir } from './helpers.js';

/** A valid pid that no system hands out. */
const GONE = 2147483646;
const BAD_PIDS = [0, -1, 1.5, Number.NaN];
const ROOT_IGNORES_MODES = process.getuid?.() === 0 && 'root ignores directory modes';

/** Resolves once `check()` is true, polling every 20 ms; rejects after `ms`. */
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** PidFiles in a fresh directory, with its warnings collected. */
function pidFiles(dir = path.join(tmpdir(), 'pids')) {
  const warnings = [];
  const pf = new PidFiles(dir, createLogger({ write: (s) => warnings.push(s) }));
  return { pf, dir, warnings };
}

/** A sleeping node child, killed after the test. */
function sleeper(t, o = {}) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', ...o });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  return child;
}

test('pidDirFor: XDG_RUNTIME_DIR when set, else the temporary directory, with a per-user name', () => {
  const tag = process.getuid?.() ?? os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_');
  assert.equal(pidDirFor({ XDG_RUNTIME_DIR: '/run/user/example' }), path.join('/run/user/example', `mcp-patchbay-${tag}`));
  assert.equal(pidDirFor({}), path.join(os.tmpdir(), `mcp-patchbay-${tag}`));
});

test('lookups of a pid that is gone, or not a pid at all, find nothing', async () => {
  for (const pid of [GONE, ...BAD_PIDS]) {
    assert.equal(commandLineOf(pid), null, String(pid));
    assert.equal(await commandLineOfAsync(pid), null, String(pid));
    assert.equal(procStat(pid), null, String(pid));
    assert.equal(processStartTime(pid), undefined, String(pid));
  }
  assert.equal(processGroupOf(GONE), null);
  assert.equal(pidAlive(GONE), false);
  for (const pid of BAD_PIDS) assert.equal(killTree(pid), false, String(pid));
});

test('lookups of this process find its command line, and on POSIX its process group', async () => {
  const cmd = commandLineOf(process.pid);
  assert.ok(cmd && cmd.includes(path.basename(process.execPath).replace(/\.exe$/i, '')), String(cmd));
  assert.equal(await commandLineOfAsync(process.pid), cmd);
  if (IS_WINDOWS) assert.equal(processGroupOf(process.pid), null);
  else assert.ok(Number.isInteger(processGroupOf(process.pid)) && /** @type {number} */ (processGroupOf(process.pid)) > 0);
  if (process.platform === 'linux') {
    const st = /** @type {{start: string, pgid: number}} */ (procStat(process.pid));
    assert.match(st.start, /^\d+$/);
    assert.equal(processStartTime(process.pid), st.start);
  } else {
    assert.equal(procStat(process.pid), null, 'Linux only');
  }
});

test('a process with no command line reads as null', { skip: process.platform === 'darwin' && 'every macOS process has a command line ps can show' }, async () => {
  // Linux: kthreadd (pid 2) is a kernel thread with an empty /proc/2/cmdline. Windows: the
  // System process (pid 4) has no CommandLine.
  const pid = IS_WINDOWS ? 4 : 2;
  assert.equal(commandLineOf(pid), null);
  assert.equal(await commandLineOfAsync(pid), null);
});

test('killTree of a pid that is gone signals nothing on POSIX; Windows leaves it to taskkill', () => {
  assert.equal(killTree(GONE), IS_WINDOWS, 'taskkill runs detached, so Windows reports it as started');
  if (!IS_WINDOWS) assert.equal(killTree(GONE, 'SIGTERM', { bare: false }), false);
});

test('killGroupsLater with nothing to kill starts no helper', () => {
  assert.equal(killGroupsLater([]), undefined);
});

test('a pidfile directory that is a file disables pidfiles, with a warning', () => {
  const file = path.join(tmpdir(), 'not-a-dir');
  fs.writeFileSync(file, '');
  const { pf, warnings } = pidFiles(file);
  assert.equal(pf.enabled, false);
  assert.match(warnings.join(''), /warn: pidfiles disabled: cannot use .*not-a-dir \(/);
  pf.record(process.pid);
  assert.equal(pf.reap(), 0);
  assert.deepEqual(fs.readFileSync(file, 'utf8'), '', 'nothing was written');
});

test('a pidfile directory that is a symlink, or owned by someone else, is refused', { skip: POSIX_ONLY }, (t) => {
  const real = path.join(tmpdir(), 'real');
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(tmpdir(), 'link');
  fs.symlinkSync(real, link);
  const linked = pidFiles(link);
  assert.equal(linked.pf.enabled, false);
  assert.match(linked.warnings.join(''), /\(not a directory\)/);

  const dir = path.join(tmpdir(), 'theirs');
  const lstat = fs.lstatSync;
  const other = /** @type {number} */ (process.getuid?.()) + 1;
  t.mock.method(fs, 'lstatSync', (p, ...rest) => (p === dir ? Object.assign(lstat(p, ...rest), { uid: other }) : lstat(p, ...rest)));
  const theirs = pidFiles(dir);
  assert.equal(theirs.pf.enabled, false);
  assert.match(theirs.warnings.join(''), new RegExp(`\\(owned by uid ${other}\\)`));
});

test('an existing pidfile directory open to others is narrowed to 0700', { skip: POSIX_ONLY }, () => {
  const dir = path.join(tmpdir(), 'wide');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const { pf } = pidFiles(dir);
  assert.equal(pf.enabled, true);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('no pidfile is written for a process that is gone before its command line is read', async () => {
  const { pf, dir } = pidFiles();
  pf.record(GONE);
  await until(() => pf.pending.size === 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(pf.mine.size, 0);
});

test('a pidfile that cannot be written, or removed, is a warning or nothing, never a throw', { skip: POSIX_ONLY || ROOT_IGNORES_MODES }, async (t) => {
  const { pf, dir, warnings } = pidFiles();
  const child = sleeper(t);
  await new Promise((r) => child.once('spawn', r));
  pf.record(child.pid);
  await until(() => pf.mine.size === 1);
  fs.chmodSync(dir, 0o500);
  t.after(() => fs.chmodSync(dir, 0o700));
  assert.doesNotThrow(() => pf.remove(child.pid));
  assert.equal(fs.readdirSync(dir).length, 1, 'still there: the directory is read-only');
  pf.record(process.pid);
  await until(() => warnings.some((w) => w.includes('cannot write pidfile')));
});

test('the reaper skips what is not a pidfile of a dead patchbay, and copes with a directory that went away', { skip: POSIX_ONLY || ROOT_IGNORES_MODES }, async (t) => {
  const { pf, dir } = pidFiles();
  const write = (name, rec) => fs.writeFileSync(path.join(dir, name), typeof rec === 'string' ? rec : JSON.stringify(rec));
  // Not ours to judge: a foreign file name, unreadable JSON, our own child, a live owner's child.
  write('notes.txt', 'x');
  write(`${GONE}-1.json`, '{not json');
  write(`${process.pid}-3.json`, { owner: process.pid, pid: 3 });
  write('1-4.json', { owner: 1, pid: 4 });
  // A dead owner's child that is not a leftover: a live process in our own group (no group of
  // its own), with the right command line. Its pidfile goes, and it is left alone.
  const child = sleeper(t);
  await new Promise((r) => child.once('spawn', r));
  const cmd = /** @type {string} */ (commandLineOf(child.pid));
  write(`${GONE}-${child.pid}.json`, { owner: GONE, pid: child.pid, cmd: hashCommandLine(cmd), start: processStartTime(child.pid) });
  assert.equal(pf.reap(50), 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${GONE}-1.json`, `${process.pid}-3.json`, '1-4.json', 'notes.txt'].sort());
  assert.equal(pidAlive(child.pid), true);

  // The same, in a directory that is read-only by then: removing fails quietly.
  write(`${GONE}-${child.pid}.json`, { owner: GONE, pid: child.pid, cmd: hashCommandLine(cmd), start: processStartTime(child.pid) });
  fs.chmodSync(dir, 0o500);
  try {
    assert.equal(pf.reap(50), 0);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.ok(fs.existsSync(path.join(dir, `${GONE}-${child.pid}.json`)));

  fs.rmSync(dir, { recursive: true });
  assert.equal(pf.reap(), 0, 'a directory removed since startup');
});

test('a leftover reaped while its directory turns read-only is still killed', { skip: POSIX_ONLY || ROOT_IGNORES_MODES }, async (t) => {
  const { pf, dir } = pidFiles();
  const child = sleeper(t, { detached: true });
  await new Promise((r) => child.once('spawn', r));
  const exited = new Promise((r) => child.once('exit', r));
  const cmd = /** @type {string} */ (commandLineOf(child.pid));
  const file = path.join(dir, `${GONE}-${child.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ owner: GONE, pid: child.pid, cmd: hashCommandLine(cmd), start: processStartTime(child.pid) }));
  assert.equal(pf.reap(100), 1);
  await exited;
  fs.chmodSync(dir, 0o500);
  t.after(() => fs.chmodSync(dir, 0o700));
  await new Promise((r) => setTimeout(r, 250)); // past the grace period: the removal fails quietly
  assert.ok(fs.existsSync(file));
});
