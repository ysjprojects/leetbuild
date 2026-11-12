import type {Source} from '@/lib/types';

/**
 * The failure-mode guide for producing events: the key as the ordering scope, acks=all with an
 * idempotent producer, the delivery report, the outbox, publishing after the commit and payloads of
 * references. Rendered at `/guides/producing-events`.
 */
export const guide = `# The failure mode

A service changes its state and tells the rest of the system with an event. Downstream, the topic is
treated as the record of what happened: billing sums it, a projector folds it into a read model, an
auditor keeps it for a year, a team that does not exist yet will replay it next spring. The producer
fails when the topic stops being a faithful record of the state: events arrive **out of order**, appear
**twice**, go **missing**, announce **something that never happened**, or carry **data that should
never have left the service**.

None of that shows in a demo. One change, one event, one consumer, a broker that is up: the record
lands and the dashboard moves. Here is a minimal instance, a rename that tells the graph consumers:

\`\`\`python
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})

def rename_entity(tenant, entity_id, new_name):
    entity = store.by_id(tenant, entity_id)
    event = {"type": "entity.renamed", "tenant": tenant, "entity_id": entity_id,
             "new_name": new_name, "description": entity.description}
    producer.produce("graph.changed", value=json.dumps(event))
    producer.poll(0)
    store.rename(tenant, entity_id, new_name)
    return True
\`\`\`

It hides five flaws, one per section of this guide:

1. **No key.** Two renames of one entity can land on two partitions, and a consumer applies them in
   either order.
2. **\`acks=1\`, no idempotence.** A leader that dies after acknowledging loses the record; a retry
   after a lost acknowledgement writes it twice.
3. **\`produce\` only queues.** \`return True\` is a guess: the broker may refuse the record or never
   answer, and nobody is listening for the outcome.
4. **Produced before the commit.** If \`store.rename\` fails, every consumer has already heard about a
   rename that never happened.
5. **Content in the payload.** The entity's description now lives in a retained, replicated topic that
   every consumer group can read.

# How it shows up

The debugging courses hide these flaws in starters that work. Each of these steps starts from a
producer that passes its demo:

- [Chat Memory Service, step 4](/chat-memory/4-events): the starter keys each event by the turn and
  answers \`True\` after one poll. The memory worker summarizes a conversation's turns out of order, and
  a card number someone pasted into a chat outlives the buffer it was typed into.
- [Knowledge Graph, step 4](/knowledge-graph/4-events): no key, a fallback that only catches an
  exception, and a produce that runs before the write it announces.
- [Fine-tune Orchestrator, step 4](/fine-tune-orchestrator/4-events): consumers hear "succeeded" for
  a job the team cancelled a second earlier, and a compacted topic keeps one job's final status in
  place of another's.
- [Refund Service, step 4](/refund-service/4-events): finance books a refund the payment provider
  turned down, and two refunds of one payment are read in the wrong order.
- [Reranking Service, step 4](/reranker-service/4-events): one large tenant owns a partition, and
  every query a user typed is copied into the topic.
- [Permission Service, step 4](/permission-service/4-events): an outbox relay marks rows sent that the
  broker never took, and a revoke overtakes the grant before it.
- [CDC Streamer, step 4](/cdc-streamer/4-events): a batch the broker refused is reported as delivered,
  so the stream confirms past changes nobody received.

In production: a read model's **version goes backwards**; billing totals exceed the request count
after a broker restart; an audit chain has a **gap** that matches an outage, with no error logged; a
deletion request cannot reach text that sits in a retained topic and its mirrors.

# The mechanism

## The key is the ordering scope

A topic is split into partitions, and Kafka keeps order **only within a partition**. The producer picks
the partition from the key, \`hash(key) mod partitions\`; a record without a key goes wherever the
partitioner sends the current batch. So the key is a contract: every record with the same key is read
in the order it was written, and nothing else is.

:::widget kafka-partitions {"partitions": 4}

The right key is the smallest thing whose events a consumer folds in order:

| Key by | What stays in order | What it costs |
| --- | --- | --- |
| Entity (order, document, job, sku) | every change to one thing | no order across things, which a per-thing consumer never needs |
| Conversation, run, session | one flow's steps | a long flow is one partition's work |
| Tenant | everything a tenant does | a large tenant is a hot partition; ordering you rarely use |
| Request or event id | nothing | perfect spread, useless for anything that folds state |
| No key | nothing | the same, and a compacted topic cannot keep a latest value |

Keying by tenant is right when the consumer's state is per tenant (a billing total, a per-tenant
counter), and wrong when it is per entity: it adds no order the consumer uses and concentrates load.
Keying by entity is right for state machines and projections. On a **compacted** topic the key is
also the identity: compaction keeps the latest record per key, so keying by team keeps one job per
team. A key that mixes scopes (\`{tenant}:{session}\`) is fine as long as it is stable: adding
partitions remaps keys, so a key's new records can overtake its old ones during the change.

:::quiz
Q: Inventory events are keyed by tenant. A merchant reports that a sold-out item shows as in stock after a burst of updates. Why does rekeying by sku help more than adding partitions?
- [ ] Adding partitions would fix it too, since load is the problem
- [x] With the sku as the key, every change to one sku lands on one partition and is read in order; more partitions only spread tenants, without ordering a sku's changes against each other any better
- [ ] Rekeying by sku makes the consumer faster, so the stale read window shrinks
> The bug is about order, not speed. Keyed by tenant, one sku's changes already share a partition, but so does everything else the tenant does, and a hot tenant lags. Keyed by sku, the ordering scope is exactly what the consumer folds, and the load spreads too.
:::

## acks and idempotence prevent two different losses

\`acks\` decides **when the broker answers**; \`enable.idempotence\` decides **what a retry does**. They
fix different failures, and you need both.

| Setting | Prevents | Does not prevent |
| --- | --- | --- |
| \`acks=0\` | nothing; the client never hears an outcome | any loss |
| \`acks=1\` | a record lost before the leader wrote it | loss when the leader dies before a follower copies it |
| \`acks=all\` | loss on a leader failover: every in-sync replica has the record before the ack | duplicates from retries |
| \`enable.idempotence=true\` | a duplicate when an ack is lost and the producer resends; reordering across retries | a second \`produce\` call your code makes |

With \`acks=1\` the leader answers once it has written the record locally. If it fails before a
follower has fetched the record, a follower becomes leader without it: the producer heard success and
the record is gone. \`acks=all\` waits for the in-sync replicas. Pair it with the topic's
\`min.insync.replicas=2\`, otherwise the in-sync set can shrink to the leader alone and \`all\` means one.

A lost acknowledgement is the opposite case: the broker wrote the batch and the answer never arrived.
The producer retries, as it should, and without idempotence the broker appends the batch a second time.
An idempotent producer numbers its batches per partition; the broker remembers the last numbers it
wrote and drops a resend it already has, then acknowledges it as if it were new.

The defaults differ by client. Since Kafka 3.0 the Java client enables idempotence and \`acks=all\`
unless a conflicting setting such as \`acks=1\` quietly turns idempotence off. librdkafka, and so
confluent-kafka in Python and Go, leaves idempotence off until you set it, and refuses
\`enable.idempotence=true\` together with an explicit \`acks=1\`. kafkajs takes \`idempotent: true\` on the
producer and \`acks: -1\` on \`send\`. kafka-go has \`RequiredAcks: kafka.RequireAll\` but no idempotent
mode: where duplicates matter, Go code reaches for confluent-kafka-go.

:::details How the broker recognises a resent batch
When an idempotent producer starts, the broker gives it a **producer id** and an **epoch**. Every batch
it sends to a partition carries that id and a **sequence number** that grows by one per record. The
broker keeps the last sequence numbers per producer and partition, and it writes them to the replicated
log, so a new leader after a failover still recognises a resend. A batch whose numbers it has already
written is acknowledged without being appended again; a batch that skips ahead is refused as out of
order, which is how the producer keeps order with up to five requests in flight.

The guarantee is scoped to one producer session and to the client's own retries. A process that
restarts gets a new producer id. Code that calls \`produce\` again after a timeout, or an outbox relay
that resends a row, makes a **new** record the broker cannot match to the old one. That duplicate is
the consumer's to fold, by an event id carried in the payload: see
[consuming events](/guides/consuming-events) and [idempotent requests](/guides/idempotent-requests).
:::

:::quiz
Q: A producer runs with \`enable.idempotence=true\`. A request times out on the client, so the service's own retry loop calls \`produce\` again with the same payload. What lands on the topic?
- [ ] One record: the idempotent producer dedupes identical payloads
- [x] Possibly two records: idempotence dedupes the client library's internal retries of one batch, not a second record the application produces
- [ ] One record, because \`acks=all\` waits for the first to be replicated
> The broker matches producer id and sequence number, not payloads. A second \`produce\` call gets a new sequence number, so it is a new record. The duplicate must be recognisable by an event id in the payload, and the consumer folds it once.
:::

## produce() queues; the delivery report decides

Every Kafka client buffers. \`produce\` (or \`send\`) returns once the record is in a local queue; the
batch goes to the broker later, and the **outcome arrives later still**: a delivery report callback in
librdkafka and confluent-kafka (served by \`poll\` or \`flush\`), a promise in kafkajs, a channel event in
confluent-kafka-go, the error from a synchronous \`WriteMessages\` in kafka-go.

A producer that does not wait for that outcome is fire-and-forget. There are three outcomes and it
treats them all as success:

- **Delivered**: the report carries a partition and an offset.
- **Refused**: the report carries an error. The topic is not authorised, the record is too large,
  there are not enough in-sync replicas, the record waited past \`message.timeout.ms\` /
  \`delivery.timeout.ms\` in the queue.
- **Unknown**: no report within the window the caller can afford. The broker is stalled or
  unreachable, and the record may still be delivered later, or never.

A process that exits with records in its queue loses them too, unless it flushes on shutdown. Whether
fire-and-forget is acceptable is a product decision: a page-view counter can afford to lose a few
records, a billing record or an audit entry cannot. For events that must exist, the producer waits a
bounded time for the report and treats **refused and unknown alike: not delivered**.

:::sequence
{
  "participants": ["service", "store", "producer", "Kafka", "outbox"],
  "messages": [
    {"from": "service", "to": "store", "label": "commit the change → version 7", "kind": "sync"},
    {"from": "service", "to": "producer", "label": "produce(key = entity id, ids + version)", "kind": "sync"},
    {"from": "producer", "to": "Kafka", "label": "ProduceRequest · acks=all · pid, seq", "kind": "async"},
    {"from": "Kafka", "to": "producer", "label": "ack after every in-sync replica · offset 1042", "kind": "reply"},
    {"from": "producer", "to": "service", "label": "delivery report: ok (or error, or nothing within 2 s)", "kind": "reply"},
    {"from": "service", "to": "outbox", "label": "error or no report → insert the event; the relay sends it", "kind": "sync"}
  ]
}
:::

## Publish after the commit

An event is a statement that something happened. Produced **before** the state commits, it announces
something that may never happen: the compare-and-set refuses the transition, a constraint rejects the
row, the payment provider declines, the process dies. Consumers have already acted, and a topic has no
unpublish: the best you can do is a compensating event that every consumer must understand.

Produced **after** the commit, the event is true, but there is a window between the commit and the
delivery report:

| What fails | Commit, then produce, outbox from the report | Transactional outbox |
| --- | --- | --- |
| Broker refuses the record | outbox row, relayed later | row already written with the state |
| Broker stalls past the window | outbox row; may also arrive late, so a duplicate | row already written; relay retries |
| Process crashes between commit and produce | **event lost**: state committed, nothing announced | row committed with the state; relay sends it after restart |
| Commit fails | nothing produced, nothing written | transaction rolls back both |

The courses mostly write the outbox **from the delivery report**: cheap, no relay on the request path
when the broker is healthy, and it covers a broker that refuses or stalls. The
[transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) writes the event
row in the **same transaction** as the state and lets a relay publish it, which also covers the crash.
Either way the relay publishes at least once, so each row carries an event id that consumers dedupe on.

:::widget outbox {}

:::quiz
Q: A job moves to SUCCEEDED through a compare-and-set in the store. The starter produces \`finetune.job {status: SUCCEEDED}\` first and then runs the compare-and-set, which a concurrent cancel can make fail. What do consumers see when the cancel wins?
- [ ] Nothing: the producer notices the failed compare-and-set and withdraws the record
- [x] A SUCCEEDED event for a job the store says is CANCELLED, which no later event retracts unless one is written for that purpose
- [ ] A SUCCEEDED event, but only until the topic compacts
> Kafka cannot withdraw a record. The fix is to make the event a consequence of the commit: run the compare-and-set, produce only if it succeeded, and build the event from what the store returned.
:::

## The payload is a reference, not the content

A topic is not a request. It is **retained** (days by default, forever on a compacted topic),
**replicated** to several brokers, readable by **every consumer group**, including ones added next
year, and often mirrored to another cluster and dumped into a data lake. A single record cannot be
deleted from the middle of a log. Whatever a producer writes there, a deletion request can no longer
reach.

So an event carries what a consumer needs to act and to look the rest up:

- **ids**: tenant, entity, run, event id for dedupe;
- **versions** and states from a closed set: \`version: 7\`, \`status: "SUCCEEDED"\`, a reason code;
- **digests**: \`sha256\` of a document or prompt, so consumers compare and dedupe without the text;
- **counts and sizes**: tokens, rows, bytes, a score histogram.

Never the prompt, the completion, the document, the email address, the token, the transcript or the
hyperparameters that make up a recipe. A digest of low-entropy data (an email, a phone number) can be
reversed by hashing every candidate, so those get a keyed HMAC or a pseudonym instead. The same rule
covers everything that holds the event: the outbox row, the log line that prints it, the dead-letter
topic.

:::quiz
Q: An embedding service's \`embed.ready\` event carries the document text "so consumers do not need to call back". Which payload keeps consumers working without the risk?
- [ ] The text, encrypted with a key every consumer holds
- [ ] The first 200 characters, as a preview
- [x] The document id, the content digest, the vector count and the model version; a consumer that needs the text reads it from the store, under its own access check
> Every consumer holding the key is the same exposure as plain text. A preview is still content. Ids and a digest let consumers dedupe and fetch, and the store decides who may read the text, today and after a deletion.
:::

# The fix and its trade-offs

The pieces fit in one function: commit, build a reference payload, produce keyed by what the consumer
folds, wait a bounded time for the report, park anything not delivered.

\`\`\`python
producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",               # every in-sync replica has it before the ack
    "enable.idempotence": True,  # a retry after a lost ack is written once
})

def rename_entity(tenant, entity_id, new_name):
    change = store.rename(tenant, entity_id, new_name)  # commit first; raises if refused
    event = {"type": "entity.renamed", "event_id": change.event_id, "tenant": tenant,
             "entity_id": entity_id, "version": change.version}
    outcome = {}
    try:
        producer.produce("graph.changed", key=entity_id, value=json.dumps(event),
                         on_delivery=lambda err, msg: outcome.update(err=err))
        producer.flush(2.0)  # serves the delivery report, or gives up after 2 s
    except (BufferError, KafkaException) as e:
        outcome["err"] = e
    if outcome.get("err", "no report") is not None:
        store.insert_outbox("graph.changed", entity_id, event)  # the relay sends it later
        return False
    return True
\`\`\`

The same shape in kafkajs, where \`send\` resolves on the acknowledgement and rejects on a refusal or a
timeout:

\`\`\`typescript
const producer = kafka.producer({idempotent: true});

export async function renameEntity(tenant: string, entityId: string, newName: string): Promise<boolean> {
  const change = await store.rename(tenant, entityId, newName); // commit first
  const event = {type: 'entity.renamed', event_id: change.eventId, tenant, entity_id: entityId, version: change.version};
  try {
    await producer.send({
      topic: 'graph.changed',
      acks: -1, // all in-sync replicas
      timeout: 2000,
      messages: [{key: entityId, value: JSON.stringify(event)}],
    });
    return true;
  } catch {
    await store.insertOutbox('graph.changed', entityId, event);
    return false;
  }
}
\`\`\`

In Go, confluent-kafka-go reports on a channel; the \`select\` bounds the wait:

\`\`\`go
p, _ := kafka.NewProducer(&kafka.ConfigMap{
	"bootstrap.servers":  "kafka:9092",
	"acks":               "all",
	"enable.idempotence": true,
})

msg := &kafka.Message{
	TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
	Key:            []byte(entityID),
	Value:          value, // ids and the version, no description
}
reports := make(chan kafka.Event, 1)
err := p.Produce(msg, reports)
if err == nil {
	select {
	case e := <-reports:
		err = e.(*kafka.Message).TopicPartition.Error
	case <-time.After(2 * time.Second):
		err = context.DeadlineExceeded // unknown outcome: not delivered
	}
}
if err != nil {
	return false, outbox.Insert(ctx, topic, entityID, event)
}
\`\`\`

In C++, librdkafka calls a \`DeliveryReportCb\` from \`flush\` or \`poll\`:

\`\`\`cpp
class Report : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR__TIMED_OUT;
  void dr_cb(RdKafka::Message& m) override { error = m.err(); }
};

Report report;
conf->set("acks", "all", err);
conf->set("enable.idempotence", "true", err);
conf->set("dr_cb", &report, err);

bool publish(const std::string& key, std::string value) {
  report.error = RdKafka::ERR__TIMED_OUT;  // stays this way if no report arrives
  auto rc = producer->produce("graph.changed", RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                              value.data(), value.size(), key.data(), key.size(), 0, nullptr);
  if (rc == RdKafka::ERR_NO_ERROR) producer->flush(2000);
  if (rc != RdKafka::ERR_NO_ERROR || report.error != RdKafka::ERR_NO_ERROR) {
    outbox::insert("graph.changed", key, value);
    return false;
  }
  return true;
}
\`\`\`

One shared \`Report\` works for one call at a time; concurrent producers pass a per-message opaque and
look the outcome up by it.

What each piece costs:

| Choice | Cost | When to take a different one |
| --- | --- | --- |
| \`acks=all\` with \`min.insync.replicas=2\` | a replica round trip per batch; refusals when replicas are down | metrics you would rather drop than delay |
| Waiting for the report on the request path | a few milliseconds per call, up to the window when the broker stalls | high volume: produce many, then await them together |
| Outbox from the report | duplicates when a late delivery and the relay both land | a crash window you cannot accept: transactional outbox |
| Transactional outbox | a relay process, a table to prune, events a little later | when the store cannot take the row in the same transaction |
| Entity key | hot keys concentrate load | consumers that aggregate per tenant: key by tenant |

:::details Why not Kafka transactions?
Kafka's transactions let a producer write to several partitions and commit consumer offsets
atomically: a consume, transform, produce loop between Kafka topics becomes exactly once. They do not
include your database. A service that commits a row in Postgres or Redis and then produces still has
two systems and the same window between them; the outbox exists for that case.
:::

:::details When a refused record should not be retried
Not every refusal is transient. A record too large for the topic, or a topic the producer may not
write, will be refused again by the relay forever. The relay should distinguish these from timeouts
and broker unavailability, park them with the error, and alert, rather than loop. A relay that
**stops at the first failed row** keeps a key's order; one that skips ahead must make sure later rows
of the same key wait.
:::

# Proving it

Test outcomes against a broker you control, not calls against a mock: "\`produce\` was called with
\`acks=all\`" proves nothing about what a consumer reads. Every course fake can refuse, stall, lose an
ack and fail over; the proof is what is on the topic and in the outbox afterwards.

:::widget delivery-semantics {}

1. **Order.** Write two changes to one entity and one to another. The first two records share a
   partition and are in order; a consumer that folds the topic ends at the store's version.
2. **Leader failover.** Let the leader acknowledge and then fail before followers copy. With
   \`acks=all\` the record is on the new leader; with \`acks=1\` it is gone. Count records.
3. **Lost acknowledgement.** The broker writes the batch and drops the answer; the client retries.
   Exactly one record.
4. **A broker that refuses.** Every produce returns an error in its report. The function reports not
   delivered, and the outbox holds exactly one row with the key and the payload.
5. **A broker that stalls.** No report ever arrives. The function returns within the window plus a
   margin, and the outbox holds the row.
6. **A commit that fails.** The store refuses the change. Zero records, zero outbox rows.
7. **A crash between the commit and the produce.** Kill the process after the commit. With an outbox
   from the delivery report, assert what you accept: the state is committed and the event missing,
   and a reconciliation job finds it. With a transactional outbox, restart the relay and assert the
   topic and the store agree.
8. **Content stays home.** Put a canary string in every content field (the prompt, the document, the
   address), run the flow, including the refused path, and search the topic, the outbox and the log
   output for the canary. It appears nowhere.

:::quiz
Q: Which test catches a producer that returns \`True\` without waiting for the delivery report?
- [ ] Assert that \`produce\` was called once with the right topic and key
- [ ] Run against a healthy broker and assert the record is on the topic
- [x] Make the broker refuse every record, then assert the function reports failure and the outbox holds the event
> On a healthy broker, waiting and not waiting look identical, and a call assertion only checks that a call happened. Only a broker that refuses or stalls separates "handed to the client" from "the broker has it".
:::

:::quiz
Q: A crash test kills the service right after the commit, before \`produce\` runs, and the producer writes its outbox from the delivery report. What does the test find, and what does it mean?
- [ ] The relay publishes the event after restart, so the design is complete
- [x] The state is committed and no event or outbox row exists; closing that window takes a transactional outbox or a reconciliation pass
- [ ] Kafka's idempotent producer resends the record on restart
> An outbox written from the report needs a report, and a crashed process never gets one. That is the trade the cheap outbox makes. If the event must exist whenever the state does, write the row in the same transaction as the state.
:::
`;

