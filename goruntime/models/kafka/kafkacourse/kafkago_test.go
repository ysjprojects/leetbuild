package kafkacourse_test

import "testing"

// kafka-commit-after-processing/commit-after-processing: FetchMessage, handle, CommitMessages.
func TestCommitAfterProcessing(t *testing.T) {
	run(t, "ledger_consumer.go", solution(t, "kafka-commit-after-processing", "commit-after-processing"), `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"leetbuild/harness"
)

const group, topic = "ledger-writer", "payments"

func seedPayments(ctx *harness.Ctx, partition, n int) {
	start := ctx.Kafka.EndOffset(topic, partition)
	for i := 0; i < n; i++ {
		off := start + int64(i)
		v, _ := json.Marshal(map[string]any{"id": fmt.Sprintf("pay-%d-%d", partition, off), "partition": partition, "offset": off, "cents": 100 * (off + 1)})
		ctx.Kafka.SeedPartition(topic, partition, fmt.Sprintf("acct-%d", partition), v)
	}
}

type seen struct{ partition, offset int }

func runLedger(ctx *harness.Ctx, handler Handler) error {
	c, cancel := context.WithCancel(context.Background())
	var err error
	ctx.Drain(func() { err = run(c, handler) })
	cancel()
	return err
}

func CheckInOrder(ctx *harness.Ctx) {
	seedPayments(ctx, 0, 3)
	seedPayments(ctx, 1, 3)
	seedPayments(ctx, 2, 2)
	var got []seen
	runLedger(ctx, func(e PaymentEvent) error {
		got = append(got, seen{int(e["partition"].(float64)), int(e["offset"].(float64))})
		return nil
	})
	ctx.Equal(len(got), 8, "the handler saw every event")
	for p, n := range []int{3, 3, 2} {
		var offsets []int
		for _, s := range got {
			if s.partition == p {
				offsets = append(offsets, s.offset)
			}
		}
		for i, o := range offsets {
			ctx.Equal(o, i, "partition %d in order", p)
		}
		ctx.Equal(len(offsets), n, "partition %d", p)
	}
}

func CheckManualCommit(ctx *harness.Ctx) {
	seedPayments(ctx, 0, 2)
	seedPayments(ctx, 1, 1)
	runLedger(ctx, func(PaymentEvent) error { return nil })
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "auto-commit is on: offsets were committed before processing")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	commits := ctx.Kafka.Commits(group)
	ctx.Equal(len(commits), 3, "commit once per record")
	for _, c := range commits {
		ctx.Equal(len(c), 1, "each commit names the processed record's partition alone")
	}
}

func CheckCommittedOffset(ctx *harness.Ctx) {
	seedPayments(ctx, 0, 3)
	seedPayments(ctx, 1, 2)
	runLedger(ctx, func(PaymentEvent) error { return nil })
	ctx.Equal(ctx.Kafka.CommittedOffset(group, topic, 0), 3, "partition 0 committed offset")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, topic, 1), 2, "partition 1 committed offset")
	ctx.Equal(ctx.Kafka.Lag(group, topic), 0, "every processed record is committed")
}

func CheckCommitAfter(ctx *harness.Ctx) {
	seedPayments(ctx, 0, 2)
	seedPayments(ctx, 1, 2)
	processed := map[string]bool{}
	var early []string
	ctx.Kafka.OnCommit(func(g string, offsets harness.KafkaOffsets) {
		for tp, o := range offsets {
			if !processed[fmt.Sprintf("%d|%d", tp.Partition, o-1)] {
				early = append(early, tp.String())
			}
		}
	})
	runLedger(ctx, func(e PaymentEvent) error {
		processed[fmt.Sprintf("%d|%d", int(e["partition"].(float64)), int(e["offset"].(float64)))] = true
		return nil
	})
	ctx.Equal(len(ctx.Kafka.Commits(group)), 4, "one commit per record")
	ctx.Equal(len(early), 0, "committed before the handler finished: %v", early)
}

func CheckFailureNotCommitted(ctx *harness.Ctx) {
	seedPayments(ctx, 0, 2)
	boom := errors.New("ledger down")
	err := runLedger(ctx, func(e PaymentEvent) error {
		if e["offset"].(float64) == 1 {
			return boom
		}
		return nil
	})
	ctx.ErrorIs(err, boom, "run returns the handler's error")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, topic, 0), 1, "the failed record stays uncommitted")
}

func CheckPoison(ctx *harness.Ctx) {
	seedPayments(ctx, 0, 1)
	ctx.Kafka.SeedPartition(topic, 0, "acct-0", "not json")
	seedPayments(ctx, 0, 1)
	var ids []string
	runLedger(ctx, func(e PaymentEvent) error {
		ids = append(ids, e["id"].(string))
		return nil
	})
	ctx.Equal(strings.Join(ids, ","), "pay-0-0,pay-0-2", "the poison record is skipped")
	ctx.Equal(ctx.Kafka.CommittedOffset(group, topic, 0), 3, "and committed past")
}
`, "CheckInOrder", "CheckManualCommit", "CheckCommittedOffset", "CheckCommitAfter", "CheckFailureNotCommitted", "CheckPoison")
}
