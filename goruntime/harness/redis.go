package harness

import (
	"fmt"
	"sort"
	"strconv"

	"leetbuild/goruntime/world"
)

// Redis is the server as the harness sees it, synchronously: ctx.Redis.Get(key), .PTTL(key),
// .Keys("*"), or any command with Do. These commands are the harness's own: they are not the
// learner's round trips. Replies decode as nil, string, int64 or []any.
type Redis struct{ ctx *Ctx }

func newRedis(c *Ctx) *Redis { return &Redis{ctx: c} }

func (r *Redis) server() world.Redis {
	if world.RedisServer == nil {
		r.ctx.Fatalf("Redis is not available in this runtime")
	}
	return world.RedisServer
}

// DoErr runs a command and returns its decoded reply, or the error reply.
func (r *Redis) DoErr(args ...any) (any, error) {
	reply, err := r.server().Execute(encodeArgs(args), false)
	if err != nil {
		return nil, err
	}
	return decodeReply(reply), nil
}

// Do runs a command and returns its decoded reply; an error reply fails the check.
func (r *Redis) Do(args ...any) any {
	v, err := r.DoErr(args...)
	if err != nil {
		r.ctx.Fatalf("redis %v: %v", args, err)
	}
	return v
}

// Get is the string at key and whether it exists.
func (r *Redis) Get(key string) (string, bool) {
	v := r.Do("GET", key)
	if v == nil {
		return "", false
	}
	return v.(string), true
}

// Set runs SET key value [options…] and reports whether it set the key (false when NX/XX refused).
func (r *Redis) Set(key string, value any, options ...any) bool {
	return r.Do(append([]any{"SET", key, value}, options...)...) != nil
}

// Del deletes keys and returns how many existed.
func (r *Redis) Del(keys ...string) int64 {
	return r.Do(append([]any{"DEL"}, strs(keys)...)...).(int64)
}

// Exists counts how many of keys exist.
func (r *Redis) Exists(keys ...string) int64 {
	return r.Do(append([]any{"EXISTS"}, strs(keys)...)...).(int64)
}

// TTL is the key's remaining time to live in seconds (-1 no expiry, -2 no key).
func (r *Redis) TTL(key string) int64 { return r.Do("TTL", key).(int64) }

// PTTL is the key's remaining time to live in milliseconds (-1 no expiry, -2 no key).
func (r *Redis) PTTL(key string) int64 { return r.Do("PTTL", key).(int64) }

// Type is the key's type ("string", "hash", "none", …).
func (r *Redis) Type(key string) string { return fmt.Sprint(r.Do("TYPE", key)) }

// Keys lists the keys matching a glob pattern, sorted.
func (r *Redis) Keys(pattern string) []string { return r.sorted(r.Do("KEYS", pattern)) }

// HGet is a hash field and whether it exists.
func (r *Redis) HGet(key, field string) (string, bool) {
	v := r.Do("HGET", key, field)
	if v == nil {
		return "", false
	}
	return v.(string), true
}

// HGetAll is the whole hash.
func (r *Redis) HGetAll(key string) map[string]string {
	flat := toStrings(r.Do("HGETALL", key))
	out := make(map[string]string, len(flat)/2)
	for i := 0; i+1 < len(flat); i += 2 {
		out[flat[i]] = flat[i+1]
	}
	return out
}

// HLen is the hash's field count.
func (r *Redis) HLen(key string) int64 { return r.Do("HLEN", key).(int64) }

// LRange is the list's elements from start to stop (inclusive; negative counts from the end).
func (r *Redis) LRange(key string, start, stop int64) []string {
	return toStrings(r.Do("LRANGE", key, start, stop))
}

// LLen is the list's length.
func (r *Redis) LLen(key string) int64 { return r.Do("LLEN", key).(int64) }

// SMembers is the set's members, sorted.
func (r *Redis) SMembers(key string) []string { return r.sorted(r.Do("SMEMBERS", key)) }

// SIsMember reports whether member is in the set.
func (r *Redis) SIsMember(key, member string) bool {
	return r.Do("SISMEMBER", key, member).(int64) == 1
}

// SCard is the set's size.
func (r *Redis) SCard(key string) int64 { return r.Do("SCARD", key).(int64) }

