package kafka

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"sync"
	"time"

	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

var (
	errOnlyAvailableWithGroup = errors.New("unavailable when GroupID is not set")
	errNotAvailableWithGroup  = errors.New("unavailable when GroupID is set")
)

// ReaderConfig is a configuration object used to create new instances of
// Reader.
type ReaderConfig struct {
	// The list of broker addresses used to connect to the kafka cluster.
	Brokers []string

	// GroupID holds the optional consumer group id.  If GroupID is specified, then
	// Partition should NOT be specified e.g. 0
	GroupID string

	// GroupTopics allows specifying multiple topics, but can only be used in
	// combination with GroupID, as it is a consumer-group feature. As such, if
	// GroupID is set, then either Topic or GroupTopics must be defined.
	GroupTopics []string

	// The topic to read messages from.
	Topic string

	// Partition to read messages from.  Either Partition or GroupID may
	// be assigned, but not both
	Partition int

	// An dialer used to open connections to the kafka server. This field is
	// optional, if nil, the default dialer is used instead.
	Dialer *Dialer

	// The capacity of the internal message queue, defaults to 100 if none is
	// set.
	QueueCapacity int

	// MinBytes indicates to the broker the minimum batch size that the consumer
	// will accept. Setting a high minimum when consuming from a low-volume topic
	// may result in delayed delivery when the broker does not have enough data to
	// satisfy the defined minimum.
	//
	// Default: 1
	MinBytes int

	// MaxBytes indicates to the broker the maximum batch size that the consumer
	// will accept. The broker will truncate a message to satisfy this maximum, so
	// choose a value that is high enough for your largest message size.
	//
	// Default: 1MB
	MaxBytes int

	// Maximum amount of time to wait for new data to come when fetching batches
	// of messages from kafka.
	//
	// Default: 10s
	MaxWait time.Duration

	// ReadBatchTimeout amount of time to wait to fetch message from kafka messages batch.
	//
	// Default: 10s
	ReadBatchTimeout time.Duration

	// ReadLagInterval sets the frequency at which the reader lag is updated.
	// Setting this field to a negative value disables lag reporting.
	ReadLagInterval time.Duration

	// HeartbeatInterval sets the optional frequency at which the reader sends the consumer
	// group heartbeat update.
	//
	// Default: 3s
	//
	// Only used when GroupID is set
	HeartbeatInterval time.Duration

	// CommitInterval indicates the interval at which offsets are committed to
	// the broker.  If 0, commits will be handled synchronously.
	//
	// Default: 0
	//
	// Only used when GroupID is set
	CommitInterval time.Duration

	// PartitionWatchInterval indicates how often a reader checks for partition changes.
	// If a reader sees a partition change (such as a partition add) it will rebalance the group
	// picking up new partitions.
	//
	// Default: 5s
	//
	// Only used when GroupID is set and WatchPartitionChanges is set.
	PartitionWatchInterval time.Duration

	// WatchForPartitionChanges is used to inform kafka-go that a consumer group should be
	// polling the brokers and rebalancing if any partition changes happen to the topic.
	WatchPartitionChanges bool

	// SessionTimeout optionally sets the length of time that may pass without a heartbeat
	// before the coordinator considers the consumer dead and initiates a rebalance.
	//
	// Default: 30s
	//
	// Only used when GroupID is set
	SessionTimeout time.Duration

	// RebalanceTimeout optionally sets the length of time the coordinator will wait
	// for members to join as part of a rebalance.  For kafka servers under higher
	// load, it may be useful to set this value higher.
	//
	// Default: 30s
	//
	// Only used when GroupID is set
	RebalanceTimeout time.Duration

	// JoinGroupBackoff optionally sets the length of time to wait between re-joining
	// the consumer group after an error.
	//
	// Default: 5s
	JoinGroupBackoff time.Duration

	// RetentionTime optionally sets the length of time the consumer group will be saved
	// by the broker. -1 will disable the setting and leave the
	// retention up to the broker's offsets.retention.minutes property. By
	// default, that setting is 1 day for kafka < 2.0 and 7 days for kafka >= 2.0.
	//
	// Default: -1
	//
	// Only used when GroupID is set
	RetentionTime time.Duration

	// StartOffset determines from whence the consumer group should begin
	// consuming when it finds a partition without a committed offset.  If
	// non-zero, it must be set to one of FirstOffset or LastOffset.
	//
	// Default: FirstOffset
	//
	// Only used when GroupID is set
	StartOffset int64

	// BackoffDelayMin optionally sets the smallest amount of time the reader will wait before
	// polling for new messages
	//
	// Default: 100ms
	ReadBackoffMin time.Duration

	// BackoffDelayMax optionally sets the maximum amount of time the reader will wait before
	// polling for new messages
	//
	// Default: 1s
	ReadBackoffMax time.Duration

	// If not nil, specifies a logger used to report internal changes within the
	// reader.
	Logger Logger

	// ErrorLogger is the logger used to report errors. If nil, the reader falls
	// back to using Logger instead.
	ErrorLogger Logger

	// IsolationLevel controls the visibility of transactional records.
	// ReadUncommitted makes all records visible. With ReadCommitted only
	// non-transactional and committed records are visible.
	IsolationLevel IsolationLevel

	// Limit of how many attempts to connect will be made before returning the error.
	//
	// The default is to try 3 times.
	MaxAttempts int

	// OffsetOutOfRangeError indicates that the reader should return an error in
	// the event of an OffsetOutOfRange error, rather than retrying indefinitely.
	// This flag is being added to retain backwards-compatibility, so it will be
	// removed in a future version of kafka-go.
	OffsetOutOfRangeError bool
}

