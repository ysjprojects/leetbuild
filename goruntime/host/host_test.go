package host

import (
	"strings"
	"testing"
	"time"

	"leetbuild/goruntime/vclock"
	"leetbuild/goruntime/world"
)

// sleepSettler stands in for the JavaScript one natively: a short real wait lets the background
// goroutines reach their blocking points.
type sleepSettler struct{}

func (sleepSettler) Settle()                      { time.Sleep(30 * time.Millisecond) }
func (sleepSettler) Interrupted() <-chan struct{} { return nil }

func TestRunCheckServesMainOverHTTP(t *testing.T) {
	world.Settle = sleepSettler{}
	defer func() { world.Settle = nil }()
	job := &Job{
		Entry: "shorten.go",
		Files: map[string]string{"shorten.go": `package main

import (
	"fmt"
	"log"
	"net/http"
)

var hits = map[string]int{}

func shorten(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	hits[id]++
	fmt.Fprintf(w, "%s:%d:%d", id, min(hits[id], 2), max(len(id), 1))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /s/{id}", shorten)
	mux.HandleFunc("DELETE /s", func(w http.ResponseWriter, r *http.Request) { clear(hits); w.WriteHeader(204) })
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`},
		Harness: `package main

import "leetbuild/harness"

func CheckServes(ctx *harness.Ctx) {
	app := ctx.Main(main).HTTP()
	res := app.Get("/s/abc")
	ctx.Equal(res.Status, 200, "GET /s/abc status")
	ctx.Equal(res.Text(), "abc:1:3", "first body")
	app.Get("/s/abc")
	ctx.Equal(app.Get("/s/abc").Text(), "abc:2:3", "min caps the count at 2")
	ctx.Equal(app.Delete("/s").Status, 204, "DELETE status")
	ctx.Equal(len(hits), 0, "clear empties the map")
}

func CheckFails(ctx *harness.Ctx) {
	ctx.Equal(1+1, 3, "arithmetic")
}
`,
	}
	if res := RunCheck(job, "serves"); !res.Passed {
		t.Fatalf("serves failed: %s\nstderr: %s", res.Message, res.Stderr)
	}
	res := RunCheck(job, "fails")
	if res.Passed || res.Message != "arithmetic: got 2, want 3" {
		t.Fatalf("fails: passed=%v message=%q", res.Passed, res.Message)
	}
	res = RunCheck(job, "missing")
	if res.Passed || !strings.Contains(res.Message, "CheckMissing") {
		t.Fatalf("missing: %+v", res)
	}
}

func TestRunCheckReportsCompileErrorsAtTheLearnersLine(t *testing.T) {
	job := &Job{
		Entry:   "app.go",
		Files:   map[string]string{"app.go": "package main\n\nfunc main() {\n\tundefinedThing()\n}\n"},
		Harness: "package main\n\nimport \"leetbuild/harness\"\n\nfunc CheckX(ctx *harness.Ctx) {}\n",
	}
	res := RunCheck(job, "x")
	if res.Passed || !strings.Contains(res.Message, "app.go:4") {
		t.Fatalf("compile error: %+v", res)
	}
}

// A check's program ends with the check: main, blocked in a server the next check's reset stops,
// must not go on to log.Fatal (an exit) or listen again in that next check's world.
func TestRunCheckEndsTheProgramWithTheCheck(t *testing.T) {
	world.Settle = sleepSettler{}
	defer func() { world.Settle = nil }()
	job := &Job{
		Entry: "app.go",
		Files: map[string]string{"app.go": `package main

import (
	"log"
	"net/http"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {})
	log.Println(http.ListenAndServe(":8080", mux))
	log.Fatal(http.ListenAndServe(":8081", mux))
}
`},
		Harness: `package main

import "leetbuild/harness"

func CheckServe(ctx *harness.Ctx) { ctx.Equal(ctx.Main(main).HTTP().Get("/").Status, 200, "GET /") }

func CheckIdle(ctx *harness.Ctx) { ctx.Settle() }
`,
	}
	if res := RunCheck(job, "serve"); !res.Passed {
		t.Fatalf("serve failed: %s\nstderr: %s", res.Message, res.Stderr)
	}
	if res := RunCheck(job, "idle"); !res.Passed {
		t.Fatalf("idle failed: %s", res.Message)
	}
	if _, message, exited := world.Process.Exited(); exited {
		t.Fatalf("the previous check's main exited into this one: %s", message)
	}
	if servers := world.HTTP.Servers(); len(servers) != 0 {
		t.Fatalf("the previous check's main listens in this one, on %s", servers[0].Addr)
	}
}

