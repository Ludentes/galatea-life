/**
 * The applier's time: now, timers and their clearing, in milliseconds. The system clock in
 * production, the harness's clock under a test run (both from the entry point), a fake in unit tests.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  setInterval(fn: () => void, ms: number): number;
  clear(handle: number): void;
  close(): void;
}
