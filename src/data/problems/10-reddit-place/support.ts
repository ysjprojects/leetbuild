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

/** The same bus for the C++ starters: `#include "tile_bus.h"`. */
export const supportModulesCpp: Record<string, string> = {
  'tile_bus.h': `// Provided: the fan-out bus of one tile-stream instance. Every open StreamTiles call owns one
// TileQueue; \`publish\` hands a placement to all of them. Each stream server runs \`pump\` on a
// consumer of \`placements\` in its own group, so every instance sees every tile.
#pragma once

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "place.pb.h"

// An unbounded FIFO with a blocking \`pop\`: what one open stream reads from.
class TileQueue {
 public:
  void push(const place::Tile& tile) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      items_.push_back(tile);
    }
    ready_.notify_one();
  }

  // The next tile into \`out\`, waiting up to \`timeout\` for one; false if none came.
  template <class Rep, class Period>
  bool pop(place::Tile& out, std::chrono::duration<Rep, Period> timeout) {
    std::unique_lock<std::mutex> lock(mu_);
    if (!ready_.wait_for(lock, timeout, [this] { return !items_.empty(); })) return false;
    out = std::move(items_.front());
    items_.pop_front();
    return true;
  }

  // Tiles published for this stream and not yet popped: the client's backlog.
  std::size_t size() const {
    std::lock_guard<std::mutex> lock(mu_);
    return items_.size();
  }

 private:
  mutable std::mutex mu_;
  std::condition_variable ready_;
  std::deque<place::Tile> items_;
};

using Subscription = std::shared_ptr<TileQueue>;

namespace tile_bus_detail {
inline std::mutex mu;
inline std::vector<Subscription> queues;
}  // namespace tile_bus_detail

// A fresh queue that receives every placement published on this instance from now on.
inline Subscription subscribe() {
  auto queue = std::make_shared<TileQueue>();
  std::lock_guard<std::mutex> lock(tile_bus_detail::mu);
  tile_bus_detail::queues.push_back(queue);
  return queue;
}

inline void unsubscribe(const Subscription& queue) {
  std::lock_guard<std::mutex> lock(tile_bus_detail::mu);
  auto& queues = tile_bus_detail::queues;
  queues.erase(std::remove(queues.begin(), queues.end(), queue), queues.end());
}

// Hand a placement to every open stream on this instance.
inline void publish(const place::Tile& tile) {
  std::lock_guard<std::mutex> lock(tile_bus_detail::mu);
  for (const auto& queue : tile_bus_detail::queues) queue->push(tile);
}

// How many streams are open on this instance.
inline std::size_t subscribers() {
  std::lock_guard<std::mutex> lock(tile_bus_detail::mu);
  return tile_bus_detail::queues.size();
}

// Feed every record of \`placements\` ({"user", "x", "y", "color", "ts"}) to publish; one consumer
// group per stream server.
inline void pump(RdKafka::KafkaConsumer& consumer) {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer.consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const auto event = nlohmann::json::parse(static_cast<const char*>(msg->payload()),
                                             static_cast<const char*>(msg->payload()) + msg->len(), nullptr, false);
    if (!event.is_object()) continue;  // malformed: not a tile
    place::Tile tile;
    tile.set_user(event.value("user", ""));
    tile.set_x(event.value("x", 0u));
    tile.set_y(event.value("y", 0u));
    tile.set_color(event.value("color", 0u));
    tile.set_ts(event.value("ts", int64_t{0}));
    publish(tile);
  }
}
`,
};
