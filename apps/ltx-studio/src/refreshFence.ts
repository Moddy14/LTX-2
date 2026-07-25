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
