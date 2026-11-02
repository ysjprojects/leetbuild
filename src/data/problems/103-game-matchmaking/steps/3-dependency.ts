import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Game server allocation with ticket release on failure',
  concept: 'grpc',
  file: 'client',
  focus: ['matchmaker', 'allocator', 'redis'],
  task: `## Task

**Starting point.** The starter is the allocator client the matchmaker calls after it has claimed
a roster. \`allocate_match(stub, match_id)\` calls \`Allocate\` with a 3-second deadline
(\`ALLOCATOR_DEADLINE_MS\`) inside \`while True\`, returns the server id on success and, on any
\`RpcError\`, loops straight back into the next call. It compiles, the demo allocates, and it hides
4 flaws.

**Failure mode the checks target.** An allocation that fails leaves the roster claimed: the
players are neither waiting in the pool nor in a match, so nothing can match them and nothing can
cancel them. The tight unbounded loop turns a dependency blip into a stampede against an
allocator that is already unhealthy and hides the failure from the matchmaker's own metrics. And
once a release exists, a release that runs twice returns a ticket to the bucket twice and leaves
the depth counter claiming more waiting tickets than there are.

- Keep the **3-second deadline** on every attempt.
- When an attempt fails (deadline exceeded or \`FAILED\`), **release every participant ticket**
  before the next attempt: \`ZADD\` each ticket back at its skill, clear its claimed marker and
  restore the depth counter.
- The release is **idempotent**: one atomic script guarded by \`SET … NX\` on
  \`{RELEASED_PREFIX}:{match_id}\` releases the roster once and answers **0** afterwards.
- Retries are bounded by \`MAX_ALLOC_ATTEMPTS\` and spaced by an exponential backoff from
  \`BACKOFF_BASE_MS\`.
- The call ends in one of two states: a server id, or a released roster.`,
  sequence: {
    participants: ['Matchmaker', 'Game server allocator', 'Redis pools'],
    messages: [
      {from: 'Matchmaker', to: 'Game server allocator', label: 'Allocate(match_id) · deadline 3000 ms', kind: 'sync'},
      {from: 'Game server allocator', to: 'Matchmaker', label: 'server id / FAILED', kind: 'reply'},
      {
        from: 'Matchmaker',
        to: 'Redis pools',
        label: 'EVAL release.lua 4 pool · depth · claimed · released',
        kind: 'sync',
      },
      {from: 'Redis pools', to: 'Matchmaker', label: '1 released / 0 already released', kind: 'reply'},
      {from: 'Matchmaker', to: 'Matchmaker', label: 'backoff, then a fresh allocation attempt', kind: 'sync'},
      {from: 'Matchmaker', to: 'Game server allocator', label: 'Allocate — attempt 2', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'grpc-deadline',
      title: 'Calls the allocator with a 3-second deadline',
      detail:
        'Each attempt carries `ALLOCATOR_DEADLINE_MS = 3000`, so a hung allocator cannot hold the matchmaker. The starter uses the deadline too — this is the one check it already satisfies — but it never gives the roster back when the deadline fires.',
      match: {
        python: {all: [/DEADLINE_MS/, /3000/]},
        typescript: {all: [/DEADLINE_MS/, /3000/]},
        go: {all: [/[Dd]eadlineMs/, /3000/]},
        scala: {all: [/DeadlineMs/, /3000/]},
        cpp: {all: [/DeadlineMs/, /3000/]},
      },
    },
    {
      id: 'release-on-failure',
      title: 'Releases the roster when the allocation fails',
      detail:
        'The failure branch calls `release_participants`, so every participant ticket goes back to the pool. The starter returns from the error and leaves the roster claimed — the ghost queue. This is an `order`-style contract in spirit: release must happen on the failure path, not only on the happy one.',
      match: {
        python: {all: [/release_participants\(/, /except/]},
        typescript: {all: [/releaseParticipants\(/, /catch/]},
        go: {all: [/ReleaseParticipants\(/, /if err/]},
        scala: {all: [/releaseParticipants\(/, /catch|recover|Try/]},
        cpp: {all: [/releaseParticipants\(/, /catch/]},
      },
    },
    {
      id: 'idempotent-release',
      title: 'Releases once per match',
      detail:
        'The release takes a `SET … NX` guard on `{RELEASED_PREFIX}:{match_id}`, so a retried release answers "already released" instead of returning the tickets a second time. Without the guard a second attempt adds the same ticket to the bucket twice and inflates the depth counter.',
      match: {
        python: {all: [/RELEASED/, /NX/]},
        typescript: {all: [/RELEASED/, /NX/]},
        go: {all: [/releasedPrefix/, /NX/]},
        scala: {all: [/ReleasedPrefix/, /NX/]},
        cpp: {all: [/kReleasedPrefix/, /NX/]},
      },
    },
    {
      id: 'backoff-retry',
      title: 'Backs off between attempts',
      detail:
        'Attempts are spaced by an exponential delay derived from `BACKOFF_BASE_MS`, so the retry does not hammer an allocator that is already unhealthy. The starter retries in a tight loop.',
      match: {
        python: {all: [/BACKOFF/, /attempt/i]},
        typescript: {all: [/BACKOFF/, /attempt/i]},
        go: {all: [/backoff/, /attempt/i]},
        scala: {all: [/Backoff/, /attempt/i]},
        cpp: {all: [/Backoff/, /attempt/i]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Bounds the attempts',
      detail:
        'The retry loop is bounded by `MAX_ALLOC_ATTEMPTS`; there is no `while true` around the allocator. The starter retries against the same dead pool indefinitely, which is how one failed dependency becomes an unbounded loop.',
      match: {
        python: {all: [/MAX_ALLOC_ATTEMPTS/]},
        typescript: {all: [/MAX_ALLOC_ATTEMPTS/]},
        go: {all: [/maxAllocAttempts/]},
        scala: {all: [/MaxAllocAttempts/]},
        cpp: {all: [/kMaxAllocAttempts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Allocator client: allocate a server for a claimed roster."""
import grpc

import allocator_pb2
import allocator_pb2_grpc

ALLOCATOR_DEADLINE_MS = 3000


def allocate_match(stub: allocator_pb2_grpc.AllocatorStub, match_id: str) -> str | None:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    while True:
        try:
            reply = stub.Allocate(
                allocator_pb2.AllocateRequest(match_id=match_id),
                timeout=ALLOCATOR_DEADLINE_MS / 1000,
            )
            return reply.server_id
        except grpc.RpcError:
            continue
`,
      solution: `"""Allocator client: a deadline per attempt and a certain, idempotent release on failure."""
import time

import grpc
import redis as redis_lib

import allocator_pb2
import allocator_pb2_grpc
from state import CLAIMED_PREFIX, bucket_key, depth_key

ALLOCATOR_DEADLINE_MS = 3000
MAX_ALLOC_ATTEMPTS = 3
BACKOFF_BASE_MS = 250
RELEASED_PREFIX = "matchmaking:released"
RELEASED_TTL_S = 1800

RELEASE_LUA = """
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local released = KEYS[4]
local count = tonumber(ARGV[1])
if redis.call('SET', released, '1', 'NX', 'EX', ARGV[count * 2 + 2]) == false then
  return 0
end
for i = 1, count do
  local ticket = ARGV[2 * i]
  local skill = tonumber(ARGV[2 * i + 1])
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('DEL', claimed .. ':' .. ticket)
end
redis.call('HINCRBY', depth, count)
return 1
"""


def release_participants(
    r: redis_lib.Redis,
    match_id: str,
    bucket: int,
    participants: list[tuple[str, float]],
) -> str:
    """Return every participant ticket to its bucket, exactly once per match."""
    args: list[object] = [len(participants)]
    for ticket_id, skill in participants:
        args += [ticket_id, skill]
    args.append(RELEASED_TTL_S)
    released = r.eval(
        RELEASE_LUA,
        4,
        bucket_key(bucket),
        depth_key(bucket),
        CLAIMED_PREFIX,
        f"{RELEASED_PREFIX}:{match_id}",
        *args,
    )
    return "released" if released else "already_released"


def backoff_seconds(attempt: int) -> float:
    return BACKOFF_BASE_MS * (2**attempt) / 1000


def allocate_match(
    r: redis_lib.Redis,
    stub: allocator_pb2_grpc.AllocatorStub,
    match_id: str,
    bucket: int,
    participants: list[tuple[str, float]],
) -> str | None:
    for attempt in range(MAX_ALLOC_ATTEMPTS):
        try:
            reply = stub.Allocate(
                allocator_pb2.AllocateRequest(match_id=match_id),
                timeout=ALLOCATOR_DEADLINE_MS / 1000,
            )
            return reply.server_id
        except grpc.RpcError:
            release_participants(r, match_id, bucket, participants)
            time.sleep(backoff_seconds(attempt))
    return None
`,
    },
    typescript: {
      starter: `/** Allocator client: allocate a server for a claimed roster. */
import * as grpc from '@grpc/grpc-js';

import {AllocatorClient} from './allocator_grpc_pb';
import {AllocateRequest} from './allocator_pb';

const ALLOCATOR_DEADLINE_MS = 3000;

export async function allocateMatch(client: AllocatorClient, matchId: string): Promise<string | null> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (;;) {
    try {
      const {promise, resolve, reject} = Promise.withResolvers<{getServerId(): string}>();
      client.allocate(
        new AllocateRequest().setMatchId(matchId),
        new grpc.Metadata(),
        {deadline: Date.now() + ALLOCATOR_DEADLINE_MS},
        (error, value) => (error ? reject(error) : resolve(value)),
      );
      const reply = await promise;
      return reply.getServerId();
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** Allocator client: a deadline per attempt and a certain, idempotent release on failure. */
import * as grpc from '@grpc/grpc-js';

import {AllocatorClient} from './allocator_grpc_pb';
import {AllocateRequest} from './allocator_pb';
import {r} from './state';

const ALLOCATOR_DEADLINE_MS = 3000;
const MAX_ALLOC_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const RELEASED_PREFIX = 'matchmaking:released';
const RELEASED_TTL_S = 1800;

interface Participant {
  ticketId: string;
  skill: number;
}

const RELEASE_LUA = \`
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local released = KEYS[4]
local count = tonumber(ARGV[1])
if redis.call('SET', released, '1', 'NX', 'EX', ARGV[count * 2 + 2]) == false then
  return 0
end
for i = 1, count do
  local ticket = ARGV[2 * i]
  local skill = tonumber(ARGV[2 * i + 1])
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('DEL', claimed .. ':' .. ticket)
end
redis.call('HINCRBY', depth, count)
return 1
\`;

export async function releaseParticipants(
  matchId: string,
  bucket: number,
  participants: Participant[],
): Promise<boolean> {
  const args: string[] = [String(participants.length)];
  for (const p of participants) args.push(p.ticketId, String(p.skill));
  args.push(String(RELEASED_TTL_S));
  const released = await r.eval(
    RELEASE_LUA,
    4,
    'matchmaking:pool:' + bucket,
    'matchmaking:depth:' + bucket,
    'matchmaking:claimed',
    RELEASED_PREFIX + ':' + matchId,
    ...args,
  );
  return released === 1;
}

export async function allocateMatch(
  client: AllocatorClient,
  matchId: string,
  bucket: number,
  participants: Participant[],
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt += 1) {
    try {
      const {promise, resolve, reject} = Promise.withResolvers<{getServerId(): string}>();
      client.allocate(
        new AllocateRequest().setMatchId(matchId),
        new grpc.Metadata(),
        {deadline: Date.now() + ALLOCATOR_DEADLINE_MS},
        (error, value) => (error ? reject(error) : resolve(value)),
      );
      const reply = await promise;
      return reply.getServerId();
    } catch {
      await releaseParticipants(matchId, bucket, participants);
      const {promise: pause, resolve: wake} = Promise.withResolvers<void>();
      setTimeout(wake, BACKOFF_BASE_MS * 2 ** attempt);
      await pause;
    }
  }
  return null;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const allocatorDeadlineMs = 3000

var allocatorConn, _ = grpc.NewClient("allocator:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))

func AllocateMatch(ctx context.Context, matchID string) (string, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	for {
		callCtx, cancel := context.WithTimeout(ctx, time.Duration(allocatorDeadlineMs)*time.Millisecond)
		reply, err := Allocate(callCtx, matchID)
		cancel()
		if err == nil {
			return reply, nil
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const (
	allocatorDeadlineMs = 3000
	maxAllocAttempts    = 3
	backoffBaseMs       = 250
	releasedPrefix      = "matchmaking:released"
	releasedTtlS        = 1800
)

type Participant struct {
	TicketID string
	Skill    float64
}

var allocatorConn, _ = grpc.NewClient("allocator:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))

var releaseScript = redis.NewScript(\`
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local released = KEYS[4]
local count = tonumber(ARGV[1])
if redis.call('SET', released, '1', 'NX', 'EX', ARGV[count * 2 + 2]) == false then
  return 0
end
for i = 1, count do
  local ticket = ARGV[2 * i]
  local skill = tonumber(ARGV[2 * i + 1])
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('DEL', claimed .. ':' .. ticket)
end
redis.call('HINCRBY', depth, count)
return 1
\`)

func releasedKey(matchID string) string {
	return releasedPrefix + ":" + matchID
}

func ReleaseParticipants(ctx context.Context, matchID string, bucket int, participants []Participant) (bool, error) {
	keys := []string{
		"matchmaking:pool:" + strconv.Itoa(bucket),
		"matchmaking:depth:" + strconv.Itoa(bucket),
		"matchmaking:claimed",
		releasedKey(matchID),
	}
	args := make([]any, 0, len(participants)*2+2)
	args = append(args, len(participants))
	for _, p := range participants {
		args = append(args, p.TicketID, p.Skill)
	}
	args = append(args, releasedTtlS)
	released, err := releaseScript.Run(ctx, rdb, keys, args...).Int()
	if err != nil {
		return false, err
	}
	return released == 1, nil
}

func AllocateMatch(ctx context.Context, matchID string, bucket int, participants []Participant) (string, error) {
	var lastErr error
	for attempt := 0; attempt < maxAllocAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, time.Duration(allocatorDeadlineMs)*time.Millisecond)
		reply, err := Allocate(callCtx, matchID)
		cancel()
		if err == nil {
			return reply, nil
		}
		lastErr = err
		if _, err := ReleaseParticipants(ctx, matchID, bucket, participants); err != nil {
			return "", err
		}
		time.Sleep(time.Duration(backoffBaseMs*(1<<attempt)) * time.Millisecond)
	}
	return "", lastErr
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import scala.util.control.NonFatal

object AllocatorClient {
  val AllocatorDeadlineMs = 3000

  def allocateMatch(stub: AllocatorGrpc.AllocatorBlockingStub, matchId: String): Option[String] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    var serverId: Option[String] = None
    while (serverId.isEmpty) {
      try {
        val reply = stub
          .withDeadlineAfter(AllocatorDeadlineMs, TimeUnit.MILLISECONDS)
          .allocate(AllocateRequest(matchId))
        serverId = Some(reply.serverId)
      } catch {
        case NonFatal(_) => serverId = None
      }
    }
    serverId
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object AllocatorClient {
  val AllocatorDeadlineMs = 3000
  val MaxAllocAttempts = 3
  val BackoffBaseMs = 250
  val ReleasedPrefix = "matchmaking:released"
  val ReleasedTtlS = 1800

  val jedis = new Jedis("redis", 6379)

  val ReleaseLua = """
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local released = KEYS[4]
local count = tonumber(ARGV[1])
if redis.call('SET', released, '1', 'NX', 'EX', ARGV[count * 2 + 2]) == false then
  return 0
end
for i = 1, count do
  local ticket = ARGV[2 * i]
  local skill = tonumber(ARGV[2 * i + 1])
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('DEL', claimed .. ':' .. ticket)
end
redis.call('HINCRBY', depth, count)
return 1
"""

  def releaseParticipants(
      matchId: String,
      bucket: Int,
      participants: List[(String, Double)]
  ): Boolean = {
    val keys = List(
      "matchmaking:pool:" + bucket,
      "matchmaking:depth:" + bucket,
      "matchmaking:claimed",
      ReleasedPrefix + ":" + matchId
    ).asJava
    val args = ((participants.size.toString :: participants.flatMap { case (id, skill) => List(id, skill.toString) })
      :+ ReleasedTtlS.toString).asJava
    jedis.eval(ReleaseLua, keys, args).toString.toLong == 1L
  }

  def allocateMatch(
      stub: AllocatorGrpc.AllocatorBlockingStub,
      matchId: String,
      bucket: Int,
      participants: List[(String, Double)]
  ): Option[String] = {
    var serverId: Option[String] = None
    var attempt = 0
    while (attempt < MaxAllocAttempts && serverId.isEmpty) {
      try {
        val reply = stub
          .withDeadlineAfter(AllocatorDeadlineMs, TimeUnit.MILLISECONDS)
          .allocate(AllocateRequest(matchId))
        serverId = Some(reply.serverId)
      } catch {
        case _: Throwable =>
          releaseParticipants(matchId, bucket, participants)
          Thread.sleep(BackoffBaseMs.toLong * math.pow(2, attempt).toLong)
      }
      attempt += 1
    }
    serverId
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kAllocatorDeadlineMs = 3000;

std::string allocateMatch(allocator::Allocator::Stub& stub, const std::string& matchId) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  while (true) {
    try {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kAllocatorDeadlineMs));
      AllocateRequest request;
      request.set_match_id(matchId);
      AllocateReply reply;
      const grpc::Status status = stub.Allocate(&ctx, request, &reply);
      if (status.ok()) {
        return reply.server_id();
      }
      throw std::runtime_error(status.error_message());
    } catch (const std::exception&) {
      continue;
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using sw::redis::Redis;

constexpr int kAllocatorDeadlineMs = 3000;
constexpr int kMaxAllocAttempts = 3;
constexpr int kBackoffBaseMs = 250;
constexpr const char* kReleasedPrefix = "matchmaking:released";
constexpr int kReleasedTtlS = 1800;

struct Participant {
  std::string ticket_id;
  double skill;
};

Redis r("tcp://redis:6379");

const std::string RELEASE_LUA = R"LUA(
local bucket = KEYS[1]
local depth = KEYS[2]
local claimed = KEYS[3]
local released = KEYS[4]
local count = tonumber(ARGV[1])
if redis.call('SET', released, '1', 'NX', 'EX', ARGV[count * 2 + 2]) == false then
  return 0
end
for i = 1, count do
  local ticket = ARGV[2 * i]
  local skill = tonumber(ARGV[2 * i + 1])
  redis.call('ZADD', bucket, skill, ticket)
  redis.call('DEL', claimed .. ':' .. ticket)
end
redis.call('HINCRBY', depth, count)
return 1
)LUA";

std::string releasedKey(const std::string& matchId) {
  return std::string(kReleasedPrefix) + ":" + matchId;
}

bool releaseParticipants(const std::string& matchId, int bucket, const std::vector<Participant>& participants) {
  const std::vector<std::string> keys{
      "matchmaking:pool:" + std::to_string(bucket),
      "matchmaking:depth:" + std::to_string(bucket),
      "matchmaking:claimed",
      releasedKey(matchId),
  };
  std::vector<std::string> args{std::to_string(participants.size())};
  for (const auto& p : participants) {
    args.push_back(p.ticket_id);
    args.push_back(std::to_string(p.skill));
  }
  args.push_back(std::to_string(kReleasedTtlS));
  const long long released = r.eval<long long>(RELEASE_LUA, keys, args);
  return released == 1;
}

std::string allocateMatch(
    allocator::Allocator::Stub& stub,
    const std::string& matchId,
    int bucket,
    const std::vector<Participant>& participants) {
  for (int attempt = 0; attempt < kMaxAllocAttempts; ++attempt) {
    try {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kAllocatorDeadlineMs));
      AllocateRequest request;
      request.set_match_id(matchId);
      AllocateReply reply;
      const grpc::Status status = stub.Allocate(&ctx, request, &reply);
      if (status.ok()) {
        return reply.server_id();
      }
      throw std::runtime_error(status.error_message());
    } catch (const std::exception&) {
      releaseParticipants(matchId, bucket, participants);
      std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffBaseMs * (1 << attempt)));
    }
  }
  return "";
}
`,
    },
  },
  hints: [
    'During an allocator outage the matchmaker worker count drops to zero free, allocator call rate climbs, and a group of players stays "searching" with no ticket in any bucket and no match.',
    'The `except`/`catch` branch only loops: the roster stays claimed between attempts and the loop has no exit, so every failed call keeps the tickets out of the pool and the worker busy.',
    'In the error branch call `release_participants` (one script: `ZADD` back, `DEL` marker, `HINCRBY` depth up, guarded by `SET {RELEASED_PREFIX}:{match_id} 1 NX`), then sleep `BACKOFF_BASE_MS * 2 ** attempt`, bounded by `MAX_ALLOC_ATTEMPTS`.',
  ],
  debrief: `The happy path of a dependency call is the easy part; the roster's tickets on the failure path decide whether the queue survives a bad afternoon at the allocator. The release is certain, so no error branch skips it, and idempotent, because the retry loop calls it more than once and a second release must not return a ticket twice or double-count the depth. It runs as one script for the same reason the claim did: a crash cannot half-release a roster. The bound and the backoff keep a dead allocator from turning into a loop of doomed calls that holds a worker and hides the failure. Production allocators add a lease on the server so the allocator's own timeout drives release, and a capacity signal so the matchmaker stops forming matches the fleet cannot seat.`,
};
