/**
 * @fileoverview Field-named filter and argument rejection oracles shared by every tool contract test.
 * @module tests/fixtures/filter-rejection
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { Parser } from 'commonmark';
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
    error: { message: string; data: Record<string, unknown> & { recovery: { hint: string } } };
  };
  expect(error.data.field).toBe(expected.field);
  expect(error.message.startsWith(`${expected.field}: `)).toBe(true);
  if (expected.allowed) {
    expect(error.data.allowed).toEqual(expected.allowed);
    expect(error.message).toContain(expected.allowed.map((value) => `"${value}"`).join(', '));
  } else expect(error.data).not.toHaveProperty('allowed');
  if (expected.shape) expect(error.message).toContain(expected.shape);
  const visible = visibleText(result);
  expect(visible).toContain(`Error: ${error.message}\n\nRecovery: `);
  expect(visible).toContain(error.data.recovery.hint);
  if (!expected.rejected) return;
  expect(visible).not.toContain(expected.rejected);
  expect(JSON.stringify(result.structuredContent)).not.toContain(expected.rejected);
}

/** What a schema-level argument rejection must say: each field path with its expectation. */
export interface ArgumentRejection {
  /** `<path>: <expectation>` text the message and the rendered `content[]` both carry. */
  lines: readonly string[];
  /** Caller value that must reach neither surface; empty when no value was sent. */
  rejected: string;
}

/** Assert a `-32602` `invalid_arguments` rejection naming every expected line, never the value. */
export function assertArgumentRejection(result: ToolErrorResult, expected: ArgumentRejection) {
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as {
    error: { code: number; message: string; data: { reason: string } };
  };
  expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  expect(error.data.reason).toBe('invalid_arguments');
  const visible = visibleText(result);
  for (const line of expected.lines) {
    expect(error.message).toContain(line);
    expect(visible).toContain(line);
  }
  if (!expected.rejected) return;
  expect(visible).not.toContain(expected.rejected);
  expect(JSON.stringify(result.structuredContent)).not.toContain(expected.rejected);
}

/** The text a reader sees in `content[]`, Markdown escapes resolved. */
function visibleText(result: ToolErrorResult): string {
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  const walker = new Parser().parse(text).walker();
  let visible = '';
  for (let event = walker.next(); event; event = walker.next()) {
    if (!event.entering) continue;
    if (event.node.type === 'text') visible += event.node.literal;
    else if (event.node.type === 'softbreak' || event.node.type === 'linebreak') visible += '\n';
    else if (event.node.type === 'paragraph' && visible) visible += '\n\n';
  }
  return visible;
}
