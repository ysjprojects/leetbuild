package kafkacourse_test

import "testing"

// kafka-keyed-producer/keyed-producer: Produce + Events() delivery reports, Flush(5000).
func TestKeyedProducer(t *testing.T) {
	run(t, "order_events.go", solution(t, "kafka-keyed-producer", "keyed-producer"), `package main

import (
	"encoding/json"
	"fmt"
	"time"

	"leetbuild/harness"
)

const topicName = "order-events"

func stat(ctx *harness.Ctx) string {
	ctx.Settle() // the delivery-report goroutine counts what was reported
	d, f := stats()
	return fmt.Sprintf("delivered=%d failed=%d", d, f)
}

func CheckKeyed(ctx *harness.Ctx) {
	for _, ty := range []string{"placed", "paid", "shipped"} {
		emit("o-1", ty)
	}
	emit("o-2", "placed")
	ctx.Equal(shutdown(), 0, "shutdown")
	recs := ctx.Kafka.Records(topicName)
	ctx.Equal(fmt.Sprint(ctx.Kafka.Keys(topicName)), "[o-1 o-1 o-1 o-2]", "records keyed by order id")
	want := ctx.Kafka.PartitionFor(topicName, []byte("o-1"))
	var types []string
	for _, r := range recs[:3] {
		ctx.Equal(r.Partition, want, "o-1 lands on the partition its key hashes to")
		var e map[string]any
		ctx.NoError(json.Unmarshal(r.Value, &e), "value is JSON")
		types = append(types, e["type"].(string))
	}
	ctx.Equal(fmt.Sprint(types), "[placed paid shipped]", "one order keeps its order")
}

func CheckValue(ctx *harness.Ctx) {
	time.Sleep(1000 * time.Second)
	before := float64(time.Now().UnixMilli()) / 1000
	emit("o-7", "paid")
	shutdown()
	recs := ctx.Kafka.Records(topicName)
	ctx.Equal(len(recs), 1, "one record")
	var e map[string]any
	ctx.NoError(json.Unmarshal(recs[0].Value, &e), "the value must be JSON")
	ctx.Equal(e["order_id"], "o-7", "order_id")
	ts := e["ts"].(float64)
	ctx.Assert(ts >= before-1 && ts <= before+1, "ts is the clock in seconds: %v vs %v", ts, before)
}

func CheckDelivered(ctx *harness.Ctx) {
	ctx.Kafka.StallFor(topicName, 2)
	for i := 0; i < 4; i++ {
		emit(fmt.Sprintf("o-%d", i), "placed")
	}
	d, f := stats()
	ctx.Equal(d+f, int64(0), "nothing is delivered before the broker acknowledges")
	ctx.Equal(shutdown(), 0, "shutdown returns 0 once everything is delivered")
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 4, "shutdown flushes")
	ctx.Equal(stat(ctx), "delivered=4 failed=0", "the delivery reports")
}

func CheckCallback(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(topicName, 1)
	emit("o-1", "placed")
	emit("o-1", "paid")
	ctx.Equal(shutdown(), 0, "a failed record is not pending")
	ctx.Equal(stat(ctx), "delivered=1 failed=1", "one delivered, one failed")
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 1, "the second event is delivered")
}

func CheckBounded(ctx *harness.Ctx) {
	ctx.Kafka.Stall(topicName)
	for i := 0; i < 3; i++ {
		emit("o-9", fmt.Sprintf("event-%d", i))
	}
	start := time.Now()
	pending := shutdown()
	waited := time.Since(start)
	ctx.Assert(waited <= 5500*time.Millisecond, "shutdown waited %v on a dead broker", waited)
	ctx.Equal(pending, 3, "the records still undelivered")
	d, f := stats()
	ctx.Equal(d+f, int64(0), "queued records are neither delivered nor failed")
	ctx.Assert(ctx.Kafka.Flushes() >= 1, "shutdown must flush")
}

func CheckNonBlocking(ctx *harness.Ctx) {
	ctx.Kafka.StallFor(topicName, 2)
	start := time.Now()
	emit("o-3", "placed")
	ctx.Assert(time.Since(start) < time.Second, "emit waited for the broker")
	ctx.Equal(ctx.Kafka.Flushes(), 0, "emit must not flush")
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 0, "the record is queued until the broker answers")
	ctx.Equal(shutdown(), 0, "shutdown")
	ctx.Equal(len(ctx.Kafka.Records(topicName)), 1, "the record reaches the broker once it answers")
	ctx.Equal(stat(ctx), "delivered=1 failed=0", "counted")
}
`, "CheckKeyed", "CheckValue", "CheckDelivered", "CheckCallback", "CheckBounded", "CheckNonBlocking")
}

