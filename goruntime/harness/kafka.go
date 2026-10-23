package harness

import (
	"encoding/json"
	"fmt"
	"time"

	mk "leetbuild/goruntime/models/kafka"
)

// Kafka is the broker as the harness sees it (the TypeScript ctx.kafka): it seeds records from
// "other producers", reads what the learner produced and committed, observes commits and
// subscriptions as they happen, and injects failures. Its seeds and commits are not the learner's
// and do not count in the check's metrics.
//
//	ctx.Kafka.Seed("orders", "o-1", `{"id":1}`)        a record from another producer
//	ctx.Kafka.Records("orders")                        what is on the topic, in production order
//	ctx.Kafka.Lag("ledger", "payments")                records the group has not committed
//	ctx.Kafka.OnCommit(func(group string, offsets harness.KafkaOffsets) { … })
//	ctx.Kafka.StallFor("orders", 2)                    the broker acknowledges 2 s later
type Kafka struct{ ctx *Ctx }

func newKafka(c *Ctx) *Kafka { return &Kafka{ctx: c} }

// KafkaRecord is a record on a partition: Topic, Partition, Offset, Key, Value (nil for a missing
// key or a tombstone), Headers, Timestamp, and Seq, its place in the global production order.
// r.Header(name) returns a header's value.
type KafkaRecord = mk.Record

// KafkaHeader is a record header.
type KafkaHeader = mk.Header

// KafkaTopicPartition names a partition; String() is "topic|partition".
type KafkaTopicPartition = mk.TopicPartition

// KafkaOffsets maps partitions to offsets: a commit, each offset the next one to read.
type KafkaOffsets = mk.Offsets

// KafkaEvent is an entry of the broker's log (the TypeScript ctx.kafka.events): Kind is produce,
// seed, produce-failed, produce-stalled, produce-lost, produce-timed-out, ack-lost, failover,
// flush, producer, consumer, subscribe, deliver, commit, manual-commit, auto-commit or close; Group,
// Topic, Partition, Offset, Topics, Offsets, Lost and Client are set as the kind needs.
type KafkaEvent = mk.Event

// KafkaConsumer describes a consumer the learner created: Client ("kafka-go" or "confluent"),
// Group, Topics, AutoCommit, AutoCommitInterval, Config, Assignment, Closed.
type KafkaConsumer = mk.ConsumerInfo

func (k *Kafka) broker() *mk.Broker { return mk.Default() }

// bytesOf is the TypeScript toBytes: nil stays nil, strings and byte slices are taken as they are,
// anything else is encoded as JSON.
func (k *Kafka) bytesOf(v any) []byte {
	switch x := v.(type) {
	case nil:
		return nil
	case []byte:
		return x
	case string:
		return []byte(x)
	case fmt.Stringer:
		return []byte(x.String())
	}
	b, err := json.Marshal(v)
	if err != nil {
		k.ctx.Fatalf("kafka: cannot encode %v as a record field: %v", v, err)
	}
	return b
}

// CreateTopic creates topic with partitions partitions (<= 0: the default, 3) unless it exists.
// Topics are otherwise created on first use with 3 partitions.
func (k *Kafka) CreateTopic(topic string, partitions int) { k.broker().CreateTopic(topic, partitions) }

// Topics lists the topics in creation order.
func (k *Kafka) Topics() []string { return k.broker().Topics() }

// Partitions is topic's partition count.
func (k *Kafka) Partitions(topic string) int { return k.broker().Partitions(topic) }

// PartitionFor is the partition the broker's partitioner puts key on (CRC-32 of the key modulo the
// partition count: librdkafka's default, what confluent-kafka-go uses with PartitionAny, and the
// TypeScript and Python runtimes' partitionFor). kafka-go's Writer partitions with its Balancer
// instead: compare with (&kafka.Hash{}).Balance(kafka.Message{Key: key}, 0, 1, 2) there.
func (k *Kafka) PartitionFor(topic string, key []byte) int {
	return k.broker().PartitionFor(topic, key)
}

// Seed puts a record from another producer on topic, on the partition its key hashes to (the
// TypeScript seed(topic, {key, value, headers})). Key and value are strings, byte slices, nil, or
// values encoded as JSON.
func (k *Kafka) Seed(topic string, key, value any, headers ...KafkaHeader) KafkaRecord {
	return k.broker().Seed(topic, -1, k.bytesOf(key), k.bytesOf(value), headers)
}

// SeedPartition is Seed on a given partition (seed(topic, {key, value, partition})).
func (k *Kafka) SeedPartition(topic string, partition int, key, value any, headers ...KafkaHeader) KafkaRecord {
	if n := k.broker().Partitions(topic); partition < 0 || partition >= n {
		k.ctx.Fatalf("kafka: %s has %d partitions, no partition %d", topic, n, partition)
	}
	return k.broker().Seed(topic, partition, k.bytesOf(key), k.bytesOf(value), headers)
}

