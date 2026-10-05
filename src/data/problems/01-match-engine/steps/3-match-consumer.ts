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
  debrief: `The consumer group turns the partition key into ownership: whoever holds the \`ACME\` partition holds the \`ACME\` book, so the hottest structure in the system runs single-threaded with no lock. Producing the trades before committing keeps the offset honest — but with an in-memory book, a replay is not idempotent, which is the gap that separates this exercise from a real engine. Real engines close it by making the book a pure function of the sequenced input: on restart they rebuild from a snapshot plus the log (the commit is just a bookmark), and they deduplicate by sequence number so a replayed order is recognised, not re-matched. Add to that a warm standby consuming the same partition a few messages behind, and you have the failover story of every exchange.`,
};
