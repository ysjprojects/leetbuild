package goredis

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"leetbuild/goruntime/world"
)

// fake is a minimal server (strings, lists, one-group streams): enough to see what go-redis sends
// and when. A blocking command waits for a write in real time, a virtual second lasting 10 ms.
type fake struct {
	mu      sync.Mutex
	data    map[string]string
	lists   map[string][]string
	streams map[string]*stream
	trips   [][]string
	changed chan struct{} // closed by every write
	parked  chan struct{} // receives once per wait of a blocking command
	// blockingTrips counts the trips through ExecuteBlocking and PipelineBlocking.
	blockingTrips int
	conns         int
	watches       map[int]map[string]string // connection → WATCHed key → its value when watched
}

type stream struct {
	entries [][]string     // field-value pairs; entry i has id "<i+1>-0"
	groups  map[string]int // group → entries delivered
}

func newFake() *fake {
	return &fake{
		data:    map[string]string{},
		lists:   map[string][]string{},
		streams: map[string]*stream{},
		changed: make(chan struct{}),
		parked:  make(chan struct{}, 16),
	}
}

func (f *fake) wrote() {
	close(f.changed)
	f.changed = make(chan struct{})
}

// run answers one command without blocking: a blocking command finding nothing answers nil.
func (f *fake) run(args [][]byte) (world.Reply, error) {
	name := strings.ToUpper(string(args[0]))
	switch name {
	case "GET":
		if v, ok := f.data[string(args[1])]; ok {
			return []byte(v), nil
		}
		return nil, nil
	case "SET":
		nx := len(args) > 3 && strings.EqualFold(string(args[len(args)-1]), "NX")
		if _, ok := f.data[string(args[1])]; ok && nx {
			return nil, nil
		}
		f.data[string(args[1])] = string(args[2])
		f.wrote()
		return world.Status("OK"), nil
	case "INCR":
		n, _ := strconv.ParseInt(f.data[string(args[1])], 10, 64)
		n++
		f.data[string(args[1])] = strconv.FormatInt(n, 10)
		f.wrote()
		return n, nil
	case "RPUSH":
		key := string(args[1])
		for _, v := range args[2:] {
			f.lists[key] = append(f.lists[key], string(v))
		}
		f.wrote()
		return int64(len(f.lists[key])), nil
	case "BLPOP":
		for _, k := range args[1 : len(args)-1] {
			if l := f.lists[string(k)]; len(l) > 0 {
				f.lists[string(k)] = l[1:]
				return []world.Reply{k, []byte(l[0])}, nil
			}
		}
		return nil, nil
	case "XADD": // XADD key * field value ...
		s := f.stream(string(args[1]))
		var fields []string
		for _, a := range args[3:] {
			fields = append(fields, string(a))
		}
		s.entries = append(s.entries, fields)
		f.wrote()
		return []byte(fmt.Sprintf("%d-0", len(s.entries))), nil
	case "XGROUP": // XGROUP CREATE key group $ MKSTREAM
		s := f.stream(string(args[2]))
		s.groups[string(args[3])] = len(s.entries)
		return world.Status("OK"), nil
	case "XREADGROUP": // XREADGROUP GROUP g c [COUNT n] [BLOCK ms] STREAMS key >
		key := string(args[len(args)-2])
		s := f.streams[key]
		group := string(args[2])
		if s == nil || s.groups[group] == len(s.entries) {
			return nil, nil
		}
		var msgs []world.Reply
		for i := s.groups[group]; i < len(s.entries); i++ {
			var fields []world.Reply
			for _, v := range s.entries[i] {
				fields = append(fields, []byte(v))
			}
			msgs = append(msgs, []world.Reply{[]byte(fmt.Sprintf("%d-0", i+1)), fields})
		}
		s.groups[group] = len(s.entries)
		return []world.Reply{[]world.Reply{[]byte(key), msgs}}, nil
	}
	return nil, &world.ReplyError{Message: "ERR unknown command '" + name + "'"}
}

func (f *fake) stream(key string) *stream {
	s := f.streams[key]
	if s == nil {
		s = &stream{groups: map[string]int{}}
		f.streams[key] = s
	}
	return s
}

