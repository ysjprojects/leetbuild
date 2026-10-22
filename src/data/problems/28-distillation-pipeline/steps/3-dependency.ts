import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Teacher generation with retries that respect the budget',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'teacher'],
  task: `## Task

The starter is a plausible model-generated draft: it calls the teacher, skips outputs it cannot use,
and keeps trying until something comes back. It works against a healthy teacher and falls apart
against a real one. Three flaws, one deadline, one retry policy, one budget check.

Implement the generation call the worker makes for every sample, over the teacher's gRPC service.

- Every attempt carries a **four-second deadline** (\`DEADLINE_S\`). A teacher that accepts the
  connection and then hangs must not pin the worker: the call is cut off, the sample is recorded as
  **\`timed_out\`** and the worker moves on.
- Only **\`UNAVAILABLE\`** is retried, at most **twice** (\`MAX_ATTEMPTS\` = 3 in total) with a short
  backoff. \`DEADLINE_EXCEEDED\` is not retried inside the same sample: the attempt already spent its
  deadline.
- A **refusal** (\`refused\`) or an **empty** completion is an outcome, not an error: record it as
  rejected with reason \`refusal\`/\`empty\` and return — never retry it. Retrying a refusal is asking
  the same question until the answer hurts.
- Each attempt draws from the job's budget: before the call, ask the state whether the attempt is
  affordable (\`can_spend\`/\`CanSpend\`) and stop with reason \`budget\` when it is not, so retries
  cannot push the job's spend negative.
- Return the attempt count with the outcome, and only ever record **one** outcome per sample.

**Failure mode the checks target.** A retry loop with no deadline is the one that takes the shard
down: one hung stream holds a worker until its global wall clock expires, and every other sample in
that shard waits behind it. The refusal case is the subtler one — a teacher that safely refuses 30
percent of a dataset turns into a retry storm that burns the budget on prompts it will never answer,
which is why a refusal has to be *recorded*, not retried.`,
  sequence: {
    participants: ['Worker', 'Job state', 'Teacher'],
    messages: [
      {from: 'Worker', to: 'Job state', label: 'can_spend(prompt_id) · budget left?', kind: 'sync'},
      {from: 'Job state', to: 'Worker', label: 'yes / no', kind: 'reply'},
      {from: 'Worker', to: 'Teacher', label: 'Generate · deadline = 4 s', kind: 'sync'},
      {from: 'Teacher', to: 'Worker', label: 'reply / refused / empty', kind: 'reply'},
      {from: 'Worker', to: 'Teacher', label: 'retry on UNAVAILABLE · max 2', kind: 'sync'},
      {from: 'Worker', to: 'Job state', label: 'record(sampled, accepted|rejected + reason)', kind: 'async'},
    ],
  },
  hints: [
    'A deadline is per attempt, not per sample and not per shard: set a 4-second timeout on each call so one hung stream costs four seconds and one recorded `timed_out`, never a stalled worker. Languages spell it differently (`timeout=`, `deadline: Date.now() + …`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) but it is the same contract.',
    'Sort the failures before you write the loop: `UNAVAILABLE` is retryable and bounded, `DEADLINE_EXCEEDED` is terminal for that sample, everything else is terminal too. A refusal or an empty completion is not a failure at all — it is data with a reason, and it belongs in the counters, not in the retry path.',
    'The budget check closes the loop with step 2: ask whether the attempt is affordable before you make it (`can_spend`), and return `budget` when it is not. Otherwise a retry storm is just a slower way to overspend the job.',
  ],
  checks: [
    {
      id: 'attempt-deadline',
      title: 'Four-second deadline on every attempt',
      detail:
        'Each attempt carries its own four-second deadline (`DEADLINE_S` passed as `timeout=`, a JS `deadline: Date.now() + DEADLINE_MS`, a `context.WithTimeout`, `withDeadlineAfter`, or `set_deadline`). The draft has no per-call deadline, so a hung teacher holds the worker.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineMS/, /WithTimeout/]},
        scala: {all: [/DeadlineMs/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries only UNAVAILABLE, at most twice',
      detail:
        'Only `UNAVAILABLE` is retried, bounded by `MAX_ATTEMPTS` (three attempts, two retries) with a backoff between them. The draft retries whatever comes back until its wall clock expires.',
      match: {
        python: {all: [/grpc\.StatusCode\.UNAVAILABLE/, /MAX_ATTEMPTS/]},
        typescript: {all: [/status\.UNAVAILABLE/, /MAX_ATTEMPTS/]},
        go: {all: [/codes\.Unavailable/, /maxAttempts/]},
        scala: {all: [/Status\.UNAVAILABLE/, /MaxAttempts/]},
        cpp: {all: [/grpc::StatusCode::UNAVAILABLE/, /kMaxAttempts/]},
      },
    },
    {
      id: 'refusal-recorded',
      title: 'Records a refusal or an empty output instead of retrying it',
      detail:
        'A refusal or an empty completion returns a **rejected** sample with its reason (`refusal`/`empty`) and the attempt count — it is never retried. The draft retries it, so a teacher that refuses a prompt burns the job’s budget on answers it will never give.',
      match: {
        python: {all: [/refus/i, /reject/i, /reason/i]},
        typescript: {all: [/refus/i, /reject/i, /reason/i]},
        go: {all: [/refus/i, /reject/i, /Reason/]},
        scala: {all: [/refus/i, /reject/i, /reason/i]},
        cpp: {all: [/refus/i, /reject/i, /reason/i]},
      },
    },
    {
      id: 'hung-call-cut',
      title: 'Marks a hung call timed out',
      detail:
        'A call that runs past its deadline comes back as `DEADLINE_EXCEEDED` and the sample is recorded as `timed_out` with reason `deadline` — not retried inside the same sample. The draft swallows the error and loops.',
      match: {
        python: {all: [/grpc\.StatusCode\.DEADLINE_EXCEEDED/, /timed_out/]},
        typescript: {all: [/status\.DEADLINE_EXCEEDED/, /timed_out/]},
        go: {all: [/codes\.DeadlineExceeded/, /timed_out/]},
        scala: {all: [/Status\.DEADLINE_EXCEEDED/, /timed_out/]},
        cpp: {all: [/grpc::StatusCode::DEADLINE_EXCEEDED/, /timed_out/]},
      },
    },
    {
      id: 'budget-before-call',
      title: 'Checks the budget before each attempt',
      detail:
        'Every attempt asks the job state whether it is affordable (`can_spend`) **before** the teacher call, and stops with reason `budget` when it is not. The draft never consults the budget, so its retries can spend past the cap.',
      match: {
        python: {order: [/can_spend\(/, /stub\.Generate\(/]},
        typescript: {order: [/canSpend\(/, /generateAsync\(/]},
        go: {order: [/CanSpend\(/, /\.Generate\(/]},
        scala: {order: [/canSpend\(/, /\.generate\(/]},
        cpp: {order: [/can_spend\(/, /Generate\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

MAX_SHARD_SECONDS = 30


def generate(stub, job_id: str, prompt_id: str, prompt: str) -> dict:
    # TODO: this draft has no per-attempt deadline, retries a refusal or an empty completion until
    # the shard's wall clock runs out, and never asks whether the job still has budget. Review all
    # three: a teacher that refuses one prompt can hold a worker for half a minute.
    deadline = time.monotonic() + MAX_SHARD_SECONDS
    while time.monotonic() < deadline:
        try:
            reply = stub.Generate(
                GenerateRequest(job_id=job_id, prompt_id=prompt_id, prompt=prompt)
            )
        except grpc.RpcError:
            continue
        if reply.refused or reply.text == "":
            continue
        return {"status": "accepted", "text": reply.text, "teacher_version": reply.teacher_version}
    return {"status": "accepted", "text": ""}
`,
      solution: `import logging
import time

import grpc

logger = logging.getLogger("distill.teacher")

DEADLINE_S = 4.0
MAX_ATTEMPTS = 3
BACKOFF_S = 0.25


def generate(stub, state, job_id: str, prompt_id: str, prompt: str) -> dict:
    """One teacher sample: a bounded retry loop that respects the deadline and the job's budget."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if not state.can_spend(prompt_id):
            return {"status": "rejected", "reason": "budget", "attempts": attempt}
        try:
            reply = stub.Generate(
                GenerateRequest(job_id=job_id, prompt_id=prompt_id, prompt=prompt),
                timeout=DEADLINE_S,
                metadata=(("x-distill-attempt", str(attempt)),),
            )
        except grpc.RpcError as err:
            code = err.code()
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                return {"status": "timed_out", "reason": "deadline", "attempts": attempt}
            if code == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                continue
            return {"status": "rejected", "reason": code.name.lower(), "attempts": attempt}
        if reply.refused or reply.text == "":
            reason = "refusal" if reply.refused else "empty"
            return {"status": "rejected", "reason": reason, "attempts": attempt}
        return {
            "status": "accepted",
            "text": reply.text,
            "teacher_version": reply.teacher_version,
            "attempts": attempt,
        }
    return {"status": "rejected", "reason": "unavailable", "attempts": MAX_ATTEMPTS}
`,
    },
    typescript: {
      starter: `/** Teacher generation: a model-generated draft that retries until its wall clock expires. */
import type {Client, ServiceError} from '@grpc/grpc-js';
import {promisify} from 'node:util';

const MAX_SHARD_SECONDS = 30;

export interface GenerateReply {
  text: string;
  refused: boolean;
  teacher_version: string;
}

export interface Sample {
  status: string;
  text?: string;
  teacher_version?: string;
  reason?: string;
  attempts: number;
}

export async function generate(stub: Client, jobId: string, promptId: string, prompt: string): Promise<Sample> {
  // TODO: this draft has no per-attempt deadline, retries a refusal or an empty completion until the
  // shard's wall clock runs out, and never asks whether the job still has budget. Review all three.
  const generateAsync = promisify(stub.generate.bind(stub)) as (request: {
    job_id: string;
    prompt_id: string;
    prompt: string;
  }) => Promise<GenerateReply>;
  const until = Date.now() + MAX_SHARD_SECONDS * 1000;
  while (Date.now() < until) {
    try {
      const reply = await generateAsync({job_id: jobId, prompt_id: promptId, prompt});
      if (reply.refused || reply.text === '') continue;
      return {status: 'accepted', text: reply.text, teacher_version: reply.teacher_version, attempts: 1};
    } catch (err) {
      void (err as ServiceError);
      continue;
    }
  }
  return {status: 'accepted', text: '', attempts: 1};
}
`,
      solution: `/** Teacher generation: one deadline per attempt, bounded retries, refusals recorded. */
import {type Client, type ServiceError, status} from '@grpc/grpc-js';
import {promisify} from 'node:util';

const DEADLINE_MS = 4_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 250;

export interface GenerateReply {
  text: string;
  refused: boolean;
  teacher_version: string;
}

export interface Sample {
  status: 'accepted' | 'rejected' | 'timed_out';
  text?: string;
  teacher_version?: string;
  reason?: string;
  attempts: number;
}

export async function generate(
  stub: Client,
  state: {canSpend(promptId: string): Promise<boolean>},
  jobId: string,
  promptId: string,
  prompt: string,
): Promise<Sample> {
  const generateAsync = promisify(stub.generate.bind(stub)) as (
    request: {job_id: string; prompt_id: string; prompt: string},
    options: {deadline: number},
  ) => Promise<GenerateReply>;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (!(await state.canSpend(promptId))) return {status: 'rejected', reason: 'budget', attempts: attempt};
    try {
      const reply = await generateAsync(
        {job_id: jobId, prompt_id: promptId, prompt},
        {deadline: Date.now() + DEADLINE_MS},
      );
      if (reply.refused || reply.text === '') {
        const reason = reply.refused ? 'refusal' : 'empty';
        return {status: 'rejected', reason, attempts: attempt};
      }
      return {status: 'accepted', text: reply.text, teacher_version: reply.teacher_version, attempts: attempt};
    } catch (err) {
      const code = (err as ServiceError).code;
      if (code === status.DEADLINE_EXCEEDED) return {status: 'timed_out', reason: 'deadline', attempts: attempt};
      if (code === status.UNAVAILABLE && attempt < MAX_ATTEMPTS) {
        const backoff = Promise.withResolvers<void>();
        setTimeout(backoff.resolve, BACKOFF_MS * attempt);
        await backoff.promise;
        continue;
      }
      return {status: 'rejected', reason: String(code), attempts: attempt};
    }
  }
  return {status: 'rejected', reason: 'unavailable', attempts: MAX_ATTEMPTS};
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"time"
)

const maxShardSeconds = 30

type Sample struct {
	Status         string
	Text           string
	TeacherVersion string
}

func Generate(ctx context.Context, stub TeacherClient, jobID, promptID, prompt string) (Sample, error) {
	// TODO: this draft has no per-attempt deadline, retries a refusal or an empty completion until
	// the shard's wall clock runs out, and never asks whether the job still has budget. Review all
	// three: a teacher that refuses one prompt can hold a worker for half a minute.
	until := time.Now().Add(maxShardSeconds * time.Second)
	for time.Now().Before(until) {
		reply, err := stub.Generate(ctx, &GenerateRequest{JobId: jobID, PromptId: promptID, Prompt: prompt})
		if err != nil {
			continue
		}
		if reply.Refused || reply.Text == "" {
			continue
		}
		return Sample{Status: "accepted", Text: reply.Text, TeacherVersion: reply.TeacherVersion}, nil
	}
	return Sample{Status: "accepted"}, nil
}
`,
      solution: `package client

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS  = 4000
	maxAttempts = 3
	backoffMS   = 250
)

type Sample struct {
	Status         string
	Text           string
	TeacherVersion string
	Reason         string
	Attempts       int
}

// Generate runs one teacher sample: at most maxAttempts attempts, each under its own deadline.
func Generate(ctx context.Context, stub TeacherClient, state *JobState, jobID, promptID, prompt string) (Sample, error) {
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if !state.CanSpend(promptID) {
			return Sample{Status: "rejected", Reason: "budget", Attempts: attempt}, nil
		}
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := stub.Generate(callCtx, &GenerateRequest{JobId: jobID, PromptId: promptID, Prompt: prompt})
		cancel()
		if err != nil {
			switch status.Code(err) {
			case codes.DeadlineExceeded:
				return Sample{Status: "timed_out", Reason: "deadline", Attempts: attempt}, nil
			case codes.Unavailable:
				if attempt < maxAttempts {
					time.Sleep(backoffMS * time.Duration(attempt) * time.Millisecond)
					continue
				}
			}
			return Sample{Status: "rejected", Reason: status.Code(err).String(), Attempts: attempt}, nil
		}
		if reply.Refused || reply.Text == "" {
			reason := "empty"
			if reply.Refused {
				reason = "refusal"
			}
			return Sample{Status: "rejected", Reason: reason, Attempts: attempt}, nil
		}
		return Sample{Status: "accepted", Text: reply.Text, TeacherVersion: reply.TeacherVersion, Attempts: attempt}, nil
	}
	return Sample{Status: "rejected", Reason: status.Code(context.DeadlineExceeded).String(), Attempts: maxAttempts}, nil
}
`,
    },
    scala: {
      starter: `import java.time.Instant

import io.grpc.StatusRuntimeException

object TeacherClient {
  val MaxShardSeconds = 30L

  final case class Sample(
      status: String,
      text: String = "",
      teacherVersion: String = "",
      reason: String = "none",
      attempts: Int = 0
  )

  def generate(
      stub: TeacherServiceGrpc.TeacherServiceBlockingStub,
      jobId: String,
      promptId: String,
      prompt: String
  ): Sample = {
    // TODO: this draft has no per-attempt deadline, retries a refusal or an empty completion until
    // the shard's wall clock runs out, and never asks whether the job still has budget. Review all
    // three: a teacher that refuses one prompt can hold a worker for half a minute.
    val until = Instant.now().plusSeconds(MaxShardSeconds)
    while (Instant.now().isBefore(until)) {
      try {
        val reply = stub.generate(GenerateRequest(jobId, promptId, prompt))
        if (reply.refused || reply.text.isEmpty) {
          // keep asking
        } else {
          return Sample("accepted", text = reply.text, teacherVersion = reply.teacherVersion)
        }
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    Sample("accepted")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object TeacherClient {
  val DeadlineMs = 4000L
  val MaxAttempts = 3
  val BackoffMs = 250L

  final case class Sample(
      status: String,
      text: String = "",
      teacherVersion: String = "",
      reason: String = "none",
      attempts: Int = 0
  )

  def generate(
      stub: TeacherServiceGrpc.TeacherServiceBlockingStub,
      state: JobState,
      jobId: String,
      promptId: String,
      prompt: String
  ): Sample = {
    var attempt = 1
    while (attempt <= MaxAttempts) {
      if (!state.canSpend(promptId)) return Sample("rejected", reason = "budget", attempts = attempt)
      try {
        val reply = stub
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .generate(GenerateRequest(jobId, promptId, prompt))
        if (reply.refused) return Sample("rejected", reason = "refusal", attempts = attempt)
        if (reply.text.isEmpty) return Sample("rejected", reason = "empty", attempts = attempt)
        return Sample("accepted", text = reply.text, teacherVersion = reply.teacherVersion, attempts = attempt)
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.DEADLINE_EXCEEDED =>
          return Sample("timed_out", reason = "deadline", attempts = attempt)
        case e: StatusRuntimeException if e.getStatus.getCode == Status.UNAVAILABLE && attempt < MaxAttempts =>
          Thread.sleep(BackoffMs * attempt)
        case e: StatusRuntimeException =>
          return Sample("rejected", reason = e.getStatus.getCode.toString.toLowerCase, attempts = attempt)
      }
      attempt += 1
    }
    Sample("rejected", reason = "unavailable", attempts = MaxAttempts)
  }
}
`,
    },
    cpp: {
      starter: `#include "teacher.grpc.pb.h"

#include <chrono>
#include <string>

constexpr int kMaxShardSeconds = 30;

struct Sample {
  std::string status;
  std::string text;
  std::string teacher_version;
  std::string reason;
  int attempts;
};

Sample generate(teacher::Teacher::Stub& stub, const std::string& jobId, const std::string& promptId,
                const std::string& prompt) {
  // TODO: this draft has no per-attempt deadline, retries a refusal or an empty completion until the
  // shard's wall clock runs out, and never asks whether the job still has budget. Review all three:
  // a teacher that refuses one prompt can hold a worker for half a minute.
  const auto until = std::chrono::system_clock::now() + std::chrono::seconds(kMaxShardSeconds);
  while (std::chrono::system_clock::now() < until) {
    teacher::GenerateRequest request;
    request.set_job_id(jobId);
    request.set_prompt_id(promptId);
    request.set_prompt(prompt);
    teacher::GenerateReply reply;
    grpc::ClientContext ctx;
    if (!stub.Generate(&ctx, request, &reply).ok()) continue;
    if (reply.refused() || reply.text().empty()) continue;
    return {"accepted", reply.text(), reply.teacher_version(), "none", 1};
  }
  return {"accepted", "", "", "none", 1};
}
`,
      solution: `#include "teacher.grpc.pb.h"

#include <chrono>
#include <string>
#include <thread>

constexpr int kDeadlineMs = 4000;
constexpr int kMaxAttempts = 3;
constexpr int kBackoffMs = 250;

struct Sample {
  std::string status;
  std::string text;
  std::string teacher_version;
  std::string reason;
  int attempts;
};

// One teacher sample: an attempt is bounded by its own deadline and by the job's budget.
Sample generate(teacher::Teacher::Stub& stub, const JobState& state, const std::string& jobId,
                const std::string& promptId, const std::string& prompt) {
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    if (!state.can_spend(promptId)) return {"rejected", "", "", "budget", attempt};
    teacher::GenerateRequest request;
    request.set_job_id(jobId);
    request.set_prompt_id(promptId);
    request.set_prompt(prompt);
    teacher::GenerateReply reply;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    const grpc::Status result = stub.Generate(&ctx, request, &reply);
    if (!result.ok()) {
      if (result.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
        return {"timed_out", "", "", "deadline", attempt};
      }
      if (result.error_code() == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) {
        std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffMs * attempt));
        continue;
      }
      return {"rejected", "", "", "unavailable", attempt};
    }
    if (reply.refused()) return {"rejected", "", "", "refusal", attempt};
    if (reply.text().empty()) return {"rejected", "", "", "empty", attempt};
    return {"accepted", reply.text(), reply.teacher_version(), "none", attempt};
  }
  return {"rejected", "", "", "unavailable", kMaxAttempts};
}
`,
    },
  },
  debrief: `This step is where an interviewer sees whether you can tell a transient failure from an answer. The draft is generous — it keeps trying and never gives up — and that generosity is the bug: retrying a refusal, retrying past the deadline, and retrying someone else's budget. The four contracts to say out loud are a per-attempt deadline, a bounded retry policy over the retryable status codes only, a budget check before every attempt, and a recorded outcome (with reason and attempt count) for every sample. Real pipelines add a circuit breaker per teacher endpoint, hedged requests to a second replica, and separate deadlines for the first token and the whole completion.`,
};
