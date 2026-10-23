package kafka

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/vclock"
)

// Broker carries the metadata associated with a kafka broker.
type Broker struct {
	Host string
	Port int
	ID   int
	Rack string
}

// Partition carries the metadata associated with a kafka partition.
type Partition struct {
	// Name of the topic that the partition belongs to, and its index in the
	// topic.
	Topic string
	ID    int

	// Leader, replicas, and ISR for the partition.
	//
	// When no physical host is known to be running a broker, the Host and Port
	// fields will be set to the zero values. The logical broker ID is always
	// set to the value known to the kafka cluster, even if the broker is not
	// currently backed by a physical host.
	Leader          Broker
	Replicas        []Broker
	Isr             []Broker
	OfflineReplicas []Broker

	// Available only with metadata API level >= 6:
	Error error
}

// TopicConfig is a configuration for a topic.
type TopicConfig struct {
	// Topic name
	Topic string

	// NumPartitions created. -1 indicates unset.
	NumPartitions int

	// ReplicationFactor for the topic. -1 indicates unset.
	ReplicationFactor int

	// ReplicaAssignments among kafka brokers for this topic partitions. If this
	// is set num_partitions and replication_factor must be unset.
	ReplicaAssignments []ReplicaAssignment

	// ConfigEntries holds topic level configuration for topic to be set.
	ConfigEntries []ConfigEntry
}

// ReplicaAssignment is the brokers holding a partition's replicas.
type ReplicaAssignment struct {
	Partition int
	Replicas  []int
}

// ConfigEntry is a topic configuration entry.
type ConfigEntry struct {
	ConfigName  string
	ConfigValue string
}

const (
	SeekStart    = 0 // Seek relative to the first offset available in the partition.
	SeekAbsolute = 1 // Seek to an absolute offset.
	SeekEnd      = 2 // Seek relative to the last offset available in the partition.
	SeekCurrent  = 3 // Seek relative to the current offset.

	// This flag may be combined to any of the SeekAbsolute and SeekCurrent
	// constants to skip the bound check that the connection would do otherwise.
	// Programs can use this flag to avoid making a metadata request to the kafka
	// broker to read the current first and last offsets of the partition.
	SeekDontCheck = 1 << 30
)

var clusterBroker = Broker{Host: "kafka", Port: 9092, ID: 1}

// The Dialer type mirrors the net.Dialer API but is designed to open kafka
// connections instead of raw network connections.
type Dialer struct {
	// Unique identifier for client connections established by this Dialer.
	ClientID string

	// Timeout is the maximum amount of time a dial will wait for a connect to
	// complete. If Deadline is also set, it may fail earlier.
	Timeout time.Duration

	// Deadline is an absolute point in time after which dials will fail.
	Deadline time.Time

	// LocalAddr is the local address to use when dialing an address.
	LocalAddr net.Addr

	// DualStack enables RFC 6555-compliant "Happy Eyeballs" dialing.
	DualStack bool

	// FallbackDelay specifies the length of time to wait before spawning a
	// fallback connection, when DualStack is enabled.
	FallbackDelay time.Duration

	// KeepAlive specifies the keep-alive period for an active network
	// connection.
	KeepAlive time.Duration

	// TLS enables Dialer to open secure connections.  If nil, standard net.Conn
	// will be used.
	TLS *tls.Config

	// TransactionalID is the transactional id to use for this connection.
	TransactionalID string
}

// DefaultDialer is the default dialer used when none is specified.
var DefaultDialer = &Dialer{
	Timeout:   10 * time.Second,
	DualStack: true,
}

// Dial connects to the address on the named network.
func (d *Dialer) Dial(network string, address string) (*Conn, error) {
	return d.DialContext(context.Background(), network, address)
}

// DialContext connects to the address on the named network using the provided context.
func (d *Dialer) DialContext(ctx context.Context, network string, address string) (*Conn, error) {
	return newConn(ctx, "", -1)
}

// DialLeader opens a connection to the leader of the partition for a given
// topic.
func (d *Dialer) DialLeader(ctx context.Context, network string, address string, topic string, partition int) (*Conn, error) {
	return d.DialPartition(ctx, network, address, Partition{Topic: topic, ID: partition})
}

// DialPartition opens a connection to the leader of the partition specified by partition
// descriptor.
func (d *Dialer) DialPartition(ctx context.Context, network string, address string, partition Partition) (*Conn, error) {
	if partition.ID < 0 || partition.ID >= broker().Partitions(partition.Topic) {
		return nil, UnknownTopicOrPartition
	}
	return newConn(ctx, partition.Topic, partition.ID)
}

// Dial is a convenience wrapper for DefaultDialer.Dial.
func Dial(network string, address string) (*Conn, error) {
	return DefaultDialer.Dial(network, address)
}

// DialContext is a convenience wrapper for DefaultDialer.DialContext.
func DialContext(ctx context.Context, network string, address string) (*Conn, error) {
	return DefaultDialer.DialContext(ctx, network, address)
}

