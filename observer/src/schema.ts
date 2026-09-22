import { OBSERVATION_TYPES, OBSERVATION_CONCEPTS } from './taxonomy.js';

/**
 * Raw JSON schemas (not wrapped in a response_format envelope).
 *
 * These used to be sent as `response_format: {type:"json_schema", ...}`
 * (OpenAI "structured outputs" / grammar-constrained decoding). That broke
 * gemma-4-26b specifically: xgrammar-style token masking forces the model to
 * keep generating until every schema constraint is satisfied, and Gemma 4's
 * chat template has a known interaction bug where disabling thinking or a
 * template BOS mismatch corrupts its logits mid-string -- trapped between
 * "wants to stop" and "mask forbids the closing brace", it fills the rest of
 * max_tokens with repetition/garbage (see vLLM #40080, mlx-vlm #1294).
 *
 * response_format is now just `{type:"json_object"}` (loose: valid JSON
 * syntax, no grammar mask) and the schema is instead grounded directly in
 * the prompt via schemaGroundingText(). This trades AJV-strict enum/shape
 * guarantees for not triggering the loop -- acceptable here because toXml.ts
 * already treats every field defensively (falls back on missing/malformed
 * values) rather than assuming schema-perfect input.
 */

export const OBSERVATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['skip', 'observe'],
      description: 'skip when the tool activity shown is noise (navigation, a read with nothing learned). observe when it is a finished, searchable unit of work.',
    },
    skip_reason: {
      type: 'string',
      description: 'Short reason when action=skip (e.g. "noise", "navigation"). Empty string when action=observe.',
    },
    observations: {
      type: 'array',
      description: 'One or more observations when action=observe. Empty array when action=skip.',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: [...OBSERVATION_TYPES] },
          title: { type: 'string', description: 'Describes the work done. Never a tool name.' },
          subtitle: { type: 'string' },
          facts: {
            type: 'array',
            description: '4-10 concrete facts, referencing real file paths/values from the shown parameters/outcome.',
            items: { type: 'string' },
            minItems: 4,
            maxItems: 10,
          },
          narrative: { type: 'string' },
          concepts: {
            type: 'array',
            items: { type: 'string', enum: [...OBSERVATION_CONCEPTS] },
          },
          files_read: { type: 'array', items: { type: 'string' } },
          files_modified: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'title', 'subtitle', 'facts', 'narrative', 'concepts', 'files_read', 'files_modified'],
      },
    },
  },
  required: ['action', 'skip_reason', 'observations'],
} as const;

export const SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    request: { type: 'string' },
    investigated: { type: 'string' },
    learned: { type: 'string' },
    completed: { type: 'string' },
    next_steps: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'],
} as const;

/** Loose structured-output mode: valid JSON syntax only, no grammar mask. */
export const JSON_OBJECT_RESPONSE_FORMAT = { type: 'json_object' } as const;

/** Appended to a system prompt to ground the model on the expected shape without a token-level grammar mask. */
export function schemaGroundingText(schema: unknown): string {
  return `You must output a single JSON object that adheres strictly to this JSON Schema. Do not wrap the output in markdown code fences, and do not include any text before or after the JSON object.\n\nSchema:\n${JSON.stringify(schema)}`;
}
