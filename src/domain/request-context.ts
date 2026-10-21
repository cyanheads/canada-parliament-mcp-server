/**
 * @fileoverview Disposable tool-wide deadline and upstream-work budget.
 * @module domain/request-context
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { requestCancelled, timeout } from '@cyanheads/mcp-ts-core/errors';

/** Final service argument; all operations share this budget instead of restarting it. */
export interface RequestContext {
  readonly callerSignal: AbortSignal;
  readonly context: Context;
  readonly deadlineAt: number;
  readonly outerSignal: AbortSignal;
  remainingMs(): number;
  readonly signal: AbortSignal;
  throwIfAborted(): void;
  throwIfOuterAborted(): void;
}
/** Tool-owned disposable context. Dispose in a handler's finally block. */
export interface CallBudget extends RequestContext {
  dispose(): void;
}
/** Start one 50s call clock with a 45s upstream subdeadline. */
export function createRequestContext(context: Context): CallBudget {
  const deadlineAt = Date.now() + 45_000;
  const outer = new AbortController();
  const upstream = new AbortController();
  const abortCaller = () =>
    outer.abort(requestCancelled('Caller cancelled the parliamentary request.'));
  const abortOuter = () => upstream.abort(outer.signal.reason);
  context.signal.addEventListener('abort', abortCaller, { once: true });
  outer.signal.addEventListener('abort', abortOuter, { once: true });
  if (context.signal.aborted) abortCaller();
  const outerTimer = setTimeout(
    () => outer.abort(timeout('Parliamentary call exceeded its 50 second deadline.')),
    50_000,
  );
  const upstreamTimer = setTimeout(
    () => upstream.abort(timeout('Upstream work exceeded its 45 second budget.')),
    45_000,
  );
  outerTimer.unref();
  upstreamTimer.unref();
  return {
    context,
    callerSignal: context.signal,
    outerSignal: outer.signal,
    signal: upstream.signal,
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    throwIfOuterAborted: () => {
      outer.signal.throwIfAborted();
    },
    throwIfAborted: () => {
      outer.signal.throwIfAborted();
      upstream.signal.throwIfAborted();
    },
    dispose() {
      clearTimeout(outerTimer);
      clearTimeout(upstreamTimer);
      context.signal.removeEventListener('abort', abortCaller);
      outer.signal.removeEventListener('abort', abortOuter);
    },
  };
}