// DialLeader is a convenience wrapper for DefaultDialer.DialLeader.
func DialLeader(ctx context.Context, network string, address string, topic string, partition int) (*Conn, error) {
	return DefaultDialer.DialLeader(ctx, network, address, topic, partition)
}

// DialPartition is a convenience wrapper for DefaultDialer.DialPartition.
func DialPartition(ctx context.Context, network string, address string, partition Partition) (*Conn, error) {
	return DefaultDialer.DialPartition(ctx, network, address, partition)
}

// Conn represents a connection to a kafka broker: to the leader of one partition after DialLeader,
// to the cluster after Dial.
type Conn struct {
	epoch     int
	topic     string
	partition int

	mu            sync.Mutex
	closed        bool
	offset        int64
	readDeadline  time.Time
	writeDeadline time.Time
	// RequiredAcks of WriteMessages (the library's connections wait for every replica).
	acks RequiredAcks
}

func newConn(ctx context.Context, topic string, partition int) (*Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c := &Conn{epoch: broker().Epoch(), topic: topic, partition: partition, acks: RequireAll}
	if topic != "" {
		c.offset = 0
	}
	return c, nil
}

func (c *Conn) check(partitioned bool) error {
	if broker().Stale(c.epoch) {
		mk.Park()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	if partitioned && c.topic == "" {
		return errors.New("kafka: the connection is not bound to a partition (use DialLeader)")
	}
	return nil
}

// Close closes the kafka connection.
func (c *Conn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return nil
}

// LocalAddr returns the local network address.
func (c *Conn) LocalAddr() net.Addr { return &networkAddress{network: "tcp", address: "127.0.0.1:0"} }

// RemoteAddr returns the remote network address.
func (c *Conn) RemoteAddr() net.Addr { return &networkAddress{network: "tcp", address: "kafka:9092"} }

// SetDeadline sets the read and write deadlines associated with the connection.
func (c *Conn) SetDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline, c.writeDeadline = t, t
	c.mu.Unlock()
	return nil
}

// SetReadDeadline sets the deadline for future Read calls and any
// currently-blocked Read call.
func (c *Conn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline = t
	c.mu.Unlock()
	return nil
}

// SetWriteDeadline sets the deadline for future Write calls and any
// currently-blocked Write call.
func (c *Conn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.writeDeadline = t
	c.mu.Unlock()
	return nil
}

// SetRequiredAcks sets the number of acknowledges from replicas that the
// connection requests when producing messages.
func (c *Conn) SetRequiredAcks(n int) error {
	switch n {
	case -1, 1:
		c.mu.Lock()
		c.acks = RequiredAcks(n)
		c.mu.Unlock()
		return nil
	default:
		return InvalidRequiredAcks
	}
}

// Controller requests kafka for the current controller and returns its URL.
func (c *Conn) Controller() (Broker, error) {
	if err := c.check(false); err != nil {
		return Broker{}, err
	}
	return clusterBroker, nil
}

// Brokers retrieve the broker list from the Kafka metadata.
func (c *Conn) Brokers() ([]Broker, error) {
	if err := c.check(false); err != nil {
		return nil, err
	}
	return []Broker{clusterBroker}, nil
}

// ReadPartitions returns the list of available partitions for the given list of
// topics.
//
// If the method is called with no topic, it uses the topic configured on the
// connection. If there are none, the method fetches all partitions of the kafka
// cluster.
func (c *Conn) ReadPartitions(topics ...string) ([]Partition, error) {
	if err := c.check(false); err != nil {
		return nil, err
	}
	b := broker()
	if len(topics) == 0 {
		if c.topic != "" {
			topics = []string{c.topic}
		} else {
			topics = b.Topics()
		}
	}
	var out []Partition
	for _, t := range topics {
		for p := range b.Partitions(t) {
			out = append(out, Partition{
				Topic:    t,
				ID:       p,
				Leader:   clusterBroker,
				Replicas: []Broker{clusterBroker},
				Isr:      []Broker{clusterBroker},
			})
		}
	}
	return out, nil
}

// CreateTopics creates one topic per provided configuration with idempotent
// operational semantics. In other words, if CreateTopics is invoked with a
// configuration for an existing topic, it will have no effect.
func (c *Conn) CreateTopics(topics ...TopicConfig) error {
	if err := c.check(false); err != nil {
		return err
	}
	for _, t := range topics {
		n := t.NumPartitions
		if n <= 0 && len(t.ReplicaAssignments) > 0 {
			n = len(t.ReplicaAssignments)
		}
		broker().CreateTopic(t.Topic, n)
	}
	return nil
}

// DeleteTopics deletes the specified topics.
func (c *Conn) DeleteTopics(topics ...string) error {
	if err := c.check(false); err != nil {
		return err
	}
	for _, t := range topics {
		if !broker().DeleteTopic(t) {
			return UnknownTopicOrPartition
		}
	}
	return nil
}

// Offset returns the current offset of the connection as pair of integers,
// where the first one is an offset value and the second one indicates how
// to interpret it.
//
// See Seek for more details about the offset and whence values.
func (c *Conn) Offset() (offset int64, whence int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.offset, SeekAbsolute
}

