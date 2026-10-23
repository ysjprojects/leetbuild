// Package kafka is github.com/confluentinc/confluent-kafka-go/v2/kafka as the courses meet it, on
// the runtime's in-memory broker (leetbuild/goruntime/models/kafka): Producer (Produce enqueues,
// delivery reports arrive on the delivery channel or Events(), Flush waits on the virtual clock,
// message.timeout.ms on a stalled broker, acks and enable.idempotence), Consumer (subscribe and
// consumer groups, Poll/ReadMessage, auto-commit on a timer and on Close, explicit commits and
// offset stores, pause/resume/seek, watermarks) and the library's error codes. Names and signatures
// are the real library's; behaviour follows librdkafka and the Python runtime's confluent_kafka.
//
// Not modelled: transactions, the admin client, statistics, logs, OAuth.
package kafka

import (
	"fmt"
	"strconv"
	"time"

	mk "leetbuild/goruntime/models/kafka"
)

// PartitionAny represents any partition (for partitioning),
// or unspecified value (for all other cases)
const PartitionAny = int32(-1)

// Offset type (int64) with support for canonical names
type Offset int64

// OffsetBeginning represents the earliest offset (logical)
const OffsetBeginning = Offset(-2)

// OffsetEnd represents the latest offset (logical)
const OffsetEnd = Offset(-1)

// OffsetInvalid represents an invalid/unspecified offset
const OffsetInvalid = Offset(-1001)

// OffsetStored represents a stored offset
const OffsetStored = Offset(-1000)

func (o Offset) String() string {
	switch o {
	case OffsetBeginning:
		return "beginning"
	case OffsetEnd:
		return "end"
	case OffsetInvalid:
		return "unset"
	case OffsetStored:
		return "stored"
	default:
		return fmt.Sprintf("%d", int64(o))
	}
}

// Set offset value, see NewOffset()
func (o *Offset) Set(offset interface{}) error {
	n, err := NewOffset(offset)
	if err == nil {
		*o = n
	}
	return err
}

// NewOffset creates a new Offset using the provided logical string, an
// absolute int64 offset value, or a concrete Offset type.
// Logical offsets: "beginning", "earliest", "end", "latest", "unset", "invalid", "stored"
func NewOffset(offset interface{}) (Offset, error) {
	switch v := offset.(type) {
	case string:
		switch v {
		case "beginning", "earliest":
			return OffsetBeginning, nil
		case "end", "latest":
			return OffsetEnd, nil
		case "unset", "invalid":
			return OffsetInvalid, nil
		case "stored":
			return OffsetStored, nil
		default:
			off, err := strconv.Atoi(v)
			return Offset(off), err
		}
	case int:
		return Offset((int64)(v)), nil
	case int64:
		return Offset(v), nil
	case Offset:
		return v, nil
	default:
		return OffsetInvalid, newErrorFromString(ErrInvalidArg, fmt.Sprintf("Invalid offset type: %t", v))
	}
}

// OffsetTail returns the logical offset relativeOffset from current end of partition
func OffsetTail(relativeOffset Offset) Offset {
	return Offset(-2000 - int64(relativeOffset))
}

// TopicPartition is a generic placeholder for a Topic+Partition and optionally Offset.
type TopicPartition struct {
	Topic       *string
	Partition   int32
	Offset      Offset
	Metadata    *string
	Error       error
	LeaderEpoch *int32 // LeaderEpoch or nil if not available
}

func (p TopicPartition) String() string {
	topic := "<null>"
	if p.Topic != nil {
		topic = *p.Topic
	}
	if p.Error != nil {
		return fmt.Sprintf("%s[%d]@%s(%s)", topic, p.Partition, p.Offset, p.Error)
	}
	return fmt.Sprintf("%s[%d]@%s", topic, p.Partition, p.Offset)
}

func (p TopicPartition) key() mk.TopicPartition {
	topic := ""
	if p.Topic != nil {
		topic = *p.Topic
	}
	return mk.TopicPartition{Topic: topic, Partition: int(p.Partition)}
}

func topicPartition(tp mk.TopicPartition, offset Offset) TopicPartition {
	topic := tp.Topic
	return TopicPartition{Topic: &topic, Partition: int32(tp.Partition), Offset: offset}
}

// TopicPartitions is a slice of TopicPartitions that also implements
// the sort interface
type TopicPartitions []TopicPartition

func (tps TopicPartitions) Len() int {
	return len(tps)
}

