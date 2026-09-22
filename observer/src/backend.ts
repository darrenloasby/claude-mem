import { BACKEND_API_KEY, BACKEND_BASE_URL, BACKEND_MODEL, MAX_TOKENS } from './config.js';
import type { ChatMessage } from './trim.js';
import { stripThinkTags } from './sanitize.js';
import { debugLog } from './debug.js';

export interface BackendResult {
  content: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// Different OpenAI-compatible servers spell "disable thinking" differently,
// and some (strict validators, e.g. behind a gateway fronting a real OpenAI
// endpoint) 400 on any field they don't recognize rather than ignoring it.
// Sent optimistically first; stripped and retried once if the backend
// rejects one of them by name.
const THINKING_OFF_FIELDS = {
  reasoning: { enabled: false },
  enable_thinking: false,
  chat_template_kwargs: { enable_thinking: false },
};
const THINKING_OFF_FIELD_NAMES = Object.keys(THINKING_OFF_FIELDS);

export function buildRequestBody(
  messages: ChatMessage[],
  responseFormat: Record<string, unknown> | undefined,
  includeThinkingOffFields: boolean,
  model: string = BACKEND_MODEL,
): Record<string, unknown> {
  return {
    model,
    messages,
    temperature: 0.3,
    max_tokens: MAX_TOKENS,
    ...(includeThinkingOffFields ? THINKING_OFF_FIELDS : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };
}

/** True if a 400 body is a strict-validator rejection of one of our injected thinking-off fields. */
function isUnknownThinkingFieldError(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('unknown_parameter') || lower.includes('unknown parameter')
    ? THINKING_OFF_FIELD_NAMES.some((name) => lower.includes(name.toLowerCase()))
    : false;
}

async function postChatCompletion(
  url: string,
  requestBody: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; bodyText: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BACKEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal,
  });
  const bodyText = await res.text();
  return { status: res.status, ok: res.ok, bodyText };
}

/**
 * POSTs to the real backend. Optional responseFormat enables grammar-constrained
 * JSON output. `signal` propagates the original caller's disconnect (see
 * server.ts) so an abandoned job's in-flight generation is actually cancelled
 * against the backend instead of running to completion for no one (#retry-storm).
 */
export async function callBackend(
  messages: ChatMessage[],
  responseFormat?: Record<string, unknown>,
  jobId = '-',
  model: string = BACKEND_MODEL,
  signal?: AbortSignal,
): Promise<BackendResult> {
  const url = `${BACKEND_BASE_URL}/chat/completions`;
  let requestBody = buildRequestBody(messages, responseFormat, true, model);

  debugLog(jobId, `POST ${url}`, requestBody);
  const startedAt = Date.now();

  let response: { status: number; ok: boolean; bodyText: string };
  try {
    response = await postChatCompletion(url, requestBody, signal);
  } catch (error) {
    debugLog(jobId, `backend request failed after ${Date.now() - startedAt}ms`, error instanceof Error ? error.message : String(error));
    throw error;
  }

  if (!response.ok && isUnknownThinkingFieldError(response.status, response.bodyText)) {
    debugLog(jobId, 'backend rejected thinking-off field as unknown -- retrying without it', response.bodyText.slice(0, 500));
    requestBody = buildRequestBody(messages, responseFormat, false, model);
    debugLog(jobId, `POST ${url} (retry, thinking-off fields stripped)`, requestBody);
    try {
      response = await postChatCompletion(url, requestBody, signal);
    } catch (error) {
      debugLog(jobId, `backend request failed after ${Date.now() - startedAt}ms`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    debugLog(jobId, `backend responded ${response.status} after ${elapsedMs}ms`, response.bodyText.slice(0, 2000));
    throw new Error(`backend ${response.status}: ${response.bodyText.slice(0, 500)}`);
  }

  const data = JSON.parse(response.bodyText) as {
    model?: string;
    choices?: Array<{ message?: Record<string, unknown> & { content?: string }; finish_reason?: string }>;
    usage?: BackendResult['usage'];
  };

  const message = data.choices?.[0]?.message ?? {};
  const rawContent = typeof message.content === 'string' ? message.content : '';
  const content = stripThinkTags(rawContent);
  debugLog(jobId, `backend responded 200 after ${elapsedMs}ms (model=${data.model ?? model}, finish_reason=${data.choices?.[0]?.finish_reason}, usage=${JSON.stringify(data.usage ?? {})})`);
  // Full raw message object, not just `content` -- an o1/R1-style backend can
  // split chain-of-thought into `reasoning`/`reasoning_content` (or similar)
  // instead of prefixing it into `content`, which stripThinkTags would never
  // see. This is how we'd catch that: content is tiny but completion_tokens
  // is huge, and the missing tokens show up here instead.
  debugLog(jobId, 'full raw message object from backend', message);
  if (rawContent !== content) {
    debugLog(jobId, 'raw content (before think-tag strip)', rawContent);
  }
  debugLog(jobId, 'content (after think-tag strip)', content);

  return { content, model: data.model, usage: data.usage };
}
