import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'The kill switch: commit, then push under a deadline',
  concept: 'grpc',
  file: 'kill',
  focus: ['api', 'relay', 'redis', 'sdk'],
  task: `## Task

**Starting point.** The starter is the operator's kill switch: \`kill_flag(flag_key, actor)\` reads
the snapshot (\`flags.engine\`), calls \`Relay.PushKill\` with the next version, retrying up to five
times a second apart, then publishes that version with the flag \`killed\` and answers \`{flag_key,
version, status: "pushed"}\`. With the relay healthy the flag goes dark; it hides three flaws.

**Failure mode the checks target.** A relay that hangs holds the operator's kill open for as long as
it likes. A relay that reacts to the push refetches the snapshot before the kill is in it and keeps
serving the flag. A relay that is down gets five retries in place, then the kill is reported
\`pushed\` and the push is forgotten.

\`\`\`proto
service Relay { rpc PushKill(KillRequest) returns (KillAck); }  // KillRequest{flag_key, version, actor}
\`\`\`

- The push carries a **1-second deadline** (\`KILL_DEADLINE_S\`): SDKs poll the snapshot every
  5 seconds anyway, so the push only has to beat that.
- **Commit first**: \`engine.publish_snapshot\` with the flag killed, then the push for that version.
- One push. When it fails (any status, \`DEADLINE_EXCEEDED\` included), RPUSH \`{"flag_key", "version",
  "actor"}\` to \`flags:push:pending\` for the retrier and answer \`status: "pending"\`.`,
  sequence: {
    participants: ['Operator', 'flagsvc', 'Redis', 'Edge relay'],
    messages: [
      {from: 'Operator', to: 'flagsvc', label: 'kill_flag(checkout, oncall)', kind: 'sync'},
      {from: 'flagsvc', to: 'Redis', label: 'publish_snapshot(v5, checkout killed)', kind: 'sync'},
      {from: 'flagsvc', to: 'Edge relay', label: 'PushKill{checkout, 5} · deadline 1 s', kind: 'sync'},
      {from: 'Edge relay', to: 'Redis', label: 'GET flags:snapshot → v5', kind: 'sync'},
      {from: 'Edge relay', to: 'flagsvc', label: 'KillAck · or DEADLINE_EXCEEDED → flags:push:pending', kind: 'reply'},
      {from: 'flagsvc', to: 'Operator', label: 'status: pushed · pending', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'The push carries a 1-second deadline',
      detail:
        "The `PushKill` call has a deadline (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) and nothing sleeps between retries: a hung relay costs the operator one second, not the relay's whim.",
      match: {
        python: {all: [/timeout=KILL_DEADLINE_S|timeout=1(?:\.0)?\b/], none: [/time\.sleep\(/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+/], none: [/\bsleep\(/]},
        go: {all: [/context\.WithTimeout\(/], none: [/time\.Sleep\(/]},
        scala: {all: [/withDeadlineAfter\(/], none: [/Thread\.sleep\(/]},
        cpp: {all: [/set_deadline\(/], none: [/sleep_for\(/]},
      },
    },
    {
      id: 'commit-first',
      title: 'Publishes the killed snapshot before the push',
      detail:
        '`publish_snapshot`/`publishSnapshot` runs before `PushKill`, so a relay that refetches on the push reads a snapshot with the flag killed; the starter pushes first.',
      match: {
        python: {order: [/publish_snapshot\(/, /\.PushKill\(/]},
        typescript: {order: [/publishSnapshot\(/, /\.PushKill\(/]},
        go: {order: [/engine\.PublishSnapshot\(/, /relay\.PushKill\(/]},
        scala: {order: [/Engine\.publishSnapshot\(/, /\.pushKill\(/]},
        cpp: {order: [/engine::publishSnapshot\(/, /->PushKill\(/]},
      },
    },
    {
      id: 'pending',
      title: 'A failed push is queued and reported pending',
      detail:
        'When the push fails, the kill (already in the snapshot) is RPUSHed to `flags:push:pending` and the answer says `pending`; the starter reports `pushed` whatever the relay said.',
      match: {
        python: {all: [/flags:push:pending/, /rpush/i, /["']pending["']/]},
        typescript: {all: [/flags:push:pending/, /rpush/i, /['"]pending['"]/]},
        go: {all: [/flags:push:pending/, /RPush\(/, /"pending"/]},
        scala: {all: [/flags:push:pending/, /rpush\(/, /"pending"/]},
        cpp: {all: [/flags:push:pending/, /rpush\(/, /"pending"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc
import redis

import feature_flags_pb2
import feature_flags_pb2_grpc
from flags import engine  # engine.read_snapshot, engine.publish_snapshot

r = redis.Redis(host="redis", port=6379, decode_responses=True)
relay = feature_flags_pb2_grpc.RelayStub(grpc.insecure_channel("relay:9000"))


def kill_flag(flag_key: str, actor: str) -> dict:
    """Disable flag_key for everyone: a snapshot with the flag killed, and a push to the edge relay."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    current = engine.read_snapshot()
    if current is None or flag_key not in current["flags"]:
        return {"flag_key": flag_key, "status": "unknown"}
    version = current["version"] + 1
    request = feature_flags_pb2.KillRequest(flag_key=flag_key, version=version, actor=actor)
    for _ in range(5):
        try:
            relay.PushKill(request)
            break
        except grpc.RpcError:
            time.sleep(1)
    flags = {**current["flags"], flag_key: {**current["flags"][flag_key], "killed": True}}
    if not engine.publish_snapshot({"version": version, "flags": flags}):
        return {"flag_key": flag_key, "version": current["version"], "status": "conflict"}
    return {"flag_key": flag_key, "version": version, "status": "pushed"}
`,
      solution: `import json

import grpc
import redis

import feature_flags_pb2
import feature_flags_pb2_grpc
from flags import engine  # engine.read_snapshot, engine.publish_snapshot

KILL_DEADLINE_S = 1
PENDING_KEY = "flags:push:pending"

r = redis.Redis(host="redis", port=6379, decode_responses=True)
relay = feature_flags_pb2_grpc.RelayStub(grpc.insecure_channel("relay:9000"))


def kill_flag(flag_key: str, actor: str) -> dict:
    """Disable flag_key for everyone: a snapshot with the flag killed, and a push to the edge relay."""
    current = engine.read_snapshot()
    if current is None or flag_key not in current["flags"]:
        return {"flag_key": flag_key, "status": "unknown"}
    version = current["version"] + 1
    flags = {**current["flags"], flag_key: {**current["flags"][flag_key], "killed": True}}
    # The kill is committed first: a relay that refetches on the push reads it.
    if not engine.publish_snapshot({"version": version, "flags": flags}):
        return {"flag_key": flag_key, "version": current["version"], "status": "conflict"}
    request = feature_flags_pb2.KillRequest(flag_key=flag_key, version=version, actor=actor)
    try:
        relay.PushKill(request, timeout=KILL_DEADLINE_S)
    except grpc.RpcError:
        # Evaluators see the kill on their next poll; the retrier owns the push from here.
        r.rpush(PENDING_KEY, json.dumps({"flag_key": flag_key, "version": version, "actor": actor}))
        return {"flag_key": flag_key, "version": version, "status": "pending"}
    return {"flag_key": flag_key, "version": version, "status": "pushed"}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {setTimeout as sleep} from 'node:timers/promises';
import Redis from 'ioredis';

import {publishSnapshot, readSnapshot} from 'flags/engine';

interface KillRequest {
  flag_key: string;
  version: number;
  actor: string;
}

export interface KillResult {
  flag_key: string;
  version?: number;
  status: string;
}

export const redis = new Redis({host: 'redis', port: 6379});

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('feature_flags.proto')) as unknown as {
  flagrelay: {Relay: grpc.ServiceClientConstructor};
};
const relay = new pkg.flagrelay.Relay('relay:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PushKill(request: KillRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{applied_version: number}>;
};

/** Disable flagKey for everyone: a snapshot with the flag killed, and a push to the edge relay. */
export async function killFlag(flagKey: string, actor: string): Promise<KillResult> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const current = await readSnapshot();
  if (current === null || !Object.hasOwn(current.flags, flagKey)) return {flag_key: flagKey, status: 'unknown'};
  const version = current.version + 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await relay.PushKill({flag_key: flagKey, version, actor}, new grpc.Metadata(), {});
      break;
    } catch {
      await sleep(1000);
    }
  }
  const flags = {...current.flags, [flagKey]: {...current.flags[flagKey], killed: true}};
  if (!(await publishSnapshot({version, flags}))) return {flag_key: flagKey, version: current.version, status: 'conflict'};
  return {flag_key: flagKey, version, status: 'pushed'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {publishSnapshot, readSnapshot} from 'flags/engine';

export const KILL_DEADLINE_MS = 1000;
export const PENDING_KEY = 'flags:push:pending';

interface KillRequest {
  flag_key: string;
  version: number;
  actor: string;
}

export interface KillResult {
  flag_key: string;
  version?: number;
  status: string;
}

export const redis = new Redis({host: 'redis', port: 6379});

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('feature_flags.proto')) as unknown as {
  flagrelay: {Relay: grpc.ServiceClientConstructor};
};
const relay = new pkg.flagrelay.Relay('relay:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PushKill(request: KillRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{applied_version: number}>;
};

/** Disable flagKey for everyone: a snapshot with the flag killed, and a push to the edge relay. */
export async function killFlag(flagKey: string, actor: string): Promise<KillResult> {
  const current = await readSnapshot();
  if (current === null || !Object.hasOwn(current.flags, flagKey)) return {flag_key: flagKey, status: 'unknown'};
  const version = current.version + 1;
  const flags = {...current.flags, [flagKey]: {...current.flags[flagKey], killed: true}};
  // The kill is committed first: a relay that refetches on the push reads it.
  if (!(await publishSnapshot({version, flags}))) return {flag_key: flagKey, version: current.version, status: 'conflict'};
  try {
    await relay.PushKill({flag_key: flagKey, version, actor}, new grpc.Metadata(), {deadline: Date.now() + KILL_DEADLINE_MS});
  } catch {
    // Evaluators see the kill on their next poll; the retrier owns the push from here.
    await redis.rpush(PENDING_KEY, JSON.stringify({flag_key: flagKey, version, actor}));
    return {flag_key: flagKey, version, status: 'pending'};
  }
  return {flag_key: flagKey, version, status: 'pushed'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"flags/engine" // engine.ReadSnapshot, PublishSnapshot, Snapshot, Flag
	pb "flags/gen/feature_flags"
)

var (
	rdb          = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	relayConn, _ = grpc.NewClient("relay:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	relay        = pb.NewRelayClient(relayConn)
)

// killResult is what the operator is told.
type killResult struct {
	FlagKey string \`json:"flag_key"\`
	Version int64  \`json:"version,omitempty"\`
	Status  string \`json:"status"\`
}

// withKilled is the next version of current, with flagKey killed.
func withKilled(current *engine.Snapshot, flagKey string) engine.Snapshot {
	flags := make(map[string]engine.Flag, len(current.Flags))
	for key, flag := range current.Flags {
		flags[key] = flag
	}
	flag := flags[flagKey]
	flag.Killed = true
	flags[flagKey] = flag
	return engine.Snapshot{Version: current.Version + 1, Flags: flags}
}

// killFlag disables flagKey for everyone: a snapshot with the flag killed, and a push to the edge relay.
func killFlag(ctx context.Context, flagKey, actor string) (killResult, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	current, err := engine.ReadSnapshot(ctx)
	if err != nil {
		return killResult{}, err
	}
	if current == nil {
		return killResult{FlagKey: flagKey, Status: "unknown"}, nil
	}
	if _, known := current.Flags[flagKey]; !known {
		return killResult{FlagKey: flagKey, Status: "unknown"}, nil
	}
	killed := withKilled(current, flagKey)
	request := &pb.KillRequest{FlagKey: flagKey, Version: killed.Version, Actor: actor}
	for attempt := 0; attempt < 5; attempt++ {
		if _, err := relay.PushKill(ctx, request); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	moved, err := engine.PublishSnapshot(ctx, killed)
	if err != nil {
		return killResult{}, err
	}
	if !moved {
		return killResult{FlagKey: flagKey, Version: current.Version, Status: "conflict"}, nil
	}
	return killResult{FlagKey: flagKey, Version: killed.Version, Status: "pushed"}, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"flags/engine" // engine.ReadSnapshot, PublishSnapshot, Snapshot, Flag
	pb "flags/gen/feature_flags"
)

const (
	killDeadline = time.Second
	pendingKey   = "flags:push:pending"
)

var (
	rdb          = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	relayConn, _ = grpc.NewClient("relay:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	relay        = pb.NewRelayClient(relayConn)
)

// killResult is what the operator is told.
type killResult struct {
	FlagKey string \`json:"flag_key"\`
	Version int64  \`json:"version,omitempty"\`
	Status  string \`json:"status"\`
}

// withKilled is the next version of current, with flagKey killed.
func withKilled(current *engine.Snapshot, flagKey string) engine.Snapshot {
	flags := make(map[string]engine.Flag, len(current.Flags))
	for key, flag := range current.Flags {
		flags[key] = flag
	}
	flag := flags[flagKey]
	flag.Killed = true
	flags[flagKey] = flag
	return engine.Snapshot{Version: current.Version + 1, Flags: flags}
}

// killFlag disables flagKey for everyone: a snapshot with the flag killed, and a push to the edge relay.
func killFlag(ctx context.Context, flagKey, actor string) (killResult, error) {
	current, err := engine.ReadSnapshot(ctx)
	if err != nil {
		return killResult{}, err
	}
	if current == nil {
		return killResult{FlagKey: flagKey, Status: "unknown"}, nil
	}
	if _, known := current.Flags[flagKey]; !known {
		return killResult{FlagKey: flagKey, Status: "unknown"}, nil
	}
	killed := withKilled(current, flagKey)
	// The kill is committed first: a relay that refetches on the push reads it.
	moved, err := engine.PublishSnapshot(ctx, killed)
	if err != nil {
		return killResult{}, err
	}
	if !moved {
		return killResult{FlagKey: flagKey, Version: current.Version, Status: "conflict"}, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, killDeadline)
	defer cancel()
	if _, err := relay.PushKill(callCtx, &pb.KillRequest{FlagKey: flagKey, Version: killed.Version, Actor: actor}); err != nil {
		// Evaluators see the kill on their next poll; the retrier owns the push from here.
		row, _ := json.Marshal(map[string]any{"flag_key": flagKey, "version": killed.Version, "actor": actor})
		if err := rdb.RPush(ctx, pendingKey, string(row)).Err(); err != nil {
			return killResult{}, err
		}
		return killResult{FlagKey: flagKey, Version: killed.Version, Status: "pending"}, nil
	}
	return killResult{FlagKey: flagKey, Version: killed.Version, Status: "pushed"}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import spray.json._

import flags.Engine // Engine.readSnapshot, Engine.publishSnapshot
import flagrelay.feature_flags.{KillRequest, RelayGrpc}

object Kill {
  val jedis = new JedisPooled("redis", 6379)
  private val relay = RelayGrpc.blockingStub(ManagedChannelBuilder.forAddress("relay", 9000).usePlaintext().build())

  private def answer(flagKey: String, version: Long, status: String): JsObject =
    JsObject("flag_key" -> JsString(flagKey), "version" -> JsNumber(version), "status" -> JsString(status))

  /** The next version of current, with flagKey killed. */
  private def withKilled(current: JsObject, version: Long, flagKey: String): JsObject = {
    val flags = current.fields("flags").asJsObject.fields
    val killed = JsObject(flags(flagKey).asJsObject.fields + ("killed" -> JsTrue))
    JsObject("version" -> JsNumber(version), "flags" -> JsObject(flags + (flagKey -> killed)))
  }

  /** Disable flagKey for everyone: a snapshot with the flag killed, and a push to the edge relay. */
  def killFlag(flagKey: String, actor: String): JsObject =
    Engine.readSnapshot().filter(_.fields("flags").asJsObject.fields.contains(flagKey)) match {
      case None => JsObject("flag_key" -> JsString(flagKey), "status" -> JsString("unknown"))
      case Some(current) =>
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        val currentVersion = current.fields("version").asInstanceOf[JsNumber].value.toLong
        val version = currentVersion + 1
        val request = KillRequest(flagKey = flagKey, version = version, actor = actor)
        var attempt = 0
        var pushed = false
        while (attempt < 5 && !pushed) {
          try { relay.pushKill(request); pushed = true }
          catch { case _: StatusRuntimeException => Thread.sleep(1000); attempt += 1 }
        }
        if (!Engine.publishSnapshot(withKilled(current, version, flagKey))) answer(flagKey, currentVersion, "conflict")
        else answer(flagKey, version, "pushed")
    }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import spray.json._

import flags.Engine // Engine.readSnapshot, Engine.publishSnapshot
import flagrelay.feature_flags.{KillRequest, RelayGrpc}

object Kill {
  val KillDeadlineSeconds = 1L
  val PendingKey = "flags:push:pending"

  val jedis = new JedisPooled("redis", 6379)
  private val relay = RelayGrpc.blockingStub(ManagedChannelBuilder.forAddress("relay", 9000).usePlaintext().build())

  private def answer(flagKey: String, version: Long, status: String): JsObject =
    JsObject("flag_key" -> JsString(flagKey), "version" -> JsNumber(version), "status" -> JsString(status))

  /** The next version of current, with flagKey killed. */
  private def withKilled(current: JsObject, version: Long, flagKey: String): JsObject = {
    val flags = current.fields("flags").asJsObject.fields
    val killed = JsObject(flags(flagKey).asJsObject.fields + ("killed" -> JsTrue))
    JsObject("version" -> JsNumber(version), "flags" -> JsObject(flags + (flagKey -> killed)))
  }

  /** Disable flagKey for everyone: a snapshot with the flag killed, and a push to the edge relay. */
  def killFlag(flagKey: String, actor: String): JsObject =
    Engine.readSnapshot().filter(_.fields("flags").asJsObject.fields.contains(flagKey)) match {
      case None => JsObject("flag_key" -> JsString(flagKey), "status" -> JsString("unknown"))
      case Some(current) =>
        val currentVersion = current.fields("version").asInstanceOf[JsNumber].value.toLong
        val version = currentVersion + 1
        // The kill is committed first: a relay that refetches on the push reads it.
        if (!Engine.publishSnapshot(withKilled(current, version, flagKey))) answer(flagKey, currentVersion, "conflict")
        else
          try {
            relay.withDeadlineAfter(KillDeadlineSeconds, TimeUnit.SECONDS).pushKill(KillRequest(flagKey = flagKey, version = version, actor = actor))
            answer(flagKey, version, "pushed")
          } catch {
            case _: StatusRuntimeException =>
              // Evaluators see the kill on their next poll; the retrier owns the push from here.
              jedis.rpush(PendingKey, JsObject("flag_key" -> JsString(flagKey), "version" -> JsNumber(version), "actor" -> JsString(actor)).compactPrint)
              answer(flagKey, version, "pending")
          }
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <thread>

#include "feature_flags.grpc.pb.h"
#include "flags/engine.h"  // engine::readSnapshot, engine::publishSnapshot

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");
auto relay = flagrelay::Relay::NewStub(grpc::CreateChannel("relay:9000", grpc::InsecureChannelCredentials()));

// The next version of current, with flag_key killed.
json withKilled(const json& current, const std::string& flag_key) {
  json next = current;
  next["version"] = current.at("version").get<long long>() + 1;
  next["flags"][flag_key]["killed"] = true;
  return next;
}

// Disable flag_key for everyone: a snapshot with the flag killed, and a push to the edge relay.
json killFlag(const std::string& flag_key, const std::string& actor) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const auto current = engine::readSnapshot();
  if (!current || !current->at("flags").contains(flag_key)) return json{{"flag_key", flag_key}, {"status", "unknown"}};
  const json killed = withKilled(*current, flag_key);
  const long long version = killed.at("version").get<long long>();
  flagrelay::KillRequest request;
  request.set_flag_key(flag_key);
  request.set_version(version);
  request.set_actor(actor);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    flagrelay::KillAck ack;
    if (relay->PushKill(&ctx, request, &ack).ok()) break;
    std::this_thread::sleep_for(std::chrono::seconds{1});
  }
  if (!engine::publishSnapshot(killed)) return json{{"flag_key", flag_key}, {"version", version - 1}, {"status", "conflict"}};
  return json{{"flag_key", flag_key}, {"version", version}, {"status", "pushed"}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "feature_flags.grpc.pb.h"
#include "flags/engine.h"  // engine::readSnapshot, engine::publishSnapshot

using json = nlohmann::json;

constexpr std::chrono::seconds kKillDeadline{1};
const std::string kPendingKey = "flags:push:pending";

sw::redis::Redis redis("tcp://redis:6379");
auto relay = flagrelay::Relay::NewStub(grpc::CreateChannel("relay:9000", grpc::InsecureChannelCredentials()));

// The next version of current, with flag_key killed.
json withKilled(const json& current, const std::string& flag_key) {
  json next = current;
  next["version"] = current.at("version").get<long long>() + 1;
  next["flags"][flag_key]["killed"] = true;
  return next;
}

// Disable flag_key for everyone: a snapshot with the flag killed, and a push to the edge relay.
json killFlag(const std::string& flag_key, const std::string& actor) {
  const auto current = engine::readSnapshot();
  if (!current || !current->at("flags").contains(flag_key)) return json{{"flag_key", flag_key}, {"status", "unknown"}};
  const json killed = withKilled(*current, flag_key);
  const long long version = killed.at("version").get<long long>();
  // The kill is committed first: a relay that refetches on the push reads it.
  if (!engine::publishSnapshot(killed)) return json{{"flag_key", flag_key}, {"version", version - 1}, {"status", "conflict"}};
  flagrelay::KillRequest request;
  request.set_flag_key(flag_key);
  request.set_version(version);
  request.set_actor(actor);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kKillDeadline);
  flagrelay::KillAck ack;
  if (!relay->PushKill(&ctx, request, &ack).ok()) {
    // Evaluators see the kill on their next poll; the retrier owns the push from here.
    redis.rpush(kPendingKey, json{{"flag_key", flag_key}, {"version", version}, {"actor", actor}}.dump());
    return json{{"flag_key", flag_key}, {"version", version}, {"status", "pending"}};
  }
  return json{{"flag_key", flag_key}, {"version", version}, {"status", "pushed"}};
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import feature_flags_pb2
import feature_flags_pb2_grpc
from flags import engine

USER = {"user_id": "u-7"}


def _flag(rollout):
    return {"default": False, "rules": [], "rollout": rollout, "salt": "2026", "killed": False}


BASE = {"version": 4, "flags": {"checkout": _flag(100), "search-v2": _flag(100)}}


class Relay(feature_flags_pb2_grpc.RelayServicer):
    """Records each push with the snapshot Redis held when it arrived (what a refetch would read)."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.seen = []

    def PushKill(self, request, context):
        raw = self.ctx.redis.get("flags:snapshot")
        self.seen.append((request.flag_key, request.version, json.loads(raw) if raw else None))
        return feature_flags_pb2.KillAck(applied_version=request.version)


def _kill(ctx):
    relay = Relay(ctx)
    ctx.grpc.serve(feature_flags_pb2_grpc.add_RelayServicer_to_server, relay)
    assert engine.publish_snapshot(BASE), "seeding version 4 failed"
    return ctx.load("kill"), relay


def _killed(flag_key):
    d = engine.evaluate(flag_key, USER)
    return d is not None and d["reason"] == "killed"


def check_deadline(ctx):
    m, _ = _kill(ctx)
    result = m.kill_flag("checkout", "oncall")
    assert result.get("status") == "pushed", f"with the relay healthy kill_flag answered {result}, expected status pushed"
    calls = ctx.grpc.calls_to("PushKill")
    assert len(calls) == 1, f"one kill made {len(calls)} PushKill calls"
    assert calls[0].timeout is not None, "the PushKill call carries no deadline: a relay that hangs holds the operator's kill open"
    assert 0.5 <= calls[0].timeout <= 1.5, f"the PushKill call carries a {calls[0].timeout} s deadline, expected 1 s"
    ctx.grpc.set_latency("PushKill", 30.0)
    started = ctx.clock.time()
    result = m.kill_flag("search-v2", "oncall")
    elapsed = ctx.clock.time() - started
    assert elapsed <= 2.0, f"with the relay hung, kill_flag held the operator for {elapsed:.1f} s: the push needs a 1-second deadline"
    assert _killed("search-v2"), f"after a kill whose push timed out, search-v2 evaluates to {engine.evaluate('search-v2', USER)}: the kill must be in the snapshot"


def check_commit_first(ctx):
    m, relay = _kill(ctx)
    result = m.kill_flag("checkout", "oncall")
    assert result.get("version") == 5, f"the kill must publish version 5, kill_flag answered {result}"
    assert relay.seen, "no PushKill reached the relay"
    flag_key, version, snapshot = relay.seen[0]
    assert flag_key == "checkout" and version == 5, f"the relay got a push for {flag_key} version {version}, expected checkout version 5"
    held = None if snapshot is None else snapshot["version"]
    assert snapshot is not None and held == 5 and snapshot["flags"]["checkout"]["killed"] is True, f"when the push for version 5 arrived, Redis held version {held}: a relay that refetches on the push reads the old snapshot and keeps serving checkout. Publish the killed snapshot, then push"
    assert _killed("checkout"), f"after the kill checkout evaluates to {engine.evaluate('checkout', USER)}"


def check_pending(ctx):
    m, _ = _kill(ctx)
    ctx.grpc.fail("PushKill", grpc.StatusCode.UNAVAILABLE, "relay restarting", times=1)
    result = m.kill_flag("checkout", "oncall")
    assert result.get("status") == "pending", f"the PushKill failed UNAVAILABLE and kill_flag answered {result}: a failed push is queued in flags:push:pending and answered pending"
    calls = len(ctx.grpc.calls_to("PushKill"))
    assert calls == 1, f"a failed push was retried in place ({calls} calls): the retrier owns it once it is queued"
    rows = ctx.redis.lrange("flags:push:pending", 0, -1)
    assert len(rows) == 1, f"flags:push:pending holds {rows}, expected one row for the failed push"
    assert json.loads(rows[0]) == {"flag_key": "checkout", "version": 5, "actor": "oncall"}, f"the pending row is {rows[0]}, expected flag_key checkout, version 5, actor oncall"
    assert _killed("checkout"), "the kill must be in the snapshot even when the push failed"
    result = m.kill_flag("search-v2", "oncall")
    assert result.get("status") == "pushed", f"with the relay back kill_flag answered {result}"
    assert len(ctx.redis.lrange("flags:push:pending", 0, -1)) == 1, "a push that landed must not add a pending row"
`,
    typescript: `const USER = {user_id: 'u-7'};
const flag = (rollout: number) => ({default: false, rules: [], rollout, salt: '2026', killed: false});
const BASE = {version: 4, flags: {checkout: flag(100), 'search-v2': flag(100)}};

/** The relay records each push with the snapshot Redis held when it arrived (what a refetch would read). */
async function kill(ctx) {
  const pkg = ctx.proto('feature_flags.proto');
  const seen: {flag_key: string; version: number; snapshot: {version: number; flags: Record<string, {killed: boolean}>} | null}[] = [];
  ctx.grpc.serve(pkg.flagrelay.Relay.service, {
    PushKill(call, callback) {
      const raw = ctx.redis.get('flags:snapshot');
      seen.push({flag_key: call.request.flag_key, version: Number(call.request.version), snapshot: raw === null ? null : JSON.parse(raw)});
      callback(null, {applied_version: call.request.version});
    },
  });
  const engine = ctx.load('/support/flags/engine.ts');
  assert(await engine.publishSnapshot(BASE), 'seeding version 4 failed');
  const killed = async (flagKey: string) => (await engine.evaluate(flagKey, USER))?.reason === 'killed';
  return {m: ctx.load('kill'), seen, killed};
}

export async function check_deadline(ctx) {
  const {m, killed} = await kill(ctx);
  let result = await m.killFlag('checkout', 'oncall');
  assert.equal(result.status, 'pushed', \`with the relay healthy killFlag answered \${JSON.stringify(result)}, expected status pushed\`);
  const calls = ctx.grpc.callsTo('PushKill');
  assert.equal(calls.length, 1, \`one kill made \${calls.length} PushKill calls\`);
  assert(calls[0].timeout !== null, "the PushKill call carries no deadline: a relay that hangs holds the operator's kill open");
  assert(0.5 <= calls[0].timeout && calls[0].timeout <= 1.5, \`the PushKill call carries a \${calls[0].timeout} s deadline, expected 1 s\`);
  ctx.grpc.setLatency('PushKill', 30.0);
  const started = ctx.clock.now();
  result = await m.killFlag('search-v2', 'oncall');
  const elapsed = (ctx.clock.now() - started) / 1000;
  assert(elapsed <= 2.0, \`with the relay hung, killFlag held the operator for \${elapsed.toFixed(1)} s: the push needs a 1-second deadline\`);
  assert(await killed('search-v2'), 'after a kill whose push timed out, search-v2 must evaluate as killed: the kill must be in the snapshot');
}

export async function check_commit_first(ctx) {
  const {m, seen, killed} = await kill(ctx);
  const result = await m.killFlag('checkout', 'oncall');
  assert.equal(result.version, 5, \`the kill must publish version 5, killFlag answered \${JSON.stringify(result)}\`);
  assert(seen.length > 0, 'no PushKill reached the relay');
  const {flag_key, version, snapshot} = seen[0];
  assert(flag_key === 'checkout' && version === 5, \`the relay got a push for \${flag_key} version \${version}, expected checkout version 5\`);
  const held = snapshot === null ? null : snapshot.version;
  assert(snapshot !== null && held === 5 && snapshot.flags.checkout.killed === true, \`when the push for version 5 arrived, Redis held version \${held}: a relay that refetches on the push reads the old snapshot and keeps serving checkout. Publish the killed snapshot, then push\`);
  assert(await killed('checkout'), 'after the kill checkout must evaluate as killed');
}

export async function check_pending(ctx) {
  const {m, killed} = await kill(ctx);
  ctx.grpc.fail('PushKill', ctx.grpc.status.UNAVAILABLE, 'relay restarting', 1);
  let result = await m.killFlag('checkout', 'oncall');
  assert.equal(result.status, 'pending', \`the PushKill failed UNAVAILABLE and killFlag answered \${JSON.stringify(result)}: a failed push is queued in flags:push:pending and answered pending\`);
  const calls = ctx.grpc.callsTo('PushKill').length;
  assert.equal(calls, 1, \`a failed push was retried in place (\${calls} calls): the retrier owns it once it is queued\`);
  const rows = ctx.redis.lrange('flags:push:pending', 0, -1);
  assert.equal(rows.length, 1, \`flags:push:pending holds \${JSON.stringify(rows)}, expected one row for the failed push\`);
  assert.deepStrictEqual(JSON.parse(rows[0]), {flag_key: 'checkout', version: 5, actor: 'oncall'}, \`the pending row is \${rows[0]}, expected flag_key checkout, version 5, actor oncall\`);
  assert(await killed('checkout'), 'the kill must be in the snapshot even when the push failed');
  result = await m.killFlag('search-v2', 'oncall');
  assert.equal(result.status, 'pushed', \`with the relay back killFlag answered \${JSON.stringify(result)}\`);
  assert.equal(ctx.redis.lrange('flags:push:pending', 0, -1).length, 1, 'a push that landed must not add a pending row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc/codes"

	"flags/engine"
	pb "flags/gen/feature_flags"

	"leetbuild/harness"
)

var killBg = context.Background()

type killSeen struct {
	flagKey  string
	version  int64
	snapshot *engine.Snapshot
}

// killPeer records each push with the snapshot Redis held when it arrived (what a refetch would read).
type killPeer struct {
	pb.UnimplementedRelayServer
	seen []killSeen
}

func (p *killPeer) PushKill(ctx context.Context, req *pb.KillRequest) (*pb.KillAck, error) {
	s, _ := engine.ReadSnapshot(ctx)
	p.seen = append(p.seen, killSeen{req.GetFlagKey(), req.GetVersion(), s})
	return &pb.KillAck{AppliedVersion: req.GetVersion()}, nil
}

func killSetup(ctx *harness.Ctx) *killPeer {
	peer := &killPeer{}
	pb.RegisterRelayServer(ctx.GRPC.Server(""), peer)
	base := engine.Snapshot{Version: 4, Flags: map[string]engine.Flag{
		"checkout":  {Rollout: 100, Salt: "2026"},
		"search-v2": {Rollout: 100, Salt: "2026"},
	}}
	moved, err := engine.PublishSnapshot(killBg, base)
	ctx.Assert(err == nil && moved, "seeding version 4 failed: %v", err)
	return peer
}

func killRun(ctx *harness.Ctx, flagKey string) killResult {
	result, err := killFlag(killBg, flagKey, "oncall")
	ctx.NoError(err, "killFlag(%s) failed", flagKey)
	return result
}

func killIsKilled(flagKey string) bool {
	d, _ := engine.Evaluate(killBg, flagKey, map[string]string{"user_id": "u-7"})
	return d != nil && d.Reason == "killed"
}

func CheckDeadline(ctx *harness.Ctx) {
	killSetup(ctx)
	result := killRun(ctx, "checkout")
	ctx.Equal(result.Status, "pushed", "with the relay healthy, the status killFlag answers")
	calls := ctx.GRPC.CallsTo("PushKill", "")
	ctx.Equal(len(calls), 1, "one kill, the PushKill calls")
	ctx.Assert(calls[0].HasDeadline(), "the PushKill call carries no deadline: a relay that hangs holds the operator's kill open")
	ctx.Assert(500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 1500*time.Millisecond, "the PushKill call carries a %v deadline, expected 1 s", calls[0].Timeout)
	ctx.GRPC.SetLatency("PushKill", 30.0, "")
	started := ctx.Clock.Now()
	killRun(ctx, "search-v2")
	elapsed := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(elapsed <= 2.0, "with the relay hung, killFlag held the operator for %.1f s: the push needs a 1-second deadline", elapsed)
	ctx.Assert(killIsKilled("search-v2"), "after a kill whose push timed out, search-v2 must evaluate as killed: the kill must be in the snapshot")
}

func CheckCommitFirst(ctx *harness.Ctx) {
	peer := killSetup(ctx)
	result := killRun(ctx, "checkout")
	ctx.Equal(result.Version, int64(5), "the version the kill publishes")
	ctx.Assert(len(peer.seen) > 0, "no PushKill reached the relay")
	seen := peer.seen[0]
	ctx.Assert(seen.flagKey == "checkout" && seen.version == 5, "the relay got a push for %s version %d, expected checkout version 5", seen.flagKey, seen.version)
	held := int64(0)
	if seen.snapshot != nil {
		held = seen.snapshot.Version
	}
	ctx.Assert(held == 5 && seen.snapshot.Flags["checkout"].Killed, "when the push for version 5 arrived, Redis held version %d: a relay that refetches on the push reads the old snapshot and keeps serving checkout. Publish the killed snapshot, then push", held)
	ctx.Assert(killIsKilled("checkout"), "after the kill checkout must evaluate as killed")
}

func CheckPending(ctx *harness.Ctx) {
	killSetup(ctx)
	ctx.GRPC.Fail("PushKill", codes.Unavailable, "relay restarting", 1, "")
	result := killRun(ctx, "checkout")
	ctx.Equal(result.Status, "pending", "the PushKill failed UNAVAILABLE: a failed push is queued in flags:push:pending and answered pending; the status")
	ctx.Equal(len(ctx.GRPC.CallsTo("PushKill", "")), 1, "a failed push is queued for the retrier, not retried in place; the PushKill calls")
	rows := ctx.Redis.LRange("flags:push:pending", 0, -1)
	ctx.Equal(len(rows), 1, "flags:push:pending must hold one row for the failed push (%v); rows", rows)
	var row map[string]any
	ctx.NoError(json.Unmarshal([]byte(rows[0]), &row), "the pending row must be JSON (%s)", rows[0])
	ctx.Assert(row["flag_key"] == "checkout" && row["version"] == float64(5) && row["actor"] == "oncall", "the pending row is %s, expected flag_key checkout, version 5, actor oncall", rows[0])
	ctx.Assert(killIsKilled("checkout"), "the kill must be in the snapshot even when the push failed")
	ctx.Equal(killRun(ctx, "search-v2").Status, "pushed", "with the relay back, the status")
	ctx.Equal(len(ctx.Redis.LRange("flags:push:pending", 0, -1)), 1, "a push that landed must not add a pending row; rows")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "feature_flags.grpc.pb.h"
#include "flags/engine.h"

namespace {

struct KillSeen {
  std::string flag_key;
  long long version = 0;
  std::optional<nlohmann::json> snapshot;
};

// Records each push with the snapshot Redis held when it arrived (what a refetch would read).
class KillPeer final : public flagrelay::Relay::Service {
 public:
  std::vector<KillSeen> seen;
  grpc::Status PushKill(grpc::ServerContext*, const flagrelay::KillRequest* req, flagrelay::KillAck* out) override {
    seen.push_back({req->flag_key(), req->version(), engine::readSnapshot()});
    out->set_applied_version(req->version());
    return grpc::Status::OK;
  }
};

KillPeer& killSetup(harness::Ctx& ctx) {
  static KillPeer* peer = nullptr;
  delete peer;
  peer = new KillPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  const nlohmann::json flag = {{"default", false}, {"rules", nlohmann::json::array()}, {"rollout", 100}, {"salt", "2026"}, {"killed", false}};
  ctx.Assert(engine::publishSnapshot({{"version", 4}, {"flags", {{"checkout", flag}, {"search-v2", flag}}}}), "seeding version 4 failed");
  return *peer;
}

nlohmann::json killRun(harness::Ctx& ctx, const std::string& flag_key) {
  try {
    return killFlag(flag_key, "oncall");
  } catch (const std::exception& e) {
    ctx.Fatalf("killFlag(%s) threw %s: %s", flag_key, harness::CurrentExceptionType(), e.what());
  }
}

bool killIsKilled(const std::string& flag_key) {
  const auto d = engine::evaluate(flag_key, {{"user_id", "u-7"}});
  return d && d->value("reason", "") == "killed";
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  killSetup(ctx);
  const auto result = killRun(ctx, "checkout");
  ctx.Equal(result.value("status", ""), "pushed", "with the relay healthy, the status killFlag answers");
  const auto calls = ctx.GRPC.CallsTo("PushKill");
  ctx.Equal(calls.size(), 1, "one kill, the PushKill calls");
  ctx.Assert(calls[0].HasDeadline(), "the PushKill call carries no deadline: a relay that hangs holds the operator's kill open");
  ctx.Assert(0.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 1.5, "the PushKill call carries a %v s deadline, expected 1 s", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("PushKill", 30.0);
  const int64_t started = ctx.Clock.Now();
  killRun(ctx, "search-v2");
  const double elapsed = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(elapsed <= 2.0, "with the relay hung, killFlag held the operator for %v s: the push needs a 1-second deadline", elapsed);
  ctx.Assert(killIsKilled("search-v2"), "after a kill whose push timed out, search-v2 must evaluate as killed: the kill must be in the snapshot");
}

void CheckCommitFirst(harness::Ctx& ctx) {
  KillPeer& peer = killSetup(ctx);
  const auto result = killRun(ctx, "checkout");
  ctx.Equal(result.value("version", 0LL), 5LL, "the version the kill publishes");
  ctx.Assert(!peer.seen.empty(), "no PushKill reached the relay");
  const KillSeen& seen = peer.seen[0];
  ctx.Assert(seen.flag_key == "checkout" && seen.version == 5, "the relay got a push for %s version %d, expected checkout version 5", seen.flag_key, seen.version);
  const long long held = seen.snapshot ? seen.snapshot->value("version", 0LL) : 0LL;
  ctx.Assert(held == 5 && seen.snapshot->at("flags").at("checkout").value("killed", false), "when the push for version 5 arrived, Redis held version %d: a relay that refetches on the push reads the old snapshot and keeps serving checkout. Publish the killed snapshot, then push", held);
  ctx.Assert(killIsKilled("checkout"), "after the kill checkout must evaluate as killed");
}

void CheckPending(harness::Ctx& ctx) {
  killSetup(ctx);
  ctx.GRPC.Fail("PushKill", grpc::StatusCode::UNAVAILABLE, "relay restarting", 1);
  const auto result = killRun(ctx, "checkout");
  ctx.Equal(result.value("status", ""), "pending", "the PushKill failed UNAVAILABLE: a failed push is queued in flags:push:pending and answered pending; the status");
  ctx.Equal(ctx.GRPC.CallsTo("PushKill").size(), 1, "a failed push is queued for the retrier, not retried in place; the PushKill calls");
  const auto rows = ctx.Redis.LRange("flags:push:pending", 0, -1);
  ctx.Equal(rows.size(), 1, "flags:push:pending must hold one row for the failed push (%v); rows", rows);
  const auto row = nlohmann::json::parse(rows[0], nullptr, false);
  ctx.Assert(row == nlohmann::json{{"flag_key", "checkout"}, {"version", 5}, {"actor", "oncall"}}, "the pending row is %s, expected flag_key checkout, version 5, actor oncall", rows[0]);
  ctx.Assert(killIsKilled("checkout"), "the kill must be in the snapshot even when the push failed");
  ctx.Equal(killRun(ctx, "search-v2").value("status", ""), "pushed", "with the relay back, the status");
  ctx.Equal(ctx.Redis.LRange("flags:push:pending", 0, -1).size(), 1, "a push that landed must not add a pending row; rows");
}
`,
  },
  hints: [
    'Hang the relay and kill a flag: the operator waits as long as the relay does. Watch a relay that refetches on the push: it reads the old snapshot. Take the relay down: the kill says pushed.',
    'The call has no deadline and sleeps between five attempts; the push is sent before `publish_snapshot` runs; when every attempt fails, nothing records it and the answer is still pushed.',
    'Publish the killed snapshot first; then one `PushKill(request, timeout=KILL_DEADLINE_S)`; on `grpc.RpcError`, RPUSH `{flag_key, version, actor}` to `flags:push:pending` and answer `pending`.',
  ],
  debrief: `A kill is a correctness event, so the order is fixed: the snapshot is the truth and the push only shortens the wait for it. Committing first means anything that reacts to the push reads the kill; the deadline bounds what one bad relay can cost the operator, and SDK polling bounds what a lost push costs users. Retrying in place made both worse, so the failure goes to a list another worker drains with its own backoff, and the answer says \`pending\` because that is the truth. Production kill paths fan the push out to every relay in parallel, carry the version so a relay ignores a push older than what it has, and page someone when the pending list does not drain.`,
};
