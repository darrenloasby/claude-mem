import { classifyContent } from './classify.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function extractTag(content: string, tag: string): string | null {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : null;
}

/**
 * claude-mem wraps every session/turn start in system_identity, observer_role,
 * spatial_awareness, recording_focus, skip_guidance and a full
 * <observation>/<summary> skeleton example -- several KB of prose whose entire
 * job is to teach the model the output shape. A JSON-schema-constrained
 * backend doesn't need that teaching, so only the two dynamic tags survive.
 *
 * Also: claude-mem never parses this response (see handleInitResponse), so
 * the caller can -- and does -- skip the network call for this mode entirely.
 * Trimming it still matters for messages that show up as *history* on a
 * later real call.
 */
function trimInitMessage(content: string): string {
  const userRequest = extractTag(content, 'user_request') ?? '';
  const requestedAt = extractTag(content, 'requested_at') ?? '';
  const priorContext = extractTag(content, 'session_start_context');
  let out = `Task requested: "${userRequest}" (${requestedAt})`;
  if (priorContext) {
    out += `\n\nAlready recorded earlier in this session:\n${priorContext}`;
  }
  return out;
}

/**
 * The per-tool-call prompt repeats the same instructional prose on every
 * single turn, and claude-mem resends the *entire* conversation history on
 * every request -- so by turn N of a session, N copies of that prose have
 * been paid for. Only the four dynamic tags carry information the model
 * needs (what happened, when, where, with what data).
 */
function trimObservationMessage(content: string): string {
  const whatHappened = extractTag(content, 'what_happened') ?? '';
  const occurredAt = extractTag(content, 'occurred_at') ?? '';
  const workingDirectory = extractTag(content, 'working_directory');
  const parameters = extractTag(content, 'parameters') ?? '';
  const outcome = extractTag(content, 'outcome') ?? '';
  const elided = content.includes('<elided ');

  let out = `Tool: ${whatHappened} at ${occurredAt}`;
  if (workingDirectory) out += ` (cwd: ${workingDirectory})`;
  out += `\nparameters: ${parameters}\noutcome: ${outcome}`;
  if (elided) {
    out += '\n(a field above was truncated for size -- describe only what is shown, do not infer the missing part)';
  }
  return out;
}

// Fixed literal strings from src/sdk/prompts.ts's buildSummaryPrompt -- not
// mode-configurable, so safe to strip by exact match regardless of which
// claude-mem mode is active.
const SUMMARY_FIXED_LINES = [
  '--- MODE SWITCH: PROGRESS SUMMARY ---',
  '⚠️ CRITICAL TAG REQUIREMENT — READ CAREFULLY:',
  '• You MUST wrap your ENTIRE response in <summary>...</summary> tags.',
  '• Do NOT use <observation> tags. <observation> output will be DISCARDED and cause a system error.',
  '• The ONLY accepted root tag is <summary>. Any other root tag is a protocol violation.',
  'REMINDER: Your response MUST use <summary> as the root tag, NOT <observation>.',
];

/**
 * Best-effort trim for the summary prompt: strips the fixed boilerplate lines
 * and the <summary> skeleton example (the schema replaces its purpose), but
 * leaves the mode's own prose (summary_instruction, summary_footer, etc.)
 * alone since it isn't a fixed string we can safely match across custom
 * modes. This mode fires once per session, so the payoff is smaller than the
 * per-tool-call trim above.
 */
function trimSummaryMessage(content: string): string {
  let out = content.replace(/<summary>[\s\S]*?<\/summary>/, '');
  for (const line of SUMMARY_FIXED_LINES) {
    out = out.split(line).join('');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Rewrites every user-role message down to its dynamic payload. Assistant
 * messages are our own prior XML replies -- already compact -- and pass
 * through unchanged. Unrecognized user content (field-compression prompts,
 * Telegram wrap-up prompts, anything future) also passes through unchanged
 * rather than risk corrupting a shape this observer doesn't understand.
 */
export function trimMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'user') return message;

  switch (classifyContent(message.content)) {
    case 'summary':
      return { ...message, content: trimSummaryMessage(message.content) };
    case 'observation':
      return { ...message, content: trimObservationMessage(message.content) };
    case 'init':
      return { ...message, content: trimInitMessage(message.content) };
    case 'plain':
      return message;
  }
}

export function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(trimMessage);
}
