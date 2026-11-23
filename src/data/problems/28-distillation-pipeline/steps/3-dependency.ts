import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Teacher generation: a deadline, bounded retries, one outcome',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'teacher', 'redis'],
  task: `## Task

**Starting point.** The starter's \`generate(state, job_id, prompt_id, prompt)\` calls \`Teacher.Generate\`
(\`teacher.proto\`, served as a stand-in at \`distill/config\`'s \`TEACHER\`) and keeps calling, with a
short sleep between tries, until a non-empty, non-refused completion comes back or the shard's 30-second
wall clock runs out; then it records the outcome through the step-2 state. Against a healthy teacher it
answers in one call. It hides five flaws.

**Failure mode the checks target.** A retry loop with no deadline is the one that takes the shard down:
one hung stream holds a worker for the whole wall clock and every sample behind it waits. The refusal
case costs money: a teacher that safely refuses 30 percent of a dataset becomes a retry storm,
so a refusal has to be recorded, not retried. And a worker that calls before it reserves spends budget
the job no longer has.

\`\`\`proto
service Teacher { rpc Generate(GenerateRequest) returns (GenerateReply); }
message GenerateRequest { string job_id = 1; string prompt_id = 2; string prompt = 3; }
message GenerateReply   { string text = 1; bool refused = 2; string teacher_version = 3; }
\`\`\`

Requirements:

- \`state.reserve(job_id, prompt)\` **before** the first call: \`duplicate\` returns status \`duplicate\`
  with no call; \`budget\` returns \`rejected\` with reason \`budget\` and no call.
- Every attempt carries a **four-second deadline** (\`DEADLINE_S\`). \`DEADLINE_EXCEEDED\` is recorded as
  \`rejected\` with reason \`deadline\`, not retried.
- Only \`UNAVAILABLE\` is retried, at most **twice** (\`MAX_ATTEMPTS\` = 3) with a backoff; a third
  failure is \`rejected\` with reason \`unavailable\`.
- A refusal or an empty completion is \`rejected\` with reason \`refusal\` or \`empty\`, after one call.
- Exactly **one** \`state.record\` per sample; the result carries \`status\`, \`reason\`, \`attempts\`, and
  for an accepted sample \`text\`, \`teacher_version\` and \`dedupe_hash\`.`,
  sequence: {
    participants: ['Worker', 'Job state', 'Teacher'],
    messages: [
      {from: 'Worker', to: 'Job state', label: 'reserve(job, prompt)', kind: 'sync'},
      {from: 'Job state', to: 'Worker', label: '{ok, remaining, dedupe_hash}', kind: 'reply'},
      {from: 'Worker', to: 'Teacher', label: 'Generate · deadline 4 s', kind: 'sync'},
      {from: 'Teacher', to: 'Worker', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Worker', to: 'Teacher', label: 'Generate · attempt 2 after backoff', kind: 'sync'},
      {from: 'Teacher', to: 'Worker', label: '{text, refused: false, teacher_version}', kind: 'reply'},
      {from: 'Worker', to: 'Job state', label: 'record(job, accepted)', kind: 'sync'},
    ],
  },
  hints: [
    'Symptom: one hung teacher call parks a worker for half a minute, a prompt the teacher refuses is asked 120 times, and a job keeps calling the teacher after its budget is gone.',
    'Mechanism: the loop has no per-call deadline, so a hang runs to the wall clock; it treats a refusal and an empty completion as "try again"; and it calls Generate without ever asking the state for budget.',
    'Change: `state.reserve` first and return on duplicate/budget; `timeout=DEADLINE_S` on each call; retry only UNAVAILABLE while `attempt < MAX_ATTEMPTS` with `time.sleep(BACKOFF_S)`; everything else records once and returns.',
  ],
  checks: [
    {
      id: 'attempt-deadline',
      title: 'Four-second deadline on every attempt',
      detail:
        'Each Generate call carries a deadline of about 4 s (DEADLINE_S as timeout=, a deadline: Date.now() + DEADLINE_MS, context.WithTimeout, set_deadline); a teacher that answers in 3 s is accepted. The starter sends no deadline.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\b/, /context\.WithTimeout\(/]},
        cpp: {all: [/kDeadline/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries only UNAVAILABLE, at most twice',
      detail:
        'One UNAVAILABLE earns a retry after a backoff and the sample is accepted on the second call; three in a row end as rejected with reason unavailable after exactly three calls, each carrying its own full four-second deadline. Any other status (INTERNAL, RESOURCE_EXHAUSTED) is rejected after one call and recorded once. The starter retries anything until its wall clock runs out.',
      match: {
        python: {all: [/grpc\.StatusCode\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/MAX_SHARD_SECONDS/]},
        typescript: {all: [/status\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/MAX_SHARD_SECONDS/]},
        go: {all: [/codes\.Unavailable/, /maxAttempts/], none: [/maxShardSeconds/]},
        cpp: {all: [/grpc::StatusCode::UNAVAILABLE/, /kMaxAttempts/], none: [/kMaxShardSeconds/]},
      },
    },
    {
      id: 'refusal-recorded',
      title: 'Records a refusal or an empty output instead of retrying it',
      detail:
        'A refused or empty completion ends the sample after one call as rejected with reason refusal or empty, recorded once in the job state. The starter asks again until the wall clock expires.',
      match: {
        python: {all: [/["']refusal["']/, /["']empty["']/, /state\.record\(/]},
        typescript: {all: [/['"]refusal['"]/, /['"]empty['"]/, /state\.record\(/]},
        go: {all: [/"refusal"/, /"empty"/, /state\.Record\(/]},
        cpp: {all: [/"refusal"/, /"empty"/, /state\.record\(/]},
      },
    },
    {
      id: 'hung-call-cut',
      title: 'Cuts a hung call at the deadline and records it',
      detail:
        'A teacher that hangs past 4 s comes back DEADLINE_EXCEEDED: the sample is rejected with reason deadline after one call, about 4 s of waiting, and no retry. The starter waits the whole hang out and then calls again.',
      match: {
        python: {all: [/grpc\.StatusCode\.DEADLINE_EXCEEDED/, /["']deadline["']/]},
        typescript: {all: [/status\.DEADLINE_EXCEEDED/, /['"]deadline['"]/]},
        go: {all: [/codes\.DeadlineExceeded/, /"deadline"/]},
        cpp: {all: [/grpc::StatusCode::DEADLINE_EXCEEDED/, /"deadline"/]},
      },
    },
    {
      id: 'budget-before-call',
      title: 'Reserves budget before the call',
      detail:
        "state.reserve runs before the first Generate: a duplicate prompt and a job out of budget make no call, an accepted sample carries the reservation's dedupe_hash, and after a run sampled equals accepted plus rejected. The starter calls first and records without reserving.",
      match: {
        python: {order: [/state\.reserve\(/, /stub\.Generate\(/]},
        typescript: {order: [/state\.reserve\(/, /stub\.Generate\(/]},
        go: {order: [/state\.Reserve\(/, /stub\.Generate\(/]},
        cpp: {order: [/state\.reserve\(/, /->Generate\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import teacher_pb2
import teacher_pb2_grpc
from distill.config import TEACHER

logger = logging.getLogger("distill.teacher")

MAX_SHARD_SECONDS = 30
BACKOFF_S = 0.25

channel = grpc.insecure_channel(TEACHER)
stub = teacher_pb2_grpc.TeacherStub(channel)


def generate(state, job_id: str, prompt_id: str, prompt: str) -> dict:
    """One teacher sample: call until a usable completion comes back, then record the outcome."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    until = time.monotonic() + MAX_SHARD_SECONDS
    attempts = 0
    while time.monotonic() < until:
        attempts += 1
        try:
            reply = stub.Generate(teacher_pb2.GenerateRequest(job_id=job_id, prompt_id=prompt_id, prompt=prompt))
        except grpc.RpcError as err:
            logger.warning("teacher call failed job=%s prompt=%s code=%s", job_id, prompt_id, err.code())
            time.sleep(BACKOFF_S)
            continue
        if reply.refused or reply.text == "":
            time.sleep(BACKOFF_S)
            continue
        state.record(job_id, "accepted")
        return {"status": "accepted", "text": reply.text, "teacher_version": reply.teacher_version, "attempts": attempts}
    state.record(job_id, "rejected", "unavailable")
    return {"status": "rejected", "reason": "unavailable", "attempts": attempts}
`,
      solution: `import logging
import time

import grpc

import teacher_pb2
import teacher_pb2_grpc
from distill.config import TEACHER

logger = logging.getLogger("distill.teacher")

DEADLINE_S = 4.0
MAX_ATTEMPTS = 3
BACKOFF_S = 0.25

channel = grpc.insecure_channel(TEACHER)
stub = teacher_pb2_grpc.TeacherStub(channel)


def generate(state, job_id: str, prompt_id: str, prompt: str) -> dict:
    """One teacher sample: reserve budget, call with a deadline and bounded retries, record one outcome."""
    reservation = state.reserve(job_id, prompt)
    if reservation["verdict"] == "duplicate":
        return {"status": "duplicate", "attempts": 0, "dedupe_hash": reservation["dedupe_hash"]}
    if reservation["verdict"] == "budget":
        return {"status": "rejected", "reason": "budget", "attempts": 0}

    def rejected(reason: str, attempt: int) -> dict:
        state.record(job_id, "rejected", reason)
        return {"status": "rejected", "reason": reason, "attempts": attempt}

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Generate(
                teacher_pb2.GenerateRequest(job_id=job_id, prompt_id=prompt_id, prompt=prompt),
                timeout=DEADLINE_S,
            )
        except grpc.RpcError as err:
            code = err.code()
            if code == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                continue
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                return rejected("deadline", attempt)
            return rejected(code.name.lower(), attempt)
        if reply.refused:
            return rejected("refusal", attempt)
        if reply.text == "":
            return rejected("empty", attempt)
        state.record(job_id, "accepted")
        return {
            "status": "accepted",
            "text": reply.text,
            "teacher_version": reply.teacher_version,
            "dedupe_hash": reservation["dedupe_hash"],
            "attempts": attempt,
        }
    return rejected("unavailable", MAX_ATTEMPTS)
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {TEACHER} from 'distill/config';

export const MAX_SHARD_SECONDS = 30;
export const BACKOFF_MS = 250;

interface GenerateRequest {
  job_id: string;
  prompt_id: string;
  prompt: string;
}
interface GenerateReply {
  text: string;
  refused: boolean;
  teacher_version: string;
}
interface TeacherClient {
  Generate(request: GenerateRequest, options?: {deadline: number}): Promise<GenerateReply>;
}

const {distill} = grpc.loadPackageDefinition(protoLoader.loadSync('teacher.proto')) as unknown as {
  distill: {Teacher: new (target: string, credentials: grpc.ChannelCredentials) => TeacherClient};
};
const stub = new distill.Teacher(TEACHER, grpc.credentials.createInsecure());

/** The step-2 job state the worker hands in: reserve before a call, record once after. */
export interface JobState {
  reserve(jobId: string, prompt: string): Promise<{verdict: string; remaining: number; dedupeHash: string}>;
  record(jobId: string, outcome: string, reason?: string): Promise<void>;
}

export interface Sample {
  status: string;
  reason?: string;
  text?: string;
  teacher_version?: string;
  dedupe_hash?: string;
  attempts: number;
}

/** One teacher sample: call until a usable completion comes back, then record the outcome. */
export async function generate(state: JobState, jobId: string, promptId: string, prompt: string): Promise<Sample> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const until = Date.now() + MAX_SHARD_SECONDS * 1000;
  let attempts = 0;
  while (Date.now() < until) {
    attempts += 1;
    let reply: GenerateReply;
    try {
      reply = await stub.Generate({job_id: jobId, prompt_id: promptId, prompt});
    } catch (err) {
      console.warn(\`teacher call failed job=\${jobId} prompt=\${promptId} code=\${(err as grpc.ServiceError).code}\`);
      await sleep(BACKOFF_MS);
      continue;
    }
    if (reply.refused || reply.text === '') {
      await sleep(BACKOFF_MS);
      continue;
    }
    await state.record(jobId, 'accepted');
    return {status: 'accepted', text: reply.text, teacher_version: reply.teacher_version, attempts};
  }
  await state.record(jobId, 'rejected', 'unavailable');
  return {status: 'rejected', reason: 'unavailable', attempts};
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {TEACHER} from 'distill/config';

export const DEADLINE_MS = 4_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 250;

interface GenerateRequest {
  job_id: string;
  prompt_id: string;
  prompt: string;
}
interface GenerateReply {
  text: string;
  refused: boolean;
  teacher_version: string;
}
interface TeacherClient {
  Generate(request: GenerateRequest, options?: {deadline: number}): Promise<GenerateReply>;
}

const {distill} = grpc.loadPackageDefinition(protoLoader.loadSync('teacher.proto')) as unknown as {
  distill: {Teacher: new (target: string, credentials: grpc.ChannelCredentials) => TeacherClient};
};
const stub = new distill.Teacher(TEACHER, grpc.credentials.createInsecure());

/** The step-2 job state the worker hands in: reserve before a call, record once after. */
export interface JobState {
  reserve(jobId: string, prompt: string): Promise<{verdict: string; remaining: number; dedupeHash: string}>;
  record(jobId: string, outcome: string, reason?: string): Promise<void>;
}

export interface Sample {
  status: string;
  reason?: string;
  text?: string;
  teacher_version?: string;
  dedupe_hash?: string;
  attempts: number;
}

/** One teacher sample: reserve budget, call with a deadline and bounded retries, record one outcome. */
export async function generate(state: JobState, jobId: string, promptId: string, prompt: string): Promise<Sample> {
  const reservation = await state.reserve(jobId, prompt);
  if (reservation.verdict === 'duplicate') return {status: 'duplicate', attempts: 0, dedupe_hash: reservation.dedupeHash};
  if (reservation.verdict === 'budget') return {status: 'rejected', reason: 'budget', attempts: 0};

  const rejected = async (reason: string, attempt: number): Promise<Sample> => {
    await state.record(jobId, 'rejected', reason);
    return {status: 'rejected', reason, attempts: attempt};
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let reply: GenerateReply;
    try {
      reply = await stub.Generate({job_id: jobId, prompt_id: promptId, prompt}, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      if (code === grpc.status.DEADLINE_EXCEEDED) return rejected('deadline', attempt);
      const name = Object.keys(grpc.status).find(k => grpc.status[k as keyof typeof grpc.status] === code);
      return rejected((name ?? \`status_\${code}\`).toLowerCase(), attempt);
    }
    if (reply.refused) return rejected('refusal', attempt);
    if (reply.text === '') return rejected('empty', attempt);
    await state.record(jobId, 'accepted');
    return {status: 'accepted', text: reply.text, teacher_version: reply.teacher_version, dedupe_hash: reservation.dedupeHash, attempts: attempt};
  }
  return rejected('unavailable', MAX_ATTEMPTS);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"distill/config" // config.Teacher — provided
	pb "distill/gen/teacher"
)

const (
	maxShardSeconds = 30
	backoff         = 250 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Teacher, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewTeacherClient(conn)

// Reservation is what the step-2 state answers: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
type Reservation struct {
	Verdict    string
	Remaining  int64
	DedupeHash string
}

// JobState is the step-2 job state the worker hands in: reserve before a call, record once after.
type JobState interface {
	Reserve(ctx context.Context, jobID, prompt string) (Reservation, error)
	Record(ctx context.Context, jobID, outcome, reason string) error
}

// Sample is one sample's outcome.
type Sample struct {
	Status         string
	Reason         string
	Text           string
	TeacherVersion string
	DedupeHash     string
	Attempts       int
}

// generate makes one teacher sample: call until a usable completion comes back, then record the outcome.
func generate(ctx context.Context, state JobState, jobID, promptID, prompt string) (Sample, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	until := time.Now().Add(maxShardSeconds * time.Second)
	attempts := 0
	for time.Now().Before(until) {
		attempts++
		reply, err := stub.Generate(ctx, &pb.GenerateRequest{JobId: jobID, PromptId: promptID, Prompt: prompt})
		if err != nil {
			log.Printf("teacher call failed job=%s prompt=%s code=%s", jobID, promptID, status.Code(err))
			time.Sleep(backoff)
			continue
		}
		if reply.GetRefused() || reply.GetText() == "" {
			time.Sleep(backoff)
			continue
		}
		if err := state.Record(ctx, jobID, "accepted", ""); err != nil {
			return Sample{}, err
		}
		return Sample{Status: "accepted", Text: reply.GetText(), TeacherVersion: reply.GetTeacherVersion(), Attempts: attempts}, nil
	}
	if err := state.Record(ctx, jobID, "rejected", "unavailable"); err != nil {
		return Sample{}, err
	}
	return Sample{Status: "rejected", Reason: "unavailable", Attempts: attempts}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"distill/config" // config.Teacher — provided
	pb "distill/gen/teacher"
)

const (
	deadline    = 4 * time.Second
	maxAttempts = 3
	backoff     = 250 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Teacher, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewTeacherClient(conn)

// Reservation is what the step-2 state answers: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
type Reservation struct {
	Verdict    string
	Remaining  int64
	DedupeHash string
}

// JobState is the step-2 job state the worker hands in: reserve before a call, record once after.
type JobState interface {
	Reserve(ctx context.Context, jobID, prompt string) (Reservation, error)
	Record(ctx context.Context, jobID, outcome, reason string) error
}

// Sample is one sample's outcome.
type Sample struct {
	Status         string
	Reason         string
	Text           string
	TeacherVersion string
	DedupeHash     string
	Attempts       int
}

// statusNames names every gRPC status code in lower snake case, indexed by its number.
var statusNames = [...]string{"ok", "cancelled", "unknown", "invalid_argument", "deadline_exceeded", "not_found", "already_exists", "permission_denied", "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss", "unauthenticated"}

// generate makes one teacher sample: reserve budget, call with a deadline and bounded retries, record one outcome.
func generate(ctx context.Context, state JobState, jobID, promptID, prompt string) (Sample, error) {
	reservation, err := state.Reserve(ctx, jobID, prompt)
	if err != nil {
		return Sample{}, err
	}
	switch reservation.Verdict {
	case "duplicate":
		return Sample{Status: "duplicate", DedupeHash: reservation.DedupeHash}, nil
	case "budget":
		return Sample{Status: "rejected", Reason: "budget"}, nil
	}
	rejected := func(reason string, attempt int) (Sample, error) {
		if err := state.Record(ctx, jobID, "rejected", reason); err != nil {
			return Sample{}, err
		}
		return Sample{Status: "rejected", Reason: reason, Attempts: attempt}, nil
	}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Generate(callCtx, &pb.GenerateRequest{JobId: jobID, PromptId: promptID, Prompt: prompt})
		cancel()
		if err != nil {
			code := status.Code(err)
			if code == codes.Unavailable && attempt < maxAttempts {
				time.Sleep(backoff * time.Duration(attempt))
				continue
			}
			if code == codes.DeadlineExceeded {
				return rejected("deadline", attempt)
			}
			reason := "unknown"
			if int(code) < len(statusNames) {
				reason = statusNames[code]
			}
			return rejected(reason, attempt)
		}
		if reply.GetRefused() {
			return rejected("refusal", attempt)
		}
		if reply.GetText() == "" {
			return rejected("empty", attempt)
		}
		if err := state.Record(ctx, jobID, "accepted", ""); err != nil {
			return Sample{}, err
		}
		return Sample{Status: "accepted", Text: reply.GetText(), TeacherVersion: reply.GetTeacherVersion(), DedupeHash: reservation.DedupeHash, Attempts: attempt}, nil
	}
	return rejected("unavailable", maxAttempts)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>

#include "distill/config.h"  // config::kTeacher — provided
#include "teacher.grpc.pb.h"

constexpr int kMaxShardSeconds = 30;
constexpr std::chrono::milliseconds kBackoff{250};

auto channel = grpc::CreateChannel(config::kTeacher, grpc::InsecureChannelCredentials());
auto stub = distill::Teacher::NewStub(channel);

// What the step-2 state answers: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
struct Reservation {
  std::string verdict;
  long long remaining = 0;
  std::string dedupe_hash;
};

// The step-2 job state the worker hands in: reserve before a call, record once after.
struct JobState {
  virtual ~JobState() = default;
  virtual Reservation reserve(const std::string& job_id, const std::string& prompt) = 0;
  virtual void record(const std::string& job_id, const std::string& outcome, const std::string& reason) = 0;
};

// One sample's outcome.
struct Sample {
  std::string status;
  std::string reason;
  std::string text;
  std::string teacher_version;
  std::string dedupe_hash;
  int attempts = 0;
};

// One teacher sample: call until a usable completion comes back, then record the outcome.
Sample generate(JobState& state, const std::string& job_id, const std::string& prompt_id, const std::string& prompt) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(kMaxShardSeconds);
  int attempts = 0;
  while (std::chrono::steady_clock::now() < until) {
    attempts++;
    grpc::ClientContext ctx;
    distill::GenerateRequest request;
    request.set_job_id(job_id);
    request.set_prompt_id(prompt_id);
    request.set_prompt(prompt);
    distill::GenerateReply reply;
    const grpc::Status status = stub->Generate(&ctx, request, &reply);
    if (!status.ok()) {
      std::cerr << "teacher call failed job=" << job_id << " prompt=" << prompt_id << " code=" << status.error_code() << "\\n";
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    if (reply.refused() || reply.text().empty()) {
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    state.record(job_id, "accepted", "");
    return {"accepted", "", reply.text(), reply.teacher_version(), "", attempts};
  }
  state.record(job_id, "rejected", "unavailable");
  return {"rejected", "unavailable", "", "", "", attempts};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>
#include <thread>

#include "distill/config.h"  // config::kTeacher — provided
#include "teacher.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{4};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{250};

auto channel = grpc::CreateChannel(config::kTeacher, grpc::InsecureChannelCredentials());
auto stub = distill::Teacher::NewStub(channel);

// What the step-2 state answers: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
struct Reservation {
  std::string verdict;
  long long remaining = 0;
  std::string dedupe_hash;
};

// The step-2 job state the worker hands in: reserve before a call, record once after.
struct JobState {
  virtual ~JobState() = default;
  virtual Reservation reserve(const std::string& job_id, const std::string& prompt) = 0;
  virtual void record(const std::string& job_id, const std::string& outcome, const std::string& reason) = 0;
};

// One sample's outcome.
struct Sample {
  std::string status;
  std::string reason;
  std::string text;
  std::string teacher_version;
  std::string dedupe_hash;
  int attempts = 0;
};

std::string reason_of(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::UNAVAILABLE: return "unavailable";
    case grpc::StatusCode::DEADLINE_EXCEEDED: return "deadline";
    case grpc::StatusCode::INVALID_ARGUMENT: return "invalid_argument";
    case grpc::StatusCode::RESOURCE_EXHAUSTED: return "resource_exhausted";
    default: {
      static const char* const kNames[] = {"ok", "cancelled", "unknown", "invalid_argument", "deadline_exceeded", "not_found", "already_exists", "permission_denied", "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss", "unauthenticated"};
      const int n = static_cast<int>(code);
      return n >= 0 && n < 17 ? kNames[n] : "unknown";
    }
  }
}

// One teacher sample: reserve budget, call with a deadline and bounded retries, record one outcome.
Sample generate(JobState& state, const std::string& job_id, const std::string& prompt_id, const std::string& prompt) {
  const Reservation reservation = state.reserve(job_id, prompt);
  if (reservation.verdict == "duplicate") return {"duplicate", "", "", "", reservation.dedupe_hash, 0};
  if (reservation.verdict == "budget") return {"rejected", "budget", "", "", "", 0};

  const auto rejected = [&](const std::string& reason, int attempt) {
    state.record(job_id, "rejected", reason);
    return Sample{"rejected", reason, "", "", "", attempt};
  };

  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    distill::GenerateRequest request;
    request.set_job_id(job_id);
    request.set_prompt_id(prompt_id);
    request.set_prompt(prompt);
    distill::GenerateReply reply;
    const grpc::Status status = stub->Generate(&ctx, request, &reply);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) {
        std::this_thread::sleep_for(kBackoff * attempt);
        continue;
      }
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) return rejected("deadline", attempt);
      return rejected(reason_of(status.error_code()), attempt);
    }
    if (reply.refused()) return rejected("refusal", attempt);
    if (reply.text().empty()) return rejected("empty", attempt);
    state.record(job_id, "accepted", "");
    return {"accepted", "", reply.text(), reply.teacher_version(), reservation.dedupe_hash, attempt};
  }
  return rejected("unavailable", kMaxAttempts);
}
`,
    },
  },
  harness: {
    python: `import hashlib

import grpc

import teacher_pb2
import teacher_pb2_grpc
from distill import config, teacher

JOB = "j1"


class TeacherServicer(teacher_pb2_grpc.TeacherServicer):
    """The stand-in teacher: answers from distill.teacher."""

    def Generate(self, request, context):
        text, refused = teacher.complete(request.prompt)
        return teacher_pb2.GenerateReply(text=text, refused=refused, teacher_version=teacher.TEACHER_VERSION)


def _world(ctx, cap=100):
    ctx.grpc.serve(teacher_pb2_grpc.add_TeacherServicer_to_server, TeacherServicer(), config.TEACHER)
    state = ctx.load("state")
    state.start_job(JOB, cap)
    m = ctx.load("client")
    return m, state


def _calls(ctx):
    return ctx.grpc.calls_to("Generate")


def _progress(ctx):
    return {k: int(v) for k, v in ctx.redis.hgetall(f"distill:progress:{JOB}").items() if k != "updated_at"}


def _reasons(ctx):
    return {k: int(v) for k, v in ctx.redis.hgetall(f"distill:reasons:{JOB}").items()}


def _expect(sample, status, reason=None):
    assert isinstance(sample, dict), f"generate must return a dict, got {type(sample).__name__}"
    assert sample.get("status") == status, f"expected status {status!r}, got {sample}"
    if reason is not None:
        assert sample.get("reason") == reason, f"expected reason {reason!r}, got {sample}"


def check_attempt_deadline(ctx):
    m, state = _world(ctx)
    sample = m.generate(state, JOB, "p-1", "What is the capital of France?")
    _expect(sample, "accepted")
    assert sample.get("text") == "Teacher answer: What is the capital of France?", f"an accepted sample carries the reply's text, got {sample}"
    assert sample.get("teacher_version") == teacher.TEACHER_VERSION, f"an accepted sample carries teacher_version, got {sample}"
    assert sample.get("attempts") == 1, f"a healthy teacher is called once (attempts 1), got {sample}"
    calls = _calls(ctx)
    assert len(calls) == 1, f"a healthy teacher must be called exactly once, saw {len(calls)} Generate calls"
    assert calls[0].timeout is not None, "the Generate call carries no deadline: a hung teacher would hold the worker for the whole shard"
    assert 3.5 <= calls[0].timeout <= 4.5, f"the deadline must be DEADLINE_S = 4 s, got {calls[0].timeout} s"
    ctx.grpc.set_latency("Generate", 3.0, config.TEACHER)
    slow = m.generate(state, JOB, "p-2", "What is the capital of Peru?")
    _expect(slow, "accepted")
    assert len(_calls(ctx)) == 2, "a teacher that answers within the deadline is accepted on the first call"


def check_retry_unavailable(ctx):
    m, state = _world(ctx)
    ctx.grpc.fail("Generate", grpc.StatusCode.UNAVAILABLE, "teacher restarting", times=1, target=config.TEACHER)
    sample = m.generate(state, JOB, "p-1", "What is 2 + 2?")
    _expect(sample, "accepted")
    assert sample.get("attempts") == 2 and len(_calls(ctx)) == 2, f"one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw {len(_calls(ctx))} calls and {sample}"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the next attempt"
    ctx.grpc.fail("Generate", grpc.StatusCode.UNAVAILABLE, "teacher down", times=3, target=config.TEACHER)
    sample = m.generate(state, JOB, "p-2", "What is 3 + 3?")
    _expect(sample, "rejected", "unavailable")
    assert len(_calls(ctx)) == 5, f"a teacher that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls, then the sample is rejected: saw {len(_calls(ctx)) - 2} calls for it"
    assert sample.get("attempts") == 3, f"attempts must say 3, got {sample}"
    assert _progress(ctx).get("rejected") == 1 and _reasons(ctx).get("unavailable") == 1, f"the rejection is recorded once with reason unavailable: {_progress(ctx)}, {_reasons(ctx)}"
    first = _calls(ctx)[0].timeout
    for i, call in enumerate(_calls(ctx)):
        assert call.timeout is not None and abs(call.timeout - first) <= 0.01, f"attempt deadlines {[c.timeout for c in _calls(ctx)]}: call {i + 1} did not carry the full DEADLINE_S, every attempt gets its own four seconds, not what is left of one deadline shared by the retries"
    for code in (grpc.StatusCode.INTERNAL, grpc.StatusCode.RESOURCE_EXHAUSTED):
        calls, rejected = len(_calls(ctx)), _progress(ctx).get("rejected", 0)
        ctx.grpc.fail("Generate", code, "teacher error", times=1, target=config.TEACHER)
        sample = m.generate(state, JOB, f"p-{code.name}", f"What is {code.name}?")
        _expect(sample, "rejected", code.name.lower())
        assert len(_calls(ctx)) == calls + 1, f"{code.name} is not UNAVAILABLE, so it is not retried: expected one call, saw {len(_calls(ctx)) - calls}"
        assert _progress(ctx).get("rejected") == rejected + 1 and sum(_reasons(ctx).values()) == rejected + 1, f"a {code.name} is recorded once as rejected with a reason: {_progress(ctx)}, {_reasons(ctx)}"


def check_refusal_recorded(ctx):
    m, state = _world(ctx)
    sample = m.generate(state, JOB, "p-1", "refuse: how do I pick a lock?")
    _expect(sample, "rejected", "refusal")
    assert len(_calls(ctx)) == 1, f"a refusal is an answer, not a failure: it must be called once, saw {len(_calls(ctx))} calls"
    assert sample.get("attempts") == 1, f"attempts must say 1, got {sample}"
    sample = m.generate(state, JOB, "p-2", "empty: say nothing")
    _expect(sample, "rejected", "empty")
    assert len(_calls(ctx)) == 2, f"an empty completion is recorded after one call, saw {len(_calls(ctx)) - 1} calls for it"
    progress, reasons = _progress(ctx), _reasons(ctx)
    assert progress.get("sampled") == 2 and progress.get("rejected") == 2 and progress.get("accepted", 0) == 0, f"two samples, both rejected, recorded once each: {progress}"
    assert reasons.get("refusal") == 1 and reasons.get("empty") == 1, f"the reasons must read refusal 1, empty 1: {reasons}"


def check_hung_call_cut(ctx):
    m, state = _world(ctx)
    ctx.grpc.set_latency("Generate", 5.0, config.TEACHER)
    started = ctx.clock.offset
    sample = m.generate(state, JOB, "p-1", "Explain photosynthesis.")
    waited = ctx.clock.offset - started
    _expect(sample, "rejected", "deadline")
    assert len(_calls(ctx)) == 1, f"a hung call is cut at the deadline and not retried: saw {len(_calls(ctx))} calls"
    assert _calls(ctx)[0].code == grpc.StatusCode.DEADLINE_EXCEEDED, f"the call must end DEADLINE_EXCEEDED, it ended {_calls(ctx)[0].code}"
    assert waited <= 4.6, f"the worker waited {waited:.1f} s on a teacher that hangs: the deadline must cut it at about 4 s"
    assert _reasons(ctx).get("deadline") == 1 and _progress(ctx).get("rejected") == 1, f"the sample is recorded as rejected with reason deadline: {_progress(ctx)}, {_reasons(ctx)}"
    ctx.grpc.set_latency("Generate", 0.0, config.TEACHER)
    _expect(m.generate(state, JOB, "p-2", "And respiration?"), "accepted")


def check_budget_before_call(ctx):
    m, state = _world(ctx, cap=1)
    first = m.generate(state, JOB, "p-1", "What is the capital of France?")
    _expect(first, "accepted")
    assert first.get("dedupe_hash") == hashlib.sha256(b"What is the capital of France?").hexdigest(), f"an accepted sample carries the reservation's dedupe_hash (the prompt's SHA-256): {first}"
    assert len(_calls(ctx)) == 1
    second = m.generate(state, JOB, "p-2", "What is the capital of Peru?")
    _expect(second, "rejected", "budget")
    assert len(_calls(ctx)) == 1, f"with the budget spent the worker must not call the teacher: saw {len(_calls(ctx)) - 1} extra Generate calls"
    again = m.generate(state, JOB, "p-3", "What is the capital of France?")
    _expect(again, "duplicate")
    assert len(_calls(ctx)) == 1, "a duplicate prompt must not call the teacher"
    progress = _progress(ctx)
    assert progress.get("sampled") == progress.get("accepted", 0) + progress.get("rejected", 0) == 2, f"after a run sampled must equal accepted + rejected: {progress}"
    assert progress.get("duplicate") == 1 and _reasons(ctx).get("budget") == 1, f"the duplicate and the budget refusal are counted: {progress}, {_reasons(ctx)}"
`,
    typescript: `import {createHash} from 'node:crypto';

const JOB = 'j1';

/** The stand-in teacher at TEACHER, the step-2 state seeded, the learner's module. */
async function world(ctx, cap = 100) {
  const {distill} = ctx.proto('teacher.proto');
  const config = ctx.load('/support/distill/config.ts');
  const teacher = ctx.load('/support/distill/teacher.ts');
  ctx.grpc.serve(distill.Teacher.service, {
    Generate(call, callback) {
      const {text, refused} = teacher.complete(call.request.prompt);
      callback(null, {text, refused, teacher_version: teacher.TEACHER_VERSION});
    },
  }, config.TEACHER);
  const state = ctx.load('state');
  await state.startJob(JOB, cap);
  return {m: ctx.load('client'), state, config, teacher};
}

const calls = ctx => ctx.grpc.callsTo('Generate');
const progress = ctx => Object.fromEntries(Object.entries(ctx.redis.hgetall(\`distill:progress:\${JOB}\`)).filter(([k]) => k !== 'updated_at').map(([k, v]) => [k, Number(v)]));
const reasons = ctx => Object.fromEntries(Object.entries(ctx.redis.hgetall(\`distill:reasons:\${JOB}\`)).map(([k, v]) => [k, Number(v)]));

function expect(sample, status: string, reason?: string) {
  assert(sample !== null && typeof sample === 'object', \`generate must resolve to an object, got \${JSON.stringify(sample)}\`);
  assert.equal(sample.status, status, \`expected status \${status}, got \${JSON.stringify(sample)}\`);
  if (reason !== undefined) assert.equal(sample.reason, reason, \`expected reason \${reason}, got \${JSON.stringify(sample)}\`);
}

export async function check_attempt_deadline(ctx) {
  const {m, state, config, teacher} = await world(ctx);
  const sample = await m.generate(state, JOB, 'p-1', 'What is the capital of France?');
  expect(sample, 'accepted');
  assert.equal(sample.text, 'Teacher answer: What is the capital of France?', \`an accepted sample carries the reply's text, got \${JSON.stringify(sample)}\`);
  assert.equal(sample.teacher_version, teacher.TEACHER_VERSION, \`an accepted sample carries teacher_version, got \${JSON.stringify(sample)}\`);
  assert.equal(sample.attempts, 1, \`a healthy teacher is called once (attempts 1), got \${JSON.stringify(sample)}\`);
  assert.equal(calls(ctx).length, 1, \`a healthy teacher must be called exactly once, saw \${calls(ctx).length} Generate calls\`);
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the Generate call carries no deadline: a hung teacher would hold the worker for the whole shard');
  assert(3.5 <= call.timeout && call.timeout <= 4.5, \`the deadline must be DEADLINE_MS = 4000 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Generate', 3.0, config.TEACHER);
  expect(await m.generate(state, JOB, 'p-2', 'What is the capital of Peru?'), 'accepted');
  assert.equal(calls(ctx).length, 2, 'a teacher that answers within the deadline is accepted on the first call');
}

export async function check_retry_unavailable(ctx) {
  const {m, state, config} = await world(ctx);
  ctx.grpc.fail('Generate', ctx.grpc.status.UNAVAILABLE, 'teacher restarting', 1, config.TEACHER);
  let sample = await m.generate(state, JOB, 'p-1', 'What is 2 + 2?');
  expect(sample, 'accepted');
  assert(sample.attempts === 2 && calls(ctx).length === 2, \`one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw \${calls(ctx).length} calls and \${JSON.stringify(sample)}\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the next attempt');
  ctx.grpc.fail('Generate', ctx.grpc.status.UNAVAILABLE, 'teacher down', 3, config.TEACHER);
  sample = await m.generate(state, JOB, 'p-2', 'What is 3 + 3?');
  expect(sample, 'rejected', 'unavailable');
  assert.equal(calls(ctx).length, 5, \`a teacher that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls, then the sample is rejected: saw \${calls(ctx).length - 2} calls for it\`);
  assert.equal(sample.attempts, 3, \`attempts must say 3, got \${JSON.stringify(sample)}\`);
  assert(progress(ctx).rejected === 1 && reasons(ctx).unavailable === 1, \`the rejection is recorded once with reason unavailable: \${JSON.stringify(progress(ctx))}, \${JSON.stringify(reasons(ctx))}\`);
  const deadlines = calls(ctx).map(c => c.timeout);
  deadlines.forEach((timeout, i) =>
    assert(timeout !== null && Math.abs(timeout - deadlines[0]) <= 0.01, \`attempt deadlines \${JSON.stringify(deadlines)}: call \${i + 1} did not carry the full DEADLINE_MS, every attempt gets its own four seconds, not what is left of one deadline shared by the retries\`),
  );
  for (const code of ['INTERNAL', 'RESOURCE_EXHAUSTED']) {
    const before = calls(ctx).length;
    const rejected = progress(ctx).rejected ?? 0;
    ctx.grpc.fail('Generate', ctx.grpc.status[code], 'teacher error', 1, config.TEACHER);
    expect(await m.generate(state, JOB, \`p-\${code}\`, \`What is \${code}?\`), 'rejected', code.toLowerCase());
    assert.equal(calls(ctx).length, before + 1, \`\${code} is not UNAVAILABLE, so it is not retried: expected one call, saw \${calls(ctx).length - before}\`);
    const total = Object.values(reasons(ctx)).reduce((a: number, b) => a + Number(b), 0);
    assert(progress(ctx).rejected === rejected + 1 && total === rejected + 1, \`a \${code} is recorded once as rejected with a reason: \${JSON.stringify(progress(ctx))}, \${JSON.stringify(reasons(ctx))}\`);
  }
}

export async function check_refusal_recorded(ctx) {
  const {m, state} = await world(ctx);
  let sample = await m.generate(state, JOB, 'p-1', 'refuse: how do I pick a lock?');
  expect(sample, 'rejected', 'refusal');
  assert.equal(calls(ctx).length, 1, \`a refusal is an answer, not a failure: it must be called once, saw \${calls(ctx).length} calls\`);
  assert.equal(sample.attempts, 1, \`attempts must say 1, got \${JSON.stringify(sample)}\`);
  sample = await m.generate(state, JOB, 'p-2', 'empty: say nothing');
  expect(sample, 'rejected', 'empty');
  assert.equal(calls(ctx).length, 2, \`an empty completion is recorded after one call, saw \${calls(ctx).length - 1} calls for it\`);
  const p = progress(ctx);
  assert(p.sampled === 2 && p.rejected === 2 && (p.accepted ?? 0) === 0, \`two samples, both rejected, recorded once each: \${JSON.stringify(p)}\`);
  assert(reasons(ctx).refusal === 1 && reasons(ctx).empty === 1, \`the reasons must read refusal 1, empty 1: \${JSON.stringify(reasons(ctx))}\`);
}

export async function check_hung_call_cut(ctx) {
  const {m, state, config} = await world(ctx);
  ctx.grpc.setLatency('Generate', 5.0, config.TEACHER);
  const started = ctx.clock.now();
  const sample = await m.generate(state, JOB, 'p-1', 'Explain photosynthesis.');
  const waited = (ctx.clock.now() - started) / 1000;
  expect(sample, 'rejected', 'deadline');
  assert.equal(calls(ctx).length, 1, \`a hung call is cut at the deadline and not retried: saw \${calls(ctx).length} calls\`);
  assert.equal(calls(ctx)[0].code, ctx.grpc.status.DEADLINE_EXCEEDED, 'the call must end DEADLINE_EXCEEDED');
  assert(waited <= 4.6, \`the worker waited \${waited.toFixed(1)} s on a teacher that hangs: the deadline must cut it at about 4 s\`);
  assert(reasons(ctx).deadline === 1 && progress(ctx).rejected === 1, \`the sample is recorded as rejected with reason deadline: \${JSON.stringify(progress(ctx))}, \${JSON.stringify(reasons(ctx))}\`);
  ctx.grpc.setLatency('Generate', 0, config.TEACHER);
  expect(await m.generate(state, JOB, 'p-2', 'And respiration?'), 'accepted');
}

export async function check_budget_before_call(ctx) {
  const {m, state} = await world(ctx, 1);
  const first = await m.generate(state, JOB, 'p-1', 'What is the capital of France?');
  expect(first, 'accepted');
  const hash = createHash('sha256').update('What is the capital of France?').digest('hex');
  assert.equal(first.dedupe_hash, hash, \`an accepted sample carries the reservation's dedupe_hash (the prompt's SHA-256): \${JSON.stringify(first)}\`);
  assert.equal(calls(ctx).length, 1);
  const second = await m.generate(state, JOB, 'p-2', 'What is the capital of Peru?');
  expect(second, 'rejected', 'budget');
  assert.equal(calls(ctx).length, 1, \`with the budget spent the worker must not call the teacher: saw \${calls(ctx).length - 1} extra Generate calls\`);
  expect(await m.generate(state, JOB, 'p-3', 'What is the capital of France?'), 'duplicate');
  assert.equal(calls(ctx).length, 1, 'a duplicate prompt must not call the teacher');
  const p = progress(ctx);
  assert(p.sampled === 2 && p.sampled === (p.accepted ?? 0) + (p.rejected ?? 0), \`after a run sampled must equal accepted + rejected: \${JSON.stringify(p)}\`);
  assert(p.duplicate === 1 && reasons(ctx).budget === 1, \`the duplicate and the budget refusal are counted: \${JSON.stringify(p)}, \${JSON.stringify(reasons(ctx))}\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"

	"distill/config"
	pb "distill/gen/teacher"
	"distill/teacher"

	"leetbuild/harness"
)

const kHClientJob = "j1"

// teacherPeer is the stand-in teacher: answers from distill/teacher.
type HTeacherPeer struct {
	pb.UnimplementedTeacherServer
}

func (HTeacherPeer) Generate(_ context.Context, req *pb.GenerateRequest) (*pb.GenerateReply, error) {
	text, refused := teacher.Complete(req.GetPrompt())
	return &pb.GenerateReply{Text: text, Refused: refused, TeacherVersion: teacher.Version}, nil
}

// clientState stands in for the step-2 job state over the harness's Redis.
type HClientState struct {
	ctx *harness.Ctx
}

func (s HClientState) Reserve(_ context.Context, jobID, prompt string) (Reservation, error) {
	sum := sha256.Sum256([]byte(prompt))
	hash := hex.EncodeToString(sum[:])
	if s.ctx.Redis.SIsMember(config.SeenKey(jobID), hash) {
		s.ctx.Redis.Do("HINCRBY", config.ProgressKey(jobID), "duplicate", 1)
		return Reservation{Verdict: "duplicate", DedupeHash: hash}, nil
	}
	raw, _ := s.ctx.Redis.Get(config.BudgetKey(jobID))
	remaining, _ := strconv.ParseInt(raw, 10, 64)
	if remaining < config.TokensPerCall {
		s.ctx.Redis.Do("HINCRBY", config.ProgressKey(jobID), "sampled", 1)
		s.ctx.Redis.Do("HINCRBY", config.ProgressKey(jobID), "rejected", 1)
		s.ctx.Redis.Do("HINCRBY", config.ReasonsKey(jobID), "budget", 1)
		return Reservation{Verdict: "budget", Remaining: remaining, DedupeHash: hash}, nil
	}
	left := s.ctx.Redis.Do("DECRBY", config.BudgetKey(jobID), config.TokensPerCall).(int64)
	s.ctx.Redis.Do("SADD", config.SeenKey(jobID), hash)
	s.ctx.Redis.Do("HINCRBY", config.ProgressKey(jobID), "sampled", 1)
	return Reservation{Verdict: "ok", Remaining: left, DedupeHash: hash}, nil
}

func (s HClientState) Record(_ context.Context, jobID, outcome, reason string) error {
	if outcome == "accepted" {
		s.ctx.Redis.Do("HINCRBY", config.ProgressKey(jobID), "accepted", 1)
		return nil
	}
	s.ctx.Redis.Do("HINCRBY", config.ProgressKey(jobID), "rejected", 1)
	s.ctx.Redis.Do("HINCRBY", config.ReasonsKey(jobID), reason, 1)
	return nil
}

func hClientWorld(ctx *harness.Ctx, cap int) HClientState {
	pb.RegisterTeacherServer(ctx.GRPC.Server(config.Teacher), &HTeacherPeer{})
	ctx.Redis.Set(config.BudgetKey(kHClientJob), int64(cap)*config.TokensPerCall)
	ctx.Redis.Do("HSET", config.ProgressKey(kHClientJob), "sampled", 0, "accepted", 0, "rejected", 0, "duplicate", 0)
	return HClientState{ctx: ctx}
}

func hClientGenerate(ctx *harness.Ctx, state HClientState, promptID, prompt string) Sample {
	sample, err := generate(context.Background(), state, kHClientJob, promptID, prompt)
	ctx.NoError(err, "generate(%q)", promptID)
	return sample
}

func hClientCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Generate", "") }

func hClientCount(ctx *harness.Ctx, key, field string) int64 {
	n, _ := strconv.ParseInt(ctx.Redis.HGetAll(key)[field], 10, 64)
	return n
}

func hClientExpect(ctx *harness.Ctx, sample Sample, status, reason string) {
	ctx.Equal(sample.Status, status, "the sample's status (%+v)", sample)
	if reason != "" {
		ctx.Equal(sample.Reason, reason, "the sample's reason (%+v)", sample)
	}
}

func CheckAttemptDeadline(ctx *harness.Ctx) {
	state := hClientWorld(ctx, 100)
	sample := hClientGenerate(ctx, state, "p-1", "What is the capital of France?")
	hClientExpect(ctx, sample, "accepted", "")
	ctx.Equal(sample.Text, "Teacher answer: What is the capital of France?", "an accepted sample carries the reply's text")
	ctx.Equal(sample.TeacherVersion, teacher.Version, "an accepted sample carries TeacherVersion")
	ctx.Equal(sample.Attempts, 1, "a healthy teacher is called once; attempts")
	calls := hClientCalls(ctx)
	ctx.Equal(len(calls), 1, "a healthy teacher must be called exactly once; Generate calls")
	ctx.Assert(calls[0].HasDeadline(), "the Generate call carries no deadline: a hung teacher would hold the worker for the whole shard")
	ctx.Assert(3500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 4500*time.Millisecond, "the deadline must be 4 s, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Generate", 3.0, config.Teacher)
	hClientExpect(ctx, hClientGenerate(ctx, state, "p-2", "What is the capital of Peru?"), "accepted", "")
	ctx.Equal(len(hClientCalls(ctx)), 2, "a teacher that answers within the deadline is accepted on the first call; calls")
}

func CheckRetryUnavailable(ctx *harness.Ctx) {
	state := hClientWorld(ctx, 100)
	ctx.GRPC.Fail("Generate", codes.Unavailable, "teacher restarting", 1, config.Teacher)
	sample := hClientGenerate(ctx, state, "p-1", "What is 2 + 2?")
	hClientExpect(ctx, sample, "accepted", "")
	ctx.Assert(sample.Attempts == 2 && len(hClientCalls(ctx)) == 2, "one UNAVAILABLE earns one retry: expected 2 calls and Attempts 2, saw %d calls and %+v", len(hClientCalls(ctx)), sample)
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt")
	ctx.GRPC.Fail("Generate", codes.Unavailable, "teacher down", 3, config.Teacher)
	sample = hClientGenerate(ctx, state, "p-2", "What is 3 + 3?")
	hClientExpect(ctx, sample, "rejected", "unavailable")
	ctx.Equal(len(hClientCalls(ctx)), 5, "a teacher that stays UNAVAILABLE gets maxAttempts = 3 calls, then the sample is rejected; calls so far")
	ctx.Equal(sample.Attempts, 3, "Attempts")
	ctx.Assert(hClientCount(ctx, config.ProgressKey(kHClientJob), "rejected") == 1 && hClientCount(ctx, config.ReasonsKey(kHClientJob), "unavailable") == 1, "the rejection is recorded once with reason unavailable: %v, %v", ctx.Redis.HGetAll(config.ProgressKey(kHClientJob)), ctx.Redis.HGetAll(config.ReasonsKey(kHClientJob)))
	deadlines := []time.Duration{}
	for _, call := range hClientCalls(ctx) {
		deadlines = append(deadlines, call.Timeout)
	}
	for i, call := range hClientCalls(ctx) {
		gap := call.Timeout - deadlines[0]
		ctx.Assert(call.HasDeadline() && -10*time.Millisecond <= gap && gap <= 10*time.Millisecond, "attempt deadlines %v: call %d did not carry the full deadline, every attempt gets its own four seconds, not what is left of one deadline shared by the retries", deadlines, i+1)
	}
	for _, terminal := range []struct {
		code   codes.Code
		reason string
	}{{codes.Internal, "internal"}, {codes.ResourceExhausted, "resource_exhausted"}} {
		code := terminal.code
		before, rejected := len(hClientCalls(ctx)), hClientCount(ctx, config.ProgressKey(kHClientJob), "rejected")
		ctx.GRPC.Fail("Generate", code, "teacher error", 1, config.Teacher)
		hClientExpect(ctx, hClientGenerate(ctx, state, "p-"+code.String(), "What is "+code.String()+"?"), "rejected", terminal.reason)
		ctx.Equal(len(hClientCalls(ctx))-before, 1, "%v is not UNAVAILABLE, so it is not retried; calls for it", code)
		total := int64(0)
		for field := range ctx.Redis.HGetAll(config.ReasonsKey(kHClientJob)) {
			total += hClientCount(ctx, config.ReasonsKey(kHClientJob), field)
		}
		ctx.Assert(hClientCount(ctx, config.ProgressKey(kHClientJob), "rejected") == rejected+1 && total == rejected+1, "a %v is recorded once as rejected with a reason: %v, %v", code, ctx.Redis.HGetAll(config.ProgressKey(kHClientJob)), ctx.Redis.HGetAll(config.ReasonsKey(kHClientJob)))
	}
}

func CheckRefusalRecorded(ctx *harness.Ctx) {
	state := hClientWorld(ctx, 100)
	sample := hClientGenerate(ctx, state, "p-1", "refuse: how do I pick a lock?")
	hClientExpect(ctx, sample, "rejected", "refusal")
	ctx.Equal(len(hClientCalls(ctx)), 1, "a refusal is an answer, not a failure: it must be called once; calls")
	ctx.Equal(sample.Attempts, 1, "Attempts")
	sample = hClientGenerate(ctx, state, "p-2", "empty: say nothing")
	hClientExpect(ctx, sample, "rejected", "empty")
	ctx.Equal(len(hClientCalls(ctx)), 2, "an empty completion is recorded after one call; calls so far")
	progress := ctx.Redis.HGetAll(config.ProgressKey(kHClientJob))
	ctx.Assert(progress["sampled"] == "2" && progress["rejected"] == "2" && progress["accepted"] == "0", "two samples, both rejected, recorded once each: %v", progress)
	reasons := ctx.Redis.HGetAll(config.ReasonsKey(kHClientJob))
	ctx.Assert(reasons["refusal"] == "1" && reasons["empty"] == "1", "the reasons must read refusal 1, empty 1: %v", reasons)
}

func CheckHungCallCut(ctx *harness.Ctx) {
	state := hClientWorld(ctx, 100)
	ctx.GRPC.SetLatency("Generate", 5.0, config.Teacher)
	started := ctx.Clock.Now()
	sample := hClientGenerate(ctx, state, "p-1", "Explain photosynthesis.")
	waited := float64(ctx.Clock.Now()-started) / 1000
	hClientExpect(ctx, sample, "rejected", "deadline")
	ctx.Equal(len(hClientCalls(ctx)), 1, "a hung call is cut at the deadline and not retried; calls")
	ctx.Equal(hClientCalls(ctx)[0].Code, codes.DeadlineExceeded, "the call must end DEADLINE_EXCEEDED")
	ctx.Assert(waited <= 4.6, "the worker waited %.1f s on a teacher that hangs: the deadline must cut it at about 4 s", waited)
	ctx.Assert(hClientCount(ctx, config.ReasonsKey(kHClientJob), "deadline") == 1 && hClientCount(ctx, config.ProgressKey(kHClientJob), "rejected") == 1, "the sample is recorded as rejected with reason deadline: %v, %v", ctx.Redis.HGetAll(config.ProgressKey(kHClientJob)), ctx.Redis.HGetAll(config.ReasonsKey(kHClientJob)))
	ctx.GRPC.SetLatency("Generate", 0, config.Teacher)
	hClientExpect(ctx, hClientGenerate(ctx, state, "p-2", "And respiration?"), "accepted", "")
}

func CheckBudgetBeforeCall(ctx *harness.Ctx) {
	state := hClientWorld(ctx, 1)
	first := hClientGenerate(ctx, state, "p-1", "What is the capital of France?")
	hClientExpect(ctx, first, "accepted", "")
	sum := sha256.Sum256([]byte("What is the capital of France?"))
	ctx.Equal(first.DedupeHash, hex.EncodeToString(sum[:]), "an accepted sample carries the reservation's DedupeHash (the prompt's SHA-256)")
	ctx.Equal(len(hClientCalls(ctx)), 1, "calls after one sample")
	second := hClientGenerate(ctx, state, "p-2", "What is the capital of Peru?")
	hClientExpect(ctx, second, "rejected", "budget")
	ctx.Equal(len(hClientCalls(ctx)), 1, "with the budget spent the worker must not call the teacher; calls")
	hClientExpect(ctx, hClientGenerate(ctx, state, "p-3", "What is the capital of France?"), "duplicate", "")
	ctx.Equal(len(hClientCalls(ctx)), 1, "a duplicate prompt must not call the teacher; calls")
	sampled, accepted, rejected := hClientCount(ctx, config.ProgressKey(kHClientJob), "sampled"), hClientCount(ctx, config.ProgressKey(kHClientJob), "accepted"), hClientCount(ctx, config.ProgressKey(kHClientJob), "rejected")
	ctx.Assert(sampled == 2 && sampled == accepted+rejected, "after a run sampled must equal accepted + rejected: %v", ctx.Redis.HGetAll(config.ProgressKey(kHClientJob)))
	ctx.Assert(hClientCount(ctx, config.ProgressKey(kHClientJob), "duplicate") == 1 && hClientCount(ctx, config.ReasonsKey(kHClientJob), "budget") == 1, "the duplicate and the budget refusal are counted: %v, %v", ctx.Redis.HGetAll(config.ProgressKey(kHClientJob)), ctx.Redis.HGetAll(config.ReasonsKey(kHClientJob)))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <cstdlib>
#include <string>
#include <utility>

#include "digest.h"
#include "distill/teacher.h"

namespace {

const std::string kHJob = "j1";

// The stand-in teacher: answers from distill/teacher.h.
class HTeacherPeer final : public distill::Teacher::Service {
 public:
  grpc::Status Generate(grpc::ServerContext*, const distill::GenerateRequest* req, distill::GenerateReply* reply) override {
    const auto completion = teacher::complete(req->prompt());
    reply->set_text(completion.text);
    reply->set_refused(completion.refused);
    reply->set_teacher_version(teacher::kVersion);
    return grpc::Status::OK;
  }
};

// Stands in for the step-2 job state over the harness's Redis.
class HClientState final : public JobState {
 public:
  explicit HClientState(harness::Ctx& ctx) : ctx_(ctx) {}

  Reservation reserve(const std::string& job_id, const std::string& prompt) override {
    const std::string hash = sha256_hex(prompt);
    if (ctx_.Redis.SIsMember(config::seen_key(job_id), hash)) {
      ctx_.Redis.Do("HINCRBY", config::progress_key(job_id), "duplicate", 1);
      return {"duplicate", 0, hash};
    }
    const auto raw = ctx_.Redis.Get(config::budget_key(job_id));
    const long long remaining = raw ? std::strtoll(raw->c_str(), nullptr, 10) : 0;
    if (remaining < config::kTokensPerCall) {
      ctx_.Redis.Do("HINCRBY", config::progress_key(job_id), "sampled", 1);
      ctx_.Redis.Do("HINCRBY", config::progress_key(job_id), "rejected", 1);
      ctx_.Redis.Do("HINCRBY", config::reasons_key(job_id), "budget", 1);
      return {"budget", remaining, hash};
    }
    const long long left = ctx_.Redis.Do("DECRBY", config::budget_key(job_id), config::kTokensPerCall).Int();
    ctx_.Redis.Do("SADD", config::seen_key(job_id), hash);
    ctx_.Redis.Do("HINCRBY", config::progress_key(job_id), "sampled", 1);
    return {"ok", left, hash};
  }

  void record(const std::string& job_id, const std::string& outcome, const std::string& reason) override {
    if (outcome == "accepted") {
      ctx_.Redis.Do("HINCRBY", config::progress_key(job_id), "accepted", 1);
      return;
    }
    ctx_.Redis.Do("HINCRBY", config::progress_key(job_id), "rejected", 1);
    ctx_.Redis.Do("HINCRBY", config::reasons_key(job_id), reason, 1);
  }

 private:
  harness::Ctx& ctx_;
};

struct HWorld {
  HTeacherPeer peer;
  HClientState state;
  explicit HWorld(harness::Ctx& ctx) : state(ctx) {}
};

HWorld& hClientWorld(harness::Ctx& ctx, int cap) {
  static HWorld* world = nullptr;
  delete world;
  world = new HWorld(ctx);
  ctx.GRPC.Server(config::kTeacher)->RegisterService(&world->peer);
  ctx.Redis.Set(config::budget_key(kHJob), static_cast<long long>(cap) * config::kTokensPerCall);
  ctx.Redis.Do("HSET", config::progress_key(kHJob), "sampled", 0, "accepted", 0, "rejected", 0, "duplicate", 0);
  return *world;
}

long long hClientCount(harness::Ctx& ctx, const std::string& key, const std::string& field) {
  const auto all = ctx.Redis.HGetAll(key);
  const auto it = all.find(field);
  return it == all.end() ? 0 : std::strtoll(it->second.c_str(), nullptr, 10);
}

void hClientExpect(harness::Ctx& ctx, const Sample& sample, const std::string& status, const std::string& reason = "") {
  ctx.Equal(sample.status, status, "the sample's status (reason %q, attempts %d)", sample.reason, sample.attempts);
  if (!reason.empty()) ctx.Equal(sample.reason, reason, "the sample's reason");
}

}  // namespace

void CheckAttemptDeadline(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx, 100);
  const Sample sample = generate(w.state, kHJob, "p-1", "What is the capital of France?");
  hClientExpect(ctx, sample, "accepted");
  ctx.Equal(sample.text, "Teacher answer: What is the capital of France?", "an accepted sample carries the reply's text");
  ctx.Equal(sample.teacher_version, teacher::kVersion, "an accepted sample carries teacher_version");
  ctx.Equal(sample.attempts, 1, "a healthy teacher is called once; attempts");
  const auto calls = ctx.GRPC.CallsTo("Generate");
  ctx.Equal(calls.size(), 1, "a healthy teacher must be called exactly once; Generate calls");
  ctx.Assert(calls[0].HasDeadline(), "the Generate call carries no deadline: a hung teacher would hold the worker for the whole shard");
  ctx.Assert(3.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 4.5, "the deadline must be 4 s, got %vs", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Generate", 3.0, config::kTeacher);
  hClientExpect(ctx, generate(w.state, kHJob, "p-2", "What is the capital of Peru?"), "accepted");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 2, "a teacher that answers within the deadline is accepted on the first call; calls");
}

void CheckRetryUnavailable(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx, 100);
  ctx.GRPC.Fail("Generate", grpc::StatusCode::UNAVAILABLE, "teacher restarting", 1, config::kTeacher);
  Sample sample = generate(w.state, kHJob, "p-1", "What is 2 + 2?");
  hClientExpect(ctx, sample, "accepted");
  ctx.Assert(sample.attempts == 2 && ctx.GRPC.CallsTo("Generate").size() == 2, "one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw %d calls and attempts %d", ctx.GRPC.CallsTo("Generate").size(), sample.attempts);
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt");
  ctx.GRPC.Fail("Generate", grpc::StatusCode::UNAVAILABLE, "teacher down", 3, config::kTeacher);
  sample = generate(w.state, kHJob, "p-2", "What is 3 + 3?");
  hClientExpect(ctx, sample, "rejected", "unavailable");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 5, "a teacher that stays UNAVAILABLE gets kMaxAttempts = 3 calls, then the sample is rejected; calls so far");
  ctx.Equal(sample.attempts, 3, "attempts");
  ctx.Assert(hClientCount(ctx, config::progress_key(kHJob), "rejected") == 1 && hClientCount(ctx, config::reasons_key(kHJob), "unavailable") == 1, "the rejection is recorded once with reason unavailable: %v, %v", ctx.Redis.HGetAll(config::progress_key(kHJob)), ctx.Redis.HGetAll(config::reasons_key(kHJob)));
  const auto all = ctx.GRPC.CallsTo("Generate");
  std::string deadlines;
  for (const auto& call : all) deadlines += (deadlines.empty() ? "" : " ") + std::to_string(call.TimeoutSeconds());
  for (size_t i = 0; i < all.size(); ++i) {
    ctx.Assert(all[i].HasDeadline() && std::abs(all[i].TimeoutSeconds() - all[0].TimeoutSeconds()) <= 0.01, "attempt deadlines [%s]: call %d did not carry the full deadline, every attempt gets its own four seconds, not what is left of one deadline shared by the retries", deadlines, i + 1);
  }
  for (const auto& [code, name, reason] : {std::tuple{grpc::StatusCode::INTERNAL, "INTERNAL", "internal"}, std::tuple{grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED", "resource_exhausted"}}) {
    const size_t before = ctx.GRPC.CallsTo("Generate").size();
    const long long rejected = hClientCount(ctx, config::progress_key(kHJob), "rejected");
    ctx.GRPC.Fail("Generate", code, "teacher error", 1, config::kTeacher);
    hClientExpect(ctx, generate(w.state, kHJob, std::string("p-") + name, std::string("What is ") + name + "?"), "rejected", reason);
    ctx.Equal(ctx.GRPC.CallsTo("Generate").size() - before, 1, "%s is not UNAVAILABLE, so it is not retried; calls for it", name);
    long long total = 0;
    for (const auto& [field, value] : ctx.Redis.HGetAll(config::reasons_key(kHJob))) total += std::strtoll(value.c_str(), nullptr, 10);
    ctx.Assert(hClientCount(ctx, config::progress_key(kHJob), "rejected") == rejected + 1 && total == rejected + 1, "a %s is recorded once as rejected with a reason: %v, %v", name, ctx.Redis.HGetAll(config::progress_key(kHJob)), ctx.Redis.HGetAll(config::reasons_key(kHJob)));
  }
}

void CheckRefusalRecorded(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx, 100);
  Sample sample = generate(w.state, kHJob, "p-1", "refuse: how do I pick a lock?");
  hClientExpect(ctx, sample, "rejected", "refusal");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 1, "a refusal is an answer, not a failure: it must be called once; calls");
  ctx.Equal(sample.attempts, 1, "attempts");
  sample = generate(w.state, kHJob, "p-2", "empty: say nothing");
  hClientExpect(ctx, sample, "rejected", "empty");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 2, "an empty completion is recorded after one call; calls so far");
  const auto progress = ctx.Redis.HGetAll(config::progress_key(kHJob));
  ctx.Assert(hClientCount(ctx, config::progress_key(kHJob), "sampled") == 2 && hClientCount(ctx, config::progress_key(kHJob), "rejected") == 2 && hClientCount(ctx, config::progress_key(kHJob), "accepted") == 0, "two samples, both rejected, recorded once each: %v", progress);
  ctx.Assert(hClientCount(ctx, config::reasons_key(kHJob), "refusal") == 1 && hClientCount(ctx, config::reasons_key(kHJob), "empty") == 1, "the reasons must read refusal 1, empty 1: %v", ctx.Redis.HGetAll(config::reasons_key(kHJob)));
}

void CheckHungCallCut(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx, 100);
  ctx.GRPC.SetLatency("Generate", 5.0, config::kTeacher);
  const int64_t started = ctx.Clock.Now();
  const Sample sample = generate(w.state, kHJob, "p-1", "Explain photosynthesis.");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  hClientExpect(ctx, sample, "rejected", "deadline");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 1, "a hung call is cut at the deadline and not retried; calls");
  ctx.Equal(ctx.GRPC.CallsTo("Generate")[0].Code, grpc::StatusCode::DEADLINE_EXCEEDED, "the call must end DEADLINE_EXCEEDED");
  ctx.Assert(waited <= 4.6, "the worker waited %.1f s on a teacher that hangs: the deadline must cut it at about 4 s", waited);
  ctx.Assert(hClientCount(ctx, config::reasons_key(kHJob), "deadline") == 1 && hClientCount(ctx, config::progress_key(kHJob), "rejected") == 1, "the sample is recorded as rejected with reason deadline: %v, %v", ctx.Redis.HGetAll(config::progress_key(kHJob)), ctx.Redis.HGetAll(config::reasons_key(kHJob)));
  ctx.GRPC.SetLatency("Generate", 0, config::kTeacher);
  hClientExpect(ctx, generate(w.state, kHJob, "p-2", "And respiration?"), "accepted");
}

void CheckBudgetBeforeCall(harness::Ctx& ctx) {
  auto& w = hClientWorld(ctx, 1);
  const Sample first = generate(w.state, kHJob, "p-1", "What is the capital of France?");
  hClientExpect(ctx, first, "accepted");
  ctx.Equal(first.dedupe_hash, sha256_hex("What is the capital of France?"), "an accepted sample carries the reservation's dedupe_hash (the prompt's SHA-256)");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 1, "calls after one sample");
  const Sample second = generate(w.state, kHJob, "p-2", "What is the capital of Peru?");
  hClientExpect(ctx, second, "rejected", "budget");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 1, "with the budget spent the worker must not call the teacher; calls");
  hClientExpect(ctx, generate(w.state, kHJob, "p-3", "What is the capital of France?"), "duplicate");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 1, "a duplicate prompt must not call the teacher; calls");
  const long long sampled = hClientCount(ctx, config::progress_key(kHJob), "sampled");
  const long long accepted = hClientCount(ctx, config::progress_key(kHJob), "accepted");
  const long long rejected = hClientCount(ctx, config::progress_key(kHJob), "rejected");
  ctx.Assert(sampled == 2 && sampled == accepted + rejected, "after a run sampled must equal accepted + rejected: %v", ctx.Redis.HGetAll(config::progress_key(kHJob)));
  ctx.Assert(hClientCount(ctx, config::progress_key(kHJob), "duplicate") == 1 && hClientCount(ctx, config::reasons_key(kHJob), "budget") == 1, "the duplicate and the budget refusal are counted: %v, %v", ctx.Redis.HGetAll(config::progress_key(kHJob)), ctx.Redis.HGetAll(config::reasons_key(kHJob)));
}
`,
  },
  debrief: `The loop's shape comes from sorting what the teacher can say into three kinds. A transient status (\`UNAVAILABLE\`) is worth a bounded retry; a terminal one (\`DEADLINE_EXCEEDED\`, anything else) is recorded and left alone; a refusal or an empty completion is not a failure at all but data with a reason, which is why it goes to the counters and not back to the teacher. The deadline belongs on the call, because a sleep around the call still waits for the reply. Reserving first closes the loop with step 2: the budget is drawn once, before the money is spent, so a retry storm cannot overspend. Production pipelines add a circuit breaker per teacher endpoint, hedge a slow request against a second replica, and separate the deadline for the first token from the one for the whole completion.`,
};
