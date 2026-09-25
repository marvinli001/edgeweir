import { EventEmitter } from "node:events";
import pg from "pg";
import type { Logger } from "./logger";

export const CONFIG_CHANNEL = "edgeweir_config";
export const TASKS_CHANNEL = "edgeweir_tasks";

export interface ConfigPublishedEvent {
  clusterId: string;
  revision: number;
  contentHash: string;
}

/** New node tasks exist for nodes of these clusters. */
export interface TasksCreatedEvent {
  clusterIds: string[];
}

/**
 * Fan-out of configuration changes and new node tasks across console
 * instances using PostgreSQL LISTEN/NOTIFY. Each instance keeps one dedicated connection and
 * re-emits notifications locally; it reconnects with backoff on failure.
 */
export class ConfigEventBus {
  private readonly emitter = new EventEmitter();
  private client: pg.Client | undefined;
  private stopped = false;
  private retryMs = 500;

  constructor(
    private readonly connectionString: string,
    private readonly log: Logger,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.connectionString,
      application_name: "edgeweir-listen",
    });
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      const event =
        msg.channel === CONFIG_CHANNEL ? "config" : msg.channel === TASKS_CHANNEL ? "tasks" : null;
      if (!event) return;
      try {
        this.emitter.emit(event, JSON.parse(msg.payload));
      } catch (error) {
        this.log.warn("ignoring malformed notification", { error });
      }
    });
    client.on("error", (error) => {
      this.log.warn("listen connection error", { error });
      void this.reconnect(client);
    });
    client.on("end", () => void this.reconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${CONFIG_CHANNEL}`);
      await client.query(`LISTEN ${TASKS_CHANNEL}`);
      this.client = client;
      this.retryMs = 500;
      // Consumers re-read the latest revision after a reconnect, since
      // notifications sent while disconnected are lost.
      this.emitter.emit("reconnected");
    } catch (error) {
      this.log.warn("listen connect failed", { error });
      void this.reconnect(client);
    }
  }

  private async reconnect(old: pg.Client): Promise<void> {
    if (this.stopped || (this.client && this.client !== old)) return;
    this.client = undefined;
    old.removeAllListeners();
    old.end().catch(() => {});
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
    setTimeout(() => void this.connect(), delay).unref();
  }

  on(event: "config", listener: (e: ConfigPublishedEvent) => void): () => void;
  on(event: "tasks", listener: (e: TasksCreatedEvent) => void): () => void;
  on(event: "reconnected", listener: () => void): () => void;
  on(event: string, listener: (...args: never[]) => void): () => void {
    const fn = listener as (...args: unknown[]) => void;
    this.emitter.on(event, fn);
    return () => this.emitter.off(event, fn);
  }

  /** Emits locally, for callers in the same process that must not wait for NOTIFY. */
  emitLocal(event: ConfigPublishedEvent) {
    this.emitter.emit("config", event);
  }

  /** Local counterpart of a TASKS_CHANNEL notification. */
  emitTasksLocal(event: TasksCreatedEvent) {
    this.emitter.emit("tasks", event);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => {});
  }
}
