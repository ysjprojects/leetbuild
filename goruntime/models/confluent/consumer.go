package kafka

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

// RebalanceCb provides a per-Subscribe*() rebalance event callback.
// The passed Event will be either AssignedPartitions or RevokedPartitions
type RebalanceCb func(*Consumer, Event) error

// Consumer implements a High-level Apache Kafka Consumer instance.
//
// Subscribe joins the consumer group (group.id is required): the group's members split the
// partitions, and each assigned partition starts at the group's committed offset, else at
// auto.offset.reset (latest by default). Poll and ReadMessage deliver the next record round-robin
// over the unpaused partitions, waiting on the virtual clock for the timeout. With
// enable.auto.offset.store (default) every delivered record's offset+1 is stored; with
// enable.auto.commit (default) the stored offsets are committed every auto.commit.interval.ms
// (default 5 s) and on Close.
type Consumer struct {
	name       string
	epoch      int
	conf       ConfigMap
	group      string
	autoCommit bool
	autoStore  bool
	interval   time.Duration
	earliest   bool
	eof        bool
	session    time.Duration

	mu           sync.Mutex
	closed       bool
	member       *mk.Member
	subscription []string
	rebalanceCb  RebalanceCb
	gen          int
	assigned     []mk.TopicPartition
	positions    map[mk.TopicPartition]int64
	stored       map[mk.TopicPartition]int64
	paused       map[mk.TopicPartition]bool
	atEOF        map[mk.TopicPartition]bool
	rr           int
	wake         chan struct{}
	stopTimer    func()
	assignCalled bool
}

// NewConsumer creates a new high-level Consumer instance.
//
// conf is a *ConfigMap with standard librdkafka configuration properties.
//
// Supported special configuration properties:
//
//	go.application.rebalance.enable (bool, false) - Forward rebalancing responsibility to application via the Events() channel.
//	                                     If set to true the app must handle the AssignedPartitions and
//	                                     RevokedPartitions events and call Assign() and Unassign()
//	                                     respectively.
//	go.events.channel.enable (bool, false) - [deprecated] Enable the Events() channel. Messages and events will be pushed on the Events() channel and the Poll() interface will be disabled.
//	go.events.channel.size (int, 1000) - Events() channel size
//	go.logs.channel.enable (bool, false) - Forward log to Logs() channel.
//	go.logs.channel (chan kafka.LogEvent, nil) - Forward logs to application-provided channel instead of Logs(). Requires go.logs.channel.enable=true.
func NewConsumer(conf *ConfigMap) (*Consumer, error) {
	if conf == nil {
		conf = &ConfigMap{}
	}
	cm := conf.clone()
	group, ok := cm.lookup("group.id")
	if !ok || group == "" {
		// without a group.id the underlying cgrp subsystem in librdkafka wont get started
		// and without it there is no way to consume assigned partitions.
		return nil, newErrorFromString(ErrInvalidArg, "Required property group.id not set")
	}
	autoCommit, err := cm.boolean(true, "enable.auto.commit")
	if err != nil {
		return nil, err
	}
	autoStore, err := cm.boolean(true, "enable.auto.offset.store")
	if err != nil {
		return nil, err
	}
	interval, err := cm.millis(5*time.Second, "auto.commit.interval.ms")
	if err != nil {
		return nil, err
	}
	session, err := cm.millis(45*time.Second, "session.timeout.ms")
	if err != nil {
		return nil, err
	}
	eof, err := cm.boolean(false, "enable.partition.eof")
	if err != nil {
		return nil, err
	}
	earliest := false
	if s, ok := cm.lookup("auto.offset.reset"); ok {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "smallest", "earliest", "beginning":
			earliest = true
		case "largest", "latest", "end", "error":
		default:
			return nil, newErrorFromString(ErrInvalidArg, fmt.Sprintf("Invalid value \"%s\" for configuration property \"auto.offset.reset\"", s))
		}
	}
	clientSeq.Lock()
	clientSeq.consumers++
	n := clientSeq.consumers
	clientSeq.Unlock()
	b := mk.Default()
	c := &Consumer{
		name:       fmt.Sprintf("rdkafka#consumer-%d", n),
		epoch:      b.Epoch(),
		conf:       cm,
		group:      group,
		autoCommit: autoCommit,
		autoStore:  autoStore,
		interval:   interval,
		earliest:   earliest,
		eof:        eof,
		session:    session,
		positions:  map[mk.TopicPartition]int64{},
		stored:     map[mk.TopicPartition]int64{},
		paused:     map[mk.TopicPartition]bool{},
		atEOF:      map[mk.TopicPartition]bool{},
		wake:       make(chan struct{}),
	}
	if autoCommit && interval > 0 {
		epoch := c.epoch
		stop := vclock.Get().Every(interval, func() {
			defer world.Recover()
			if b.Stale(epoch) {
				return
			}
			c.commitStored("auto-commit")
		})
		c.stopTimer = stop
		b.OnReset(stop)
	}
	b.RegisterConsumer(c.info)
	b.Log(mk.Event{Kind: "consumer", Group: group, Client: "confluent"})
	return c, nil
}

