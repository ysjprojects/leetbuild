package kafka

import (
	"hash/crc32"
	"reflect"
	"testing"
	"time"

	"leetbuild/goruntime/models/kafka/kafkatest"
	"leetbuild/goruntime/vclock"
)

func fresh(t *testing.T) (*Broker, *kafkatest.Clock) {
	t.Helper()
	clock := kafkatest.New()
	vclock.Set(clock)
	t.Cleanup(func() { vclock.Set(vclock.Real{}) })
	return New(), clock
}

func TestPartitioningAndProductionOrder(t *testing.T) {
	b, _ := fresh(t)
	if got := b.Partitions("orders"); got != DefaultPartitions {
		t.Fatalf("a topic is created on first use with %d partitions, got %d", DefaultPartitions, got)
	}
	want := int(crc32.ChecksumIEEE([]byte("o-1")) % 3)
	if got := b.PartitionFor("orders", []byte("o-1")); got != want {
		t.Fatalf("keyed partition: got %d, want crc32 %% 3 = %d", got, want)
	}
	// Unkeyed records spread round-robin on the global sequence, as in the TypeScript broker.
	var unkeyed []int
	for range 3 {
		unkeyed = append(unkeyed, b.Seed("orders", -1, nil, []byte("x"), nil).Partition)
	}
	if !reflect.DeepEqual(unkeyed, []int{0, 1, 2}) {
		t.Fatalf("unkeyed partitions: %v", unkeyed)
	}
	b.Write(Write{Topic: "orders", Partition: -1, Key: []byte("o-1"), Value: []byte("a"), Acks: -1})
	b.Write(Write{Topic: "orders", Partition: -1, Key: []byte("o-2"), Value: []byte("b"), Acks: -1})
	recs := b.Records("orders")
	if len(recs) != 5 || string(recs[3].Value) != "a" || string(recs[4].Value) != "b" {
		t.Fatalf("records are in production order: %+v", recs)
	}
	if recs[3].Partition != want {
		t.Fatalf("o-1 landed on %d, want %d", recs[3].Partition, want)
	}
	produced, delivered, commits := b.Metrics()
	if produced != 2 || delivered != 0 || commits != 0 {
		t.Fatalf("metrics count the learner's writes only (seeds are the harness's): %d %d %d", produced, delivered, commits)
	}
	b.CreateTopic("wide", 6)
	if b.Partitions("wide") != 6 || b.CreateTopic("wide", 2) {
		t.Fatal("CreateTopic sets the partition count once")
	}
}

func TestCommitsLagAndHooks(t *testing.T) {
	b, _ := fresh(t)
	for i := range 4 {
		b.Seed("pay", i%2, nil, []byte{byte('a' + i)}, nil)
	}
	if lag := b.Lag("ledger", "pay"); lag != 4 {
		t.Fatalf("lag before any commit: %d", lag)
	}
	var seen []Offsets
	b.OnCommit(func(group string, offsets Offsets) {
		if group != "ledger" {
			t.Errorf("hook group %q", group)
		}
		seen = append(seen, offsets)
	})
	b.Commit("ledger", Offsets{{"pay", 0}: 2}, "manual-commit")
	b.Commit("ledger", Offsets{{"pay", 1}: 1}, "")
	if lag := b.Lag("ledger", "pay"); lag != 1 {
		t.Fatalf("lag after commits: %d", lag)
	}
	if o, ok := b.CommittedOffset("ledger", "pay", 0); !ok || o != 2 {
		t.Fatalf("committed offset: %d %v", o, ok)
	}
	if _, ok := b.CommittedOffset("ledger", "pay", 2); ok {
		t.Fatal("no commit on partition 2")
	}
	if len(seen) != 2 || len(b.Commits("ledger")) != 2 || len(b.Commits("other")) != 0 {
		t.Fatalf("hooks %v commits %v", seen, b.Commits("ledger"))
	}
	if _, _, commits := b.Metrics(); commits != 1 {
		t.Fatalf("the harness's commit is not counted: %d", commits)
	}
	kinds := []string{}
	for _, e := range b.Events() {
		kinds = append(kinds, e.Kind)
	}
	if !reflect.DeepEqual(kinds[len(kinds)-3:], []string{"commit", "manual-commit", "commit"}) {
		t.Fatalf("events: %v", kinds)
	}
}

