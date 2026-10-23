package kafkacourse_test

import "testing"

// kafka-batch-consumer/batch-consumer: FetchMessage under a batch window, CommitMessages per batch.
func TestBatchConsumer(t *testing.T) {
	run(t, "batch_consumer.go", solution(t, "kafka-batch-consumer", "batch-consumer"), `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

const group, topic = "rollup", "metrics"

func seed(ctx *harness.Ctx, n int, partition func(int) int) {
	for i := 0; i < n; i++ {
		ctx.Kafka.SeedPartition(topic, partition(i), fmt.Sprintf("host-%d", i), fmt.Sprintf(`+"`"+`{"host":"host-%d","cpu":%d}`+"`"+`, i, i))
	}
}

func mod3(i int) int { return i % 3 }

type recording struct {
	flushes [][]kafka.Message
	commits []harness.KafkaOffsets
	at      []time.Time
	log     []string
}

func record(ctx *harness.Ctx) *recording {
	rec := &recording{}
	ctx.Kafka.OnCommit(func(g string, offsets harness.KafkaOffsets) {
		rec.commits = append(rec.commits, offsets)
		rec.at = append(rec.at, time.Now())
		rec.log = append(rec.log, "commit")
	})
	return rec
}

// runFor runs the learner's loop over what was seeded and some seconds of silence after it.
func runFor(ctx *harness.Ctx, rec *recording) {
	c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx.Drain(func() {
		run(c, func(batch []kafka.Message) error {
			rec.flushes = append(rec.flushes, append([]kafka.Message(nil), batch...))
			rec.log = append(rec.log, fmt.Sprintf("flush %d", len(batch)))
			return nil
		})
	})
}

func sizes(rec *recording) string {
	var s []int
	for _, f := range rec.flushes {
		s = append(s, len(f))
	}
	return fmt.Sprint(s)
}

func CheckBatchSize(ctx *harness.Ctx) {
	seed(ctx, 120, mod3)
	rec := record(ctx)
	runFor(ctx, rec)
	ctx.Equal(sizes(rec), "[50 50 20]", "120 records flush as 50, 50, 20")
	ctx.Equal(fmt.Sprint(rec.log), "[flush 50 commit flush 50 commit flush 20 commit]", "one commit right after each flush")
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "no auto-commit")
	ctx.Equal(ctx.Kafka.Lag(group, topic), 0, "everything flushed is committed")
}

func CheckBatchWait(ctx *harness.Ctx) {
	seed(ctx, 70, mod3)
	rec := record(ctx)
	runFor(ctx, rec)
	ctx.Equal(sizes(rec), "[50 20]", "the trailing 20 flush once 500 ms pass")
	ctx.Equal(len(rec.commits), 2, "one commit per batch")
	ctx.Equal(rec.at[1].Sub(rec.at[0]), 500*time.Millisecond, "the trailing batch commits 500 ms after it started")
}

func CheckCommitOffsets(ctx *harness.Ctx) {
	seed(ctx, 55, func(i int) int {
		if i < 50 {
			return 1
		}
		return 2
	})
	rec := record(ctx)
	runFor(ctx, rec)
	ctx.Equal(len(rec.flushes), 2, "two batches")
	for i, f := range rec.flushes {
		want := harness.KafkaOffsets{}
		for _, m := range f {
			tp := harness.KafkaTopicPartition{Topic: m.Topic, Partition: m.Partition}
			if m.Offset+1 > want[tp] {
				want[tp] = m.Offset + 1
			}
		}
		ctx.Equal(rec.commits[i], want, "commit %d is the batch's highest offset + 1 per partition", i+1)
	}
	ctx.Equal(ctx.Kafka.CommittedOffset(group, topic, 1), 50, "partition 1")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, topic, 2), 5, "partition 2")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, topic, 0), -1, "partition 0 had nothing to commit")
}

func CheckNoEmptyFlush(ctx *harness.Ctx) {
	seed(ctx, 50, mod3)
	rec := record(ctx)
	runFor(ctx, rec)
	ctx.Equal(sizes(rec), "[50]", "exactly 50 records then silence flush once")
	ctx.Equal(len(rec.commits), 1, "one batch, one commit")
}
`, "CheckBatchSize", "CheckBatchWait", "CheckCommitOffsets", "CheckNoEmptyFlush")
}

