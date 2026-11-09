import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FAKE, fake, isAlive, POSIX_ONLY, startPatchbay, tmpdir, waitFor } from './helpers.js';
import { commandLineOf, commandLineOfAsync, hashCommandLine, pidDirFor, PidFiles, processStartTime } from '../src/process.js';

async function twoChildrenWithGrandchildren(t) {
  const pb = await startPatchbay({
    config: {
      version: 1,
      servers: {
        one: fake({ tools: 'pid', env: { FAKE_GRANDCHILD: '1' } }),
        two: fake({ tools: 'pid', env: { FAKE_GRANDCHILD: '1' } }),
      },
    },
  });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'one' });
  await pb.own('enable', { name: 'two' });
  const pids = [];
  for (const s of ['one', 'two']) {
    const info = JSON.parse((await pb.call(`${s}__pid`)).content[0].text);
    pids.push(info.pid, info.grandchild);
  }
  for (const p of pids) assert.ok(isAlive(p), `pid ${p} alive before`);
  return { pb, pids };
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} on the patchbay kills every child process group within 500 ms`, { skip: POSIX_ONLY }, async (t) => {
    const { pb, pids } = await twoChildrenWithGrandchildren(t);
    const sent = Date.now();
    process.kill(pb.pid, signal);
    const all = [pb.pid, ...pids];
    await waitFor(() => all.every((p) => !isAlive(p)), 2000, 5);
    const took = Date.now() - sent;
    assert.ok(took < 500, `all processes gone in ${took} ms`);
  });
}

test('stdin closing shuts the patchbay and its children down', { skip: POSIX_ONLY }, async (t) => {
  const { pb, pids } = await twoChildrenWithGrandchildren(t);
  const sent = Date.now();
  pb.transport._process.stdin.end();
  await waitFor(() => [pb.pid, ...pids].every((p) => !isAlive(p)), 2000, 5);
  assert.ok(Date.now() - sent < 500);
});

test('pidfiles are written per child and removed on disable', { skip: POSIX_ONLY }, async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { one: fake({ tools: 'pid' }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'one' });
  const childPid = JSON.parse((await pb.call('one__pid')).content[0].text).pid;
  const dir = pidDirFor({ XDG_RUNTIME_DIR: pb.runtime });
  const file = path.join(dir, `${pb.pid}-${childPid}.json`);
  await waitFor(() => fs.existsSync(file));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.pid, childPid);
  assert.equal(rec.owner, pb.pid);
  assert.match(rec.cmd, /^[0-9a-f]{64}$/);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('fake-server'), 'no command line stored, only its hash');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  await pb.own('disable', { name: 'one' });
  await waitFor(() => !fs.existsSync(file));
});

test('startup reaps leftovers of a dead patchbay only when the command line still matches', { skip: POSIX_ONLY }, async (t) => {
  const runtime = path.join(tmpdir(), 'rt');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const dir = pidDirFor({ XDG_RUNTIME_DIR: runtime });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const sleeper = (tag) => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', tag], { detached: true, stdio: 'ignore' });
    c.unref();
    t.after(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } });
    return c.pid;
  };
  const deadOwner = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(deadOwner.stdout);
  assert.ok(!isAlive(deadPid));

  const leftover = sleeper('leftover');
  const reused = sleeper('reused-pid');
  const otherSession = sleeper('other-session');
  await waitFor(() => commandLineOf(leftover)?.includes('leftover'));
  await waitFor(() => commandLineOf(reused)?.includes('reused-pid'));
  const write = (owner, pid, cmd) =>
    fs.writeFileSync(path.join(dir, `${owner}-${pid}.json`), JSON.stringify({ v: 2, owner, pid, cmd, start: processStartTime(pid), created: new Date().toISOString() }), { mode: 0o600 });
  write(deadPid, leftover, hashCommandLine(commandLineOf(leftover)));
  write(deadPid, reused, hashCommandLine('some other command line'));
  write(process.pid, otherSession, hashCommandLine(commandLineOf(otherSession)));

  const pb = await startPatchbay({ config: { version: 1, servers: {} }, runtime });
  t.after(() => pb.close());
  await waitFor(() => !isAlive(leftover), 3000);
  assert.ok(isAlive(reused), 'a pid now running something else is left alone');
  assert.ok(isAlive(otherSession), 'pidfiles of a live patchbay are left alone');
  await waitFor(() => !fs.existsSync(path.join(dir, `${deadPid}-${leftover}.json`)));
  assert.ok(!fs.existsSync(path.join(dir, `${deadPid}-${reused}.json`)), 'stale pidfile removed');
  assert.ok(fs.existsSync(path.join(dir, `${process.pid}-${otherSession}.json`)));
});

test('the patchbay survives a child that dies during initialize', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { dies: fake({ env: { FAKE_EXIT_ON_START: '1' } }), ok: fake() } } });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'dies' });
  assert.equal(r.isError, true);
  assert.equal((await pb.own('enable', { name: 'ok' })).isError, false);
  assert.equal((await pb.call('ok__echo')).content[0].text, 'fake:echo:{}');
});

test('a last stderr line without a newline is quoted in the start error', async (t) => {
  // Shorter than the minimum secret length, so the env value itself is not redacted.
  const pb = await startPatchbay({ config: { version: 1, servers: { dies: fake({ env: { FAKE_STDERR_TAIL: 'boom!', FAKE_EXIT_ON_START: '1' } }) } } });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'dies' });
  assert.equal(r.isError, true);
  assert.match(r.text, /last stderr: boom!"/);
});

test('the start error quotes the last stderr line after a lot of stderr output', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { dies: fake({ env: { FAKE_STDERR_BULK: '1048576', FAKE_STDERR_TAIL: 'boom!', FAKE_EXIT_ON_START: '1' } }) } } });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'dies' });
  assert.equal(r.isError, true);
  assert.match(r.text, /exited with code 1; last stderr: boom!"/);
});

test('a child that ignores SIGTERM is gone shortly after the patchbay shuts down', { skip: POSIX_ONLY }, async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { stubborn: fake({ tools: 'pid', env: { FAKE_IGNORE_SIGTERM: '1' } }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'stubborn' });
  const childPid = JSON.parse((await pb.call('stubborn__pid')).content[0].text).pid;
  t.after(() => { try { process.kill(-childPid, 'SIGKILL'); } catch { /* gone */ } });
  const sent = Date.now();
  process.kill(pb.pid, 'SIGTERM');
  await waitFor(() => !isAlive(pb.pid), 2000, 5);
  assert.ok(Date.now() - sent < 500, 'the patchbay itself exits at once');
  await waitFor(() => !isAlive(childPid), 3000, 10);
});

test('a SIGTERM-ignoring child keeps its pidfile until it is gone; the reaper escalates to SIGKILL', { skip: POSIX_ONLY }, async (t) => {
  const runtime = path.join(tmpdir(), 'rt');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const dir = pidDirFor({ XDG_RUNTIME_DIR: runtime });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const c = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1e6)', 'stubborn-leftover'], { detached: true, stdio: 'ignore' });
  c.unref();
  t.after(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } });
  await waitFor(() => commandLineOf(c.pid)?.includes('stubborn-leftover'));
  const deadOwner = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const file = path.join(dir, `${deadOwner}-${c.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ v: 2, owner: deadOwner, pid: c.pid, cmd: hashCommandLine(commandLineOf(c.pid)), start: processStartTime(c.pid), created: new Date().toISOString() }), { mode: 0o600 });
  const pb = await startPatchbay({ config: { version: 1, servers: {} }, runtime });
  t.after(() => pb.close());
  await waitFor(() => !isAlive(c.pid), 5000);
  await waitFor(() => !fs.existsSync(file), 3000);
});

