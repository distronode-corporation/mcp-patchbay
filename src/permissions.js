// Claude Code permission rules that would approve enable_confirm without asking the person.
// Used by `doctor` (to warn) and `rename-permissions` (never to write one). See SECURITY-MODEL.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonSyntaxMessage } from './config.js';
import { CLIENT_PREFIX } from './naming.js';

export const ENABLE_CONFIRM_CLIENT_NAME = `${CLIENT_PREFIX}enable_confirm`;
const SERVER_RULE = CLIENT_PREFIX.slice(0, -2); // "mcp__patchbay": the whole server

/**
 * Would this permission rule match the client name of enable_confirm? Covers the exact name,
 * the whole-server rule `mcp__patchbay`, and any rule with `*` wildcards (`mcp__patchbay__*`,
 * `mcp__*`, `*`). A rule with a parenthesised specifier is treated by what precedes it.
 * @param {unknown} rule
 */
export function ruleMatchesEnableConfirm(rule) {
  if (typeof rule !== 'string') return false;
  let r = rule.trim();
  const paren = r.indexOf('(');
  if (paren !== -1) r = r.slice(0, paren);
  if (r === SERVER_RULE) return true;
  if (!r.includes('*')) return r === ENABLE_CONFIRM_CLIENT_NAME;
  const escaped = r.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(ENABLE_CONFIRM_CLIENT_NAME);
}

/**
 * The Claude Code settings files doctor reads: the user's, and with a project dir, the project's.
 * @param {{home?: string, project?: string}} [o]
 */
export function settingsFiles(o = {}) {
  const home = o.home ?? os.homedir();
  const files = [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json')];
  if (o.project) files.push(path.join(o.project, '.claude', 'settings.json'), path.join(o.project, '.claude', 'settings.local.json'));
  return files;
}

/**
 * Reads each settings file and reports what would approve enable_confirm without a prompt:
 * allow rules that match it, and `permissions.defaultMode: "bypassPermissions"`.
 * @param {string[]} files
 * @returns {Array<{file: string, status: 'missing'|'unreadable'|'ok', error?: string, rules: string[], bypass: boolean}>}
 */
export function scanSettings(files) {
  return files.map((file) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      if (code === 'ENOENT') return { file, status: 'missing', rules: [], bypass: false };
      return { file, status: 'unreadable', error: `cannot read: ${code ?? e}`, rules: [], bypass: false };
    }
    let settings;
    try {
      settings = JSON.parse(text);
    } catch {
      // Never the parser's message: it quotes the text around the error (settings can hold env).
      return { file, status: 'unreadable', error: jsonSyntaxMessage(file, text), rules: [], bypass: false };
    }
    const perms = settings?.permissions ?? {};
    const allow = Array.isArray(perms.allow) ? perms.allow : [];
    return {
      file,
      status: 'ok',
      rules: allow.filter(ruleMatchesEnableConfirm),
      bypass: perms.defaultMode === 'bypassPermissions',
    };
  });
}
