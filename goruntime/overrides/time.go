// Package overrides replaces, for interpreted code only, the parts of the standard library that
// would reach outside the runtime: time and context deadlines run on the virtual clock (vclock),
// listening captures instead of binding a port, exiting ends the check instead of the runtime.
// Everything else in those packages is the real standard library (the generated tables).
package overrides

import (
	"reflect"
	"time"

	"leetbuild/goruntime/vclock"
)

// Time is the `time` package on the virtual clock: the clock functions and the Timer and Ticker
// types; Duration, Time, Month, the constants, parsing and formatting stay the standard library's.
func Time() map[string]reflect.Value {
	return map[string]reflect.Value{
		"Now":       reflect.ValueOf(vclock.Now),
		"Since":     reflect.ValueOf(vclock.Since),
		"Until":     reflect.ValueOf(vclock.Until),
		"Sleep":     reflect.ValueOf(vclock.Sleep),
		"After":     reflect.ValueOf(vclock.After),
		"AfterFunc": reflect.ValueOf(vclock.AfterFunc),
		"NewTimer":  reflect.ValueOf(vclock.NewTimer),
		"NewTicker": reflect.ValueOf(vclock.NewTicker),
		"Tick":      reflect.ValueOf(vclock.Tick),
		"Timer":     reflect.ValueOf((*vclock.Timer)(nil)),
		"Ticker":    reflect.ValueOf((*vclock.Ticker)(nil)),
		// Unchanged, listed so a reader of this table sees the clock surface whole.
		"Duration": reflect.ValueOf((*time.Duration)(nil)),
	}
}

// Context is `context` with its deadlines on the virtual clock.
func Context() map[string]reflect.Value {
	return map[string]reflect.Value{
		"WithTimeout":       reflect.ValueOf(vclock.WithTimeout),
		"WithDeadline":      reflect.ValueOf(vclock.WithDeadline),
		"WithTimeoutCause":  reflect.ValueOf(vclock.WithTimeoutCause),
		"WithDeadlineCause": reflect.ValueOf(vclock.WithDeadlineCause),
	}
}
