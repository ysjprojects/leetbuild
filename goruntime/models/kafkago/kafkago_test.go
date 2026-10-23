package kafka_test

import (
	"context"
	"errors"
	"io"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"

	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/models/kafka/kafkatest"
	kafka "leetbuild/goruntime/models/kafkago"
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

func TestSyncWriteLingersForTheBatchAndHashesKeys(t *testing.T) {
	b, clock := world(t)
	w := &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "orders", Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}
	start := clock.Now()
	var err error
	within(t, "WriteMessages", func() {
		err = w.WriteMessages(context.Background(),
			kafka.Message{Key: []byte("o-1"), Value: []byte("placed")},
			kafka.Message{Key: []byte("o-1"), Value: []byte("paid")},
			kafka.Message{Key: []byte("o-2"), Value: []byte("placed")})
	})
	if err != nil {
		t.Fatal(err)
	}
	if waited := clock.Now().Sub(start); waited != time.Second {
		t.Fatalf("a sync write of a partial batch waits BatchTimeout (1 s by default), waited %v", waited)
	}
	recs := b.Records("orders")
	if len(recs) != 3 {
		t.Fatalf("records: %+v", recs)
	}
	for _, r := range recs {
		want := (&kafka.Hash{}).Balance(kafka.Message{Key: r.Key}, 0, 1, 2)
		if r.Partition != want {
			t.Fatalf("%s on partition %d, kafka.Hash says %d", r.Key, r.Partition, want)
		}
	}
	if string(recs[0].Value) != "placed" || string(recs[1].Value) != "paid" {
		t.Fatal("one key keeps its order")
	}
	w.BatchTimeout = 5 * time.Millisecond
	start = clock.Now()
	within(t, "WriteMessages", func() { err = w.WriteMessages(context.Background(), kafka.Message{Value: []byte("x")}) })
	if waited := clock.Now().Sub(start); err != nil || waited != 5*time.Millisecond {
		t.Fatalf("BatchTimeout bounds the linger: %v %v", waited, err)
	}
	if s := w.Stats(); s.Messages != 4 || s.Writes < 2 || s.BatchTimeout != 5*time.Millisecond {
		t.Fatalf("stats: %+v", s)
	}
	within(t, "Close", func() { _ = w.Close() })
	if err := w.WriteMessages(context.Background(), kafka.Message{Value: []byte("late")}); err != io.ErrClosedPipe {
		t.Fatalf("a closed writer refuses writes: %v", err)
	}
}

func TestBatchSizeFlushesAtOnce(t *testing.T) {
	b, clock := world(t)
	w := &kafka.Writer{Addr: kafka.TCP("k"), Topic: "t", Balancer: kafka.BalancerFunc(func(kafka.Message, ...int) int { return 1 }), BatchSize: 2}
	start := clock.Now()
	within(t, "WriteMessages", func() {
		if err := w.WriteMessages(context.Background(), kafka.Message{Value: []byte("a")}, kafka.Message{Value: []byte("b")}); err != nil {
			t.Error(err)
		}
	})
	if clock.Now() != start || b.EndOffset("t", 1) != 2 {
		t.Fatal("a full batch is sent without lingering")
	}
}

func TestAcksAndFailover(t *testing.T) {
	b, _ := world(t)
	for _, acks := range []kafka.RequiredAcks{kafka.RequireAll, kafka.RequireOne} {
		w := &kafka.Writer{Addr: kafka.TCP("k"), Topic: "acks-" + acks.String(), RequiredAcks: acks, BatchTimeout: time.Millisecond}
		within(t, "WriteMessages", func() {
			if err := w.WriteMessages(context.Background(), kafka.Message{Value: []byte("v")}); err != nil {
				t.Error(err)
			}
		})
	}
	b.Failover("")
	if len(b.Records("acks-all")) != 1 || len(b.Records("acks-one")) != 0 {
		t.Fatal("a failover right after the ack loses the RequireOne record only")
	}
}