// kafka-idempotent-producer/idempotent-producer: enable.idempotence, a delivery channel, retries.
func TestIdempotentProducer(t *testing.T) {
	run(t, "idempotent_producer.go", solution(t, "kafka-idempotent-producer", "idempotent-producer"), `package main

import (
	"fmt"
	"sort"
	"time"

	"leetbuild/harness"
)

const events = "events"

func CheckLoseAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(events, 1)
	send("e1", "p1")
	shutdown()
	ctx.Equal(len(ctx.Kafka.Records(events)), 1, "a lost ack must not duplicate the record")
	s := stats()
	ctx.Equal(s["delivered"], 1, "delivered once")
	ctx.Equal(len(s["dead"].([]string)), 0, "not dead")
	ctx.Equal(s["pending"], 0, "nothing in flight")
}

func CheckRetries(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(events, 2)
	send("e1", "p1")
	shutdown()
	s := stats()
	ctx.Equal(s["retried"], 2, "two retriable failures, two retries")
	ctx.Equal(s["delivered"], 1, "the third attempt succeeds")
	ctx.Equal(fmt.Sprint(ctx.Kafka.Keys(events)), "[e1]", "one record")
	ctx.Equal(fmt.Sprint(ctx.Kafka.Values(events)), "[p1]", "the retry carries the same value")
}

// The TypeScript check sends e2 after 10 ms, by when e1's promise-driven retry chain is over. The Go
// solution advances its retries only inside send/shutdown, so e2 would take some of e1's failures:
// the port lets shutdown run e1's chain to the end.
func CheckDead(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(events, 4)
	send("e1", "p1")
	shutdown()
	s := stats()
	ctx.Equal(fmt.Sprint(s["dead"]), "[e1]", "a record that failed MAX_RETRIES + 1 times is dead")
	ctx.Equal(s["retried"], 3, "retried")
	ctx.Equal(s["delivered"], 0, "nothing delivered")
	ctx.Equal(s["pending"], 0, "pending")
	ctx.Equal(len(ctx.Kafka.Records(events)), 0, "e1 never landed")
}

func CheckBackpressure(ctx *harness.Ctx) {
	ctx.Kafka.StallFor(events, 5)
	var ids []string
	for i := 0; i < 150; i++ {
		ids = append(ids, fmt.Sprintf("e%d", i))
	}
	sent := make(chan struct{})
	go func() {
		for _, id := range ids {
			send(id, "p")
		}
		close(sent)
	}()
	time.Sleep(10 * time.Millisecond)
	stalled := len(ctx.Kafka.EventsOf("produce-stalled"))
	ctx.Assert(stalled > 0 && stalled <= 100, "%d records were handed to the stalled broker: send waits once MAX_PENDING are in flight", stalled)
	<-sent
	shutdown()
	keys := ctx.Kafka.Keys(events)
	sort.Strings(keys)
	sort.Strings(ids)
	ctx.Equal(fmt.Sprint(keys), fmt.Sprint(ids), "every record lands once the broker answers")
	ctx.Equal(stats()["delivered"], 150, "waiting is not dropping")
}

func CheckKeyed(ctx *harness.Ctx) {
	for _, id := range []string{"order-1", "order-2", "order-3"} {
		send(id, "p")
	}
	shutdown()
	for _, r := range ctx.Kafka.Records(events) {
		ctx.Equal(r.Partition, ctx.Kafka.PartitionFor(events, r.Key), "%s on the partition its key hashes to", r.Key)
	}
	ctx.Equal(fmt.Sprint(ctx.Kafka.Keys(events)), "[order-1 order-2 order-3]", "keys")
}

func CheckFlushBound(ctx *harness.Ctx) {
	ctx.Kafka.Stall(events)
	send("e1", "p1")
	start := time.Now()
	left := shutdown()
	waited := time.Since(start)
	ctx.Assert(waited >= 2500*time.Millisecond && waited <= 10*time.Second, "shutdown waited %v on a dead broker", waited)
	ctx.Equal(left, 1, "one record still in flight")
	ctx.Equal(stats()["delivered"], 0, "nothing delivered")
}
`, "CheckLoseAcks", "CheckRetries", "CheckDead", "CheckBackpressure", "CheckKeyed", "CheckFlushBound")
}

