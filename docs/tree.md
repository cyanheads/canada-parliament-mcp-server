# canada-parliament-mcp-server - Directory Structure

Generated on: 2026-10-21 08:38:53

```text
canada-parliament-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── domain/
│   │   ├── html-to-text.ts
│   │   ├── normalization.ts
│   │   ├── reference-catalog.ts
│   │   ├── request-context.ts
│   │   └── schemas.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _format.ts
│   │           ├── _member-identity.ts
│   │           ├── get-bill.tool.ts
│   │           ├── get-member.tool.ts
│   │           ├── get-vote.tool.ts
│   │           ├── list-reference.tool.ts
│   │           ├── search-bills.tool.ts
│   │           ├── search-members.tool.ts
│   │           ├── search-speeches.tool.ts
│   │           └── search-votes.tool.ts
│   ├── services/
│   │   ├── legisinfo/
│   │   │   ├── index.ts
│   │   │   ├── legisinfo-service.ts
│   │   │   ├── parsing.ts
│   │   │   └── types.ts
│   │   ├── openparliament/
│   │   │   ├── index.ts
│   │   │   ├── openparliament-service.ts
│   │   │   ├── parsing.ts
│   │   │   └── types.ts
│   │   └── ourcommons/
│   │       ├── index.ts
│   │       ├── ourcommons-service.ts
│   │       ├── parsing.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── domain/
│   │   ├── html-to-text.test.ts
│   │   ├── normalization.test.ts
│   │   ├── request-context.test.ts
│   │   └── schemas.test.ts
│   ├── fixtures/
│   │   ├── bill-tools/
│   │   │   ├── dossiers/
│   │   │   │   ├── 35-1-c-1.json
│   │   │   │   ├── 41-1-c-38.json
│   │   │   │   ├── 42-1-c-86.json
│   │   │   │   ├── 44-1-c-69.json
│   │   │   │   └── 45-1-c-15.json
│   │   │   └── harness.ts
│   │   ├── integration/
│   │   │   └── upstream-preload.ts
│   │   ├── member-tools/
│   │   │   ├── member-votes/
│   │   │   │   ├── 2897-44-1.xml
│   │   │   │   ├── 2897-45-1.xml
│   │   │   │   ├── 35933-latest.xml
│   │   │   │   ├── 88721-45-1.xml
│   │   │   │   └── empty.xml
│   │   │   ├── harness.ts
│   │   │   └── lawrence-cannon.json
│   │   ├── speech-tools/
│   │   │   └── harness.ts
│   │   ├── vote-tools/
│   │   │   └── harness.ts
│   │   ├── filter-rejection.ts
│   │   └── markdown-decode.ts
│   ├── fuzz/
│   ├── integration/
│   │   └── parliament-server.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── legisinfo/
│   │   │   ├── legisinfo-service.test.ts
│   │   │   └── parsing.test.ts
│   │   ├── openparliament/
│   │   │   ├── openparliament-service.test.ts
│   │   │   └── parsing.test.ts
│   │   └── ourcommons/
│   │       ├── ourcommons-service.test.ts
│   │       └── parsing.test.ts
│   ├── smoke/
│   └── tools/
│       ├── format.test.ts
│       ├── get-bill.test.ts
│       ├── get-member.test.ts
│       ├── get-vote.test.ts
│       ├── list-reference.test.ts
│       ├── member-identity.test.ts
│       ├── search-bills.test.ts
│       ├── search-members.test.ts
│       ├── search-speeches.test.ts
│       └── search-votes.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
