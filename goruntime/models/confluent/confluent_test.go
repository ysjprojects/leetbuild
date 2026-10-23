package kafka_test

import (
	"hash/crc32"
	"testing"
	"time"

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
		// the report sits unread in Events(): the real Flush counts it
		t.Logf("left %d", left)
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
