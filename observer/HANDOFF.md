# Handoff: claude-mem pipeline (observer shim + omniroute + fork)

You're picking this up with no memory of how it got here. This document is
the fast path to being useful immediately instead of re-deriving everything
from scratch.

**2026-09-22: merged into the fork.** What used to be the standalone
`claude-mem-host-observer` repo now lives at `observer/` inside the
`claude-mem` fork itself (this file's location). It's reachable both as the
standalone `claude-mem-observer` CLI (still works, see README.md) and as
`claude-mem observer start|stop|restart|status` from the fork's own CLI
(`src/npx-cli/commands/observer.ts`, wired into `src/npx-cli/index.ts`
alongside the `worker` subcommand) -- both paths spawn the exact same
`bin/claude-mem-observer.mjs` and share one PID file, so there's no state to
keep in sync between them. The `observer/` directory is fork-only: it's not
in package.json's `files` allowlist, so it never ships in the published npm
tarball, and the `claude-mem observer` subcommand only resolves it from a
full git clone (`marketplaceDirectory()`). This closes the gap where
`claude-mem`'s own `--provider host` installer option
(`buildHostObserverSettings` in `src/npx-cli/cmem-memory-credentials.ts`)
configured a client to talk to `http://127.0.0.1:<port>/v1` without ever
shipping anything to listen there -- now this fork does. The standalone
`claude-mem-host-observer` git repo this was developed in has been deleted
(2026-09-22, after confirming its `src/` was byte-identical to `observer/`
here); `observer/` in this fork is the only copy from here on.

**2026-09-22 (later same day): unbounded history fix + summary routing.**
`handleChatCompletion` in `src/server.ts` was forwarding claude-mem's
*entire* resent session history to the backend on every `observation`-mode
call, even though `OBSERVATION_SYSTEM_PROMPT` only ever judges "the newest
turn shown to you" and neither the schema nor the validator has any
dedup/continuity dependency on prior turns. That's unbounded per-turn growth
with zero payoff -- turn N of a session was re-paying for N-1 already-judged
turns on every single tool call. `observation` mode now sends only the
current turn (`trimmed.slice(-1)`). Separately, `summary` mode (the one
genuinely large, once-per-session request) now routes straight to
`FALLBACK_MODEL` (`cx/gpt-5.6-luna`) instead of trying local `BACKEND_MODEL`
first -- that attempt was never going to stick for a payload of that size,
so it was pure wasted local-backend time before the escalation.

## The pipeline, end to end

```
Claude Code / Codex hooks (this Mac, or xenon via SSH tunnel)
  -> claude-mem worker (this Mac, port 37701, real DB at ~/.claude-mem/claude-mem.db)
    -> this repo's observer/ (port 37777, stands in for a hosted model)
      -> omniroute gateway (https://omniroute.529broo.me, runs on CT102/krypton)
        -> oMLX server on xenon (LAN, local models: gemma4-26b, qwen3.8-27b, ...)
        -> or a hosted frontier model (cx/gpt-5.6-luna) via the same gateway
```

Why this shim exists: claude-mem's worker will talk to any OpenAI-compatible
`CLAUDE_MEM_OPENROUTER_BASE_URL`, but it sends a huge repeated instructional
prompt and expects a specific XML contract back. This service classifies
each request, strips the boilerplate, asks the backend for structured JSON
instead of freeform XML, converts JSON->XML, and runs one job at a time.
**Read `README.md` in this repo first** -- it has the full up-to-date
architecture writeup and is kept in sync with the code.

## Current live config (as of this handoff)

- `BACKEND_MODEL=xenon/gemma4-26b` (primary, local, cheap)
- `FALLBACK_MODEL=cx/gpt-5.6-luna` (escalates only if gemma4-26b's response
  fails structural validation -- see `src/validate.ts` and
  `generateStructuredXml` in `src/server.ts`)
- Both routed through omniroute, not called directly.
- Daemon managed via `claude-mem-observer {start,stop,restart,status}` (on
  PATH via `~/.local/bin`). `DEBUG=1` env var gets you full request/response
  logging to `~/.claude-mem-host-observer/observer.log`.

## The big bug this session found and fixed: gemma-4-26b runaway generation

**Symptom:** requests to gemma4-26b would run for 100+ seconds and consume
the entire `max_tokens` budget with garbage/repetition, even though the
model is otherwise fast (~60 tok/s on trivial prompts).

**Root cause:** `response_format: {type: "json_schema"}` (grammar-constrained/
token-masked decoding) traps Gemma 4 in a loop -- the token mask forbids
closing the JSON until every schema constraint is satisfied, but something
in Gemma 4's chat template / thinking-mode interaction corrupts its ability
to actually finish, so it fills the rest of the budget with repetition.
Confirmed via isolation testing: free-form (no schema) = fine; strict
`json_schema` = runaway; loose `json_object` = fine. Matches
`vLLM#40080`, `mlx-vlm#1294`, `oMLX#3772`/`#1559` (found via a research
subagent -- worth re-running that research if this resurfaces on a
different model).

**Fix, already live:** `src/schema.ts` uses loose `response_format:
{type:"json_object"}` with the schema grounded as text in the system prompt
instead (`schemaGroundingText()`), never grammar-constrained `json_schema`.
`src/toXml.ts` is defensive about malformed/missing fields as a result (no
AJV-level guarantee anymore), and `src/validate.ts` + the escalation logic
in `server.ts` catch anything that's still bad enough to matter, escalating
to `FALLBACK_MODEL` rather than storing garbage.

**If this resurfaces**: check whether it's oMLX-specific first (oMLX's
thinking/reasoning behavior is a *host-level* setting in
`~/.omlx/model_settings.json` on xenon, NOT controllable via the request
body -- `enable_thinking`, `thinking_budget_tokens`, `dflash_enabled`).
`backend.ts` already sends three different "disable thinking" field
spellings optimistically (`reasoning.enabled`, `enable_thinking`,
`chat_template_kwargs.enable_thinking`) and self-heals if a strict backend
400s on them as unknown params -- but none of them do anything for oMLX
specifically, this is a known no-op there.

