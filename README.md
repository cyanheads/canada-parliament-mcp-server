<div align="center">
  <h1>@cyanheads/canada-parliament-mcp-server</h1>
  <p><b>Track Canadian federal bills, MPs, House votes, and Hansard speeches via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/canada-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/canada-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/canada-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/canada-parliament-mcp-server/releases/latest/download/canada-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=canada-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2FuYWRhLXBhcmxpYW1lbnQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22canada-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcanada-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Canadian federal parliamentary records from [LEGISinfo](https://www.parl.ca/legisinfo/en/bills), the [House of Commons](https://www.ourcommons.ca/en/open-data), and [OpenParliament](https://openparliament.ca/api/). Follow House and Senate bills through their stages, find current and former MPs, inspect recorded House divisions, and read indexed House Hansard speeches. Public sources require no API key.

### Tools

| Tool | Description |
|:---|:---|
| `canparl_search_bills` | Search a session's official bills by title, number, chamber, type, status, or indexed MP sponsor |
| `canparl_get_bill` | Read an official bill dossier, stages, divisions, publications, and enacted statute citation |
| `canparl_search_members` | Search the current House roster or OpenParliament's historical name index |
| `canparl_get_member` | Read a member profile, dated memberships, sponsored bills, and recent ballots |
| `canparl_search_votes` | Search recorded House divisions by bill, result, document type, date, or subject |
| `canparl_get_vote` | Read a division's official tally, party totals, and individual recorded ballots |
| `canparl_search_speeches` | Find indexed House speeches by speaker, bill debated or mentioned, date, and literal English text |
| `canparl_list_reference` | Discover actual session coverage and source-specific filter vocabulary |

## Capability reference

### `canparl_search_bills` <sub>tool</sub>

- Combine `titleContains`, `billCode`, `originatingChamber`, `billType`, `status`, and `sponsor` with AND; `limit` 1–100 (default 25), `offset` default 0
- Returns official bilingual titles, status, latest major stage, royal assent date, exact filtered `total`, and `pagination.nextOffset`
- `sponsor` takes a returned MP OpenParliament slug and restricts results to its index (`sponsorCoverage: "openparliament_index"`); Senators are outside that index. A scan exceeding ten 100-row pages fails with `sponsor_scan_incomplete` rather than returning an incomplete set

---

### `canparl_get_bill` <sub>tool</sub>

- Supply `billCode` from search and its `session`; returns sponsor, House/Senate/royal-assent stages with nested records, House divisions, source-specific Senate vote records, publications, and `statute` when available
- Dossiers above a 24,000-byte serialized response budget return `kind: "outline"` with section selectors: `sponsor`, `stages.house`, `stages.senate`, `stages.royalAssent`, `divisions`, `senateVoteDetails`, `publications`, `statute`. Re-call with `section`; collections accept `offset` (default 0) and `limit` 1–100 (default 20), continued through `pagination.nextOffset`
- Section pages preserve whole records and may contain fewer than `limit` to fit the budget. An indivisible record or scalar section above the budget is returned whole with `disclosure`; `null`, empty collections, and past-end offsets remain distinguishable

---

### `canparl_search_members` <sub>tool</sub>

- Current roster: literal `name`/`riding` substrings plus `province` and `party`; `limit` 1–100 (default 25), offset pagination, and exact filtered `total`
- `includeFormer: true` selects the historical index: one name token searches a surname, multiple tokens a full recorded name; riding/province/party filters are unsupported. Historical rows can contain only name and slug, with `total: null`
- Pass a returned `detailLookup` unchanged to `canparl_get_member`; official `personId` and OpenParliament `slug` are distinct identifiers

---

### `canparl_get_member` <sub>tool</sub>

- Supply exactly one `personId` or `slug` from `detailLookup`; returns a public profile and dated `memberships` where available
- Independent `sponsoredBills` (0–5, default 5) and `recentVotes` (0–10, default 10) limits, with `billsOffset`/`votesOffset` and each section's `nextOffset`; set both limits to 0 for profile-only lookup
- Optional enrichment failures preserve the official profile. Activity sections distinguish `available`, `unavailable`, and `not_requested`, with `failure` metadata; unavailable history is never an empty-history claim

---

### `canparl_search_votes` <sub>tool</sub>

- Combine `billCode`, `result`, `documentType`, `dateFrom`, `dateTo`, and `subjectContains`; dates are inclusive Ottawa civil dates. `limit` 1–100 (default 25), offset pagination
- Returns newest divisions first, official result wording and tallies, exact filtered `total`, and `pagination.nextOffset`; use returned `session` and `number` with `canparl_get_vote`

---

### `canparl_get_vote` <sub>tool</sub>

- Supply `number` and its `session`; optional `party`/`province` filters affect only the ballot page. `limit` 1–400 (default 100), offset pagination
- `tally`, `byParty`, and `ballotsTotal` describe the full division; `ballotsMatched` describes the filtered set. `tallyMatchesBallots` flags discrepancies without rewriting either source count
- Ballots are `Yea`, `Nay`, or `Paired`; nonvoters are absent, and paired records are counted individually

---

### `canparl_search_speeches` <sub>tool</sub>

- Require at least one `politician`, `billDebated`, `mentionedBill`, `dateFrom`, or `dateTo`; bill scopes require explicit `{ session, code }`. Filters combine with AND; optional `contains` is a literal English-text substring and cannot be the sole scope
- `limit` 1–10 (default 5); scans at most 100 raw candidates per call. Continue `nextOffset` with identical filters until `exhausted` before drawing a negative conclusion; even an exhausted search describes OpenParliament's index, not all parliamentary speech
- Complete English `content` and speech-date party/riding are returned when available, otherwise `null`. `substantiveOnly` defaults true; set false to include procedural remarks. Committee records are excluded and counted in `excludedCommittees`

---

### `canparl_list_reference` <sub>tool</sub>

- Required `topic`: `sessions`, `bill_types`, `bill_statuses`, `vote_results`, `vote_document_types`, or `parties`; returns the complete reference set without pagination
- For `sessions`, omit `session`; entries distinguish `basic`/`full` bill coverage and advertised House division coverage. Other topics accept a session and mark whether vocabulary was actually `observed` in its feed

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Canadian Parliament-specific:

- Official bill coverage begins at session `35-1` (1994); full dossiers begin at `37-1` (2001). House division coverage begins at `38-1` (2004). Discover supported sessions with `canparl_list_reference`; OpenParliament's historical name index reaches 1994, with source-dependent activity coverage
- Bills cover both chambers; member, division, and speech tools cover the House. Missing historical fields remain `null`
- A session accepts `"45-1"` or `{ "parliament": 45, "session": 1 }`; omitted sessions resolve from the current official bill feed, except explicit speech bill scopes
- Shared source pacing, short-lived in-memory caches, retries, and one 50-second tool deadline. OpenParliament requests are serialized with a two-second start gap; large member activity requests can take tens of seconds

Agent-friendly output:

- Provenance — `source`, `url`, original `retrievedAt`, and `cached` accompany every successful retrieval
- Explicit coverage — normalized `appliedFilters`, continuation fields, notices, and typed failure reasons distinguish no matches from unavailable or incomplete data
- Lossless client surfaces — Markdown `content[]` and `structuredContent` carry the same values, including source text and nested stage records

## Getting started

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "canada-parliament-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/canada-parliament-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio", "MCP_LOG_LEVEL": "info" }
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
      "env": { "MCP_TRANSPORT_TYPE": "stdio", "MCP_LOG_LEVEL": "info" }
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

