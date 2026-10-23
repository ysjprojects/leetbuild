// Package host runs one check of a Go harness: it assembles the source tree (the learner's step
// file, the harness as harness_test.go, the course's support packages, stubs generated from the
// course's .proto files), compiles it in a fresh interpreter with the runtime's symbol tables and
// overrides, and calls the check.
package host

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"path"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing/fstest"
	"unicode"

	"github.com/traefik/yaegi/interp"

	"leetbuild/goruntime/builtins"
	"leetbuild/goruntime/harness"
	"leetbuild/goruntime/models/goredis"
	"leetbuild/goruntime/overrides"
	"leetbuild/goruntime/symbols"
	"leetbuild/goruntime/world"
)

// Job is what the JavaScript side sends: RunJob, as src/lib/runtime/types.ts defines it.
type Job struct {
	Files   map[string]string `json:"files"`
	Support map[string]string `json:"support"`
	Harness string            `json:"harness"`
	Entry   string            `json:"entry"`
	Checks  []string          `json:"checks"`
}

// Result is one check's outcome, with the output the program wrote while it ran.
type Result struct {
	ID      string `json:"id"`
	Passed  bool   `json:"passed"`
	Message string `json:"message,omitempty"`
	Stdout  string `json:"stdout"`
	Stderr  string `json:"stderr"`
}

// Hooks the model packages fill in at start-up (the host imports none of them directly).
var (
	// Resets clear the models' per-check state (the broker, the gRPC registry).
	Resets []func()
	// Listen is net.Listen for interpreted code (in-memory listeners); nil: listening fails.
	Listen func(network, address string) (net.Listener, error)
	// GenerateStubs turns the course's .proto sources into Go packages at the given import paths:
	// files "chat.proto" → source, importPaths "chat" → "chat/gen/chat"; it returns source paths
	// under src/ → Go source.
	GenerateStubs func(files, importPaths map[string]string) (map[string]string, error)
	// Tables are extra symbol tables applied after the generated ones (model overrides).
	Tables []func() interp.Exports
)

// MetricHooks add the models' counters for the last check (learner-only), under the names of
// RunMetrics in src/lib/runtime/types.ts.
var MetricHooks []func(m map[string]int)

// Metrics is what the learner's code did on the Go side of the world in the last check: the
// broker's and the gRPC registry's counters (Redis, SQL and sleeps are counted in JavaScript).
func Metrics() map[string]int {
	m := map[string]int{"kafkaProduced": 0, "kafkaDelivered": 0, "kafkaCommits": 0, "grpcCalls": 0}
	for _, h := range MetricHooks {
		h(m)
	}
	return m
}

