import { errorMessage, type Logger } from './logger.ts';
import { backoffDelay } from './util.ts';

export interface ReconnectingSocketOptions {
  readonly url: string;
  readonly logger: Logger;
  /** Called on every (re)connect; send subscriptions here. */
  readonly onOpen: (send: (payload: string) => void) => void;
  readonly onMessage: (data: string) => void;
  readonly onReconnect?: () => void;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** WebSocket client that reconnects forever with jittered exponential backoff. */
export class ReconnectingSocket {
  private readonly options: ReconnectingSocketOptions;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ReconnectingSocketOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.discard();
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Sends on the open connection; returns false when not connected (caller resends on next open). */
  send(payload: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(payload);
    return true;
  }

  /**
   * Drops the current connection and reconnects without waiting for a close handshake,
   * which never completes on a half-open TCP connection.
   */
  forceReconnect(reason: string): void {
    this.options.logger.warn('forcing reconnect', { reason });
    this.discard();
    this.scheduleReconnect('forced');
  }

  private discard(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch (error: unknown) {
      this.options.logger.debug('socket close failed', { error: errorMessage(error) });
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.timer) return;
    const delay = backoffDelay(this.attempt, this.options.baseDelayMs ?? 1_000, this.options.maxDelayMs ?? 30_000);
    this.attempt += 1;
    this.options.logger.warn('reconnecting', { reason, delayMs: delay });
    this.options.onReconnect?.();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private connect(): void {
    if (this.stopped) return;
    const { logger, url } = this.options;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      logger.info('socket open', { attempt: this.attempt });
      this.options.onOpen((payload) => socket.send(payload));
    };
    socket.onmessage = (message: MessageEvent) => {
      if (typeof message.data !== 'string') return;
      this.attempt = 0;
      try {
        this.options.onMessage(message.data);
      } catch (error: unknown) {
        logger.error('message handler failed', { error: errorMessage(error) });
      }
    };
    socket.onerror = (event: Event) => {
      logger.warn('socket error', { error: (event as ErrorEvent).message ?? event.type });
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect(`closed ${event.code} ${event.reason}`.trim());
    };
  }
}
