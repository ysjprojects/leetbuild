package kafka_test

import (
	"hash/crc32"
	"sync"
	"testing"
	"time"

	"leetbuild/goruntime/harness"
	kafka "leetbuild/goruntime/models/confluent"
	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/models/kafka/kafkatest"
	"leetbuild/goruntime/vclock"
)

func world(t *testing.T) (*mk.Broker, *kafkatest.Clock) {
	t.Helper()
	clock := kafkatest.New()
	vclock.Set(clock)
	mk.Reset()
	stop := clock.Start()
	t.Cleanup(func() {
		stop()
		mk.Reset()
		vclock.Set(vclock.Real{})
	})
	return mk.Default(), clock
}

func within(t *testing.T, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s did not return", what)
	}
}

func producer(t *testing.T, conf kafka.ConfigMap) *kafka.Producer {
	t.Helper()
	p, err := kafka.NewProducer(&conf)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func produce(t *testing.T, p *kafka.Producer, topic, key, value string, ch chan kafka.Event) {
	t.Helper()
	if err := p.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
		Key:            []byte(key),
		Value:          []byte(value),
		Opaque:         key,
	}, ch); err != nil {
		t.Fatal(err)
	}
}

func report(t *testing.T, ch chan kafka.Event) *kafka.Message {
	t.Helper()
	select {
	case ev := <-ch:
		m, ok := ev.(*kafka.Message)
		if !ok {
			t.Fatalf("a delivery report is a *Message, got %T", ev)
		}
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("no delivery report")
	}
	return nil
}

