package kafka

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

// The Writer type provides the implementation of a producer of kafka messages
// that automatically distributes messages across partitions of a single topic
// using a configurable balancing policy.
//
// As in the library, messages wait in a per-partition batch until BatchSize messages are in it or
// BatchTimeout (default 1 s) has passed since its first message; a synchronous WriteMessages
// returns once every batch holding its messages was acknowledged. RequiredAcks defaults to
// RequireNone (0) — the zero value — as in the library. On a stalled broker a batch waits
// WriteTimeout (default 10 s) per attempt, MaxAttempts times (default 10), with backoff between
// attempts, then fails with RequestTimedOut.
type Writer struct {
	// Address of the kafka cluster that this writer is configured to send
	// messages to.
	Addr net.Addr

	// Topic is the name of the topic that the writer will produce messages to.
	Topic string

	// The balancer used to distribute messages across partitions.
	//
	// The default is to use a round-robin distribution.
	Balancer Balancer

	// Limit on how many attempts will be made to deliver a message.
	//
	// The default is to try at most 10 times.
	MaxAttempts int

	// WriteBackoffMin optionally sets the smallest amount of time the writer waits before
	// it attempts to write a batch of messages
	//
	// Default: 100ms
	WriteBackoffMin time.Duration

	// WriteBackoffMax optionally sets the maximum amount of time the writer waits before
	// it attempts to write a batch of messages
	//
	// Default: 1s
	WriteBackoffMax time.Duration

	// Limit on how many messages will be buffered before being sent to a
	// partition.
	//
	// The default is to use a target batch size of 100 messages.
	BatchSize int

	// Limit the maximum size of a request in bytes before being sent to
	// a partition.
	//
	// The default is to use a kafka default value of 1048576.
	BatchBytes int64

	// Time limit on how often incomplete message batches will be flushed to
	// kafka.
	//
	// The default is to flush at least every second.
	BatchTimeout time.Duration

	// Timeout for read operations performed by the Writer.
	//
	// Defaults to 10 seconds.
	ReadTimeout time.Duration

	// Timeout for write operation performed by the Writer.
	//
	// Defaults to 10 seconds.
	WriteTimeout time.Duration

	// Number of acknowledges from partition replicas required before receiving
	// a response to a produce request, the following values are supported:
	//
	//  RequireNone (0)  fire-and-forget, do not wait for acknowledgements from the
	//  RequireOne  (1)  wait for the leader to acknowledge the writes
	//  RequireAll  (-1) wait for the full ISR to acknowledge the writes
	//
	// Defaults to RequireNone.
	RequiredAcks RequiredAcks

	// Setting this flag to true causes the WriteMessages method to never block.
	// It also means that errors are ignored since the caller will not receive
	// the returned value. Use this only if you don't care about guarantees of
	// whether the messages were written to kafka.
	//
	// Defaults to false.
	Async bool

	// An optional function called when the writer succeeds or fails the
	// delivery of messages to a kafka partition. When writing the messages
	// fails, the `err` parameter will be non-nil.
	//
	// The messages that the Completion function is called with have their
	// topic, partition, offset, and time set based on the Produce responses
	// received from kafka. All messages passed to a call to the function have
	// been written to the same partition. The keys and values of messages are
	// referencing the original byte slices carried by messages in the calls to
	// WriteMessages.
	//
	// The function is called from goroutines started by the writer. Calls to
	// Close will block on the Completion function calls. When the Writer is
	// not writing asynchronously, the WriteMessages call will also block on
	// Completion function, which is a useful guarantee if the byte slices
	// for the message keys and values are intended to be reused after the
	// WriteMessages call returned.
	//
	// If a completion function panics, the program terminates because the
	// panic is not recovered by the writer and bubbles up to the top of the
	// goroutine's call stack.
	Completion func(messages []Message, err error)

	// Compression set the compression codec to be used to compress messages.
	Compression Compression

	// If not nil, specifies a logger used to report internal changes within the
	// writer.
	Logger Logger

	// ErrorLogger is the logger used to report errors. If nil, the writer falls
	// back to using Logger instead.
	ErrorLogger Logger

	// AllowAutoTopicCreation notifies writer to create topic if missing.
	AllowAutoTopicCreation bool

	mu         sync.Mutex
	started    bool
	epoch      int
	closed     bool
	writers    map[mk.TopicPartition]*partitionWriter
	order      []*partitionWriter
	group      sync.WaitGroup
	roundRobin RoundRobin
	smu        sync.Mutex
	stats      writerStats
	// completions run one at a time, in order, on a goroutine of the writer.
	completions []func()
	completing  bool
}

