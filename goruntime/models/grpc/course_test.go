package grpc_test

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"leetbuild/goruntime/harness"
	"leetbuild/goruntime/models/grpc"
	"leetbuild/goruntime/protogen"
	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
	"leetbuild/goruntime/yaegitest"
)

// The real course code: each test compiles a step's Go solution (from its step file) with the
// stubs protogen generates from the course's .proto files, plus a test-local harness, and runs
// the harness's checks on the virtual clock.

const problems = "../../../src/data/problems"

func problemDir(t *testing.T, id string) string {
	t.Helper()
	dirs, _ := filepath.Glob(filepath.Join(problems, "*-"+id))
	for _, d := range dirs {
		if regexp.MustCompile(`^\d+-` + regexp.QuoteMeta(id) + `$`).MatchString(filepath.Base(d)) {
			return d
		}
	}
	t.Fatalf("no problem %s", id)
	return ""
}

// templateLiteral reads the template literal opening at src[i] (a backtick), unescaping \` \$ \\.
func templateLiteral(src string, i int) string {
	var b strings.Builder
	for j := i + 1; j < len(src); j++ {
		switch src[j] {
		case '`':
			return b.String()
		case '\\':
			if j+1 < len(src) && strings.ContainsRune("`$\\", rune(src[j+1])) {
				b.WriteByte(src[j+1])
				j++
				continue
			}
		}
		b.WriteByte(src[j])
	}
	return b.String()
}

// solution returns code.go.solution of a step.
func solution(t *testing.T, problem, step string) string {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(problemDir(t, problem), "steps", "*-"+step+".ts"))
	if len(files) != 1 {
		t.Fatalf("no step %s/%s", problem, step)
	}
	raw, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	code := strings.Index(src, "\n  code: {")
	goAt := regexp.MustCompile(`\n    go: \{\s*\n\s*starter: ` + "`").FindStringIndex(src[code:])
	if code < 0 || goAt == nil {
		t.Fatalf("%s/%s has no Go code", problem, step)
	}
	starterAt := code + goAt[1] - 1
	starter := templateLiteral(src, starterAt)
	rest := src[starterAt+len(starter):]
	solAt := strings.Index(rest, "solution: `")
	return templateLiteral(rest, solAt+len("solution: "))
}

