// Package kafka is the in-memory Kafka cluster the Go runtime's clients (the kafka-go and the
// confluent-kafka-go models) and the harness share: topics with partitions, key hashing, consumer
// groups with committed offsets and partition assignment, and delivery acknowledgements that can
// fail, stall, be lost or vanish in a leader failover. The semantics are those of `Broker` in the
// TypeScript runtime (src/lib/runtime/ts/kafka.ts) and the Python one, so a check grades the same
// property in every language.
//
// Time is virtual (vclock). Nothing here polls: every change (an append, a stall ending, a
// rebalance, a reset) closes the channel Changed returned, and waiting clients select on it.
package kafka

import (
	"fmt"
	"hash/crc32"
	"sort"
	"sync"
	"time"

	"leetbuild/goruntime/vclock"
)

// DefaultPartitions is the partition count of a topic created on first use.
const DefaultPartitions = 3

// ReplicationLag is how long a record acknowledged by the leader alone (acks 0/1) stays only on the
// leader: a failover within it loses the record.
const ReplicationLag = 100 * time.Millisecond

// Header is a record header.
type Header struct {
	Key   string
	Value []byte
}

// Record is a record in a partition log.
type Record struct {
	Topic     string
	Partition int
	Offset    int64
	Key       []byte
	Value     []byte
	Headers   []Header
	Timestamp time.Time
	// Seq is the global production order (1, 2, …) across every topic and partition.
	Seq int
}

// Header returns the value of the first header called name.
func (r Record) Header(name string) ([]byte, bool) {
	for _, h := range r.Headers {
		if h.Key == name {
			return h.Value, true
		}
	}
	return nil, false
}

// TopicPartition names a partition.
type TopicPartition struct {
	Topic     string
	Partition int
}

// String is "topic|partition", the key the TypeScript and Python harnesses use.
func (tp TopicPartition) String() string { return fmt.Sprintf("%s|%d", tp.Topic, tp.Partition) }

// Offsets maps partitions to offsets (a commit: the next offset to read).
type Offsets map[TopicPartition]int64

func (o Offsets) clone() Offsets {
	out := make(Offsets, len(o))
	for k, v := range o {
		out[k] = v
	}
	return out
}

// Event is one entry of the broker's log, which checks read to see what the clients did. Kind is
// one of the TypeScript runtime's event names; the other fields are set as the kind needs:
//
//	produce, seed             Topic, Partition, Offset (seed: a record the harness put there)
//	produce-failed            Topic (a FailNext failure)
//	produce-stalled           Topic (the record waits for a stalled broker)
//	produce-lost              Topic (acks=0 on a stalled broker: reported sent, never written)
//	produce-timed-out         Topic (the producer gave up waiting for the acknowledgement)
//	ack-lost                  Topic (written, the acknowledgement lost: the producer retried)
//	failover                  Topic ("" every topic), Lost
//	flush                     a confluent Producer.Flush
//	producer, consumer        Client ("kafka-go" or "confluent"); consumer: Group
//	subscribe                 Group, Topics
//	deliver                   Group, Topic, Partition, Offset (a record handed to the learner)
//	commit                    Group, Offsets (every commit, the harness's included)
//	manual-commit             Group (the commit was the learner's explicit call)
//	auto-commit               Group (the client committed by itself: a timer, ReadMessage)
//	close                     Group (a consumer closed)
type Event struct {
	Kind      string
	Group     string
	Topic     string
	Partition int
	Offset    int64
	Topics    []string
	Offsets   Offsets
	Lost      int
	Client    string
}

// ConsumerInfo describes a consumer for the harness.
type ConsumerInfo struct {
	// Client is "kafka-go" or "confluent".
	Client string
	Group  string
	Topics []string
	// AutoCommit: the client commits on its own (confluent enable.auto.commit; kafka-go: a
	// CommitInterval timer, or ReadMessage committing what it returns).
	AutoCommit         bool
	AutoCommitInterval time.Duration
	// Config is the client's configuration as text (confluent: the ConfigMap).
	Config     map[string]string
	Assignment []TopicPartition
	Closed     bool
}

// Write is a produce request for one record.
type Write struct {
	Topic string
	// Partition < 0: the broker's partitioner (PartitionFor).
	Partition int
	Key       []byte
	Value     []byte
	Headers   []Header
	// Time is the record's timestamp; zero: now.
	Time time.Time
	// Acks is the producer's acks: -1 all, 0 none, 1 the leader.
	Acks       int
	Idempotent bool
}

