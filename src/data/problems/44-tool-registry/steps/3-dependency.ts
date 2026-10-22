import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Sandbox validation before a tool version goes live',
  concept: 'grpc',
  file: 'client',
  focus: ['registry', 'sandbox', 'vault', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the sandbox is up it
validates the candidate and the promotion goes through, so the demo ships. Every failure path
promotes anyway. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement the validation the registry runs on a candidate version before promotion — the work behind
\`POST /v1/tools/{name}/versions/{version}/validate\`:

- Every candidate is exercised in the **sandbox** over gRPC under a **10-second deadline**
  (\`VALIDATE_DEADLINE_S\` / \`VALIDATE_DEADLINE_MS\` / \`validateDeadline\`). No deadline means one
  wedged sandbox pins the worker that asked for the promotion.
- The sandbox is dialled with **its own scoped credential** — the sandbox endpoint and token from
  the sandbox config, carried as \`authorization\` metadata. The production provider credential never
  reaches this path: the sandbox runs candidate code, so a credential handed to it is a credential
  the candidate can spend.
- A **timeout or any RPC error is a rejection, not a pass**: the version that is currently active
  stays active, and the rejection is recorded with a visible reason
  (\`verdicts.record(name, version, …)\`) so the operator can see why the candidate did not ship.
- A **schema rejection** — the sandbox answers \`INVALID_ARGUMENT\` — is **terminal for that
  version**: record the verdict, do not retry it, and answer a re-request for the same version from
  the recorded verdict (\`verdicts.get(name, version)\`) instead of calling the sandbox again.
- **Promotion happens only after a validation that returned OK**: \`catalog.promote(name, version,
  actor)\` is reached by the OK branch, and by nothing else.

**Failure mode the checks target.** Treating silence as consent is the whole bug: the draft reads a
timeout as "the checks would surely have passed" and promotes, so a wedged sandbox ships a version
nobody validated. The second is the credential: dialling the sandbox with the production provider
key puts a live key in the process that runs the candidate's own code. The third is the retry on a
schema rejection: the same bytes produce the same rejection, so the retry only turns a measured "no"
into a load test against the sandbox.`,
  sequence: {
    participants: ['Registry', 'Sandbox', 'Vault', 'Catalog'],
    messages: [
      {from: 'Registry', to: 'Vault', label: 'sandbox endpoint + token · SANDBOX_TOKEN', kind: 'sync'},
      {
        from: 'Registry',
        to: 'Sandbox',
        label: 'Validate(name, version) · deadline 10 s · authorization metadata',
        kind: 'sync',
      },
      {
        from: 'Sandbox',
        to: 'Registry',
        label: 'OK{ok} · INVALID_ARGUMENT (schema) · DEADLINE_EXCEEDED',
        kind: 'reply',
      },
      {
        from: 'Registry',
        to: 'Catalog',
        label: 'record rejection(name, version, reason) · active version untouched',
        kind: 'sync',
      },
      {
        from: 'Registry',
        to: 'Registry',
        label: 're-request → recorded verdict, no second sandbox call',
        kind: 'sync',
      },
      {from: 'Registry', to: 'Catalog', label: 'promote(name, version, actor) — OK branch only', kind: 'sync'},
      {from: 'Catalog', to: 'Registry', label: 'version live', kind: 'reply'},
    ],
  },
  hints: [
    'The deadline is an argument on the call: `timeout=VALIDATE_DEADLINE_S`, `deadline: Date.now() + VALIDATE_DEADLINE_MS`, `context.WithTimeout(ctx, validateDeadline)`, `withDeadlineAfter(ValidateDeadlineMs, …)`, `ctx.set_deadline(…)`. Wrapping the call in a timer changes nothing.',
    'Credentials are per hop. Build the sandbox client from the sandbox endpoint and put the sandbox token in the call’s `authorization` metadata; the production credential belongs to the provider call, not to the process that runs candidate code. The draft’s `prod_metadata()` is the leak.',
    'Sort the failure before you react to it. A transport failure (`DEADLINE_EXCEEDED` / `UNAVAILABLE`) leaves the active version alone and records the rejection with its reason; `INVALID_ARGUMENT` is a verdict on the version, so record it and stop. Check `verdicts.get(name, version)` before you call the sandbox, and let only the OK branch reach `catalog.promote(...)`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every sandbox call carries a 10-second deadline',
      detail:
        'The call is created with a 10-second deadline — `timeout=VALIDATE_DEADLINE_S`, `deadline: Date.now() + VALIDATE_DEADLINE_MS`, `context.WithTimeout(ctx, validateDeadline)`, `withDeadlineAfter` or `set_deadline`. Without it one wedged sandbox holds the request that asked for the promotion open indefinitely.',
      match: {
        python: {all: [/VALIDATE_DEADLINE_S\s*=\s*10/, /timeout=VALIDATE_DEADLINE_S/, /\.Validate\(/]},
        typescript: {
          all: [
            /VALIDATE_DEADLINE_MS\s*=\s*10_?000/,
            /deadline:\s*Date\.now\(\)\s*\+\s*VALIDATE_DEADLINE_MS/,
            /\.Validate\(/,
          ],
        },
        go: {
          all: [
            /validateDeadline\s*=\s*10\s*\*\s*time\.Second/,
            /context\.With(Timeout|Deadline)\([^\n]*validateDeadline/,
            /\.Validate\(/,
          ],
        },
        scala: {all: [/ValidateDeadlineMs\s*=\s*10000/, /withDeadlineAfter\(/, /\.validate\(/]},
        cpp: {all: [/kValidateDeadlineMs\s*=\s*10000/, /set_deadline\(/, /->Validate\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A timeout keeps the active version and records the reason',
      detail:
        'The error branch records a rejection with its reason and returns, so `catalog.promote` is unreachable from it and the previously active version stays active. The draft promotes in the `except` / `catch` / `err != nil` branch: a timeout became a release.',
      match: {
        python: {
          all: [/except\s+grpc\.[\w.]*RpcError/, /verdicts\.record\(/, /reason/],
          none: [/except\s+grpc\.[\w.]*RpcError[\s\S]{0,200}?(STATUS_PASSED|return\s+True|promote\w*\()/],
        },
        typescript: {
          all: [/catch\s*\(\s*\w+\s*\)\s*\{/, /verdicts\.record\(/, /reason/],
          none: [/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]{0,200}?(STATUS_PASSED|return\s+true|[Cc]atalog\.promote\()/],
        },
        go: {
          all: [/if err != nil\s*\{/, /verdicts\.Record\(/, /reason/],
          none: [/if err != nil\s*\{[\s\S]{0,200}?catalog\.Promote\(/],
        },
        scala: {
          all: [/case \w+: StatusRuntimeException/, /Verdicts\.record\(/, /reason/],
          none: [/case \w+: StatusRuntimeException[\s\S]{0,200}?Catalog\.promote\(/],
        },
        cpp: {
          all: [/!status\.ok\(\)/, /verdicts\.record\(/, /reason/],
          none: [/!status\.ok\(\)\s*\{[\s\S]{0,200}?catalog\.promote\(/],
        },
      },
    },
    {
      id: 'credentials',
      title: 'The sandbox is dialled with its own scoped credential',
      detail:
        'The sandbox client is built from the sandbox endpoint and carries the sandbox token (`SANDBOX_TOKEN` / `SandboxToken`) as `authorization` metadata; the production provider credential never appears on this path. The draft dials the sandbox with the key the production provider call uses.',
      match: {
        python: {all: [/SANDBOX_[A-Z_]+/, /metadata\s*=/, /\.Validate\(/], none: [/provider_?api_?key/i]},
        typescript: {
          all: [/SANDBOX_[A-Z_]+/, /metadata\.set\(/, /\.Validate\(/],
          none: [/provider_?api_?key/i],
        },
        go: {
          all: [/SANDBOX_(TOKEN|ENDPOINT)/, /metadata\.AppendToOutgoingContext\(/, /\.Validate\(/],
          none: [/provider_?api_?key/i],
        },
        scala: {
          all: [/SandboxToken|SandboxEndpoint/, /Metadata\.Key\.of\(/, /\.validate\(/],
          none: [/provider_?api_?key/i],
        },
        cpp: {all: [/SANDBOX_TOKEN|kSandboxToken/, /AddMetadata\(/, /->Validate\(/], none: [/provider_?api_?key/i]},
      },
    },
    {
      id: 'terminal',
      title: 'A schema rejection is terminal for that version',
      detail:
        '`INVALID_ARGUMENT` is a verdict on the version: it is recorded and returned, and a re-request for the same version is answered from `verdicts.get(name, version)` instead of calling the sandbox again. The draft retries the rejection in a loop until the checks pass.',
      match: {
        python: {
          all: [/StatusCode\.INVALID_ARGUMENT/, /verdicts\.get\(/, /reject/i],
          none: [/INVALID_ARGUMENT[\s\S]{0,80}?continue/],
        },
        typescript: {
          all: [/grpc\.status\.INVALID_ARGUMENT/, /verdicts\.get\(/, /reject/i],
          none: [/INVALID_ARGUMENT[\s\S]{0,80}?continue\b/],
        },
        go: {
          all: [/codes\.InvalidArgument/, /verdicts\.Get\(/, /reject/i],
          none: [/InvalidArgument[\s\S]{0,80}?continue/],
        },
        scala: {
          all: [/Code\.INVALID_ARGUMENT/, /Verdicts\.get\(/, /reject/i],
          none: [/INVALID_ARGUMENT[\s\S]{0,120}?attempt\s*\+=/],
        },
        cpp: {
          all: [/StatusCode::INVALID_ARGUMENT/, /verdicts\.get\(/, /reject/i],
          none: [/INVALID_ARGUMENT[\s\S]{0,80}?continue;/],
        },
      },
    },
    {
      id: 'promote',
      title: 'Promotion happens only after a validation that returned OK',
      detail:
        'The sandbox call comes first, its reply is checked for `ok`, and `catalog.promote(name, version, …)` is reached only by that branch. The draft promotes whatever the sandbox answered — including nothing at all.',
      match: {
        python: {
          all: [/catalog\.promote\(\s*name\s*,\s*version/],
          order: [/\.Validate\(/, /reply\.ok\b/, /catalog\.promote\(/],
        },
        typescript: {
          all: [/catalog\.promote\(\s*name\s*,\s*version/],
          order: [/\.Validate\(/, /reply\.ok\b/, /[Cc]atalog\.promote\(/],
        },
        go: {
          all: [/[Cc]atalog\.Promote\(\s*ctx\s*,\s*name\s*,\s*version/],
          order: [/\.Validate\(/, /reply\.(GetOk\(\)|Ok)/, /[Cc]atalog\.Promote\(/],
        },
        scala: {
          all: [/Catalog\.promote\(\s*name\s*,\s*version/],
          order: [/\.validate\(/, /reply\.ok\b/, /Catalog\.promote\(/],
        },
        cpp: {
          all: [/catalog\.promote\(\s*name\s*,\s*version/],
          order: [/->Validate\(/, /reply\.ok\(\)/, /catalog\.promote\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Sandbox validation for a candidate tool version: a generated first pass."""
import os

import grpc

import sandbox_pb2
import sandbox_pb2_grpc

SCHEMA_RETRIES = 5  # a rejected schema is worth another attempt

PROVIDER_API_KEY = os.environ["PROVIDER_API_KEY"]

channel = grpc.aio.insecure_channel("sandbox:9000")
sandbox = sandbox_pb2_grpc.SandboxStub(channel)


def prod_metadata() -> tuple[tuple[str, str], ...]:
    return (("authorization", f"Bearer {PROVIDER_API_KEY}"),)


class Catalog:
    def promote(self, name: str, version: str, actor: str) -> None:
        raise NotImplementedError


catalog = Catalog()


def validate_candidate(name: str, version: str, actor: str) -> None:
    # TODO: the sandbox call carries no deadline, it is dialled with the production provider
    # credential, a schema rejection is retried and every other failure is treated as a pass. Make
    # a timeout leave the active version alone with a recorded reason, dial the sandbox with its
    # own token, make a schema rejection terminal, and promote only after the sandbox answers OK.
    request = sandbox_pb2.ValidateRequest(name=name, version=version)
    for _ in range(SCHEMA_RETRIES):
        try:
            sandbox.Validate(request, metadata=prod_metadata())
            return
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                continue  # a schema rejection: the checks will surely pass on another attempt
            catalog.promote(name, version, actor)  # a timeout is not a rejection
            return
    catalog.promote(name, version, actor)
`,
      solution: `"""Sandbox validation for a candidate tool version."""
import os

import grpc

import sandbox_pb2
import sandbox_pb2_grpc

VALIDATE_DEADLINE_S = 10.0
STATUS_PASSED = "passed"
STATUS_REJECTED = "rejected"

SANDBOX_ENDPOINT = os.environ.get("SANDBOX_ENDPOINT", "sandbox:9000")
SANDBOX_TOKEN = os.environ["SANDBOX_TOKEN"]

channel = grpc.aio.insecure_channel(SANDBOX_ENDPOINT)
sandbox = sandbox_pb2_grpc.SandboxStub(channel)


class Verdicts:
    """One verdict per (name, version): a candidate version is validated once."""

    def get(self, name: str, version: str) -> dict | None:
        raise NotImplementedError

    def record(self, name: str, version: str, status: str, reason: str) -> None:
        raise NotImplementedError


class Catalog:
    def promote(self, name: str, version: str, actor: str) -> None:
        """Point the tool at this version. Only a passing validation may call it."""
        raise NotImplementedError


verdicts = Verdicts()
catalog = Catalog()


def sandbox_metadata() -> tuple[tuple[str, str], ...]:
    """The sandbox's own token from config: a sandbox call never carries the production credential."""
    return (("authorization", f"Bearer {SANDBOX_TOKEN}"),)


async def validate_candidate(name: str, version: str, actor: str) -> dict:
    """Exercise the candidate in the sandbox and act on the verdict it returns.

    A recorded verdict is final for that version. Anything other than a passing validation leaves
    the active version active and records the rejection with a visible reason.
    """
    recorded = verdicts.get(name, version)
    if recorded is not None:
        return recorded

    # The sandbox answers within the deadline or the promotion is refused: a timeout is not consent.
    request = sandbox_pb2.ValidateRequest(name=name, version=version)
    try:
        reply = await sandbox.Validate(
            request, timeout=VALIDATE_DEADLINE_S, metadata=sandbox_metadata()
        )
    except grpc.aio.AioRpcError as exc:
        if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
            reason = f"schema rejected: {exc.details() or 'invalid candidate schema'}"
        else:
            reason = f"sandbox {exc.code().name.lower()}"
        verdicts.record(name, version, STATUS_REJECTED, reason)
        return {"status": STATUS_REJECTED, "reason": reason}

    if not reply.ok:
        reason = reply.reason or "schema rejected"
        verdicts.record(name, version, STATUS_REJECTED, reason)
        return {"status": STATUS_REJECTED, "reason": reason}

    catalog.promote(name, version, actor)
    verdicts.record(name, version, STATUS_PASSED, "")
    return {"status": STATUS_PASSED, "reason": ""}
`,
    },
    typescript: {
      starter: `/** Sandbox validation for a candidate tool version: a generated first pass. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const SCHEMA_RETRIES = 5; // a rejected schema is worth another attempt
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY ?? '';

interface ValidateReply {
  ok: boolean;
  reason: string;
}

interface SandboxClient {
  Validate(
    request: {name: string; version: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: ValidateReply) => void,
  ): grpc.ClientUnaryCall;
}

const loaded = grpc.loadPackageDefinition(protoLoader.loadSync('sandbox.proto')) as unknown as {
  sandbox: {Sandbox: new (target: string, credentials: grpc.ChannelCredentials) => SandboxClient};
};
const sandbox = new loaded.sandbox.Sandbox('sandbox:9000', grpc.credentials.createInsecure());

/** The registry's catalog store. */
const catalog = {
  async promote(name: string, version: string, actor: string): Promise<void> {
    throw new Error('not implemented');
  },
};

function prodMetadata(): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set('authorization', \`Bearer \${PROVIDER_API_KEY}\`);
  return metadata;
}

export async function validateCandidate(name: string, version: string, actor: string): Promise<void> {
  // TODO: the sandbox call carries no deadline, it is dialled with the production provider
  // credential, a schema rejection is retried and every other failure is treated as a pass. Make a
  // timeout leave the active version alone with a recorded reason, dial the sandbox with its own
  // token, make a schema rejection terminal, and promote only after the sandbox answers OK.
  for (let attempt = 0; attempt < SCHEMA_RETRIES; attempt++) {
    const {promise, resolve, reject} = Promise.withResolvers<ValidateReply>();
    sandbox.Validate({name, version}, prodMetadata(), {}, (error, reply) =>
      error === null ? resolve(reply) : reject(error),
    );
    try {
      await promise;
      return;
    } catch (error) {
      if ((error as grpc.ServiceError).code === grpc.status.INVALID_ARGUMENT) {
        continue; // a schema rejection: the checks will surely pass on another attempt
      }
      await catalog.promote(name, version, actor); // a timeout is not a rejection
      return;
    }
  }
  await catalog.promote(name, version, actor);
}
`,
      solution: `/** Sandbox validation for a candidate tool version. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const VALIDATE_DEADLINE_MS = 10_000;
const STATUS_PASSED = 'passed';
const STATUS_REJECTED = 'rejected';

const SANDBOX_ENDPOINT = process.env.SANDBOX_ENDPOINT ?? 'sandbox:9000';
const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN ?? '';

interface ValidateReply {
  ok: boolean;
  reason: string;
}

interface SandboxClient {
  Validate(
    request: {name: string; version: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: ValidateReply) => void,
  ): grpc.ClientUnaryCall;
}

interface Verdict {
  status: string;
  reason: string;
}

const loaded = grpc.loadPackageDefinition(protoLoader.loadSync('sandbox.proto')) as unknown as {
  sandbox: {Sandbox: new (target: string, credentials: grpc.ChannelCredentials) => SandboxClient};
};
const sandbox = new loaded.sandbox.Sandbox(SANDBOX_ENDPOINT, grpc.credentials.createInsecure());

/** One verdict per (name, version): a candidate version is validated once. */
const verdicts = {
  async get(name: string, version: string): Promise<Verdict | null> {
    throw new Error('not implemented');
  },
  async record(name: string, version: string, status: string, reason: string): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The registry's catalog store: only a passing validation may call promote. */
const catalog = {
  async promote(name: string, version: string, actor: string): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The sandbox's own token: a sandbox call never carries the production credential. */
function sandboxMetadata(): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set('authorization', \`Bearer \${SANDBOX_TOKEN}\`);
  return metadata;
}

export async function validateCandidate(name: string, version: string, actor: string): Promise<Verdict> {
  const recorded = await verdicts.get(name, version);
  if (recorded !== null) return recorded;

  const {promise, resolve, reject} = Promise.withResolvers<ValidateReply>();
  sandbox.Validate(
    {name, version},
    sandboxMetadata(),
    {deadline: Date.now() + VALIDATE_DEADLINE_MS},
    (error, reply) => (error === null ? resolve(reply) : reject(error)),
  );

  let reply: ValidateReply;
  try {
    reply = await promise;
  } catch (error) {
    const serviceError = error as grpc.ServiceError;
    const reason =
      serviceError.code === grpc.status.INVALID_ARGUMENT
        ? \`schema rejected: \${serviceError.details}\`
        : \`sandbox status \${serviceError.code}\`;
    await verdicts.record(name, version, STATUS_REJECTED, reason);
    return {status: STATUS_REJECTED, reason};
  }

  if (!reply.ok) {
    const reason = reply.reason || 'schema rejected';
    await verdicts.record(name, version, STATUS_REJECTED, reason);
    return {status: STATUS_REJECTED, reason};
  }

  await catalog.promote(name, version, actor);
  await verdicts.record(name, version, STATUS_PASSED, '');
  return {status: STATUS_PASSED, reason: ''};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"os"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "registry/sandboxpb"
)

const schemaRetries = 5 // a rejected schema is worth another attempt

var providerAPIKey = os.Getenv("PROVIDER_API_KEY")

func prodMetadata() metadata.MD {
	return metadata.Pairs("authorization", "Bearer "+providerAPIKey)
}

type Catalog struct{}

func (c *Catalog) Promote(ctx context.Context, name, version, actor string) error { return nil }

var catalog = &Catalog{}

// TODO: the sandbox call carries no deadline, it is dialled with the production provider
// credential, a schema rejection is retried and every other failure is treated as a pass. Make a
// timeout leave the active version alone with a recorded reason, dial the sandbox with its own
// token, make a schema rejection terminal, and promote only after the sandbox answers OK.
func validateCandidate(ctx context.Context, client pb.SandboxClient, name, version, actor string) error {
	request := &pb.ValidateRequest{Name: name, Version: version}
	for attempt := 0; attempt < schemaRetries; attempt++ {
		_, err := client.Validate(metadata.NewOutgoingContext(ctx, prodMetadata()), request)
		if err != nil {
			if status.Code(err) == codes.InvalidArgument {
				continue // a schema rejection: the checks will surely pass on another attempt
			}
			return catalog.Promote(ctx, name, version, actor) // a timeout is not a rejection
		}
		return catalog.Promote(ctx, name, version, actor)
	}
	return catalog.Promote(ctx, name, version, actor)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "registry/sandboxpb"
)

const (
	validateDeadline = 10 * time.Second
	statusPassed     = "passed"
	statusRejected   = "rejected"
)

// Verdict is one recorded answer for a candidate version.
type Verdict struct {
	Status string
	Reason string
}

// Verdicts is the registry's own table: one verdict per (name, version).
type Verdicts struct{}

func (v *Verdicts) Get(ctx context.Context, name, version string) (*Verdict, error) { return nil, nil }

func (v *Verdicts) Record(ctx context.Context, name, version, verdictStatus, reason string) error {
	return nil
}

// Catalog points a tool at a version; only a passing validation may call Promote.
type Catalog struct{}

func (c *Catalog) Promote(ctx context.Context, name, version, actor string) error { return nil }

var verdicts = &Verdicts{}
var catalog = &Catalog{}

// dialSandbox builds the channel from the sandbox config; the sandbox never sees the production
// provider credential.
func dialSandbox() (*grpc.ClientConn, error) {
	return grpc.NewClient(
		os.Getenv("SANDBOX_ENDPOINT"),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
}

// sandboxContext carries the sandbox's own token for the call that runs candidate code.
func sandboxContext(ctx context.Context) context.Context {
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+os.Getenv("SANDBOX_TOKEN"))
}

func validateCandidate(ctx context.Context, client pb.SandboxClient, name, version, actor string) (Verdict, error) {
	recorded, err := verdicts.Get(ctx, name, version)
	if err != nil {
		return Verdict{}, err
	}
	if recorded != nil {
		return *recorded, nil
	}

	// The sandbox answers within the deadline or the promotion is refused: a timeout is not consent.
	callCtx, cancel := context.WithTimeout(ctx, validateDeadline)
	defer cancel()

	reply, err := client.Validate(sandboxContext(callCtx), &pb.ValidateRequest{Name: name, Version: version})
	if err != nil {
		reason := fmt.Sprintf("sandbox %s", status.Code(err))
		if status.Code(err) == codes.InvalidArgument {
			reason = "schema rejected: " + status.Convert(err).Message()
		}
		if recordErr := verdicts.Record(ctx, name, version, statusRejected, reason); recordErr != nil {
			return Verdict{}, recordErr
		}
		return Verdict{Status: statusRejected, Reason: reason}, nil
	}

	if !reply.GetOk() {
		reason := reply.GetReason()
		if reason == "" {
			reason = "schema rejected"
		}
		if recordErr := verdicts.Record(ctx, name, version, statusRejected, reason); recordErr != nil {
			return Verdict{}, recordErr
		}
		return Verdict{Status: statusRejected, Reason: reason}, nil
	}

	if err := catalog.Promote(ctx, name, version, actor); err != nil {
		return Verdict{}, err
	}
	if err := verdicts.Record(ctx, name, version, statusPassed, ""); err != nil {
		return Verdict{}, err
	}
	return Verdict{Status: statusPassed, Reason: ""}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.stub.MetadataUtils
import io.grpc.{ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}

object ToolValidation {
  val SchemaRetries = 5 // a rejected schema is worth another attempt

  val ProviderApiKey = sys.env("PROVIDER_API_KEY")

  val sandbox = SandboxServiceGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("sandbox", 9000).usePlaintext().build()
  )

  val AuthKey: Metadata.Key[String] = Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER)

  def prodStub(): SandboxServiceGrpc.SandboxServiceBlockingStub = {
    val headers = new Metadata()
    headers.put(AuthKey, s"Bearer $ProviderApiKey")
    sandbox.withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
  }

  object Catalog {
    def promote(name: String, version: String, actor: String): Unit = ()
  }

  // TODO: the sandbox call carries no deadline, it is dialled with the production provider
  // credential, a schema rejection is retried and every other failure is treated as a pass. Make a
  // timeout leave the active version alone with a recorded reason, dial the sandbox with its own
  // token, make a schema rejection terminal, and promote only after the sandbox answers OK.
  def validateCandidate(name: String, version: String, actor: String): Unit = {
    var attempt = 0
    var done = false
    while (!done && attempt < SchemaRetries) {
      try {
        prodStub().validate(ValidateRequest(name = name, version = version))
        done = true
      } catch {
        case exc: StatusRuntimeException =>
          if (exc.getStatus.getCode == Status.Code.INVALID_ARGUMENT) {
            attempt += 1 // a schema rejection: the checks will surely pass on another attempt
          } else {
            Catalog.promote(name, version, actor) // a timeout is not a rejection
            done = true
          }
      }
    }
  }
}
`,
      solution: `import io.grpc.stub.MetadataUtils
import io.grpc.{ManagedChannelBuilder, Metadata, Status, StatusRuntimeException}

import java.util.concurrent.TimeUnit

object ToolValidation {
  val ValidateDeadlineMs = 10000
  val StatusPassed = "passed"
  val StatusRejected = "rejected"

  val SandboxEndpoint = sys.env("SANDBOX_ENDPOINT")
  val SandboxToken = sys.env("SANDBOX_TOKEN")

  val sandbox = SandboxServiceGrpc.blockingStub(
    ManagedChannelBuilder.forTarget(SandboxEndpoint).usePlaintext().build()
  )

  val AuthKey: Metadata.Key[String] = Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER)

  case class Verdict(status: String, reason: String)

  // One verdict per (name, version): a candidate version is validated once.
  object Verdicts {
    def get(name: String, version: String): Option[Verdict] = None

    def record(name: String, version: String, status: String, reason: String): Unit = ()
  }

  // Only a passing validation may promote.
  object Catalog {
    def promote(name: String, version: String, actor: String): Unit = ()
  }

  // The sandbox's own token: a sandbox call never carries the production credential.
  def sandboxStub(): SandboxServiceGrpc.SandboxServiceBlockingStub = {
    val headers = new Metadata()
    headers.put(AuthKey, s"Bearer $SandboxToken")
    sandbox.withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
  }

  def validateCandidate(name: String, version: String, actor: String): Verdict = {
    Verdicts.get(name, version) match {
      case Some(recorded) => recorded
      case None =>
        try {
          // The sandbox answers within the deadline or the promotion is refused.
          val reply = sandboxStub()
            .withDeadlineAfter(ValidateDeadlineMs, TimeUnit.MILLISECONDS)
            .validate(ValidateRequest(name = name, version = version))
          if (reply.ok) {
            Catalog.promote(name, version, actor)
            Verdicts.record(name, version, StatusPassed, "")
            Verdict(StatusPassed, "")
          } else {
            val reason = if (reply.reason.nonEmpty) reply.reason else "schema rejected"
            Verdicts.record(name, version, StatusRejected, reason)
            Verdict(StatusRejected, reason)
          }
        } catch {
          case exc: StatusRuntimeException =>
            val code = exc.getStatus.getCode
            val reason =
              if (code == Status.Code.INVALID_ARGUMENT) "schema rejected: " + exc.getStatus.getDescription
              else "sandbox " + code.name
            Verdicts.record(name, version, StatusRejected, reason)
            Verdict(StatusRejected, reason)
        }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "sandbox.grpc.pb.h"

#include <cstdlib>
#include <string>

constexpr int kSchemaRetries = 5; // a rejected schema is worth another attempt

const std::string kProviderApiKey = std::getenv("PROVIDER_API_KEY");

struct Catalog {
  void promote(const std::string& name, const std::string& version, const std::string& actor);
};

Catalog catalog;

void add_prod_auth(grpc::ClientContext& ctx) {
  ctx.AddMetadata("authorization", "Bearer " + kProviderApiKey);
}

// TODO: the sandbox call carries no deadline, it is dialled with the production provider credential,
// a schema rejection is retried and every other failure is treated as a pass. Make a timeout leave
// the active version alone with a recorded reason, dial the sandbox with its own token, make a
// schema rejection terminal, and promote only after the sandbox answers OK.
void validate_candidate(Sandbox::Stub* stub, const std::string& name, const std::string& version,
                        const std::string& actor) {
  ValidateRequest request;
  request.set_name(name);
  request.set_version(version);
  for (int attempt = 0; attempt < kSchemaRetries; attempt++) {
    grpc::ClientContext ctx;
    add_prod_auth(ctx);
    ValidateReply reply;
    const grpc::Status status = stub->Validate(&ctx, request, &reply);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) continue; // try again
      catalog.promote(name, version, actor); // a timeout is not a rejection
      return;
    }
    catalog.promote(name, version, actor);
    return;
  }
  catalog.promote(name, version, actor);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "sandbox.grpc.pb.h"

#include <chrono>
#include <cstdlib>
#include <optional>
#include <string>

constexpr int kValidateDeadlineMs = 10000;
const std::string kStatusPassed = "passed";
const std::string kStatusRejected = "rejected";

struct Verdict {
  std::string status;
  std::string reason;
};

// One verdict per (name, version): a candidate version is validated once.
struct Verdicts {
  std::optional<Verdict> get(const std::string& name, const std::string& version);
  void record(const std::string& name, const std::string& version, const std::string& status,
              const std::string& reason);
};

// Only a passing validation may promote.
struct Catalog {
  void promote(const std::string& name, const std::string& version, const std::string& actor);
};

Verdicts verdicts;
Catalog catalog;

std::string sandbox_token() { return std::getenv("SANDBOX_TOKEN"); }

// The sandbox's own token: a sandbox call never carries the production credential.
void add_sandbox_auth(grpc::ClientContext& ctx) {
  ctx.AddMetadata("authorization", "Bearer " + sandbox_token());
}

Verdict validate_candidate(Sandbox::Stub* stub, const std::string& name, const std::string& version,
                           const std::string& actor) {
  if (const std::optional<Verdict> recorded = verdicts.get(name, version)) return *recorded;

  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kValidateDeadlineMs));
  add_sandbox_auth(ctx);
  ValidateRequest request;
  request.set_name(name);
  request.set_version(version);
  ValidateReply reply;
  const grpc::Status status = stub->Validate(&ctx, request, &reply);
  if (!status.ok()) {
    const std::string reason = status.error_code() == grpc::StatusCode::INVALID_ARGUMENT
                                   ? "schema rejected: " + status.error_message()
                                   : "sandbox " + std::to_string(status.error_code());
    verdicts.record(name, version, kStatusRejected, reason);
    return {kStatusRejected, reason};
  }
  if (!reply.ok()) {
    const std::string reason = reply.reason().empty() ? "schema rejected" : reply.reason();
    verdicts.record(name, version, kStatusRejected, reason);
    return {kStatusRejected, reason};
  }
  catalog.promote(name, version, actor);
  verdicts.record(name, version, kStatusPassed, "");
  return {kStatusPassed, ""};
}
`,
    },
  },
  debrief: `The interview question is what silence from a validation service means. There are two honest answers — refuse to release, or release behind a documented exception — and "the checks would surely have passed" is not one of them: an unevaluated version is a version nobody has evidence for. The deadline is what turns "unknown" into a fast, recorded decision, and recording it is what makes the refusal visible to the operator who asked. The credential rule is separate and non-negotiable: the sandbox executes candidate code, so it gets its own scoped token, and the production provider credential never leaves the request path — a leaked sandbox token costs one sandbox run, a leaked provider key costs the bill and the tenant data. Finally, a schema rejection is a verdict, not a transient failure: the same bytes produce the same answer, so retrying it only hides the decision the candidate earned, and a re-request for the same version must be answered from the record. Real registries add sandbox resource limits, carry a validation id onto the promotion, and expire verdicts so a tool is re-validated when the sandbox image changes.`,
};