func (c *Consumer) info() mk.ConsumerInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return mk.ConsumerInfo{
		Client:             "confluent",
		Group:              c.group,
		Topics:             append([]string(nil), c.subscription...),
		AutoCommit:         c.autoCommit,
		AutoCommitInterval: c.interval,
		Config:             c.conf.text(),
		Assignment:         append([]mk.TopicPartition(nil), c.assigned...),
		Closed:             c.closed,
	}
}

// String returns a human readable name for a Consumer instance
func (c *Consumer) String() string { return c.name }

// IsClosed returns boolean representing if client is closed or not
func (c *Consumer) IsClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// verify parks a consumer of a previous check and refuses a closed one.
func (c *Consumer) verify() error {
	if mk.Default().Stale(c.epoch) {
		mk.Park()
	}
	if c.IsClosed() {
		return errClosed()
	}
	return nil
}

func (c *Consumer) wakeLocked() {
	close(c.wake)
	c.wake = make(chan struct{})
}

// Subscribe to a single topic
// This replaces the current subscription
func (c *Consumer) Subscribe(topic string, rebalanceCb RebalanceCb) error {
	return c.SubscribeTopics([]string{topic}, rebalanceCb)
}

// SubscribeTopics subscribes to the provided list of topics.
// This replaces the current subscription.
func (c *Consumer) SubscribeTopics(topics []string, rebalanceCb RebalanceCb) (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	old := c.member
	c.member = nil
	c.mu.Unlock()
	if old != nil {
		old.Leave()
	}
	m := mk.Default().Join(c.group, topics, c.session)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.member = m
	c.subscription = append([]string(nil), topics...)
	c.rebalanceCb = rebalanceCb
	c.gen = 0
	c.wakeLocked()
	return nil
}

// Unsubscribe from the current subscription, if any.
func (c *Consumer) Unsubscribe() (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	m := c.member
	c.member = nil
	c.subscription = nil
	c.assigned = nil
	c.mu.Unlock()
	if m != nil {
		m.Leave()
	}
	return nil
}

// Subscription returns the current subscription as set by Subscribe()
func (c *Consumer) Subscription() (topics []string, err error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.subscription...), nil
}