// ctx.Instance() is a second process of the same build: its own pid and package state, its
// functions callable from the check, the check's own program untouched by them.
func TestInstanceIsAnotherProcessOfTheProgram(t *testing.T) {
	job := &Job{
		Entry: "app.go",
		Files: map[string]string{"app.go": `package main

import (
	"os"
	"strconv"
)

var group = "chat-" + strconv.Itoa(os.Getpid())

var count int

func bump() int {
	count++
	return count
}

var describe = func() string { return group + ":" + strconv.Itoa(count) }

func main() {}
`},
		Harness: `package main

import "leetbuild/harness"

func CheckTwo(ctx *harness.Ctx) {
	b := ctx.Instance()
	ctx.Equal(group, "chat-1", "the check's program is pid 1")
	ctx.Equal(b.Get("group"), "chat-2", "the instance is another process")
	ctx.Equal(b.Get("bump").(func() int)(), 1, "the instance's state starts fresh")
	ctx.Equal(b.Get("bump").(func() int)(), 2, "the instance keeps its state")
	ctx.Equal(count, 0, "the check's program is untouched by the instance")
	ctx.Equal(b.Get("describe").(func() string)(), "chat-2:2", "a func variable of the instance")
	ctx.Equal(ctx.Instance().Get("group"), "chat-3", "a third instance")
}

func CheckMissing(ctx *harness.Ctx) { ctx.Instance().Get("nothing") }
`,
	}
	if res := RunCheck(job, "two"); !res.Passed {
		t.Fatalf("two failed: %s\nstderr: %s", res.Message, res.Stderr)
	}
	if res := RunCheck(job, "missing"); res.Passed || res.Message != "the program has no package-level nothing" {
		t.Fatalf("missing: passed=%v message=%q", res.Passed, res.Message)
	}
}

// A course's protos all get generated packages beside the one the step imports, so a step importing
// only locations still compiles when the course also ships routing.proto.
func TestProtoImportPathsCoverEveryCourseProto(t *testing.T) {
	protos := map[string]string{"locations.proto": "", "routing.proto": ""}
	got := protoImportPaths(protos, []string{"package main\n\nimport pb \"dispatch/gen/locations\"\n"})
	want := map[string]string{"locations": "dispatch/gen/locations", "routing": "dispatch/gen/routing"}
	if len(got) != len(want) || got["locations"] != want["locations"] || got["routing"] != want["routing"] {
		t.Fatalf("import paths: got %v, want %v", got, want)
	}
	if got := protoImportPaths(protos, []string{"package main\n"}); len(got) != 0 {
		t.Fatalf("code importing no generated package gets no stubs, got %v", got)
	}
}

// fakeClock is the JavaScript clock's control over a vclock Fake: Advance moves it, firing timers.
type fakeClock struct{ f *vclock.Fake }

func (c fakeClock) Advance(ms float64) { c.f.Advance(time.Duration(ms * float64(time.Millisecond))) }
func (fakeClock) Sleeps() int          { return 0 }
func (fakeClock) Slept() float64       { return 0 }

// http.Server.Shutdown stops listening at once, then drains the requests in flight, bounded by its
// context: a program closing without draining, or draining without a bound, is told apart.
func TestShutdownDrainsRequestsInFlightWithinItsDeadline(t *testing.T) {
	world.Settle = sleepSettler{}
	fake := vclock.NewFake()
	vclock.Set(fake)
	world.ClockControl = fakeClock{fake}
	defer func() { world.Settle, world.ClockControl = nil, nil; vclock.Set(vclock.Real{}) }()
	job := &Job{
		Entry: "app.go",
		Files: map[string]string{"app.go": `package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("done")) })
	srv := &http.Server{Addr: ":8443", Handler: mux}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM)
	go srv.ListenAndServe()
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	os.Exit(0)
}
`},
		Harness: `package main

import (
	"syscall"

	"leetbuild/harness"
)

func CheckDrains(ctx *harness.Ctx) {
	p := ctx.Main(main)
	release := p.HTTP().Hold("GET", "/slow", nil)
	ctx.Equal(p.Signal(syscall.SIGTERM), 1, "SIGTERM subscribers")
	ctx.Tick()
	ctx.Assert(!p.Listening(), "the listener closes at SIGTERM")
	ctx.Assert(p.Running(), "the program waits for the request in flight")
	ctx.Equal(release().Text(), "done", "the held response")
	ctx.Tick()
	ctx.Assert(!p.Running(), "the drain is over: the program exits")
}

func CheckBounded(ctx *harness.Ctx) {
	p := ctx.Main(main)
	p.HTTP().Hold("GET", "/slow", nil)
	p.Signal(syscall.SIGTERM)
	ctx.Tick()
	ctx.Clock.Advance(9)
	ctx.Tick()
	ctx.Assert(p.Running(), "9 s into a 10 s drain the program still waits")
	ctx.Clock.Advance(2)
	ctx.Tick()
	ctx.Assert(!p.Running(), "past the 10 s deadline the program exits anyway")
}
`,
	}
	for _, id := range []string{"drains", "bounded"} {
		if res := RunCheck(job, id); !res.Passed {
			t.Fatalf("%s failed: %s\nstderr: %s", id, res.Message, res.Stderr)
		}
	}
}
