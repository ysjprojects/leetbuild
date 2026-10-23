package kafka

import (
	"fmt"
	"strings"
	"sync"
	"time"

	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

const (
	// PurgeInFlight purges messages in-flight to or from the broker.
	// Purging these messages will void any future acknowledgements from the
	// broker, making it impossible for the application to know if these
	// messages were successfully delivered or not.
	// Retrying these messages may lead to duplicates.
	PurgeInFlight = int(0x2)

	// PurgeQueue Purge messages in internal queues.
	PurgeQueue = int(0x1)

	// PurgeNonBlocking Don't wait for background thread queue purging to finish.
	PurgeNonBlocking = int(0x4)
)

var clientSeq struct {
	sync.Mutex
	producers, consumers int
}

// Producer implements a High-level Apache Kafka Producer instance.
//
// Produce enqueues the message and returns; the delivery report — the message with its
// TopicPartition (partition, offset, Error) and Opaque — arrives on the deliveryChan given to
// Produce, or on Events(), served by the producer's background poller as in the real client. A
// stalled broker keeps records in flight until it answers or message.timeout.ms (default 300 s)
// passes, when the report carries ErrMsgTimedOut; acks=0 on a stalled broker reports success for a
// record that was never written.
type Producer struct {
	name       string
	epoch      int
	acks       int
	idempotent bool
	msgTimeout time.Duration
	reports    bool
	events     chan Event

	mu          sync.Mutex
	closed      bool
	closeCh     chan struct{}
	inflight    []*inflightMsg
	waiting     bool
	queue       []report
	dispatching bool
	sending     int
	changed     chan struct{}
	sendMu      sync.Mutex
}

type inflightMsg struct {
	msg   *Message
	ch    chan Event
	at    time.Time
	topic string
}

type report struct {
	ch chan Event
	ev Event
}

// NewProducer creates a new high-level Producer instance.
//
// conf is a *ConfigMap with standard librdkafka configuration properties.
//
// Supported special configuration properties (type, default):
//
//	go.batch.producer (bool, false) - EXPERIMENTAL: Enable batch producer (for increased performance).
//	                                  These batches do not relate to Kafka message batches in any way.
//	                                  Note: timestamps and headers are not supported with this interface.
//	go.delivery.reports (bool, true) - Forward per-message delivery reports to the
//	                                   Events() channel.
//	go.delivery.report.fields (string, "key,value") - Comma separated list of fields to enable for delivery reports.
//	                                     Allowed values: all, none (or empty string), key, value, headers
//	                                     Warning: There is a performance penalty to include headers in the delivery report.
//	go.events.channel.size (int, 1000000) - Events().
//	go.produce.channel.size (int, 1000000) - ProduceChannel() buffer size (in number of messages)
//	go.logs.channel.enable (bool, false) - Forward log to Logs() channel.
//	go.logs.channel (chan kafka.LogEvent, nil) - Forward logs to application-provided channel instead of Logs(). Requires go.logs.channel.enable=true.
func NewProducer(conf *ConfigMap) (*Producer, error) {
	if conf == nil {
		conf = &ConfigMap{}
	}
	c := conf.clone()
	idempotent, err := c.boolean(false, "enable.idempotence")
	if err != nil {
		return nil, err
	}
	acks := -1
	if s, ok := c.lookup("acks", "request.required.acks"); ok {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "all", "-1":
			acks = -1
		case "0":
			acks = 0
		case "1":
			acks = 1
		default:
			return nil, newErrorFromString(ErrInvalidArg, fmt.Sprintf("Invalid value \"%s\" for configuration property \"acks\"", s))
		}
		if idempotent && acks != -1 {
			return nil, newErrorFromString(ErrInvalidArg, "Failed to create producer: `acks` must be set to `all` when `enable.idempotence` is true")
		}
	}
	timeout, err := c.millis(300*time.Second, "message.timeout.ms", "delivery.timeout.ms")
	if err != nil {
		return nil, err
	}
	reports, err := c.boolean(true, "go.delivery.reports")
	if err != nil {
		return nil, err
	}
	size, err := c.integer(1000000, "go.events.channel.size")
	if err != nil {
		return nil, err
	}
	// The channel's buffer is allocated up front; a backlog beyond it waits in the poller's queue.
	if size > 10000 {
		size = 10000
	}
	clientSeq.Lock()
	clientSeq.producers++
	n := clientSeq.producers
	clientSeq.Unlock()
	b := mk.Default()
	p := &Producer{
		name:       fmt.Sprintf("rdkafka#producer-%d", n),
		epoch:      b.Epoch(),
		acks:       acks,
		idempotent: idempotent,
		msgTimeout: timeout,
		reports:    reports,
		events:     make(chan Event, size),
		closeCh:    make(chan struct{}),
		changed:    make(chan struct{}),
	}
	b.Log(mk.Event{Kind: "producer", Client: "confluent"})
	return p, nil
}

