# claude-mem host observer

An OpenAI-compatible endpoint that stands in for claude-mem's `openrouter`
provider, forwarding jobs to a local LM Studio (or any OpenAI-compatible)
backend instead of a hosted model.

## Why this exists

claude-mem's worker will happily talk to any OpenAI-compatible base URL
(`CLAUDE_MEM_OPENROUTER_BASE_URL`), but it always sends the same verbose,
multi-KB instructional prompt it uses for hosted models, and it resends the
*entire* conversation history on every turn. That's fine for a hosted model;
it's wasteful and unreliable for a small local model that can't be trusted to
freehand well-formed XML.

This service sits between them:

1. Classifies each incoming request by prompt shape (session-start,
   per-tool-call observation, session summary, or something else).
2. Session-start/continuation turns are answered instantly with a fixed
   `<skip_summary reason="session_start" />` and never reach the backend at
   all -- claude-mem never inspects that reply (see
   `OpenAICompatibleProvider.handleInitResponse` in claude-mem's source), so
   the round trip is pure waste.
3. Every other user-role message (current and historical) is stripped down
   to its dynamic payload -- tool name/params/outcome, or the session
   request -- dropping claude-mem's repeated instructional boilerplate.
4. The real backend call asks for structured JSON instead of freeform XML --
   more reliable for a local model than hoping it produces valid nested XML.
   This uses loose `response_format: {type: "json_object"}` with the schema
   grounded directly in the system prompt (see `schema.ts`), **not**
   grammar-constrained `response_format: {type: "json_schema"}`. The
   grammar-masked mode was tried first and reliably broke gemma-4-26b: token
   masking that forces the model to keep generating until every schema
   constraint is satisfied interacts badly with Gemma 4's chat template, and
   generation gets trapped in a loop that fills the entire `max_tokens`
   budget with repetition instead of closing the JSON (matches
   `vLLM#40080`/`mlx-vlm#1294`). `toXml.ts` treats every field defensively
   rather than trusting AJV-clean input, so the loss of grammar-level
   guarantees costs little in practice.
5. The returned JSON is serialized into the exact XML shape claude-mem's
   response parser expects (`<observation>`, `<skip_summary>`, `<summary>`),
   and any `<think>`/`<|think|>` reasoning-model wrapper text is stripped
   before parsing.
6. All requests run through a single-lane queue -- only one job is ever in
   flight against the local backend at a time, regardless of how many
   claude-mem sessions are running concurrently.

## Running it

### In the foreground (iterating)

```bash
npm install
npm run dev      # tsx watch, for iterating
# or
npm start        # tsx, no watch
```

Listens on `http://127.0.0.1:37777` by default.

### As a daemon (`claude-mem-observer` CLI)

This project now lives inside the `claude-mem` fork as `observer/`, so its
daemon is also reachable as `claude-mem observer <command>` -- a thin wrapper
that spawns this same `bin/claude-mem-observer.mjs`, resolved from the
installed plugin's marketplace clone (git clone installs only; the observer
is not part of the published npm tarball). Both invocations are equivalent
and share the same PID file, so `claude-mem observer start` and
`claude-mem-observer start` do the same thing:

```bash
claude-mem observer start [--port 37777] [--host 127.0.0.1]
claude-mem observer status
claude-mem observer stop
claude-mem observer restart
```

Or, for a mirroring CLI symlinked directly into `~/.local/bin/claude-mem-observer`
(make sure that's on your `PATH`):

```bash
claude-mem-observer start [--port 37777] [--host 127.0.0.1]
claude-mem-observer status
claude-mem-observer stop
claude-mem-observer restart
```

`status` reports PID, uptime, and the bound address; exits 0 when running,
1 when not. The daemon is spawned detached via `tsx` against this repo's
`src/server.ts` (re-symlink or edit in place -- no rebuild step), with its
PID at `~/.claude-mem-host-observer/observer.pid` and stdout/stderr at
`~/.claude-mem-host-observer/observer.log`. `start` refuses to double-spawn
if a live process already owns the PID file, and detects (and reports) a
backend that dies immediately after boot, e.g. because the port is already
taken.

To reinstall the symlink after moving the repo:

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/bin/claude-mem-observer.mjs" ~/.local/bin/claude-mem-observer
```

## Configuration (env vars)

| Var                | Default                            |
|--------------------|-------------------------------------|
| `PORT`             | `37777`                             |
| `HOST`             | `127.0.0.1`                         |
| `BACKEND_BASE_URL` | `https://omniroute.529broo.me/v1`   |
| `BACKEND_MODEL`    | `cx/gpt-5.6-luna`                   |
| `BACKEND_API_KEY`  | `sk-1234`                           |
| `MAX_TOKENS`       | `8192`                              |
| `DEBUG`            | unset (`1`/`true`/`yes` to enable)  |

These defaults point at a hosted frontier model through an omniroute gateway
rather than a local model directly -- gemma-4-26b via oMLX works (see below)
but is far slower per call. Override `BACKEND_BASE_URL`/`BACKEND_MODEL` to
point at a local backend directly when that's what you want.

`DEBUG=1` logs the full request/response cycle per job (incoming messages,
trimmed messages, the exact backend request body, raw and post-processing
content, parse results) to stdout -- piped to
`~/.claude-mem-host-observer/observer.log` when run via the CLI daemon.

## Pointing claude-mem at it

```
CLAUDE_MEM_PROVIDER=openrouter
CLAUDE_MEM_OPENROUTER_BASE_URL=http://127.0.0.1:37777/v1
CLAUDE_MEM_OPENROUTER_MODEL=anything -- this shim always substitutes its own configured BACKEND_MODEL
CLAUDE_MEM_OPENROUTER_API_KEY=anything-nonempty
```

**Port note:** claude-mem's own install flow auto-probes for an observer one
port *above* its worker port (worker on 37777 -> it looks for an observer on
37778) and health-checks it via `GET /v1/models`. Since this service is
pinned to 37777 by design, either:

- move claude-mem's own worker off 37777 (`CLAUDE_MEM_WORKER_PORT=<other>`), or
- set `CLAUDE_MEM_HOST_OBSERVER_PORT=37777` explicitly on the claude-mem side

so its probe checks the right port instead of trying to move you.

## Known assumptions

- The observation type/concept enums (`src/taxonomy.ts`) are copied from
  claude-mem's default "code" mode. Since `response_format` is now loose
  `json_object` (not grammar-enforced `json_schema` -- see above), a model
  can drift outside these enums or omit a field; nothing rejects that at the
  backend, `toXml.ts` just serializes whatever it gets. If you switch
  claude-mem to a custom mode with different `observation_types`/
  `observation_concepts`, update this file to match for the prompt grounding
  to stay accurate, but drift here is a quality issue, not a hard failure.
- The summary-prompt trim only strips fixed literal boilerplate (verified
  against claude-mem's source); the per-mode prose in the middle of that
  prompt is left as-is. Summary turns fire once per session, so this is a
  smaller win than the per-tool-call trim.
- Some backends (e.g. a strict OpenAI-passthrough route) 400 on unrecognized
  request fields. `backend.ts` sends three different "disable thinking"
  field spellings optimistically and retries once without them if the
  backend rejects one by name -- see `isUnknownThinkingFieldError`. For
  oMLX specifically, none of these fields do anything either way; oMLX's
  thinking/reasoning behavior is a per-model setting in
  `~/.omlx/model_settings.json` on the host running it, not something
  controllable via the request body.
