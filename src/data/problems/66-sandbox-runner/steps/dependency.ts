import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Container calls with isolation checks before use',
  concept: 'grpc',
  file: 'client',
  focus: ['runner', 'container', 'sandbox'],
  task: `## Task

The starter is a plausible model-generated draft: when the container service is healthy and fast the
job starts, so the demo works. Every failure path weakens the boundary. Find them, fix them, and
prove the fix.

Implement \`start_container(job_id, image, requested_profile)\`, the runner’s gRPC client for the
container service:

- Every attempt carries a **30-second deadline** (\`START_DEADLINE_S\` / \`StartDeadlineMs\`) on the
  call itself. Without one, a wedged container service holds the runner forever.
- The container service reports the **isolation profile it actually used**. If that profile ranks
  below the requested one, the runner **kills the container and aborts** the job: a downgrade is a
  boundary failure, not a detail. The draft trusts the profile the container echoes.
- An **image rejection** (\`FAILED_PRECONDITION\` / \`INVALID_ARGUMENT\`) is **terminal**: it will
  never succeed, so it is returned to the caller immediately instead of being retried five times.
- A **start timeout** (\`DEADLINE_EXCEEDED\`) **aborts the job**. It must never fall back to running
  the code under the default, weaker profile — a slow start is not permission to weaken isolation.
- At most **2 attempts** (\`MAX_ATTEMPTS\`), and only \`UNAVAILABLE\` is retryable; everything else
  returns immediately.

**Failure mode the checks target.** Trusting the echoed profile means a misconfigured node silently
downgrades every job; retrying a rejected image burns the container service on a request that cannot
succeed; and "the start timed out, so run it anyway" is precisely how a sandboxed job ends up on the
host with the network. Each is invisible until the pod it runs on cannot be trusted.`,
  sequence: {
    participants: ['Runner', 'Container service', 'Sandbox node'],
    messages: [
      {
        from: 'Runner',
        to: 'Container service',
        label: 'Start(job, image, profile) · deadline 30 s · attempt ≤ 2',
        kind: 'sync',
      },
      {from: 'Container service', to: 'Runner', label: 'FAILED_PRECONDITION on an unknown image', kind: 'reply'},
      {from: 'Runner', to: 'Runner', label: 'rejection is terminal — no third attempt', kind: 'sync'},
      {from: 'Container service', to: 'Runner', label: 'StartReply{handle, profile: runc}', kind: 'reply'},
      {from: 'Runner', to: 'Runner', label: 'rank(runc) < rank(gvisor) → abort the job', kind: 'sync'},
      {from: 'Runner', to: 'Container service', label: 'Kill(job) after a downgraded start', kind: 'sync'},
      {from: 'Runner', to: 'Runner', label: 'DEADLINE_EXCEEDED → fail, never run weaker', kind: 'sync'},
    ],
  },
  hints: [
    'The deadline belongs on the call: `timeout=START_DEADLINE_S` (Python), an options object with `deadline` (TypeScript), a `context.WithTimeout` context (Go), `withDeadlineAfter` (Scala), `ctx.set_deadline(...)` (C++). Wrapping the call in a try/except changes nothing.',
    'Compare ranks, do not compare strings: `ISOLATION_RANK[used] < ISOLATION_RANK[requested]` → kill the container and raise. The container may only ever report a profile *at least as strong* as the one requested.',
    'Sort the error codes once: a rejection (`FAILED_PRECONDITION`, `INVALID_ARGUMENT`) is terminal, `DEADLINE_EXCEEDED` aborts, only `UNAVAILABLE` is retried — and only while `attempt + 1 < MAX_ATTEMPTS`. There is no branch in which a failed start continues with the default profile.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 30-second deadline',
      detail:
        '`Start` is called with a 30-second deadline on the call itself (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`). The draft calls without one, so a stuck container service pins the runner.',
      match: {
        python: {all: [/START_DEADLINE_S\s*=\s*30/, /timeout=START_DEADLINE_S/, /containers\.Start\(/]},
        typescript: {
          all: [/START_DEADLINE_MS\s*=\s*30_000/, /deadline:\s*Date\.now\(\)\s*\+\s*START_DEADLINE_MS/, /\.Start\(/],
        },
        go: {all: [/(startDeadline|30\s*\*\s*time\.Second)/, /context\.WithTimeout|WithDeadline/, /\.Start\(/]},
        scala: {all: [/StartDeadlineMs\s*=\s*30000/, /withDeadlineAfter\(/, /\.start\(/]},
        cpp: {all: [/kStartDeadlineMs\s*=\s*30000/, /set_deadline\(/, /->Start\(/]},
      },
    },
    {
      id: 'isolation-check',
      title: 'Refuses a container that reports a weaker profile',
      detail:
        'The used profile is ranked against the requested one, and a weaker result kills the container and aborts the job (`ISOLATION_RANK` + `IsolationError`). The draft returns whatever the container echoes back.',
      match: {
        python: {all: [/ISOLATION_RANK/, /IsolationError/]},
        typescript: {all: [/ISOLATION_RANK/, /IsolationError/]},
        go: {all: [/isolationRank/, /ErrIsolation/]},
        scala: {all: [/IsolationRank/, /IsolationError/]},
        cpp: {all: [/kIsolationRank/, /IsolationError/]},
      },
    },
    {
      id: 'image-terminal',
      title: 'An image rejection is terminal',
      detail:
        '`FAILED_PRECONDITION` / `INVALID_ARGUMENT` aborts the start immediately instead of being retried. The draft retries the rejection five times against a container service that will never accept the image.',
      match: {
        python: {all: [/FAILED_PRECONDITION/, /TERMINAL/, /raise IsolationError\(/]},
        typescript: {all: [/FAILED_PRECONDITION/, /INVALID_ARGUMENT/, /throw new IsolationError\(/]},
        go: {all: [/codes\.FailedPrecondition/, /return nil, ErrIsolation/]},
        scala: {all: [/FAILED_PRECONDITION/, /throw new IsolationError\(/]},
        cpp: {all: [/StatusCode::FAILED_PRECONDITION/, /throw IsolationError\(/]},
      },
    },
    {
      id: 'no-downgrade',
      title: 'A start timeout never silently weakens isolation',
      detail:
        '`DEADLINE_EXCEEDED` fails the job with an isolation error; there is no branch that reassigns the profile to the default and continues. The draft does exactly that when the start is slow.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /IsolationError/], none: [/profile\s*=\s*["']runc["']/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /IsolationError/], none: [/profile\s*=\s*['"]runc['"]/i]},
        go: {all: [/codes\.DeadlineExceeded/, /ErrIsolation/], none: [/[Pp]rofile\s*:?=\s*"runc"/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /IsolationError/], none: [/[Pp]rofile\s*=\s*"runc"/]},
        cpp: {all: [/StatusCode::DEADLINE_EXCEEDED/, /IsolationError/], none: [/profile\s*=\s*"runc"/i]},
      },
    },
    {
      id: 'bounded-retries',
      title: 'Bounds attempts and retries only UNAVAILABLE',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 2` and only `UNAVAILABLE` is retryable; there is no unbounded loop and no five-shot retry of a permanent failure. The draft loops five times on any error.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2/, /range\(MAX_ATTEMPTS\)/], none: [/while\s+True/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2/, /attempt\s*<\s*MAX_ATTEMPTS/], none: [/while\s*\(\s*true\s*\)/]},
        go: {
          all: [/maxAttempts\s*=\s*2/, /attempt\s*<\s*maxAttempts/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {all: [/MaxAttempts\s*=\s*2/, /attempt\s*<\s*MaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2/, /attempt\s*<\s*kMaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import containers_pb2 as pb
import containers_pb2_grpc as pb_grpc


class IsolationError(RuntimeError):
    """The start did not happen under the isolation we asked for."""


def start_container(job_id: str, image: str, requested_profile: str):
    # TODO: put a 30-second deadline on the call, bound the attempts, treat an image rejection as
    # terminal, fail on a start timeout instead of downgrading the profile, and refuse a container
    # whose reported isolation is weaker than the one requested.
    for attempt in range(5):
        try:
            handle = containers.Start(pb.StartRequest(job_id=job_id, image=image, profile=requested_profile))
        except grpc.RpcError:
            requested_profile = "runc"
            continue
        return handle
`,
      solution: `import grpc

import containers_pb2 as pb
import containers_pb2_grpc as pb_grpc

START_DEADLINE_S = 30.0
MAX_ATTEMPTS = 2
ISOLATION_RANK = {"runc": 1, "gvisor": 2, "kata": 3}
TERMINAL = {grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.INVALID_ARGUMENT}


class IsolationError(RuntimeError):
    """The start did not happen under the isolation we asked for."""


def start_container(job_id: str, image: str, requested_profile: str):
    for attempt in range(MAX_ATTEMPTS):
        try:
            handle = containers.Start(
                pb.StartRequest(job_id=job_id, image=image, profile=requested_profile),
                timeout=START_DEADLINE_S,
            )
        except grpc.RpcError as err:
            code = err.code()
            if code in TERMINAL:
                raise IsolationError(f"the container service rejected the image: {code}")
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                # A slow start is not permission to run weaker: abort instead of downgrading.
                raise IsolationError("start timed out before the isolation was confirmed")
            if code == grpc.StatusCode.UNAVAILABLE and attempt + 1 < MAX_ATTEMPTS:
                continue
            raise IsolationError(f"container start failed: {code}")
        if ISOLATION_RANK[handle.profile] < ISOLATION_RANK[requested_profile]:
            containers.Kill(pb.KillRequest(job_id=job_id))
            raise IsolationError(f"container downgraded {requested_profile} to {handle.profile}")
        return handle
    raise IsolationError("container start gave up")
`,
    },
    typescript: {
      starter: `/** Start a container: a model-generated draft that trusts the profile the container echoes. */
import {status} from '@grpc/grpc-js';

class IsolationError extends Error {}

async function startContainer(
  jobId: string,
  image: string,
  requestedProfile: string,
): Promise<{handleId: string; profile: string}> {
  // TODO: put a 30-second deadline on the call, bound the attempts, treat an image rejection as
  // terminal, fail on a start timeout instead of downgrading the profile, and refuse a container
  // whose reported isolation is weaker than the one requested.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await containerService.Start({jobId, image, profile: requestedProfile});
    } catch {
      requestedProfile = 'runc';
      continue;
    }
  }
  throw new IsolationError('container start failed');
}

void status;
`,
      solution: `/** Start a container: 30-second deadline, a bounded retry, and an isolation check before use. */
import {status} from '@grpc/grpc-js';

const START_DEADLINE_MS = 30_000;
const MAX_ATTEMPTS = 2;
const ISOLATION_RANK: Record<string, number> = {runc: 1, gvisor: 2, kata: 3};

class IsolationError extends Error {}

async function startContainer(
  jobId: string,
  image: string,
  requestedProfile: string,
): Promise<{handleId: string; profile: string}> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let handle: {handleId: string; profile: string};
    try {
      handle = await containerService.Start(
        {jobId, image, profile: requestedProfile},
        {deadline: Date.now() + START_DEADLINE_MS},
      );
    } catch (error) {
      const code = (error as {code?: number}).code;
      if (code === status.FAILED_PRECONDITION || code === status.INVALID_ARGUMENT)
        throw new IsolationError('the container service rejected the image');
      if (code === status.DEADLINE_EXCEEDED)
        throw new IsolationError('start timed out; refusing to run under a weaker isolation');
      if (code === status.UNAVAILABLE && attempt + 1 < MAX_ATTEMPTS) continue;
      throw new IsolationError('container start failed');
    }
    if (ISOLATION_RANK[handle.profile] < ISOLATION_RANK[requestedProfile]) {
      await containerService.Kill({jobId});
      throw new IsolationError(\`container downgraded \${requestedProfile} to \${handle.profile}\`);
    }
    return handle;
  }
  throw new IsolationError('container start gave up');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "sandbox/containerspb"
)

var ErrIsolation = errIsolation("container start did not confirm the requested isolation")

type errIsolation string

func (e errIsolation) Error() string { return string(e) }

func startContainer(ctx context.Context, jobID, image, requestedProfile string) (*pb.StartReply, error) {
	// TODO: put a 30-second deadline on the call, bound the attempts, treat an image rejection as
	// terminal, fail on a start timeout instead of downgrading the profile, and refuse a container
	// whose reported isolation is weaker than the one requested.
	for attempt := 0; attempt < 5; attempt++ {
		handle, err := containers.Start(ctx, &pb.StartRequest{JobId: jobID, Image: image, Profile: requestedProfile})
		if err != nil {
			requestedProfile = "runc"
			continue
		}
		return handle, nil
	}
	return nil, ErrIsolation
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	pb "sandbox/containerspb"
)

const (
	startDeadline = 30 * time.Second
	maxAttempts   = 2
)

var (
	ErrIsolation  = errIsolation("container start did not confirm the requested isolation")
	isolationRank = map[string]int{"runc": 1, "gvisor": 2, "kata": 3}
)

type errIsolation string

func (e errIsolation) Error() string { return string(e) }

func startContainer(ctx context.Context, jobID, image, requestedProfile string) (*pb.StartReply, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, startDeadline)
		handle, err := containers.Start(callCtx, &pb.StartRequest{JobId: jobID, Image: image, Profile: requestedProfile})
		cancel()
		if err != nil {
			switch status.Code(err) {
			case codes.FailedPrecondition, codes.InvalidArgument:
				return nil, ErrIsolation
			case codes.DeadlineExceeded:
				// A slow start is not permission to run weaker: abort instead of downgrading.
				return nil, ErrIsolation
			case codes.Unavailable:
				if attempt+1 < maxAttempts {
					continue
				}
			}
			return nil, ErrIsolation
		}
		if isolationRank[handle.Profile] < isolationRank[requestedProfile] {
			_, _ = containers.Kill(ctx, &pb.KillRequest{JobId: jobID})
			return nil, ErrIsolation
		}
		return handle, nil
	}
	return nil, ErrIsolation
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

object ContainerClient {
  class IsolationError(message: String) extends RuntimeException(message)

  def startContainer(jobId: String, image: String, requestedProfile: String): ContainerHandle = {
    var profile = requestedProfile
    var attempt = 0
    // TODO: put a 30-second deadline on the call, bound the attempts, treat an image rejection as
    // terminal, fail on a start timeout instead of downgrading the profile, and refuse a container
    // whose reported isolation is weaker than the one requested.
    while (attempt < 5) {
      try {
        return containers.start(StartRequest(jobId, image, profile))
      } catch {
        case _: StatusRuntimeException =>
          profile = "runc"
          attempt += 1
      }
    }
    throw new IsolationError("container start failed")
  }
}
`,
      solution: `import io.grpc.Status
import io.grpc.StatusRuntimeException

import java.util.concurrent.TimeUnit

object ContainerClient {
  class IsolationError(message: String) extends RuntimeException(message)

  val StartDeadlineMs = 30000L
  val MaxAttempts = 2
  val IsolationRank = Map("runc" -> 1, "gvisor" -> 2, "kata" -> 3)

  def startContainer(jobId: String, image: String, requestedProfile: String): ContainerHandle = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val handle = containers
          .withDeadlineAfter(StartDeadlineMs, TimeUnit.MILLISECONDS)
          .start(StartRequest(jobId = jobId, image = image, profile = requestedProfile))
        if (IsolationRank(handle.profile) < IsolationRank(requestedProfile)) {
          containers.kill(jobId)
          throw new IsolationError(s"container downgraded $requestedProfile to \${handle.profile}")
        }
        return handle
      } catch {
        case err: StatusRuntimeException =>
          err.getStatus.getCode match {
            case Status.Code.FAILED_PRECONDITION | Status.Code.INVALID_ARGUMENT =>
              throw new IsolationError("the container service rejected the image")
            case Status.Code.DEADLINE_EXCEEDED =>
              // a slow start is not permission to run weaker: fail the job instead
              throw new IsolationError("start timed out; refusing to run under a weaker isolation")
            case Status.Code.UNAVAILABLE if attempt + 1 < MaxAttempts =>
              attempt += 1
            case _ =>
              throw new IsolationError(s"container start failed: \${err.getStatus}")
          }
      }
    }
    throw new IsolationError("container start gave up")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <memory>
#include <string>

#include "containers.grpc.pb.h"

struct IsolationError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::unique_ptr<ContainerService::Stub> containers;

std::unique_ptr<ContainerHandle> startContainer(
    const std::string& jobId,
    const std::string& image,
    std::string requestedProfile) {
  // TODO: put a 30-second deadline on the call, bound the attempts, treat an image rejection as
  // terminal, fail on a start timeout instead of downgrading the profile, and refuse a container
  // whose reported isolation is weaker than the one requested.
  for (int attempt = 0; attempt < 5; ++attempt) {
    grpc::ClientContext ctx;
    StartRequest request;
    request.set_job_id(jobId);
    request.set_image(image);
    request.set_profile(requestedProfile);
    StartReply reply;
    if (!containers->Start(&ctx, request, &reply).ok()) {
      requestedProfile = "runc";
      continue;
    }
    return std::make_unique<ContainerHandle>(reply.handle_id(), reply.profile());
  }
  throw IsolationError("container start failed");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>

#include "containers.grpc.pb.h"

constexpr long long kStartDeadlineMs = 30000;
constexpr int kMaxAttempts = 2;
const std::map<std::string, int> kIsolationRank = {{"runc", 1}, {"gvisor", 2}, {"kata", 3}};

struct IsolationError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::unique_ptr<ContainerService::Stub> containers;

std::unique_ptr<ContainerHandle> startContainer(
    const std::string& jobId,
    const std::string& image,
    const std::string& requestedProfile) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kStartDeadlineMs));
    StartRequest request;
    request.set_job_id(jobId);
    request.set_image(image);
    request.set_profile(requestedProfile);
    StartReply reply;
    const grpc::Status outcome = containers->Start(&ctx, request, &reply);
    if (!outcome.ok()) {
      switch (outcome.error_code()) {
        case grpc::StatusCode::FAILED_PRECONDITION:
        case grpc::StatusCode::INVALID_ARGUMENT:
          throw IsolationError("the container service rejected the image");
        case grpc::StatusCode::DEADLINE_EXCEEDED:
          // A slow start is not permission to run weaker: abort instead of downgrading.
          throw IsolationError("start timed out; refusing to run under a weaker isolation");
        case grpc::StatusCode::UNAVAILABLE:
          if (attempt + 1 < kMaxAttempts) continue;
          break;
        default:
          break;
      }
      throw IsolationError("container start failed");
    }
    if (kIsolationRank.at(reply.profile()) < kIsolationRank.at(requestedProfile)) {
      grpc::ClientContext killCtx;
      KillRequest kill;
      kill.set_job_id(jobId);
      containers->Kill(&killCtx, kill, nullptr);
      throw IsolationError("container downgraded " + requestedProfile + " to " + reply.profile());
    }
    return std::make_unique<ContainerHandle>(reply.handle_id(), reply.profile());
  }
  throw IsolationError("container start gave up");
}
`,
    },
  },
  debrief: `The question here is "who decides how strong the isolation is?" The caller asks for a profile,
the scheduler picks a node, and the container service reports what it actually started — and the
runner is the last place that can refuse a downgrade. Trusting the echoed profile converts a
misconfigured node into a silent boundary failure across every job it runs, which is why the check
is a *rank* comparison, not a string comparison, and why the downgrade path kills the container
before it does anything else. The error taxonomy is the second half: a rejected image is permanent,
a timeout is a failed start, and only an unavailable service is worth a second attempt. The
temptation is the timeout branch — "the start was slow, so run it with the default profile" — and
that single line is the difference between a hard boundary and a suggestion. Real platforms add
image allowlists and signature checks, node taints per profile, and a probe that verifies the
sandbox properties from inside the container before the job's code is invoked.`,
};
