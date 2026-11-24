/** @fileoverview The shared linear-time assertion stays decidable at the timer's resolution. @module tests/fixtures/cpu-timing.test */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectLinearCpu } from './cpu-timing.js';

describe('expectLinearCpu', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('passes a constant-time run whose batches read 0 µs', () => {
    vi.spyOn(process, 'threadCpuUsage').mockReturnValue({ user: 0, system: 0 });
    expect(() =>
      expectLinearCpu(
        () => {},
        (size) => size,
        [1, 2, 4, 8, 16, 32, 64],
      ),
    ).not.toThrow();
  });
});
