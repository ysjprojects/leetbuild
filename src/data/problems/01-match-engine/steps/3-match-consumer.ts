import type {Step} from '@/lib/types';

export const matchConsumerStep: Step = {
  id: 'match-consumer',
  title: 'The engine: match orders, emit trades, then commit',
  concept: 'kafka',
  file: 'match_engine',
  focus: ['orders', 'engine', 'trades'],
  task: `## Task

Implement the engine loop: a member of consumer group **\`engine\`** that reads \`orders\` and crosses each one
against the book of its symbol. \`Book\` is provided — a limit order book with **price-time priority**:
\`book.match(order)\` (\`matchOrder\` in Scala) rests or crosses the order and returns the fills it produced.

- Join group \`engine\` and subscribe to \`orders\`. Because orders are keyed by symbol, one member owns every
  order of a given symbol — \`books[symbol]\` needs no lock.
- **Disable auto-commit.** The offset moves only when you say so.
- Per record: parse the order, \`fills = books[symbol].match(order)\`, produce **one record per fill** on the
  **\`trades\`** topic keyed by the symbol, wait for those trades to be acknowledged, and **only then** commit
  the offset.
- A malformed record is skipped: log it and commit, so a poison message does not stall the partition.

:::widget order-book {}

> Committing after the trades are out gives at-least-once: a crash in between replays the order. For a stateless
> counter that is a harmless duplicate; for an in-memory book it is a second match — see the debrief for how real
> engines close that gap.

:::widget delivery-semantics {}`,
  sequence: {
    participants: ['Kafka', 'engine', 'Book'],
    messages: [
      {from: 'Kafka', to: 'engine', label: 'poll → order (partition 3, offset 5120)', kind: 'reply'},
      {from: 'engine', to: 'Book', label: 'books[ACME].match(order)', kind: 'sync'},
      {from: 'Book', to: 'engine', label: '[fill 100 @ 10.05, fill 50 @ 10.06]', kind: 'reply'},
      {from: 'engine', to: 'Kafka', label: 'produce trades ×2, key=ACME', kind: 'sync'},
      {from: 'Kafka', to: 'engine', label: 'acks', kind: 'reply'},
      {from: 'engine', to: 'Kafka', label: 'commit offset 5121 (partition 3)', kind: 'sync'},
    ],
  },
  hints: [
    'Consumer configuration first: `group.id=engine`, `enable.auto.commit=false` (kafka-go: `GroupID` + `FetchMessage`/`CommitMessages` instead of `ReadMessage`).',
    'The loop body has a fixed order — parse, match, produce every fill, wait for the producer, commit — and the malformed-record branch is the same loop body with the middle three steps removed.',
    'The trades producer is synchronous on purpose: flush (or `.get()` each future) before the commit call, otherwise a crash can commit an order whose trades were still sitting in the producer buffer.',
  ],
  checks: [
    {
      id: 'group',
      title: 'Joins consumer group engine on orders',
      detail:
        'The consumer must use `group.id` `engine` and subscribe to `orders`; the group is what assigns each symbol’s partition to exactly one engine.',
      match: {
        python: {all: [/"group\.id"\s*:\s*"engine"/, /subscribe\(\s*\[\s*"orders"\s*\]\s*\)/]},
        typescript: {all: [/groupId:\s*['"]engine['"]/, /subscribe\(\s*\{[^}]*topic:\s*['"]orders['"]/]},
        go: {all: [/GroupID:\s*"engine"/, /Topic:\s*"orders"/]},
        scala: {all: [/"group\.id"\s*,\s*"engine"|GROUP_ID_CONFIG\s*,\s*"engine"/, /subscribe\([^\n]*"orders"/]},
        cpp: {all: [/"group\.id"\s*,\s*"engine"/, /subscribe\([^\n]*"orders"/]},
      },
    },
    {
      id: 'manual-commit',
      title: 'Disables auto-commit',
      detail: 'Offsets must be committed explicitly, after the trades are out — not on a timer.',
      match: {
        python: {all: [/"enable\.auto\.commit"\s*:\s*False/]},
        typescript: {all: [/autoCommit:\s*false/, /commitOffsets\(/]},
        go: {all: [/reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"enable\.auto\.commit"\s*,\s*"false"|ENABLE_AUTO_COMMIT_CONFIG\s*,\s*"false"/]},
        cpp: {all: [/"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'match',
      title: 'Matches against the book of the order’s symbol',
      detail:
        'Look up (or create) the book for `order.symbol` and let it match the order; the fills it returns are the trades.',
      match: {
        python: {all: [/books\[\s*order\.symbol\s*\]/, /\.match\(\s*order\s*\)/]},
        typescript: {all: [/bookFor\(\s*order\.symbol\s*\)/, /\.match\(\s*order\s*\)/]},
        go: {all: [/bookFor\(\s*order\.Symbol\s*\)/, /\.Match\(\s*order\s*\)/]},
        scala: {all: [/books\.getOrElseUpdate\(\s*order\.symbol\s*,/, /\.matchOrder\(\s*order\s*\)/]},
        cpp: {all: [/books\[\s*order->symbol\s*\]/, /\.match\(\s*\*order\s*\)/]},
      },
    },
    {
      id: 'trades',
      title: 'Produces one trades record per fill, keyed by symbol',
      detail:
        'Every fill becomes its own record on `trades`, keyed by the symbol so a symbol’s trades stay in sequence for the market-data consumers.',
      match: {
        python: {all: [/for \w+ in fills:/, /producer\.produce\(\s*TRADES\s*,[^\n]*key\s*=\s*order\.symbol/]},
        typescript: {
          all: [/fills\.map\(|for \(const \w+ of fills\)/, /topic:\s*TRADES/, /key:\s*order\.symbol/],
        },
        go: {all: [/for _, \w+ := range fills/, /Key:\s*\[\]byte\(\s*order\.Symbol\s*\)/, /trades\.WriteMessages\(/]},
        scala: {
          all: [
            /fills\.map|fills\.foreach|for \(\w+ <- fills\)/,
            /new ProducerRecord(\[[^\]]*\])?\(\s*Trades\s*,\s*order\.symbol\s*,/,
          ],
        },
        cpp: {
          all: [
            /for \(\s*(const\s+)?(auto|Fill)\s*&?\s*\w+\s*:\s*fills\s*\)/,
            /produce\(\s*kTrades\s*,[\s\S]{0,400}?order->symbol\.(c_str|data)\(\)/,
          ],
        },
      },
    },
    {
      id: 'commit-after',
      title: 'Commits only after the trades are acknowledged',
      detail:
        'Match, produce, wait for the producer, then commit: the offset must never move past an order whose trades are not yet on the broker.',
      match: {
        python: {
          order: [/\.match\(\s*order\s*\)/, /producer\.produce\(\s*TRADES/, /producer\.flush\(/, /consumer\.commit\(/],
        },
        typescript: {order: [/\.match\(\s*order\s*\)/, /await producer\.send\(/, /commitOffsets\(/]},
        go: {order: [/\.Match\(\s*order\s*\)/, /trades\.WriteMessages\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/\.matchOrder\(\s*order\s*\)/, /producer\.send\(/, /\.get\(\)/, /consumer\.commitSync\(/]},
        cpp: {
          order: [
            /\.match\(\s*\*order\s*\)/,
            /producer->produce\(\s*kTrades/,
            /producer->flush\(/,
            /consumer->commitSync\(/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
from collections import defaultdict
from dataclasses import asdict

from confluent_kafka import Consumer, Producer

from book import Book, Order  # price-time priority: Book().match(order) -> list[Fill]

log = logging.getLogger("engine")
TRADES = "trades"

books: dict[str, Book] = defaultdict(Book)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "auto.offset.reset": "earliest",
        # TODO: group.id engine; disable auto-commit
    }
)
consumer.subscribe(["orders"])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: order = Order(**json.loads(msg.value())); malformed → log, commit, continue
        # TODO: fills = books[order.symbol].match(order); one TRADES record per fill, keyed by order.symbol
        # TODO: flush the producer, then commit this message's offset
        _ = asdict
        raise NotImplementedError
`,
      solution: `import json
import logging
from collections import defaultdict
from dataclasses import asdict

from confluent_kafka import Consumer, Producer

from book import Book, Order  # price-time priority: Book().match(order) -> list[Fill]

log = logging.getLogger("engine")
TRADES = "trades"

books: dict[str, Book] = defaultdict(Book)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})
consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "auto.offset.reset": "earliest",
        "group.id": "engine",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["orders"])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        try:
            order = Order(**json.loads(msg.value()))
        except (ValueError, TypeError):
            log.warning("skipping malformed order at offset %d", msg.offset())
            consumer.commit(message=msg, asynchronous=False)
            continue
        fills = books[order.symbol].match(order)
        for fill in fills:
            producer.produce(TRADES, key=order.symbol, value=json.dumps(asdict(fill)))
        producer.flush()  # every trade is on the broker before the offset moves
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {Book, type Order} from 'book'; // price-time priority: new Book().match(order) -> Fill[]

export const TRADES = 'trades';

const books = new Map<string, Book>();

function bookFor(symbol: string): Book {
  let book = books.get(symbol);
  if (book === undefined) {
    book = new Book();
    books.set(symbol, book);
  }
  return book;
}

const kafka = new Kafka({clientId: 'engine', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true});
export const consumer = kafka.consumer({groupId: 'engine'});

export async function run(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  // TODO: subscribe to orders (fromBeginning); run with autoCommit: false
  // TODO: per message: order = JSON.parse(message.value); malformed → log, commitOffsets, return
  // TODO: fills = bookFor(order.symbol).match(order); one TRADES record per fill, keyed by order.symbol
  // TODO: await the send (acks all), then commitOffsets this message's offset + 1
  void bookFor;
  throw new Error('not implemented');
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {Book, type Order} from 'book'; // price-time priority: new Book().match(order) -> Fill[]

export const TRADES = 'trades';

const books = new Map<string, Book>();

function bookFor(symbol: string): Book {
  let book = books.get(symbol);
  if (book === undefined) {
    book = new Book();
    books.set(symbol, book);
  }
  return book;
}

const kafka = new Kafka({clientId: 'engine', brokers: ['kafka:9092']});
export const producer = kafka.producer({idempotent: true});
export const consumer = kafka.consumer({groupId: 'engine'});

function parseOrder(value: Buffer | null): Order {
  const o = JSON.parse(value?.toString('utf8') ?? '') as Partial<Order>;
  if (
    typeof o !== 'object' ||
    o === null ||
    typeof o.order_id !== 'string' ||
    typeof o.symbol !== 'string' ||
    typeof o.side !== 'string' ||
    typeof o.price !== 'number' ||
    typeof o.qty !== 'number' ||
    typeof o.client_order_id !== 'string'
  ) {
    throw new TypeError('not an order');
  }
  return o as Order;
}

export async function run(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topic: 'orders', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const next = [{topic, partition, offset: String(Number(message.offset) + 1)}];
      let order: Order;
      try {
        order = parseOrder(message.value);
      } catch {
        console.warn(\`skipping malformed order at offset \${message.offset}\`);
        await consumer.commitOffsets(next);
        return;
      }
      const fills = bookFor(order.symbol).match(order);
      if (fills.length > 0) {
        // Resolves once every trade is acknowledged by the broker: only then may the offset move.
        await producer.send({
          topic: TRADES,
          acks: -1,
          messages: fills.map(fill => ({key: order.symbol, value: JSON.stringify(fill)})),
        });
      }
      await consumer.commitOffsets(next);
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
	"log"

	"github.com/segmentio/kafka-go"

	"exchange/book" // price-time priority: book.New().Match(order) → []book.Fill
)

var books = map[string]*book.Book{}

func bookFor(symbol string) *book.Book {
	b, ok := books[symbol]
	if !ok {
		b = book.New()
		books[symbol] = b
	}
	return b
}

var trades = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "trades",
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	Topic:   "orders",
	// TODO: GroupID engine
})

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: json.Unmarshal into a book.Order; malformed → log, CommitMessages, continue
		// TODO: fills := bookFor(order.Symbol).Match(order); one trades record per fill, Key = order.Symbol
		// TODO: trades.WriteMessages (synchronous), then CommitMessages for this message
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
	"log"

	"github.com/segmentio/kafka-go"

	"exchange/book" // price-time priority: book.New().Match(order) → []book.Fill
)

var books = map[string]*book.Book{}

func bookFor(symbol string) *book.Book {
	b, ok := books[symbol]
	if !ok {
		b = book.New()
		books[symbol] = b
	}
	return b
}

var trades = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "trades",
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	Topic:   "orders",
	GroupID: "engine",
})

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var order book.Order
		if err := json.Unmarshal(msg.Value, &order); err != nil || order.Symbol == "" {
			log.Printf("skipping malformed order at offset %d", msg.Offset)
			reader.CommitMessages(ctx, msg)
			continue
		}
		fills := bookFor(order.Symbol).Match(order)
		records := make([]kafka.Message, 0, len(fills))
		for _, fill := range fills {
			value, _ := json.Marshal(fill)
			records = append(records, kafka.Message{Key: []byte(order.Symbol), Value: value})
		}
		if len(records) > 0 {
			if err := trades.WriteMessages(ctx, records...); err != nil {
				return err // not committed: the offset stays on this order
			}
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

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

import exchange.book.{Book, Order} // price-time priority: book.matchOrder(order): Seq[Fill]; Order.parse(json): Option[Order]; fill.toJson: String

object MatchEngine {
  val Trades = "trades"
  private val books = mutable.Map.empty[String, Book]

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("auto.offset.reset", "earliest")
  // TODO: group.id engine; disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("orders").asJava)

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofMillis(100))
      records.asScala.foreach { record =>
        // TODO: Order.parse(record.value()); None → log and skip
        // TODO: books.getOrElseUpdate(symbol, new Book).matchOrder(order); one Trades record per fill, keyed by symbol
        // TODO: .get() every send so the trades are acknowledged
      }
      // TODO: commitSync once every trade of the batch is on the broker
    }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

import exchange.book.{Book, Order} // price-time priority: book.matchOrder(order): Seq[Fill]; Order.parse(json): Option[Order]; fill.toJson: String

object MatchEngine {
  val Trades = "trades"
  private val books = mutable.Map.empty[String, Book]

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("auto.offset.reset", "earliest")
  props.put("group.id", "engine")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("orders").asJava)

  def run(): Unit =
    while (true) {
      val records = consumer.poll(Duration.ofMillis(100))
      records.asScala.foreach { record =>
        Order.parse(record.value()) match {
          case None => System.err.println(s"skipping malformed order at offset \${record.offset()}")
          case Some(order) =>
            val book = books.getOrElseUpdate(order.symbol, new Book)
            val fills = book.matchOrder(order)
            val acks = fills.map(fill => producer.send(new ProducerRecord[String, String](Trades, order.symbol, fill.toJson)))
            acks.foreach(_.get()) // every trade is on the broker before the offset moves
        }
      }
      consumer.commitSync()
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>

#include "book.h"  // price-time priority: Book::match(const Order&) -> std::vector<Fill>; Order::parse(json) -> std::optional<Order>; Fill::to_json()

const std::string kTrades = "trades";
std::unordered_map<std::string, Book> books;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: group.id engine; disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"orders"});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    // TODO: Order::parse(value); nullopt → log, commitSync, continue
    // TODO: fills = books[order->symbol].match(*order); one kTrades record per fill, keyed by order->symbol
    // TODO: flush the producer, then commitSync this message
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>

#include "book.h"  // price-time priority: Book::match(const Order&) -> std::vector<Fill>; Order::parse(json) -> std::optional<Order>; Fill::to_json()

const std::string kTrades = "trades";
std::unordered_map<std::string, Book> books;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("group.id", "engine", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"orders"});
  return consumer;
}

auto producer = make_producer();
auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const std::string value(static_cast<const char*>(msg->payload()), msg->len());
    const auto order = Order::parse(value);
    if (!order) {
      std::cerr << "skipping malformed order at offset " << msg->offset() << "\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    const auto fills = books[order->symbol].match(*order);
    for (const auto& fill : fills) {
      std::string trade = fill.to_json();
      producer->produce(kTrades, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, trade.data(), trade.size(),
                        order->symbol.c_str(), order->symbol.size(), 0, nullptr);
    }
    producer->flush(5000);  // every trade is on the broker before the offset moves
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json


def _order(order_id, symbol, side, price, qty):
    return json.dumps({"order_id": order_id, "symbol": symbol, "side": side, "price": price, "qty": qty, "client_order_id": "c-" + order_id})


def _seed(ctx, *orders):
    for order_id, symbol, side, price, qty in orders:
        ctx.kafka.seed("orders", key=symbol, value=_order(order_id, symbol, side, price, qty))


def _run(ctx):
    """Load the engine after seeding (it subscribes at import) and drain the orders topic."""
    m = ctx.load("match_engine")
    ctx.drain(m.run)
    return m


def _trades(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records("trades")]


def check_group(ctx):
    _seed(ctx, ("o-1", "ACME", "BUY", 10.05, 100))
    _run(ctx)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer never subscribed"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "engine", f"the consumer joined group {group!r}, expected engine"
    assert topics == ["orders"], f"the consumer subscribed to {topics}, expected ['orders']"
    delivered = [e for e in ctx.kafka.events if e[0] == "deliver" and e[1] == "engine"]
    assert delivered, "group engine consumed nothing from orders"


def check_manual_commit(ctx):
    _seed(ctx, ("o-1", "ACME", "BUY", 10.05, 100))
    _run(ctx)
    consumer = ctx.kafka.consumers[-1]
    assert consumer.auto_commit is False, "enable.auto.commit must be False: the offset moves only when the engine says so"
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "the engine never committed the offset explicitly"
    assert ctx.kafka.lag("engine", "orders") == 0, f"after draining, the engine still has {ctx.kafka.lag('engine', 'orders')} uncommitted orders"


def check_match(ctx):
    _seed(
        ctx,
        ("o-1", "ACME", "BUY", 10.05, 100),
        ("o-2", "BETA", "SELL", 9.00, 100),  # another symbol: must not cross with ACME
        ("o-3", "ACME", "SELL", 10.00, 60),  # crosses o-1 at the resting price
    )
    _run(ctx)
    trades = _trades(ctx)
    assert len(trades) == 1, f"expected exactly one fill (ACME 60 @ 10.05), found {len(trades)} trades: {trades}"
    fill = trades[0]
    assert fill.get("symbol") == "ACME" and fill.get("qty") == 60 and fill.get("price") == 10.05, f"the fill must be 60 ACME at the resting price 10.05, got {fill}"
    assert fill.get("buy_order_id") == "o-1" and fill.get("sell_order_id") == "o-3", f"the fill must name o-1 (buy) and o-3 (sell), got {fill}"


def check_trades(ctx):
    _seed(
        ctx,
        ("o-1", "ACME", "SELL", 10.05, 50),
        ("o-2", "ACME", "SELL", 10.06, 50),
        ("o-3", "ACME", "BUY", 10.10, 80),  # fills 50 @ 10.05 then 30 @ 10.06
    )
    _run(ctx)
    records = ctx.kafka.records("trades")
    assert len(records) == 2, f"two fills must become two trades records, found {len(records)}"
    assert all(r.key == b"ACME" for r in records), f"trades must be keyed by the symbol, got {[r.key for r in records]}"
    assert records[0].partition == records[1].partition, "one symbol's trades must stay on one partition"
    fills = [(t.get("price"), t.get("qty")) for t in _trades(ctx)]
    assert fills == [(10.05, 50), (10.06, 30)], f"expected fills [(10.05, 50), (10.06, 30)] in price-time order, got {fills}"


def check_commit_after(ctx):
    _seed(
        ctx,
        ("o-1", "ACME", "BUY", 10.05, 100),
        ("o-2", "ACME", "SELL", 10.00, 40),
    )
    ctx.kafka.seed("orders", key="ACME", value="this is not an order")
    m = ctx.load("match_engine")
    seen = []  # (trades on the broker, trades still awaiting their delivery report) at the moment of each commit
    ctx.kafka.on_commit(lambda group, offsets: seen.append((len(ctx.kafka.records("trades")), len(m.producer))))
    ctx.drain(m.run)
    assert len(_trades(ctx)) == 1, f"expected one fill, found {len(_trades(ctx))}"
    assert len(seen) == 3, f"expected one commit per record (two orders and one malformed), found {len(seen)}"
    assert seen[1][0] == 1, "the offset of the crossing order was committed before its trade reached the broker"
    assert seen[1][1] == 0, "the offset of the crossing order was committed while its trade was still waiting for the broker's acknowledgement: flush first"
    events = ctx.kafka.events
    produced = next(i for i, e in enumerate(events) if e[0] == "produce" and e[1] == "trades")
    committed = next(i for i, e in enumerate(events) if i > produced and e[0] == "commit")
    assert any(e[0] == "flush" for e in events[produced:committed]), "no flush between producing the trade and committing its order: the trade could still sit in the producer buffer"
    assert ctx.kafka.lag("engine", "orders") == 0, "the malformed record must be skipped and committed so the partition does not stall"
`,
    typescript: `type Seed = [string, string, string, number, number];

function orderJson(orderId: string, symbol: string, side: string, price: number, qty: number): string {
  return JSON.stringify({order_id: orderId, symbol, side, price, qty, client_order_id: 'c-' + orderId});
}

function seed(ctx, ...orders: Seed[]) {
  for (const [orderId, symbol, side, price, qty] of orders)
    ctx.kafka.seed('orders', {key: symbol, value: orderJson(orderId, symbol, side, price, qty)});
}

/** Load the engine after seeding and drain the orders topic. */
async function run(ctx) {
  const m = ctx.load('match_engine');
  await ctx.drain(m.run());
  return m;
}

function trades(ctx): Record<string, unknown>[] {
  return ctx.kafka.values('trades').map((v: string) => JSON.parse(v));
}

export async function check_group(ctx) {
  seed(ctx, ['o-1', 'ACME', 'BUY', 10.05, 100]);
  await run(ctx);
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer never subscribed');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, 'engine', \`the consumer joined group \${JSON.stringify(group)}, expected engine\`);
  assert.deepEqual(topics, ['orders'], \`the consumer subscribed to \${JSON.stringify(topics)}, expected ['orders']\`);
  const delivered = ctx.kafka.events.filter(e => e[0] === 'deliver' && e[1] === 'engine');
  assert(delivered.length > 0, 'group engine consumed nothing from orders');
}

export async function check_manual_commit(ctx) {
  seed(ctx, ['o-1', 'ACME', 'BUY', 10.05, 100]);
  await run(ctx);
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'offsets were auto-committed: run with autoCommit: false, the offset moves only when the engine says so');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'the engine never committed the offset explicitly');
  assert.equal(ctx.kafka.lag('engine', 'orders'), 0, \`after draining, the engine still has \${ctx.kafka.lag('engine', 'orders')} uncommitted orders\`);
}

export async function check_match(ctx) {
  seed(
    ctx,
    ['o-1', 'ACME', 'BUY', 10.05, 100],
    ['o-2', 'BETA', 'SELL', 9.0, 100], // another symbol: must not cross with ACME
    ['o-3', 'ACME', 'SELL', 10.0, 60], // crosses o-1 at the resting price
  );
  await run(ctx);
  const fills = trades(ctx);
  assert.equal(fills.length, 1, \`expected exactly one fill (ACME 60 @ 10.05), found \${fills.length} trades: \${JSON.stringify(fills)}\`);
  const fill = fills[0];
  assert(fill.symbol === 'ACME' && fill.qty === 60 && fill.price === 10.05, \`the fill must be 60 ACME at the resting price 10.05, got \${JSON.stringify(fill)}\`);
  assert(fill.buy_order_id === 'o-1' && fill.sell_order_id === 'o-3', \`the fill must name o-1 (buy) and o-3 (sell), got \${JSON.stringify(fill)}\`);
}

export async function check_trades(ctx) {
  seed(
    ctx,
    ['o-1', 'ACME', 'SELL', 10.05, 50],
    ['o-2', 'ACME', 'SELL', 10.06, 50],
    ['o-3', 'ACME', 'BUY', 10.1, 80], // fills 50 @ 10.05 then 30 @ 10.06
  );
  await run(ctx);
  const records = ctx.kafka.records('trades');
  assert.equal(records.length, 2, \`two fills must become two trades records, found \${records.length}\`);
  const keys = ctx.kafka.keys('trades');
  assert(keys.every(k => k === 'ACME'), \`trades must be keyed by the symbol, got \${JSON.stringify(keys)}\`);
  assert.equal(records[0].partition, records[1].partition, "one symbol's trades must stay on one partition");
  const fills = trades(ctx).map(t => [t.price, t.qty]);
  assert.deepEqual(fills, [[10.05, 50], [10.06, 30]], \`expected fills [[10.05, 50], [10.06, 30]] in price-time order, got \${JSON.stringify(fills)}\`);
}

export async function check_commit_after(ctx) {
  seed(ctx, ['o-1', 'ACME', 'BUY', 10.05, 100], ['o-2', 'ACME', 'SELL', 10.0, 40]);
  ctx.kafka.seed('orders', {key: 'ACME', value: 'this is not an order'});
  // The trades topic's leader is slow to acknowledge: a trade is on the broker only once the send resolved.
  ctx.kafka.stall('trades', 0.2);
  const seen: number[] = []; // trades on the broker at the moment of each commit
  ctx.kafka.onCommit(() => seen.push(ctx.kafka.records('trades').length));
  const m = ctx.load('match_engine');
  await ctx.drain(m.run());
  assert.equal(seen.length, 3, \`expected one commit per record (two orders and one malformed), found \${seen.length}\`);
  assert.equal(seen[1], 1, "the offset of the crossing order was committed while its trade was still waiting for the broker's acknowledgement: await the send before committing");
  assert.equal(trades(ctx).length, 1, \`expected one fill, found \${trades(ctx).length}\`);
  assert.equal(ctx.kafka.lag('engine', 'orders'), 0, 'the malformed record must be skipped and committed so the partition does not stall');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"
)

type seededOrder struct {
	orderID, symbol, side string
	price                 float64
	qty                   int
}

func seedOrders(ctx *harness.Ctx, orders ...seededOrder) {
	for _, o := range orders {
		value := fmt.Sprintf("{%q:%q,%q:%q,%q:%q,%q:%v,%q:%d,%q:%q}", "order_id", o.orderID, "symbol", o.symbol, "side", o.side, "price", o.price, "qty", o.qty, "client_order_id", "c-"+o.orderID)
		ctx.Kafka.Seed("orders", o.symbol, value)
	}
}

// runEngine drains the orders topic through the learner's loop.
func runEngine(ctx *harness.Ctx) {
	ctx.Drain(func() { _ = run(context.Background()) })
}

func tradesOnBroker(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, v := range ctx.Kafka.Values("trades") {
		var t map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &t), "a trades record is not JSON: %q", v)
		out = append(out, t)
	}
	return out
}

func CheckGroup(ctx *harness.Ctx) {
	seedOrders(ctx, seededOrder{"o-1", "ACME", "BUY", 10.05, 100})
	runEngine(ctx)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer never subscribed")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, "engine", "the consumer joined the wrong group")
	ctx.Equal(last.Topics, []string{"orders"}, "the consumer's topics")
	delivered := 0
	for _, e := range ctx.Kafka.EventsOf("deliver") {
		if e.Group == "engine" {
			delivered++
		}
	}
	ctx.Assert(delivered > 0, "group engine consumed nothing from orders")
}

func CheckManualCommit(ctx *harness.Ctx) {
	seedOrders(ctx, seededOrder{"o-1", "ACME", "BUY", 10.05, 100})
	runEngine(ctx)
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "offsets were auto-committed: FetchMessage, not ReadMessage, and no CommitInterval; the offset moves only when the engine says so")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "the engine never committed the offset explicitly")
	lag := ctx.Kafka.Lag("engine", "orders")
	ctx.Equal(lag, 0, "after draining, the engine still has %d uncommitted orders", lag)
}

func CheckMatch(ctx *harness.Ctx) {
	seedOrders(ctx,
		seededOrder{"o-1", "ACME", "BUY", 10.05, 100},
		seededOrder{"o-2", "BETA", "SELL", 9.0, 100}, // another symbol: must not cross with ACME
		seededOrder{"o-3", "ACME", "SELL", 10.0, 60}, // crosses o-1 at the resting price
	)
	runEngine(ctx)
	fills := tradesOnBroker(ctx)
	ctx.Equal(len(fills), 1, "expected exactly one fill (ACME 60 @ 10.05), trades %v; trades", fills)
	fill := fills[0]
	ctx.Assert(fill["symbol"] == "ACME" && fill["qty"] == 60.0 && fill["price"] == 10.05, "the fill must be 60 ACME at the resting price 10.05, got %v", fill)
	ctx.Assert(fill["buy_order_id"] == "o-1" && fill["sell_order_id"] == "o-3", "the fill must name o-1 (buy) and o-3 (sell), got %v", fill)
}

func CheckTrades(ctx *harness.Ctx) {
	seedOrders(ctx,
		seededOrder{"o-1", "ACME", "SELL", 10.05, 50},
		seededOrder{"o-2", "ACME", "SELL", 10.06, 50},
		seededOrder{"o-3", "ACME", "BUY", 10.1, 80}, // fills 50 @ 10.05 then 30 @ 10.06
	)
	runEngine(ctx)
	records := ctx.Kafka.Records("trades")
	ctx.Equal(len(records), 2, "two fills must become two trades records")
	keys := ctx.Kafka.Keys("trades")
	for _, k := range keys {
		ctx.Assert(k == "ACME", "trades must be keyed by the symbol, got %q", keys)
	}
	ctx.Equal(records[0].Partition, records[1].Partition, "one symbol's trades must stay on one partition")
	var fills [][2]any
	for _, t := range tradesOnBroker(ctx) {
		fills = append(fills, [2]any{t["price"], t["qty"]})
	}
	ctx.Equal(fills, [][2]any{{10.05, 50.0}, {10.06, 30.0}}, "expected fills [[10.05, 50], [10.06, 30]] in price-time order")
}

func CheckCommitAfter(ctx *harness.Ctx) {
	seedOrders(ctx, seededOrder{"o-1", "ACME", "BUY", 10.05, 100}, seededOrder{"o-2", "ACME", "SELL", 10.0, 40})
	ctx.Kafka.Seed("orders", "ACME", "this is not an order")
	// The trades topic's leader is slow to acknowledge: a trade is on the broker only once the write returned.
	ctx.Kafka.StallFor("trades", 0.2)
	var seen []int // trades on the broker at the moment of each commit
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { seen = append(seen, len(ctx.Kafka.Records("trades"))) })
	runEngine(ctx)
	ctx.Equal(len(seen), 3, "expected one commit per record (two orders and one malformed)")
	ctx.Equal(seen[1], 1, "the offset of the crossing order was committed while its trade was still waiting for the broker's acknowledgement: WriteMessages before committing; trades on the broker at that commit")
	ctx.Equal(len(tradesOnBroker(ctx)), 1, "expected one fill")
	ctx.Equal(ctx.Kafka.Lag("engine", "orders"), 0, "the malformed record must be skipped and committed so the partition does not stall; uncommitted orders")
}
`,
  },
  debrief: `The consumer group turns the partition key into ownership: whoever holds the \`ACME\` partition holds the \`ACME\` book, so the hottest structure in the system runs single-threaded with no lock. Producing the trades before committing keeps the offset honest — but with an in-memory book, a replay is not idempotent, which is the gap that separates this exercise from a real engine. Real engines close it by making the book a pure function of the sequenced input: on restart they rebuild from a snapshot plus the log (the commit is just a bookmark), and they deduplicate by sequence number so a replayed order is recognised, not re-matched. Add to that a warm standby consuming the same partition a few messages behind, and you have the failover story of every exchange.`,
};