// startLocked is where an assigned partition starts: the offset asked for, else the group's
// committed offset, else auto.offset.reset.
func (c *Consumer) startLocked(tp mk.TopicPartition, offset Offset) int64 {
	b := mk.Default()
	end := b.EndOffset(tp.Topic, tp.Partition)
	switch {
	case offset >= 0:
		return int64(offset)
	case offset == OffsetBeginning:
		return 0
	case offset == OffsetEnd:
		return end
	case offset <= -2000:
		start := end - (-2000 - int64(offset))
		if start < 0 {
			start = 0
		}
		return start
	}
	if o, ok := b.CommittedOffset(c.group, tp.Topic, tp.Partition); ok {
		return o
	}
	if c.earliest {
		return 0
	}
	// latest: the end as of the group assignment (records appended since are read).
	if c.member != nil {
		if at, ok := c.member.EndAtAssignment(tp); ok {
			return at
		}
	}
	return end
}

func (c *Consumer) assignLocked(partitions []TopicPartition) {
	c.assigned = nil
	c.positions = map[mk.TopicPartition]int64{}
	for _, p := range partitions {
		tp := p.key()
		c.assigned = append(c.assigned, tp)
		c.positions[tp] = c.startLocked(tp, p.Offset)
	}
	c.assignCalled = true
	c.wakeLocked()
}

// Assign an atomic set of partitions to consume.
//
// The .Offset field of each TopicPartition must either be set to an absolute
// starting offset (>= 0), or one of the logical offsets (`kafka.OffsetEnd` etc),
// but should typically be set to `kafka.OffsetStored` to have the consumer
// use the committed offset as a start position, with a fallback to
// `auto.offset.reset` if there is no committed offset.
//
// This replaces the current assignment.
func (c *Consumer) Assign(partitions []TopicPartition) (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.assignLocked(partitions)
	return nil
}

// Unassign the current set of partitions to consume.
func (c *Consumer) Unassign() (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.assigned = nil
	c.assignCalled = true
	return nil
}

// IncrementalAssign adds the specified partitions to the current set of
// partitions to consume.
func (c *Consumer) IncrementalAssign(partitions []TopicPartition) (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range partitions {
		tp := p.key()
		if _, ok := c.positions[tp]; !ok || !c.ownsLocked(tp) {
			c.assigned = append(c.assigned, tp)
		}
		c.positions[tp] = c.startLocked(tp, p.Offset)
	}
	c.assignCalled = true
	c.wakeLocked()
	return nil
}

// IncrementalUnassign removes the specified partitions from the current set of
// partitions to consume.
func (c *Consumer) IncrementalUnassign(partitions []TopicPartition) (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	drop := map[mk.TopicPartition]bool{}
	for _, p := range partitions {
		drop[p.key()] = true
	}
	kept := c.assigned[:0]
	for _, tp := range c.assigned {
		if !drop[tp] {
			kept = append(kept, tp)
		}
	}
	c.assigned = kept
	c.assignCalled = true
	return nil
}

// GetRebalanceProtocol returns the current consumer group rebalance protocol,
// which is either "EAGER" or "COOPERATIVE".
// If the rebalance protocol is not known in the current state an empty string
// is returned.
// Should typically only be called during rebalancing.
func (c *Consumer) GetRebalanceProtocol() string { return "EAGER" }

// AssignmentLost returns true if current partition assignment has been lost.
// This method is only applicable for use with a subscribing consumer when
// handling a rebalance event or callback.
// Partitions that have been lost may already be owned by other members in the
// group and therefore commiting offsets, for example, may fail.
func (c *Consumer) AssignmentLost() bool { return false }

// Assignment returns the current partition assignments
func (c *Consumer) Assignment() (partitions []TopicPartition, err error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, tp := range c.assigned {
		partitions = append(partitions, topicPartition(tp, OffsetInvalid))
	}
	return partitions, nil
}

func (c *Consumer) ownsLocked(tp mk.TopicPartition) bool {
	for _, x := range c.assigned {
		if x == tp {
			return true
		}
	}
	return false
}

