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
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
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
	h := fnv.New64a()
	h.Write([]byte(key))
	return h.Sum64()
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
	"errors"
	"fmt"
	"hash/fnv"
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
	h := fnv.New64a()
	h.Write([]byte(key))
	return h.Sum64()
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
    python: `from collections import Counter

import grpc

import messages_pb2
import messages_pb2_grpc

EPOCH = 1420070400000
BUCKET_MS = 10 * 24 * 3600 * 1000


def sf(bucket, offset_ms=0):
    return ((bucket * BUCKET_MS + offset_ms) << 22) | (1 << 17)


END = sf(431, BUCKET_MS - 1)
CHANNELS = [sf(400 + i, 1000 * i) for i in range(12)]


class FakePeer(messages_pb2_grpc.MessageDataServicer):
    """A data service answering three messages just below the cursor; records every request."""

    def __init__(self):
        self.requests = []

    def GetMessages(self, request, context):
        self.requests.append(request)
        base = request.before - 1
        n = min(request.limit, 3)
        return messages_pb2.GetMessagesReply(messages=[messages_pb2.Message(id=base - i, author_id=7, content=f"m{i}") for i in range(n)])


def _client(ctx):
    peer = FakePeer()
    ctx.grpc.serve(messages_pb2_grpc.add_MessageDataServicer_to_server, peer)
    m = ctx.load("channel_routing")
    routed = []
    for name, stub in m.stubs.items():
        def wrapped(request, *args, _name=name, _original=stub.GetMessages, **kwargs):
            routed.append(_name)
            return _original(request, *args, **kwargs)

        stub.GetMessages = wrapped
    return m, peer, routed


def _expected(m, nodes, key):
    """The clockwise rule applied by hand: the first of the node#i points at or after _hash(str(key))."""
    points = sorted((m._hash(f"{node}#{i}"), node) for node in nodes for i in range(m.VNODES))
    h = m._hash(str(key))
    for position, node in points:
        if position >= h:
            return node
    return points[0][1]


def check_virtual_nodes(ctx):
    m, peer, routed = _client(ctx)
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
    m, peer, routed = _client(ctx)
    for nodes in (m.INSTANCES, m.INSTANCES[:2], ["data-7:9000", "data-8:9000", "data-9:9000", "data-10:9000"]):
        ring = m.Ring(nodes)
        for key in [sf(425, i * 4096 * 7919) for i in range(400)]:
            expected = _expected(m, nodes, key)
            got = ring.pick(key)
            assert got == expected, f"pick({key}) on {nodes} returned {got}, expected {expected}: the first point at or after _hash(str(key)) among the VNODES points hashed from node#i, wrapping to the first point"
    a, b = m.Ring(m.INSTANCES), m.Ring(list(reversed(m.INSTANCES)))
    assert all(a.pick(k) == b.pick(k) for k in CHANNELS), "the mapping must not depend on the order instances were added"


def check_remove_minimal(ctx):
    m, peer, routed = _client(ctx)
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
    m, peer, routed = _client(ctx)
    used = set()
    for channel in CHANNELS:
        rows = await m.fetch_messages(channel, END, 50)
        expected = m.ring.pick(channel)
        assert routed and routed[-1] == expected, f"fetch_messages for channel {channel} called {routed[-1] if routed else 'no stub'}, but ring.pick says {expected}"
        used.add(routed[-1])
        request = peer.requests[-1]
        assert (request.channel_id, request.before, request.limit) == (channel, END, 50), f"the request must carry channel_id, before and limit as given: {request}"
        assert [x.id for x in rows] == [END - 1, END - 2, END - 3], f"fetch_messages must return the reply's messages, got {[x.id for x in rows]}"
    assert len(used) >= 2, f"twelve channels all went to {used}: the ring must spread channels over the instances"
    for _ in range(3):
        await m.fetch_messages(CHANNELS[0], END, 50)
    assert len(set(routed[-3:])) == 1 and routed[-1] == m.ring.pick(CHANNELS[0]), "repeated reads of one channel must all reach the same instance"
    m.ring.remove(m.ring.pick(CHANNELS[0]))
    await m.fetch_messages(CHANNELS[0], END, 50)
    assert routed[-1] == m.ring.pick(CHANNELS[0]), "after its instance left, the channel's reads must follow the ring to the new owner"


async def check_deadline(ctx):
    m, peer, routed = _client(ctx)
    await m.fetch_messages(CHANNELS[1], END, 50)
    call = ctx.grpc.calls_to("GetMessages")[-1]
    assert call.timeout is not None, "GetMessages carries no deadline: a stalled data service would hold the API request forever"
    assert 0.25 <= call.timeout <= 0.35, f"the deadline must be 300 ms, got {call.timeout} s"
    ctx.grpc.set_latency("GetMessages", 2.0)
    try:
        rows = await m.fetch_messages(CHANNELS[1], END, 50)
        raise AssertionError(f"a data service slower than the deadline must surface DEADLINE_EXCEEDED, fetch_messages returned {rows}")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.DEADLINE_EXCEEDED, f"expected DEADLINE_EXCEEDED, got {e.code()}"
`,
  },
  debrief: `Consistent hashing is the routing policy that makes coalescing worth having: the hash of the channel, not of the request, decides the instance, so the thousand clients opening one channel meet in one process and one of them pays for the database. Virtual nodes fix the two problems of a naive ring — three points split a circle very unevenly, and when one leaves its whole arc lands on a single neighbour; a hundred points per instance make the shares close to equal and spread a departure over every survivor. The guarantee that matters operationally is the minimal move: adding or losing an instance changes homes for only that instance's share of channels, so a deploy is a small cold spot rather than a cluster-wide one. Discord routes on the channel id for messages and on other keys for other services, each one chosen so that the requests that would coalesce share a key. Real routers get the instance list from service discovery, weight points by instance capacity, and hedge: when the owner fails fast with UNAVAILABLE, the next point clockwise is already the right fallback.`,
};
