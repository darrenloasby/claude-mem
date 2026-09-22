/**
 * Reconstructs the exact request body our shim sends for a real
 * observation-mode turn, using our own current code (trim + system prompt +
 * schema), so it reflects the maxItems/self-healing fixes already applied --
 * not a stale capture from an earlier log. Used to (a) research known
 * gemma-4-26b/LM-Studio quirks against a fixed reference payload, and (b)
 * send the identical shape at other candidate models for comparison.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { trimMessages, type ChatMessage } from '../src/trim.js';
import { JSON_OBJECT_RESPONSE_FORMAT, OBSERVATION_JSON_SCHEMA, schemaGroundingText } from '../src/schema.js';
import { OBSERVATION_SYSTEM_PROMPT } from '../src/systemPrompts.js';
import { buildRequestBody } from '../src/backend.js';

// A representative real turn, shaped exactly like claude-mem's actual
// buildObservationPrompt() output (captured pattern from live debug logs).
const rawMessages: ChatMessage[] = [
  {
    role: 'user',
    content:
      '<observed_from_primary_session>\n' +
      '  <user_request>Fix the login bug</user_request>\n' +
      '  <requested_at>2026-09-21</requested_at>\n' +
      '</observed_from_primary_session>',
  },
  { role: 'assistant', content: '<skip_summary reason="session_start" />' },
  {
    role: 'user',
    content:
      '<observed_from_primary_session>\n' +
      '  <what_happened>Edit</what_happened>\n' +
      '  <occurred_at>2026-09-21T10:00:00Z</occurred_at>\n' +
      '  <working_directory>/repo</working_directory>\n' +
      '  <parameters>"{\\"file\\":\\"src/auth.ts\\",\\"old\\":\\"if (session.token) {\\",\\"new\\":\\"if (session?.token) {\\"}"</parameters>\n' +
      '  <outcome>"{\\"status\\":\\"ok\\",\\"linesChanged\\":1}"</outcome>\n' +
      '</observed_from_primary_session>\n\n' +
      'Return either one or more <observation>...</observation> blocks, or <skip_summary reason="noise" /> if this tool use should be skipped.\n' +
      'Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.\n' +
      'Never reply with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Non-XML text is discarded.',
  },
];

const trimmed = trimMessages(rawMessages);
const groundedSystemPrompt = `${OBSERVATION_SYSTEM_PROMPT}\n\n${schemaGroundingText(OBSERVATION_JSON_SCHEMA)}`;
const fullMessages: ChatMessage[] = [{ role: 'system', content: groundedSystemPrompt }, ...trimmed];

const modelArg = process.argv[2] ?? 'REPLACE_ME';
const body = buildRequestBody(fullMessages, JSON_OBJECT_RESPONSE_FORMAT, true, modelArg);

mkdirSync('fixtures', { recursive: true });
const outPath = `fixtures/observation-request-${modelArg.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
writeFileSync(outPath, JSON.stringify(body, null, 2));
console.log(`wrote ${outPath}`);
