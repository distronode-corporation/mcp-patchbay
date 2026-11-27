#!/usr/bin/env node
// A raw JSON-RPC MCP server for children and patchbay tests: it says only what the test
// scripts, so it can do what the SDK's McpServer never does. Selected by environment variables:
//
//   SCRIPTED_PAGES        tools/list pages, "|" between pages and "," between tool names
//                         ("a,b|c"): each page but the last names the next page's cursor
//   SCRIPTED_SAME_CURSOR=1  the second page names its own cursor again as the next one
//   SCRIPTED_REQUESTS     methods to send to the client once initialized, "," separated; each
//                         answer is written to stderr as `answer <method> <json>`
//   SCRIPTED_STRAY=1      once initialized, send a response to a request the client never made
//   SCRIPTED_INIT_ERROR=1 answer initialize with a JSON-RPC error
//   SCRIPTED_INIT_SILENT=1  never answer initialize
//   SCRIPTED_NOTIFY       notifications to send once initialized, "," separated, each after
//                         SCRIPTED_NOTIFY_DELAY_MS (default 0), with SCRIPTED_NOTIFY_PARAMS
//                         (JSON, default {}) as params
//   SCRIPTED_LIST_DELAY_MS  delay every tools/list answer by this much
//   SCRIPTED_LIST_FAIL=1  answer every tools/list after the first with an error
//   SCRIPTED_ECHO=1       write `got <method>` to stderr for every message received
//   SCRIPTED_HOLD=1       ignore SIGTERM and stdin closing; only SIGKILL ends it
//   SCRIPTED_STDERR       lines written to stderr at startup ("|" separated)
//   SCRIPTED_CALL_DELAY_MS  delay every tools/call answer by this much
//   SCRIPTED_DEAF_MS      this long after initialized, stop reading stdin for good (stay alive)
import fs from 'node:fs';
import readline from 'node:readline';

const env = process.env;
const pages = (env.SCRIPTED_PAGES ?? '').split('|').map((p) => p.split(',').filter(Boolean));
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const later = (ms, f) => setTimeout(f, ms);
/** @type {Map<string, string>} */
const asked = new Map();
let lists = 0;

if (env.SCRIPTED_HOLD === '1') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1e6);
}
for (const line of (env.SCRIPTED_STDERR ?? '').split('|').filter(Boolean)) process.stderr.write(`${line}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (env.SCRIPTED_ECHO === '1' && m.method) process.stderr.write(`got ${m.method}\n`);
  if (m.method === 'initialize') {
    if (env.SCRIPTED_INIT_SILENT === '1') return;
    if (env.SCRIPTED_INIT_ERROR === '1') send({ id: m.id, error: { code: -32603, message: 'scripted: cannot initialize' } });
    else send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'scripted', version: '1.0.0' } } });
  } else if (m.method === 'notifications/initialized') {
    for (const [i, method] of (env.SCRIPTED_REQUESTS ?? '').split(',').filter(Boolean).entries()) {
      asked.set(`s${i}`, method);
      send({ id: `s${i}`, method, params: {} });
    }
    if (env.SCRIPTED_STRAY === '1') send({ id: 999999, result: {} });
    const delay = Number(env.SCRIPTED_NOTIFY_DELAY_MS ?? 0);
    for (const method of (env.SCRIPTED_NOTIFY ?? '').split(',').filter(Boolean)) later(delay, () => send({ method, params: JSON.parse(env.SCRIPTED_NOTIFY_PARAMS ?? '{}') }));
    if (env.SCRIPTED_DEAF_MS) {
      later(Number(env.SCRIPTED_DEAF_MS), () => {
        rl.close();
        // Node never closes fds 0-2 when their stream is destroyed; close fd 0 itself, so the
        // pipe has no reader left.
        process.stdin.destroy();
        setImmediate(() => {
          fs.closeSync(0);
          process.stderr.write('deaf\n');
        });
        setInterval(() => {}, 1e6);
      });
    }
  } else if (m.method === 'tools/list') {
    lists++;
    const at = m.params?.cursor ? Number(m.params.cursor) : 0;
    const tools = (pages[at] ?? []).map((name) => ({ name, inputSchema: { type: 'object' } }));
    let nextCursor;
    if (env.SCRIPTED_SAME_CURSOR === '1' && at === 1) nextCursor = '1';
    else if (at + 1 < pages.length) nextCursor = String(at + 1);
    const answer = lists > 1 && env.SCRIPTED_LIST_FAIL === '1'
      ? { id: m.id, error: { code: -32603, message: 'scripted: cannot list' } }
      : { id: m.id, result: { tools, ...(nextCursor ? { nextCursor } : {}) } };
    later(Number(env.SCRIPTED_LIST_DELAY_MS ?? 0), () => send(answer));
  } else if (m.method === 'tools/call') {
    later(Number(env.SCRIPTED_CALL_DELAY_MS ?? 0), () => send({ id: m.id, result: { content: [{ type: 'text', text: `called ${m.params.name}` }] } }));
  } else if (m.id !== undefined && asked.has(m.id)) {
    process.stderr.write(`answer ${asked.get(m.id)} ${JSON.stringify(m.error ?? m.result)}\n`);
  } else if (m.method === 'ping') {
    send({ id: m.id, result: {} });
  }
});
