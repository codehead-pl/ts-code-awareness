// Build-timing instrumentation.
//
// A tiny monotonic timer (`performance.now()`, immune to wall-clock jumps)
// wrapped around the four expensive build operations — buildSkeleton,
// hydratePackage, each adapter's build(), and indexPackage. Timings are
// collected here and persisted to the store's `build_metrics` table by the
// caller (build.ts / semantic.ts), then surfaced in overview().

/** Monotonic clock reading, in fractional milliseconds. */
export function nowMs(): number {
  return performance.now();
}

export interface Timing {
  /** Operation label, e.g. "buildSkeleton", "adapter:nest", "indexPackage". */
  op: string;
  /** Package the op ran over ("." for whole-project ops). */
  package: string;
  /** Duration in milliseconds (monotonic). */
  ms: number;
}

/** Accumulates monotonic durations for a build so they can be flushed at once. */
export class Timer {
  private marks: Timing[] = [];

  /** Run `fn`, record how long it took under `op`/`pkg`, and return its result. */
  time<T>(op: string, pkg: string, fn: () => T): T {
    const t0 = nowMs();
    try {
      return fn();
    } finally {
      this.marks.push({ op, package: pkg, ms: round(nowMs() - t0) });
    }
  }

  /** Record a pre-measured duration (when timing can't wrap a single call). */
  add(op: string, pkg: string, ms: number): void {
    this.marks.push({ op, package: pkg, ms: round(ms) });
  }

  timings(): Timing[] {
    return this.marks;
  }

  total(): number {
    return round(this.marks.reduce((a, m) => a + m.ms, 0));
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