## Debugging omniroute

Omniroute (CT102 on krypton) is a multi-provider LLM gateway. It sits
between this shim and every actual model backend. When something is slow,
failing, or behaving strangely, **check omniroute before assuming it's the
model or our code.**

### Tools available

- `mcp__omniroute__*` MCP tools (already connected in most sessions):
  - `omniroute_get_health` -- circuit breakers, rate limits, uptime. Can come
    back mostly-empty/zeroed right after a restart -- that's not necessarily
    an error, but worth noting.
  - `omniroute_get_session_snapshot` -- cost, tokens, top models, errors.
  - `omniroute_set_resilience_profile` (`aggressive`/`balanced`/
    `conservative`) -- **this setting does NOT persist across an omniroute
    restart.** If a container rebuild or restart happens on CT102, it
    silently reverts, and the old default is too tight for a slow local
    model (see below). Re-apply `conservative` if you see the 504 below
    coming back after any CT102 restart. This is a known operational gap,
    not something fixable from our side -- flag it to the user, don't just
    silently re-apply it without saying so if it looks like a fresh
    regression.
  - `omniroute_explain_route` (needs a request id from the `X-Request-Id`
    header).
  - `omniroute_agent_skills_list` -- lists omniroute's own documented
    API/CLI/config surface; useful for finding capabilities not covered
    here.
- Direct container access via the `servarr` skill (load it first):
  `servarr containers logs 102 <lines>` for the raw omniroute journal, or
  `servarr containers exec 102 "<cmd>"` for anything else. CT102's own logs
  are far more informative than the MCP health tools for actual failure
  diagnosis -- **grep the raw logs first** when something's actually broken.

### Known failure signatures (from CT102's logs)

```
[ERROR] [504]: Request exceeded OmniRoute's local rate-limit execution
  expiration (legacy resilienceSettings.requestQueue.maxWaitMs=15000ms)
```
This is the resilience-profile issue above. Fast to hit with any model
slower than ~15s per response. Fix: re-apply the `conservative` profile.

```
[429] model_cooldown: "All credentials for model X are cooling down"
```
Omniroute's own circuit breaker tripped after repeated failures for that
model (separate from the maxWaitMs issue, though the two often cluster
together -- a streak of 504s can trip this next). Self-resolves after
`reset_seconds`; don't panic, just wait or use a different model meanwhile.

```
ProxyFetch Direct response-start timeout (30000ms) on pooled dispatcher --
  retrying on fresh no-keep-alive dispatcher: <ip>:<port>
```
A separate, shorter dispatcher-level timeout, distinct from the
resilience-profile one. Also worth knowing about if requests fail right
around 30s.

**Important, still-unconfirmed suspicion**: omniroute may not actually
*cancel* the underlying request to a backend (oMLX) when it times the
caller out. If you see a job ID in oMLX's own dashboard sitting at high
token counts for minutes with no corresponding entry in our observer's log,
that's likely an orphaned request omniroute gave up on but oMLX kept
running. Not fully root-caused this session -- worth a proper look if it
keeps happening (check for a matching timeout/504 in CT102's logs around
when the orphan started, then check whether oMLX exposes any way to see
what triggered / cancel in-flight jobs).

### Tracing one request end to end

1. `DEBUG=1` on our observer (`~/.claude-mem-host-observer/observer.log`) --
   shows the exact request we sent, mode classification, trimmed messages,
   raw backend response, parse result, and any escalation.
2. `servarr containers logs 102 <N>` -- CT102's own log, shows the same
   request from omniroute's side: routing decision, which upstream account
   got used, timing, any 429/504.
3. If it reached oMLX, check oMLX's own dashboard on xenon (or ask the user
   -- they've been watching it directly via its UI) for the actual
   generation progress/token count for that job.

## The claude-mem fork

`darrenloasby/claude-mem` (github), forked from `thedotmack/claude-mem`,
reset to upstream `main` then patched. Marketplace source repointed to the
fork on both machines that run it (this Mac: `~/.claude/plugins/marketplaces/
thedotmack`, via `known_marketplaces.json`; xenon: `~/.codex/.tmp/
marketplaces/claude-mem-local`, via `~/.codex/config.toml`'s
`[marketplaces.claude-mem-local]` block). Both are real git clones with
`origin` pointed at the fork.