// rebalance follows the group's assignment: a new generation revokes the old partitions and assigns
// the new ones (through the rebalance callback, which may Assign itself).
func (c *Consumer) rebalance() {
	c.mu.Lock()
	if c.member == nil {
		c.mu.Unlock()
		return
	}
	gen, tps := c.member.Assignment()
	if gen == c.gen {
		c.mu.Unlock()
		return
	}
	c.gen = gen
	var revoked, assigned []TopicPartition
	for _, tp := range c.assigned {
		revoked = append(revoked, topicPartition(tp, OffsetInvalid))
	}
	for _, tp := range tps {
		assigned = append(assigned, topicPartition(tp, OffsetStored))
	}
	cb := c.rebalanceCb
	if cb == nil {
		c.assignLocked(assigned)
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	if len(revoked) > 0 {
		c.mu.Lock()
		c.assignCalled = false
		c.mu.Unlock()
		_ = cb(c, RevokedPartitions{Partitions: revoked})
		c.mu.Lock()
		if !c.assignCalled {
			c.assigned = nil
		}
		c.mu.Unlock()
	}
	c.mu.Lock()
	c.assignCalled = false
	c.mu.Unlock()
	_ = cb(c, AssignedPartitions{Partitions: assigned})
	c.mu.Lock()
	if !c.assignCalled {
		c.assignLocked(assigned)
	}
	c.mu.Unlock()
}

// Poll the consumer for messages or events.
//
// # Will block for at most timeoutMs milliseconds
//
// The following callbacks may be triggered:
//
//	Subscribe()'s rebalanceCb
//
// Returns nil on timeout, else an Event
func (c *Consumer) Poll(timeoutMs int) (event Event) {
	b := mk.Default()
	if b.Stale(c.epoch) {
		mk.Park()
	}
	var deadline time.Time
	if timeoutMs > 0 {
		deadline = vclock.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	}
	if c.IsClosed() {
		vclock.Sleep(time.Duration(timeoutMs) * time.Millisecond)
		return nil
	}
	// While the consumer polls its process is alive: the group does not evict it.
	var polling *mk.Member
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	for {
		changed := b.Changed()
		if b.Stale(c.epoch) {
			mk.Park()
		}
		if m := c.membership(); m != nil && m != polling {
			if release != nil {
				release()
			}
			polling, release = m, m.Fetching()
		}
		c.rebalance()
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return nil
		}
		if ev := c.nextLocked(b); ev != nil {
			c.mu.Unlock()
			// librdkafka hands the message over from its own threads: the application's other
			// goroutines get to run between two polls, as they would.
			runtime.Gosched()
			return ev
		}
		wake := c.wake
		c.mu.Unlock()
		if timeoutMs == 0 {
			return nil
		}
		var timeout <-chan time.Time
		var t *vclock.Timer
		if timeoutMs > 0 {
			left := vclock.Until(deadline)
			if left <= 0 {
				return nil
			}
			t = vclock.NewTimer(left)
			timeout = t.C
		}
		select {
		case <-changed:
		case <-wake:
		case <-timeout:
		}
		if t != nil {
			t.Stop()
		}
	}
}

// membership is the consumer's group membership, joined again if the group evicted it.
func (c *Consumer) membership() *mk.Member {
	c.mu.Lock()
	m, topics := c.member, c.subscription
	c.mu.Unlock()
	if m == nil || !m.Left() {
		return m
	}
	fresh := mk.Default().Join(c.group, topics, c.session)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.member != m || c.closed {
		fresh.Leave()
		return c.member
	}
	c.member = fresh
	c.gen = 0
	return fresh
}