func TestStallRetriesAndTimeouts(t *testing.T) {
	b, clock := world(t)
	w := &kafka.Writer{Addr: kafka.TCP("k"), Topic: "n", RequiredAcks: kafka.RequireAll, BatchTimeout: time.Millisecond}
	b.Stall("n", time.Second)
	start := clock.Now()
	var err error
	within(t, "WriteMessages", func() { err = w.WriteMessages(context.Background(), kafka.Message{Value: []byte("slow")}) })
	if err != nil || clock.Now().Sub(start) != time.Second || len(b.Records("n")) != 1 {
		t.Fatalf("a stall shorter than WriteTimeout delays the write: %v after %v", err, clock.Now().Sub(start))
	}

	b.Stall("n", 0)
	start = clock.Now()
	within(t, "WriteMessages", func() {
		ctx, cancel := vclock.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		err = w.WriteMessages(ctx, kafka.Message{Value: []byte("dead")})
	})
	if !errors.Is(err, context.DeadlineExceeded) || clock.Now().Sub(start) != 2*time.Second {
		t.Fatalf("the caller's deadline bounds a sync write: %v after %v", err, clock.Now().Sub(start))
	}
	b.Resume("n")
	within(t, "Close", func() { _ = w.Close() })
	if len(b.Records("n")) != 2 {
		t.Fatal("the abandoned batch is still delivered once the broker answers")
	}

	short := &kafka.Writer{Addr: kafka.TCP("k"), Topic: "d", RequiredAcks: kafka.RequireAll, BatchTimeout: time.Millisecond, WriteTimeout: time.Second, MaxAttempts: 2}
	b.Stall("d", 0)
	start = clock.Now()
	within(t, "WriteMessages", func() { err = short.WriteMessages(context.Background(), kafka.Message{Value: []byte("x")}) })
	var werr kafka.WriteErrors
	if !errors.As(err, &werr) || !errors.Is(werr[0], kafka.RequestTimedOut) {
		t.Fatalf("a dead broker fails the write after its attempts: %v", err)
	}
	// 1 ms linger + 1 s attempt + 100 ms backoff + 1 s attempt.
	if waited := clock.Now().Sub(start); waited != 2101*time.Millisecond {
		t.Fatalf("attempts × WriteTimeout + backoff: waited %v", waited)
	}

	lost := &kafka.Writer{Addr: kafka.TCP("k"), Topic: "d", BatchTimeout: time.Millisecond}
	within(t, "WriteMessages", func() { err = lost.WriteMessages(context.Background(), kafka.Message{Value: []byte("gone")}) })
	if err != nil || len(b.Records("d")) != 0 {
		t.Fatal("RequireNone on a stalled broker: no error, no record")
	}
	if len(stalls(b, "n")) != 2 {
		t.Fatalf("produce-stalled events: %v", stalls(b, "n"))
	}
}

func stalls(b *mk.Broker, topic string) []mk.Event {
	var out []mk.Event
	for _, e := range b.Events() {
		if e.Kind == "produce-stalled" && e.Topic == topic {
			out = append(out, e)
		}
	}
	return out
}