For Streamable HTTP, start the built server from a local checkout:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher, or Node.js v24+
- Internet access to Parliament and OpenParliament; no upstream API key required

### Installation

```sh
git clone https://github.com/cyanheads/canada-parliament-mcp-server.git
cd canada-parliament-mcp-server
bun install
cp .env.example .env
bun run rebuild
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `CANPARL_USER_AGENT` | Optional upstream HTTP identification; blank uses the default, CR/LF forbidden | `canada-parliament-mcp-server (casey@caseyjhand.com; https://github.com/cyanheads/canada-parliament-mcp-server)` |
| `MCP_TRANSPORT_TYPE` | `stdio` or `http` | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP port | `3010` |
| `MCP_SESSION_MODE` | `stateless`, `stateful`, or `auto` | `stateless` |
| `MCP_AUTH_MODE` | `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Minimum log level | `info` |
| `LOGS_DIR` | File log directory (Node.js only) | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Framework storage backend | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for common framework overrides.

## Running the server

```sh
bun run rebuild       # Clean and build
bun run start:stdio   # Built server over stdio
bun run start:http    # Built server over Streamable HTTP
```

For a local HTTP container:

```sh
docker build -t canada-parliament-mcp-server .
docker run --rm -p 127.0.0.1:3010:3010 canada-parliament-mcp-server
```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions` | Eight tools and shared Markdown rendering |
| `src/services/legisinfo` | Official bill JSON, session discovery, pacing, and cache |
| `src/services/ourcommons` | Official current roster and division XML |
| `src/services/openparliament` | Historical identities, activity, speeches, and memberships |
| `src/domain` | Shared schemas, normalization, vocabulary, and request budgets |
| `src/config` | Server-specific environment parsing |
| `tests` | Parser, service, tool, and integration tests with synthetic upstream fixtures |

See [`docs/tree.md`](./docs/tree.md) for the full tree.

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) or [`AGENTS.md`](./AGENTS.md) for development rules.

- Register tools in `src/index.ts`; keep source parsing and transport in their owning services
- Validate upstream data and preserve unavailable fields rather than inventing values
- Declare typed errors and render every returned value on both client surfaces
- Test real parsers and handlers through the fake HTTP boundary

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Code is licensed under [Apache 2.0](./LICENSE). Parliamentary data is an unofficial reproduction credited to Parliament and, where used, OpenParliament; Parliament retains copyright. Reuse is governed separately by [Parliament notices](https://www.parl.ca/ImportantNotices-e.html), [Speaker's Permission](https://www.ourcommons.ca/en/important-notices#SpeakersPermission), [Senate terms](https://sencanada.ca/en/intellectual-property/), and [OpenParliament API terms](https://openparliament.ca/api/). This free, noncommercial relay does not imply government endorsement or an open-data licence.