// CheckName is the harness function for a check id: "release-atomic" → "CheckReleaseAtomic".
func CheckName(id string) string {
	var b strings.Builder
	b.WriteString("Check")
	upper := true
	for _, r := range id {
		if r == '-' || r == '_' || r == ' ' {
			upper = true
			continue
		}
		if upper {
			b.WriteRune(unicode.ToUpper(r))
			upper = false
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// output is a check's stdout or stderr: written by interpreted code on any goroutine.
type output struct {
	mu sync.Mutex
	b  strings.Builder
}

func (o *output) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.b.Write(p)
}

func (o *output) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.b.String()
}

// RunCheck runs check id of job in a world the caller has reset on its side (JavaScript resources,
// the clock installed); the Go side of the world is reset here.
func RunCheck(job *Job, id string) Result {
	world.Reset()
	for _, reset := range Resets {
		reset()
	}
	stdout, stderr := &output{}, &output{}
	res := Result{ID: id}
	finish := func(passed bool, message string) Result {
		res.Passed, res.Message = passed, message
		res.Stdout, res.Stderr = stdout.String(), stderr.String()
		return res
	}
	tree, files, err := sourceTree(job)
	if err != nil {
		return finish(false, err.Error())
	}
	var bgPanics []string
	var bgMu sync.Mutex
	record := func(r any) {
		if _, ok := overrides.IsExit(r); ok {
			return // the program exited; Process records it
		}
		bgMu.Lock()
		bgPanics = append(bgPanics, fmt.Sprint(r))
		bgMu.Unlock()
	}
	world.PanicHandler = record
	// start builds one instance of the program: a fresh interpreter over the tree, with its own
	// process (pid). The check's program is pid 1; ctx.Instance() starts more beside it. When the
	// check ends, so does every instance: goroutines left behind (main blocked in a server the next
	// reset stops, a consumer loop) must not act on the next check's world.
	var started []*interp.Interpreter
	defer func() {
		for _, in := range started {
			in.Halt()
		}
	}()
	start := func(pid int) (*interp.Interpreter, string) {
		in := interp.New(interp.Options{
			GoPath:               ".",
			SourcecodeFilesystem: tree,
			Stdout:               stdout,
			Stderr:               stderr,
			GoroutinePanic:       func(r interface{}) { record(r) },
		})
		in.Haltable()
		started = append(started, in)
		proc := &overrides.Process{Env: map[string]string{}, Files: files, Stderr: stderr, Pid: pid}
		if err := use(in, proc); err != nil {
			return nil, "the runtime could not load its libraries: " + err.Error()
		}
		if err := compile(in); err != nil {
			return nil, explainCompile(err, job.Entry)
		}
		return in, ""
	}
	i, problem := start(1)
	if problem != "" {
		return finish(false, problem)
	}
	world.SpawnInstance = func() (func(name string) (reflect.Value, bool), error) {
		in, problem := start(len(started) + 1)
		if problem != "" {
			return nil, errors.New(problem)
		}
		return func(name string) (reflect.Value, bool) { return in.Lookup("main", name) }, nil
	}
	name := CheckName(id)
	sym, ok := i.Symbols("main")["main"][name]
	if !ok {
		return finish(false, "the harness has no "+name)
	}
	check, ok := sym.Interface().(func(*harness.Ctx))
	if !ok {
		if withErr, ok2 := sym.Interface().(func(*harness.Ctx) error); ok2 {
			check = func(c *harness.Ctx) {
				if err := withErr(c); err != nil {
					c.Fatalf("%v", err)
				}
			}
		} else {
			return finish(false, fmt.Sprintf("%s must be func(*harness.Ctx), it is %s", name, sym.Type()))
		}
	}
	ctx := harness.New(settler{})
	failure := run(func() { check(ctx) })
	if failure == "" {
		bgMu.Lock()
		if len(bgPanics) > 0 {
			failure = "a goroutine of the program panicked: " + bgPanics[0] + learnerLocation(stderr.String(), job.Entry)
		}
		bgMu.Unlock()
	}
	if failure != "" {
		return finish(false, failure)
	}
	return finish(true, "")
}

// run calls f and turns what it panicked with into a failure message ("" when it returned).
func run(f func()) (message string) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		var failure harness.Failure
		if errors.As(asError(r), &failure) {
			message = failure.Message
			return
		}
		if exit, ok := overrides.IsExit(r); ok {
			message = "the program exited: " + exit.Error()
			return
		}
		message = fmt.Sprintf("panic: %v", r)
	}()
	f()
	return ""
}

func asError(v any) error {
	if err, ok := v.(error); ok {
		return err
	}
	return fmt.Errorf("%v", v)
}

func use(i *interp.Interpreter, proc *overrides.Process) error {
	if err := i.Use(symbols.Symbols); err != nil {
		return err
	}
	tables := interp.Exports{
		"time/time":                          overrides.Time(),
		"context/context":                    overrides.Context(),
		"log/log":                            proc.Log(),
		"os/os":                              proc.Os(),
		"syscall/syscall":                    proc.Syscall(),
		"os/signal/signal":                   overrides.Signal(),
		"net/http/http":                      overrides.HTTP(),
		"github.com/redis/go-redis/v9/redis": goredis.Overrides(),
		builtins.ImportKey:                   builtins.Table(),
		"net/net":                            netTable(),
	}
	for _, t := range Tables {
		for k, v := range t() {
			if tables[k] == nil {
				tables[k] = map[string]reflect.Value{}
			}
			for name, val := range v {
				tables[k][name] = val
			}
		}
	}
	return i.Use(tables)
}

func netTable() map[string]reflect.Value {
	return map[string]reflect.Value{
		"Listen": reflect.ValueOf(func(network, address string) (net.Listener, error) {
			if Listen == nil {
				return nil, fmt.Errorf("listen %s %s: listening is not available in this runtime", network, address)
			}
			return Listen(network, address)
		}),
	}
}

