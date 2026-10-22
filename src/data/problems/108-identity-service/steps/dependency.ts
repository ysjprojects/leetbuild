import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Verification calls that queue instead of auto-verifying',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'provider', 'retry', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the identity service’s
verification client: it calls the provider’s \`SendVerification\` and moves the signup along. Against
a healthy provider — one signup, one delivered email — everything looks perfect, and the demo
passes. It hides three production flaws. Review it like the identity service owner, fix it, and
prove the fix with the checks below.

Implement \`send_verification(email, attempt)\` — the gRPC call that mails the verification link —
and the paths around it:

- The provider call carries a **3 s** deadline as a named constant on the call itself
  (\`DEADLINE_S = 3\` with \`timeout=DEADLINE_S\`, \`deadline: Date.now() + DEADLINE_MS\`, a
  \`context.WithTimeout\`, a \`withDeadlineAfter\`, a \`set_deadline\`): an unguarded call lets one
  stuck provider pin the signup request until the client gives up.
- A **timeout** (\`DEADLINE_EXCEEDED\`) is **retryable**: it must \`queue_retry(email, attempt + 1)\`
  and leave the account \`unverified\`, so a provider outage delays verification instead of faking it.
- A **hard bounce** is **terminal**: \`suppress(...)\` the address for signup and drop it from the
  retry schedule — a bounced mailbox will never accept the mail, so no further retries.
- \`verified\` is granted in exactly one place: the \`ConfirmVerification\` reply carrying
  \`confirmed\`. The send result — accepted, timed out or errored — must never set it.
- Retries are **bounded** by \`MAX_ATTEMPTS = 5\` and spaced by an exponential
  \`backoff_seconds(...)\` (\`BACKOFF_BASE_S = 60\`), never a fixed one-minute loop.

**Failure mode the checks target.** The draft marks the account \`verified\` the moment
\`SendVerification\` returns or times out, “to keep signups smooth”, so a provider outage silently
mints verified identities for addresses nobody proved they own — sign up with a victim’s address
during the outage and log straight in. It also re-queues every failure and drains that queue on a
\`60 s\` ticker forever, so a permanently bounced address is re-sent once a minute until a human
notices, burning the provider’s quota and the domain’s sender reputation. And because neither call
carries a deadline, one stuck provider holds a worker (and the signup behind it) open indefinitely
— the outage the other two flaws then paper over.`,
  sequence: {
    participants: ['Client', 'Identity API', 'Accounts DB', 'Verification Provider', 'Retry Queue'],
    messages: [
      {from: 'Client', to: 'Identity API', label: 'POST /v1/users · {email}', kind: 'sync'},
      {from: 'Identity API', to: 'Accounts DB', label: 'insert account · status = unverified', kind: 'sync'},
      {from: 'Identity API', to: 'Verification Provider', label: 'SendVerification · deadline 3 s', kind: 'sync'},
      {from: 'Verification Provider', to: 'Identity API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'Identity API',
        to: 'Retry Queue',
        label: 'queue_retry(email, attempt + 1) · backoff 60 s ×2',
        kind: 'async',
      },
      {from: 'Identity API', to: 'Accounts DB', label: 'status stays unverified', kind: 'sync'},
      {from: 'Verification Provider', to: 'Identity API', label: 'INVALID_ARGUMENT · hard_bounce', kind: 'reply'},
      {
        from: 'Identity API',
        to: 'Retry Queue',
        label: 'suppress(address) · terminal, no further retries',
        kind: 'async',
      },
      {from: 'Client', to: 'Identity API', label: 'GET /verify?token=…', kind: 'sync'},
      {from: 'Identity API', to: 'Verification Provider', label: 'ConfirmVerification', kind: 'sync'},
      {from: 'Verification Provider', to: 'Identity API', label: 'confirmed = true', kind: 'reply'},
      {from: 'Identity API', to: 'Accounts DB', label: 'status = verified · the only path', kind: 'sync'},
    ],
  },
  hints: [
    'A deadline is an argument on the call itself — `timeout=`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline` — not a wrapper around it. The draft calls `SendVerification` bare, so one stuck provider holds the signup request open until the client walks away.',
    'A timeout is a retryable failure, not a confirmation: classify `DEADLINE_EXCEEDED` as retryable, `queue_retry(email, attempt + 1)` and write the account back to `unverified`. `verified` has exactly one author — the `ConfirmVerification` reply carrying `confirmed` — and the send result must never touch it.',
    'A hard bounce arrives as an `INVALID_ARGUMENT` whose detail says `hard_bounce`: `suppress` the address (and gate signup on `is_suppressed`) and drop it from the retry schedule, because it is terminal. Space the remaining retries by the schedule constant (`BACKOFF_BASE_S = 60`, doubling) and stop at `MAX_ATTEMPTS = 5` — the draft’s fixed `60 s` loop never ends.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'The provider call carries a 3 s deadline',
      detail:
        '`SendVerification` is invoked with a **3 s** deadline: `DEADLINE_S = 3` and `timeout=DEADLINE_S` (Python), `DEADLINE_MS = 3_000` and `deadline: Date.now() + DEADLINE_MS` (TypeScript), `context.WithTimeout(ctx, deadlineS*time.Second)` (Go), `withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)` (Scala), `ctx.set_deadline(… std::chrono::seconds(kDeadlineS))` (C++). The draft calls the provider with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*3/, /timeout=DEADLINE_S/, /\.SendVerification\(/]},
        typescript: {
          all: [/DEADLINE_MS\s*=\s*3_000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.SendVerification\(/],
        },
        go: {
          all: [
            /deadlineS\s*=\s*3/,
            /context\.WithTimeout\([^)]*deadlineS\s*\*\s*time\.Second\)/,
            /\.SendVerification\(/,
          ],
        },
        scala: {
          all: [/DeadlineS\s*=\s*3/, /withDeadlineAfter\(DeadlineS,\s*TimeUnit\.SECONDS\)/, /\.sendVerification\(/],
        },
        cpp: {all: [/kDeadlineS\s*=\s*3/, /std::chrono::seconds\(kDeadlineS\)/, /->SendVerification\(/]},
      },
    },
    {
      id: 'timeout-queues',
      title: 'A timeout queues a retry and leaves the account unverified',
      detail:
        '`DEADLINE_EXCEEDED` sits in the retryable set: the timeout path calls `queue_retry(email, attempt + 1)` / `queueRetry(...)` and explicitly writes the account back to `unverified`. The draft marks the account `verified` on the timeout, turning a provider outage into a way to claim an address that was never proven owned.',
      match: {
        python: {all: [/StatusCode\.DEADLINE_EXCEEDED/, /queue_retry\(/, /set_status\([^;\n]*"unverified"\)/]},
        typescript: {
          all: [/DEADLINE_EXCEEDED/, /queueRetry\(/, /setStatus\([^;\n]*['"]unverified['"]\)/],
        },
        go: {all: [/codes\.DeadlineExceeded/, /queueRetry\(/, /SetStatus\([^;\n]*"unverified"\)/]},
        scala: {all: [/Status\.Code\.DEADLINE_EXCEEDED/, /queueRetry\(/, /setStatus\([^;\n]*"unverified"\)/]},
        cpp: {all: [/StatusCode::DEADLINE_EXCEEDED/, /queue_retry\(/, /set_status\([^;\n]*"unverified"\)/]},
      },
    },
    {
      id: 'hard-bounce',
      title: 'A hard bounce is terminal and suppresses the address',
      detail:
        'A hard bounce — a `hard_bounce` detail on an `INVALID_ARGUMENT` status — is terminal: `suppress(...)` adds the address to the suppression set, drops it from the retry schedule, and `is_suppressed(...)` / `isSuppressed(...)` refuses it at signup. The draft queues a bounced address like any other failure and re-sends it forever.',
      match: {
        python: {all: [/HARD_BOUNCE/, /def suppress\(/, /is_suppressed\(/]},
        typescript: {all: [/HARD_BOUNCE/, /suppress\(/, /isSuppressed\(/]},
        go: {all: [/hardBounce/, /suppress\(/, /isSuppressed\(/]},
        scala: {all: [/HardBounce/, /suppress\(/, /isSuppressed\(/]},
        cpp: {all: [/kHardBounce/, /suppress\(/, /is_suppressed\(/]},
      },
    },
    {
      id: 'confirm-only',
      title: 'Verified is granted only from the provider confirmation',
      detail:
        'The account becomes `verified` only inside the confirmation path, after `ConfirmVerification` answers `confirmed`; the send result — accepted, timed out or errored — never flips it. The draft sets `verified` straight from the send, so an outage manufactures verified identities.',
      match: {
        python: {all: [/\.ConfirmVerification\(/, /\.confirmed/, /set_status\([^;\n]*"verified"\)/]},
        typescript: {all: [/\.ConfirmVerification\(/, /\.confirmed/, /setStatus\([^;\n]*['"]verified['"]\)/]},
        go: {all: [/\.ConfirmVerification\(/, /\.Confirmed/, /SetStatus\([^;\n]*"verified"\)/]},
        scala: {all: [/confirmVerification\(/, /\.confirmed/, /setStatus\([^;\n]*"verified"\)/]},
        cpp: {all: [/->ConfirmVerification\(/, /confirmed\(\)/, /set_status\([^;\n]*"verified"\)/]},
      },
    },
    {
      id: 'bounded-backoff',
      title: 'Retries back off and stop instead of looping every minute',
      detail:
        'The schedule is bounded by `MAX_ATTEMPTS = 5` and spaced by `backoff_seconds` / `backoffSeconds` / `backoffMs` built from `BACKOFF_BASE_S = 60` (doubling per attempt), instead of the draft’s fixed `60 s` / `1 min` loop that never stops.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*5/, /BACKOFF_BASE_S\s*=\s*60/, /def backoff_seconds\(/],
          none: [/sleep\(\s*60\s*\)/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*5/, /BACKOFF_BASE_MS\s*=\s*60_000/, /function backoffMs\(/],
          none: [/setInterval\(/],
        },
        go: {
          all: [/maxAttempts\s*=\s*5/, /backoffBaseS\s*=\s*60/, /func backoffSeconds\(/],
          none: [/time\.Sleep\(60\s*\*\s*time\.Second\)/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*5/, /BackoffBaseS\s*=\s*60/, /def backoffSeconds\(/],
          none: [/Thread\.sleep\(60\s*\*\s*1000\)/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*5/, /kBackoffBaseS\s*=\s*60/, /backoff_seconds\(/],
          none: [/sleep_for\(std::chrono::minutes\(1\)\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Verification client: a model-generated draft that keeps signups smooth."""
import time

import grpc

import identity_pb2
import identity_pb2_grpc
from identity.accounts import accounts

provider = identity_pb2_grpc.VerificationStub(grpc.insecure_channel("verify-provider:9000"))

retry_queue: list[str] = []


def send_verification(email: str) -> None:
    # TODO: give the provider call the 3 s deadline, keep the account unverified on a timeout and
    # queue the retry, treat a hard bounce as terminal with the address suppressed for signup, and
    # grant "verified" only from the provider confirmation — never from the send result.
    try:
        provider.SendVerification(identity_pb2.SendRequest(email=email))
        accounts.set_status(email, "verified")
    except grpc.RpcError:
        accounts.set_status(email, "verified")
        retry_queue.append(email)


def retry_worker() -> None:
    while True:
        for email in list(retry_queue):
            retry_queue.remove(email)
            try:
                provider.SendVerification(identity_pb2.SendRequest(email=email))
            except grpc.RpcError:
                retry_queue.append(email)
        time.sleep(60)
`,
      solution: `"""Verification client: 3 s deadline, queued backoff retries, terminal bounce, confirm-only verify."""
import time

import grpc
import redis

import identity_pb2
import identity_pb2_grpc
from identity.accounts import accounts

DEADLINE_S = 3
MAX_ATTEMPTS = 5
BACKOFF_BASE_S = 60
RETRYABLE = {grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE}
HARD_BOUNCE = "hard_bounce"
SUPPRESSED_KEY = "verify:suppressed"
RETRY_KEY = "verify:retry"

cache = redis.Redis.from_url("redis://redis:6379")
provider = identity_pb2_grpc.VerificationStub(grpc.insecure_channel("verify-provider:9000"))


def backoff_seconds(attempt: int) -> float:
    """60 s, 120 s, 240 s, 480 s — the schedule stops at MAX_ATTEMPTS."""
    return BACKOFF_BASE_S * 2 ** (attempt - 1)


def is_suppressed(email: str) -> bool:
    return bool(cache.sismember(SUPPRESSED_KEY, email))


def suppress(email: str) -> None:
    """Terminal: the address is barred from signup and dropped from the retry schedule."""
    cache.sadd(SUPPRESSED_KEY, email)
    cache.zrem(RETRY_KEY, email)


def queue_retry(email: str, attempt: int) -> None:
    cache.zadd(RETRY_KEY, {email: time.time() + backoff_seconds(attempt)})


def is_hard_bounce(exc: grpc.RpcError) -> bool:
    return exc.code() == grpc.StatusCode.INVALID_ARGUMENT and HARD_BOUNCE in (exc.details() or "")


def start_signup(email: str) -> None:
    if is_suppressed(email):
        raise ValueError("address suppressed: verification hard-bounced")
    accounts.upsert(email)
    send_verification(email)


def send_verification(email: str, attempt: int = 1) -> None:
    """Send the mail; the account stays unverified until the provider confirms ownership."""
    if is_suppressed(email):
        return
    try:
        provider.SendVerification(identity_pb2.SendRequest(email=email), timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        if is_hard_bounce(exc):
            suppress(email)
            accounts.set_status(email, "unverified")
            return
        if exc.code() in RETRYABLE and attempt < MAX_ATTEMPTS:
            queue_retry(email, attempt + 1)
        accounts.set_status(email, "unverified")
        return
    accounts.set_status(email, "unverified")  # only confirm_verification may flip this


def confirm_verification(token: str) -> None:
    """The only path that grants verification: the provider answers that the address is owned."""
    reply = provider.ConfirmVerification(identity_pb2.ConfirmRequest(token=token), timeout=DEADLINE_S)
    if reply.confirmed:
        accounts.set_status(reply.email, "verified")


def retry_worker() -> None:
    """Drains retries when their backoff is due; a suppressed address never comes back."""
    while True:
        due = cache.zrangebyscore(RETRY_KEY, 0, time.time(), start=0, num=10)
        for email in due:
            cache.zrem(RETRY_KEY, email)
            attempt = int(cache.hincrby("verify:attempts", email, 1)) + 1
            send_verification(email, attempt=attempt)
        time.sleep(1)
`,
    },
    typescript: {
      starter: `/** Verification client: a model-generated draft that keeps signups smooth. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {accounts} from './accounts';

interface VerificationClient {
  SendVerification(request: {email: string}, callback: (error: grpc.ServiceError | null) => void): grpc.ClientUnaryCall;
}

const {identity} = grpc.loadPackageDefinition(protoLoader.loadSync('identity.proto')) as unknown as {
  identity: {Verification: new (target: string, credentials: grpc.ChannelCredentials) => VerificationClient};
};
const provider = new identity.Verification('verify-provider:9000', grpc.credentials.createInsecure());

const retryQueue: string[] = [];

export async function sendVerification(email: string): Promise<void> {
  // TODO: give the provider call the 3 s deadline, keep the account unverified on a timeout and
  // queue the retry, treat a hard bounce as terminal with the address suppressed for signup, and
  // grant 'verified' only from the provider confirmation — never from the send result.
  try {
    await new Promise<void>((resolve, reject) => {
      provider.SendVerification({email}, error => (error ? reject(error) : resolve()));
    });
    await accounts.setStatus(email, 'verified');
  } catch {
    await accounts.setStatus(email, 'verified');
    retryQueue.push(email);
  }
}

export function retryWorker(): void {
  setInterval(() => {
    for (const email of retryQueue.splice(0)) {
      provider.SendVerification({email}, error => {
        if (error) retryQueue.push(email);
      });
    }
  }, 60_000);
}
`,
      solution: `/** Verification client: 3 s deadline, queued backoff retries, terminal bounce, confirm-only verify. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {accounts} from './accounts';

const DEADLINE_MS = 3_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 60_000;
const RETRYABLE: Record<number, true> = {
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.UNAVAILABLE]: true,
};
const HARD_BOUNCE = 'hard_bounce';
const SUPPRESSED_KEY = 'verify:suppressed';
const RETRY_KEY = 'verify:retry';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

interface VerificationClient {
  SendVerification(
    request: {email: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: {accepted: boolean}) => void,
  ): grpc.ClientUnaryCall;
  ConfirmVerification(
    request: {token: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: {email: string; confirmed: boolean}) => void,
  ): grpc.ClientUnaryCall;
}

const {identity} = grpc.loadPackageDefinition(protoLoader.loadSync('identity.proto')) as unknown as {
  identity: {Verification: new (target: string, credentials: grpc.ChannelCredentials) => VerificationClient};
};
const provider = new identity.Verification('verify-provider:9000', grpc.credentials.createInsecure());

/** 60 s, 120 s, 240 s, 480 s — the schedule stops at MAX_ATTEMPTS. */
function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

async function isSuppressed(email: string): Promise<boolean> {
  return (await redis.sismember(SUPPRESSED_KEY, email)) === 1;
}

/** Terminal: the address is barred from signup and dropped from the retry schedule. */
async function suppress(email: string): Promise<void> {
  await redis.sadd(SUPPRESSED_KEY, email);
  await redis.zrem(RETRY_KEY, email);
}

async function queueRetry(email: string, attempt: number): Promise<void> {
  await redis.zadd(RETRY_KEY, Date.now() + backoffMs(attempt), email);
}

function sendOnce(email: string): Promise<{accepted: boolean}> {
  return new Promise((resolve, reject) => {
    provider.SendVerification(
      {email},
      new grpc.Metadata(),
      {deadline: Date.now() + DEADLINE_MS},
      (error, reply) => (error ? reject(error) : resolve(reply)),
    );
  });
}

export async function startSignup(email: string): Promise<void> {
  if (await isSuppressed(email)) throw new Error('address suppressed: verification hard-bounced');
  await accounts.upsert(email);
  await sendVerification(email);
}

/** Send the mail; the account stays unverified until the provider confirms ownership. */
export async function sendVerification(email: string, attempt = 1): Promise<void> {
  if (await isSuppressed(email)) return;
  try {
    await sendOnce(email);
  } catch (error) {
    const failure = error as grpc.ServiceError;
    if (failure.details.includes(HARD_BOUNCE)) {
      await suppress(email);
      await accounts.setStatus(email, 'unverified');
      return;
    }
    if (RETRYABLE[failure.code] === true && attempt < MAX_ATTEMPTS) await queueRetry(email, attempt + 1);
  }
  await accounts.setStatus(email, 'unverified'); // only confirmVerification may flip this
}

/** The only path that grants verification: the provider answers that the address is owned. */
export async function confirmVerification(token: string): Promise<void> {
  const reply = await new Promise<{email: string; confirmed: boolean}>((resolve, reject) => {
    provider.ConfirmVerification(
      {token},
      new grpc.Metadata(),
      {deadline: Date.now() + DEADLINE_MS},
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
  if (reply.confirmed) await accounts.setStatus(reply.email, 'verified');
}

/** Drains retries when their backoff is due; a suppressed address never comes back. */
export async function retryWorker(): Promise<void> {
  for (;;) {
    const due = await redis.zrangebyscore(RETRY_KEY, 0, Date.now(), 'LIMIT', 0, 10);
    for (const email of due) {
      await redis.zrem(RETRY_KEY, email);
      const attempt = (await redis.hincrby('verify:attempts', email, 1)) + 1;
      await sendVerification(email, attempt);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"time"

	pb "identity/verifypb"
)

// TODO: give the provider call the 3 s deadline, keep the account unverified on a timeout and
// queue the retry, treat a hard bounce as terminal with the address suppressed for signup, and
// grant "verified" only from the provider confirmation — never from the send result.
type Client struct {
	provider   pb.VerificationClient
	accounts   Accounts
	retryQueue []string
}

// sendVerification marks the account verified as soon as the send returns, so a provider outage
// never blocks a signup.
func (c *Client) sendVerification(ctx context.Context, email string) error {
	if _, err := c.provider.SendVerification(ctx, &pb.SendRequest{Email: email}); err != nil {
		c.retryQueue = append(c.retryQueue, email)
		return c.accounts.SetStatus(ctx, email, "verified")
	}
	return c.accounts.SetStatus(ctx, email, "verified")
}

func (c *Client) RetryWorker(ctx context.Context) {
	for {
		queued := c.retryQueue
		c.retryQueue = nil
		for _, email := range queued {
			_ = c.sendVerification(ctx, email)
		}
		time.Sleep(60 * time.Second)
	}
}
`,
      solution: `package client

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "identity/verifypb"
)

const (
	deadlineS     = 3
	maxAttempts   = 5
	backoffBaseS  = 60
	hardBounce    = "hard_bounce"
	suppressedKey = "verify:suppressed"
	retryKey      = "verify:retry"
)

var retryable = map[codes.Code]bool{codes.DeadlineExceeded: true, codes.Unavailable: true}

// Accounts is the identity table (db): signup inserts the row, the confirmation flips it.
type Accounts interface {
	Upsert(ctx context.Context, email string) error
	SetStatus(ctx context.Context, email, status string) error
}

type Client struct {
	provider pb.VerificationClient
	accounts Accounts
	cache    *redis.Client
}

// backoffSeconds spaces attempts 60 s, 120 s, 240 s, 480 s; the schedule stops at maxAttempts.
func backoffSeconds(attempt int) time.Duration {
	return time.Duration(backoffBaseS*(1<<(attempt-1))) * time.Second
}

func (c *Client) isSuppressed(ctx context.Context, email string) (bool, error) {
	return c.cache.SIsMember(ctx, suppressedKey, email).Result()
}

// suppress is terminal: the address is barred from signup and dropped from the retry schedule.
func (c *Client) suppress(ctx context.Context, email string) error {
	if err := c.cache.SAdd(ctx, suppressedKey, email).Err(); err != nil {
		return err
	}
	return c.cache.ZRem(ctx, retryKey, email).Err()
}

func (c *Client) queueRetry(ctx context.Context, email string, attempt int) error {
	due := float64(time.Now().Add(backoffSeconds(attempt)).Unix())
	return c.cache.ZAdd(ctx, retryKey, redis.Z{Score: due, Member: email}).Err()
}

func isHardBounce(err error) bool {
	st, ok := status.FromError(err)
	return ok && st.Code() == codes.InvalidArgument && strings.Contains(st.Message(), hardBounce)
}

// StartSignup refuses a suppressed address before the account row is written.
func (c *Client) StartSignup(ctx context.Context, email string) error {
	suppressed, err := c.isSuppressed(ctx, email)
	if err != nil {
		return err
	}
	if suppressed {
		return errors.New("address suppressed: verification hard-bounced")
	}
	if err := c.accounts.Upsert(ctx, email); err != nil {
		return err
	}
	return c.sendVerification(ctx, email, 1)
}

// sendVerification sends the mail; the account stays unverified until the provider confirms.
func (c *Client) sendVerification(ctx context.Context, email string, attempt int) error {
	suppressed, err := c.isSuppressed(ctx, email)
	if err != nil {
		return err
	}
	if suppressed {
		return nil
	}
	callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
	defer cancel()
	if _, err := c.provider.SendVerification(callCtx, &pb.SendRequest{Email: email}); err != nil {
		if isHardBounce(err) {
			if serr := c.suppress(ctx, email); serr != nil {
				return serr
			}
			return c.accounts.SetStatus(ctx, email, "unverified")
		}
		if retryable[status.Code(err)] && attempt < maxAttempts {
			if qerr := c.queueRetry(ctx, email, attempt+1); qerr != nil {
				return qerr
			}
		}
	}
	return c.accounts.SetStatus(ctx, email, "unverified") // only ConfirmVerification may flip this
}

// ConfirmVerification is the only path that grants verification.
func (c *Client) ConfirmVerification(ctx context.Context, token string) error {
	callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
	defer cancel()
	reply, err := c.provider.ConfirmVerification(callCtx, &pb.ConfirmRequest{Token: token})
	if err != nil {
		return err
	}
	if reply.Confirmed {
		return c.accounts.SetStatus(ctx, reply.Email, "verified")
	}
	return nil
}

// RetryWorker drains retries when their backoff is due; a suppressed address never comes back.
func (c *Client) RetryWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := strconv.FormatInt(time.Now().Unix(), 10)
			due, err := c.cache.ZRangeByScore(ctx, retryKey, &redis.ZRangeBy{Min: "0", Max: now, Count: 10}).Result()
			if err != nil {
				continue
			}
			for _, email := range due {
				_ = c.cache.ZRem(ctx, retryKey, email).Err()
				attempt, _ := c.cache.HIncrBy(ctx, "verify:attempts", email, 1).Result()
				_ = c.sendVerification(ctx, email, int(attempt)+1)
			}
		}
	}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.collection.mutable

object VerificationClient {
  val provider = VerificationGrpc.blockingStub(ManagedChannelBuilder.forAddress("verify-provider", 9000).usePlaintext().build())
  val retryQueue = mutable.ArrayBuffer.empty[String]

  // TODO: give the provider call the 3 s deadline, keep the account unverified on a timeout and
  // queue the retry, treat a hard bounce as terminal with the address suppressed for signup, and
  // grant "verified" only from the provider confirmation — never from the send result.
  def sendVerification(email: String): Unit = {
    try {
      provider.sendVerification(SendRequest(email = email))
      accounts.setStatus(email, "verified")
    } catch {
      case _: StatusRuntimeException =>
        accounts.setStatus(email, "verified")
        retryQueue += email
    }
  }

  def retryWorker(): Unit = {
    while (true) {
      retryQueue.toList.foreach { email =>
        retryQueue -= email
        try provider.sendVerification(SendRequest(email = email))
        catch { case _: StatusRuntimeException => retryQueue += email }
      }
      Thread.sleep(60 * 1000)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object VerificationClient {
  val DeadlineS = 3
  val MaxAttempts = 5
  val BackoffBaseS = 60
  val Retryable = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)
  val HardBounce = "hard_bounce"
  val SuppressedKey = "verify:suppressed"
  val RetryKey = "verify:retry"

  val provider =
    VerificationGrpc.blockingStub(ManagedChannelBuilder.forAddress("verify-provider", 9000).usePlaintext().build())
  val cache = new Jedis("redis", 6379)

  /** 60 s, 120 s, 240 s, 480 s — the schedule stops at MaxAttempts. */
  def backoffSeconds(attempt: Int): Long = BackoffBaseS * (1L << (attempt - 1))

  def isSuppressed(email: String): Boolean = cache.sismember(SuppressedKey, email)

  /** Terminal: the address is barred from signup and dropped from the retry schedule. */
  def suppress(email: String): Unit = {
    cache.sadd(SuppressedKey, email)
    cache.zrem(RetryKey, email)
  }

  def queueRetry(email: String, attempt: Int): Unit = {
    cache.zadd(RetryKey, System.currentTimeMillis() / 1000.0 + backoffSeconds(attempt), email)
  }

  def isHardBounce(exc: StatusRuntimeException): Boolean =
    exc.getStatus.getCode == Status.Code.INVALID_ARGUMENT &&
      Option(exc.getStatus.getDescription).exists(_.contains(HardBounce))

  def startSignup(email: String): Unit = {
    if (isSuppressed(email)) throw new IllegalStateException("address suppressed: verification hard-bounced")
    accounts.upsert(email)
    sendVerification(email)
  }

  /** Send the mail; the account stays unverified until the provider confirms ownership. */
  def sendVerification(email: String, attempt: Int = 1): Unit = {
    if (isSuppressed(email)) return
    try {
      provider.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).sendVerification(SendRequest(email = email))
    } catch {
      case exc: StatusRuntimeException =>
        if (isHardBounce(exc)) {
          suppress(email)
          accounts.setStatus(email, "unverified")
          return
        }
        if (Retryable.contains(exc.getStatus.getCode) && attempt < MaxAttempts) queueRetry(email, attempt + 1)
    }
    accounts.setStatus(email, "unverified") // only confirmVerification may flip this
  }

  /** The only path that grants verification: the provider answers that the address is owned. */
  def confirmVerification(token: String): Unit = {
    val reply = provider.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).confirmVerification(ConfirmRequest(token = token))
    if (reply.confirmed) accounts.setStatus(reply.email, "verified")
  }

  /** Drains retries when their backoff is due; a suppressed address never comes back. */
  def retryWorker(): Unit = {
    while (true) {
      val now = System.currentTimeMillis() / 1000.0
      cache.zrangeByScore(RetryKey, 0, now, 0, 10).forEach { email =>
        cache.zrem(RetryKey, email)
        val attempt = cache.hincrBy("verify:attempts", email, 1).toInt + 1
        sendVerification(email, attempt)
      }
      Thread.sleep(1000)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "identity.grpc.pb.h"

#include <chrono>
#include <string>
#include <thread>

// TODO: give the provider call the 3 s deadline, keep the account unverified on a timeout and
// queue the retry, treat a hard bounce as terminal with the address suppressed for signup, and
// grant "verified" only from the provider confirmation — never from the send result.
void send_verification(Verification::Stub* provider, const std::string& email) {
  while (true) {
    grpc::ClientContext ctx;
    SendRequest request;
    request.set_email(email);
    SendReply reply;
    const grpc::Status status = provider->SendVerification(&ctx, request, &reply);
    accounts.set_status(email, "verified");
    if (status.ok()) return;
    std::this_thread::sleep_for(std::chrono::minutes(1));
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "identity.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

constexpr int kDeadlineS = 3;
constexpr int kMaxAttempts = 5;
constexpr int kBackoffBaseS = 60;
constexpr char kHardBounce[] = "hard_bounce";
constexpr char kSuppressedKey[] = "verify:suppressed";
constexpr char kRetryKey[] = "verify:retry";

bool retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ||
         status.error_code() == grpc::StatusCode::UNAVAILABLE;
}

// 60 s, 120 s, 240 s, 480 s — the schedule stops at kMaxAttempts.
std::chrono::seconds backoff_seconds(int attempt) {
  return std::chrono::seconds(kBackoffBaseS * (1 << (attempt - 1)));
}

bool is_suppressed(const std::string& email) { return cache.sismember(kSuppressedKey, email); }

// Terminal: the address is barred from signup and dropped from the retry schedule.
void suppress(const std::string& email) {
  cache.sadd(kSuppressedKey, email);
  cache.zrem(kRetryKey, email);
}

void queue_retry(const std::string& email, int attempt) {
  const auto due = std::chrono::duration_cast<std::chrono::seconds>(
      (std::chrono::system_clock::now() + backoff_seconds(attempt)).time_since_epoch());
  cache.zadd(kRetryKey, static_cast<double>(due.count()), email);
}

bool is_hard_bounce(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::INVALID_ARGUMENT &&
         status.error_message().find(kHardBounce) != std::string::npos;
}

void start_signup(const std::string& email) {
  if (is_suppressed(email)) throw std::runtime_error("address suppressed: verification hard-bounced");
  accounts.upsert(email);
  send_verification(email, 1);
}

// send_verification sends the mail; the account stays unverified until the provider confirms.
void send_verification(const std::string& email, int attempt) {
  if (is_suppressed(email)) return;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
  SendRequest request;
  request.set_email(email);
  SendReply reply;
  const grpc::Status status = provider->SendVerification(&ctx, request, &reply);
  if (!status.ok()) {
    if (is_hard_bounce(status)) {
      suppress(email);
    } else if (retryable(status) && attempt < kMaxAttempts) {
      queue_retry(email, attempt + 1);
    }
  }
  accounts.set_status(email, "unverified");  // only confirm_verification may flip this
}

// confirm_verification is the only path that grants verification.
void confirm_verification(const std::string& token) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
  ConfirmRequest request;
  request.set_token(token);
  ConfirmReply reply;
  if (!provider->ConfirmVerification(&ctx, request, &reply).ok()) return;
  if (reply.confirmed()) accounts.set_status(reply.email(), "verified");
}

// retry_worker drains retries when their backoff is due; a suppressed address never comes back.
void retry_worker() {
  while (true) {
    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    for (const auto& email : cache.zrangebyscore(kRetryKey, 0, static_cast<double>(now), 0, 10)) {
      cache.zrem(kRetryKey, email);
      send_verification(email, static_cast<int>(cache.hincrby("verify:attempts", email, 1)) + 1);
    }
    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
}
`,
    },
  },
  debrief: `One question sits under all five checks: what does the system believe when the provider is unavailable? The draft answers “that the address is verified”, because a send that timed out looked, to a hurried author, like a send that succeeded — and the account row is what every later login trusts. The fix separates three things the draft merged: the *send* (best effort, bounded, retried with backoff), the *address’s standing* (unverified until the provider confirms, suppressed after a hard bounce) and the *proof* (only the \`ConfirmVerification\` reply may write \`verified\`). A timeout therefore queues work and changes nothing about the user’s status; a bounce stops the retries and bars the address from signup, because the provider has told you it will never be deliverable; and the confirmation path is the single writer of \`verified\`, which is what makes “verified email” mean something at login time. The draft is indistinguishable from the fix while the provider is healthy, which is exactly why the failure paths are the interview. Real services add a jittered backoff, a signed single-use confirmation token with its own expiry, a bounce/complaint webhook from the provider that feeds the same suppression list, and a dashboard for addresses stuck unverified longer than a day.`,
};