func (tps TopicPartitions) Less(i, j int) bool {
	if *tps[i].Topic < *tps[j].Topic {
		return true
	} else if *tps[i].Topic > *tps[j].Topic {
		return false
	}
	return tps[i].Partition < tps[j].Partition
}

func (tps TopicPartitions) Swap(i, j int) {
	tps[i], tps[j] = tps[j], tps[i]
}

// Header represents a single Kafka message header.
//
// Message headers are made up of a list of Header elements, retaining their original insert
// order and allowing for duplicate Keys.
//
// Key is a human readable string identifying the header.
// Value is the key's binary value, Kafka does not put any restrictions on the format of
// of the Value but it should be made relatively compact.
// The value may be a byte array, empty, or nil.
//
// NOTE: Message headers are not available on producer delivery report messages.
type Header struct {
	Key   string // Header name (utf-8 string)
	Value []byte // Header value (nil, empty, or binary)
}

// String returns the Header Key and data in a human representable possibly truncated form
// suitable for displaying to the user.
func (h Header) String() string {
	if h.Value == nil {
		return fmt.Sprintf("%s=nil", h.Key)
	}
	valueLen := len(h.Value)
	if valueLen == 0 {
		return fmt.Sprintf("%s=<empty>", h.Key)
	}
	truncSize := valueLen
	trunc := ""
	if valueLen > 50+15 {
		truncSize = 50
		trunc = fmt.Sprintf("(%d more bytes)", valueLen-truncSize)
	}
	return fmt.Sprintf("%s=%s%s", h.Key, strconv.Quote(string(h.Value[:truncSize])), trunc)
}

// TimestampType is a the Message timestamp type or source
type TimestampType int

const (
	// TimestampNotAvailable indicates no timestamp was set, or not available due to lacking broker support
	TimestampNotAvailable TimestampType = 0
	// TimestampCreateTime indicates timestamp set by producer (source time)
	TimestampCreateTime TimestampType = 1
	// TimestampLogAppendTime indicates timestamp set set by broker (store time)
	TimestampLogAppendTime TimestampType = 2
)

func (t TimestampType) String() string {
	switch t {
	case TimestampCreateTime:
		return "CreateTime"
	case TimestampLogAppendTime:
		return "LogAppendTime"
	default:
		return "NotAvailable"
	}
}

// Message represents a Kafka message
type Message struct {
	TopicPartition TopicPartition
	Value          []byte
	Key            []byte
	Timestamp      time.Time
	TimestampType  TimestampType
	Opaque         interface{}
	Headers        []Header
	LeaderEpoch    *int32 // Deprecated: LeaderEpoch or nil if not available. Use m.TopicPartition.LeaderEpoch instead.
}

// String returns a human readable representation of a Message.
// Key and payload are not represented.
func (m *Message) String() string {
	var topic string
	if m.TopicPartition.Topic != nil {
		topic = *m.TopicPartition.Topic
	}
	return fmt.Sprintf("%s[%d]@%s", topic, m.TopicPartition.Partition, m.TopicPartition.Offset)
}

func toHeaders(hs []Header) []mk.Header {
	if len(hs) == 0 {
		return nil
	}
	out := make([]mk.Header, len(hs))
	for i, h := range hs {
		out[i] = mk.Header{Key: h.Key, Value: h.Value}
	}
	return out
}

func fromRecord(r mk.Record) *Message {
	var hs []Header
	if len(r.Headers) > 0 {
		hs = make([]Header, len(r.Headers))
		for i, h := range r.Headers {
			hs[i] = Header{Key: h.Key, Value: h.Value}
		}
	}
	return &Message{
		TopicPartition: topicPartition(mk.TopicPartition{Topic: r.Topic, Partition: r.Partition}, Offset(r.Offset)),
		Value:          r.Value,
		Key:            r.Key,
		Timestamp:      r.Timestamp,
		TimestampType:  TimestampCreateTime,
		Headers:        hs,
	}
}

// Event generic interface
type Event interface {
	// String returns a human-readable representation of the event
	String() string
}

// Stats statistics event
type Stats struct {
	statsJSON string
}

func (e Stats) String() string {
	return e.statsJSON
}

// AssignedPartitions consumer group rebalance event: assigned partition set
type AssignedPartitions struct {
	Partitions []TopicPartition
}

func (e AssignedPartitions) String() string {
	return fmt.Sprintf("AssignedPartitions: %v", e.Partitions)
}

// RevokedPartitions consumer group rebalance event: revoked partition set
type RevokedPartitions struct {
	Partitions []TopicPartition
}