export const sources: Source[] = [
  {
    title: 'Producer Configs',
    url: 'https://kafka.apache.org/41/configuration/producer-configs',
    kind: 'docs',
    venue: 'Apache Kafka documentation',
    takes:
      'What acks=0, 1 and all promise, that idempotence requires acks=all and is quietly disabled by a conflicting setting, and how retries without it duplicate and reorder records.',
  },
  {
    title: "Exactly-Once Semantics Are Possible: Here's How Kafka Does It",
    url: 'https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/',
    kind: 'post',
    venue: 'Confluent blog',
    by: 'Neha Narkhede',
    date: '2017-06-30',
    takes:
      'How the idempotent producer numbers batches so the broker drops a resend after a lost acknowledgement, with the sequence persisted to the replicated log so a failover keeps it.',
  },
  {
    title: 'Pattern: Transactional outbox',
    url: 'https://microservices.io/patterns/data/transactional-outbox.html',
    kind: 'post',
    venue: 'microservices.io',
    by: 'Chris Richardson',
    takes:
      'Writing the event to an outbox table in the transaction that changes the state, a relay that publishes it, and the duplicates that relay can produce.',
  },
  {
    title: 'Introduction to librdkafka',
    url: 'https://github.com/confluentinc/librdkafka/blob/master/INTRODUCTION.md',
    kind: 'docs',
    venue: 'GitHub',
    takes:
      'The delivery report callback as the only signal of a record’s outcome, message timeouts, and the idempotent producer’s guarantees and its refusal of acks=1.',
  },
];
