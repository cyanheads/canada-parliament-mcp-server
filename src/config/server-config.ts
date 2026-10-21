/**
 * @fileoverview Server-specific public upstream configuration.
 * @module config/server-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Default identification sent to public parliamentary sources. */
export const DEFAULT_USER_AGENT =
  'canada-parliament-mcp-server (casey@caseyjhand.com; https://github.com/cyanheads/canada-parliament-mcp-server)';
/** Configuration schema; whitespace-only user agents use the default. */
export const ServerConfigSchema = z.object({
  userAgent: z
    .preprocess(
      (value) =>
        typeof value === 'string' && !/[\r\n]/.test(value) && !value.trim() ? undefined : value,
      z
        .string()
        .regex(/^[^\r\n]+$/)
        .default(DEFAULT_USER_AGENT),
    )
    .describe('HTTP User-Agent identifying this server; CR and LF are forbidden.'),
});
/** Parsed server-specific configuration. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
let config: ServerConfig | undefined;
/** Initialize lazily; call from application setup before accepting requests. */
export function getServerConfig(): ServerConfig {
  config ??= parseEnvConfig(ServerConfigSchema, { userAgent: 'CANPARL_USER_AGENT' });
  return config;
}
