import { errorMessage, type Logger } from './logger.ts';
import type { RadarEvent } from './types.ts';

export type EventHandler = (event: RadarEvent) => Promise<void> | void;

/**
 * In-process event bus. Handlers run concurrently and a failing handler never blocks
 * the others. Can be swapped for Redis Streams when the system moves to multiple processes.
 */
export interface EventBus {
  subscribe(name: string, handler: EventHandler): void;
  publish(event: RadarEvent): void;
}

export function createEventBus(logger: Logger): EventBus {
  const handlers: Array<{ readonly name: string; readonly handler: EventHandler }> = [];

  return {
    subscribe(name, handler) {
      handlers.push({ name, handler });
    },
    publish(event) {
      for (const { name, handler } of handlers) {
        Promise.resolve()
          .then(() => handler(event))
          .catch((error: unknown) => logger.error('event handler failed', { handler: name, key: event.key, error: errorMessage(error) }));
      }
    },
  };
}
