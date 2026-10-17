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
