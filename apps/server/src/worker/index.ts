import { setTimeout as delay } from "node:timers/promises";
import { Store, HttpError, type Lease } from "../db/store.js";
import { probe } from "../engine/probe.js";

export class Runner {
  private readonly stopSignal = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private reserved = 0;
  private loop?: Promise<void>;
  constructor(
    private store: Store,
    private origin: string,
    private report: (err: unknown) => void,
    private limit = 4,
  ) {}
  private get capacity() {
    return this.limit - this.active.size - this.reserved;
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    return work.finally(() => this.active.delete(work));
  }
  private async execute(lease: Lease) {
    const monitor = await this.store.get(lease.monitor_id);
    const result = await probe(monitor, this.origin, this.stopSignal.signal);
    this.stopSignal.signal.throwIfAborted();
    return this.store.finish(lease, result);
  }
  manual(id: string) {
    if (this.stopSignal.signal.aborted || this.capacity <= 0)
      throw new HttpError(429, "Probe capacity exhausted");
    return this.track(
      this.store.manual(id).then((lease) => this.execute(lease)),
    );
  }
  start() {
    this.loop ??= this.poll();
  }
  private async poll() {
    const signal = this.stopSignal.signal;
    while (!signal.aborted) {
      this.reserved = this.capacity;
      try {
        if (this.reserved > 0) {
          const leases = await this.store.claim(this.reserved);
          for (const lease of leases) {
            void this.track(this.execute(lease)).catch((err) => {
              if (!signal.aborted) this.report(err);
            });
          }
        }
      } catch (err) {
        if (!signal.aborted) this.report(err);
      } finally {
        this.reserved = 0;
      }
      await delay(250, undefined, { signal }).catch(() => {});
    }
  }
  async stop() {
    this.stopSignal.abort();
    await this.loop;
    await Promise.allSettled(this.active);
  }
}