// kafka-backpressure-pause/pause-at-high-water: Poll, Pause/Resume at the water marks, CommitMessage.
func TestBackpressurePause(t *testing.T) {
	runWithBudget(t, 5000, "backpressure.go", solution(t, "kafka-backpressure-pause", "pause-at-high-water"), `package main

import (
	"fmt"
	"sync"
	"time"

	"leetbuild/harness"
)

const n = 200

type trace struct {
	mu      sync.Mutex
	samples []Status
	jobs    []Job
	done    [3]int
}

func (t *trace) sample() {
	t.mu.Lock()
	t.samples = append(t.samples, Stats())
	t.mu.Unlock()
}

func start(ctx *harness.Ctx, slow bool) *trace {
	for i := 0; i < n; i++ {
		ctx.Kafka.SeedPartition("jobs", i%3, fmt.Sprintf("job-%d", i), fmt.Sprintf("job-%d", i))
	}
	t := &trace{}
	finished := make(chan struct{})
	var once sync.Once
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		if ctx.Kafka.Lag(group, "jobs") == 0 {
			once.Do(func() { close(finished) })
		}
	})
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	go func() {
		for range ticker.C {
			t.sample()
		}
	}()
	ran := make(chan error, 1)
	go func() {
		ran <- Run(func(j Job) {
			t.sample()
			t.mu.Lock()
			t.jobs = append(t.jobs, j)
			t.mu.Unlock()
			if slow {
				time.Sleep(50 * time.Millisecond)
			}
			t.mu.Lock()
			t.done[j.Partition]++
			t.mu.Unlock()
		})
	}()
	<-finished
	Stop()
	ctx.NoError(<-ran, "Run")
	ctx.Equal(Stats().Processed, n, "processed")
	return t
}

func CheckBoundedAndInOrder(ctx *harness.Ctx) {
	t := start(ctx, true)
	peak, paused := 0, false
	for _, s := range t.samples {
		if s.Queued > peak {
			peak = s.Queued
		}
		paused = paused || s.Paused
	}
	ctx.Assert(peak <= highWater, "the queue held %d jobs", peak)
	ctx.Assert(paused, "a slow worker pauses the consumer")
	next := [3]int64{}
	for _, j := range t.jobs {
		ctx.Equal(j.Offset, next[j.Partition], "partition %d in order", j.Partition)
		next[j.Partition]++
		ctx.Equal(j.Value, fmt.Sprintf("job-%d", 3*j.Offset+int64(j.Partition)), "value")
	}
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "no auto-commit")
	ctx.Equal(ctx.Kafka.Lag(group, "jobs"), 0, "every processed job is committed")
}

func CheckFastWorker(ctx *harness.Ctx) {
	t := start(ctx, false)
	for _, s := range t.samples {
		ctx.Assert(!s.Paused, "the worker kept up, yet the consumer was paused")
	}
}
`, "CheckBoundedAndInOrder", "CheckFastWorker")
}

// kafka-async-ack-tracking/async-ack-tracking: concurrent handlers, contiguous-frontier CommitOffsets.
func TestAsyncAckTracking(t *testing.T) {
	run(t, "async_consumer.go", solution(t, "kafka-async-ack-tracking", "async-ack-tracking"), `package main

import (
	"fmt"
	"sort"
	"sync"

	"leetbuild/harness"
)

type gates struct {
	mu      sync.Mutex
	ch      map[string]chan struct{}
	started []string
}

func (g *gates) gate(v string) chan struct{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ch[v] == nil {
		g.ch[v] = make(chan struct{})
	}
	return g.ch[v]
}

func (g *gates) handler(v string) error {
	g.mu.Lock()
	g.started = append(g.started, v)
	g.mu.Unlock()
	<-g.gate(v)
	return nil
}

func (g *gates) open(vs ...string) {
	for _, v := range vs {
		close(g.gate(v))
	}
}

func CheckConcurrencyAndFrontier(ctx *harness.Ctx) {
	var values []string
	for i := 0; i < 20; i++ {
		v := fmt.Sprintf("r%d", i)
		values = append(values, v)
		ctx.Kafka.SeedPartition("requests", 0, nil, v)
	}
	g := &gates{ch: map[string]chan struct{}{}}
	go run(g.handler)
	ctx.Settle()
	started := append([]string(nil), g.started...)
	sort.Strings(started)
	want := append([]string(nil), values[:8]...)
	sort.Strings(want)
	ctx.Equal(fmt.Sprint(started), fmt.Sprint(want), "CONCURRENCY = 8 records start (each handler on its own goroutine: any order)")
	inFlight, _ := stats()
	ctx.Equal(inFlight, 8, "inFlight")
	g.open("r1", "r2")
	ctx.Settle()
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), -1, "r0 still runs: nothing is committed")
	g.open("r0")
	ctx.Settle()
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 3, "r0..r2 done: the frontier is 3")
	ctx.Equal(len(g.started), 11, "three completions free three slots")
	all := make(chan struct{})
	var once sync.Once
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		for _, o := range offsets {
			if o == 20 {
				once.Do(func() { close(all) })
			}
		}
	})
	g.open(values[3:]...)
	<-all // every record handled: the frontier reached the end
	shutdown()
	ctx.Equal(ctx.Kafka.CommittedOffset(group, "requests", 0), 20, "everything committed")
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "no auto-commit")
	ctx.Equal(len(ctx.Kafka.EventsOf("close")), 1, "shutdown closes the consumer")
}
`, "CheckConcurrencyAndFrontier")
}
