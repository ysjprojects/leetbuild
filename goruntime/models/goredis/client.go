package goredis

import (
	"context"
	"net"
	"reflect"

	"github.com/redis/go-redis/v9"
	"github.com/redis/go-redis/v9/maintnotifications"

	"leetbuild/goruntime/world"
)

// dial opens a connection to the runtime's server, whatever address the options name.
func dial(context.Context, string, string) (net.Conn, error) {
	if world.RedisServer == nil {
		return nil, world.ErrUnavailable
	}
	return NewConn(world.RedisServer), nil
}

// adapt points options at the runtime's server: RESP2 (no HELLO 3), no client identity handshake,
// and no maintenance notifications (their endpoint detection resolves the address over DNS, which
// in WebAssembly waits for a resolver that never answers).
func adapt(opt *redis.Options) *redis.Options {
	o := *opt
	o.Dialer = dial
	o.Protocol = 2
	o.DisableIdentity = true
	o.MaxRetries = -1
	o.MaintNotificationsConfig = &maintnotifications.Config{Mode: maintnotifications.ModeDisabled}
	return &o
}

// NewClient is redis.NewClient connected to the runtime's server.
func NewClient(opt *redis.Options) *redis.Client { return redis.NewClient(adapt(opt)) }

// NewFailoverClient is redis.NewFailoverClient as a plain client of the runtime's server.
func NewFailoverClient(opt *redis.FailoverOptions) *redis.Client {
	return NewClient(&redis.Options{DB: opt.DB, Password: opt.Password, Username: opt.Username})
}

// NewUniversalClient is redis.NewUniversalClient as a plain client of the runtime's server.
func NewUniversalClient(opt *redis.UniversalOptions) redis.UniversalClient {
	return NewClient(&redis.Options{DB: opt.DB, Password: opt.Password, Username: opt.Username})
}

// Overrides is the part of the go-redis table that dials: every constructor connects to the
// runtime's server. The rest of the table is go-redis itself.
func Overrides() map[string]reflect.Value {
	return map[string]reflect.Value{
		"NewClient":          reflect.ValueOf(NewClient),
		"NewFailoverClient":  reflect.ValueOf(NewFailoverClient),
		"NewUniversalClient": reflect.ValueOf(NewUniversalClient),
	}
}
