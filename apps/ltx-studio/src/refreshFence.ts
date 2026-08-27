export class RefreshFence {
  private revision = 0;
  private mutationsInFlight = 0;

  snapshot(): number {
    return this.revision;
  }

  accepts(snapshot: number): boolean {
    return this.mutationsInFlight === 0 && snapshot === this.revision;
  }

  beginMutation(): () => void {
    this.mutationsInFlight += 1;
    this.revision += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.mutationsInFlight -= 1;
      this.revision += 1;
    };
  }
}

export type LatestRefreshTicket = Readonly<{
  request: number;
  revision: number;
}>;

/**
 * Accepts only the newest refresh that was issued outside an intervening
 * mutation. This is intentionally stricter than RefreshFence: server list
 * responses contain authoritative nulls, so an older response must never be
 * allowed to restore or revoke state after a newer response or mutation.
 */
export class LatestRefreshFence {
  private latestRequest = 0;
  private revision = 0;
  private mutationsInFlight = 0;

  issue(): LatestRefreshTicket {
    this.latestRequest += 1;
    return { request: this.latestRequest, revision: this.revision };
  }

  accepts(ticket: LatestRefreshTicket): boolean {
    return this.mutationsInFlight === 0
      && ticket.request === this.latestRequest
      && ticket.revision === this.revision;
  }

  beginMutation(): () => void {
    this.mutationsInFlight += 1;
    this.revision += 1;
    this.latestRequest += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.mutationsInFlight -= 1;
      this.revision += 1;
      this.latestRequest += 1;
    };
  }
}
