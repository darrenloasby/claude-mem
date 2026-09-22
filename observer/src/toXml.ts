function escapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface ObservationJson {
  action: 'skip' | 'observe';
  skip_reason: string;
  observations: Array<{
    type: string;
    title: string;
    subtitle: string;
    facts: string[];
    narrative: string;
    concepts: string[];
    files_read: string[];
    files_modified: string[];
  }>;
}

/** Array field, defensively: the model no longer has a grammar guaranteeing this is actually an array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Pure serializer: JSON in, claude-mem's XML contract out. Never parses XML.
 *
 * No longer assumes AJV-clean input (see schema.ts for why) -- every field
 * is coerced defensively rather than trusted to match ObservationJson.
 */
export function observationJsonToXml(json: ObservationJson): string {
  if (json?.action === 'skip' || !Array.isArray(json?.observations) || json.observations.length === 0) {
    return `<skip_summary reason="${escapeXml(json?.skip_reason || 'noise')}" />`;
  }

  return json.observations
    .map((o) => `<observation>
  <type>${escapeXml(o?.type)}</type>
  <title>${escapeXml(o?.title)}</title>
  <subtitle>${escapeXml(o?.subtitle)}</subtitle>
  <facts>
${asArray(o?.facts).map((f) => `    <fact>${escapeXml(f as string)}</fact>`).join('\n')}
  </facts>
  <narrative>${escapeXml(o?.narrative)}</narrative>
  <concepts>
${asArray(o?.concepts).map((c) => `    <concept>${escapeXml(c as string)}</concept>`).join('\n')}
  </concepts>
  <files_read>
${asArray(o?.files_read).map((f) => `    <file>${escapeXml(f as string)}</file>`).join('\n')}
  </files_read>
  <files_modified>
${asArray(o?.files_modified).map((f) => `    <file>${escapeXml(f as string)}</file>`).join('\n')}
  </files_modified>
</observation>`)
    .join('\n');
}

interface SummaryJson {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string;
}

export function summaryJsonToXml(json: SummaryJson): string {
  return `<summary>
  <request>${escapeXml(json?.request)}</request>
  <investigated>${escapeXml(json?.investigated)}</investigated>
  <learned>${escapeXml(json?.learned)}</learned>
  <completed>${escapeXml(json?.completed)}</completed>
  <next_steps>${escapeXml(json?.next_steps)}</next_steps>
  <notes>${escapeXml(json?.notes)}</notes>
</summary>`;
}
