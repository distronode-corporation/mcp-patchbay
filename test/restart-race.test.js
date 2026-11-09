// Races between restart, disable, enable and a crash, driven in-process so they are
// deterministic: toolRestart() sets the slot to "off" synchronously before it awaits the stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { Patchbay } from '../src/server.js';
import { fake } from './helpers.js';

async function confirmServerOn(t) {
  const config = validateConfig({ version: 1, servers: { ask: fake({ name: 'ask', tools: 'echo', policy: 'confirm' }) } });
  const pb = new Patchbay(config, { log: createLogger({ write: () => {} }), pidFiles: null });
  const slot = pb.slots.get('ask');
  t.after(async () => {
    for (const c of [slot.child, slot.lastChild]) await c?.close().catch(() => {});
  });
  // Approved earlier (or autostarted): it is on.
  const r = await pb.startSlot(slot);
  assert.equal(r.ok, true);
  assert.equal(slot.state, 'on');
  return { pb, slot };
}

const parse = (r) => JSON.parse(r.content[0].text);

test('a disable that races a restart wins: the confirm server stays off', async (t) => {
  const { pb, slot } = await confirmServerOn(t);
  const restarting = pb.toolRestart('ask', {});
  assert.equal(slot.state, 'off', 'restart is stopping the old child');
  const d = await pb.toolDisable('ask');
  assert.equal(d.isError, undefined);
  const r = await restarting;
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /restart.*cancelled.*disable/i);
  assert.equal(slot.state, 'off');
  assert.equal(slot.child, null);
  assert.equal(pb.publishedTools().length, 0);
});

test('an enable that races a restart joins it instead of asking a question it would ignore', async (t) => {
  const { pb, slot } = await confirmServerOn(t);
  const restarting = pb.toolRestart('ask', {});
  assert.equal(slot.state, 'off');
  const e = await pb.toolEnable('ask', {});
  const r = await restarting;
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(e.isError, undefined, e.content[0].text);
  assert.equal(parse(e).state, 'on');
  assert.equal(slot.state, 'on');
});

test('a crash makes the slot failed at once, so an immediate restart needs a person again', async (t) => {
  const { pb, slot } = await confirmServerOn(t);
  const child = slot.child;
  child.emit('exit', { code: 1, signal: null, expected: false });
  assert.equal(slot.state, 'failed', 'failed immediately, not 20 ms later');
  assert.equal(pb.publishedTools().length, 0);
  const r = await pb.toolRestart('ask', {});
  assert.equal(r.isError, true);
  assert.match(parse(r).error, /needs a person's approval/);
  assert.notEqual(slot.state, 'on');
  await child.close();
});