// Validate method validates ReaderConfig properties.
func (config *ReaderConfig) Validate() error {
	if len(config.Brokers) == 0 {
		return errors.New("cannot create a new kafka reader with an empty list of broker addresses")
	}
	if config.Partition < 0 || config.Partition >= math.MaxInt32 {
		return fmt.Errorf("partition number out of bounds: %d", config.Partition)
	}
	if config.MinBytes < 0 {
		return fmt.Errorf("invalid negative minimum batch size (min = %d)", config.MinBytes)
	}
	if config.MaxBytes < 0 {
		return fmt.Errorf("invalid negative maximum batch size (max = %d)", config.MaxBytes)
	}
	if config.GroupID != "" {
		if config.Partition != 0 {
			return errors.New("either Partition or GroupID may be specified, but not both")
		}
		if len(config.Topic) == 0 && len(config.GroupTopics) == 0 {
			return errors.New("either Topic or GroupTopics must be specified with GroupID")
		}
	} else if len(config.Topic) == 0 {
		return errors.New("cannot create a new kafka reader with an empty topic")
	}
	if config.MinBytes > config.MaxBytes {
		return fmt.Errorf("minimum batch size greater than the maximum (min = %d, max = %d)", config.MinBytes, config.MaxBytes)
	}
	if config.ReadBackoffMax < 0 {
		return fmt.Errorf("ReadBackoffMax out of bounds: %d", config.ReadBackoffMax)
	}
	if config.ReadBackoffMin < 0 {
		return fmt.Errorf("ReadBackoffMin out of bounds: %d", config.ReadBackoffMin)
	}
	return nil
}

// ReaderStats is a data structure returned by a call to Reader.Stats that exposes
// details about the behavior of the reader.
type ReaderStats struct {
	Dials      int64 `metric:"kafka.reader.dial.count"      type:"counter"`
	Fetches    int64 `metric:"kafka.reader.fetch.count"     type:"counter"`
	Messages   int64 `metric:"kafka.reader.message.count"   type:"counter"`
	Bytes      int64 `metric:"kafka.reader.message.bytes"   type:"counter"`
	Rebalances int64 `metric:"kafka.reader.rebalance.count" type:"counter"`
	Timeouts   int64 `metric:"kafka.reader.timeout.count"   type:"counter"`
	Errors     int64 `metric:"kafka.reader.error.count"     type:"counter"`

	DialTime   DurationStats `metric:"kafka.reader.dial.seconds"`
	ReadTime   DurationStats `metric:"kafka.reader.read.seconds"`
	WaitTime   DurationStats `metric:"kafka.reader.wait.seconds"`
	FetchSize  SummaryStats  `metric:"kafka.reader.fetch.size"`
	FetchBytes SummaryStats  `metric:"kafka.reader.fetch.bytes"`

	Offset        int64         `metric:"kafka.reader.offset"          type:"gauge"`
	Lag           int64         `metric:"kafka.reader.lag"             type:"gauge"`
	MinBytes      int64         `metric:"kafka.reader.fetch_bytes.min" type:"gauge"`
	MaxBytes      int64         `metric:"kafka.reader.fetch_bytes.max" type:"gauge"`
	MaxWait       time.Duration `metric:"kafka.reader.fetch_wait.max"  type:"gauge"`
	QueueLength   int64         `metric:"kafka.reader.queue.length"    type:"gauge"`
	QueueCapacity int64         `metric:"kafka.reader.queue.capacity"  type:"gauge"`

	ClientID  string `tag:"client_id"`
	Topic     string `tag:"topic"`
	Partition string `tag:"partition"`

	// The original `Fetches` field had a typo where the metric name was called
	// "kafak..." instead of "kafka...", in order to offer time to fix monitors
	// that may be relying on this mistake we are temporarily introducing this
	// field.
	DeprecatedFetchesWithTypo int64 `metric:"kafak.reader.fetch.count" type:"counter"`
}