// String returns a human readable name for a Producer instance
func (p *Producer) String() string { return p.name }

// IsClosed returns boolean representing if client is closed or not
func (p *Producer) IsClosed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closed
}

func (p *Producer) parkIfStale() {
	if mk.Default().Stale(p.epoch) {
		mk.Park()
	}
}

// Produce single message.
// This is an asynchronous call that enqueues the message on the internal
// transmit queue, thus returning immediately.
// The delivery report will be sent on the provided deliveryChan if specified,
// or on the Producer object's Events() channel if not.
// msg.Timestamp requires librdkafka >= 0.9.4 (else returns ErrNotImplemented),
// api.version.request=true, and broker >= 0.10.0.0.
// msg.Headers requires librdkafka >= 0.11.4 (else returns ErrNotImplemented),
// api.version.request=true, and broker >= 0.11.0.0.
// Returns an error if message could not be enqueued.
func (p *Producer) Produce(msg *Message, deliveryChan chan Event) error {
	p.parkIfStale()
	if p.IsClosed() {
		return errClosed()
	}
	if msg == nil || msg.TopicPartition.Topic == nil || len(*msg.TopicPartition.Topic) == 0 {
		return newErrorFromString(ErrInvalidArg, "")
	}
	b := mk.Default()
	topic := *msg.TopicPartition.Topic
	copied := *msg
	p.mu.Lock()
	defer p.mu.Unlock()
	p.settleLocked()
	if part := msg.TopicPartition.Partition; part != PartitionAny && (part < 0 || int(part) >= b.Partitions(topic)) {
		p.reportLocked(deliveryChan, p.reportFor(&copied, mk.Record{}, newError(ErrUnknownPartition)))
		return nil
	}
	if b.TakeFailure(topic) {
		p.reportLocked(deliveryChan, p.reportFor(&copied, mk.Record{}, Error{code: ErrMsgTimedOut, str: "Local: Message timed out", retriable: true}))
		return nil
	}
	_, stalled := b.StalledUntil(topic)
	queued := false
	for _, m := range p.inflight {
		if m.topic == topic {
			queued = true
			break
		}
	}
	if stalled || queued {
		if stalled && p.acks == 0 {
			// acks=0: nobody waits for the broker — the report says delivered and the record is gone.
			b.Log(mk.Event{Kind: "produce-lost", Topic: topic})
			p.reportLocked(deliveryChan, p.reportFor(&copied, mk.Record{Topic: topic, Partition: int(msg.TopicPartition.Partition), Offset: int64(OffsetInvalid)}, nil))
			return nil
		}
		p.inflight = append(p.inflight, &inflightMsg{msg: &copied, ch: deliveryChan, at: vclock.Now(), topic: topic})
		b.Log(mk.Event{Kind: "produce-stalled", Topic: topic})
		p.signalLocked()
		if !p.waiting {
			p.waiting = true
			go p.waitForBroker()
		}
		return nil
	}
	p.reportLocked(deliveryChan, p.write(&copied))
	return nil
}

// write hands an accepted message to the broker; its delivery report.
func (p *Producer) write(msg *Message) *Message {
	partition := int(msg.TopicPartition.Partition)
	if msg.TopicPartition.Partition == PartitionAny {
		partition = -1
	}
	r := mk.Default().Write(mk.Write{
		Topic:      *msg.TopicPartition.Topic,
		Partition:  partition,
		Key:        msg.Key,
		Value:      msg.Value,
		Headers:    toHeaders(msg.Headers),
		Time:       msg.Timestamp,
		Acks:       p.acks,
		Idempotent: p.idempotent,
	})
	return p.reportFor(msg, r, nil)
}

