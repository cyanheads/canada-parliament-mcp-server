<div align="center">
  <h1>@cyanheads/canada-parliament-mcp-server</h1>
  <p><b>Track Canadian federal bills, MPs, House votes, and Hansard speeches via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/canada-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/canada-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/canada-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Canadian federal parliamentary records from [LEGISinfo](https://www.parl.ca/legisinfo/en/bills), the [House of Commons](https://www.ourcommons.ca/en/open-data), and [OpenParliament](https://openparliament.ca/api/). Follow House and Senate bills through their stages, find current and former MPs, inspect recorded House divisions, and read indexed House Hansard speeches. Public sources require no API key.

### Tools

| Tool | Description |
|:---|:---|
| `canparl_search_bills` | Search a session's official bills by title, number, chamber, type, status, or indexed MP sponsor |
| `canparl_get_bill` | Read an official bill dossier: sponsor and title, stages, reading milestones, divisions, publications, legislative summary, notes, web references, and enacted statute citation |
| `canparl_search_members` | Search the current House roster or OpenParliament's historical name index |
| `canparl_get_member` | Read a member profile, dated memberships, sponsored bills, and recent ballots |
| `canparl_search_votes` | Search recorded House divisions by bill, result, document type, date, or subject |
| `canparl_get_vote` | Read a division's official tally, party totals, and individual recorded ballots |
| `canparl_search_speeches` | Find indexed House speeches by speaker, bill debated or mentioned, date, and literal English text |
| `canparl_list_reference` | Discover actual session coverage and source-specific filter vocabulary |

## Capability reference

### `canparl_search_bills` <sub>tool</sub>

- `titleContains`, `billCode`, `originatingChamber`, `billType`, `status`, and `sponsor`, combined with AND; `limit` 1–100 (default 25; values up to 10,000 clamp to 100 with a notice) with offset pagination
- Bilingual titles, status, latest major stage, and royal assent date, with the exact filtered `total` and `pagination.nextOffset`
- Whole bill rows stop early at the 24,000-byte response budget; follow `pagination.nextOffset` with identical filters. An oversized single row returns whole with a notice
- `sponsor` takes an OpenParliament slug, `/politicians/` path, or profile URL (`member.slug` from `canparl_get_member`, or an `includeFormer` search row), or a current MP's `personId`. A digit-only value equal to a current `personId`, or its `/politicians/<digits>/` path or URL, resolves through the same verified crosswalk as `canparl_get_member`; `appliedFilters.sponsorName` names the profile used
- Sponsor results cover only OpenParliament's index (`sponsorCoverage: "openparliament_index"`), which excludes Senators; a scan past ten 100-row pages fails as `sponsor_scan_incomplete`

---

### `canparl_get_bill` <sub>tool</sub>

- `billCode` and its `session` from `canparl_search_bills`; returns the sponsor and their affiliation `title`, House/Senate/royal-assent stages, House divisions (`dateTime` is the LEGISinfo sitting date-time, not when the division was recorded), Senate vote records, publications, and `statute`
- Also the Library of Parliament legislative `summary` and dossier `notes` as plain text (each note link kept as `text (href)`), the six reading `milestones` as UTC instants, and related `webReferences` (press releases, background documents, costing notes) whose URLs are relayed as published, never fetched
- Above a 24,000-byte response budget, returns `kind: "outline"` with `sponsor`, `statute`, and `milestones` inline, listing the sections `sponsor`, `stages.house`, `stages.senate`, `stages.royalAssent`, `divisions`, `senateVoteDetails`, `publications`, `statute`, `summary.en`, `summary.fr`, `notes.en`, `notes.fr`, `milestones`, and `webReferences`; re-call with `section`, paging collections by `offset` and `limit` (1–100, default 20; values up to 10,000 clamp to 100 with a notice) through `pagination.nextOffset`
- Pages hold whole records; an indivisible record or language section over the budget returns whole with `disclosure`, and null, empty, and past-end sections stay distinct

---

### `canparl_search_members` <sub>tool</sub>

- Current roster: `name` and `riding` substrings, `province` (postal code or full name), and `party`; `limit` 1–100 (default 25; values up to 10,000 clamp to 100 with a notice) with the exact filtered `total`
- `includeFormer: true` searches OpenParliament's historical name index instead: one token matches a surname, several match a full recorded name. Geographic and party filters are rejected there, rows may carry only a name and slug, and `total` is `null`
- Pass `detailLookup` unchanged to `canparl_get_member`: current rows carry an official `personId`, historical rows an OpenParliament `slug`
- Whole member rows stop early at the 24,000-byte response budget; follow `pagination.nextOffset` with identical filters. An oversized single row returns whole with a notice

---

### `canparl_get_member` <sub>tool</sub>

- Exactly one `personId` or `slug` from `detailLookup`; returns the profile and dated `memberships`. A digit-only `slug` equal to a current `personId`, or its `/politicians/<digits>/` path or URL, is read as that `personId`
- Current-person crosswalks verify the official ID and a recorded name or published alias; a bounded surname lookup after an empty exact-name page accommodates accents and middle initials without guessing a slug
- `sponsoredBills` (0–5, default 5) and `recentVotes` (0–10, default 10) page independently through `billsOffset` and `votesOffset`; `0` skips a section, and values up to 10,000 clamp to the cap with a notice
- With one official `personId`, ballots come newest first from the official member-votes feed in one request, for the member's latest session or `votesSession`, optionally narrowed by `votesBillCode`. `ballot` reads `Yes`/`No`/`Paired`, `officialBallot` keeps `Yea`/`Nay`/`Paired`, and `source` names the feed; other members keep OpenParliament ballots
- Each activity section reports `available`, `unavailable`, or `not_requested`, with `failure` metadata; unavailable history is never reported as empty
- Profile `links` are never fetched: an absolute `http` or `https` URL is relayed as published, and a relative value is resolved against `https://openparliament.ca`

---

### `canparl_search_votes` <sub>tool</sub>

- `billCode`, `result` (`Agreed To`, `Negatived`, `Tie`), `documentType`, inclusive Ottawa-date `dateFrom` and `dateTo`, and `subjectContains`; `limit` 1–100 (default 25; values up to 10,000 clamp to 100 with a notice) with offset pagination
- Newest first, with official tallies and the exact filtered `total`; pass `session` and `number` to `canparl_get_vote`
- Whole division rows stop early at the 24,000-byte response budget; follow `pagination.nextOffset` with identical filters. An oversized single row returns whole with a notice

---

### `canparl_get_vote` <sub>tool</sub>

- `number` and its `session`; `ballot` (`Yea`, `Nay`, `Paired`; `Yes`/`No` accepted), `personId`, `party`, and `province` filter only the ballot page; `limit` 1–400 (default 30; values up to 10,000 clamp to 400 with a notice) with offset pagination
- `tally`, `byParty`, and `ballotsTotal` cover the whole division and `ballotsMatched` the filtered set; `tallyMatchesBallots` flags a disagreement without changing either count
- Ballots are `Yea`, `Nay`, or `Paired`; nonvoters are not listed, so a `personId` with no ballot returns an empty page
- A page stops at a 24,000-byte response budget with `truncated` and a notice; follow `nextOffset` for the rest

---

### `canparl_search_speeches` <sub>tool</sub>

- Needs a scope: `politician`, `billDebated` or `mentionedBill` (`{ session, code }`), `dateFrom`, or `dateTo`; `contains` is a literal English substring and never a scope on its own. `limit` 1–10 (default 5; values up to 10,000 clamp to 10 with a notice), and a page stops at a 24,000-byte response budget, returning at least one speech whole
- `politician` takes the same slug, path, URL, or current `personId` values as `canparl_search_bills` `sponsor`, resolved the same way; `appliedFilters.politicianName` names the profile used
- Scans at most 100 raw candidates per call: follow `nextOffset` with identical filters until `exhausted` before concluding there is no match, and even then the answer covers OpenParliament's index only
- Complete English `content` with speech-date party and riding (`null` when unavailable); `substantiveOnly` (default `true`) drops procedural remarks, and committee records are excluded and counted in `excludedCommittees`

---

### `canparl_list_reference` <sub>tool</sub>

- `topic`: `sessions`, `bill_types`, `bill_statuses`, `vote_results`, `vote_document_types`, or `parties`; returns the complete set without pagination
- `sessions` takes no `session` and reports `basic` or `full` bill coverage and House division coverage per session; other topics take a session and mark each value `observed` in its feed

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
- Both surfaces: every `structuredContent` value, complete source text included, also renders in Markdown `content[]`

## Getting started

### Public Hosted Instance

A public instance is available at `https://canada-parliament.caseyjhand.com/mcp` — no installation required. It serves Streamable HTTP; each client takes its own config shape.

For Claude Code:

```sh
claude mcp add --transport http canada-parliament-mcp-server https://canada-parliament.caseyjhand.com/mcp
```

For Cline (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "canada-parliament-mcp-server": {
      "type": "streamableHttp",
      "url": "https://canada-parliament.caseyjhand.com/mcp"
    }
  }
}
```

For Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "canada-parliament-mcp-server": {
      "url": "https://canada-parliament.caseyjhand.com/mcp"
    }
  }
}
```

Claude Desktop adds remote servers under Settings → Connectors.

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "canada-parliament-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/canada-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "canada-parliament-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/canada-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "canada-parliament-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/canada-parliament-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Internet access to parl.ca, ourcommons.ca, and openparliament.ca; no API key is required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/canada-parliament-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd canada-parliament-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optional: set CANPARL_USER_AGENT to identify your deployment to the upstream sources
```

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

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`), the shared Markdown renderer, and the shared member-identity crosswalk. |
| `src/services/legisinfo` | LEGISinfo service — session discovery, official bill lists and dossiers. |
| `src/services/ourcommons` | House of Commons service — current roster, division, and member-vote XML. |
| `src/services/openparliament` | OpenParliament service — historical identities, activity, speeches, and memberships. |
| `src/domain` | Shared schemas, normalization, reference vocabulary, and request budgets. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
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
