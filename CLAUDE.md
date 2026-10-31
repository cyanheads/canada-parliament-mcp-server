# Developer Protocol

**Server:** canada-parliament-mcp-server
**Version:** 0.2.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `0.13.18`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.4.0
**Zod:** ^4.6.7

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers throw on failure. Catch only to translate a known domain failure, preserve optional enrichment, or dispose a request context; always propagate caller cancellation. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

Eight read-only tools and the `canada-parliament-guide` skill are registered in `src/index.ts`. The skill is served as an MCP resource; there are no prompts. Read the real definitions instead of copying generic examples:

| Definition | Pattern |
|:---|:---|
| `search-votes.tool.ts` | Validate filters, load the complete official feed, paginate, enrich, render |
| `get-member.tool.ts` | Verified identity crosswalk and independently pageable optional activity |
| `get-bill.tool.ts` | Lossless outline/section retrieval and whole-record pagination |
| `search-speeches.tool.ts` | Bounded raw-candidate scan and historical membership hydration |

All definitions use `formatResult` from `_format.ts`, with reversible Markdown values matching `structuredContent`. Preserve source text as data, never instructions.

### Server configuration and identity

`src/config/server-config.ts` lazily parses `CANPARL_USER_AGENT` through `parseEnvConfig`. Blank input uses `DEFAULT_USER_AGENT`; CR/LF is invalid. There are no upstream credentials or configurable source origins.

`createApp()` uses `name: 'canada-parliament-mcp-server'` and `title: 'canada-parliament-mcp-server'`; the package supplies its description. npm/install identity is `@cyanheads/canada-parliament-mcp-server`, registry identity `io.github.cyanheads/canada-parliament-mcp-server`. Keep scoped names off machine/display fields.

### Services and lifecycle

| Service | Owned data |
|:---|:---|
| `legisinfo` | Official sessions, current session, complete session bill lists, dossiers |
| `ourcommons` | Current and per-Parliament House rosters, division sessions/lists/participants, member votes |
| `openparliament` | Historical identities, sponsored bills, ballots for members without one official personId, speeches, dated memberships |

`setup()` initializes all three services; `teardown()` disposes their pacers and caches. HTTP defaults to stateless. Source caches hold parsed public data only; no durable personal-data store.

Each handler creates a request context and disposes it in `finally`. One 50-second deadline covers queueing, retrying, body reads, and hydration; the upstream subdeadline is 45 seconds. Optional member/speech enrichment may become explicitly unavailable, but caller cancellation and the outer deadline always fail the call. Never turn unavailable history into an empty-history claim.

Requests use fixed HTTPS origins `www.parl.ca`, `www.ourcommons.ca`, and `api.openparliament.ca`. Validate identifiers and pagination links; returned image/publication/profile links are references, never arbitrary fetch targets. Cache successful responses only and retain original retrieval timestamps.

Official HTTP 403 refusals become source-named `upstream_blocked` ServiceUnavailable failures with status 403, no retry, and source-specific retry-later recovery. Disable upstream error-body capture before framework logging. Never bypass source restrictions or substitute unofficial data. Optional enrichment keeps its unavailable-section contract.

### Domain constraints