type stall struct {
	until   time.Time
	forever bool
}

type unreplicated struct {
	record *Record
	at     time.Time
}

type group struct {
	members    []*Member
	generation int
}

// Member is a consumer's membership of a group.
type Member struct {
	broker *Broker
	group  string
	topics []string
	// session is how long the member may stay away from fetching once a newer member joined.
	session  time.Duration
	fetching int
	evict    func() bool
	gen      int
	tps      []TopicPartition
	ends     map[TopicPartition]int64
	left     bool
}

// Broker is the cluster.
type Broker struct {
	mu             sync.Mutex
	epoch          int
	topics         map[string][][]*Record
	topicOrder     []string
	committed      map[string]Offsets
	events         []Event
	seq            int
	failing        map[string]int
	stalls         map[string]stall
	ackLosses      map[string]int
	unreplicated   []unreplicated
	commitHooks    []func(group string, offsets Offsets)
	subscribeHooks []func(group string, topics []string)
	groups         map[string]*group
	consumers      []func() ConsumerInfo
	resetHooks     []func()
	flushes        int
	produced       int
	delivered      int
	commits        int
	changed        chan struct{}
}

// New returns an empty broker.
func New() *Broker {
	b := &Broker{changed: make(chan struct{})}
	b.clear()
	return b
}

var std = New()

// Default is the broker the clients and the harness share.
func Default() *Broker { return std }

// Reset empties the shared broker before a check: no topics, commits, failure rules or hooks, and
// the clients of the previous check are stale (their calls park for good, their timers stop).
func Reset() { std.Reset() }

// Metrics is what the learner's clients did since the last Reset: records produced, records
// delivered to the learner, commits made (the harness's seeds and commits are not counted).
func Metrics() (produced, delivered, commits int) { return std.Metrics() }

// Park blocks the calling goroutine for good: a stale client (made before the last Reset) stops.
func Park() { select {} }

func (b *Broker) clear() {
	b.topics = map[string][][]*Record{}
	b.topicOrder = nil
	b.committed = map[string]Offsets{}
	b.events = nil
	b.seq = 0
	b.failing = map[string]int{}
	b.stalls = map[string]stall{}
	b.ackLosses = map[string]int{}
	b.unreplicated = nil
	b.commitHooks = nil
	b.subscribeHooks = nil
	b.groups = map[string]*group{}
	b.consumers = nil
	b.flushes, b.produced, b.delivered, b.commits = 0, 0, 0, 0
}

// Reset empties the broker and makes every client made so far stale.
func (b *Broker) Reset() {
	b.mu.Lock()
	hooks := b.resetHooks
	b.resetHooks = nil
	b.epoch++
	b.clear()
	b.notifyLocked()
	b.mu.Unlock()
	for _, h := range hooks {
		h()
	}
}

// Metrics: see the package-level Metrics.
func (b *Broker) Metrics() (produced, delivered, commits int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.produced, b.delivered, b.commits
}

// Epoch identifies the world since the last Reset; a client remembers it at creation.
func (b *Broker) Epoch() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.epoch
}

// Stale reports whether a Reset happened since epoch.
func (b *Broker) Stale(epoch int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.epoch != epoch
}

// OnReset runs f at the next Reset (a client's timers stop with its world). f must not block.
func (b *Broker) OnReset(f func()) {
	b.mu.Lock()
	b.resetHooks = append(b.resetHooks, f)
	b.mu.Unlock()
}

// Changed is closed at the next change: an append, a stall or resume, a rebalance, a reset. Take
// it before looking at the state, then wait on it.
func (b *Broker) Changed() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.changed
}

// Notify wakes every waiter (a client changed something its waiters watch, e.g. a pause).
func (b *Broker) Notify() {
	b.mu.Lock()
	b.notifyLocked()
	b.mu.Unlock()
}

func (b *Broker) notifyLocked() {
	close(b.changed)
	b.changed = make(chan struct{})
}

// Log appends an event.
func (b *Broker) Log(e Event) {
	b.mu.Lock()
	b.events = append(b.events, e)
	b.mu.Unlock()
}

// Events is the log so far.
func (b *Broker) Events() []Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Event, len(b.events))
	copy(out, b.events)
	return out
}

// ---- topics ------------------------------------------------------------------------------------

// CreateTopic creates topic with partitions (<= 0: DefaultPartitions) unless it exists.
func (b *Broker) CreateTopic(topic string, partitions int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.topics[topic]; ok {
		return false
	}
	b.createLocked(topic, partitions)
	return true
}

