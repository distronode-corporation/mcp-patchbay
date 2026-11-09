#!/usr/bin/env node
// A fake MCP server for the mcp-patchbay test suite. It uses the SDK's McpServer over stdio.
// All behaviour is selected by environment variables, so one file can play every child:
//
//   FAKE_NAME           server name reported in serverInfo (default "fake")
//   FAKE_INSTRUCTIONS   instructions text; FAKE_INSTRUCTIONS_LEN=N pads it to N chars
//   FAKE_TOOLS          comma-separated tool names. Special names get special behaviour:
//                         echo, sleep, crash, noise, grow, roots, ask, sample, structured,
//                         pid, env, fail, authline. Any other name is a plain echo tool of that
//                         name.
//   FAKE_MARKER_DIR     directory for marker files (cancelled, argv.json, signed-in)
//   FAKE_GRANDCHILD=1   spawn a long-lived grandchild in our process group at startup
//   FAKE_STDERR         text written to stderr at startup ("\n" separated lines)
//   FAKE_EXIT_ON_START  exit with this code before speaking MCP
//   FAKE_NOISE_AT_START=1  print non-JSON lines on stdout before connecting
//   FAKE_AUTH=1         print an mcp-remote style sign-in prompt on stderr, then wait for
//                       $FAKE_MARKER_DIR/signed-in to exist before connecting
//   FAKE_DUMP_ARGV=1    write {argv, env subset} to $FAKE_MARKER_DIR/argv.json at startup
//   FAKE_IGNORE_SIGTERM=1  trap SIGTERM with an empty handler and stay alive after stdin closes
//                       (the FAKE_GRANDCHILD too)
//   FAKE_LOG_URL=1      log "Connecting to remote server: <argv[0]>" on stderr, like mcp-remote
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const env = process.env;
const name = env.FAKE_NAME || 'fake';
const markerDir = env.FAKE_MARKER_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function marker(file, content) {
  if (!markerDir) return;
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, file), content);
}

if (env.FAKE_DUMP_ARGV === '1') {
  const picked = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('MCP_PATCHBAY_HEADER_') || k === 'MCP_REMOTE_CONFIG_DIR' || k.startsWith('FAKE_')) {
      picked[k] = v;
    }
  }
  marker(`argv-${name}.json`, JSON.stringify({ argv: process.argv.slice(2), env: picked }));
}

if (env.FAKE_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1e6);
}

if (env.FAKE_LOG_URL === '1') {
  process.stderr.write(`[${process.pid}] Connecting to remote server: ${process.argv[2]}\n`);
}

if (env.FAKE_STDERR) {
  for (const line of env.FAKE_STDERR.split('\n')) process.stderr.write(line + '\n');
}

if (env.FAKE_EXIT_ON_START) {
  process.exit(Number(env.FAKE_EXIT_ON_START));
}

let grandchildPid = null;
if (env.FAKE_GRANDCHILD === '1') {
  const keep = 'setInterval(() => {}, 1e6)';
  const script = env.FAKE_IGNORE_SIGTERM === '1' ? `process.on('SIGTERM', () => {}); ${keep}` : keep;
  const gc = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  grandchildPid = gc.pid;
}

if (env.FAKE_NOISE_AT_START === '1') {
  process.stdout.write('this is not json\n');
  process.stdout.write('{"also": "not jsonrpc"}\n');
}

if (env.FAKE_AUTH === '1') {
  // Same shape as mcp-remote 0.15.2: log(`\nPlease authorize this client by visiting:\n${url}\n`)
  // where log() prefixes "[pid] " and writes to stderr.
  const url = env.FAKE_AUTH_URL || 'https://auth.example.com/authorize?client_id=fake&state=abc123';
  process.stderr.write(`[${process.pid}] \nPlease authorize this client by visiting:\n${url}\n\n`);
  while (!fs.existsSync(path.join(markerDir, 'signed-in'))) {
    await sleep(20);
  }
  process.stderr.write(`[${process.pid}] Authentication successful\n`);
}

let instructions = env.FAKE_INSTRUCTIONS;
if (env.FAKE_INSTRUCTIONS_LEN) {
  const n = Number(env.FAKE_INSTRUCTIONS_LEN);
  const base = instructions || `Instructions for ${name}. `;
  instructions = base.repeat(Math.ceil(n / base.length)).slice(0, n);
}

const mcp = new McpServer({ name, version: '1.0.0' }, instructions ? { instructions } : undefined);
const tools = (env.FAKE_TOOLS || 'echo').split(',').map((s) => s.trim()).filter(Boolean);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