// nextLocked delivers the next record round-robin over the unpaused assigned partitions (or a
// PartitionEOF when enabled).
func (c *Consumer) nextLocked(b *mk.Broker) Event {
	n := len(c.assigned)
	for i := range n {
		tp := c.assigned[(c.rr+i)%n]
		if c.paused[tp] {
			continue
		}
		pos, ok := c.positions[tp]
		if !ok {
			pos = c.startLocked(tp, OffsetStored)
			c.positions[tp] = pos
		}
		rec, ok := b.Fetch(tp.Topic, tp.Partition, pos)
		if !ok {
			continue
		}
		c.rr = (c.rr + i + 1) % n
		c.positions[tp] = pos + 1
		c.atEOF[tp] = false
		if c.autoStore {
			c.stored[tp] = pos + 1
		}
		b.Delivered(c.group, rec)
		return fromRecord(rec)
	}
	if c.eof {
		for _, tp := range c.assigned {
			if c.paused[tp] || c.atEOF[tp] {
				continue
			}
			if pos := c.positions[tp]; pos >= b.EndOffset(tp.Topic, tp.Partition) {
				c.atEOF[tp] = true
				return PartitionEOF(topicPartition(tp, Offset(pos)))
			}
		}
	}
	return nil
}

// ReadMessage polls the consumer for a message.
//
// This is a convenience API that wraps Poll() and only returns
// messages or errors. All other event types are discarded.
//
// The call will block for at most `timeout` waiting for
// a new message or error. `timeout` may be set to -1 for
// indefinite wait.
//
// Timeout is returned as (nil, err) where `err.(kafka.Error).IsTimeout() == true`.
//
// Messages are returned as (msg, nil),
// while general errors are returned as (nil, err),
// and partition-specific errors are returned as (msg, err) where
// msg.TopicPartition provides partition-specific information (such as topic, partition and offset).
//
// All other event types, such as PartitionEOF, AssignedPartitions, etc, are silently discarded.
func (c *Consumer) ReadMessage(timeout time.Duration) (*Message, error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	var absTimeout time.Time
	var timeoutMs int
	if timeout > 0 {
		absTimeout = vclock.Now().Add(timeout)
		timeoutMs = int(timeout.Seconds() * 1000.0)
	} else {
		timeoutMs = int(timeout)
	}
	for {
		ev := c.Poll(timeoutMs)
		switch e := ev.(type) {
		case *Message:
			if e.TopicPartition.Error != nil {
				return e, e.TopicPartition.Error
			}
			return e, nil
		case Error:
			return nil, e
		}
		if timeout > 0 {
			timeoutMs = int(vclock.Until(absTimeout).Milliseconds())
			if timeoutMs < 0 {
				timeoutMs = 0
			}
		}
		if timeoutMs == 0 && ev == nil {
			return nil, newError(ErrTimedOut)
		}
	}
}

func toOffsets(partitions []TopicPartition) mk.Offsets {
	out := mk.Offsets{}
	for _, p := range partitions {
		if p.Offset >= 0 {
			out[p.key()] = int64(p.Offset)
		}
	}
	return out
}

func fromOffsets(offsets mk.Offsets) []TopicPartition {
	var out []TopicPartition
	for tp, o := range offsets {
		out = append(out, topicPartition(tp, Offset(o)))
	}
	sort.Sort(TopicPartitions(out))
	return out
}

func (c *Consumer) commit(offsets mk.Offsets) ([]TopicPartition, error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	if len(offsets) == 0 {
		return nil, newError(ErrNoOffset)
	}
	mk.Default().Commit(c.group, offsets, "manual-commit")
	return fromOffsets(offsets), nil
}

// Commit offsets for currently assigned partitions
// This is a blocking call.
// Returns the committed offsets on success.
func (c *Consumer) Commit() ([]TopicPartition, error) {
	c.mu.Lock()
	offsets := mk.Offsets{}
	for _, tp := range c.assigned {
		if o, ok := c.stored[tp]; ok {
			offsets[tp] = o
		}
	}
	c.mu.Unlock()
	return c.commit(offsets)
}

// CommitMessage commits offset based on the provided message.
// This is a blocking call.
// Returns the committed offsets on success.
func (c *Consumer) CommitMessage(m *Message) ([]TopicPartition, error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	if m.TopicPartition.Error != nil {
		return nil, newErrorFromString(ErrInvalidArg, "Can't commit errored message")
	}
	offsets := []TopicPartition{m.TopicPartition}
	offsets[0].Offset++
	return c.commit(toOffsets(offsets))
}

