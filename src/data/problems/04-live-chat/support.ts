/**
 * Hand-written Python modules the live-chat starters import but no step builds: the per-instance
 * subscription table shared by the chat stream (step 2: `subscribe` / `unsubscribe`) and the room
 * bus (step 3: `local_deliver`).
 */
export const supportModules: Record<string, string> = {
  'subscriptions.py': `"""
Provided: the subscription table of one chat-server instance. Every open stream that joined a room
owns one asyncio.Queue; the room bus hands every delivered message to all of them.
"""
import asyncio

_rooms: dict[str, list[asyncio.Queue]] = {}


def subscribe(room: str) -> asyncio.Queue:
    """A fresh queue that receives every message delivered to \`room\` on this instance."""
    queue: asyncio.Queue = asyncio.Queue()
    _rooms.setdefault(room, []).append(queue)
    return queue


def unsubscribe(room: str, queue: asyncio.Queue) -> None:
    queues = _rooms.get(room)
    if queues is None:
        return
    if queue in queues:
        queues.remove(queue)
    if not queues:
        del _rooms[room]


def local_deliver(room: str, msg) -> None:
    """Hand \`msg\` to every stream on this instance subscribed to \`room\`."""
    for queue in list(_rooms.get(room, ())):
        queue.put_nowait(msg)


def subscribers(room: str) -> int:
    """How many streams on this instance are subscribed to \`room\`."""
    return len(_rooms.get(room, ()))
`,
};
