import { EventEmitter } from "node:events";
import type { Job } from "@studio/shared";

export interface EventMap {
  job: [Job];
  project: [{ projectId: string }];
}

/** In-process pub/sub that feeds the Server-Sent Events stream. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    this.emitter.emit(event, ...args);
  }

  /** Returns an unsubscribe function. */
  on<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): () => void {
    this.emitter.on(event, listener as (...a: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...a: unknown[]) => void);
  }
}