type writerStats struct {
	writes, messages, bytes, errors, retries int64
	batchSize, batchBytes                    summary
	batchTime, writeTime                     summary
}

// WriterStats is a data structure returned by a call to Writer.Stats that
// exposes details about the behavior of the writer.
type WriterStats struct {
	Writes   int64 `metric:"kafka.writer.write.count"     type:"counter"`
	Messages int64 `metric:"kafka.writer.message.count"   type:"counter"`
	Bytes    int64 `metric:"kafka.writer.message.bytes"   type:"counter"`
	Errors   int64 `metric:"kafka.writer.error.count"     type:"counter"`

	BatchTime      DurationStats `metric:"kafka.writer.batch.seconds"`
	BatchQueueTime DurationStats `metric:"kafka.writer.batch.queue.seconds"`
	WriteTime      DurationStats `metric:"kafka.writer.write.seconds"`
	WaitTime       DurationStats `metric:"kafka.writer.wait.seconds"`
	Retries        int64         `metric:"kafka.writer.retries.count" type:"counter"`
	BatchSize      SummaryStats  `metric:"kafka.writer.batch.size"`
	BatchBytes     SummaryStats  `metric:"kafka.writer.batch.bytes"`

	MaxAttempts     int64         `metric:"kafka.writer.attempts.max"  type:"gauge"`
	WriteBackoffMin time.Duration `metric:"kafka.writer.backoff.min"   type:"gauge"`
	WriteBackoffMax time.Duration `metric:"kafka.writer.backoff.max"   type:"gauge"`
	MaxBatchSize    int64         `metric:"kafka.writer.batch.max"     type:"gauge"`
	BatchTimeout    time.Duration `metric:"kafka.writer.batch.timeout" type:"gauge"`
	ReadTimeout     time.Duration `metric:"kafka.writer.read.timeout"  type:"gauge"`
	WriteTimeout    time.Duration `metric:"kafka.writer.write.timeout" type:"gauge"`
	RequiredAcks    int64         `metric:"kafka.writer.acks.required" type:"gauge"`
	Async           bool          `metric:"kafka.writer.async"         type:"gauge"`

	Topic string `tag:"topic"`

	// DEPRECATED: these fields will only be reported for backward compatibility
	// if the Writer was constructed with NewWriter.
	Dials    int64         `metric:"kafka.writer.dial.count" type:"counter"`
	DialTime DurationStats `metric:"kafka.writer.dial.seconds"`

	// DEPRECATED: these fields were meaningful prior to kafka-go 0.4, changes
	// to the internal implementation and the introduction of the transport type
	// made them unnecessary.
	//
	// The values will be zero but are left for backward compatibility to avoid
	// breaking programs that used these fields.
	Rebalances        int64
	RebalanceInterval time.Duration
	QueueLength       int64
	QueueCapacity     int64
	ClientID          string
}

// partitionWriter sends one partition's batches, one at a time, in order.
type partitionWriter struct {
	key   mk.TopicPartition
	curr  *writeBatch
	queue []*writeBatch
	busy  bool
}

type writeBatch struct {
	key   mk.TopicPartition
	msgs  []Message
	bytes int64
	time  time.Time
	timer *vclock.Timer
	done  chan struct{}
	// errs is each message's outcome once done is closed.
	errs []error
}

func (w *Writer) maxAttempts() int {
	if w.MaxAttempts > 0 {
		return w.MaxAttempts
	}
	return 10
}

func (w *Writer) writeBackoffMin() time.Duration {
	if w.WriteBackoffMin > 0 {
		return w.WriteBackoffMin
	}
	return 100 * time.Millisecond
}

func (w *Writer) writeBackoffMax() time.Duration {
	if w.WriteBackoffMax > 0 {
		return w.WriteBackoffMax
	}
	return 1 * time.Second
}

func (w *Writer) batchSize() int {
	if w.BatchSize > 0 {
		return w.BatchSize
	}
	return 100
}

func (w *Writer) batchBytes() int64 {
	if w.BatchBytes > 0 {
		return w.BatchBytes
	}
	return 1048576
}

func (w *Writer) batchTimeout() time.Duration {
	if w.BatchTimeout > 0 {
		return w.BatchTimeout
	}
	return 1 * time.Second
}

func (w *Writer) readTimeout() time.Duration {
	if w.ReadTimeout > 0 {
		return w.ReadTimeout
	}
	return 10 * time.Second
}

func (w *Writer) writeTimeout() time.Duration {
	if w.WriteTimeout > 0 {
		return w.WriteTimeout
	}
	return 10 * time.Second
}

