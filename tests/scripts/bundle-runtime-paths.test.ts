/**
 * @fileoverview Bundle pruning preserves SDK skill runtime modules while removing package-root agent docs.
 * @module tests/scripts/bundle-runtime-paths
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as cleanerEntry,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as checkerEntry } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation pruning', () => {
  it('keeps SDK skill runtime modules in direct and nested dependencies', () => {
    const entries = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.ts',
      'node_modules/consumer/node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.js',
      'node_modules/runtime/dist/skills/handler.js',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
    for (const entry of entries) expect(checkerEntry.test(entry)).toBe(false);
  });

  it('strips package-root documentation at either dependency depth', () => {
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/query/SKILL.md',
      'node_modules/example/.claude/skills/query/SKILL.md',
      'node_modules/example/.agents/skills/query/SKILL.md',
      'node_modules/example/SKILL.md',
      'node_modules/consumer/node_modules/@example/server/skills/query/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(entries);
    for (const entry of entries) expect(checkerEntry.test(entry)).toBe(true);
    expect(cleanerEntry.source).toBe(checkerEntry.source);
  });
});
