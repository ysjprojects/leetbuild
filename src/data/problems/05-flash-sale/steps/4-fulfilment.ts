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
  debrief: `The consumer is a state machine per record: allocate → (sale | no stock) → commit, and the commit is last so a crash anywhere before it replays the record instead of losing it. The gRPC side does what every good client does — a deadline on each call, backoff only for the one status that means "try later", a hard cap on attempts — and the order id in the request is what makes that replay safe on the warehouse side. Real fulfilment services process partitions with a small worker pool per partition, pause the partition (not the whole consumer) while a warehouse is down, and put the Redis \`confirm\` behind the warehouse's own transactional record so the two never disagree.`,
};
