import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BACKEND_MODEL, FALLBACK_MODEL, HOST, PORT } from './config.js';
import { classifyContent } from './classify.js';
import { trimMessages, type ChatMessage } from './trim.js';
import {
  JSON_OBJECT_RESPONSE_FORMAT,
  OBSERVATION_JSON_SCHEMA,
  SUMMARY_JSON_SCHEMA,
  schemaGroundingText,
} from './schema.js';
import { OBSERVATION_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from './systemPrompts.js';
import { observationJsonToXml, summaryJsonToXml } from './toXml.js';
import { validateObservationJson, validateSummaryJson } from './validate.js';
import { callBackend } from './backend.js';
import { SerialQueue } from './queue.js';
import { DEBUG, debugLog } from './debug.js';

const queue = new SerialQueue();

const SESSION_START_XML = '<skip_summary reason="session_start" />';
const OBSERVER_ERROR_XML = '<skip_summary reason="observer_error" />';

function openAiChatCompletion(
  content: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
  servedModel: string = BACKEND_MODEL,
) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    // The model that ACTUALLY served this request -- BACKEND_MODEL only when
    // no escalation happened. claude-mem's OpenRouterProvider reads this
    // field as `servedModel` and persists it as sdk_sessions.observed_model,
    // which is how "did this get escalated to Luna or stay on Gemma" becomes
    // visible per-record rather than requiring a log dive every time.
    model: servedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Runs a structured-extraction backend call and converts the result to XML.
 *
 * Uses loose `json_object` mode plus the schema grounded directly in the
 * system prompt, not grammar-constrained `json_schema` -- the latter breaks
 * gemma-4-26b specifically (xgrammar-style token masking interacts badly
 * with Gemma 4's chat template and traps generation in a loop that fills
 * max_tokens with repetition; see schema.ts for the full writeup).
 *
 * "Velvet glove" quality gate: rather than retrying the same model hoping
 * for a better roll, or coercing correctness at the token level (the thing
 * that broke gemma-4-26b in the first place), a response that fails
 * validate() is escalated -- same conversation turn, sent once to
 * FALLBACK_MODEL instead. Only a response that validates gets rendered;
 * exhausting every model without a valid response falls back to a skip
 * rather than storing a malformed observation in claude-mem permanently.
 */
async function generateStructuredXml(
  messages: ChatMessage[],
  systemPrompt: string,
  jsonSchema: unknown,
  toXml: (json: any) => string,
  validate: (json: unknown) => string[],
  jobId: string,
  signal: AbortSignal,
  modelsToTry: string[] = [BACKEND_MODEL, FALLBACK_MODEL],
): Promise<{ xml: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; servedModel?: string }> {
  const groundedSystemPrompt = `${systemPrompt}\n\n${schemaGroundingText(jsonSchema)}`;
  const fullMessages: ChatMessage[] = [{ role: 'system', content: groundedSystemPrompt }, ...messages];

  for (let i = 0; i < modelsToTry.length; i += 1) {
    if (signal.aborted) {
      console.log(`[${jobId}] caller disconnected -- skipping remaining model attempts`);
      return { xml: OBSERVER_ERROR_XML };
    }
    const model = modelsToTry[i];
    const isLastAttempt = i === modelsToTry.length - 1;
    try {
      const result = await callBackend(fullMessages, JSON_OBJECT_RESPONSE_FORMAT, jobId, model, signal);
      const json = JSON.parse(result.content);
      debugLog(jobId, `model=${model} parsed JSON`, json);

      const problems = validate(json);
      if (problems.length > 0) {
        console.log(`[${jobId}] model=${model} failed validation (${problems.length} problem(s))${isLastAttempt ? ' -- exhausted, falling back to skip' : ` -- escalating to ${modelsToTry[i + 1]}`}`);
        debugLog(jobId, `model=${model} validation problems`, problems);
        if (!isLastAttempt) continue;
        return { xml: OBSERVER_ERROR_XML };
      }

      const xml = toXml(json);
      debugLog(jobId, `model=${model} converted to XML`, xml);
      // Prefer the backend's own reported model (result.model) when present --
      // some gateways rewrite/alias the requested id -- falling back to the
      // model string we actually requested.
      return { xml, usage: result.usage, servedModel: result.model || model };
    } catch (error) {
      if (signal.aborted) {
        console.log(`[${jobId}] model=${model} attempt cancelled -- caller disconnected`);
        return { xml: OBSERVER_ERROR_XML };
      }
      console.error(`[${jobId}] model=${model} attempt failed:`, error instanceof Error ? error.message : error);
      if (isLastAttempt) {
        return { xml: OBSERVER_ERROR_XML };
      }
    }
  }
  return { xml: OBSERVER_ERROR_XML };
}

async function handleChatCompletion(
  body: { messages?: ChatMessage[] },
  signal: AbortSignal,
): Promise<ReturnType<typeof openAiChatCompletion>> {
  const jobId = randomUUID().slice(0, 8);
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const mode = last ? classifyContent(last.content) : 'plain';

  console.log(`[${jobId}] mode=${mode} messages=${messages.length}`);
  debugLog(jobId, 'incoming messages (raw, as sent by claude-mem)', messages);

  // Dropped while queued behind other work: the caller (claude-mem's worker,
  // or omniroute on its behalf) already gave up and hung up. Running this
  // anyway would occupy the single backend slot for nobody -- exactly the
  // orphaned-request pattern that let the queue pile up in the first place.
  if (signal.aborted) {
    console.log(`[${jobId}] caller already disconnected before this job's turn -- skipping backend call entirely`);
    return openAiChatCompletion(OBSERVER_ERROR_XML);
  }

  // claude-mem never inspects the reply to an init/continuation turn (it only
  // needs *something* in history to keep role alternation intact) -- so skip
  // the network round trip to the local model entirely.
  if (mode === 'init') {
    debugLog(jobId, 'init/continuation turn -- short-circuiting, backend not called');
    return openAiChatCompletion(SESSION_START_XML);
  }

  const trimmed = trimMessages(messages);
  debugLog(jobId, 'trimmed messages (sent to backend, minus system prompt)', trimmed);

  if (mode === 'observation') {
    // OBSERVATION_SYSTEM_PROMPT only ever judges "the newest turn shown to
    // you" -- there is no dedup/continuity field in OBSERVATION_JSON_SCHEMA
    // that depends on prior turns. But claude-mem resends the *entire*
    // session history on every tool-call request, and until this fix we
    // forwarded all of it: by turn N of a long session, N-1 already-observed
    // turns were being paid for again on every single call, back-to-back
    // with no cap. Slicing to just the current turn removes that unbounded
    // per-turn growth entirely without changing what the model is asked.
    const currentTurn = trimmed.slice(-1);
    const { xml, usage, servedModel } = await generateStructuredXml(
      currentTurn,
      OBSERVATION_SYSTEM_PROMPT,
      OBSERVATION_JSON_SCHEMA,
      observationJsonToXml,
      validateObservationJson,
      jobId,
      signal,
    );
    return openAiChatCompletion(xml, usage, servedModel);
  }

  if (mode === 'summary') {
    // Fires once per session but carries the *entire* trimmed history in one
    // shot -- the one genuinely "chunky" request this observer makes. Local
    // BACKEND_MODEL trying (and likely choking on) that payload before
    // escalating to FALLBACK_MODEL just burns the local backend's time on a
    // call that was always going to the hosted frontier model anyway, so
    // summary goes straight to FALLBACK_MODEL (cx/gpt-5.6-luna) instead of
    // the default try-BACKEND_MODEL-first order.
    const { xml, usage, servedModel } = await generateStructuredXml(
      trimmed,
      SUMMARY_SYSTEM_PROMPT,
      SUMMARY_JSON_SCHEMA,
      summaryJsonToXml,
      validateSummaryJson,
      jobId,
      signal,
      [FALLBACK_MODEL],
    );
    return openAiChatCompletion(xml, usage, servedModel);
  }

  // 'plain' -- field-compression / Telegram wrap-up / anything unrecognized.
  // These want free text back, not XML, so no schema and no conversion.
  try {
    const result = await callBackend(trimmed, undefined, jobId, undefined, signal);
    return openAiChatCompletion(result.content, result.usage);
  } catch (error) {
    console.error(`[${jobId}] plain-mode backend call failed:`, error instanceof Error ? error.message : error);
    return openAiChatCompletion('');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: BACKEND_MODEL, object: 'model' }] }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    // Propagates the caller hanging up (claude-mem's worker gives up after its
    // own timeout, or omniroute gives up on our behalf) down into the queued
    // job and its in-flight backend fetch, so an abandoned request actually
    // stops instead of running to completion and occupying the single backend
    // slot for no one -- see backend.ts/queue.ts for the rest of this chain.
    const controller = new AbortController();
    let clientGone = false;
    req.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });

    readBody(req)
      .then((raw) => {
        let body: { messages?: ChatMessage[] };
        try {
          body = JSON.parse(raw);
        } catch {
          if (!clientGone) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
          }
          return;
        }
        // Serialized onto the single-job queue: only one request is ever
        // in flight against the local backend at a time.
        queue
          .run(() => handleChatCompletion(body, controller.signal))
          .then((completion) => {
            if (clientGone) {
              console.log('caller disconnected before this job completed -- discarding result, not writing to a closed socket');
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(completion));
          })
          .catch((error) => {
            if (clientGone) return;
            console.error('unhandled error:', error);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'internal error' } }));
          });
      })
      .catch((error) => {
        if (clientGone) return;
        console.error('body read error:', error);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'failed to read request body' } }));
      });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, HOST, () => {
  console.log(`claude-mem host observer listening on http://${HOST}:${PORT}${DEBUG ? ' (DEBUG logging on)' : ''}`);
});
