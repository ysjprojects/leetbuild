/**
 * How the C++ runtime's resources plug into a running program (src/lib/runtime/cpp.ts): each is a
 * bridge — Redis (./redis.ts), Postgres (./db.ts), the Kafka broker (./kafka.ts) — answering the
 * requests its C++ model makes through lb::call (synchronous) and lb::call_async (the calling
 * thread waits), and calling back into the program through the world it is given.
 */

/** What a bridge gets from the program instance it serves. */
export interface BridgeWorld {
  /** Run `handle`'s lb::receiver with `payload` (JSON text) on a thread of its own: a delivered message. */
  deliver(handle: number, payload: string): void;
  /** Run `handle`'s lb::invocable now, on the thread making the call: a probe firing inside a command. */
  invoke(handle: number): void;
  /** Asynchronous work a thread waits on (a statement): the world does not settle while any is in flight. */
  tracked<T>(work: Promise<T>): Promise<T>;
  /** Whether the program still runs: callbacks into a program that is over do nothing. */
  live(): boolean;
}

/** One resource's requests, by op name: each handler takes the JSON request and returns the JSON reply. */
export interface Bridge {
  calls?: Record<string, (request: never) => unknown>;
  asyncCalls?: Record<string, (request: never) => Promise<unknown>>;
  /** The program is over: release what it holds (a database connection, a transaction). */
  stop?: () => Promise<void>;
}