func (w *Writer) balancer() Balancer {
	if w.Balancer != nil {
		return w.Balancer
	}
	return &w.roundRobin
}

// enter marks the writer used (its world is the one of its first use) and reports whether it is
// still open; a writer of a previous check parks.
func (w *Writer) enter() bool {
	b := broker()
	w.mu.Lock()
	if !w.started {
		w.started = true
		w.epoch = b.Epoch()
		w.mu.Unlock()
		b.Log(mk.Event{Kind: "producer", Client: "kafka-go"})
		w.mu.Lock()
	}
	stale := b.Stale(w.epoch)
	closed := w.closed
	w.mu.Unlock()
	if stale {
		mk.Park()
	}
	return !closed
}

func (w *Writer) chooseTopic(msg Message) (string, error) {
	if w.Topic != "" && msg.Topic != "" {
		return "", errors.New("kafka.(*Writer): Topic must not be specified for both Writer and Message")
	} else if w.Topic == "" && msg.Topic == "" {
		return "", errors.New("kafka.(*Writer): Topic must be specified for Writer or Message")
	}
	if msg.Topic != "" {
		return msg.Topic, nil
	}
	return w.Topic, nil
}

// WriteMessages writes a batch of messages to the kafka topic configured on this
// writer.
//
// Unless the writer was configured to write messages asynchronously, the method
// blocks until all messages have been written, or until the maximum number of
// attempts was reached.
//
// When sending synchronously and the writer's batch size is configured to be
// greater than 1, this method blocks until either a full batch can be assembled
// or the batch timeout is reached.  The batch size and timeouts are evaluated
// per partition, so the choice of Balancer can also influence the flushing
// behavior.  For example, the Hash balancer will require on average N * batch
// size messages to trigger a flush where N is the number of partitions.  The
// best way to achieve good batching behavior is to share one Writer amongst
// multiple go routines.
//
// When the method returns an error, it may be of type kafka.WriteError to allow
// the caller to determine the status of each message.
//
// The context passed as first argument may also be used to asynchronously
// cancel the operation. Note that in this case there are no guarantees made on
// whether messages were written to kafka, they might also still be written
// after this method has already returned, therefore it is important to not
// modify byte slices of passed messages if WriteMessages returned early due
// to a canceled context.
// The program should assume that the whole batch failed and re-write the
// messages later (which could then cause duplicates).
func (w *Writer) WriteMessages(ctx context.Context, msgs ...Message) error {
	if w.Addr == nil {
		return errors.New("kafka.(*Writer).WriteMessages: cannot create a kafka writer with a nil address")
	}
	if !w.enter() {
		return io.ErrClosedPipe
	}
	if len(msgs) == 0 {
		return nil
	}
	balancer := w.balancer()
	batchBytes := w.batchBytes()
	for i := range msgs {
		if int64(msgs[i].totalSize()) > batchBytes {
			return messageTooLarge(msgs, i)
		}
	}
	b := broker()
	keys := make([]mk.TopicPartition, len(msgs))
	for i, msg := range msgs {
		topic, err := w.chooseTopic(msg)
		if err != nil {
			return err
		}
		n := b.Partitions(topic)
		keys[i] = mk.TopicPartition{Topic: topic, Partition: balancer.Balance(msg, loadCachedPartitions(n)...)}
	}

	type slot struct {
		batch *writeBatch
		index int
	}
	slots := make([]slot, len(msgs))
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return io.ErrClosedPipe
	}
	if w.writers == nil {
		w.writers = map[mk.TopicPartition]*partitionWriter{}
	}
	for i, msg := range msgs {
		pw := w.writers[keys[i]]
		if pw == nil {
			pw = &partitionWriter{key: keys[i]}
			w.writers[keys[i]] = pw
			w.order = append(w.order, pw)
		}
		if pw.curr == nil {
			pw.curr = w.newBatchLocked(pw)
		}
		batch := pw.curr
		msg.Topic = keys[i].Topic
		batch.msgs = append(batch.msgs, msg)
		batch.bytes += int64(msg.totalSize())
		slots[i] = slot{batch, len(batch.msgs) - 1}
		if len(batch.msgs) >= w.batchSize() || batch.bytes >= batchBytes {
			pw.curr = nil
			w.dispatchLocked(pw, batch)
		}
	}
	w.mu.Unlock()
	if w.Async {
		return nil
	}

	done := ctx.Done()
	failed := false
	for _, s := range slots {
		select {
		case <-done:
			return ctx.Err()
		case <-s.batch.done:
			if s.batch.errs[s.index] != nil {
				failed = true
			}
		}
	}
	if !failed {
		return nil
	}
	werr := make(WriteErrors, len(msgs))
	for i, s := range slots {
		werr[i] = s.batch.errs[s.index]
	}
	return werr
}

