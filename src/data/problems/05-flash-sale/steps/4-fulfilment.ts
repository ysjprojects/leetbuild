import type {Step} from '@/lib/types';

export const fulfilmentStep: Step = {
  id: 'fulfilment',
  title: 'Fulfil orders: allocate over gRPC, commit after',
  concept: 'grpc',
  file: 'fulfilment_consumer',
  focus: ['kafka', 'fulfilment', 'warehouse', 'redis'],
  task: `## Task

The warehouse exposes:

\`\`\`proto
service Warehouse {
  rpc Allocate(AllocateRequest) returns (AllocateReply);
}
message AllocateRequest { string order_id = 1; string sku = 2; uint32 qty = 3; }
message AllocateReply   { string shipment_id = 1; }
\`\`\`

Implement the consumer in group **\`fulfilment\`** that turns each \`orders\` record into a physical
allocation:

- Disable auto-commit; commit **after** the outcome of a record is handled, never before.
- For each record call \`Allocate(order_id, sku, qty)\` with a **5 s deadline**.
- \`UNAVAILABLE\` → retry with exponential backoff (250 ms, 500 ms, 1 s) up to **4 attempts** in total;
  other statuses are not retried.
- Success → \`confirm(order_id)\` (provided: deletes the hold and its expiry entry — the reservation
  is now a sale).
- \`FAILED_PRECONDITION\` means the warehouse has no physical stock: \`release(order_id)\` (provided) and
  \`publish_failed(order)\` (provided: dead-letters to \`orders-failed\`), then commit — the record is
  handled, just not happily.
- Anything else propagates: the record stays uncommitted and is redelivered after a restart.

:::widget grpc-streams {"mode": "unary"}

> \`Allocate\` carries the order id, so the warehouse can make it idempotent: a redelivered record after
> a crash between \`Allocate\` and the commit asks for the same allocation again and gets the same
> shipment back.

:::widget deadline-retry {"base": 250, "deadline": 5000, "attempts": 4}`,
  sequence: {
    participants: ['Kafka', 'fulfilment', 'Warehouse', 'Redis'],
    messages: [
      {from: 'Kafka', to: 'fulfilment', label: 'poll → order o1 (partition 3, offset 88231)', kind: 'reply'},
      {from: 'fulfilment', to: 'Warehouse', label: 'Allocate(o1, shoe-42, 2) · deadline 5 s', kind: 'sync'},
      {from: 'Warehouse', to: 'fulfilment', label: 'status UNAVAILABLE → sleep 250 ms, retry', kind: 'reply'},
      {from: 'fulfilment', to: 'Warehouse', label: 'Allocate(o1, shoe-42, 2)', kind: 'sync'},
      {from: 'Warehouse', to: 'fulfilment', label: 'AllocateReply{shipment_id}', kind: 'reply'},
      {from: 'fulfilment', to: 'Redis', label: 'confirm(o1): DEL hold · ZREM holds', kind: 'sync'},
      {from: 'fulfilment', to: 'Kafka', label: 'commit offset 88232 (partition 3)', kind: 'sync'},
    ],
  },
  hints: [
    'Split the work: a helper that returns "allocated" or "no stock" (and throws for everything else) keeps the retry loop away from the commit logic in the poll loop.',
    'The deadline is per attempt and set on the call (timeout argument, context with timeout, `withDeadlineAfter`, `set_deadline`). Sleep *before* each retry: base × 2^(attempt − 1), so the first call is immediate.',
    'In the poll loop: helper → on success `confirm`, on no-stock `release` + `publish_failed` → commit. If the helper throws, do not catch it here — an uncommitted offset is exactly what you want for a warehouse that is down.',
  ],
  checks: [
    {
      id: 'group-manual-commit',
      title: 'Joins group fulfilment on orders with auto-commit off',
      detail:
        'The consumer must use `group.id` `fulfilment`, subscribe to `orders`, and commit offsets itself rather than on a timer.',
      match: {
        python: {
          all: [
            /"group\.id"\s*:\s*"fulfilment"/,
            /subscribe\(\s*\[\s*"orders"\s*\]\s*\)/,
            /"enable\.auto\.commit"\s*:\s*(False|"false")/,
          ],
        },
        typescript: {
          all: [/groupId:\s*['"]fulfilment['"]/, /subscribe\(\s*\{[^}]*topic:\s*['"]orders['"]/, /autoCommit:\s*false/],
        },
        go: {all: [/GroupID:\s*"fulfilment"/, /Topic:\s*"orders"/, /reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {
          all: [/"group\.id"\s*,\s*"fulfilment"/, /subscribe\([^\n]*"orders"/, /"enable\.auto\.commit"\s*,\s*"false"/],
        },
        cpp: {
          all: [/"group\.id"\s*,\s*"fulfilment"/, /subscribe\([^\n]*"orders"/, /"enable\.auto\.commit"\s*,\s*"false"/],
        },
      },
    },
    {
      id: 'deadline',
      title: 'Allocate carries a 5 s deadline',
      detail: 'Every RPC must carry a deadline so a hung warehouse cannot stall the partition forever.',
      match: {
        python: {all: [/stub\.Allocate\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/stub\.Allocate\([\s\S]{0,200}?deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {order: [/context\.WithTimeout\(\s*\w+\s*,\s*deadline\s*\)/, /stub\.Allocate\(/]},
        scala: {
          all: [
            /withDeadlineAfter\(\s*(DeadlineMillis\s*,\s*TimeUnit\.MILLISECONDS|5L?\s*,\s*TimeUnit\.SECONDS)\s*\)\s*\.allocate\(/,
          ],
        },
        cpp: {all: [/set_deadline\([^\n]*kDeadline\s*\)/, /stub->Allocate\(\s*&\w+\s*,/]},
      },
    },
    {
      id: 'backoff-bounded',
      title: 'Retries UNAVAILABLE with exponential backoff, at most 4 attempts',
      detail:
        'Only `UNAVAILABLE` is retried, the wait doubles each time (250 ms, 500 ms, 1 s: base × 2^(attempt−1) or a delay that doubles), and the loop is bounded by `MAX_ATTEMPTS`.',
      match: {
        python: {
          all: [
            /StatusCode\.UNAVAILABLE/,
            /range\([^)]*MAX_ATTEMPTS|attempt\s*<=?\s*MAX_ATTEMPTS/,
            /time\.sleep\(/,
            /BACKOFF_S\s*\*\s*\(?\s*2\s*\*\*|BACKOFF_S\s*\*\s*\(?\s*1\s*<<|\*=\s*2\b/,
          ],
        },
        typescript: {
          all: [
            /status\.UNAVAILABLE/,
            /attempt\s*<=?\s*MAX_ATTEMPTS/,
            /await sleep\(|setTimeout\(/,
            /BACKOFF_MS\s*\*\s*\(?\s*2\s*\*\*|BACKOFF_MS\s*\*\s*\(?\s*1\s*<<|BACKOFF_MS\s*<<|\*=\s*2\b/,
          ],
        },
        go: {
          all: [
            /codes\.Unavailable/,
            /attempt\s*<=?\s*maxAttempts/,
            /time\.Sleep\(/,
            /backoff\s*\*\s*(time\.Duration\()?\(?\s*1\s*<<|backoff\s*<<|\*=\s*2\b|<<=\s*1\b/,
          ],
        },
        scala: {
          all: [
            /Code\.UNAVAILABLE/,
            /attempt\s*<=?\s*MaxAttempts/,
            /Thread\.sleep\(/,
            /BackoffMillis\s*\*\s*\(?\s*1L?\s*<<|BackoffMillis\s*<<|\*=\s*2L?\b|<<=\s*1\b/,
          ],
        },
        cpp: {
          all: [
            /StatusCode::UNAVAILABLE/,
            /attempt\s*<=?\s*kMaxAttempts/,
            /sleep_for\(/,
            /kBackoff\s*\*\s*\(?\s*1\s*<<|kBackoff\s*<<|\*=\s*2\b|<<=\s*1\b/,
          ],
        },
      },
    },
    {
      id: 'no-stock',
      title: 'FAILED_PRECONDITION releases the hold and dead-letters the order',
      detail:
        'No physical stock is a final outcome: give the units back with `release(order_id)` and publish the order to `orders-failed` via `publish_failed(order)`.',
      match: {
        python: {
          all: [
            /StatusCode\.FAILED_PRECONDITION/,
            /release\(\s*order\[["']order_id["']\]\s*\)/,
            /publish_failed\(\s*order\s*\)/,
          ],
        },
        typescript: {
          all: [/status\.FAILED_PRECONDITION/, /release\(\s*order\.order_id\s*\)/, /publishFailed\(\s*order\s*\)/],
        },
        go: {
          all: [
            /codes\.FailedPrecondition/,
            /release\(\s*ctx\s*,\s*order\.OrderID\s*\)/,
            /publishFailed\(\s*ctx\s*,\s*order\s*\)/,
          ],
        },
        scala: {all: [/Code\.FAILED_PRECONDITION/, /release\(\s*order\.orderId\s*\)/, /publishFailed\(\s*order\s*\)/]},
        cpp: {
          all: [/StatusCode::FAILED_PRECONDITION/, /release\(\s*order\.order_id\s*\)/, /publish_failed\(\s*order\s*\)/],
        },
      },
    },
    {
      id: 'commit-after',
      title: 'Confirms the sale and commits only after the outcome is handled',
      detail:
        'Allocate, then `confirm(order_id)`, then commit: an offset committed before the outcome is handled would lose the order on a crash.',
      match: {
        python: {order: [/stub\.Allocate\(/, /confirm\(\s*order\[["']order_id["']\]\s*\)/, /consumer\.commit\(/]},
        typescript: {order: [/stub\.Allocate\(/, /confirm\(\s*order\.order_id\s*\)/, /consumer\.commitOffsets\(/]},
        go: {order: [/stub\.Allocate\(/, /confirm\(\s*ctx\s*,\s*order\.OrderID\s*\)/, /reader\.CommitMessages\(/]},
        scala: {order: [/\.allocate\(/, /confirm\(\s*order\.orderId\s*\)/, /consumer\.commitSync\(/]},
        cpp: {order: [/stub->Allocate\(/, /confirm\(\s*order\.order_id\s*\)/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

import grpc
from confluent_kafka import Consumer

import warehouse_pb2
import warehouse_pb2_grpc

log = logging.getLogger("fulfilment")

DEADLINE_S = 5.0
BACKOFF_S = 0.25
MAX_ATTEMPTS = 4

channel = grpc.insecure_channel("warehouse:9000")
stub = warehouse_pb2_grpc.WarehouseStub(channel)

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "fulfilment",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["orders"])


def confirm(order_id: str) -> None:
    """The reservation became a sale: DEL hold:{order_id}, ZREM holds (provided)."""
    raise NotImplementedError


def release(order_id: str) -> None:
    """Gives the hold back to stock (step 5)."""
    raise NotImplementedError


def publish_failed(order: dict) -> None:
    """Dead-letters the order on orders-failed (provided)."""
    raise NotImplementedError


def allocate(order: dict) -> bool:
    """True when the warehouse took the order, False when it has no physical stock."""
    request = warehouse_pb2.AllocateRequest(order_id=order["order_id"], sku=order["sku"], qty=order["qty"])
    # TODO: up to MAX_ATTEMPTS calls to stub.Allocate with timeout=DEADLINE_S
    # TODO: FAILED_PRECONDITION → False; UNAVAILABLE → sleep BACKOFF_S * 2 ** (attempt - 1) and retry; else raise
    _ = request, time
    raise NotImplementedError


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        order = json.loads(msg.value())
        # TODO: allocate(order) → confirm; no stock → release + publish_failed
        # TODO: commit this message's offset only after the outcome is handled
        raise NotImplementedError
`,
      solution: `import json
import logging
import time

import grpc
from confluent_kafka import Consumer

import warehouse_pb2
import warehouse_pb2_grpc

log = logging.getLogger("fulfilment")

DEADLINE_S = 5.0
BACKOFF_S = 0.25
MAX_ATTEMPTS = 4

channel = grpc.insecure_channel("warehouse:9000")
stub = warehouse_pb2_grpc.WarehouseStub(channel)

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "fulfilment",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["orders"])


def confirm(order_id: str) -> None:
    """The reservation became a sale: DEL hold:{order_id}, ZREM holds (provided)."""
    raise NotImplementedError


def release(order_id: str) -> None:
    """Gives the hold back to stock (step 5)."""
    raise NotImplementedError


def publish_failed(order: dict) -> None:
    """Dead-letters the order on orders-failed (provided)."""
    raise NotImplementedError


def allocate(order: dict) -> bool:
    """True when the warehouse took the order, False when it has no physical stock."""
    request = warehouse_pb2.AllocateRequest(order_id=order["order_id"], sku=order["sku"], qty=order["qty"])
    for attempt in range(MAX_ATTEMPTS):
        if attempt > 0:
            time.sleep(BACKOFF_S * 2 ** (attempt - 1))
        try:
            stub.Allocate(request, timeout=DEADLINE_S)
            return True
        except grpc.RpcError as e:
            if e.code() == grpc.StatusCode.FAILED_PRECONDITION:
                return False
            if e.code() != grpc.StatusCode.UNAVAILABLE:
                raise
    raise RuntimeError(f"warehouse unavailable after {MAX_ATTEMPTS} attempts")


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        order = json.loads(msg.value())
        if allocate(order):
            confirm(order["order_id"])
        else:
            log.warning("no physical stock for %s: releasing %s", order["sku"], order["order_id"])
            release(order["order_id"])
            publish_failed(order)
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';

import type {Order} from './checkout_api';

export const DEADLINE_MS = 5000;
export const BACKOFF_MS = 250;
export const MAX_ATTEMPTS = 4;

interface WarehouseClient {
  Allocate(request: {order_id: string; sku: string; qty: number}, options: {deadline: number}): Promise<{shipment_id: string}>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse.proto')) as unknown as {
  flashsale: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};
const stub = new pkg.flashsale.Warehouse('warehouse:9000', grpc.credentials.createInsecure());

const kafka = new Kafka({clientId: 'fulfilment', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'fulfilment'});

/** Step 5 and the dead-letter producer (provided). */
export const services = {
  /** The reservation became a sale: DEL hold:{order_id}, ZREM holds. */
  async confirm(orderId: string): Promise<void> {
    throw new Error('not implemented');
  },
  /** Gives the hold back to stock (step 5). */
  async release(orderId: string): Promise<void> {
    throw new Error('not implemented');
  },
  /** Dead-letters the order on orders-failed. */
  async publishFailed(order: Order): Promise<void> {
    throw new Error('not implemented');
  },
};

/** true when the warehouse took the order, false when it has no physical stock. */
export async function allocate(order: Order): Promise<boolean> {
  const request = {order_id: order.order_id, sku: order.sku, qty: order.qty};
  // TODO: up to MAX_ATTEMPTS calls to stub.Allocate with deadline: Date.now() + DEADLINE_MS
  // TODO: FAILED_PRECONDITION → false; UNAVAILABLE → sleep BACKOFF_MS * 2 ** (attempt - 1) and retry; else rethrow
  throw new Error('not implemented');
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'orders', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      const order = JSON.parse(message.value!.toString()) as Order;
      // TODO: allocate(order) → services.confirm; no stock → services.release + services.publishFailed
      // TODO: commit this message's offset (offset + 1) only after the outcome is handled
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';

import type {Order} from './checkout_api';

export const DEADLINE_MS = 5000;
export const BACKOFF_MS = 250;
export const MAX_ATTEMPTS = 4;

interface WarehouseClient {
  Allocate(request: {order_id: string; sku: string; qty: number}, options: {deadline: number}): Promise<{shipment_id: string}>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse.proto')) as unknown as {
  flashsale: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};
const stub = new pkg.flashsale.Warehouse('warehouse:9000', grpc.credentials.createInsecure());

const kafka = new Kafka({clientId: 'fulfilment', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'fulfilment'});

/** Step 5 and the dead-letter producer (provided). */
export const services = {
  /** The reservation became a sale: DEL hold:{order_id}, ZREM holds. */
  async confirm(orderId: string): Promise<void> {
    throw new Error('not implemented');
  },
  /** Gives the hold back to stock (step 5). */
  async release(orderId: string): Promise<void> {
    throw new Error('not implemented');
  },
  /** Dead-letters the order on orders-failed. */
  async publishFailed(order: Order): Promise<void> {
    throw new Error('not implemented');
  },
};

/** true when the warehouse took the order, false when it has no physical stock. */
export async function allocate(order: Order): Promise<boolean> {
  const request = {order_id: order.order_id, sku: order.sku, qty: order.qty};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    try {
      await stub.Allocate(request, {deadline: Date.now() + DEADLINE_MS});
      return true;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code === grpc.status.FAILED_PRECONDITION) return false;
      if (code !== grpc.status.UNAVAILABLE) throw e;
    }
  }
  throw new Error(\`warehouse unavailable after \${MAX_ATTEMPTS} attempts\`);
}

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'orders', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const order = JSON.parse(message.value!.toString()) as Order;
      if (await allocate(order)) {
        await services.confirm(order.order_id);
      } else {
        console.warn(\`no physical stock for \${order.sku}: releasing \${order.order_id}\`);
        await services.release(order.order_id);
        await services.publishFailed(order);
      }
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "flashsale/gen/warehouse"
)

const (
	deadline    = 5 * time.Second
	backoff     = 250 * time.Millisecond
	maxAttempts = 4
)

var conn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewWarehouseClient(conn)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "fulfilment",
	Topic:   "orders",
})

type Order struct {
	OrderID string \`json:"order_id"\`
	SKU     string \`json:"sku"\`
	Qty     int    \`json:"qty"\`
}

// confirm turns the reservation into a sale: DEL hold:{order_id}, ZREM holds (provided).
func confirm(ctx context.Context, orderID string) error { panic("not implemented") }

// release gives the hold back to stock (step 5).
func release(ctx context.Context, orderID string) error { panic("not implemented") }

// publishFailed dead-letters the order on orders-failed (provided).
func publishFailed(ctx context.Context, order Order) error { panic("not implemented") }

// allocate returns false when the warehouse has no physical stock for the order.
func allocate(ctx context.Context, order Order) (bool, error) {
	req := &pb.AllocateRequest{OrderId: order.OrderID, Sku: order.SKU, Qty: uint32(order.Qty)}
	// TODO: up to maxAttempts calls to stub.Allocate under a context that expires after \`deadline\`
	// TODO: FailedPrecondition → false, nil; Unavailable → sleep backoff << (attempt-1) and retry; else return err
	_, _, _ = req, codes.OK, status.Code
	return false, fmt.Errorf("not implemented")
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want), decode the Order
		// TODO: allocate → confirm; no stock → release + publishFailed; then CommitMessages for this message
		_ = json.Unmarshal
		log.Println("not implemented")
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "flashsale/gen/warehouse"
)

const (
	deadline    = 5 * time.Second
	backoff     = 250 * time.Millisecond
	maxAttempts = 4
)

var conn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewWarehouseClient(conn)

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "fulfilment",
	Topic:   "orders",
})

type Order struct {
	OrderID string \`json:"order_id"\`
	SKU     string \`json:"sku"\`
	Qty     int    \`json:"qty"\`
}

// confirm turns the reservation into a sale: DEL hold:{order_id}, ZREM holds (provided).
func confirm(ctx context.Context, orderID string) error { panic("not implemented") }

// release gives the hold back to stock (step 5).
func release(ctx context.Context, orderID string) error { panic("not implemented") }

// publishFailed dead-letters the order on orders-failed (provided).
func publishFailed(ctx context.Context, order Order) error { panic("not implemented") }

// allocate returns false when the warehouse has no physical stock for the order.
func allocate(ctx context.Context, order Order) (bool, error) {
	req := &pb.AllocateRequest{OrderId: order.OrderID, Sku: order.SKU, Qty: uint32(order.Qty)}
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(backoff * time.Duration(1<<(attempt-1)))
		}
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		_, err := stub.Allocate(callCtx, req)
		cancel()
		if err == nil {
			return true, nil
		}
		switch status.Code(err) {
		case codes.FailedPrecondition:
			return false, nil
		case codes.Unavailable:
			lastErr = err
		default:
			return false, err
		}
	}
	return false, fmt.Errorf("warehouse unavailable after %d attempts: %w", maxAttempts, lastErr)
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var order Order
		if err := json.Unmarshal(msg.Value, &order); err != nil {
			return fmt.Errorf("malformed order at offset %d: %w", msg.Offset, err)
		}
		ok, err := allocate(ctx, order)
		if err != nil {
			return err // not committed: redelivered after a restart
		}
		if ok {
			confirm(ctx, order.OrderID)
		} else {
			log.Printf("no physical stock for %s: releasing %s", order.SKU, order.OrderID)
			release(ctx, order.OrderID)
			publishFailed(ctx, order)
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import flashsale.warehouse.{AllocateRequest, WarehouseGrpc}
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._

final case class Order(orderId: String, sku: String, qty: Int)

object FulfilmentConsumer {
  val DeadlineMillis = 5000L
  val BackoffMillis = 250L
  val MaxAttempts = 4

  private val channel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val stub = WarehouseGrpc.blockingStub(channel)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "fulfilment")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("orders").asJava)

  /** The reservation became a sale: DEL hold:{order_id}, ZREM holds (provided). */
  def confirm(orderId: String): Unit = ???
  /** Gives the hold back to stock (step 5). */
  def release(orderId: String): Unit = ???
  /** Dead-letters the order on orders-failed (provided). */
  def publishFailed(order: Order): Unit = ???
  /** Parses the JSON record written by the intake (provided). */
  def parseOrder(json: String): Order = ???

  /** True when the warehouse took the order, false when it has no physical stock. */
  def allocate(order: Order): Boolean = {
    val request = AllocateRequest(orderId = order.orderId, sku = order.sku, qty = order.qty)
    // TODO: up to MaxAttempts calls with withDeadlineAfter(DeadlineMillis)
    // TODO: FAILED_PRECONDITION → false; UNAVAILABLE → sleep BackoffMillis << (attempt-1) and retry; else rethrow
    false
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val order = parseOrder(record.value())
        // TODO: allocate → confirm; no stock → release + publishFailed
      }
      // TODO: commit synchronously once every record of the batch is handled
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import flashsale.warehouse.{AllocateRequest, WarehouseGrpc}
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import scala.jdk.CollectionConverters._

final case class Order(orderId: String, sku: String, qty: Int)

object FulfilmentConsumer {
  val DeadlineMillis = 5000L
  val BackoffMillis = 250L
  val MaxAttempts = 4

  private val channel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val stub = WarehouseGrpc.blockingStub(channel)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "fulfilment")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("orders").asJava)

  /** The reservation became a sale: DEL hold:{order_id}, ZREM holds (provided). */
  def confirm(orderId: String): Unit = ???
  /** Gives the hold back to stock (step 5). */
  def release(orderId: String): Unit = ???
  /** Dead-letters the order on orders-failed (provided). */
  def publishFailed(order: Order): Unit = ???
  /** Parses the JSON record written by the intake (provided). */
  def parseOrder(json: String): Order = ???

  /** True when the warehouse took the order, false when it has no physical stock. */
  def allocate(order: Order): Boolean = {
    val request = AllocateRequest(orderId = order.orderId, sku = order.sku, qty = order.qty)
    var attempt = 0
    while (attempt < MaxAttempts) {
      if (attempt > 0) Thread.sleep(BackoffMillis * (1L << (attempt - 1)))
      try {
        stub.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).allocate(request)
        return true
      } catch {
        case e: StatusRuntimeException =>
          e.getStatus.getCode match {
            case Status.Code.FAILED_PRECONDITION => return false
            case Status.Code.UNAVAILABLE => attempt += 1
            case _ => throw e
          }
      }
    }
    throw new IllegalStateException(s"warehouse unavailable after $MaxAttempts attempts")
  }

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.asScala.foreach { record =>
        val order = parseOrder(record.value())
        if (allocate(order)) confirm(order.orderId)
        else {
          System.err.println(s"no physical stock for \${order.sku}: releasing \${order.orderId}")
          release(order.orderId)
          publishFailed(order)
        }
      }
      consumer.commitSync() // every record of the batch is handled
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

#include "warehouse.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{5000};
constexpr std::chrono::milliseconds kBackoff{250};
constexpr int kMaxAttempts = 4;

struct Order {
  std::string order_id, sku;
  int qty;
};

auto channel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
auto stub = flashsale::Warehouse::NewStub(channel);

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "fulfilment", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"orders"});
  return consumer;
}

auto consumer = make_consumer();

// The reservation became a sale: DEL hold:{order_id}, ZREM holds (provided).
void confirm(const std::string& order_id);
// Gives the hold back to stock (step 5).
void release(const std::string& order_id);
// Dead-letters the order on orders-failed (provided).
void publish_failed(const Order& order);
// Parses the JSON record written by the intake (provided).
Order parse_order(const RdKafka::Message& msg);

// True when the warehouse took the order, false when it has no physical stock.
bool allocate(const Order& order) {
  flashsale::AllocateRequest request;
  request.set_order_id(order.order_id);
  request.set_sku(order.sku);
  request.set_qty(order.qty);
  // TODO: up to kMaxAttempts calls with a ClientContext deadline of now + kDeadline
  // TODO: FAILED_PRECONDITION → false; UNAVAILABLE → sleep kBackoff << (attempt-1) and retry; else throw
  return false;
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const Order order = parse_order(*msg);
    // TODO: allocate → confirm; no stock → release + publish_failed; then commitSync this message
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

#include "warehouse.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{5000};
constexpr std::chrono::milliseconds kBackoff{250};
constexpr int kMaxAttempts = 4;

struct Order {
  std::string order_id, sku;
  int qty;
};

auto channel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
auto stub = flashsale::Warehouse::NewStub(channel);

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "fulfilment", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"orders"});
  return consumer;
}

auto consumer = make_consumer();

// The reservation became a sale: DEL hold:{order_id}, ZREM holds (provided).
void confirm(const std::string& order_id);
// Gives the hold back to stock (step 5).
void release(const std::string& order_id);
// Dead-letters the order on orders-failed (provided).
void publish_failed(const Order& order);
// Parses the JSON record written by the intake (provided).
Order parse_order(const RdKafka::Message& msg);

// True when the warehouse took the order, false when it has no physical stock.
bool allocate(const Order& order) {
  flashsale::AllocateRequest request;
  request.set_order_id(order.order_id);
  request.set_sku(order.sku);
  request.set_qty(order.qty);
  grpc::Status status;
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    if (attempt > 0) std::this_thread::sleep_for(kBackoff * (1 << (attempt - 1)));
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    flashsale::AllocateReply reply;
    status = stub->Allocate(&ctx, request, &reply);
    if (status.ok()) return true;
    if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) return false;
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) break;
  }
  throw std::runtime_error("warehouse: " + status.error_message());
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const Order order = parse_order(*msg);
    if (allocate(order)) {
      confirm(order.order_id);
    } else {
      std::cerr << "no physical stock for " << order.sku << ": releasing " << order.order_id << "\\n";
      release(order.order_id);
      publish_failed(order);
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import warehouse_pb2
import warehouse_pb2_grpc

NO_STOCK_SKU = "phantom-9"


class FakeWarehouse(warehouse_pb2_grpc.WarehouseServicer):
    def __init__(self):
        self.allocated = []

    def Allocate(self, request, context):
        if request.sku == NO_STOCK_SKU:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, "no physical stock")
        self.allocated.append((request.order_id, request.sku, request.qty))
        return warehouse_pb2.AllocateReply(shipment_id="ship-" + request.order_id)


def _order(order_id, sku="shoe-42", qty=2):
    return {"order_id": order_id, "sku": sku, "qty": qty, "user": "ada"}


def _seed(ctx, *orders):
    for order in orders:
        ctx.kafka.seed("orders", key=order["sku"], value=json.dumps(order))


def _consumer(ctx, *orders):
    _seed(ctx, *orders)
    peer = FakeWarehouse()
    ctx.grpc.serve(warehouse_pb2_grpc.add_WarehouseServicer_to_server, peer)
    m = ctx.load("fulfilment_consumer")
    log = []
    m.confirm = lambda order_id: log.append(("confirm", order_id))
    m.release = lambda order_id: log.append(("release", order_id))
    m.publish_failed = lambda order: log.append(("failed", dict(order)))
    return m, peer, log


def _calls(log, kind):
    return [e[1] for e in log if e[0] == kind]


def check_group_manual_commit(ctx):
    m, peer, log = _consumer(ctx, _order("o1"))
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "fulfilment", f"group.id must be fulfilment, got {group!r}"
    assert "orders" in topics, f"the consumer must subscribe to orders, got {topics}"
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit is on: offsets would be committed on a timer, before the outcome is handled"
    ctx.drain(m.run)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "the consumer never committed an offset itself"
    assert ctx.kafka.lag("fulfilment", "orders") == 0, "the handled record must be committed"


def check_deadline(ctx):
    m, peer, log = _consumer(ctx, _order("o1"))
    ctx.drain(m.run)
    calls = ctx.grpc.calls_to("Allocate")
    assert calls, "no Allocate RPC reached the warehouse"
    assert calls[-1].timeout is not None, "the Allocate RPC carries no deadline: a hung warehouse would stall the partition forever"
    assert 4.0 < calls[-1].timeout <= 5.0, f"the deadline is {calls[-1].timeout} s, expected 5 s"
    ctx.grpc.set_latency("Allocate", 30.0)
    before = len(calls)
    try:
        m.allocate(_order("o2"))
        raise AssertionError("a warehouse slower than the deadline must raise DEADLINE_EXCEEDED, not return")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.DEADLINE_EXCEEDED, f"a slow warehouse raised {e.code()}, expected DEADLINE_EXCEEDED"
    assert len(ctx.grpc.calls_to("Allocate")) == before + 1, "DEADLINE_EXCEEDED must not be retried"


def check_backoff_bounded(ctx):
    m, peer, log = _consumer(ctx)
    ctx.grpc.fail("Allocate", grpc.StatusCode.UNAVAILABLE, times=2)
    waited = ctx.clock.offset
    assert m.allocate(_order("o1")) is True, "two UNAVAILABLE answers followed by success must end as allocated (True)"
    assert len(ctx.grpc.calls_to("Allocate")) == 3, f"made {len(ctx.grpc.calls_to('Allocate'))} calls, expected 3 (two UNAVAILABLE, then success)"
    assert ctx.clock.sleeps == 2, f"slept {ctx.clock.sleeps} times before the retries, expected 2 (never before the first call)"
    waited = ctx.clock.offset - waited
    assert 0.74 <= waited <= 0.76, f"waited {waited:.3f} s across two retries, expected 0.25 + 0.5 = 0.75 s (base x 2^(attempt-1))"
    assert peer.allocated == [("o1", "shoe-42", 2)], f"the warehouse saw {peer.allocated}, expected the order's id, sku and qty"

    ctx.grpc.fail("Allocate", grpc.StatusCode.INVALID_ARGUMENT, "qty", times=1)
    try:
        m.allocate(_order("o2"))
        raise AssertionError("INVALID_ARGUMENT must propagate, not be retried or swallowed")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.INVALID_ARGUMENT, f"got {e.code()}, expected INVALID_ARGUMENT to propagate unchanged"
    assert len(ctx.grpc.calls_to("Allocate")) == 4, "INVALID_ARGUMENT must not be retried"

    ctx.grpc.fail("Allocate", grpc.StatusCode.UNAVAILABLE, times=50)
    waited = ctx.clock.offset
    try:
        m.allocate(_order("o3"))
        raise AssertionError("a warehouse that stays UNAVAILABLE must raise after MAX_ATTEMPTS, not return")
    except AssertionError:
        raise
    except Exception:
        pass
    attempts = len(ctx.grpc.calls_to("Allocate")) - 4
    assert attempts == 4, f"made {attempts} attempts against a down warehouse, expected 4 in total"
    waited = ctx.clock.offset - waited
    assert 1.74 <= waited <= 1.76, f"waited {waited:.3f} s across three retries, expected 0.25 + 0.5 + 1.0 = 1.75 s"


def check_no_stock(ctx):
    ghost = _order("o2", sku=NO_STOCK_SKU)
    m, peer, log = _consumer(ctx, _order("o1"), ghost)
    ctx.drain(m.run)
    assert _calls(log, "release") == ["o2"], f"release calls were {_calls(log, 'release')}, expected exactly ['o2'] (the order without physical stock)"
    assert _calls(log, "failed") == [ghost], f"publish_failed calls were {_calls(log, 'failed')}, expected the whole order o2"
    assert _calls(log, "confirm") == ["o1"], f"confirm calls were {_calls(log, 'confirm')}, expected ['o1'] only"
    assert len(ctx.grpc.calls_to("Allocate")) == 2, "FAILED_PRECONDITION is final: it must not be retried"
    assert ctx.kafka.lag("fulfilment", "orders") == 0, "a no-stock order is handled (released and dead-lettered) and must be committed"


def check_commit_after(ctx):
    m, peer, log = _consumer(ctx, _order("o1"))
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(list(log)))
    ctx.drain(m.run)
    assert _calls(log, "confirm") == ["o1"], f"a successful allocation must confirm the sale: confirm calls were {_calls(log, 'confirm')}"
    assert at_commit, "the offset was never committed"
    assert ("confirm", "o1") in at_commit[0], "the commit came before confirm(o1): a crash in between would lose the sale"
    assert ctx.kafka.lag("fulfilment", "orders") == 0, "the handled record must be committed"

    ctx.grpc.fail("Allocate", grpc.StatusCode.INTERNAL, "warehouse bug", times=1)
    _seed(ctx, _order("o2"))
    try:
        ctx.drain(m.run)
        raise AssertionError("an unexpected status must propagate out of the loop, not be swallowed")
    except AssertionError:
        raise
    except Exception:
        pass
    assert ctx.kafka.lag("fulfilment", "orders") == 1, "a record whose outcome is unknown must stay uncommitted so it is redelivered after a restart"
    assert "o2" not in _calls(log, "confirm") and "o2" not in _calls(log, "release"), "an unexpected status must neither confirm nor release the hold"
`,
    typescript: `const NO_STOCK_SKU = 'phantom-9';

type Entry = [string, unknown];

interface Order {
  order_id: string;
  sku: string;
  qty: number;
  user: string;
}

const order = (orderId: string, sku = 'shoe-42', qty = 2): Order => ({order_id: orderId, sku, qty, user: 'ada'});

function seed(ctx, ...orders: Order[]) {
  for (const o of orders) ctx.kafka.seed('orders', {key: o.sku, value: JSON.stringify(o)});
}

/** The warehouse peer (no stock for phantom-9) and the consumer with steps 5 and the dead-letter producer recorded. */
function consumer(ctx, ...orders: Order[]) {
  seed(ctx, ...orders);
  const allocated: [string, string, number][] = [];
  const pkg = ctx.proto('warehouse.proto');
  ctx.grpc.serve(pkg.flashsale.Warehouse.service, {
    Allocate(call, callback) {
      const {order_id, sku, qty} = call.request;
      if (sku === NO_STOCK_SKU) {
        callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: 'no physical stock'});
        return;
      }
      allocated.push([order_id, sku, qty]);
      callback(null, {shipment_id: 'ship-' + order_id});
    },
  });
  const m = ctx.load('fulfilment_consumer');
  const log: Entry[] = [];
  m.services.confirm = async (orderId: string) => {
    log.push(['confirm', orderId]);
  };
  m.services.release = async (orderId: string) => {
    log.push(['release', orderId]);
  };
  m.services.publishFailed = async (o: Record<string, unknown>) => {
    log.push(['failed', {...o}]);
  };
  return {m, allocated, log};
}

const calls = (log: Entry[], kind: string) => log.filter(e => e[0] === kind).map(e => e[1]);

/** Rejection of a promise as a value, or null when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

export async function check_group_manual_commit(ctx) {
  const {m} = consumer(ctx, order('o1'));
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to a topic');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, 'fulfilment', \`groupId must be fulfilment, got \${JSON.stringify(group)}\`);
  assert(topics.includes('orders'), \`the consumer must subscribe to orders, got \${JSON.stringify(topics)}\`);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'autoCommit is on: offsets were committed on a timer, before the outcome is handled');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'the consumer never committed an offset itself');
  assert.equal(ctx.kafka.lag('fulfilment', 'orders'), 0, 'the handled record must be committed');
}

export async function check_deadline(ctx) {
  const {m} = consumer(ctx, order('o1'));
  await ctx.drain(m.run());
  const calls_ = ctx.grpc.callsTo('Allocate');
  assert(calls_.length > 0, 'no Allocate RPC reached the warehouse');
  const timeout = calls_[calls_.length - 1].timeout;
  assert(timeout !== null, 'the Allocate RPC carries no deadline: a hung warehouse would stall the partition forever');
  assert(4 < timeout && timeout <= 5, \`the deadline is \${timeout} s, expected 5 s\`);
  ctx.grpc.setLatency('Allocate', 30);
  const before = calls_.length;
  const error = await rejection(m.allocate(order('o2')));
  assert(error !== null, 'a warehouse slower than the deadline must reject with DEADLINE_EXCEEDED, not resolve');
  assert.equal((error as {code?: number}).code, ctx.grpc.status.DEADLINE_EXCEEDED, \`a slow warehouse failed with code \${(error as {code?: number}).code}, expected DEADLINE_EXCEEDED (\${ctx.grpc.status.DEADLINE_EXCEEDED})\`);
  assert.equal(ctx.grpc.callsTo('Allocate').length, before + 1, 'DEADLINE_EXCEEDED must not be retried');
}

export async function check_backoff_bounded(ctx) {
  const {m, allocated} = consumer(ctx);
  ctx.grpc.fail('Allocate', ctx.grpc.status.UNAVAILABLE, '', 2);
  let started = ctx.clock.now();
  assert.equal(await m.allocate(order('o1')), true, 'two UNAVAILABLE answers followed by success must end as allocated (true)');
  assert.equal(ctx.grpc.callsTo('Allocate').length, 3, \`made \${ctx.grpc.callsTo('Allocate').length} calls, expected 3 (two UNAVAILABLE, then success)\`);
  assert.equal(ctx.clock.sleeps, 2, \`slept \${ctx.clock.sleeps} times before the retries, expected 2 (never before the first call)\`);
  let waited = ctx.clock.now() - started;
  assert(740 <= waited && waited <= 900, \`waited \${waited} ms across two retries, expected 250 + 500 = 750 ms (base x 2^(attempt-1))\`);
  assert.deepEqual(allocated, [['o1', 'shoe-42', 2]], \`the warehouse saw \${JSON.stringify(allocated)}, expected the order's id, sku and qty\`);

  ctx.grpc.fail('Allocate', ctx.grpc.status.INVALID_ARGUMENT, 'qty', 1);
  const error = await rejection(m.allocate(order('o2')));
  assert(error !== null, 'INVALID_ARGUMENT must propagate, not be retried or swallowed');
  assert.equal((error as {code?: number}).code, ctx.grpc.status.INVALID_ARGUMENT, \`got code \${(error as {code?: number}).code}, expected INVALID_ARGUMENT (\${ctx.grpc.status.INVALID_ARGUMENT}) to propagate unchanged\`);
  assert.equal(ctx.grpc.callsTo('Allocate').length, 4, 'INVALID_ARGUMENT must not be retried');

  ctx.grpc.fail('Allocate', ctx.grpc.status.UNAVAILABLE, '', 50);
  started = ctx.clock.now();
  const down = await rejection(m.allocate(order('o3')));
  assert(down !== null, 'a warehouse that stays UNAVAILABLE must reject after MAX_ATTEMPTS, not resolve');
  const attempts = ctx.grpc.callsTo('Allocate').length - 4;
  assert.equal(attempts, 4, \`made \${attempts} attempts against a down warehouse, expected 4 in total\`);
  waited = ctx.clock.now() - started;
  assert(1740 <= waited && waited <= 1900, \`waited \${waited} ms across three retries, expected 250 + 500 + 1000 = 1750 ms\`);
}

export async function check_no_stock(ctx) {
  const ghost = order('o2', NO_STOCK_SKU);
  const {m, log} = consumer(ctx, order('o1'), ghost);
  await ctx.drain(m.run());
  assert.deepEqual(calls(log, 'release'), ['o2'], \`release calls were \${JSON.stringify(calls(log, 'release'))}, expected exactly ['o2'] (the order without physical stock)\`);
  assert.deepEqual(calls(log, 'failed'), [ghost], \`publishFailed calls were \${JSON.stringify(calls(log, 'failed'))}, expected the whole order o2\`);
  assert.deepEqual(calls(log, 'confirm'), ['o1'], \`confirm calls were \${JSON.stringify(calls(log, 'confirm'))}, expected ['o1'] only\`);
  assert.equal(ctx.grpc.callsTo('Allocate').length, 2, 'FAILED_PRECONDITION is final: it must not be retried');
  assert.equal(ctx.kafka.lag('fulfilment', 'orders'), 0, 'a no-stock order is handled (released and dead-lettered) and must be committed');
}

export async function check_commit_after(ctx) {
  const {m, log} = consumer(ctx, order('o1'));
  const atCommit: Entry[][] = [];
  ctx.kafka.onCommit(() => atCommit.push([...log]));
  await ctx.drain(m.run());
  assert.deepEqual(calls(log, 'confirm'), ['o1'], \`a successful allocation must confirm the sale: confirm calls were \${JSON.stringify(calls(log, 'confirm'))}\`);
  assert(atCommit.length > 0, 'the offset was never committed');
  assert(atCommit[0].some(e => e[0] === 'confirm' && e[1] === 'o1'), 'the commit came before confirm(o1): a crash in between would lose the sale');
  assert.equal(ctx.kafka.lag('fulfilment', 'orders'), 0, 'the handled record must be committed');

  ctx.grpc.fail('Allocate', ctx.grpc.status.INTERNAL, 'warehouse bug', 1);
  seed(ctx, order('o2'));
  const error = await rejection(ctx.drain(m.run()));
  assert(error !== null, 'an unexpected status must propagate out of the loop, not be swallowed');
  assert.equal(ctx.kafka.lag('fulfilment', 'orders'), 1, 'a record whose outcome is unknown must stay uncommitted so it is redelivered after a restart');
  assert(!calls(log, 'confirm').includes('o2') && !calls(log, 'release').includes('o2'), 'an unexpected status must neither confirm nor release the hold');
}
`,
  },
  debrief: `The consumer is a state machine per record: allocate → (sale | no stock) → commit, and the commit is last so a crash anywhere before it replays the record instead of losing it. The gRPC side does what every good client does — a deadline on each call, backoff only for the one status that means "try later", a hard cap on attempts — and the order id in the request is what makes that replay safe on the warehouse side. Real fulfilment services process partitions with a small worker pool per partition, pause the partition (not the whole consumer) while a warehouse is down, and put the Redis \`confirm\` behind the warehouse's own transactional record so the two never disagree.`,
};
