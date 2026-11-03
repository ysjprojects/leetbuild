import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'System-under-test calls with isolation and kill switches',
  concept: 'grpc',
  file: 'client',
  focus: ['runner', 'sandbox', 'sut'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/redteam/execute\`: \`run_probes\` walks the probe
list, breaks when a process-local \`KILL_SWITCH\` is true, calls \`execute\` with no deadline inside
a \`while True\` that retries on any \`RpcError\`, and returns \`status: "complete"\` with the probes
it sent. In a demo it looks careful. It hides five flaws.

**Failure mode the checks target.** A dead target receives the probe set multiplied by an unknown
factor, and the run never terminates. One runner that sees unintended damage stops alone while its
replicas keep probing, because the flag it flipped lives in its own process and is read nowhere
else before the next payload leaves. A stalled probe holds the runner. A run that was cut short
reports complete, so the coverage gap is invisible and the next run repeats probes that succeeded.

- Every probe call carries a **5-second deadline** (\`PROBE_DEADLINE_S = 5\` /
  \`PROBE_DEADLINE_MS = 5000\`).
- The kill switch is shared: it is read from Redis under \`redteam:kill:{target}\`
  (\`kill_switch_key\`, \`kill_active\`) before every probe, inside the loop.
- A probe that times out is retried at most once (\`MAX_ATTEMPTS = 2\`) and only on
  \`DEADLINE_EXCEEDED\`; every other status is surfaced immediately.
- When the kill switch fires, the run ends with \`status: "aborted"\` and records where it stopped
  (\`resume_at\` = the probe that was not sent).`,
  sequence: {
    participants: ['Probe runner', 'Kill switch (Redis)', 'System under test'],
    messages: [
      {from: 'Probe runner', to: 'Kill switch (Redis)', label: 'GET redteam:kill:{target}', kind: 'sync'},
      {from: 'Kill switch (Redis)', to: 'Probe runner', label: '0 — clear to probe', kind: 'reply'},
      {from: 'Probe runner', to: 'System under test', label: 'Probe(probe_id) · deadline 5s', kind: 'sync'},
      {from: 'System under test', to: 'Probe runner', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Probe runner', to: 'System under test', label: 'Probe(probe_id) · one retry only', kind: 'sync'},
      {
        from: 'Probe runner',
        to: 'Kill switch (Redis)',
        label: 'GET again → 1 · aborted · resume_at = probe-18',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every probe with a 5-second deadline',
      detail:
        'The gRPC call carries a 5-second deadline, so a stalled target cannot hold a runner. The starter calls without any deadline at all.',
      match: {
        python: {all: [/PROBE_DEADLINE_S\s*=\s*5/, /timeout=PROBE_DEADLINE_S/]},
        typescript: {all: [/PROBE_DEADLINE_MS\s*=\s*5_000/, /deadline:\s*Date\.now\(\)\s*\+\s*PROBE_DEADLINE_MS/]},
        go: {
          all: [/probeDeadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\(\s*\w+\s*,\s*probeDeadline\s*\)/],
        },
        scala: {all: [/ProbeDeadlineMs\s*=\s*5000/, /withDeadlineAfter\(\s*ProbeDeadlineMs/]},
        cpp: {all: [/kProbeDeadlineMs\s*=\s*5000/, /set_deadline\(/]},
      },
    },
    {
      id: 'kill-switch-shared',
      title: 'Reads the kill switch from shared state',
      detail:
        'The switch is a Redis key every runner reads before it probes. The starter keeps a process-local boolean, so a runner that hits damage stops alone while its replicas keep probing.',
      match: {
        python: {all: [/kill_switch_key\(/, /r\.get\(/, /KILL_SWITCH/], none: [/KILL_SWITCH\s*=\s*False/]},
        typescript: {all: [/killSwitchKey\(/, /\.get\(/, /KILL_SWITCH/], none: [/let\s+killSwitch\s*=\s*false/]},
        go: {all: [/killSwitchKey\(/, /rdb\.Get\(/, /killSwitch/], none: [/var\s+killSwitch\s*=\s*false/]},
        scala: {all: [/killSwitchKey\(/, /jedis\.get\(/, /KillSwitch/], none: [/var\s+killSwitch\s*=\s*false/]},
        cpp: {all: [/kKillSwitchPrefix/, /killSwitchKey\(/, /redis\.get\(/], none: [/bool\s+kill_switch\s*=\s*false/]},
      },
    },
    {
      id: 'kill-before-probe',
      title: 'Evaluates the kill switch before each probe',
      detail:
        'The switch is read before the probe is executed, inside the probe loop, so an abort lands before the next payload leaves. A switch checked once at startup cannot stop a run that is already going.',
      match: {
        python: {order: [/kill_active\(/, /execute\(/]},
        typescript: {order: [/killActive\(/, /execute\(/]},
        go: {order: [/killActive\(/, /execute\(/]},
        scala: {order: [/killActive\(/, /execute\(/]},
        cpp: {order: [/killActive\(/, /execute\(/]},
      },
    },
    {
      id: 'single-retry',
      title: 'Retries a timed-out probe at most once',
      detail:
        'Attempts are capped at 2 and only `DEADLINE_EXCEEDED` is retryable. The starter loops forever on every failure, which multiplies the probe set against a target that is already failing.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2/, /DEADLINE_EXCEEDED/]},
        go: {all: [/maxAttempts\s*=\s*2/, /DeadlineExceeded/]},
        scala: {all: [/MaxAttempts\s*=\s*2/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'abort-cursor',
      title: 'Records where an aborted run stopped',
      detail:
        'An aborted run returns `status: "aborted"` with `resume_at` set to the probe that was not sent. The starter reports `complete`, so the coverage gap is invisible and the next run repeats work.',
      match: {
        python: {all: [/resume_at/, /"aborted"/]},
        typescript: {all: [/resumeAt/, /'aborted'/]},
        go: {all: [/ResumeAt/, /"aborted"/]},
        scala: {all: [/resumeAt/, /"aborted"/]},
        cpp: {all: [/resume_at/, /"aborted"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import redis

import sut_pb2
import sut_pb2_grpc
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

KILL_SWITCH = False

channel = grpc.insecure_channel("sut-shadow.sandbox:9000")
sut = sut_pb2_grpc.SutStub(channel)


class RunRequest(BaseModel):
    run_id: str
    target: str
    endpoint: str
    probes: list[str]


def execute(endpoint: str, probe_id: str) -> str:
    request = sut_pb2.ProbeRequest(probe_id=probe_id, endpoint=endpoint)
    return sut.Probe(request).content


@app.post("/v1/redteam/execute")
def run_probes(body: RunRequest) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    sent = []
    for probe_id in body.probes:
        if KILL_SWITCH:
            break
        while True:
            try:
                execute(body.endpoint, probe_id)
                sent.append(probe_id)
                break
            except grpc.RpcError:
                continue
    return {"status": "complete", "sent": sent}
`,
      solution: `import grpc
import redis

import sut_pb2
import sut_pb2_grpc
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

KILL_SWITCH_PREFIX = "redteam:kill:"
PROBE_DEADLINE_S = 5
MAX_ATTEMPTS = 2
RETRYABLE = {grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("sut-shadow.sandbox:9000")
sut = sut_pb2_grpc.SutStub(channel)


class RunRequest(BaseModel):
    run_id: str
    target: str
    endpoint: str
    probes: list[str]


def kill_switch_key(target: str) -> str:
    return f"{KILL_SWITCH_PREFIX}{target}"


def kill_active(target: str) -> bool:
    """The switch is shared state: every runner replica reads the same key."""
    return r.get(kill_switch_key(target)) == "1"


def execute(endpoint: str, probe_id: str) -> str:
    request = sut_pb2.ProbeRequest(probe_id=probe_id, endpoint=endpoint)
    return sut.Probe(request, timeout=PROBE_DEADLINE_S).content


@app.post("/v1/redteam/execute")
def run_probes(body: RunRequest) -> dict:
    sent: list[str] = []
    for probe_id in body.probes:
        if kill_active(body.target):
            return {"status": "aborted", "resume_at": probe_id, "sent": sent}
        for attempt in range(MAX_ATTEMPTS):
            try:
                execute(body.endpoint, probe_id)
                sent.append(probe_id)
                break
            except grpc.RpcError as error:
                if error.code() not in RETRYABLE or attempt == MAX_ATTEMPTS - 1:
                    raise
    return {"status": "complete", "resume_at": None, "sent": sent}
`,
    },
    typescript: {
      starter: `/** Probe execution: flawed code that retries forever behind a local flag. */
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';

export const app = Fastify();

let killSwitch = false;

interface RunBody {
  run_id: string;
  target: string;
  endpoint: string;
  probes: string[];
}

function execute(stub: grpc.Client, probeId: string, endpoint: string): Promise<string> {
  const {promise, resolve, reject} = Promise.withResolvers<string>();
  stub.makeUnaryRequest(
    '/sut.Sut/Probe',
    (value: unknown) => Buffer.from(JSON.stringify(value)),
    (bytes: Buffer) => JSON.parse(bytes.toString()),
    {probe_id: probeId, endpoint},
    (error, reply) => (error ? reject(error) : resolve(String(reply))),
  );
  return promise;
}

app.post('/v1/redteam/execute', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const body = request.body as RunBody;
  const sent: string[] = [];
  for (const probeId of body.probes) {
    if (killSwitch) break;
    for (;;) {
      try {
        await execute(stub, probeId, body.endpoint);
        sent.push(probeId);
        break;
      } catch {
        continue;
      }
    }
  }
  return reply.code(200).send({status: 'complete', sent});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Probe execution: one deadline, one retry, one shared kill switch, one cursor. */
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const KILL_SWITCH_PREFIX = 'redteam:kill:';
const PROBE_DEADLINE_MS = 5_000;
const MAX_ATTEMPTS = 2;
const RETRYABLE: Record<number, true> = {[grpc.status.DEADLINE_EXCEEDED]: true};

interface RunBody {
  run_id: string;
  target: string;
  endpoint: string;
  probes: string[];
}

interface RunOutcome {
  status: 'complete' | 'aborted';
  resumeAt: string | null;
  sent: string[];
}

function killSwitchKey(target: string): string {
  return \`\${KILL_SWITCH_PREFIX}\${target}\`;
}

async function killActive(target: string): Promise<boolean> {
  return (await r.get(killSwitchKey(target))) === '1';
}

function execute(stub: grpc.Client, probeId: string, endpoint: string): Promise<string> {
  const {promise, resolve, reject} = Promise.withResolvers<string>();
  stub.makeUnaryRequest(
    '/sut.Sut/Probe',
    (value: unknown) => Buffer.from(JSON.stringify(value)),
    (bytes: Buffer) => JSON.parse(bytes.toString()),
    {probe_id: probeId, endpoint},
    new grpc.Metadata(),
    {deadline: Date.now() + PROBE_DEADLINE_MS},
    (error, reply) => (error ? reject(error) : resolve(String(reply))),
  );
  return promise;
}

app.post('/v1/redteam/execute', async (request, reply) => {
  const body = request.body as RunBody;
  const sent: string[] = [];
  for (const probeId of body.probes) {
    if (await killActive(body.target)) {
      return reply.code(200).send({status: 'aborted', resumeAt: probeId, sent} satisfies RunOutcome);
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await execute(stub, probeId, body.endpoint);
        sent.push(probeId);
        break;
      } catch (error) {
        const code = (error as grpc.ServiceError).code;
        if (RETRYABLE[code] !== true || attempt === MAX_ATTEMPTS - 1) throw error;
      }
    }
  }
  return reply.code(200).send({status: 'complete', resumeAt: null, sent} satisfies RunOutcome);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "runner/sutpb"
)

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
var killSwitch = false

func execute(ctx context.Context, client pb.SutClient, endpoint, probeID string) (string, error) {
	reply, err := client.Probe(ctx, &pb.ProbeRequest{ProbeId: probeID, Endpoint: endpoint})
	if err != nil {
		return "", err
	}
	return reply.Content, nil
}

func runProbes(ctx context.Context, client pb.SutClient, run Run) map[string]any {
	sent := []string{}
	for _, probeID := range run.Probes {
		if killSwitch {
			break
		}
		for {
			if _, err := execute(ctx, client, run.Endpoint, probeID); err != nil {
				continue
			}
			sent = append(sent, probeID)
			break
		}
	}
	return map[string]any{"status": "complete", "sent": sent}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/redis/go-redis/v9"
	pb "runner/sutpb"
)

const (
	killSwitchPrefix = "redteam:kill:"
	probeDeadline    = 5 * time.Second
	maxAttempts      = 2
)

var retryable = map[codes.Code]bool{codes.DeadlineExceeded: true}

var rdb *redis.Client

type Run struct {
	RunID    string   \`json:"run_id"\`
	Target   string   \`json:"target"\`
	Endpoint string   \`json:"endpoint"\`
	Probes   []string \`json:"probes"\`
}

type RunOutcome struct {
	Status   string   \`json:"status"\`
	ResumeAt string   \`json:"resume_at"\`
	Sent     []string \`json:"sent"\`
}

func killSwitchKey(target string) string {
	return killSwitchPrefix + target
}

// killActive reads the shared switch so an abort on one runner stops every runner's next probe.
func killActive(ctx context.Context, target string) bool {
	value, err := rdb.Get(ctx, killSwitchKey(target)).Result()
	return err == nil && value == "1"
}

func execute(ctx context.Context, client pb.SutClient, endpoint, probeID string) error {
	callCtx, cancel := context.WithTimeout(ctx, probeDeadline)
	defer cancel()
	_, err := client.Probe(callCtx, &pb.ProbeRequest{ProbeId: probeID, Endpoint: endpoint})
	return err
}

func runProbes(ctx context.Context, client pb.SutClient, run Run) (RunOutcome, error) {
	sent := []string{}
	for _, probeID := range run.Probes {
		if killActive(ctx, run.Target) {
			return RunOutcome{Status: "aborted", ResumeAt: probeID, Sent: sent}, nil
		}
		for attempt := 0; attempt < maxAttempts; attempt++ {
			err := execute(ctx, client, run.Endpoint, probeID)
			if err == nil {
				sent = append(sent, probeID)
				break
			}
			if !retryable[status.Code(err)] || attempt == maxAttempts-1 {
				return RunOutcome{}, err
			}
		}
	}
	return RunOutcome{Status: "complete", Sent: sent}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.Jedis

object Client {
  val stub = SutGrpc.blockingStub(ManagedChannelBuilder.forAddress("sut-shadow.sandbox", 9000).usePlaintext().build())
  val jedis = new Jedis("redis", 6379)

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  var killSwitch = false

  final case class Run(run_id: String, target: String, endpoint: String, probes: List[String])

  def execute(probeId: String, endpoint: String): String =
    stub.probe(ProbeRequest(probeId, endpoint)).content

  def runProbes(run: Run): String = {
    var sent = List.empty[String]
    for (probeId <- run.probes) {
      if (!killSwitch) {
        var done = false
        while (!done) {
          try {
            execute(probeId, run.endpoint)
            sent = sent :+ probeId
            done = true
          } catch {
            case _: Throwable => ()
          }
        }
      }
    }
    s"""{"status":"complete","sent":\${sent.size}}"""
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.Jedis

object Client {
  val KillSwitchPrefix = "redteam:kill:"
  val ProbeDeadlineMs = 5000
  val MaxAttempts = 2
  val Retryable = Set(Status.Code.DEADLINE_EXCEEDED)

  val stub = SutGrpc.blockingStub(ManagedChannelBuilder.forAddress("sut-shadow.sandbox", 9000).usePlaintext().build())
  val jedis = new Jedis("redis", 6379)

  final case class Run(run_id: String, target: String, endpoint: String, probes: List[String])
  final case class RunOutcome(status: String, resumeAt: String, sent: List[String])

  def killSwitchKey(target: String): String = KillSwitchPrefix + target

  /** The switch is shared state: every runner replica reads the same key. */
  def killActive(target: String): Boolean = jedis.get(killSwitchKey(target)) == "1"

  def execute(probeId: String, endpoint: String): String =
    stub.withDeadlineAfter(ProbeDeadlineMs, TimeUnit.MILLISECONDS).probe(ProbeRequest(probeId, endpoint)).content

  def runProbes(run: Run): RunOutcome = {
    var sent = List.empty[String]
    for (probeId <- run.probes) {
      if (killActive(run.target)) {
        return RunOutcome("aborted", probeId, sent)
      }
      var attempt = 0
      var done = false
      while (attempt < MaxAttempts && !done) {
        try {
          execute(probeId, run.endpoint)
          sent = sent :+ probeId
          done = true
        } catch {
          case exc: StatusRuntimeException =>
            if (!Retryable.contains(exc.getStatus.getCode) || attempt == MaxAttempts - 1) throw exc
        }
        attempt += 1
      }
    }
    RunOutcome("complete", "", sent)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "sut.grpc.pb.h"

#include <string>
#include <vector>

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
bool kill_switch = false;

struct RunOutcome {
  std::string status;
  std::string resume_at;
  std::vector<std::string> sent;
};

grpc::Status execute(
    Sut::Stub* stub,
    const std::string& probeId,
    const std::string& endpoint,
    std::string* content) {
  grpc::ClientContext ctx;
  ProbeRequest request;
  request.set_probe_id(probeId);
  request.set_endpoint(endpoint);
  ProbeReply reply;
  const grpc::Status status = stub->Probe(&ctx, request, &reply);
  if (status.ok()) *content = reply.content();
  return status;
}

RunOutcome runProbes(Sut::Stub* stub, const std::string& target, const std::string& endpoint,
                     const std::vector<std::string>& probes) {
  RunOutcome outcome{"complete", "", {}};
  for (const auto& probeId : probes) {
    if (kill_switch) break;
    std::string content;
    while (true) {
      if (execute(stub, probeId, endpoint, &content).ok()) {
        outcome.sent.push_back(probeId);
        break;
      }
    }
  }
  return outcome;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include "sut.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

const std::string kKillSwitchPrefix = "redteam:kill:";
constexpr int kProbeDeadlineMs = 5000;
constexpr int kMaxAttempts = 2;

struct RunOutcome {
  std::string status;
  std::string resume_at;
  std::vector<std::string> sent;
};

std::string killSwitchKey(const std::string& target) {
  return kKillSwitchPrefix + target;
}

/** The switch is shared state: every runner replica reads the same key. */
bool killActive(sw::redis::Redis& redis, const std::string& target) {
  const auto value = redis.get(killSwitchKey(target));
  return value && *value == "1";
}

grpc::Status execute(
    Sut::Stub* stub,
    const std::string& probeId,
    const std::string& endpoint,
    std::string* content) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kProbeDeadlineMs));
  ProbeRequest request;
  request.set_probe_id(probeId);
  request.set_endpoint(endpoint);
  ProbeReply reply;
  const grpc::Status status = stub->Probe(&ctx, request, &reply);
  if (status.ok()) *content = reply.content();
  return status;
}

RunOutcome runProbes(
    Sut::Stub* stub,
    sw::redis::Redis& redis,
    const std::string& target,
    const std::string& endpoint,
    const std::vector<std::string>& probes) {
  RunOutcome outcome{"complete", "", {}};
  for (const auto& probeId : probes) {
    if (killActive(redis, target)) {
      outcome.status = "aborted";
      outcome.resume_at = probeId;
      return outcome;
    }
    for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
      std::string content;
      const grpc::Status status = execute(stub, probeId, endpoint, &content);
      if (status.ok()) {
        outcome.sent.push_back(probeId);
        break;
      }
      if (status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED || attempt == kMaxAttempts - 1) {
        throw std::runtime_error("probe failed: " + status.error_message());
      }
    }
  }
  return outcome;
}
`,
    },
  },
  hints: [
    'An operator hits the kill switch after a probe corrupts a shadow database, and two other runners keep sending the rest of the set for another twenty minutes.',
    '`KILL_SWITCH` is a module-level boolean, so only the process that set it stops; `sut.Probe` has no timeout and `while True: … except RpcError: continue` retries every failure forever.',
    'Call `sut.Probe(request, timeout=PROBE_DEADLINE_S)`, retry once on `DEADLINE_EXCEEDED` (`MAX_ATTEMPTS = 2`), read `kill_active(target)` from `redteam:kill:{target}` before each `execute`, and return `aborted` with `resume_at`.',
  ],
  debrief: `A probe set is a workload pointed at someone else's system, so the fix gives it three properties. It is bounded: a deadline per attempt and a retry cap mean a target that stops answering cannot absorb the run's whole time budget. It is interruptible from outside the process that noticed the damage: the kill switch is shared state read before every probe, which is the only version of the control that works on a fleet. And it leaves a truthful record: an aborted run reports where it stopped, so the coverage gap is a first-class fact instead of a silent success. Production platforms add a per-target concurrency limit so a probe set cannot overload its own target, and require a second person to reset the switch once it has fired.`,
};