// CommitOffsets commits the provided list of offsets
// This is a blocking call.
// Returns the committed offsets on success.
func (c *Consumer) CommitOffsets(offsets []TopicPartition) ([]TopicPartition, error) {
	return c.commit(toOffsets(offsets))
}

// commitStored is the auto-commit: the stored offsets not committed yet.
func (c *Consumer) commitStored(kind string) {
	b := mk.Default()
	c.mu.Lock()
	due := mk.Offsets{}
	for tp, o := range c.stored {
		if cur, ok := b.CommittedOffset(c.group, tp.Topic, tp.Partition); !ok || cur != o {
			due[tp] = o
		}
	}
	c.mu.Unlock()
	if len(due) > 0 {
		b.Commit(c.group, due, kind)
	}
}

// StoreOffsets stores the provided list of offsets that will be committed
// to the offset store according to `auto.commit.interval.ms` or manual
// offset-less Commit().
//
// Returns the stored offsets on success. If at least one offset couldn't be stored,
// an error and a list of offsets is returned. Each offset can be checked for
// specific errors via its `.Error` member.
func (c *Consumer) StoreOffsets(offsets []TopicPartition) (storedOffsets []TopicPartition, err error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range offsets {
		if p.Offset >= 0 {
			c.stored[p.key()] = int64(p.Offset)
		}
		storedOffsets = append(storedOffsets, p)
	}
	return storedOffsets, nil
}

// StoreMessage stores offset based on the provided message.
// This is a convenience method that uses StoreOffsets to do the actual work.
func (c *Consumer) StoreMessage(m *Message) (storedOffsets []TopicPartition, err error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	if m.TopicPartition.Error != nil {
		return nil, newErrorFromString(ErrInvalidArg, "Can't store errored message")
	}
	if m.TopicPartition.Offset < 0 {
		return nil, newErrorFromString(ErrInvalidArg, "Can't store message with offset less than 0")
	}
	offsets := []TopicPartition{m.TopicPartition}
	offsets[0].Offset++
	return c.StoreOffsets(offsets)
}

// Committed retrieves committed offsets for the given set of partitions
func (c *Consumer) Committed(partitions []TopicPartition, timeoutMs int) (offsets []TopicPartition, err error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	b := mk.Default()
	for _, p := range partitions {
		o, ok := b.CommittedOffset(c.group, p.key().Topic, int(p.Partition))
		out := p
		out.Offset = OffsetInvalid
		if ok {
			out.Offset = Offset(o)
		}
		offsets = append(offsets, out)
	}
	return offsets, nil
}

// Position returns the current consume position for the given partitions.
// Typical use is to call Assignment() to get the partition list
// and then pass it to Position() to get the current consume position for
// each of the assigned partitions.
// The consume position is the next message to read from the partition.
// i.e., the offset of the last message seen by the application + 1.
func (c *Consumer) Position(partitions []TopicPartition) (offsets []TopicPartition, err error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range partitions {
		out := p
		out.Offset = OffsetInvalid
		if o, ok := c.positions[p.key()]; ok {
			out.Offset = Offset(o)
		}
		offsets = append(offsets, out)
	}
	return offsets, nil
}

// Seek seeks the given topic partitions using the offset from the TopicPartition.
//
// The ignoredTimeoutMs parameter is ignored. Instead, this method blocks until
// the fetcher state is updated for the given partition with the new offset.
// This guarantees that no previously fetched messages for the old offset (or
// fetch position) will be passed to the application once this call returns.
// It will still take some time after the method returns until messages are
// fetched at the new offset.
//
// Seek() may only be used for partitions already being consumed
// (through Assign() or implicitly through a self-rebalanced Subscribe()).
// To set the starting offset it is preferred to use Assign() and provide
// a starting offset for each partition.
//
// Returns an error on failure or nil otherwise.
// Deprecated: Seek is deprecated in favour of SeekPartitions().
func (c *Consumer) Seek(partition TopicPartition, ignoredTimeoutMs int) error {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tp := partition.key()
	if !c.ownsLocked(tp) {
		return newError(ErrUnknownPartition)
	}
	c.positions[tp] = c.startLocked(tp, partition.Offset)
	c.wakeLocked()
	return nil
}

