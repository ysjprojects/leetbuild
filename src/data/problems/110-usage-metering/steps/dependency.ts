import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Billing close under one id, bounded and reconciled',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'idempotent-requests'],
  file: 'client',
  focus: ['api', 'engine', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter hands a finished hour to billing: \`close_period(account, window)\`
reads the window with \`ledger.read_window\`, calls \`Billing.ClosePeriod\` with
\`{close_id, account, window, total_units}\` up to \`ATTEMPTS\` (3) times, marks the window closed
with \`ledger.mark_closed\` and returns \`PERIOD_CLOSED\`. It closes the demo hour and hides four
flaws.

**Failure mode the checks target.** Every attempt mints a fresh UUID, so an attempt that timed out
on the client but landed at billing is billed again under the retry's id. The call has no deadline,
so a stalled billing service holds the worker. The function says \`PERIOD_CLOSED\` after every attempt
failed, and it records whatever billing answers without comparing it to the counters.

- Derive the close id with \`close_id(account, window)\` = \`close:{account}:{window}\`; every attempt
  and every later run of the close carries the same one (billing dedupes on it).
- Each call carries a deadline of \`DEADLINE_SECONDS\` (5).
- When no attempt succeeds, return \`PERIOD_OPEN\` and mark nothing.
- When \`billed_units\` differs from the window's units, return \`PERIOD_OPEN\` and mark nothing.`,
  sequence: {
    participants: ['usaged', 'Redis', 'Billing service'],
    messages: [
      {from: 'usaged', to: 'Redis', label: 'read_window(account, window) → units', kind: 'sync'},
      {
        from: 'usaged',
        to: 'Billing service',
        label: 'ClosePeriod{close:{account}:{window}, total} · 5 s',
        kind: 'sync',
      },
      {from: 'Billing service', to: 'usaged', label: 'DEADLINE_EXCEEDED · retry, same close id', kind: 'reply'},
      {from: 'Billing service', to: 'usaged', label: '{close_id, billed_units}', kind: 'reply'},
      {from: 'usaged', to: 'Redis', label: 'billed == units → mark_closed · else PERIOD_OPEN', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'closes',
      title: 'Closes a healthy period with its total',
      detail:
        "With billing healthy, `ClosePeriod` carries the window's units, the window is marked closed and the answer is `PERIOD_CLOSED`.",
      match: {
        python: {all: [/billing\.ClosePeriod\(/, /ledger\.mark_closed\(/]},
        typescript: {all: [/billing\.ClosePeriod\(/, /markClosed\(/]},
        go: {all: [/billing\.ClosePeriod\(/, /ledger\.MarkClosed\(/]},
        scala: {all: [/billing\b[^\n]*\.closePeriod\(/, /Ledger\.markClosed\(/]},
        cpp: {all: [/billing->ClosePeriod\(/, /ledger::markClosed\(/]},
      },
    },
    {
      id: 'close-id',
      title: 'Derives one close id per (account, window)',
      detail:
        'The close id comes from `close_id`/`closeId` (Go `closeID`) as `close:{account}:{window}`, the same on every attempt and every run, so billing can tell a retry from a second close. The starter mints a random id per attempt.',
      match: {
        python: {all: [/def close_id\(/, /f["']close:\{account\}:\{window\}/], none: [/uuid/]},
        typescript: {
          all: [/closeId\s*=\s*\(|function closeId\(/, /close:\$\{account\}:\$\{window\}/],
          none: [/randomUUID/],
        },
        go: {all: [/func closeID\(/, /"close:%s:%d"|"close:" \+ account/], none: [/uuid/]},
        scala: {all: [/def closeId\(/, /s"close:\$account:\$window"/], none: [/UUID/]},
        cpp: {all: [/std::string closeId\(/, /"close:" \+ account/], none: [/mt19937|random_device|newCloseId/]},
      },
    },
    {
      id: 'deadline',
      title: 'Bounds every call with a 5-second deadline',
      detail:
        'Each `ClosePeriod` call carries `DEADLINE_SECONDS` (5 s; TypeScript `DEADLINE_MS`, Go `deadline`, C++ `kDeadline`), so a stalled billing service fails the attempt instead of holding the worker. The starter calls with no deadline.',
      match: {
        python: {all: [/DEADLINE_SECONDS\s*=\s*5\b/, /ClosePeriod\([\s\S]{0,300}?timeout\s*=\s*DEADLINE_SECONDS/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*5L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{5\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'timeout-open',
      title: 'Leaves the period open when no attempt lands',
      detail:
        'When every attempt fails (`DEADLINE_EXCEEDED`, `UNAVAILABLE`), the function returns `PERIOD_OPEN` and marks nothing, so the scheduler closes it again later. The starter returns `PERIOD_CLOSED` after the loop whatever happened.',
      match: {
        python: {all: [/return PERIOD_OPEN\s*$/]},
        typescript: {all: [/return PERIOD_OPEN;\s*\}\s*$/]},
        go: {all: [/return periodOpen\s*\}\s*$/]},
        scala: {all: [/case _ => PeriodOpen/]},
        cpp: {all: [/return kPeriodOpen;\s*\}\s*$/]},
      },
    },
    {
      id: 'reconcile',
      title: 'Reconciles the reply against the window',
      detail:
        "The close counts only when `billed_units` equals the window's units; otherwise the answer is `PERIOD_OPEN` and nothing is marked. The starter marks whatever billing answers.",
      match: {
        python: {all: [/billed_units\s*[!=]=\s*totals\[["']units["']\]/]},
        typescript: {all: [/billed_units\)?\s*[!=]==?\s*totals\.units/]},
        go: {all: [/GetBilledUnits\(\)\s*[!=]=\s*totals\.Units/]},
        scala: {all: [/billedUnits\s*[!=]=\s*totals\.units/]},
        cpp: {all: [/billed_units\(\)\s*[!=]=\s*totals\.units/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc

import usage_metering_pb2
import usage_metering_pb2_grpc
from metering import ledger  # read_window, mark_closed

PERIOD_CLOSED = "PERIOD_CLOSED"
PERIOD_OPEN = "PERIOD_OPEN"
ATTEMPTS = 3

billing = usage_metering_pb2_grpc.BillingStub(grpc.insecure_channel("billing:9000"))


def close_period(account: str, window: int) -> str:
    """Hand the window's total to billing: PERIOD_CLOSED once billing holds it, else PERIOD_OPEN."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    totals = ledger.read_window(account, window)
    for _ in range(ATTEMPTS):
        close_id = str(uuid.uuid4())
        try:
            reply = billing.ClosePeriod(
                usage_metering_pb2.ClosePeriodRequest(close_id=close_id, account=account, window=window, total_units=totals["units"])
            )
        except grpc.RpcError:
            continue
        ledger.mark_closed(account, window, close_id, reply.billed_units)
        break
    return PERIOD_CLOSED
`,
      solution: `import grpc

import usage_metering_pb2
import usage_metering_pb2_grpc
from metering import ledger  # read_window, mark_closed

PERIOD_CLOSED = "PERIOD_CLOSED"
PERIOD_OPEN = "PERIOD_OPEN"
ATTEMPTS = 3
DEADLINE_SECONDS = 5

billing = usage_metering_pb2_grpc.BillingStub(grpc.insecure_channel("billing:9000"))


def close_id(account: str, window: int) -> str:
    """One id per (account, window): billing dedupes on it, so a retry cannot bill twice."""
    return f"close:{account}:{window}"


def close_period(account: str, window: int) -> str:
    """Hand the window's total to billing: PERIOD_CLOSED once billing holds it, else PERIOD_OPEN."""
    totals = ledger.read_window(account, window)
    cid = close_id(account, window)
    for _ in range(ATTEMPTS):
        try:
            reply = billing.ClosePeriod(
                usage_metering_pb2.ClosePeriodRequest(close_id=cid, account=account, window=window, total_units=totals["units"]),
                timeout=DEADLINE_SECONDS,
            )
        except grpc.RpcError:
            continue  # a timed-out attempt may have landed; the same id makes the retry safe
        if reply.billed_units != totals["units"]:
            return PERIOD_OPEN  # billing holds another number: leave the period for reconciliation
        ledger.mark_closed(account, window, cid, reply.billed_units)
        return PERIOD_CLOSED
    return PERIOD_OPEN
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {markClosed, readWindow} from 'metering/ledger';

export const PERIOD_CLOSED = 'PERIOD_CLOSED';
export const PERIOD_OPEN = 'PERIOD_OPEN';
export const ATTEMPTS = 3;

interface ClosePeriodRequest {
  close_id: string;
  account: string;
  window: number;
  total_units: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('usage_metering.proto')) as unknown as {
  usagemeter: {Billing: grpc.ServiceClientConstructor};
};
const billing = new pkg.usagemeter.Billing('billing:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ClosePeriod(request: ClosePeriodRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{close_id: string; billed_units: string}>;
};

/** Hand the window's total to billing: PERIOD_CLOSED once billing holds it, else PERIOD_OPEN. */
export async function closePeriod(account: string, window: number): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const totals = await readWindow(account, window);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const closeId = randomUUID();
    try {
      const reply = await billing.ClosePeriod({close_id: closeId, account, window, total_units: totals.units}, new grpc.Metadata(), {});
      await markClosed(account, window, closeId, Number(reply.billed_units));
      break;
    } catch {
      continue;
    }
  }
  return PERIOD_CLOSED;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {markClosed, readWindow} from 'metering/ledger';

export const PERIOD_CLOSED = 'PERIOD_CLOSED';
export const PERIOD_OPEN = 'PERIOD_OPEN';
export const ATTEMPTS = 3;
export const DEADLINE_MS = 5000;

interface ClosePeriodRequest {
  close_id: string;
  account: string;
  window: number;
  total_units: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('usage_metering.proto')) as unknown as {
  usagemeter: {Billing: grpc.ServiceClientConstructor};
};
const billing = new pkg.usagemeter.Billing('billing:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ClosePeriod(request: ClosePeriodRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{close_id: string; billed_units: string}>;
};

/** One id per (account, window): billing dedupes on it, so a retry cannot bill twice. */
export const closeId = (account: string, window: number): string => \`close:\${account}:\${window}\`;

/** Hand the window's total to billing: PERIOD_CLOSED once billing holds it, else PERIOD_OPEN. */
export async function closePeriod(account: string, window: number): Promise<string> {
  const totals = await readWindow(account, window);
  const id = closeId(account, window);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let reply;
    try {
      reply = await billing.ClosePeriod({close_id: id, account, window, total_units: totals.units}, new grpc.Metadata(), {
        deadline: Date.now() + DEADLINE_MS,
      });
    } catch {
      continue; // a timed-out attempt may have landed; the same id makes the retry safe
    }
    // Billing holds another number: leave the period for reconciliation.
    if (Number(reply.billed_units) !== totals.units) return PERIOD_OPEN;
    await markClosed(account, window, id, totals.units);
    return PERIOD_CLOSED;
  }
  return PERIOD_OPEN;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"metering/ledger" // ledger.ReadWindow, MarkClosed
	pb "metering/gen/usage_metering"
)

const (
	periodClosed = "PERIOD_CLOSED"
	periodOpen   = "PERIOD_OPEN"
	attempts     = 3
)

var (
	billingConn, _ = grpc.NewClient("billing:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	billing        = pb.NewBillingClient(billingConn)
)

// closePeriod hands the window's total to billing: periodClosed once billing holds it, else periodOpen.
func closePeriod(ctx context.Context, account string, window int64) string {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	totals := ledger.ReadWindow(ctx, account, window)
	for i := 0; i < attempts; i++ {
		id := uuid.NewString()
		reply, err := billing.ClosePeriod(ctx, &pb.ClosePeriodRequest{CloseId: id, Account: account, Window: window, TotalUnits: totals.Units})
		if err != nil {
			continue
		}
		ledger.MarkClosed(ctx, account, window, id, reply.GetBilledUnits())
		break
	}
	return periodClosed
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"metering/ledger" // ledger.ReadWindow, MarkClosed
	pb "metering/gen/usage_metering"
)

const (
	periodClosed = "PERIOD_CLOSED"
	periodOpen   = "PERIOD_OPEN"
	attempts     = 3
	deadline     = 5 * time.Second
)

var (
	billingConn, _ = grpc.NewClient("billing:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	billing        = pb.NewBillingClient(billingConn)
)

// closeID is one id per (account, window): billing dedupes on it, so a retry cannot bill twice.
func closeID(account string, window int64) string {
	return fmt.Sprintf("close:%s:%d", account, window)
}

// closePeriod hands the window's total to billing: periodClosed once billing holds it, else periodOpen.
func closePeriod(ctx context.Context, account string, window int64) string {
	totals := ledger.ReadWindow(ctx, account, window)
	id := closeID(account, window)
	for i := 0; i < attempts; i++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := billing.ClosePeriod(callCtx, &pb.ClosePeriodRequest{CloseId: id, Account: account, Window: window, TotalUnits: totals.Units})
		cancel()
		if err != nil {
			continue // a timed-out attempt may have landed; the same id makes the retry safe
		}
		if reply.GetBilledUnits() != totals.Units {
			return periodOpen // billing holds another number: leave the period for reconciliation
		}
		ledger.MarkClosed(ctx, account, window, id, reply.GetBilledUnits())
		return periodClosed
	}
	return periodOpen
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import metering.Ledger // Ledger.readWindow, markClosed
import usagemeter.usage_metering.{BillingGrpc, ClosePeriodRequest}

object Client {
  val PeriodClosed = "PERIOD_CLOSED"
  val PeriodOpen = "PERIOD_OPEN"
  val Attempts = 3

  private val billing = BillingGrpc.blockingStub(ManagedChannelBuilder.forAddress("billing", 9000).usePlaintext().build())

  /** Hand the window's total to billing: PeriodClosed once billing holds it, else PeriodOpen. */
  def closePeriod(account: String, window: Long): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val totals = Ledger.readWindow(account, window)
    val closed = (1 to Attempts).iterator.map { _ =>
      val closeId = UUID.randomUUID().toString
      try Some(closeId -> billing.closePeriod(ClosePeriodRequest(closeId, account, window, totals.units)))
      catch { case _: StatusRuntimeException => None }
    }.collectFirst { case Some(done) => done }
    closed.foreach { case (closeId, reply) => Ledger.markClosed(account, window, closeId, reply.billedUnits) }
    PeriodClosed
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import metering.Ledger // Ledger.readWindow, markClosed
import usagemeter.usage_metering.{BillingGrpc, ClosePeriodRequest}

object Client {
  val PeriodClosed = "PERIOD_CLOSED"
  val PeriodOpen = "PERIOD_OPEN"
  val Attempts = 3
  val DeadlineSeconds = 5L

  private val billing = BillingGrpc.blockingStub(ManagedChannelBuilder.forAddress("billing", 9000).usePlaintext().build())

  /** One id per (account, window): billing dedupes on it, so a retry cannot bill twice. */
  def closeId(account: String, window: Long): String = s"close:$account:$window"

  /** Hand the window's total to billing: PeriodClosed once billing holds it, else PeriodOpen. */
  def closePeriod(account: String, window: Long): String = {
    val totals = Ledger.readWindow(account, window)
    val id = closeId(account, window)
    // A timed-out attempt may have landed; the same id makes the retry safe.
    val reply = (1 to Attempts).iterator.map { _ =>
      try Some(billing.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).closePeriod(ClosePeriodRequest(id, account, window, totals.units)))
      catch { case _: StatusRuntimeException => None }
    }.collectFirst { case Some(done) => done }
    reply match {
      case Some(done) if done.billedUnits == totals.units =>
        Ledger.markClosed(account, window, id, done.billedUnits)
        PeriodClosed
      // No attempt landed, or billing holds another number: leave the period open.
      case _ => PeriodOpen
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdio>
#include <random>
#include <string>

#include "metering/ledger.h"  // ledger::readWindow, markClosed
#include "usage_metering.grpc.pb.h"

const std::string kPeriodClosed = "PERIOD_CLOSED";
const std::string kPeriodOpen = "PERIOD_OPEN";
constexpr int kAttempts = 3;

auto billing = usagemeter::Billing::NewStub(grpc::CreateChannel("billing:9000", grpc::InsecureChannelCredentials()));

std::string newCloseId() {
  static std::mt19937_64 rng{static_cast<unsigned long long>(std::chrono::steady_clock::now().time_since_epoch().count())};
  char id[17];
  std::snprintf(id, sizeof id, "%016llx", static_cast<unsigned long long>(rng()));
  return id;
}

// Hand the window's total to billing: kPeriodClosed once billing holds it, else kPeriodOpen.
std::string closePeriod(const std::string& account, long long window) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const ledger::Totals totals = ledger::readWindow(account, window);
  for (int attempt = 0; attempt < kAttempts; attempt++) {
    const std::string id = newCloseId();
    grpc::ClientContext ctx;
    usagemeter::ClosePeriodRequest request;
    request.set_close_id(id);
    request.set_account(account);
    request.set_window(window);
    request.set_total_units(totals.units);
    usagemeter::ClosePeriodReply reply;
    if (!billing->ClosePeriod(&ctx, request, &reply).ok()) continue;
    ledger::markClosed(account, window, id, reply.billed_units());
    break;
  }
  return kPeriodClosed;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "metering/ledger.h"  // ledger::readWindow, markClosed
#include "usage_metering.grpc.pb.h"

const std::string kPeriodClosed = "PERIOD_CLOSED";
const std::string kPeriodOpen = "PERIOD_OPEN";
constexpr int kAttempts = 3;
constexpr std::chrono::seconds kDeadline{5};

auto billing = usagemeter::Billing::NewStub(grpc::CreateChannel("billing:9000", grpc::InsecureChannelCredentials()));

// One id per (account, window): billing dedupes on it, so a retry cannot bill twice.
std::string closeId(const std::string& account, long long window) { return "close:" + account + ":" + std::to_string(window); }

// Hand the window's total to billing: kPeriodClosed once billing holds it, else kPeriodOpen.
std::string closePeriod(const std::string& account, long long window) {
  const ledger::Totals totals = ledger::readWindow(account, window);
  const std::string id = closeId(account, window);
  for (int attempt = 0; attempt < kAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    usagemeter::ClosePeriodRequest request;
    request.set_close_id(id);
    request.set_account(account);
    request.set_window(window);
    request.set_total_units(totals.units);
    usagemeter::ClosePeriodReply reply;
    // A timed-out attempt may have landed; the same id makes the retry safe.
    if (!billing->ClosePeriod(&ctx, request, &reply).ok()) continue;
    // Billing holds another number: leave the period for reconciliation.
    if (reply.billed_units() != totals.units) return kPeriodOpen;
    ledger::markClosed(account, window, id, reply.billed_units());
    return kPeriodClosed;
  }
  return kPeriodOpen;
}
`,
    },
  },
  harness: {
    python: `import grpc

import usage_metering_pb2
import usage_metering_pb2_grpc
from metering import ledger


class Billing(usage_metering_pb2_grpc.BillingServicer):
    """Bills each close id once; short takes units off what it bills (a billing service that lost some)."""

    def __init__(self):
        self.billed = {}
        self.short = 0

    def ClosePeriod(self, request, context):
        if request.close_id not in self.billed:
            self.billed[request.close_id] = request.total_units - self.short
        return usage_metering_pb2.ClosePeriodReply(close_id=request.close_id, billed_units=self.billed[request.close_id])


def _client(ctx):
    billing = Billing()
    ctx.grpc.serve(usage_metering_pb2_grpc.add_BillingServicer_to_server, billing)
    m = ctx.load("client")
    ledger.record_usage({"request_id": "req_1", "account": "acct_1", "route": "/v1/generate", "units": 1200, "gateway": "gw-eu-1"})
    ledger.record_usage({"request_id": "req_2", "account": "acct_1", "route": "/v1/embed", "units": 300, "gateway": "gw-eu-1"})
    return m, billing, ledger.current_window()


def check_closes(ctx):
    m, billing, w = _client(ctx)
    result = m.close_period("acct_1", w)
    assert result == "PERIOD_CLOSED", f"with billing healthy close_period answered {result!r}, expected PERIOD_CLOSED"
    calls = ctx.grpc.calls_to("ClosePeriod")
    assert calls, "close_period never called Billing.ClosePeriod"
    sent = calls[-1].request
    assert sent.account == "acct_1" and sent.window == w and sent.total_units == 1500, f"ClosePeriod carried account {sent.account!r} window {sent.window} total {sent.total_units}, expected acct_1, {w}, 1500"
    close = ledger.last_close("acct_1")
    assert close is not None and close["window"] == w and close["units"] == 1500, f"the closed window must be marked with its 1500 units, the ledger holds {close}"


def check_close_id(ctx):
    m, billing, w = _client(ctx)
    expected = f"close:acct_1:{w}"
    ctx.grpc.fail("ClosePeriod", grpc.StatusCode.UNAVAILABLE, times=1)
    assert m.close_period("acct_1", w) == "PERIOD_CLOSED", "after one UNAVAILABLE the retry must close the period"
    ids = [c.request.close_id for c in ctx.grpc.calls_to("ClosePeriod")]
    assert ids == [expected, expected], f"the two attempts carried close ids {ids}, expected {expected} on both: a fresh id per attempt lets an attempt that landed be billed again"
    assert ledger.last_close("acct_1")["close_id"] == expected, f"the window was marked closed under {ledger.last_close('acct_1')['close_id']!r}, expected {expected}"
    m.close_period("acct_1", w)
    assert list(billing.billed) == [expected], f"running the close again billed the period under {sorted(billing.billed)}: every run must carry {expected}"


def check_deadline(ctx):
    m, billing, w = _client(ctx)
    ctx.grpc.set_latency("ClosePeriod", 30.0)
    result = m.close_period("acct_1", w)
    calls = ctx.grpc.calls_to("ClosePeriod")
    assert calls, "close_period never called Billing.ClosePeriod"
    for call in calls:
        assert call.timeout is not None, "a ClosePeriod call carries no deadline: a stalled billing service holds the worker"
        assert 4.5 <= call.timeout <= 5.5, f"a ClosePeriod call carries a {call.timeout} s deadline, expected DEADLINE_SECONDS = 5"
    assert result == "PERIOD_OPEN", f"with billing slower than every deadline close_period answered {result!r}, expected PERIOD_OPEN"


def check_timeout_open(ctx):
    m, billing, w = _client(ctx)
    ctx.grpc.fail("ClosePeriod", grpc.StatusCode.DEADLINE_EXCEEDED, times=3)
    result = m.close_period("acct_1", w)
    assert result == "PERIOD_OPEN", f"every attempt timed out and close_period answered {result!r}: billing never confirmed the close, so the period stays PERIOD_OPEN"
    assert ledger.last_close("acct_1") is None, f"a close no attempt confirmed was marked: {ledger.last_close('acct_1')}"
    assert m.close_period("acct_1", w) == "PERIOD_CLOSED", "once billing answers again the period must close"


def check_reconcile(ctx):
    m, billing, w = _client(ctx)
    billing.short = 100
    result = m.close_period("acct_1", w)
    assert result == "PERIOD_OPEN", f"billing billed 1400 of the window's 1500 units and close_period answered {result!r}: a close that does not tie out stays PERIOD_OPEN"
    assert ledger.last_close("acct_1") is None, f"a close that does not tie out was marked: {ledger.last_close('acct_1')}"
`,
    typescript: `/** Bills each close id once; short takes units off what it bills (a billing service that lost some). */
function client(ctx) {
  const pkg = ctx.proto('usage_metering.proto');
  const billing = {billed: new Map<string, number>(), short: 0};
  ctx.grpc.serve(pkg.usagemeter.Billing.service, {
    ClosePeriod(call, callback) {
      const {close_id, total_units} = call.request;
      if (!billing.billed.has(close_id)) billing.billed.set(close_id, Number(total_units) - billing.short);
      callback(null, {close_id, billed_units: billing.billed.get(close_id)});
    },
  });
  return {m: ctx.load('client'), ledger: ctx.load('/support/metering/ledger.ts'), billing};
}

async function seed(ledger): Promise<number> {
  await ledger.recordUsage({request_id: 'req_1', account: 'acct_1', route: '/v1/generate', units: 1200, gateway: 'gw-eu-1'});
  await ledger.recordUsage({request_id: 'req_2', account: 'acct_1', route: '/v1/embed', units: 300, gateway: 'gw-eu-1'});
  return ledger.currentWindow();
}

export async function check_closes(ctx) {
  const {m, ledger} = client(ctx);
  const w = await seed(ledger);
  const result = await m.closePeriod('acct_1', w);
  assert.equal(result, 'PERIOD_CLOSED', \`with billing healthy closePeriod answered \${result}, expected PERIOD_CLOSED\`);
  const calls = ctx.grpc.callsTo('ClosePeriod');
  assert(calls.length > 0, 'closePeriod never called Billing.ClosePeriod');
  const sent = calls[calls.length - 1].request;
  assert(sent.account === 'acct_1' && Number(sent.window) === w && Number(sent.total_units) === 1500, \`ClosePeriod carried \${JSON.stringify(sent)}, expected acct_1, window \${w}, total 1500\`);
  const close = await ledger.lastClose('acct_1');
  assert(close !== null && close.window === w && close.units === 1500, \`the closed window must be marked with its 1500 units, the ledger holds \${JSON.stringify(close)}\`);
}

export async function check_close_id(ctx) {
  const {m, ledger, billing} = client(ctx);
  const w = await seed(ledger);
  const expected = \`close:acct_1:\${w}\`;
  ctx.grpc.fail('ClosePeriod', ctx.grpc.status.UNAVAILABLE, '', 1);
  assert.equal(await m.closePeriod('acct_1', w), 'PERIOD_CLOSED', 'after one UNAVAILABLE the retry must close the period');
  const ids = ctx.grpc.callsTo('ClosePeriod').map(c => c.request.close_id);
  assert.deepStrictEqual(ids, [expected, expected], \`the two attempts carried close ids \${JSON.stringify(ids)}, expected \${expected} on both: a fresh id per attempt lets an attempt that landed be billed again\`);
  assert.equal((await ledger.lastClose('acct_1')).close_id, expected, 'the window must be marked closed under the derived close id');
  await m.closePeriod('acct_1', w);
  const billed = [...billing.billed.keys()];
  assert.deepStrictEqual(billed, [expected], \`running the close again billed the period under \${JSON.stringify(billed)}: every run must carry \${expected}\`);
}

export async function check_deadline(ctx) {
  const {m, ledger} = client(ctx);
  const w = await seed(ledger);
  ctx.grpc.setLatency('ClosePeriod', 30.0);
  const result = await m.closePeriod('acct_1', w);
  const calls = ctx.grpc.callsTo('ClosePeriod');
  assert(calls.length > 0, 'closePeriod never called Billing.ClosePeriod');
  for (const call of calls) {
    assert(call.timeout !== null, 'a ClosePeriod call carries no deadline: a stalled billing service holds the worker');
    assert(4.5 <= call.timeout && call.timeout <= 5.5, \`a ClosePeriod call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 5000\`);
  }
  assert.equal(result, 'PERIOD_OPEN', \`with billing slower than every deadline closePeriod answered \${result}, expected PERIOD_OPEN\`);
}

export async function check_timeout_open(ctx) {
  const {m, ledger} = client(ctx);
  const w = await seed(ledger);
  ctx.grpc.fail('ClosePeriod', ctx.grpc.status.DEADLINE_EXCEEDED, '', 3);
  const result = await m.closePeriod('acct_1', w);
  assert.equal(result, 'PERIOD_OPEN', \`every attempt timed out and closePeriod answered \${result}: billing never confirmed the close, so the period stays PERIOD_OPEN\`);
  assert.equal(await ledger.lastClose('acct_1'), null, 'a close no attempt confirmed was marked');
  assert.equal(await m.closePeriod('acct_1', w), 'PERIOD_CLOSED', 'once billing answers again the period must close');
}

export async function check_reconcile(ctx) {
  const {m, ledger, billing} = client(ctx);
  const w = await seed(ledger);
  billing.short = 100;
  const result = await m.closePeriod('acct_1', w);
  assert.equal(result, 'PERIOD_OPEN', \`billing billed 1400 of the window's 1500 units and closePeriod answered \${result}: a close that does not tie out stays PERIOD_OPEN\`);
  assert.equal(await ledger.lastClose('acct_1'), null, 'a close that does not tie out was marked');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"

	pb "metering/gen/usage_metering"
	"metering/ledger"

	"leetbuild/harness"
)

var clientBg = context.Background()

// billingPeer bills each close id once; short takes units off what it bills (a billing service that lost some).
type billingPeer struct {
	pb.UnimplementedBillingServer
	billed map[string]int64
	ids    []string
	short  int64
}

func (b *billingPeer) ClosePeriod(_ context.Context, req *pb.ClosePeriodRequest) (*pb.ClosePeriodReply, error) {
	if _, seen := b.billed[req.GetCloseId()]; !seen {
		b.billed[req.GetCloseId()] = req.GetTotalUnits() - b.short
		b.ids = append(b.ids, req.GetCloseId())
	}
	return &pb.ClosePeriodReply{CloseId: req.GetCloseId(), BilledUnits: b.billed[req.GetCloseId()]}, nil
}

func setup(ctx *harness.Ctx) (*billingPeer, int64) {
	peer := &billingPeer{billed: map[string]int64{}}
	pb.RegisterBillingServer(ctx.GRPC.Server(""), peer)
	ledger.RecordUsage(clientBg, ledger.Record{RequestID: "req_1", Account: "acct_1", Route: "/v1/generate", Units: 1200, Gateway: "gw-eu-1"})
	ledger.RecordUsage(clientBg, ledger.Record{RequestID: "req_2", Account: "acct_1", Route: "/v1/embed", Units: 300, Gateway: "gw-eu-1"})
	return peer, ledger.CurrentWindow()
}

func CheckCloses(ctx *harness.Ctx) {
	_, w := setup(ctx)
	result := closePeriod(clientBg, "acct_1", w)
	ctx.Equal(result, "PERIOD_CLOSED", "with billing healthy, closePeriod")
	calls := ctx.GRPC.CallsTo("ClosePeriod", "")
	ctx.Assert(len(calls) > 0, "closePeriod never called Billing.ClosePeriod")
	sent := calls[len(calls)-1].Request.(*pb.ClosePeriodRequest)
	ctx.Assert(sent.GetAccount() == "acct_1" && sent.GetWindow() == w && sent.GetTotalUnits() == 1500, "ClosePeriod carried account %q window %d total %d, expected acct_1, %d, 1500", sent.GetAccount(), sent.GetWindow(), sent.GetTotalUnits(), w)
	close := ledger.LastClose(clientBg, "acct_1")
	ctx.Assert(close != nil && close.Window == w && close.Units == 1500, "the closed window must be marked with its 1500 units, the ledger holds %+v", close)
}

func CheckCloseId(ctx *harness.Ctx) {
	peer, w := setup(ctx)
	expected := fmt.Sprintf("close:acct_1:%d", w)
	ctx.GRPC.Fail("ClosePeriod", codes.Unavailable, "", 1, "")
	ctx.Equal(closePeriod(clientBg, "acct_1", w), "PERIOD_CLOSED", "after one UNAVAILABLE the retry must close the period; closePeriod")
	var ids []string
	for _, c := range ctx.GRPC.CallsTo("ClosePeriod", "") {
		ids = append(ids, c.Request.(*pb.ClosePeriodRequest).GetCloseId())
	}
	ctx.Equal(ids, []string{expected, expected}, "a fresh id per attempt lets an attempt that landed be billed again; the two attempts' close ids")
	ctx.Equal(ledger.LastClose(clientBg, "acct_1").CloseID, expected, "the window must be marked closed under the derived close id")
	closePeriod(clientBg, "acct_1", w)
	ctx.Equal(peer.ids, []string{expected}, "running the close again must carry %s; the close ids billing billed", expected)
}

func CheckDeadline(ctx *harness.Ctx) {
	_, w := setup(ctx)
	ctx.GRPC.SetLatency("ClosePeriod", 30.0, "")
	result := closePeriod(clientBg, "acct_1", w)
	calls := ctx.GRPC.CallsTo("ClosePeriod", "")
	ctx.Assert(len(calls) > 0, "closePeriod never called Billing.ClosePeriod")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a ClosePeriod call carries no deadline: a stalled billing service holds the worker")
		ctx.Assert(4500*time.Millisecond <= call.Timeout && call.Timeout <= 5500*time.Millisecond, "a ClosePeriod call carries a %v deadline, expected 5 s", call.Timeout)
	}
	ctx.Equal(result, "PERIOD_OPEN", "with billing slower than every deadline, closePeriod")
}

func CheckTimeoutOpen(ctx *harness.Ctx) {
	_, w := setup(ctx)
	ctx.GRPC.Fail("ClosePeriod", codes.DeadlineExceeded, "", 3, "")
	result := closePeriod(clientBg, "acct_1", w)
	ctx.Equal(result, "PERIOD_OPEN", "every attempt timed out: billing never confirmed the close, so the period stays open; closePeriod")
	ctx.Assert(ledger.LastClose(clientBg, "acct_1") == nil, "a close no attempt confirmed was marked: %+v", ledger.LastClose(clientBg, "acct_1"))
	ctx.Equal(closePeriod(clientBg, "acct_1", w), "PERIOD_CLOSED", "once billing answers again the period must close; closePeriod")
}

func CheckReconcile(ctx *harness.Ctx) {
	peer, w := setup(ctx)
	peer.short = 100
	result := closePeriod(clientBg, "acct_1", w)
	ctx.Equal(result, "PERIOD_OPEN", "billing billed 1400 of the window's 1500 units: a close that does not tie out stays open; closePeriod")
	ctx.Assert(ledger.LastClose(clientBg, "acct_1") == nil, "a close that does not tie out was marked: %+v", ledger.LastClose(clientBg, "acct_1"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "metering/ledger.h"

namespace {

// Bills each close id once; short takes units off what it bills (a billing service that lost some).
class BillingPeer final : public usagemeter::Billing::Service {
 public:
  std::map<std::string, long long> billed;
  std::vector<std::string> ids;
  long long short_by = 0;
  grpc::Status ClosePeriod(grpc::ServerContext*, const usagemeter::ClosePeriodRequest* req, usagemeter::ClosePeriodReply* out) override {
    if (!billed.count(req->close_id())) {
      billed[req->close_id()] = req->total_units() - short_by;
      ids.push_back(req->close_id());
    }
    out->set_close_id(req->close_id());
    out->set_billed_units(billed[req->close_id()]);
    return grpc::Status::OK;
  }
};

BillingPeer& setup(harness::Ctx& ctx) {
  static BillingPeer* peer = nullptr;
  delete peer;
  peer = new BillingPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  ledger::Record first;
  first.request_id = "req_1";
  first.account = "acct_1";
  first.route = "/v1/generate";
  first.units = 1200;
  first.gateway = "gw-eu-1";
  ledger::recordUsage(first);
  ledger::Record second = first;
  second.request_id = "req_2";
  second.route = "/v1/embed";
  second.units = 300;
  ledger::recordUsage(second);
  return *peer;
}

}  // namespace

void CheckCloses(harness::Ctx& ctx) {
  setup(ctx);
  const long long w = ledger::currentWindow();
  ctx.Equal(closePeriod("acct_1", w), "PERIOD_CLOSED", "with billing healthy, closePeriod");
  const auto calls = ctx.GRPC.CallsTo("ClosePeriod");
  ctx.Assert(!calls.empty(), "closePeriod never called Billing.ClosePeriod");
  const auto sent = calls.back().Request<usagemeter::ClosePeriodRequest>();
  ctx.Assert(sent.account() == "acct_1" && sent.window() == w && sent.total_units() == 1500, "ClosePeriod carried account %q window %d total %d, expected acct_1, %d, 1500", sent.account(), sent.window(), sent.total_units(), w);
  const auto close = ledger::lastClose("acct_1");
  ctx.Assert(close && close->window == w && close->units == 1500, "the closed window must be marked with its 1500 units, the ledger holds window %d units %d", close ? close->window : 0LL, close ? close->units : 0LL);
}

void CheckCloseId(harness::Ctx& ctx) {
  BillingPeer& peer = setup(ctx);
  const long long w = ledger::currentWindow();
  const std::string expected = "close:acct_1:" + std::to_string(w);
  ctx.GRPC.Fail("ClosePeriod", grpc::StatusCode::UNAVAILABLE, "", 1);
  ctx.Equal(closePeriod("acct_1", w), "PERIOD_CLOSED", "after one UNAVAILABLE the retry must close the period; closePeriod");
  std::vector<std::string> ids;
  for (const auto& c : ctx.GRPC.CallsTo("ClosePeriod")) ids.push_back(c.Request<usagemeter::ClosePeriodRequest>().close_id());
  ctx.Equal(ids, std::vector<std::string>{expected, expected}, "a fresh id per attempt lets an attempt that landed be billed again; the two attempts' close ids");
  const auto close = ledger::lastClose("acct_1");
  ctx.Equal(close ? close->close_id : std::string(), expected, "the window must be marked closed under the derived close id");
  closePeriod("acct_1", w);
  ctx.Equal(peer.ids, std::vector<std::string>{expected}, "running the close again must carry %s; the close ids billing billed", expected);
}

void CheckDeadline(harness::Ctx& ctx) {
  setup(ctx);
  const long long w = ledger::currentWindow();
  ctx.GRPC.SetLatency("ClosePeriod", 30.0);
  const std::string result = closePeriod("acct_1", w);
  const auto calls = ctx.GRPC.CallsTo("ClosePeriod");
  ctx.Assert(!calls.empty(), "closePeriod never called Billing.ClosePeriod");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a ClosePeriod call carries no deadline: a stalled billing service holds the worker");
    ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "a ClosePeriod call carries a %v s deadline, expected kDeadline = 5 s", call.TimeoutSeconds());
  }
  ctx.Equal(result, "PERIOD_OPEN", "with billing slower than every deadline, closePeriod");
}

void CheckTimeoutOpen(harness::Ctx& ctx) {
  setup(ctx);
  const long long w = ledger::currentWindow();
  ctx.GRPC.Fail("ClosePeriod", grpc::StatusCode::DEADLINE_EXCEEDED, "", 3);
  ctx.Equal(closePeriod("acct_1", w), "PERIOD_OPEN", "every attempt timed out: billing never confirmed the close, so the period stays open; closePeriod");
  ctx.Assert(!ledger::lastClose("acct_1"), "a close no attempt confirmed was marked");
  ctx.Equal(closePeriod("acct_1", w), "PERIOD_CLOSED", "once billing answers again the period must close; closePeriod");
}

void CheckReconcile(harness::Ctx& ctx) {
  BillingPeer& peer = setup(ctx);
  const long long w = ledger::currentWindow();
  peer.short_by = 100;
  ctx.Equal(closePeriod("acct_1", w), "PERIOD_OPEN", "billing billed 1400 of the window's 1500 units: a close that does not tie out stays open; closePeriod");
  ctx.Assert(!ledger::lastClose("acct_1"), "a close that does not tie out was marked");
}
`,
  },
  hints: [
    'Make billing time out once and look at its invoices: the window was billed twice. Make it slow: the worker waits as long as billing does. Make every attempt fail: the answer is still PERIOD_CLOSED.',
    'Each attempt asks `uuid4` for a new close id, so billing cannot see that two attempts are one close. There is no deadline, the loop falls through to `return PERIOD_CLOSED`, and `billed_units` is never compared.',
    'Derive `close_id(account, window)` = `close:{account}:{window}` once before the loop, pass `timeout=DEADLINE_SECONDS`, return `PERIOD_OPEN` when `billed_units != totals["units"]` and after the loop, mark only on a match.',
  ],
  debrief: `A timeout tells the client nothing about whether the request landed, so the only safe retry is one the server can recognize: deriving the close id from the account and the window makes every attempt, and every later run of the scheduler, the same close in billing's eyes. The deadline turns a stalled billing service into a failed attempt the loop can retry, and PERIOD_OPEN is the only answer that holds when none landed. Comparing billed_units with the counters is what makes "closed" mean "billing holds our number". Production closers also retry open periods on a schedule with backoff, alert when a period stays open past the invoice cutoff, and send corrections for late usage as adjustments under their own ids.`,
};
