// Property tests (fast-check) over the code that handles what child servers send: the tool
// names and tool lists from a child's tools/list (naming.js), and the text redact.js scrubs
// before the patchbay logs or reports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { CLIENT_PREFIX, MAX_CLIENT_NAME, exposedName, isValidSegment, mapTools, splitExposed } from '../src/naming.js';
import { MIN_SECRET_LENGTH, redact } from '../src/redact.js';

const segment = fc
  .stringMatching(/^[A-Za-z0-9_-]{1,64}$/)
  .filter(isValidSegment);

test('property: splitExposed undoes exposedName for every valid segment and tool name', () => {
  fc.assert(
    fc.property(segment, fc.string({ minLength: 1 }), (seg, tool) => {
      const exposed = exposedName(seg, tool);
      assert.match(exposed, /^[A-Za-z0-9_-]+$/);
      const split = splitExposed(exposed);
      assert.ok(split, exposed);
      assert.equal(split.segment, seg);
      assert.equal(exposedName(split.segment, split.tool), exposed);
      assert.equal(split.tool.length, tool.length);
    }),
    { numRuns: 500 },
  );
});

// A tool list as a misbehaving child might send it: valid tools, near-valid ones and garbage.
const toolEntry = fc.oneof(
  fc.record({
    name: fc.oneof(fc.string(), fc.stringMatching(/^[a-z_.]{1,12}$/), fc.string({ minLength: 100, maxLength: 140 })),
    inputSchema: fc.constant({ type: 'object' }),
    description: fc.option(fc.string(), { nil: undefined }),
  }, { requiredKeys: ['name', 'inputSchema'] }),
  fc.record({ name: fc.anything(), inputSchema: fc.anything() }, { requiredKeys: [] }),
  fc.anything(),
);

test('property: mapTools never throws on any tool list, and every tool is published or skipped, once', () => {
  fc.assert(
    fc.property(segment, fc.array(toolEntry, { maxLength: 20 }), (seg, tools) => {
      const { published, skipped } = mapTools(seg, tools);
      assert.equal(published.length + skipped.length, tools.length);
      const names = published.map((p) => p.exposed);
      assert.equal(new Set(names).size, names.length, 'exposed names are unique');
      for (const p of published) {
        assert.equal(p.tool.name, p.exposed);
        assert.ok(CLIENT_PREFIX.length + p.exposed.length <= MAX_CLIENT_NAME, p.exposed);
        assert.deepEqual(splitExposed(p.exposed)?.segment, seg);
        assert.equal(p.exposed, exposedName(seg, p.original));
        // Everything but `name` passes through unchanged.
        const source = tools.find((t) => t?.name === p.original);
        assert.deepEqual({ ...p.tool, name: p.original }, { ...source });
      }
      for (const s of skipped) assert.equal(typeof s.reason, 'string');
    }),
    { numRuns: 300 },
  );
});

// Secrets the caller asks redact to scrub. Alphanumeric, so no replacement can create one
// across the marker's brackets, and not a substring of the marker itself.
const secret = fc
  .stringMatching(new RegExp(`^[A-Za-z0-9]{${MIN_SECRET_LENGTH},24}$`))
  .filter((s) => !'redacted'.includes(s));

test('property: redact never throws, and no secret it was given survives in its output', () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.string(), secret), { maxLength: 8 }),
      fc.uniqueArray(secret, { maxLength: 4 }),
      (pieces, secrets) => {
        // Text that is likely to contain the secrets, glued to arbitrary text.
        const text = [...pieces, ...secrets].join(' ').concat(secrets.join(''));
        const out = redact(text, secrets);
        assert.equal(typeof out, 'string');
        for (const s of secrets) assert.ok(!out.includes(s), `${s} survived in ${out}`);
      },
    ),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(fc.anything(), (input) => {
      assert.equal(typeof redact(input), 'string');
    }),
    { numRuns: 200 },
  );
});
