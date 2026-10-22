import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Session events: keyed by user, hashed tokens, committed first',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes a \`session.event\` for every
session change so audit and analytics can consume it. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`emit_session_event\` against the \`session.event\` topic.

- **Key by user.** The event's partition key is the \`user_id\`, so one user's session history stays ordered.
  Keying by session id scatters one user's events across partitions and destroys that ordering.
- **Hash the token.** The payload carries \`token_hash\`, \`device_class\`, \`session_id\` and \`rotation\` — never the
  raw token. A token in a retained, replicated topic is a credential leak with a long memory.
- **Commit before you announce.** The session record is committed **before** the event is produced, so a consumer
  never sees a session the store does not have. Use \`store.commit(id)\` then \`producer.produce(...)\`.
- **Outbox on failure.** If the broker rejects the produce, write an \`outbox\` row so the event can be replayed
  after the broker recovers instead of being lost.
- **Idempotent producer.** The producer runs with \`enable.idempotence\` and \`acks\` set so a retry cannot publish
  the same event twice.

**Failure mode the checks target.** Keying by session id means two events for one user can land in different
partitions and be consumed out of order. Publishing the raw token turns the topic into a credential store. And
producing before committing the record — or dropping the event when the broker rejects it — means the topic and
the store disagree, which is the bug audit teams spend a week chasing.`,
  sequence: {
    participants: ['Session API', 'Session Store', 'session.event', 'Session consumer'],
    messages: [
      {from: 'Session API', to: 'Session Store', label: 'commit session record', kind: 'sync'},
      {from: 'Session Store', to: 'Session API', label: 'committed', kind: 'reply'},
      {from: 'Session API', to: 'session.event', label: 'produce · key = user_id · token_hash', kind: 'sync'},
      {from: 'session.event', to: 'Session consumer', label: 'consume', kind: 'async'},
      {from: 'Session API', to: 'Session Store', label: 'outbox row on broker reject', kind: 'async'},
      {from: 'Session API', to: 'Session Store', label: 'commit offset after the record', kind: 'reply'},
    ],
  },
  hints: [
    'What has to be true before a consumer sees the event? The draft announces the session before the store has it.',
    'The topic is retained and replicated. Which field in the payload would you never want a future reader to have?',
    'A produce can fail. Where does the event go so it is not lost, and what makes the retry safe to publish twice?',
  ],
  checks: [
    {
      id: 'user-key',
      title: 'Keys the event by user id',
      detail:
        'The record key is the `user_id`, so one user’s events share a partition and keep their order. The draft keys by `session_id`, so a user’s history scatters.',
      match: {
        python: {all: [/key\s*=\s*user_id/]},
        typescript: {all: [/key\s*:\s*userId/]},
        go: {all: [/Key:\s*\[\]byte\(userID\)/]},
        scala: {all: [/ProducerRecord[^\n]*userId/]},
        cpp: {all: [/producer\.produce\(/, /user_id\.c_str\(\)/]},
      },
    },
    {
      id: 'hashed-token',
      title: 'Publishes a token hash and the device class',
      detail:
        'The payload carries `token_hash` and `device_class`, so the event is useful without carrying the credential. The draft publishes the raw `token`.',
      match: {
        python: {all: [/token_hash/, /device_class/]},
        typescript: {all: [/token_hash/, /device_class/]},
        go: {all: [/TokenHash/, /DeviceClass/]},
        scala: {all: [/tokenHash/, /deviceClass/]},
        cpp: {all: [/token_hash/, /device_class/]},
      },
    },
    {
      id: 'record-first',
      title: 'Commits the session record before producing the event',
      detail:
        'The record commit happens before the produce in the source, so a consumer cannot observe a session the store has not committed. The draft produces first.',
      match: {
        python: {order: [/store\.commit\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.commit\(/, /producer\.send\(/]},
        go: {order: [/store\.Commit\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/store\.commit\(/, /producer\.send\(/]},
        cpp: {order: [/store\.commit\(/, /producer\.produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A failed produce lands in the `outbox` so the event can be replayed later. The draft lets the produce failure disappear.',
      match: {
        python: {all: [/outbox\.add\(/]},
        typescript: {all: [/outbox\.add\(/]},
        go: {all: [/outbox\.Add\(/]},
        scala: {all: [/outbox\.add\(/]},
        cpp: {all: [/outbox\.add\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Runs an idempotent producer with acks',
      detail:
        'The producer enables `enable.idempotence` and sets `acks` so a retry cannot duplicate the event. The draft uses default producer settings.',
      match: {
        python: {all: [/enable\.idempotence/, /acks/]},
        typescript: {all: [/idempotent\s*:\s*true/]},
        go: {all: [/kafka\.RequireAll/, /Writer\{/]},
        scala: {all: [/enable\.idempotence/, /acks/]},
        cpp: {all: [/enable\.idempotence/, /acks/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})


def emit_session_event(session_id: str, user_id: str, device_class: str, token: str, rotation: int) -> None:
    # TODO: the event is produced before the record is committed and it carries the raw token; it is
    # also keyed by session id, so one user's events scatter across partitions.
    payload = json.dumps(
        {
            "session_id": session_id,
            "device_class": device_class,
            "token": token,
            "rotation": rotation,
        }
    )
    logger.info("session %s changed for token %s", session_id, token)
    producer.produce("session.event", key=session_id, value=payload)
    store.commit(session_id)
`,
      solution: `import hashlib
import json

from confluent_kafka import Producer

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


def emit_session_event(session_id: str, user_id: str, device_class: str, token: str, rotation: int) -> None:
    payload = json.dumps(
        {
            "session_id": session_id,
            "user_id": user_id,
            "device_class": device_class,
            "token_hash": hashlib.sha256(token.encode()).hexdigest(),
            "rotation": rotation,
        }
    )
    # The record is committed first; the event is a notification, not the source of truth.
    store.commit(session_id)
    try:
        producer.produce("session.event", key=user_id, value=payload)
    except BufferError:
        outbox.add(session_id, payload)
`,
    },
    typescript: {
      starter: `import {createHash} from 'crypto';
import {Kafka} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();

export async function emitSessionEvent(
  sessionId: string,
  userId: string,
  deviceClass: string,
  token: string,
  rotation: number,
): Promise<void> {
  // TODO: the event is produced before the record is committed and it carries the raw token; it is
  // also keyed by session id, so one user's events scatter across partitions.
  const payload = JSON.stringify({
    session_id: sessionId,
    device_class: deviceClass,
    token: token,
    rotation,
  });
  logger.info(\`session \${sessionId} changed for token \${token}\`);
  await producer.send({topic: 'session.event', messages: [{key: sessionId, value: payload}]});
  await store.commit(sessionId);
}
`,
      solution: `import {createHash} from 'crypto';
import {Kafka} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});

export async function emitSessionEvent(
  sessionId: string,
  userId: string,
  deviceClass: string,
  token: string,
  rotation: number,
): Promise<void> {
  const payload = JSON.stringify({
    session_id: sessionId,
    user_id: userId,
    device_class: deviceClass,
    token_hash: createHash('sha256').update(token).digest('hex'),
    rotation,
  });
  // The record is committed first; the event is a notification, not the source of truth.
  await store.commit(sessionId);
  try {
    await producer.send({topic: 'session.event', messages: [{key: userId, value: payload}]});
  } catch {
    await outbox.add(sessionId, payload);
  }
}
`,
    },
    go: {
      starter: `package session

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "session.event"}

type SessionEvent struct {
	SessionID   string \`json:"session_id"\`
	DeviceClass string \`json:"device_class"\`
	Token       string \`json:"token"\`
	Rotation    int    \`json:"rotation"\`
}

func EmitSessionEvent(ctx context.Context, sessionID, userID, deviceClass, token string, rotation int) error {
	// TODO: the event is produced before the record is committed and it carries the raw token; it is
	// also keyed by session id, so one user's events scatter across partitions.
	payload, err := json.Marshal(SessionEvent{SessionID: sessionID, DeviceClass: deviceClass, Token: token, Rotation: rotation})
	if err != nil {
		return err
	}
	log.Printf("session %s changed for token %s", sessionID, token)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(sessionID), Value: payload}); err != nil {
		return err
	}
	return store.Commit(ctx, sessionID)
}
`,
      solution: `package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "session.event",
	RequiredAcks: kafka.RequireAll,
	Async:        false,
}

type SessionEvent struct {
	SessionID   string \`json:"session_id"\`
	UserID      string \`json:"user_id"\`
	DeviceClass string \`json:"device_class"\`
	TokenHash   string \`json:"token_hash"\`
	Rotation    int    \`json:"rotation"\`
}

func EmitSessionEvent(ctx context.Context, sessionID, userID, deviceClass, token string, rotation int) error {
	sum := sha256.Sum256([]byte(token))
	payload, err := json.Marshal(SessionEvent{
		SessionID:   sessionID,
		UserID:      userID,
		DeviceClass: deviceClass,
		TokenHash:   hex.EncodeToString(sum[:]),
		Rotation:    rotation,
	})
	if err != nil {
		return err
	}
	// The record is committed first; the event is a notification, not the source of truth.
	if err := store.Commit(ctx, sessionID); err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(userID), Value: payload}); err != nil {
		return outbox.Add(ctx, sessionID, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `package session

import java.util.Properties
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import io.circe.syntax._
import io.circe.generic.auto._

object SessionEvents {
  val props: Properties = {
    val p = new Properties()
    p.put("bootstrap.servers", "kafka:9092")
    p
  }
  val producer = new KafkaProducer[String, String](props)

  case class SessionEvent(sessionId: String, deviceClass: String, token: String, rotation: Int)

  // TODO: the event is produced before the record is committed and it carries the raw token; it is
  // also keyed by session id, so one user's events scatter across partitions.
  def emitSessionEvent(sessionId: String, userId: String, deviceClass: String, token: String, rotation: Int): Unit = {
    val payload = SessionEvent(sessionId, deviceClass, token, rotation).asJson.noSpaces
    logger.info(s"session $sessionId changed for token $token")
    producer.send(new ProducerRecord[String, String]("session.event", sessionId, payload))
    store.commit(sessionId)
  }
}
`,
      solution: `package session

import java.security.MessageDigest
import java.util.Properties
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import io.circe.syntax._
import io.circe.generic.auto._

object SessionEvents {
  val props: Properties = {
    val p = new Properties()
    p.put("bootstrap.servers", "kafka:9092")
    p.put("enable.idempotence", "true")
    p.put("acks", "all")
    p
  }
  val producer = new KafkaProducer[String, String](props)

  case class SessionEvent(
      sessionId: String,
      userId: String,
      deviceClass: String,
      tokenHash: String,
      rotation: Int,
  )

  def emitSessionEvent(sessionId: String, userId: String, deviceClass: String, token: String, rotation: Int): Unit = {
    val digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes("UTF-8"))
    val hash = digest.map("%02x".format(_)).mkString
    val payload = SessionEvent(sessionId, userId, deviceClass, hash, rotation).asJson.noSpaces
    // The record is committed first; the event is a notification, not the source of truth.
    store.commit(sessionId)
    try {
      producer.send(new ProducerRecord[String, String]("session.event", userId, payload))
    } catch {
      case _: Exception => outbox.add(sessionId, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <string>

#include <nlohmann/json.hpp>
#include <librdkafka/rdkafkacpp.h>

using json = nlohmann::json;

namespace session {

// TODO: the event is produced before the record is committed and it carries the raw token; it is
// also keyed by session id, so one user's events scatter across partitions.
void emit_session_event(RdKafka::Producer& producer, const std::string& session_id, const std::string& user_id,
                        const std::string& device_class, const std::string& token, int rotation) {
  const json payload = {
      {"session_id", session_id},
      {"device_class", device_class},
      {"token", token},
      {"rotation", rotation},
  };
  const std::string value = payload.dump();
  producer.produce("session.event", RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.c_str()), value.size(),
                   session_id.c_str(), session_id.size(), 0, nullptr);
  store.commit(session_id);
}

}  // namespace session
`,
      solution: `#include <string>

#include <nlohmann/json.hpp>
#include <librdkafka/rdkafkacpp.h>

using json = nlohmann::json;

namespace session {

std::string sha256_hex(const std::string& input);

RdKafka::Producer* create_producer() {
  std::string errstr;
  RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  return RdKafka::Producer::create(conf, errstr);
}

void emit_session_event(RdKafka::Producer& producer, const std::string& session_id, const std::string& user_id,
                        const std::string& device_class, const std::string& token, int rotation) {
  const json payload = {
      {"session_id", session_id},
      {"user_id", user_id},
      {"device_class", device_class},
      {"token_hash", sha256_hex(token)},
      {"rotation", rotation},
  };
  const std::string value = payload.dump();
  // The record is committed first; the event is a notification, not the source of truth.
  store.commit(session_id);
  const auto err = producer.produce("session.event", RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.c_str()),
                                    value.size(), user_id.c_str(), user_id.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox.add(session_id, value);
  }
}

}  // namespace session
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated event path for ordering, secrecy and durability. Three defects are being checked: keying by session id instead of user id scatters one user's history and breaks per-user ordering; publishing the raw token puts a credential in a retained, replicated topic; and producing before the record commit — or dropping a rejected produce — leaves the topic and the store disagreeing. The habits to name out loud are: choose the partition key by what needs to stay ordered, keep credentials out of any topic or log line, make the store the source of truth before you announce a change, and give a failed produce a durable home. Real systems add an outbox relay with its own retry and dedupe, a schema registry so a future producer cannot smuggle content in, and a consumer that updates counters before committing its offset.`,
};
