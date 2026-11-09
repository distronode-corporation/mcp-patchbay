// The public naming contract: how a child's tool name becomes the name the client sees.
// See SPEC.md §4 and README "Naming contract".
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';

/** What Claude Code puts in front of every tool of a server registered as "patchbay". */
export const CLIENT_PREFIX = 'mcp__patchbay__';
/** Claude Code's limit on a full tool name. */
export const MAX_CLIENT_NAME = 128;
export const SEPARATOR = '__';

const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Server names and prefixes: [A-Za-z0-9_-]{1,64}, no "__", no trailing "_".
 * Together these make the first "__" in an exposed name the separator.
 * @param {string} s
 */
export function isValidSegment(s) {
  return typeof s === 'string' && SEGMENT_RE.test(s) && !s.includes('__') && !s.endsWith('_');
}

/** @param {string} name */
export function sanitizeToolName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * @param {string} segment
 * @param {string} tool original tool name
 */
export function exposedName(segment, tool) {
  return `${segment}${SEPARATOR}${sanitizeToolName(tool)}`;
}

/**
 * Splits an exposed name on its first "__".
 * @param {string} name
 * @returns {{segment: string, tool: string} | null}
 */
export function splitExposed(name) {
  const i = name.indexOf(SEPARATOR);
  if (i <= 0) return null;
  const tool = name.slice(i + SEPARATOR.length);
  if (!tool) return null;
  return { segment: name.slice(0, i), tool };
}

/**
 * @typedef {{exposed: string, original: string, tool: Record<string, unknown>}} Published
 * @typedef {{tool: string, reason: string}} Skipped
 */

/**
 * Maps a child's tools to published tools. The published tool object is the child's object
 * with only `name` replaced; everything else (schemas, annotations, title, _meta, unknown keys)
 * passes through unchanged.
 * @param {string} segment
 * @param {Array<Record<string, any>>} tools raw tools from the child's tools/list
 * @returns {{published: Published[], skipped: Skipped[]}}
 */
export function mapTools(segment, tools) {
  /** @type {Published[]} */
  const published = [];
  /** @type {Skipped[]} */
  const skipped = [];
  /** @type {Map<string, string>} */
  const taken = new Map();
  for (const tool of tools) {
    const original = typeof tool?.name === 'string' ? tool.name : '';
    if (!original) {
      skipped.push({ tool: original, reason: 'empty name' });
      continue;
    }
    if (!ToolSchema.safeParse(tool).success) {
      skipped.push({ tool: original, reason: 'invalid tool definition' });
      continue;
    }
    if (tool.execution?.taskSupport === 'required') {
      skipped.push({ tool: original, reason: 'requires task-augmented calls, which the patchbay does not support' });
      continue;
    }
    const exposed = exposedName(segment, original);
    if (CLIENT_PREFIX.length + exposed.length > MAX_CLIENT_NAME) {
      skipped.push({ tool: original, reason: `name too long: ${CLIENT_PREFIX}${exposed} exceeds ${MAX_CLIENT_NAME} characters` });
      continue;
    }
    const clash = taken.get(exposed);
    if (clash !== undefined) {
      skipped.push({ tool: original, reason: `name collides with ${clash} after sanitizing` });
      continue;
    }
    taken.set(exposed, original);
    published.push({ exposed, original, tool: { ...tool, name: exposed } });
  }
  return { published, skipped };
}
