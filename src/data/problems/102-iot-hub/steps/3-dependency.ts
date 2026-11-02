import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Device gateway calls with offline queue semantics',
  concept: 'grpc',
  file: 'client',
  focus: ['hub', 'gateway', 'device'],
  task: `## Task

**Starting point.** The starter's \`deliver(command)\` loops with \`while True\`: it calls
\`gateway.Deliver\` with \`command_id\` and \`device_id\`, returns \`True\` when \`reply.accepted\` is
set, swallows every \`grpc.RpcError\`, and sleeps one second between attempts. It compiles and
hides five flaws.

**Failure mode the checks target.** A device that stays offline for days is poked once a second for
days; a gateway that accepts the connection and then says nothing holds the worker open; and a
command the gateway merely queued is recorded as delivered, so a door that did not unlock looks
like one that did.

Requirements:

- \`DEADLINE_S = 5\`: every \`Deliver\` call carries \`timeout=DEADLINE_S\`.
- \`MAX_ATTEMPTS = 3\`: the loop runs while \`attempts < MAX_ATTEMPTS\` and
  \`time.time() < command.expires_at\`. No \`while True\`, no \`time.sleep\`.
- The request carries the window as \`expires_at_ms=int(command.expires_at * 1000)\`. The gateway
  queues an offline device's command only until then and answers \`DeliverReply.EXPIRED\` after;
  handle that as a final \`False\`.
- \`RETRYABLE = {UNAVAILABLE, DEADLINE_EXCEEDED}\`: any other status code (\`not in RETRYABLE\`) is
  raised to the caller at once.
- Return \`True\` only on \`reply.status == gateway_pb2.DeliverReply.DELIVERED\`, the device's own
  acknowledgment. Do not read \`reply.accepted\`; \`QUEUED\` means the gateway took the command and
  nothing more.`,
  sequence: {
    participants: ['IoT Hub', 'Device Gateway', 'Device'],
    messages: [
      {
        from: 'IoT Hub',
        to: 'Device Gateway',
        label: 'Deliver(command_id) · deadline 5 s · expires_at_ms',
        kind: 'sync',
      },
      {from: 'Device Gateway', to: 'Device', label: 'push command', kind: 'sync'},
      {from: 'Device', to: 'Device Gateway', label: 'ack', kind: 'reply'},
      {from: 'Device Gateway', to: 'IoT Hub', label: 'DELIVERED — the device’s ack, not an enqueue', kind: 'reply'},
      {
        from: 'Device Gateway',
        to: 'Device Gateway',
        label: 'offline → queue only until expires_at, then drop · EXPIRED',
        kind: 'sync',
      },
      {
        from: 'IoT Hub',
        to: 'IoT Hub',
        label: 'retry ≤ 3 attempts while the window is open — never a fresh loop',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'A lock that lost its uplink on Friday shows every command as delivered in the operator console, and on Monday the gateway logs show the hub calling `Deliver` for it 250,000 times.',
    '`while True` with `time.sleep(1)` has no exit except `reply.accepted`, which the gateway sets as soon as it enqueues, so an offline device both spins the loop and reports success.',
    'Loop on `attempts < MAX_ATTEMPTS and time.time() < command.expires_at`, pass `timeout=DEADLINE_S`, return `True` only on `DeliverReply.DELIVERED`. The checks also cover `RETRYABLE`, `expires_at_ms` and `EXPIRED`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every delivery attempt carries a 5 s deadline',
      detail:
        'The `Deliver` call is created with a **5 s** deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout(ctx, deadlineS*time.Second)`, `withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)` or `set_deadline`. Without one a gateway that never answers holds the hub’s delivery worker open indefinitely; the starter calls `Deliver` with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*5/, /timeout=DEADLINE_S/, /\.Deliver\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Deliver\(/]},
        go: {all: [/deadlineS\s*=\s*5/, /context\.WithTimeout\(ctx,\s*deadlineS\s*\*\s*time\.Second\)/, /\.Deliver\(/]},
        scala: {all: [/DeadlineS\s*=\s*5/, /withDeadlineAfter\(DeadlineS,\s*TimeUnit\.SECONDS\)/, /\.deliver\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*5000/, /set_deadline\(/, /->Deliver\(/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Attempts are capped and stop at the validity window',
      detail:
        '`MAX_ATTEMPTS = 3` caps the attempts and the loop condition also stops at the command’s `expires_at`, so a device that stays offline is not retried past the window. The starter’s `while True` has no cap and never looks at the window.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempts\s*<\s*MAX_ATTEMPTS/, /time\.time\(\)\s*<\s*command\.expires_at/],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /Date\.now\(\)\s*<\s*command\.expiresAt/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /time\.Now\(\)\.Before\(command\.ExpiresAt\)/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {
          all: [
            /MaxAttempts\s*=\s*3/,
            /attempt\s*<\s*MaxAttempts/,
            /System\.currentTimeMillis\(\)\s*<\s*command\.expiresAt/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kMaxAttempts/,
            /std::chrono::system_clock::now\(\)\s*<\s*command\.expires_at/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'offline-queue-until-expiry',
      title: 'An offline device’s command expires with its window',
      detail:
        'The command’s validity window travels with the request (`expires_at_ms` / `expiresAtMs` / `ExpiresAtMs`) and the gateway’s `EXPIRED` outcome is handled: a command whose window closed is dropped by the queue and never delivered late or retried. The starter never sends the window, never checks it, and pokes the gateway on a fixed one-second timer instead.',
      match: {
        python: {all: [/expires_at_ms=int\(command\.expires_at/, /DeliverReply\.EXPIRED/], none: [/time\.sleep\(/]},
        typescript: {
          all: [/expiresAtMs:\s*command\.expiresAt/, /DeliverStatus\.EXPIRED/],
          none: [/setTimeout\([^)]*,\s*1000\s*\)/],
        },
        go: {
          all: [/ExpiresAtMs:\s*command\.ExpiresAt\.UnixMilli\(\)/, /pb\.DeliverReply_EXPIRED/],
          none: [/time\.Sleep\(/],
        },
        scala: {
          all: [/expiresAtMs\s*=\s*command\.expiresAt/, /DeliverReply\.Status\.EXPIRED/],
          none: [/Thread\.sleep\(/],
        },
        cpp: {all: [/set_expires_at_ms\(/, /DeliverReply::EXPIRED/], none: [/sleep_for\(/]},
      },
    },
    {
      id: 'ack-required',
      title: 'Delivered means the device acknowledged it',
      detail:
        '`DELIVERED` — the device’s acknowledgment — is the only reply that counts as delivered. The gateway accepting the enqueue (`accepted` / `Accepted`) is not delivery: returning on it records a door as unlocked that never was. The starter returns success the moment the gateway accepts the enqueue.',
      match: {
        python: {all: [/reply\.status\s*==\s*gateway_pb2\.DeliverReply\.DELIVERED/], none: [/reply\.accepted/]},
        typescript: {all: [/reply\.status\s*===\s*DeliverStatus\.DELIVERED/], none: [/reply\.accepted/]},
        go: {all: [/reply\.Status\s*==\s*pb\.DeliverReply_DELIVERED/], none: [/reply\.Accepted/]},
        scala: {all: [/reply\.status\s*==\s*DeliverReply\.Status\.DELIVERED/], none: [/reply\.accepted/]},
        cpp: {all: [/reply\.status\(\)\s*==\s*DeliverReply::DELIVERED/], none: [/reply\.accepted\(\)/]},
      },
    },
    {
      id: 'no-infinite-retry',
      title: 'No unbounded retry: only the retryable codes are retried',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retryable, gated by a `RETRYABLE` set (a `retryable` predicate in Go and C++), so a permanent failure exits instead of spinning. There is no `while True` / `for (;;)` loop and no one-second sleep hammering the gateway for an offline device; the starter retries every failure forever.',
      match: {
        python: {all: [/RETRYABLE\s*=\s*\{/, /not\s+in\s+RETRYABLE/], none: [/while\s+True/, /time\.sleep\(/]},
        typescript: {
          all: [/const RETRYABLE/, /RETRYABLE\[/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/, /setTimeout\([^)]*,\s*1000\s*\)/],
        },
        go: {
          all: [/retryable\s*=\s*map\[codes\.Code\]bool/, /retryable\[status\.Code\(err\)\]/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/, /time\.Sleep\(/],
        },
        scala: {
          all: [/Retryable\s*=\s*Set\(Status\.Code\.UNAVAILABLE/, /Retryable\.contains\(/],
          none: [/while\s*\(\s*true\s*\)/, /Thread\.sleep\(/],
        },
        cpp: {
          all: [/retryable\(status\)/, /grpc::StatusCode::UNAVAILABLE/, /grpc::StatusCode::DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /sleep_for\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import gateway_pb2
import gateway_pb2_grpc

channel = grpc.insecure_channel("gateway:50051")
gateway = gateway_pb2_grpc.DeviceGatewayStub(channel)


class Command:
    id: str
    device_id: str
    expires_at: float  # epoch seconds; the command is useless after this


def deliver(command) -> bool:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while True:
        try:
            reply = gateway.Deliver(
                gateway_pb2.DeliverRequest(command_id=command.id, device_id=command.device_id)
            )
            if reply.accepted:
                return True
        except grpc.RpcError:
            pass
        time.sleep(1)
`,
      solution: `import time

import grpc

import gateway_pb2
import gateway_pb2_grpc

DEADLINE_S = 5
MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("gateway:50051")
gateway = gateway_pb2_grpc.DeviceGatewayStub(channel)


class Command:
    id: str
    device_id: str
    expires_at: float  # epoch seconds; the command is useless after this


def deliver(command) -> bool:
    """Deliver a command; True only when the device acknowledged it inside its window.

    Every attempt carries DEADLINE_S. Attempts stop at MAX_ATTEMPTS or at the command's validity
    window: an offline device's command rests in the gateway queue only until expires_at, where
    the queue drops it, so a fresh retry loop would spin for days on a command that cannot run.
    """
    attempts = 0
    while attempts < MAX_ATTEMPTS and time.time() < command.expires_at:
        attempts += 1
        request = gateway_pb2.DeliverRequest(
            command_id=command.id,
            device_id=command.device_id,
            expires_at_ms=int(command.expires_at * 1000),
        )
        try:
            reply = gateway.Deliver(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                raise
            continue
        if reply.status == gateway_pb2.DeliverReply.DELIVERED:
            return True  # the device acknowledged it: the only proof of delivery
        if reply.status == gateway_pb2.DeliverReply.EXPIRED:
            return False  # the window closed and the queue dropped the command
    return False
`,
    },
    typescript: {
      starter: `/** Device gateway client: delivers one command to a device through the gateway. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface DeliverReply {
  accepted: boolean;
  status: number;
}

interface DeviceGatewayClient {
  Deliver(
    request: {commandId: string; deviceId: string},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: DeliverReply) => void,
  ): grpc.ClientUnaryCall;
}

const iot = grpc.loadPackageDefinition(protoLoader.loadSync('gateway.proto')) as unknown as {
  iot: {DeviceGateway: new (target: string, credentials: grpc.ChannelCredentials) => DeviceGatewayClient};
};
const gateway = new iot.DeviceGateway('gateway:50051', grpc.credentials.createInsecure());

export interface Command {
  id: string;
  deviceId: string;
  /** Epoch millis: the command is useless after this passes. */
  expiresAt: number;
}

export function deliver(command: Command): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const {promise, resolve} = Promise.withResolvers<boolean>();
  const attempt = (): void => {
    gateway.Deliver(
      {commandId: command.id, deviceId: command.deviceId},
      new grpc.Metadata(),
      {},
      (error, reply) => {
        if (error === null && reply.accepted) resolve(true);
        else setTimeout(attempt, 1000);
      },
    );
  };
  attempt();
  return promise;
}
`,
      solution: `/** Device gateway client: 5 s deadline, bounded retries, delivery only on the device's ack. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 5000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

/** Mirrors DeliverReply.Status in gateway.proto. */
const DeliverStatus = {QUEUED: 0, DELIVERED: 1, EXPIRED: 2} as const;

interface DeliverReply {
  status: number;
}

interface DeviceGatewayClient {
  Deliver(
    request: {commandId: string; deviceId: string; expiresAtMs: number},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: DeliverReply) => void,
  ): grpc.ClientUnaryCall;
}

export interface Command {
  id: string;
  deviceId: string;
  /** Epoch millis: the gateway queues the command only until this passes. */
  expiresAt: number;
}

const iot = grpc.loadPackageDefinition(protoLoader.loadSync('gateway.proto')) as unknown as {
  iot: {DeviceGateway: new (target: string, credentials: grpc.ChannelCredentials) => DeviceGatewayClient};
};
const gateway = new iot.DeviceGateway('gateway:50051', grpc.credentials.createInsecure());

function callGateway(command: Command): Promise<DeliverReply> {
  const {promise, resolve, reject} = Promise.withResolvers<DeliverReply>();
  gateway.Deliver(
    {commandId: command.id, deviceId: command.deviceId, expiresAtMs: command.expiresAt},
    new grpc.Metadata(),
    {deadline: Date.now() + DEADLINE_MS},
    (error, reply) => (error === null ? resolve(reply) : reject(error)),
  );
  return promise;
}

export async function deliver(command: Command): Promise<boolean> {
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS && Date.now() < command.expiresAt) {
    attempt += 1;
    let reply: DeliverReply;
    try {
      reply = await callGateway(command);
    } catch (error) {
      if (RETRYABLE[(error as grpc.ServiceError).code] !== true) throw error;
      continue;
    }
    if (reply.status === DeliverStatus.DELIVERED) return true;
    if (reply.status === DeliverStatus.EXPIRED) return false;
    // QUEUED: the device is offline; the gateway holds the command only until expiresAt, so
    // the loop ends with the window instead of poking the gateway once a second.
  }
  return false;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	pb "iothub/gatewaypb"
)

type Command struct {
	ID        string
	DeviceID  string
	ExpiresAt time.Time
}

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func deliver(ctx context.Context, client pb.DeviceGatewayClient, command Command) (bool, error) {
	for attempt := 0; ; attempt++ {
		reply, err := client.Deliver(ctx, &pb.DeliverRequest{
			CommandId: command.ID,
			DeviceId:  command.DeviceID,
		})
		if err == nil && reply.Accepted {
			return true, nil
		}
		time.Sleep(time.Second)
	}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "iothub/gatewaypb"
)

const (
	deadlineS   = 5
	maxAttempts = 3
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type Command struct {
	ID        string
	DeviceID  string
	ExpiresAt time.Time
}

// deliver returns true only when the device acknowledged the command inside its validity window;
// an offline device's command is queued by the gateway only until command.ExpiresAt, then dropped.
func deliver(ctx context.Context, client pb.DeviceGatewayClient, command Command) (bool, error) {
	for attempt := 0; attempt < maxAttempts && time.Now().Before(command.ExpiresAt); attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
		reply, err := client.Deliver(callCtx, &pb.DeliverRequest{
			CommandId:   command.ID,
			DeviceId:    command.DeviceID,
			ExpiresAtMs: command.ExpiresAt.UnixMilli(),
		})
		cancel()
		if err != nil {
			if !retryable[status.Code(err)] {
				return false, err
			}
			continue
		}
		if reply.Status == pb.DeliverReply_DELIVERED {
			return true, nil
		}
		if reply.Status == pb.DeliverReply_EXPIRED {
			return false, nil
		}
	}
	return false, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

final case class Command(id: String, deviceId: String, expiresAt: Long)

object DeviceDelivery {
  val gateway =
    DeviceGatewayGrpc.blockingStub(ManagedChannelBuilder.forAddress("gateway", 50051).usePlaintext().build())

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def deliver(command: Command): Boolean = {
    var delivered = false
    while (!delivered) {
      try {
        val reply = gateway.deliver(DeliverRequest(commandId = command.id, deviceId = command.deviceId))
        delivered = reply.accepted
      } catch {
        case _: StatusRuntimeException => ()
      }
      if (!delivered) Thread.sleep(1000)
    }
    delivered
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class Command(id: String, deviceId: String, expiresAt: Long)

object DeviceDelivery {
  val DeadlineS = 5
  val MaxAttempts = 3
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val gateway =
    DeviceGatewayGrpc.blockingStub(ManagedChannelBuilder.forAddress("gateway", 50051).usePlaintext().build())

  /** True only when the device acknowledged the command inside its validity window. */
  def deliver(command: Command): Boolean = {
    var attempt = 0
    while (attempt < MaxAttempts && System.currentTimeMillis() < command.expiresAt) {
      attempt += 1
      try {
        val reply = gateway
          .withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)
          .deliver(
            DeliverRequest(
              commandId = command.id,
              deviceId = command.deviceId,
              expiresAtMs = command.expiresAt,
            )
          )
        if (reply.status == DeliverReply.Status.DELIVERED) return true
        if (reply.status == DeliverReply.Status.EXPIRED) return false
        // QUEUED: offline; the gateway keeps the command only until expiresAt, never a fresh loop.
      } catch {
        case exc: StatusRuntimeException =>
          if (!Retryable.contains(exc.getStatus.getCode)) throw exc
      }
    }
    false
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "gateway.grpc.pb.h"

#include <chrono>
#include <string>
#include <thread>

struct Command {
  std::string id;
  std::string device_id;
  std::chrono::system_clock::time_point expires_at;
};

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
bool deliver(DeviceGateway::Stub* gateway, const Command& command) {
  while (true) {
    grpc::ClientContext ctx;
    DeliverRequest request;
    request.set_command_id(command.id);
    request.set_device_id(command.device_id);
    DeliverReply reply;
    gateway->Deliver(&ctx, request, &reply);
    if (reply.accepted()) return true;
    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "gateway.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>

constexpr int kDeadlineMs = 5000;
constexpr int kMaxAttempts = 3;

struct Command {
  std::string id;
  std::string device_id;
  std::chrono::system_clock::time_point expires_at;
};

namespace {

bool retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE ||
         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

int64_t to_unix_ms(const std::chrono::system_clock::time_point& when) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(when.time_since_epoch()).count();
}

}  // namespace

// True only when the device acknowledged (DELIVERED) inside the command's validity window; an
// offline device's command is queued by the gateway only until command.expires_at, then dropped.
bool deliver(DeviceGateway::Stub* gateway, const Command& command) {
  for (int attempt = 0; attempt < kMaxAttempts && std::chrono::system_clock::now() < command.expires_at;
       ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    DeliverRequest request;
    request.set_command_id(command.id);
    request.set_device_id(command.device_id);
    request.set_expires_at_ms(to_unix_ms(command.expires_at));
    DeliverReply reply;
    const grpc::Status status = gateway->Deliver(&ctx, request, &reply);
    if (!status.ok()) {
      if (!retryable(status)) throw std::runtime_error(status.error_message());
      continue;
    }
    if (reply.status() == DeliverReply::DELIVERED) return true;
    if (reply.status() == DeliverReply::EXPIRED) return false;
  }
  return false;
}
`,
    },
  },
  debrief: `Three bounds replace one open loop. The 5-second deadline bounds a single attempt, so a
silent gateway costs at most five seconds of worker time. \`MAX_ATTEMPTS\` and \`expires_at\` bound
the whole delivery, and the window is what matters for an offline device: the gateway's queue drops
the command at that instant, so a hub-side retry after it is work for a command that cannot run.
\`RETRYABLE\` keeps the loop from re-sending on a permanent failure such as \`NOT_FOUND\`.
\`DELIVERED\` is the only success because only the device can confirm the side effect. This step has
no answer for a gateway that is itself unreachable; a production hub parks the command in an outbox
for a sweeper to re-drive, and expires queued commands on a schedule.`,
};
