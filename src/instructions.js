// The patchbay's own `instructions` (initialize result). See SPEC.md §3.2.

export const MAX_INSTRUCTIONS = 4096;
const CATALOGUE_MAX = 3000;
const DESCRIPTION_MAX = 120;
const TRUNC = '…[truncated]';

const HEADER = [
  'mcp-patchbay hosts the MCP servers listed below and can switch them on and off during the session.',
  'Call `servers` for their current state, `enable` {name} to turn one on (its tools then appear as <server>__<tool>; some servers need a person to approve), and `disable` {name} to turn it off again. `info` {name} shows a server\'s own instructions.',
  'Servers:',
].join('\n');

/**
 * Water-fills `budget` over items of the given lengths: each gets min(length, equal share of
 * what is left), with unused share redistributed.
 * @param {number[]} lengths
 * @param {number} budget
 * @returns {number[]}
 */
export function fairShare(lengths, budget) {
  const out = lengths.map(() => 0);
  let left = Math.max(0, budget);
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  let remaining = order.length;
  for (const { len, i } of order) {
    const share = Math.floor(left / remaining);
    const take = Math.min(len, share);
    out[i] = take;
    left -= take;
    remaining--;
  }
  return out;
}

/** @param {string} s @param {number} n */
export function truncate(s, n) {
  if (s.length <= n) return s;
  if (n <= TRUNC.length) return s.slice(0, Math.max(0, n));
  return s.slice(0, n - TRUNC.length) + TRUNC;
}

/**
 * @param {Array<{name: string, description: string, policy: string, state: string}>} servers
 * @param {Array<{name: string, instructions: string}>} autostarted those that are on and have instructions
 * @returns {string}
 */
export function buildInstructions(servers, autostarted) {
  const lines = [];
  let used = HEADER.length;
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    const desc = s.description ? `: ${truncate(s.description, DESCRIPTION_MAX)}` : '';
    const line = `- ${s.name} [${s.policy === 'deny' ? 'deny' : `${s.state}, ${s.policy}`}]${desc}`;
    const more = servers.length - i;
    const tail = `- … ${more} more; call servers`;
    if (used + 1 + line.length + 1 + tail.length > CATALOGUE_MAX && i < servers.length - 1) {
      lines.push(tail);
      used += 1 + tail.length;
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  let text = `${HEADER}\n${lines.join('\n')}`;

  const blocks = autostarted.filter((a) => a.instructions);
  if (blocks.length) {
    const heads = blocks.map((b) => `\n\n## ${b.name} instructions\n`);
    const overhead = heads.reduce((n, h) => n + h.length, 0);
    const budget = MAX_INSTRUCTIONS - text.length - overhead;
    const shares = fairShare(blocks.map((b) => b.instructions.length), budget);
    blocks.forEach((b, i) => {
      if (shares[i] <= 0) return;
      text += heads[i] + truncate(b.instructions, shares[i]);
    });
  }
  if (text.length > MAX_INSTRUCTIONS) text = truncate(text, MAX_INSTRUCTIONS);
  return text;
}