func TestFailNextFailsOneMessage(t *testing.T) {
	b, _ := world(t)
	w := &kafka.Writer{Addr: kafka.TCP("k"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll, BatchTimeout: time.Millisecond}
	b.FailNext("payments", 1)
	var err error
	within(t, "WriteMessages", func() {
		err = w.WriteMessages(context.Background(),
			kafka.Message{Topic: "payments", Key: []byte("m-1"), Value: []byte("e1")},
			kafka.Message{Topic: "payments", Key: []byte("m-1"), Value: []byte("e2")},
			kafka.Message{Topic: "refunds", Key: []byte("m-1"), Value: []byte("e3")})
	})
	var werr kafka.WriteErrors
	if !errors.As(err, &werr) || werr.Count() != 1 || werr[0] == nil || werr[1] != nil || werr[2] != nil {
		t.Fatalf("WriteErrors per message: %v", err)
	}
	if len(b.Records("payments")) != 1 || len(b.Records("refunds")) != 1 {
		t.Fatal("the other messages land")
	}
	if err := w.WriteMessages(context.Background(), kafka.Message{Value: []byte("x")}); err == nil {
		t.Fatal("a message needs a topic")
	}
}

func TestAsyncCompletion(t *testing.T) {
	b, clock := world(t)
	var mu sync.Mutex
	var got []string
	var errs int
	w := &kafka.Writer{
		Addr: kafka.TCP("k"), Topic: "clicks", Async: true, BatchTimeout: 10 * time.Millisecond, RequiredAcks: kafka.RequireOne,
		Completion: func(messages []kafka.Message, err error) {
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs++
				return
			}
			for _, m := range messages {
				got = append(got, string(m.Value))
			}
		},
	}
	b.FailNext("clicks", 1)
	start := clock.Now()
	for _, v := range []string{"a", "b"} {
		if err := w.WriteMessages(context.Background(), kafka.Message{Value: []byte(v)}); err != nil {
			t.Fatal(err)
		}
	}
	if clock.Now() != start || len(b.Records("clicks")) != 0 {
		t.Fatal("an async write returns at once; the batch lingers")
	}
	within(t, "Close", func() { _ = w.Close() })
	mu.Lock()
	defer mu.Unlock()
	if errs != 1 || !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("Completion saw %v and %d failures", got, errs)
	}
}

func seed(b *mk.Broker, topic string, n int) {
	for i := range n {
		b.Seed(topic, i%3, []byte{byte('k')}, []byte{byte('0' + i)}, nil)
	}
}

func TestGroupReaderFetchCommitResume(t *testing.T) {
	b, _ := world(t)
	seed(b, "payments", 6)
	cfg := kafka.ReaderConfig{Brokers: []string{"k"}, GroupID: "ledger", Topic: "payments"}
	r := kafka.NewReader(cfg)
	ctx := context.Background()
	var msgs []kafka.Message
	for range 4 {
		m, err := r.FetchMessage(ctx)
		if err != nil {
			t.Fatal(err)
		}
		msgs = append(msgs, m)
	}
	if b.Lag("ledger", "payments") != 6 {
		t.Fatal("FetchMessage does not commit")
	}
	if err := r.CommitMessages(ctx, msgs...); err != nil {
		t.Fatal(err)
	}
	if lag := b.Lag("ledger", "payments"); lag != 2 {
		t.Fatalf("CommitMessages commits offset+1 per partition: lag %d", lag)
	}
	r.Close()
	if _, err := r.FetchMessage(ctx); err != io.EOF {
		t.Fatalf("a closed reader returns io.EOF: %v", err)
	}
	r2 := kafka.NewReader(cfg)
	m, err := r2.ReadMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if m.Offset != 1 {
		t.Fatalf("a new member resumes from the committed offsets: got offset %d on %d", m.Offset, m.Partition)
	}
	if b.Lag("ledger", "payments") != 1 {
		t.Fatal("ReadMessage commits what it returns")
	}
	kinds := map[string]int{}
	for _, e := range b.Events() {
		kinds[e.Kind]++
	}
	if kinds["manual-commit"] != 1 || kinds["auto-commit"] != 1 || kinds["deliver"] != 5 || kinds["close"] != 1 || kinds["subscribe"] != 2 {
		t.Fatalf("events: %v", kinds)
	}
	infos := b.Consumers()
	if len(infos) != 2 || infos[1].Group != "ledger" || !infos[1].AutoCommit || infos[0].AutoCommit {
		t.Fatalf("consumers: %+v", infos)
	}
	if _, delivered, commits := b.Metrics(); delivered != 5 || commits != 2 {
		t.Fatalf("metrics: %d delivered, %d commits", delivered, commits)
	}
}