// kafka-consume-transform-produce/consume-transform-produce: read, write, commit after the acks.
func TestConsumeTransformProduce(t *testing.T) {
	run(t, "cleaner.go", solution(t, "kafka-consume-transform-produce", "consume-transform-produce"), `package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

const raw, clean, group = "raw", "clean", "cleaner"

var events = [][2]string{{"ana", " hello "}, {"bo", "x"}, {"ana", "world"}, {"cy", "ok"}, {"bo", "y"}, {"ana", "!"}, {"dee", "z"}}

func transform(v string) string { return strings.ToUpper(strings.TrimSpace(v)) }

func seed(ctx *harness.Ctx) {
	for _, e := range events {
		ctx.Kafka.Seed(raw, e[0], e[1])
	}
}

// runCleaner runs the learner's loop until it waits for input, then stops it (the open batch is
// finished on the way out).
func runCleaner(ctx *harness.Ctx) error {
	c, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(c, transform) }()
	ctx.Settle()
	cancel()
	var err error
	ctx.Drain(func() { err = <-done })
	return err
}

func CheckTransformOrder(ctx *harness.Ctx) {
	seed(ctx)
	ctx.NoError(runCleaner(ctx), "run")
	recs := ctx.Kafka.Records(clean)
	ctx.Equal(len(recs), len(events), "one clean record per raw record")
	hash := &kafka.Hash{}
	for _, r := range recs {
		home := hash.Balance(kafka.Message{Key: r.Key}, 0, 1, 2)
		ctx.Equal(r.Partition, home, "%s stays on the partition its key hashes to", r.Key)
	}
	var ana []string
	for _, r := range recs {
		if string(r.Key) == "ana" {
			ana = append(ana, string(r.Value))
		}
	}
	ctx.Equal(strings.Join(ana, ","), "HELLO,WORLD,!", "ana's records in raw order")
	ctx.Equal(ctx.Kafka.Lag(group, raw), 0, "the open batch is committed before run returns")
}

func CheckCommitAfterAcks(ctx *harness.Ctx) {
	seed(ctx)
	ctx.Kafka.StallFor(clean, 1)
	start := time.Now()
	var early []time.Duration
	ctx.Kafka.OnCommit(func(g string, offsets harness.KafkaOffsets) {
		if len(ctx.Kafka.Records(clean)) < len(events) || time.Since(start) < time.Second {
			early = append(early, time.Since(start))
		}
	})
	ctx.NoError(runCleaner(ctx), "run")
	ctx.Assert(len(ctx.Kafka.Commits(group)) > 0, "no offset was ever committed")
	ctx.Equal(len(early), 0, "committed before the broker acknowledged: %v", early)
	ctx.Equal(ctx.Kafka.Lag(group, raw), 0, "lag")
}

func CheckFlushTimeout(ctx *harness.Ctx) {
	seed(ctx)
	ctx.Kafka.Stall(clean)
	start := time.Now()
	err := runCleaner(ctx)
	waited := time.Since(start)
	ctx.ErrorIs(err, ErrBatchFailed, "an unacknowledged batch fails")
	ctx.Assert(waited <= 2500*time.Millisecond, "run gave up after %v: a send waits at most 2 s", waited)
	ctx.Equal(len(ctx.Kafka.Commits(group)), 0, "nothing of the failed batch is committed")
	ctx.Kafka.Resume(clean)
	restart()
	ctx.NoError(runCleaner(ctx), "run after restart")
	ctx.Equal(ctx.Kafka.Lag(group, raw), 0, "the batch is re-read and lands")
	ctx.Assert(len(ctx.Kafka.Records(clean)) >= len(events), "every record landed")
}

func CheckReplayDedupable(ctx *harness.Ctx) {
	seed(ctx)
	ctx.Kafka.FailNext(clean, 1)
	err := runCleaner(ctx)
	ctx.Assert(errors.Is(err, ErrBatchFailed), "a failed record fails the batch: %v", err)
	landed := len(ctx.Kafka.Records(clean))
	ctx.Equal(landed, len(events)-1, "the records whose send did not fail landed")
	ctx.Equal(len(ctx.Kafka.Commits(group)), 0, "no commit")
	restart()
	ctx.NoError(runCleaner(ctx), "replay")
	ctx.Equal(len(ctx.Kafka.Records(clean)), landed+len(events), "the replay re-sends the whole batch")
	sources := map[string]bool{}
	for _, r := range ctx.Kafka.Records(clean) {
		p, _ := r.Header("src_partition")
		o, _ := r.Header("src_offset")
		sources[string(p)+"/"+string(o)] = true
	}
	ctx.Equal(len(sources), len(events), "src_partition/src_offset name every raw record")
}
`, "CheckTransformOrder", "CheckCommitAfterAcks", "CheckFlushTimeout", "CheckReplayDedupable")
}

