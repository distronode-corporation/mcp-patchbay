import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, startPatchbay, waitFor } from './helpers.js';

test('a crashing child marks only itself failed; the others keep answering', async (t) => {
  const pb = await startPatchbay({
    config: { version: 1, servers: { bad: fake({ tools: 'crash,echo' }), good: fake({ name: 'good', tools: 'echo' }) } },
  });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'bad' });
  await pb.own('enable', { name: 'good' });
  const before = pb.listChanged.count;
  await pb.call('bad__crash').catch(() => {});
  await waitFor(async () => (await pb.state('bad')).state === 'failed', 5000);
  await waitFor(() => pb.listChanged.count > before);
  const bad = await pb.state('bad');
  assert.match(bad.lastError, /exited/);
  assert.ok(!bad.lastError.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'stderr token redacted');
  assert.equal(bad.canEnable, true);
  const names = await pb.toolNames();
  assert.ok(!names.some((n) => n.startsWith('bad__')));
  assert.ok(names.includes('good__echo'));
  assert.equal((await pb.call('good__echo', { value: 'still here' })).content[0].text, 'good:echo:{"value":"still here"}');
  assert.equal((await pb.state('good')).state, 'on');
  // not restarted automatically, but can be enabled again
  assert.equal((await pb.state('bad')).state, 'failed');
  const again = await pb.own('enable', { name: 'bad' });
  assert.equal(again.isError, false);
  assert.equal((await pb.state('bad')).state, 'on');
  assert.ok(!pb.stderr().includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'logs are redacted too');
});

test('a call in flight when the child dies fails cleanly', async (t) => {
  const pb = await startPatchbay({ config: { version: 1, servers: { bad: fake({ tools: 'crash,sleep' }) } } });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'bad' });
  const slow = pb.call('bad__sleep', { ms: 5000 });
  await waitFor(async () => (await pb.own('info', { name: 'bad' })).data.inFlight === 1);
  await pb.call('bad__crash').catch(() => {});
  await assert.rejects(slow, /exited during the call/);
});

test('env: children inherit the patchbay env plus their own entry env, never another entry', async (t) => {
  const pb = await startPatchbay({
    env: { PATCHBAY_TEST_SHARED: 'from-patchbay', HOME: process.env.HOME ?? '/path/to/home' },
    config: {
      version: 1,
      servers: {
        a: fake({ tools: 'env', env: { A_ONLY: 'a-value' } }),
        b: fake({ tools: 'env', env: { B_ONLY: 'b-value', PATCHBAY_TEST_SHARED: 'overridden-by-b' } }),
      },
    },
  });
  t.after(() => pb.close());
  await pb.own('enable', { name: 'a' });
  await pb.own('enable', { name: 'b' });
  const names = ['PATCHBAY_TEST_SHARED', 'A_ONLY', 'B_ONLY', 'HOME', 'PATH'];
  const a = JSON.parse((await pb.call('a__env', { names })).content[0].text);
  const b = JSON.parse((await pb.call('b__env', { names })).content[0].text);
  assert.equal(a.PATCHBAY_TEST_SHARED, 'from-patchbay');
  assert.equal(a.A_ONLY, 'a-value');
  assert.equal(a.B_ONLY, null);
  assert.equal(b.B_ONLY, 'b-value');
  assert.equal(b.A_ONLY, null);
  assert.equal(b.PATCHBAY_TEST_SHARED, 'overridden-by-b');
  assert.equal(a.HOME, process.env.HOME ?? '/path/to/home');
  assert.ok(a.PATH && a.PATH.length > 0);
});

test('redaction: start failures report a redacted error in servers, info and logs', async (t) => {
  const secretArg = 'arg-secret-value-123';
  const pb = await startPatchbay({
    config: {
      version: 1,
      servers: {
        broken: {
          ...fake({ env: {
            FAKE_STDERR: [
              'connecting to https://mcp.example.com/mcp?access_token=abc123secret',
              'using Authorization: Bearer abcdef0123456789abcdef',
              'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl',
              `key ghp_abcdefghijklmnopqrstuvwxyz0123456789 and API_SECRET=myplainenvsecret and ${secretArg}`,
            ].join('\n'),
            FAKE_EXIT_ON_START: '3',
            API_SECRET: 'myplainenvsecret',
          } }),
          args: [(fake()).args[0], secretArg],
        },
        missing: { command: '/path/to/definitely-missing-binary', args: ['--token', 'missing-secret-arg'], policy: 'allow' },
      },
    },
  });
  t.after(() => pb.close());
  const r = await pb.own('enable', { name: 'broken' });
  assert.equal(r.isError, true);
  const m = await pb.own('enable', { name: 'missing' });
  assert.equal(m.isError, true);
  const servers = (await pb.own('servers')).text;
  const info = (await pb.own('info', { name: 'broken' })).text;
  const all = [r.text, m.text, servers, info, pb.stderr()].join('\n');
  for (const secret of ['abc123secret', 'abcdef0123456789abcdef', 'eyJhbGciOiJIUzI1NiJ9', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'myplainenvsecret', secretArg, 'missing-secret-arg']) {
    assert.ok(!all.includes(secret), `leaked ${secret}`);
  }
  assert.match(info, /\[redacted\]/);
  assert.equal((await pb.state('broken')).state, 'failed');
  assert.match((await pb.state('missing')).lastError, /could not start|ENOENT|not found/i);
});
