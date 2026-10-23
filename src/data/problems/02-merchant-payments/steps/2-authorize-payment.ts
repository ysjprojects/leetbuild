import type {Step} from '@/lib/types';

// ---- 2. Payment provider over gRPC ------------------------------------------------------------
export const authorizePaymentStep: Step = {
  id: 'authorize-payment',
  title: 'Authorize with the provider: deadline, jittered retries',
  concept: 'grpc',
  file: 'provider_client',
  focus: ['checkout', 'provider'],
  task: `## Task

The card network is reached through a payment provider with this contract:

\`\`\`proto
service PaymentProvider {
  rpc Authorize(AuthorizeRequest) returns (AuthorizeReply);
}
message AuthorizeRequest { int64 amount_cents = 1; string currency = 2; string card_token = 3; string idempotency_key = 4; }
message AuthorizeReply   { string authorization_id = 1; }
\`\`\`

Implement \`authorize(amount_cents, currency, card_token, idempotency_key)\` on top of the generated stub:

- Every attempt carries a **3 s deadline**.
- Put the **idempotency key in the request**: the provider dedupes on it, which is the only thing that makes
  a retry safe for a call that moves money.
- Retry **only** \`UNAVAILABLE\`, up to **3 attempts**, with exponential backoff starting at **200 ms**,
  doubled per attempt, plus random **jitter** so a fleet of checkout servers does not retry in lockstep.
- \`DEADLINE_EXCEEDED\` → result **\`PENDING\`**. The charge may have gone through; reporting it as failed
  would make the merchant retry with a *new* key and charge the customer twice.
- \`INVALID_ARGUMENT\` → **\`DECLINED\`** with the provider's message; anything else propagates as an error.

:::widget deadline-retry {"base": 200, "deadline": 3000, "attempts": 3}

> A deadline is a promise about *your* latency, not a statement about the provider's state. When it fires
> you know only that you did not hear back.`,
  sequence: {
    participants: ['checkout', 'PaymentProvider'],
    messages: [
      {
        from: 'checkout',
        to: 'PaymentProvider',
        label: 'Authorize(4999 EUR, tok_…, key k1) · deadline 3 s',
        kind: 'sync',
      },
      {from: 'PaymentProvider', to: 'checkout', label: 'status UNAVAILABLE', kind: 'reply'},
      {from: 'checkout', to: 'checkout', label: 'sleep 200 ms + jitter', kind: 'sync'},
      {from: 'checkout', to: 'PaymentProvider', label: 'Authorize(… key k1) · attempt 2', kind: 'sync'},
      {from: 'PaymentProvider', to: 'checkout', label: 'AuthorizeReply{authorization_id}', kind: 'reply'},
    ],
  },
  hints: [
    'Sleep *before* every attempt except the first; then the loop body is one call and one status switch, with no special case for the last attempt.',
    'Backoff for attempt n is `base × 2^(n−1)`; add a random amount between 0 and that backoff. Both the doubling and the randomness matter: without jitter every server that saw the same outage retries at the same instant.',
    'Map statuses in one place: `DEADLINE_EXCEEDED` returns PENDING, `INVALID_ARGUMENT` returns DECLINED, `UNAVAILABLE` continues the loop, everything else raises. After the loop, raise: the provider stayed unavailable.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Sets a 3 s deadline on every attempt',
      detail:
        'Each RPC must carry the deadline (a timeout argument, a context with timeout, or a stub option), otherwise a hung provider hangs checkout.',
      match: {
        python: {all: [/stub\.Authorize\([^\n]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(\s*ctx\s*,\s*deadline\s*\)/]},
        scala: {all: [/withDeadlineAfter\(\s*DeadlineMillis/]},
        cpp: {all: [/set_deadline\([^\n]*kDeadline/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Sends the idempotency key to the provider',
      detail:
        'The request must carry `idempotency_key` so the provider recognises a retry of the same authorization instead of creating a second one.',
      match: {
        python: {all: [/AuthorizeRequest\([^)]*idempotency_key\s*=\s*idempotency_key/]},
        typescript: {all: [/idempotency_key:\s*idempotencyKey/]},
        go: {all: [/IdempotencyKey:\s*idempotencyKey/]},
        scala: {all: [/idempotencyKey\s*=\s*idempotencyKey/]},
        cpp: {all: [/set_idempotency_key\(\s*idempotency_key\s*\)/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries only UNAVAILABLE, at most 3 attempts',
      detail:
        'A bounded loop over the attempts that continues only on `UNAVAILABLE`; an unbounded loop would pin a checkout thread on a provider that is down.',
      match: {
        python: {all: [/StatusCode\.UNAVAILABLE/, /for \w+ in range\([^)\n]*MAX_ATTEMPTS/], none: [/while True/]},
        typescript: {
          all: [/status\.UNAVAILABLE/, /for \(let \w+ = \d+; \w+ <=? MAX_ATTEMPTS; (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/codes\.Unavailable/, /for \w+ := \d+; \w+ <=? maxAttempts; \w+\+\+/], none: [/for \{/]},
        scala: {
          all: [/Code\.UNAVAILABLE/, /\w+ < MaxAttempts|\w+ <- \d+ (until|to) MaxAttempts/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/StatusCode::UNAVAILABLE/, /for \(int \w+ = \d+; \w+ <=? kMaxAttempts; (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
    {
      id: 'backoff-jitter',
      title: 'Backs off exponentially with jitter',
      detail:
        'The wait before a retry doubles from the 200 ms base and adds a random component; sleeping a fixed interval synchronises every retrying server.',
      match: {
        python: {
          all: [
            /BASE_BACKOFF_S\s*\*\s*\(?\s*2\s*\*\*|2\s*\*\*[^\n]*\*\s*BASE_BACKOFF_S/,
            /random\.uniform\(|random\.random\(\)/,
            /time\.sleep\(/,
          ],
        },
        typescript: {
          all: [
            /BASE_BACKOFF_MS\s*\*\s*\(?\s*2\s*\*\*|2\s*\*\*[^\n]*\*\s*BASE_BACKOFF_MS|BASE_BACKOFF_MS\s*<<|BASE_BACKOFF_MS\s*\*\s*Math\.pow\(\s*2/,
            /Math\.random\(\)/,
            /await sleep\(|await setTimeout\(/,
          ],
        },
        go: {all: [/baseBackoff\s*(<<|\*)|\*\s*baseBackoff/, /rand\.(N|Int64N|IntN|Float64)\(/, /time\.Sleep\(/]},
        scala: {
          all: [
            /BaseBackoffMillis\s*(<<|\*)|\*\s*BaseBackoffMillis/,
            /Random\.next(Long|Int|Double)\(/,
            /Thread\.sleep\(/,
          ],
        },
        cpp: {
          all: [
            /kBaseBackoff\s*(<<|\*)|\*\s*kBaseBackoff/,
            /uniform_int_distribution|uniform_real_distribution/,
            /sleep_for\(/,
          ],
        },
      },
    },
    {
      id: 'status-mapping',
      title: 'DEADLINE_EXCEEDED is PENDING, INVALID_ARGUMENT is DECLINED',
      detail:
        'A timed-out authorization is unknown, not failed: report `PENDING` so nobody retries with a fresh key. A rejected request is a `DECLINED`.',
      match: {
        python: {
          all: [
            /StatusCode\.DEADLINE_EXCEEDED/,
            /AuthResult\(\s*"PENDING"/,
            /StatusCode\.INVALID_ARGUMENT/,
            /AuthResult\(\s*"DECLINED"/,
          ],
        },
        typescript: {
          all: [
            /status\.DEADLINE_EXCEEDED/,
            /status:\s*['"]PENDING['"]/,
            /status\.INVALID_ARGUMENT/,
            /status:\s*['"]DECLINED['"]/,
          ],
        },
        go: {all: [/codes\.DeadlineExceeded/, /Status:\s*Pending/, /codes\.InvalidArgument/, /Status:\s*Declined/]},
        scala: {all: [/Code\.DEADLINE_EXCEEDED/, /Pending\(/, /Code\.INVALID_ARGUMENT/, /Declined\(/]},
        cpp: {
          all: [
            /StatusCode::DEADLINE_EXCEEDED/,
            /AuthStatus::kPending/,
            /StatusCode::INVALID_ARGUMENT/,
            /AuthStatus::kDeclined/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import random
import time
from dataclasses import dataclass

import grpc

import provider_pb2
import provider_pb2_grpc

DEADLINE_S = 3.0
MAX_ATTEMPTS = 3
BASE_BACKOFF_S = 0.2

channel = grpc.secure_channel("provider:9443", grpc.ssl_channel_credentials())
stub = provider_pb2_grpc.PaymentProviderStub(channel)


@dataclass
class AuthResult:
    status: str  # APPROVED | DECLINED | PENDING
    authorization_id: str | None = None
    reason: str | None = None


class ProviderUnavailable(Exception):
    pass


def authorize(amount_cents: int, currency: str, card_token: str, idempotency_key: str) -> AuthResult:
    request = provider_pb2.AuthorizeRequest(amount_cents=amount_cents, currency=currency, card_token=card_token)
    # TODO: put idempotency_key in the request so the provider dedupes retries
    # TODO: stub.Authorize with a deadline of DEADLINE_S; up to MAX_ATTEMPTS attempts on UNAVAILABLE only
    # TODO: sleep BASE_BACKOFF_S doubled per attempt, plus random jitter, before each retry
    # TODO: DEADLINE_EXCEEDED → PENDING (the charge may have happened); INVALID_ARGUMENT → DECLINED; else raise
    raise NotImplementedError
`,
      solution: `import random
import time
from dataclasses import dataclass

import grpc

import provider_pb2
import provider_pb2_grpc

DEADLINE_S = 3.0
MAX_ATTEMPTS = 3
BASE_BACKOFF_S = 0.2

channel = grpc.secure_channel("provider:9443", grpc.ssl_channel_credentials())
stub = provider_pb2_grpc.PaymentProviderStub(channel)


@dataclass
class AuthResult:
    status: str  # APPROVED | DECLINED | PENDING
    authorization_id: str | None = None
    reason: str | None = None


class ProviderUnavailable(Exception):
    pass


def authorize(amount_cents: int, currency: str, card_token: str, idempotency_key: str) -> AuthResult:
    request = provider_pb2.AuthorizeRequest(
        amount_cents=amount_cents, currency=currency, card_token=card_token, idempotency_key=idempotency_key
    )
    for attempt in range(MAX_ATTEMPTS):
        if attempt > 0:
            backoff = BASE_BACKOFF_S * 2 ** (attempt - 1)
            time.sleep(backoff + random.uniform(0, backoff))  # jitter: spread retries across servers
        try:
            reply = stub.Authorize(request, timeout=DEADLINE_S)
            return AuthResult("APPROVED", authorization_id=reply.authorization_id)
        except grpc.RpcError as e:
            code = e.code()
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                return AuthResult("PENDING", reason="no answer within the deadline; the charge may exist")
            if code == grpc.StatusCode.INVALID_ARGUMENT:
                return AuthResult("DECLINED", reason=e.details())
            if code != grpc.StatusCode.UNAVAILABLE:
                raise
    raise ProviderUnavailable(f"provider unavailable after {MAX_ATTEMPTS} attempts")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {setTimeout as sleep} from 'node:timers/promises';

export const DEADLINE_MS = 3000;
export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 200;

interface AuthorizeRequest {
  amount_cents: number;
  currency: string;
  card_token: string;
  idempotency_key?: string;
}

interface ProviderClient {
  Authorize(request: AuthorizeRequest, options: {deadline: number}): Promise<{authorization_id: string}>;
}

// proto-loader's package object is untyped; this is the generated stub's shape.
const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('provider.proto')) as unknown as {
  payments: {PaymentProvider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const client = new pkg.payments.PaymentProvider('provider:9443', grpc.credentials.createSsl());

export interface AuthResult {
  status: 'APPROVED' | 'DECLINED' | 'PENDING';
  authorization_id?: string;
  reason?: string;
}

export class ProviderUnavailable extends Error {}

export async function authorize(
  amountCents: number,
  currency: string,
  cardToken: string,
  idempotencyKey: string,
): Promise<AuthResult> {
  const request = {amount_cents: amountCents, currency, card_token: cardToken};
  // TODO: put idempotency_key in the request so the provider dedupes retries
  // TODO: client.Authorize with a deadline of DEADLINE_MS; up to MAX_ATTEMPTS attempts on UNAVAILABLE only
  // TODO: sleep BASE_BACKOFF_MS doubled per attempt, plus random jitter, before each retry
  // TODO: DEADLINE_EXCEEDED → PENDING (the charge may have happened); INVALID_ARGUMENT → DECLINED; else throw
  throw new Error('not implemented');
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {setTimeout as sleep} from 'node:timers/promises';

export const DEADLINE_MS = 3000;
export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 200;

interface AuthorizeRequest {
  amount_cents: number;
  currency: string;
  card_token: string;
  idempotency_key?: string;
}

interface ProviderClient {
  Authorize(request: AuthorizeRequest, options: {deadline: number}): Promise<{authorization_id: string}>;
}

// proto-loader's package object is untyped; this is the generated stub's shape.
const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('provider.proto')) as unknown as {
  payments: {PaymentProvider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const client = new pkg.payments.PaymentProvider('provider:9443', grpc.credentials.createSsl());

export interface AuthResult {
  status: 'APPROVED' | 'DECLINED' | 'PENDING';
  authorization_id?: string;
  reason?: string;
}

export class ProviderUnavailable extends Error {}

export async function authorize(
  amountCents: number,
  currency: string,
  cardToken: string,
  idempotencyKey: string,
): Promise<AuthResult> {
  const request = {amount_cents: amountCents, currency, card_token: cardToken, idempotency_key: idempotencyKey};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff + Math.random() * backoff); // jitter: spread retries across servers
    }
    try {
      const reply = await client.Authorize(request, {deadline: Date.now() + DEADLINE_MS});
      return {status: 'APPROVED', authorization_id: reply.authorization_id};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.DEADLINE_EXCEEDED) {
        return {status: 'PENDING', reason: 'no answer within the deadline; the charge may exist'};
      }
      if (code === grpc.status.INVALID_ARGUMENT) return {status: 'DECLINED', reason: details};
      if (code !== grpc.status.UNAVAILABLE) throw e;
    }
  }
  throw new ProviderUnavailable(\`provider unavailable after \${MAX_ATTEMPTS} attempts\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"

	pb "payments/gen/provider"
)

const (
	deadline    = 3 * time.Second
	maxAttempts = 3
	baseBackoff = 200 * time.Millisecond
)

var conn, _ = grpc.NewClient("provider:9443", grpc.WithTransportCredentials(credentials.NewClientTLSFromCert(nil, "")))
var stub = pb.NewPaymentProviderClient(conn)

type AuthStatus string

const (
	Approved AuthStatus = "APPROVED"
	Declined AuthStatus = "DECLINED"
	Pending  AuthStatus = "PENDING"
)

type AuthResult struct {
	Status          AuthStatus
	AuthorizationID string
	Reason          string
}

func authorize(ctx context.Context, amountCents int64, currency, cardToken, idempotencyKey string) (AuthResult, error) {
	req := &pb.AuthorizeRequest{AmountCents: amountCents, Currency: currency, CardToken: cardToken}
	// TODO: set IdempotencyKey on the request so the provider dedupes retries
	// TODO: stub.Authorize with a context that expires after deadline; up to maxAttempts attempts on codes.Unavailable only
	// TODO: sleep baseBackoff doubled per attempt, plus random jitter, before each retry
	// TODO: codes.DeadlineExceeded → Pending (the charge may have happened); codes.InvalidArgument → Declined; else return the error
	_ = req
	_ = codes.OK
	_ = status.Code
	_ = rand.Int64N
	return AuthResult{}, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"

	pb "payments/gen/provider"
)

const (
	deadline    = 3 * time.Second
	maxAttempts = 3
	baseBackoff = 200 * time.Millisecond
)

var conn, _ = grpc.NewClient("provider:9443", grpc.WithTransportCredentials(credentials.NewClientTLSFromCert(nil, "")))
var stub = pb.NewPaymentProviderClient(conn)

type AuthStatus string

const (
	Approved AuthStatus = "APPROVED"
	Declined AuthStatus = "DECLINED"
	Pending  AuthStatus = "PENDING"
)

type AuthResult struct {
	Status          AuthStatus
	AuthorizationID string
	Reason          string
}

func authorize(ctx context.Context, amountCents int64, currency, cardToken, idempotencyKey string) (AuthResult, error) {
	req := &pb.AuthorizeRequest{AmountCents: amountCents, Currency: currency, CardToken: cardToken, IdempotencyKey: idempotencyKey}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			backoff := baseBackoff << (attempt - 1)
			time.Sleep(backoff + time.Duration(rand.Int64N(int64(backoff)))) // jitter: spread retries across servers
		}
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Authorize(callCtx, req)
		cancel()
		if err == nil {
			return AuthResult{Status: Approved, AuthorizationID: reply.GetAuthorizationId()}, nil
		}
		switch status.Code(err) {
		case codes.DeadlineExceeded:
			return AuthResult{Status: Pending, Reason: "no answer within the deadline; the charge may exist"}, nil
		case codes.InvalidArgument:
			return AuthResult{Status: Declined, Reason: status.Convert(err).Message()}, nil
		case codes.Unavailable:
			continue
		default:
			return AuthResult{}, err
		}
	}
	return AuthResult{}, fmt.Errorf("provider unavailable after %d attempts", maxAttempts)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import payments.provider.{AuthorizeRequest, PaymentProviderGrpc}
import scala.util.Random

object ProviderClient {
  val DeadlineMillis = 3000L
  val MaxAttempts = 3
  val BaseBackoffMillis = 200L

  sealed trait AuthResult
  final case class Approved(authorizationId: String) extends AuthResult
  final case class Declined(reason: String) extends AuthResult
  final case class Pending(reason: String) extends AuthResult

  final class ProviderUnavailable(message: String) extends RuntimeException(message)

  private val channel = ManagedChannelBuilder.forAddress("provider", 9443).useTransportSecurity().build()
  private val stub = PaymentProviderGrpc.blockingStub(channel)

  def authorize(amountCents: Long, currency: String, cardToken: String, idempotencyKey: String): AuthResult = {
    val request = AuthorizeRequest(amountCents = amountCents, currency = currency, cardToken = cardToken)
    // TODO: put idempotencyKey in the request so the provider dedupes retries
    // TODO: call authorize with a deadline of DeadlineMillis; up to MaxAttempts attempts on UNAVAILABLE only
    // TODO: sleep BaseBackoffMillis doubled per attempt, plus random jitter, before each retry
    // TODO: DEADLINE_EXCEEDED → Pending (the charge may have happened); INVALID_ARGUMENT → Declined; else rethrow
    throw new ProviderUnavailable("not implemented")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import payments.provider.{AuthorizeRequest, PaymentProviderGrpc}
import scala.util.Random

object ProviderClient {
  val DeadlineMillis = 3000L
  val MaxAttempts = 3
  val BaseBackoffMillis = 200L

  sealed trait AuthResult
  final case class Approved(authorizationId: String) extends AuthResult
  final case class Declined(reason: String) extends AuthResult
  final case class Pending(reason: String) extends AuthResult

  final class ProviderUnavailable(message: String) extends RuntimeException(message)

  private val channel = ManagedChannelBuilder.forAddress("provider", 9443).useTransportSecurity().build()
  private val stub = PaymentProviderGrpc.blockingStub(channel)

  def authorize(amountCents: Long, currency: String, cardToken: String, idempotencyKey: String): AuthResult = {
    val request =
      AuthorizeRequest(amountCents = amountCents, currency = currency, cardToken = cardToken, idempotencyKey = idempotencyKey)
    var attempt = 0
    while (attempt < MaxAttempts) {
      if (attempt > 0) {
        val backoff = BaseBackoffMillis << (attempt - 1)
        Thread.sleep(backoff + Random.nextLong(backoff)) // jitter: spread retries across servers
      }
      try {
        val reply = stub.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).authorize(request)
        return Approved(reply.authorizationId)
      } catch {
        case e: StatusRuntimeException =>
          e.getStatus.getCode match {
            case Status.Code.DEADLINE_EXCEEDED => return Pending("no answer within the deadline; the charge may exist")
            case Status.Code.INVALID_ARGUMENT => return Declined(e.getStatus.getDescription)
            case Status.Code.UNAVAILABLE => attempt += 1
            case _ => throw e
          }
      }
    }
    throw new ProviderUnavailable(s"provider unavailable after $MaxAttempts attempts")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

#include "provider.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{3000};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBaseBackoff{200};

enum class AuthStatus { kApproved, kDeclined, kPending };

struct AuthResult {
  AuthStatus status;
  std::string authorization_id;
  std::string reason;
};

auto channel = grpc::CreateChannel("provider:9443", grpc::SslCredentials(grpc::SslCredentialsOptions()));
auto stub = payments::PaymentProvider::NewStub(channel);
std::mt19937_64 rng{std::random_device{}()};

AuthResult authorize(int64_t amount_cents, const std::string& currency, const std::string& card_token,
                     const std::string& idempotency_key) {
  payments::AuthorizeRequest request;
  request.set_amount_cents(amount_cents);
  request.set_currency(currency);
  request.set_card_token(card_token);
  // TODO: request.set_idempotency_key so the provider dedupes retries
  // TODO: stub->Authorize with a ClientContext deadline of now + kDeadline; up to kMaxAttempts attempts on UNAVAILABLE only
  // TODO: sleep kBaseBackoff doubled per attempt, plus random jitter, before each retry
  // TODO: DEADLINE_EXCEEDED → kPending (the charge may have happened); INVALID_ARGUMENT → kDeclined; else throw
  throw std::runtime_error("not implemented");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

#include "provider.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{3000};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBaseBackoff{200};

enum class AuthStatus { kApproved, kDeclined, kPending };

struct AuthResult {
  AuthStatus status;
  std::string authorization_id;
  std::string reason;
};

auto channel = grpc::CreateChannel("provider:9443", grpc::SslCredentials(grpc::SslCredentialsOptions()));
auto stub = payments::PaymentProvider::NewStub(channel);
std::mt19937_64 rng{std::random_device{}()};

AuthResult authorize(int64_t amount_cents, const std::string& currency, const std::string& card_token,
                     const std::string& idempotency_key) {
  payments::AuthorizeRequest request;
  request.set_amount_cents(amount_cents);
  request.set_currency(currency);
  request.set_card_token(card_token);
  request.set_idempotency_key(idempotency_key);
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    if (attempt > 0) {
      const auto backoff = kBaseBackoff * (1 << (attempt - 1));
      std::uniform_int_distribution<int64_t> jitter(0, backoff.count());
      std::this_thread::sleep_for(backoff + std::chrono::milliseconds(jitter(rng)));  // spread retries across servers
    }
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    payments::AuthorizeReply reply;
    const grpc::Status status = stub->Authorize(&ctx, request, &reply);
    if (status.ok()) return {AuthStatus::kApproved, reply.authorization_id(), ""};
    switch (status.error_code()) {
      case grpc::StatusCode::DEADLINE_EXCEEDED:
        return {AuthStatus::kPending, "", "no answer within the deadline; the charge may exist"};
      case grpc::StatusCode::INVALID_ARGUMENT:
        return {AuthStatus::kDeclined, "", status.error_message()};
      case grpc::StatusCode::UNAVAILABLE:
        continue;
      default:
        throw std::runtime_error("provider: " + status.error_message());
    }
  }
  throw std::runtime_error("provider unavailable after " + std::to_string(kMaxAttempts) + " attempts");
}
`,
    },
  },
  harness: {
    python: `import grpc

import provider_pb2
import provider_pb2_grpc


class FakeProvider(provider_pb2_grpc.PaymentProviderServicer):
    def __init__(self):
        self.requests = []

    def Authorize(self, request, context):
        self.requests.append(request)
        if request.card_token == "tok_expired":
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "card expired")
        return provider_pb2.AuthorizeReply(authorization_id="auth-" + request.idempotency_key)


def _client(ctx):
    peer = FakeProvider()
    ctx.grpc.serve(provider_pb2_grpc.add_PaymentProviderServicer_to_server, peer)
    return ctx.load("provider_client"), peer


def _authorize(m, token="tok_visa", key="k1"):
    return m.authorize(4999, "EUR", token, key)


def _calls(ctx):
    return ctx.grpc.calls_to("Authorize")


def check_deadline(ctx):
    m, peer = _client(ctx)
    result = _authorize(m)
    assert result.status == "APPROVED", f"a provider that answers must give APPROVED, got {result.status!r}"
    assert result.authorization_id == "auth-k1", f"authorization_id must be the provider's, got {result.authorization_id!r}"
    call = _calls(ctx)[-1]
    assert call.timeout is not None, "the RPC carries no deadline: a hung provider would hang checkout"
    assert 2.5 <= call.timeout <= 3.5, f"the deadline must be about 3 s, got {call.timeout} s"
    ctx.grpc.set_latency("Authorize", 30.0)
    result = _authorize(m, key="k2")
    assert result.status != "APPROVED", "a provider slower than the deadline cannot have answered"
    assert len(_calls(ctx)) == 2, f"a DEADLINE_EXCEEDED attempt must not be retried, saw {len(_calls(ctx)) - 1} calls for it"
    assert _calls(ctx)[-1].timeout is not None and _calls(ctx)[-1].timeout <= 3.5, "every attempt carries the deadline"


def check_idempotency_key(ctx):
    m, peer = _client(ctx)
    _authorize(m, key="k1")
    assert peer.requests, "the provider was never called"
    req = peer.requests[-1]
    assert req.idempotency_key == "k1", f"the request carried idempotency_key {req.idempotency_key!r}, expected 'k1'"
    assert (req.amount_cents, req.currency, req.card_token) == (4999, "EUR", "tok_visa"), "amount, currency and card token must be in the request"
    ctx.grpc.fail("Authorize", grpc.StatusCode.UNAVAILABLE, "restarting", times=1)
    result = _authorize(m, key="k2")
    assert result.status == "APPROVED"
    keys = [c.request.idempotency_key for c in _calls(ctx)[1:]]
    assert keys == ["k2", "k2"], f"every attempt of one authorization must carry the same key, saw {keys}"


def check_retry_unavailable(ctx):
    m, peer = _client(ctx)
    ctx.grpc.fail("Authorize", grpc.StatusCode.UNAVAILABLE, "restarting", times=1)
    result = _authorize(m)
    assert result.status == "APPROVED", f"one UNAVAILABLE must be retried and succeed, got {result.status!r}"
    assert len(_calls(ctx)) == 2, f"expected 2 attempts after one UNAVAILABLE, saw {len(_calls(ctx))}"
    ctx.grpc.fail("Authorize", grpc.StatusCode.UNAVAILABLE, "down", times=50)
    try:
        result = _authorize(m, key="k2")
        raise AssertionError(f"a provider that stays UNAVAILABLE must raise after the last attempt, got {result!r}")
    except AssertionError:
        raise
    except Exception:
        pass
    attempts = len(_calls(ctx)) - 2
    assert attempts == 3, f"made {attempts} attempts against a down provider, expected exactly 3"
    ctx.grpc.failures.clear()  # the provider is back; the next failure is a different status
    ctx.grpc.fail("Authorize", grpc.StatusCode.PERMISSION_DENIED, "bad api key", times=5)
    try:
        result = _authorize(m, key="k3")
        raise AssertionError(f"PERMISSION_DENIED must propagate as an error, got {result!r}")
    except AssertionError:
        raise
    except Exception:
        pass
    assert len(_calls(ctx)) == 6, "only UNAVAILABLE is retried; PERMISSION_DENIED must be raised after one attempt"


def check_backoff_jitter(ctx):
    m, peer = _client(ctx)
    gaps = []
    slept = []  # virtual seconds each authorization slept in total (sleeps are the only thing advancing the clock here)
    for n in range(4):
        ctx.grpc.fail("Authorize", grpc.StatusCode.UNAVAILABLE, "restarting", times=2)
        before, offset = len(_calls(ctx)), ctx.clock.offset
        result = _authorize(m, key=f"k{n}")
        assert result.status == "APPROVED", f"two UNAVAILABLE then success must be APPROVED, got {result.status!r}"
        calls = _calls(ctx)[before:]
        assert len(calls) == 3, f"expected 3 attempts, saw {len(calls)}"
        gaps.append((calls[1].started - calls[0].started, calls[2].started - calls[1].started))
        slept.append(ctx.clock.offset - offset)
    assert ctx.clock.sleeps >= 8, "the client must sleep before each retry"
    for first, second in gaps:
        assert 0.2 <= first <= 0.45, f"the wait before the 2nd attempt was {first:.3f} s, expected 200 ms base plus up to 200 ms jitter"
        assert 0.4 <= second <= 0.85, f"the wait before the 3rd attempt was {second:.3f} s, expected 400 ms (doubled) plus up to 400 ms jitter"
    assert len({round(s, 9) for s in slept}) > 1, f"every authorization waited exactly {slept[0]:.3f} s before its retries: add random jitter so a fleet does not retry in lockstep"


def check_status_mapping(ctx):
    m, peer = _client(ctx)
    ctx.grpc.set_latency("Authorize", 30.0)
    result = _authorize(m, key="k1")
    assert result.status == "PENDING", f"a timed-out authorization must be PENDING (the charge may exist), got {result.status!r}"
    assert len(_calls(ctx)) == 1, "DEADLINE_EXCEEDED must not be retried: a second attempt could charge twice"
    ctx.grpc.set_latency("Authorize", 0.0)
    result = _authorize(m, token="tok_expired", key="k2")
    assert result.status == "DECLINED", f"INVALID_ARGUMENT must be DECLINED, got {result.status!r}"
    assert result.reason and "card expired" in result.reason, f"DECLINED must carry the provider's message, got reason={result.reason!r}"
    assert len(_calls(ctx)) == 2, "INVALID_ARGUMENT must not be retried"
    result = _authorize(m, key="k3")
    assert result.status == "APPROVED" and result.authorization_id == "auth-k3"
`,
    typescript: `/** The provider: approves everything but tok_expired (INVALID_ARGUMENT), records every request it saw. */
function provider(ctx) {
  const requests: Record<string, unknown>[] = [];
  const pkg = ctx.proto('provider.proto');
  ctx.grpc.serve(pkg.payments.PaymentProvider.service, {
    Authorize: (call, callback) => {
      requests.push(call.request);
      if (call.request.card_token === 'tok_expired') {
        callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'card expired'});
        return;
      }
      callback(null, {authorization_id: 'auth-' + call.request.idempotency_key});
    },
  });
  return {m: ctx.load('provider_client'), requests};
}

const authorize = (m, token = 'tok_visa', key = 'k1') => m.authorize(4999, 'EUR', token, key);
const calls = ctx => ctx.grpc.callsTo('Authorize');

/** Runs the authorization expecting it to throw; AssertionErrors pass through. */
async function mustThrow(fn: () => Promise<unknown>, message: (result: unknown) => string) {
  let result: unknown;
  try {
    result = await fn();
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    return;
  }
  assert.fail(message(result));
}

export async function check_deadline(ctx) {
  const {m} = provider(ctx);
  let result = await authorize(m);
  assert.equal(result.status, 'APPROVED', \`a provider that answers must give APPROVED, got \${JSON.stringify(result.status)}\`);
  assert.equal(result.authorization_id, 'auth-k1', \`authorization_id must be the provider's, got \${JSON.stringify(result.authorization_id)}\`);
  const call = calls(ctx)[calls(ctx).length - 1];
  assert(call.timeout !== null, 'the RPC carries no deadline: a hung provider would hang checkout');
  assert(2.5 <= call.timeout && call.timeout <= 3.5, \`the deadline must be about 3 s, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Authorize', 30.0);
  result = await authorize(m, 'tok_visa', 'k2');
  assert.notEqual(result.status, 'APPROVED', 'a provider slower than the deadline cannot have answered');
  assert.equal(calls(ctx).length, 2, \`a DEADLINE_EXCEEDED attempt must not be retried, saw \${calls(ctx).length - 1} calls for it\`);
  const last = calls(ctx)[calls(ctx).length - 1];
  assert(last.timeout !== null && last.timeout <= 3.5, 'every attempt carries the deadline');
}

export async function check_idempotency_key(ctx) {
  const {m, requests} = provider(ctx);
  await authorize(m, 'tok_visa', 'k1');
  assert(requests.length > 0, 'the provider was never called');
  const req = requests[requests.length - 1];
  assert.equal(req.idempotency_key, 'k1', \`the request carried idempotency_key \${JSON.stringify(req.idempotency_key)}, expected 'k1'\`);
  assert.deepEqual([String(req.amount_cents), req.currency, req.card_token], ['4999', 'EUR', 'tok_visa'], 'amount, currency and card token must be in the request');
  ctx.grpc.fail('Authorize', ctx.grpc.status.UNAVAILABLE, 'restarting', 1);
  const result = await authorize(m, 'tok_visa', 'k2');
  assert.equal(result.status, 'APPROVED');
  const keys = calls(ctx).slice(1).map(c => c.request.idempotency_key);
  assert.deepEqual(keys, ['k2', 'k2'], \`every attempt of one authorization must carry the same key, saw \${JSON.stringify(keys)}\`);
}

export async function check_retry_unavailable(ctx) {
  const {m} = provider(ctx);
  ctx.grpc.fail('Authorize', ctx.grpc.status.UNAVAILABLE, 'restarting', 1);
  const result = await authorize(m);
  assert.equal(result.status, 'APPROVED', \`one UNAVAILABLE must be retried and succeed, got \${JSON.stringify(result.status)}\`);
  assert.equal(calls(ctx).length, 2, \`expected 2 attempts after one UNAVAILABLE, saw \${calls(ctx).length}\`);
  // Down for exactly the three allowed attempts: a fourth attempt would reach a provider that is back.
  ctx.grpc.fail('Authorize', ctx.grpc.status.UNAVAILABLE, 'down', 3);
  await mustThrow(
    () => authorize(m, 'tok_visa', 'k2'),
    r => \`a provider that stays UNAVAILABLE must throw after the last attempt, got \${JSON.stringify(r)}\`,
  );
  const attempts = calls(ctx).length - 2;
  assert.equal(attempts, 3, \`made \${attempts} attempts against a down provider, expected exactly 3\`);
  ctx.grpc.fail('Authorize', ctx.grpc.status.PERMISSION_DENIED, 'bad api key', 5);
  await mustThrow(
    () => authorize(m, 'tok_visa', 'k3'),
    r => \`PERMISSION_DENIED must propagate as an error, got \${JSON.stringify(r)}\`,
  );
  assert.equal(calls(ctx).length, 6, 'only UNAVAILABLE is retried; PERMISSION_DENIED must be thrown after one attempt');
}

export async function check_backoff_jitter(ctx) {
  const {m} = provider(ctx);
  const gaps: [number, number][] = [];
  const slept: number[] = []; // virtual ms each authorization slept in total (sleeps are the only thing advancing the clock here)
  for (let n = 0; n < 4; n++) {
    ctx.grpc.fail('Authorize', ctx.grpc.status.UNAVAILABLE, 'restarting', 2);
    const before = calls(ctx).length;
    const start = ctx.clock.now();
    const result = await authorize(m, 'tok_visa', \`k\${n}\`);
    assert.equal(result.status, 'APPROVED', \`two UNAVAILABLE then success must be APPROVED, got \${JSON.stringify(result.status)}\`);
    const attempts = calls(ctx).slice(before);
    assert.equal(attempts.length, 3, \`expected 3 attempts, saw \${attempts.length}\`);
    gaps.push([attempts[1].started - attempts[0].started, attempts[2].started - attempts[1].started]);
    slept.push(ctx.clock.now() - start);
  }
  assert(ctx.clock.sleeps >= 8, 'the client must sleep before each retry');
  for (const [first, second] of gaps) {
    assert(200 <= first && first <= 450, \`the wait before the 2nd attempt was \${Math.round(first)} ms, expected 200 ms base plus up to 200 ms jitter\`);
    assert(400 <= second && second <= 850, \`the wait before the 3rd attempt was \${Math.round(second)} ms, expected 400 ms (doubled) plus up to 400 ms jitter\`);
  }
  const distinct = new Set(slept.map(s => Math.round(s / 5)));
  assert(distinct.size > 1, \`every authorization waited about \${Math.round(slept[0])} ms before its retries: add random jitter so a fleet does not retry in lockstep\`);
}

export async function check_status_mapping(ctx) {
  const {m} = provider(ctx);
  ctx.grpc.setLatency('Authorize', 30.0);
  let result = await authorize(m, 'tok_visa', 'k1');
  assert.equal(result.status, 'PENDING', \`a timed-out authorization must be PENDING (the charge may exist), got \${JSON.stringify(result.status)}\`);
  assert.equal(calls(ctx).length, 1, 'DEADLINE_EXCEEDED must not be retried: a second attempt could charge twice');
  ctx.grpc.setLatency('Authorize', 0.0);
  result = await authorize(m, 'tok_expired', 'k2');
  assert.equal(result.status, 'DECLINED', \`INVALID_ARGUMENT must be DECLINED, got \${JSON.stringify(result.status)}\`);
  assert(typeof result.reason === 'string' && result.reason.includes('card expired'), \`DECLINED must carry the provider's message, got reason=\${JSON.stringify(result.reason)}\`);
  assert.equal(calls(ctx).length, 2, 'INVALID_ARGUMENT must not be retried');
  result = await authorize(m, 'tok_visa', 'k3');
  assert(result.status === 'APPROVED' && result.authorization_id === 'auth-k3');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "payments/gen/provider"
)

// providerPeer approves everything but tok_expired (INVALID_ARGUMENT) and records every request it saw.
type providerPeer struct {
	pb.UnimplementedPaymentProviderServer
	mu       sync.Mutex
	requests []*pb.AuthorizeRequest
}

func (p *providerPeer) Authorize(_ context.Context, req *pb.AuthorizeRequest) (*pb.AuthorizeReply, error) {
	p.mu.Lock()
	p.requests = append(p.requests, req)
	p.mu.Unlock()
	if req.GetCardToken() == "tok_expired" {
		return nil, status.Error(codes.InvalidArgument, "card expired")
	}
	return &pb.AuthorizeReply{AuthorizationId: "auth-" + req.GetIdempotencyKey()}, nil
}

func serveProvider(ctx *harness.Ctx) *providerPeer {
	p := &providerPeer{}
	pb.RegisterPaymentProviderServer(ctx.GRPC.Server(""), p)
	return p
}

func authorizeCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Authorize", "") }

func authorizeWith(token, key string) (AuthResult, error) {
	return authorize(context.Background(), 4999, "EUR", token, key)
}

func CheckDeadline(ctx *harness.Ctx) {
	serveProvider(ctx)
	result, err := authorizeWith("tok_visa", "k1")
	ctx.NoError(err, "authorize against a provider that answers")
	ctx.Equal(result.Status, Approved, "a provider that answers must give Approved")
	ctx.Equal(result.AuthorizationID, "auth-k1", "AuthorizationID must be the provider's")
	calls := authorizeCalls(ctx)
	ctx.Assert(len(calls) > 0, "the provider was never called")
	call := calls[len(calls)-1]
	ctx.Assert(call.HasDeadline(), "the RPC carries no deadline: a hung provider would hang checkout")
	timeout := call.Timeout.Seconds()
	ctx.Assert(2.5 <= timeout && timeout <= 3.5, "the deadline must be about 3 s, got %.2f s", timeout)
	ctx.GRPC.SetLatency("Authorize", 30.0, "")
	result, err = authorizeWith("tok_visa", "k2")
	ctx.NoError(err, "authorize against a provider slower than the deadline")
	ctx.Assert(result.Status != Approved, "a provider slower than the deadline cannot have answered")
	calls = authorizeCalls(ctx)
	ctx.Equal(len(calls), 2, "a DEADLINE_EXCEEDED attempt must not be retried: calls so far")
	last := calls[len(calls)-1]
	ctx.Assert(last.HasDeadline() && last.Timeout.Seconds() <= 3.5, "every attempt carries the deadline")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	p := serveProvider(ctx)
	_, err := authorizeWith("tok_visa", "k1")
	ctx.NoError(err, "authorize against a provider that answers")
	ctx.Assert(len(p.requests) > 0, "the provider was never called")
	req := p.requests[len(p.requests)-1]
	ctx.Equal(req.GetIdempotencyKey(), "k1", "the request's IdempotencyKey")
	ctx.Equal([]any{req.GetAmountCents(), req.GetCurrency(), req.GetCardToken()}, []any{int64(4999), "EUR", "tok_visa"}, "amount, currency and card token must be in the request")
	ctx.GRPC.Fail("Authorize", codes.Unavailable, "restarting", 1, "")
	result, err := authorizeWith("tok_visa", "k2")
	ctx.NoError(err, "one UNAVAILABLE then success")
	ctx.Equal(result.Status, Approved, "one UNAVAILABLE then success")
	var keys []string
	for _, call := range authorizeCalls(ctx)[1:] {
		sent, _ := call.Request.(*pb.AuthorizeRequest)
		keys = append(keys, sent.GetIdempotencyKey())
	}
	ctx.Equal(keys, []string{"k2", "k2"}, "every attempt of one authorization must carry the same key")
}

func CheckRetryUnavailable(ctx *harness.Ctx) {
	serveProvider(ctx)
	ctx.GRPC.Fail("Authorize", codes.Unavailable, "restarting", 1, "")
	result, err := authorizeWith("tok_visa", "k1")
	ctx.NoError(err, "one UNAVAILABLE must be retried and succeed")
	ctx.Equal(result.Status, Approved, "one UNAVAILABLE must be retried and succeed")
	ctx.Equal(len(authorizeCalls(ctx)), 2, "attempts after one UNAVAILABLE")
	// Down for exactly the three allowed attempts: a fourth attempt would reach a provider that is back.
	ctx.GRPC.Fail("Authorize", codes.Unavailable, "down", 3, "")
	result, err = authorizeWith("tok_visa", "k2")
	ctx.Assert(err != nil, "a provider that stays UNAVAILABLE must return an error after the last attempt, got %+v", result)
	ctx.Equal(len(authorizeCalls(ctx))-2, 3, "attempts against a down provider")
	ctx.GRPC.Fail("Authorize", codes.PermissionDenied, "bad api key", 5, "")
	result, err = authorizeWith("tok_visa", "k3")
	ctx.Assert(err != nil, "PERMISSION_DENIED must propagate as an error, got %+v", result)
	ctx.Equal(len(authorizeCalls(ctx)), 6, "only UNAVAILABLE is retried; PERMISSION_DENIED must be returned after one attempt: calls so far")
}

func CheckBackoffJitter(ctx *harness.Ctx) {
	serveProvider(ctx)
	var gaps [][2]float64
	var slept []int64 // virtual ms each authorization slept in total (sleeps are the only thing advancing the clock here)
	for n := range 4 {
		ctx.GRPC.Fail("Authorize", codes.Unavailable, "restarting", 2, "")
		before := len(authorizeCalls(ctx))
		start := ctx.Clock.Now()
		result, err := authorizeWith("tok_visa", fmt.Sprintf("k%d", n))
		ctx.NoError(err, "two UNAVAILABLE then success")
		ctx.Equal(result.Status, Approved, "two UNAVAILABLE then success")
		attempts := authorizeCalls(ctx)[before:]
		ctx.Equal(len(attempts), 3, "attempts")
		gaps = append(gaps, [2]float64{
			float64(attempts[1].Started.Sub(attempts[0].Started).Milliseconds()),
			float64(attempts[2].Started.Sub(attempts[1].Started).Milliseconds()),
		})
		slept = append(slept, ctx.Clock.Now()-start)
	}
	ctx.Assert(ctx.Clock.Sleeps() >= 8, "the client must sleep before each retry")
	for _, gap := range gaps {
		ctx.Assert(200 <= gap[0] && gap[0] <= 450, "the wait before the 2nd attempt was %.0f ms, expected 200 ms base plus up to 200 ms jitter", gap[0])
		ctx.Assert(400 <= gap[1] && gap[1] <= 850, "the wait before the 3rd attempt was %.0f ms, expected 400 ms (doubled) plus up to 400 ms jitter", gap[1])
	}
	distinct := map[float64]bool{}
	for _, s := range slept {
		distinct[math.Round(float64(s)/5)] = true
	}
	ctx.Assert(len(distinct) > 1, "every authorization waited about %d ms before its retries: add random jitter so a fleet does not retry in lockstep", slept[0])
}

func CheckStatusMapping(ctx *harness.Ctx) {
	serveProvider(ctx)
	ctx.GRPC.SetLatency("Authorize", 30.0, "")
	result, err := authorizeWith("tok_visa", "k1")
	ctx.NoError(err, "a timed-out authorization is a result, not an error")
	ctx.Equal(result.Status, Pending, "a timed-out authorization must be Pending (the charge may exist)")
	ctx.Equal(len(authorizeCalls(ctx)), 1, "DEADLINE_EXCEEDED must not be retried (a second attempt could charge twice): calls so far")
	ctx.GRPC.SetLatency("Authorize", 0.0, "")
	result, err = authorizeWith("tok_expired", "k2")
	ctx.NoError(err, "a declined card is a result, not an error")
	ctx.Equal(result.Status, Declined, "INVALID_ARGUMENT must be Declined")
	ctx.Assert(strings.Contains(result.Reason, "card expired"), "Declined must carry the provider's message, got Reason %q", result.Reason)
	ctx.Equal(len(authorizeCalls(ctx)), 2, "INVALID_ARGUMENT must not be retried: calls so far")
	result, err = authorizeWith("tok_visa", "k3")
	ctx.NoError(err, "authorize against a provider that answers")
	ctx.Assert(result.Status == Approved && result.AuthorizationID == "auth-k3", "a card the provider accepts must be Approved with its AuthorizationID, got %+v", result)
}
`,
  },
  debrief: `Three ideas, each of which fails on its own: the deadline bounds *your* latency, the idempotency key makes the retry safe, and PENDING is the honest answer when a call that moves money times out. Retrying without the key charges twice; treating a timeout as a failure makes the merchant charge twice with a new key. Production clients use the gRPC retry policy in the service config instead of hand-written loops, propagate the caller's deadline, and reconcile PENDING authorizations later through a provider status query or webhook.`,
};