func (p *Producer) reportFor(msg *Message, r mk.Record, err error) *Message {
	topic := *msg.TopicPartition.Topic
	out := &Message{
		TopicPartition: TopicPartition{Topic: &topic, Partition: msg.TopicPartition.Partition, Offset: OffsetInvalid, Error: err},
		Value:          msg.Value,
		Key:            msg.Key,
		Timestamp:      msg.Timestamp,
		Opaque:         msg.Opaque,
	}
	if err == nil && r.Topic != "" {
		out.TopicPartition.Partition = int32(r.Partition)
		out.TopicPartition.Offset = Offset(r.Offset)
		if !r.Timestamp.IsZero() {
			out.Timestamp = r.Timestamp
			out.TimestampType = TimestampCreateTime
		}
	}
	return out
}

// settleLocked delivers in-flight records the broker accepts again and fails those past
// message.timeout.ms; it returns when the next one may change (zero: nothing in flight or nothing
// scheduled).
func (p *Producer) settleLocked() time.Time {
	b := mk.Default()
	now := vclock.Now()
	var wake time.Time
	soonest := func(t time.Time) {
		if !t.IsZero() && (wake.IsZero() || t.Before(wake)) {
			wake = t
		}
	}
	blocked := map[string]bool{}
	keep := p.inflight[:0]
	changed := false
	for _, m := range p.inflight {
		until, stalled := b.StalledUntil(m.topic)
		switch {
		case !stalled && !blocked[m.topic]:
			p.reportLocked(m.ch, p.write(m.msg))
			changed = true
		case now.Sub(m.at) >= p.msgTimeout:
			b.Log(mk.Event{Kind: "produce-timed-out", Topic: m.topic})
			p.reportLocked(m.ch, p.reportFor(m.msg, mk.Record{}, Error{code: ErrMsgTimedOut, str: "Local: Message timed out", retriable: true}))
			changed = true
		default:
			blocked[m.topic] = true
			keep = append(keep, m)
			soonest(m.at.Add(p.msgTimeout))
			soonest(until)
		}
	}
	for i := len(keep); i < len(p.inflight); i++ {
		p.inflight[i] = nil
	}
	p.inflight = keep
	if changed {
		p.signalLocked()
	}
	return wake
}

// waitForBroker is the producer's background thread while records are in flight: it wakes when
// the broker changes (a resume) or the next stall end / message timeout falls due.
func (p *Producer) waitForBroker() {
	b := mk.Default()
	for {
		changed := b.Changed()
		if b.Stale(p.epoch) {
			return
		}
		p.mu.Lock()
		if p.closed {
			p.waiting = false
			p.mu.Unlock()
			return
		}
		wake := p.settleLocked()
		if len(p.inflight) == 0 {
			p.waiting = false
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()
		var timeout <-chan time.Time
		var t *vclock.Timer
		if !wake.IsZero() {
			t = vclock.NewTimer(vclock.Until(wake))
			timeout = t.C
		}
		select {
		case <-changed:
		case <-timeout:
		case <-p.closeCh:
		}
		if t != nil {
			t.Stop()
		}
	}
}

func (p *Producer) signalLocked() {
	close(p.changed)
	p.changed = make(chan struct{})
}

// reportLocked queues a delivery report for the poller.
func (p *Producer) reportLocked(ch chan Event, m *Message) {
	if m.TopicPartition.Error == nil && !p.reports {
		return
	}
	if ch == nil {
		if !p.reports {
			return
		}
		ch = p.events
	}
	p.queue = append(p.queue, report{ch: ch, ev: m})
	p.signalLocked()
	if !p.dispatching {
		p.dispatching = true
		world.Go(p.dispatch)
	}
}

// dispatch is the poller: it hands the reports to their channels, in order.
func (p *Producer) dispatch() {
	defer func() {
		// A report sent on a channel the application closed panics: the poller stops, the next
		// report starts a new one.
		if r := recover(); r != nil {
			p.mu.Lock()
			p.dispatching = false
			p.mu.Unlock()
			panic(r)
		}
	}()
	for {
		p.mu.Lock()
		if len(p.queue) == 0 || p.closed {
			p.dispatching = false
			p.mu.Unlock()
			return
		}
		r := p.queue[0]
		p.queue = p.queue[1:]
		p.sending++
		p.mu.Unlock()
		p.send(r)
		p.mu.Lock()
		p.sending--
		p.signalLocked()
		p.mu.Unlock()
	}
}

func (p *Producer) send(r report) {
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	if p.IsClosed() {
		return
	}
	select {
	case r.ch <- r.ev:
	case <-p.closeCh:
	}
}

// Events returns the Events channel (read)
func (p *Producer) Events() chan Event {
	return p.events
}

// Len returns the number of messages and requests waiting to be transmitted to the broker
// as well as delivery reports queued for the application.
// BUG: Tries to include the number of messages on the ProduceChannel(), but the
// method returns a value that is not consistent with the number of messages
// on the ProduceChannel().
func (p *Producer) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lenLocked()
}

