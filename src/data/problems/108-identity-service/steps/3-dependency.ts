import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Verification over gRPC: queued, suppressed, or confirmed',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'provider', 'retry'],
  task: `## Task

**Starting point.** The starter is the verification client the signup path calls after the account
is written: \`send_verification(user_id)\` asks the provider's \`SendVerification\` to mail the
account's address a link and answers \`"sent"\`, trying three times two seconds apart;
\`confirm_verification(user_id, token)\` calls \`ConfirmVerification\` when the user clicks it. Both
write the account \`verified\` through \`accounts.set_status\`. With a healthy provider every signup
ends verified, and it hides four flaws.

**Failure mode the checks target.** A stalled provider holds the signup open; an outage, a bounced
address and a forged token all end in a verified account, so nobody proved they own the address.

\`\`\`proto
service Verification {
  rpc SendVerification(SendRequest) returns (SendReply);           // INVALID_ARGUMENT: hard bounce
  rpc ConfirmVerification(ConfirmRequest) returns (ConfirmReply);  // confirmed: the token proves the address
}
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 3 s** deadline and is made once.
- \`DEADLINE_EXCEEDED\`, \`UNAVAILABLE\` and other transient codes: \`accounts.queue_retry(user_id)\`,
  answer \`"queued"\`.
- \`INVALID_ARGUMENT\` is a hard bounce, terminal: \`accounts.suppress(user_id)\`, answer
  \`"suppressed"\`, queue nothing.
- Sending leaves the account \`unverified\`; only a \`ConfirmReply\` with \`confirmed\` makes it
  \`verified\` (\`confirm_verification\` answers whether it did).`,
  sequence: {
    participants: ['identityd', 'Verification provider', 'accounts store'],
    messages: [
      {from: 'identityd', to: 'Verification provider', label: 'SendVerification · deadline 3 s', kind: 'sync'},
      {
        from: 'Verification provider',
        to: 'identityd',
        label: 'SendReply → "sent", status stays unverified',
        kind: 'reply',
      },
      {from: 'Verification provider', to: 'identityd', label: 'DEADLINE_EXCEEDED / UNAVAILABLE', kind: 'reply'},
      {from: 'identityd', to: 'accounts store', label: 'queue_retry(user_id) → "queued"', kind: 'async'},
      {from: 'Verification provider', to: 'identityd', label: 'INVALID_ARGUMENT: hard bounce', kind: 'reply'},
      {from: 'identityd', to: 'accounts store', label: 'suppress(user_id) → "suppressed"', kind: 'sync'},
      {
        from: 'identityd',
        to: 'Verification provider',
        label: 'ConfirmVerification(token) · deadline 3 s',
        kind: 'sync',
      },
      {from: 'identityd', to: 'accounts store', label: 'confirmed → set_status(verified)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every provider call carries a 3-second deadline',
      detail:
        'Both `SendVerification` and `ConfirmVerification` are made with `DEADLINE_S` (3 s); the starter sets none, so a stalled provider holds the signup for as long as it stalls.',
      match: {
        python: {
          all: [
            /DEADLINE_S\s*=\s*3\b/,
            /SendVerification\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/,
            /ConfirmVerification\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/,
          ],
        },
        typescript: {
          all: [
            /DEADLINE_MS\s*=\s*3000\b/,
            /SendVerification\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/,
            /ConfirmVerification\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/,
          ],
        },
        go: {all: [/deadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*3L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{3\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'timeout-queues',
      title: 'An outage queues a retry and leaves the account unverified',
      detail:
        'A transient failure (`DEADLINE_EXCEEDED`, `UNAVAILABLE`) calls `queue_retry`/`queueRetry` and answers `"queued"` after one attempt; the starter sleeps and retries in place, then marks the account verified so the user is not locked out.',
      match: {
        python: {all: [/accounts\.queue_retry\(/], none: [/time\.sleep\(/, /for attempt in/]},
        typescript: {all: [/queueRetry\(/], none: [/setTimeout\(/, /for \(let attempt/]},
        go: {all: [/accounts\.QueueRetry\(/], none: [/time\.Sleep\(/, /for attempt :=/]},
        scala: {all: [/Accounts\.queueRetry\(/], none: [/Thread\.sleep\(/, /while \(attempt/]},
        cpp: {all: [/accounts::queueRetry\(/], none: [/sleep_for\(/, /for \(int attempt/]},
      },
    },
    {
      id: 'hard-bounce',
      title: 'A hard bounce suppresses the address',
      detail:
        '`INVALID_ARGUMENT` from `SendVerification` is a hard bounce: `suppress` the account and answer `"suppressed"` without queueing a retry; the starter treats it like any failure and retries the dead mailbox.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /accounts\.suppress\(/]},
        typescript: {all: [/INVALID_ARGUMENT/, /\bsuppress\(/]},
        go: {all: [/codes\.InvalidArgument/, /accounts\.Suppress\(/]},
        scala: {all: [/INVALID_ARGUMENT/, /Accounts\.suppress\(/]},
        cpp: {all: [/INVALID_ARGUMENT/, /accounts::suppress\(/]},
      },
    },
    {
      id: 'confirm-only',
      title: 'Only a confirmed token verifies the account',
      detail:
        'Sending writes no status; `confirm_verification` sets `verified` only when the `ConfirmReply` says `confirmed`. The starter marks the account verified when the mail goes out, when the provider is down, and for any token.',
      match: {
        python: {
          order: [/def confirm_verification/, /\.confirmed/, /set_status\([^\n]*["']verified["']/],
          none: [/def send_verification(?:(?!\ndef )[\s\S])*?["']verified["']/],
        },
        typescript: {
          order: [/function confirmVerification/, /\.confirmed/, /setStatus\([^\n]*'verified'/],
          none: [/function sendVerification(?:(?!\nexport )[\s\S])*?'verified'/],
        },
        go: {
          order: [/func confirmVerification/, /\.GetConfirmed\(\)|\.Confirmed\b/, /SetStatus\([^\n]*"verified"/],
          none: [/func sendVerification(?:(?!\n\})[\s\S])*?"verified"/],
        },
        scala: {
          order: [/def confirmVerification/, /\.confirmed/, /setStatus\([^\n]*"verified"/],
          none: [/def sendVerification(?:(?!\n {2}def )[\s\S])*?"verified"/],
        },
        cpp: {
          order: [/bool confirmVerification/, /\.confirmed\(\)/, /setStatus\([^\n]*"verified"/],
          none: [/std::string sendVerification(?:(?!\n\})[\s\S])*?"verified"/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import identity_service_pb2 as pb
import identity_service_pb2_grpc
from identityd import accounts  # get_account, set_status, queue_retry, suppress

verifier = identity_service_pb2_grpc.VerificationStub(grpc.insecure_channel("verify:9000"))


def send_verification(user_id: str) -> str:
    """Ask the provider to mail the account a verification link; answers sent, queued or suppressed."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    account = accounts.get_account(user_id)
    for attempt in range(3):
        try:
            verifier.SendVerification(pb.SendRequest(user_id=user_id, email=account["email"]))
            accounts.set_status(user_id, "verified")  # the link is on its way to the address on file
            return "sent"
        except grpc.RpcError:
            time.sleep(2.0)  # the provider is flaky: try again
    accounts.set_status(user_id, "verified")  # do not lock a new user out over a provider outage
    return "sent"


def confirm_verification(user_id: str, token: str) -> bool:
    """The user clicked the link: ask the provider about the token; answers whether the account is verified."""
    verifier.ConfirmVerification(pb.ConfirmRequest(user_id=user_id, token=token))
    accounts.set_status(user_id, "verified")
    return True
`,
      solution: `import grpc

import identity_service_pb2 as pb
import identity_service_pb2_grpc
from identityd import accounts  # get_account, set_status, queue_retry, suppress

DEADLINE_S = 3

verifier = identity_service_pb2_grpc.VerificationStub(grpc.insecure_channel("verify:9000"))


def send_verification(user_id: str) -> str:
    """Ask the provider to mail the account a verification link; answers sent, queued or suppressed."""
    account = accounts.get_account(user_id)
    try:
        verifier.SendVerification(pb.SendRequest(user_id=user_id, email=account["email"]), timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
            accounts.suppress(user_id)  # a hard bounce: the mailbox does not exist, retrying cannot help
            return "suppressed"
        accounts.queue_retry(user_id)  # deadline, outage: the retry queue tries later
        return "queued"
    return "sent"  # sending proves nothing: the account stays unverified until the user confirms


def confirm_verification(user_id: str, token: str) -> bool:
    """The user clicked the link: ask the provider about the token; answers whether the account is verified."""
    reply = verifier.ConfirmVerification(pb.ConfirmRequest(user_id=user_id, token=token), timeout=DEADLINE_S)
    if not reply.confirmed:
        return False
    accounts.set_status(user_id, "verified")
    return True
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {getAccount, queueRetry, setStatus, suppress} from 'identityd/accounts';

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('identity_service.proto')) as unknown as {
  idverify: {Verification: grpc.ServiceClientConstructor};
};
const verifier = new pkg.idverify.Verification('verify:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SendVerification(request: {user_id: string; email: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{message_id: string}>;
  ConfirmVerification(request: {user_id: string; token: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{confirmed: boolean}>;
};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Ask the provider to mail the account a verification link; answers sent, queued or suppressed. */
export async function sendVerification(userId: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const account = await getAccount(userId);
  if (account === null) throw new Error(\`no account \${userId}\`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await verifier.SendVerification({user_id: userId, email: account.email}, new grpc.Metadata(), {});
      await setStatus(userId, 'verified'); // the link is on its way to the address on file
      return 'sent';
    } catch {
      await sleep(2000); // the provider is flaky: try again
    }
  }
  await setStatus(userId, 'verified'); // do not lock a new user out over a provider outage
  return 'sent';
}

/** The user clicked the link: ask the provider about the token; answers whether the account is verified. */
export async function confirmVerification(userId: string, token: string): Promise<boolean> {
  await verifier.ConfirmVerification({user_id: userId, token}, new grpc.Metadata(), {});
  await setStatus(userId, 'verified');
  return true;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {getAccount, queueRetry, setStatus, suppress} from 'identityd/accounts';

export const DEADLINE_MS = 3000;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('identity_service.proto')) as unknown as {
  idverify: {Verification: grpc.ServiceClientConstructor};
};
const verifier = new pkg.idverify.Verification('verify:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SendVerification(request: {user_id: string; email: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{message_id: string}>;
  ConfirmVerification(request: {user_id: string; token: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{confirmed: boolean}>;
};

/** Ask the provider to mail the account a verification link; answers sent, queued or suppressed. */
export async function sendVerification(userId: string): Promise<string> {
  const account = await getAccount(userId);
  if (account === null) throw new Error(\`no account \${userId}\`);
  try {
    await verifier.SendVerification({user_id: userId, email: account.email}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  } catch (e) {
    if ((e as grpc.ServiceError).code === grpc.status.INVALID_ARGUMENT) {
      await suppress(userId); // a hard bounce: the mailbox does not exist, retrying cannot help
      return 'suppressed';
    }
    await queueRetry(userId); // deadline, outage: the retry queue tries later
    return 'queued';
  }
  return 'sent'; // sending proves nothing: the account stays unverified until the user confirms
}

/** The user clicked the link: ask the provider about the token; answers whether the account is verified. */
export async function confirmVerification(userId: string, token: string): Promise<boolean> {
  const reply = await verifier.ConfirmVerification({user_id: userId, token}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  if (!reply.confirmed) return false;
  await setStatus(userId, 'verified');
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"identityd/accounts" // accounts.GetAccount, SetStatus, QueueRetry, Suppress
	pb "identityd/gen/identity_service"
)

var (
	verifierConn, _ = grpc.NewClient("verify:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	verifier        = pb.NewVerificationClient(verifierConn)
)

// sendVerification asks the provider to mail the account a verification link; it answers sent, queued or suppressed.
func sendVerification(ctx context.Context, userID string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	account, err := accounts.GetAccount(ctx, userID)
	if err != nil || account == nil {
		return "", fmt.Errorf("no account %s: %v", userID, err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := verifier.SendVerification(ctx, &pb.SendRequest{UserId: userID, Email: account.Email}); err == nil {
			return "sent", accounts.SetStatus(ctx, userID, "verified") // the link is on its way to the address on file
		}
		time.Sleep(2 * time.Second) // the provider is flaky: try again
	}
	return "sent", accounts.SetStatus(ctx, userID, "verified") // do not lock a new user out over a provider outage
}

// confirmVerification asks the provider about the token the user clicked; it answers whether the account is verified.
func confirmVerification(ctx context.Context, userID, token string) (bool, error) {
	if _, err := verifier.ConfirmVerification(ctx, &pb.ConfirmRequest{UserId: userID, Token: token}); err != nil {
		return false, err
	}
	return true, accounts.SetStatus(ctx, userID, "verified")
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"identityd/accounts" // accounts.GetAccount, SetStatus, QueueRetry, Suppress
	pb "identityd/gen/identity_service"
)

const deadline = 3 * time.Second

var (
	verifierConn, _ = grpc.NewClient("verify:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	verifier        = pb.NewVerificationClient(verifierConn)
)

// sendVerification asks the provider to mail the account a verification link; it answers sent, queued or suppressed.
func sendVerification(ctx context.Context, userID string) (string, error) {
	account, err := accounts.GetAccount(ctx, userID)
	if err != nil || account == nil {
		return "", fmt.Errorf("no account %s: %v", userID, err)
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	_, err = verifier.SendVerification(callCtx, &pb.SendRequest{UserId: userID, Email: account.Email})
	if err == nil {
		return "sent", nil // sending proves nothing: the account stays unverified until the user confirms
	}
	if status.Code(err) == codes.InvalidArgument {
		return "suppressed", accounts.Suppress(ctx, userID) // a hard bounce: the mailbox does not exist, retrying cannot help
	}
	return "queued", accounts.QueueRetry(ctx, userID) // deadline, outage: the retry queue tries later
}

// confirmVerification asks the provider about the token the user clicked; it answers whether the account is verified.
func confirmVerification(ctx context.Context, userID, token string) (bool, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := verifier.ConfirmVerification(callCtx, &pb.ConfirmRequest{UserId: userID, Token: token})
	if err != nil || !reply.GetConfirmed() {
		return false, err
	}
	return true, accounts.SetStatus(ctx, userID, "verified")
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import identityd.Accounts // Accounts.getAccount, setStatus, queueRetry, suppress
import idverify.identity_service.{ConfirmRequest, SendRequest, VerificationGrpc}

object Verify {
  private val verifier = VerificationGrpc.blockingStub(ManagedChannelBuilder.forAddress("verify", 9000).usePlaintext().build())

  /** Ask the provider to mail the account a verification link; answers sent, queued or suppressed. */
  def sendVerification(userId: String): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val account = Accounts.getAccount(userId).getOrElse(throw new NoSuchElementException(s"no account $userId"))
    var attempt = 0
    var sent = false
    while (attempt < 3 && !sent) {
      try {
        verifier.sendVerification(SendRequest(userId, account.email))
        sent = true
      } catch { case _: StatusRuntimeException => Thread.sleep(2000); attempt += 1 } // the provider is flaky: try again
    }
    Accounts.setStatus(userId, "verified") // on its way, or the provider is down: do not lock a new user out
    "sent"
  }

  /** The user clicked the link: ask the provider about the token; answers whether the account is verified. */
  def confirmVerification(userId: String, token: String): Boolean = {
    verifier.confirmVerification(ConfirmRequest(userId, token))
    Accounts.setStatus(userId, "verified")
    true
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import identityd.Accounts // Accounts.getAccount, setStatus, queueRetry, suppress
import idverify.identity_service.{ConfirmRequest, SendRequest, VerificationGrpc}

object Verify {
  val DeadlineSeconds = 3L

  private val verifier = VerificationGrpc.blockingStub(ManagedChannelBuilder.forAddress("verify", 9000).usePlaintext().build())

  /** Ask the provider to mail the account a verification link; answers sent, queued or suppressed. */
  def sendVerification(userId: String): String = {
    val account = Accounts.getAccount(userId).getOrElse(throw new NoSuchElementException(s"no account $userId"))
    try {
      verifier.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).sendVerification(SendRequest(userId, account.email))
      "sent" // sending proves nothing: the account stays unverified until the user confirms
    } catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
        Accounts.suppress(userId) // a hard bounce: the mailbox does not exist, retrying cannot help
        "suppressed"
      case _: StatusRuntimeException =>
        Accounts.queueRetry(userId) // deadline, outage: the retry queue tries later
        "queued"
    }
  }

  /** The user clicked the link: ask the provider about the token; answers whether the account is verified. */
  def confirmVerification(userId: String, token: String): Boolean = {
    val reply = verifier.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).confirmVerification(ConfirmRequest(userId, token))
    if (reply.confirmed) Accounts.setStatus(userId, "verified")
    reply.confirmed
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "identity_service.grpc.pb.h"
#include "identityd/accounts.h"  // accounts::getAccount, setStatus, queueRetry, suppress

auto verifier = idverify::Verification::NewStub(grpc::CreateChannel("verify:9000", grpc::InsecureChannelCredentials()));

// Ask the provider to mail the account a verification link; answers sent, queued or suppressed.
std::string sendVerification(const std::string& user_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto account = accounts::getAccount(user_id);
  if (!account) throw std::out_of_range("no account " + user_id);
  idverify::SendRequest request;
  request.set_user_id(user_id);
  request.set_email(account->email);
  for (int attempt = 0; attempt < 3; attempt++) {
    grpc::ClientContext ctx;
    idverify::SendReply reply;
    if (verifier->SendVerification(&ctx, request, &reply).ok()) break;
    std::this_thread::sleep_for(std::chrono::seconds{2});  // the provider is flaky: try again
  }
  accounts::setStatus(user_id, "verified");  // on its way, or the provider is down: do not lock a new user out
  return "sent";
}

// The user clicked the link: ask the provider about the token; answers whether the account is verified.
bool confirmVerification(const std::string& user_id, const std::string& token) {
  grpc::ClientContext ctx;
  idverify::ConfirmRequest request;
  request.set_user_id(user_id);
  request.set_token(token);
  idverify::ConfirmReply reply;
  verifier->ConfirmVerification(&ctx, request, &reply);
  accounts::setStatus(user_id, "verified");
  return true;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "identity_service.grpc.pb.h"
#include "identityd/accounts.h"  // accounts::getAccount, setStatus, queueRetry, suppress

constexpr std::chrono::seconds kDeadline{3};

auto verifier = idverify::Verification::NewStub(grpc::CreateChannel("verify:9000", grpc::InsecureChannelCredentials()));

// Ask the provider to mail the account a verification link; answers sent, queued or suppressed.
std::string sendVerification(const std::string& user_id) {
  const auto account = accounts::getAccount(user_id);
  if (!account) throw std::out_of_range("no account " + user_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  idverify::SendRequest request;
  request.set_user_id(user_id);
  request.set_email(account->email);
  idverify::SendReply reply;
  const grpc::Status status = verifier->SendVerification(&ctx, request, &reply);
  if (status.ok()) return "sent";  // sending proves nothing: the account stays unverified until the user confirms
  if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
    accounts::suppress(user_id);  // a hard bounce: the mailbox does not exist, retrying cannot help
    return "suppressed";
  }
  accounts::queueRetry(user_id);  // deadline, outage: the retry queue tries later
  return "queued";
}

// The user clicked the link: ask the provider about the token; answers whether the account is verified.
bool confirmVerification(const std::string& user_id, const std::string& token) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  idverify::ConfirmRequest request;
  request.set_user_id(user_id);
  request.set_token(token);
  idverify::ConfirmReply reply;
  const grpc::Status status = verifier->ConfirmVerification(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("ConfirmVerification: " + status.error_message());
  if (!reply.confirmed()) return false;
  accounts::setStatus(user_id, "verified");
  return true;
}
`,
    },
  },
  harness: {
    python: `import grpc

import identity_service_pb2 as pb
import identity_service_pb2_grpc
from identityd import accounts


class Provider(identity_service_pb2_grpc.VerificationServicer):
    """Mails every address but those at bounce.test (a hard bounce); tok-<user_id> is the token that proves an address."""

    def SendVerification(self, request, context):
        if request.email.endswith("@bounce.test"):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, f"hard bounce: {request.email} does not exist")
        return pb.SendReply(message_id=f"m-{request.user_id}")

    def ConfirmVerification(self, request, context):
        return pb.ConfirmReply(confirmed=request.token == f"tok-{request.user_id}")


def _client(ctx):
    ctx.grpc.serve(identity_service_pb2_grpc.add_VerificationServicer_to_server, Provider())
    accounts.create_account("u-1", "ada@example.com", "+442079460958", "Ada")
    accounts.create_account("u-2", "nobody@bounce.test", "+15550100200", "Nobody")
    return ctx.load("client")


def _status(user_id):
    return accounts.get_account(user_id)["status"]


def check_deadline(ctx):
    m = _client(ctx)
    assert m.send_verification("u-1") == "sent", "with a healthy provider send_verification must answer sent"
    assert m.confirm_verification("u-1", "tok-u-1") is True, "the right token must verify the account"
    for method in ("SendVerification", "ConfirmVerification"):
        calls = ctx.grpc.calls_to(method)
        assert calls, f"no {method} call was made"
        for call in calls:
            assert call.timeout is not None, f"a {method} call carries no deadline: a stalled provider holds the signup open"
            assert 2.5 <= call.timeout <= 3.5, f"a {method} call carries a {call.timeout} s deadline, expected DEADLINE_S = 3"
    accounts.create_account("u-3", "bo@example.com", "+15550100300", "Bo")
    ctx.grpc.set_latency("SendVerification", 10.0)
    before = len(ctx.grpc.calls_to("SendVerification"))
    outcome = m.send_verification("u-3")
    assert outcome == "queued", f"with the provider slower than the deadline send_verification answered {outcome!r}, expected queued"
    assert len(ctx.grpc.calls_to("SendVerification")) == before + 1, "a deadline is queued for later, not retried in place"


def check_timeout_queues(ctx):
    m = _client(ctx)
    ctx.grpc.fail("SendVerification", grpc.StatusCode.UNAVAILABLE, "provider down", times=5)
    outcome = m.send_verification("u-1")
    assert _status("u-1") == "unverified", f"the provider was down and the account is {_status('u-1')}: nobody proved they own ada@example.com"
    assert outcome == "queued", f"during an outage send_verification answered {outcome!r}, expected queued"
    assert accounts.pending_retries() == ["u-1"], f"the retry queue holds {accounts.pending_retries()}, expected u-1"
    calls = len(ctx.grpc.calls_to("SendVerification"))
    assert calls == 1 and ctx.clock.sleeps == 0, f"the outage was retried in place ({calls} calls, {ctx.clock.sleeps} sleeps): the signup waits on it. Queue the retry and answer"


def check_hard_bounce(ctx):
    m = _client(ctx)
    outcome = m.send_verification("u-2")
    assert _status("u-2") == "suppressed", f"after a hard bounce the account is {_status('u-2')}, expected suppressed"
    assert accounts.is_suppressed("nobody@bounce.test"), "the bounced address is not on the suppression list"
    assert outcome == "suppressed", f"a hard bounce answered {outcome!r}, expected suppressed"
    assert accounts.pending_retries() == [], f"a hard bounce was queued for retry: {accounts.pending_retries()}"
    calls = len(ctx.grpc.calls_to("SendVerification"))
    assert calls == 1, f"the bounced address was mailed {calls} times: a hard bounce is terminal"


def check_confirm_only(ctx):
    m = _client(ctx)
    assert m.send_verification("u-1") == "sent", "with a healthy provider send_verification must answer sent"
    assert _status("u-1") == "unverified", f"the link was only sent and the account is {_status('u-1')}: sending proves nothing, a confirmed token does"
    assert m.confirm_verification("u-1", "tok-u-2") is False, "a token the provider does not confirm must answer False"
    assert _status("u-1") == "unverified", f"a token the provider rejected left the account {_status('u-1')}"
    assert m.confirm_verification("u-1", "tok-u-1") is True, "the confirmed token must answer True"
    assert _status("u-1") == "verified", f"after a confirmed token the account is {_status('u-1')}, expected verified"
`,
    typescript: `async function client(ctx) {
  const pkg = ctx.proto('identity_service.proto');
  // Mails every address but those at bounce.test (a hard bounce); tok-<user_id> is the token that proves an address.
  ctx.grpc.serve(pkg.idverify.Verification.service, {
    SendVerification(call, callback) {
      const {user_id, email} = call.request;
      if (email.endsWith('@bounce.test')) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: \`hard bounce: \${email} does not exist\`});
      callback(null, {message_id: \`m-\${user_id}\`});
    },
    ConfirmVerification(call, callback) {
      callback(null, {confirmed: call.request.token === \`tok-\${call.request.user_id}\`});
    },
  });
  const accounts = ctx.load('/support/identityd/accounts.ts');
  await accounts.createAccount('u-1', 'ada@example.com', '+442079460958', 'Ada');
  await accounts.createAccount('u-2', 'nobody@bounce.test', '+15550100200', 'Nobody');
  const status = async (userId: string): Promise<string> => (await accounts.getAccount(userId)).status;
  return {m: ctx.load('client'), accounts, status};
}

export async function check_deadline(ctx) {
  const {m, accounts} = await client(ctx);
  assert.equal(await m.sendVerification('u-1'), 'sent', 'with a healthy provider sendVerification must answer sent');
  assert.equal(await m.confirmVerification('u-1', 'tok-u-1'), true, 'the right token must verify the account');
  for (const method of ['SendVerification', 'ConfirmVerification']) {
    const calls = ctx.grpc.callsTo(method);
    assert(calls.length > 0, \`no \${method} call was made\`);
    for (const call of calls) {
      assert(call.timeout !== null, \`a \${method} call carries no deadline: a stalled provider holds the signup open\`);
      assert(2.5 <= call.timeout && call.timeout <= 3.5, \`a \${method} call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 3000\`);
    }
  }
  await accounts.createAccount('u-3', 'bo@example.com', '+15550100300', 'Bo');
  ctx.grpc.setLatency('SendVerification', 10.0);
  const before = ctx.grpc.callsTo('SendVerification').length;
  const outcome = await m.sendVerification('u-3');
  assert.equal(outcome, 'queued', \`with the provider slower than the deadline sendVerification answered \${JSON.stringify(outcome)}, expected queued\`);
  assert.equal(ctx.grpc.callsTo('SendVerification').length, before + 1, 'a deadline is queued for later, not retried in place');
}

export async function check_timeout_queues(ctx) {
  const {m, accounts, status} = await client(ctx);
  ctx.grpc.fail('SendVerification', ctx.grpc.status.UNAVAILABLE, 'provider down', 5);
  const outcome = await m.sendVerification('u-1');
  assert.equal(await status('u-1'), 'unverified', \`the provider was down and the account is \${await status('u-1')}: nobody proved they own ada@example.com\`);
  assert.equal(outcome, 'queued', \`during an outage sendVerification answered \${JSON.stringify(outcome)}, expected queued\`);
  assert.deepStrictEqual(await accounts.pendingRetries(), ['u-1'], \`the retry queue holds \${JSON.stringify(await accounts.pendingRetries())}, expected u-1\`);
  const calls = ctx.grpc.callsTo('SendVerification').length;
  assert(calls === 1 && ctx.clock.sleeps === 0, \`the outage was retried in place (\${calls} calls, \${ctx.clock.sleeps} sleeps): the signup waits on it. Queue the retry and answer\`);
}

export async function check_hard_bounce(ctx) {
  const {m, accounts, status} = await client(ctx);
  const outcome = await m.sendVerification('u-2');
  assert.equal(await status('u-2'), 'suppressed', \`after a hard bounce the account is \${await status('u-2')}, expected suppressed\`);
  assert.equal(await accounts.isSuppressed('nobody@bounce.test'), true, 'the bounced address is not on the suppression list');
  assert.equal(outcome, 'suppressed', \`a hard bounce answered \${JSON.stringify(outcome)}, expected suppressed\`);
  assert.deepStrictEqual(await accounts.pendingRetries(), [], 'a hard bounce was queued for retry');
  const calls = ctx.grpc.callsTo('SendVerification').length;
  assert.equal(calls, 1, \`the bounced address was mailed \${calls} times: a hard bounce is terminal\`);
}

export async function check_confirm_only(ctx) {
  const {m, status} = await client(ctx);
  assert.equal(await m.sendVerification('u-1'), 'sent', 'with a healthy provider sendVerification must answer sent');
  assert.equal(await status('u-1'), 'unverified', \`the link was only sent and the account is \${await status('u-1')}: sending proves nothing, a confirmed token does\`);
  assert.equal(await m.confirmVerification('u-1', 'tok-u-2'), false, 'a token the provider does not confirm must answer false');
  assert.equal(await status('u-1'), 'unverified', 'a token the provider rejected must leave the account unverified');
  assert.equal(await m.confirmVerification('u-1', 'tok-u-1'), true, 'the confirmed token must answer true');
  assert.equal(await status('u-1'), 'verified', 'after a confirmed token the account must be verified');
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"identityd/accounts"
	pb "identityd/gen/identity_service"

	"leetbuild/harness"
)

var verifyBg = context.Background()

// provider mails every address but those at bounce.test (a hard bounce); tok-<user_id> is the token that proves an address.
type provider struct {
	pb.UnimplementedVerificationServer
}

func (provider) SendVerification(_ context.Context, req *pb.SendRequest) (*pb.SendReply, error) {
	if strings.HasSuffix(req.GetEmail(), "@bounce.test") {
		return nil, status.Errorf(codes.InvalidArgument, "hard bounce: %s does not exist", req.GetEmail())
	}
	return &pb.SendReply{MessageId: "m-" + req.GetUserId()}, nil
}

func (provider) ConfirmVerification(_ context.Context, req *pb.ConfirmRequest) (*pb.ConfirmReply, error) {
	return &pb.ConfirmReply{Confirmed: req.GetToken() == "tok-"+req.GetUserId()}, nil
}

func setup(ctx *harness.Ctx) {
	pb.RegisterVerificationServer(ctx.GRPC.Server(""), provider{})
	for _, a := range [][3]string{{"u-1", "ada@example.com", "+442079460958"}, {"u-2", "nobody@bounce.test", "+15550100200"}} {
		_, err := accounts.CreateAccount(verifyBg, a[0], a[1], a[2], "Ada")
		ctx.NoError(err, "CreateAccount(%s) failed", a[0])
	}
}

func statusOf(ctx *harness.Ctx, userID string) string {
	a, err := accounts.GetAccount(verifyBg, userID)
	ctx.NoError(err, "GetAccount(%s) failed", userID)
	return a.Status
}

func mustSend(ctx *harness.Ctx, userID string) string {
	outcome, err := sendVerification(verifyBg, userID)
	ctx.NoError(err, "sendVerification(%s) failed", userID)
	return outcome
}

func mustConfirm(ctx *harness.Ctx, userID, token string) bool {
	ok, err := confirmVerification(verifyBg, userID, token)
	ctx.NoError(err, "confirmVerification(%s, %s) failed", userID, token)
	return ok
}

func CheckDeadline(ctx *harness.Ctx) {
	setup(ctx)
	ctx.Equal(mustSend(ctx, "u-1"), "sent", "with a healthy provider sendVerification must answer sent")
	ctx.Equal(mustConfirm(ctx, "u-1", "tok-u-1"), true, "the right token must verify the account")
	for _, method := range []string{"SendVerification", "ConfirmVerification"} {
		calls := ctx.GRPC.CallsTo(method, "")
		ctx.Assert(len(calls) > 0, "no %s call was made", method)
		for _, call := range calls {
			ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled provider holds the signup open", method)
			ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "a %s call carries a %v deadline, expected 3 s", method, call.Timeout)
		}
	}
	_, err := accounts.CreateAccount(verifyBg, "u-3", "bo@example.com", "+15550100300", "Bo")
	ctx.NoError(err, "CreateAccount(u-3) failed")
	ctx.GRPC.SetLatency("SendVerification", 10.0, "")
	before := len(ctx.GRPC.CallsTo("SendVerification", ""))
	ctx.Equal(mustSend(ctx, "u-3"), "queued", "with the provider slower than the deadline, sendVerification's answer")
	ctx.Equal(len(ctx.GRPC.CallsTo("SendVerification", "")), before+1, "a deadline is queued for later, not retried in place; the calls")
}

func CheckTimeoutQueues(ctx *harness.Ctx) {
	setup(ctx)
	ctx.GRPC.Fail("SendVerification", codes.Unavailable, "provider down", 5, "")
	outcome := mustSend(ctx, "u-1")
	ctx.Equal(statusOf(ctx, "u-1"), "unverified", "the provider was down, so nobody proved they own ada@example.com; the account's status")
	ctx.Equal(outcome, "queued", "during an outage, sendVerification's answer")
	ctx.Equal(accounts.PendingRetries(verifyBg), []string{"u-1"}, "the retry queue")
	calls := len(ctx.GRPC.CallsTo("SendVerification", ""))
	ctx.Assert(calls == 1 && ctx.Clock.Sleeps() == 0, "the outage was retried in place (%d calls, %d sleeps): the signup waits on it. Queue the retry and answer", calls, ctx.Clock.Sleeps())
}

func CheckHardBounce(ctx *harness.Ctx) {
	setup(ctx)
	outcome := mustSend(ctx, "u-2")
	ctx.Equal(statusOf(ctx, "u-2"), "suppressed", "after a hard bounce, the account's status")
	ctx.Assert(accounts.IsSuppressed(verifyBg, "nobody@bounce.test"), "the bounced address is not on the suppression list")
	ctx.Equal(outcome, "suppressed", "a hard bounce's answer")
	ctx.Equal(len(accounts.PendingRetries(verifyBg)), 0, "a hard bounce must not be queued for retry; the queue holds %v", accounts.PendingRetries(verifyBg))
	ctx.Equal(len(ctx.GRPC.CallsTo("SendVerification", "")), 1, "a hard bounce is terminal; the mails sent to the bounced address")
}

func CheckConfirmOnly(ctx *harness.Ctx) {
	setup(ctx)
	ctx.Equal(mustSend(ctx, "u-1"), "sent", "with a healthy provider sendVerification must answer sent")
	ctx.Equal(statusOf(ctx, "u-1"), "unverified", "the link was only sent (sending proves nothing, a confirmed token does); the account's status")
	ctx.Equal(mustConfirm(ctx, "u-1", "tok-u-2"), false, "a token the provider does not confirm")
	ctx.Equal(statusOf(ctx, "u-1"), "unverified", "after a token the provider rejected, the account's status")
	ctx.Equal(mustConfirm(ctx, "u-1", "tok-u-1"), true, "the confirmed token")
	ctx.Equal(statusOf(ctx, "u-1"), "verified", "after a confirmed token, the account's status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "identity_service.grpc.pb.h"
#include "identityd/accounts.h"

namespace {

// Mails every address but those at bounce.test (a hard bounce); tok-<user_id> is the token that proves an address.
class ProviderPeer final : public idverify::Verification::Service {
 public:
  grpc::Status SendVerification(grpc::ServerContext*, const idverify::SendRequest* req, idverify::SendReply* out) override {
    const std::string& email = req->email();
    if (email.size() >= 12 && email.compare(email.size() - 12, 12, "@bounce.test") == 0) {
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "hard bounce: " + email + " does not exist");
    }
    out->set_message_id("m-" + req->user_id());
    return grpc::Status::OK;
  }
  grpc::Status ConfirmVerification(grpc::ServerContext*, const idverify::ConfirmRequest* req, idverify::ConfirmReply* out) override {
    out->set_confirmed(req->token() == "tok-" + req->user_id());
    return grpc::Status::OK;
  }
};

void setup(harness::Ctx& ctx) {
  static ProviderPeer* peer = nullptr;
  delete peer;
  peer = new ProviderPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  accounts::createAccount("u-1", "ada@example.com", "+442079460958", "Ada");
  accounts::createAccount("u-2", "nobody@bounce.test", "+15550100200", "Nobody");
}

std::string statusOf(const std::string& user_id) { return accounts::getAccount(user_id)->status; }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  setup(ctx);
  ctx.Equal(sendVerification("u-1"), "sent", "with a healthy provider sendVerification must answer sent");
  ctx.Equal(confirmVerification("u-1", "tok-u-1"), true, "the right token must verify the account");
  for (const std::string method : {"SendVerification", "ConfirmVerification"}) {
    const auto calls = ctx.GRPC.CallsTo(method);
    ctx.Assert(!calls.empty(), "no %s call was made", method);
    for (const auto& call : calls) {
      ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled provider holds the signup open", method);
      ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "a %s call carries a %v s deadline, expected kDeadline = 3 s", method, call.TimeoutSeconds());
    }
  }
  accounts::createAccount("u-3", "bo@example.com", "+15550100300", "Bo");
  ctx.GRPC.SetLatency("SendVerification", 10.0);
  const size_t before = ctx.GRPC.CallsTo("SendVerification").size();
  ctx.Equal(sendVerification("u-3"), "queued", "with the provider slower than the deadline, sendVerification's answer");
  ctx.Equal(ctx.GRPC.CallsTo("SendVerification").size(), before + 1, "a deadline is queued for later, not retried in place; the calls");
}

void CheckTimeoutQueues(harness::Ctx& ctx) {
  setup(ctx);
  ctx.GRPC.Fail("SendVerification", grpc::StatusCode::UNAVAILABLE, "provider down", 5);
  const std::string outcome = sendVerification("u-1");
  ctx.Equal(statusOf("u-1"), "unverified", "the provider was down, so nobody proved they own ada@example.com; the account's status");
  ctx.Equal(outcome, "queued", "during an outage, sendVerification's answer");
  ctx.Equal(accounts::pendingRetries(), std::vector<std::string>{"u-1"}, "the retry queue");
  const size_t calls = ctx.GRPC.CallsTo("SendVerification").size();
  ctx.Assert(calls == 1 && ctx.Clock.Sleeps() == 0, "the outage was retried in place (%d calls, %d sleeps): the signup waits on it. Queue the retry and answer", calls, ctx.Clock.Sleeps());
}

void CheckHardBounce(harness::Ctx& ctx) {
  setup(ctx);
  const std::string outcome = sendVerification("u-2");
  ctx.Equal(statusOf("u-2"), "suppressed", "after a hard bounce, the account's status");
  ctx.Assert(accounts::isSuppressed("nobody@bounce.test"), "the bounced address is not on the suppression list");
  ctx.Equal(outcome, "suppressed", "a hard bounce's answer");
  ctx.Assert(accounts::pendingRetries().empty(), "a hard bounce must not be queued for retry; the queue holds %v", accounts::pendingRetries());
  ctx.Equal(ctx.GRPC.CallsTo("SendVerification").size(), 1, "a hard bounce is terminal; the mails sent to the bounced address");
}

void CheckConfirmOnly(harness::Ctx& ctx) {
  setup(ctx);
  ctx.Equal(sendVerification("u-1"), "sent", "with a healthy provider sendVerification must answer sent");
  ctx.Equal(statusOf("u-1"), "unverified", "the link was only sent (sending proves nothing, a confirmed token does); the account's status");
  ctx.Equal(confirmVerification("u-1", "tok-u-2"), false, "a token the provider does not confirm");
  ctx.Equal(statusOf("u-1"), "unverified", "after a token the provider rejected, the account's status");
  ctx.Equal(confirmVerification("u-1", "tok-u-1"), true, "the confirmed token");
  ctx.Equal(statusOf("u-1"), "verified", "after a confirmed token, the account's status");
}
`,
  },
  hints: [
    'Take the provider down, sign up, and read the account: it is verified. Do the same with an address that bounces, or confirm with any token: verified again.',
    'Every branch of `send_verification` ends in `set_status("verified")`, and the loop sleeps between attempts with no deadline on the call. `confirm_verification` never reads `reply.confirmed`.',
    'One `SendVerification` with `timeout=DEADLINE_S`: success → "sent"; `INVALID_ARGUMENT` → `accounts.suppress`; anything else → `accounts.queue_retry`. In `confirm_verification`, `set_status(user_id, "verified")` only when `reply.confirmed`.',
  ],
  debrief: `Verification is a proof, so the only code that may write \`verified\` is the code that read the proof: a \`ConfirmReply\` that says \`confirmed\`. Everything else the provider says is about the mail, not the person. A deadline or an outage says nothing either way, which is why it goes to the retry queue and the signup answers at once, where the starter made the user wait through three tries and then guessed. A hard bounce does say something: the mailbox does not exist, and retrying it costs the sender reputation that delivers everyone else's mail. Production services also bound the retry queue (attempts, backoff, an expiry on the token) and let a support agent resend by hand.`,
};
