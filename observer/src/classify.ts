export type PromptMode = 'init' | 'observation' | 'summary' | 'plain';

const SUMMARY_MODE_MARKER = 'MODE SWITCH: PROGRESS SUMMARY';

/**
 * Identifies which of claude-mem's prompt shapes a single message's content
 * is. Order matters: check the most distinctive marker first.
 *
 * - 'summary'     buildSummaryPrompt        -- session wrap-up
 * - 'observation' buildObservationPrompt    -- one tool call to judge
 * - 'init'        buildInitPrompt/buildContinuationPrompt -- session/turn start
 * - 'plain'       anything else (field-compression, Telegram wrap-up, unknown)
 */
export function classifyContent(content: string): PromptMode {
  if (content.includes(SUMMARY_MODE_MARKER)) return 'summary';
  if (content.includes('<what_happened>')) return 'observation';
  if (content.includes('<user_request>')) return 'init';
  return 'plain';
}