func (b *Broker) createLocked(topic string, partitions int) [][]*Record {
	if partitions <= 0 {
		partitions = DefaultPartitions
	}
	logs := make([][]*Record, partitions)
	b.topics[topic] = logs
	b.topicOrder = append(b.topicOrder, topic)
	return logs
}

// DeleteTopic removes topic and its records.
func (b *Broker) DeleteTopic(topic string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.topics[topic]; !ok {
		return false
	}
	delete(b.topics, topic)
	for i, t := range b.topicOrder {
		if t == topic {
			b.topicOrder = append(b.topicOrder[:i:i], b.topicOrder[i+1:]...)
			break
		}
	}
	b.notifyLocked()
	return true
}

func (b *Broker) logsLocked(topic string) [][]*Record {
	if logs, ok := b.topics[topic]; ok {
		return logs
	}
	return b.createLocked(topic, 0)
}

// HasTopic reports whether topic exists.
func (b *Broker) HasTopic(topic string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.topics[topic]
	return ok
}

// Partitions is topic's partition count, creating the topic on first use.
func (b *Broker) Partitions(topic string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.logsLocked(topic))
}

// Topics lists the topics in creation order.
func (b *Broker) Topics() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.topicOrder...)
}

// PartitionFor is the broker's partitioner, the one a client uses when it does not pick the
// partition itself (librdkafka's default consistent_random, the TypeScript and Python runtimes'):
// a key hashes with CRC-32 modulo the partition count; no key spreads records round-robin.
func (b *Broker) PartitionFor(topic string, key []byte) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.partitionForLocked(topic, key)
}

func (b *Broker) partitionForLocked(topic string, key []byte) int {
	n := len(b.logsLocked(topic))
	if key == nil {
		return b.seq % n
	}
	return int(crc32.ChecksumIEEE(key) % uint32(n))
}

func (b *Broker) appendLocked(topic string, partition int, key, value []byte, headers []Header, at time.Time, kind string) *Record {
	logs := b.logsLocked(topic)
	if partition < 0 {
		partition = b.partitionForLocked(topic, key)
	}
	if partition >= len(logs) {
		partition = len(logs) - 1
	}
	if at.IsZero() {
		at = vclock.Now()
	}
	b.seq++
	r := &Record{
		Topic:     topic,
		Partition: partition,
		Offset:    int64(len(logs[partition])),
		Key:       clone(key),
		Value:     clone(value),
		Headers:   cloneHeaders(headers),
		Timestamp: at,
		Seq:       b.seq,
	}
	logs[partition] = append(logs[partition], r)
	b.events = append(b.events, Event{Kind: kind, Topic: topic, Partition: partition, Offset: r.Offset})
	b.notifyLocked()
	return r
}

// Seed puts a record from another producer on topic (partition < 0: the broker's partitioner):
// redeliveries, duplicates, poison messages. It is not the learner's produce.
func (b *Broker) Seed(topic string, partition int, key, value []byte, headers []Header) Record {
	b.mu.Lock()
	defer b.mu.Unlock()
	return *b.appendLocked(topic, partition, key, value, headers, time.Time{}, "seed")
}

// Write is a learner's client writing one record the broker accepted: acks 0/1 leave it
// unreplicated for ReplicationLag; a lost acknowledgement (LoseAcks) makes the producer retry, which
// writes the record again unless the producer is idempotent. It returns the record the producer's
// acknowledgement reports (the retry's, when there was one).
func (b *Broker) Write(w Write) Record {
	b.mu.Lock()
	defer b.mu.Unlock()
	return *b.writeLocked(w)
}

func (b *Broker) writeLocked(w Write) *Record {
	r := b.appendLocked(w.Topic, w.Partition, w.Key, w.Value, w.Headers, w.Time, "produce")
	b.produced++
	now := vclock.Now()
	if w.Acks != -1 {
		b.unreplicated = append(b.unreplicated, unreplicated{r, now})
	}
	if n := b.ackLosses[w.Topic]; n > 0 {
		b.ackLosses[w.Topic] = n - 1
		b.events = append(b.events, Event{Kind: "ack-lost", Topic: w.Topic})
		if !w.Idempotent {
			// The retry of a write whose acknowledgement was lost is written again.
			r = b.appendLocked(w.Topic, r.Partition, w.Key, w.Value, w.Headers, w.Time, "produce")
			b.produced++
			if w.Acks != -1 {
				b.unreplicated = append(b.unreplicated, unreplicated{r, now})
			}
		}
	}
	return r
}