// supportGo returns the course's Go support file at path (from support.ts), keyed for the source
// tree ("src/<path>").
func supportGo(t *testing.T, problem, path string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(problemDir(t, problem), "support.ts"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	key := "'" + path + "': "
	at := strings.Index(src, key+"`")
	if at < 0 {
		t.Fatalf("%s has no Go support file %s", problem, path)
	}
	return map[string]string{"src/" + path: templateLiteral(src, at+len(key))}
}

// stubs generates Go from a problem's .proto files, at the import paths the code imports them by.
func stubs(t *testing.T, problem, code string) map[string]string {
	t.Helper()
	paths, _ := filepath.Glob(filepath.Join(problemDir(t, problem), "proto", "*.proto"))
	files := map[string]string{}
	for _, p := range paths {
		src, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		files[filepath.Base(p)] = string(src)
	}
	importPaths := map[string]string{}
	for _, m := range regexp.MustCompile(`"([\w.-]+/gen/(\w+))"`).FindAllStringSubmatch(code, -1) {
		importPaths[m[2]] = m[1]
	}
	for name := range files {
		stem := strings.TrimSuffix(name, ".proto")
		if _, ok := importPaths[stem]; !ok {
			importPaths[stem] = problem + "/gen/" + stem
		}
	}
	out, err := protogen.Generate(files, importPaths)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type host struct{}

// Settle approximates the runtime's: the interpreted goroutines get a moment to block.
func (host) Settle()                      { time.Sleep(30 * time.Millisecond) }
func (host) Interrupted() <-chan struct{} { return nil }

// autoClock stands in for the host's settling clock: once the world has looked idle for a while
// (no timer armed or fired, no call started or ended, over several samples) with timers pending,
// time moves 1 ms at a time until one of them fires.
func autoClock(t *testing.T) *vclock.Fake {
	clock := vclock.NewFake()
	vclock.Set(clock)
	stop := make(chan struct{})
	done := make(chan struct{})
	fingerprint := func() string {
		calls := grpc.Calls()
		ended := 0
		for _, c := range calls {
			if c.Done {
				ended++
			}
		}
		return fmt.Sprint(clock.Pending(), len(calls), ended)
	}
	go func() {
		defer close(done)
		quiet, last := 0, ""
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			if fp := fingerprint(); fp != last {
				quiet, last = 0, fp
				continue
			}
			if quiet++; quiet < 6 {
				continue
			}
			n := clock.Pending()
			for i := 0; n > 0 && clock.Pending() >= n && i < 600_000; i++ {
				clock.Advance(time.Millisecond)
			}
			quiet, last = 0, ""
		}
	}()
	t.Cleanup(func() {
		close(stop)
		<-done
		vclock.Set(vclock.Real{})
	})
	return clock
}

// runChecks compiles code (the solution, transformed) with checks (harness_test.go) once per
// check, as the runtime does, and runs each check in a world reset before it.
func runChecks(t *testing.T, problem, code, checks string, support ...map[string]string) {
	t.Helper()
	gen := stubs(t, problem, code)
	names := regexp.MustCompile(`(?m)^func (Check\w+)\(`).FindAllStringSubmatch(checks, -1)
	if len(names) == 0 {
		t.Fatal("no checks")
	}
	for _, m := range names {
		t.Run(m[1], func(t *testing.T) {
			grpc.Reset()
			t.Cleanup(grpc.Reset)
			var panics []any
			var panicMu sync.Mutex
			world.PanicHandler = func(r any) {
				panicMu.Lock()
				panics = append(panics, r)
				panicMu.Unlock()
			}
			t.Cleanup(func() {
				world.PanicHandler = nil
				panicMu.Lock()
				defer panicMu.Unlock()
				if len(panics) > 0 {
					t.Errorf("panics in handlers: %v", panics)
				}
			})
			autoClock(t)
			files := map[string]string{
				"src/main/solution.go":     code,
				"src/main/harness_test.go": checks,
			}
			for p, src := range gen {
				files[p] = src
			}
			for _, extra := range support {
				for p, src := range extra {
					files[p] = src
				}
			}
			i, err := yaegitest.Compile(files)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			check, err := i.Func(m[1])
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan any, 1)
			go func() {
				defer func() { done <- recover() }()
				check.Call([]reflect.Value{reflect.ValueOf(harness.New(host{}))})
			}()
			select {
			case r := <-done:
				if r != nil {
					t.Fatalf("check failed: %v\n%s", r, i.Stderr)
				}
			case <-time.After(20 * time.Second):
				t.Fatalf("check timed out\n%s", i.Stderr)
			}
			if len(i.Panics) > 0 {
				t.Fatalf("goroutine panics: %v", i.Panics)
			}
		})
	}
}

func TestEveryCourseProtoCompilesUnderYaegi(t *testing.T) {
	dirs, _ := filepath.Glob(filepath.Join(problems, "*", "proto"))
	if len(dirs) == 0 {
		t.Fatal("no course protos")
	}
	for _, d := range dirs {
		problem := filepath.Base(filepath.Dir(d))
		t.Run(problem, func(t *testing.T) {
			id := regexp.MustCompile(`^\d+-`).ReplaceAllString(problem, "")
			gen := stubs(t, id, "")
			pkgs := map[string]bool{}
			for p := range gen {
				pkgs[strings.TrimPrefix(filepath.Dir(p), "src/")] = true
			}
			main := "package main\n\nimport (\n"
			for p := range pkgs {
				main += fmt.Sprintf("\t_ %q\n", p)
			}
			main += ")\n\nfunc main() {}\n"
			files := map[string]string{"src/main/main.go": main}
			for p, src := range gen {
				files[p] = src
			}
			if _, err := yaegitest.Compile(files); err != nil {
				t.Fatalf("%v\n%s", err, main)
			}
		})
	}
}
