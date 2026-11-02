import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Billing flush with an idempotent period close',
  concept: 'grpc',
  file: 'client',
  focus: ['engine', 'fallback', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter is the period flush that hands metered usage to billing over gRPC:
\`flush_period(account, period)\` tries \`ClosePeriod\` up to three times, minting a fresh UUID close
id on each attempt, with no deadline and no total, and returns "closed" whether or not any attempt
succeeded. It compiles, serves the demo and hides four flaws.

**Failure mode the checks target.** Two defects compound. A timeout is treated as success, so the
period stops being retried even though billing never saw it; and the retry mints a new close id, so
the attempt that does land is a *different* period close from billing's point of view. The first
half under-bills, the second half double-bills.

- The close id is **derived**, not minted: \`close:{account}:{period}\`. Billing dedupes on it, so a
  retry after a timeout carries the *same* id.
- The \`ClosePeriod\` call carries a **5-second deadline** (\`DEADLINE_SECONDS\`). A call without a
  deadline hangs the worker and the period it was closing.
- \`DEADLINE_EXCEEDED\` leaves the period **open**: the close may or may not have landed, so the period
  stays open and the retry reuses the close id.
- The total sent is read from the Redis counters, and the reply is **reconciled** against those same
  counters to the unit; a mismatch leaves the period open rather than reporting a close that does not
  tie out.
- Return \`PERIOD_OPEN\` while the period is not confirmed closed, and \`PERIOD_CLOSED\` only when
  billing has accepted a total that matches the counters.`,
  sequence: {
    participants: ['Metering worker', 'Billing service', 'Usage records'],
    messages: [
      {from: 'Metering worker', to: 'Usage records', label: 'window_total(account, period)', kind: 'sync'},
      {from: 'Usage records', to: 'Metering worker', label: 'units counted', kind: 'reply'},
      {
        from: 'Metering worker',
        to: 'Billing service',
        label: 'ClosePeriod{close_id, total_units} · 5s deadline',
        kind: 'sync',
      },
      {from: 'Billing service', to: 'Metering worker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Metering worker', to: 'Usage records', label: 'period stays open · same close id', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'flush',
      title: 'Flushes the period under its close id',
      detail:
        'The worker calls billing’s `ClosePeriod` with the derived `close_id` and the period total. The starter calls the stub too, but under an id it invents per attempt.',
      match: {
        python: {all: [/billing\.ClosePeriod\(/, /close_id/]},
        typescript: {all: [/billing\.closePeriod\(/, /closeId/]},
        go: {all: [/billing\.ClosePeriod\(/, /CloseID|CloseId/]},
        scala: {all: [/closePeriod\(/, /closeId/]},
        cpp: {all: [/ClosePeriod\(/, /close_id/]},
      },
    },
    {
      id: 'deadline',
      title: 'Bounds the call with a 5-second deadline',
      detail:
        'The `ClosePeriod` call carries a 5-second deadline so a silent billing service cannot hang the worker. The starter calls with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_SECONDS/, /timeout=DEADLINE_SECONDS/]},
        typescript: {all: [/DEADLINE_SECONDS/, /deadline/]},
        go: {all: [/deadlineSeconds/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineSeconds/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadlineSeconds/, /deadline/]},
      },
    },
    {
      id: 'timeout-open',
      title: 'Leaves the period open on a timeout',
      detail:
        '`DEADLINE_EXCEEDED` returns `PERIOD_OPEN` so the period is retried; the starter returns "closed" even though billing never confirmed the close.',
      match: {
        python: {all: [/PERIOD_OPEN/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/PERIOD_OPEN/, /DEADLINE_EXCEEDED/]},
        go: {all: [/(periodOpen|PeriodOpen|PERIOD_OPEN)/, /DeadlineExceeded/]},
        scala: {all: [/PeriodOpen/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/kPeriodOpen/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'same-close-id',
      title: 'Derives one close id per (account, period)',
      detail:
        'The close id is `close:{account}:{period}`, computed from the period — never a fresh id per attempt. The starter mints a random id on every retry, so a late success closes a period that already closed under another id.',
      match: {
        python: {all: [/def close_id\(/, /"close:/], none: [/uuid4\(/]},
        typescript: {all: [/function closeId\(|const closeId/, /close:/], none: [/randomUUID\(/]},
        go: {all: [/func closeID\(/, /"close:/], none: [/uuid\.NewString\(/]},
        scala: {all: [/def closeId\(/, /"close:/], none: [/UUID\.randomUUID\(/]},
        cpp: {all: [/closeId\(/, /"close:"/], none: [/[Uu]uid/]},
      },
    },
    {
      id: 'reconcile',
      title: 'Reconciles the reply against the Redis counters',
      detail:
        'The total sent is the Redis window total and the reply is compared to that same total; a mismatch keeps the period open. The starter never reads the counters, so nothing ties out.',
      match: {
        python: {all: [/window_total\(/, /total_units/]},
        typescript: {all: [/windowTotal\(/, /totalUnits/]},
        go: {all: [/(windowTotal|WindowTotal)\(/, /TotalUnits/]},
        scala: {all: [/windowTotal\(/, /totalUnits/]},
        cpp: {all: [/windowTotal\(/, /total_units/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

import grpc
import redis

import billing_pb2
import billing_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("metering")

channel = grpc.insecure_channel("billing:9000")
billing = billing_pb2_grpc.BillingStub(channel)


def flush_period(account: str, period: str) -> str:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    for _ in range(3):
        close_id = str(uuid.uuid4())
        request = billing_pb2.ClosePeriodRequest(close_id=close_id, account=account, period=period)
        try:
            billing.ClosePeriod(request)
        except grpc.RpcError:
            continue
        return "closed"
    return "closed"
`,
      solution: `import logging

import grpc
import redis

import billing_pb2
import billing_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("metering")

DEADLINE_SECONDS = 5.0
PERIOD_OPEN = "open"
PERIOD_CLOSED = "closed"

channel = grpc.insecure_channel("billing:9000")
billing = billing_pb2_grpc.BillingStub(channel)


def close_id(account: str, period: str) -> str:
    return f"close:{account}:{period}"


def window_total(account: str, period: str) -> int:
    return int(r.hget(f"usage:{{{account}}}:{period}", "units") or 0)


def flush_period(account: str, period: str) -> str:
    total = window_total(account, period)
    request = billing_pb2.ClosePeriodRequest(
        close_id=close_id(account, period),
        account=account,
        period=period,
        total_units=total,
    )
    try:
        reply = billing.ClosePeriod(request, timeout=DEADLINE_SECONDS)
    except grpc.RpcError as error:
        if error.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            logger.warning("billing timeout account=%s period=%s; period stays open", account, period)
            return PERIOD_OPEN
        raise
    if reply.total_units != window_total(account, period):
        logger.warning("reconcile mismatch account=%s period=%s", account, period)
        return PERIOD_OPEN
    return PERIOD_CLOSED
`,
    },
    typescript: {
      starter: `/** Billing flush: flawed code that re-mints the close id on every attempt. */
import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';

import {billing} from './billing_client';

const r = new Redis('redis://redis:6379');

export async function flushPeriod(account: string, period: string): Promise<string> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const closeId = randomUUID();
    try {
      await billing.closePeriod({close_id: closeId, account, period});
    } catch (error) {
      continue;
    }
    return 'closed';
  }
  return 'closed';
}
`,
      solution: `/** Billing flush: one close id per period, a deadline, and a timeout that keeps the period open. */
import * as grpc from '@grpc/grpc-js';

import {billing} from './billing_client';

const r = new Redis('redis://redis:6379');

const DEADLINE_SECONDS = 5;
const PERIOD_OPEN = 'open';
const PERIOD_CLOSED = 'closed';

function closeId(account: string, period: string): string {
  return \`close:\${account}:\${period}\`;
}

async function windowTotal(account: string, period: string): Promise<number> {
  const units = await r.hget(\`usage:{\${account}}:\${period}\`, 'units');
  return Number(units ?? 0);
}

export async function flushPeriod(account: string, period: string): Promise<string> {
  const total = await windowTotal(account, period);
  const deadline = new Date(Date.now() + DEADLINE_SECONDS * 1000);
  try {
    const reply = await billing.closePeriod({close_id: closeId(account, period), account, period, total_units: total}, {
      deadline,
    });
    if (reply.totalUnits !== (await windowTotal(account, period))) return PERIOD_OPEN;
    return PERIOD_CLOSED;
  } catch (error) {
    const status = (error as grpc.ServiceError).code;
    if (status === grpc.status.DEADLINE_EXCEEDED) return PERIOD_OPEN;
    throw error;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/google/uuid"
)

func flushPeriod(ctx context.Context, billing BillingClient, account, period string) string {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < 3; attempt++ {
		closeID := uuid.NewString()
		if _, err := billing.ClosePeriod(ctx, &ClosePeriodRequest{CloseId: closeID, Account: account, Period: period}); err != nil {
			continue
		}
		return "closed"
	}
	return "closed"
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const deadlineSeconds = 5

const (
	periodOpen   = "open"
	periodClosed = "closed"
)

func closeID(account, period string) string {
	return "close:" + account + ":" + period
}

func windowTotal(ctx context.Context, account, period string) (int64, error) {
	return r.HGet(ctx, "usage:{"+account+"}:"+period, "units").Int64()
}

func flushPeriod(ctx context.Context, billing BillingClient, account, period string) (string, error) {
	total, err := windowTotal(ctx, account, period)
	if err != nil {
		return periodOpen, err
	}
	callCtx, cancel := context.WithTimeout(ctx, deadlineSeconds*time.Second)
	defer cancel()
	reply, err := billing.ClosePeriod(callCtx, &ClosePeriodRequest{
		CloseId:   closeID(account, period),
		Account:   account,
		Period:    period,
		TotalUnits: total,
	})
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			return periodOpen, nil
		}
		return periodOpen, err
	}
	reconciled, err := windowTotal(ctx, account, period)
	if err != nil {
		return periodOpen, err
	}
	if reply.TotalUnits != reconciled {
		return periodOpen, nil
	}
	return periodClosed, nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.Status

object Client {
  def flushPeriod(billing: BillingGrpc.BillingBlockingStub, account: String, period: String): String = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    var attempt = 0
    while (attempt < 3) {
      val closeId = UUID.randomUUID().toString
      try {
        billing.closePeriod(ClosePeriodRequest(closeId, account, period, 0L))
        return "closed"
      } catch {
        case _: io.grpc.StatusRuntimeException =>
      }
      attempt += 1
    }
    "closed"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.Status

object Client {
  val DeadlineSeconds = 5L

  val PeriodOpen = "open"
  val PeriodClosed = "closed"

  def closeId(account: String, period: String): String = s"close:$account:$period"

  def windowTotal(account: String, period: String): Long = 0L

  def flushPeriod(billing: BillingGrpc.BillingBlockingStub, account: String, period: String): String = {
    val total = windowTotal(account, period)
    val stub = billing.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
    try {
      val reply = stub.closePeriod(ClosePeriodRequest(closeId(account, period), account, period, total))
      if (reply.totalUnits != windowTotal(account, period)) PeriodOpen else PeriodClosed
    } catch {
      case e: io.grpc.StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        PeriodOpen
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <uuid/uuid.h>

#include <string>

#include "billing.grpc.pb.h"

std::string flushPeriod(std::shared_ptr<grpc::Channel> channel, const std::string& account,
                        const std::string& period) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  auto stub = Billing::NewStub(channel);
  for (int attempt = 0; attempt < 3; ++attempt) {
    uuid_t raw;
    uuid_generate(raw);
    char id[37];
    uuid_unparse(raw, id);
    ClosePeriodRequest request;
    request.set_close_id(id);
    request.set_account(account);
    request.set_period(period);
    grpc::ClientContext context;
    ClosePeriodReply reply;
    if (!stub->ClosePeriod(&context, request, &reply).ok()) {
      continue;
    }
    return "closed";
  }
  return "closed";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "billing.grpc.pb.h"

constexpr long long kDeadlineSeconds = 5;
const std::string kPeriodOpen = "open";
const std::string kPeriodClosed = "closed";

std::string closeId(const std::string& account, const std::string& period) {
  return "close:" + account + ":" + period;
}

long long windowTotal(grpc::ClientContext& ctx, const std::string& account, const std::string& period);

std::string flushPeriod(std::shared_ptr<grpc::Channel> channel, const std::string& account,
                        const std::string& period) {
  auto stub = Billing::NewStub(channel);
  grpc::ClientContext context;
  const long long total = windowTotal(context, account, period);
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
  ClosePeriodRequest request;
  request.set_close_id(closeId(account, period));
  request.set_account(account);
  request.set_period(period);
  request.set_total_units(total);
  ClosePeriodReply reply;
  const grpc::Status status = stub->ClosePeriod(&context, request, &reply);
  if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
    return kPeriodOpen;
  }
  if (!status.ok()) {
    return kPeriodOpen;
  }
  grpc::ClientContext reconcileContext;
  if (reply.total_units() != windowTotal(reconcileContext, account, period)) {
    return kPeriodOpen;
  }
  return kPeriodClosed;
}
`,
    },
  },
  hints: [
    'Stall the billing stub for a minute: the worker hangs, then reports the period closed although billing has nothing for it. Let two attempts land and the invoice shows the period twice.',
    'Each loop iteration builds a new `uuid4()` close id, calls with no timeout, swallows every `RpcError` and falls through to "closed". Nothing is read from Redis and nothing in the reply is compared.',
    'Compute `close_id(account, period)` as `close:{account}:{period}`, pass `timeout=DEADLINE_SECONDS`, return `PERIOD_OPEN` on `DEADLINE_EXCEEDED`, send `window_total(account, period)` and compare the reply `total_units` before `PERIOD_CLOSED`.',
  ],
  debrief: `The close id is a pure function of what is being closed because that is the only way a retry
can tell billing "this is the same close again". A deadline translates into "still open" rather than
"closed" because the worker cannot know which side of the timeout the request landed on, and open is
the state a retry can recover from while closed is not. Reconciling the reply against the counters
that produced the number closes the loop: a period is closed when billing agrees on the total, not
when the RPC returns. Production flushes usually write a durable outbox row per period so a worker
crash does not lose the attempt, and alert on any period that stays open longer than one window.`,
};