func (e RevokedPartitions) String() string {
	return fmt.Sprintf("RevokedPartitions: %v", e.Partitions)
}

// PartitionEOF consumer reached end of partition
// Needs to be explicitly enabled by setting the `enable.partition.eof`
// configuration property to true.
type PartitionEOF TopicPartition

func (p PartitionEOF) String() string {
	return fmt.Sprintf("EOF at %s", TopicPartition(p))
}

// OffsetsCommitted reports committed offsets
type OffsetsCommitted struct {
	Error   error
	Offsets []TopicPartition
}

func (o OffsetsCommitted) String() string {
	return fmt.Sprintf("OffsetsCommitted (%v, %v)", o.Error, o.Offsets)
}

// Error provides a Kafka-specific error container
type Error struct {
	code             ErrorCode
	str              string
	fatal            bool
	retriable        bool
	txnRequiresAbort bool
}

// NewError creates a new Error.
func NewError(code ErrorCode, str string, fatal bool) (err Error) {
	return Error{code: code, str: str, fatal: fatal}
}

func newError(code ErrorCode) Error { return Error{code: code} }

func newErrorFromString(code ErrorCode, str string) Error { return Error{code: code, str: str} }

// Error returns a human readable representation of an Error
// Same as Error.String()
func (e Error) Error() string {
	return e.String()
}

// String returns a human readable representation of an Error
func (e Error) String() string {
	errstr := e.str
	if len(errstr) == 0 {
		errstr = e.code.String()
	}
	if e.IsFatal() {
		return fmt.Sprintf("Fatal error: %s", errstr)
	}
	return errstr
}

// Code returns the ErrorCode of an Error
func (e Error) Code() ErrorCode {
	return e.code
}

// IsFatal returns true if the error is a fatal error.
// A fatal error indicates the client instance is no longer operable and
// should be terminated. Typical causes include non-recoverable
// idempotent producer errors.
func (e Error) IsFatal() bool {
	return e.fatal
}

// IsRetriable returns true if the operation that caused this error
// may be retried. In this runtime a delivery that failed with a transient broker error (a
// FailNext, a message timeout) is retriable, as librdkafka classifies those errors.
func (e Error) IsRetriable() bool {
	return e.retriable
}

// IsTimeout returns true if the error is a timeout error.
// A timeout error indicates that the operation timed out locally.
func (e Error) IsTimeout() bool {
	return e.code == ErrTimedOut || e.code == ErrTimedOutQueue || e.code == ErrMsgTimedOut
}

// TxnRequiresAbort returns true if the error is an abortable transaction error
// that requires the application to abort the current transaction with
// AbortTransaction() and start a new transaction with BeginTransaction()
// if it wishes to proceed with transactional operations.
// This flag is only set by the Transactional producer API.
func (e Error) TxnRequiresAbort() bool {
	return e.txnRequiresAbort
}

func errClosed() error { return newErrorFromString(ErrState, "Operation not allowed on closed client") }

// BrokerMetadata contains per-broker metadata
type BrokerMetadata struct {
	ID   int32
	Host string
	Port int
}

// PartitionMetadata contains per-partition metadata
type PartitionMetadata struct {
	ID       int32
	Error    Error
	Leader   int32
	Replicas []int32
	Isrs     []int32
}

// TopicMetadata contains per-topic metadata
type TopicMetadata struct {
	Topic      string
	Partitions []PartitionMetadata
	Error      Error
}

// Metadata contains broker and topic metadata for all (matching) topics
type Metadata struct {
	Brokers []BrokerMetadata
	Topics  map[string]TopicMetadata

	OriginatingBroker BrokerMetadata
}

func getMetadata(topic *string, allTopics bool) *Metadata {
	b := mk.Default()
	broker := BrokerMetadata{ID: 1, Host: "kafka", Port: 9092}
	md := &Metadata{Brokers: []BrokerMetadata{broker}, Topics: map[string]TopicMetadata{}, OriginatingBroker: broker}
	var topics []string
	if topic != nil {
		topics = []string{*topic}
	} else if allTopics {
		topics = b.Topics()
	}
	for _, t := range topics {
		tm := TopicMetadata{Topic: t}
		for p := range b.Partitions(t) {
			tm.Partitions = append(tm.Partitions, PartitionMetadata{ID: int32(p), Leader: 1, Replicas: []int32{1}, Isrs: []int32{1}})
		}
		md.Topics[t] = tm
	}
	return md
}