func (w *Writer) newBatchLocked(pw *partitionWriter) *writeBatch {
	batch := &writeBatch{key: pw.key, time: vclock.Now(), done: make(chan struct{})}
	w.group.Add(1)
	epoch := w.epoch
	batch.timer = vclock.AfterFunc(w.batchTimeout(), func() {
		if broker().Stale(epoch) {
			return
		}
		w.mu.Lock()
		defer w.mu.Unlock()
		if pw.curr == batch {
			pw.curr = nil
			w.dispatchLocked(pw, batch)
		}
	})
	return batch
}

// dispatchLocked queues a full or timed-out batch on its partition; an idle partition writes it at
// once when the broker answers, or hands it to a goroutine that waits for the broker.
func (w *Writer) dispatchLocked(pw *partitionWriter, batch *writeBatch) {
	batch.timer.Stop()
	pw.queue = append(pw.queue, batch)
	if pw.busy {
		return
	}
	pw.busy = true
	w.drainLocked(pw)
}

// drainLocked writes the partition's queued batches while the broker answers; on a stall it
// leaves the rest to a waiting goroutine (pw stays busy).
func (w *Writer) drainLocked(pw *partitionWriter) {
	b := broker()
	for len(pw.queue) > 0 {
		batch := pw.queue[0]
		if _, stalled := b.StalledUntil(batch.key.Topic); stalled && w.RequiredAcks != RequireNone {
			for range batch.msgs {
				b.Log(mk.Event{Kind: "produce-stalled", Topic: batch.key.Topic})
			}
			go w.waitAndWrite(pw)
			return
		}
		pw.queue = pw.queue[1:]
		w.completeLocked(batch, w.produce(batch))
	}
	pw.busy = false
}

