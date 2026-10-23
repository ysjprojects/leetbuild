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

/**
 * The same subscription table for TypeScript: one `Subscription` (an async inbox) per open stream,
 * `localDeliver` pushes to every inbox of the room, `unsubscribe` closes the inbox so a forwarding
 * loop over it ends.
 */
export const supportModulesTs: Record<string, string> = {
  'subscriptions.ts': `/**
 * Provided: the subscription table of one chat-server instance. Every open stream that joined a room
 * owns one Subscription (an async inbox); the room bus hands every delivered message to all of them.
 */

/** What the room says: the ServerMsg of chat.proto as a plain object. */
export interface ServerMsg {
  room: string;
  user: string;
  text: string;
  /** Milliseconds since the epoch (an int64: a decimal string once it crossed the gRPC wire). */
  ts: number | string;
}

/** One stream's inbox: \`push\` from the bus, \`next()\` / \`for await\` from the forwarding loop; closed by unsubscribe. */
export class Subscription {
  private readonly items: ServerMsg[] = [];
  private readonly waiters: ((msg: ServerMsg | null) => void)[] = [];
  private closed = false;

  push(msg: ServerMsg): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(msg);
    else this.items.push(msg);
  }

  /** The next delivered message, or null once the subscription is closed. */
  next(): Promise<ServerMsg | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    const {promise, resolve} = Promise.withResolvers<ServerMsg | null>();
    this.waiters.push(resolve);
    return promise;
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ServerMsg> {
    for (;;) {
      const msg = await this.next();
      if (msg === null) return;
      yield msg;
    }
  }
}

const rooms = new Map<string, Subscription[]>();

/** A fresh inbox that receives every message delivered to \`room\` on this instance. */
export function subscribe(room: string): Subscription {
  const sub = new Subscription();
  rooms.set(room, [...(rooms.get(room) ?? []), sub]);
  return sub;
}

/** Drop the inbox from the room and close it, so a loop reading it ends. */
export function unsubscribe(room: string, sub: Subscription): void {
  sub.close();
  const subs = (rooms.get(room) ?? []).filter(s => s !== sub);
  if (subs.length === 0) rooms.delete(room);
  else rooms.set(room, subs);
}

/** Hand \`msg\` to every stream on this instance subscribed to \`room\`. */
export function localDeliver(room: string, msg: ServerMsg): void {
  for (const sub of rooms.get(room) ?? []) sub.push(msg);
}

/** How many streams on this instance are subscribed to \`room\`. */
export function subscribers(room: string): number {
  return rooms.get(room)?.length ?? 0;
}
`,
};

/**
 * The same subscription table for Go, as the package `chat/subscriptions`: one channel per open
 * stream. The chat stream (step 2) binds `subscribe` / `unsubscribe` to it, the room bus (step 3)
 * binds `localDeliver`.
 */
export const supportModulesGo: Record<string, string> = {
  'chat/subscriptions/subscriptions.go': `// Package subscriptions is the subscription table of one chat-server instance. Every open stream
// that joined a room owns one channel; the room bus hands every delivered message to all of them.
package subscriptions

import (
	"sync"

	pb "chat/gen/chat"
)

// inboxSize is how far a stream may fall behind its room. LocalDeliver never blocks the room on one
// slow stream: a stream that has inboxSize messages waiting misses the next ones.
const inboxSize = 64

var (
	mu    sync.Mutex
	rooms = map[string][]chan *pb.ServerMsg{}
)

// Subscribe returns a fresh channel that receives every message delivered to room on this instance.
func Subscribe(room string) <-chan *pb.ServerMsg {
	mu.Lock()
	defer mu.Unlock()
	sub := make(chan *pb.ServerMsg, inboxSize)
	rooms[room] = append(rooms[room], sub)
	return sub
}

// Unsubscribe drops sub from room: it receives nothing more.
func Unsubscribe(room string, sub <-chan *pb.ServerMsg) {
	mu.Lock()
	defer mu.Unlock()
	subs := rooms[room]
	for i := range subs {
		if (<-chan *pb.ServerMsg)(subs[i]) == sub {
			subs = append(subs[:i:i], subs[i+1:]...)
			break
		}
	}
	if len(subs) == 0 {
		delete(rooms, room)
	} else {
		rooms[room] = subs
	}
}

// LocalDeliver hands msg to every stream on this instance subscribed to room.
func LocalDeliver(room string, msg *pb.ServerMsg) {
	mu.Lock()
	defer mu.Unlock()
	subs := rooms[room]
	for i := range subs {
		select {
		case subs[i] <- msg:
		default: // this stream is inboxSize messages behind: it misses this one
		}
	}
}

// Subscribers is how many streams on this instance are subscribed to room.
func Subscribers(room string) int {
	mu.Lock()
	defer mu.Unlock()
	return len(rooms[room])
}
`,
};
