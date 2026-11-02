import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Delivery events keyed by recipient for lifecycle order',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'store'],
  task: `## Task

**Starting point.** The starter's \`publish(event_type, campaign_key, message_id, recipient)\`
produces one record to \`email.event\` keyed by the campaign id, with the raw address in the value
as \`recipient_email\`. \`handle_send\` publishes \`accepted\` and then calls \`relay.send\`. It
compiles and hides five flaws.

**Failure mode the checks target.** One recipient's events spread across partitions, so a consumer
can see \`bounced\` before the \`accepted\` it follows; a message the relay rejects a moment later has
already been reported as accepted; every consumer and third-party sink receives the plain address;
and the topic holds a single event type, so it cannot serve as a lifecycle record.

Requirements:

- Add \`def recipient_hash(recipient)\` returning \`sha256(recipient)\` and produce with
  \`key=recipient_key\`; no campaign key anywhere in the module.
- \`handle_send\` calls \`relay.send\` first and \`publish("accepted", ...)\` only after it returns.
- The value carries \`message_id\` and \`category\` plus the recipient only as
  \`recipient_hash(...)\`; the \`recipient_email\` field goes away.
- The module produces all four types: \`"queued"\`, \`"accepted"\`, \`"bounced"\` and
  \`"complained"\`.`,
  sequence: {
    participants: ['Email API', 'Relay', 'Kafka', 'Event consumer'],
    messages: [
      {from: 'Email API', to: 'Kafka', label: 'produce email.event · key = sha256(recipient) · queued', kind: 'async'},
      {from: 'Email API', to: 'Relay', label: 'send(recipient, message_id)', kind: 'sync'},
      {from: 'Relay', to: 'Email API', label: 'Accepted{message_id} / Bounce{category}', kind: 'reply'},
      {from: 'Email API', to: 'Kafka', label: 'produce accepted only after acceptance', kind: 'async'},
      {from: 'Kafka', to: 'Event consumer', label: 'consume email.event key = sha256(recipient)', kind: 'async'},
      {from: 'Event consumer', to: 'Kafka', label: 'commit offset after processing', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'recipient-key',
      title: 'Keys every event by the recipient hash',
      detail:
        'The record key is `sha256(recipient)`, so a recipient’s events share a partition. The starter keys by campaign.',
      match: {
        python: {all: [/def recipient_hash\(/, /key=recipient_key/], none: [/campaign/i]},
        typescript: {all: [/recipientHash\(/, /key:\s*recipientKey/], none: [/campaign/i]},
        go: {all: [/RecipientHash\(/, /\[\]byte\(recipientKey\)/], none: [/campaign/i]},
        scala: {all: [/recipientHash\(/, /key\s*=\s*recipientKey/], none: [/campaign/i]},
        cpp: {all: [/recipientHash\(/, /recipient_key/], none: [/campaign/i]},
      },
    },
    {
      id: 'publish-after-accept',
      title: 'Publishes accepted only after the relay confirms',
      detail:
        'The `accepted` event is produced after the relay returns acceptance. The starter produces it while the message is still queued.',
      match: {
        python: {order: [/relay\.send\(/, /publish\(/]},
        typescript: {order: [/relay\.send\(/, /publish\(/]},
        go: {order: [/relay\.Send\(/, /Publish\(/]},
        scala: {order: [/relay\.send\(/, /publish\(/]},
        cpp: {order: [/relay\.send\(/, /publish\(/]},
      },
    },
    {
      id: 'hashed-payload',
      title: 'Payload carries the recipient hash, never the raw address',
      detail:
        'The payload carries the recipient as a hash and the message id; the raw address never reaches the topic. The starter writes the address into the payload.',
      match: {
        python: {all: [/recipient_hash\(/, /message_id/], none: [/recipient_email/]},
        typescript: {all: [/recipientHash\(/, /message_id/], none: [/recipient_email/]},
        go: {all: [/RecipientHash\(/, /message_id|MessageID/], none: [/recipient_email/]},
        scala: {all: [/recipientHash\(/, /messageId/], none: [/recipient_email/]},
        cpp: {all: [/recipientHash\(/, /message_id/], none: [/recipient_email/]},
      },
    },
    {
      id: 'lifecycle-events',
      title: 'Produces the whole lifecycle: queued, accepted, bounced, complained',
      detail:
        'All four event types are produced so the topic is a real lifecycle. The starter only produces `accepted`.',
      match: {
        python: {all: [/["']queued["']/, /["']accepted["']/, /["']bounced["']/, /["']complained["']/]},
        typescript: {all: [/["']queued["']/, /["']accepted["']/, /["']bounced["']/, /["']complained["']/]},
        go: {all: [/"queued"/, /"accepted"/, /"bounced"/, /"complained"/]},
        scala: {all: [/["']queued["']/, /["']accepted["']/, /["']bounced["']/, /["']complained["']/]},
        cpp: {all: [/"queued"/, /"accepted"/, /"bounced"/, /"complained"/]},
      },
    },
    {
      id: 'payload-fields',
      title: 'Payload carries the message id and the bounce category',
      detail:
        'The payload includes `message_id` and `category`, so a consumer can correlate and classify without the address. The starter omits the category.',
      match: {
        python: {all: [/message_id/, /category/]},
        typescript: {all: [/message_id|messageId/, /category/]},
        go: {all: [/message_id|MessageID/, /category|Category/]},
        scala: {all: [/messageId/, /category/]},
        cpp: {all: [/message_id/, /category/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

TOPIC = "email.event"


def publish(event_type: str, campaign_key: str, message_id: str, recipient: str) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    producer.send(
        TOPIC,
        key=campaign_key,
        value=json.dumps({"event_type": event_type, "recipient_email": recipient, "message_id": message_id}),
    )


def handle_send(recipient: str, message_id: str, campaign_id: str) -> None:
    publish("accepted", campaign_id, message_id, recipient)
    relay.send(recipient, message_id)
`,
      solution: `import hashlib
import json

TOPIC = "email.event"


def recipient_hash(recipient: str) -> str:
    """Stable, non-reversible key so the topic never carries an address."""
    return hashlib.sha256(recipient.encode()).hexdigest()


def publish(event_type: str, recipient_key: str, message_id: str, category: str = "") -> None:
    """Produce to email.event, keyed by the recipient hash."""
    producer.send(
        TOPIC,
        key=recipient_key,
        value=json.dumps({"event_type": event_type, "message_id": message_id, "category": category}),
    )


def handle_send(recipient: str, message_id: str) -> None:
    recipient_key = recipient_hash(recipient)
    publish("queued", recipient_key, message_id)
    outcome = relay.send(recipient, message_id)
    if outcome.accepted:
        publish("accepted", recipient_key, message_id)
    elif outcome.bounced:
        publish("bounced", recipient_key, message_id, outcome.category)


def handle_complaint(recipient: str, message_id: str) -> None:
    publish("complained", recipient_hash(recipient), message_id, "COMPLAINT")
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import {producer} from './kafka';

const TOPIC = 'email.event';

export async function publish(
  eventType: string,
  campaignKey: string,
  messageId: string,
  recipient: string,
): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  await producer.send({
    topic: TOPIC,
    messages: [
      {
        key: campaignKey,
        value: JSON.stringify({event_type: eventType, recipient_email: recipient, message_id: messageId}),
      },
    ],
  });
}

export async function handleSend(recipient: string, messageId: string, campaignId: string): Promise<void> {
  await publish('accepted', campaignId, messageId, recipient);
  await relay.send(recipient, messageId);
}
`,
      solution: `import {createHash} from 'node:crypto';

import {producer} from './kafka';

const TOPIC = 'email.event';

function recipientHash(recipient: string): string {
  return createHash('sha256').update(recipient).digest('hex');
}

export async function publish(
  eventType: string,
  recipientKey: string,
  messageId: string,
  category = '',
): Promise<void> {
  await producer.send({
    topic: TOPIC,
    messages: [
      {
        key: recipientKey,
        value: JSON.stringify({event_type: eventType, message_id: messageId, category}),
      },
    ],
  });
}

export async function handleSend(recipient: string, messageId: string): Promise<void> {
  const recipientKey = recipientHash(recipient);
  await publish('queued', recipientKey, messageId);
  const outcome = await relay.send(recipient, messageId);
  if (outcome.accepted) {
    await publish('accepted', recipientKey, messageId);
  } else if (outcome.bounced) {
    await publish('bounced', recipientKey, messageId, outcome.category);
  }
}

export async function handleComplaint(recipient: string, messageId: string): Promise<void> {
  await publish('complained', recipientHash(recipient), messageId, 'COMPLAINT');
}
`,
    },
    go: {
      starter: `package events

import (
	"context"
	"encoding/json"
)

const Topic = "email.event"

type Producer interface {
	Produce(ctx context.Context, topic string, key []byte, value []byte) error
}

func Publish(ctx context.Context, producer Producer, eventType, campaignKey, messageID, recipient string) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]string{
		"event_type":      eventType,
		"recipient_email": recipient,
		"message_id":      messageID,
	})
	return producer.Produce(ctx, Topic, []byte(campaignKey), payload)
}

func HandleSend(ctx context.Context, producer Producer, relay Relay, recipient, messageID, campaignID string) error {
	if err := Publish(ctx, producer, "accepted", campaignID, messageID, recipient); err != nil {
		return err
	}
	_, err := relay.Send(ctx, recipient, messageID)
	return err
}
`,
      solution: `package events

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const Topic = "email.event"

type Producer interface {
	Produce(ctx context.Context, topic string, key []byte, value []byte) error
}

func RecipientHash(recipient string) string {
	sum := sha256.Sum256([]byte(recipient))
	return hex.EncodeToString(sum[:])
}

func Publish(ctx context.Context, producer Producer, eventType, recipientKey, messageID, category string) error {
	payload, _ := json.Marshal(map[string]string{
		"event_type": eventType,
		"message_id": messageID,
		"category":   category,
	})
	return producer.Produce(ctx, Topic, []byte(recipientKey), payload)
}

func HandleSend(ctx context.Context, producer Producer, relay Relay, recipient, messageID string) error {
	recipientKey := RecipientHash(recipient)
	if err := Publish(ctx, producer, "queued", recipientKey, messageID, ""); err != nil {
		return err
	}
	outcome, err := relay.Send(ctx, recipient, messageID)
	if err != nil {
		return err
	}
	if outcome.Accepted {
		return Publish(ctx, producer, "accepted", recipientKey, messageID, "")
	}
	if outcome.Bounced {
		return Publish(ctx, producer, "bounced", recipientKey, messageID, outcome.Category)
	}
	return nil
}

func HandleComplaint(ctx context.Context, producer Producer, recipient, messageID string) error {
	return Publish(ctx, producer, "complained", RecipientHash(recipient), messageID, "COMPLAINT")
}
`,
    },
    scala: {
      starter: `package events

import spray.json.DefaultJsonProtocol._
import spray.json._

object Events {
  val Topic = "email.event"

  def publish(eventType: String, campaignKey: String, messageId: String, recipient: String): Unit = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val payload = Map(
      "event_type" -> eventType,
      "recipient_email" -> recipient,
      "message_id" -> messageId,
    ).toJson.compactPrint
    producer.send(topic = Topic, key = campaignKey, value = payload)
  }

  def handleSend(recipient: String, messageId: String, campaignId: String): Unit = {
    publish("accepted", campaignId, messageId, recipient)
    relay.send(recipient, messageId)
  }
}
`,
      solution: `package events

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import spray.json.DefaultJsonProtocol._
import spray.json._

object Events {
  val Topic = "email.event"

  def recipientHash(recipient: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(recipient.getBytes(StandardCharsets.UTF_8))
    digest.map("%02x".format(_)).mkString
  }

  def publish(eventType: String, recipientKey: String, messageId: String, category: String = ""): Unit = {
    val payload = Map(
      "event_type" -> eventType,
      "message_id" -> messageId,
      "category" -> category,
    ).toJson.compactPrint
    producer.send(topic = Topic, key = recipientKey, value = payload)
  }

  def handleSend(recipient: String, messageId: String): Unit = {
    val recipientKey = recipientHash(recipient)
    publish("queued", recipientKey, messageId)
    val outcome = relay.send(recipient, messageId)
    if (outcome.accepted) {
      publish("accepted", recipientKey, messageId)
    } else if (outcome.bounced) {
      publish("bounced", recipientKey, messageId, outcome.category)
    }
  }

  def handleComplaint(recipient: String, messageId: String): Unit = {
    publish("complained", recipientHash(recipient), messageId, "COMPLAINT")
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>

#include <string>

namespace events {

using json = nlohmann::json;

const std::string kTopic = "email.event";

void publish(Producer& producer, const std::string& event_type, const std::string& campaign_key,
             const std::string& message_id, const std::string& recipient) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json payload = json{{"event_type", event_type}, {"recipient_email", recipient}, {"message_id", message_id}};
  producer.send(kTopic, campaign_key, payload.dump());
}

void handleSend(Producer& producer, Relay& relay, const std::string& recipient, const std::string& message_id,
                const std::string& campaign_id) {
  publish(producer, "accepted", campaign_id, message_id, recipient);
  relay.send(recipient, message_id);
}

}  // namespace events
`,
      solution: `#include <nlohmann/json.hpp>

#include <string>

namespace events {

using json = nlohmann::json;

const std::string kTopic = "email.event";

std::string recipientHash(const std::string& recipient);

void publish(Producer& producer, const std::string& event_type, const std::string& recipient_key,
             const std::string& message_id, const std::string& category = "") {
  const json payload = json{{"event_type", event_type}, {"message_id", message_id}, {"category", category}};
  producer.send(kTopic, recipient_key, payload.dump());
}

void handleSend(Producer& producer, Relay& relay, const std::string& recipient, const std::string& message_id) {
  const std::string recipient_key = recipientHash(recipient);
  publish(producer, "queued", recipient_key, message_id);
  const auto outcome = relay.send(recipient, message_id);
  if (outcome.accepted) {
    publish(producer, "accepted", recipient_key, message_id);
  } else if (outcome.bounced) {
    publish(producer, "bounced", recipient_key, message_id, outcome.category);
  }
}

void handleComplaint(Producer& producer, const std::string& recipient, const std::string& message_id) {
  publish(producer, "complained", recipientHash(recipient), message_id, "COMPLAINT");
}

}  // namespace events
`,
    },
  },
  hints: [
    'The lifecycle consumer shows a recipient as accepted after it recorded their bounce, and a data-protection audit found plain addresses in the analytics sink fed from `email.event`.',
    'The record key is the campaign id, so two events for one recipient land on different partitions and are consumed in either order, and the value serialises `recipient_email` as given.',
    'Key with `recipient_hash(recipient)` (`sha256`), pass it as `recipient_key`, and replace `recipient_email` with the hash plus `message_id` and `category`. The other checks cover publish order and the four event types.',
  ],
  debrief: `The fix rests on how Kafka orders records: only within a partition, and the partition is chosen by the key. Keying by the recipient hash puts one recipient's whole lifecycle on one partition, so a consumer sees queued, accepted and bounced in the order they happened; a campaign key gives the campaign that property instead, which nobody needs. Publishing \`accepted\` after \`relay.send\` returns makes the event mean what it says. Hashing the address in key and value keeps personal data off the topic, so retention and downstream access need not treat it as such. Production pipelines also turn on the idempotent producer with \`acks=all\` so a broker retry cannot duplicate an event, register the payload schema, and commit consumer offsets only after the lifecycle write succeeds.`,
};