// kafka-replay-from-offset/replay-to-snapshot: DialLeader + ReadLastOffset, partition readers, SetOffset.
func TestReplayToSnapshot(t *testing.T) {
	run(t, "replay_tool.go", solution(t, "kafka-replay-from-offset", "replay-to-snapshot"), `package main

import (
	"context"
	"fmt"

	"leetbuild/harness"
)

const topic = "events"

func seed(ctx *harness.Ctx, partition int, values ...string) {
	for _, v := range values {
		ctx.Kafka.SeedPartition(topic, partition, "k", v)
	}
}

func replayAll(ctx *harness.Ctx, from int64) (int, map[int][]string) {
	got := map[int][]string{}
	var n int
	var err error
	ctx.Drain(func() {
		n, err = replay(context.Background(), topic, from, func(r ReplayRecord) error {
			got[r.Partition] = append(got[r.Partition], fmt.Sprintf("%d:%s", r.Offset, r.Value))
			return nil
		})
	})
	ctx.NoError(err, "replay")
	return n, got
}

func CheckFromOffset(ctx *harness.Ctx) {
	seed(ctx, 0, "a0", "a1", "a2", "a3")
	seed(ctx, 1, "b0")
	seed(ctx, 2, "c0", "c1", "c2")
	n, got := replayAll(ctx, 2)
	ctx.Equal(fmt.Sprint(got[0]), "[2:a2 3:a3]", "partition 0")
	ctx.Equal(len(got[1]), 0, "partition 1 has nothing from offset 2")
	ctx.Equal(fmt.Sprint(got[2]), "[2:c2]", "partition 2")
	ctx.Equal(n, 3, "count")
	n, got = replayAll(ctx, 10)
	ctx.Equal(n, 0, "beyond every end")
}

func CheckIndependent(ctx *harness.Ctx) {
	seed(ctx, 0, "a0", "a1")
	seed(ctx, 1, "b0")
	n, _ := replayAll(ctx, 1)
	ctx.Equal(n, 1, "first replay")
	seed(ctx, 0, "a2")
	seed(ctx, 2, "c0")
	n, got := replayAll(ctx, 0)
	ctx.Equal(n, 5, "the second replay starts over")
	ctx.Equal(fmt.Sprint(got[0]), "[0:a0 1:a1 2:a2]", "partition 0")
	ctx.Equal(len(ctx.Kafka.Commits("")), 0, "a replay never commits")
	for _, c := range ctx.Kafka.Consumers() {
		ctx.Equal(c.Group, "", "partition readers have no group")
		ctx.Assert(c.Closed, "every reader is closed")
	}
}

func CheckSnapshot(ctx *harness.Ctx) {
	seed(ctx, 0, "a0", "a1")
	appended := false
	var n int
	ctx.Drain(func() {
		n, _ = replay(context.Background(), topic, 0, func(r ReplayRecord) error {
			if !appended {
				appended = true
				seed(ctx, 0, "late")
			}
			return nil
		})
	})
	ctx.Equal(n, 2, "records appended after the replay started are out of scope")
}
`, "CheckFromOffset", "CheckIndependent", "CheckSnapshot")
}

// kafka-graceful-shutdown/graceful-shutdown: FetchMessage → write → CommitMessages, bounded shutdown.
func TestGracefulShutdown(t *testing.T) {
	run(t, "forwarder.go", solution(t, "kafka-graceful-shutdown", "graceful-shutdown"), `package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

const inbox, outbox, group = "inbox", "outbox", "forwarder"

func seed(ctx *harness.Ctx, keys ...string) {
	for _, k := range keys {
		ctx.Kafka.SeedPartition(inbox, 0, k, "v-"+k)
	}
}

func outboxKeys(ctx *harness.Ctx) string {
	var out []string
	for _, r := range ctx.Kafka.Records(outbox) {
		out = append(out, string(r.Key)+"="+string(r.Value))
	}
	return strings.Join(out, ",")
}

func CheckDrain(ctx *harness.Ctx) {
	seed(ctx, "a", "slow", "b")
	var calls []string
	inHand := make(chan struct{})
	handler := func(m kafka.Message) ([]byte, error) {
		key := string(m.Key)
		calls = append(calls, key)
		if key == "slow" {
			close(inHand)
			time.Sleep(2 * time.Second)
		}
		return []byte(strings.ToUpper(string(m.Value))), nil
	}
	go run(handler)
	<-inHand
	before := time.Now()
	report := shutdown(5 * time.Second)
	took := time.Since(before)
	ctx.Assert(took <= 5500*time.Millisecond, "shutdown(5) took %v", took)
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "no auto-commit")
	ctx.Equal(outboxKeys(ctx), "a=V-A,slow=V-SLOW", "the record in hand is forwarded, nothing more")
	ctx.Equal(fmt.Sprint(calls), "[a slow]", "no record is taken after shutdown")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, inbox, 0), 2, "every forwarded record is committed")
	ctx.Equal(report.Forwarded, 2, "forwarded")
	ctx.Equal(report.Undelivered+report.Uncommitted, 0, "a clean stop")
	ctx.Equal(len(ctx.Kafka.EventsOf("close")), 1, "the reader is closed")
}

func CheckSlowBrokerWithinDeadline(ctx *harness.Ctx) {
	seed(ctx, "a", "b")
	ctx.Kafka.StallFor(outbox, 2)
	inHand := make(chan struct{})
	var once bool
	go run(func(m kafka.Message) ([]byte, error) {
		if !once {
			once = true
			close(inHand)
		}
		return m.Value, nil
	})
	<-inHand
	before := time.Now()
	report := shutdown(5 * time.Second)
	took := time.Since(before)
	ctx.Equal(outboxKeys(ctx), "a=v-a", "the forward in hand lands when the broker answers")
	ctx.Assert(took <= 2500*time.Millisecond, "the broker answered after 2 s, shutdown took %v", took)
	ctx.Equal(report.Undelivered+report.Uncommitted, 0, "report %+v", report)
	ctx.Equal(ctx.Kafka.CommittedOffset(group, inbox, 0), 1, "a is committed")
}
`, "CheckDrain", "CheckSlowBrokerWithinDeadline")
}
