import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fake, isAlive, POSIX_ONLY, startPatchbay, tmpdir, waitFor } from './helpers.js';
import { commandLineOf, hashCommandLine, pidDirFor } from '../src/process.js';

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
    fs.writeFileSync(path.join(dir, `${owner}-${pid}.json`), JSON.stringify({ v: 1, owner, pid, cmd, created: new Date().toISOString() }), { mode: 0o600 });
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
