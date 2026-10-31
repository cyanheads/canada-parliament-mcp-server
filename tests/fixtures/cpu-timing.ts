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
 * Asserts `run` over `build(size)` for every size stays under 250,000 CPU microseconds per call and
 * that per-call CPU at the largest size is under 256 times the smallest, with equal total work at
 * each size.
 */
export function expectLinearCpu(
  run: (input: string) => void,
  build: (size: number) => string,
  sizes: readonly number[],
): void {
  const largest = sizes.at(-1) as number;
  const call = (input: string) => () => run(input);
  cpu(call(build(sizes[0] as number)), 20);
  const perCall: number[] = [];
  for (const size of sizes) {
    const input = build(size);
    expect(cpu(call(input), 1), `${size} characters`).toBeLessThan(250_000);
    perCall.push(cpu(call(input), Math.max(1, largest / size)));
  }
  expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
}
