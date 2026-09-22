import { OBSERVATION_TYPES } from './taxonomy.js';

/**
 * Structural quality gate, separate from toXml.ts's crash-prevention
 * defensiveness. toXml.ts will happily render whatever it's given without
 * throwing; this decides whether what it would render is actually GOOD
 * enough to use, or should be escalated to the fallback model instead (see
 * config.ts FALLBACK_MODEL). Returns a list of problems -- empty means valid.
 */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function validateObservationJson(json: unknown): string[] {
  const problems: string[] = [];
  if (typeof json !== 'object' || json === null) {
    return ['response is not a JSON object'];
  }
  const obj = json as Record<string, unknown>;

  if (obj.action !== 'skip' && obj.action !== 'observe') {
    problems.push(`action must be "skip" or "observe", got ${JSON.stringify(obj.action)}`);
    return problems; // nothing else is checkable without knowing which branch
  }

  if (obj.action === 'skip') {
    return problems;
  }

  // action === 'observe'
  if (!Array.isArray(obj.observations) || obj.observations.length === 0) {
    problems.push('action=observe but observations is missing, not an array, or empty');
    return problems;
  }

  obj.observations.forEach((o, i) => {
    if (typeof o !== 'object' || o === null) {
      problems.push(`observations[${i}] is not an object`);
      return;
    }
    const item = o as Record<string, unknown>;
    if (!isNonEmptyString(item.type) || !(OBSERVATION_TYPES as readonly string[]).includes(item.type)) {
      problems.push(`observations[${i}].type is not one of the known enum values: ${JSON.stringify(item.type)}`);
    }
    if (!isNonEmptyString(item.title)) problems.push(`observations[${i}].title is missing or empty`);
    if (!isNonEmptyString(item.subtitle)) problems.push(`observations[${i}].subtitle is missing or empty`);
    if (!isNonEmptyString(item.narrative)) problems.push(`observations[${i}].narrative is missing or empty`);
    if (!isStringArray(item.facts) || item.facts.length === 0) problems.push(`observations[${i}].facts is missing, not a string array, or empty`);
    if (!isStringArray(item.concepts)) problems.push(`observations[${i}].concepts is not a string array`);
    if (!isStringArray(item.files_read)) problems.push(`observations[${i}].files_read is not a string array`);
    if (!isStringArray(item.files_modified)) problems.push(`observations[${i}].files_modified is not a string array`);
  });

  return problems;
}

export function validateSummaryJson(json: unknown): string[] {
  const problems: string[] = [];
  if (typeof json !== 'object' || json === null) {
    return ['response is not a JSON object'];
  }
  const obj = json as Record<string, unknown>;
  for (const field of ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes']) {
    if (typeof obj[field] !== 'string') {
      problems.push(`${field} is missing or not a string`);
    }
  }
  return problems;
}