**Deploying a change to the fork requires ALL of these steps, not just a
commit + push** (learned the hard way -- version bump alone silently did
nothing):

1. Make the source change, typecheck (`npx tsc --noEmit`, and
   `npx tsc --noEmit -p src/ui/viewer/tsconfig.json` if you touched the
   viewer).
2. **Bump the version** in all five manifest files (`package.json`,
   `plugin/package.json`, `plugin/.claude-plugin/plugin.json`,
   `plugin/.codex-plugin/plugin.json`, `.codex-plugin/plugin.json`) --
   run `node scripts/sync-plugin-manifests.js` after to catch any others.
   Claude Code's plugin cache dedupes by version string, not git content --
   without a version bump, `claude plugin update` sees "already at this
   version" and does nothing, even though the underlying git content
   changed.
3. **Run the full build**: `npm run build`. This regenerates the checked-in
   compiled bundles (`plugin/scripts/*.cjs`, `plugin/sqlite/*.js`,
   `plugin/ui/viewer-bundle.js`+`viewer.html`). These are NOT built on
   install -- they're committed artifacts. Skipping this step means the
   cache gets a version bump with stale pre-patch compiled code inside it.
4. Verify the patch actually landed in the built output before pushing,
   e.g. `rg -c "<a string unique to your change>" plugin/scripts/worker-service.cjs`.
5. Commit + push.
6. On each machine running the plugin: `git pull` in its marketplace clone,
   then trigger a real re-fetch. `claude plugin update <plugin>@<marketplace>`
   / `codex plugin add <plugin>@<marketplace>` can both report "already up
   to date" and skip re-copying if the target cache directory for that
   version already exists from an earlier (possibly stale) attempt -- if in
   doubt, `rm -rf` the specific version directory under
   `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` (or the codex
   equivalent under `~/.codex/plugins/cache/...`) before re-running the
   update/add command, then verify with the same `rg -c` check as step 4.
7. Restart the actual worker process (`claude-mem-observer` is separate --
   this is claude-mem's OWN worker, not ours): find the bundle path from the
   cache dir and run `bun <path>/scripts/worker-service.cjs restart`, or
   whatever the currently-running PID's version tells you needs replacing.
8. Verify migrations ran against the real DB if you touched the schema:
   `sqlite3 ~/.claude-mem/claude-mem.db "SELECT version FROM schema_versions
   ORDER BY version DESC LIMIT 5"`, and spot-check whatever your change was
   supposed to do actually happened.

### What's in the fork so far

- `source_host` column (`sdk_sessions`, `tool_uses`) -- which machine a
  session/tool-use actually ran on, since one worker now serves hooks from
  multiple machines. Captured via `os.hostname()` client-side in the hook
  handlers (`src/cli/handlers/session-init.ts`, `observation.ts`).
- VS Code Copilot mislabeling fix: the `claude-code` hook wire format isn't
  exclusive to genuine Claude Code. `resolveClaudeCodeHookPlatform()` in
  `src/shared/platform-source.ts` checks for `CLAUDE_CODE_ENTRYPOINT` (only
  genuine Claude Code sets it) and labels anything else `vscode-copilot`.
  Includes a tested one-time backfill for historical rows using VS Code's
  lowercase-snake_case tool-name vocabulary as the retroactive signal.
- `generated_by_model` on `session_summaries` (matching the column
  `observations` already had) -- which model actually produced a given
  observation/summary. Surfaced in the viewer's main feed query
  (`PaginationHelper.ts`, which already joined `sdk_sessions` for
  `platform_source` -- `source_host` rides the same join).
- Viewer: tiny labels for host + generator model next to the existing
  platform badge (`ObservationCard.tsx`, `SummaryCard.tsx`,
  `PromptCard.tsx`), plus a distinct `vscode-copilot` badge color in
  `src/ui/viewer-template.html`.

### The xenon multi-host tunnel setup

xenon runs Codex CLI with claude-mem's plugin, but has NO local worker of
its own by design -- it tunnels hook traffic back to this Mac's real worker
via an SSH remote-forward (`~/.ssh/config`, `Host xenon`:
`RemoteForward 127.0.0.1:37701 192.168.86.4:37701` -- the explicit
`127.0.0.1:` bind prefix matters, an unqualified `RemoteForward 37701 ...`
was defaulting to IPv6-only `::1`, which didn't match what claude-mem's
worker-liveness probe checks, causing xenon to think no worker was reachable
and lazily spawn its own rogue local one). `CLAUDE_MEM_WORKER_HOST` in
xenon's `~/.codex/config.toml` (`[shell_environment_policy]`) must be
`127.0.0.1` to match. If you ever see two different things listening on
port 37701 on xenon (check with `lsof -nP -iTCP:37701 -sTCP:LISTEN`), one of
them is a rogue worker that needs killing (and its
`~/.claude-mem/worker.pid` removed) -- it'll have its own separate, stale
`~/.claude-mem/claude-mem.db` silently absorbing session data that never
reaches the real one.
