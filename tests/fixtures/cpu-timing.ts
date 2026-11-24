/**
 * @fileoverview Thread-CPU measurement shared by the linear-time suites. Their cases run
 * synchronously, so a wall-clock timeout cannot stop one early; it only fails a loaded host after
 * the CPU assertions passed. Suites using these helpers set `{ timeout: 0 }`.
 * @module tests/fixtures/cpu-timing
 */
import { expect } from 'vitest';

/** Thread CPU microseconds per call, best of `trials`, running `reps` calls per trial. */
export function cpu(run: () => void, reps: number, trials = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < trials; trial++) {
    const start = process.threadCpuUsage();
    for (let i = 0; i < reps; i++) run();
    const used = process.threadCpuUsage(start);
    best = Math.min(best, (used.user + used.system) / reps);
  }
  return best;
}

/**
 * Asserts `run` stays linear over `build(size)` for doubling `sizes` spanning at least 64×. Each size
 * runs under 250,000 CPU microseconds per call (least of three) before the next is built, so a
 * super-linear regression fails at the first size it crosses instead of at the largest. Then the
 * span's growth, one call at the largest size over the per-call CPU of a batch of smallest-size calls
 * of equal total length timed just before it, stays under 256, the least over three such pairs.
 * Timing the baseline beside the large call keeps both on one core: a baseline timed once can sit on
 * a performance core while a later size runs on an efficiency core, several times slower.
 */
export function expectLinearCpu<T>(
  run: (input: T) => void,
  build: (size: number) => T,
  sizes: readonly number[],
): void {
  const smallest = sizes[0] as number;
  const largest = sizes.at(-1) as number;
  expect(largest / smallest, 'size span').toBeGreaterThanOrEqual(64);
  const base = build(smallest);
  cpu(() => run(base), 20);
  let input = base;
  for (const size of sizes) {
    input = build(size);
    expect(
      cpu(() => run(input), 1),
      `size ${size}`,
    ).toBeLessThan(250_000);
  }
  const reps = largest / smallest;
  let growth = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < 3; trial++) {
    // A batch under the timer's 1 µs resolution reads 0; floor it there so 0/0 never yields NaN.
    const small = Math.max(
      cpu(() => run(base), reps, 1),
      1 / reps,
    );
    growth = Math.min(growth, cpu(() => run(input), 1, 1) / small);
  }
  expect(growth, `growth from size ${smallest} to ${largest}`).toBeLessThan(256);
}
