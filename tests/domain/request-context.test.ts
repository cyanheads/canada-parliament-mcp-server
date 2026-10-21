/**
 * @fileoverview Shared upstream and outer call deadlines with cancellation cleanup.
 * @module tests/domain/request-context.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequestContext } from '@/domain/request-context.js';

describe('request budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('shares one decreasing 45s upstream budget and reserves 5s before the outer deadline', () => {
    const budget = createRequestContext(createMockContext());
    try {
      expect(budget.deadlineAt).toBe(Date.now() + 45_000);
      expect(budget.remainingMs()).toBe(45_000);
      vi.advanceTimersByTime(44_999);
      expect(budget.remainingMs()).toBe(1);
      expect(() => budget.throwIfAborted()).not.toThrow();
      vi.advanceTimersByTime(1);
      expect(budget.remainingMs()).toBe(0);
      expect(budget.signal.aborted).toBe(true);
      expect(budget.outerSignal.aborted).toBe(false);
      expect(() => budget.throwIfAborted()).toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.Timeout }),
      );
      expect(() => budget.throwIfOuterAborted()).not.toThrow();
      vi.advanceTimersByTime(4_999);
      expect(budget.outerSignal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(() => budget.throwIfOuterAborted()).toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.Timeout }),
      );
    } finally {
      budget.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, 44_000, 46_000])('caller cancellation wins at elapsed %i ms', (elapsed) => {
    const caller = new AbortController();
    const budget = createRequestContext(createMockContext({ signal: caller.signal }));
    try {
      vi.advanceTimersByTime(elapsed);
      caller.abort(new Error('synthetic abort'));
      expect(budget.callerSignal).toBe(caller.signal);
      expect(budget.outerSignal.aborted).toBe(true);
      expect(() => budget.throwIfAborted()).toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.RequestCancelled }),
      );
      expect(() => budget.throwIfOuterAborted()).toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.RequestCancelled }),
      );
    } finally {
      budget.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('honors an already cancelled caller', () => {
    const caller = new AbortController();
    caller.abort();
    const budget = createRequestContext(createMockContext({ signal: caller.signal }));
    expect(() => budget.throwIfAborted()).toThrow(
      expect.objectContaining({ code: JsonRpcErrorCode.RequestCancelled }),
    );
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('disposes timers and listeners without affecting the caller', () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const budget = createRequestContext(createMockContext({ signal: caller.signal }));
    expect(vi.getTimerCount()).toBe(2);
    budget.dispose();
    budget.dispose();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(caller.signal.aborted).toBe(false);
    caller.abort();
    vi.advanceTimersByTime(60_000);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.outerSignal.aborted).toBe(false);
  });
});