// ---- failure injection -------------------------------------------------------------------------

// FailNext makes the next times produces to topic fail with a delivery error.
func (b *Broker) FailNext(topic string, times int) {
	b.mu.Lock()
	b.failing[topic] += times
	b.mu.Unlock()
}

// TakeFailure consumes one FailNext of topic: true if this produce fails (logged produce-failed).
func (b *Broker) TakeFailure(topic string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failing[topic] <= 0 {
		return false
	}
	b.failing[topic]--
	b.events = append(b.events, Event{Kind: "produce-failed", Topic: topic})
	return true
}

// Stall stops the broker acknowledging produces to topic ("" every topic) — a dead or partitioned
// cluster — for d of virtual time (d <= 0: until Resume).
func (b *Broker) Stall(topic string, d time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if d <= 0 {
		b.stalls[topic] = stall{forever: true}
	} else {
		b.stalls[topic] = stall{until: vclock.Now().Add(d)}
	}
	b.notifyLocked()
}

// Resume ends the stall of topic ("" every stall).
func (b *Broker) Resume(topic string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if topic == "" {
		b.stalls = map[string]stall{}
	} else {
		delete(b.stalls, topic)
	}
	b.notifyLocked()
}

// StalledUntil reports whether produces to topic are stalled now, and until when (zero: until
// resumed).
func (b *Broker) StalledUntil(topic string) (until time.Time, stalled bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.stalledUntilLocked(topic)
}

func (b *Broker) stalledUntilLocked(topic string) (time.Time, bool) {
	now := vclock.Now()
	var until time.Time
	stalled := false
	for _, key := range []string{"", topic} {
		s, ok := b.stalls[key]
		if !ok {
			continue
		}
		if s.forever {
			return time.Time{}, true
		}
		if s.until.After(now) {
			stalled = true
			if s.until.After(until) {
				until = s.until
			}
		}
	}
	return until, stalled
}

// LoseAcks: the next times produce requests to topic are written but their acknowledgement is lost.
func (b *Broker) LoseAcks(topic string, times int) {
	b.mu.Lock()
	b.ackLosses[topic] += times
	b.mu.Unlock()
}

// Failover fails the partition leaders of topic ("" every topic): records acknowledged by the leader
// alone (acks 0/1) within the last ReplicationLag are gone. It returns how many were lost.
func (b *Broker) Failover(topic string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := vclock.Now()
	var keep []unreplicated
	lost := map[*Record]bool{}
	for _, u := range b.unreplicated {
		if (topic == "" || u.record.Topic == topic) && now.Sub(u.at) < ReplicationLag {
			lost[u.record] = true
		} else {
			keep = append(keep, u)
		}
	}
	b.unreplicated = keep
	touched := map[string]bool{}
	for r := range lost {
		touched[r.Topic] = true
	}
	for name := range touched {
		logs := b.topics[name]
		for p, log := range logs {
			kept := log[:0]
			for _, r := range log {
				if !lost[r] {
					r.Offset = int64(len(kept))
					kept = append(kept, r)
				}
			}
			logs[p] = kept
		}
	}
	b.events = append(b.events, Event{Kind: "failover", Topic: topic, Lost: len(lost)})
	b.notifyLocked()
	return len(lost)
}

// CountFlush records a producer flush.
func (b *Broker) CountFlush() {
	b.mu.Lock()
	b.flushes++
	b.events = append(b.events, Event{Kind: "flush"})
	b.mu.Unlock()
}

// Flushes counts the producer flushes so far.
func (b *Broker) Flushes() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.flushes
}

// ---- reading -----------------------------------------------------------------------------------