// Records is everything on topic, in production order.
func (k *Kafka) Records(topic string) []KafkaRecord { return k.broker().Records(topic) }

// Values are the values of Records(topic) as text (a nil value is "").
func (k *Kafka) Values(topic string) []string {
	var out []string
	for _, r := range k.Records(topic) {
		out = append(out, string(r.Value))
	}
	return out
}

// Keys are the keys of Records(topic) as text (a nil key is "").
func (k *Kafka) Keys(topic string) []string {
	var out []string
	for _, r := range k.Records(topic) {
		out = append(out, string(r.Key))
	}
	return out
}

// EndOffset is the offset the next record of the partition gets.
func (k *Kafka) EndOffset(topic string, partition int) int64 {
	return k.broker().EndOffset(topic, partition)
}

// Lag counts the records of topic the group has not committed.
func (k *Kafka) Lag(group, topic string) int64 { return k.broker().Lag(group, topic) }

// CommittedOffset is the group's committed offset of the partition, -1 when it has none (the
// TypeScript null).
func (k *Kafka) CommittedOffset(group, topic string, partition int) int64 {
	if o, ok := k.broker().CommittedOffset(group, topic, partition); ok {
		return o
	}
	return -1
}

// Committed is the group's committed offset of the partition and whether there is one.
func (k *Kafka) Committed(group, topic string, partition int) (int64, bool) {
	return k.broker().CommittedOffset(group, topic, partition)
}

// Commits lists the offsets of every commit of group ("" every group), in order.
func (k *Kafka) Commits(group string) []KafkaOffsets { return k.broker().Commits(group) }

// Commit commits offsets for group as another member of the group would (the harness's commit: it
// runs the commit hooks but is not the learner's).
func (k *Kafka) Commit(group string, offsets KafkaOffsets) { k.broker().Commit(group, offsets, "") }

// OnCommit runs hook(group, offsets) at every commit, before the committing call returns: snapshot
// other state there to prove the commit came after the work.
func (k *Kafka) OnCommit(hook func(group string, offsets KafkaOffsets)) { k.broker().OnCommit(hook) }

// OnSubscribe runs hook(group, topics) when a consumer joins a group (confluent: Subscribe;
// kafka-go: a group Reader's first fetch), before it reads anything: act once the learner's consumer
// is listening.
func (k *Kafka) OnSubscribe(hook func(group string, topics []string)) { k.broker().OnSubscribe(hook) }

// FailNext makes the next times produces to topic fail with a delivery error (kafka-go:
// RequestTimedOut for that message; confluent: a delivery report with ErrMsgTimedOut, retriable).
func (k *Kafka) FailNext(topic string, times int) {
	if times <= 0 {
		times = 1
	}
	k.broker().FailNext(topic, times)
}

// Stall stops the broker acknowledging produces to topic ("" every topic) until Resume: producers
// wait, and time out as their client does.
func (k *Kafka) Stall(topic string) { k.broker().Stall(topic, 0) }

// StallFor is Stall for seconds of virtual time: the broker answers again afterwards.
func (k *Kafka) StallFor(topic string, seconds float64) {
	if seconds <= 0 {
		k.ctx.Fatalf("kafka: StallFor needs a positive duration, got %v (Stall stalls until Resume)", seconds)
	}
	k.broker().Stall(topic, time.Duration(seconds*float64(time.Second)))
}

// Resume ends the stall of topic ("" every stall); waiting producers deliver.
func (k *Kafka) Resume(topic string) { k.broker().Resume(topic) }

// LoseAcks: the next times produce requests to topic are written but their acknowledgement is lost;
// the producer retries, which writes the record again unless it is idempotent.
func (k *Kafka) LoseAcks(topic string, times int) {
	if times <= 0 {
		times = 1
	}
	k.broker().LoseAcks(topic, times)
}

// Failover fails the partition leaders of topic ("" every topic): records acknowledged by the
// leader alone (acks 0 or 1) within the last 100 ms are gone. It returns how many were lost.
func (k *Kafka) Failover(topic string) int { return k.broker().Failover(topic) }

// Events is the broker's log so far.
func (k *Kafka) Events() []KafkaEvent { return k.broker().Events() }

// EventsOf is the log's entries of the given kinds.
func (k *Kafka) EventsOf(kinds ...string) []KafkaEvent {
	want := map[string]bool{}
	for _, kind := range kinds {
		want[kind] = true
	}
	var out []KafkaEvent
	for _, e := range k.Events() {
		if want[e.Kind] {
			out = append(out, e)
		}
	}
	return out
}

// Consumers describes every consumer the learner created in this check, in creation order.
func (k *Kafka) Consumers() []KafkaConsumer { return k.broker().Consumers() }

// Flushes counts the producer flushes (confluent Producer.Flush) so far.
func (k *Kafka) Flushes() int { return k.broker().Flushes() }