func (p *Producer) lenLocked() int {
	return len(p.inflight) + len(p.queue) + p.sending + len(p.events)
}

// Flush and wait for outstanding messages and requests to complete delivery.
// Runs until value reaches zero or on timeoutMs.
// Returns the number of outstanding events still un-flushed.
// BUG: Tries to include messages on ProduceChannel, but it's not guaranteed to be reliable.
func (p *Producer) Flush(timeoutMs int) int {
	p.parkIfStale()
	mk.Default().CountFlush()
	deadline := vclock.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for {
		p.mu.Lock()
		p.settleLocked()
		n := p.lenLocked()
		unread := len(p.events)
		changed := p.changed
		p.mu.Unlock()
		if n == 0 {
			return 0
		}
		remain := vclock.Until(deadline)
		if remain <= 0 {
			return n
		}
		// Reports the application has yet to read are seen leaving only by looking again, as the
		// real client's flush loop does every 100 ms.
		if unread > 0 && remain > 100*time.Millisecond {
			remain = 100 * time.Millisecond
		}
		t := vclock.NewTimer(remain)
		select {
		case <-changed:
		case <-t.C:
		}
		t.Stop()
	}
}

// Close a Producer instance.
// The Producer object or its channels are no longer usable after this call.
func (p *Producer) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	close(p.closeCh)
	p.inflight = nil
	p.queue = nil
	p.signalLocked()
	p.mu.Unlock()
	p.sendMu.Lock()
	close(p.events)
	p.sendMu.Unlock()
}

// Purge messages currently handled by this producer instance.
//
// flags is a combination of PurgeQueue, PurgeInFlight and PurgeNonBlocking.
//
// The application will need to call Poll(), Flush() or read the Events() channel
// after this call to serve delivery reports for the purged messages.
//
// Messages purged from internal queues fail with the delivery report
// error code set to ErrPurgeQueue, while purged messages that
// are in-flight to or from the broker will fail with the error code set to
// ErrPurgeInflight.
//
// Warning: Purging messages that are in-flight to or from the broker
// will ignore any subsequent acknowledgement for these messages
// received from the broker, effectively making it impossible
// for the application to know if the messages were successfully
// produced or not. This may result in duplicate messages if the
// application retries these messages at a later time.
//
// Note: This method may block for a short period of time while it waits
// for the internal threads to finish purging.
func (p *Producer) Purge(flags int) error {
	if p.IsClosed() {
		return errClosed()
	}
	if flags&(PurgeQueue|PurgeInFlight) == 0 {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, m := range p.inflight {
		p.reportLocked(m.ch, p.reportFor(m.msg, mk.Record{}, newError(ErrPurgeQueue)))
	}
	p.inflight = nil
	p.signalLocked()
	return nil
}

// GetMetadata queries broker for cluster and topic metadata.
// If topic is non-nil only information about that topic is returned, else if
// allTopics is false only information about locally used topics is returned,
// else information about all topics is returned.
// GetMetadata is equivalent to listTopics, describeTopics and describeCluster in the Java API.
func (p *Producer) GetMetadata(topic *string, allTopics bool, timeoutMs int) (*Metadata, error) {
	if p.IsClosed() {
		return nil, errClosed()
	}
	return getMetadata(topic, allTopics), nil
}

// QueryWatermarkOffsets returns the broker's low and high offsets for the given topic
// and partition.
func (p *Producer) QueryWatermarkOffsets(topic string, partition int32, timeoutMs int) (low, high int64, err error) {
	if p.IsClosed() {
		return 0, 0, errClosed()
	}
	return 0, mk.Default().EndOffset(topic, int(partition)), nil
}

// GetFatalError returns an Error object if the client instance has raised a fatal error, else nil.
func (p *Producer) GetFatalError() error { return nil }