// block answers a command that may block, with f.mu held: it waits (unlocked) for a write or the
// command's timeout.
func (f *fake) block(args [][]byte) (world.Reply, error) {
	var timeout <-chan time.Time // nil: no timeout
	if d := blockFor(args); d > 0 {
		timeout = time.After(d)
	}
	for {
		r, err := f.run(args)
		if err != nil || r != nil || !isBlocking(args) {
			return r, err
		}
		changed := f.changed
		f.mu.Unlock()
		f.parked <- struct{}{}
		select {
		case <-changed:
			f.mu.Lock()
		case <-timeout:
			f.mu.Lock()
			return nil, nil
		}
	}
}

// blockFor is a blocking command's timeout in the fake's real time; 0 waits for ever.
func blockFor(args [][]byte) time.Duration {
	if strings.EqualFold(string(args[0]), "BLPOP") {
		sec, _ := strconv.ParseFloat(string(args[len(args)-1]), 64)
		return time.Duration(sec * float64(10*time.Millisecond))
	}
	for i, a := range args {
		if strings.EqualFold(string(a), "BLOCK") {
			ms, _ := strconv.ParseInt(string(args[i+1]), 10, 64)
			return time.Duration(ms) * 10 * time.Microsecond
		}
	}
	return 0
}

func (f *fake) Execute(args [][]byte, record bool) (world.Reply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if record {
		f.trips = append(f.trips, []string{strings.ToUpper(string(args[0]))})
	}
	return f.run(args)
}

func (f *fake) ExecuteBlocking(args [][]byte, record bool) (world.Reply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.blockingTrips++
	if record {
		f.trips = append(f.trips, []string{strings.ToUpper(string(args[0]))})
	}
	return f.block(args)
}

func (f *fake) batch(cmds [][][]byte, trip []string) []world.Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.trips = append(f.trips, trip)
	out := make([]world.Result, len(cmds))
	for i, c := range cmds {
		r, err := f.run(c)
		out[i] = world.Result{Reply: r, Err: err}
	}
	return out
}

func (f *fake) PipelineBlocking(cmds [][][]byte) []world.Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.blockingTrips++
	f.trips = append(f.trips, names(cmds))
	out := make([]world.Result, len(cmds))
	for i, c := range cmds {
		r, err := f.block(c)
		out[i] = world.Result{Reply: r, Err: err}
	}
	return out
}

func names(cmds [][][]byte) []string {
	out := make([]string, len(cmds))
	for i, c := range cmds {
		out[i] = strings.ToUpper(string(c[0]))
	}
	return out
}

func (f *fake) Pipeline(cmds [][][]byte) []world.Result { return f.batch(cmds, names(cmds)) }

func (f *fake) Connect() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.conns++
	return f.conns
}

// held renders key's value, "" when absent; the caller holds f.mu.
func (f *fake) held(key string) string {
	if v, ok := f.data[key]; ok {
		return "s:" + v
	}
	return ""
}

func (f *fake) Watch(conn int, keys [][]byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.watches == nil {
		f.watches = map[int]map[string]string{}
	}
	if f.watches[conn] == nil {
		f.watches[conn] = map[string]string{}
	}
	for _, k := range keys {
		if _, ok := f.watches[conn][string(k)]; !ok {
			f.watches[conn][string(k)] = f.held(string(k))
		}
	}
}

func (f *fake) Unwatch(conn int, _ bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.watches, conn)
}

func (f *fake) Exec(conn int, cmds [][][]byte) ([]world.Result, bool) {
	f.mu.Lock()
	watched := f.watches[conn]
	delete(f.watches, conn)
	for k, before := range watched {
		if f.held(k) != before {
			f.mu.Unlock()
			return nil, true
		}
	}
	f.mu.Unlock()
	return f.batch(cmds, append(append([]string{"MULTI"}, names(cmds)...), "EXEC")), false
}

func (f *fake) Probe([]byte, func() (any, error)) *world.Probe { return &world.Probe{} }

func (f *fake) Subscribe([]byte, bool, func(pattern, channel, message []byte)) func() {
	return func() {}
}

func (f *fake) RoundTrips() [][]string { return f.trips }

