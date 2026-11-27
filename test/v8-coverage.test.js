// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// scripts/v8-coverage.mjs: what each CI leg keeps, and the merge that refuses a missing leg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { collect, lfOffsets, merge, srcPathOf } from '../scripts/v8-coverage.mjs';
import { ROOT, tmpdir } from './helpers.js';

const SCRIPT = path.join(ROOT, 'scripts', 'v8-coverage.mjs');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

/** A V8 coverage file as NODE_V8_COVERAGE writes it, with one range per script. */
function rawFile(dir, name, scripts) {
  fs.mkdirSync(dir, { recursive: true });
  const result = scripts.map(({ url, start, end }) => ({
    scriptId: '1',
    url,
    functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: start, endOffset: end, count: 1 }] }],
  }));
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ result, 'source-map-cache': {} }));
}

/** A scratch repository root with src/a.js holding `text`. */
function repoWith(text) {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), text);
  fs.writeFileSync(path.join(root, 'src', 'sub', 'b.js'), 'x\n');
  return root;
}

const urlOf = (root, ...p) => pathToFileURL(path.join(root, ...p)).href;

test('srcPathOf keeps scripts under src/ only, as forward-slash paths', () => {
  const root = repoWith('');
  assert.equal(srcPathOf(urlOf(root, 'src', 'a.js'), root), 'src/a.js');
  assert.equal(srcPathOf(urlOf(root, 'src', 'sub', 'b.js'), root), 'src/sub/b.js');
  assert.equal(srcPathOf(urlOf(root, 'test', 'a.test.js'), root), null);
  assert.equal(srcPathOf(urlOf(root, 'srcx', 'a.js'), root), null);
  assert.equal(srcPathOf(urlOf(root, 'src'), root), null, 'the directory itself is not a script');
  assert.equal(srcPathOf(urlOf(path.dirname(root), 'src', 'a.js'), root), null, 'a src/ outside the repository');
  assert.equal(srcPathOf('node:fs', root), null);
  assert.equal(srcPathOf('evalmachine.<anonymous>', root), null);
});

test('lfOffsets moves each offset back by the CRs before it, and leaves LF text alone', () => {
  const crlf = 'ab\r\ncd\r\n\r\ne';
  const lf = crlf.replaceAll('\r\n', '\n');
  const map = lfOffsets(crlf);
  // Every character that survives keeps its identity: crlf[i] lands on the same character in lf.
  for (let i = 0; i < crlf.length; i++) {
    if (crlf[i] === '\r') continue;
    assert.equal(lf[map(i)], crlf[i], `offset ${i}`);
  }
  assert.equal(map(crlf.length), lf.length, 'the end of the text');
  assert.equal(map(0), 0);
  const plain = lfOffsets(lf);
  for (let i = 0; i <= lf.length; i++) assert.equal(plain(i), i);
  // A lone CR is not a line ending and stays.
  assert.equal(lfOffsets('a\rb')(2), 2);
});

test('collect keeps only src/ scripts, relative, with CRLF offsets moved to the LF text', () => {
  const root = repoWith('one\r\ntwo\r\n');
  const raw = path.join(tmpdir(), 'raw');
  const out = path.join(tmpdir(), 'out');
  // Offset 5 is "t" of "two" in the CRLF text, 4 in the LF text; 10 is the end (8 in LF).
  rawFile(raw, 'coverage-1.json', [
    { url: urlOf(root, 'src', 'a.js'), start: 5, end: 10 },
    { url: urlOf(root, 'test', 'x.test.js'), start: 0, end: 3 },
    { url: 'node:internal/main', start: 0, end: 3 },
  ]);
  rawFile(raw, 'coverage-2.json', [{ url: urlOf(root, 'src', 'a.js'), start: 0, end: 3 }]);
  rawFile(raw, 'coverage-3.json', [{ url: 'node:fs', start: 0, end: 3 }]);
  fs.writeFileSync(path.join(raw, 'not-coverage.txt'), 'ignored');
  assert.equal(collect(raw, out, root), 2);
  assert.deepEqual(fs.readdirSync(out).sort(), ['coverage-1.json', 'coverage-2.json'], 'a file with nothing under src/ is dropped');
  const one = JSON.parse(fs.readFileSync(path.join(out, 'coverage-1.json'), 'utf8'));
  assert.equal(one.result.length, 1);
  assert.equal(one.result[0].url, 'src/a.js');
  assert.deepEqual(one.result[0].functions[0].ranges[0], { startOffset: 4, endOffset: 8, count: 1 });
  assert.equal(one['source-map-cache'], undefined);
});

test('collect refuses a run that recorded nothing under src/', () => {
  const root = repoWith('x\n');
  const raw = path.join(tmpdir(), 'raw');
  rawFile(raw, 'coverage-1.json', [{ url: 'node:fs', start: 0, end: 1 }]);
  assert.throws(() => collect(raw, path.join(tmpdir(), 'out'), root), /holds no coverage of src\//);
});

test('merge writes every leg\'s files with absolute URLs, and refuses a missing or empty leg', () => {
  const root = repoWith('x\n');
  const legA = path.join(tmpdir(), 'a');
  const legB = path.join(tmpdir(), 'b');
  for (const leg of [legA, legB]) {
    fs.mkdirSync(leg);
    fs.writeFileSync(path.join(leg, 'coverage-1.json'), JSON.stringify({ result: [{ url: 'src/a.js', functions: [] }] }));
  }
  const out = path.join(tmpdir(), 'merged');
  assert.equal(merge(out, [legA, legB], root), 2);
  assert.deepEqual(fs.readdirSync(out).sort(), ['leg0-coverage-1.json', 'leg1-coverage-1.json'], 'same names from two legs do not collide');
  const merged = JSON.parse(fs.readFileSync(path.join(out, 'leg1-coverage-1.json'), 'utf8'));
  assert.equal(merged.result[0].url, urlOf(root, 'src', 'a.js'));

  const empty = path.join(tmpdir(), 'empty');
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, 'notes.txt'), 'no json here');
  assert.throws(() => merge(path.join(tmpdir(), 'm2'), [legA, empty], root), /no coverage from leg .*empty: it is missing or empty/);
  assert.throws(() => merge(path.join(tmpdir(), 'm3'), [legA, path.join(tmpdir(), 'absent')], root), /absent: it is missing or empty/);
  assert.throws(() => merge(path.join(tmpdir(), 'm4'), [], root), /at least one leg/);
});

test('the command line: usage errors exit 64, refusals exit 1, success prints a summary', () => {
  assert.equal(run().status, 64);
  assert.equal(run('collect', 'only-one').status, 64);
  assert.equal(run('merge', 'out-only').status, 64);
  assert.equal(run('publish', 'a', 'b').status, 64);

  const missing = run('merge', path.join(tmpdir(), 'out'), path.join(tmpdir(), 'no-such-leg'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^v8-coverage: no coverage from leg .*no-such-leg: it is missing or empty/);

  // A real run of this suite's own src/: a script that loads src/naming.js under NODE_V8_COVERAGE.
  const raw = path.join(tmpdir(), 'raw');
  const load = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'naming.js')).href)})`], {
    env: { ...process.env, NODE_V8_COVERAGE: raw },
  });
  assert.equal(load.status, 0);
  const out = path.join(tmpdir(), 'out');
  const kept = run('collect', raw, out);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /^kept coverage of \d+ script\(s\) under src\//);
  const merged = run('merge', path.join(tmpdir(), 'merged'), out);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stdout, /^merged \d+ coverage file\(s\) from 1 leg\(s\)/);
});
