// Redaction of secrets in text that the patchbay itself emits: logs, errors, `servers`/`info`
// output, doctor output. Pass-through content (tool results, tool lists, child instructions) is
// not touched. See SPEC.md §6.

const R = '[redacted]';

/** Minimum length for an exact-match secret (entry env values, args, header values). */
export const MIN_SECRET_LENGTH = 6;

const SECRET_KEY = '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|api[_-]?key|apikey|authorization|cookie|session(?:[_-]?id)?)';

/** @type {Array<[RegExp, string | ((...m: string[]) => string)]>} */
const RULES = [
  // URL userinfo: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi, `$1${R}@`],
  // URL query strings: keep the path, drop everything from ? to whitespace, quote or #
  [/\b((?:https?|wss?|ftp|file):\/\/[^\s?#'"<>]*)\?[^\s#'"<>]*/gi, `$1?${R}`],
  // Authorization schemes
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${R}`],
  // "key": "value" in JSON-ish text
  [new RegExp(`("${SECRET_KEY}"\\s*:\\s*")[^"]*(")`, 'gi'), `$1${R}$2`],
  // key=value / key: value
  [new RegExp(`\\b(${SECRET_KEY})(\\s*[=:]\\s*)(?!\\[redacted\\])(?!Bearer\\b|Basic\\b)[^\\s,;&'"]+`, 'gi'), `$1$2${R}`],
  // Well-known token prefixes
  [/\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, R],
  // JWT-shaped
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, R],
  // long hex runs
  [/\b[0-9a-fA-F]{32,}\b/g, R],
];

// Long base64 / base64url runs with mixed character classes. Runs that start with "/" are left
// alone, which spares most absolute paths.
const B64 = /(^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+_-][A-Za-z0-9+/_-]{39,}={0,2})/g;

/**
 * Redacts secrets from `input`.
 * @param {unknown} input
 * @param {string[]} [secrets] exact strings to scrub (already filtered by length)
 * @returns {string}
 */
export function redact(input, secrets = []) {
  let s;
  if (input === undefined || input === null) return '';
  if (input instanceof Error) s = `${input.name}: ${input.message}`;
  else s = typeof input === 'string' ? input : String(input);
  if (secrets.length) {
    const sorted = [...new Set(secrets)].sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
      if (secret.length >= MIN_SECRET_LENGTH) s = s.split(secret).join(R);
    }
  }
  for (const [re, rep] of RULES) s = s.replace(re, /** @type {any} */ (rep));
  s = s.replace(B64, (m, pre, run) => {
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) return `${pre}${R}`;
    return m;
  });
  return s;
}

/**
 * The exact strings to scrub for one server entry: its env values, args and header values.
 * @param {{args?: string[], env?: Record<string,string>, headers?: Record<string,string>}} entry
 * @returns {string[]}
 */
export function secretsFor(entry) {
  const out = [];
  for (const v of entry.args ?? []) out.push(v);
  for (const v of Object.values(entry.env ?? {})) out.push(v);
  for (const v of Object.values(entry.headers ?? {})) {
    out.push(v);
    // "Bearer xyz": also the bare credential
    const parts = v.split(/\s+/);
    if (parts.length > 1) out.push(parts.slice(1).join(' '));
  }
  return out.filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH);
}

/** A fixed-size buffer of the most recent lines. */
export class RingBuffer {
  /** @param {number} size */
  constructor(size) {
    this.size = size;
    /** @type {string[]} */
    this.buf = [];
  }

  /** @param {string} line */
  push(line) {
    this.buf.push(line);
    if (this.buf.length > this.size) this.buf.splice(0, this.buf.length - this.size);
  }

  /** @param {number} [n] */
  lines(n) {
    return n === undefined ? [...this.buf] : this.buf.slice(-n);
  }

  last() {
    return this.buf[this.buf.length - 1];
  }
}