test('after a crash, group members that ignore SIGTERM are SIGKILLed', { skip: POSIX_ONLY }, async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { bad: fake({ tools: 'crash,pid', env: { FAKE_GRANDCHILD: '1', FAKE_IGNORE_SIGTERM: '1' } }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'bad' });
  const { pid, grandchild } = JSON.parse((await pb.call('bad__pid')).content[0].text);
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.ok(isAlive(grandchild));
  await pb.call('bad__crash').catch(() => {});
  await waitFor(async () => (await pb.state('bad')).state === 'failed', 5000);
  await waitFor(() => !isAlive(grandchild), 3000);
});

test('the reaper never signals a live process with another start time, or one that does not lead its group', { skip: POSIX_ONLY }, async (t) => {
  const runtime = path.join(tmpdir(), 'rt');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const dir = pidDirFor({ XDG_RUNTIME_DIR: runtime });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadOwner = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const kill = (pid) => t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });

  // Leads its own group and runs the recorded command line, but started at another time: the
  // pid was reused by an unrelated process that happens to look the same.
  const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'reused-start'], { detached: true, stdio: 'ignore' });
  reused.unref();
  kill(reused.pid);
  // Same command line and start time, but in our own process group: not a child we spawned.
  const member = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'not-a-leader'], { stdio: 'ignore' });
  kill(member.pid);
  await waitFor(() => commandLineOf(reused.pid)?.includes('reused-start') && commandLineOf(member.pid)?.includes('not-a-leader'));

  const files = [];
  const write = (pid, start) => {
    const f = path.join(dir, `${deadOwner}-${pid}.json`);
    fs.writeFileSync(f, JSON.stringify({ v: 2, owner: deadOwner, pid, cmd: hashCommandLine(commandLineOf(pid)), start, created: new Date().toISOString() }), { mode: 0o600 });
    files.push(f);
  };
  if (process.platform === 'linux') write(reused.pid, String(Number(processStartTime(reused.pid)) + 1));
  write(member.pid, processStartTime(member.pid));

  const pb = await startPatchbay({ config: { version: 1, servers: {} }, runtime });
  t.after(() => pb.close());
  await waitFor(() => files.every((f) => !fs.existsSync(f)), 3000);
  await new Promise((r) => setTimeout(r, 1300)); // past the reaper's SIGKILL follow-up
  assert.ok(isAlive(reused.pid), 'a process with another start time is left alone');
  assert.ok(isAlive(member.pid), 'a process that does not lead its own group is left alone');
});

