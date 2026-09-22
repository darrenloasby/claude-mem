/**
 * 30-case stress suite for schema enforcement, split two ways:
 *
 * - Part A (20 cases): real historical tool-call records pulled from actual
 *   claude/codex sessions across this machine (fixtures/gnarly-real-world.json,
 *   see scripts/../fixtures) -- built into the exact `observed_from_primary_session`
 *   shape claude-mem sends, run through classifyContent + trimMessages. This
 *   is the input side: does real, messy, unpredictable tool-call content
 *   (huge outputs, unicode, ANSI escapes, embedded JSON, error dumps, empty
 *   results) break our classifier/trimmer.
 *
 * - Part B (11 cases): hand-crafted adversarial JSON payloads fed directly to
 *   observationJsonToXml/summaryJsonToXml. This matters more since the
 *   backend.ts/schema.ts fix (json_object + prompt-grounded schema instead
 *   of grammar-constrained json_schema, see schema.ts) traded away AJV-level
 *   shape guarantees to dodge the gemma-4-26b runaway bug -- so toXml.ts is
 *   now the only thing standing between a misbehaving model and a broken
 *   claude-mem XML payload. This is the output side: does malformed,
 *   incomplete, or hostile model output break the serializer.
 *
 * - Part C: validate.ts, the quality gate that decides whether a response is
 *   good enough to render or should be escalated to FALLBACK_MODEL (see
 *   server.ts generateStructuredXml). Confirms it correctly separates the
 *   "renders without crashing" cases in Part B from the "actually good
 *   enough to keep" cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { classifyContent } from '../src/classify.js';
import { trimMessages, type ChatMessage } from '../src/trim.js';
import { observationJsonToXml, summaryJsonToXml } from '../src/toXml.js';
import { validateObservationJson, validateSummaryJson } from '../src/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RealRecord {
  harness: string;
  bucket: string;
  tool_name: string;
  parameters: string;
  outcome: string;
}

const realRecords: RealRecord[] = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'gnarly-real-world.json'), 'utf8'),
).slice(0, 20);

function buildObservationTurn(record: RealRecord): string {
  return `<observed_from_primary_session>
  <what_happened>${record.tool_name}</what_happened>
  <occurred_at>2026-09-21T12:00:00Z</occurred_at>
  <working_directory>/repo</working_directory>
  <parameters>${JSON.stringify(record.parameters)}</parameters>
  <outcome>${JSON.stringify(record.outcome)}</outcome>
</observed_from_primary_session>

Return either one or more <observation>...</observation> blocks, or <skip_summary reason="noise" /> if this tool use should be skipped.`;
}

// ---------------------------------------------------------------------------
// Part A: real historical tool-call data through classify + trim
// ---------------------------------------------------------------------------

for (let i = 0; i < realRecords.length; i += 1) {
  const record = realRecords[i];
  test(`A${i + 1} [${record.harness}/${record.bucket}] ${record.tool_name}: classify+trim survives real tool-call data`, () => {
    const content = buildObservationTurn(record);
    const message: ChatMessage = { role: 'user', content };

    // classify() must recognize this as an observation turn regardless of
    // what garbage is embedded in parameters/outcome.
    const mode = classifyContent(content);
    assert.equal(mode, 'observation', `expected mode=observation, got ${mode}`);

    // trimMessages must not throw on any real-world content shape, and must
    // actually produce a compacted turn (not pass the giant instructional
    // suffix through unchanged).
    let trimmed: ChatMessage[];
    assert.doesNotThrow(() => {
      trimmed = trimMessages([message]);
    }, 'trimMessages threw on real tool-call content');
    trimmed = trimMessages([message]);

    assert.equal(trimmed.length, 1);
    const out = trimmed[0].content;
    assert.ok(out.startsWith('Tool: '), `expected trimmed content to start with "Tool: ", got: ${out.slice(0, 60)}`);
    assert.ok(!out.includes('Return either one or more'), 'trimmed content leaked the untrimmed instruction suffix');
    // The trim must not silently produce an empty/near-empty string even
    // when the source outcome was itself huge or empty.
    assert.ok(out.length > 'Tool: '.length, 'trimmed content is suspiciously empty');
  });
}

// ---------------------------------------------------------------------------
// Part B: adversarial / malformed JSON directly at the XML serializer
// ---------------------------------------------------------------------------

function assertNoRawSpecialChars(xml: string, context: string): void {
  // Every '<' in valid output must open one of our own known tags; a stray
  // unescaped '<' from injected model content would corrupt the XML claude-mem
  // parses. Cheap check: count of '<' must equal count of '>' pairs.
  const opens = (xml.match(/</g) ?? []).length;
  const closes = (xml.match(/>/g) ?? []).length;
  assert.equal(opens, closes, `${context}: mismatched < > counts, likely unescaped injection`);
}

test('B1: completely empty object', () => {
  const xml = observationJsonToXml({} as any);
  assert.ok(xml.includes('<skip_summary'), 'empty object should fall back to skip_summary');
  assertNoRawSpecialChars(xml, 'B1');
});

test('B2: action missing entirely, observations present', () => {
  const xml = observationJsonToXml({ observations: [{ type: 'bugfix', title: 'x', subtitle: 'y', facts: ['a', 'b', 'c', 'd'], narrative: 'n', concepts: [], files_read: [], files_modified: [] }] } as any);
  assert.ok(xml.includes('<observation>'), 'should still render the observation despite missing action');
  assertNoRawSpecialChars(xml, 'B2');
});

test('B3: action=observe but observations missing -> falls back to skip', () => {
  const xml = observationJsonToXml({ action: 'observe' } as any);
  assert.ok(xml.includes('<skip_summary'), 'missing observations array should fall back to skip_summary, not throw');
});

test('B4: observations is a string, not an array', () => {
  assert.doesNotThrow(() => observationJsonToXml({ action: 'observe', observations: 'not an array' } as any));
  const xml = observationJsonToXml({ action: 'observe', observations: 'not an array' } as any);
  assert.ok(xml.includes('<skip_summary'), 'non-array observations should be treated as absent, not crash');
});

test('B5: facts is a single string instead of an array', () => {
  const xml = observationJsonToXml({
    action: 'observe',
    observations: [{ type: 'bugfix', title: 't', subtitle: 's', facts: 'this should be an array', narrative: 'n', concepts: [], files_read: [], files_modified: [] }],
  } as any);
  assert.ok(!xml.includes('<fact>'), 'a non-array facts field should not silently iterate a string char-by-char or crash');
  assertNoRawSpecialChars(xml, 'B5');
});

test('B6: title/narrative contain raw XML special characters', () => {
  const xml = observationJsonToXml({
    action: 'observe',
    observations: [{
      type: 'bugfix',
      title: 'Fixed <script>alert(1)</script> & "quoted" issue',
      subtitle: 's',
      facts: ['a', 'b', 'c', 'd'],
      narrative: 'Uses < and > and & and " liberally',
      concepts: [],
      files_read: [],
      files_modified: [],
    }],
  } as any);
  assert.ok(!xml.includes('<script>'), 'raw <script> tag must be escaped, not passed through');
  assert.ok(xml.includes('&lt;script&gt;'), 'expected the tag to be XML-escaped');
  assertNoRawSpecialChars(xml, 'B6');
});

test('B7: title attempts XML injection with a fake closing/opening tag', () => {
  const xml = observationJsonToXml({
    action: 'observe',
    observations: [{
      type: 'bugfix',
      title: '</observation><observation><type>hacked</type><title>injected',
      subtitle: 's',
      facts: ['a', 'b', 'c', 'd'],
      narrative: 'n',
      concepts: [],
      files_read: [],
      files_modified: [],
    }],
  } as any);
  // Exactly one real <observation> open tag must survive -- the injected
  // text must be escaped, not parsed as a second sibling element.
  const observationOpens = (xml.match(/<observation>/g) ?? []).length;
  assert.equal(observationOpens, 1, 'injected </observation><observation> text must not create a second real element');
  assertNoRawSpecialChars(xml, 'B7');
});

test('B8: narrative is a 50,000 character string', () => {
  const huge = 'x'.repeat(50_000);
  const xml = observationJsonToXml({
    action: 'observe',
    observations: [{ type: 'bugfix', title: 't', subtitle: 's', facts: ['a', 'b', 'c', 'd'], narrative: huge, concepts: [], files_read: [], files_modified: [] }],
  } as any);
  assert.ok(xml.includes(huge), 'huge narrative should be preserved, not truncated by the serializer itself');
});

test('B9: concepts array contains non-string items (numbers, null, nested object)', () => {
  assert.doesNotThrow(() => observationJsonToXml({
    action: 'observe',
    observations: [{
      type: 'bugfix', title: 't', subtitle: 's', facts: ['a', 'b', 'c', 'd'], narrative: 'n',
      concepts: [42, null, { nested: true }, 'gotcha'],
      files_read: [], files_modified: [],
    }],
  } as any));
});

test('B10: 20 observations in one response (well past the old maxItems:5, unenforced under json_object)', () => {
  const observations = Array.from({ length: 20 }, (_, i) => ({
    type: 'change', title: `t${i}`, subtitle: `s${i}`, facts: ['a', 'b', 'c', 'd'], narrative: `n${i}`, concepts: [], files_read: [], files_modified: [],
  }));
  const xml = observationJsonToXml({ action: 'observe', observations } as any);
  const observationOpens = (xml.match(/<observation>/g) ?? []).length;
  assert.equal(observationOpens, 20, 'all 20 observations should render, not silently truncate');
});

test('B11 (bonus): summaryJsonToXml on a completely empty object', () => {
  assert.doesNotThrow(() => summaryJsonToXml({} as any));
  const xml = summaryJsonToXml({} as any);
  assert.ok(xml.startsWith('<summary>') && xml.endsWith('</summary>'), 'malformed summary input should still produce a well-formed <summary> shell');
});

// ---------------------------------------------------------------------------
// Part C: the validation gate that decides render-vs-escalate
// ---------------------------------------------------------------------------

const VALID_OBSERVATION = {
  action: 'observe',
  skip_reason: '',
  observations: [{
    type: 'bugfix',
    title: 'Fixed null pointer in login handler',
    subtitle: 'Session token read before the null check',
    facts: ['a', 'b', 'c', 'd'],
    narrative: 'n',
    concepts: ['problem-solution'],
    files_read: [],
    files_modified: ['src/auth.ts'],
  }],
};

test('C1: a genuinely valid observation passes with zero problems', () => {
  assert.deepEqual(validateObservationJson(VALID_OBSERVATION), []);
});

test('C2: a valid skip passes with zero problems', () => {
  assert.deepEqual(validateObservationJson({ action: 'skip', skip_reason: 'noise', observations: [] }), []);
});

test('C3: every Part B failure case that is NOT a legitimate skip is flagged by the validator', () => {
  // B1-B5 are all cases that render as <skip_summary> in toXml -- correctly
  // so, since none of them is actually a usable observation. The validator
  // must agree action=observe cases among them are invalid, catching what
  // toXml's defensiveness silently downgrades to a skip.
  assert.ok(validateObservationJson({}).length > 0, 'empty object must be flagged');
  assert.ok(validateObservationJson({ action: 'observe' }).length > 0, 'observe with no observations must be flagged');
  assert.ok(validateObservationJson({ action: 'observe', observations: 'not an array' }).length > 0, 'non-array observations must be flagged');
});

test('C4: an observation with an out-of-enum type is flagged', () => {
  const bad = { action: 'observe', observations: [{ ...VALID_OBSERVATION.observations[0], type: 'made_up_type' }] };
  const problems = validateObservationJson(bad);
  assert.ok(problems.some((p) => p.includes('type')), `expected a type-related problem, got: ${JSON.stringify(problems)}`);
});

test('C5: an observation with facts as a non-array string is flagged (matches Part B5)', () => {
  const bad = { action: 'observe', observations: [{ ...VALID_OBSERVATION.observations[0], facts: 'not an array' }] };
  const problems = validateObservationJson(bad);
  assert.ok(problems.some((p) => p.includes('facts')), `expected a facts-related problem, got: ${JSON.stringify(problems)}`);
});

test('C6: a complete, correctly-typed summary passes with zero problems', () => {
  const valid = { request: 'r', investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: '' };
  assert.deepEqual(validateSummaryJson(valid), []);
});

test('C7: a summary missing a required field is flagged', () => {
  const problems = validateSummaryJson({ request: 'r', investigated: 'i', learned: 'l', completed: 'c' });
  assert.ok(problems.some((p) => p.includes('next_steps')), `expected next_steps to be flagged, got: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes('notes')), `expected notes to be flagged, got: ${JSON.stringify(problems)}`);
});
