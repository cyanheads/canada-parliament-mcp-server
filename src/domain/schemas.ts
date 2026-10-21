/**
 * @fileoverview Shared parliamentary values and input shapes.
 * @module domain/schemas
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Trim an optional input, interpreting a blank form field as absent. */
export const OptionalStringSchema = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim() || undefined : value),
    z.string().optional(),
  )
  .describe('Optional trimmed text; blank means unset.');
/** Session input; services resolve an omitted value from the current official feed. */
export const SessionInputSchema = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim() || undefined : value),
    z
      .union([
        z
          .string()
          .regex(/^\d+-\d+$/)
          .describe('Parliament-session token, such as 45-1.'),
        z
          .object({
            parliament: z.number().int().positive().describe('Positive parliament number.'),
            session: z.number().int().positive().describe('Positive session number.'),
          })
          .strict()
          .describe('Parliament and session numbers.'),
      ])
      .optional(),
  )
  .describe('Parliamentary session; omitted means current.');
/** Accepted session representation before normalization. */
export type SessionInput = z.infer<typeof SessionInputSchema>;
/** Source identifiers are intentionally distinct from display labels. */
export const SourceNameSchema = z
  .enum(['legisinfo', 'ourcommons', 'openparliament'])
  .describe('Public source identifier.');
/** Retrieval provenance, retained unchanged when served from cache. */
export const SourceSchema = z
  .object({
    source: SourceNameSchema,
    url: z
      .string()
      .regex(/^https:\/\//)
      .describe('Absolute HTTPS source request URL.'),
    retrievedAt: z.string().describe('Original ISO retrieval timestamp.'),
    cached: z.boolean().describe('Whether this response came from the in-memory cache.'),
  })
  .strict()
  .describe('Source retrieval metadata.');
/** Source retrieval metadata. */
export type Source = z.infer<typeof SourceSchema>;
/** Bilingual source text, preserving unavailable translations. */
export const BilingualTextSchema = z
  .object({
    en: z.string().nullable().describe('English text, or null when unavailable.'),
    fr: z.string().nullable().describe('French text, or null when unavailable.'),
  })
  .strict();
/** Default list limit. */
export const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe('Maximum returned rows, from 1 to 100.');
/** Stable ordering offset, not a server-side cursor. */
export const OffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .default(0)
  .describe('Zero-based offset in the selected ordering.');
/** Explicit continuation metadata. */
export const PaginationSchema = z
  .object({
    offset: z.number().int().nonnegative().describe('Requested zero-based offset.'),
    limit: z.number().int().positive().describe('Requested maximum rows.'),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Next offset, or null when exhausted.'),
    hasMore: z.boolean().describe('Whether more rows remain.'),
  })
  .strict();
/** Local or upstream-derived pagination. */
export type Pagination = z.infer<typeof PaginationSchema>;
/** JSON values retained losslessly from variable official records. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
/** Variable official JSON object. */
export type JsonRecord = { [key: string]: JsonValue };
/** Recursively serializable JSON values. */
export const JsonValueSchema: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(JsonValueSchema),
      z.record(z.string(), JsonValueSchema),
    ]),
  )
  .describe('Recursively serializable JSON value.');
/** Variable official record, with unknown fields retained. */
export const JsonRecordSchema = z
  .record(z.string(), JsonValueSchema)
  .describe('Official JSON object with all source fields retained.');