// Z is a sorted-set member and its score.
type Z struct {
	Member string
	Score  float64
}

// ZRangeWithScores is the sorted set from start to stop, lowest score first.
func (r *Redis) ZRangeWithScores(key string, start, stop int64) []Z {
	return r.pairs(r.Do("ZRANGE", key, start, stop, "WITHSCORES"))
}

// ZRevRangeWithScores is the sorted set from start to stop, highest score first.
func (r *Redis) ZRevRangeWithScores(key string, start, stop int64) []Z {
	return r.pairs(r.Do("ZREVRANGE", key, start, stop, "WITHSCORES"))
}

// ZScore is a member's score and whether the member exists.
func (r *Redis) ZScore(key, member string) (float64, bool) {
	v := r.Do("ZSCORE", key, member)
	if v == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(fmt.Sprint(v), 64)
	if err != nil {
		r.ctx.Fatalf("ZSCORE %s %s: %v", key, member, err)
	}
	return f, true
}

// ZCard is the sorted set's size.
func (r *Redis) ZCard(key string) int64 { return r.Do("ZCARD", key).(int64) }

// Publish sends message on channel and returns how many subscribers received it.
func (r *Redis) Publish(channel, message string) int64 {
	return r.Do("PUBLISH", channel, message).(int64)
}

// After runs fn right after the first command touching key, before its caller sees the reply (a
// competing client landing in a race window). The probe reports whether it fired, what fn
// returned, and what it failed with: fn runs inside the server's command, so a failing assertion
// there is recorded on the probe (Err) rather than ending the check at once.
func (r *Redis) After(key string, fn func() any) *world.Probe {
	return r.server().Probe([]byte(key), func() (result any, err error) {
		defer func() {
			if rec := recover(); rec != nil {
				err = asError(rec)
			}
		}()
		return fn(), nil
	})
}

// Subscribe receives every message published on channel, as another connection would; it returns
// the unsubscribe.
func (r *Redis) Subscribe(channel string, fn func(channel, message string)) func() {
	return r.server().Subscribe([]byte(channel), false, func(_, ch, msg []byte) { fn(string(ch), string(msg)) })
}

// RoundTrips lists every round trip the learner's clients made so far, as upper-case command names:
// [[GET] [MGET]]; a pipeline is one trip ([GET GET]), a transaction [MULTI HSET EXEC].
func (r *Redis) RoundTrips() [][]string { return r.server().RoundTrips() }

func (r *Redis) sorted(v any) []string {
	out := toStrings(v)
	sort.Strings(out)
	return out
}

func (r *Redis) pairs(v any) []Z {
	flat := toStrings(v)
	out := make([]Z, 0, len(flat)/2)
	for i := 0; i+1 < len(flat); i += 2 {
		score, err := strconv.ParseFloat(flat[i+1], 64)
		if err != nil {
			r.ctx.Fatalf("score %q of %q: %v", flat[i+1], flat[i], err)
		}
		out = append(out, Z{Member: flat[i], Score: score})
	}
	return out
}

func encodeArgs(args []any) [][]byte {
	out := make([][]byte, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case string:
			out[i] = []byte(v)
		case []byte:
			out[i] = v
		case float64:
			out[i] = []byte(strconv.FormatFloat(v, 'f', -1, 64))
		case float32:
			out[i] = []byte(strconv.FormatFloat(float64(v), 'f', -1, 32))
		default:
			out[i] = []byte(fmt.Sprint(v))
		}
	}
	return out
}

func decodeReply(r world.Reply) any {
	switch v := r.(type) {
	case []byte:
		return string(v)
	case world.Status:
		return string(v)
	case int:
		return int64(v)
	case []world.Reply:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = decodeReply(x)
		}
		return out
	}
	return r
}

func toStrings(v any) []string {
	list, _ := v.([]any)
	out := make([]string, len(list))
	for i, x := range list {
		out[i] = fmt.Sprint(x)
	}
	return out
}

func strs(keys []string) []any {
	out := make([]any, len(keys))
	for i, k := range keys {
		out[i] = k
	}
	return out
}

func asError(v any) error {
	if err, ok := v.(error); ok {
		return err
	}
	return fmt.Errorf("%v", v)
}