// waitAndWrite is the partition writer on a stalled broker: each attempt waits for the broker until
// WriteTimeout, attempts are spaced by the backoff, the last one failing fails the batch.
func (w *Writer) waitAndWrite(pw *partitionWriter) {
	b := broker()
	w.mu.Lock()
	epoch := w.epoch
	batch := pw.queue[0]
	w.mu.Unlock()
	topic := batch.key.Topic
	var errs []error
	for attempt, attempts := 0, w.maxAttempts(); attempt < attempts && errs == nil; attempt++ {
		if attempt != 0 {
			w.smu.Lock()
			w.stats.retries++
			w.smu.Unlock()
			vclock.Sleep(backoff(attempt, w.writeBackoffMin(), w.writeBackoffMax()))
		}
		deadline := vclock.Now().Add(w.writeTimeout())
		for {
			changed := b.Changed()
			if b.Stale(epoch) {
				mk.Park()
			}
			until, stalled := b.StalledUntil(topic)
			if !stalled {
				errs = w.produce(batch)
				break
			}
			now := vclock.Now()
			if !now.Before(deadline) {
				w.smu.Lock()
				w.stats.writes++
				w.stats.errors++
				w.smu.Unlock()
				break
			}
			wake := deadline
			if !until.IsZero() && until.Before(wake) {
				wake = until
			}
			t := vclock.NewTimer(wake.Sub(now))
			select {
			case <-changed:
			case <-t.C:
			}
			t.Stop()
		}
	}
	if errs == nil {
		errs = make([]error, len(batch.msgs))
		for i := range errs {
			errs[i] = RequestTimedOut
		}
		b.Log(mk.Event{Kind: "produce-timed-out", Topic: topic})
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if b.Stale(epoch) {
		return
	}
	pw.queue = pw.queue[1:]
	w.completeLocked(batch, errs)
	w.drainLocked(pw)
}

// produce writes the batch's messages to a broker that answers; each message's outcome.
func (w *Writer) produce(batch *writeBatch) []error {
	b := broker()
	errs := make([]error, len(batch.msgs))
	_, stalled := b.StalledUntil(batch.key.Topic)
	for i := range batch.msgs {
		m := &batch.msgs[i]
		m.Partition = batch.key.Partition
		if b.TakeFailure(batch.key.Topic) {
			errs[i] = RequestTimedOut
			continue
		}
		if stalled {
			// acks=0 on a stalled broker: nobody waits for an answer, the record is gone.
			b.Log(mk.Event{Kind: "produce-lost", Topic: batch.key.Topic})
			m.Offset = -1
			continue
		}
		r := b.Write(mk.Write{
			Topic:     batch.key.Topic,
			Partition: batch.key.Partition,
			Key:       m.Key,
			Value:     m.Value,
			Headers:   toHeaders(m.Headers),
			Time:      m.Time,
			Acks:      int(w.RequiredAcks),
		})
		m.Offset = r.Offset
		if m.Time.IsZero() {
			m.Time = r.Timestamp
		}
	}
	w.smu.Lock()
	w.stats.writes++
	w.stats.messages += int64(len(batch.msgs))
	w.stats.bytes += batch.bytes
	w.stats.batchSize.observe(int64(len(batch.msgs)))
	w.stats.batchBytes.observe(batch.bytes)
	w.stats.batchTime.observe(int64(vclock.Since(batch.time)))
	for _, err := range errs {
		if err != nil {
			w.stats.errors++
			break
		}
	}
	w.smu.Unlock()
	return errs
}

// completeLocked settles the batch: its waiters wake once Completion (if any) has seen it.
func (w *Writer) completeLocked(batch *writeBatch, errs []error) {
	batch.errs = errs
	finish := func() {
		close(batch.done)
		w.group.Done()
	}
	if w.Completion == nil {
		finish()
		return
	}
	completion := w.Completion
	var ok, failed []Message
	var failure error
	for i, m := range batch.msgs {
		if errs[i] == nil {
			ok = append(ok, m)
		} else {
			failed = append(failed, m)
			failure = errs[i]
		}
	}
	w.completions = append(w.completions, func() {
		defer finish()
		defer world.Recover()
		if len(ok) > 0 {
			completion(ok, nil)
		}
		if len(failed) > 0 {
			completion(failed, failure)
		}
	})
	if !w.completing {
		w.completing = true
		go w.runCompletions()
	}
}

func (w *Writer) runCompletions() {
	for {
		w.mu.Lock()
		if len(w.completions) == 0 {
			w.completing = false
			w.mu.Unlock()
			return
		}
		job := w.completions[0]
		w.completions = w.completions[1:]
		w.mu.Unlock()
		job()
	}
}

// Close flushes pending writes, and waits for all writes to complete before
// returning. Calling Close also prevents new writes from being submitted to
// the Writer, further calls to WriteMessages and the like will fail with
// io.ErrClosedPipe.
func (w *Writer) Close() error {
	w.mu.Lock()
	if w.started && broker().Stale(w.epoch) {
		w.mu.Unlock()
		mk.Park()
	}
	w.closed = true
	for _, pw := range w.order {
		if pw.curr != nil {
			batch := pw.curr
			pw.curr = nil
			w.dispatchLocked(pw, batch)
		}
	}
	w.mu.Unlock()
	w.group.Wait()
	return nil
}

// Stats returns a snapshot of the writer stats since the last time the method
// was called, or since the writer was created if it is called for the first
// time.
//
// A typical use of this method is to spawn a goroutine that will periodically
// call Stats on a kafka writer and report the metrics to a stats collection
// system.
func (w *Writer) Stats() WriterStats {
	w.smu.Lock()
	s := w.stats
	w.stats = writerStats{}
	w.smu.Unlock()
	return WriterStats{
		Writes:          s.writes,
		Messages:        s.messages,
		Bytes:           s.bytes,
		Errors:          s.errors,
		BatchTime:       s.batchTime.snapshotDuration(),
		WriteTime:       s.writeTime.snapshotDuration(),
		Retries:         s.retries,
		BatchSize:       s.batchSize.snapshot(),
		BatchBytes:      s.batchBytes.snapshot(),
		MaxAttempts:     int64(w.maxAttempts()),
		WriteBackoffMin: w.writeBackoffMin(),
		WriteBackoffMax: w.writeBackoffMax(),
		MaxBatchSize:    int64(w.batchSize()),
		BatchTimeout:    w.batchTimeout(),
		ReadTimeout:     w.readTimeout(),
		WriteTimeout:    w.writeTimeout(),
		RequiredAcks:    int64(w.RequiredAcks),
		Async:           w.Async,
		Topic:           w.Topic,
	}
}

var (
	partitionsMu    sync.Mutex
	partitionsCache []int
)

func loadCachedPartitions(numPartitions int) []int {
	partitionsMu.Lock()
	defer partitionsMu.Unlock()
	if len(partitionsCache) < numPartitions {
		partitionsCache = make([]int, ((numPartitions/128)+1)*128)
		for i := range partitionsCache {
			partitionsCache[i] = i
		}
	}
	return partitionsCache[:numPartitions]
}
