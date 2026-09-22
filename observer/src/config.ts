export const PORT = Number(process.env.PORT ?? 37777);
export const HOST = process.env.HOST ?? '127.0.0.1';

export const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL ?? 'https://omniroute.529broo.me/v1';
export const BACKEND_MODEL = process.env.BACKEND_MODEL ?? 'xenon/gemma4-26b';
export const BACKEND_API_KEY = process.env.BACKEND_API_KEY ?? 'sk-1234';

/**
 * Escalation model, tried once when BACKEND_MODEL's response fails structural
 * validation (see validate.ts) -- same conversation turn, different model,
 * routed through the same gateway/key. Not a retry of the same model: a
 * model that produced a malformed shape once is asked again for free, a
 * model that's fundamentally unreliable for this schema is not. Luna has a
 * 100% clean track record in our own stress testing, at real per-call cost,
 * so this is meant to fire rarely -- BACKEND_MODEL should be doing the bulk
 * of the work.
 */
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? 'cx/gpt-5.6-luna';

/**
 * Per-call generation budget forwarded to the backend. 4096 measured as too
 * tight for this schema on this model -- real calls hit the ceiling exactly
 * (completion_tokens: 4096) and got cut off mid-JSON before the closing
 * braces, which is a parse failure independent of the timeout issue.
 */
export const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 8192);
