/**
 * Observation type/concept ids, copied from claude-mem's default "code" mode
 * (plugin/modes/code.json). claude-mem lets these be redefined per-mode; this
 * observer does not read that config live, so if you switch claude-mem to a
 * custom mode, update this list to match its observation_types/concepts.
 */
export const OBSERVATION_TYPES = [
  'bugfix',
  'feature',
  'refactor',
  'change',
  'discovery',
  'decision',
  'security_alert',
  'security_note',
  'sensitive',
] as const;

export const OBSERVATION_CONCEPTS = [
  'how-it-works',
  'why-it-exists',
  'what-changed',
  'problem-solution',
  'gotcha',
  'pattern',
  'trade-off',
] as const;