for (const tool of tools) {
  switch (tool) {
    case 'sleep':
      mcp.registerTool('sleep', {
        description: 'Sleeps for ms milliseconds, reporting progress',
        inputSchema: { ms: z.number(), settleMs: z.number().optional() },
      }, async ({ ms, settleMs }, extra) => {
        const token = extra._meta?.progressToken;
        const onAbort = () => marker('cancelled', String(extra.signal.reason ?? 'aborted'));
        // A cancel read with the request can abort the signal before this handler runs.
        if (extra.signal.aborted) onAbort();
        else extra.signal.addEventListener('abort', onAbort);
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          if (extra.signal.aborted) return text('aborted');
          await sleep(ms / steps);
          if (token !== undefined) {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: i, total: steps, message: `step ${i}` },
            });
          }
        }
        if (settleMs) await sleep(settleMs);
        return text(`slept ${ms}`);
      });
      break;
    case 'crash':
      mcp.registerTool('crash', { description: 'Exits the process' }, async () => {
        process.stderr.write('about to crash with token sk-abcdefghijklmnopqrstuvwxyz123456\n');
        setTimeout(() => process.exit(7), 5);
        return text('crashing');
      });
      break;
    case 'noise':
      mcp.registerTool('noise', { description: 'Prints non-JSON to stdout' }, async () => {
        process.stdout.write('garbage line one\n');
        process.stdout.write('[1,2,3\n');
        process.stdout.write('{"jsonrpc":"2.0","bogus":true}\n');
        return text('noisy');
      });
      break;
    case 'grow':
      mcp.registerTool('grow', { description: 'Registers another tool and sends list_changed' }, async () => {
        // registerTool on a connected McpServer sends notifications/tools/list_changed itself.
        mcp.registerTool('grown', { description: 'A tool added at run time' }, async () => text('grown'));
        return text('grew');
      });
      break;
    case 'roots':
      mcp.registerTool('roots', { description: 'Asks the client for roots' }, async () => {
        const r = await mcp.server.listRoots();
        return text(JSON.stringify(r.roots));
      });
      break;
    case 'ask':
      mcp.registerTool('ask', { description: 'Elicits a value from the person' }, async () => {
        const r = await mcp.server.elicitInput({
          mode: 'form',
          message: 'What colour?',
          requestedSchema: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] },
        });
        return text(JSON.stringify(r));
      });
      break;
    case 'sample':
      mcp.registerTool('sample', { description: 'Tries sampling' }, async () => {
        try {
          await mcp.server.request(
            { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 5 } },
            z.object({}).loose(),
          );
          return text('sampling unexpectedly worked');
        } catch (e) {
          return text(`sampling refused: ${e.code} ${e.message}`);
        }
      });
      break;
    case 'structured':
      // Registered without outputSchema (McpServer would enforce it); the schema is added to the
      // tools/list answer below, so the result breaks its own declared outputSchema.
      mcp.registerTool('structured', { description: 'Has outputSchema, returns no structuredContent' },
        async () => ({ content: [{ type: 'text', text: 'no structured content here' }], _meta: { 'example/trace': 'abc' } }));
      break;
    case 'authline':
      mcp.registerTool('authline', { description: 'Prints an mcp-remote style sign-in line on stderr' }, async () => {
        process.stderr.write(`Please authorize this client by visiting: ${env.FAKE_AUTH_URL || 'https://evil.example/authorize'}\n`);
        return text('printed');
      });
      break;
    case 'pid':
      mcp.registerTool('pid', { description: 'Reports pids' }, async () =>
        text(JSON.stringify({ pid: process.pid, pgid: process.pid, grandchild: grandchildPid })));
      break;
    case 'env':
      mcp.registerTool('env', {
        description: 'Reports env vars',
        inputSchema: { names: z.array(z.string()) },
      }, async ({ names }) => text(JSON.stringify(Object.fromEntries(names.map((n) => [n, env[n] ?? null])))));
      break;
    case 'fail':
      // McpServer turns errors thrown by a tool into isError results; the protocol-level error
      // is raised by the tools/call wrapper installed below.
      mcp.registerTool('fail', { description: 'Fails with a protocol error with a secret in it' }, async () => text('unreachable'));
      break;
    default:
      mcp.registerTool(tool, {
        title: `Title of ${tool}`,
        description: `Echo tool ${tool}`,
        inputSchema: { value: z.string().optional() },
        annotations: { readOnlyHint: true },
        _meta: { 'example/origin': name },
      }, async (args) => text(`${name}:${tool}:${JSON.stringify(args)}`));
  }
}

if (tools.includes('structured')) {
  const handlers = /** @type {any} */ (mcp.server)._requestHandlers;
  const original = handlers.get('tools/list');
  mcp.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const r = await original(req, extra);
    for (const t of r.tools) {
      if (t.name === 'structured') {
        t.outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
      }
    }
    return r;
  });
}

if (tools.includes('fail')) {
  const handlers = /** @type {any} */ (mcp.server)._requestHandlers;
  const original = handlers.get('tools/call');
  handlers.set('tools/call', async (req, extra) => {
    if (req.params?.name === 'fail') {
      throw new McpError(-32050, 'upstream rejected Bearer abcdefghijklmnop.qrstuvwxyz at https://api.example.com/v1?key=supersecretvalue', { hint: 'kept' });
    }
    return original(req, extra);
  });
}

await mcp.connect(new StdioServerTransport());
