import { EventEmitter } from 'node:events';
import type { BusEvent } from '../types.js';

/** Typed event bus: app components publish, the WebSocket layer broadcasts. */
export class Bus extends EventEmitter {
  publish(event: BusEvent): void {
    this.emit('event', event);
  }

  subscribe(fn: (event: BusEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