func TestGoRedisOverTheConn(t *testing.T) {
	server := newFake()
	world.RedisServer = server
	defer func() { world.RedisServer = nil }()
	ctx := context.Background()
	rdb := NewClient(&redis.Options{Addr: "redis:6379"})
	defer rdb.Close()

	ok, err := rdb.SetNX(ctx, "lock", "a", 0).Result()
	if err != nil || !ok {
		t.Fatalf("SetNX on a free key: %v %v", ok, err)
	}
	if ok, _ := rdb.SetNX(ctx, "lock", "b", 0).Result(); ok {
		t.Fatal("SetNX on a held key returned true")
	}
	if _, err := rdb.Get(ctx, "missing").Result(); !errors.Is(err, redis.Nil) {
		t.Fatalf("GET of a missing key: %v, want redis.Nil", err)
	}
	server.trips = nil

	cmds, err := rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		p.Incr(ctx, "n")
		p.Incr(ctx, "n")
		return nil
	})
	if err != nil || cmds[1].(*redis.IntCmd).Val() != 2 {
		t.Fatalf("pipeline: %v %v", cmds, err)
	}
	if _, err := rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Incr(ctx, "n")
		p.Set(ctx, "k", "v", 0)
		return nil
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}
	got := server.trips
	want := [][]string{{"INCR", "INCR"}, {"MULTI", "INCR", "SET", "EXEC"}}
	if len(got) != len(want) || strings.Join(got[0], ",") != "INCR,INCR" || strings.Join(got[1], ",") != "MULTI,INCR,SET,EXEC" {
		t.Fatalf("round trips %v, want %v", got, want)
	}

	// WATCH: a change to the key between WATCH and EXEC aborts the transaction.
	err = rdb.Watch(ctx, func(tx *redis.Tx) error {
		_ = server.data // another client writes the watched key
		server.mu.Lock()
		server.data["n"] = "100"
		server.mu.Unlock()
		_, err := tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
			p.Set(ctx, "n", "1", 0)
			return nil
		})
		return err
	}, "n")
	if !errors.Is(err, redis.TxFailedErr) {
		t.Fatalf("Watch after a concurrent write: %v, want TxFailedErr", err)
	}
	if server.data["n"] != "100" {
		t.Fatalf("the aborted transaction ran: n = %s", server.data["n"])
	}
}

// client is a go-redis client of a fresh fake server.
func client(t *testing.T) (*fake, *redis.Client) {
	server := newFake()
	world.RedisServer = server
	rdb := NewClient(&redis.Options{Addr: "redis:6379"})
	t.Cleanup(func() {
		rdb.Close()
		world.RedisServer = nil
	})
	return server, rdb
}

func TestBLPopIsWokenByAnotherClientsPush(t *testing.T) {
	server, rdb := client(t)
	ctx := context.Background()
	got := make(chan []string, 1)
	go func() {
		v, err := rdb.BLPop(ctx, 0, "jobs").Result()
		if err != nil {
			t.Errorf("BLPop: %v", err)
		}
		got <- v
	}()
	<-server.parked
	if err := rdb.RPush(ctx, "jobs", "j1").Err(); err != nil {
		t.Fatalf("RPush: %v", err)
	}
	if v := <-got; strings.Join(v, ",") != "jobs,j1" {
		t.Fatalf("BLPop = %v, want [jobs j1]", v)
	}

	// Pipelined, the commands after the blocking one wait until it answers.
	done := make(chan []redis.Cmder, 1)
	go func() {
		cmds, err := rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
			p.BLPop(ctx, time.Minute, "jobs")
			p.Incr(ctx, "n")
			return nil
		})
		if err != nil {
			t.Errorf("Pipelined: %v", err)
		}
		done <- cmds
	}()
	<-server.parked
	server.mu.Lock()
	_, ran := server.data["n"]
	server.mu.Unlock()
	if ran {
		t.Fatal("the INCR after a blocked BLPOP ran before it answered")
	}
	if err := rdb.RPush(ctx, "jobs", "j2").Err(); err != nil {
		t.Fatalf("RPush: %v", err)
	}
	cmds := <-done
	if v := cmds[0].(*redis.StringSliceCmd).Val(); strings.Join(v, ",") != "jobs,j2" {
		t.Fatalf("pipelined BLPop = %v, want [jobs j2]", v)
	}
	if n := cmds[1].(*redis.IntCmd).Val(); n != 1 {
		t.Fatalf("pipelined INCR = %d, want 1", n)
	}
	if server.blockingTrips != 2 {
		t.Fatalf("%d blocking trips, want 2", server.blockingTrips)
	}
}

