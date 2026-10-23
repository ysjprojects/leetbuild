package goredis

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/redis/go-redis/v9"

	"leetbuild/goruntime/world"
)

// fake is a minimal string-only server: enough to see what go-redis sends and when.
type fake struct {
	mu    sync.Mutex
	data  map[string]string
	trips [][]string
}

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
		return world.Status("OK"), nil
	case "INCR":
		n, _ := strconv.ParseInt(f.data[string(args[1])], 10, 64)
		n++
		f.data[string(args[1])] = strconv.FormatInt(n, 10)
		return n, nil
	}
	return nil, &world.ReplyError{Message: "ERR unknown command '" + name + "'"}
}

func (f *fake) Execute(args [][]byte, record bool) (world.Reply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if record {
		f.trips = append(f.trips, []string{strings.ToUpper(string(args[0]))})
	}
	return f.run(args)
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

func names(cmds [][][]byte) []string {
	out := make([]string, len(cmds))
	for i, c := range cmds {
		out[i] = strings.ToUpper(string(c[0]))
	}
	return out
}

func (f *fake) Pipeline(cmds [][][]byte) []world.Result { return f.batch(cmds, names(cmds)) }

func (f *fake) Transaction(cmds [][][]byte) []world.Result {
	return f.batch(cmds, append(append([]string{"MULTI"}, names(cmds)...), "EXEC"))
}

func (f *fake) Fingerprint(key []byte) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if v, ok := f.data[string(key)]; ok {
		return "s:" + v
	}
	return ""
}

func (f *fake) Probe([]byte, func() (any, error)) *world.Probe { return &world.Probe{} }

func (f *fake) Subscribe([]byte, bool, func(pattern, channel, message []byte)) func() {
	return func() {}
}

func (f *fake) RoundTrips() [][]string { return f.trips }

func TestGoRedisOverTheConn(t *testing.T) {
	server := &fake{data: map[string]string{}}
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