func noReport(t *testing.T, ch chan kafka.Event, what string) {
	t.Helper()
	select {
	case ev := <-ch:
		t.Fatalf("%s: unexpected report %v", what, ev)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestProduceReportsAndPartitions(t *testing.T) {
	b, clock := world(t)
	p := producer(t, kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "all"})
	ch := make(chan kafka.Event, 1)
	produce(t, p, "orders", "o-1", "v", ch)
	m := report(t, ch)
	want := int32(crc32.ChecksumIEEE([]byte("o-1")) % 3)
	if m.TopicPartition.Error != nil || m.TopicPartition.Partition != want || m.TopicPartition.Offset != 0 || m.Opaque != "o-1" {
		t.Fatalf("report: %v opaque %v", m.TopicPartition, m.Opaque)
	}
	produce(t, p, "orders", "o-2", "w", nil)
	m = report(t, p.Events())
	if string(m.Key) != "o-2" {
		t.Fatal("without a delivery channel the report goes to Events()")
	}
	start := clock.Now()
	var left int
	within(t, "Flush", func() { left = p.Flush(5000) })
	if left != 0 || clock.Now() != start || b.Flushes() != 1 {
		t.Fatalf("Flush with nothing outstanding: %d after %v", left, clock.Now().Sub(start))
	}
	p.Close()
	if _, ok := <-p.Events(); ok {
		t.Fatal("Close closes Events()")
	}
	if err := p.Produce(&kafka.Message{}, nil); err == nil {
		t.Fatal("a closed producer refuses messages")
	}
}

func TestFlushWaitsForAStalledBrokerBoundedly(t *testing.T) {
	b, clock := world(t)
	p := producer(t, kafka.ConfigMap{"acks": "all", "message.timeout.ms": 60000})
	b.Stall("orders", 2*time.Second)
	start := clock.Now()
	produce(t, p, "orders", "o-1", "a", nil)
	if clock.Now() != start || len(b.Records("orders")) != 0 || p.Len() != 1 {
		t.Fatal("Produce enqueues and returns; the record waits for the broker")
	}
	var left int
	within(t, "Flush", func() { left = p.Flush(5000) })
	if left != 1 {
		t.Fatalf("the report sits unread in Events(): the real Flush counts it (Len includes len(Events())), got %d", left)
	}
	if got := len(b.Records("orders")); got != 1 {
		t.Fatalf("the stall ended after 2 s: %d records", got)
	}
	if m := report(t, p.Events()); m.TopicPartition.Error != nil {
		t.Fatal(m.TopicPartition.Error)
	}
	within(t, "Flush", func() { left = p.Flush(5000) })
	if left != 0 {
		t.Fatalf("everything delivered and read: Flush returns 0, got %d", left)
	}

	b.Stall("orders", 0)
	ch := make(chan kafka.Event, 4)
	produce(t, p, "orders", "o-2", "b", ch)
	start = clock.Now()
	within(t, "Flush", func() { left = p.Flush(5000) })
	if left != 1 || clock.Now().Sub(start) != 5*time.Second {
		t.Fatalf("a dead broker: Flush(5000) returns 1 after 5 s, got %d after %v", left, clock.Now().Sub(start))
	}
	m := report(t, ch)
	kerr, ok := m.TopicPartition.Error.(kafka.Error)
	if !ok || kerr.Code() != kafka.ErrMsgTimedOut || !kerr.IsTimeout() || !kerr.IsRetriable() {
		t.Fatalf("message.timeout.ms ends the wait with ErrMsgTimedOut: %v", m.TopicPartition.Error)
	}
	if clock.Now().Sub(start) != 60*time.Second {
		t.Fatalf("the report came at the message timeout: %v", clock.Now().Sub(start))
	}
}

func TestOrderSurvivesAStall(t *testing.T) {
	b, _ := world(t)
	p := producer(t, kafka.ConfigMap{})
	b.Stall("t", time.Second)
	produce(t, p, "t", "k", "1", nil)
	b.Resume("t")
	produce(t, p, "t", "k", "2", nil)
	within(t, "Flush", func() { p.Flush(1000) })
	vals := b.Records("t")
	if len(vals) != 2 || string(vals[0].Value) != "1" || string(vals[1].Value) != "2" {
		t.Fatalf("records keep the produce order: %+v", vals)
	}
}

// The poller hands reports out one at a time with a blocking send, as confluent-kafka-go's
// eventPoll does (`*ch <- msg`): a report on an unbuffered channel nobody reads holds back every
// later report, the ones for other channels too, and counts in Len and Flush until it is taken.
func TestUnreadDeliveryChannelBlocksThePoller(t *testing.T) {
	b, _ := world(t)
	p := producer(t, kafka.ConfigMap{"acks": "all"})
	abandoned := make(chan kafka.Event)
	produce(t, p, "t", "a", "1", abandoned)
	later := make(chan kafka.Event, 1)
	produce(t, p, "t", "b", "2", later)
	noReport(t, later, "a report behind one nobody reads")
	var left int
	within(t, "Flush", func() { left = p.Flush(1000) })
	if left != 2 {
		t.Fatalf("both reports are still queued for the application: Flush returns 2, got %d", left)
	}
	<-abandoned
	report(t, later)
	within(t, "Flush", func() { left = p.Flush(1000) })
	if left != 0 {
		t.Fatalf("every report taken: Flush returns 0, got %d", left)
	}

	// The caller gave up on a stalled broker: its report arrives once the broker answers, and
	// blocks the poller from then on.
	b.Stall("s", 0)
	gaveUp := make(chan kafka.Event)
	produce(t, p, "s", "c", "3", gaveUp)
	b.Resume("s")
	next := make(chan kafka.Event, 1)
	produce(t, p, "s", "d", "4", next)
	noReport(t, next, "a report behind one whose caller timed out")
	if m := report(t, gaveUp); m.TopicPartition.Error != nil {
		t.Fatal(m.TopicPartition.Error)
	}
	report(t, next)
}

// Flush returns Len once the timeout passes: messages not yet delivered plus delivery reports
// queued for the application (unread in Events() or not yet handed to their channel). A delivered
// or refused message whose report the application has taken is no longer counted.
func TestFlushCountsReportsQueuedForTheApplication(t *testing.T) {
	b, clock := world(t)
	p := producer(t, kafka.ConfigMap{"acks": "all"})
	var left int
	b.FailNext("t", 1)
	ch := make(chan kafka.Event, 1)
	produce(t, p, "t", "a", "1", ch)
	start := clock.Now()
	within(t, "Flush", func() { left = p.Flush(2000) })
	if left != 0 || clock.Now() != start {
		t.Fatalf("a refused message whose report reached its channel is not pending: Flush %d after %v", left, clock.Now().Sub(start))
	}
	if m := report(t, ch); m.TopicPartition.Error == nil {
		t.Fatal("FailNext refuses the message")
	}
	for _, fail := range []bool{false, true} {
		if fail {
			b.FailNext("t", 1)
		}
		produce(t, p, "t", "b", "2", nil)
		start = clock.Now()
		within(t, "Flush", func() { left = p.Flush(2000) })
		if left != 1 || clock.Now().Sub(start) != 2*time.Second {
			t.Fatalf("refused %v, report unread in Events(): Flush(2000) returns 1 after 2 s, got %d after %v", fail, left, clock.Now().Sub(start))
		}
		if m := report(t, p.Events()); (m.TopicPartition.Error != nil) != fail {
			t.Fatalf("refused %v: report error %v", fail, m.TopicPartition.Error)
		}
	}
	within(t, "Flush", func() { left = p.Flush(2000) })
	if left != 0 {
		t.Fatalf("every report read: Flush returns 0, got %d", left)
	}
}

func TestFailuresAcksAndIdempotence(t *testing.T) {
	b, _ := world(t)
	if _, err := kafka.NewProducer(&kafka.ConfigMap{"acks": 1, "enable.idempotence": true}); err == nil {
		t.Fatal("idempotence requires acks all")
	}
	p := producer(t, kafka.ConfigMap{"enable.idempotence": true})
	ch := make(chan kafka.Event, 4)
	b.FailNext("events", 1)
	produce(t, p, "events", "e1", "p1", ch)
	kerr, ok := report(t, ch).TopicPartition.Error.(kafka.Error)
	if !ok || !kerr.IsRetriable() {
		t.Fatalf("a FailNext is a retriable delivery error: %v", kerr)
	}
	b.LoseAcks("events", 1)
	produce(t, p, "events", "e1", "p1", ch)
	report(t, ch)
	if got := len(b.Records("events")); got != 1 {
		t.Fatalf("an idempotent producer writes a lost-ack retry once: %d", got)
	}
	plain := producer(t, kafka.ConfigMap{"acks": "1"})
	b.LoseAcks("events", 1)
	produce(t, plain, "events", "e2", "p2", ch)
	report(t, ch)
	if got := len(b.Records("events")); got != 3 {
		t.Fatalf("a plain producer duplicates it: %d", got)
	}
	if b.Failover("events") != 2 {
		t.Fatal("acks=1 records are lost in a failover right after the ack")
	}
}

func consumer(t *testing.T, conf kafka.ConfigMap) *kafka.Consumer {
	t.Helper()
	c, err := kafka.NewConsumer(&conf)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConsumerOffsetsAndCommits(t *testing.T) {
	b, clock := world(t)
	if _, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "k"}); err == nil {
		t.Fatal("group.id is required")
	}
	for i := range 4 {
		b.Seed("jobs", i%2, nil, []byte{byte('a' + i)}, nil)
	}
	latest := consumer(t, kafka.ConfigMap{"group.id": "late"})
	if err := latest.Subscribe("jobs", nil); err != nil {
		t.Fatal(err)
	}
	start := clock.Now()
	var ev kafka.Event
	within(t, "Poll", func() { ev = latest.Poll(100) })
	if ev != nil || clock.Now().Sub(start) != 100*time.Millisecond {
		t.Fatalf("latest: nothing old is delivered; Poll waits its timeout: %v after %v", ev, clock.Now().Sub(start))
	}
	latest.Close()

	c := consumer(t, kafka.ConfigMap{"group.id": "workers", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	if err := c.SubscribeTopics([]string{"jobs"}, nil); err != nil {
		t.Fatal(err)
	}
	var msgs []*kafka.Message
	for range 3 {
		var m *kafka.Message
		var err error
		within(t, "ReadMessage", func() { m, err = c.ReadMessage(time.Second) })
		if err != nil {
			t.Fatal(err)
		}
		msgs = append(msgs, m)
	}
	if _, err := c.CommitMessage(msgs[0]); err != nil {
		t.Fatal(err)
	}
	if o, _ := b.CommittedOffset("workers", "jobs", int(msgs[0].TopicPartition.Partition)); o != int64(msgs[0].TopicPartition.Offset)+1 {
		t.Fatal("CommitMessage commits offset+1")
	}
	clock.Advance(10 * time.Second)
	if len(b.Commits("workers")) != 1 {
		t.Fatal("enable.auto.commit false: no timer commits")
	}
	tps, err := c.Commit()
	if err != nil || len(tps) != 2 {
		t.Fatalf("Commit commits the stored offsets of the assignment: %v %v", tps, err)
	}
	if b.Lag("workers", "jobs") != 1 {
		t.Fatalf("lag %d", b.Lag("workers", "jobs"))
	}
	within(t, "ReadMessage", func() {
		if _, err := c.ReadMessage(50 * time.Millisecond); err != nil {
			t.Error(err)
		}
		_, err := c.ReadMessage(50 * time.Millisecond)
		if kerr, ok := err.(kafka.Error); !ok || !kerr.IsTimeout() {
			t.Errorf("a drained topic: ReadMessage times out: %v", err)
		}
	})
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CommitOffsets(nil); err == nil {
		t.Fatal("a closed consumer cannot commit")
	}
	if infos := b.Consumers(); infos[1].AutoCommit || infos[1].Config["auto.offset.reset"] != "earliest" {
		t.Fatalf("consumer info: %+v", infos[1])
	}
}

func TestAutoCommitOnTheTimerAndClose(t *testing.T) {
	b, clock := world(t)
	b.Seed("t", 0, nil, []byte("x"), nil)
	c := consumer(t, kafka.ConfigMap{"group.id": "g", "auto.offset.reset": "earliest", "auto.commit.interval.ms": 1000})
	_ = c.Subscribe("t", nil)
	within(t, "Poll", func() {
		if c.Poll(100) == nil {
			t.Error("no message")
		}
	})
	if len(b.Commits("g")) != 0 {
		t.Fatal("nothing commits before the interval")
	}
	clock.Advance(time.Second)
	if len(b.Commits("g")) != 1 || b.Lag("g", "t") != 0 {
		t.Fatal("the auto-commit timer commits the delivered offset")
	}
	b.Seed("t", 0, nil, []byte("y"), nil)
	within(t, "Poll", func() { c.Poll(100) })
	c.Close()
	if b.Lag("g", "t") != 0 {
		t.Fatal("Close commits what was delivered")
	}
	auto := 0
	for _, e := range b.Events() {
		if e.Kind == "auto-commit" {
			auto++
		}
	}
	if auto != 2 {
		t.Fatalf("auto-commit events: %d", auto)
	}
}

// A loop ctx.Drain runs polls with a timeout that would spend the check's sleep budget one jump at
// a time. Once every record of its assignment was delivered (and auto-committed) the poll waits for
// the next record without moving the clock, as Python's poll ends a drained loop: the drain ends at
// once, and the next Drain sees what was seeded since taken — by the first loop, still polling, or
// the second (its re-subscribe redelivers what was not committed yet, as a rebalance does).
func TestDrainLoopWaitsForTheNextRecordWithoutMovingTheClock(t *testing.T) {
	b, clock := world(t)
	ctx := harness.New(clock)
	var mu sync.Mutex
	loop := func(c *kafka.Consumer, topic string, commit bool, seen *[]string) func() {
		return func() {
			if err := c.Subscribe(topic, nil); err != nil {
				t.Error(err)
				return
			}
			for {
				msg, ok := c.Poll(1000).(*kafka.Message)
				if !ok {
					continue
				}
				mu.Lock()
				*seen = append(*seen, string(msg.Value))
				mu.Unlock()
				if commit {
					if _, err := c.CommitMessage(msg); err != nil {
						t.Error(err)
						return
					}
				}
			}
		}
	}
	taken := func(what string, seen *[]string, want ...string) {
		t.Helper()
		mu.Lock()
		defer mu.Unlock()
		distinct := map[string]bool{}
		for _, v := range *seen {
			distinct[v] = true
		}
		ok := len(distinct) == len(want)
		for _, v := range want {
			ok = ok && distinct[v]
		}
		if !ok {
			t.Fatalf("%s: the loops took %v, want %v", what, *seen, want)
		}
	}

	b.CreateTopic("turns", 1)
	c := consumer(t, kafka.ConfigMap{"group.id": "g", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	var seen []string
	start := clock.Now()
	b.Seed("turns", 0, nil, []byte("a"), nil)
	if ctx.Drain(loop(c, "turns", true, &seen)) {
		t.Fatal("the loop never returns")
	}
	taken("the first drain", &seen, "a")
	if moved := clock.Now().Sub(start); moved != 0 || clock.Jumps() != 0 {
		t.Fatalf("the drained loop moved the clock %v in %d jumps", moved, clock.Jumps())
	}
	b.Seed("turns", 0, nil, []byte("b"), nil)
	b.Seed("turns", 0, nil, []byte("c"), nil)
	ctx.Drain(loop(c, "turns", true, &seen))
	taken("the second drain", &seen, "a", "b", "c")
	if lag, moved := b.Lag("g", "turns"), clock.Now().Sub(start); lag != 0 || moved != 0 {
		t.Fatalf("after the second drain: lag %d, the clock moved %v", lag, moved)
	}

	// With auto-commit the clock moves on to the timer's tick (5 s) that commits what was delivered.
	auto := consumer(t, kafka.ConfigMap{"group.id": "auto", "auto.offset.reset": "earliest"})
	var autoSeen []string
	b.Seed("events", 0, nil, []byte("x"), nil)
	start = clock.Now()
	ctx.Drain(loop(auto, "events", false, &autoSeen))
	taken("the auto-commit drain", &autoSeen, "x")
	if lag, moved := b.Lag("auto", "events"), clock.Now().Sub(start); lag != 0 || moved < 5*time.Second || moved > 6*time.Second {
		t.Fatalf("auto-commit: lag %d after %v; want 0 after the 5 s tick", lag, moved)
	}
}

func TestPauseResumeSeek(t *testing.T) {
	b, _ := world(t)
	for i := range 6 {
		b.Seed("jobs", i%3, nil, []byte{byte('0' + i)}, nil)
	}
	c := consumer(t, kafka.ConfigMap{"group.id": "g", "auto.offset.reset": "earliest", "enable.auto.commit": false})
	_ = c.Subscribe("jobs", nil)
	var first *kafka.Message
	within(t, "Poll", func() { first, _ = c.Poll(100).(*kafka.Message) })
	assigned, _ := c.Assignment()
	if len(assigned) != 3 {
		t.Fatalf("a lone consumer is assigned every partition: %v", assigned)
	}
	_ = c.Pause(assigned)
	within(t, "Poll", func() {
		if ev := c.Poll(50); ev != nil {
			t.Errorf("a paused consumer delivers nothing: %v", ev)
		}
	})
	tp := first.TopicPartition
	_ = c.Resume([]kafka.TopicPartition{tp})
	_ = c.Seek(tp, 0)
	within(t, "Poll", func() {
		m := c.Poll(50).(*kafka.Message)
		if m.TopicPartition.Offset != tp.Offset || m.TopicPartition.Partition != tp.Partition {
			t.Errorf("Seek puts the record back under the cursor: %v", m.TopicPartition)
		}
	})
	low, high, _ := c.GetWatermarkOffsets("jobs", 1)
	if low != 0 || high != 2 {
		t.Fatalf("watermarks %d %d", low, high)
	}
	resumed := make(chan *kafka.Message, 1)
	go func() { resumed <- c.Poll(-1).(*kafka.Message) }()
	time.Sleep(10 * time.Millisecond)
	_ = c.Resume(assigned)
	select {
	case m := <-resumed:
		if m == nil {
			t.Fatal("nil")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Resume wakes a waiting Poll")
	}
}

func TestGroupSplitAndRebalanceCallback(t *testing.T) {
	b, _ := world(t)
	var events []string
	cb := func(c *kafka.Consumer, ev kafka.Event) error {
		switch e := ev.(type) {
		case kafka.AssignedPartitions:
			events = append(events, "assigned "+itoa(len(e.Partitions)))
		case kafka.RevokedPartitions:
			events = append(events, "revoked "+itoa(len(e.Partitions)))
		}
		return nil
	}
	c1 := consumer(t, kafka.ConfigMap{"group.id": "g"})
	_ = c1.Subscribe("t", cb)
	within(t, "Poll", func() { c1.Poll(0) })
	c2 := consumer(t, kafka.ConfigMap{"group.id": "g"})
	_ = c2.Subscribe("t", nil)
	within(t, "Poll", func() { c1.Poll(0); c2.Poll(0) })
	a1, _ := c1.Assignment()
	a2, _ := c2.Assignment()
	if len(a1) != 2 || len(a2) != 1 {
		t.Fatalf("assignments %v %v", a1, a2)
	}
	if len(events) != 3 || events[0] != "assigned 3" || events[1] != "revoked 3" || events[2] != "assigned 2" {
		t.Fatalf("rebalance callback: %v", events)
	}
	_ = b
}

func itoa(n int) string { return string(rune('0' + n)) }
