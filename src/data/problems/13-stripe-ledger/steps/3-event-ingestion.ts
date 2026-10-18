import type {Step} from '@/lib/types';

// ---- 3. Money-movement events → balanced transactions -------------------------------------------
export const eventIngestionStep: Step = {
  id: 'event-ingestion',
  title: 'Turn money-events into transactions',
  concept: 'kafka',
  file: 'event_consumer',
  focus: ['kafka', 'ingest', 'dead', 'db'],
  task: `## Task

Most of the ledger is not posted over HTTPS: the systems that move money publish **events** to the
\`money-events\` topic, keyed by event id —

\`\`\`json
{"event_id": "evt_01", "type": "payment.captured", "amount": 4999, "currency": "EUR",
 "occurred_at": 1700000000000, "charge": "ch_1"}
\`\`\`

— and the ingest consumer turns each one into a balanced transaction. The **mapping** from event type to
accounts is provided: \`payment.captured\` debits \`cash:acquirer\` and credits \`clearing:payments\`,
\`payout.sent\` debits \`clearing:payouts\` and credits \`cash:bank\`, \`refund.issued\` debits
\`clearing:payments\` and credits \`cash:acquirer\`. \`parse(raw)\` returns the event as a dict or \`None\`
when it is not a well-formed event, and \`write_transaction\` (step 4) writes the rows.

Implement \`to_entries(event)\` and the consumer loop \`run()\` in group **\`ledger\`**:

- Disable auto-commit; the offset is committed by you, **after** the write.
- \`to_entries\`: two entries in the event's currency — the amount **debited** from the first account,
  **credited** (negated) to the second — or \`None\` when the type has no mapping.
- An event that cannot be parsed or has no mapping goes to **\`money-events.dead\`** with the original key
  and value and a \`reason\` header; **flush** the producer, commit the offset, and carry on. A consumer
  that stops on the first unknown event stops the whole ledger.
- Otherwise \`await write_transaction(entries, event["type"], event_id=…, posted_at=event["occurred_at"])\`,
  **then** commit this message's offset. If the write throws, do not commit: the record comes back.

:::widget consumer-groups {"partitions": 3}

> The dead-letter topic is the consumer's "I don't know what this is" — which is different from "this is
> wrong". Someone looks at it, adds the mapping, and replays. Stripe's post calls this the long tail:
> the tiny fraction of events that need a human, kept out of the way of the billions that do not.`,
  sequence: {
    participants: ['Kafka', 'ledger-ingest', 'Postgres', 'money-events.dead'],
    messages: [
      {from: 'Kafka', to: 'ledger-ingest', label: 'evt_01 payment.captured 4999 EUR', kind: 'async'},
      {
        from: 'ledger-ingest',
        to: 'ledger-ingest',
        label: 'MAPPING → [+4999 cash:acquirer, −4999 clearing:payments]',
        kind: 'sync',
      },
      {
        from: 'ledger-ingest',
        to: 'Postgres',
        label: 'write_transaction(entries, event_id=evt_01, posted_at=occurred_at)',
        kind: 'sync',
      },
      {from: 'ledger-ingest', to: 'Kafka', label: 'commit offset', kind: 'sync'},
      {from: 'Kafka', to: 'ledger-ingest', label: 'evt_02 dispute.opened 4999 EUR', kind: 'async'},
      {
        from: 'ledger-ingest',
        to: 'money-events.dead',
        label: 'produce evt_02 · reason: unmapped type · flush',
        kind: 'async',
      },
      {from: 'ledger-ingest', to: 'Kafka', label: 'commit offset', kind: 'sync'},
    ],
  },
  hints: [
    'Three branches per record, every one ending in a commit except the failed write: parse/map fails → dead-letter then commit; write succeeds → commit; write throws → re-raise without committing.',
    'The dead-letter record is the original record — `msg.key()` and `msg.value()` as they came — plus a header; do not re-serialise what you could not parse. Flush before the commit, or a crash in between loses the only copy you parked.',
    'The credit is the negated amount in the same currency: `[{debit, +amount}, {credit, -amount}]` is balanced by construction, which is why the API validation of step 1 is not repeated here.',
  ],
  checks: [
    {
      id: 'group-manual-commit',
      title: 'Joins group ledger on money-events with auto-commit disabled',
      detail:
        'The consumer uses `group.id` `ledger`, subscribes to `money-events` and commits offsets itself; auto-commit acknowledges on a timer, before the write.',
      match: {
        python: {all: [/"group\.id"\s*:\s*"ledger"/, /"enable\.auto\.commit"\s*:\s*False/, /consumer\.commit\(/]},
        typescript: {all: [/groupId:\s*['"]ledger['"]/, /autoCommit:\s*false/, /\.commitOffsets\(/]},
        go: {
          all: [/GroupID:\s*"ledger"/, /reader\.FetchMessage\(/, /reader\.CommitMessages\(/],
          none: [/ReadMessage\(/],
        },
        scala: {all: [/"group\.id"\s*,\s*"ledger"/, /"enable\.auto\.commit"\s*,\s*"false"/, /commitSync\(/]},
        cpp: {all: [/"group\.id"\s*,\s*"ledger"/, /"enable\.auto\.commit"\s*,\s*"false"/, /commitSync\(/]},
      },
    },
    {
      id: 'mapping',
      title: 'Maps each event to a debit and a negated credit through the mapping table',
      detail:
        "Look the type up in the mapping; the first account gets `+amount`, the second `-amount`, both in the event's currency. The write carries the event id and the event's own `occurred_at`.",
      match: {
        python: {
          all: [
            /MAPPING\.get\(|MAPPING\[/,
            /-\s*amount\b/,
            /(?<!def )write_transaction\([^\n]*event_id\s*=/,
            /posted_at\s*=\s*event\[["']occurred_at["']\]/,
          ],
        },
        typescript: {
          all: [
            /MAPPING\[/,
            /-\s*amount\b/,
            /(?<!\{)\bwriteTransaction\([^\n]*eventId/,
            /postedAt:\s*event\.occurred_at/,
          ],
        },
        go: {all: [/mapping\[/, /-amount\b|-\s*event\.Amount\b/, /(?<!func )writeTransaction\(/, /event\.OccurredAt/]},
        scala: {
          all: [/Mapping\.get\(/, /-amount\b|-\s*event\.amount\b/, /(?<!def )writeTransaction\(/, /\w+\.occurredAt/],
        },
        cpp: {
          all: [
            /kMapping\.find\(/,
            /-amount\b|-\s*event\.amount\b/,
            /(?<!string )write_transaction\(/,
            /event(->|\.)occurred_at/,
          ],
        },
      },
    },
    {
      id: 'dead-letter',
      title: 'Parks unparseable or unmapped events on money-events.dead',
      detail:
        'Produce the original key and value to `money-events.dead` with a `reason` header and flush; nothing is written to the journal for such an event.',
      match: {
        python: {all: [/producer\.produce\(\s*DEAD_TOPIC/, /producer\.flush\(/, /reason/]},
        typescript: {all: [/\.send\(\s*\{\s*topic:\s*DEAD_TOPIC/, /reason/]},
        go: {all: [/deadWriter\.WriteMessages\(/, /reason/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*DeadTopic/, /\.get\(\)/, /reason/]},
        cpp: {all: [/producer->produce\(\s*kDeadTopic/, /producer->flush\(/, /reason/]},
      },
    },
    {
      id: 'continues-after-dead',
      title: 'Commits the dead-lettered offset and keeps consuming',
      detail:
        'A parked record is committed like any other and the loop goes on; skipping it without committing would redeliver it forever, stopping would stall the partition.',
      match: {
        python: {
          order: [/producer\.produce\(\s*DEAD_TOPIC/, /consumer\.commit\(/, /continue/, /await write_transaction\(/],
        },
        typescript: {
          order: [
            /\.send\(\s*\{\s*topic:\s*DEAD_TOPIC/,
            /await commit\(\)|\.commitOffsets\(/,
            /return/,
            /await writeTransaction\(/,
          ],
        },
        go: {
          order: [
            /deadWriter\.WriteMessages\(/,
            /reader\.CommitMessages\(/,
            /continue/,
            /(?<!func )writeTransaction\(/,
          ],
        },
        scala: {
          order: [/ProducerRecord\[[^\]]*\]\(\s*DeadTopic/, /commit\(\s*record\s*\)/, /(?<!def )writeTransaction\(/],
        },
        cpp: {
          order: [/produce\(\s*kDeadTopic/, /consumer->commitSync\(/, /continue/, /(?<!string )write_transaction\(/],
        },
      },
    },
    {
      id: 'commit-after-write',
      title: 'Commits only after the write succeeded',
      detail:
        'The commit follows `write_transaction`; a crash between the two replays the record, and step 4 makes the replay harmless.',
      match: {
        python: {order: [/await write_transaction\(/, /consumer\.commit\(/]},
        typescript: {order: [/await writeTransaction\(/, /await commit\(\)|\.commitOffsets\(/]},
        go: {order: [/(?<!func )writeTransaction\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/(?<!def )writeTransaction\(/, /commit\(\s*record\s*\)/]},
        cpp: {order: [/(?<!string )write_transaction\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer

from ledger_writer import write_transaction  # built in step 4: insert-or-skip on event_id, returns the id or None

log = logging.getLogger("ledger-ingest")

TOPIC = "money-events"
DEAD_TOPIC = "money-events.dead"
REQUIRED = ("event_id", "type", "amount", "currency", "occurred_at")

# Event type → (debit account, credit account): the amount is debited from the first, credited to the second.
MAPPING = {
    "payment.captured": ("cash:acquirer", "clearing:payments"),
    "payout.sent": ("clearing:payouts", "cash:bank"),
    "refund.issued": ("clearing:payments", "cash:acquirer"),
}

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "ledger",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe([TOPIC])
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def parse(raw: bytes) -> dict | None:
    """The event as a dict, or None when it is not JSON or lacks a required field."""
    try:
        event = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(event, dict) or any(field not in event for field in REQUIRED):
        return None
    return event


def to_entries(event: dict) -> list[dict] | None:
    """The two balanced entries for an event, or None when its type has no mapping."""
    # TODO: MAPPING[type] → [{debit account, +amount}, {credit account, -amount}] in the event's currency
    return None


async def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        # TODO: parse + to_entries; None → produce the original key/value to DEAD_TOPIC with a reason header, flush, commit, continue
        # TODO: await write_transaction(entries, event["type"], event_id=event["event_id"], posted_at=event["occurred_at"]), then commit
        raise NotImplementedError
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer

from ledger_writer import write_transaction  # built in step 4: insert-or-skip on event_id, returns the id or None

log = logging.getLogger("ledger-ingest")

TOPIC = "money-events"
DEAD_TOPIC = "money-events.dead"
REQUIRED = ("event_id", "type", "amount", "currency", "occurred_at")

# Event type → (debit account, credit account): the amount is debited from the first, credited to the second.
MAPPING = {
    "payment.captured": ("cash:acquirer", "clearing:payments"),
    "payout.sent": ("clearing:payouts", "cash:bank"),
    "refund.issued": ("clearing:payments", "cash:acquirer"),
}

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "ledger",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe([TOPIC])
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def parse(raw: bytes) -> dict | None:
    """The event as a dict, or None when it is not JSON or lacks a required field."""
    try:
        event = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(event, dict) or any(field not in event for field in REQUIRED):
        return None
    return event


def to_entries(event: dict) -> list[dict] | None:
    """The two balanced entries for an event, or None when its type has no mapping."""
    accounts = MAPPING.get(event["type"])
    if accounts is None:
        return None
    debit, credit = accounts
    amount, currency = event["amount"], event["currency"]
    return [
        {"account": debit, "currency": currency, "amount": amount},
        {"account": credit, "currency": currency, "amount": -amount},
    ]


def dead_letter(msg, reason: str) -> None:
    """Park the original record where a human can look at it; flushed so a crash cannot lose it."""
    producer.produce(DEAD_TOPIC, key=msg.key(), value=msg.value(), headers={"reason": reason})
    producer.flush()


async def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        event = parse(msg.value())
        entries = to_entries(event) if event is not None else None
        if entries is None:
            dead_letter(msg, "malformed event" if event is None else f"no mapping for event type {event['type']}")
            consumer.commit(message=msg, asynchronous=False)
            continue
        await write_transaction(entries, event["type"], event_id=event["event_id"], posted_at=event["occurred_at"])
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import {type EachMessagePayload, Kafka, type KafkaMessage} from 'kafkajs';

import {type Entry, writeTransaction} from './ledger_writer'; // built in step 4: insert-or-skip on event_id, returns the id or null

export const TOPIC = 'money-events';
export const DEAD_TOPIC = 'money-events.dead';
const REQUIRED = ['event_id', 'type', 'amount', 'currency', 'occurred_at'];

export interface MoneyEvent {
  event_id: string;
  type: string;
  amount: number;
  currency: string;
  occurred_at: number;
  [extra: string]: unknown;
}

// Event type → [debit account, credit account]: the amount is debited from the first, credited to the second.
export const MAPPING: Record<string, [string, string]> = {
  'payment.captured': ['cash:acquirer', 'clearing:payments'],
  'payout.sent': ['clearing:payouts', 'cash:bank'],
  'refund.issued': ['clearing:payments', 'cash:acquirer'],
};

const kafka = new Kafka({clientId: 'ledger-ingest', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'ledger'});
const producer = kafka.producer({idempotent: true});

/** The event as an object, or null when the record is not JSON or lacks a required field. */
export function parse(raw: Buffer | null): MoneyEvent | null {
  if (raw === null) return null;
  let event: unknown;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  if (REQUIRED.some(field => !(field in event))) return null;
  return event as MoneyEvent;
}

/** The two balanced entries for an event, or null when its type has no mapping. */
export function toEntries(event: MoneyEvent): Entry[] | null {
  // TODO: MAPPING[type] → [{debit account, +amount}, {credit account, -amount}] in the event's currency
  return null;
}

/** Park the original record where a human can look at it; \`send\` resolves once the broker acknowledged it. */
async function deadLetter(message: KafkaMessage, reason: string): Promise<void> {
  await producer.send({topic: DEAD_TOPIC, messages: [{key: message.key, value: message.value, headers: {reason}}]});
}

export async function run(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      // TODO: parse + toEntries; null → deadLetter(message, reason), commit this offset, return
      // TODO: await writeTransaction(entries, event.type, {eventId: event.event_id, postedAt: event.occurred_at}), then commit
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import {type EachMessagePayload, Kafka, type KafkaMessage} from 'kafkajs';

import {type Entry, writeTransaction} from './ledger_writer'; // built in step 4: insert-or-skip on event_id, returns the id or null

export const TOPIC = 'money-events';
export const DEAD_TOPIC = 'money-events.dead';
const REQUIRED = ['event_id', 'type', 'amount', 'currency', 'occurred_at'];

export interface MoneyEvent {
  event_id: string;
  type: string;
  amount: number;
  currency: string;
  occurred_at: number;
  [extra: string]: unknown;
}

// Event type → [debit account, credit account]: the amount is debited from the first, credited to the second.
export const MAPPING: Record<string, [string, string]> = {
  'payment.captured': ['cash:acquirer', 'clearing:payments'],
  'payout.sent': ['clearing:payouts', 'cash:bank'],
  'refund.issued': ['clearing:payments', 'cash:acquirer'],
};

const kafka = new Kafka({clientId: 'ledger-ingest', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'ledger'});
const producer = kafka.producer({idempotent: true});

/** The event as an object, or null when the record is not JSON or lacks a required field. */
export function parse(raw: Buffer | null): MoneyEvent | null {
  if (raw === null) return null;
  let event: unknown;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  if (REQUIRED.some(field => !(field in event))) return null;
  return event as MoneyEvent;
}

/** The two balanced entries for an event, or null when its type has no mapping. */
export function toEntries(event: MoneyEvent): Entry[] | null {
  const accounts = MAPPING[event.type];
  if (accounts === undefined) return null;
  const [debit, credit] = accounts;
  const {amount, currency} = event;
  return [
    {account: debit, currency, amount},
    {account: credit, currency, amount: -amount},
  ];
}

/** Park the original record where a human can look at it; \`send\` resolves once the broker acknowledged it. */
async function deadLetter(message: KafkaMessage, reason: string): Promise<void> {
  await producer.send({topic: DEAD_TOPIC, messages: [{key: message.key, value: message.value, headers: {reason}}]});
}

export async function run(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}: EachMessagePayload) => {
      const commit = (): Promise<void> =>
        consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = parse(message.value);
      const entries = event === null ? null : toEntries(event);
      if (event === null || entries === null) {
        await deadLetter(message, event === null ? 'malformed event' : \`no mapping for event type \${event.type}\`);
        await commit();
        return;
      }
      await writeTransaction(entries, event.type, {eventId: event.event_id, postedAt: event.occurred_at});
      await commit();
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
)

const (
	topic     = "money-events"
	deadTopic = "money-events.dead"
)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

type Event struct {
	EventID    string \`json:"event_id"\`
	Type       string \`json:"type"\`
	Amount     int64  \`json:"amount"\`
	Currency   string \`json:"currency"\`
	OccurredAt int64  \`json:"occurred_at"\`
}

// Event type → {debit account, credit account}: the amount is debited from the first, credited to the second.
var mapping = map[string][2]string{
	"payment.captured": {"cash:acquirer", "clearing:payments"},
	"payout.sent":      {"clearing:payouts", "cash:bank"},
	"refund.issued":    {"clearing:payments", "cash:acquirer"},
}

// writeTransaction is built in step 4 (ledger_writer.go): insert-or-skip on the event id.
func writeTransaction(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
	panic("not implemented")
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "ledger",
	Topic:   topic,
})

var deadWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: deadTopic, RequiredAcks: kafka.RequireAll}

// parse returns the event, or false when the value is not a well-formed event.
func parse(value []byte) (Event, bool) {
	var event Event
	if err := json.Unmarshal(value, &event); err != nil || event.EventID == "" || event.Type == "" || event.Currency == "" || event.OccurredAt <= 0 {
		return Event{}, false
	}
	return event, true
}

// toEntries returns the two balanced entries for an event, or nil when its type has no mapping.
func toEntries(event Event) []Entry {
	// TODO: mapping[event.Type] → {debit, +amount}, {credit, -amount} in the event's currency
	return nil
}

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: parse + toEntries; nil → deadWriter.WriteMessages the original key/value with a reason header, CommitMessages, continue
		// TODO: writeTransaction(ctx, entries, event.Type, &event.EventID, event.OccurredAt, nil), then CommitMessages
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
)

const (
	topic     = "money-events"
	deadTopic = "money-events.dead"
)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

type Event struct {
	EventID    string \`json:"event_id"\`
	Type       string \`json:"type"\`
	Amount     int64  \`json:"amount"\`
	Currency   string \`json:"currency"\`
	OccurredAt int64  \`json:"occurred_at"\`
}

// Event type → {debit account, credit account}: the amount is debited from the first, credited to the second.
var mapping = map[string][2]string{
	"payment.captured": {"cash:acquirer", "clearing:payments"},
	"payout.sent":      {"clearing:payouts", "cash:bank"},
	"refund.issued":    {"clearing:payments", "cash:acquirer"},
}

// writeTransaction is built in step 4 (ledger_writer.go): insert-or-skip on the event id.
func writeTransaction(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
	panic("not implemented")
}

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "ledger",
	Topic:   topic,
})

var deadWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: deadTopic, RequiredAcks: kafka.RequireAll}

// parse returns the event, or false when the value is not a well-formed event.
func parse(value []byte) (Event, bool) {
	var event Event
	if err := json.Unmarshal(value, &event); err != nil || event.EventID == "" || event.Type == "" || event.Currency == "" || event.OccurredAt <= 0 {
		return Event{}, false
	}
	return event, true
}

// toEntries returns the two balanced entries for an event, or nil when its type has no mapping.
func toEntries(event Event) []Entry {
	accounts, ok := mapping[event.Type]
	if !ok {
		return nil
	}
	return []Entry{
		{Account: accounts[0], Currency: event.Currency, Amount: event.Amount},
		{Account: accounts[1], Currency: event.Currency, Amount: -event.Amount},
	}
}

// deadLetter parks the original record where a human can look at it; WriteMessages is synchronous, so it is durable before the commit.
func deadLetter(ctx context.Context, msg kafka.Message, reason string) error {
	return deadWriter.WriteMessages(ctx, kafka.Message{
		Key:     msg.Key,
		Value:   msg.Value,
		Headers: []kafka.Header{{Key: "reason", Value: []byte(reason)}},
	})
}

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		event, ok := parse(msg.Value)
		var entries []Entry
		if ok {
			entries = toEntries(event)
		}
		if entries == nil {
			reason := "malformed event"
			if ok {
				reason = "no mapping for event type " + event.Type
			}
			if err := deadLetter(ctx, msg, reason); err != nil {
				return err
			}
			if err := reader.CommitMessages(ctx, msg); err != nil {
				return err
			}
			continue
		}
		if _, err := writeTransaction(ctx, entries, event.Type, &event.EventID, event.OccurredAt, nil); err != nil {
			return err // not committed: the record comes back
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

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._
import scala.jdk.CollectionConverters._

final case class Entry(account: String, currency: String, amount: Long)
final case class Event(eventId: String, \`type\`: String, amount: Long, currency: String, occurredAt: Long)

object EventConsumer {
  val Topic = "money-events"
  val DeadTopic = "money-events.dead"

  /** Event type → (debit account, credit account): the amount is debited from the first, credited to the second. */
  val Mapping: Map[String, (String, String)] = Map(
    "payment.captured" -> ("cash:acquirer", "clearing:payments"),
    "payout.sent" -> ("clearing:payouts", "cash:bank"),
    "refund.issued" -> ("clearing:payments", "cash:acquirer"))

  /** Built in step 4 (LedgerWriter): insert-or-skip on the event id. */
  def writeTransaction(entries: Seq[Entry], description: String, eventId: Option[String], postedAt: Long, settles: Option[String]): Option[String] = ???

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "ledger")
  consumerProps.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** The event, or None when the value is not a well-formed event. */
  def parse(raw: String): Option[Event] =
    scala.util.Try {
      val f = raw.parseJson.asJsObject.fields
      Event(f("event_id").convertTo[String], f("type").convertTo[String], f("amount").convertTo[Long],
            f("currency").convertTo[String], f("occurred_at").convertTo[Long])
    }.toOption

  /** The two balanced entries for an event, or None when its type has no mapping. */
  def toEntries(event: Event): Option[Seq[Entry]] = {
    // TODO: Mapping.get(type) → Seq(Entry(debit, currency, +amount), Entry(credit, currency, -amount))
    None
  }

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        // TODO: parse + toEntries; None → send the original key/value to DeadTopic with a reason header, .get() it, commit(record)
        // TODO: writeTransaction(entries, event.type, Some(event.eventId), event.occurredAt, None), then commit(record)
      }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import spray.json._
import scala.jdk.CollectionConverters._

final case class Entry(account: String, currency: String, amount: Long)
final case class Event(eventId: String, \`type\`: String, amount: Long, currency: String, occurredAt: Long)

object EventConsumer {
  val Topic = "money-events"
  val DeadTopic = "money-events.dead"

  /** Event type → (debit account, credit account): the amount is debited from the first, credited to the second. */
  val Mapping: Map[String, (String, String)] = Map(
    "payment.captured" -> ("cash:acquirer", "clearing:payments"),
    "payout.sent" -> ("clearing:payouts", "cash:bank"),
    "refund.issued" -> ("clearing:payments", "cash:acquirer"))

  /** Built in step 4 (LedgerWriter): insert-or-skip on the event id. */
  def writeTransaction(entries: Seq[Entry], description: String, eventId: Option[String], postedAt: Long, settles: Option[String]): Option[String] = ???

  private val consumerProps = new Properties()
  consumerProps.put("bootstrap.servers", "kafka:9092")
  consumerProps.put("group.id", "ledger")
  consumerProps.put("auto.offset.reset", "earliest")
  consumerProps.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](consumerProps, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List(Topic).asJava)

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("acks", "all")
  producerProps.put("enable.idempotence", "true")
  private val producer = new KafkaProducer[String, String](producerProps, new StringSerializer, new StringSerializer)

  /** The event, or None when the value is not a well-formed event. */
  def parse(raw: String): Option[Event] =
    scala.util.Try {
      val f = raw.parseJson.asJsObject.fields
      Event(f("event_id").convertTo[String], f("type").convertTo[String], f("amount").convertTo[Long],
            f("currency").convertTo[String], f("occurred_at").convertTo[Long])
    }.toOption

  /** The two balanced entries for an event, or None when its type has no mapping. */
  def toEntries(event: Event): Option[Seq[Entry]] =
    Mapping.get(event.\`type\`).map { case (debit, credit) =>
      Seq(Entry(debit, event.currency, event.amount), Entry(credit, event.currency, -event.amount))
    }

  /** Parks the original record where a human can look at it; .get() blocks until the broker acknowledged it. */
  private def deadLetter(record: ConsumerRecord[String, String], reason: String): Unit = {
    val parked = new ProducerRecord[String, String](DeadTopic, record.key, record.value)
    parked.headers().add("reason", reason.getBytes("UTF-8"))
    producer.send(parked).get()
  }

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = parse(record.value)
        event.flatMap(toEntries) match {
          case None =>
            deadLetter(record, event.fold("malformed event")(e => s"no mapping for event type \${e.\`type\`}"))
            commit(record)
          case Some(entries) =>
            val e = event.get
            writeTransaction(entries, e.\`type\`, Some(e.eventId), e.occurredAt, None) // throws → not committed, the record comes back
            commit(record)
        }
      }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "money-events";
const std::string kDeadTopic = "money-events.dead";

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

struct Event {
  std::string event_id;
  std::string type;
  int64_t amount;
  std::string currency;
  int64_t occurred_at;
};

// Event type → {debit account, credit account}: the amount is debited from the first, credited to the second.
const std::map<std::string, std::pair<std::string, std::string>> kMapping = {
    {"payment.captured", {"cash:acquirer", "clearing:payments"}},
    {"payout.sent", {"clearing:payouts", "cash:bank"}},
    {"refund.issued", {"clearing:payments", "cash:acquirer"}},
};

// Built in step 4 (ledger_writer.cpp): insert-or-skip on the event id; nullopt when the event was already recorded.
std::optional<std::string> write_transaction(const std::vector<Entry>& entries, const std::string& description,
                                             std::optional<std::string> event_id, int64_t posted_at,
                                             std::optional<std::string> settles);

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "ledger", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

// The event, or nullopt when the value is not a well-formed event.
std::optional<Event> parse(const std::string& raw) {
  const json j = json::parse(raw, nullptr, false);
  if (!j.is_object()) return std::nullopt;
  for (const char* field : {"event_id", "type", "amount", "currency", "occurred_at"})
    if (!j.contains(field)) return std::nullopt;
  if (!j["amount"].is_number_integer() || !j["occurred_at"].is_number_integer()) return std::nullopt;
  return Event{j["event_id"].get<std::string>(), j["type"].get<std::string>(), j["amount"].get<int64_t>(),
               j["currency"].get<std::string>(), j["occurred_at"].get<int64_t>()};
}

// The two balanced entries for an event, or nullopt when its type has no mapping.
std::optional<std::vector<Entry>> to_entries(const Event& event) {
  // TODO: kMapping.find(type) → {debit, +amount}, {credit, -amount} in the event's currency
  return std::nullopt;
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    // TODO: parse + to_entries; nullopt → produce the original key/payload to kDeadTopic with a reason header, flush, commitSync, continue
    // TODO: write_transaction(entries, event.type, event.event_id, event.occurred_at, std::nullopt), then commitSync this message
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "money-events";
const std::string kDeadTopic = "money-events.dead";

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

struct Event {
  std::string event_id;
  std::string type;
  int64_t amount;
  std::string currency;
  int64_t occurred_at;
};

// Event type → {debit account, credit account}: the amount is debited from the first, credited to the second.
const std::map<std::string, std::pair<std::string, std::string>> kMapping = {
    {"payment.captured", {"cash:acquirer", "clearing:payments"}},
    {"payout.sent", {"clearing:payouts", "cash:bank"}},
    {"refund.issued", {"clearing:payments", "cash:acquirer"}},
};

// Built in step 4 (ledger_writer.cpp): insert-or-skip on the event id; nullopt when the event was already recorded.
std::optional<std::string> write_transaction(const std::vector<Entry>& entries, const std::string& description,
                                             std::optional<std::string> event_id, int64_t posted_at,
                                             std::optional<std::string> settles);

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "ledger", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  return consumer;
}

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto consumer = make_consumer();
auto producer = make_producer();

// The event, or nullopt when the value is not a well-formed event.
std::optional<Event> parse(const std::string& raw) {
  const json j = json::parse(raw, nullptr, false);
  if (!j.is_object()) return std::nullopt;
  for (const char* field : {"event_id", "type", "amount", "currency", "occurred_at"})
    if (!j.contains(field)) return std::nullopt;
  if (!j["amount"].is_number_integer() || !j["occurred_at"].is_number_integer()) return std::nullopt;
  return Event{j["event_id"].get<std::string>(), j["type"].get<std::string>(), j["amount"].get<int64_t>(),
               j["currency"].get<std::string>(), j["occurred_at"].get<int64_t>()};
}

// The two balanced entries for an event, or nullopt when its type has no mapping.
std::optional<std::vector<Entry>> to_entries(const Event& event) {
  const auto it = kMapping.find(event.type);
  if (it == kMapping.end()) return std::nullopt;
  const auto& [debit, credit] = it->second;
  return std::vector<Entry>{Entry{debit, event.currency, event.amount}, Entry{credit, event.currency, -event.amount}};
}

// Parks the original record where a human can look at it; flushed so a crash cannot lose it.
void dead_letter(const RdKafka::Message& msg, const std::string& reason) {
  RdKafka::Headers* headers = RdKafka::Headers::create();
  headers->add("reason", reason);
  const std::string payload(static_cast<const char*>(msg.payload()), msg.len());
  const std::string key = msg.key() ? *msg.key() : "";
  producer->produce(kDeadTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                    payload.size(), key.data(), key.size(), 0, headers, nullptr);
  producer->flush(5000);
}

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const auto event = parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    const auto entries = event ? to_entries(*event) : std::nullopt;
    if (!entries) {
      dead_letter(*msg, event ? "no mapping for event type " + event->type : "malformed event");
      consumer->commitSync(msg.get());
      continue;
    }
    write_transaction(*entries, event->type, event->event_id, event->occurred_at, std::nullopt);  // throws → not committed
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

SCHEMA = """
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
"""

T0 = 1700000000000
TOPIC = "money-events"
DEAD = "money-events.dead"


def _event(event_id, type="payment.captured", amount=4999, currency="EUR", occurred_at=T0):
    return {"event_id": event_id, "type": type, "amount": amount, "currency": currency, "occurred_at": occurred_at, "charge": "ch_" + event_id}


def _seed(ctx, *events):
    for event in events:
        if isinstance(event, dict):
            ctx.kafka.seed(TOPIC, key=event["event_id"], value=json.dumps(event))
        else:
            ctx.kafka.seed(TOPIC, key="raw", value=event)


async def _consumer(ctx):
    """The learner's consumer in front of the real journal writer (step 4) and an empty ledger database."""
    await ctx.db.reset(SCHEMA)
    return ctx.load("event_consumer")


async def _run(m):
    try:
        await m.run()
    except KeyboardInterrupt:
        pass


async def _journal(ctx):
    """{event_id: (transaction row, [(account, currency, amount, posted_at)])} as the database holds it."""
    transactions = await ctx.db.execute("SELECT * FROM transactions ORDER BY event_id")
    entries = await ctx.db.execute("SELECT * FROM entries ORDER BY account")
    return {t["event_id"]: (t, [(e["account"], e["currency"], e["amount"], e["posted_at"]) for e in entries if e["transaction_id"] == t["id"]]) for t in transactions}


def _dead(ctx):
    return ctx.kafka.records(DEAD)


def _watch_commits(ctx):
    """Every commit as the broker saw it, with the database's query log and the dead-letter topic at that instant."""
    seen = []
    ctx.kafka.on_commit(lambda group, offsets: seen.append((group, dict(offsets), list(ctx.db.queries), [r.value for r in _dead(ctx)])))
    return seen


def _write_committed(queries, event_id):
    """Whether the database had committed a write of event_id by the end of this query log."""
    insert = next((i for i, (sql, params) in enumerate(queries) if "insert into transactions" in sql.lower() and event_id in params), None)
    return insert is not None and any(sql.strip().upper() == "COMMIT" for sql, _ in queries[insert + 1:])


def _newly_committed(ctx, commits):
    """(record, query log, dead-letter values) for each record of money-events as its offset was first committed."""
    out = []
    done = {}
    for group, offsets, queries, dead in commits:
        if group != "ledger":
            continue
        for (topic, partition), offset in offsets.items():
            if topic != TOPIC:
                continue
            for record in ctx.kafka.records(TOPIC):
                if record.partition == partition and done.get(partition, 0) <= record.offset < offset:
                    out.append((record, queries, dead))
            done[partition] = max(done.get(partition, 0), offset)
    return out


def _fully_committed(ctx):
    lag = ctx.kafka.lag("ledger", TOPIC)
    assert lag == 0, f"{lag} record(s) of money-events are not committed for group ledger after the consumer handled them"


async def check_group_manual_commit(ctx):
    _seed(ctx, _event("e1"), _event("e2", amount=120), _event("e3", amount=7))
    m = await _consumer(ctx)
    commits = _watch_commits(ctx)
    await _run(m)
    journal = await _journal(ctx)
    assert sorted(journal) == ["e1", "e2", "e3"], f"the consumer must read money-events and write every event: the journal holds {sorted(journal)}"
    assert ctx.kafka.commits("ledger"), f"no offsets were committed for group ledger (groups that committed: {sorted({c[0] for c in commits})})"
    _fully_committed(ctx)
    for record, queries, _ in _newly_committed(ctx, commits):
        event_id = record.key.decode()
        assert _write_committed(queries, event_id), f"the offset of {event_id} was committed before its transaction was in the journal: offsets are committed by the consumer, after the write"
    # e4's write is slow (the transactions insert takes 6 s) and then fails on a constraint: while it is
    # in flight, a consumer that auto-commits acknowledges e4 on its timer — and e4 is lost.
    await ctx.db.execute("ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 7777) NOT VALID")
    slow = ctx.db_after("INSERT INTO transactions", lambda: ctx.clock.advance(6))
    _seed(ctx, _event("e4", amount=7777))
    try:
        await _run(m)
    except Exception:
        pass
    assert slow.fired, "e4 was never written: the consumer must keep reading money-events"
    lag = ctx.kafka.lag("ledger", TOPIC)
    assert lag == 1, f"e4's write took 6 s and then failed, yet group ledger's lag is {lag} instead of 1: e4 was acknowledged while it was still being written — with auto-commit on, the timer commits polled records; disable enable.auto.commit and commit after the write"
    await ctx.db.execute("ALTER TABLE entries DROP CONSTRAINT journal_down")
    restarted = ctx.load("event_consumer")
    await _run(restarted)
    journal = await _journal(ctx)
    assert "e4" in journal and len(journal["e4"][1]) == 2, f"after a restart e4 must be redelivered and written once, the journal holds {sorted(journal)}"
    _fully_committed(ctx)


async def check_mapping(ctx):
    _seed(ctx, _event("e1"), _event("e2", type="payout.sent", amount=120000, currency="USD", occurred_at=T0 + 5), _event("e3", type="refund.issued", amount=999, occurred_at=T0 + 9))
    m = await _consumer(ctx)
    await _run(m)
    journal = await _journal(ctx)
    assert sorted(journal) == ["e1", "e2", "e3"], f"three mapped events must become three transactions keyed by their event id, the journal holds {sorted(journal)}"
    expected = {
        "e1": ({("cash:acquirer", "EUR", 4999), ("clearing:payments", "EUR", -4999)}, "payment.captured", T0),
        "e2": ({("clearing:payouts", "USD", 120000), ("cash:bank", "USD", -120000)}, "payout.sent", T0 + 5),
        "e3": ({("clearing:payments", "EUR", 999), ("cash:acquirer", "EUR", -999)}, "refund.issued", T0 + 9),
    }
    for event_id, (transaction, entries) in journal.items():
        accounts, description, occurred_at = expected[event_id]
        got = {(a, c, amount) for a, c, amount, _ in entries}
        assert len(entries) == 2 and got == accounts, f"{event_id}: the journal holds the entries {sorted(got)} — expected {sorted(accounts)} (the first account debited, the second credited the negated amount, in the event's currency)"
        assert transaction["description"] == description, f"{event_id}: the transaction's description is {transaction['description']!r}, expected the event type"
        assert transaction["posted_at"] == occurred_at and all(at == occurred_at for *_, at in entries), f"{event_id}: posted at {transaction['posted_at']} / {[at for *_, at in entries]}, expected the event's occurred_at {occurred_at}"
    got = m.to_entries(_event("x", amount=250))
    assert got == [{"account": "cash:acquirer", "currency": "EUR", "amount": 250}, {"account": "clearing:payments", "currency": "EUR", "amount": -250}], f"to_entries of a 250 EUR payment.captured returned {got}"
    assert m.to_entries(_event("x", type="dispute.opened")) is None, "to_entries must return None for a type without a mapping"


async def check_dead_letter(ctx):
    unknown = _event("e2", type="dispute.opened")
    _seed(ctx, _event("e1"), unknown, "{not json", _event("e4"))
    m = await _consumer(ctx)
    # The dead-letter topic's leader is slow to acknowledge for the first 30 s of the run.
    ctx.kafka.stall(DEAD, seconds=30)
    commits = _watch_commits(ctx)
    await _run(m)
    journal = await _journal(ctx)
    assert sorted(journal) == ["e1", "e4"], f"only the mapped events are written, the journal holds {sorted(journal)}"
    for record, _, dead in _newly_committed(ctx, commits):
        if record.key.decode() in ("e2", "raw"):
            assert record.value in dead, f"the offset of {record.value.decode()!r} was committed while its dead-letter copy was not on money-events.dead yet: flush the producer before committing, or a crash in between loses the only copy"
    dead = _dead(ctx)
    assert len(dead) == 2, f"the unmapped event and the malformed record must both be parked on money-events.dead, found {len(dead)} record(s) there"
    values = [r.value for r in dead]
    assert json.dumps(unknown).encode() in values, "the unmapped event must be parked with its original value, unchanged"
    assert b"{not json" in values, "the malformed record must be parked with its original value, unchanged"
    parked = next(r for r in dead if r.value == json.dumps(unknown).encode())
    assert parked.key == b"e2", f"the parked record must keep the original key, got {parked.key!r}"
    for r in dead:
        assert any(name == "reason" and value for name, value in r.headers), f"every parked record must carry a 'reason' header, got headers {r.headers}"


async def check_continues_after_dead(ctx):
    _seed(ctx, _event("e1", type="dispute.opened"), _event("e2"), "{not json", _event("e4"), _event("e5", type="chargeback.won"))
    m = await _consumer(ctx)
    try:
        await _run(m)
    except Exception as exc:
        raise AssertionError(f"an event that cannot be mapped must not stop the consumer, but run() raised {type(exc).__name__}: {exc}")
    journal = await _journal(ctx)
    assert sorted(journal) == ["e2", "e4"], f"the events after a parked one must still be written, the journal holds {sorted(journal)}"
    assert len(_dead(ctx)) == 3, f"three records must be parked, money-events.dead holds {len(_dead(ctx))}"
    lag = ctx.kafka.lag("ledger", TOPIC)
    assert lag == 0, f"{lag} record(s) not committed: a parked record's offset must be committed too, or it is redelivered forever"


async def check_commit_after_write(ctx):
    _seed(ctx, _event("e1"), _event("e2", amount=120))
    m = await _consumer(ctx)
    commits = _watch_commits(ctx)
    await _run(m)
    committed = _newly_committed(ctx, commits)
    assert committed, "the offsets of e1 and e2 were never committed"
    for record, queries, _ in committed:
        event_id = record.key.decode()
        assert _write_committed(queries, event_id), f"the offset of {event_id} was committed before its transaction was committed in the journal: commit the offset only after write_transaction returned"
    # The journal starts refusing: an entry of 7777 now violates a constraint, so e3's write rolls back.
    await ctx.db.execute("ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 7777) NOT VALID")
    _seed(ctx, _event("e3", amount=7777))
    try:
        await _run(m)
    except Exception:
        pass
    assert "e3" not in await _journal(ctx), "e3's write failed in the database and must have left nothing in the journal"
    assert ctx.kafka.lag("ledger", TOPIC) == 1, "a record whose write failed must not be committed: it has to come back"
    assert _dead(ctx) == [], "a failed write is not a dead letter: the record is retried, not parked"
    await ctx.db.execute("ALTER TABLE entries DROP CONSTRAINT journal_down")
    restarted = ctx.load("event_consumer")
    await _run(restarted)
    journal = await _journal(ctx)
    assert sorted(journal) == ["e1", "e2", "e3"], f"after a restart the consumer must redeliver e3 and write it, the journal holds {sorted(journal)}"
    assert len(journal["e3"][1]) == 2, f"e3 must be written exactly once, the journal holds {len(journal['e3'][1])} entries for it"
    _fully_committed(ctx)
`,
    typescript: `const SCHEMA = \`
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
\`;

const T0 = 1700000000000;
const TOPIC = 'money-events';
const DEAD = 'money-events.dead';

interface EventOptions {
  type?: string;
  amount?: number;
  currency?: string;
  occurred_at?: number;
}

function event(eventId: string, {type = 'payment.captured', amount = 4999, currency = 'EUR', occurred_at = T0}: EventOptions = {}) {
  return {event_id: eventId, type, amount, currency, occurred_at, charge: 'ch_' + eventId};
}

function seed(ctx, ...events: (Record<string, unknown> | string)[]) {
  for (const e of events) {
    if (typeof e === 'string') ctx.kafka.seed(TOPIC, {key: 'raw', value: e});
    else ctx.kafka.seed(TOPIC, {key: e.event_id, value: JSON.stringify(e)});
  }
}

/** The learner's consumer in front of the real journal writer (step 4) and an empty ledger database. */
async function consumer(ctx) {
  await ctx.db.reset(SCHEMA);
  return ctx.load('event_consumer');
}

/** {event_id: {transaction, entries: [account, currency, amount, posted_at][]}} as the database holds it. */
async function journal(ctx) {
  const transactions = await ctx.db.execute('SELECT * FROM transactions ORDER BY event_id');
  const entries = await ctx.db.execute('SELECT * FROM entries ORDER BY account');
  const out: Record<string, {transaction; entries: [string, string, number, number][]}> = {};
  for (const t of transactions) {
    out[t.event_id] = {
      transaction: t,
      entries: entries.filter(e => e.transaction_id === t.id).map(e => [e.account, e.currency, Number(e.amount), Number(e.posted_at)]),
    };
  }
  return out;
}

const dead = (ctx) => ctx.kafka.records(DEAD);

interface CommitSeen {
  group: string;
  offsets: Map<string, number>;
  queries: [string, unknown[]][];
  dead: (Buffer | null)[];
}

/** Every commit as the broker saw it, with the database's query log and the dead-letter topic at that instant. */
function watchCommits(ctx): CommitSeen[] {
  const seen: CommitSeen[] = [];
  ctx.kafka.onCommit((group, offsets) =>
    seen.push({group, offsets: new Map(offsets), queries: [...ctx.db.queries], dead: dead(ctx).map(r => r.value)}),
  );
  return seen;
}

/** Whether the database had committed a write of eventId by the end of this query log. */
function writeCommitted(queries: [string, unknown[]][], eventId: string): boolean {
  const insert = queries.findIndex(([sql, params]) => sql.toLowerCase().includes('insert into transactions') && params.includes(eventId));
  return insert !== -1 && queries.slice(insert + 1).some(([sql]) => sql.trim().toUpperCase() === 'COMMIT');
}

/** [record, query log, dead-letter values] for each record of money-events as its offset was first committed. */
function newlyCommitted(ctx, commits: CommitSeen[]) {
  const out: {record; queries: [string, unknown[]][]; dead: (Buffer | null)[]}[] = [];
  const done: Record<number, number> = {};
  for (const {group, offsets, queries, dead: parked} of commits) {
    if (group !== 'ledger') continue;
    for (const [tp, offset] of offsets) {
      const [topic, partition] = tp.split('|');
      if (topic !== TOPIC) continue;
      const p = Number(partition);
      for (const record of ctx.kafka.records(TOPIC)) {
        if (record.partition === p && (done[p] ?? 0) <= record.offset && record.offset < offset) out.push({record, queries, dead: parked});
      }
      done[p] = Math.max(done[p] ?? 0, offset);
    }
  }
  return out;
}

function fullyCommitted(ctx) {
  const lag = ctx.kafka.lag('ledger', TOPIC);
  assert.equal(lag, 0, \`\${lag} record(s) of money-events are not committed for group ledger after the consumer handled them\`);
}

const text = (b: Buffer | null): string => (b === null ? '' : b.toString());

export async function check_group_manual_commit(ctx) {
  seed(ctx, event('e1'), event('e2', {amount: 120}), event('e3', {amount: 7}));
  const m = await consumer(ctx);
  const commits = watchCommits(ctx);
  await m.run();
  let j = await journal(ctx);
  assert.deepEqual(Object.keys(j).sort(), ['e1', 'e2', 'e3'], \`the consumer must read money-events and write every event: the journal holds \${JSON.stringify(Object.keys(j).sort())}\`);
  assert(ctx.kafka.commits('ledger').length > 0, \`no offsets were committed for group ledger (groups that committed: \${JSON.stringify([...new Set(commits.map(c => c.group))].sort())})\`);
  fullyCommitted(ctx);
  const members = ctx.kafka.consumers.filter(c => c.groupId === 'ledger');
  assert(members.length > 0, \`no consumer joined group ledger (groups seen: \${JSON.stringify(ctx.kafka.consumers.map(c => c.groupId))})\`);
  assert(members.every(c => !c.autoCommit), 'the consumer runs with auto-commit on: the broker acknowledges on a timer, before the write — set autoCommit: false and commit after writeTransaction returned');
  for (const {record, queries} of newlyCommitted(ctx, commits)) {
    const eventId = text(record.key);
    assert(writeCommitted(queries, eventId), \`the offset of \${eventId} was committed before its transaction was in the journal: offsets are committed by the consumer, after the write\`);
  }
  // e4's write is slow (the transactions insert takes 6 s) and then fails on a constraint: a consumer
  // that acknowledges before the write has returned loses e4.
  await ctx.db.execute('ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 7777) NOT VALID');
  let slow = false;
  ctx.dbAfter('INSERT INTO transactions', () => {
    slow = true;
    ctx.clock.advance(6);
  });
  seed(ctx, event('e4', {amount: 7777}));
  try {
    await m.run();
  } catch {
    // the failed write surfaces here; what matters is what was committed
  }
  assert(slow, 'e4 was never written: the consumer must keep reading money-events');
  const lag = ctx.kafka.lag('ledger', TOPIC);
  assert.equal(lag, 1, \`e4's write took 6 s and then failed, yet group ledger's lag is \${lag} instead of 1: e4 was acknowledged although its write never landed — disable autoCommit and commit the offset yourself, after the write\`);
  await ctx.db.execute('ALTER TABLE entries DROP CONSTRAINT journal_down');
  const restarted = ctx.load('event_consumer');
  await restarted.run();
  j = await journal(ctx);
  assert('e4' in j && j.e4.entries.length === 2, \`after a restart e4 must be redelivered and written once, the journal holds \${JSON.stringify(Object.keys(j).sort())}\`);
  fullyCommitted(ctx);
}

export async function check_mapping(ctx) {
  seed(
    ctx,
    event('e1'),
    event('e2', {type: 'payout.sent', amount: 120000, currency: 'USD', occurred_at: T0 + 5}),
    event('e3', {type: 'refund.issued', amount: 999, occurred_at: T0 + 9}),
  );
  const m = await consumer(ctx);
  await m.run();
  const j = await journal(ctx);
  assert.deepEqual(Object.keys(j).sort(), ['e1', 'e2', 'e3'], \`three mapped events must become three transactions keyed by their event id, the journal holds \${JSON.stringify(Object.keys(j).sort())}\`);
  const expected: Record<string, [[string, string, number][], string, number]> = {
    e1: [[['cash:acquirer', 'EUR', 4999], ['clearing:payments', 'EUR', -4999]], 'payment.captured', T0],
    e2: [[['clearing:payouts', 'USD', 120000], ['cash:bank', 'USD', -120000]], 'payout.sent', T0 + 5],
    e3: [[['clearing:payments', 'EUR', 999], ['cash:acquirer', 'EUR', -999]], 'refund.issued', T0 + 9],
  };
  for (const [eventId, {transaction, entries}] of Object.entries(j)) {
    const [accounts, description, occurredAt] = expected[eventId];
    const got = entries.map(([a, c, amount]) => [a, c, amount]).sort();
    assert(entries.length === 2 && JSON.stringify(got) === JSON.stringify([...accounts].sort()), \`\${eventId}: the journal holds the entries \${JSON.stringify(got)} — expected \${JSON.stringify([...accounts].sort())} (the first account debited, the second credited the negated amount, in the event's currency)\`);
    assert.equal(transaction.description, description, \`\${eventId}: the transaction's description is \${JSON.stringify(transaction.description)}, expected the event type\`);
    assert(Number(transaction.posted_at) === occurredAt && entries.every(([, , , at]) => at === occurredAt), \`\${eventId}: posted at \${transaction.posted_at} / \${JSON.stringify(entries.map(([, , , at]) => at))}, expected the event's occurred_at \${occurredAt}\`);
  }
  const got = m.toEntries(event('x', {amount: 250}));
  assert.deepEqual(got, [{account: 'cash:acquirer', currency: 'EUR', amount: 250}, {account: 'clearing:payments', currency: 'EUR', amount: -250}], \`toEntries of a 250 EUR payment.captured returned \${JSON.stringify(got)}\`);
  assert.equal(m.toEntries(event('x', {type: 'dispute.opened'})), null, 'toEntries must return null for a type without a mapping');
}

export async function check_dead_letter(ctx) {
  const unknown = event('e2', {type: 'dispute.opened'});
  seed(ctx, event('e1'), unknown, '{not json', event('e4'));
  const m = await consumer(ctx);
  // The dead-letter topic's leader is slow to acknowledge for the first 30 s of the run.
  ctx.kafka.stall(DEAD, 30);
  const commits = watchCommits(ctx);
  await m.run();
  const j = await journal(ctx);
  assert.deepEqual(Object.keys(j).sort(), ['e1', 'e4'], \`only the mapped events are written, the journal holds \${JSON.stringify(Object.keys(j).sort())}\`);
  for (const {record, dead: parked} of newlyCommitted(ctx, commits)) {
    if (['e2', 'raw'].includes(text(record.key))) {
      assert(parked.some(v => text(v) === text(record.value)), \`the offset of \${JSON.stringify(text(record.value))} was committed while its dead-letter copy was not on money-events.dead yet: wait for the broker's acknowledgement before committing, or a crash in between loses the only copy\`);
    }
  }
  const parked = dead(ctx);
  assert.equal(parked.length, 2, \`the unmapped event and the malformed record must both be parked on money-events.dead, found \${parked.length} record(s) there\`);
  const values = parked.map(r => text(r.value));
  assert(values.includes(JSON.stringify(unknown)), 'the unmapped event must be parked with its original value, unchanged');
  assert(values.includes('{not json'), 'the malformed record must be parked with its original value, unchanged');
  const unmapped = parked.find(r => text(r.value) === JSON.stringify(unknown));
  assert.equal(text(unmapped.key), 'e2', \`the parked record must keep the original key, got \${JSON.stringify(text(unmapped.key))}\`);
  for (const r of parked) {
    assert(text(r.headers['reason'] ?? null) !== '', \`every parked record must carry a 'reason' header, got headers \${JSON.stringify(Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, text(v)])))}\`);
  }
}

export async function check_continues_after_dead(ctx) {
  seed(ctx, event('e1', {type: 'dispute.opened'}), event('e2'), '{not json', event('e4'), event('e5', {type: 'chargeback.won'}));
  const m = await consumer(ctx);
  try {
    await m.run();
  } catch (e) {
    assert.fail(\`an event that cannot be mapped must not stop the consumer, but run() rejected with \${e instanceof Error ? e.name : typeof e}: \${e instanceof Error ? e.message : String(e)}\`);
  }
  const j = await journal(ctx);
  assert.deepEqual(Object.keys(j).sort(), ['e2', 'e4'], \`the events after a parked one must still be written, the journal holds \${JSON.stringify(Object.keys(j).sort())}\`);
  assert.equal(dead(ctx).length, 3, \`three records must be parked, money-events.dead holds \${dead(ctx).length}\`);
  const lag = ctx.kafka.lag('ledger', TOPIC);
  assert.equal(lag, 0, \`\${lag} record(s) not committed: a parked record's offset must be committed too, or it is redelivered forever\`);
}

export async function check_commit_after_write(ctx) {
  seed(ctx, event('e1'), event('e2', {amount: 120}));
  const m = await consumer(ctx);
  const commits = watchCommits(ctx);
  await m.run();
  const committed = newlyCommitted(ctx, commits);
  assert(committed.length > 0, 'the offsets of e1 and e2 were never committed');
  for (const {record, queries} of committed) {
    const eventId = text(record.key);
    assert(writeCommitted(queries, eventId), \`the offset of \${eventId} was committed before its transaction was committed in the journal: commit the offset only after writeTransaction returned\`);
  }
  // The journal starts refusing: an entry of 7777 now violates a constraint, so e3's write rolls back.
  await ctx.db.execute('ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 7777) NOT VALID');
  seed(ctx, event('e3', {amount: 7777}));
  try {
    await m.run();
  } catch {
    // the failed write surfaces here; what matters is what was committed
  }
  assert(!('e3' in (await journal(ctx))), "e3's write failed in the database and must have left nothing in the journal");
  assert.equal(ctx.kafka.lag('ledger', TOPIC), 1, 'a record whose write failed must not be committed: it has to come back');
  assert.deepEqual(dead(ctx), [], 'a failed write is not a dead letter: the record is retried, not parked');
  await ctx.db.execute('ALTER TABLE entries DROP CONSTRAINT journal_down');
  const restarted = ctx.load('event_consumer');
  await restarted.run();
  const j = await journal(ctx);
  assert.deepEqual(Object.keys(j).sort(), ['e1', 'e2', 'e3'], \`after a restart the consumer must redeliver e3 and write it, the journal holds \${JSON.stringify(Object.keys(j).sort())}\`);
  assert.equal(j.e3.entries.length, 2, \`e3 must be written exactly once, the journal holds \${j.e3.entries.length} entries for it\`);
  fullyCommitted(ctx);
}
`,
  },
  debrief: `The mapping table is the course's stand-in for Stripe's fund flows: a declaration of which accounts an event moves money between, kept out of the consumer's code so adding a producer is a data change. The consumer's job is then only ordering and failure handling — write, then commit, so a crash replays rather than loses — and the dead-letter topic separates "I do not understand this" from "this failed": the first is parked and committed so the partition keeps flowing, the second is retried. Real ingestion pipelines version the mappings, carry the mapping version on each transaction so a bad mapping can be found and reversed, and alert on the dead-letter topic's growth rate rather than on every record.`,
};
