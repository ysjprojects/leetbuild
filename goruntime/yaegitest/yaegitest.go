// Package yaegitest builds an interpreter the way the runtime does, natively and without the
// JavaScript world, for model and harness tests: the symbol tables, the time and context overrides,
// the injected min, max and clear builtins, and a source tree of `path → source` (paths under src/,
// e.g. src/main/app.go, src/main/harness_test.go, src/chat/gen/chat/chat.pb.go). Install a
// vclock.Fake first when the code under test sleeps.
package yaegitest

import (
	"fmt"
	"reflect"
	"strings"
	"testing/fstest"

	"github.com/traefik/yaegi/interp"

	"leetbuild/goruntime/builtins"
	"leetbuild/goruntime/overrides"
	"leetbuild/goruntime/symbols"
)

// Interpreter is a compiled main package.
type Interpreter struct {
	*interp.Interpreter
	Stdout, Stderr *strings.Builder
	// Panics collects panics that escaped goroutines the interpreted code started.
	Panics []any
}

// Compile compiles src/main (its _test.go files included) without running main.
func Compile(files map[string]string) (*Interpreter, error) {
	fs := fstest.MapFS{}
	for path, text := range files {
		fs[path] = &fstest.MapFile{Data: []byte(text)}
	}
	builtins.Inject(fs)
	out := &Interpreter{Stdout: &strings.Builder{}, Stderr: &strings.Builder{}}
	i := interp.New(interp.Options{
		GoPath:               ".",
		SourcecodeFilesystem: fs,
		Stdout:               out.Stdout,
		Stderr:               out.Stderr,
		GoroutinePanic:       func(r interface{}) { out.Panics = append(out.Panics, r) },
	})
	out.Interpreter = i
	if err := i.Use(symbols.Symbols); err != nil {
		return nil, err
	}
	if err := i.Use(interp.Exports{
		"time/time":        overrides.Time(),
		"context/context":  overrides.Context(),
		builtins.ImportKey: builtins.Table(),
	}); err != nil {
		return nil, err
	}
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("compile panic: %v", r)
			}
		}()
		err = i.EvalTest("main")
	}()
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Func returns the exported function name of the main package.
func (i *Interpreter) Func(name string) (reflect.Value, error) {
	sym, ok := i.Symbols("main")["main"][name]
	if !ok {
		return reflect.Value{}, fmt.Errorf("main has no exported %s", name)
	}
	return sym, nil
}
