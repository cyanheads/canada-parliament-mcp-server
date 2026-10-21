/**
 * @fileoverview Public upstream identification configuration boundary tests.
 * @module tests/config/server-config.test
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_AGENT, ServerConfigSchema } from '@/config/server-config.js';

describe('server configuration', () => {
  it.each([undefined, '', '  \t '])('defaults absent or blank User-Agent %j', (userAgent) => {
    expect(ServerConfigSchema.parse({ userAgent })).toEqual({ userAgent: DEFAULT_USER_AGENT });
    expect(DEFAULT_USER_AGENT).toBe(
      'canada-parliament-mcp-server (casey@caseyjhand.com; https://github.com/cyanheads/canada-parliament-mcp-server)',
    );
  });
  it('preserves an explicitly provided identification string', () => {
    expect(
      ServerConfigSchema.parse({ userAgent: 'SyntheticResearch/1.0 (https://example.test)' })
        .userAgent,
    ).toBe('SyntheticResearch/1.0 (https://example.test)');
  });
  it.each(['\r', '\n', '\r\n', 'agent\rX-Header: injected', 'agent\nX-Header: injected'])(
    'rejects CR/LF header injection %j',
    (userAgent) => {
      expect(ServerConfigSchema.safeParse({ userAgent }).success).toBe(false);
    },
  );
});
