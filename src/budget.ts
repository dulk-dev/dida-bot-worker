import { SOFT_SUBREQUEST_BUDGET } from "./constants.ts";

/**
 * Tracks outbound fetch subrequests (Dida Open API + webhook).
 * KV is a Worker binding and is documented as not counted.
 */
export class SubrequestBudget {
  used = 0;
  stopped: "budget" | null = null;

  constructor(readonly limit = SOFT_SUBREQUEST_BUDGET) {}

  remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  canAfford(n: number): boolean {
    return this.stopped === null && this.used + n <= this.limit;
  }

  /** Record a fetch that is about to happen (or just happened). */
  record(n = 1): void {
    this.used += n;
  }

  markStopped(): void {
    this.stopped = "budget";
  }
}
