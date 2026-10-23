import type {Step} from '@/lib/types';

export const channelRoutingStep: Step = {
  id: 'channel-routing',
  title: 'Route by channel: a consistent hash ring of data services',
  concept: 'grpc',
  file: 'channel_routing',
  focus: ['api', 'data'],
  task: `## Task

Coalescing only helps when identical requests meet in the **same** data-service instance. Give the
API a **consistent hash ring**: every instance owns many points on a 2⁶⁴ circle, a channel id is
hashed onto the circle, and the request goes to the first instance point clockwise from it. One channel,
one instance — and when an instance disappears, only its channels move.

Implement \`Ring\` and \`fetch_messages\`. \`_hash(key)\` (a 64-bit position), \`INSTANCES\`, the
\`ring\` and the per-instance \`stubs\` are provided.

- \`add(node)\` inserts **\`VNODES\`** (100) points for the node, at \`_hash(f"{node}#{i}")\` for
  \`i\` in \`0..VNODES\`; keep the points sorted by position. Virtual nodes are what make the
  split even and the hand-over after a removal spread across the survivors.
- \`pick(key)\` hashes \`str(key)\` and returns the node of the first point at or after that
  position, wrapping around to the first point of the ring; an empty ring raises.
- \`remove(node)\` drops exactly that node's points and nothing else.
- \`fetch_messages(channel_id, before, limit)\` calls \`GetMessages\` on
  \`stubs[ring.pick(channel_id)]\` with a **300 ms** deadline (\`DEADLINE_S\`) and returns the
  messages; a deadline that passes propagates as the gRPC error it is.

:::widget deadline-retry {"base": 50, "deadline": 300, "attempts": 1}

> A plain \`hash(channel) % 3\` would route every channel to one instance too — until the day you go
> from 3 instances to 4 and two thirds of all channels change homes at once, every one of them a cold
> coalescing table.`,
  sequence: {
    participants: ['messages-api', 'data-2:9000', 'data-3:9000'],
    messages: [
      {
        from: 'messages-api',
        to: 'messages-api',
        label: 'ring.pick(1032…) → _hash("1032…") → next point clockwise: data-2',
        kind: 'sync',
      },
      {
        from: 'messages-api',
        to: 'data-2:9000',
        label: 'GetMessages(1032…, before, 50) · deadline 300 ms',
        kind: 'sync',
      },
      {from: 'data-2:9000', to: 'messages-api', label: 'GetMessagesReply{50 messages}', kind: 'reply'},
      {
        from: 'messages-api',
        to: 'messages-api',
        label: 'ring.remove("data-2:9000") → 1032… now maps to data-3',
        kind: 'sync',
      },
      {
        from: 'messages-api',
        to: 'data-3:9000',
        label: 'GetMessages(1032…, before, 50) · deadline 300 ms',
        kind: 'sync',
      },
      {from: 'data-3:9000', to: 'messages-api', label: 'GetMessagesReply{50 messages}', kind: 'reply'},
    ],
  },
  hints: [
    'Keep the ring as a sorted list of `(position, node)` tuples; `bisect.insort` keeps it sorted on insert, and `bisect_right(points, (h, ""))` finds the first point whose position is `>= h`. Wrap with `% len(points)`.',
    'Remove by filtering the list on the node name: every other point stays exactly where it was, which is the whole guarantee — keys that mapped to a surviving node still map to it.',
    'The deadline is the `timeout=` argument of the stub call; `fetch_messages` is `async` because the stubs are `grpc.aio` stubs — await the call and return `list(reply.messages)`.',
  ],
  checks: [
    {
      id: 'virtual-nodes',
      title: 'Adds VNODES points per instance, labelled node#i',
      detail:
        'Each instance owns `VNODES` positions, hashed from `"{node}#{i}"`, so the split is even and a removal spreads over every survivor.',
      match: {
        python: {all: [/for \w+ in range\(\s*VNODES\s*\)/, /f"\{node\}#\{\w+\}"/, /insort\(|\.sort\(/]},
        typescript: {all: [/for \(let \w+ = 0; \w+ < VNODES; \w+\+\+\)/, /`\$\{node\}#\$\{\w+\}`/, /\.sort\(/]},
        go: {all: [/for \w+ := 0; \w+ < vnodes; \w+\+\+/, /"%s#%d"/, /sort\.Slice\(/]},
        scala: {all: [/0 until VNodes/, /s"\$node#\$\w+"/, /points\.put\(/]},
        cpp: {
          all: [/for \(int \w+ = 0; \w+ < kVNodes; (\+\+\w+|\w+\+\+)\)/, /"#"\s*\+\s*std::to_string\(/, /points_\[/],
        },
      },
    },
    {
      id: 'clockwise-pick',
      title: 'Picks the first point at or after the key’s hash, wrapping around',
      detail:
        'Binary-search the sorted positions for the first one `>= _hash(str(key))`; past the end, wrap to the first point. An empty ring raises.',
      match: {
        python: {all: [/bisect_right\(|bisect_left\(|bisect\.bisect\(/, /%\s*len\(\s*self\._points\s*\)/, /raise /]},
        typescript: {all: [/>=\s*h\b|<\s*h\b/, /%\s*this\.points\.length/, /throw /]},
        go: {all: [/sort\.Search\(/, /%\s*len\(\s*r\.points\s*\)/]},
        scala: {all: [/ceilingEntry\(/, /firstEntry\(\)/, /throw /]},
        cpp: {all: [/lower_bound\(/, /points_\.begin\(\)/, /throw /]},
      },
    },
    {
      id: 'remove-minimal',
      title: 'Removing an instance drops only its own points',
      detail:
        'Points of the other instances stay where they are, so only the keys that mapped to the removed instance change homes.',
      match: {
        python: {all: [/def remove(?:(?!\n {4}def )[\s\S])*?(!= node|\.remove\()/]},
        typescript: {all: [/remove\(node(?:(?!\n {2}[a-z])[\s\S])*?!==\s*node/]},
        go: {all: [/func \(r \*Ring\) Remove(?:(?!\n\})[\s\S])*?!= node/]},
        scala: {all: [/def remove(?:(?!\n {4}def )[\s\S])*?points\.remove\(/]},
        cpp: {all: [/void remove\([^\n]*\{(?:(?!\n {2}\})[\s\S])*?points_\.erase\(/]},
      },
    },
    {
      id: 'route-by-channel',
      title: 'Calls the instance the ring picks for the channel',
      detail:
        '`fetch_messages` asks `ring.pick(channel_id)` and uses that instance’s stub, so every request for one channel reaches the same data service.',
      match: {
        python: {all: [/ring\.pick\(\s*channel_id\s*\)/, /stubs\[\s*instance\s*\]\.GetMessages\(/]},
        typescript: {all: [/ring\.pick\(\s*channelId\s*\)/, /stubs\[\s*instance\s*\]\.GetMessages\(/]},
        go: {all: [/ring\.Pick\(\s*strconv\.FormatInt\(\s*channelID/, /stubs\[\s*instance\s*\]\.GetMessages\(/]},
        scala: {all: [/ring\.pick\(\s*channelId\.toString\s*\)/, /stubs\(\s*instance\s*\)/]},
        cpp: {
          all: [/ring\.pick\(\s*std::to_string\(\s*channel_id\s*\)\s*\)/, /stubs\.at\(\s*instance\s*\)->GetMessages\(/],
        },
      },
    },
    {
      id: 'deadline',
      title: 'Sets a 300 ms deadline on GetMessages',
      detail:
        'Every call carries `DEADLINE_S`; a data service that does not answer in time fails the request instead of holding the API thread.',
      match: {
        python: {all: [/GetMessages\([^\n]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/GetMessages\([^\n]*deadline:\s*(new Date\()?Date\.now\(\)\s*\+\s*DEADLINE_S\s*\*\s*1000/]},
        go: {all: [/context\.WithTimeout\(\s*ctx\s*,\s*deadline\s*\)/, /\.GetMessages\(\s*callCtx/]},
        scala: {all: [/withDeadlineAfter\(\s*DeadlineMillis\s*,\s*TimeUnit\.MILLISECONDS\s*\)/]},
        cpp: {all: [/set_deadline\([^\n]*kDeadline/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import bisect
import hashlib

import grpc

import messages_pb2
import messages_pb2_grpc

INSTANCES = ["data-1:9000", "data-2:9000", "data-3:9000"]
VNODES = 100
DEADLINE_S = 0.3


def _hash(key: str) -> int:
    """A 64-bit position on the ring (provided)."""
    return int.from_bytes(hashlib.md5(key.encode()).digest()[:8], "big")


class Ring:
    """Consistent hash ring: every instance owns VNODES points, a key goes to the first point clockwise."""

    def __init__(self, nodes=()):
        self._points: list[tuple[int, str]] = []  # (position, node), sorted by position
        for node in nodes:
            self.add(node)

    def add(self, node: str) -> None:
        # TODO: VNODES points at _hash(f"{node}#{i}"), kept sorted (bisect.insort)
        pass

    def remove(self, node: str) -> None:
        # TODO: drop this node's points, nothing else
        pass

    def pick(self, key) -> str:
        # TODO: empty ring → raise; the node of the first point with position >= _hash(str(key)), wrapping around
        raise NotImplementedError


ring = Ring(INSTANCES)
stubs = {node: messages_pb2_grpc.MessageDataStub(grpc.aio.insecure_channel(node)) for node in INSTANCES}


async def fetch_messages(channel_id: int, before: int, limit: int) -> list[messages_pb2.Message]:
    """The page from the data service that owns the channel."""
    # TODO: instance = ring.pick(channel_id); GetMessages on stubs[instance] with timeout=DEADLINE_S
    # TODO: return list(reply.messages)
    raise NotImplementedError
`,
      solution: `import bisect
import hashlib

import grpc

import messages_pb2
import messages_pb2_grpc

INSTANCES = ["data-1:9000", "data-2:9000", "data-3:9000"]
VNODES = 100
DEADLINE_S = 0.3


def _hash(key: str) -> int:
    """A 64-bit position on the ring (provided)."""
    return int.from_bytes(hashlib.md5(key.encode()).digest()[:8], "big")


class Ring:
    """Consistent hash ring: every instance owns VNODES points, a key goes to the first point clockwise."""

    def __init__(self, nodes=()):
        self._points: list[tuple[int, str]] = []  # (position, node), sorted by position
        for node in nodes:
            self.add(node)

    def add(self, node: str) -> None:
        for i in range(VNODES):
            bisect.insort(self._points, (_hash(f"{node}#{i}"), node))

    def remove(self, node: str) -> None:
        self._points = [point for point in self._points if point[1] != node]  # every other point stays put

    def pick(self, key) -> str:
        if not self._points:
            raise LookupError("no data-service instance is up")
        i = bisect.bisect_right(self._points, (_hash(str(key)), ""))  # first point at or after the key's position
        return self._points[i % len(self._points)][1]


ring = Ring(INSTANCES)
stubs = {node: messages_pb2_grpc.MessageDataStub(grpc.aio.insecure_channel(node)) for node in INSTANCES}


async def fetch_messages(channel_id: int, before: int, limit: int) -> list[messages_pb2.Message]:
    """The page from the data service that owns the channel."""
    instance = ring.pick(channel_id)
    request = messages_pb2.GetMessagesRequest(channel_id=channel_id, before=before, limit=limit)
    reply = await stubs[instance].GetMessages(request, timeout=DEADLINE_S)
    return list(reply.messages)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {createHash} from 'node:crypto';

import type {GetMessagesReply, GetMessagesRequest, Message} from './data_service'; // the wire shapes (ids as decimal strings)

export const INSTANCES = ['data-1:9000', 'data-2:9000', 'data-3:9000'];
export const VNODES = 100;
export const DEADLINE_S = 0.3;

/** A 64-bit position on the ring (provided). */
export function _hash(key: string): bigint {
  return BigInt('0x' + createHash('md5').update(key).digest('hex').slice(0, 16));
}

/** Consistent hash ring: every instance owns VNODES points, a key goes to the first point clockwise. */
export class Ring {
  private points: [bigint, string][] = []; // [position, node], sorted by position

  constructor(nodes: string[] = []) {
    for (const node of nodes) this.add(node);
  }

  add(node: string): void {
    // TODO: VNODES points at _hash(\`\${node}#\${i}\`), kept sorted by position
  }

  remove(node: string): void {
    // TODO: drop this node's points, nothing else
  }

  pick(key: string | bigint): string {
    // TODO: empty ring → throw; the node of the first point with position >= _hash(String(key)), wrapping around
    throw new Error('not implemented');
  }
}

interface MessageDataClient {
  GetMessages(request: GetMessagesRequest, options: grpc.CallOptions): Promise<GetMessagesReply>;
}

const proto = grpc.loadPackageDefinition(protoLoader.loadSync('messages.proto', {longs: String})) as unknown as {
  discord: {MessageData: grpc.ServiceClientConstructor};
};

export const ring = new Ring(INSTANCES);
export const stubs: Record<string, MessageDataClient> = Object.fromEntries(
  INSTANCES.map(node => [node, new proto.discord.MessageData(node, grpc.credentials.createInsecure()) as unknown as MessageDataClient]),
);

/** The page from the data service that owns the channel. */
export async function fetch_messages(channelId: bigint, before: bigint, limit: number): Promise<Message[]> {
  // TODO: instance = ring.pick(channelId); GetMessages on stubs[instance] with {deadline: Date.now() + DEADLINE_S * 1000}
  // TODO: return reply.messages
  throw new Error('not implemented');
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {createHash} from 'node:crypto';

import type {GetMessagesReply, GetMessagesRequest, Message} from './data_service'; // the wire shapes (ids as decimal strings)

export const INSTANCES = ['data-1:9000', 'data-2:9000', 'data-3:9000'];
export const VNODES = 100;
export const DEADLINE_S = 0.3;

/** A 64-bit position on the ring (provided). */
export function _hash(key: string): bigint {
  return BigInt('0x' + createHash('md5').update(key).digest('hex').slice(0, 16));
}

/** Consistent hash ring: every instance owns VNODES points, a key goes to the first point clockwise. */
export class Ring {
  private points: [bigint, string][] = []; // [position, node], sorted by position

  constructor(nodes: string[] = []) {
    for (const node of nodes) this.add(node);
  }

  add(node: string): void {
    for (let i = 0; i < VNODES; i++) this.points.push([_hash(\`\${node}#\${i}\`), node]);
    this.points.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  }

  remove(node: string): void {
    this.points = this.points.filter(point => point[1] !== node); // every other point stays put
  }

  pick(key: string | bigint): string {
    if (this.points.length === 0) throw new Error('no data-service instance is up');
    const h = _hash(String(key));
    let lo = 0; // binary search: the first point at or after the key's position
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid][0] < h) lo = mid + 1;
      else hi = mid;
    }
    return this.points[lo % this.points.length][1];
  }
}

interface MessageDataClient {
  GetMessages(request: GetMessagesRequest, options: grpc.CallOptions): Promise<GetMessagesReply>;
}

const proto = grpc.loadPackageDefinition(protoLoader.loadSync('messages.proto', {longs: String})) as unknown as {
  discord: {MessageData: grpc.ServiceClientConstructor};
};

export const ring = new Ring(INSTANCES);
export const stubs: Record<string, MessageDataClient> = Object.fromEntries(
  INSTANCES.map(node => [node, new proto.discord.MessageData(node, grpc.credentials.createInsecure()) as unknown as MessageDataClient]),
);

/** The page from the data service that owns the channel. */
export async function fetch_messages(channelId: bigint, before: bigint, limit: number): Promise<Message[]> {
  const instance = ring.pick(channelId);
  const request: GetMessagesRequest = {channel_id: String(channelId), before: String(before), limit};
  const reply = await stubs[instance].GetMessages(request, {deadline: Date.now() + DEADLINE_S * 1000});
  return reply.messages;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/md5"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "discord/gen/messages"
)

var instances = []string{"data-1:9000", "data-2:9000", "data-3:9000"}

const (
	vnodes   = 100
	deadline = 300 * time.Millisecond
)

// hashKey is a 64-bit position on the ring (provided).
func hashKey(key string) uint64 {
	sum := md5.Sum([]byte(key))
	return binary.BigEndian.Uint64(sum[:8])
}

type point struct {
	pos  uint64
	node string
}

// Ring is a consistent hash ring: every instance owns vnodes points, a key goes to the first point clockwise.
type Ring struct {
	mu     sync.RWMutex
	points []point // sorted by pos
}

func NewRing(nodes ...string) *Ring {
	r := &Ring{}
	for _, node := range nodes {
		r.Add(node)
	}
	return r
}

func (r *Ring) Add(node string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// TODO: vnodes points at hashKey(fmt.Sprintf("%s#%d", node, i)); keep r.points sorted by pos
	_ = fmt.Sprintf
	_ = sort.Slice
}

func (r *Ring) Remove(node string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// TODO: drop this node's points, nothing else
}

func (r *Ring) Pick(key string) (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	// TODO: empty ring → error; the node of the first point with pos >= hashKey(key), wrapping around (sort.Search)
	return "", errors.New("not implemented")
}

var ring = NewRing(instances...)

var stubs = func() map[string]pb.MessageDataClient {
	out := map[string]pb.MessageDataClient{}
	for _, node := range instances {
		conn, _ := grpc.NewClient(node, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[node] = pb.NewMessageDataClient(conn)
	}
	return out
}()

// fetchMessages is the page from the data service that owns the channel.
func fetchMessages(ctx context.Context, channelID, before int64, limit int) ([]*pb.Message, error) {
	// TODO: instance, err := ring.Pick(strconv.FormatInt(channelID, 10))
	// TODO: GetMessages on stubs[instance] with a context that expires after deadline → reply.GetMessages()
	_ = strconv.FormatInt
	return nil, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"crypto/md5"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "discord/gen/messages"
)

var instances = []string{"data-1:9000", "data-2:9000", "data-3:9000"}

const (
	vnodes   = 100
	deadline = 300 * time.Millisecond
)

// hashKey is a 64-bit position on the ring (provided).
func hashKey(key string) uint64 {
	sum := md5.Sum([]byte(key))
	return binary.BigEndian.Uint64(sum[:8])
}

type point struct {
	pos  uint64
	node string
}

// Ring is a consistent hash ring: every instance owns vnodes points, a key goes to the first point clockwise.
type Ring struct {
	mu     sync.RWMutex
	points []point // sorted by pos
}

func NewRing(nodes ...string) *Ring {
	r := &Ring{}
	for _, node := range nodes {
		r.Add(node)
	}
	return r
}

func (r *Ring) Add(node string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := 0; i < vnodes; i++ {
		r.points = append(r.points, point{pos: hashKey(fmt.Sprintf("%s#%d", node, i)), node: node})
	}
	sort.Slice(r.points, func(a, b int) bool { return r.points[a].pos < r.points[b].pos })
}

func (r *Ring) Remove(node string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.points[:0]
	for _, p := range r.points {
		if p.node != node { // every other point stays put
			kept = append(kept, p)
		}
	}
	r.points = kept
}

func (r *Ring) Pick(key string) (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.points) == 0 {
		return "", errors.New("no data-service instance is up")
	}
	h := hashKey(key)
	i := sort.Search(len(r.points), func(i int) bool { return r.points[i].pos >= h }) // first point at or after the key
	return r.points[i%len(r.points)].node, nil
}

var ring = NewRing(instances...)

var stubs = func() map[string]pb.MessageDataClient {
	out := map[string]pb.MessageDataClient{}
	for _, node := range instances {
		conn, _ := grpc.NewClient(node, grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[node] = pb.NewMessageDataClient(conn)
	}
	return out
}()

// fetchMessages is the page from the data service that owns the channel.
func fetchMessages(ctx context.Context, channelID, before int64, limit int) ([]*pb.Message, error) {
	instance, err := ring.Pick(strconv.FormatInt(channelID, 10))
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := stubs[instance].GetMessages(callCtx, &pb.GetMessagesRequest{ChannelId: uint64(channelID), Before: uint64(before), Limit: uint32(limit)})
	if err != nil {
		return nil, err
	}
	return reply.GetMessages(), nil
}
`,
    },
    scala: {
      starter: `import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import discord.messages.{GetMessagesRequest, Message, MessageDataGrpc}
import io.grpc.ManagedChannelBuilder

object ChannelRouting {
  val Instances: Seq[String] = Seq("data-1:9000", "data-2:9000", "data-3:9000")
  val VNodes = 100
  val DeadlineMillis = 300L

  /** A 64-bit position on the ring (provided). */
  def hash(key: String): Long =
    ByteBuffer.wrap(MessageDigest.getInstance("MD5").digest(key.getBytes(UTF_8))).getLong

  /** Consistent hash ring: every instance owns VNodes points, a key goes to the first point clockwise. */
  final class Ring(nodes: Seq[String]) {
    private val points = new java.util.TreeMap[Long, String] // position → node
    nodes.foreach(add)

    def add(node: String): Unit = points.synchronized {
      // TODO: VNodes points at hash(s"$node#$i")
    }

    def remove(node: String): Unit = points.synchronized {
      // TODO: drop this node's points, nothing else
    }

    def pick(key: String): String = points.synchronized {
      // TODO: empty ring → throw; the node of the first point with position >= hash(key) (ceilingEntry), wrapping to firstEntry
      ???
    }
  }

  val ring = new Ring(Instances)
  private val stubs: Map[String, MessageDataGrpc.MessageDataBlockingStub] = Instances.map { node =>
    node -> MessageDataGrpc.blockingStub(ManagedChannelBuilder.forTarget(node).usePlaintext().build())
  }.toMap

  /** The page from the data service that owns the channel. */
  def fetchMessages(channelId: Long, before: Long, limit: Int): Seq[Message] = {
    // TODO: val instance = ring.pick(channelId.toString)
    // TODO: stubs(instance).withDeadlineAfter(DeadlineMillis, MILLISECONDS).getMessages(request).messages
    ???
  }
}
`,
      solution: `import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import discord.messages.{GetMessagesRequest, Message, MessageDataGrpc}
import io.grpc.ManagedChannelBuilder

object ChannelRouting {
  val Instances: Seq[String] = Seq("data-1:9000", "data-2:9000", "data-3:9000")
  val VNodes = 100
  val DeadlineMillis = 300L

  /** A 64-bit position on the ring (provided). */
  def hash(key: String): Long =
    ByteBuffer.wrap(MessageDigest.getInstance("MD5").digest(key.getBytes(UTF_8))).getLong

  /** Consistent hash ring: every instance owns VNodes points, a key goes to the first point clockwise. */
  final class Ring(nodes: Seq[String]) {
    private val points = new java.util.TreeMap[Long, String] // position → node
    nodes.foreach(add)

    def add(node: String): Unit = points.synchronized {
      for (i <- 0 until VNodes) points.put(hash(s"$node#$i"), node)
    }

    def remove(node: String): Unit = points.synchronized {
      for (i <- 0 until VNodes) points.remove(hash(s"$node#$i")) // every other point stays put
    }

    def pick(key: String): String = points.synchronized {
      if (points.isEmpty) throw new NoSuchElementException("no data-service instance is up")
      val entry = points.ceilingEntry(hash(key)) // first point at or after the key's position
      (if (entry == null) points.firstEntry() else entry).getValue
    }
  }

  val ring = new Ring(Instances)
  private val stubs: Map[String, MessageDataGrpc.MessageDataBlockingStub] = Instances.map { node =>
    node -> MessageDataGrpc.blockingStub(ManagedChannelBuilder.forTarget(node).usePlaintext().build())
  }.toMap

  /** The page from the data service that owns the channel. */
  def fetchMessages(channelId: Long, before: Long, limit: Int): Seq[Message] = {
    val instance = ring.pick(channelId.toString)
    val request = GetMessagesRequest(channelId = channelId, before = before, limit = limit)
    stubs(instance).withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).getMessages(request).messages
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "messages.grpc.pb.h"

using discord::GetMessagesReply;
using discord::GetMessagesRequest;
using discord::MessageData;

const std::vector<std::string> kInstances = {"data-1:9000", "data-2:9000", "data-3:9000"};
constexpr int kVNodes = 100;
constexpr std::chrono::milliseconds kDeadline{300};

// A 64-bit position on the ring (provided).
uint64_t hash_key(const std::string& key) { return std::hash<std::string>{}(key); }

// Consistent hash ring: every instance owns kVNodes points, a key goes to the first point clockwise.
class Ring {
 public:
  explicit Ring(const std::vector<std::string>& nodes) {
    for (const auto& node : nodes) add(node);
  }

  void add(const std::string& node) {
    std::lock_guard<std::mutex> guard(mu_);
    // TODO: kVNodes points at hash_key(node + "#" + std::to_string(i))
  }

  void remove(const std::string& node) {
    std::lock_guard<std::mutex> guard(mu_);
    // TODO: drop this node's points, nothing else
  }

  std::string pick(const std::string& key) {
    std::lock_guard<std::mutex> guard(mu_);
    // TODO: empty ring → throw; the node of the first point with position >= hash_key(key) (lower_bound), wrapping to begin()
    return "";
  }

 private:
  std::mutex mu_;
  std::map<uint64_t, std::string> points_;  // position → node
};

Ring ring(kInstances);

std::map<std::string, std::unique_ptr<MessageData::Stub>> make_stubs() {
  std::map<std::string, std::unique_ptr<MessageData::Stub>> out;
  for (const auto& node : kInstances)
    out[node] = MessageData::NewStub(grpc::CreateChannel(node, grpc::InsecureChannelCredentials()));
  return out;
}

auto stubs = make_stubs();

// The page from the data service that owns the channel.
std::vector<discord::Message> fetch_messages(int64_t channel_id, int64_t before, int limit) {
  // TODO: const std::string instance = ring.pick(std::to_string(channel_id))
  // TODO: stubs.at(instance)->GetMessages with a ClientContext whose deadline is now + kDeadline; !ok → throw
  return {};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "messages.grpc.pb.h"

using discord::GetMessagesReply;
using discord::GetMessagesRequest;
using discord::MessageData;

const std::vector<std::string> kInstances = {"data-1:9000", "data-2:9000", "data-3:9000"};
constexpr int kVNodes = 100;
constexpr std::chrono::milliseconds kDeadline{300};

// A 64-bit position on the ring (provided).
uint64_t hash_key(const std::string& key) { return std::hash<std::string>{}(key); }

// Consistent hash ring: every instance owns kVNodes points, a key goes to the first point clockwise.
class Ring {
 public:
  explicit Ring(const std::vector<std::string>& nodes) {
    for (const auto& node : nodes) add(node);
  }

  void add(const std::string& node) {
    std::lock_guard<std::mutex> guard(mu_);
    for (int i = 0; i < kVNodes; ++i) points_[hash_key(node + "#" + std::to_string(i))] = node;
  }

  void remove(const std::string& node) {
    std::lock_guard<std::mutex> guard(mu_);
    for (int i = 0; i < kVNodes; ++i) points_.erase(hash_key(node + "#" + std::to_string(i)));  // the rest stay put
  }

  std::string pick(const std::string& key) {
    std::lock_guard<std::mutex> guard(mu_);
    if (points_.empty()) throw std::runtime_error("no data-service instance is up");
    auto it = points_.lower_bound(hash_key(key));  // first point at or after the key's position
    if (it == points_.end()) it = points_.begin();
    return it->second;
  }

 private:
  std::mutex mu_;
  std::map<uint64_t, std::string> points_;  // position → node
};

Ring ring(kInstances);

std::map<std::string, std::unique_ptr<MessageData::Stub>> make_stubs() {
  std::map<std::string, std::unique_ptr<MessageData::Stub>> out;
  for (const auto& node : kInstances)
    out[node] = MessageData::NewStub(grpc::CreateChannel(node, grpc::InsecureChannelCredentials()));
  return out;
}

auto stubs = make_stubs();

// The page from the data service that owns the channel.
std::vector<discord::Message> fetch_messages(int64_t channel_id, int64_t before, int limit) {
  const std::string instance = ring.pick(std::to_string(channel_id));
  GetMessagesRequest request;
  request.set_channel_id(static_cast<uint64_t>(channel_id));
  request.set_before(static_cast<uint64_t>(before));
  request.set_limit(static_cast<uint32_t>(limit));
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  GetMessagesReply reply;
  const grpc::Status status = stubs.at(instance)->GetMessages(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("data service: " + status.error_message());
  return {reply.messages().begin(), reply.messages().end()};
}
`,
    },
  },
  harness: {
    python: `import importlib
from collections import Counter

import grpc

from messages.db import SCHEMA

EPOCH = 1420070400000
BUCKET_MS = 10 * 24 * 3600 * 1000
INSERT = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES (%s, %s, %s, %s, %s)"


def sf(bucket, offset_ms=0):
    return ((bucket * BUCKET_MS + offset_ms) << 22) | (1 << 17)


B = 430
END = sf(B + 1, BUCKET_MS - 1)
CHANNELS = [sf(B, 1000 * i + 1) for i in range(12)]  # twelve channels created in bucket B


def _page(i):
    """What Postgres holds for CHANNELS[i], newest first."""
    return [f"{i}:2", f"{i}:1", f"{i}:0"]


async def _cluster(ctx):
    """The routing module, with step 3's data service — the real one, over Postgres — serving one instance at each of its INSTANCES."""
    await ctx.db.reset(SCHEMA)
    for i, channel in enumerate(CHANNELS):
        for j in range(3):
            await ctx.db.execute(INSERT, (str(channel), B, str(sf(B, 1000 * i + 10 + j)), "7", f"{i}:{j}"))
    m = ctx.load("channel_routing")
    data_service = importlib.import_module("data_service")
    pb2_grpc = importlib.import_module("messages_pb2_grpc")
    base = pb2_grpc.MessageDataServicer
    servicers = [v for v in vars(data_service).values() if isinstance(v, type) and issubclass(v, base) and v is not base]
    assert servicers, "data_service (step 3) defines no MessageDataServicer to route to"
    for node in m.INSTANCES:
        ctx.grpc.serve(pb2_grpc.add_MessageDataServicer_to_server, servicers[0](), target=node)
    return m


async def _fetch(ctx, m, channel):
    """fetch_messages for one channel: the contents it returned and the one GetMessages call it made."""
    n = len(ctx.grpc.calls_to("GetMessages"))
    rows = await m.fetch_messages(channel, END, 50)
    calls = ctx.grpc.calls_to("GetMessages")[n:]
    assert len(calls) == 1, f"fetch_messages for channel {channel} made {len(calls)} GetMessages calls, expected one"
    return [x.content for x in rows], calls[0]


def _expected(m, nodes, key):
    """The clockwise rule applied by hand: the first of the node#i points at or after _hash(str(key))."""
    points = sorted((m._hash(f"{node}#{i}"), node) for node in nodes for i in range(m.VNODES))
    h = m._hash(str(key))
    for position, node in points:
        if position >= h:
            return node
    return points[0][1]


def check_virtual_nodes(ctx):
    m = ctx.load("channel_routing")
    assert m.VNODES >= 50, f"VNODES is {m.VNODES}: a handful of points per instance cannot split the ring evenly"
    ring = m.Ring(m.INSTANCES)
    keys = [sf(425, i * 4096 * 7919) for i in range(3000)]
    shares = Counter(ring.pick(k) for k in keys)
    assert set(shares) == set(m.INSTANCES), f"every instance must own part of the ring, picks landed on {set(shares)}"
    for node, n in shares.items():
        assert 0.2 <= n / len(keys) <= 0.5, f"{node} receives {n / len(keys):.0%} of 3000 channels; with VNODES points per instance the split should be close to a third each: {dict(shares)}"
    only = m.Ring(["data-9:9000"])
    assert all(only.pick(k) == "data-9:9000" for k in keys[:50]), "a ring with one instance picks it for every key"
    try:
        m.Ring([]).pick(CHANNELS[0])
        raise AssertionError("pick on an empty ring must raise: there is no instance to route to")
    except AssertionError:
        raise
    except Exception:
        pass


def check_clockwise_pick(ctx):
    m = ctx.load("channel_routing")
    for nodes in (m.INSTANCES, m.INSTANCES[:2], ["data-7:9000", "data-8:9000", "data-9:9000", "data-10:9000"]):
        ring = m.Ring(nodes)
        for key in [sf(425, i * 4096 * 7919) for i in range(400)]:
            expected = _expected(m, nodes, key)
            got = ring.pick(key)
            assert got == expected, f"pick({key}) on {nodes} returned {got}, expected {expected}: the first point at or after _hash(str(key)) among the VNODES points hashed from node#i, wrapping to the first point"
    a, b = m.Ring(m.INSTANCES), m.Ring(list(reversed(m.INSTANCES)))
    assert all(a.pick(k) == b.pick(k) for k in CHANNELS), "the mapping must not depend on the order instances were added"


def check_remove_minimal(ctx):
    m = ctx.load("channel_routing")
    ring = m.Ring(m.INSTANCES)
    keys = [sf(425, i * 4096 * 7919) for i in range(1500)]
    before = {k: ring.pick(k) for k in keys}
    ring.remove("data-2:9000")
    after = {k: ring.pick(k) for k in keys}
    assert "data-2:9000" not in set(after.values()), "a removed instance must receive nothing"
    stayed = [k for k in keys if before[k] != "data-2:9000"]
    moved = [k for k in stayed if after[k] != before[k]]
    assert not moved, f"{len(moved)} of {len(stayed)} channels that did not live on data-2 changed instance when data-2 left: removing a node must drop only its own points"
    orphans = [k for k in keys if before[k] == "data-2:9000"]
    assert {after[k] for k in orphans} == {"data-1:9000", "data-3:9000"}, f"data-2's channels must spread over both survivors, they went to {set(after[k] for k in orphans)}"
    ring.add("data-2:9000")
    assert {k: ring.pick(k) for k in keys} == before, "adding the instance back must restore the exact previous mapping"
    ring.remove("data-1:9000")
    ring.remove("data-3:9000")
    assert all(ring.pick(k) == "data-2:9000" for k in keys[:20]), "with one instance left every key goes to it"


async def check_route_by_channel(ctx):
    m = await _cluster(ctx)
    homes = {}
    for i, channel in enumerate(CHANNELS):
        page, call = await _fetch(ctx, m, channel)
        owner = m.ring.pick(channel)
        assert call.target == owner, f"fetch_messages for channel {channel} reached {call.target}, but ring.pick says {owner}: a channel's reads must go to the instance that owns it on the ring"
        assert (call.request.channel_id, call.request.before, call.request.limit) == (channel, END, 50), f"the request must carry channel_id, before and limit as given, the data service received {call.request}"
        assert page == _page(i), f"fetch_messages must return the data service's page for channel {channel} ({_page(i)}), got {page}"
        homes[channel] = call.target
    assert len(set(homes.values())) >= 2, f"twelve channels all reached {set(homes.values())}: the ring must spread channels over the instances"
    for _ in range(3):
        _page0, call = await _fetch(ctx, m, CHANNELS[0])
        assert call.target == homes[CHANNELS[0]], f"repeated reads of one channel must all reach the same instance: {homes[CHANNELS[0]]} first, then {call.target}"
    gone = homes[CHANNELS[0]]
    ctx.grpc.stop(gone)  # the instance goes down; service discovery drops it from the ring
    m.ring.remove(gone)
    for i, channel in enumerate(CHANNELS):
        try:
            page, call = await _fetch(ctx, m, channel)
        except grpc.RpcError as e:
            raise AssertionError(f"after {gone} went down and left the ring, channel {channel} failed with {e.code()}: its reads must follow the ring to a live instance")
        assert call.target != gone, f"channel {channel} still dialled {gone} after it left the ring"
        if homes[channel] != gone:
            assert call.target == homes[channel], f"channel {channel} lived on {homes[channel]}, which is still up, yet moved to {call.target} when {gone} left"
        assert call.target == m.ring.pick(channel), f"channel {channel} reached {call.target}, but the ring now says {m.ring.pick(channel)}"
        assert page == _page(i), f"the new owner must answer channel {channel}'s real page {_page(i)}, got {page}"


async def check_deadline(ctx):
    m = await _cluster(ctx)
    channel = CHANNELS[1]
    page, call = await _fetch(ctx, m, channel)
    assert page == _page(1), f"expected channel {channel}'s page {_page(1)}, got {page}"
    assert call.timeout is not None, "GetMessages carries no deadline: a stalled data service would hold the API request forever"
    assert 0.25 <= call.timeout <= 0.35, f"the deadline must be 300 ms, the call carried {call.timeout} s"
    owner = call.target
    ctx.grpc.set_latency("GetMessages", 2.0, target=owner)  # that instance stalls for 2 s
    started = ctx.clock.time()
    try:
        rows = await m.fetch_messages(channel, END, 50)
        raise AssertionError(f"{owner} took 2 s to answer and fetch_messages waited {ctx.clock.time() - started:.1f} s for {len(rows)} messages: a data service slower than the deadline must surface DEADLINE_EXCEEDED")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.DEADLINE_EXCEEDED, f"expected DEADLINE_EXCEEDED from the stalled instance, got {e.code()}"
    waited = ctx.clock.time() - started
    assert waited <= 0.5, f"the API waited {waited:.1f} s for a stalled instance, the deadline is 300 ms"
`,
    typescript: `import {status} from '@grpc/grpc-js';
import {SCHEMA} from 'messages/db';

const BUCKET_MS = 10 * 24 * 3600 * 1000;
const INSERT = 'INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)';

function sf(bucket: number, offsetMs = 0): bigint {
  return (BigInt(bucket * BUCKET_MS + offsetMs) << 22n) | (1n << 17n);
}

const B = 430;
const END = sf(B + 1, BUCKET_MS - 1);
const CHANNELS = Array.from({length: 12}, (_, i) => sf(B, 1000 * i + 1)); // twelve channels created in bucket B

/** What Postgres holds for CHANNELS[i], newest first. */
function page(i: number): string[] {
  return [\`\${i}:2\`, \`\${i}:1\`, \`\${i}:0\`];
}

/** The routing module, with step 3's data service — the real one, over Postgres — serving one instance at each of its INSTANCES. */
async function cluster(ctx) {
  await ctx.db.reset(SCHEMA);
  for (const [i, channel] of CHANNELS.entries()) {
    for (let j = 0; j < 3; j++) {
      await ctx.db.execute(INSERT, [String(channel), B, String(sf(B, 1000 * i + 10 + j)), '7', \`\${i}:\${j}\`]);
    }
  }
  const m = ctx.load('channel_routing');
  const data = ctx.load('data_service');
  assert(data.messageData !== undefined && typeof data.messageData.GetMessages === 'function', 'data_service (step 3) exports no messageData handlers to route to');
  const service = ctx.proto('messages.proto').discord.MessageData.service;
  for (const node of m.INSTANCES) ctx.grpc.serve(service, data.messageData, node);
  return m;
}

/** fetch_messages for one channel: the contents it returned and the one GetMessages call it made. */
async function fetch(ctx, m, channel: bigint) {
  const n = ctx.grpc.callsTo('GetMessages').length;
  const rows = await m.fetch_messages(channel, END, 50);
  const calls = ctx.grpc.callsTo('GetMessages').slice(n);
  assert.equal(calls.length, 1, \`fetch_messages for channel \${channel} made \${calls.length} GetMessages calls, expected one\`);
  return {page: (rows as {content: string}[]).map(x => x.content), call: calls[0]};
}

/** The clockwise rule applied by hand: the first of the node#i points at or after _hash(String(key)). */
function expected(m, nodes: string[], key: bigint): string {
  const points: [bigint, string][] = nodes.flatMap(node => Array.from({length: m.VNODES as number}, (_, i): [bigint, string] => [m._hash(\`\${node}#\${i}\`), node]));
  points.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h: bigint = m._hash(String(key));
  for (const [position, node] of points) if (position >= h) return node;
  return points[0][1];
}

const KEYS = (n: number): bigint[] => Array.from({length: n}, (_, i) => sf(425, i * 4096 * 7919));

export async function check_virtual_nodes(ctx) {
  const m = ctx.load('channel_routing');
  assert(m.VNODES >= 50, \`VNODES is \${m.VNODES}: a handful of points per instance cannot split the ring evenly\`);
  const ring = new m.Ring(m.INSTANCES);
  const keys = KEYS(3000);
  const shares = new Map<string, number>();
  for (const k of keys) {
    const node = ring.pick(k);
    shares.set(node, (shares.get(node) ?? 0) + 1);
  }
  assert.deepEqual([...shares.keys()].sort(), [...m.INSTANCES].sort(), \`every instance must own part of the ring, picks landed on \${JSON.stringify([...shares.keys()])}\`);
  for (const [node, n] of shares) {
    assert(0.2 <= n / keys.length && n / keys.length <= 0.5, \`\${node} receives \${Math.round((100 * n) / keys.length)}% of 3000 channels; with VNODES points per instance the split should be close to a third each: \${JSON.stringify(Object.fromEntries(shares))}\`);
  }
  const only = new m.Ring(['data-9:9000']);
  assert(keys.slice(0, 50).every(k => only.pick(k) === 'data-9:9000'), 'a ring with one instance picks it for every key');
  assert.throws(() => new m.Ring([]).pick(CHANNELS[0]), 'pick on an empty ring must throw: there is no instance to route to');
}

export async function check_clockwise_pick(ctx) {
  const m = ctx.load('channel_routing');
  for (const nodes of [m.INSTANCES, m.INSTANCES.slice(0, 2), ['data-7:9000', 'data-8:9000', 'data-9:9000', 'data-10:9000']]) {
    const ring = new m.Ring(nodes);
    for (const key of KEYS(400)) {
      const want = expected(m, nodes, key);
      const got = ring.pick(key);
      assert.equal(got, want, \`pick(\${key}) on \${JSON.stringify(nodes)} returned \${got}, expected \${want}: the first point at or after _hash(String(key)) among the VNODES points hashed from node#i, wrapping to the first point\`);
    }
  }
  const a = new m.Ring(m.INSTANCES);
  const b = new m.Ring([...m.INSTANCES].reverse());
  assert(CHANNELS.every(k => a.pick(k) === b.pick(k)), 'the mapping must not depend on the order instances were added');
}

export async function check_remove_minimal(ctx) {
  const m = ctx.load('channel_routing');
  const ring = new m.Ring(m.INSTANCES);
  const keys = KEYS(1500);
  const before = new Map(keys.map(k => [k, ring.pick(k) as string]));
  ring.remove('data-2:9000');
  const after = new Map(keys.map(k => [k, ring.pick(k) as string]));
  assert(![...after.values()].includes('data-2:9000'), 'a removed instance must receive nothing');
  const stayed = keys.filter(k => before.get(k) !== 'data-2:9000');
  const moved = stayed.filter(k => after.get(k) !== before.get(k));
  assert.equal(moved.length, 0, \`\${moved.length} of \${stayed.length} channels that did not live on data-2 changed instance when data-2 left: removing a node must drop only its own points\`);
  const orphans = keys.filter(k => before.get(k) === 'data-2:9000');
  const homes = [...new Set(orphans.map(k => after.get(k)))].sort();
  assert.deepEqual(homes, ['data-1:9000', 'data-3:9000'], \`data-2's channels must spread over both survivors, they went to \${JSON.stringify(homes)}\`);
  ring.add('data-2:9000');
  assert(keys.every(k => ring.pick(k) === before.get(k)), 'adding the instance back must restore the exact previous mapping');
  ring.remove('data-1:9000');
  ring.remove('data-3:9000');
  assert(keys.slice(0, 20).every(k => ring.pick(k) === 'data-2:9000'), 'with one instance left every key goes to it');
}

export async function check_route_by_channel(ctx) {
  const m = await cluster(ctx);
  const homes = new Map<bigint, string>();
  for (const [i, channel] of CHANNELS.entries()) {
    const {page: got, call} = await fetch(ctx, m, channel);
    const owner = m.ring.pick(channel);
    assert.equal(call.target, owner, \`fetch_messages for channel \${channel} reached \${call.target}, but ring.pick says \${owner}: a channel's reads must go to the instance that owns it on the ring\`);
    const request = call.request as {channel_id: unknown; before: unknown; limit: unknown};
    assert.deepEqual([String(request.channel_id), String(request.before), Number(request.limit)], [String(channel), String(END), 50], \`the request must carry channel_id, before and limit as given, the data service received \${JSON.stringify(request)}\`);
    assert.deepEqual(got, page(i), \`fetch_messages must return the data service's page for channel \${channel} (\${JSON.stringify(page(i))}), got \${JSON.stringify(got)}\`);
    homes.set(channel, call.target);
  }
  assert(new Set(homes.values()).size >= 2, \`twelve channels all reached \${JSON.stringify([...new Set(homes.values())])}: the ring must spread channels over the instances\`);
  for (let n = 0; n < 3; n++) {
    const {call} = await fetch(ctx, m, CHANNELS[0]);
    assert.equal(call.target, homes.get(CHANNELS[0]), \`repeated reads of one channel must all reach the same instance: \${homes.get(CHANNELS[0])} first, then \${call.target}\`);
  }
  const gone = homes.get(CHANNELS[0])!;
  ctx.grpc.stop(gone); // the instance goes down; service discovery drops it from the ring
  m.ring.remove(gone);
  for (const [i, channel] of CHANNELS.entries()) {
    let got: string[];
    let call;
    try {
      ({page: got, call} = await fetch(ctx, m, channel));
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.fail(\`after \${gone} went down and left the ring, channel \${channel} failed with \${(e as {code?: number}).code}: its reads must follow the ring to a live instance\`);
    }
    assert.notEqual(call.target, gone, \`channel \${channel} still dialled \${gone} after it left the ring\`);
    if (homes.get(channel) !== gone) {
      assert.equal(call.target, homes.get(channel), \`channel \${channel} lived on \${homes.get(channel)}, which is still up, yet moved to \${call.target} when \${gone} left\`);
    }
    assert.equal(call.target, m.ring.pick(channel), \`channel \${channel} reached \${call.target}, but the ring now says \${m.ring.pick(channel)}\`);
    assert.deepEqual(got, page(i), \`the new owner must answer channel \${channel}'s real page \${JSON.stringify(page(i))}, got \${JSON.stringify(got)}\`);
  }
}

export async function check_deadline(ctx) {
  const m = await cluster(ctx);
  const channel = CHANNELS[1];
  const {page: got, call} = await fetch(ctx, m, channel);
  assert.deepEqual(got, page(1), \`expected channel \${channel}'s page \${JSON.stringify(page(1))}, got \${JSON.stringify(got)}\`);
  assert(call.timeout !== null && call.timeout !== undefined, 'GetMessages carries no deadline: a stalled data service would hold the API request forever');
  assert(0.25 <= call.timeout && call.timeout <= 0.35, \`the deadline must be 300 ms, the call carried \${call.timeout} s\`);
  const owner = call.target;
  ctx.grpc.setLatency('GetMessages', 2.0, owner); // that instance stalls for 2 s
  const started = ctx.clock.now();
  let rows: unknown[] | null = null;
  try {
    rows = await m.fetch_messages(channel, END, 50);
  } catch (e) {
    const code = (e as {code?: number}).code;
    assert.equal(code, status.DEADLINE_EXCEEDED, \`expected DEADLINE_EXCEEDED from the stalled instance, got \${code}\`);
  }
  assert(rows === null, \`\${owner} took 2 s to answer and fetch_messages waited \${((ctx.clock.now() - started) / 1000).toFixed(1)} s for \${rows?.length} messages: a data service slower than the deadline must surface DEADLINE_EXCEEDED\`);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 0.5, \`the API waited \${waited.toFixed(1)} s for a stalled instance, the deadline is 300 ms\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"discord/db"
	pb "discord/gen/messages"
	"leetbuild/harness"
)

const (
	rtBucketMs int64 = 10 * 24 * 3600 * 1000
	rtInsert         = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES ($1, $2, $3, $4, $5)"
	rtB        int64 = 430
)

func rtSnowflake(bucket, offsetMs int64) int64 {
	return ((bucket*rtBucketMs + offsetMs) << 22) | (1 << 17)
}

var rtEnd = rtSnowflake(rtB+1, rtBucketMs-1)

// rtChannels are twelve channels created in bucket rtB.
var rtChannels = func() []int64 {
	out := []int64{}
	for i := range 12 {
		out = append(out, rtSnowflake(rtB, int64(1000*i+1)))
	}
	return out
}()

// rtPage is what Postgres holds for rtChannels[i], newest first.
func rtPage(i int) []string {
	return []string{fmt.Sprintf("%d:2", i), fmt.Sprintf("%d:1", i), fmt.Sprintf("%d:0", i)}
}

func rtKeys(n int) []int64 {
	out := []int64{}
	for i := range n {
		out = append(out, rtSnowflake(425, int64(i)*4096*7919))
	}
	return out
}

func rtKey(channel int64) string { return strconv.FormatInt(channel, 10) }

// rtPeer is step 3's data service: the page walk over Postgres behind MessageData.GetMessages.
type rtPeer struct {
	pb.UnimplementedMessageDataServer
}

func (p *rtPeer) GetMessages(ctx context.Context, req *pb.GetMessagesRequest) (*pb.GetMessagesReply, error) {
	channel, before, limit := int64(req.GetChannelId()), int64(req.GetBefore()), int(req.GetLimit())
	reply := &pb.GetMessagesReply{}
	for bucket := (before >> 22) / rtBucketMs; len(reply.Messages) < limit && bucket >= (channel>>22)/rtBucketMs; bucket-- {
		rows, err := db.Query(ctx, "SELECT message_id, author_id, content FROM messages"+
			" WHERE channel_id = $1 AND bucket = $2 AND message_id < $3 ORDER BY message_id DESC LIMIT $4",
			channel, bucket, before, limit-len(reply.Messages))
		if err != nil {
			return nil, status.Error(codes.Unavailable, "messages store: "+err.Error())
		}
		for rows.Next() {
			var id, author int64
			var content string
			rows.Scan(&id, &author, &content)
			reply.Messages = append(reply.Messages, &pb.Message{Id: uint64(id), AuthorId: uint64(author), Content: content})
		}
		rows.Close()
	}
	return reply, nil
}

// rtCluster fills Postgres and serves the data service at every one of the learner's instances.
func rtCluster(ctx *harness.Ctx) {
	ctx.DB.Reset(db.Schema)
	for i, channel := range rtChannels {
		for j := range 3 {
			ctx.DB.Exec(rtInsert, channel, rtB, rtSnowflake(rtB, int64(1000*i+10+j)), 7, fmt.Sprintf("%d:%d", i, j))
		}
	}
	for _, node := range instances {
		pb.RegisterMessageDataServer(ctx.GRPC.Server(node), &rtPeer{})
	}
}

// rtFetch is fetchMessages for one channel: the contents it returned and the one GetMessages call it made.
func rtFetch(ctx *harness.Ctx, channel int64) ([]string, harness.Call, error) {
	n := len(ctx.GRPC.CallsTo("GetMessages", ""))
	rows, err := fetchMessages(context.Background(), channel, rtEnd, 50)
	if err != nil {
		return nil, harness.Call{}, err
	}
	calls := ctx.GRPC.CallsTo("GetMessages", "")[n:]
	ctx.Equal(len(calls), 1, "fetchMessages for channel %d must make one GetMessages call; calls", channel)
	page := []string{}
	for _, m := range rows {
		page = append(page, m.GetContent())
	}
	return page, calls[0], nil
}

// rtPoint is one virtual node of the ring the harness rebuilds by hand.
type rtPoint struct {
	pos  uint64
	node string
}

// rtPoints are the vnodes points hashed from node#i for every node, sorted by position.
func rtPoints(nodes []string) []rtPoint {
	points := []rtPoint{}
	for _, node := range nodes {
		for i := 0; i < vnodes; i++ {
			points = append(points, rtPoint{hashKey(fmt.Sprintf("%s#%d", node, i)), node})
		}
	}
	sort.SliceStable(points, func(a, b int) bool { return points[a].pos < points[b].pos })
	return points
}

// rtExpected is the clockwise rule applied by hand: the first point at or after hashKey(key), wrapping.
func rtExpected(points []rtPoint, key int64) string {
	h := hashKey(rtKey(key))
	i := sort.Search(len(points), func(i int) bool { return points[i].pos >= h })
	if i == len(points) {
		return points[0].node
	}
	return points[i].node
}

func rtPick(ctx *harness.Ctx, r *Ring, key int64) string {
	node, err := r.Pick(rtKey(key))
	ctx.NoError(err, "Pick(%d)", key)
	return node
}

func CheckVirtualNodes(ctx *harness.Ctx) {
	ctx.Assert(vnodes >= 50, "vnodes is %d: a handful of points per instance cannot split the ring evenly", vnodes)
	r := NewRing(instances...)
	keys := rtKeys(3000)
	shares := map[string]int{}
	for _, k := range keys {
		shares[rtPick(ctx, r, k)]++
	}
	owners := []string{}
	for node := range shares {
		owners = append(owners, node)
	}
	sort.Strings(owners)
	want := append([]string{}, instances...)
	sort.Strings(want)
	ctx.Equal(owners, want, "every instance must own part of the ring: instances the picks landed on")
	for node, n := range shares {
		share := float64(n) / float64(len(keys))
		ctx.Assert(0.2 <= share && share <= 0.5, "%s receives %.0f%% of 3000 channels; with vnodes points per instance the split should be close to a third each: %v", node, 100*share, shares)
	}
	only := NewRing("data-9:9000")
	for _, k := range keys[:50] {
		ctx.Equal(rtPick(ctx, only, k), "data-9:9000", "a ring with one instance picks it for every key")
	}
	_, err := NewRing().Pick(rtKey(rtChannels[0]))
	ctx.Assert(err != nil, "Pick on an empty ring must return an error: there is no instance to route to")
}

func CheckClockwisePick(ctx *harness.Ctx) {
	for _, nodes := range [][]string{instances, instances[:2], {"data-7:9000", "data-8:9000", "data-9:9000", "data-10:9000"}} {
		r := NewRing(nodes...)
		points := rtPoints(nodes)
		for _, key := range rtKeys(400) {
			want := rtExpected(points, key)
			ctx.Equal(rtPick(ctx, r, key), want, "Pick(%d) on %v: the first point at or after hashKey(key) among the vnodes points hashed from node#i, wrapping to the first point", key, nodes)
		}
	}
	reversed := []string{}
	for i := len(instances) - 1; i >= 0; i-- {
		reversed = append(reversed, instances[i])
	}
	a, b := NewRing(instances...), NewRing(reversed...)
	for _, k := range rtChannels {
		ctx.Assert(rtPick(ctx, a, k) == rtPick(ctx, b, k), "the mapping must not depend on the order instances were added")
	}
}

func CheckRemoveMinimal(ctx *harness.Ctx) {
	r := NewRing(instances...)
	keys := rtKeys(1500)
	before := map[int64]string{}
	for _, k := range keys {
		before[k] = rtPick(ctx, r, k)
	}
	r.Remove("data-2:9000")
	after := map[int64]string{}
	for _, k := range keys {
		after[k] = rtPick(ctx, r, k)
		ctx.Assert(after[k] != "data-2:9000", "a removed instance must receive nothing")
	}
	stayed, moved := 0, 0
	homes := map[string]bool{}
	for _, k := range keys {
		if before[k] != "data-2:9000" {
			stayed++
			if after[k] != before[k] {
				moved++
			}
		} else {
			homes[after[k]] = true
		}
	}
	ctx.Equal(moved, 0, "of %d channels that did not live on data-2, some changed instance when data-2 left: removing a node must drop only its own points; moved", stayed)
	got := []string{}
	for node := range homes {
		got = append(got, node)
	}
	sort.Strings(got)
	ctx.Equal(got, []string{"data-1:9000", "data-3:9000"}, "data-2's channels must spread over both survivors")
	r.Add("data-2:9000")
	for _, k := range keys {
		ctx.Assert(rtPick(ctx, r, k) == before[k], "adding the instance back must restore the exact previous mapping")
	}
	r.Remove("data-1:9000")
	r.Remove("data-3:9000")
	for _, k := range keys[:20] {
		ctx.Assert(rtPick(ctx, r, k) == "data-2:9000", "with one instance left every key goes to it")
	}
}

func CheckRouteByChannel(ctx *harness.Ctx) {
	rtCluster(ctx)
	homes := map[int64]string{}
	targets := map[string]bool{}
	for i, channel := range rtChannels {
		got, call, err := rtFetch(ctx, channel)
		ctx.NoError(err, "fetchMessages for channel %d", channel)
		owner := rtPick(ctx, ring, channel)
		ctx.Equal(call.Target, owner, "fetchMessages for channel %d must reach the instance ring.Pick names: a channel's reads must go to the instance that owns it on the ring", channel)
		req, _ := call.Request.(*pb.GetMessagesRequest)
		ctx.Assert(req != nil && req.GetChannelId() == uint64(channel) && req.GetBefore() == uint64(rtEnd) && req.GetLimit() == 50, "the request must carry channel_id %d, before %d and limit 50 as given, the data service received %v", channel, rtEnd, call.Request)
		ctx.Equal(got, rtPage(i), "fetchMessages must return the data service's page for channel %d", channel)
		homes[channel] = call.Target
		targets[call.Target] = true
	}
	ctx.Assert(len(targets) >= 2, "twelve channels all reached %v: the ring must spread channels over the instances", targets)
	for range 3 {
		_, call, err := rtFetch(ctx, rtChannels[0])
		ctx.NoError(err, "fetchMessages for channel %d", rtChannels[0])
		ctx.Equal(call.Target, homes[rtChannels[0]], "repeated reads of one channel must all reach the same instance")
	}
	gone := homes[rtChannels[0]]
	ctx.GRPC.Stop(gone) // the instance goes down; service discovery drops it from the ring
	ring.Remove(gone)
	for i, channel := range rtChannels {
		got, call, err := rtFetch(ctx, channel)
		if err != nil {
			ctx.Fatalf("after %s went down and left the ring, channel %d failed with %v: its reads must follow the ring to a live instance", gone, channel, status.Code(err))
		}
		ctx.Assert(call.Target != gone, "channel %d still dialled %s after it left the ring", channel, gone)
		if homes[channel] != gone {
			ctx.Equal(call.Target, homes[channel], "channel %d lived on %s, which is still up, yet moved when %s left", channel, homes[channel], gone)
		}
		ctx.Equal(call.Target, rtPick(ctx, ring, channel), "channel %d must reach the instance the ring now names", channel)
		ctx.Equal(got, rtPage(i), "the new owner must answer channel %d's real page", channel)
	}
}

func CheckDeadline(ctx *harness.Ctx) {
	rtCluster(ctx)
	channel := rtChannels[1]
	got, call, err := rtFetch(ctx, channel)
	ctx.NoError(err, "fetchMessages for channel %d", channel)
	ctx.Equal(got, rtPage(1), "expected channel %d's page", channel)
	ctx.Assert(call.HasDeadline(), "GetMessages carries no deadline: a stalled data service would hold the API request forever")
	timeout := call.Timeout.Seconds()
	ctx.Assert(0.25 <= timeout && timeout <= 0.35, "the deadline must be 300 ms, the call carried %.3f s", timeout)
	owner := call.Target
	ctx.GRPC.SetLatency("GetMessages", 2.0, owner) // that instance stalls for 2 s
	started := ctx.Clock.Now()
	rows, err := fetchMessages(context.Background(), channel, rtEnd, 50)
	if err != nil {
		ctx.Equal(status.Code(err), codes.DeadlineExceeded, "expected DEADLINE_EXCEEDED from the stalled instance")
	}
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(err != nil, "%s took 2 s to answer and fetchMessages waited %.1f s for %d messages: a data service slower than the deadline must surface DEADLINE_EXCEEDED", owner, waited, len(rows))
	ctx.Assert(waited <= 0.5, "the API waited %.1f s for a stalled instance, the deadline is 300 ms", waited)
}
`,
  },
  debrief: `Consistent hashing is the routing policy that makes coalescing worth having: the hash of the channel, not of the request, decides the instance, so the thousand clients opening one channel meet in one process and one of them pays for the database. Virtual nodes fix the two problems of a naive ring — three points split a circle very unevenly, and when one leaves its whole arc lands on a single neighbour; a hundred points per instance make the shares close to equal and spread a departure over every survivor. The guarantee that matters operationally is the minimal move: adding or losing an instance changes homes for only that instance's share of channels, so a deploy is a small cold spot rather than a cluster-wide one. Discord routes on the channel id for messages and on other keys for other services, each one chosen so that the requests that would coalesce share a key. Real routers get the instance list from service discovery, weight points by instance capacity, and hedge: when the owner fails fast with UNAVAILABLE, the next point clockwise is already the right fallback.`,
};
