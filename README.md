<div align="center">
  <h1>@cyanheads/canada-parliament-mcp-server</h1>
  <p><b>Track Canadian federal bills, MPs, House votes, and Hansard speeches via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/canada-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/canada-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/canada-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/canada-parliament-mcp-server/releases/latest/download/canada-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=canada-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2FuYWRhLXBhcmxpYW1lbnQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22canada-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcanada-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://canada-parliament.caseyjhand.com/mcp](https://canada-parliament.caseyjhand.com/mcp)

</div>

---

## Overview

Canadian federal parliamentary records from [LEGISinfo](https://www.parl.ca/legisinfo/en/bills), the [House of Commons](https://www.ourcommons.ca/en/open-data), and [OpenParliament](https://openparliament.ca/api/). Follow House and Senate bills through their stages and read each version's text, find current and former MPs, inspect recorded House divisions, and read indexed House Hansard speeches. Public sources require no API key.

### Tools

| Tool | Description |
|:---|:---|
| `canparl_search_bills` | Search a session's official bills by title, number, chamber, type, status, or indexed MP sponsor |
| `canparl_get_bill` | Read an official bill dossier: sponsor and title, stages, inter-chamber messages, reading milestones, divisions, publications, legislative summary, notes, web references, enacted statute citation, and links to earlier versions |
| `canparl_get_bill_text` | Read one version of a bill as plain text from its official XML: introduction, headings, numbered sections, and schedules |
| `canparl_search_members` | Search the current House roster by name, riding, province, party, or postal code, a past Parliament's official roster, or OpenParliament's historical name index |
| `canparl_get_member` | Read a member profile, dated memberships, sponsored bills, and recent ballots with their division tallies |
| `canparl_search_votes` | Search recorded House divisions by bill, result, document type, date, or subject |
| `canparl_get_vote` | Read a division's official tally, party totals, and individual recorded ballots |
| `canparl_search_speeches` | Find indexed House speeches by speaker, bill debated or mentioned, date, and literal English or French text |
| `canparl_list_reference` | Discover actual session coverage and source-specific filter vocabulary |

## Capability reference

### `canparl_search_bills` <sub>tool</sub>

- `titleContains` (matching ignores case, accents, dash and quote styles, and repeated whitespace), `billCode`, `originatingChamber`, `billType`, `status`, and `sponsor`, combined with AND; `limit` 1–100 (default 10; values up to 10,000 clamp to 100 with a notice) with offset pagination
- Bilingual titles, status, latest major stage, and royal assent date, with the exact filtered `total` and `pagination.nextOffset`
- `sponsor` takes an OpenParliament slug, `/politicians/` path, or profile URL (`member.slug` from `canparl_get_member`, or an `includeFormer` search row), or a current MP's `personId`. A digit-only value equal to a current `personId`, or its `/politicians/<digits>/` path or URL, resolves through the same verified crosswalk as `canparl_get_member`; `appliedFilters.sponsorName` names the profile used. Any other digit-only value is an OpenParliament ID; when it is also a former MP's `personId`, a notice names both people and routes that `personId` to `canparl_get_member`
- Sponsor results cover only OpenParliament's index (`sponsorCoverage: "openparliament_index"`), which excludes Senators; a scan past ten 100-row pages fails as `sponsor_scan_incomplete`

---

### `canparl_get_bill` <sub>tool</sub>

- `billCode` and its `session` from `canparl_search_bills`; returns the sponsor and their affiliation `title`, House/Senate/royal-assent stages, House divisions (`dateTime` is the LEGISinfo sitting date-time, not when the division was recorded), Senate vote records, publications, and `statute`
- Also the Library of Parliament legislative `summary` and dossier `notes` as plain text (each note link kept as `text (href)`), the six reading `milestones` as UTC instants converted from LEGISinfo's Ottawa-time clocks, and related `webReferences` (press releases, background documents, costing notes) whose URLs are relayed as published, never fetched
- `interChamberMessages` lists the messages and amendment exchanges between the House and Senate, the record of whether the Senate amended the bill and how the House answered. `similarBills` lists earlier versions and related bills as `canparl_search_bills` rows, newest session first, and `reinstatement` links the bill to the previous or next session's version when LEGISinfo records one (a bill reinstated by government motion carries no link; `similarBills` still lists its earlier version). Pass a returned `session` and `billCode` back to `canparl_get_bill`; each `publications` entry's `id` is the `publicationId` for `canparl_get_bill_text`
- Above a 24,000-byte serialized size, returns `kind: "outline"` with `sponsor`, `statute`, `milestones`, and `reinstatement` inline, listing the 17 sections `sponsor`, `stages.house`, `stages.senate`, `stages.royalAssent`, `interChamberMessages`, `divisions`, `senateVoteDetails`, `publications`, `statute`, `summary.en`, `summary.fr`, `notes.en`, `notes.fr`, `milestones`, `webReferences`, `reinstatement`, and `similarBills`; re-call with `section`, paging collections by `offset` and `limit` (1–100, default 20; values up to 10,000 clamp to 100 with a notice) through `pagination.nextOffset`
- A selected page holds exactly `limit` whole records (or what remains); `reinstatement` and the other scalar sections take no `offset` or `limit`, and null, empty, and past-end sections stay distinct

---

### `canparl_get_bill_text` <sub>tool</sub>

- Reads one version of a bill as plain text from its official XML: the `introduction` (royal recommendation, summary, preamble, enacting clause), `headings`, numbered `body` sections, and `schedules`. `publicationId` is a `canparl_get_bill` `publications` entry's `id` and defaults to the last-listed version; `language` is `en` (default) or `fr`; an omitted `session` resolves from the current official bill feed
- A text of at most 24,000 bytes returns whole. A larger one returns `kind: "outline"` with the segment counts and the outermost headings, each with the body `offset` and `count` of the sections it spans and their `characters`; re-call with `segment` set to `introduction`, `headings`, `body`, or `schedules`, paging the last three by `offset` and `limit` (1–100; default 50 headings, 5 sections or schedules; values up to 10,000 clamp to 100 with a notice) through `pagination.nextOffset`
- Pages hold whole sections, never a split one, so a single section can be very large: one section of 45-1 C-15 is 129,702 characters. Read a heading's `characters` before paging its sections, and request a small `limit` for a large part
- Explanatory notes on existing text are kept in `explanatoryNotes`, apart from the enacted `text`. Table cells are joined by ` | `
- A version exported only as a PDF or a table-of-contents cover, as in many sessions before 42-1, has no text here and fails as `bill_text_unavailable`; read it on its `publications` `url`

---

### `canparl_search_members` <sub>tool</sub>

- Current roster: `name` and `riding` substrings (matching ignores case, accents, dash and quote styles, and repeated whitespace), `province` (two-letter abbreviation such as `ON`, or full name), and `party`; `limit` 1–100 (default 25; values up to 10,000 clamp to 100 with a notice) with the exact filtered `total`
- `postalCode` finds the sitting MPs who represent a complete Canadian postal code (`K1A 0A6`, any case, with or without one space or dash): every one when the code spans ridings, combined with the other filters by AND. A code with no sitting MP, whether unassigned or in a vacant riding, returns an empty page with a notice. It reads the current roster only and is rejected with `includeFormer` or `parliament`
- `parliament` (36th onward) searches that Parliament's official roster with the same filters: everyone who sat in it, one row each with the caucus and riding last held there, the membership `from` and `to` dates, and `current`. An unoffered Parliament fails listing the ones offered; it is rejected with `includeFormer` or `postalCode`
- `includeFormer: true` searches OpenParliament's historical name index instead: one token matches a surname, several match a full recorded name. Parliament, geographic, party, and postal code filters are rejected there, rows may carry only a name and slug, and `total` is `null`
- Pass `detailLookup` unchanged to `canparl_get_member`: official roster rows carry an official `personId`, historical rows an OpenParliament `slug`

---

### `canparl_get_member` <sub>tool</sub>

- Exactly one `personId` or `slug` from `detailLookup`; returns the profile and dated `memberships`. A digit-only `slug` equal to a current `personId`, or its `/politicians/<digits>/` path or URL, is read as that `personId`. A former member's `personId` (36th Parliament onward, as on `canparl_get_vote` ballots) resolves on the all-Parliaments roster with `current: false`, carrying their latest Parliament's caucus and riding; slug inputs stay current-roster only, so any other digit-only `slug` is an OpenParliament ID, and when it is also a former MP's `personId` a notice names both people
- `personId` crosswalks verify the official ID and a recorded name or published alias; a bounded surname lookup after an empty exact-name page accommodates accents and middle initials without guessing a slug
- `sponsoredBills` (0–5, default 5) and `recentVotes` (default 10) page independently through `billsOffset` and `votesOffset`; `0` skips a section, and values up to 10,000 clamp to the cap with a notice. `recentVotes` takes 0–100 per call for official ballots and 0–10 for a member without one official `personId`
- With one official `personId`, ballots come newest first from the official member-votes feed in one request, for the member's latest session or `votesSession`, optionally narrowed by `votesBillCode`; `recentVotes.total` is the exact count of the session's ballots after `votesBillCode`, before paging (`null` for OpenParliament ballots, whose pages carry no count; `sponsoredBills.total` is always `null`). Each ballot carries its division's `yeas`, `nays`, `paired`, and, on official rows, `documentType`, each `null` when the source omits it. `ballot` reads `Yes`/`No`/`Paired`, `officialBallot` keeps `Yea`/`Nay`/`Paired`, and `source` names the feed; other members keep OpenParliament ballots
- Each activity section reports `available`, `unavailable`, or `not_requested`, with `failure` metadata; unavailable history is never reported as empty
- Profile `links` are never fetched: an absolute `http` or `https` URL is relayed as published, and a relative value is resolved against `https://openparliament.ca`

---

### `canparl_search_votes` <sub>tool</sub>

- `billCode`, `result` (`Agreed To`, `Negatived`, `Tie`), `documentType`, inclusive Ottawa-date `dateFrom` and `dateTo`, and `subjectContains` (matching ignores case, accents, dash and quote styles, and repeated whitespace); `limit` 1–100 (default 25; values up to 10,000 clamp to 100 with a notice) with offset pagination
- Newest first, with official tallies and the exact filtered `total`; pass `session` and `number` to `canparl_get_vote`

---

### `canparl_get_vote` <sub>tool</sub>

- `number` and its `session`; `ballot` (`Yea`, `Nay`, `Paired`; `Yes`/`No` accepted), `personId`, `party`, and `province` filter only the ballot page; `limit` 1–400 (default 30; values up to 10,000 clamp to 400 with a notice) with offset pagination
- `tally`, `byParty`, and `ballotsTotal` cover the whole division and `ballotsMatched` the filtered set; `tallyMatchesBallots` flags a disagreement without changing either count
- Ballots are `Yea`, `Nay`, or `Paired`; nonvoters are not listed, so a `personId` with no ballot returns an empty page
- A page holds up to `limit` ballots, with `truncated` and `nextOffset` while more match

---

### `canparl_search_speeches` <sub>tool</sub>

- Needs a scope: `politician`, `billDebated` or `mentionedBill` (`{ session, code }`), `dateFrom`, or `dateTo`; `contains` is a literal substring of the selected `language` (`en` default, or `fr`; matching ignores case, accents, dash and quote styles, and repeated whitespace) and never a scope on its own. `limit` 1–10 (default 5; values up to 10,000 clamp to 10 with a notice)
- `politician` takes the same slug, path, URL, or current `personId` values as `canparl_search_bills` `sponsor`, resolved the same way, including the notice for a digit-only value that is also a former MP's `personId`; `appliedFilters.politicianName` names the profile used
- Scans at most 100 raw candidates per call: follow `nextOffset` with identical filters until `exhausted` before concluding there is no match, and even then the answer covers OpenParliament's index only
- Complete `content`, `speaker`, `h1`, and `h2` in the selected `language` (`null` where that language has none, never the other language's text; older records carry no French), with speech-date party and riding in English (`null` when unavailable); `substantiveOnly` (default `true`) drops procedural remarks, and committee records are excluded and counted in `excludedCommittees`

---

### `canparl_list_reference` <sub>tool</sub>

- `topic`: `sessions`, `bill_types`, `bill_statuses`, `vote_results`, `vote_document_types`, or `parties`; returns the complete set without pagination
- `sessions` takes no `session` and reports `basic` or `full` bill coverage and House division coverage per session; other topics take a session and mark each value `observed` in its feed; `parties` takes only the current session

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Canadian Parliament-specific:

- Official bill coverage from session `35-1` (1994), full dossiers from `37-1` (2001), and House divisions from `38-1` (2004); OpenParliament's historical name index reaches 1994
- Bills cover both chambers; member, division, and speech tools cover the House of Commons. Missing historical fields stay `null`
- Sessions accept `"45-1"` or `{ "parliament": 45, "session": 1 }`; an omitted session resolves from the current official bill feed, except in speech bill scopes
- Shared source pacing, short-lived in-memory caches, retries, and one 50-second tool deadline. OpenParliament requests are serialized with a two-second start gap, so sponsored bills and OpenParliament ballots can take tens of seconds
- Official-source HTTP 403 refusals fail with `upstream_blocked`, the source name, and guidance to retry that source later; response HTML is excluded, and official data is never replaced with another source

Agent-friendly output:

- Provenance: `source`, `url`, original `retrievedAt`, and `cached` on every successful retrieval
- Explicit coverage: normalized `appliedFilters`, continuation fields, notices, and typed failure reasons separate no matches from unavailable or incomplete data
- Advertised input formats: dates, sessions, person IDs, bill codes, postal codes, bill sections, and bill-text segments carry a `pattern` in the tool schema that accepts what the tool accepts, padded values included. A value outside the format fails at argument validation (`-32602`, `invalid_arguments`) naming the field and the expected form; impossible dates, reversed bounds, out-of-range session numbers, and unknown vocabulary values keep their typed tool reasons
- Both surfaces: every `structuredContent` value, complete source text included, also renders in Markdown `content[]`

The [Canadian Parliament research guide](./skills/canada-parliament-guide/SKILL.md) connects bill, division, member, and Hansard records and explains the evidence needed for historical conclusions. It ships with plugin installs, npm, Docker, and the desktop bundle, and is available over MCP as `skill://canada-parliament-guide/SKILL.md`.

## Getting started

Connect to the hosted server in Claude Code:

```sh
claude mcp add --transport http canada-parliament-mcp-server https://canada-parliament.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add canada-parliament-mcp-server -- npx -y @cyanheads/canada-parliament-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "canada-parliament-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/canada-parliament-mcp-server"]
    }
  }
}
```

No API key is required. Optionally set `CANPARL_USER_AGENT` to identify your deployment to the upstream sources. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `CANPARL_USER_AGENT` | HTTP User-Agent sent to the upstream sources. Blank uses the default; CR and LF are rejected. | `canada-parliament-mcp-server (casey@caseyjhand.com; https://github.com/cyanheads/canada-parliament-mcp-server)` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for every server setting and the common framework overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+), and Internet access to parl.ca, ourcommons.ca, and openparliament.ca.

```sh
git clone https://github.com/cyanheads/canada-parliament-mcp-server.git
cd canada-parliament-mcp-server
bun install
cp .env.example .env
```

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/canada-parliament-mcp-server:latest
```

The image defaults to HTTP transport, stateless sessions, and logs in `/var/log/canada-parliament-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/canada-parliament-mcp-server:latest"]`. Build locally with `docker build -t canada-parliament-mcp-server .`; OpenTelemetry peers are installed by default, or omitted with `--build-arg OTEL_ENABLED=false`.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), the shared Markdown renderer, and the shared member-identity crosswalk. |
| `src/services/legisinfo` | LEGISinfo service — session discovery, official bill lists, dossiers, and bill-version text. |
| `src/services/ourcommons` | House of Commons service — current and per-Parliament rosters, postal-code lookup, division, and member-vote XML. |
| `src/services/openparliament` | OpenParliament service — historical identities, activity, speeches, and memberships. |
| `src/domain` | Shared schemas, normalization, reference vocabulary, and request budgets. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `skills/` | Published parliamentary research guide for agents calling the tools. |
| `tests/` | Parser, service, tool, and integration tests over synthetic upstream fixtures. |

See [`docs/tree.md`](./docs/tree.md) for the full tree.

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches; catch only to translate a known source failure or keep optional enrichment
- Use `ctx.log` for logging and `ctx.enrich` for applied filters, totals, and notices
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Code is licensed under [Apache 2.0](./LICENSE). Parliamentary data is an unofficial reproduction credited to Parliament and, where used, OpenParliament; Parliament retains copyright. Reuse is governed separately by the [Parliament notices](https://www.parl.ca/ImportantNotices-e.html), the [Speaker's Permission](https://www.ourcommons.ca/en/important-notices#SpeakersPermission), the [Senate terms](https://sencanada.ca/en/intellectual-property/), and the [OpenParliament API terms](https://openparliament.ca/api/). This free, noncommercial relay does not imply government endorsement or an open-data licence.