// Reader provides a high-level API for consuming messages from kafka.
//
// A Reader with a GroupID is a member of that consumer group: it joins the group at its first fetch
// and owns its share of the partitions (all of them when it is alone; the group's members split
// them, and a member joining or leaving rebalances the group, each member resuming its partitions
// from their committed offsets). A partition without a committed offset starts at StartOffset
// (FirstOffset by default). Without a GroupID the Reader reads one Partition from FirstOffset (or
// wherever SetOffset puts it) and commits nothing.
type Reader struct {
	config ReaderConfig
	epoch  int

	mu       sync.Mutex
	closed   bool
	closedCh chan struct{}
	// group readers
	member    *mk.Member
	gen       int
	assigned  []mk.TopicPartition
	positions map[mk.TopicPartition]int64
	rr        int
	stash     mk.Offsets
	stashKind string
	stopTimer func()
	autoRead  bool
	// partition readers
	offset int64
	lag    int64

	messages, bytes, rebalances int64
}

// NewReader creates and returns a new Reader configured with config.
// The offset is initialized to FirstOffset.
func NewReader(config ReaderConfig) *Reader {
	if err := config.Validate(); err != nil {
		panic(err)
	}
	if config.Dialer == nil {
		config.Dialer = DefaultDialer
	}
	if config.MaxBytes == 0 {
		config.MaxBytes = 1e6 // 1 MB
	}
	if config.MinBytes == 0 {
		config.MinBytes = 1
	}
	if config.MaxWait == 0 {
		config.MaxWait = 10 * time.Second
	}
	if config.ReadBatchTimeout == 0 {
		config.ReadBatchTimeout = 10 * time.Second
	}
	if config.ReadLagInterval == 0 {
		config.ReadLagInterval = 1 * time.Minute
	}
	if config.ReadBackoffMin == 0 {
		config.ReadBackoffMin = 100 * time.Millisecond
	}
	if config.ReadBackoffMax == 0 {
		config.ReadBackoffMax = 1 * time.Second
	}
	if config.ReadBackoffMax < config.ReadBackoffMin {
		panic(fmt.Errorf("ReadBackoffMax %d smaller than ReadBackoffMin %d", config.ReadBackoffMax, config.ReadBackoffMin))
	}
	if config.QueueCapacity == 0 {
		config.QueueCapacity = 100
	}
	if config.MaxAttempts == 0 {
		config.MaxAttempts = 3
	}
	b := broker()
	r := &Reader{
		config:   config,
		epoch:    b.Epoch(),
		closedCh: make(chan struct{}),
		offset:   FirstOffset,
	}
	if r.useConsumerGroup() && config.CommitInterval > 0 {
		epoch := r.epoch
		stop := vclock.Get().Every(config.CommitInterval, func() {
			defer world.Recover()
			if b.Stale(epoch) {
				return
			}
			r.flushStash()
		})
		r.stopTimer = stop
		b.OnReset(stop)
	}
	b.RegisterConsumer(r.info)
	b.Log(mk.Event{Kind: "consumer", Group: config.GroupID, Client: "kafka-go"})
	return r
}

func (r *Reader) useConsumerGroup() bool { return r.config.GroupID != "" }

func (r *Reader) getTopics() []string {
	if len(r.config.GroupTopics) > 0 {
		return append([]string(nil), r.config.GroupTopics...)
	}
	return []string{r.config.Topic}
}