- Bills cover both chambers; members, divisions, and speeches cover the House only. Early bill sessions have basic coverage and nullable dossier fields.
- Official `personId` and OpenParliament `slug` are distinct. Use returned `detailLookup` and verified crosswalks, never name-derived slugs. Slug inputs (`slug`, `sponsor`, `politician`) read a digit-only value equal to a current personId, or its `/politicians/<digits>/` path or profile URL, through the shared crosswalk in `_member-identity.ts`, the roster first; every other numeric value is an OpenParliament ID. Never request `/politicians/{personId}/`.
- Fixed input formats (date, session, personId, bill code, bill `section`) are one `InputFormat` in `normalization.ts`, advertised as a schema `pattern` and parsed by the same normalizer (`optionalFormat`/`requiredFormat` in `schemas.ts`). Shape failures are schema-level `-32602 invalid_arguments`; semantic failures (impossible dates, reversed bounds, out-of-range session numbers, unknown vocabulary, malformed slugs) keep their tool reasons. Slug inputs carry no pattern.
- Sponsor filtering is the OpenParliament-indexed subset; a bounded incomplete scan fails rather than inventing completeness.
- Current-person crosswalks retain strict index and recorded-profile name precedence. Only an empty terminal exact-name page opens surname discovery and a different accent-folded surname query; each page and the deduplicated union admit at most three candidates. A unique profile must verify the official personId and a recorded name or usable published alias, comparing accents and optional interior single-letter initials locally. Source names remain unchanged.
- Official-roster search (current, or a past Parliament via `parliament`) filters the complete roster. Historical name lookup stays sparse and rejects unsupported parliament/geographic/caucus filters. A roster row holds one caucus per member (the last held), so `canparl_list_reference` `parties` answers the current session only. A former personId resolves on the all-Parliaments roster (`p=*`) in `canparl_get_member` only; slug inputs stay current-only.
- Speech `contains` is a bounded scan with raw-offset continuation and `exhausted`, over the selected `language` (`en`/`fr`) text; a speech without text in that language never matches. Hydrate affiliations from dated memberships, never current attributes.
- One 24,000-byte complete-response budget and measure (`_format.ts`) bound `canparl_get_bill`, `canparl_get_vote`, and all four search tools; final notices and every enrichment field render through `renderValue` so the measure equals the wire. Large bill dossiers return an outline; pages preserve whole records, stop before the first that would exceed the budget, and return at least one when records exist; oversized indivisible records return with disclosure. Current searches advance by delivered rows; historical member pages preserve upstream nextOffset when delivered in full, otherwise resume at input offset plus delivered rows. Count acceptance, caps, and exact current totals stay unchanged.
- Preserve source-specific vote vocabulary and full tallies independently of ballot-page filters. `canparl_get_member` ballots keep OpenParliament's `Yes`/`No` in `ballot` on every row and carry the official `Yea`/`Nay`/`Paired` in `officialBallot`.
- Profile links are never fetched: an absolute `http` or `https` URL without credentials is relayed as published, any other non-empty value is resolved against `https://openparliament.ca`, and empty, credentialed, `mailto:`, `javascript:`, `data:`, and `ftp:` values are rejected; only `https://` values render as links.
- Tests run real parsers/services/handlers through synthetic fake HTTP responses, not mocked domain service methods.
- Parliamentary data is unofficial and subject to its source reuse terms. Do not imply government endorsement or an open-data licence.

See `docs/design.md` for source contracts and architectural decisions.

---

## Context

| Property | Server usage |
|:---|:---|
| `ctx.signal` | Caller cancellation composed with the tool/source deadlines |
| `ctx.fail` | Typed reason/code/recovery from the tool's inline error contract |
| `ctx.enrich` | Applied filters, totals, continuation limits, notices, and unavailable sections on both client surfaces |
| `ctx.log` | Request-correlated logging; client-visible, so exclude private data |

No tool uses elicitation, sampling, non-text content blocks, or durable storage.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts
  config/server-config.ts
  domain/                         # schemas, normalization, reference catalog, request context
  services/
    legisinfo/                    # index, service, parsing, types
    ourcommons/                   # index, service, parsing, types
    openparliament/               # index, service, parsing, types
  mcp-server/tools/definitions/   # eight *.tool.ts definitions, _format.ts, and _member-identity.ts
tests/
  config/
  domain/
  fixtures/
  integration/
  services/
  tools/
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-bills.tool.ts` |
| Tool/resource/prompt names | snake_case | `canparl_search_bills` |
| Directories | kebab-case | `src/services/legisinfo/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Two skill trees live at the project root, written for different readers:

| Tree | For | Written by |
|:-----|:----|:-----------|
| `framework-skills/` | The agent developing this server — framework skills (`metadata.audience: external`) plus any development-time skills of the server's own | `init` and the `maintenance` sync (framework skills); you (your own) |
| `skills/` | The agents that install the server and call its tools — tool chains, identifier sources, gates | You, deliberately, with the `add-skill` skill. Absent by default; usually none is needed |

Development skills are modular instructions. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. Their directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand them to every agent that installs it.

A published skill in root `skills/` reaches plugin installs and the `.mcpb` bundle as-is, ships in the npm package and the Docker image, and reaches MCP clients when the server opts in with `createApp({ skills: 'skills' })`. `lint:packaging` validates the tree.

**Agent skill directory:** Copy `framework-skills/` into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-skill` | Author a skill the server publishes in root `skills/` for the agents that use it — when one earns its place, structure, validation, delivery |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity, `.mcpbignore` coverage, plugin manifests, the published `skills/` tree (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start` | Built Node entry point |
| `bun run test:coverage` | Vitest coverage |
| `bun run publish-mcp` | Publish to MCP Registry using Keychain credentials; release workflow only |
| `bun run release:github` | GitHub release helper; release workflow only |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. `mcpb pack` reads `.mcpbignore`, not `.gitignore`, so every root path the bundle must not ship — source, tests, docs, caches, logs, agent docs, plugin manifests, gitignored local files — needs a root-anchored line there (`/docs/`, never `docs/`, which also strips `node_modules/*/docs/`); `lint:packaging` names each missing or unanchored line. Root `skills/` ships on purpose. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips four classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`); platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on; node-gyp build output beside a `binding.gyp` (`config.gypi`, Makefiles, `obj.target/`, `.deps/`, object files and debug symbols), which records the packing machine's paths — compiled `*.node` addons stay; and build-only package files — the framework's `changelog/`, `scripts/`, `templates/`, `CLAUDE.md`, `AGENTS.md`, and config bases (`biome.json`, `vitest.config.base.mjs`, `config/tsconfig.base.json`), and `better-sqlite3`'s `deps/` and `src/` C sources. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

Every release goes through a `release/<version>` PR — `git-wrapup`'s "Release PR mode", mode `straight-through`. Follow `git-wrapup`, then `release-and-publish`; fast-forward `main` locally with `git merge --ff-only`. Never squash, rebase, or merge through the GitHub UI. Docker publishing applies to this server.

The server reads public upstreams only and maintains no personal-data store. `docs/idea.md` is private design input, excluded from git, npm packages, MCP bundles, and Docker build contexts.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getLegisinfoService } from '@/services/legisinfo/index.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure; known-failure translation and optional enrichment preserve cancellation
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `plugin.json` + `mcp.json` (Agent Plugins 1.0.0 — read by Codex, Cursor, GitHub Copilot, VS Code, Kiro) populated — `plugin.json` `name` = the unscoped repo name (lowercase `a-z`, `0-9`, `-`, `.` only); `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords` from `package.json`; no other top-level field, `extensions` included. `mcp.json` holds one `"type": "stdio"` entry keyed by the unscoped name, `npx -y <full package name>`, and the same fixed `env` as `.codex-plugin/mcp.json`. Neither file carries a user-supplied variable (no `""`, no `${…}` besides `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`): keys reach Codex through `.codex-plugin/mcp.json` `env_vars`, which works only while `.codex-plugin/plugin.json` keeps `"mcpServers": "./.codex-plugin/mcp.json"`
- [ ] Any new root dev path has a root-anchored line in `.mcpbignore`; `bun run bundle` and `lint:packaging` pass
- [ ] If the server publishes a skill in root `skills/`: `lint:packaging` passes, and `field-test` verified every gate and identifier claim in it against live tool behavior
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] CLAUDE.md and AGENTS.md are byte-identical
- [ ] `bun run devcheck`, `bun run rebuild`, and `bun run test` pass