// SeekPartitions seeks the given topic partitions to the per-partition offset
// stored in the .Offset field of each partition.
//
// The offset may be either absolute (>= 0) or a logical offset (e.g. OffsetEnd).
//
// SeekPartitions() may only be used for partitions already being consumed
// (through Assign() or implicitly through a self-rebalanced Subscribe()).
// To set the starting offset it is preferred to use Assign() in a
// kafka.AssignedPartitions handler and provide a starting offset for each
// partition.
//
// Returns an error on failure or nil otherwise. Individual partition errors
// should be checked in the per-partition .Error field.
func (c *Consumer) SeekPartitions(partitions []TopicPartition) ([]TopicPartition, error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	out := make([]TopicPartition, len(partitions))
	for i, p := range partitions {
		out[i] = p
		if err := c.Seek(p, 0); err != nil {
			out[i].Error = err
		}
	}
	return out, nil
}

// Pause consumption for the provided list of partitions
//
// Note that messages already enqueued on the consumer's Event channel
// (if `go.events.channel.enable` has been set) will NOT be purged by
// this call, set `go.events.channel.size` accordingly.
func (c *Consumer) Pause(partitions []TopicPartition) (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range partitions {
		c.paused[p.key()] = true
	}
	c.wakeLocked()
	return nil
}

// Resume consumption for the provided list of partitions
func (c *Consumer) Resume(partitions []TopicPartition) (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range partitions {
		delete(c.paused, p.key())
	}
	c.wakeLocked()
	return nil
}

// GetWatermarkOffsets returns the cached low and high offsets for the given topic
// and partition.  The high offset is populated on every fetch response or via calling QueryWatermarkOffsets.
// The low offset is populated every statistics.interval.ms if that value is set.
// OffsetInvalid will be returned if there is no cached offset for either value.
func (c *Consumer) GetWatermarkOffsets(topic string, partition int32) (low, high int64, err error) {
	if err := c.verify(); err != nil {
		return 0, 0, err
	}
	return 0, mk.Default().EndOffset(topic, int(partition)), nil
}

// QueryWatermarkOffsets queries the broker for the low and high offsets for the given topic and partition.
func (c *Consumer) QueryWatermarkOffsets(topic string, partition int32, timeoutMs int) (low, high int64, err error) {
	return c.GetWatermarkOffsets(topic, partition)
}

// GetMetadata queries broker for cluster and topic metadata.
// If topic is non-nil only information about that topic is returned, else if
// allTopics is false only information about locally used topics is returned,
// else information about all topics is returned.
// GetMetadata is equivalent to listTopics, describeTopics and describeCluster in the Java API.
func (c *Consumer) GetMetadata(topic *string, allTopics bool, timeoutMs int) (*Metadata, error) {
	if err := c.verify(); err != nil {
		return nil, err
	}
	return getMetadata(topic, allTopics), nil
}

// Close Consumer instance.
// The object is no longer usable after this call.
func (c *Consumer) Close() (err error) {
	if err := c.verify(); err != nil {
		return err
	}
	if c.autoCommit {
		c.commitStored("auto-commit")
	}
	c.mu.Lock()
	c.closed = true
	m := c.member
	c.member = nil
	c.wakeLocked()
	c.mu.Unlock()
	if c.stopTimer != nil {
		c.stopTimer()
	}
	if m != nil {
		m.Leave()
	}
	mk.Default().Log(mk.Event{Kind: "close", Group: c.group})
	return nil
}
