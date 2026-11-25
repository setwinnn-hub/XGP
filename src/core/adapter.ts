import type { HealthRegistry } from './health.ts';
import type { Logger } from './logger.ts';
import type { RadarEvent } from './types.ts';

/** A data source that pushes normalized events into the pipeline. One per chain/provider. */
export interface Adapter {
  readonly name: string;
  start(): void;
  stop(): void;
}

export type Ingest = (healthName: string, event: RadarEvent) => boolean;

export interface AdapterDeps {
  readonly logger: Logger;
  readonly health: HealthRegistry;
  readonly ingest: Ingest;
}
