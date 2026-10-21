/**
 * @fileoverview Field-named filter rejection oracle shared by every tool contract test.
 * @module tests/fixtures/filter-rejection
 */
import { expect } from 'vitest';

interface ToolErrorResult {
  content: readonly { type: string; text?: string }[];
  isError?: boolean | undefined;
  structuredContent?: unknown;
}

/** What a rejected filter must say: its field and accepted values or expected shape, never the value. */
export interface FilterRejection {
  /** Exact accepted values, in message order; omitted for shape-only fields. */
  allowed?: readonly string[];
  /** Field path the rejection names. */
  field: string;
  /** Caller value that must reach neither surface. */
  rejected: string;
  /** Shape wording the message states for codes, slugs, dates, and sessions. */
  shape?: string;
}

/** Assert the message, `data.field`/`data.allowed`, rendered recovery, and value non-echo. */
export function assertFilterRejection(result: ToolErrorResult, expected: FilterRejection) {
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as {
    error: { message: string; data: Record<string, unknown> };
  };
  expect(error.data.field).toBe(expected.field);
  expect(error.message.startsWith(`${expected.field}: `)).toBe(true);
  if (expected.allowed) {
    expect(error.data.allowed).toEqual(expected.allowed);
    expect(error.message).toContain(expected.allowed.map((value) => `"${value}"`).join(', '));
  } else expect(error.data).not.toHaveProperty('allowed');
  if (expected.shape) expect(error.message).toContain(expected.shape);
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  expect(text).toContain(`Error: ${error.message}\n\nRecovery: `);
  if (!expected.rejected) return;
  expect(text).not.toContain(expected.rejected);
  expect(JSON.stringify(result.structuredContent)).not.toContain(expected.rejected);
}
