import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Allocate a server, or put the roster back in the pool',
  concept: 'grpc',
  file: 'client',
  focus: ['matchmaker', 'allocator', 'redis'],
  task: `## Task

**Starting point.** The starter is the allocator client the matchmaker calls after a roster is
claimed (step 2) and recorded with \`store.create_match\`. \`allocate_match(match_id)\` calls
\`Allocate\` up to \`MAX_ALLOC_ATTEMPTS\` (3) times, asking again at once after any error, and on
success records the server with \`store.set_server\`; \`release_roster(match_id)\` puts each ticket of
the match back: \`state=waiting\`, \`ZADD pool:{bucket}\`, \`pool:depth\` +1. It places matches while
the fleet is healthy and hides 4 flaws.

**Failure mode the checks target.** A hung allocator holds the matchmaker for as long as it likes. A
busy fleet gets three calls in the same millisecond, and a full fleet is asked twice more. When the
attempts run out the roster stays claimed: its players wait in neither the pool nor a game. And a
release that runs twice (a retry, a second matchmaker cleaning up) counts the tickets back twice.

\`\`\`proto
service Allocator { rpc Allocate(AllocateRequest) returns (Allocation); }  // RESOURCE_EXHAUSTED: no free server
\`\`\`

- Every call carries \`ALLOCATOR_DEADLINE_S\` (3 s).
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried, after \`BACKOFF_BASE_S\` (0.25 s) ×
  2^attempt; any other code ends the attempts.
- No server: \`release_roster\`, then \`store.abandon(match_id, "allocation_failed")\`, return \`None\`.
- \`release_roster\` is one Lua script guarded by \`SET released:{match_id} 1 NX EX 3600\`: it returns
  each ticket still claimed by this match and answers \`False\` when the match was released before.`,
  sequence: {
    participants: ['Matchmaker', 'Game server allocator', 'Redis'],
    messages: [
      {from: 'Matchmaker', to: 'Game server allocator', label: 'Allocate(m-1) · deadline 3 s', kind: 'sync'},
      {from: 'Game server allocator', to: 'Matchmaker', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Matchmaker', to: 'Matchmaker', label: 'sleep 0.25 s, then 0.5 s', kind: 'sync'},
      {from: 'Matchmaker', to: 'Game server allocator', label: 'Allocate(m-1) · attempt 2, 3', kind: 'sync'},
      {from: 'Game server allocator', to: 'Matchmaker', label: 'gs-17 · or no server', kind: 'reply'},
      {
        from: 'Matchmaker',
        to: 'Redis',
        label: 'EVAL release: SET released:m-1 NX · ZADD · HSET waiting · HINCRBY',
        kind: 'sync',
      },
      {from: 'Matchmaker', to: 'Redis', label: 'abandon(m-1, "allocation_failed")', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Allocate call carries a 3-second deadline',
      detail:
        "Each attempt is made with `ALLOCATOR_DEADLINE_S` (3 s), so an allocator that does not answer costs the matchmaker seconds, not the allocator's whole stall.",
      match: {
        python: {
          all: [/ALLOCATOR_DEADLINE_S\s*=\s*3\b/, /\.Allocate\([\s\S]{0,120}?timeout\s*=\s*ALLOCATOR_DEADLINE_S/],
        },
        typescript: {
          all: [/ALLOCATOR_DEADLINE_MS\s*=\s*3000\b/, /\.Allocate\([\s\S]{0,200}?deadline:[^\n]*ALLOCATOR_DEADLINE_MS/],
        },
        go: {all: [/allocatorDeadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*allocatorDeadline\)/]},
        scala: {all: [/AllocatorDeadlineMs\s*=\s*3000L?\b/, /withDeadlineAfter\(\s*AllocatorDeadlineMs/]},
        cpp: {all: [/kAllocatorDeadline\{3\}/, /set_deadline\([^\n]*kAllocatorDeadline\)/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries a busy fleet with backoff, never a full one',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried, each after an exponential backoff from `BACKOFF_BASE_S`; `RESOURCE_EXHAUSTED` ends the attempts at once.',
      match: {
        python: {
          all: [/time\.sleep\(/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/except grpc\.RpcError:\s*\n\s*continue/],
        },
        typescript: {all: [/setTimeout\(/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        go: {all: [/time\.Sleep\(/, /codes\.Unavailable/, /codes\.DeadlineExceeded/]},
        scala: {all: [/Thread\.sleep\(/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/sleep_for\(/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'release-on-failure',
      title: 'No server: the roster goes back to the pool',
      detail:
        'When the attempts end without a server, `allocate_match` calls `release_roster` and `store.abandon(match_id, "allocation_failed")`, so every player waits in the pool again.',
      match: {
        python: {order: [/def allocate_match/, /release_roster\(/, /store\.abandon\(/]},
        typescript: {order: [/function allocateMatch/, /releaseRoster\(/, /abandon\(/]},
        go: {order: [/func allocateMatch/, /releaseRoster\(/, /store\.Abandon\(/]},
        scala: {order: [/def allocateMatch/, /releaseRoster\(/, /Store\.abandon\(/]},
        cpp: {order: [/allocateMatch\(const std::string& match_id\)\s*\{/, /releaseRoster\(/, /store::abandon\(/]},
      },
    },
    {
      id: 'idempotent-release',
      title: 'A roster is released once',
      detail:
        '`release_roster` is one script guarded by `SET released:{match_id} … NX`, returning only tickets this match still holds; a second release answers `False` and changes nothing.',
      match: {
        python: {all: [/released:/, /['"]NX['"]/, /register_script\(|\.eval\(/], none: [/\br\.(zadd|hincrby)\(/]},
        typescript: {all: [/released:/, /['"]NX['"]/, /\.eval\(|defineCommand\(/], none: [/redis\.(zadd|hincrby)\(/]},
        go: {all: [/released:/, /['"]NX['"]/, /redis\.NewScript\(|\.Eval\(/], none: [/rdb\.(ZAdd|HIncrBy)\(/]},
        scala: {all: [/released:/, /['"]NX['"]/, /jedis\.eval(sha)?\(/], none: [/jedis\.(zadd|hincrBy)\(/]},
        cpp: {all: [/released:/, /['"]NX['"]/, /redis\.eval(sha)?[<(]/], none: [/redis\.(zadd|hincrby)\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Allocator client: a game server for a claimed roster."""
import grpc
import redis

import game_matchmaking_pb2
import game_matchmaking_pb2_grpc
from matchmaking import store  # get_match, get_ticket, set_server, abandon, ticket_key, pool_key, DEPTH_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)
allocator = game_matchmaking_pb2_grpc.AllocatorStub(grpc.insecure_channel("allocator:9000"))

MAX_ALLOC_ATTEMPTS = 3


def release_roster(match_id: str) -> bool:
    """Put every ticket of the match back in its pool; True when this call released it."""
    match = store.get_match(match_id)
    for ticket_id in match["tickets"]:
        ticket = store.get_ticket(ticket_id)
        r.hset(store.ticket_key(ticket_id), mapping={"state": "waiting", "match_id": ""})
        r.zadd(store.pool_key(ticket["bucket"]), {ticket_id: ticket["skill"]})
        r.hincrby(store.DEPTH_KEY, str(ticket["bucket"]), 1)
    return True


def allocate_match(match_id: str) -> str | None:
    """Reserve a game server for the claimed roster: its server id, or None when the match cannot be placed."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    match = store.get_match(match_id)
    request = game_matchmaking_pb2.AllocateRequest(match_id=match_id, players=match["players"])
    for attempt in range(MAX_ALLOC_ATTEMPTS):
        try:
            allocation = allocator.Allocate(request)
        except grpc.RpcError:
            continue  # the fleet is busy: ask again
        store.set_server(match_id, allocation.server_id)
        return allocation.server_id
    return None
`,
      solution: `"""Allocator client: a game server for a claimed roster, or the roster back in the pool."""
import time

import grpc
import redis

import game_matchmaking_pb2
import game_matchmaking_pb2_grpc
from matchmaking import store  # get_match, get_ticket, set_server, abandon, ticket_key, pool_key, DEPTH_KEY

r = redis.Redis(host="redis", port=6379, decode_responses=True)
allocator = game_matchmaking_pb2_grpc.AllocatorStub(grpc.insecure_channel("allocator:9000"))

ALLOCATOR_DEADLINE_S = 3
MAX_ALLOC_ATTEMPTS = 3
BACKOFF_BASE_S = 0.25
RELEASED_TTL_S = 3600
# A busy or slow fleet may have a server a moment later; RESOURCE_EXHAUSTED and the rest will not.
TRANSIENT = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

# KEYS: released:{match}, pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket, guard TTL.
# The guard makes a second release a no-op; the match_id test skips a ticket another match took since.
RELEASE_LUA = """
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3]) then return 0 end
local released = 0
for i = 4, #KEYS do
  if redis.call('HGET', KEYS[i], 'match_id') == ARGV[1] then
    redis.call('HSET', KEYS[i], 'state', 'waiting', 'match_id', '')
    redis.call('ZADD', KEYS[2], redis.call('HGET', KEYS[i], 'skill'), redis.call('HGET', KEYS[i], 'ticket_id'))
    released = released + 1
  end
end
redis.call('HINCRBY', KEYS[3], ARGV[2], released)
return 1
"""
release = r.register_script(RELEASE_LUA)


def release_roster(match_id: str) -> bool:
    """Put every ticket of the match back in its pool; True when this call released it."""
    match = store.get_match(match_id)
    keys = [f"released:{match_id}", store.pool_key(match["bucket"]), store.DEPTH_KEY]
    keys += [store.ticket_key(t) for t in match["tickets"]]
    return release(keys=keys, args=[match_id, match["bucket"], RELEASED_TTL_S]) == 1


def allocate_match(match_id: str) -> str | None:
    """Reserve a game server for the claimed roster: its server id, or None when the match cannot be placed."""
    match = store.get_match(match_id)
    request = game_matchmaking_pb2.AllocateRequest(match_id=match_id, players=match["players"])
    for attempt in range(MAX_ALLOC_ATTEMPTS):
        try:
            allocation = allocator.Allocate(request, timeout=ALLOCATOR_DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in TRANSIENT or attempt == MAX_ALLOC_ATTEMPTS - 1:
                break
            time.sleep(BACKOFF_BASE_S * 2**attempt)
            continue
        store.set_server(match_id, allocation.server_id)
        return allocation.server_id
    # No server: the players go back to the pool instead of waiting on a match that never starts.
    release_roster(match_id)
    store.abandon(match_id, "allocation_failed")
    return None
`,
    },
    typescript: {
      starter: `/** Allocator client: a game server for a claimed roster. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {DEPTH_KEY, getMatch, getTicket, poolKey, setServer, ticketKey} from 'matchmaking/store';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_ALLOC_ATTEMPTS = 3;

interface AllocateRequest {
  match_id: string;
  players: string[];
}

interface Allocation {
  server_id: string;
  address: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('game_matchmaking.proto')) as unknown as {
  matchmakerd: {Allocator: grpc.ServiceClientConstructor};
};
const allocator = new pkg.matchmakerd.Allocator('allocator:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Allocate(request: AllocateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Allocation>;
};

/** Put every ticket of the match back in its pool; true when this call released it. */
export async function releaseRoster(matchId: string): Promise<boolean> {
  const match = await getMatch(matchId);
  for (const ticketId of match?.tickets ?? []) {
    const ticket = await getTicket(ticketId);
    if (ticket === null) continue;
    await redis.hset(ticketKey(ticketId), {state: 'waiting', match_id: ''});
    await redis.zadd(poolKey(ticket.bucket), ticket.skill, ticketId);
    await redis.hincrby(DEPTH_KEY, String(ticket.bucket), 1);
  }
  return true;
}

/** Reserve a game server for the claimed roster: its server id, or null when the match cannot be placed. */
export async function allocateMatch(matchId: string): Promise<string | null> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const match = await getMatch(matchId);
  const request = {match_id: matchId, players: match?.players ?? []};
  for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt++) {
    try {
      const allocation = await allocator.Allocate(request, new grpc.Metadata(), {});
      await setServer(matchId, allocation.server_id);
      return allocation.server_id;
    } catch {
      continue; // the fleet is busy: ask again
    }
  }
  return null;
}
`,
      solution: `/** Allocator client: a game server for a claimed roster, or the roster back in the pool. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {DEPTH_KEY, abandon, getMatch, poolKey, setServer, ticketKey} from 'matchmaking/store';

const redis = new Redis({host: 'redis', port: 6379});

export const ALLOCATOR_DEADLINE_MS = 3000;
export const MAX_ALLOC_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 250;
export const RELEASED_TTL_S = 3600;
/** A busy or slow fleet may have a server a moment later; RESOURCE_EXHAUSTED and the rest will not. */
const TRANSIENT: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface AllocateRequest {
  match_id: string;
  players: string[];
}

interface Allocation {
  server_id: string;
  address: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('game_matchmaking.proto')) as unknown as {
  matchmakerd: {Allocator: grpc.ServiceClientConstructor};
};
const allocator = new pkg.matchmakerd.Allocator('allocator:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Allocate(request: AllocateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Allocation>;
};

/**
 * KEYS: released:{match}, pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket, guard TTL.
 * The guard makes a second release a no-op; the match_id test skips a ticket another match took since.
 */
export const RELEASE_LUA = \`
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3]) then return 0 end
local released = 0
for i = 4, #KEYS do
  if redis.call('HGET', KEYS[i], 'match_id') == ARGV[1] then
    redis.call('HSET', KEYS[i], 'state', 'waiting', 'match_id', '')
    redis.call('ZADD', KEYS[2], redis.call('HGET', KEYS[i], 'skill'), redis.call('HGET', KEYS[i], 'ticket_id'))
    released = released + 1
  end
end
redis.call('HINCRBY', KEYS[3], ARGV[2], released)
return 1
\`;

/** Put every ticket of the match back in its pool; true when this call released it. */
export async function releaseRoster(matchId: string): Promise<boolean> {
  const match = await getMatch(matchId);
  if (match === null) return false;
  const keys = [\`released:\${matchId}\`, poolKey(match.bucket), DEPTH_KEY, ...match.tickets.map(ticketKey)];
  return (await redis.eval(RELEASE_LUA, keys.length, ...keys, matchId, String(match.bucket), String(RELEASED_TTL_S))) === 1;
}

/** Reserve a game server for the claimed roster: its server id, or null when the match cannot be placed. */
export async function allocateMatch(matchId: string): Promise<string | null> {
  const match = await getMatch(matchId);
  const request = {match_id: matchId, players: match?.players ?? []};
  for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt++) {
    try {
      const allocation = await allocator.Allocate(request, new grpc.Metadata(), {deadline: Date.now() + ALLOCATOR_DEADLINE_MS});
      await setServer(matchId, allocation.server_id);
      return allocation.server_id;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (!TRANSIENT.includes(code) || attempt === MAX_ALLOC_ATTEMPTS - 1) break;
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, BACKOFF_BASE_MS * 2 ** attempt);
      await promise;
    }
  }
  // No server: the players go back to the pool instead of waiting on a match that never starts.
  await releaseRoster(matchId);
  await abandon(matchId, 'allocation_failed');
  return null;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "matchmaking/gen/game_matchmaking"
	"matchmaking/store" // store.GetMatch, GetTicket, SetServer, Abandon, TicketKey, PoolKey, DepthKey
)

const maxAllocAttempts = 3

var (
	rdb              = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	allocatorConn, _ = grpc.NewClient("allocator:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	allocator        = pb.NewAllocatorClient(allocatorConn)
)

// releaseRoster puts every ticket of the match back in its pool; true when this call released it.
func releaseRoster(ctx context.Context, matchID string) (bool, error) {
	m := store.GetMatch(ctx, matchID)
	if m == nil {
		return false, nil
	}
	for _, ticketID := range m.Tickets {
		t := store.GetTicket(ctx, ticketID)
		rdb.HSet(ctx, store.TicketKey(ticketID), "state", "waiting", "match_id", "")
		rdb.ZAdd(ctx, store.PoolKey(t.Bucket), redis.Z{Score: float64(t.Skill), Member: ticketID})
		rdb.HIncrBy(ctx, store.DepthKey, strconv.Itoa(t.Bucket), 1)
	}
	return true, nil
}

// allocateMatch reserves a game server for the claimed roster: its server id, or "" when the match cannot be placed.
func allocateMatch(ctx context.Context, matchID string) (string, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	m := store.GetMatch(ctx, matchID)
	req := &pb.AllocateRequest{MatchId: matchID, Players: m.Players}
	for attempt := 0; attempt < maxAllocAttempts; attempt++ {
		allocation, err := allocator.Allocate(ctx, req)
		if err != nil {
			continue // the fleet is busy: ask again
		}
		store.SetServer(ctx, matchID, allocation.GetServerId())
		return allocation.GetServerId(), nil
	}
	return "", nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "matchmaking/gen/game_matchmaking"
	"matchmaking/store" // store.GetMatch, GetTicket, SetServer, Abandon, TicketKey, PoolKey, DepthKey
)

const (
	allocatorDeadline = 3 * time.Second
	maxAllocAttempts  = 3
	backoffBase       = 250 * time.Millisecond
	releasedTTLS      = 3600
)

var (
	rdb              = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	allocatorConn, _ = grpc.NewClient("allocator:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	allocator        = pb.NewAllocatorClient(allocatorConn)
)

// KEYS: released:{match}, pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket, guard TTL.
// The guard makes a second release a no-op; the match_id test skips a ticket another match took since.
var releaseScript = redis.NewScript(\`
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3]) then return 0 end
local released = 0
for i = 4, #KEYS do
  if redis.call('HGET', KEYS[i], 'match_id') == ARGV[1] then
    redis.call('HSET', KEYS[i], 'state', 'waiting', 'match_id', '')
    redis.call('ZADD', KEYS[2], redis.call('HGET', KEYS[i], 'skill'), redis.call('HGET', KEYS[i], 'ticket_id'))
    released = released + 1
  end
end
redis.call('HINCRBY', KEYS[3], ARGV[2], released)
return 1
\`)

// releaseRoster puts every ticket of the match back in its pool; true when this call released it.
func releaseRoster(ctx context.Context, matchID string) (bool, error) {
	m := store.GetMatch(ctx, matchID)
	if m == nil {
		return false, nil
	}
	keys := []string{"released:" + matchID, store.PoolKey(m.Bucket), store.DepthKey}
	for _, t := range m.Tickets {
		keys = append(keys, store.TicketKey(t))
	}
	n, err := releaseScript.Run(ctx, rdb, keys, matchID, strconv.Itoa(m.Bucket), releasedTTLS).Int64()
	return n == 1, err
}

// allocateMatch reserves a game server for the claimed roster: its server id, or "" when the match cannot be placed.
func allocateMatch(ctx context.Context, matchID string) (string, error) {
	m := store.GetMatch(ctx, matchID)
	req := &pb.AllocateRequest{MatchId: matchID, Players: m.Players}
	for attempt := 0; attempt < maxAllocAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, allocatorDeadline)
		allocation, err := allocator.Allocate(callCtx, req)
		cancel()
		if err == nil {
			store.SetServer(ctx, matchID, allocation.GetServerId())
			return allocation.GetServerId(), nil
		}
		// A busy or slow fleet may have a server a moment later; ResourceExhausted and the rest will not.
		code := status.Code(err)
		if (code != codes.Unavailable && code != codes.DeadlineExceeded) || attempt == maxAllocAttempts-1 {
			break
		}
		time.Sleep(backoffBase << attempt)
	}
	// No server: the players go back to the pool instead of waiting on a match that never starts.
	if _, err := releaseRoster(ctx, matchID); err != nil {
		return "", err
	}
	store.Abandon(ctx, matchID, "allocation_failed")
	return "", nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import matchmakerd.game_matchmaking.{AllocateRequest, AllocatorGrpc}
import matchmaking.Store // Store.getMatch, getTicket, setServer, abandon, ticketKey, poolKey, DepthKey

object Client {
  val MaxAllocAttempts = 3

  private val jedis = new JedisPooled("redis", 6379)
  private val allocator = AllocatorGrpc.blockingStub(ManagedChannelBuilder.forAddress("allocator", 9000).usePlaintext().build())

  /** Put every ticket of the match back in its pool; true when this call released it. */
  def releaseRoster(matchId: String): Boolean = {
    Store.getMatch(matchId).toSeq.flatMap(_.tickets).foreach { ticketId =>
      Store.getTicket(ticketId).foreach { t =>
        jedis.hset(Store.ticketKey(ticketId), Map("state" -> "waiting", "match_id" -> "").asJava)
        jedis.zadd(Store.poolKey(t.bucket), t.skill.toDouble, ticketId)
        jedis.hincrBy(Store.DepthKey, t.bucket.toString, 1L)
      }
    }
    true
  }

  /** Reserve a game server for the claimed roster: its server id, or None when the match cannot be placed. */
  def allocateMatch(matchId: String): Option[String] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val request = AllocateRequest(matchId, Store.getMatch(matchId).map(_.players).getOrElse(Seq.empty))
    val serverId = Iterator.range(0, MaxAllocAttempts).map { _ =>
      try Some(allocator.allocate(request).serverId)
      catch { case _: StatusRuntimeException => None } // the fleet is busy: ask again
    }.collectFirst { case Some(id) => id }
    serverId.foreach(Store.setServer(matchId, _))
    serverId
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import matchmakerd.game_matchmaking.{AllocateRequest, AllocatorGrpc}
import matchmaking.Store // Store.getMatch, getTicket, setServer, abandon, ticketKey, poolKey, DepthKey

object Client {
  val AllocatorDeadlineMs = 3000L
  val MaxAllocAttempts = 3
  val BackoffBaseMs = 250L
  val ReleasedTtlS = 3600L
  /** A busy or slow fleet may have a server a moment later; RESOURCE_EXHAUSTED and the rest will not. */
  private val Transient = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val jedis = new JedisPooled("redis", 6379)
  private val allocator = AllocatorGrpc.blockingStub(ManagedChannelBuilder.forAddress("allocator", 9000).usePlaintext().build())

  /**
   * KEYS: released:{match}, pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket, guard TTL.
   * The guard makes a second release a no-op; the match_id test skips a ticket another match took since.
   */
  val ReleaseLua: String =
    """if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3]) then return 0 end
      |local released = 0
      |for i = 4, #KEYS do
      |  if redis.call('HGET', KEYS[i], 'match_id') == ARGV[1] then
      |    redis.call('HSET', KEYS[i], 'state', 'waiting', 'match_id', '')
      |    redis.call('ZADD', KEYS[2], redis.call('HGET', KEYS[i], 'skill'), redis.call('HGET', KEYS[i], 'ticket_id'))
      |    released = released + 1
      |  end
      |end
      |redis.call('HINCRBY', KEYS[3], ARGV[2], released)
      |return 1
      |""".stripMargin

  /** Put every ticket of the match back in its pool; true when this call released it. */
  def releaseRoster(matchId: String): Boolean = Store.getMatch(matchId) match {
    case None => false
    case Some(m) =>
      val keys = Seq(s"released:$matchId", Store.poolKey(m.bucket), Store.DepthKey) ++ m.tickets.map(Store.ticketKey)
      val args = Seq(matchId, m.bucket.toString, ReleasedTtlS.toString)
      jedis.eval(ReleaseLua, keys.asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** Reserve a game server for the claimed roster: its server id, or None when the match cannot be placed. */
  def allocateMatch(matchId: String): Option[String] = {
    val request = AllocateRequest(matchId, Store.getMatch(matchId).map(_.players).getOrElse(Seq.empty))
    def attempt(n: Int): Option[String] =
      try Some(allocator.withDeadlineAfter(AllocatorDeadlineMs, TimeUnit.MILLISECONDS).allocate(request).serverId)
      catch {
        case e: StatusRuntimeException if Transient.contains(e.getStatus.getCode) && n + 1 < MaxAllocAttempts =>
          Thread.sleep(BackoffBaseMs << n)
          attempt(n + 1)
        case _: StatusRuntimeException => None
      }
    attempt(0) match {
      case Some(serverId) =>
        Store.setServer(matchId, serverId)
        Some(serverId)
      case None =>
        // No server: the players go back to the pool instead of waiting on a match that never starts.
        releaseRoster(matchId)
        Store.abandon(matchId, "allocation_failed")
        None
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

#include "game_matchmaking.grpc.pb.h"
#include "matchmaking/store.h"  // store::getMatch, getTicket, setServer, abandon, ticketKey, poolKey, kDepthKey

constexpr int kMaxAllocAttempts = 3;

sw::redis::Redis redis("tcp://redis:6379");
auto allocator = matchmakerd::Allocator::NewStub(grpc::CreateChannel("allocator:9000", grpc::InsecureChannelCredentials()));

// Put every ticket of the match back in its pool; true when this call released it.
bool releaseRoster(const std::string& match_id) {
  const auto m = store::getMatch(match_id);
  if (!m) return false;
  for (const std::string& ticket_id : m->tickets) {
    const auto t = store::getTicket(ticket_id);
    if (!t) continue;
    redis.hset(store::ticketKey(ticket_id), {{"state", "waiting"}, {"match_id", ""}});
    redis.zadd(store::poolKey(t->bucket), ticket_id, static_cast<double>(t->skill));
    redis.hincrby(store::kDepthKey, std::to_string(t->bucket), 1);
  }
  return true;
}

// Reserve a game server for the claimed roster: its server id, or none when the match cannot be placed.
std::optional<std::string> allocateMatch(const std::string& match_id) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto m = store::getMatch(match_id);
  matchmakerd::AllocateRequest request;
  request.set_match_id(match_id);
  for (const std::string& p : m ? m->players : std::vector<std::string>{}) request.add_players(p);
  for (int attempt = 0; attempt < kMaxAllocAttempts; attempt++) {
    grpc::ClientContext ctx;
    matchmakerd::Allocation allocation;
    if (!allocator->Allocate(&ctx, request, &allocation).ok()) continue;  // the fleet is busy: ask again
    store::setServer(match_id, allocation.server_id());
    return allocation.server_id();
  }
  return std::nullopt;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "game_matchmaking.grpc.pb.h"
#include "matchmaking/store.h"  // store::getMatch, getTicket, setServer, abandon, ticketKey, poolKey, kDepthKey

constexpr std::chrono::seconds kAllocatorDeadline{3};
constexpr int kMaxAllocAttempts = 3;
constexpr std::chrono::milliseconds kBackoffBase{250};
constexpr long kReleasedTtlS = 3600;

sw::redis::Redis redis("tcp://redis:6379");
auto allocator = matchmakerd::Allocator::NewStub(grpc::CreateChannel("allocator:9000", grpc::InsecureChannelCredentials()));

// KEYS: released:{match}, pool:{bucket}, pool:depth, ticket:{id}…; ARGV: match id, bucket, guard TTL.
// The guard makes a second release a no-op; the match_id test skips a ticket another match took since.
const std::string kReleaseLua = R"lua(
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3]) then return 0 end
local released = 0
for i = 4, #KEYS do
  if redis.call('HGET', KEYS[i], 'match_id') == ARGV[1] then
    redis.call('HSET', KEYS[i], 'state', 'waiting', 'match_id', '')
    redis.call('ZADD', KEYS[2], redis.call('HGET', KEYS[i], 'skill'), redis.call('HGET', KEYS[i], 'ticket_id'))
    released = released + 1
  end
end
redis.call('HINCRBY', KEYS[3], ARGV[2], released)
return 1
)lua";

// Put every ticket of the match back in its pool; true when this call released it.
bool releaseRoster(const std::string& match_id) {
  const auto m = store::getMatch(match_id);
  if (!m) return false;
  std::vector<std::string> keys = {"released:" + match_id, store::poolKey(m->bucket), store::kDepthKey};
  for (const std::string& t : m->tickets) keys.push_back(store::ticketKey(t));
  const std::vector<std::string> args = {match_id, std::to_string(m->bucket), std::to_string(kReleasedTtlS)};
  return redis.eval<long long>(kReleaseLua, keys, args) == 1;
}

// Reserve a game server for the claimed roster: its server id, or none when the match cannot be placed.
std::optional<std::string> allocateMatch(const std::string& match_id) {
  const auto m = store::getMatch(match_id);
  matchmakerd::AllocateRequest request;
  request.set_match_id(match_id);
  for (const std::string& p : m ? m->players : std::vector<std::string>{}) request.add_players(p);
  for (int attempt = 0; attempt < kMaxAllocAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kAllocatorDeadline);
    matchmakerd::Allocation allocation;
    const grpc::Status status = allocator->Allocate(&ctx, request, &allocation);
    if (status.ok()) {
      store::setServer(match_id, allocation.server_id());
      return allocation.server_id();
    }
    // A busy or slow fleet may have a server a moment later; RESOURCE_EXHAUSTED and the rest will not.
    const bool transient = status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!transient || attempt == kMaxAllocAttempts - 1) break;
    std::this_thread::sleep_for(kBackoffBase * (1 << attempt));
  }
  // No server: the players go back to the pool instead of waiting on a match that never starts.
  releaseRoster(match_id);
  store::abandon(match_id, "allocation_failed");
  return std::nullopt;
}
`,
    },
  },
  harness: {
    python: `import grpc

import game_matchmaking_pb2
import game_matchmaking_pb2_grpc
from matchmaking import claims, store


class Allocator(game_matchmaking_pb2_grpc.AllocatorServicer):
    """A healthy fleet: every match gets gs-{match id}."""

    def Allocate(self, request, context):
        return game_matchmaking_pb2.Allocation(server_id=f"gs-{request.match_id}", address="10.0.0.7:7777")


def _client(ctx):
    ctx.grpc.serve(game_matchmaking_pb2_grpc.add_AllocatorServicer_to_server, Allocator())
    return ctx.load("client")


def _claimed(match_id, tickets):
    """Queue the tickets in pool:15 (t1 is a party of p1 and p2), claim them for match_id, record the match."""
    for ticket_id in tickets:
        n = int(ticket_id[1:])
        participants = ["p1", "p2"] if n == 1 else [f"p{n + 1}"]
        store.enqueue(ticket_id, participants[0], 1500 + n, participants)
    assert claims.claim_tickets(match_id, 15, tickets), f"setup: claiming {tickets} for {match_id} failed"
    store.create_match(match_id, 15, tickets)


def _pool(ctx):
    return dict(ctx.redis.zrange("pool:15", 0, -1, withscores=True))


def _depth(ctx):
    return int(ctx.redis.hget("pool:depth", "15") or 0)


def check_deadline(ctx):
    m = _client(ctx)
    _claimed("m-1", ["t1", "t2"])
    assert m.allocate_match("m-1") == "gs-m-1", "with a healthy fleet the match must be placed on gs-m-1"
    for call in ctx.grpc.calls_to("Allocate"):
        assert call.timeout is not None, "an Allocate call carries no deadline: a stalled allocator holds the matchmaker as long as it stalls"
        assert 2.5 <= call.timeout <= 3.5, f"an Allocate call carries a {call.timeout} s deadline, expected ALLOCATOR_DEADLINE_S = 3"
    _claimed("m-2", ["t3"])
    ctx.grpc.set_latency("Allocate", 30.0)
    before = ctx.clock.time()
    m.allocate_match("m-2")
    waited = ctx.clock.time() - before
    assert waited < 12, f"allocate_match waited {waited:.0f} s on an allocator that answers after 30 s: three 3-second attempts and their backoff end well before that"


def check_retry_policy(ctx):
    m = _client(ctx)
    _claimed("m-1", ["t1", "t2"])
    ctx.grpc.fail("Allocate", grpc.StatusCode.UNAVAILABLE, "fleet busy", times=2)
    before = ctx.clock.time()
    assert m.allocate_match("m-1") == "gs-m-1", "two UNAVAILABLE answers, then a server: the third attempt must place the match"
    waited = ctx.clock.time() - before
    assert len(ctx.grpc.calls_to("Allocate")) == 3, f"{len(ctx.grpc.calls_to('Allocate'))} Allocate calls for two failures and a success"
    assert ctx.clock.sleeps == 2 and waited >= 0.7, f"the retries went out after {waited:.2f} s with {ctx.clock.sleeps} sleeps: back off BACKOFF_BASE_S * 2**attempt (0.25 s, then 0.5 s) before asking a busy fleet again"
    _claimed("m-2", ["t3"])
    ctx.grpc.fail("Allocate", grpc.StatusCode.RESOURCE_EXHAUSTED, "no free server", times=3)
    assert m.allocate_match("m-2") is None, "a fleet with no free server cannot place the match"
    asked = len(ctx.grpc.calls_to("Allocate")) - 3
    assert asked == 1, f"RESOURCE_EXHAUSTED was asked {asked} times: a full fleet stays full for the next millisecond, retrying only adds load"


def check_release_on_failure(ctx):
    m = _client(ctx)
    store.enqueue("t9", "p9", 1590, ["p9"])
    _claimed("m-1", ["t1", "t2"])
    ctx.grpc.fail("Allocate", grpc.StatusCode.UNAVAILABLE, "fleet busy", times=3)
    assert m.allocate_match("m-1") is None, "every attempt failed: allocate_match must answer None"
    for ticket_id, skill in (("t1", 1501), ("t2", 1502)):
        t = store.get_ticket(ticket_id)
        assert t["state"] == "waiting" and t["match_id"] is None, f"after the allocation failed {ticket_id} is {t}: its players wait in neither the pool nor a game"
        assert _pool(ctx).get(ticket_id) == skill, f"{ticket_id} is not back in pool:15 at its skill {skill}: {_pool(ctx)}"
    assert _depth(ctx) == 3, f"pool:depth is {_depth(ctx)} with three tickets waiting"
    match = store.get_match("m-1")
    assert match["state"] == "abandoned" and match["reason"] == "allocation_failed", f"the match must be abandoned with reason allocation_failed, it is {match}"
    assert claims.claim_tickets("m-2", 15, ["t1", "t2"]), "the released tickets must be claimable by the next match"


def check_idempotent_release(ctx):
    m = _client(ctx)
    store.enqueue("t9", "p9", 1590, ["p9"])
    _claimed("m-1", ["t1", "t2"])
    assert m.release_roster("m-1") is True, "the first release of m-1 must release it"
    assert m.release_roster("m-1") is False, "the second release of m-1 must answer False: the roster was already returned"
    assert _depth(ctx) == 3 and len(_pool(ctx)) == 3, f"after a release that ran twice pool:depth is {_depth(ctx)} for {len(_pool(ctx))} waiting tickets: the tickets were counted back twice"
    assert claims.claim_tickets("m-2", 15, ["t1", "t2"]), "the released tickets must be claimable by m-2"
    store.create_match("m-2", 15, ["t1", "t2"])
    m.release_roster("m-1")  # a late cleanup of the dead match
    for ticket_id in ("t1", "t2"):
        assert store.get_ticket(ticket_id)["match_id"] == "m-2", f"a late release of m-1 took {ticket_id} out of m-2: {store.get_ticket(ticket_id)}"
    assert _depth(ctx) == 1, f"a late release of m-1 moved pool:depth to {_depth(ctx)}"
`,
    typescript: `function client(ctx) {
  const pkg = ctx.proto('game_matchmaking.proto');
  // A healthy fleet: every match gets gs-{match id}.
  ctx.grpc.serve(pkg.matchmakerd.Allocator.service, {
    Allocate(call, callback) {
      callback(null, {server_id: \`gs-\${call.request.match_id}\`, address: '10.0.0.7:7777'});
    },
  });
  return {
    m: ctx.load('client'),
    store: ctx.load('/support/matchmaking/store.ts'),
    claims: ctx.load('/support/matchmaking/claims.ts'),
  };
}

/** Queue the tickets in pool:15 (t1 is a party of p1 and p2), claim them for matchId, record the match. */
async function claimed(store, claims, matchId: string, tickets: string[]) {
  for (const ticketId of tickets) {
    const n = Number(ticketId.slice(1));
    const participants = n === 1 ? ['p1', 'p2'] : [\`p\${n + 1}\`];
    await store.enqueue(ticketId, participants[0], 1500 + n, participants);
  }
  assert(await claims.claimTickets(matchId, 15, tickets), \`setup: claiming \${tickets} for \${matchId} failed\`);
  await store.createMatch(matchId, 15, tickets);
}

const depth = (ctx): number => Number(ctx.redis.hget('pool:depth', '15') ?? 0);
const score = (ctx, ticketId: string): number | null => {
  const s = ctx.redis.zscore('pool:15', ticketId);
  return s === null ? null : Number(s);
};

export async function check_deadline(ctx) {
  const {m, store, claims} = client(ctx);
  await claimed(store, claims, 'm-1', ['t1', 't2']);
  assert.equal(await m.allocateMatch('m-1'), 'gs-m-1', 'with a healthy fleet the match must be placed on gs-m-1');
  for (const call of ctx.grpc.callsTo('Allocate')) {
    assert(call.timeout !== null, 'an Allocate call carries no deadline: a stalled allocator holds the matchmaker as long as it stalls');
    assert(2.5 <= call.timeout && call.timeout <= 3.5, \`an Allocate call carries a \${call.timeout} s deadline, expected ALLOCATOR_DEADLINE_MS = 3000\`);
  }
  await claimed(store, claims, 'm-2', ['t3']);
  ctx.grpc.setLatency('Allocate', 30.0);
  const before = ctx.clock.now();
  await m.allocateMatch('m-2');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited < 12, \`allocateMatch waited \${waited.toFixed(0)} s on an allocator that answers after 30 s: three 3-second attempts and their backoff end well before that\`);
}

export async function check_retry_policy(ctx) {
  const {m, store, claims} = client(ctx);
  await claimed(store, claims, 'm-1', ['t1', 't2']);
  ctx.grpc.fail('Allocate', ctx.grpc.status.UNAVAILABLE, 'fleet busy', 2);
  const before = ctx.clock.now();
  assert.equal(await m.allocateMatch('m-1'), 'gs-m-1', 'two UNAVAILABLE answers, then a server: the third attempt must place the match');
  const waited = (ctx.clock.now() - before) / 1000;
  assert.equal(ctx.grpc.callsTo('Allocate').length, 3, \`\${ctx.grpc.callsTo('Allocate').length} Allocate calls for two failures and a success\`);
  assert(ctx.clock.sleeps === 2 && waited >= 0.7, \`the retries went out after \${waited.toFixed(2)} s with \${ctx.clock.sleeps} sleeps: back off BACKOFF_BASE_MS * 2 ** attempt (250 ms, then 500 ms) before asking a busy fleet again\`);
  await claimed(store, claims, 'm-2', ['t3']);
  ctx.grpc.fail('Allocate', ctx.grpc.status.RESOURCE_EXHAUSTED, 'no free server', 3);
  assert.equal(await m.allocateMatch('m-2'), null, 'a fleet with no free server cannot place the match');
  const asked = ctx.grpc.callsTo('Allocate').length - 3;
  assert.equal(asked, 1, \`RESOURCE_EXHAUSTED was asked \${asked} times: a full fleet stays full for the next millisecond, retrying only adds load\`);
}

export async function check_release_on_failure(ctx) {
  const {m, store, claims} = client(ctx);
  await store.enqueue('t9', 'p9', 1590, ['p9']);
  await claimed(store, claims, 'm-1', ['t1', 't2']);
  ctx.grpc.fail('Allocate', ctx.grpc.status.UNAVAILABLE, 'fleet busy', 3);
  assert.equal(await m.allocateMatch('m-1'), null, 'every attempt failed: allocateMatch must answer null');
  for (const [ticketId, skill] of [['t1', 1501], ['t2', 1502]] as const) {
    const t = await store.getTicket(ticketId);
    assert(t.state === 'waiting' && t.match_id === null, \`after the allocation failed \${ticketId} is \${JSON.stringify(t)}: its players wait in neither the pool nor a game\`);
    assert.equal(score(ctx, ticketId), skill, \`\${ticketId} is not back in pool:15 at its skill \${skill}\`);
  }
  assert.equal(depth(ctx), 3, \`pool:depth is \${depth(ctx)} with three tickets waiting\`);
  const match = await store.getMatch('m-1');
  assert(match.state === 'abandoned' && match.reason === 'allocation_failed', \`the match must be abandoned with reason allocation_failed, it is \${JSON.stringify(match)}\`);
  assert(await claims.claimTickets('m-2', 15, ['t1', 't2']), 'the released tickets must be claimable by the next match');
}

export async function check_idempotent_release(ctx) {
  const {m, store, claims} = client(ctx);
  await store.enqueue('t9', 'p9', 1590, ['p9']);
  await claimed(store, claims, 'm-1', ['t1', 't2']);
  assert.equal(await m.releaseRoster('m-1'), true, 'the first release of m-1 must release it');
  assert.equal(await m.releaseRoster('m-1'), false, 'the second release of m-1 must answer false: the roster was already returned');
  const waiting = ctx.redis.zcard('pool:15');
  assert(depth(ctx) === 3 && waiting === 3, \`after a release that ran twice pool:depth is \${depth(ctx)} for \${waiting} waiting tickets: the tickets were counted back twice\`);
  assert(await claims.claimTickets('m-2', 15, ['t1', 't2']), 'the released tickets must be claimable by m-2');
  await store.createMatch('m-2', 15, ['t1', 't2']);
  await m.releaseRoster('m-1'); // a late cleanup of the dead match
  for (const ticketId of ['t1', 't2']) {
    const t = await store.getTicket(ticketId);
    assert.equal(t.match_id, 'm-2', \`a late release of m-1 took \${ticketId} out of m-2: \${JSON.stringify(t)}\`);
  }
  assert.equal(depth(ctx), 1, \`a late release of m-1 moved pool:depth to \${depth(ctx)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"

	pb "matchmaking/gen/game_matchmaking"
	"matchmaking/claims"
	"matchmaking/store"

	"leetbuild/harness"
)

var allocBg = context.Background()

// allocatorPeer is a healthy fleet: every match gets gs-{match id}.
type allocatorPeer struct {
	pb.UnimplementedAllocatorServer
}

func (allocatorPeer) Allocate(_ context.Context, req *pb.AllocateRequest) (*pb.Allocation, error) {
	return &pb.Allocation{ServerId: "gs-" + req.GetMatchId(), Address: "10.0.0.7:7777"}, nil
}

func allocServe(ctx *harness.Ctx) {
	pb.RegisterAllocatorServer(ctx.GRPC.Server(""), allocatorPeer{})
}

// allocClaimed queues the tickets in pool:15 (t1 is a party of p1 and p2), claims them for matchID and records the match.
func allocClaimed(ctx *harness.Ctx, matchID string, tickets ...string) {
	for _, ticketID := range tickets {
		n, _ := strconv.Atoi(ticketID[1:])
		participants := []string{fmt.Sprintf("p%d", n+1)}
		if n == 1 {
			participants = []string{"p1", "p2"}
		}
		store.Enqueue(allocBg, ticketID, participants[0], 1500+n, participants)
	}
	ok, err := claims.ClaimTickets(allocBg, matchID, 15, tickets)
	ctx.Assert(ok && err == nil, "setup: claiming %v for %s failed (%v)", tickets, matchID, err)
	store.CreateMatch(allocBg, matchID, 15, tickets)
}

func allocDepth(ctx *harness.Ctx) int {
	v, _ := ctx.Redis.HGet("pool:depth", "15")
	n, _ := strconv.Atoi(v)
	return n
}

func allocate(ctx *harness.Ctx, matchID string) string {
	serverID, err := allocateMatch(allocBg, matchID)
	ctx.NoError(err, "allocateMatch(%s)", matchID)
	return serverID
}

func release(ctx *harness.Ctx, matchID string) bool {
	ok, err := releaseRoster(allocBg, matchID)
	ctx.NoError(err, "releaseRoster(%s)", matchID)
	return ok
}

func CheckDeadline(ctx *harness.Ctx) {
	allocServe(ctx)
	allocClaimed(ctx, "m-1", "t1", "t2")
	ctx.Equal(allocate(ctx, "m-1"), "gs-m-1", "with a healthy fleet the match must be placed on gs-m-1; the server")
	for _, call := range ctx.GRPC.CallsTo("Allocate", "") {
		ctx.Assert(call.HasDeadline(), "an Allocate call carries no deadline: a stalled allocator holds the matchmaker as long as it stalls")
		ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "an Allocate call carries a %v deadline, expected allocatorDeadline = 3 s", call.Timeout)
	}
	allocClaimed(ctx, "m-2", "t3")
	ctx.GRPC.SetLatency("Allocate", 30.0, "")
	before := ctx.Clock.Now()
	allocate(ctx, "m-2")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited < 12, "allocateMatch waited %.0f s on an allocator that answers after 30 s: three 3-second attempts and their backoff end well before that", waited)
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	allocServe(ctx)
	allocClaimed(ctx, "m-1", "t1", "t2")
	ctx.GRPC.Fail("Allocate", codes.Unavailable, "fleet busy", 2, "")
	before := ctx.Clock.Now()
	ctx.Equal(allocate(ctx, "m-1"), "gs-m-1", "two UNAVAILABLE answers, then a server: the third attempt must place the match; the server")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Equal(len(ctx.GRPC.CallsTo("Allocate", "")), 3, "Allocate calls for two failures and a success")
	ctx.Assert(ctx.Clock.Sleeps() == 2 && waited >= 0.7, "the retries went out after %.2f s with %d sleeps: back off backoffBase << attempt (250 ms, then 500 ms) before asking a busy fleet again", waited, ctx.Clock.Sleeps())
	allocClaimed(ctx, "m-2", "t3")
	ctx.GRPC.Fail("Allocate", codes.ResourceExhausted, "no free server", 3, "")
	ctx.Equal(allocate(ctx, "m-2"), "", "a fleet with no free server cannot place the match; the server")
	asked := len(ctx.GRPC.CallsTo("Allocate", "")) - 3
	ctx.Equal(asked, 1, "RESOURCE_EXHAUSTED must not be retried (a full fleet stays full for the next millisecond, retrying only adds load); the calls")
}

func CheckReleaseOnFailure(ctx *harness.Ctx) {
	allocServe(ctx)
	store.Enqueue(allocBg, "t9", "p9", 1590, []string{"p9"})
	allocClaimed(ctx, "m-1", "t1", "t2")
	ctx.GRPC.Fail("Allocate", codes.Unavailable, "fleet busy", 3, "")
	ctx.Equal(allocate(ctx, "m-1"), "", "every attempt failed: allocateMatch must answer no server")
	for ticketID, skill := range map[string]float64{"t1": 1501, "t2": 1502} {
		t := store.GetTicket(allocBg, ticketID)
		ctx.Assert(t.State == "waiting" && t.MatchID == "", "after the allocation failed %s is %+v: its players wait in neither the pool nor a game", ticketID, t)
		got, ok := ctx.Redis.ZScore("pool:15", ticketID)
		ctx.Assert(ok && got == skill, "%s is not back in pool:15 at its skill %v", ticketID, skill)
	}
	ctx.Equal(allocDepth(ctx), 3, "pool:depth with three tickets waiting")
	m := store.GetMatch(allocBg, "m-1")
	ctx.Assert(m.State == "abandoned" && m.Reason == "allocation_failed", "the match must be abandoned with reason allocation_failed, it is %+v", m)
	ok, _ := claims.ClaimTickets(allocBg, "m-2", 15, []string{"t1", "t2"})
	ctx.Assert(ok, "the released tickets must be claimable by the next match")
}

func CheckIdempotentRelease(ctx *harness.Ctx) {
	allocServe(ctx)
	store.Enqueue(allocBg, "t9", "p9", 1590, []string{"p9"})
	allocClaimed(ctx, "m-1", "t1", "t2")
	ctx.Equal(release(ctx, "m-1"), true, "the first release of m-1 must release it")
	ctx.Equal(release(ctx, "m-1"), false, "the second release of m-1 must answer false: the roster was already returned")
	ctx.Assert(allocDepth(ctx) == 3 && ctx.Redis.ZCard("pool:15") == 3, "after a release that ran twice pool:depth is %d for %d waiting tickets: the tickets were counted back twice", allocDepth(ctx), ctx.Redis.ZCard("pool:15"))
	ok, _ := claims.ClaimTickets(allocBg, "m-2", 15, []string{"t1", "t2"})
	ctx.Assert(ok, "the released tickets must be claimable by m-2")
	store.CreateMatch(allocBg, "m-2", 15, []string{"t1", "t2"})
	release(ctx, "m-1") // a late cleanup of the dead match
	for _, ticketID := range []string{"t1", "t2"} {
		ctx.Equal(store.GetTicket(allocBg, ticketID).MatchID, "m-2", "a late release of m-1 must not take %s out of m-2; its match", ticketID)
	}
	ctx.Equal(allocDepth(ctx), 1, "a late release of m-1 must not move pool:depth")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "game_matchmaking.grpc.pb.h"
#include "matchmaking/claims.h"
#include "matchmaking/store.h"

namespace {

// A healthy fleet: every match gets gs-{match id}.
class AllocatorPeer final : public matchmakerd::Allocator::Service {
 public:
  grpc::Status Allocate(grpc::ServerContext*, const matchmakerd::AllocateRequest* req, matchmakerd::Allocation* out) override {
    out->set_server_id("gs-" + req->match_id());
    out->set_address("10.0.0.7:7777");
    return grpc::Status::OK;
  }
};

void allocServe(harness::Ctx& ctx) {
  static AllocatorPeer* peer = nullptr;
  delete peer;
  peer = new AllocatorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

// Queue the tickets in pool:15 (t1 is a party of p1 and p2), claim them for match_id, record the match.
void allocClaimed(harness::Ctx& ctx, const std::string& match_id, const std::vector<std::string>& tickets) {
  for (const std::string& ticket_id : tickets) {
    const int n = std::stoi(ticket_id.substr(1));
    const std::vector<std::string> participants = n == 1 ? std::vector<std::string>{"p1", "p2"} : std::vector<std::string>{"p" + std::to_string(n + 1)};
    store::enqueue(ticket_id, participants[0], 1500 + n, participants);
  }
  ctx.Assert(claims::claimTickets(match_id, 15, tickets), "setup: claiming the tickets for %s failed", match_id);
  store::createMatch(match_id, 15, tickets);
}

long allocDepth(harness::Ctx& ctx) {
  const auto v = ctx.Redis.HGet("pool:depth", "15");
  return v && !v->empty() ? std::stol(*v) : 0;
}

std::string serverOf(const std::optional<std::string>& server) { return server.value_or("(none)"); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  allocServe(ctx);
  allocClaimed(ctx, "m-1", {"t1", "t2"});
  ctx.Equal(serverOf(allocateMatch("m-1")), "gs-m-1", "with a healthy fleet the match must be placed on gs-m-1; the server");
  for (const auto& call : ctx.GRPC.CallsTo("Allocate")) {
    ctx.Assert(call.HasDeadline(), "an Allocate call carries no deadline: a stalled allocator holds the matchmaker as long as it stalls");
    ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "an Allocate call carries a %v s deadline, expected kAllocatorDeadline = 3 s", call.TimeoutSeconds());
  }
  allocClaimed(ctx, "m-2", {"t3"});
  ctx.GRPC.SetLatency("Allocate", 30.0);
  const int64_t before = ctx.Clock.Now();
  allocateMatch("m-2");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited < 12, "allocateMatch waited %.0f s on an allocator that answers after 30 s: three 3-second attempts and their backoff end well before that", waited);
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  allocServe(ctx);
  allocClaimed(ctx, "m-1", {"t1", "t2"});
  ctx.GRPC.Fail("Allocate", grpc::StatusCode::UNAVAILABLE, "fleet busy", 2);
  const int64_t before = ctx.Clock.Now();
  ctx.Equal(serverOf(allocateMatch("m-1")), "gs-m-1", "two UNAVAILABLE answers, then a server: the third attempt must place the match; the server");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Equal(ctx.GRPC.CallsTo("Allocate").size(), 3, "Allocate calls for two failures and a success");
  ctx.Assert(ctx.Clock.Sleeps() == 2 && waited >= 0.7, "the retries went out after %.2f s with %d sleeps: back off kBackoffBase * 2^attempt (250 ms, then 500 ms) before asking a busy fleet again", waited, ctx.Clock.Sleeps());
  allocClaimed(ctx, "m-2", {"t3"});
  ctx.GRPC.Fail("Allocate", grpc::StatusCode::RESOURCE_EXHAUSTED, "no free server", 3);
  ctx.Equal(serverOf(allocateMatch("m-2")), "(none)", "a fleet with no free server cannot place the match; the server");
  const size_t asked = ctx.GRPC.CallsTo("Allocate").size() - 3;
  ctx.Equal(asked, 1, "RESOURCE_EXHAUSTED must not be retried (a full fleet stays full for the next millisecond, retrying only adds load); the calls");
}

void CheckReleaseOnFailure(harness::Ctx& ctx) {
  allocServe(ctx);
  store::enqueue("t9", "p9", 1590, {"p9"});
  allocClaimed(ctx, "m-1", {"t1", "t2"});
  ctx.GRPC.Fail("Allocate", grpc::StatusCode::UNAVAILABLE, "fleet busy", 3);
  ctx.Equal(serverOf(allocateMatch("m-1")), "(none)", "every attempt failed: allocateMatch must answer no server");
  for (const auto& [ticket_id, skill] : std::vector<std::pair<std::string, double>>{{"t1", 1501}, {"t2", 1502}}) {
    const auto t = store::getTicket(ticket_id);
    ctx.Assert(t && t->state == "waiting" && t->match_id.empty(), "after the allocation failed %s is %s (match %s): its players wait in neither the pool nor a game", ticket_id, t ? t->state : "gone", t ? t->match_id : "");
    ctx.Equal(ctx.Redis.ZScore("pool:15", ticket_id), std::optional<double>(skill), "%s back in pool:15 at its skill", ticket_id);
  }
  ctx.Equal(allocDepth(ctx), 3, "pool:depth with three tickets waiting");
  const auto m = store::getMatch("m-1");
  ctx.Assert(m && m->state == "abandoned" && m->reason == "allocation_failed", "the match must be abandoned with reason allocation_failed, it is %s (%s)", m ? m->state : "gone", m ? m->reason : "");
  ctx.Assert(claims::claimTickets("m-2", 15, {"t1", "t2"}), "the released tickets must be claimable by the next match");
}

void CheckIdempotentRelease(harness::Ctx& ctx) {
  allocServe(ctx);
  store::enqueue("t9", "p9", 1590, {"p9"});
  allocClaimed(ctx, "m-1", {"t1", "t2"});
  ctx.Equal(releaseRoster("m-1"), true, "the first release of m-1 must release it");
  ctx.Equal(releaseRoster("m-1"), false, "the second release of m-1 must answer false: the roster was already returned");
  ctx.Assert(allocDepth(ctx) == 3 && ctx.Redis.ZCard("pool:15") == 3, "after a release that ran twice pool:depth is %d for %d waiting tickets: the tickets were counted back twice", allocDepth(ctx), ctx.Redis.ZCard("pool:15"));
  ctx.Assert(claims::claimTickets("m-2", 15, {"t1", "t2"}), "the released tickets must be claimable by m-2");
  store::createMatch("m-2", 15, {"t1", "t2"});
  releaseRoster("m-1");  // a late cleanup of the dead match
  for (const std::string ticket_id : {"t1", "t2"}) {
    const auto t = store::getTicket(ticket_id);
    ctx.Equal(t ? t->match_id : "", "m-2", "a late release of m-1 must not take %s out of m-2; its match", ticket_id);
  }
  ctx.Equal(allocDepth(ctx), 1, "a late release of m-1 must not move pool:depth");
}
`,
  },
  hints: [
    'Make the allocator answer UNAVAILABLE three times: the match reports no server, and its players are claimed by it forever. Slow the allocator to 30 s: the matchmaker waits all 30.',
    'The calls carry no deadline and the loop treats every error as "ask again now". When the loop ends nothing returns the tickets, and `release_roster` adds them back blind, so running it twice counts them twice.',
    'Pass `timeout=ALLOCATOR_DEADLINE_S`; on UNAVAILABLE or DEADLINE_EXCEEDED sleep `BACKOFF_BASE_S * 2**attempt`, otherwise stop. After the loop call `release_roster` and `store.abandon(..., "allocation_failed")`. Make the release one script that starts with `SET released:{id} 1 NX EX 3600`.',
  ],
  debrief: `The status code separates "ask again in a moment" from "asking again changes nothing", so the retry loop is a policy over codes, and the backoff keeps a busy fleet from being hit by every matchmaker at once. The deadline turns a stalled allocator into one of those retryable codes instead of a stuck thread. Releasing is the part that keeps players visible: a claim that cannot become a game must be undone, or the tickets sit in a state nothing reads. The release runs once per match because the guard is set in the same script that returns the tickets, and it checks each ticket's match id so it never takes a ticket a newer match has claimed. Production matchmakers add jitter to the backoff and also reclaim a server whose match never connected.`,
};
