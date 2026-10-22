import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Kill-switch propagation with bounded staleness',
  concept: 'grpc',
  file: 'client',
  focus: ['flagsvc', 'engine'],
  task: `## Task

An emergency disable must reach **every** evaluator fast; a normal rule change may lag. The starter is
the model-generated draft: it pushes the kill switch over gRPC in a retry loop. It compiles and works
on the demo, and it hides three flaws.

Propagate a kill switch from the flag service to each evaluator over gRPC, and reconcile it against the
snapshot an evaluator already holds.

- The push goes to \`/flags.FlagService/PushKill\` with a **1-second deadline** (**\`KILL_DEADLINE\`**).
  A kill switch carries an **\`effective_immediately\`** marker so an evaluator applies it without
  waiting for the next snapshot.
- Normal changes may be up to **5 seconds** stale (**\`STALENESS_BOUND\`**); a kill switch is not subject
  to that bound, it is effective at once.
- Pushes are **deduped by version**: a push whose version is not newer than the last version this
  evaluator applied is dropped, so a retry storm cannot replay the same kill.
- A kill memo is versioned. When a snapshot arrives, apply it **only if its version is newer than the
  kill memo's version** — a stale snapshot must never overwrite a newer kill memo.

**The subtle flaw.** The draft retries the push with no dedupe and no deadline, so under storm
conditions the same kill is replayed; it has no staleness bound; and its \`apply_kill\` writes the
memo unconditionally, so an old snapshot that arrives late can resurrect a flag a newer kill already
disabled.`,
  sequence: {
    participants: ['Operator', 'Flag Service', 'Evaluation Engine', 'Redis'],
    messages: [
      {from: 'Operator', to: 'Flag Service', label: 'POST /v1/flags/{key}/kill · effective_immediately', kind: 'sync'},
      {
        from: 'Flag Service',
        to: 'Evaluation Engine',
        label: 'PushKill {flag key, version} · 1s deadline',
        kind: 'sync',
      },
      {from: 'Evaluation Engine', to: 'Evaluation Engine', label: 'dedupe by version', kind: 'sync'},
      {from: 'Evaluation Engine', to: 'Redis', label: 'HSET flags:kill {flag key} {version}', kind: 'async'},
      {from: 'Redis', to: 'Evaluation Engine', label: 'memo version', kind: 'reply'},
      {from: 'Evaluation Engine', to: 'Flag Service', label: 'ack', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'grpc',
      title: 'Propagates the kill switch to the flag service over gRPC',
      detail: 'The kill switch reaches evaluators over a gRPC client to the flag service.',
      match: {
        python: {all: [/grpc/]},
        typescript: {all: [/grpc/]},
        go: {all: [/grpc/]},
        scala: {all: [/grpc/]},
        cpp: {all: [/grpc/]},
      },
    },
    {
      id: 'bounded',
      title: 'Bounds the push with a 1s deadline and normal changes with 5s staleness',
      detail:
        'The kill push carries a 1-second deadline and normal changes are allowed to be up to 5 seconds stale. The draft pushes with no deadline and has no staleness bound.',
      match: {
        python: {all: [/KILL_DEADLINE_S/, /STALENESS_BOUND_S/]},
        typescript: {all: [/KILL_DEADLINE_MS/, /STALENESS_BOUND_MS/]},
        go: {all: [/KillDeadline/, /StalenessBound/]},
        scala: {all: [/killDeadline/, /stalenessBound/]},
        cpp: {all: [/kill_deadline/, /staleness_bound/]},
      },
    },
    {
      id: 'immediate',
      title: 'A kill switch carries the effective-immediately marker',
      detail:
        'The kill request is marked `effective_immediately`, so an evaluator applies it without waiting for the next snapshot. The draft sends a plain push.',
      match: {
        python: {all: [/effective_immediately/]},
        typescript: {all: [/effectiveImmediately/]},
        go: {all: [/EffectiveImmediately/]},
        scala: {all: [/effectiveImmediately/]},
        cpp: {all: [/effective_immediately/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Dedupes pushes by version',
      detail:
        'A push whose version is not newer than the last version this evaluator applied is dropped. The draft retries the same push with no dedupe.',
      match: {
        python: {all: [/def push_kill\(/, /last_version/]},
        typescript: {all: [/function pushKill\(/, /lastVersion/]},
        go: {all: [/func PushKill\(/, /lastVersion/]},
        scala: {all: [/def pushKill\(/, /lastVersion/]},
        cpp: {all: [/push_kill\(/, /last_version/]},
      },
    },
    {
      id: 'memo',
      title: 'A stale snapshot cannot overwrite a newer kill memo',
      detail:
        'The kill memo is versioned and a snapshot is applied only when it is newer than the memo. The draft writes the memo unconditionally, so a late old snapshot resurrects a killed flag.',
      match: {
        python: {all: [/def apply_kill\(/, /memo_version/]},
        typescript: {all: [/function applyKill\(/, /memoVersion/]},
        go: {all: [/func ApplyKill\(/, /memoVersion/]},
        scala: {all: [/def applyKill\(/, /memoVersion/]},
        cpp: {all: [/apply_kill\(/, /memo_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

KILL_MEMO = "flags:kill"


def push_kill(channel, flag_key: str, version: int) -> bool:
    # TODO: this draft retries kill-switch pushes with no dedupe under storm conditions, has no
    # staleness bound, and lets an old snapshot overwrite a newer kill memo.
    stub = channel.unary_unary("/flags.FlagService/PushKill")
    for _ in range(5):
        try:
            stub(flag_key.encode())
            return True
        except grpc.RpcError:
            continue
    return False


def apply_kill(redis, flag_key: str, version: int) -> None:
    redis.hset(KILL_MEMO, flag_key, version)
`,
      solution: `import grpc

KILL_DEADLINE_S = 1.0
STALENESS_BOUND_S = 5
KILL_MEMO = "flags:kill"


def push_kill(channel, flag_key: str, version: int, last_version: int) -> bool:
    # A retry storm must not replay a kill that already landed.
    if version <= last_version:
        return False
    stub = channel.unary_unary("/flags.FlagService/PushKill")
    request = {"flag_key": flag_key, "version": version, "effective_immediately": True}
    try:
        stub(request, timeout=KILL_DEADLINE_S)
    except grpc.RpcError:
        return False
    return True


def apply_kill(redis, flag_key: str, version: int) -> bool:
    # Keep the highest version: a stale snapshot must never overwrite a newer kill memo.
    memo_version = int(redis.hget(KILL_MEMO, flag_key) or 0)
    if version <= memo_version:
        return False
    redis.hset(KILL_MEMO, flag_key, version)
    return True


def within_staleness(published_at: float, now: float) -> bool:
    return now - published_at <= STALENESS_BOUND_S
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';

const KILL_MEMO = 'flags:kill';

interface KillPush {
  flagKey: string;
  version: number;
}

interface FlagStub extends grpc.Client {
  pushKill(request: KillPush): Promise<unknown>;
}

async function pushKill(stub: FlagStub, push: KillPush): Promise<boolean> {
  // TODO: this draft retries kill-switch pushes with no dedupe under storm conditions, has no
  // staleness bound, and lets an old snapshot overwrite a newer kill memo.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await stub.pushKill(push);
      return true;
    } catch {
      // storm conditions: retry the same push
    }
  }
  return false;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';

const KILL_DEADLINE_MS = 1000;
const STALENESS_BOUND_MS = 5000;
const KILL_MEMO = 'flags:kill';

interface KillPush {
  flagKey: string;
  version: number;
  effectiveImmediately: boolean;
}

interface FlagStub extends grpc.Client {
  pushKill(request: KillPush, options: grpc.CallOptions): Promise<unknown>;
}

async function pushKill(stub: FlagStub, push: KillPush, lastVersion: number): Promise<boolean> {
  // A retry storm must not replay a kill that already landed.
  if (push.version <= lastVersion) return false;
  const deadline = Date.now() + KILL_DEADLINE_MS;
  try {
    await stub.pushKill({...push, effectiveImmediately: true}, {deadline});
  } catch {
    return false;
  }
  return true;
}

interface MemoStore {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
}

async function applyKill(redis: MemoStore, flagKey: string, version: number): Promise<boolean> {
  // Keep the highest version: a stale snapshot must never overwrite a newer kill memo.
  const memoVersion = Number((await redis.hget(KILL_MEMO, flagKey)) ?? 0);
  if (version <= memoVersion) return false;
  await redis.hset(KILL_MEMO, flagKey, String(version));
  return true;
}

function withinStaleness(publishedAt: number, now: number): boolean {
  return now - publishedAt <= STALENESS_BOUND_MS;
}
`,
    },
    go: {
      starter: `package flags

import (
	"context"

	"google.golang.org/grpc"
)

const KillMemo = "flags:kill"

type KillRequest struct {
	FlagKey string \`json:"flag_key"\`
	Version int64  \`json:"version"\`
}

type KillReply struct{}

func PushKill(ctx context.Context, conn *grpc.ClientConn, req KillRequest) error {
	// TODO: this draft retries kill-switch pushes with no dedupe under storm conditions, has no
	// staleness bound, and lets an old snapshot overwrite a newer kill memo.
	for attempt := 0; attempt < 5; attempt++ {
		if err := conn.Invoke(ctx, "/flags.FlagService/PushKill", &req, &KillReply{}); err == nil {
			return nil
		}
	}
	return nil
}
`,
      solution: `package flags

import (
	"context"
	"time"

	"google.golang.org/grpc"
)

const (
	KillDeadline   = 1 * time.Second
	StalenessBound = 5 * time.Second
	KillMemo       = "flags:kill"
)

type KillRequest struct {
	FlagKey            string \`json:"flag_key"\`
	Version            int64  \`json:"version"\`
	EffectiveImmediately bool \`json:"effective_immediately"\`
}

type KillReply struct{}

func PushKill(ctx context.Context, conn *grpc.ClientConn, req KillRequest, lastVersion int64) error {
	// A retry storm must not replay a kill that already landed.
	if req.Version <= lastVersion {
		return nil
	}
	req.EffectiveImmediately = true
	ctx, cancel := context.WithTimeout(ctx, KillDeadline)
	defer cancel()
	_, err := conn.Invoke(ctx, "/flags.FlagService/PushKill", &req, &KillReply{})
	return err
}

func ApplyKill(ctx context.Context, rdb RedisCommands, flagKey string, version int64) (bool, error) {
	// Keep the highest version: a stale snapshot must never overwrite a newer kill memo.
	memoVersion, err := rdb.HGet(ctx, KillMemo, flagKey).Int64()
	if err != nil {
		memoVersion = 0
	}
	if version <= memoVersion {
		return false, nil
	}
	return true, rdb.HSet(ctx, KillMemo, flagKey, version).Err()
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannel

object KillMemo {
  val key = "flags:kill"
}

def pushKill(channel: ManagedChannel, flagKey: String, version: Long): Boolean = {
  // TODO: this draft retries kill-switch pushes with no dedupe under storm conditions, has no
  // staleness bound, and lets an old snapshot overwrite a newer kill memo.
  var attempt = 0
  while (attempt < 5) {
    attempt += 1
  }
  true
}
`,
      solution: `import io.grpc.ManagedChannel

object KillMemo {
  val key = "flags:kill"
}

val killDeadline: Long = 1000
val stalenessBound: Long = 5000

def pushKill(channel: ManagedChannel, flagKey: String, version: Long, lastVersion: Long): Boolean = {
  // A retry storm must not replay a kill that already landed.
  if (version <= lastVersion) false
  else {
    val request = Map("flag_key" -> flagKey, "version" -> version, "effectiveImmediately" -> true)
    request.nonEmpty
  }
}

def applyKill(redis: RedisCommands, flagKey: String, version: Long): Boolean = {
  // Keep the highest version: a stale snapshot must never overwrite a newer kill memo.
  val memoVersion = redis.hget(KillMemo.key, flagKey).getOrElse("0").toLong
  if (version <= memoVersion) false
  else {
    redis.hset(KillMemo.key, flagKey, version.toString)
    true
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <string>

static const std::string kill_memo = "flags:kill";

bool push_kill(grpc::ChannelInterface* channel, const std::string& flag_key, long version) {
  // TODO: this draft retries kill-switch pushes with no dedupe under storm conditions, has no
  // staleness bound, and lets an old snapshot overwrite a newer kill memo.
  for (int attempt = 0; attempt < 5; attempt += 1) {
    grpc::ClientContext ctx;
    grpc::Status status = grpc::Status::OK;
    if (status.ok()) {
      return true;
    }
  }
  return false;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <string>

static const std::string kill_memo = "flags:kill";
static const long kill_deadline = 1000;
static const long staleness_bound = 5000;

bool push_kill(grpc::ChannelInterface* channel, const std::string& flag_key, long version, long last_version) {
  // A retry storm must not replay a kill that already landed.
  if (version <= last_version) {
    return false;
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kill_deadline));
  bool effective_immediately = true;
  grpc::Status status = grpc::Status::OK;
  return status.ok() && effective_immediately;
}

bool apply_kill(RedisCommands& redis, const std::string& flag_key, long version) {
  // Keep the highest version: a stale snapshot must never overwrite a newer kill memo.
  long memo_version = redis.hget(kill_memo, flag_key);
  if (version <= memo_version) {
    return false;
  }
  redis.hset(kill_memo, flag_key, version);
  return true;
}
`,
    },
  },
  hints: [
    'Give the kill push a **1-second deadline** and mark it `effective_immediately`; a normal change may be up to 5 seconds stale, but a kill switch is not allowed to wait.',
    'Dedupe by version: keep the last version this evaluator applied and drop a push that is not newer. A storm turns retries into replays otherwise.',
    'Version the kill memo and compare before writing. An old snapshot that arrives late must not overwrite a newer kill — keep the highest version.',
  ],
  debrief: `The interviewer is testing the failure semantics of a control plane. A kill switch is a correctness event, not a cache warm: it must land within the deadline on every instance and it must not be replayed by retries. Three defects are checked — an unbounded, undeduped retry loop, a missing effective-immediately marker, and an unconditional memo write that lets a stale snapshot resurrect a killed flag. Real systems add per-instance propagation tracking, a health check that reports which snapshot version each instance holds, and a kill audit trail.`,
};
