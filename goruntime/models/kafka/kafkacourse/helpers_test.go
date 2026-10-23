package kafkacourse_test

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"leetbuild/goruntime/harness"
	mk "leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/models/kafka/kafkatest"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
	"leetbuild/goruntime/yaegitest"
)

// solution is the Go solution of a step (problem id, step id), read from the course sources.
func solution(t *testing.T, problem, step string) string {
	t.Helper()
	dir, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	for !exists(filepath.Join(dir, "src", "data", "problems")) {
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("the course sources (src/data/problems) are not in a parent directory")
		}
		dir = parent
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "src", "data", "problems", "*-"+problem, "steps", "*-"+step+".ts"))
	if len(matches) != 1 {
		t.Fatalf("step %s/%s: found %v", problem, step, matches)
	}
	src, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	code := strings.Index(text, "\n  code: {")
	goAt := strings.Index(text[code:], "\n    go: {")
	if code < 0 || goAt < 0 {
		t.Fatalf("%s has no code.go", matches[0])
	}
	rest := text[code+goAt:]
	sol := strings.Index(rest, "solution: `")
	if sol < 0 {
		t.Fatalf("%s has no code.go.solution", matches[0])
	}
	return templateLiteral(rest[sol+len("solution: `"):])
}

// templateLiteral reads a TypeScript template literal up to its closing backquote, unescaping \`,
// \$ and \\.
func templateLiteral(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\':
			if i+1 < len(s) && strings.IndexByte("`$\\", s[i+1]) >= 0 {
				b.WriteByte(s[i+1])
				i++
				continue
			}
			b.WriteByte(c)
		case '`':
			return b.String()
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// run compiles the learner's file beside the harness and runs each check in a fresh world and a
// fresh interpreter, as the runtime does: broker reset, clock at zero, then compile, then call.
func run(t *testing.T, learnerFile, learner, harnessSrc string, checks ...string) {
	t.Helper()
	runWithBudget(t, 500, learnerFile, learner, harnessSrc, checks...)
}

// runWithBudget is run with a sleep budget other than the runtime's 500 jumps.
func runWithBudget(t *testing.T, budget int, learnerFile, learner, harnessSrc string, checks ...string) {
	t.Helper()
	for _, name := range checks {
		t.Run(name, func(t *testing.T) {
			// The runtime is js/wasm: one thread, goroutines interleave only where they block or yield.
			defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(1))
			clock := kafkatest.New()
			clock.SetBudget(budget)
			vclock.Set(clock)
			mk.Reset()
			stop := clock.Start()
			var panics []any
			world.PanicHandler = func(r any) { panics = append(panics, r) }
			defer func() {
				stop()
				mk.Reset()
				vclock.Set(vclock.Real{})
				world.PanicHandler = nil
			}()
			i, err := yaegitest.Compile(map[string]string{
				"src/main/" + learnerFile:  learner,
				"src/main/harness_test.go": harnessSrc,
			})
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			check, err := i.Func(name)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan any, 1)
			go func() {
				defer func() { done <- recover() }()
				check.Call([]reflect.Value{reflect.ValueOf(harness.New(clock))})
			}()
			select {
			case r := <-done:
				if r != nil {
					if f, ok := r.(harness.Failure); ok {
						t.Fatalf("check failed: %s", f.Message)
					}
					t.Fatalf("check panicked: %v", r)
				}
			case <-time.After(20 * time.Second):
				buf := make([]byte, 1<<20)
				n := runtime.Stack(buf, true)
				t.Fatalf("the check did not finish; clock at %v after %d jumps\n%s", clock.Now(), clock.Jumps(), buf[:n])
			}
			if len(i.Panics) > 0 || len(panics) > 0 {
				t.Fatalf("goroutine panics: %v %v", i.Panics, panics)
			}
			produced, delivered, commits := mk.Metrics()
			t.Logf("metrics: produced %d, delivered %d, commits %d; clock jumps %d; stdout %q stderr %q",
				produced, delivered, commits, clock.Jumps(), i.Stdout.String(), trim(i.Stderr.String()))
		})
	}
}

func trim(s string) string {
	if len(s) > 400 {
		return s[:400] + fmt.Sprintf("…(%d bytes)", len(s))
	}
	return s
}