func TestBLPopTimesOutWithNil(t *testing.T) {
	_, rdb := client(t)
	v, err := rdb.BLPop(context.Background(), time.Second, "empty").Result()
	if !errors.Is(err, redis.Nil) {
		t.Fatalf("BLPop on an empty list: %v %v, want redis.Nil", v, err)
	}
}

func TestXReadGroupBlockIsWokenByXAdd(t *testing.T) {
	server, rdb := client(t)
	ctx := context.Background()
	if err := rdb.XGroupCreateMkStream(ctx, "events", "workers", "$").Err(); err != nil {
		t.Fatalf("XGroupCreateMkStream: %v", err)
	}
	got := make(chan []redis.XStream, 1)
	go func() {
		streams, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    "workers",
			Consumer: "c1",
			Streams:  []string{"events", ">"},
			Count:    10,
			Block:    time.Minute,
		}).Result()
		if err != nil {
			t.Errorf("XReadGroup: %v", err)
		}
		got <- streams
	}()
	<-server.parked
	id, err := rdb.XAdd(ctx, &redis.XAddArgs{Stream: "events", Values: []string{"type", "signup"}}).Result()
	if err != nil {
		t.Fatalf("XAdd: %v", err)
	}
	streams := <-got
	if len(streams) != 1 || streams[0].Stream != "events" || len(streams[0].Messages) != 1 ||
		streams[0].Messages[0].ID != id || streams[0].Messages[0].Values["type"] != "signup" {
		t.Fatalf("XReadGroup = %+v, want the entry %s", streams, id)
	}
}

func TestBlockingCommandInATransactionDoesNotBlock(t *testing.T) {
	server, rdb := client(t)
	ctx := context.Background()
	done := make(chan []redis.Cmder, 1)
	go func() {
		cmds, _ := rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
			p.BLPop(ctx, 0, "empty")
			p.Incr(ctx, "n")
			return nil
		})
		done <- cmds
	}()
	var cmds []redis.Cmder
	select {
	case cmds = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("BLPOP inside MULTI blocked")
	}
	if err := cmds[0].Err(); !errors.Is(err, redis.Nil) {
		t.Fatalf("BLPOP inside MULTI: %v, want redis.Nil", err)
	}
	if n := cmds[1].(*redis.IntCmd).Val(); n != 1 {
		t.Fatalf("INCR after it = %d, want 1", n)
	}
	if server.blockingTrips != 0 {
		t.Fatalf("%d blocking trips, want none", server.blockingTrips)
	}
	if trips := server.RoundTrips(); strings.Join(trips[len(trips)-1], ",") != "MULTI,BLPOP,INCR,EXEC" {
		t.Fatalf("round trips %v", trips)
	}
}

func TestIsBlocking(t *testing.T) {
	for cmd, want := range map[string]bool{
		"BLPOP q 0":                            true,
		"brpoplpush a b 1":                     true,
		"BLMOVE a b LEFT RIGHT 0":              true,
		"LPOP q":                               false,
		"XREAD COUNT 1 STREAMS s 0":            false,
		"XREAD block 0 STREAMS s $":            true,
		"XREAD STREAMS block 0":                false,
		"XREADGROUP GROUP block c STREAMS s >": false,
		"XREADGROUP GROUP g c COUNT 5 BLOCK 100 STREAMS s >": true,
		"XREADGROUP GROUP g c NOACK BLOCK 0 STREAMS s >":     true,
		"XREAD BLOCK":                       false,
		"XREAD BOGUS 1 BLOCK 0 STREAMS s 0": false,
	} {
		var args [][]byte
		for _, w := range strings.Fields(cmd) {
			args = append(args, []byte(w))
		}
		if got := isBlocking(args); got != want {
			t.Errorf("isBlocking(%s) = %v, want %v", cmd, got, want)
		}
	}
}
