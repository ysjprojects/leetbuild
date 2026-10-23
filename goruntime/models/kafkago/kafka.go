// Package kafka is github.com/segmentio/kafka-go as the courses meet it, on the runtime's in-memory
// broker (leetbuild/goruntime/models/kafka): Writer (batching with BatchSize/BatchTimeout, acks,
// retries with backoff on a stalled broker, Async with Completion), Reader (consumer groups that
// split partitions, FetchMessage/CommitMessages/ReadMessage, partition readers with SetOffset),
// the balancers (the library's own algorithms), Conn (DialLeader, ReadLastOffset, CreateTopics) and
// the library's error values. Names, signatures and defaults are the real library's. Time is
// virtual: waits are vclock timers and channel waits, never polls.
//
// Differences from a real cluster, on purpose: topics are created on first use with
// DefaultPartitions; a FailNext failure fails exactly one message (the others of its batch land);
// a group reader joins its group at its first fetch.
package kafka

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	mk "leetbuild/goruntime/models/kafka"
)

const (
	LastOffset  int64 = -1 // The most recent offset available for a partition.
	FirstOffset int64 = -2 // The least recent offset available for a partition.
)

// Header is a key/value pair carried by a message.
type Header struct {
	Key   string
	Value []byte
}

// Message is a data structure representing kafka messages.
type Message struct {
	// Topic indicates which topic this message was consumed from via Reader.
	//
	// When being used with Writer, this can be used to configure the topic if
	// not already specified on the writer itself.
	Topic string

	// Partition is read-only and MUST NOT be set when writing messages
	Partition     int
	Offset        int64
	HighWaterMark int64
	Key           []byte
	Value         []byte
	Headers       []Header

	// This field is used to hold arbitrary data you wish to include, so it
	// will be available when handle it on the Writer's `Completion` method,
	// this support the application can do any post operation on each message.
	WriterData interface{}

	// If not set at the creation, Time will be automatically set when
	// writing the message.
	Time time.Time
}

func (msg *Message) totalSize() int32 {
	n := len(msg.Key) + len(msg.Value)
	for _, h := range msg.Headers {
		n += len(h.Key) + len(h.Value)
	}
	return int32(n)
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

func fromRecord(r mk.Record, highWaterMark int64) Message {
	var hs []Header
	if len(r.Headers) > 0 {
		hs = make([]Header, len(r.Headers))
		for i, h := range r.Headers {
			hs[i] = Header{Key: h.Key, Value: h.Value}
		}
	}
	return Message{
		Topic:         r.Topic,
		Partition:     r.Partition,
		Offset:        r.Offset,
		HighWaterMark: highWaterMark,
		Key:           r.Key,
		Value:         r.Value,
		Headers:       hs,
		Time:          r.Timestamp,
	}
}

// RequiredAcks represents the number of acknowledgements required before a produce request is
// considered successful.
type RequiredAcks int

const (
	RequireNone RequiredAcks = 0
	RequireOne  RequiredAcks = 1
	RequireAll  RequiredAcks = -1
)

func (acks RequiredAcks) String() string {
	switch acks {
	case RequireNone:
		return "none"
	case RequireOne:
		return "one"
	case RequireAll:
		return "all"
	default:
		return "unknown"
	}
}

func (acks RequiredAcks) MarshalText() ([]byte, error) {
	return []byte(acks.String()), nil
}

func (acks *RequiredAcks) UnmarshalText(b []byte) error {
	switch string(b) {
	case "none":
		*acks = RequireNone
	case "one":
		*acks = RequireOne
	case "all":
		*acks = RequireAll
	default:
		x, err := strconv.ParseInt(string(b), 10, 64)
		parsed := RequiredAcks(x)
		if err != nil || (parsed != RequireNone && parsed != RequireOne && parsed != RequireAll) {
			return fmt.Errorf("required acks must be one of none, one, or all, not %q", b)
		}
		*acks = parsed
	}
	return nil
}

// Compression is a message compression codec (the model stores records uncompressed).
type Compression int8

const (
	Gzip   Compression = 1
	Snappy Compression = 2
	Lz4    Compression = 3
	Zstd   Compression = 4
)

func (c Compression) String() string {
	switch c {
	case 0:
		return "none"
	case Gzip:
		return "gzip"
	case Snappy:
		return "snappy"
	case Lz4:
		return "lz4"
	case Zstd:
		return "zstd"
	}
	return "unknown"
}

// IsolationLevel controls the visibility of transactional records.
type IsolationLevel int8

const (
	ReadUncommitted IsolationLevel = 0
	ReadCommitted   IsolationLevel = 1
)

// Logger interface API for log.Logger.
type Logger interface {
	Printf(string, ...interface{})
}

// LoggerFunc is a bridge between Logger and any third party logger.
type LoggerFunc func(string, ...interface{})

func (f LoggerFunc) Printf(msg string, args ...interface{}) { f(msg, args...) }

// DurationStats is a data structure that carries a summary of observed duration values.
type DurationStats struct {
	Avg   time.Duration `metric:"avg" type:"gauge"`
	Min   time.Duration `metric:"min" type:"gauge"`
	Max   time.Duration `metric:"max" type:"gauge"`
	Count int64         `metric:"count" type:"counter"`
	Sum   time.Duration `metric:"sum" type:"counter"`
}

// SummaryStats is a data structure that carries a summary of observed values.
type SummaryStats struct {
	Avg   int64 `metric:"avg" type:"gauge"`
	Min   int64 `metric:"min" type:"gauge"`
	Max   int64 `metric:"max" type:"gauge"`
	Count int64 `metric:"count" type:"counter"`
	Sum   int64 `metric:"sum" type:"counter"`
}

type summary struct {
	count, sum, min, max int64
}

func (s *summary) observe(v int64) {
	if s.count == 0 || v < s.min {
		s.min = v
	}
	if s.count == 0 || v > s.max {
		s.max = v
	}
	s.count++
	s.sum += v
}

func (s *summary) snapshot() SummaryStats {
	out := SummaryStats{Min: s.min, Max: s.max, Count: s.count, Sum: s.sum}
	if s.count > 0 {
		out.Avg = s.sum / s.count
	}
	return out
}

func (s *summary) snapshotDuration() DurationStats {
	x := s.snapshot()
	return DurationStats{Avg: time.Duration(x.Avg), Min: time.Duration(x.Min), Max: time.Duration(x.Max), Count: x.Count, Sum: time.Duration(x.Sum)}
}

// TCP constructs an address with the network set to "tcp".
func TCP(address ...string) net.Addr { return makeNetAddr("tcp", address) }

func makeNetAddr(network string, addresses []string) net.Addr {
	switch len(addresses) {
	case 0:
		return nil
	case 1:
		return &networkAddress{network: network, address: canonicalAddress(addresses[0])}
	default:
		canon := make([]string, len(addresses))
		for i, a := range addresses {
			canon[i] = canonicalAddress(a)
		}
		return &networkAddress{network: network, address: strings.Join(canon, ",")}
	}
}

type networkAddress struct {
	network string
	address string
}

func (a *networkAddress) Network() string { return a.network }

func (a *networkAddress) String() string { return a.address }

func canonicalAddress(s string) string {
	host, port, err := net.SplitHostPort(s)
	if err != nil {
		host, port = s, "9092"
	}
	return net.JoinHostPort(host, port)
}

func broker() *mk.Broker { return mk.Default() }

// backoff is the library's retry delay: attempt² × min, at most max.
func backoff(attempt int, min time.Duration, max time.Duration) time.Duration {
	d := time.Duration(attempt*attempt) * min
	if d > max {
		d = max
	}
	return d
}
