// stderr-only logging. stdout belongs to MCP.
import { redact } from './redact.js';

/**
 * @typedef {{info: (msg: string, secrets?: string[]) => void, warn: (msg: string, secrets?: string[]) => void, error: (msg: string, secrets?: string[]) => void, debug: (msg: string, secrets?: string[]) => void}} Logger
 */

/**
 * @param {{debug?: boolean, write?: (s: string) => void}} [o]
 * @returns {Logger}
 */
export function createLogger(o = {}) {
  const write = o.write ?? ((s) => { try { process.stderr.write(s); } catch { /* stderr gone */ } });
  const debugOn = o.debug ?? process.env.MCP_PATCHBAY_DEBUG === '1';
  const emit = (level, msg, secrets) => write(`[mcp-patchbay] ${level}: ${redact(msg, secrets)}\n`);
  return {
    info: (m, s) => emit('info', m, s),
    warn: (m, s) => emit('warn', m, s),
    error: (m, s) => emit('error', m, s),
    debug: (m, s) => { if (debugOn) emit('debug', m, s); },
  };
}