func compile(i *interp.Interpreter) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return i.EvalTest("main")
}

// sourceTree lays the job out as the interpreter's source tree, and the course's other files
// (certificates, fixtures) for os.ReadFile.
func sourceTree(job *Job) (fstest.MapFS, fs.FS, error) {
	tree := fstest.MapFS{}
	files := fstest.MapFS{}
	add := func(p, src string) { tree[p] = &fstest.MapFile{Data: []byte(src)} }
	entry := job.Files[job.Entry]
	if job.Entry == "" || !strings.HasSuffix(job.Entry, ".go") {
		return nil, nil, fmt.Errorf("the job names no Go entry file (%q)", job.Entry)
	}
	if strings.TrimSpace(job.Harness) == "" {
		return nil, nil, errors.New("this step has no Go harness")
	}
	add("src/main/"+job.Entry, entry)
	add("src/main/harness_test.go", job.Harness)
	goSources := []string{entry, job.Harness}
	protos := map[string]string{}
	for p, src := range job.Support {
		switch {
		case strings.HasSuffix(p, ".go"):
			add("src/"+p, src)
			goSources = append(goSources, src)
		case strings.HasSuffix(p, ".proto"):
			protos[path.Base(p)] = src
			files[p] = &fstest.MapFile{Data: []byte(src)}
		default:
			files[p] = &fstest.MapFile{Data: []byte(src)}
		}
	}
	if len(protos) > 0 && GenerateStubs != nil {
		paths := protoImportPaths(protos, goSources)
		if len(paths) > 0 {
			stubs, err := GenerateStubs(protos, paths)
			if err != nil {
				return nil, nil, fmt.Errorf("generating the gRPC stubs: %v", err)
			}
			for p, src := range stubs {
				add(p, src)
			}
		}
	}
	builtins.Inject(tree)
	return tree, files, nil
}

var genImport = regexp.MustCompile(`"([\w./-]+/gen/([\w-]+))"`)

// protoImportPaths finds where the Go code imports each proto's generated package
// (`pb "chat/gen/chat"` for chat.proto). A proto the code does not import (another step's, or one
// only a sibling .proto imports) is generated beside the imported ones: <module>/gen/<stem>.
func protoImportPaths(protos map[string]string, sources []string) map[string]string {
	out := map[string]string{}
	root := ""
	for _, src := range sources {
		for _, m := range genImport.FindAllStringSubmatch(src, -1) {
			if _, ok := protos[m[2]+".proto"]; ok {
				out[m[2]] = m[1]
				root = strings.TrimSuffix(m[1], "/"+m[2])
			}
		}
	}
	if root == "" {
		return out
	}
	for file := range protos {
		if stem := strings.TrimSuffix(file, ".proto"); out[stem] == "" {
			out[stem] = root + "/" + stem
		}
	}
	return out
}

var position = regexp.MustCompile(`(?:\./)?src/main/([\w.-]+\.go):(\d+)(?::\d+)?`)

// explainCompile reports a compile error at the learner's line, without the source tree's prefix.
func explainCompile(err error, entry string) string {
	msg := err.Error()
	msg = position.ReplaceAllString(msg, "$1:$2")
	msg = strings.ReplaceAll(msg, "src/", "")
	if strings.Contains(msg, "harness_test.go") {
		return "the harness does not compile against your code: " + msg
	}
	return "your code does not compile: " + msg
}

// learnerLocation finds, in what the interpreter printed, where a panic came from in the learner's file.
func learnerLocation(stderr, entry string) string {
	for _, line := range strings.Split(stderr, "\n") {
		if m := position.FindStringSubmatch(line); m != nil && m[1] == entry {
			return " (" + m[1] + ":" + m[2] + ")"
		}
	}
	return ""
}

// settler is the harness's Host: the world's Settler when the JavaScript side installed one.
type settler struct{}

func (settler) Settle() {
	if world.Settle != nil {
		world.Settle.Settle()
	}
}

// Tick is Settle with the clock held where it is, when the world's Settler can (the JavaScript one).
func (settler) Tick() {
	if t, ok := world.Settle.(interface{ Tick() }); ok {
		t.Tick()
		return
	}
	settler{}.Settle()
}

func (settler) Interrupted() <-chan struct{} {
	if world.Settle != nil {
		return world.Settle.Interrupted()
	}
	return nil
}