func TestStallFailoverAckLoss(t *testing.T) {
	b, clock := fresh(t)
	b.Stall("orders", 2*time.Second)
	if until, stalled := b.StalledUntil("orders"); !stalled || until.IsZero() {
		t.Fatal("a timed stall has an end")
	}
	if _, stalled := b.StalledUntil("other"); stalled {
		t.Fatal("a topic stall does not stall other topics")
	}
	clock.Advance(2 * time.Second)
	if _, stalled := b.StalledUntil("orders"); stalled {
		t.Fatal("the stall ends with its time")
	}
	b.Stall("", 0)
	if until, stalled := b.StalledUntil("x"); !stalled || !until.IsZero() {
		t.Fatal("a stall of every topic until resumed")
	}
	b.Resume("")
	if _, stalled := b.StalledUntil("x"); stalled {
		t.Fatal("resumed")
	}

	b.Write(Write{Topic: "orders", Partition: 0, Value: []byte("all"), Acks: -1})
	b.Write(Write{Topic: "orders", Partition: 0, Value: []byte("one"), Acks: 1})
	if lost := b.Failover("orders"); lost != 1 {
		t.Fatalf("failover lost %d, want the acks=1 record", lost)
	}
	b.Write(Write{Topic: "orders", Partition: 0, Value: []byte("old"), Acks: 1})
	clock.Advance(ReplicationLag)
	if lost := b.Failover(""); lost != 0 {
		t.Fatal("a record older than the replication lag is replicated")
	}
	if got := len(b.Records("orders")); got != 2 {
		t.Fatalf("records after failover: %d", got)
	}
	if r, _ := b.Fetch("orders", 0, 1); string(r.Value) != "old" || r.Offset != 1 {
		t.Fatalf("offsets are renumbered after a failover: %+v", r)
	}

	b.LoseAcks("dup", 1)
	b.Write(Write{Topic: "dup", Partition: 0, Value: []byte("v"), Acks: -1})
	b.LoseAcks("dup", 1)
	b.Write(Write{Topic: "dup", Partition: 0, Value: []byte("w"), Acks: -1, Idempotent: true})
	if got := len(b.Records("dup")); got != 3 {
		t.Fatalf("a lost ack duplicates a non-idempotent write only: %d records", got)
	}
	b.FailNext("f", 2)
	if !b.TakeFailure("f") || !b.TakeFailure("f") || b.TakeFailure("f") {
		t.Fatal("FailNext counts")
	}
}

func TestGroupsSplitPartitionsInJoinOrder(t *testing.T) {
	b, _ := fresh(t)
	var subs []string
	b.OnSubscribe(func(group string, topics []string) { subs = append(subs, group+":"+topics[0]) })
	done := map[*Member]func(){}
	m1 := b.Join("g", []string{"t"}, time.Minute)
	done[m1] = m1.Fetching() // a member inside a fetch is alive: no eviction
	gen1, tps := m1.Assignment()
	if len(tps) != 3 {
		t.Fatalf("a lone member owns every partition: %v", tps)
	}
	m2 := b.Join("g", []string{"t"}, time.Minute)
	gen2, a1 := m1.Assignment()
	_, a2 := m2.Assignment()
	if gen2 == gen1 {
		t.Fatal("a join starts a new generation")
	}
	if !reflect.DeepEqual(a1, []TopicPartition{{"t", 0}, {"t", 1}}) || !reflect.DeepEqual(a2, []TopicPartition{{"t", 2}}) {
		t.Fatalf("range assignment: %v %v", a1, a2)
	}
	other := b.Join("h", []string{"t"}, time.Minute)
	if _, a := other.Assignment(); len(a) != 3 {
		t.Fatal("another group gets every partition")
	}
	m1.Leave()
	if _, a := m2.Assignment(); len(a) != 3 {
		t.Fatalf("after a leave the remaining member owns everything: %v", a)
	}
	if !reflect.DeepEqual(subs, []string{"g:t", "g:t", "h:t"}) {
		t.Fatalf("subscribe hooks: %v", subs)
	}
	done[m1]()
}

func TestAnIdleMemberIsEvictedWhenAReplacementJoins(t *testing.T) {
	b, clock := fresh(t)
	old := b.Join("g", []string{"t"}, 30*time.Second)
	fresh := b.Join("g", []string{"t"}, 30*time.Second)
	if _, a := fresh.Assignment(); len(a) != 0 {
		t.Fatalf("the rebalance waits for the idle member: the replacement owns nothing yet: %v", a)
	}
	clock.Advance(29 * time.Second)
	if old.Left() {
		t.Fatal("evicted before the session timeout")
	}
	clock.Advance(time.Second)
	if !old.Left() {
		t.Fatal("a member that did not fetch for its session timeout is evicted")
	}
	if _, a := fresh.Assignment(); len(a) != 3 {
		t.Fatalf("the replacement owns everything: %v", a)
	}
	alive := b.Join("h", []string{"t"}, time.Second)
	release := alive.Fetching()
	b.Join("h", []string{"t"}, time.Second)
	clock.Advance(time.Minute)
	if alive.Left() {
		t.Fatal("a member inside a fetch stays")
	}
	release()
}

func TestAnAwaitedMemberThatFetchesCompletesTheRebalance(t *testing.T) {
	b, _ := fresh(t)
	busy := b.Join("g", []string{"t"}, 30*time.Second)
	late := b.Join("g", []string{"t"}, 30*time.Second)
	if _, a := busy.Assignment(); len(a) != 3 {
		t.Fatal("the awaited member keeps its partitions until it rejoins")
	}
	release := busy.Fetching()
	defer release()
	_, a1 := busy.Assignment()
	_, a2 := late.Assignment()
	if len(a1) != 2 || len(a2) != 1 {
		t.Fatalf("its next fetch completes the rebalance: %v %v", a1, a2)
	}
}

func TestResetMakesClientsStaleAndWakesWaiters(t *testing.T) {
	b, _ := fresh(t)
	epoch := b.Epoch()
	b.Seed("t", 0, nil, []byte("x"), nil)
	changed := b.Changed()
	stopped := false
	b.OnReset(func() { stopped = true })
	b.Reset()
	select {
	case <-changed:
	default:
		t.Fatal("Reset wakes waiters")
	}
	if !b.Stale(epoch) || !stopped || len(b.Records("t")) != 0 || len(b.Events()) != 0 {
		t.Fatal("Reset empties the broker, runs the reset hooks and makes old clients stale")
	}
}
