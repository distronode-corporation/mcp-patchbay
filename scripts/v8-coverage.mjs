#!/usr/bin/env node
// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// Coverage across operating systems. Each CI test leg runs the suite with NODE_V8_COVERAGE set
// and keeps only what V8 recorded for src/ (`collect`); one Linux job then puts every leg's
// files in one directory (`merge`) for `c8 report`, which merges V8's range trees and holds the
// floor in .c8rc.json. A platform branch is so measured on the system that takes it.
//
//   node scripts/v8-coverage.mjs collect <NODE_V8_COVERAGE dir> <out dir>
//   node scripts/v8-coverage.mjs merge <out dir> <leg dir> [<leg dir> ...]
//
// collect stores each script's URL relative to the repository (src/x.js), and, for a checkout
// with CRLF line endings (Windows), moves V8's offsets to where they fall in the LF text the
// merge job checks out. merge refuses a leg directory that is missing or holds no coverage, so a
// leg that did not report can never pass as covered.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repository-relative path (forward slashes) of a script V8 recorded, when it is under src/.
 * @param {string} url
 * @param {string} root
 * @returns {string | null}
 */
export function srcPathOf(url, root) {
  if (!url.startsWith('file:')) return null;
  const rel = path.relative(root, fileURLToPath(url));
  const parts = rel.split(path.sep);
  if (parts[0] !== 'src' || parts.length < 2) return null;
  return parts.join('/');
}

/**
 * Maps an offset in `text` to the same place once every CR before an LF is removed.
 * @param {string} text
 * @returns {(offset: number) => number}
 */
export function lfOffsets(text) {
  /** @type {number[]} */
  const removed = [];
  for (let i = text.indexOf('\r\n'); i !== -1; i = text.indexOf('\r\n', i + 2)) removed.push(i);
  return (offset) => {
    let lo = 0;
    let hi = removed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (removed[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return offset - lo;
  };
}

/**
 * @param {string} rawDir
 * @param {string} outDir
 * @param {string} [root]
 * @returns {number} how many scripts were kept
 */
export function collect(rawDir, outDir, root = ROOT) {
  fs.mkdirSync(outDir, { recursive: true });
  /** @type {Map<string, (offset: number) => number>} */
  const maps = new Map();
  let kept = 0;
  for (const name of fs.readdirSync(rawDir).filter((n) => n.endsWith('.json')).sort()) {
    const { result } = JSON.parse(fs.readFileSync(path.join(rawDir, name), 'utf8'));
    const scripts = [];
    for (const script of result) {
      const rel = srcPathOf(script.url, root);
      if (!rel) continue;
      let map = maps.get(rel);
      if (!map) {
        map = lfOffsets(fs.readFileSync(path.join(root, rel), 'utf8'));
        maps.set(rel, map);
      }
      for (const fn of script.functions) {
        for (const range of fn.ranges) {
          range.startOffset = map(range.startOffset);
          range.endOffset = map(range.endOffset);
        }
      }
      scripts.push({ ...script, url: rel });
    }
    if (!scripts.length) continue;
    fs.writeFileSync(path.join(outDir, name), JSON.stringify({ result: scripts }));
    kept += scripts.length;
  }
  if (!kept) throw new Error(`${rawDir} holds no coverage of src/`);
  return kept;
}

/**
 * @param {string} outDir
 * @param {string[]} legDirs
 * @param {string} [root]
 * @returns {number} how many files were written
 */
export function merge(outDir, legDirs, root = ROOT) {
  if (!legDirs.length) throw new Error('merge needs at least one leg directory');
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const [i, dir] of legDirs.entries()) {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : [];
    if (!names.length) throw new Error(`no coverage from leg ${dir}: it is missing or empty`);
    for (const name of names) {
      const { result } = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const scripts = result.map((s) => ({ ...s, url: pathToFileURL(path.join(root, s.url)).href }));
      fs.writeFileSync(path.join(outDir, `leg${i}-${name}`), JSON.stringify({ result: scripts }));
      written++;
    }
  }
  return written;
}

/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'collect' && args.length === 2) {
      console.log(`kept coverage of ${collect(args[0], args[1])} script(s) under src/`);
      return 0;
    }
    if (cmd === 'merge' && args.length >= 2) {
      console.log(`merged ${merge(args[0], args.slice(1))} coverage file(s) from ${args.length - 1} leg(s)`);
      return 0;
    }
    console.error('usage: v8-coverage.mjs collect <raw dir> <out dir> | merge <out dir> <leg dir>...');
    return 64;
  } catch (e) {
    console.error(`v8-coverage: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