func TestReaderBlocksUntilARecordArrives(t *testing.T) {
	b, _ := world(t)
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"k"}, GroupID: "g", Topic: "t", StartOffset: kafka.LastOffset})
	b.Seed("t", 0, nil, []byte("before"), nil)
	got := make(chan string, 1)
	go func() {
		m, err := r.FetchMessage(context.Background())
		if err != nil {
			got <- err.Error()
			return
		}
		got <- string(m.Value)
	}()
	time.Sleep(20 * time.Millisecond)
	select {
	case v := <-got:
		t.Fatalf("FetchMessage returned %q with nothing new on the topic", v)
	default:
	}
	b.Seed("t", 1, nil, []byte("after"), nil)
	select {
	case v := <-got:
		if v != "before" && v != "after" {
			t.Fatal(v)
		}
		if v == "before" {
			t.Fatal("LastOffset: the group started at the end offsets of its first fetch... got the older record")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("an append wakes the reader")
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()
	if _, err := r.FetchMessage(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("a canceled context ends the fetch: %v", err)
	}
}

func TestGroupMembersSplitPartitions(t *testing.T) {
	b, _ := world(t)
	cfg := kafka.ReaderConfig{Brokers: []string{"k"}, GroupID: "g", Topic: "t"}
	r1, r2 := kafka.NewReader(cfg), kafka.NewReader(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	partitions := func(r *kafka.Reader, n int, out chan<- map[int]bool) {
		got := map[int]bool{}
		for range n {
			m, err := r.FetchMessage(ctx)
			if err != nil {
				break
			}
			got[m.Partition] = true
		}
		out <- got
	}
	first, second := make(chan map[int]bool, 1), make(chan map[int]bool, 1)
	// Both members wait inside a fetch (alive) on an empty topic: the second join rebalances at once.
	go partitions(r1, 4, first)
	for len(b.Consumers()[0].Topics) == 0 || len(b.Events()) < 3 {
		runtime.Gosched()
	}
	go partitions(r2, 2, second)
	for {
		subs := 0
		for _, e := range b.Events() {
			if e.Kind == "subscribe" {
				subs++
			}
		}
		if subs == 2 {
			break
		}
		runtime.Gosched()
	}
	seed(b, "t", 6)
	// Range assignment in join order: r1 partitions 0-1, r2 partition 2.
	if got := <-first; !reflect.DeepEqual(got, map[int]bool{0: true, 1: true}) {
		t.Fatalf("the first member owns partitions 0 and 1: %v", got)
	}
	if got := <-second; !reflect.DeepEqual(got, map[int]bool{2: true}) {
		t.Fatalf("the second member owns partition 2 only: %v", got)
	}
	infos := b.Consumers()
	if len(infos[0].Assignment) != 2 || len(infos[1].Assignment) != 1 {
		t.Fatalf("assignments: %+v", infos)
	}
}

func TestPartitionReaderAndConn(t *testing.T) {
	b, _ := world(t)
	seed(b, "kv", 7)
	conn, err := kafka.DialLeader(context.Background(), "tcp", "kafka:9092", "kv", 1)
	if err != nil {
		t.Fatal(err)
	}
	last, err := conn.ReadLastOffset()
	conn.Close()
	if err != nil || last != 2 {
		t.Fatalf("ReadLastOffset: %d %v", last, err)
	}
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"k"}, Topic: "kv", Partition: 1})
	if err := r.SetOffset(1); err != nil {
		t.Fatal(err)
	}
	m, err := r.FetchMessage(context.Background())
	if err != nil || m.Offset != 1 || m.Partition != 1 || m.HighWaterMark != 2 {
		t.Fatalf("partition reader: %+v %v", m, err)
	}
	if r.Offset() != 2 || r.Lag() != 0 {
		t.Fatalf("offset %d lag %d", r.Offset(), r.Lag())
	}
	if err := r.CommitMessages(context.Background(), m); err == nil {
		t.Fatal("a reader without a group cannot commit")
	}
	if _, err := kafka.DialLeader(context.Background(), "tcp", "k", "kv", 5); err == nil {
		t.Fatal("no partition 5")
	}
	c, _ := kafka.Dial("tcp", "k")
	if err := c.CreateTopics(kafka.TopicConfig{Topic: "wide", NumPartitions: 6, ReplicationFactor: 1}); err != nil || b.Partitions("wide") != 6 {
		t.Fatal("CreateTopics")
	}
	if ps, _ := c.ReadPartitions("wide"); len(ps) != 6 {
		t.Fatal("ReadPartitions")
	}
}

