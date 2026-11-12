import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Container calls with isolation checks before use',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['runner', 'container', 'sandbox'],
  task: `## Task

**Starting point.** The starter is \`start_container(job_id, image, profile)\`, the runner's call to
the container service (\`Containers.Start\` in \`sandbox_containers.proto\`): it tries \`Start\` up to
five times with no deadline, switches the request to \`runc\` after any error, and returns
\`{container_id, profile}\` as the node reported it. It serves the demo and hides four flaws.

**Failure mode the checks target.** A wedged node pins the runner; an image the node refuses is
retried; a flaky node gets model-authored code to run under the weakest profile; a node that started
\`runc\` when \`gvisor\` was asked for is accepted as if nothing happened.

- Every call carries \`START_DEADLINE_S\` (30 s) as its deadline; \`DEADLINE_EXCEEDED\` fails the job.
- Only \`UNAVAILABLE\` is retried, \`MAX_ATTEMPTS\` (2) attempts in all. Anything else
  (\`FAILED_PRECONDITION\`, \`INVALID_ARGUMENT\`: the image is refused) raises \`IsolationError\` at once.
- Every attempt asks for the profile the job asked for.
- Rank the reported profile with \`ISOLATION_RANK\` (\`runc\` < \`gvisor\` < \`kata\`): a weaker one is
  stopped with \`Containers.Kill\` and raises \`IsolationError\`; a stronger one is fine.`,
  sequence: {
    participants: ['Runner', 'Container service', 'Sandbox node'],
    messages: [
      {from: 'Runner', to: 'Container service', label: 'Start(job, image, gvisor) · deadline 30 s', kind: 'sync'},
      {from: 'Container service', to: 'Runner', label: 'UNAVAILABLE → one more attempt, same profile', kind: 'reply'},
      {
        from: 'Container service',
        to: 'Runner',
        label: 'FAILED_PRECONDITION / deadline → IsolationError',
        kind: 'reply',
      },
      {from: 'Container service', to: 'Sandbox node', label: 'run under the requested runtime', kind: 'sync'},
      {from: 'Container service', to: 'Runner', label: '{container_id, profile: runc}', kind: 'reply'},
      {from: 'Runner', to: 'Runner', label: 'ISOLATION_RANK runc < gvisor', kind: 'sync'},
      {from: 'Runner', to: 'Container service', label: 'Kill(container) · IsolationError', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Start carries a 30-second deadline',
      detail:
        'Each `Start` call is made with `START_DEADLINE_S` (30 s); a node that takes 60 s fails the job within the deadline, with one call. The starter sets no deadline, so a wedged node holds the runner for as long as it likes.',
      match: {
        python: {all: [/START_DEADLINE_S\s*=\s*30\b/, /\.Start\([\s\S]{0,200}?timeout\s*=\s*START_DEADLINE_S/]},
        typescript: {
          all: [/START_DEADLINE_MS\s*=\s*30_?000\b/, /\.Start\([\s\S]{0,200}?deadline:[^\n]*START_DEADLINE_MS/],
        },
        go: {all: [/startDeadline\s*=\s*30\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*startDeadline\)/]},
        scala: {all: [/StartDeadlineSeconds\s*=\s*30L?\b/, /withDeadlineAfter\(\s*StartDeadlineSeconds/]},
        cpp: {all: [/kStartDeadline\{30\}/, /set_deadline\([^\n]*kStartDeadline\)/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries UNAVAILABLE once and nothing else',
      detail:
        'A refused image (`FAILED_PRECONDITION`, `INVALID_ARGUMENT`) raises `IsolationError` after one call; one `UNAVAILABLE` is retried and succeeds; a node that stays unavailable gets `MAX_ATTEMPTS` (2) calls. The starter retries every error five times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /StatusCode\.UNAVAILABLE/], none: [/range\(\s*5\s*\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /status\.UNAVAILABLE/], none: [/<\s*5\b/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/], none: [/<\s*5\b/]},
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /Code\.UNAVAILABLE/], none: [/<\s*5\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /StatusCode::UNAVAILABLE/], none: [/<\s*5\b/]},
      },
    },
    {
      id: 'no-downgrade',
      title: 'Never retries under a weaker profile',
      detail:
        'Every `Start` request asks for the profile the job asked for, retries included. The starter switches the request to `runc` after an error, so a flaky node runs the code with the least isolation.',
      match: {
        python: {none: [/profile\s*=\s*["']runc["']/]},
        typescript: {none: [/profile\s*=\s*['"]runc['"]/]},
        go: {none: [/[pP]rofile\s*=\s*"runc"/]},
        scala: {none: [/withProfile\(\s*"runc"\s*\)|profile\s*=\s*"runc"/]},
        cpp: {none: [/set_profile\(\s*"runc"\s*\)/]},
      },
    },
    {
      id: 'isolation-rank',
      title: 'Kills a container that started weaker than asked',
      detail:
        'The reported profile is ranked with `ISOLATION_RANK`: `runc` where `gvisor` was asked for is stopped with `Kill` and raises `IsolationError`, while `kata` is accepted. The starter returns whatever the node started.',
      match: {
        python: {all: [/ISOLATION_RANK/], order: [/\.Start\(/, /ISOLATION_RANK/, /\.Kill\(/]},
        typescript: {all: [/ISOLATION_RANK/], order: [/\.Start\(/, /ISOLATION_RANK/, /\.Kill\(/]},
        go: {all: [/isolationRank/], order: [/containers\.Start\(/, /rankOf\(|isolationRank\[/, /containers\.Kill\(/]},
        scala: {all: [/IsolationRank/], order: [/\.start\(/, /IsolationRank/, /\.kill\(/]},
        cpp: {all: [/kIsolationRank/], order: [/->Start\(/, /rankOf\(|kIsolationRank/, /->Kill\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import sandbox_containers_pb2 as pb
import sandbox_containers_pb2_grpc as pb_grpc

containers = pb_grpc.ContainersStub(grpc.insecure_channel("containers:9000"))


class IsolationError(Exception):
    """The job cannot run with the isolation it asked for."""


def start_container(job_id: str, image: str, profile: str) -> dict:
    """Start the job's container; {container_id, profile} as the node reported it."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for attempt in range(5):
        try:
            reply = containers.Start(pb.StartRequest(job_id=job_id, image=image, profile=profile))
            return {"container_id": reply.container_id, "profile": reply.profile}
        except grpc.RpcError:
            profile = "runc"  # every node has runc
    raise IsolationError(f"no node started {job_id}")
`,
      solution: `import grpc

import sandbox_containers_pb2 as pb
import sandbox_containers_pb2_grpc as pb_grpc

START_DEADLINE_S = 30
MAX_ATTEMPTS = 2
ISOLATION_RANK = {"runc": 0, "gvisor": 1, "kata": 2}

containers = pb_grpc.ContainersStub(grpc.insecure_channel("containers:9000"))


class IsolationError(Exception):
    """The job cannot run with the isolation it asked for: it fails, it never runs weaker."""


def start_container(job_id: str, image: str, profile: str) -> dict:
    """Start the job's container; {container_id, profile} as the node reported it."""
    request = pb.StartRequest(job_id=job_id, image=image, profile=profile)  # every attempt asks for the same isolation
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = containers.Start(request, timeout=START_DEADLINE_S)
            break
        except grpc.RpcError as exc:
            # Only a node that was not there is worth a second try; a refusal or a deadline fails the job.
            if exc.code() != grpc.StatusCode.UNAVAILABLE or attempt == MAX_ATTEMPTS:
                raise IsolationError(f"start {job_id}: {exc.code().name}") from exc
    if ISOLATION_RANK.get(reply.profile, -1) < ISOLATION_RANK[profile]:
        containers.Kill(pb.KillRequest(job_id=job_id, container_id=reply.container_id), timeout=START_DEADLINE_S)
        raise IsolationError(f"asked for {profile}, the node started {reply.profile}")
    return {"container_id": reply.container_id, "profile": reply.profile}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface StartRequest {
  job_id: string;
  image: string;
  profile: string;
}

interface StartReply {
  container_id: string;
  profile: string;
}

export interface Handle {
  container_id: string;
  profile: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('sandbox_containers.proto')) as unknown as {
  sandboxd: {Containers: grpc.ServiceClientConstructor};
};
const containers = new pkg.sandboxd.Containers('containers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Start(request: StartRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<StartReply>;
};

/** The job cannot run with the isolation it asked for. */
export class IsolationError extends Error {}

/** Start the job's container; {container_id, profile} as the node reported it. */
export async function startContainer(jobId: string, image: string, profile: string): Promise<Handle> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await containers.Start({job_id: jobId, image, profile}, new grpc.Metadata(), {});
      return {container_id: reply.container_id, profile: reply.profile};
    } catch {
      profile = 'runc'; // every node has runc
    }
  }
  throw new IsolationError(\`no node started \${jobId}\`);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const START_DEADLINE_MS = 30_000;
export const MAX_ATTEMPTS = 2;
export const ISOLATION_RANK: Record<string, number> = {runc: 0, gvisor: 1, kata: 2};

interface StartRequest {
  job_id: string;
  image: string;
  profile: string;
}

interface StartReply {
  container_id: string;
  profile: string;
}

export interface Handle {
  container_id: string;
  profile: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('sandbox_containers.proto')) as unknown as {
  sandboxd: {Containers: grpc.ServiceClientConstructor};
};
const containers = new pkg.sandboxd.Containers('containers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Start(request: StartRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<StartReply>;
  Kill(request: {job_id: string; container_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<unknown>;
};

/** The job cannot run with the isolation it asked for: it fails, it never runs weaker. */
export class IsolationError extends Error {}

/** Start under the requested profile; only a node that was not there is worth a second try. */
async function start(request: StartRequest): Promise<StartReply> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await containers.Start(request, new grpc.Metadata(), {deadline: Date.now() + START_DEADLINE_MS});
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      // A refusal or a deadline fails the job; the retry asks for the same isolation.
      if (code !== grpc.status.UNAVAILABLE || attempt === MAX_ATTEMPTS) {
        throw new IsolationError(\`start \${request.job_id}: \${grpc.status[code]}\`);
      }
    }
  }
}

/** Start the job's container; {container_id, profile} as the node reported it. */
export async function startContainer(jobId: string, image: string, profile: string): Promise<Handle> {
  const reply = await start({job_id: jobId, image, profile});
  if ((ISOLATION_RANK[reply.profile] ?? -1) < ISOLATION_RANK[profile]) {
    await containers.Kill({job_id: jobId, container_id: reply.container_id}, new grpc.Metadata(), {
      deadline: Date.now() + START_DEADLINE_MS,
    });
    throw new IsolationError(\`asked for \${profile}, the node started \${reply.profile}\`);
  }
  return {container_id: reply.container_id, profile: reply.profile};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "sandbox/gen/sandbox_containers"
)

var (
	conn, _    = grpc.NewClient("containers:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	containers = pb.NewContainersClient(conn)
)

// ErrIsolation: the job cannot run with the isolation it asked for.
var ErrIsolation = errors.New("isolation unavailable")

// Handle is a started container, with the profile the node reported.
type Handle struct {
	ContainerID string
	Profile     string
}

// startContainer starts the job's container.
func startContainer(ctx context.Context, jobID, image, profile string) (*Handle, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := containers.Start(ctx, &pb.StartRequest{JobId: jobID, Image: image, Profile: profile})
		if err == nil {
			return &Handle{ContainerID: reply.GetContainerId(), Profile: reply.GetProfile()}, nil
		}
		profile = "runc" // every node has runc
	}
	return nil, fmt.Errorf("%w: no node started %s", ErrIsolation, jobID)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "sandbox/gen/sandbox_containers"
)

const (
	startDeadline = 30 * time.Second
	maxAttempts   = 2
)

var isolationRank = map[string]int{"runc": 0, "gvisor": 1, "kata": 2}

var (
	conn, _    = grpc.NewClient("containers:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	containers = pb.NewContainersClient(conn)
)

// ErrIsolation: the job cannot run with the isolation it asked for; it fails, it never runs weaker.
var ErrIsolation = errors.New("isolation unavailable")

// Handle is a started container, with the profile the node reported.
type Handle struct {
	ContainerID string
	Profile     string
}

// rankOf is the profile's isolation rank; a profile the table does not know ranks below runc.
func rankOf(profile string) int {
	if rank, known := isolationRank[profile]; known {
		return rank
	}
	return -1
}

// startContainer starts the job's container.
func startContainer(ctx context.Context, jobID, image, profile string) (*Handle, error) {
	request := &pb.StartRequest{JobId: jobID, Image: image, Profile: profile} // every attempt asks for the same isolation
	var reply *pb.StartReply
	for attempt := 1; reply == nil; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, startDeadline)
		r, err := containers.Start(callCtx, request)
		cancel()
		if err == nil {
			reply = r
			continue
		}
		// Only a node that was not there is worth a second try; a refusal or a deadline fails the job.
		if status.Code(err) != codes.Unavailable || attempt == maxAttempts {
			return nil, fmt.Errorf("%w: start %s: %v", ErrIsolation, jobID, status.Code(err))
		}
	}
	if rankOf(reply.GetProfile()) < rankOf(profile) {
		killCtx, cancel := context.WithTimeout(ctx, startDeadline)
		defer cancel()
		containers.Kill(killCtx, &pb.KillRequest{JobId: jobID, ContainerId: reply.GetContainerId()})
		return nil, fmt.Errorf("%w: asked for %s, the node started %s", ErrIsolation, profile, reply.GetProfile())
	}
	return &Handle{ContainerID: reply.GetContainerId(), Profile: reply.GetProfile()}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import sandboxd.sandbox_containers.{ContainersGrpc, StartRequest}

/** The job cannot run with the isolation it asked for. */
final class IsolationError(message: String) extends Exception(message)

object Runner {
  final case class Handle(containerId: String, profile: String)

  private val containers = ContainersGrpc.blockingStub(ManagedChannelBuilder.forAddress("containers", 9000).usePlaintext().build())

  /** Start the job's container; the handle carries the profile the node reported. */
  def startContainer(jobId: String, image: String, profile: String): Handle = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    var request = StartRequest(jobId, image, profile)
    var attempt = 0
    while (attempt < 5) {
      try {
        val reply = containers.start(request)
        return Handle(reply.containerId, reply.profile)
      } catch {
        case _: StatusRuntimeException =>
          request = request.withProfile("runc") // every node has runc
          attempt += 1
      }
    }
    throw new IsolationError(s"no node started $jobId")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import sandboxd.sandbox_containers.{ContainersGrpc, KillRequest, StartReply, StartRequest}

/** The job cannot run with the isolation it asked for: it fails, it never runs weaker. */
final class IsolationError(message: String) extends Exception(message)

object Runner {
  val StartDeadlineSeconds = 30L
  val MaxAttempts = 2
  val IsolationRank: Map[String, Int] = Map("runc" -> 0, "gvisor" -> 1, "kata" -> 2)

  final case class Handle(containerId: String, profile: String)

  private val containers = ContainersGrpc.blockingStub(ManagedChannelBuilder.forAddress("containers", 9000).usePlaintext().build())

  /** Start under the requested profile; only a node that was not there is worth a second try. */
  private def start(request: StartRequest, attempt: Int): StartReply =
    try containers.withDeadlineAfter(StartDeadlineSeconds, TimeUnit.SECONDS).start(request)
    catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE && attempt < MaxAttempts =>
        start(request, attempt + 1) // the same request: the retry asks for the same isolation
      case e: StatusRuntimeException => throw new IsolationError(s"start \${request.jobId}: \${e.getStatus.getCode}")
    }

  /** Start the job's container; the handle carries the profile the node reported. */
  def startContainer(jobId: String, image: String, profile: String): Handle = {
    val reply = start(StartRequest(jobId, image, profile), 1)
    if (IsolationRank.getOrElse(reply.profile, -1) < IsolationRank(profile)) {
      containers.withDeadlineAfter(StartDeadlineSeconds, TimeUnit.SECONDS).kill(KillRequest(jobId, reply.containerId))
      throw new IsolationError(s"asked for $profile, the node started \${reply.profile}")
    }
    Handle(reply.containerId, reply.profile)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>

#include "sandbox_containers.grpc.pb.h"

auto containers = sandboxd::Containers::NewStub(grpc::CreateChannel("containers:9000", grpc::InsecureChannelCredentials()));

// The job cannot run with the isolation it asked for.
struct IsolationError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A started container, with the profile the node reported.
struct Handle {
  std::string container_id;
  std::string profile;
};

// Start the job's container.
Handle startContainer(const std::string& job_id, const std::string& image, const std::string& profile) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  sandboxd::StartRequest request;
  request.set_job_id(job_id);
  request.set_image(image);
  request.set_profile(profile);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    sandboxd::StartReply reply;
    if (containers->Start(&ctx, request, &reply).ok()) return Handle{reply.container_id(), reply.profile()};
    request.set_profile("runc");  // every node has runc
  }
  throw IsolationError("no node started " + job_id);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <stdexcept>
#include <string>

#include "sandbox_containers.grpc.pb.h"

constexpr std::chrono::seconds kStartDeadline{30};
constexpr int kMaxAttempts = 2;
const std::map<std::string, int> kIsolationRank = {{"runc", 0}, {"gvisor", 1}, {"kata", 2}};

auto containers = sandboxd::Containers::NewStub(grpc::CreateChannel("containers:9000", grpc::InsecureChannelCredentials()));

// The job cannot run with the isolation it asked for: it fails, it never runs weaker.
struct IsolationError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// A started container, with the profile the node reported.
struct Handle {
  std::string container_id;
  std::string profile;
};

// The profile's isolation rank; a profile the table does not know ranks below runc.
int rankOf(const std::string& profile) {
  const auto it = kIsolationRank.find(profile);
  return it == kIsolationRank.end() ? -1 : it->second;
}

// Start the job's container.
Handle startContainer(const std::string& job_id, const std::string& image, const std::string& profile) {
  sandboxd::StartRequest request;  // every attempt asks for the same isolation
  request.set_job_id(job_id);
  request.set_image(image);
  request.set_profile(profile);
  sandboxd::StartReply reply;
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kStartDeadline);
    const grpc::Status status = containers->Start(&ctx, request, &reply);
    if (status.ok()) break;
    // Only a node that was not there is worth a second try; a refusal or a deadline fails the job.
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE || attempt == kMaxAttempts) {
      throw IsolationError("start " + job_id + ": " + status.error_message());
    }
  }
  if (rankOf(reply.profile()) < rankOf(profile)) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kStartDeadline);
    sandboxd::KillRequest kill;
    kill.set_job_id(job_id);
    kill.set_container_id(reply.container_id());
    sandboxd::KillReply killed;
    containers->Kill(&ctx, kill, &killed);
    throw IsolationError("asked for " + profile + ", the node started " + reply.profile());
  }
  return Handle{reply.container_id(), reply.profile()};
}
`,
    },
  },
  harness: {
    python: `import grpc

import sandbox_containers_pb2 as pb
import sandbox_containers_pb2_grpc as pb_grpc

IMAGE = "python:3.12-slim"


class Node(pb_grpc.ContainersServicer):
    """Starts every container under the requested profile, unless reports maps it to another one."""

    def __init__(self):
        self.reports = {}

    def Start(self, request, context):
        return pb.StartReply(container_id=f"c-{request.job_id}", profile=self.reports.get(request.profile, request.profile))

    def Kill(self, request, context):
        return pb.KillReply()


def _client(ctx):
    node = Node()
    ctx.grpc.serve(pb_grpc.add_ContainersServicer_to_server, node)
    return ctx.load("client"), node


def _fails(m, why, job_id="j-1"):
    try:
        handle = m.start_container(job_id, IMAGE, "gvisor")
    except m.IsolationError:
        return
    except Exception as other:
        raise AssertionError(f"{why}: start_container raised {type(other).__name__}: {other}, expected IsolationError")
    raise AssertionError(f"{why}: start_container returned {handle} instead of raising IsolationError")


def _starts(ctx):
    return len(ctx.grpc.calls_to("Start"))


def check_deadline(ctx):
    m, _ = _client(ctx)
    handle = m.start_container("j-1", IMAGE, "gvisor")
    assert handle.get("profile") == "gvisor", f"a healthy start answered {handle}"
    for call in ctx.grpc.calls_to("Start"):
        assert call.timeout is not None, "a Start call carries no deadline: a wedged node holds the runner as long as it likes"
        assert 29.5 <= call.timeout <= 30.5, f"a Start call carries a {call.timeout} s deadline, expected START_DEADLINE_S = 30"
    ctx.grpc.set_latency("Start", 60.0)
    before, calls = ctx.clock.time(), _starts(ctx)
    _fails(m, "a node that takes 60 s to start", "j-2")
    waited = ctx.clock.time() - before
    assert waited <= 31, f"start_container waited {waited:.0f} s on a node that takes 60 s: the deadline must fail the job at 30 s"
    assert _starts(ctx) == calls + 1, f"a start past its deadline was sent {_starts(ctx) - calls} times: a deadline fails the job, it is not retried"


def check_retry_policy(ctx):
    m, _ = _client(ctx)
    for code in (grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.INVALID_ARGUMENT):
        calls = _starts(ctx)
        ctx.grpc.fail("Start", code, "image rejected by the node", 1)
        _fails(m, f"an image the node refuses ({code.name})")
        assert _starts(ctx) == calls + 1, f"a {code.name} was sent {_starts(ctx) - calls} times: a refused image is terminal"
    calls = _starts(ctx)
    ctx.grpc.fail("Start", grpc.StatusCode.UNAVAILABLE, "node draining", 1)
    handle = m.start_container("j-2", IMAGE, "gvisor")
    assert handle.get("container_id") == "c-j-2", f"one UNAVAILABLE then a healthy node must start the container, got {handle}"
    assert _starts(ctx) == calls + 2, f"one UNAVAILABLE then success took {_starts(ctx) - calls} calls, expected 2"
    calls = _starts(ctx)
    ctx.grpc.fail("Start", grpc.StatusCode.UNAVAILABLE, "node gone", 5)
    _fails(m, "a node that stays unavailable", "j-3")
    assert _starts(ctx) == calls + 2, f"a node that stays unavailable got {_starts(ctx) - calls} calls, expected MAX_ATTEMPTS = 2"


def check_no_downgrade(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Start", grpc.StatusCode.UNAVAILABLE, "node draining", 1)
    try:
        handle = m.start_container("j-1", IMAGE, "gvisor")
    except m.IsolationError:
        handle = None
    asked = [c.request.profile for c in ctx.grpc.calls_to("Start")]
    assert "runc" not in asked, f"the attempts asked for {asked}: a retry must ask for gvisor again, never a weaker profile"
    assert handle is not None and handle.get("profile") == "gvisor", f"one UNAVAILABLE then a healthy node must start j-1 under gvisor, got {handle}"
    ctx.grpc.fail("Start", grpc.StatusCode.DEADLINE_EXCEEDED, "slow node", 1)
    _fails(m, "a start that timed out", "j-2")
    asked = [c.request.profile for c in ctx.grpc.calls_to("Start")]
    assert "runc" not in asked, f"after a timeout the runner asked for {asked}: fail the job instead of weakening its profile"


def check_isolation_rank(ctx):
    m, node = _client(ctx)
    node.reports["gvisor"] = "runc"
    _fails(m, "a node that started runc when gvisor was asked for")
    killed = [c.request.container_id for c in ctx.grpc.calls_to("Kill")]
    assert killed == ["c-j-1"], f"the container that started weaker must be killed, Kill was called for {killed}"
    node.reports["gvisor"] = "kata"
    handle = m.start_container("j-2", IMAGE, "gvisor")
    assert handle.get("profile") == "kata", f"a node that started kata (stronger) for gvisor must be accepted, got {handle}"
    assert len(ctx.grpc.calls_to("Kill")) == 1, "a stronger profile must not be killed"
`,
    typescript: `const IMAGE = 'python:3.12-slim';

function client(ctx) {
  const pkg = ctx.proto('sandbox_containers.proto');
  const reports: Record<string, string> = {};
  ctx.grpc.serve(pkg.sandboxd.Containers.service, {
    Start(call, callback) {
      const {job_id, profile} = call.request;
      callback(null, {container_id: \`c-\${job_id}\`, profile: reports[profile] ?? profile});
    },
    Kill(call, callback) {
      callback(null, {});
    },
  });
  return {m: ctx.load('client'), reports};
}

async function fails(m, why: string, jobId = 'j-1'): Promise<void> {
  let handle;
  try {
    handle = await m.startContainer(jobId, IMAGE, 'gvisor');
  } catch (e) {
    if (e instanceof m.IsolationError) return;
    assert.fail(\`\${why}: startContainer threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected IsolationError\`);
  }
  assert.fail(\`\${why}: startContainer returned \${JSON.stringify(handle)} instead of throwing IsolationError\`);
}

const starts = (ctx): number => ctx.grpc.callsTo('Start').length;

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const handle = await m.startContainer('j-1', IMAGE, 'gvisor');
  assert.equal(handle.profile, 'gvisor', \`a healthy start answered \${JSON.stringify(handle)}\`);
  for (const call of ctx.grpc.callsTo('Start')) {
    assert(call.timeout !== null, 'a Start call carries no deadline: a wedged node holds the runner as long as it likes');
    assert(call.timeout >= 29.5 && call.timeout <= 30.5, \`a Start call carries a \${call.timeout} s deadline, expected START_DEADLINE_MS = 30000\`);
  }
  ctx.grpc.setLatency('Start', 60.0);
  const before = ctx.clock.now();
  const calls = starts(ctx);
  await fails(m, 'a node that takes 60 s to start', 'j-2');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 31, \`startContainer waited \${waited.toFixed(0)} s on a node that takes 60 s: the deadline must fail the job at 30 s\`);
  assert.equal(starts(ctx), calls + 1, \`a start past its deadline was sent \${starts(ctx) - calls} times: a deadline fails the job, it is not retried\`);
}

export async function check_retry_policy(ctx) {
  const {m} = client(ctx);
  for (const [code, name] of [[ctx.grpc.status.FAILED_PRECONDITION, 'FAILED_PRECONDITION'], [ctx.grpc.status.INVALID_ARGUMENT, 'INVALID_ARGUMENT']]) {
    const calls = starts(ctx);
    ctx.grpc.fail('Start', code, 'image rejected by the node', 1);
    await fails(m, \`an image the node refuses (\${name})\`);
    assert.equal(starts(ctx), calls + 1, \`a \${name} was sent \${starts(ctx) - calls} times: a refused image is terminal\`);
  }
  let calls = starts(ctx);
  ctx.grpc.fail('Start', ctx.grpc.status.UNAVAILABLE, 'node draining', 1);
  const handle = await m.startContainer('j-2', IMAGE, 'gvisor');
  assert.equal(handle.container_id, 'c-j-2', \`one UNAVAILABLE then a healthy node must start the container, got \${JSON.stringify(handle)}\`);
  assert.equal(starts(ctx), calls + 2, \`one UNAVAILABLE then success took \${starts(ctx) - calls} calls, expected 2\`);
  calls = starts(ctx);
  ctx.grpc.fail('Start', ctx.grpc.status.UNAVAILABLE, 'node gone', 5);
  await fails(m, 'a node that stays unavailable', 'j-3');
  assert.equal(starts(ctx), calls + 2, \`a node that stays unavailable got \${starts(ctx) - calls} calls, expected MAX_ATTEMPTS = 2\`);
}

export async function check_no_downgrade(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Start', ctx.grpc.status.UNAVAILABLE, 'node draining', 1);
  let handle = null;
  try {
    handle = await m.startContainer('j-1', IMAGE, 'gvisor');
  } catch (e) {
    if (!(e instanceof m.IsolationError)) throw e;
  }
  let asked = ctx.grpc.callsTo('Start').map(c => c.request.profile);
  assert(!asked.includes('runc'), \`the attempts asked for \${JSON.stringify(asked)}: a retry must ask for gvisor again, never a weaker profile\`);
  assert(handle !== null && handle.profile === 'gvisor', \`one UNAVAILABLE then a healthy node must start j-1 under gvisor, got \${JSON.stringify(handle)}\`);
  ctx.grpc.fail('Start', ctx.grpc.status.DEADLINE_EXCEEDED, 'slow node', 1);
  await fails(m, 'a start that timed out', 'j-2');
  asked = ctx.grpc.callsTo('Start').map(c => c.request.profile);
  assert(!asked.includes('runc'), \`after a timeout the runner asked for \${JSON.stringify(asked)}: fail the job instead of weakening its profile\`);
}

export async function check_isolation_rank(ctx) {
  const {m, reports} = client(ctx);
  reports.gvisor = 'runc';
  await fails(m, 'a node that started runc when gvisor was asked for');
  const killed = ctx.grpc.callsTo('Kill').map(c => c.request.container_id);
  assert.deepStrictEqual(killed, ['c-j-1'], \`the container that started weaker must be killed, Kill was called for \${JSON.stringify(killed)}\`);
  reports.gvisor = 'kata';
  const handle = await m.startContainer('j-2', IMAGE, 'gvisor');
  assert.equal(handle.profile, 'kata', \`a node that started kata (stronger) for gvisor must be accepted, got \${JSON.stringify(handle)}\`);
  assert.equal(ctx.grpc.callsTo('Kill').length, 1, 'a stronger profile must not be killed');
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	pb "sandbox/gen/sandbox_containers"

	"leetbuild/harness"
)

const clientImage = "python:3.12-slim"

var clientBg = context.Background()

// nodePeer starts every container under the requested profile, unless reports maps it to another one.
type nodePeer struct {
	pb.UnimplementedContainersServer
	reports map[string]string
}

func (n *nodePeer) Start(_ context.Context, req *pb.StartRequest) (*pb.StartReply, error) {
	profile := req.GetProfile()
	if reported, ok := n.reports[profile]; ok {
		profile = reported
	}
	return &pb.StartReply{ContainerId: "c-" + req.GetJobId(), Profile: profile}, nil
}

func (n *nodePeer) Kill(_ context.Context, _ *pb.KillRequest) (*pb.KillReply, error) {
	return &pb.KillReply{}, nil
}

func client(ctx *harness.Ctx) *nodePeer {
	node := &nodePeer{reports: map[string]string{}}
	pb.RegisterContainersServer(ctx.GRPC.Server(""), node)
	return node
}

func mustStart(ctx *harness.Ctx, jobID, why string) *Handle {
	handle, err := startContainer(clientBg, jobID, clientImage, "gvisor")
	ctx.NoError(err, "%s: startContainer failed", why)
	return handle
}

func mustFail(ctx *harness.Ctx, jobID, why string) {
	handle, err := startContainer(clientBg, jobID, clientImage, "gvisor")
	ctx.Assert(err != nil, "%s: startContainer returned %+v instead of an error wrapping ErrIsolation", why, handle)
	ctx.ErrorIs(err, ErrIsolation, "%s: startContainer returned %v", why, err)
}

func starts(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Start", "")) }

func askedProfiles(ctx *harness.Ctx) []string {
	asked := []string{}
	for _, c := range ctx.GRPC.CallsTo("Start", "") {
		asked = append(asked, c.Request.(*pb.StartRequest).GetProfile())
	}
	return asked
}

func noRunc(asked []string) bool {
	for _, p := range asked {
		if p == "runc" {
			return false
		}
	}
	return true
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	handle := mustStart(ctx, "j-1", "a healthy start")
	ctx.Equal(handle.Profile, "gvisor", "a healthy start's profile")
	for _, call := range ctx.GRPC.CallsTo("Start", "") {
		ctx.Assert(call.HasDeadline(), "a Start call carries no deadline: a wedged node holds the runner as long as it likes")
		ctx.Assert(29500*time.Millisecond <= call.Timeout && call.Timeout <= 30500*time.Millisecond, "a Start call carries a %v deadline, expected 30 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Start", 60.0, "")
	before, calls := ctx.Clock.Now(), starts(ctx)
	mustFail(ctx, "j-2", "a node that takes 60 s to start")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 31, "startContainer waited %.0f s on a node that takes 60 s: the deadline must fail the job at 30 s", waited)
	ctx.Equal(starts(ctx), calls+1, "a deadline fails the job, it is not retried; Start calls")
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	client(ctx)
	for _, code := range []codes.Code{codes.FailedPrecondition, codes.InvalidArgument} {
		calls := starts(ctx)
		ctx.GRPC.Fail("Start", code, "image rejected by the node", 1, "")
		mustFail(ctx, "j-1", "an image the node refuses ("+code.String()+")")
		ctx.Equal(starts(ctx), calls+1, "a refused image (%v) is terminal; Start calls", code)
	}
	calls := starts(ctx)
	ctx.GRPC.Fail("Start", codes.Unavailable, "node draining", 1, "")
	handle := mustStart(ctx, "j-2", "one UNAVAILABLE then a healthy node")
	ctx.Equal(handle.ContainerID, "c-j-2", "one UNAVAILABLE then a healthy node must start the container; the container")
	ctx.Equal(starts(ctx), calls+2, "one UNAVAILABLE then success; Start calls")
	calls = starts(ctx)
	ctx.GRPC.Fail("Start", codes.Unavailable, "node gone", 5, "")
	mustFail(ctx, "j-3", "a node that stays unavailable")
	ctx.Equal(starts(ctx), calls+2, "a node that stays unavailable gets maxAttempts = 2 calls; Start calls")
}

func CheckNoDowngrade(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("Start", codes.Unavailable, "node draining", 1, "")
	handle, _ := startContainer(clientBg, "j-1", clientImage, "gvisor")
	ctx.Assert(noRunc(askedProfiles(ctx)), "the attempts asked for %v: a retry must ask for gvisor again, never a weaker profile", askedProfiles(ctx))
	ctx.Assert(handle != nil && handle.Profile == "gvisor", "one UNAVAILABLE then a healthy node must start j-1 under gvisor, got %+v", handle)
	ctx.GRPC.Fail("Start", codes.DeadlineExceeded, "slow node", 1, "")
	mustFail(ctx, "j-2", "a start that timed out")
	ctx.Assert(noRunc(askedProfiles(ctx)), "after a timeout the runner asked for %v: fail the job instead of weakening its profile", askedProfiles(ctx))
}

func CheckIsolationRank(ctx *harness.Ctx) {
	node := client(ctx)
	node.reports["gvisor"] = "runc"
	mustFail(ctx, "j-1", "a node that started runc when gvisor was asked for")
	killed := []string{}
	for _, c := range ctx.GRPC.CallsTo("Kill", "") {
		killed = append(killed, c.Request.(*pb.KillRequest).GetContainerId())
	}
	ctx.Equal(killed, []string{"c-j-1"}, "the container that started weaker must be killed; Kill calls")
	node.reports["gvisor"] = "kata"
	handle := mustStart(ctx, "j-2", "a node that started kata for gvisor")
	ctx.Equal(handle.Profile, "kata", "a stronger profile must be accepted; the profile")
	ctx.Equal(len(ctx.GRPC.CallsTo("Kill", "")), 1, "a stronger profile must not be killed; Kill calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

namespace {

const std::string kImage = "python:3.12-slim";

// Starts every container under the requested profile, unless reports maps it to another one.
class NodePeer final : public sandboxd::Containers::Service {
 public:
  std::map<std::string, std::string> reports;
  grpc::Status Start(grpc::ServerContext*, const sandboxd::StartRequest* req, sandboxd::StartReply* out) override {
    out->set_container_id("c-" + req->job_id());
    out->set_profile(reports.count(req->profile()) ? reports.at(req->profile()) : req->profile());
    return grpc::Status::OK;
  }
  grpc::Status Kill(grpc::ServerContext*, const sandboxd::KillRequest*, sandboxd::KillReply*) override { return grpc::Status::OK; }
};

NodePeer& client(harness::Ctx& ctx) {
  static NodePeer* node = nullptr;
  delete node;
  node = new NodePeer;
  ctx.GRPC.Server("")->RegisterService(node);
  return *node;
}

Handle mustStart(harness::Ctx& ctx, const std::string& job_id, const std::string& why) {
  try {
    return startContainer(job_id, kImage, "gvisor");
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: startContainer threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

void mustFail(harness::Ctx& ctx, const std::string& job_id, const std::string& why) {
  Handle handle;
  try {
    handle = startContainer(job_id, kImage, "gvisor");
  } catch (const IsolationError&) {
    return;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: startContainer threw %s: %s, expected IsolationError", why, harness::CurrentExceptionType(), e.what());
  }
  ctx.Fatalf("%s: startContainer returned container %s under %s instead of throwing IsolationError", why, handle.container_id, handle.profile);
}

size_t starts(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Start").size(); }

std::vector<std::string> askedProfiles(harness::Ctx& ctx) {
  std::vector<std::string> asked;
  for (const auto& c : ctx.GRPC.CallsTo("Start")) asked.push_back(c.Request<sandboxd::StartRequest>().profile());
  return asked;
}

bool noRunc(const std::vector<std::string>& asked) {
  for (const auto& p : asked) {
    if (p == "runc") return false;
  }
  return true;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  const Handle handle = mustStart(ctx, "j-1", "a healthy start");
  ctx.Equal(handle.profile, "gvisor", "a healthy start's profile");
  for (const auto& call : ctx.GRPC.CallsTo("Start")) {
    ctx.Assert(call.HasDeadline(), "a Start call carries no deadline: a wedged node holds the runner as long as it likes");
    ctx.Assert(29.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 30.5, "a Start call carries a %v s deadline, expected kStartDeadline = 30 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Start", 60.0);
  const int64_t before = ctx.Clock.Now();
  const size_t calls = starts(ctx);
  mustFail(ctx, "j-2", "a node that takes 60 s to start");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 31, "startContainer waited %.0f s on a node that takes 60 s: the deadline must fail the job at 30 s", waited);
  ctx.Equal(starts(ctx), calls + 1, "a deadline fails the job, it is not retried; Start calls");
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  client(ctx);
  for (const auto code : {grpc::StatusCode::FAILED_PRECONDITION, grpc::StatusCode::INVALID_ARGUMENT}) {
    const size_t calls = starts(ctx);
    ctx.GRPC.Fail("Start", code, "image rejected by the node", 1);
    mustFail(ctx, "j-1", "an image the node refuses");
    ctx.Equal(starts(ctx), calls + 1, "a refused image is terminal; Start calls");
  }
  size_t calls = starts(ctx);
  ctx.GRPC.Fail("Start", grpc::StatusCode::UNAVAILABLE, "node draining", 1);
  const Handle handle = mustStart(ctx, "j-2", "one UNAVAILABLE then a healthy node");
  ctx.Equal(handle.container_id, "c-j-2", "one UNAVAILABLE then a healthy node must start the container; the container");
  ctx.Equal(starts(ctx), calls + 2, "one UNAVAILABLE then success; Start calls");
  calls = starts(ctx);
  ctx.GRPC.Fail("Start", grpc::StatusCode::UNAVAILABLE, "node gone", 5);
  mustFail(ctx, "j-3", "a node that stays unavailable");
  ctx.Equal(starts(ctx), calls + 2, "a node that stays unavailable gets kMaxAttempts = 2 calls; Start calls");
}

void CheckNoDowngrade(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("Start", grpc::StatusCode::UNAVAILABLE, "node draining", 1);
  std::string started;
  try {
    started = startContainer("j-1", kImage, "gvisor").profile;
  } catch (const IsolationError&) {
  }
  ctx.Assert(noRunc(askedProfiles(ctx)), "the attempts asked for runc: a retry must ask for gvisor again, never a weaker profile");
  ctx.Equal(started, "gvisor", "one UNAVAILABLE then a healthy node must start j-1 under gvisor; the profile");
  ctx.GRPC.Fail("Start", grpc::StatusCode::DEADLINE_EXCEEDED, "slow node", 1);
  mustFail(ctx, "j-2", "a start that timed out");
  ctx.Assert(noRunc(askedProfiles(ctx)), "after a timeout the runner asked for runc: fail the job instead of weakening its profile");
}

void CheckIsolationRank(harness::Ctx& ctx) {
  NodePeer& node = client(ctx);
  node.reports["gvisor"] = "runc";
  mustFail(ctx, "j-1", "a node that started runc when gvisor was asked for");
  std::vector<std::string> killed;
  for (const auto& c : ctx.GRPC.CallsTo("Kill")) killed.push_back(c.Request<sandboxd::KillRequest>().container_id());
  ctx.Equal(killed, {"c-j-1"}, "the container that started weaker must be killed; Kill calls");
  node.reports["gvisor"] = "kata";
  const Handle handle = mustStart(ctx, "j-2", "a node that started kata for gvisor");
  ctx.Equal(handle.profile, "kata", "a stronger profile must be accepted; the profile");
  ctx.Equal(ctx.GRPC.CallsTo("Kill").size(), 1, "a stronger profile must not be killed; Kill calls");
}
`,
  },
  hints: [
    'Make the node answer `UNAVAILABLE` once: the job runs, under `runc`. Make it report `runc` for a `gvisor` request and the runner accepts it. Make it take a minute and the runner waits the whole minute.',
    "The loop treats every error alike: it never reads the status code, it rewrites the request's profile on the way to the next attempt, and no call carries a deadline. The reply's profile is returned without a comparison.",
    'Pass `timeout=START_DEADLINE_S`; retry only `UNAVAILABLE`, `MAX_ATTEMPTS` in all, the same request each time; raise `IsolationError` otherwise. Then `Kill` and raise when `ISOLATION_RANK[reported] < ISOLATION_RANK[requested]`.',
  ],
  debrief: `Each failure path ends in one of two places: the same request again, or a failed job. There is no third path that runs the code somewhere weaker, which is the whole point of the rank check: the platform's guarantee is the isolation the job asked for, so a node that started less is a broken node, and its container is killed before the code can do anything. Retrying only \`UNAVAILABLE\` keeps a refused image from burning attempts, and the deadline bounds how long a wedged node can hold a runner. A production runner also spreads its retry to a different node, records which node downgraded so the scheduler can drain it, and reports the start failure on the job so the submitter sees why it never ran.`,
};