// Records is everything on topic, in production order.
func (b *Broker) Records(topic string) []Record {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Record
	for _, log := range b.topics[topic] {
		for _, r := range log {
			out = append(out, *r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

// EndOffset is the offset the next record of the partition gets (the high watermark).
func (b *Broker) EndOffset(topic string, partition int) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	logs := b.logsLocked(topic)
	if partition < 0 || partition >= len(logs) {
		return 0
	}
	return int64(len(logs[partition]))
}

// Fetch returns the record at offset of the partition, if there is one yet.
func (b *Broker) Fetch(topic string, partition int, offset int64) (Record, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	logs := b.logsLocked(topic)
	if partition < 0 || partition >= len(logs) || offset < 0 || offset >= int64(len(logs[partition])) {
		return Record{}, false
	}
	return *logs[partition][offset], true
}

// Delivered records that a client handed a record to the learner (logged deliver, counted).
func (b *Broker) Delivered(group string, r Record) {
	b.mu.Lock()
	b.delivered++
	b.events = append(b.events, Event{Kind: "deliver", Group: group, Topic: r.Topic, Partition: r.Partition, Offset: r.Offset})
	b.mu.Unlock()
}

// ---- groups ------------------------------------------------------------------------------------

// Commit stores offsets for group. kind is how the learner's client committed ("manual-commit" or
// "auto-commit", logged after the commit hooks ran) or "" for the harness's own commit, which is
// not counted.
func (b *Broker) Commit(group string, offsets Offsets, kind string) {
	b.mu.Lock()
	stored := b.committed[group]
	if stored == nil {
		stored = Offsets{}
		b.committed[group] = stored
	}
	for tp, o := range offsets {
		stored[tp] = o
	}
	b.events = append(b.events, Event{Kind: "commit", Group: group, Offsets: offsets.clone()})
	if kind != "" {
		b.commits++
	}
	hooks := append(([]func(string, Offsets))(nil), b.commitHooks...)
	b.notifyLocked()
	b.mu.Unlock()
	for _, h := range hooks {
		h(group, offsets.clone())
	}
	if kind != "" {
		b.Log(Event{Kind: kind, Group: group})
	}
}

// CommittedOffset is the group's committed offset of the partition, if any.
func (b *Broker) CommittedOffset(group, topic string, partition int) (int64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o, ok := b.committed[group][TopicPartition{topic, partition}]
	return o, ok
}

// Commits lists the offsets of every commit of group ("" every group), in order.
func (b *Broker) Commits(group string) []Offsets {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Offsets
	for _, e := range b.events {
		if e.Kind == "commit" && (group == "" || e.Group == group) {
			out = append(out, e.Offsets.clone())
		}
	}
	return out
}

// Lag counts the records of topic the group has not committed.
func (b *Broker) Lag(group, topic string) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	var lag int64
	for p, log := range b.logsLocked(topic) {
		lag += int64(len(log)) - b.committed[group][TopicPartition{topic, p}]
	}
	return lag
}

// OnCommit runs hook(group, offsets) at every commit, before the committer's call returns.
func (b *Broker) OnCommit(hook func(group string, offsets Offsets)) {
	b.mu.Lock()
	b.commitHooks = append(b.commitHooks, hook)
	b.mu.Unlock()
}

// OnSubscribe runs hook(group, topics) when a consumer joins a group, before it reads anything.
func (b *Broker) OnSubscribe(hook func(group string, topics []string)) {
	b.mu.Lock()
	b.subscribeHooks = append(b.subscribeHooks, hook)
	b.mu.Unlock()
}

// RegisterConsumer lists a consumer for the harness; info describes it when asked.
func (b *Broker) RegisterConsumer(info func() ConsumerInfo) {
	b.mu.Lock()
	b.consumers = append(b.consumers, info)
	b.mu.Unlock()
}

// Consumers describes every consumer created since the last Reset, in creation order.
func (b *Broker) Consumers() []ConsumerInfo {
	b.mu.Lock()
	infos := append([]func() ConsumerInfo(nil), b.consumers...)
	b.mu.Unlock()
	out := make([]ConsumerInfo, len(infos))
	for i, f := range infos {
		out[i] = f()
	}
	return out
}

// Join makes a consumer a member of group subscribed to topics (created on first use): the group
// rebalances — its members split every topic's partitions, contiguous ranges in join order, as
// kafka-go's RangeGroupBalancer and librdkafka's range assignor do — and the subscribe hooks run.
//
// A member that is not fetching when another one joins is presumed gone (a crashed process whose
// client was replaced), as the coordinator presumes a member that does not rejoin: the rebalance
// waits for it — the newcomer owns nothing yet — until it fetches again (it rejoins; the rebalance
// completes) or its session timeout passes (it is evicted; the rebalance completes without it).
func (b *Broker) Join(groupID string, topics []string, sessionTimeout time.Duration) *Member {
	b.mu.Lock()
	for _, t := range topics {
		b.logsLocked(t)
	}
	g := b.groups[groupID]
	if g == nil {
		g = &group{}
		b.groups[groupID] = g
	}
	for _, peer := range g.members {
		if peer.fetching == 0 && peer.evict == nil {
			b.armEvictionLocked(peer)
		}
	}
	m := &Member{broker: b, group: groupID, topics: append([]string(nil), topics...), session: sessionTimeout}
	g.members = append(g.members, m)
	b.rebalanceLocked(g)
	b.events = append(b.events, Event{Kind: "subscribe", Group: groupID, Topics: append([]string(nil), topics...)})
	hooks := append(([]func(string, []string))(nil), b.subscribeHooks...)
	b.mu.Unlock()
	for _, h := range hooks {
		h(groupID, append([]string(nil), topics...))
	}
	return m
}

func (b *Broker) armEvictionLocked(m *Member) {
	epoch := b.epoch
	t := vclock.AfterFunc(m.session, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.epoch != epoch || m.evict == nil || m.left {
			return
		}
		m.evict = nil
		b.leaveLocked(m)
	})
	m.evict = t.Stop
	b.resetHooks = append(b.resetHooks, func() { t.Stop() })
}

// Fetching marks the member as inside a fetch (its process is alive) until the returned func is
// called; it cancels a pending eviction.
func (m *Member) Fetching() (done func()) {
	b := m.broker
	b.mu.Lock()
	m.fetching++
	if m.evict != nil {
		m.evict()
		m.evict = nil
		if g := b.groups[m.group]; g != nil && !m.left {
			b.rebalanceLocked(g)
		}
	}
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		m.fetching--
		b.mu.Unlock()
	}
}

