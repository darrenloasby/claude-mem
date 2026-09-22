/**
 * Some local reasoning models (this Gemma build included) wrap chain-of-thought
 * in <|think|>...<|/think|> or <think>...</think> around -- or instead of --
 * the actual JSON, even with response_format forcing structured output. Strip
 * it before JSON.parse ever sees the content.
 */
export function stripThinkTags(content: string): string {
  return content
    .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}
