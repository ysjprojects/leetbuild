/**
 * Hand-written Python module the r/place starters import but no step builds: the per-instance
 * fan-out bus the tile stream (step 4) subscribes to. In production every stream server consumes
 * `placements` in its own consumer group and feeds the bus with `pump`; the harness publishes
 * directly.
 */
export const supportModules: Record<string, string> = {
  'tile_bus.py': `"""
Provided: the fan-out bus of one tile-stream instance. Every open StreamTiles call owns one
asyncio.Queue; \`publish\` hands a placement to all of them. Each stream server runs \`pump\` on a
consumer of \`placements\` in its own group, so every instance sees every tile.
"""
import asyncio
import json

_queues: list[asyncio.Queue] = []


def subscribe() -> asyncio.Queue:
    """A fresh queue that receives every placement published on this instance from now on."""
    queue: asyncio.Queue = asyncio.Queue()
    _queues.append(queue)
    return queue


def unsubscribe(queue: asyncio.Queue) -> None:
    if queue in _queues:
        _queues.remove(queue)


def publish(tile: dict) -> None:
    """Hand \`{"user", "x", "y", "color", "ts"}\` to every open stream on this instance."""
    for queue in list(_queues):
        queue.put_nowait(tile)


def subscribers() -> int:
    """How many streams are open on this instance."""
    return len(_queues)


def pump(consumer) -> None:
    """Feed every record of \`placements\` to publish; one consumer group per stream server."""
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        try:
            publish(json.loads(msg.value()))
        except ValueError:
            continue
`,
};

/** The same bus for the TypeScript starters: `import {subscribe, unsubscribe} from 'tile_bus'`. */
export const supportModulesTs: Record<string, string> = {
  'tile_bus.ts': `/**
 * Provided: the fan-out bus of one tile-stream instance. Every open StreamTiles call owns one
 * TileQueue; \`publish\` hands a placement to all of them. Each stream server runs \`pump\` on a
 * consumer of \`placements\` in its own group, so every instance sees every tile.
 */
import type {Consumer} from 'kafkajs';

/** One placement, shaped like the \`placements\` event. */
export interface Tile {
  user: string;
  x: number;
  y: number;
  color: number;
  ts: number;
}

/** An unbounded FIFO with an awaitable \`get\`: what one open stream reads from. */
export class TileQueue {
  private readonly items: Tile[] = [];
  private readonly waiters: ((tile: Tile) => void)[] = [];

  put(tile: Tile): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(tile);
    else this.items.push(tile);
  }

  /** The next tile, as soon as there is one. */
  get(): Promise<Tile> {
    const tile = this.items.shift();
    if (tile !== undefined) return Promise.resolve(tile);
    const {promise, resolve} = Promise.withResolvers<Tile>();
    this.waiters.push(resolve);
    return promise;
  }

  /** Tiles published for this stream and not yet taken by \`get\`: the client's backlog. */
  get size(): number {
    return this.items.length;
  }
}

const queues: TileQueue[] = [];

/** A fresh queue that receives every placement published on this instance from now on. */
export function subscribe(): TileQueue {
  const queue = new TileQueue();
  queues.push(queue);
  return queue;
}

export function unsubscribe(queue: TileQueue): void {
  const i = queues.indexOf(queue);
  if (i >= 0) queues.splice(i, 1);
}

/** Hand \`{user, x, y, color, ts}\` to every open stream on this instance. */
export function publish(tile: Tile): void {
  for (const queue of [...queues]) queue.put(tile);
}

/** How many streams are open on this instance. */
export function subscribers(): number {
  return queues.length;
}

/** Feed every record of \`placements\` to publish; one consumer group per stream server. */
export async function pump(consumer: Consumer): Promise<void> {
  await consumer.run({
    eachMessage: async ({message}) => {
      if (message.value === null) return;
      try {
        publish(JSON.parse(message.value.toString()) as Tile);
      } catch {
        return; // malformed: not a tile
      }
    },
  });
}
`,
};