// Seek sets the offset for the next read or write operation according to whence, which
// should be one of SeekStart, SeekAbsolute, SeekEnd, or SeekCurrent.
// When seeking relative to the end, the offset is subtracted from the current offset.
// Note that for historical reasons, these do not align with the usual whence constants
// as in lseek(2) or os.Seek.
// The method returns the new absolute offset of the connection.
func (c *Conn) Seek(offset int64, whence int) (int64, error) {
	if err := c.check(true); err != nil {
		return 0, err
	}
	check := whence&SeekDontCheck == 0
	whence &^= SeekDontCheck
	end := broker().EndOffset(c.topic, c.partition)
	c.mu.Lock()
	defer c.mu.Unlock()
	switch whence {
	case SeekStart:
		offset = 0 + offset
	case SeekAbsolute:
	case SeekEnd:
		offset = end - offset
	case SeekCurrent:
		offset = c.offset + offset
	default:
		return -1, errors.New("whence must be one of 0, 1, 2, or 3. (whence = " + strconv.Itoa(whence) + ")")
	}
	if check && (offset < 0 || offset > end) {
		return -1, OffsetOutOfRange
	}
	c.offset = offset
	return offset, nil
}

// ReadFirstOffset returns the first offset available on the connection.
func (c *Conn) ReadFirstOffset() (int64, error) {
	if err := c.check(true); err != nil {
		return -1, err
	}
	return 0, nil
}

// ReadLastOffset returns the last offset available on the connection (the offset the next record
// gets).
func (c *Conn) ReadLastOffset() (int64, error) {
	if err := c.check(true); err != nil {
		return -1, err
	}
	return broker().EndOffset(c.topic, c.partition), nil
}

// ReadOffsets returns the absolute first and last offsets of the topic used by
// the connection.
func (c *Conn) ReadOffsets() (first, last int64, err error) {
	if err := c.check(true); err != nil {
		return -1, -1, err
	}
	return 0, broker().EndOffset(c.topic, c.partition), nil
}

// ReadOffset returns the offset of the first message with a timestamp equal or
// greater to t.
func (c *Conn) ReadOffset(t time.Time) (int64, error) {
	if err := c.check(true); err != nil {
		return -1, err
	}
	return offsetAt(c.topic, c.partition, t), nil
}

// ReadMessage reads the message at the current offset from the connection,
// advancing the offset on success so the next call to a read method will
// produce the next message. It blocks until a message is there or the read deadline passes.
func (c *Conn) ReadMessage(maxBytes int) (Message, error) {
	b := broker()
	for {
		changed := b.Changed()
		if err := c.check(true); err != nil {
			return Message{}, err
		}
		c.mu.Lock()
		offset, deadline := c.offset, c.readDeadline
		c.mu.Unlock()
		if rec, ok := b.Fetch(c.topic, c.partition, offset); ok {
			c.mu.Lock()
			c.offset = offset + 1
			c.mu.Unlock()
			b.Delivered("", rec)
			return fromRecord(rec, b.EndOffset(c.topic, c.partition)), nil
		}
		if !deadline.IsZero() {
			wait := vclock.Until(deadline)
			if wait <= 0 {
				return Message{}, RequestTimedOut
			}
			t := vclock.NewTimer(wait)
			select {
			case <-changed:
			case <-t.C:
			}
			t.Stop()
			continue
		}
		<-changed
	}
}

// WriteMessages writes a batch of messages to the connection's topic and
// partition, returning the number of bytes written. The write is an atomic
// operation, it either fully succeeds or fails. On a stalled broker it waits until the broker
// answers or the write deadline passes.
func (c *Conn) WriteMessages(msgs ...Message) (int, error) {
	b := broker()
	if err := c.check(true); err != nil {
		return 0, err
	}
	waited := false
	for {
		changed := b.Changed()
		c.mu.Lock()
		deadline, acks := c.writeDeadline, c.acks
		c.mu.Unlock()
		until, stalled := b.StalledUntil(c.topic)
		if !stalled {
			if b.TakeFailure(c.topic) {
				return 0, RequestTimedOut
			}
			n := 0
			for _, m := range msgs {
				b.Write(mk.Write{Topic: c.topic, Partition: c.partition, Key: m.Key, Value: m.Value, Headers: toHeaders(m.Headers), Time: m.Time, Acks: int(acks)})
				n += int(m.totalSize())
			}
			return n, nil
		}
		if !waited {
			waited = true
			b.Log(mk.Event{Kind: "produce-stalled", Topic: c.topic})
		}
		wake := until
		if !deadline.IsZero() && (wake.IsZero() || deadline.Before(wake)) {
			wake = deadline
		}
		if wake.IsZero() {
			<-changed
			continue
		}
		wait := vclock.Until(wake)
		if wait <= 0 {
			if !deadline.IsZero() && !vclock.Now().Before(deadline) {
				return 0, RequestTimedOut
			}
			continue
		}
		t := vclock.NewTimer(wait)
		select {
		case <-changed:
		case <-t.C:
		}
		t.Stop()
		if b.Stale(c.epoch) {
			mk.Park()
		}
	}
}
