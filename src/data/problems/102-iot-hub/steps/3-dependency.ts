import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Device gateway calls with a deadline and the command window',
  concept: 'grpc',
  file: 'client',
  focus: ['hub', 'gateway', 'device'],
  task: `## Task

**Starting point.** The starter is the delivery worker's call to the device gateway:
\`deliver(command)\` sends \`DeviceGateway.Deliver\` with the command's id, device, action and params,
answers \`"delivered"\` as soon as a reply has \`accepted\` set, and otherwise swallows the error,
sleeps a second and calls again, with no end. Against a connected lock it delivers, and it hides
four flaws.

**Failure mode the checks target.** A gateway that accepts the connection and never answers holds
the worker forever; a gateway that is down is called once a second for days; a command for a lock
offline over the weekend runs when the lock reconnects; and a command the gateway only queued is
reported delivered.

\`\`\`proto
service DeviceGateway { rpc Deliver(DeliverRequest) returns (DeliverReply); }
// DeliverReply.status: DELIVERED (the device acknowledged) · QUEUED (held for an offline device) · EXPIRED
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 5 s** deadline.
- At most \`MAX_ATTEMPTS\` = 3 attempts, \`BACKOFF_S\` = 1 s apart, only while now < \`expires_at_ms\`;
  only \`RETRYABLE\` codes (UNAVAILABLE, DEADLINE_EXCEEDED) are retried, any other is \`"failed"\` at once.
- The request carries \`expires_at_ms\`. A command whose window has closed is not sent and answers
  \`"expired"\`, as does an \`EXPIRED\` reply; spent attempts inside the window answer \`"failed"\`.
- \`DELIVERED\` answers \`"delivered"\`, \`QUEUED\` answers \`"queued"\`; \`accepted\` decides nothing.`,
  sequence: {
    participants: ['Delivery worker', 'Device gateway', 'Device'],
    messages: [
      {from: 'Delivery worker', to: 'Device gateway', label: 'Deliver · deadline 5 s · expires_at_ms', kind: 'sync'},
      {from: 'Device gateway', to: 'Device', label: 'push command', kind: 'sync'},
      {from: 'Device', to: 'Device gateway', label: 'ack', kind: 'reply'},
      {
        from: 'Device gateway',
        to: 'Delivery worker',
        label: 'DELIVERED · or QUEUED until expires_at_ms',
        kind: 'reply',
      },
      {
        from: 'Delivery worker',
        to: 'Delivery worker',
        label: 'UNAVAILABLE → retry ≤ 3, inside the window',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Deliver call carries a 5-second deadline',
      detail:
        'Each attempt is made with `DEADLINE_S` (5 s), so a gateway that never answers costs at most three deadlines; the starter calls with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*5\b/, /\.Deliver\([^)\n]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineS\s*=\s*5L?\b/, /withDeadlineAfter\(\s*DeadlineS/]},
        cpp: {all: [/kDeadline\{5\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries three times, and only what can succeed on retry',
      detail:
        'At most `MAX_ATTEMPTS` = 3 calls, and only after a `RETRYABLE` code (UNAVAILABLE, DEADLINE_EXCEEDED); any other code answers `failed` after one call. The starter loops until a reply says `accepted`.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /RETRYABLE/, /attempts\s*<\s*MAX_ATTEMPTS/],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /RETRYABLE/, /attempts\s*<\s*MAX_ATTEMPTS/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxAttempts\s*=\s*3\b/, /retryable\[/, /attempt\s*<\s*maxAttempts/], none: [/\bfor\s*\{/]},
        scala: {
          all: [/MaxAttempts\s*=\s*3\b/, /Retryable/, /attempts\s*<\s*MaxAttempts/],
          none: [/while\s*\(\s*(true|!delivered)\s*\)/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*3\b/, /kRetryable/, /attempt\s*<\s*kMaxAttempts/],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'window',
      title: 'Sends the validity window and stops at it',
      detail:
        "The request carries the command's `expires_at_ms`, a command past it is not sent, and an `EXPIRED` reply answers `expired`; the starter sends no window, so the gateway keeps the command for an offline lock indefinitely.",
      match: {
        python: {all: [/expires_at_ms\s*=\s*command\[["']expires_at_ms["']\]/, /\.EXPIRED\b/]},
        typescript: {all: [/expires_at_ms:\s*(expiresAtMs|command\.expires_at_ms)/, /EXPIRED/]},
        go: {all: [/ExpiresAtMs:\s*command\.ExpiresAtMs/, /DeliveryStatus_EXPIRED/]},
        scala: {all: [/expiresAtMs\s*=\s*command\.expiresAtMs/, /DeliveryStatus\.EXPIRED/]},
        cpp: {all: [/set_expires_at_ms\(\s*command\.expires_at_ms/, /devicegw::EXPIRED/]},
      },
    },
    {
      id: 'acknowledged',
      title: 'Delivered means the device acknowledged',
      detail:
        "Only `DELIVERED`, the device's acknowledgement, answers `delivered`; `QUEUED` answers `queued`. The starter returns `delivered` on `accepted`, which the gateway also sets when it only queued the command.",
      match: {
        python: {all: [/\.DELIVERED\b/, /["']queued["']/], none: [/\.accepted\b/]},
        typescript: {all: [/DELIVERED/, /['"]queued['"]/], none: [/\.accepted\b/]},
        go: {all: [/DeliveryStatus_DELIVERED/, /"queued"/], none: [/GetAccepted\(\)|\.Accepted\b/]},
        scala: {all: [/DeliveryStatus\.DELIVERED/, /"queued"/], none: [/\.accepted\b/]},
        cpp: {all: [/devicegw::DELIVERED/, /"queued"/], none: [/\.accepted\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import grpc

import iot_hub_pb2
import iot_hub_pb2_grpc

gateway = iot_hub_pb2_grpc.DeviceGatewayStub(grpc.insecure_channel("gateway:50051"))


def deliver(command: dict) -> str:
    """Send a recorded command to its device: "delivered", "queued", "expired" or "failed"."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    request = iot_hub_pb2.DeliverRequest(
        command_id=command["command_id"],
        device_id=command["device_id"],
        action=command["action"],
        params_json=json.dumps(command["params"]),
    )
    while True:
        try:
            reply = gateway.Deliver(request)
            if reply.accepted:
                return "delivered"
        except grpc.RpcError:
            pass
        time.sleep(1)
`,
      solution: `import json
import time

import grpc

import iot_hub_pb2
import iot_hub_pb2_grpc

DEADLINE_S = 5
MAX_ATTEMPTS = 3
BACKOFF_S = 1
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
OUTCOMES = {iot_hub_pb2.DELIVERED: "delivered", iot_hub_pb2.QUEUED: "queued", iot_hub_pb2.EXPIRED: "expired"}

gateway = iot_hub_pb2_grpc.DeviceGatewayStub(grpc.insecure_channel("gateway:50051"))


def deliver(command: dict) -> str:
    """Send a recorded command to its device: "delivered", "queued", "expired" or "failed"."""
    request = iot_hub_pb2.DeliverRequest(
        command_id=command["command_id"],
        device_id=command["device_id"],
        action=command["action"],
        params_json=json.dumps(command["params"]),
        # The gateway's queue drops the command at the end of its window, with or without the hub.
        expires_at_ms=command["expires_at_ms"],
    )
    attempts = 0
    while attempts < MAX_ATTEMPTS and time.time() * 1000 < command["expires_at_ms"]:
        attempts += 1
        try:
            reply = gateway.Deliver(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                return "failed"  # the gateway refused the command: asking again changes nothing
            time.sleep(BACKOFF_S)
            continue
        # Only the device's acknowledgement is a delivery; QUEUED means the gateway holds it.
        return OUTCOMES.get(reply.status, "failed")
    return "expired" if time.time() * 1000 >= command["expires_at_ms"] else "failed"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Command} from 'iothub/commands';

interface DeliverRequest {
  command_id: string;
  device_id: string;
  action: string;
  params_json: string;
  expires_at_ms?: number;
}

interface DeliverReply {
  status: string;
  accepted: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('iot_hub.proto')) as unknown as {
  devicegw: {DeviceGateway: grpc.ServiceClientConstructor};
};
const gateway = new pkg.devicegw.DeviceGateway('gateway:50051', grpc.credentials.createInsecure()) as grpc.Client & {
  Deliver(request: DeliverRequest, options: grpc.CallOptions): Promise<DeliverReply>;
};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Send a recorded command to its device: "delivered", "queued", "expired" or "failed". */
export async function deliver(command: Command): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const request: DeliverRequest = {
    command_id: command.command_id,
    device_id: command.device_id,
    action: command.action,
    params_json: JSON.stringify(command.params),
  };
  while (true) {
    try {
      const reply = await gateway.Deliver(request, {});
      if (reply.accepted) return 'delivered';
    } catch {
      // the gateway is flaky: try again
    }
    await sleep(1000);
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Command} from 'iothub/commands';

export const DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 1000;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);
const OUTCOMES: Record<string, string> = {DELIVERED: 'delivered', QUEUED: 'queued', EXPIRED: 'expired'};

interface DeliverRequest {
  command_id: string;
  device_id: string;
  action: string;
  params_json: string;
  expires_at_ms?: number;
}

interface DeliverReply {
  status: string;
  accepted: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('iot_hub.proto')) as unknown as {
  devicegw: {DeviceGateway: grpc.ServiceClientConstructor};
};
const gateway = new pkg.devicegw.DeviceGateway('gateway:50051', grpc.credentials.createInsecure()) as grpc.Client & {
  Deliver(request: DeliverRequest, options: grpc.CallOptions): Promise<DeliverReply>;
};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Send a recorded command to its device: "delivered", "queued", "expired" or "failed". */
export async function deliver(command: Command): Promise<string> {
  const expiresAtMs = command.expires_at_ms ?? 0;
  const request: DeliverRequest = {
    command_id: command.command_id,
    device_id: command.device_id,
    action: command.action,
    params_json: JSON.stringify(command.params),
    // The gateway's queue drops the command at the end of its window, with or without the hub.
    expires_at_ms: expiresAtMs,
  };
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS && Date.now() < expiresAtMs) {
    attempts += 1;
    let reply: DeliverReply;
    try {
      reply = await gateway.Deliver(request, {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      // A code outside RETRYABLE means the gateway refused the command: asking again changes nothing.
      if (!RETRYABLE.has((e as grpc.ServiceError).code)) return 'failed';
      await sleep(BACKOFF_MS);
      continue;
    }
    // Only the device's acknowledgement is a delivery; QUEUED means the gateway holds it.
    return OUTCOMES[reply.status] ?? 'failed';
  }
  return Date.now() >= expiresAtMs ? 'expired' : 'failed';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"iothub/commands" // commands.Command
	pb "iothub/gen/iot_hub"
)

var (
	gatewayConn, _ = grpc.NewClient("gateway:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	gateway        = pb.NewDeviceGatewayClient(gatewayConn)
)

// deliver sends a recorded command to its device: "delivered", "queued", "expired" or "failed".
func deliver(ctx context.Context, command *commands.Command) string {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	params, _ := json.Marshal(command.Params)
	request := &pb.DeliverRequest{CommandId: command.CommandID, DeviceId: command.DeviceID, Action: command.Action, ParamsJson: string(params)}
	for {
		reply, err := gateway.Deliver(ctx, request)
		if err == nil && reply.GetAccepted() {
			return "delivered"
		}
		time.Sleep(time.Second)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"iothub/commands" // commands.Command
	pb "iothub/gen/iot_hub"
)

const (
	deadline    = 5 * time.Second
	maxAttempts = 3
	backoff     = time.Second
)

var (
	gatewayConn, _ = grpc.NewClient("gateway:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	gateway        = pb.NewDeviceGatewayClient(gatewayConn)
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var outcomes = map[pb.DeliveryStatus]string{
	pb.DeliveryStatus_DELIVERED: "delivered",
	pb.DeliveryStatus_QUEUED:    "queued",
	pb.DeliveryStatus_EXPIRED:   "expired",
}

// deliver sends a recorded command to its device: "delivered", "queued", "expired" or "failed".
func deliver(ctx context.Context, command *commands.Command) string {
	params, _ := json.Marshal(command.Params)
	request := &pb.DeliverRequest{
		CommandId: command.CommandID, DeviceId: command.DeviceID, Action: command.Action, ParamsJson: string(params),
		// The gateway's queue drops the command at the end of its window, with or without the hub.
		ExpiresAtMs: command.ExpiresAtMs,
	}
	for attempt := 0; attempt < maxAttempts && time.Now().UnixMilli() < command.ExpiresAtMs; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := gateway.Deliver(callCtx, request)
		cancel()
		if err != nil {
			if !retryable[status.Code(err)] {
				return "failed" // the gateway refused the command: asking again changes nothing
			}
			time.Sleep(backoff)
			continue
		}
		// Only the device's acknowledgement is a delivery; QUEUED means the gateway holds it.
		if outcome, ok := outcomes[reply.GetStatus()]; ok {
			return outcome
		}
		return "failed"
	}
	if time.Now().UnixMilli() >= command.ExpiresAtMs {
		return "expired"
	}
	return "failed"
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

import devicegw.iot_hub.{DeliverRequest, DeviceGatewayGrpc}
import iothub.Command

object GatewayClient {
  private val gateway = DeviceGatewayGrpc.blockingStub(ManagedChannelBuilder.forAddress("gateway", 50051).usePlaintext().build())

  /** Send a recorded command to its device: "delivered", "queued", "expired" or "failed". */
  def deliver(command: Command): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val params = JsObject(command.params.map { case (k, v) => k -> JsString(v) }).compactPrint
    val request = DeliverRequest(commandId = command.commandId, deviceId = command.deviceId, action = command.action, paramsJson = params)
    var delivered = false
    while (!delivered) {
      try delivered = gateway.deliver(request).accepted
      catch { case _: StatusRuntimeException => () } // the gateway is flaky: try again
      if (!delivered) Thread.sleep(1000)
    }
    "delivered"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import spray.json._

import devicegw.iot_hub.{DeliverRequest, DeliveryStatus, DeviceGatewayGrpc}
import iothub.Command

object GatewayClient {
  val DeadlineS = 5L
  val MaxAttempts = 3
  val BackoffMs = 1000L
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val gateway = DeviceGatewayGrpc.blockingStub(ManagedChannelBuilder.forAddress("gateway", 50051).usePlaintext().build())

  /** Send a recorded command to its device: "delivered", "queued", "expired" or "failed". */
  def deliver(command: Command): String = {
    val params = JsObject(command.params.map { case (k, v) => k -> JsString(v) }).compactPrint
    // The gateway's queue drops the command at the end of its window, with or without the hub.
    val request = DeliverRequest(commandId = command.commandId, deviceId = command.deviceId, action = command.action, paramsJson = params,
      expiresAtMs = command.expiresAtMs)
    var attempts = 0
    while (attempts < MaxAttempts && System.currentTimeMillis() < command.expiresAtMs) {
      attempts += 1
      try {
        // Only the device's acknowledgement is a delivery; QUEUED means the gateway holds it.
        return gateway.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).deliver(request).status match {
          case DeliveryStatus.DELIVERED => "delivered"
          case DeliveryStatus.QUEUED => "queued"
          case DeliveryStatus.EXPIRED => "expired"
          case _ => "failed"
        }
      } catch {
        // The gateway refused the command: asking again changes nothing.
        case e: StatusRuntimeException if !Retryable.contains(e.getStatus.getCode) => return "failed"
        case _: StatusRuntimeException => Thread.sleep(BackoffMs)
      }
    }
    if (System.currentTimeMillis() >= command.expiresAtMs) "expired" else "failed"
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <thread>

#include "iot_hub.grpc.pb.h"
#include "iothub/commands.h"  // commands::Command

auto gateway = devicegw::DeviceGateway::NewStub(grpc::CreateChannel("gateway:50051", grpc::InsecureChannelCredentials()));

// Send a recorded command to its device: "delivered", "queued", "expired" or "failed".
std::string deliver(const commands::Command& command) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  devicegw::DeliverRequest request;
  request.set_command_id(command.command_id);
  request.set_device_id(command.device_id);
  request.set_action(command.action);
  request.set_params_json(nlohmann::json(command.params).dump());
  while (true) {
    grpc::ClientContext ctx;
    devicegw::DeliverReply reply;
    if (gateway->Deliver(&ctx, request, &reply).ok() && reply.accepted()) return "delivered";
    std::this_thread::sleep_for(std::chrono::seconds{1});  // the gateway is flaky: try again
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <set>
#include <string>
#include <thread>

#include "iot_hub.grpc.pb.h"
#include "iothub/commands.h"  // commands::Command

constexpr std::chrono::seconds kDeadline{5};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::seconds kBackoff{1};
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

auto gateway = devicegw::DeviceGateway::NewStub(grpc::CreateChannel("gateway:50051", grpc::InsecureChannelCredentials()));

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Send a recorded command to its device: "delivered", "queued", "expired" or "failed".
std::string deliver(const commands::Command& command) {
  devicegw::DeliverRequest request;
  request.set_command_id(command.command_id);
  request.set_device_id(command.device_id);
  request.set_action(command.action);
  request.set_params_json(nlohmann::json(command.params).dump());
  // The gateway's queue drops the command at the end of its window, with or without the hub.
  request.set_expires_at_ms(command.expires_at_ms);
  for (int attempt = 0; attempt < kMaxAttempts && nowMs() < command.expires_at_ms; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    devicegw::DeliverReply reply;
    const grpc::Status status = gateway->Deliver(&ctx, request, &reply);
    if (!status.ok()) {
      if (!kRetryable.count(status.error_code())) return "failed";  // the gateway refused it: asking again changes nothing
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    // Only the device's acknowledgement is a delivery; QUEUED means the gateway holds it.
    switch (reply.status()) {
      case devicegw::DELIVERED:
        return "delivered";
      case devicegw::QUEUED:
        return "queued";
      case devicegw::EXPIRED:
        return "expired";
      default:
        return "failed";
    }
  }
  return nowMs() >= command.expires_at_ms ? "expired" : "failed";
}
`,
    },
  },
  harness: {
    python: `import grpc

import iot_hub_pb2
import iot_hub_pb2_grpc

LOCK = "lock-7"


class Gateway(iot_hub_pb2_grpc.DeviceGatewayServicer):
    """Devices in online acknowledge at once. Any other device is offline: its command is queued
    until expires_at_ms (0: no window, kept forever) and EXPIRED after; devices in dropped have
    lost their queue, so every command for them is EXPIRED."""

    def __init__(self, clock):
        self.clock = clock
        self.online = set()
        self.dropped = set()
        self.queued = []

    def Deliver(self, request, context):
        if request.device_id in self.online:
            return iot_hub_pb2.DeliverReply(status=iot_hub_pb2.DELIVERED, accepted=True)
        if request.device_id in self.dropped or (request.expires_at_ms and request.expires_at_ms <= self.clock.time() * 1000):
            return iot_hub_pb2.DeliverReply(status=iot_hub_pb2.EXPIRED, accepted=False)
        self.queued.append(request.command_id)
        return iot_hub_pb2.DeliverReply(status=iot_hub_pb2.QUEUED, accepted=True)


def _client(ctx):
    gateway = Gateway(ctx.clock)
    ctx.grpc.serve(iot_hub_pb2_grpc.add_DeviceGatewayServicer_to_server, gateway)
    return ctx.load("client"), gateway


def _command(ctx, command_id="cmd-1", device=LOCK, validity_s=300):
    return {
        "command_id": command_id,
        "device_id": device,
        "action": "unlock",
        "params": {"duration_s": "5"},
        "state": "pending_ack",
        "expires_at_ms": int(ctx.clock.time() * 1000) + validity_s * 1000,
        "ack_required": True,
    }


def check_deadline(ctx):
    m, gateway = _client(ctx)
    gateway.online.add(LOCK)
    outcome = ctx.drain(m.deliver, _command(ctx))
    assert outcome == "delivered", f"a connected lock acknowledged the command and deliver answered {outcome!r}, expected delivered"
    calls = ctx.grpc.calls_to("Deliver")
    assert calls and all(c.timeout is not None for c in calls), "a Deliver call carries no deadline: a gateway that accepts the connection and never answers holds the delivery worker forever"
    assert all(4.5 <= c.timeout <= 5.5 for c in calls), f"a Deliver call carries a {calls[0].timeout} s deadline, expected DEADLINE_S = 5"
    ctx.grpc.set_latency("Deliver", 30.0)
    before = ctx.clock.time()
    outcome = ctx.drain(m.deliver, _command(ctx, "cmd-2"))
    waited = ctx.clock.time() - before
    assert outcome == "failed", f"against a gateway that never answers in time deliver answered {outcome!r}, expected failed once its attempts are spent"
    assert waited <= 20, f"deliver spent {waited:.0f} s on a gateway that never answers, expected at most three 5 s deadlines"


def check_bounded_retry(ctx):
    m, gateway = _client(ctx)
    gateway.online.add(LOCK)
    ctx.grpc.fail("Deliver", grpc.StatusCode.UNAVAILABLE, "gateway restarting", times=100)
    outcome = ctx.drain(m.deliver, _command(ctx))
    calls = len(ctx.grpc.calls_to("Deliver"))
    assert outcome is not None, f"deliver never returned against a gateway that stays UNAVAILABLE: {calls} calls before the runtime stopped it. Cap the attempts at MAX_ATTEMPTS"
    assert outcome == "failed" and calls == 3, f"against a gateway that stays UNAVAILABLE deliver answered {outcome!r} after {calls} calls, expected failed after 3"
    ctx.grpc.failures.clear()
    ctx.grpc.fail("Deliver", grpc.StatusCode.INVALID_ARGUMENT, "unknown action", times=100)
    outcome = ctx.drain(m.deliver, _command(ctx, "cmd-2"))
    refused = len(ctx.grpc.calls_to("Deliver")) - calls
    assert outcome == "failed" and refused == 1, f"a command the gateway refused with INVALID_ARGUMENT answered {outcome!r} after {refused} calls, expected failed after one: only RETRYABLE codes are retried"


def check_window(ctx):
    m, gateway = _client(ctx)
    command = _command(ctx, validity_s=600)
    ctx.drain(m.deliver, command)
    calls = ctx.grpc.calls_to("Deliver")
    assert calls, "deliver made no Deliver call for a command inside its window"
    sent = calls[0].request.expires_at_ms
    assert sent == command["expires_at_ms"], f"the Deliver request carried expires_at_ms={sent}, expected the command's window {command['expires_at_ms']}: without it the gateway keeps the command for an offline lock and runs it whenever the lock reconnects"
    late = _command(ctx, "cmd-2", validity_s=60)
    ctx.clock.advance(61)
    gateway.online.add(LOCK)
    before = len(ctx.grpc.calls_to("Deliver"))
    outcome = ctx.drain(m.deliver, late)
    assert outcome == "expired", f"a command whose window closed a second ago answered {outcome!r}, expected expired"
    assert len(ctx.grpc.calls_to("Deliver")) == before, "a command whose window has closed was sent to the gateway: a door must not unlock on a command nobody waits for any more"
    gateway.dropped.add("lock-9")
    before = len(ctx.grpc.calls_to("Deliver"))
    outcome = ctx.drain(m.deliver, _command(ctx, "cmd-3", device="lock-9"))
    tries = len(ctx.grpc.calls_to("Deliver")) - before
    assert outcome == "expired" and tries == 1, f"the gateway answered EXPIRED and deliver answered {outcome!r} after {tries} calls, expected expired after one"


def check_acknowledged(ctx):
    m, gateway = _client(ctx)
    outcome = ctx.drain(m.deliver, _command(ctx))
    assert outcome == "queued", f"the gateway queued the command for an offline lock (QUEUED, accepted) and deliver answered {outcome!r}, expected queued: only DELIVERED, the device's acknowledgement, is a delivery"
    assert gateway.queued == ["cmd-1"], f"the gateway queued {gateway.queued}, expected the one command"
    gateway.online.add(LOCK)
    outcome = ctx.drain(m.deliver, _command(ctx, "cmd-2"))
    assert outcome == "delivered", f"a connected lock acknowledged the command and deliver answered {outcome!r}, expected delivered"
`,
    typescript: `const LOCK = 'lock-7';

/** Devices in online acknowledge at once; any other device is offline: its command is queued until expires_at_ms (0: kept forever) and EXPIRED after; devices in dropped answer EXPIRED. */
function client(ctx) {
  const pkg = ctx.proto('iot_hub.proto');
  const gateway = {online: new Set<string>(), dropped: new Set<string>(), queued: [] as string[]};
  ctx.grpc.serve(pkg.devicegw.DeviceGateway.service, {
    Deliver(call, callback) {
      const {command_id, device_id, expires_at_ms} = call.request;
      if (gateway.online.has(device_id)) return callback(null, {status: 'DELIVERED', accepted: true});
      const window = Number(expires_at_ms);
      if (gateway.dropped.has(device_id) || (window !== 0 && window <= ctx.clock.now())) return callback(null, {status: 'EXPIRED', accepted: false});
      gateway.queued.push(command_id);
      callback(null, {status: 'QUEUED', accepted: true});
    },
  });
  return {m: ctx.load('client'), gateway};
}

const command = (ctx, commandId = 'cmd-1', device = LOCK, validityS = 300) => ({
  command_id: commandId,
  device_id: device,
  action: 'unlock',
  params: {duration_s: '5'},
  state: 'pending_ack',
  expires_at_ms: ctx.clock.now() + validityS * 1000,
  ack_required: true,
});

export async function check_deadline(ctx) {
  const {m, gateway} = client(ctx);
  gateway.online.add(LOCK);
  let outcome = await ctx.drain(m.deliver(command(ctx)));
  assert.equal(outcome, 'delivered', \`a connected lock acknowledged the command and deliver answered \${outcome}, expected delivered\`);
  const calls = ctx.grpc.callsTo('Deliver');
  assert(calls.length > 0 && calls.every(c => c.timeout !== null), 'a Deliver call carries no deadline: a gateway that accepts the connection and never answers holds the delivery worker forever');
  assert(calls.every(c => c.timeout >= 4.5 && c.timeout <= 5.5), \`a Deliver call carries a \${calls[0].timeout} s deadline, expected DEADLINE_MS = 5000\`);
  ctx.grpc.setLatency('Deliver', 30.0);
  const before = ctx.clock.now();
  outcome = await ctx.drain(m.deliver(command(ctx, 'cmd-2')));
  const waited = (ctx.clock.now() - before) / 1000;
  assert.equal(outcome, 'failed', \`against a gateway that never answers in time deliver answered \${outcome}, expected failed once its attempts are spent\`);
  assert(waited <= 20, \`deliver spent \${waited.toFixed(0)} s on a gateway that never answers, expected at most three 5 s deadlines\`);
}

export async function check_bounded_retry(ctx) {
  const {m, gateway} = client(ctx);
  gateway.online.add(LOCK);
  ctx.grpc.fail('Deliver', ctx.grpc.status.UNAVAILABLE, 'gateway restarting', 100);
  let outcome = await ctx.drain(m.deliver(command(ctx)));
  const calls = ctx.grpc.callsTo('Deliver').length;
  assert(outcome !== undefined, \`deliver never returned against a gateway that stays UNAVAILABLE: \${calls} calls before the runtime stopped it. Cap the attempts at MAX_ATTEMPTS\`);
  assert(outcome === 'failed' && calls === 3, \`against a gateway that stays UNAVAILABLE deliver answered \${outcome} after \${calls} calls, expected failed after 3\`);
  ctx.grpc.clearFailures();
  ctx.grpc.fail('Deliver', ctx.grpc.status.INVALID_ARGUMENT, 'unknown action', 100);
  outcome = await ctx.drain(m.deliver(command(ctx, 'cmd-2')));
  const refused = ctx.grpc.callsTo('Deliver').length - calls;
  assert(outcome === 'failed' && refused === 1, \`a command the gateway refused with INVALID_ARGUMENT answered \${outcome} after \${refused} calls, expected failed after one: only RETRYABLE codes are retried\`);
}

export async function check_window(ctx) {
  const {m, gateway} = client(ctx);
  const first = command(ctx, 'cmd-1', LOCK, 600);
  await ctx.drain(m.deliver(first));
  const calls = ctx.grpc.callsTo('Deliver');
  assert(calls.length > 0, 'deliver made no Deliver call for a command inside its window');
  const sent = Number(calls[0].request.expires_at_ms);
  assert.equal(sent, first.expires_at_ms, \`the Deliver request carried expires_at_ms=\${sent}, expected the command's window \${first.expires_at_ms}: without it the gateway keeps the command for an offline lock and runs it whenever the lock reconnects\`);
  const late = command(ctx, 'cmd-2', LOCK, 60);
  ctx.clock.advance(61);
  gateway.online.add(LOCK);
  let before = ctx.grpc.callsTo('Deliver').length;
  let outcome = await ctx.drain(m.deliver(late));
  assert.equal(outcome, 'expired', \`a command whose window closed a second ago answered \${outcome}, expected expired\`);
  assert.equal(ctx.grpc.callsTo('Deliver').length, before, 'a command whose window has closed was sent to the gateway: a door must not unlock on a command nobody waits for any more');
  gateway.dropped.add('lock-9');
  before = ctx.grpc.callsTo('Deliver').length;
  outcome = await ctx.drain(m.deliver(command(ctx, 'cmd-3', 'lock-9')));
  const tries = ctx.grpc.callsTo('Deliver').length - before;
  assert(outcome === 'expired' && tries === 1, \`the gateway answered EXPIRED and deliver answered \${outcome} after \${tries} calls, expected expired after one\`);
}

export async function check_acknowledged(ctx) {
  const {m, gateway} = client(ctx);
  let outcome = await ctx.drain(m.deliver(command(ctx)));
  assert.equal(outcome, 'queued', \`the gateway queued the command for an offline lock (QUEUED, accepted) and deliver answered \${outcome}, expected queued: only DELIVERED, the device's acknowledgement, is a delivery\`);
  assert.deepEqual(gateway.queued, ['cmd-1'], \`the gateway queued \${JSON.stringify(gateway.queued)}, expected the one command\`);
  gateway.online.add(LOCK);
  outcome = await ctx.drain(m.deliver(command(ctx, 'cmd-2')));
  assert.equal(outcome, 'delivered', \`a connected lock acknowledged the command and deliver answered \${outcome}, expected delivered\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	"iothub/commands"
	pb "iothub/gen/iot_hub"

	"leetbuild/harness"
)

const gatewayLock = "lock-7"

// gatewayPeer: devices in online acknowledge at once; any other device is offline: its command is
// queued until expires_at_ms (0: kept forever) and EXPIRED after; devices in dropped answer EXPIRED.
type gatewayPeer struct {
	pb.UnimplementedDeviceGatewayServer
	ctx     *harness.Ctx
	online  map[string]bool
	dropped map[string]bool
	queued  []string
}

func (g *gatewayPeer) Deliver(_ context.Context, req *pb.DeliverRequest) (*pb.DeliverReply, error) {
	if g.online[req.GetDeviceId()] {
		return &pb.DeliverReply{Status: pb.DeliveryStatus_DELIVERED, Accepted: true}, nil
	}
	window := req.GetExpiresAtMs()
	if g.dropped[req.GetDeviceId()] || (window != 0 && window <= g.ctx.Clock.Now()) {
		return &pb.DeliverReply{Status: pb.DeliveryStatus_EXPIRED}, nil
	}
	g.queued = append(g.queued, req.GetCommandId())
	return &pb.DeliverReply{Status: pb.DeliveryStatus_QUEUED, Accepted: true}, nil
}

func gatewayFor(ctx *harness.Ctx) *gatewayPeer {
	peer := &gatewayPeer{ctx: ctx, online: map[string]bool{}, dropped: map[string]bool{}}
	pb.RegisterDeviceGatewayServer(ctx.GRPC.Server(""), peer)
	return peer
}

func commandFor(ctx *harness.Ctx, commandID, device string, validityS int64) *commands.Command {
	return &commands.Command{
		CommandID: commandID, DeviceID: device, Action: "unlock", Params: map[string]string{"duration_s": "5"},
		State: "pending_ack", ExpiresAtMs: ctx.Clock.Now() + validityS*1000, AckRequired: true,
	}
}

// deliverDrained runs deliver until it returns or the runtime stops it; "" when it never returned.
func deliverDrained(ctx *harness.Ctx, command *commands.Command) string {
	outcome := ""
	ctx.Drain(func() { outcome = deliver(context.Background(), command) })
	return outcome
}

func CheckDeadline(ctx *harness.Ctx) {
	gateway := gatewayFor(ctx)
	gateway.online[gatewayLock] = true
	outcome := deliverDrained(ctx, commandFor(ctx, "cmd-1", gatewayLock, 300))
	ctx.Equal(outcome, "delivered", "a connected lock acknowledged the command; deliver's answer")
	calls := ctx.GRPC.CallsTo("Deliver", "")
	ctx.Assert(len(calls) > 0, "no Deliver call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Deliver call carries no deadline: a gateway that accepts the connection and never answers holds the delivery worker forever")
		ctx.Assert(4500*time.Millisecond <= call.Timeout && call.Timeout <= 5500*time.Millisecond, "a Deliver call carries a %v deadline, expected 5 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Deliver", 30.0, "")
	before := ctx.Clock.Now()
	outcome = deliverDrained(ctx, commandFor(ctx, "cmd-2", gatewayLock, 300))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Equal(outcome, "failed", "against a gateway that never answers in time deliver must answer failed once its attempts are spent; its answer")
	ctx.Assert(waited <= 20, "deliver spent %.0f s on a gateway that never answers, expected at most three 5 s deadlines", waited)
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	gateway := gatewayFor(ctx)
	gateway.online[gatewayLock] = true
	ctx.GRPC.Fail("Deliver", codes.Unavailable, "gateway restarting", 100, "")
	returned := false
	outcome := ""
	command := commandFor(ctx, "cmd-1", gatewayLock, 300)
	returned = ctx.Drain(func() { outcome = deliver(context.Background(), command) })
	calls := len(ctx.GRPC.CallsTo("Deliver", ""))
	ctx.Assert(returned, "deliver never returned against a gateway that stays UNAVAILABLE: %d calls before the runtime stopped it. Cap the attempts at maxAttempts", calls)
	ctx.Assert(outcome == "failed" && calls == 3, "against a gateway that stays UNAVAILABLE deliver answered %q after %d calls, expected failed after 3", outcome, calls)
	ctx.GRPC.ClearFailures()
	ctx.GRPC.Fail("Deliver", codes.InvalidArgument, "unknown action", 100, "")
	outcome = deliverDrained(ctx, commandFor(ctx, "cmd-2", gatewayLock, 300))
	refused := len(ctx.GRPC.CallsTo("Deliver", "")) - calls
	ctx.Assert(outcome == "failed" && refused == 1, "a command the gateway refused with INVALID_ARGUMENT answered %q after %d calls, expected failed after one: only retryable codes are retried", outcome, refused)
}

func CheckWindow(ctx *harness.Ctx) {
	gateway := gatewayFor(ctx)
	first := commandFor(ctx, "cmd-1", gatewayLock, 600)
	deliverDrained(ctx, first)
	calls := ctx.GRPC.CallsTo("Deliver", "")
	ctx.Assert(len(calls) > 0, "deliver made no Deliver call for a command inside its window")
	sent := calls[0].Request.(*pb.DeliverRequest).GetExpiresAtMs()
	ctx.Assert(sent == first.ExpiresAtMs, "the Deliver request carried expires_at_ms=%d, expected the command's window %d: without it the gateway keeps the command for an offline lock and runs it whenever the lock reconnects", sent, first.ExpiresAtMs)
	late := commandFor(ctx, "cmd-2", gatewayLock, 60)
	ctx.Clock.Advance(61)
	gateway.online[gatewayLock] = true
	before := len(ctx.GRPC.CallsTo("Deliver", ""))
	outcome := deliverDrained(ctx, late)
	ctx.Equal(outcome, "expired", "a command whose window closed a second ago; deliver's answer")
	ctx.Equal(len(ctx.GRPC.CallsTo("Deliver", "")), before, "a command whose window has closed must not be sent to the gateway (a door must not unlock on a command nobody waits for any more); the calls")
	gateway.dropped["lock-9"] = true
	before = len(ctx.GRPC.CallsTo("Deliver", ""))
	outcome = deliverDrained(ctx, commandFor(ctx, "cmd-3", "lock-9", 300))
	tries := len(ctx.GRPC.CallsTo("Deliver", "")) - before
	ctx.Assert(outcome == "expired" && tries == 1, "the gateway answered EXPIRED and deliver answered %q after %d calls, expected expired after one", outcome, tries)
}

func CheckAcknowledged(ctx *harness.Ctx) {
	gateway := gatewayFor(ctx)
	outcome := deliverDrained(ctx, commandFor(ctx, "cmd-1", gatewayLock, 300))
	ctx.Equal(outcome, "queued", "the gateway queued the command for an offline lock (QUEUED, accepted): only DELIVERED, the device's acknowledgement, is a delivery; deliver's answer")
	ctx.Equal(gateway.queued, []string{"cmd-1"}, "the commands the gateway queued")
	gateway.online[gatewayLock] = true
	outcome = deliverDrained(ctx, commandFor(ctx, "cmd-2", gatewayLock, 300))
	ctx.Equal(outcome, "delivered", "a connected lock acknowledged the command; deliver's answer")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <set>
#include <string>
#include <vector>

#include "iot_hub.grpc.pb.h"
#include "iothub/commands.h"

namespace {

const std::string kGatewayLock = "lock-7";

// Devices in online acknowledge at once; any other device is offline: its command is queued until
// expires_at_ms (0: kept forever) and EXPIRED after; devices in dropped answer EXPIRED.
class GatewayPeer final : public devicegw::DeviceGateway::Service {
 public:
  harness::Ctx* ctx = nullptr;
  std::set<std::string> online;
  std::set<std::string> dropped;
  std::vector<std::string> queued;

  grpc::Status Deliver(grpc::ServerContext*, const devicegw::DeliverRequest* req, devicegw::DeliverReply* out) override {
    if (online.count(req->device_id())) {
      out->set_status(devicegw::DELIVERED);
      out->set_accepted(true);
      return grpc::Status::OK;
    }
    const long long window = req->expires_at_ms();
    if (dropped.count(req->device_id()) || (window != 0 && window <= ctx->Clock.Now())) {
      out->set_status(devicegw::EXPIRED);
      out->set_accepted(false);
      return grpc::Status::OK;
    }
    queued.push_back(req->command_id());
    out->set_status(devicegw::QUEUED);
    out->set_accepted(true);
    return grpc::Status::OK;
  }
};

GatewayPeer& gatewayFor(harness::Ctx& ctx) {
  static GatewayPeer* peer = nullptr;
  delete peer;
  peer = new GatewayPeer;
  peer->ctx = &ctx;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

commands::Command commandFor(harness::Ctx& ctx, const std::string& command_id, const std::string& device, long long validity_s) {
  commands::Command c;
  c.command_id = command_id;
  c.device_id = device;
  c.action = "unlock";
  c.params = {{"duration_s", "5"}};
  c.state = "pending_ack";
  c.expires_at_ms = ctx.Clock.Now() + validity_s * 1000;
  c.ack_required = true;
  return c;
}

// deliver run until it returns or the runtime stops it; "" when it never returned.
std::string deliverDrained(harness::Ctx& ctx, const commands::Command& command) {
  std::string outcome;
  ctx.Drain([&] { outcome = deliver(command); });
  return outcome;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  GatewayPeer& gateway = gatewayFor(ctx);
  gateway.online.insert(kGatewayLock);
  std::string outcome = deliverDrained(ctx, commandFor(ctx, "cmd-1", kGatewayLock, 300));
  ctx.Equal(outcome, "delivered", "a connected lock acknowledged the command; deliver's answer");
  const auto calls = ctx.GRPC.CallsTo("Deliver");
  ctx.Assert(!calls.empty(), "no Deliver call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Deliver call carries no deadline: a gateway that accepts the connection and never answers holds the delivery worker forever");
    ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "a Deliver call carries a %v s deadline, expected kDeadline = 5 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Deliver", 30.0);
  const int64_t before = ctx.Clock.Now();
  outcome = deliverDrained(ctx, commandFor(ctx, "cmd-2", kGatewayLock, 300));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Equal(outcome, "failed", "against a gateway that never answers in time deliver must answer failed once its attempts are spent; its answer");
  ctx.Assert(waited <= 20, "deliver spent %.0f s on a gateway that never answers, expected at most three 5 s deadlines", waited);
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  GatewayPeer& gateway = gatewayFor(ctx);
  gateway.online.insert(kGatewayLock);
  ctx.GRPC.Fail("Deliver", grpc::StatusCode::UNAVAILABLE, "gateway restarting", 100);
  std::string outcome;
  const commands::Command command = commandFor(ctx, "cmd-1", kGatewayLock, 300);
  const bool returned = ctx.Drain([&] { outcome = deliver(command); });
  const size_t calls = ctx.GRPC.CallsTo("Deliver").size();
  ctx.Assert(returned, "deliver never returned against a gateway that stays UNAVAILABLE: %d calls before the runtime stopped it. Cap the attempts at kMaxAttempts", calls);
  ctx.Assert(outcome == "failed" && calls == 3, "against a gateway that stays UNAVAILABLE deliver answered %q after %d calls, expected failed after 3", outcome, calls);
  ctx.GRPC.ClearFailures();
  ctx.GRPC.Fail("Deliver", grpc::StatusCode::INVALID_ARGUMENT, "unknown action", 100);
  outcome = deliverDrained(ctx, commandFor(ctx, "cmd-2", kGatewayLock, 300));
  const size_t refused = ctx.GRPC.CallsTo("Deliver").size() - calls;
  ctx.Assert(outcome == "failed" && refused == 1,
             "a command the gateway refused with INVALID_ARGUMENT answered %q after %d calls, expected failed after one: only kRetryable codes are retried", outcome, refused);
}

void CheckWindow(harness::Ctx& ctx) {
  GatewayPeer& gateway = gatewayFor(ctx);
  const commands::Command first = commandFor(ctx, "cmd-1", kGatewayLock, 600);
  deliverDrained(ctx, first);
  const auto calls = ctx.GRPC.CallsTo("Deliver");
  ctx.Assert(!calls.empty(), "deliver made no Deliver call for a command inside its window");
  const long long sent = calls[0].Request<devicegw::DeliverRequest>().expires_at_ms();
  ctx.Assert(sent == first.expires_at_ms,
             "the Deliver request carried expires_at_ms=%d, expected the command's window %d: without it the gateway keeps the command for an offline lock and runs it whenever the lock reconnects",
             sent, first.expires_at_ms);
  const commands::Command late = commandFor(ctx, "cmd-2", kGatewayLock, 60);
  ctx.Clock.Advance(61);
  gateway.online.insert(kGatewayLock);
  size_t before = ctx.GRPC.CallsTo("Deliver").size();
  std::string outcome = deliverDrained(ctx, late);
  ctx.Equal(outcome, "expired", "a command whose window closed a second ago; deliver's answer");
  ctx.Equal(ctx.GRPC.CallsTo("Deliver").size(), before,
            "a command whose window has closed must not be sent to the gateway (a door must not unlock on a command nobody waits for any more); the calls");
  gateway.dropped.insert("lock-9");
  before = ctx.GRPC.CallsTo("Deliver").size();
  outcome = deliverDrained(ctx, commandFor(ctx, "cmd-3", "lock-9", 300));
  const size_t tries = ctx.GRPC.CallsTo("Deliver").size() - before;
  ctx.Assert(outcome == "expired" && tries == 1, "the gateway answered EXPIRED and deliver answered %q after %d calls, expected expired after one", outcome, tries);
}

void CheckAcknowledged(harness::Ctx& ctx) {
  GatewayPeer& gateway = gatewayFor(ctx);
  std::string outcome = deliverDrained(ctx, commandFor(ctx, "cmd-1", kGatewayLock, 300));
  ctx.Equal(outcome, "queued",
            "the gateway queued the command for an offline lock (QUEUED, accepted): only DELIVERED, the device's acknowledgement, is a delivery; deliver's answer");
  ctx.Equal(gateway.queued, std::vector<std::string>{"cmd-1"}, "the commands the gateway queued");
  gateway.online.insert(kGatewayLock);
  outcome = deliverDrained(ctx, commandFor(ctx, "cmd-2", kGatewayLock, 300));
  ctx.Equal(outcome, "delivered", "a connected lock acknowledged the command; deliver's answer");
}
`,
  },
  hints: [
    'Send an unlock to a lock that is offline: `deliver` answers `delivered`. Take the gateway down instead, and the worker calls it once a second until someone notices.',
    'The loop has one exit, `reply.accepted`, which the gateway also sets when it only queued the command. Every error is swallowed and slept on, the call has no deadline, and the window never travels with the request.',
    '`timeout=DEADLINE_S`; loop while `attempts < MAX_ATTEMPTS` and now is before `expires_at_ms`, sleeping `BACKOFF_S` only after a `RETRYABLE` code; send `expires_at_ms`; map `DELIVERED`, `QUEUED`, `EXPIRED` to their outcomes; after the loop, `"expired"` past the window, else `"failed"`.',
  ],
  debrief: `The reply's status is the contract: the gateway already tells its own queue apart from the device's acknowledgement, and the hub's job is to keep them apart, because the operator console shows whatever \`deliver\` answers. The deadline turns a silent gateway into a retryable error, the attempt cap and the window bound how long one command can hold a worker, and sending \`expires_at_ms\` lets the gateway's queue drop the command by itself once nobody is asking for it. A code outside \`RETRYABLE\` stops at once because a gateway that rejected a command will reject it again. Production delivery adds jittered exponential backoff, a circuit breaker per gateway, and a receipt the gateway pushes back when a queued command finally reaches the device.`,
};
