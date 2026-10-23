// Package metadata is google.golang.org/grpc/metadata: the key/values an RPC carries (headers and
// trailers), and their place in a context. Keys are lower-cased.
package metadata

import (
	"context"
	"fmt"
	"strings"
)

// MD is a mapping from metadata keys to values.
type MD map[string][]string

// New creates an MD from a map (keys lower-cased).
func New(m map[string]string) MD {
	md := make(MD, len(m))
	for k, v := range m {
		key := strings.ToLower(k)
		md[key] = append(md[key], v)
	}
	return md
}

// Pairs returns an MD from key, value, key, value… (keys lower-cased). It panics on an odd count.
func Pairs(kv ...string) MD {
	if len(kv)%2 == 1 {
		panic(fmt.Sprintf("metadata: Pairs got the odd number of input pairs for metadata: %d", len(kv)))
	}
	md := make(MD, len(kv)/2)
	for i := 0; i < len(kv); i += 2 {
		key := strings.ToLower(kv[i])
		md[key] = append(md[key], kv[i+1])
	}
	return md
}

// Len returns the number of keys.
func (md MD) Len() int { return len(md) }

// Copy returns a deep copy of md.
func (md MD) Copy() MD {
	out := make(MD, len(md))
	for k, v := range md {
		out[k] = append([]string(nil), v...)
	}
	return out
}

// Get returns the values for key (lower-cased).
func (md MD) Get(k string) []string { return md[strings.ToLower(k)] }

// Set replaces the values for key; no values is a no-op.
func (md MD) Set(k string, vals ...string) {
	if len(vals) == 0 {
		return
	}
	md[strings.ToLower(k)] = vals
}

// Append adds values to key; no values is a no-op.
func (md MD) Append(k string, vals ...string) {
	if len(vals) == 0 {
		return
	}
	k = strings.ToLower(k)
	md[k] = append(md[k], vals...)
}

// Delete removes key.
func (md MD) Delete(k string) { delete(md, strings.ToLower(k)) }

// Join merges any number of mds into one; values of a key are concatenated in order.
func Join(mds ...MD) MD {
	out := MD{}
	for _, md := range mds {
		for k, v := range md {
			out[k] = append(out[k], v...)
		}
	}
	return out
}

type mdIncomingKey struct{}
type mdOutgoingKey struct{}

// rawMD is the outgoing metadata: a base MD and the pairs appended to it since.
type rawMD struct {
	md    MD
	added [][]string
}

// NewIncomingContext returns ctx carrying md as the incoming metadata (servers read it).
func NewIncomingContext(ctx context.Context, md MD) context.Context {
	return context.WithValue(ctx, mdIncomingKey{}, md)
}

// NewOutgoingContext returns ctx carrying md as the outgoing metadata, replacing any.
func NewOutgoingContext(ctx context.Context, md MD) context.Context {
	return context.WithValue(ctx, mdOutgoingKey{}, rawMD{md: md})
}

// AppendToOutgoingContext returns ctx with kv appended to its outgoing metadata (keys lower-cased).
// It panics on an odd count.
func AppendToOutgoingContext(ctx context.Context, kv ...string) context.Context {
	if len(kv)%2 == 1 {
		panic(fmt.Sprintf("metadata: AppendToOutgoingContext got an odd number of input pairs for metadata: %d", len(kv)))
	}
	md, _ := ctx.Value(mdOutgoingKey{}).(rawMD)
	added := make([][]string, len(md.added)+1)
	copy(added, md.added)
	pairs := make([]string, len(kv))
	for i := range kv {
		if i%2 == 0 {
			pairs[i] = strings.ToLower(kv[i])
		} else {
			pairs[i] = kv[i]
		}
	}
	added[len(added)-1] = pairs
	return context.WithValue(ctx, mdOutgoingKey{}, rawMD{md: md.md, added: added})
}

// FromIncomingContext returns a copy of the incoming metadata in ctx (keys lower-cased).
func FromIncomingContext(ctx context.Context) (MD, bool) {
	md, ok := ctx.Value(mdIncomingKey{}).(MD)
	if !ok {
		return nil, false
	}
	out := make(MD, len(md))
	for k, v := range md {
		out[strings.ToLower(k)] = append([]string(nil), v...)
	}
	return out, true
}

// ValueFromIncomingContext returns the incoming values of key in ctx.
func ValueFromIncomingContext(ctx context.Context, key string) []string {
	md, ok := ctx.Value(mdIncomingKey{}).(MD)
	if !ok {
		return nil
	}
	key = strings.ToLower(key)
	if v, ok := md[key]; ok {
		return append([]string(nil), v...)
	}
	for k, v := range md {
		if strings.EqualFold(k, key) {
			return append([]string(nil), v...)
		}
	}
	return nil
}

// FromOutgoingContext returns a copy of the outgoing metadata in ctx, appended pairs included.
func FromOutgoingContext(ctx context.Context) (MD, bool) {
	raw, ok := ctx.Value(mdOutgoingKey{}).(rawMD)
	if !ok {
		return nil, false
	}
	out := make(MD, len(raw.md))
	for k, v := range raw.md {
		key := strings.ToLower(k)
		out[key] = append(out[key], v...)
	}
	for _, added := range raw.added {
		for i := 0; i < len(added); i += 2 {
			out[added[i]] = append(out[added[i]], added[i+1])
		}
	}
	return out, true
}
