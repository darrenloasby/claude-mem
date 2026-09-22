/**
 * Serializes work onto a single lane, regardless of how many HTTP requests
 * arrive concurrently. claude-mem can run several observer sessions in
 * parallel; this is what turns that into "one job at a time" against the
 * local LM Studio backend.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Swallow rejection here so one failed job doesn't wedge the queue for
    // everything queued behind it; the real error still propagates to the
    // caller via the returned promise.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
