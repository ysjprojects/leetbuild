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
			time.Sleep(backoff + rand.N(backoff)) // jitter: spread retries across servers
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
  debrief: `Three ideas, each of which fails on its own: the deadline bounds *your* latency, the idempotency key makes the retry safe, and PENDING is the honest answer when a call that moves money times out. Retrying without the key charges twice; treating a timeout as a failure makes the merchant charge twice with a new key. Production clients use the gRPC retry policy in the service config instead of hand-written loops, propagate the caller's deadline, and reconcile PENDING authorizations later through a provider status query or webhook.`,
};