// Left reports whether the member left its group or was evicted.
func (m *Member) Left() bool {
	b := m.broker
	b.mu.Lock()
	defer b.mu.Unlock()
	return m.left
}

// rebalanceLocked assigns the group's partitions to its members, unless the rebalance still waits
// for a member to rejoin.
func (b *Broker) rebalanceLocked(g *group) {
	for _, m := range g.members {
		if m.evict != nil {
			b.notifyLocked()
			return
		}
	}
	g.generation++
	byTopic := map[string][]*Member{}
	var topics []string
	for _, m := range g.members {
		m.tps = nil
		m.ends = map[TopicPartition]int64{}
		m.gen = g.generation
		for _, t := range m.topics {
			if byTopic[t] == nil {
				topics = append(topics, t)
			}
			byTopic[t] = append(byTopic[t], m)
		}
	}
	sort.Strings(topics)
	for _, t := range topics {
		members := byTopic[t]
		n := len(b.logsLocked(t))
		per, extra := n/len(members), n%len(members)
		next := 0
		for i, m := range members {
			count := per
			if i < extra {
				count++
			}
			for p := next; p < next+count; p++ {
				m.tps = append(m.tps, TopicPartition{t, p})
				m.ends[TopicPartition{t, p}] = int64(len(b.topics[t][p]))
			}
			next += count
		}
	}
	b.notifyLocked()
}

// Group is the member's group id.
func (m *Member) Group() string { return m.group }

// Assignment is the member's generation and the partitions it owns in it.
func (m *Member) Assignment() (generation int, partitions []TopicPartition) {
	b := m.broker
	b.mu.Lock()
	defer b.mu.Unlock()
	return m.gen, append([]TopicPartition(nil), m.tps...)
}

// EndAtAssignment is the partition's end offset when the member was assigned it: where a member
// starting at the latest offset begins, whatever was appended since (a subscribe hook's seed).
func (m *Member) EndAtAssignment(tp TopicPartition) (int64, bool) {
	b := m.broker
	b.mu.Lock()
	defer b.mu.Unlock()
	o, ok := m.ends[tp]
	return o, ok
}

// Leave takes the member out of its group; the others rebalance.
func (m *Member) Leave() {
	b := m.broker
	b.mu.Lock()
	defer b.mu.Unlock()
	if m.evict != nil {
		m.evict()
		m.evict = nil
	}
	b.leaveLocked(m)
}

func (b *Broker) leaveLocked(m *Member) {
	if m.left {
		return
	}
	m.left = true
	m.tps = nil
	g := b.groups[m.group]
	if g == nil {
		return
	}
	for i, x := range g.members {
		if x == m {
			g.members = append(g.members[:i:i], g.members[i+1:]...)
			break
		}
	}
	b.rebalanceLocked(g)
}

func clone(b []byte) []byte {
	if b == nil {
		return nil
	}
	return append([]byte{}, b...)
}

func cloneHeaders(hs []Header) []Header {
	if len(hs) == 0 {
		return nil
	}
	out := make([]Header, len(hs))
	for i, h := range hs {
		out[i] = Header{Key: h.Key, Value: clone(h.Value)}
	}
	return out
}