func (r *Reader) info() mk.ConsumerInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	info := mk.ConsumerInfo{
		Client:             "kafka-go",
		Group:              r.config.GroupID,
		Topics:             r.getTopics(),
		AutoCommit:         r.autoRead || (r.useConsumerGroup() && r.config.CommitInterval > 0),
		AutoCommitInterval: r.config.CommitInterval,
		Config: map[string]string{
			"GroupID":        r.config.GroupID,
			"Topic":          r.config.Topic,
			"StartOffset":    fmt.Sprint(r.config.StartOffset),
			"CommitInterval": r.config.CommitInterval.String(),
		},
		Closed: r.closed,
	}
	if r.useConsumerGroup() {
		info.Assignment = append([]mk.TopicPartition(nil), r.assigned...)
	} else {
		info.Assignment = []mk.TopicPartition{{Topic: r.config.Topic, Partition: r.config.Partition}}
	}
	return info
}

func (r *Reader) parkIfStale() {
	if broker().Stale(r.epoch) {
		mk.Park()
	}
}

// Config returns the reader's configuration.
func (r *Reader) Config() ReaderConfig {
	return r.config
}

// Close closes the stream, preventing the program from reading any more
// messages from it.
func (r *Reader) Close() error {
	b := broker()
	if b.Stale(r.epoch) {
		return nil
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	close(r.closedCh)
	member := r.member
	r.mu.Unlock()
	if r.stopTimer != nil {
		r.stopTimer()
	}
	r.flushStash()
	if member != nil {
		member.Leave()
	}
	b.Log(mk.Event{Kind: "close", Group: r.config.GroupID})
	return nil
}

// ReadMessage reads and return the next message from the r. The method call
// blocks until a message becomes available, or an error occurs. The program
// may also specify a context to asynchronously cancel the blocking operation.
//
// The method returns io.EOF to indicate that the reader has been closed.
//
// If consumer groups are used, ReadMessage will automatically commit the
// offset when called. Note that this could result in an offset being committed
// before the message is fully processed.
//
// If more fine-grained control of when offsets are committed is required, it
// is recommended to use FetchMessage with CommitMessages instead.
func (r *Reader) ReadMessage(ctx context.Context) (Message, error) {
	m, err := r.FetchMessage(ctx)
	if err != nil {
		return Message{}, fmt.Errorf("fetching message: %w", err)
	}
	if r.useConsumerGroup() {
		r.mu.Lock()
		r.autoRead = true
		r.mu.Unlock()
		if err := r.commit(ctx, []Message{m}, "auto-commit"); err != nil {
			return Message{}, fmt.Errorf("committing message: %w", err)
		}
	}
	return m, nil
}

// FetchMessage reads and return the next message from the r. The method call
// blocks until a message becomes available, or an error occurs. The program
// may also specify a context to asynchronously cancel the blocking operation.
//
// The method returns io.EOF to indicate that the reader has been closed.
//
// FetchMessage does not commit offsets automatically when using consumer groups.
// Use CommitMessages to commit the offset.
func (r *Reader) FetchMessage(ctx context.Context) (Message, error) {
	b := broker()
	// While the reader waits here its process is alive: the group does not evict it.
	var fetching *mk.Member
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	for {
		changed := b.Changed()
		r.parkIfStale()
		if m := r.join(); m != nil && m != fetching {
			if release != nil {
				release()
			}
			fetching, release = m, m.Fetching()
		}
		r.mu.Lock()
		if r.closed {
			r.mu.Unlock()
			return Message{}, io.EOF
		}
		// A context that already ended ends the fetch, even with a record there to take.
		if err := ctx.Err(); err != nil {
			r.mu.Unlock()
			return Message{}, err
		}
		rec, hwm, ok := r.nextLocked(b)
		if ok {
			msg := fromRecord(rec, hwm)
			r.messages++
			r.bytes += int64(len(rec.Key) + len(rec.Value))
			if !r.useConsumerGroup() {
				r.offset = rec.Offset + 1
				r.lag = hwm - r.offset
			}
			r.mu.Unlock()
			b.Delivered(r.config.GroupID, rec)
			return msg, nil
		}
		r.mu.Unlock()
		if err := ctx.Err(); err != nil {
			return Message{}, err
		}
		select {
		case <-ctx.Done():
			return Message{}, ctx.Err()
		case <-changed:
		case <-r.closedCh:
		}
	}
}

// join makes a group reader a member of its group at its first fetch (again, if the group evicted
// it); it returns the membership.
func (r *Reader) join() *mk.Member {
	if !r.useConsumerGroup() {
		return nil
	}
	r.mu.Lock()
	current, closed := r.member, r.closed
	r.mu.Unlock()
	if closed || (current != nil && !current.Left()) {
		return current
	}
	session := r.config.SessionTimeout
	if session <= 0 {
		session = 30 * time.Second
	}
	m := broker().Join(r.config.GroupID, r.getTopics(), session)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.member != current || r.closed {
		m.Leave()
		return r.member
	}
	r.member = m
	r.gen = 0
	return m
}

// nextLocked picks the next record round-robin over the partitions the reader owns.
func (r *Reader) nextLocked(b *mk.Broker) (mk.Record, int64, bool) {
	if r.useConsumerGroup() {
		gen, tps := r.member.Assignment()
		if gen != r.gen {
			// A new generation: every owned partition resumes from its committed offset.
			r.gen = gen
			r.rebalances++
			r.assigned = tps
			r.positions = map[mk.TopicPartition]int64{}
			for _, tp := range tps {
				if o, ok := b.CommittedOffset(r.config.GroupID, tp.Topic, tp.Partition); ok {
					r.positions[tp] = o
				} else if r.config.StartOffset == LastOffset {
					// The end as of the assignment: records appended since (another producer's, while
					// the group was forming) are read.
					end, ok := r.member.EndAtAssignment(tp)
					if !ok {
						end = b.EndOffset(tp.Topic, tp.Partition)
					}
					r.positions[tp] = end
				} else {
					r.positions[tp] = 0
				}
			}
		}
		n := len(r.assigned)
		for i := range n {
			tp := r.assigned[(r.rr+i)%n]
			pos := r.positions[tp]
			if rec, ok := b.Fetch(tp.Topic, tp.Partition, pos); ok {
				r.rr = (r.rr + i + 1) % n
				r.positions[tp] = pos + 1
				return rec, b.EndOffset(tp.Topic, tp.Partition), true
			}
		}
		return mk.Record{}, 0, false
	}
	topic, partition := r.config.Topic, r.config.Partition
	switch r.offset {
	case FirstOffset:
		r.offset = 0
	case LastOffset:
		r.offset = b.EndOffset(topic, partition)
	}
	rec, ok := b.Fetch(topic, partition, r.offset)
	return rec, b.EndOffset(topic, partition), ok
}

// CommitMessages commits the list of messages passed as argument. The program
// may pass a context to asynchronously cancel the commit operation when it was
// configured to be blocking.
//
// Because kafka consumer groups track a single offset per partition, the
// highest message offset passed to CommitMessages will cause all previous
// messages to be committed. Applications need to account for these Kafka
// limitations when committing messages, and maintain message ordering if they
// need strong delivery guarantees. This property makes it valid to pass only
// the last message seen to CommitMessages in order to move the offset of the
// topic/partition it belonged to forward, effectively committing all previous
// messages in the partition.
func (r *Reader) CommitMessages(ctx context.Context, msgs ...Message) error {
	if !r.useConsumerGroup() {
		return errOnlyAvailableWithGroup
	}
	return r.commit(ctx, msgs, "manual-commit")
}

func (r *Reader) commit(ctx context.Context, msgs []Message, kind string) error {
	r.parkIfStale()
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return io.ErrClosedPipe
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	offsets := mk.Offsets{}
	for _, m := range msgs {
		tp := mk.TopicPartition{Topic: m.Topic, Partition: m.Partition}
		if o, ok := offsets[tp]; !ok || m.Offset+1 > o {
			offsets[tp] = m.Offset + 1
		}
	}
	if len(offsets) == 0 {
		return nil
	}
	if r.config.CommitInterval > 0 {
		r.mu.Lock()
		if r.stash == nil {
			r.stash = mk.Offsets{}
		}
		for tp, o := range offsets {
			if cur, ok := r.stash[tp]; !ok || o > cur {
				r.stash[tp] = o
			}
		}
		if kind == "manual-commit" || r.stashKind == "" {
			r.stashKind = kind
		}
		r.mu.Unlock()
		return nil
	}
	broker().Commit(r.config.GroupID, offsets, kind)
	return nil
}

// flushStash commits what a CommitInterval reader has stashed since its last commit.
func (r *Reader) flushStash() {
	r.mu.Lock()
	stash, kind := r.stash, r.stashKind
	r.stash, r.stashKind = nil, ""
	r.mu.Unlock()
	if len(stash) > 0 {
		broker().Commit(r.config.GroupID, stash, kind)
	}
}

// ReadLag returns the current lag of the reader by fetching the last offset of
// the topic and partition and computing the difference between that value and
// the offset of the last message returned by ReadMessage.
//
// This method is intended to be used in cases where a program may be unable to
// call ReadMessage to update the value returned by Lag, but still needs to get
// an up to date estimation of how far behind the reader is. For example when
// the consumer is not ready to process the next message.
//
// The function returns a lag of zero when the reader's current offset is
// negative.
func (r *Reader) ReadLag(ctx context.Context) (lag int64, err error) {
	if r.useConsumerGroup() {
		return 0, errNotAvailableWithGroup
	}
	r.parkIfStale()
	last := broker().EndOffset(r.config.Topic, r.config.Partition)
	switch cur := r.Offset(); {
	case cur == FirstOffset:
		return last, nil
	case cur == LastOffset:
		return 0, nil
	default:
		return last - cur, nil
	}
}

// Offset returns the current absolute offset of the reader, or -1
// if r is backed by a consumer group.
func (r *Reader) Offset() int64 {
	if r.useConsumerGroup() {
		return -1
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.offset
}

// Lag returns the lag of the last message returned by ReadMessage, or -1
// if r is backed by a consumer group.
func (r *Reader) Lag() int64 {
	if r.useConsumerGroup() {
		return -1
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lag
}

// SetOffset changes the offset from which the next batch of messages will be
// read. The method fails with io.ErrClosedPipe if the reader has already been closed.
//
// From version 0.2.0, FirstOffset and LastOffset can be used to indicate the first
// or last available offset in the partition. Please note while -1 and -2 were accepted
// to indicate the first or last offset in previous versions, the meanings of the numbers
// were swapped in 0.2.0 to match the meanings in other libraries and the Kafka protocol
// specification.
func (r *Reader) SetOffset(offset int64) error {
	if r.useConsumerGroup() {
		return errNotAvailableWithGroup
	}
	r.parkIfStale()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return io.ErrClosedPipe
	}
	r.offset = offset
	r.mu.Unlock()
	broker().Notify()
	return nil
}

// SetOffsetAt changes the offset from which the next batch of messages will be
// read given the timestamp t.
//
// The method fails if the unable to connect partition leader, or unable to read the offset
// given the ts, or if the reader has been closed.
func (r *Reader) SetOffsetAt(ctx context.Context, t time.Time) error {
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return io.ErrClosedPipe
	}
	return r.SetOffset(offsetAt(r.config.Topic, r.config.Partition, t))
}

// offsetAt is the first offset of the partition whose record is not older than t (the end offset
// when there is none).
func offsetAt(topic string, partition int, t time.Time) int64 {
	b := broker()
	var recs []mk.Record
	for _, rec := range b.Records(topic) {
		if rec.Partition == partition {
			recs = append(recs, rec)
		}
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Offset < recs[j].Offset })
	for _, rec := range recs {
		if !rec.Timestamp.Before(t) {
			return rec.Offset
		}
	}
	return b.EndOffset(topic, partition)
}

// Stats returns a snapshot of the reader stats since the last time the method
// was called, or since the reader was created if it is called for the first
// time.
//
// A typical use of this method is to spawn a goroutine that will periodically
// call Stats on a kafka reader and report the metrics to a stats collection
// system.
func (r *Reader) Stats() ReaderStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	partition := fmt.Sprint(r.config.Partition)
	if r.useConsumerGroup() {
		partition = "-1"
	}
	stats := ReaderStats{
		Messages:      r.messages,
		Bytes:         r.bytes,
		Rebalances:    r.rebalances,
		Offset:        r.offset,
		Lag:           r.lag,
		MinBytes:      int64(r.config.MinBytes),
		MaxBytes:      int64(r.config.MaxBytes),
		MaxWait:       r.config.MaxWait,
		QueueCapacity: int64(r.config.QueueCapacity),
		ClientID:      r.config.Dialer.ClientID,
		Topic:         r.config.Topic,
		Partition:     partition,
	}
	r.messages, r.bytes, r.rebalances = 0, 0, 0
	return stats
}