test('the command line lookup used for pidfiles matches the synchronous one', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'cmdline-probe'], { stdio: 'ignore' });
  try {
    await waitFor(() => commandLineOf(child.pid)?.includes('cmdline-probe'), 10000);
    assert.equal(await commandLineOfAsync(child.pid), commandLineOf(child.pid));
    assert.equal(await commandLineOfAsync(-1), null);
  } finally {
    child.kill();
  }
});

test('a child removed before its command line is read gets no pidfile', { skip: process.platform === 'linux' && 'Linux reads the command line synchronously' }, async () => {
  const dir = path.join(tmpdir(), 'pids');
  const pf = new PidFiles(dir, { warn() {}, info() {}, debug() {} });
  const kept = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    pf.record(process.pid);
    pf.remove(process.pid);
    pf.record(/** @type {number} */ (kept.pid));
    // Both lookups started together; once the kept one is written, the removed one has had its turn.
    await waitFor(() => fs.existsSync(pf.file(/** @type {number} */ (kept.pid))), 20000);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(pf.file(process.pid)), false);
  } finally {
    kept.kill();
  }
});

test('the pidfile of a #!/usr/bin/env script holds its command line once it serves, not env\'s', { skip: POSIX_ONLY }, async (t) => {
  const dir = tmpdir();
  const script = path.join(dir, 'wrapped.mjs');
  fs.writeFileSync(script, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(FAKE).href)});\n`, { mode: 0o755 });
  const runtime = path.join(dir, 'rt');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const pb = await startPatchbay({ config: { version: 1, servers: { wrapped: { command: script, policy: 'allow', env: { FAKE_TOOLS: 'pid' } } } }, runtime });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'wrapped' });
  const { pid } = JSON.parse((await pb.call('wrapped__pid')).content[0].text);
  const file = path.join(pidDirFor({ XDG_RUNTIME_DIR: runtime }), `${pb.pid}-${pid}.json`);
  const want = hashCommandLine(/** @type {string} */ (commandLineOf(pid)));
  assert.ok(!commandLineOf(pid)?.startsWith('/usr/bin/env'), 'the script runs as node by now');
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).cmd : 'no pidfile');
  await waitFor(() => read() === want, 10000).catch(() => assert.equal(read(), want, `pidfile for ${commandLineOf(pid)}`));
});
