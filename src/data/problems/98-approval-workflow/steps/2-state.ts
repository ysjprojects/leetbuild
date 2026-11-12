import type {Step} from '@/lib/types';

import {ADVANCE_LUA, ADVANCE_LUA_SCALA} from '../support';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis approval state with one compare-and-swap per decision',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the state of one approval chain, the module the submit and the
decision path share: \`start_chain(request_id, approvers)\` stores
\`{step_index, status, approvers, decisions}\` as JSON under \`approval:{request_id}:state\` with a
one-hour TTL; \`advance(request_id, step_index, actor, decision)\` reads it, appends the decision,
sets \`step_index\` to the number of decisions, writes it back and answers
\`{advanced, step_index, status, reason}\`. Approving a chain step by step works. It hides 5 flaws.

**Failure mode the checks target.** A double click advances two steps; two app servers handling one
approval both report it; the CFO signs the manager's step; a rejection moves the chain on; a chain
that waits past the hour is gone.

- The state is **one hash**: \`step_index\`, \`step_count\`, \`status\`, \`current_approver\`,
  \`approver:{i}\`, then \`decision:{i}\` and \`actor:{i}\` per decided step. No TTL.
- \`advance\` is **one Lua script** (\`EVAL\`): refuse a closed chain (\`chain closed\`), a \`step_index\`
  that is not the current one (\`stale step\`) and an actor who is not \`current_approver\`
  (\`not the current approver\`); then record the decision and move exactly one step.
- \`rejected\` sets \`status\` to \`rejected\` and closes the chain; the last approval sets \`approved\`.`,
  sequence: {
    participants: ['Approver', 'Approval API', 'Redis'],
    messages: [
      {from: 'Approver', to: 'Approval API', label: 'approve step 0 (double click)', kind: 'sync'},
      {
        from: 'Approval API',
        to: 'Redis',
        label: 'EVAL advance · approval:r-1:state · [0, u-mgr, approved]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Approval API', label: "{'1', '1', 'pending', ''}", kind: 'reply'},
      {from: 'Approval API', to: 'Redis', label: 'EVAL advance · the same call again', kind: 'sync'},
      {from: 'Redis', to: 'Approval API', label: "{'0', '1', 'pending', 'stale step'}", kind: 'reply'},
      {from: 'Approval API', to: 'Approver', label: 'advanced once, step_index 1', kind: 'reply'},
    ],
  },
  hints: [
    'Approve step 0 twice as the manager: both calls answer `advanced: true` and the chain jumps to step 2. Let the CFO approve step 0, or reject it: the chain moves on either way.',
    'The step index is the length of a list, so it counts calls, not steps; nothing compares the caller with an approver; and the GET, append, SET sequence lets two servers read the same blob and both write.',
    'HSET the fields in `start_chain` with no expiry; in one `EVAL`, compare `ARGV[1]` with `step_index` and `ARGV[2]` with `current_approver`, HSET `decision:{i}`, then either `status rejected` or `step_index = index + 1`.',
  ],
  checks: [
    {
      id: 'state-hash',
      title: 'Keeps the state in one hash with no TTL',
      detail:
        'The state is a hash with `step_index`, `step_count`, `status`, `current_approver` and `approver:{i}`, written without an expiry, so a chain that waits three weeks is still there.',
      match: {
        python: {all: [/\.hset\(/, /current_approver/], none: [/\bex\s*=/, /\.expire\(/, /setex\(/]},
        typescript: {all: [/\.hset\(/, /current_approver/], none: [/['"]EX['"]/, /\.expire\(/, /setex\(/]},
        go: {all: [/\.HSet\(/, /current_approver/], none: [/time\.(Hour|Minute)/, /\.Expire\(/, /SetEX\(/]},
        scala: {all: [/\.hset\(/, /current_approver/], none: [/setex\(/, /\.expire\(/, /TtlSeconds/]},
        cpp: {all: [/\.hset\(/, /current_approver/], none: [/kTtl/, /\.expire\(/, /setex\(/]},
      },
    },
    {
      id: 'single-step',
      title: 'Compares the step index and advances exactly one step',
      detail:
        'The script refuses a `step_index` (`ARGV[1]`) that is not the stored one with `stale step` and moves the index by one, so a repeated approval cannot skip a step.',
      match: {
        python: {all: [/ARGV\[1\][^\n]*~=|~=[^\n]*ARGV\[1\]/, /index \+ 1/]},
        typescript: {all: [/ARGV\[1\][^\n]*~=|~=[^\n]*ARGV\[1\]/, /index \+ 1/]},
        go: {all: [/ARGV\[1\][^\n]*~=|~=[^\n]*ARGV\[1\]/, /index \+ 1/]},
        scala: {all: [/ARGV\[1\][^\n]*~=|~=[^\n]*ARGV\[1\]/, /index \+ 1/]},
        cpp: {all: [/ARGV\[1\][^\n]*~=|~=[^\n]*ARGV\[1\]/, /index \+ 1/]},
      },
    },
    {
      id: 'current-approver',
      title: 'Only the current step’s approver may decide',
      detail:
        'The script compares the actor (`ARGV[2]`) with `current_approver` and refuses anybody else with `not the current approver`.',
      match: {
        python: {all: [/ARGV\[2\][^\n]*~=|~=[^\n]*ARGV\[2\]/, /not the current approver/]},
        typescript: {all: [/ARGV\[2\][^\n]*~=|~=[^\n]*ARGV\[2\]/, /not the current approver/]},
        go: {all: [/ARGV\[2\][^\n]*~=|~=[^\n]*ARGV\[2\]/, /not the current approver/]},
        scala: {all: [/ARGV\[2\][^\n]*~=|~=[^\n]*ARGV\[2\]/, /not the current approver/]},
        cpp: {all: [/ARGV\[2\][^\n]*~=|~=[^\n]*ARGV\[2\]/, /not the current approver/]},
      },
    },
    {
      id: 'rejection-ends',
      title: 'A rejection closes the chain',
      detail:
        'A `rejected` decision sets `status` to `rejected` without moving the index, and every later decision is refused with `chain closed`.',
      match: {
        python: {all: [/['"]status['"]\s*,\s*['"]rejected['"]/, /chain closed/]},
        typescript: {all: [/['"]status['"]\s*,\s*['"]rejected['"]/, /chain closed/]},
        go: {all: [/['"]status['"]\s*,\s*['"]rejected['"]/, /chain closed/]},
        scala: {all: [/['"]status['"]\s*,\s*['"]rejected['"]/, /chain closed/]},
        cpp: {all: [/['"]status['"]\s*,\s*['"]rejected['"]/, /chain closed/]},
      },
    },
    {
      id: 'atomic-decision',
      title: 'Decides in one atomic script',
      detail:
        'The read, the comparisons and the writes run inside one `EVAL`, so a second server handling the same approval sees the first one’s result; the client never reads the state and writes it back.',
      match: {
        python: {all: [/register_script\(|\.eval\(/], none: [/\br\.get\(/, /\br\.set\(/]},
        typescript: {all: [/\.eval\(|defineCommand\(/], none: [/redis\.get\(/, /redis\.set\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/], none: [/rdb\.Get\(/, /rdb\.Set\(/]},
        scala: {all: [/\.eval(sha)?\(/], none: [/jedis\.get\(/, /jedis\.setex\(|jedis\.set\(/]},
        cpp: {all: [/\.eval(sha)?[<(]/], none: [/redis\(\)\.get\(/, /redis\(\)\.set\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600  # an hour is plenty for a decision


def state_key(request_id: str) -> str:
    return f"approval:{request_id}:state"


def start_chain(request_id: str, approvers: list[str]) -> None:
    """Open the chain at step 0 with the pinned approvers."""
    state = {"step_index": 0, "status": "pending", "approvers": approvers, "decisions": []}
    r.set(state_key(request_id), json.dumps(state), ex=TTL_S)


def advance(request_id: str, step_index: int, actor: str, decision: str) -> dict:
    """Record actor's decision ("approved" or "rejected") on step step_index; answers {advanced, step_index, status, reason}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    raw = r.get(state_key(request_id))
    if raw is None:
        return {"advanced": False, "step_index": -1, "status": "missing", "reason": "no such request"}
    state = json.loads(raw)
    if state["status"] != "pending":
        return {"advanced": False, "step_index": state["step_index"], "status": state["status"], "reason": "closed"}
    state["decisions"].append({"actor": actor, "decision": decision})
    state["step_index"] = len(state["decisions"])
    if state["step_index"] >= len(state["approvers"]):
        state["status"] = "approved"
    r.set(state_key(request_id), json.dumps(state), ex=TTL_S)
    return {"advanced": True, "step_index": state["step_index"], "status": state["status"], "reason": ""}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# One decision, atomically: refuse a closed chain, a stale step and anybody but the current approver,
# record the decision, then move exactly one step (a rejection closes the chain instead).
ADVANCE_LUA = """
${ADVANCE_LUA}"""
advance_script = r.register_script(ADVANCE_LUA)


def state_key(request_id: str) -> str:
    return f"approval:{request_id}:state"


def start_chain(request_id: str, approvers: list[str]) -> None:
    """Open the chain at step 0 with the pinned approvers."""
    # One hash and no TTL: a chain may wait weeks; a sweeper removes closed ones.
    fields = {"step_index": 0, "step_count": len(approvers), "status": "pending", "current_approver": approvers[0]}
    for i, approver in enumerate(approvers):
        fields[f"approver:{i}"] = approver
    r.hset(state_key(request_id), mapping=fields)


def advance(request_id: str, step_index: int, actor: str, decision: str) -> dict:
    """Record actor's decision ("approved" or "rejected") on step step_index; answers {advanced, step_index, status, reason}."""
    advanced, index, status, reason = advance_script(keys=[state_key(request_id)], args=[step_index, actor, decision])
    return {"advanced": advanced == "1", "step_index": int(index), "status": status, "reason": reason}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

const TTL_S = 3600; // an hour is plenty for a decision

export interface Outcome {
  advanced: boolean;
  step_index: number;
  status: string;
  reason: string;
}

interface ChainState {
  step_index: number;
  status: string;
  approvers: string[];
  decisions: {actor: string; decision: string}[];
}

export const stateKey = (requestId: string): string => \`approval:\${requestId}:state\`;

/** Open the chain at step 0 with the pinned approvers. */
export async function startChain(requestId: string, approvers: string[]): Promise<void> {
  const state: ChainState = {step_index: 0, status: 'pending', approvers, decisions: []};
  await redis.set(stateKey(requestId), JSON.stringify(state), 'EX', TTL_S);
}

/** Record actor's decision ("approved" or "rejected") on step stepIndex. */
export async function advance(requestId: string, stepIndex: number, actor: string, decision: string): Promise<Outcome> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const raw = await redis.get(stateKey(requestId));
  if (raw === null) return {advanced: false, step_index: -1, status: 'missing', reason: 'no such request'};
  const state = JSON.parse(raw) as ChainState;
  if (state.status !== 'pending') return {advanced: false, step_index: state.step_index, status: state.status, reason: 'closed'};
  state.decisions.push({actor, decision});
  state.step_index = state.decisions.length;
  if (state.step_index >= state.approvers.length) state.status = 'approved';
  await redis.set(stateKey(requestId), JSON.stringify(state), 'EX', TTL_S);
  return {advanced: true, step_index: state.step_index, status: state.status, reason: ''};
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

// One decision, atomically: refuse a closed chain, a stale step and anybody but the current approver,
// record the decision, then move exactly one step (a rejection closes the chain instead).
export const ADVANCE_LUA = \`
${ADVANCE_LUA}\`;

export interface Outcome {
  advanced: boolean;
  step_index: number;
  status: string;
  reason: string;
}

export const stateKey = (requestId: string): string => \`approval:\${requestId}:state\`;

/** Open the chain at step 0 with the pinned approvers. */
export async function startChain(requestId: string, approvers: string[]): Promise<void> {
  // One hash and no TTL: a chain may wait weeks; a sweeper removes closed ones.
  const fields: Record<string, string> = {
    step_index: '0',
    step_count: String(approvers.length),
    status: 'pending',
    current_approver: approvers[0],
  };
  approvers.forEach((approver, i) => {
    fields[\`approver:\${i}\`] = approver;
  });
  await redis.hset(stateKey(requestId), fields);
}

/** Record actor's decision ("approved" or "rejected") on step stepIndex. */
export async function advance(requestId: string, stepIndex: number, actor: string, decision: string): Promise<Outcome> {
  const [advanced, index, status, reason] = (await redis.eval(ADVANCE_LUA, 1, stateKey(requestId), String(stepIndex), actor, decision)) as string[];
  return {advanced: advanced === '1', step_index: Number(index), status, reason};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttl = time.Hour // an hour is plenty for a decision

// Outcome is what a decision did to the chain.
type Outcome struct {
	Advanced  bool   \`json:"advanced"\`
	StepIndex int    \`json:"step_index"\`
	Status    string \`json:"status"\`
	Reason    string \`json:"reason"\`
}

type decided struct {
	Actor    string \`json:"actor"\`
	Decision string \`json:"decision"\`
}

type chainState struct {
	StepIndex int       \`json:"step_index"\`
	Status    string    \`json:"status"\`
	Approvers []string  \`json:"approvers"\`
	Decisions []decided \`json:"decisions"\`
}

func stateKey(requestID string) string {
	return "approval:" + requestID + ":state"
}

// startChain opens the chain at step 0 with the pinned approvers.
func startChain(ctx context.Context, requestID string, approvers []string) error {
	raw, _ := json.Marshal(chainState{Status: "pending", Approvers: approvers, Decisions: []decided{}})
	return rdb.Set(ctx, stateKey(requestID), raw, ttl).Err()
}

// advance records actor's decision ("approved" or "rejected") on step stepIndex.
func advance(ctx context.Context, requestID string, stepIndex int, actor, decision string) (Outcome, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	raw, err := rdb.Get(ctx, stateKey(requestID)).Result()
	if err == redis.Nil {
		return Outcome{StepIndex: -1, Status: "missing", Reason: "no such request"}, nil
	}
	if err != nil {
		return Outcome{}, err
	}
	var state chainState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return Outcome{}, err
	}
	if state.Status != "pending" {
		return Outcome{StepIndex: state.StepIndex, Status: state.Status, Reason: "closed"}, nil
	}
	state.Decisions = append(state.Decisions, decided{Actor: actor, Decision: decision})
	state.StepIndex = len(state.Decisions)
	if state.StepIndex >= len(state.Approvers) {
		state.Status = "approved"
	}
	updated, _ := json.Marshal(state)
	if err := rdb.Set(ctx, stateKey(requestID), updated, ttl).Err(); err != nil {
		return Outcome{}, err
	}
	return Outcome{Advanced: true, StepIndex: state.StepIndex, Status: state.Status}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// advanceScript is one decision, atomically: refuse a closed chain, a stale step and anybody but the
// current approver, record the decision, then move exactly one step (a rejection closes the chain instead).
var advanceScript = redis.NewScript(\`
${ADVANCE_LUA}\`)

// Outcome is what a decision did to the chain.
type Outcome struct {
	Advanced  bool   \`json:"advanced"\`
	StepIndex int    \`json:"step_index"\`
	Status    string \`json:"status"\`
	Reason    string \`json:"reason"\`
}

func stateKey(requestID string) string {
	return "approval:" + requestID + ":state"
}

// startChain opens the chain at step 0 with the pinned approvers.
func startChain(ctx context.Context, requestID string, approvers []string) error {
	// One hash and no TTL: a chain may wait weeks; a sweeper removes closed ones.
	fields := []any{"step_index", "0", "step_count", strconv.Itoa(len(approvers)), "status", "pending", "current_approver", approvers[0]}
	for i, approver := range approvers {
		fields = append(fields, fmt.Sprintf("approver:%d", i), approver)
	}
	return rdb.HSet(ctx, stateKey(requestID), fields...).Err()
}

// advance records actor's decision ("approved" or "rejected") on step stepIndex.
func advance(ctx context.Context, requestID string, stepIndex int, actor, decision string) (Outcome, error) {
	reply, err := advanceScript.Run(ctx, rdb, []string{stateKey(requestID)}, stepIndex, actor, decision).StringSlice()
	if err != nil {
		return Outcome{}, err
	}
	index, _ := strconv.Atoi(reply[1])
	return Outcome{Advanced: reply[0] == "1", StepIndex: index, Status: reply[2], Reason: reply[3]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

object State {
  final case class Outcome(advanced: Boolean, stepIndex: Long, status: String, reason: String)

  val jedis = new JedisPooled("redis", 6379)
  val TtlSeconds = 3600L // an hour is plenty for a decision

  def stateKey(requestId: String): String = s"approval:$requestId:state"

  /** Open the chain at step 0 with the pinned approvers. */
  def startChain(requestId: String, approvers: Seq[String]): Unit = {
    val state = JsObject("step_index" -> JsNumber(0), "status" -> JsString("pending"), "approvers" -> approvers.toVector.toJson, "decisions" -> JsArray())
    jedis.setex(stateKey(requestId), TtlSeconds, state.compactPrint)
  }

  /** Record actor's decision ("approved" or "rejected") on step stepIndex. */
  def advance(requestId: String, stepIndex: Long, actor: String, decision: String): Outcome = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val raw = jedis.get(stateKey(requestId))
    if (raw == null) return Outcome(advanced = false, -1, "missing", "no such request")
    val state = raw.parseJson.asJsObject.fields
    val status = state("status").convertTo[String]
    val index = state("step_index").convertTo[Long]
    if (status != "pending") return Outcome(advanced = false, index, status, "closed")
    val decisions = state("decisions").asInstanceOf[JsArray].elements :+ JsObject("actor" -> JsString(actor), "decision" -> JsString(decision))
    val nextIndex = decisions.size.toLong
    val nextStatus = if (nextIndex >= state("approvers").asInstanceOf[JsArray].elements.size) "approved" else "pending"
    val updated = JsObject(state ++ Map("step_index" -> JsNumber(nextIndex), "status" -> JsString(nextStatus), "decisions" -> JsArray(decisions)))
    jedis.setex(stateKey(requestId), TtlSeconds, updated.compactPrint)
    Outcome(advanced = true, nextIndex, nextStatus, "")
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class Outcome(advanced: Boolean, stepIndex: Long, status: String, reason: String)

  val jedis = new JedisPooled("redis", 6379)

  // One decision, atomically: refuse a closed chain, a stale step and anybody but the current approver,
  // record the decision, then move exactly one step (a rejection closes the chain instead).
  val AdvanceLua: String =
    """${ADVANCE_LUA_SCALA}
      |""".stripMargin

  def stateKey(requestId: String): String = s"approval:$requestId:state"

  /** Open the chain at step 0 with the pinned approvers. */
  def startChain(requestId: String, approvers: Seq[String]): Unit = {
    // One hash and no TTL: a chain may wait weeks; a sweeper removes closed ones.
    val fields = Map("step_index" -> "0", "step_count" -> approvers.size.toString, "status" -> "pending", "current_approver" -> approvers.head) ++
      approvers.zipWithIndex.map { case (approver, i) => s"approver:$i" -> approver }
    jedis.hset(stateKey(requestId), fields.asJava)
  }

  /** Record actor's decision ("approved" or "rejected") on step stepIndex. */
  def advance(requestId: String, stepIndex: Long, actor: String, decision: String): Outcome = {
    val reply = jedis
      .eval(AdvanceLua, List(stateKey(requestId)).asJava, List(stepIndex.toString, actor, decision).asJava)
      .asInstanceOf[java.util.List[String]]
      .asScala
    Outcome(reply(0) == "1", reply(1).toLong, reply(2), reply(3))
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long kTtlSeconds = 3600;  // an hour is plenty for a decision

// What a decision did to the chain.
struct Outcome {
  bool advanced = false;
  long step_index = 0;
  std::string status;
  std::string reason;
};

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string stateKey(const std::string& request_id) { return "approval:" + request_id + ":state"; }

// Open the chain at step 0 with the pinned approvers.
void startChain(const std::string& request_id, const std::vector<std::string>& approvers) {
  const json state = {{"step_index", 0}, {"status", "pending"}, {"approvers", approvers}, {"decisions", json::array()}};
  redis().set(stateKey(request_id), state.dump(), std::chrono::seconds(kTtlSeconds));
}

// Record actor's decision ("approved" or "rejected") on step step_index.
Outcome advance(const std::string& request_id, long step_index, const std::string& actor, const std::string& decision) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto raw = redis().get(stateKey(request_id));
  if (!raw) return Outcome{false, -1, "missing", "no such request"};
  json state = json::parse(*raw);
  if (state["status"] != "pending") return Outcome{false, state["step_index"].get<long>(), state["status"].get<std::string>(), "closed"};
  state["decisions"].push_back({{"actor", actor}, {"decision", decision}});
  state["step_index"] = state["decisions"].size();
  if (state["step_index"].get<size_t>() >= state["approvers"].size()) state["status"] = "approved";
  redis().set(stateKey(request_id), state.dump(), std::chrono::seconds(kTtlSeconds));
  return Outcome{true, state["step_index"].get<long>(), state["status"].get<std::string>(), ""};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <utility>
#include <vector>

// What a decision did to the chain.
struct Outcome {
  bool advanced = false;
  long step_index = 0;
  std::string status;
  std::string reason;
};

// One decision, atomically: refuse a closed chain, a stale step and anybody but the current approver,
// record the decision, then move exactly one step (a rejection closes the chain instead).
const std::string kAdvanceLua = R"lua(
${ADVANCE_LUA})lua";

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string stateKey(const std::string& request_id) { return "approval:" + request_id + ":state"; }

// Open the chain at step 0 with the pinned approvers.
void startChain(const std::string& request_id, const std::vector<std::string>& approvers) {
  // One hash and no TTL: a chain may wait weeks; a sweeper removes closed ones.
  std::vector<std::pair<std::string, std::string>> fields = {
      {"step_index", "0"}, {"step_count", std::to_string(approvers.size())}, {"status", "pending"}, {"current_approver", approvers.at(0)}};
  for (size_t i = 0; i < approvers.size(); i++) fields.emplace_back("approver:" + std::to_string(i), approvers[i]);
  redis().hset(stateKey(request_id), fields.begin(), fields.end());
}

// Record actor's decision ("approved" or "rejected") on step step_index.
Outcome advance(const std::string& request_id, long step_index, const std::string& actor, const std::string& decision) {
  std::vector<std::string> reply;
  redis().eval(kAdvanceLua, {stateKey(request_id)}, {std::to_string(step_index), actor, decision}, std::back_inserter(reply));
  return Outcome{reply.at(0) == "1", std::stol(reply.at(1)), reply.at(2), reply.at(3)};
}
`,
    },
  },
  harness: {
    python: `APPROVERS = ["u-mgr", "u-dir", "u-cfo"]
KEY = "approval:r-1:state"


def _chain(ctx):
    m = ctx.load("state")
    m.start_chain("r-1", APPROVERS)
    return m


def _refused(outcome, reason, why):
    assert outcome.get("advanced") is False, f"{why}: advance answered {outcome}, expected advanced false"
    assert outcome.get("reason") == reason, f"{why}: advance answered reason {outcome.get('reason')!r}, expected {reason!r}"


def check_state_hash(ctx):
    m = _chain(ctx)
    kind = ctx.redis.type(KEY)
    assert kind == "hash", f"{KEY} is a {kind}: the state of a request is one hash (step_index, step_count, status, current_approver, approver:{{i}})"
    expected = {"step_index": "0", "step_count": "3", "status": "pending", "current_approver": "u-mgr", "approver:0": "u-mgr", "approver:1": "u-dir", "approver:2": "u-cfo"}
    assert ctx.redis.hgetall(KEY) == expected, f"start_chain wrote {ctx.redis.hgetall(KEY)}, expected {expected}"
    assert ctx.redis.ttl(KEY) == -1, f"{KEY} expires in {ctx.redis.ttl(KEY)} s: a chain can wait weeks for its approvers"
    m.advance("r-1", 0, "u-mgr", "approved")
    fields = ctx.redis.hgetall(KEY)
    assert (fields.get("step_index"), fields.get("current_approver"), fields.get("decision:0"), fields.get("actor:0")) == ("1", "u-dir", "approved", "u-mgr"), f"after the manager's approval the state is {fields}"
    assert ctx.redis.ttl(KEY) == -1, f"after a decision {KEY} expires in {ctx.redis.ttl(KEY)} s"


def check_single_step(ctx):
    m = _chain(ctx)
    first = m.advance("r-1", 0, "u-mgr", "approved")
    assert first == {"advanced": True, "step_index": 1, "status": "pending", "reason": ""}, f"the manager's approval of step 0 answered {first}"
    again = m.advance("r-1", 0, "u-mgr", "approved")
    _refused(again, "stale step", "a repeated approval of step 0 (a double click)")
    assert again.get("step_index") == 1, f"a repeated approval moved the chain to step {again.get('step_index')}, expected it to stay on 1"
    ahead = m.advance("r-1", 2, "u-dir", "approved")
    _refused(ahead, "stale step", "a decision on step 2 while the chain is on step 1")
    second = m.advance("r-1", 1, "u-dir", "approved")
    assert second.get("advanced") is True and second.get("status") == "pending" and second.get("step_index") == 2, f"the director's approval of step 1 answered {second}: one signature is still missing"
    last = m.advance("r-1", 2, "u-cfo", "approved")
    assert last.get("status") == "approved" and last.get("step_index") == 3, f"the last approval answered {last}, expected status approved"


def check_current_approver(ctx):
    m = _chain(ctx)
    _refused(m.advance("r-1", 0, "u-dir", "approved"), "not the current approver", "the director approving the manager's step 0")
    _refused(m.advance("r-1", 0, "u-intruder", "approved"), "not the current approver", "an actor who is on no step")
    ok = m.advance("r-1", 0, "u-mgr", "approved")
    assert ok.get("advanced") is True and ok.get("step_index") == 1, f"the manager's approval of step 0 answered {ok}"
    _refused(m.advance("r-1", 1, "u-cfo", "approved"), "not the current approver", "the CFO approving the director's step 1")


def check_rejection_ends(ctx):
    m = _chain(ctx)
    m.advance("r-1", 0, "u-mgr", "approved")
    rejected = m.advance("r-1", 1, "u-dir", "rejected")
    assert rejected == {"advanced": True, "step_index": 1, "status": "rejected", "reason": ""}, f"the director's rejection answered {rejected}, expected the chain closed as rejected on step 1"
    _refused(m.advance("r-1", 1, "u-dir", "approved"), "chain closed", "an approval after the rejection")
    _refused(m.advance("r-1", 2, "u-cfo", "approved"), "chain closed", "the CFO deciding a rejected chain")


def check_atomic_decision(ctx):
    m = _chain(ctx)
    # Two app servers handle the same approval: the second lands right after the first touched the state.
    rival = ctx.redis_after(KEY, lambda: m.advance("r-1", 0, "u-mgr", "approved"))
    mine = m.advance("r-1", 0, "u-mgr", "approved")
    assert rival.fired, "advance never touched the state hash"
    if rival.error is not None:
        raise rival.error
    both = [rival.result, mine]
    assert sum(1 for o in both if o.get("advanced")) == 1, f"two servers handling one approval answered {both}: exactly one may advance the chain"
    nxt = m.advance("r-1", 1, "u-dir", "approved")
    assert nxt.get("advanced") is True and nxt.get("step_index") == 2 and nxt.get("status") == "pending", f"after the race the director's approval answered {nxt}: the race skipped a step"
`,
    typescript: `const APPROVERS = ['u-mgr', 'u-dir', 'u-cfo'];
const KEY = 'approval:r-1:state';

async function chain(ctx) {
  const m = ctx.load('state');
  await m.startChain('r-1', APPROVERS);
  return m;
}

function refused(outcome, reason: string, why: string): void {
  assert.equal(outcome.advanced, false, \`\${why}: advance answered \${JSON.stringify(outcome)}, expected advanced false\`);
  assert.equal(outcome.reason, reason, \`\${why}: advance answered reason \${JSON.stringify(outcome.reason)}, expected \${JSON.stringify(reason)}\`);
}

export async function check_state_hash(ctx) {
  const m = await chain(ctx);
  const kind = ctx.redis.type(KEY);
  assert.equal(kind, 'hash', \`\${KEY} is a \${kind}: the state of a request is one hash (step_index, step_count, status, current_approver, approver:{i})\`);
  const expected = {step_index: '0', step_count: '3', status: 'pending', current_approver: 'u-mgr', 'approver:0': 'u-mgr', 'approver:1': 'u-dir', 'approver:2': 'u-cfo'};
  assert.deepEqual(ctx.redis.hgetall(KEY), expected, \`startChain wrote \${JSON.stringify(ctx.redis.hgetall(KEY))}\`);
  assert.equal(ctx.redis.ttl(KEY), -1, \`\${KEY} expires in \${ctx.redis.ttl(KEY)} s: a chain can wait weeks for its approvers\`);
  await m.advance('r-1', 0, 'u-mgr', 'approved');
  const f = ctx.redis.hgetall(KEY);
  assert(f.step_index === '1' && f.current_approver === 'u-dir' && f['decision:0'] === 'approved' && f['actor:0'] === 'u-mgr', \`after the manager's approval the state is \${JSON.stringify(f)}\`);
  assert.equal(ctx.redis.ttl(KEY), -1, \`after a decision \${KEY} expires in \${ctx.redis.ttl(KEY)} s\`);
}

export async function check_single_step(ctx) {
  const m = await chain(ctx);
  const first = await m.advance('r-1', 0, 'u-mgr', 'approved');
  assert.deepEqual(first, {advanced: true, step_index: 1, status: 'pending', reason: ''}, \`the manager's approval of step 0 answered \${JSON.stringify(first)}\`);
  const again = await m.advance('r-1', 0, 'u-mgr', 'approved');
  refused(again, 'stale step', 'a repeated approval of step 0 (a double click)');
  assert.equal(again.step_index, 1, \`a repeated approval moved the chain to step \${again.step_index}, expected it to stay on 1\`);
  refused(await m.advance('r-1', 2, 'u-dir', 'approved'), 'stale step', 'a decision on step 2 while the chain is on step 1');
  const second = await m.advance('r-1', 1, 'u-dir', 'approved');
  assert(second.advanced === true && second.status === 'pending' && second.step_index === 2, \`the director's approval of step 1 answered \${JSON.stringify(second)}: one signature is still missing\`);
  const last = await m.advance('r-1', 2, 'u-cfo', 'approved');
  assert(last.status === 'approved' && last.step_index === 3, \`the last approval answered \${JSON.stringify(last)}, expected status approved\`);
}

export async function check_current_approver(ctx) {
  const m = await chain(ctx);
  refused(await m.advance('r-1', 0, 'u-dir', 'approved'), 'not the current approver', "the director approving the manager's step 0");
  refused(await m.advance('r-1', 0, 'u-intruder', 'approved'), 'not the current approver', 'an actor who is on no step');
  const ok = await m.advance('r-1', 0, 'u-mgr', 'approved');
  assert(ok.advanced === true && ok.step_index === 1, \`the manager's approval of step 0 answered \${JSON.stringify(ok)}\`);
  refused(await m.advance('r-1', 1, 'u-cfo', 'approved'), 'not the current approver', "the CFO approving the director's step 1");
}

export async function check_rejection_ends(ctx) {
  const m = await chain(ctx);
  await m.advance('r-1', 0, 'u-mgr', 'approved');
  const rejected = await m.advance('r-1', 1, 'u-dir', 'rejected');
  assert.deepEqual(rejected, {advanced: true, step_index: 1, status: 'rejected', reason: ''}, \`the director's rejection answered \${JSON.stringify(rejected)}, expected the chain closed as rejected on step 1\`);
  refused(await m.advance('r-1', 1, 'u-dir', 'approved'), 'chain closed', 'an approval after the rejection');
  refused(await m.advance('r-1', 2, 'u-cfo', 'approved'), 'chain closed', 'the CFO deciding a rejected chain');
}

export async function check_atomic_decision(ctx) {
  const m = await chain(ctx);
  // Two app servers handle the same approval: the second lands right after the first touched the state.
  const rival = ctx.redisAfter(KEY, () => m.advance('r-1', 0, 'u-mgr', 'approved'));
  const mine = await m.advance('r-1', 0, 'u-mgr', 'approved');
  assert(rival.fired, 'advance never touched the state hash');
  if (rival.error !== undefined) throw rival.error;
  const both = [await rival.result, mine];
  assert.equal(both.filter(o => o.advanced).length, 1, \`two servers handling one approval answered \${JSON.stringify(both)}: exactly one may advance the chain\`);
  const next = await m.advance('r-1', 1, 'u-dir', 'approved');
  assert(next.advanced === true && next.step_index === 2 && next.status === 'pending', \`after the race the director's approval answered \${JSON.stringify(next)}: the race skipped a step\`);
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

var (
	stateBg        = context.Background()
	stateApprovers = []string{"u-mgr", "u-dir", "u-cfo"}
)

const stateHashKey = "approval:r-1:state"

func stateChain(ctx *harness.Ctx) {
	ctx.NoError(startChain(stateBg, "r-1", stateApprovers), "startChain(r-1)")
}

func stateDecide(ctx *harness.Ctx, step int, actor, decision string) Outcome {
	o, err := advance(stateBg, "r-1", step, actor, decision)
	ctx.NoError(err, "advance(r-1, %d, %s, %s)", step, actor, decision)
	return o
}

func stateRefused(ctx *harness.Ctx, o Outcome, reason, why string) {
	ctx.Assert(!o.Advanced, "%s: advance answered %+v, expected advanced false", why, o)
	ctx.Equal(o.Reason, reason, "%s: the reason", why)
}

func CheckStateHash(ctx *harness.Ctx) {
	stateChain(ctx)
	ctx.Equal(ctx.Redis.Type(stateHashKey), "hash", "the state of a request is one hash (step_index, step_count, status, current_approver, approver:{i}); the type of %s", stateHashKey)
	want := map[string]string{"step_index": "0", "step_count": "3", "status": "pending", "current_approver": "u-mgr", "approver:0": "u-mgr", "approver:1": "u-dir", "approver:2": "u-cfo"}
	ctx.Equal(ctx.Redis.HGetAll(stateHashKey), want, "the fields startChain wrote")
	ctx.Equal(ctx.Redis.TTL(stateHashKey), int64(-1), "a chain can wait weeks for its approvers; the TTL of %s", stateHashKey)
	stateDecide(ctx, 0, "u-mgr", "approved")
	f := ctx.Redis.HGetAll(stateHashKey)
	ctx.Assert(f["step_index"] == "1" && f["current_approver"] == "u-dir" && f["decision:0"] == "approved" && f["actor:0"] == "u-mgr", "after the manager's approval the state is %v", f)
	ctx.Equal(ctx.Redis.TTL(stateHashKey), int64(-1), "after a decision, the TTL of %s", stateHashKey)
}

func CheckSingleStep(ctx *harness.Ctx) {
	stateChain(ctx)
	ctx.Equal(stateDecide(ctx, 0, "u-mgr", "approved"), Outcome{Advanced: true, StepIndex: 1, Status: "pending"}, "the manager's approval of step 0")
	again := stateDecide(ctx, 0, "u-mgr", "approved")
	stateRefused(ctx, again, "stale step", "a repeated approval of step 0 (a double click)")
	ctx.Equal(again.StepIndex, 1, "a repeated approval must leave the chain on step 1; step_index")
	stateRefused(ctx, stateDecide(ctx, 2, "u-dir", "approved"), "stale step", "a decision on step 2 while the chain is on step 1")
	second := stateDecide(ctx, 1, "u-dir", "approved")
	ctx.Assert(second.Advanced && second.Status == "pending" && second.StepIndex == 2, "the director's approval of step 1 answered %+v: one signature is still missing", second)
	last := stateDecide(ctx, 2, "u-cfo", "approved")
	ctx.Assert(last.Status == "approved" && last.StepIndex == 3, "the last approval answered %+v, expected status approved", last)
}

func CheckCurrentApprover(ctx *harness.Ctx) {
	stateChain(ctx)
	stateRefused(ctx, stateDecide(ctx, 0, "u-dir", "approved"), "not the current approver", "the director approving the manager's step 0")
	stateRefused(ctx, stateDecide(ctx, 0, "u-intruder", "approved"), "not the current approver", "an actor who is on no step")
	ok := stateDecide(ctx, 0, "u-mgr", "approved")
	ctx.Assert(ok.Advanced && ok.StepIndex == 1, "the manager's approval of step 0 answered %+v", ok)
	stateRefused(ctx, stateDecide(ctx, 1, "u-cfo", "approved"), "not the current approver", "the CFO approving the director's step 1")
}

func CheckRejectionEnds(ctx *harness.Ctx) {
	stateChain(ctx)
	stateDecide(ctx, 0, "u-mgr", "approved")
	ctx.Equal(stateDecide(ctx, 1, "u-dir", "rejected"), Outcome{Advanced: true, StepIndex: 1, Status: "rejected"}, "the director's rejection must close the chain as rejected on step 1")
	stateRefused(ctx, stateDecide(ctx, 1, "u-dir", "approved"), "chain closed", "an approval after the rejection")
	stateRefused(ctx, stateDecide(ctx, 2, "u-cfo", "approved"), "chain closed", "the CFO deciding a rejected chain")
}

func CheckAtomicDecision(ctx *harness.Ctx) {
	stateChain(ctx)
	// Two app servers handle the same approval: the second lands right after the first touched the state.
	rival := ctx.Redis.After(stateHashKey, func() any {
		o, err := advance(stateBg, "r-1", 0, "u-mgr", "approved")
		ctx.NoError(err, "the rival advance failed")
		return o
	})
	mine := stateDecide(ctx, 0, "u-mgr", "approved")
	ctx.Assert(rival.Fired, "advance never touched the state hash")
	theirs, _ := rival.Result.(Outcome)
	ctx.Assert(theirs.Advanced != mine.Advanced, "two servers handling one approval answered %+v and %+v: exactly one may advance the chain", theirs, mine)
	next := stateDecide(ctx, 1, "u-dir", "approved")
	ctx.Assert(next.Advanced && next.StepIndex == 2 && next.Status == "pending", "after the race the director's approval answered %+v: the race skipped a step", next)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>

namespace {

const std::string kStateKey = "approval:r-1:state";

void stateRefused(harness::Ctx& ctx, const Outcome& o, const std::string& reason, const std::string& why) {
  ctx.Assert(!o.advanced, "%s: advance answered advanced %t step_index %d status %q, expected advanced false", why, o.advanced, o.step_index, o.status);
  ctx.Equal(o.reason, reason, "%s: the reason", why);
}

std::string show(const Outcome& o) {
  return "{advanced " + std::string(o.advanced ? "true" : "false") + ", step_index " + std::to_string(o.step_index) + ", status " + o.status + ", reason \\"" + o.reason + "\\"}";
}

}  // namespace

void CheckStateHash(harness::Ctx& ctx) {
  startChain("r-1", {"u-mgr", "u-dir", "u-cfo"});
  ctx.Equal(ctx.Redis.Type(kStateKey), "hash", "the state of a request is one hash (step_index, step_count, status, current_approver, approver:{i}); the type of %s", kStateKey);
  const std::map<std::string, std::string> want = {{"step_index", "0"}, {"step_count", "3"}, {"status", "pending"}, {"current_approver", "u-mgr"},
                                                   {"approver:0", "u-mgr"}, {"approver:1", "u-dir"}, {"approver:2", "u-cfo"}};
  ctx.Equal(ctx.Redis.HGetAll(kStateKey), want, "the fields startChain wrote");
  ctx.Equal(ctx.Redis.TTL(kStateKey), -1, "a chain can wait weeks for its approvers; the TTL of %s", kStateKey);
  advance("r-1", 0, "u-mgr", "approved");
  auto f = ctx.Redis.HGetAll(kStateKey);
  ctx.Assert(f["step_index"] == "1" && f["current_approver"] == "u-dir" && f["decision:0"] == "approved" && f["actor:0"] == "u-mgr", "after the manager's approval the state is %v", f);
  ctx.Equal(ctx.Redis.TTL(kStateKey), -1, "after a decision, the TTL of %s", kStateKey);
}

void CheckSingleStep(harness::Ctx& ctx) {
  startChain("r-1", {"u-mgr", "u-dir", "u-cfo"});
  const Outcome first = advance("r-1", 0, "u-mgr", "approved");
  ctx.Assert(first.advanced && first.step_index == 1 && first.status == "pending", "the manager's approval of step 0 answered %s", show(first));
  const Outcome again = advance("r-1", 0, "u-mgr", "approved");
  stateRefused(ctx, again, "stale step", "a repeated approval of step 0 (a double click)");
  ctx.Equal(again.step_index, 1, "a repeated approval must leave the chain on step 1; step_index");
  stateRefused(ctx, advance("r-1", 2, "u-dir", "approved"), "stale step", "a decision on step 2 while the chain is on step 1");
  const Outcome second = advance("r-1", 1, "u-dir", "approved");
  ctx.Assert(second.advanced && second.status == "pending" && second.step_index == 2, "the director's approval of step 1 answered %s: one signature is still missing", show(second));
  const Outcome last = advance("r-1", 2, "u-cfo", "approved");
  ctx.Assert(last.status == "approved" && last.step_index == 3, "the last approval answered %s, expected status approved", show(last));
}

void CheckCurrentApprover(harness::Ctx& ctx) {
  startChain("r-1", {"u-mgr", "u-dir", "u-cfo"});
  stateRefused(ctx, advance("r-1", 0, "u-dir", "approved"), "not the current approver", "the director approving the manager's step 0");
  stateRefused(ctx, advance("r-1", 0, "u-intruder", "approved"), "not the current approver", "an actor who is on no step");
  const Outcome ok = advance("r-1", 0, "u-mgr", "approved");
  ctx.Assert(ok.advanced && ok.step_index == 1, "the manager's approval of step 0 answered %s", show(ok));
  stateRefused(ctx, advance("r-1", 1, "u-cfo", "approved"), "not the current approver", "the CFO approving the director's step 1");
}

void CheckRejectionEnds(harness::Ctx& ctx) {
  startChain("r-1", {"u-mgr", "u-dir", "u-cfo"});
  advance("r-1", 0, "u-mgr", "approved");
  const Outcome rejected = advance("r-1", 1, "u-dir", "rejected");
  ctx.Assert(rejected.advanced && rejected.step_index == 1 && rejected.status == "rejected", "the director's rejection answered %s, expected the chain closed as rejected on step 1", show(rejected));
  stateRefused(ctx, advance("r-1", 1, "u-dir", "approved"), "chain closed", "an approval after the rejection");
  stateRefused(ctx, advance("r-1", 2, "u-cfo", "approved"), "chain closed", "the CFO deciding a rejected chain");
}

void CheckAtomicDecision(harness::Ctx& ctx) {
  startChain("r-1", {"u-mgr", "u-dir", "u-cfo"});
  // Two app servers handle the same approval: the second lands right after the first touched the state.
  auto theirs = std::make_shared<std::optional<Outcome>>();
  ctx.Redis.After(kStateKey, [theirs] { *theirs = advance("r-1", 0, "u-mgr", "approved"); });
  const Outcome mine = advance("r-1", 0, "u-mgr", "approved");
  ctx.Assert(theirs->has_value(), "advance never touched the state hash");
  ctx.Assert((*theirs)->advanced != mine.advanced, "two servers handling one approval answered %s and %s: exactly one may advance the chain", show(**theirs), show(mine));
  const Outcome next = advance("r-1", 1, "u-dir", "approved");
  ctx.Assert(next.advanced && next.step_index == 2 && next.status == "pending", "after the race the director's approval answered %s: the race skipped a step", show(next));
}
`,
  },
  debrief: `The hash and the script are one design: once every fact a decision depends on (the step, the approver, the status) is a field, one Lua script can read and write all of them with nothing landing in between, which is what makes a double click, a retry and a second server the same harmless call. Comparing the caller's step index is the part that turns a retry into a no-op instead of a second signature. The missing TTL is deliberate: an approval's lifetime is set by people, so closed chains are removed by a sweeper that checks the status. Production workflow engines also record every refused decision for the audit trail, and support reassignment, which rewrites \`current_approver\` through the same script.`,
};