func TestResetParksAStaleReader(t *testing.T) {
	b, _ := world(t)
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"k"}, GroupID: "g", Topic: "t"})
	returned := make(chan error, 1)
	go func() {
		_, err := r.FetchMessage(context.Background())
		returned <- err
	}()
	time.Sleep(10 * time.Millisecond)
	mk.Reset()
	b.Seed("t", 0, nil, []byte("new world"), nil)
	select {
	case err := <-returned:
		t.Fatalf("a reader of the previous check returned (%v) instead of parking", err)
	case <-time.After(50 * time.Millisecond):
	}
	if len(b.Events()) != 1 {
		t.Fatalf("the stale reader touched the new world: %v", b.Events())
	}
}

func TestBalancersAreTheLibrarys(t *testing.T) {
	msg := kafka.Message{Key: []byte("user-42")}
	parts := []int{0, 1, 2, 3, 4, 5}
	// Reference values computed with github.com/segmentio/kafka-go v0.4.51.
	got := []int{
		(&kafka.Hash{}).Balance(msg, parts...),
		(&kafka.ReferenceHash{}).Balance(msg, parts...),
		kafka.CRC32Balancer{}.Balance(msg, parts...),
		kafka.Murmur2Balancer{}.Balance(msg, parts...),
	}
	if !reflect.DeepEqual(got, referenceBalances) {
		t.Fatalf("balances %v, the library gives %v", got, referenceBalances)
	}
	rr := &kafka.RoundRobin{}
	if rr.Balance(msg, 0, 1, 2) != 0 || rr.Balance(msg, 0, 1, 2) != 1 {
		t.Fatal("round robin")
	}
	lb := &kafka.LeastBytes{}
	if lb.Balance(kafka.Message{Value: []byte("xxxx")}, 0, 1) != 0 || lb.Balance(kafka.Message{Value: []byte("y")}, 0, 1) != 1 {
		t.Fatal("least bytes")
	}
}

var referenceBalances = []int{3, 3, 1, 4}

func TestLastOffsetReadsWhatASubscribeHookSeeds(t *testing.T) {
	b, _ := world(t)
	b.Seed("chat", 0, []byte("room"), []byte("yesterday"), nil)
	b.OnSubscribe(func(string, []string) { b.Seed("chat", 0, []byte("room"), []byte("now"), nil) })
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"k"}, GroupID: "fresh", Topic: "chat", StartOffset: kafka.LastOffset})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	m, err := r.ReadMessage(ctx)
	if err != nil || string(m.Value) != "now" {
		t.Fatalf("a new group at LastOffset starts at the end as of its assignment: got %q, %v", m.Value, err)
	}
}

func TestCancelEndsAStalledSyncWrite(t *testing.T) {
	b, clock := world(t)
	w := &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "outbox", Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}
	b.Stall("outbox", 0)
	c, cancel := context.WithCancel(context.Background())
	go func() {
		vclock.Sleep(3 * time.Second)
		cancel()
	}()
	start := clock.Now()
	var err error
	within(t, "WriteMessages", func() { err = w.WriteMessages(c, kafka.Message{Key: []byte("k"), Value: []byte("v")}) })
	if !errors.Is(err, context.Canceled) || clock.Now().Sub(start) != 3*time.Second {
		t.Fatalf("a canceled context ends a stalled sync write: %v after %v", err, clock.Now().Sub(start))
	}
}
