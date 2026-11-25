import type { EventBus } from './bus.ts';
import type { HealthRegistry } from './health.ts';
import { errorMessage, type Logger } from './logger.ts';
import type { RadarEvent } from './types.ts';
import { RecentKeys } from './util.ts';
import type { EventRepository } from '../storage/event-repo.ts';

const RECENT_KEY_LIMIT = 100_000;

export interface IngestDeps {
  readonly repo: EventRepository;
  readonly bus: EventBus;
  readonly health: HealthRegistry;
  readonly logger: Logger;
}

/**
 * Single entry point for every adapter: de-duplicate (memory, then DB unique key),
 * persist, then publish. Returns true when the event was new.
 */
export function createIngest(deps: IngestDeps): (healthName: string, event: RadarEvent) => boolean {
  const recent = new RecentKeys(RECENT_KEY_LIMIT);

  return (healthName, event) => {
    if (!recent.addIfNew(event.key)) return false;
    try {
      if (!deps.repo.insert(event)) return false;
    } catch (error: unknown) {
      deps.logger.error('event insert failed', { key: event.key, error: errorMessage(error) });
      return false;
    }
    deps.health.countEvent(healthName);
    deps.bus.publish(event);
    return true;
  };
}
