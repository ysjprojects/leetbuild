package yaegitest

import (
	"fmt"
	"runtime/debug"
	"testing"
)

// run compiles src (package main) and calls its Run, which returns a string.
func run(t *testing.T, src string) (got string) {
	t.Helper()
	i, err := Compile(map[string]string{"src/main/main.go": src})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	f, err := i.Func("Run")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panic: %v\n%s", r, debug.Stack())
		}
	}()
	return fmt.Sprint(f.Call(nil)[0])
}

func expect(t *testing.T, src, want string) {
	t.Helper()
	if got := run(t, src); got != want {
		t.Errorf("Run() = %q, want %q", got, want)
	}
}

// min, max and clear, injected as yaegitest and the runtime do, with untyped constants mixed with
// typed operands.
func TestBuiltinsInjected(t *testing.T) {
	expect(t, `package main

import "fmt"

func span(size, suffix int64) (int64, int64) { return max(0, size-suffix), min(size, 5) }

func Run() string {
	m := map[string]int{"a": 1}
	clear(m)
	s := []int{1, 2}
	clear(s)
	var index, k int64 = 3, 1
	a, b := span(7, 9)
	return fmt.Sprintf("%v %v %v %v %v %v %v %v %v", min(3, 1, 2), max(2.5, 1), min("b", "a"), len(m), s,
		max(0, index-k), min(index, 5), a, b)
}`, "1 2.5 a 0 [0 0] 2 3 0 5")
}

// Type inference for generic calls: typed arguments win over untyped constants, and core types
// (S ~[]E) infer the element type; package slices' sorting functions exist.
func TestGenericInference(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"untyped then typed", `var n int64 = 4; return fmt.Sprint(pick(0, n), pick(n, 1))`, "4 4"},
		{"untyped default", `return fmt.Sprint(pick(2.5, 1), pick(1, 'a'))`, "2.5 97"},
		{"clone", `k := []string{"b", "a"}; c := slices.Clone(k); c[0] = "z"; return fmt.Sprint(k, c)`, "[b a] [z a]"},
		{"equal", `return fmt.Sprint(slices.Equal([]string{"a"}, []string{"a"}), slices.Index([]int{1, 2}, 2))`, "true 1"},
		{"named slice", `type ids []string; x := ids{"b", "a"}; return fmt.Sprint(slices.Clone(x))`, "[b a]"},
		{"sort func", `type sc struct{ p string; n int }; o := slices.Clone([]sc{{"a", 2}, {"b", 1}}); slices.SortFunc(o, func(a, b sc) int { return a.n - b.n }); return fmt.Sprint(o)`, "[{b 1} {a 2}]"},
		{"sort stable", `type p struct{ k string; n int }; x := []p{{"a", 1}, {"b", 0}, {"c", 1}}; slices.SortStableFunc(x, func(a, b p) int { return a.n - b.n }); return fmt.Sprint(x)`, "[{b 0} {a 1} {c 1}]"},
		{"sort", `x := []string{"b", "a"}; slices.Sort(x); return fmt.Sprint(x, slices.IsSorted(x))`, "[a b] true"},
		{"min max", `x := []int64{3, 1, 2}; return fmt.Sprint(slices.Min(x), slices.Max(x), slices.IsSorted(x))`, "1 3 false"},
		{"binary search", `i, ok := slices.BinarySearch([]string{"a", "c"}, "b"); return fmt.Sprint(i, ok)`, "1 false"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, `package main

import (
	"fmt"
	"slices"
)

type number interface{ ~int | ~int32 | ~int64 | ~float64 }

func pick[T number](x T, y ...T) T {
	for _, v := range y {
		if v > x {
			x = v
		}
	}
	return x
}

func Run() string { `+c.body+` }`, c.want)
		})
	}
}

func TestUnnamedParamClosure(t *testing.T) {
	const prelude = `package main

import "context"

var hook = func(ctx context.Context) (string, error) { panic("no") }

type api struct{ codes []string }
`
	for name, body := range map[string]string{
		"captured field": `
func Run() string {
	a := &api{}
	hook = func(context.Context) (string, error) {
		a.codes = append(a.codes, "x")
		return "x", nil
	}
	s, _ := hook(context.Background())
	return s + string(rune('0'+len(a.codes)))
}`,
		"blank param": `
func Run() string {
	a := &api{}
	hook = func(_ context.Context) (string, error) {
		a.codes = append(a.codes, "x")
		return "x", nil
	}
	s, _ := hook(context.Background())
	return s + string(rune('0'+len(a.codes)))
}`,
		"global": `
var codes []string

func Run() string {
	hook = func(context.Context) (string, error) {
		codes = append(codes, "x")
		return "x", nil
	}
	s, _ := hook(context.Background())
	return s + string(rune('0'+len(codes)))
}`,
		"local closure": `
func Run() string {
	a := &api{}
	f := func(context.Context) (string, error) {
		a.codes = append(a.codes, "x")
		return "x", nil
	}
	s, _ := f(context.Background())
	return s + string(rune('0'+len(a.codes)))
}`,
	} {
		t.Run(name, func(t *testing.T) { expect(t, prelude+body, "x1") })
	}
}

// An interpreted call result passed straight to a func whose parameter is a native interface with
// methods.
func TestCallResultToNativeInterfaceParam(t *testing.T) {
	const prelude = `package main

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

type w struct{ b *strings.Builder }

func (w w) Write(p []byte) (int, error) { return w.b.Write(p) }

type Writer interface{ Write([]byte) (int, error) }

type named string

func (s named) String() string { return "named:" + string(s) }

var sb strings.Builder

func newW() w           { return w{&sb} }
func newPW() *w         { return &w{&sb} }
func newI() Writer      { return newW() }
func nilI() Writer      { return nil }
func two() (w, string)  { return newW(), "y" }
func newS() named       { return "s" }
func put(w io.Writer)   { io.WriteString(w, "x") }
func put2(w io.Writer, s string) { io.WriteString(w, s) }
func str(s fmt.Stringer) string { return s.String() }
func isNil(w io.Writer) bool { return w == nil }

var _ = fmt.Sprint
var _ io.Writer
`
	for _, c := range []struct{ name, body, want string }{
		{"value", `io.WriteString(newW(), "x")`, "x"},
		{"pointer", `io.WriteString(newPW(), "x")`, "x"},
		{"interpreted interface", `io.WriteString(newI(), "x")`, "x"},
		{"interpreted interface variable", `i := newI(); io.WriteString(i, "x")`, "x"},
		{"nil interpreted interface", `sb.WriteString(fmt.Sprint(bufio.NewWriter(nilI()) != nil, isNil(nilI())))`, "true true"},
		{"multi-value", `io.WriteString(two())`, "y"},
		{"variadic", `io.WriteString(io.MultiWriter(newW(), newPW()), "x")`, "xx"},
		{"variadic variables", `a, b := newW(), newPW(); io.WriteString(io.MultiWriter(a, b), "x")`, "xx"},
		{"method", `strings.NewReader("x").WriteTo(newW())`, "x"},
		{"fmt writer", `fmt.Fprint(newW(), "x")`, "x"},
		{"interpreted callee", `put(newW())`, "x"},
		{"interpreted callee pointer", `put(newPW())`, "x"},
		{"interpreted callee multi-value", `put2(two())`, "y"},
		{"interpreted callee interface", `put(newI())`, "x"},
		{"interpreted callee stringer", `sb.WriteString(str(newS()))`, "named:s"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, prelude+"func Run() string { "+c.body+"; return sb.String() }", c.want)
		})
	}
}

func TestSendOnRangeChannel(t *testing.T) {
	expect(t, `package main

import "fmt"

func Run() string {
	list := []chan int{make(chan int, 1), make(chan int, 1)}
	for _, s := range list {
		s <- 1
	}
	m := map[string]chan int{"a": make(chan int, 1)}
	for _, s := range m {
		s <- 2
	}
	return fmt.Sprint(<-list[0], <-list[1], <-m["a"])
}`, "1 1 2")
}

// Methods promoted from an embedded native interface, called through an interpreted interface,
// directly, or by a native func the value is passed to.
func TestPromotedNativeInterfaceMethods(t *testing.T) {
	const prelude = `package main

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"
)

type Stream interface {
	Send(string) error
	context.Context
}

type stream struct {
	context.Context
	sent []string
}

func (s *stream) Send(m string) error { s.sent = append(s.sent, m); return nil }

type single struct{ context.Context }

func (single) Send(string) error { return nil }

type RW interface {
	Name() string
	io.ReadWriter
}

type rw struct{ io.ReadWriter }

func (rw) Name() string { return "rw" }

type readWriter struct {
	io.Reader
	io.Writer
}

type key struct{}

var b strings.Builder

func ctx() context.Context {
	c, _ := context.WithTimeout(context.WithValue(context.Background(), key{}, "v"), time.Hour)
	return c
}

func newRW() RW { return rw{&readWriter{strings.NewReader("in"), &b}} }

var _ = fmt.Sprint
`
	for _, c := range []struct{ name, body, want string }{
		{"interface, pointer", `var s Stream = &stream{Context: ctx()}; s.Send("m"); _, ok := s.Deadline(); return fmt.Sprintf("%v %v %v", ok, s.Value(key{}), s.Err())`, "true v <nil>"},
		{"interface, single field", `var s Stream = single{ctx()}; _, ok := s.Deadline(); return fmt.Sprintf("%v %v", ok, s.Value(key{}))`, "true v"},
		{"interface, single field pointer", `var s Stream = &single{ctx()}; _, ok := s.Deadline(); return fmt.Sprintf("%v %v", ok, s.Value(key{}))`, "true v"},
		{"direct", `s := &stream{Context: ctx()}; _, ok := s.Deadline(); return fmt.Sprintf("%v %v", ok, s.Value(key{}))`, "true v"},
		{"direct, value", `s := stream{Context: ctx()}; _, ok := s.Deadline(); return fmt.Sprintf("%v %v", ok, s.Value(key{}))`, "true v"},
		{"to native func", `var s Stream = &stream{Context: ctx()}; c, cancel := context.WithCancel(s); defer cancel(); return fmt.Sprint(c.Value(key{}))`, "v"},
		{"to native func, value", `s := stream{Context: ctx()}; c, cancel := context.WithCancel(s); defer cancel(); return fmt.Sprint(c.Value(key{}))`, "v"},
		{"to native func, single field", `var s Stream = single{ctx()}; c, cancel := context.WithCancel(s); defer cancel(); return fmt.Sprint(c.Value(key{}))`, "v"},
		{"read writer", `r := newRW(); r.Write([]byte("out")); p := make([]byte, 2); n, _ := r.Read(p); return r.Name() + " " + b.String() + " " + string(p[:n])`, "rw out in"},
		{"read writer to native func", `io.WriteString(newRW(), "out"); var w io.Writer = newRW(); io.WriteString(w, "!"); return b.String()`, "out!"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, prelude+"func Run() string { "+c.body+" }", c.want)
		})
	}
}

// return f(), f's results converted to the enclosing function's result types.
func TestReturnCallIntoInterfaceResults(t *testing.T) {
	expect(t, `package main

import (
	"errors"
	"fmt"
	"strconv"
)

type T struct{ n int }

func f(fail bool) (*T, error) {
	if fail {
		return nil, errors.New("boom")
	}
	return &T{1}, nil
}

func g(fail bool) (interface{}, error) { return f(fail) }

func h(fail bool) (any, error) { return f(fail) }

type I interface{ M() }

func (*T) M() {}

func k(fail bool) (I, error) { return f(fail) }

func atoi(s string) (any, error) { return strconv.Atoi(s) }

type myErr struct{}

func (*myErr) Error() string { return "mine" }

func mine() (int, *myErr) { return 2, &myErr{} }

func asError() (any, error) { return mine() }

func mine2() (*T, *myErr) { return &T{3}, &myErr{} }

func asError2() (*T, error) { return mine2() }

func Run() string {
	v1, e1 := g(true)
	v2, e2 := h(true)
	v3, e3 := g(false)
	v4, e4 := k(true)
	_, e5 := k(false)
	n, e6 := atoi("x")
	v7, e7 := asError()
	v8, e8 := asError2()
	return fmt.Sprint(v1 == nil, e1, v2 == nil, e2, v3.(*T).n, e3, v4 != nil, e4, e5, n, e6 != nil, v7, e7 != nil, v8.n, e8)
}`, "false boom false boom 1 <nil> true boom <nil> 0 true 2 true 3 mine")
}

// A received value stored in a variable, a result, or a captured variable stays a settable,
// shared variable.
func TestReceiveInto(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"return", `c := make(chan int, 1); c <- 1; return fmt.Sprint(<-c)`, "1"},
		{"return any", `c := make(chan int, 1); c <- 1; return fmt.Sprint(func() any { return <-c }())`, "1"},
		{"return interface", `c := make(chan S, 1); c <- s("x"); return func() S { return <-c }().String()`, "x"},
		{"return error", `c := make(chan error, 1); c <- errors.New("x"); return func() error { return <-c }().Error()`, "x"},
		{"define then increment", `c := make(chan int, 1); c <- 0; x := <-c; x++; return fmt.Sprint(x)`, "1"},
		{"assign then increment", `c := make(chan int, 1); c <- 0; x := 0; x = <-c; x++; return fmt.Sprint(x)`, "1"},
		{"assign then address", `c := make(chan int, 1); c <- 0; x := 0; x = <-c; p := &x; *p = 1; return fmt.Sprint(x)`, "1"},
		{"assign seen by closure", `c := make(chan int, 1); c <- 1; x := 0; f := func() int { return x }; x = <-c; return fmt.Sprint(f())`, "1"},
		{"assign in closure", `c := make(chan error, 1); c <- errors.New("x"); var err error; f := func() { err = <-c }; f(); return fmt.Sprint(err)`, "x"},
		{"assign any in closure", `c := make(chan any, 1); c <- "x"; var v any; f := func() { v = <-c }; f(); return fmt.Sprint(v)`, "x"},
		{"assign interface in closure", `c := make(chan S, 1); c <- s("x"); var v S; f := func() { v = <-c }; f(); return v.String()`, "x"},
		{"assign in goroutine", `c := make(chan string); var v string; w := make(chan bool); go func() { v = <-c; w <- true }(); c <- "x"; <-w; return v`, "x"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, `package main

import (
	"errors"
	"fmt"
)

type S interface{ String() string }

type s string

func (x s) String() string { return string(x) }

var _ = errors.New

func Run() string { `+c.body+` }`, c.want)
		})
	}
}

// A multi-value call in a package-level var declaration, grouped or not, binds each result to its
// variable, which functions declared before or after it share; the callee may be declared later.
func TestVarDeclMultiValue(t *testing.T) {
	const uses = `
func alive() error { stopPolling(); return pollCtx.Err() }

func Run() string {
	before := pollCtx.Err()
	return fmt.Sprintf("%v %v %v %v", before, alive(), a, b)
}
`
	const later = `
func two() (int, string) { return 1, "s" }
`
	for _, c := range []struct{ name, decl string }{
		{"grouped with other vars", "var (\n\tn int\n\tpollCtx, stopPolling = context.WithCancel(context.Background())\n\tm = 2\n\ta, b = two()\n)"},
		{"grouped alone", "var (\n\tpollCtx, stopPolling = context.WithCancel(context.Background())\n)\n\nvar (\n\ta, b = two()\n)"},
		{"ungrouped", "var pollCtx, stopPolling = context.WithCancel(context.Background())\n\nvar a, b = two()"},
		{"after other vars", "var (\n\tmu sync.Mutex\n\tn, m int\n\ts string = \"x\"\n\tpollCtx, stopPolling = context.WithCancel(context.Background())\n\ta, b = two()\n)"},
	} {
		for _, order := range []string{"declaration first", "functions first"} {
			t.Run(c.name+", "+order, func(t *testing.T) {
				src := c.decl + "\n" + uses
				if order == "functions first" {
					src = uses + "\n" + c.decl
				}
				expect(t, "package main\n\nimport (\n\t\"context\"\n\t\"fmt\"\n\t\"sync\"\n)\n\nvar _ sync.Mutex\n\n"+src+later, "<nil> context canceled 1 s")
			})
		}
	}
}

// A composite literal assigned to a variable sets that variable (closures and pointers share it),
// and one evaluated again (in a loop) is a new value each time.
func TestCompositeLiteralStorage(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"address in loop", `var out []*s; for _, n := range []int{1, 2, 3} { out = append(out, &s{n}) }; return fmt.Sprint(out[0].n, out[1].n, out[2].n)`, "1 2 3"},
		{"define in loop", `var out []*s; for _, n := range []int{1, 2, 3} { v := s{n}; out = append(out, &v) }; return fmt.Sprint(out[0].n, out[1].n, out[2].n)`, "1 2 3"},
		{"assign through pointer", `v := s{1}; p := &v; v = s{2}; return fmt.Sprint(p.n)`, "2"},
		{"assign in closure", `var got s; f := func() { got = s{42} }; f(); return fmt.Sprint(got.n)`, "42"},
		{"assign in closure with result", `var got s; f := func() any { got = s{42}; return 7 }; r := f(); return fmt.Sprint(got.n, r)`, "42 7"},
		{"assign in closure via native", `var got s; f := func() { got = s{42} }; var o sync.Once; o.Do(f); return fmt.Sprint(got.n)`, "42"},
		{"slice in closure via native", `var got []int; f := func() { got = []int{42} }; var o sync.Once; o.Do(f); return fmt.Sprint(got)`, "[42]"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport (\n\t\"fmt\"\n\t\"sync\"\n)\n\ntype s struct{ n int }\n\nvar _ sync.Once\n\nfunc Run() string { "+c.body+" }", c.want)
		})
	}
}

// An operator's result returned or assigned into an interface (any, error, an interpreted one).
func TestOperatorIntoInterface(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"return comparison as any", `var n int64 = 1; f := func() any { return n == 1 }; return fmt.Sprint(f())`, "true"},
		{"return not as any", `ok := false; f := func() any { return !ok }; return fmt.Sprint(f())`, "true"},
		{"return negation as any", `n := 1; f := func() any { return -n }; return fmt.Sprint(f())`, "-1"},
		{"return sum as any", `n := 1; f := func() any { return n + 1 }; return fmt.Sprint(f())`, "2"},
		{"return comparison with error", `var n int64 = 1; f := func() (any, error) { return n == 1, nil }; v, _ := f(); return fmt.Sprint(v)`, "true"},
		{"assign not to any", `ok := false; var x any; x = !ok; return fmt.Sprint(x)`, "true"},
		{"assign comparison to any", `var n int64 = 1; var x any; x = n == 1; return fmt.Sprint(x)`, "true"},
		{"named result", `type C float64; c := C(2); f := func() C { return c * 2 }; return fmt.Sprint(f())`, "4"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport \"fmt\"\n\nfunc Run() string { "+c.body+" }", c.want)
		})
	}
}

// A multi-assignment assigns every pair, from sources all read before any destination is set.
func TestMultiAssign(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"call and sum in loop", `trips := [][]string{make([]string, 1000), make([]string, 1000), make([]string, 480)}; largest, total := 0, 0; for _, trip := range trips { largest, total = max(largest, len(trip)), total+len(trip) }; return fmt.Sprint(largest, " ", total)`, "1000 2480"},
		{"sums", `a, t := 0, 0; for i := 0; i < 3; i++ { a, t = a+1, t+i }; return fmt.Sprint(a, " ", t)`, "3 3"},
		{"swap", `a, b := 1, 2; a, b = b, a; return fmt.Sprint(a, " ", b)`, "2 1"},
		{"literal in closure", `var trips []int; seen := false; f := func() { seen, trips = true, []int{1} }; f(); return fmt.Sprint(seen, trips)`, "true [1]"},
		{"literal in goroutine", `var trips []int; seen := false; f := func() { if !seen { seen, trips = true, []int{1} } }; done := make(chan bool); go func() { f(); done <- true }(); <-done; return fmt.Sprint(seen, trips)`, "true [1]"},
		{"define with literal", `x, y := []int{1}, 2; return fmt.Sprint(x, y)`, "[1] 2"},
		{"call reads old value", `a, b := 1, 2; a, b = add(a, b), a; return fmt.Sprint(a, " ", b)`, "3 1"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport \"fmt\"\n\nfunc add(a, b int) int { return a + b }\n\nfunc Run() string { "+c.body+" }", c.want)
		})
	}
}

// A type assertion of a nil interface to a native interface type fails cleanly.
func TestAssertNilInterface(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"field", `var p struct{ R any }; e, ok := p.R.(error); return fmt.Sprint(e, ok)`, "<nil> false"},
		{"if", `var p struct{ R any }; if _, ok := p.R.(error); ok { return "yes" }; return "no"`, "no"},
		{"var", `var r any; e, ok := r.(error); return fmt.Sprint(e, ok)`, "<nil> false"},
		{"call result", `p := struct{ R any }{R: nilfn()}; e, ok := p.R.(error); return fmt.Sprint(e, ok)`, "<nil> false"},
		{"interpreted interface", `var s S; _, ok := s.(fmt.Stringer); return fmt.Sprint(ok)`, "false"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport \"fmt\"\n\ntype S interface{ M() }\n\nfunc nilfn() any { return nil }\n\nfunc Run() string { "+c.body+" }", c.want)
		})
	}
}

// A generic function instantiated explicitly, used as a value or called, with the remaining type
// arguments inferred from constraints (slices.Reverse[[]int] gives E), including over a type of
// another interpreted package.
func TestGenericInstantiationAsValue(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"blank stdlib", `_ = slices.Reverse[[]int]; return "ok"`, "ok"},
		{"blank stdlib, interpreted package type", `_ = slices.Reverse[[]*pb.Msg]; return "ok"`, "ok"},
		{"stdlib value called", `xs := []int{1, 2}; f := slices.Reverse[[]int]; f(xs); return fmt.Sprint(xs)`, "[2 1]"},
		{"stdlib value, interpreted package type", `xs := []*pb.Msg{{Text: "a"}, {Text: "b"}}; f := slices.Reverse[[]*pb.Msg]; f(xs); return xs[0].Text + xs[1].Text`, "ba"},
		{"own, partial", `xs := []int{1, 2}; f := rev[[]int]; f(xs); return fmt.Sprint(xs)`, "[2 1]"},
		{"own, full", `xs := []int{1, 2}; f := rev[[]int, int]; f(xs); return fmt.Sprint(xs)`, "[2 1]"},
		{"own, blank", `_ = rev[[]string]; return "ok"`, "ok"},
		{"own, called", `xs := []int{1, 2}; rev[[]int, int](xs); return fmt.Sprint(xs)`, "[2 1]"},
		{"sort func", `xs := []int{2, 1}; slices.SortFunc(xs, func(a, b int) int { return a - b }); return fmt.Sprint(xs)`, "[1 2]"},
	} {
		t.Run(c.name, func(t *testing.T) {
			i, err := Compile(map[string]string{
				"src/chat/pb/pb.go": "package pb\n\ntype Msg struct{ Text string }\n",
				"src/main/main.go": `package main

import (
	"fmt"
	"slices"

	"chat/pb"
)

var (
	_ = fmt.Sprint
	_ pb.Msg
)

func rev[S ~[]E, E any](s S) {
	for i, j := 0, len(s)-1; i < j; i, j = i+1, j-1 {
		s[i], s[j] = s[j], s[i]
	}
}

func Run() string { ` + c.body + ` }
`})
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			f, err := i.Func("Run")
			if err != nil {
				t.Fatal(err)
			}
			if got := f.Call(nil)[0].String(); got != c.want {
				t.Errorf("Run() = %q, want %q", got, c.want)
			}
		})
	}
}

// A labeled break, continue or return as the last statement of a select case leaves the loop or
// function, not only the select.
func TestJumpOutOfSelect(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"labeled break", `q := make(chan int, 10); q <- 1; q <- 2; batch := make([]int, 0, 100); n := 0
drain:
	for len(batch) < cap(batch) {
		n++
		if n > 1000 { return "looping" }
		select {
		case m := <-q:
			batch = append(batch, m)
		default:
			break drain
		}
	}
	return fmt.Sprint(len(batch), " ", n)`, "2 3"},
		{"labeled continue", `q := make(chan int, 10); q <- 1; n := 0
outer:
	for i := 0; i < 3; i++ {
		select {
		case <-q:
			continue outer
		default:
		}
		n++
	}
	return fmt.Sprint(n)`, "2"},
		{"return", `q := make(chan int, 1); q <- 7; for { select { case v := <-q: return fmt.Sprint(v) } }`, "7"},
		{"unlabeled break leaves the select", `q := make(chan int, 1); q <- 7; n := 0; for i := 0; i < 2; i++ { select { case <-q: break; default: }; n++ }; return fmt.Sprint(n)`, "2"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport \"fmt\"\n\nfunc Run() string {\n\t"+c.body+"\n}", c.want)
		})
	}
}

const errorsPrelude = `package main

import (
	"errors"
	"fmt"
	"log"
	"strings"
)

var (
	_ = log.New
	_ = strings.TrimSpace
)

type myErr struct{ m string }

func (e myErr) Error() string { return "err:" + e.m }

type pErr struct{ m string }

func (e *pErr) Error() string { return "perr:" + e.m }

type wrapErr struct {
	op  string
	err error
}

func (w wrapErr) Error() string { return w.op + ": " + w.err.Error() }
func (w wrapErr) Unwrap() error { return w.err }

type codeErr struct{ code int }

func (c codeErr) Error() string        { return fmt.Sprint("code ", c.code) }
func (c codeErr) Is(target error) bool { t, ok := target.(codeErr); return ok && t.code == c.code }

type named string

func (s named) String() string { return "named:" + string(s) }

type pStr struct{ s string }

func (p *pStr) String() string { return "pstr:" + p.s }

var sentinel = errors.New("sentinel")

var errNF = &pErr{"nf"}

func mk() error   { return &pErr{"a"} }
func get() error  { return errNF }
func getV() error { return myErr{"v"} }

func Run() string { `

// fmt and log print an interpreted error or Stringer through its method, not as a bare struct.
func TestPrintInterpretedErrorsAndStringers(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"error variable", `var e error = myErr{"a"}; return fmt.Sprint(e)`, "err:a"},
		{"pointer error variable", `var e error = &pErr{"a"}; return fmt.Sprint(e)`, "perr:a"},
		{"concrete error", `e := myErr{"a"}; return fmt.Sprint(e)`, "err:a"},
		{"returned error", `return fmt.Sprint(mk())`, "perr:a"},
		{"verbs", `var e error = myErr{"a"}; return fmt.Sprintf("%v|%s", e, e)`, "err:a|err:a"},
		{"Errorf %w", `var e error = &pErr{"a"}; return fmt.Errorf("w: %w", e).Error()`, "w: perr:a"},
		{"Errorf %w of a value error", `return fmt.Errorf("w: %w", myErr{"a"}).Error()`, "w: err:a"},
		{"stringer", `return fmt.Sprintf("%v %s", named("x"), named("y"))`, "named:x named:y"},
		{"pointer stringer", `return fmt.Sprint(&pStr{"z"})`, "pstr:z"},
		{"log", `var b strings.Builder; l := log.New(&b, "", 0); var e error = myErr{"a"}; l.Printf("%v", e); return strings.TrimSpace(b.String())`, "err:a"},
	} {
		t.Run(c.name, func(t *testing.T) { expect(t, errorsPrelude+c.body+" }", c.want) })
	}
}

// errors.Is, errors.As and errors.Unwrap through interpreted errors, wrapped by fmt.Errorf, by
// errors.Join or by an interpreted Unwrap, and interpreted Is methods.
func TestErrorsIsAsInterpreted(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"Is wrapped pointer", `var e error = &pErr{"a"}; w := fmt.Errorf("w: %w", e); return fmt.Sprint(errors.Is(w, e))`, "true"},
		{"Is wrapped value", `w := fmt.Errorf("w: %w", myErr{"a"}); return fmt.Sprint(errors.Is(w, myErr{"a"}), errors.Is(w, myErr{"b"}))`, "true false"},
		{"Is sentinel through returned error", `e := fmt.Errorf("w: %w", get()); return fmt.Sprint(errors.Is(e, errNF))`, "true"},
		{"Is native sentinel", `w := fmt.Errorf("w: %w", sentinel); return fmt.Sprint(errors.Is(w, sentinel))`, "true"},
		{"interpreted Unwrap", `var e error = wrapErr{"op", sentinel}; return fmt.Sprint(errors.Is(e, sentinel), errors.Unwrap(e) == sentinel, e)`, "true true op: sentinel"},
		{"interpreted Is", `var e error = codeErr{4}; return fmt.Sprint(errors.Is(e, codeErr{4}), errors.Is(e, codeErr{5}), errors.Is(fmt.Errorf("w: %w", e), codeErr{4}))`, "true false true"},
		{"As pointer", `w := fmt.Errorf("w: %w", mk()); var t *pErr; ok := errors.As(w, &t); return fmt.Sprint(ok, " ", t.m)`, "true a"},
		{"As value", `w := fmt.Errorf("w: %w", myErr{"a"}); var t myErr; ok := errors.As(w, &t); return fmt.Sprint(ok, " ", t.m)`, "true a"},
		{"As through interpreted Unwrap", `var e error = wrapErr{"op", &pErr{"x"}}; var t *pErr; ok := errors.As(e, &t); return fmt.Sprint(ok, " ", t.m)`, "true x"},
		{"Join", `e := errors.Join(myErr{"a"}, sentinel); var t myErr; return fmt.Sprint(errors.Is(e, sentinel), errors.As(e, &t))`, "true true"},
		{"Is nil", `return fmt.Sprint(errors.Is(nil, sentinel))`, "false"},
	} {
		t.Run(c.name, func(t *testing.T) { expect(t, errorsPrelude+c.body+" }", c.want) })
	}
}

// Type assertions and type switches over an error find its interpreted concrete type.
func TestErrorTypeSwitch(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"assert pointer", `var e error = &pErr{"x"}; p, ok := e.(*pErr); return fmt.Sprint(ok, " ", p.m)`, "true x"},
		{"assert value", `var e error = myErr{"x"}; p, ok := e.(myErr); return fmt.Sprint(ok, " ", p.m)`, "true x"},
		{"switch pointer", `var e error = &pErr{"x"}; switch v := e.(type) { case *pErr: return v.m; case myErr: return "v" }; return "none"`, "x"},
		{"switch returned pointer", `switch v := get().(type) { case *pErr: return v.m }; return "none"`, "nf"},
		{"switch value", `var e error = myErr{"x"}; switch v := e.(type) { case *pErr: return "p"; case myErr: return v.m }; return "none"`, "x"},
		{"switch returned value", `switch v := getV().(type) { case myErr: return v.m }; return "none"`, "v"},
		{"switch without assign", `switch get().(type) { case *pErr: return "p" }; return "none"`, "p"},
		{"switch to interface case", `switch get().(type) { case fmt.Stringer: return "s"; case error: return "e" }; return "none"`, "e"},
	} {
		t.Run(c.name, func(t *testing.T) { expect(t, errorsPrelude+c.body+" }", c.want) })
	}
}

// A comma-ok or multi-value assignment stores into map entries.
func TestMapEntryMultiAssign(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"interpreted call, blank", `m := map[string]string{}; for _, c := range []string{"a", "b"} { m[c], _ = two(c) }; return fmt.Sprint(m)`, "map[a:a b:b]"},
		{"interpreted call, ok", `m := map[string]string{}; var ok bool; m["k"], ok = two("v"); return fmt.Sprint(m, ok)`, "map[k:v] true"},
		{"native call", `m := map[string]int{}; var err error; m["n"], err = strconv.Atoi("7"); return fmt.Sprint(m, err)`, "map[n:7] <nil>"},
		{"native call in closure", `m := map[string]int{}; f := func() { for _, s := range []string{"1", "2"} { m[s], _ = strconv.Atoi(s) } }; f(); return fmt.Sprint(m)`, "map[1:1 2:2]"},
		{"slice element", `s := make([]string, 1); var err error; s[0], err = two2("v"); return fmt.Sprint(s, err)`, "[v] <nil>"},
		{"struct field map", `type T struct{ m map[string]string }; t := T{m: map[string]string{}}; t.m["a"], _ = two("x"); return fmt.Sprint(t.m)`, "map[a:x]"},
		{"map comma ok", `src := map[string]int{"a": 1}; dst := map[string]int{}; var ok bool; dst["a"], ok = src["a"]; return fmt.Sprint(dst, ok)`, "map[a:1] true"},
		{"type assertion", `var x any = "s"; dst := map[string]string{}; var ok bool; dst["a"], ok = x.(string); return fmt.Sprint(dst, ok)`, "map[a:s] true"},
		{"receive", `c := make(chan int, 1); c <- 3; dst := map[string]int{}; var ok bool; dst["a"], ok = <-c; return fmt.Sprint(dst, ok)`, "map[a:3] true"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport (\n\t\"fmt\"\n\t\"strconv\"\n)\n\nvar _ = strconv.Atoi\n\nfunc two(s string) (string, bool) { return s, true }\n\nfunc two2(s string) (string, error) { return s, nil }\n\nfunc Run() string { "+c.body+" }", c.want)
		})
	}
}

// append(s, x) appends x as one element; only append(s, x...) spreads it.
func TestAppendSliceElement(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"[]any into []any", `s := []any{}; s = append(s, []any{1, 2}); return fmt.Sprint(len(s))`, "1"},
		{"[]any spread", `s := []any{}; s = append(s, []any{1, 2}...); return fmt.Sprint(len(s))`, "2"},
		{"ints spread", `s := []int{1}; s = append(s, []int{2, 3}...); return fmt.Sprint(s)`, "[1 2 3]"},
		{"string into bytes", `b := []byte("a"); b = append(b, "bc"...); return string(b)`, "abc"},
		{"slice of slices", `s := [][]int{}; s = append(s, []int{1}); return fmt.Sprint(s)`, "[[1]]"},
		{"native slice spread", `parts := strings.Split("a,b", ","); s := []string{"x"}; s = append(s, parts...); return fmt.Sprint(s)`, "[x a b]"},
		{"named slice spread", `type ids []string; a := ids{"a"}; b := ids{"b"}; a = append(a, b...); return fmt.Sprint(a)`, "[a b]"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport (\n\t\"fmt\"\n\t\"strings\"\n)\n\nvar _ = strings.Split\n\nfunc Run() string { "+c.body+" }", c.want)
		})
	}
}

// range over an integer a call returns, native or interpreted, of any signed size.
func TestRangeOverIntCall(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"native method", `v := reflect.ValueOf(&p{}).Elem(); n := 0; for i := range v.NumField() { n += i + 1 }; return fmt.Sprint(n)`, "3"},
		{"native func", `n := 0; for i := range utf8.RuneCountInString("abc") { n += i }; return fmt.Sprint(n)`, "3"},
		{"interpreted func", `n := 0; for i := range three() { n += i }; return fmt.Sprint(n)`, "3"},
		{"int64", `var m int64 = 3; var s int64; for i := range m { s += i }; return fmt.Sprintf("%v %T", s, s)`, "3 int64"},
		{"literal", `n := 0; for i := range 3 { n += i }; return fmt.Sprint(n)`, "3"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, "package main\n\nimport (\n\t\"fmt\"\n\t\"reflect\"\n\t\"unicode/utf8\"\n)\n\ntype p struct{ a, b int }\n\nfunc three() int { return 3 }\n\nfunc Run() string { "+c.body+" }", c.want)
		})
	}
}

// A builtin call among several returned values sets its own result.
func TestReturnBuiltinAmongResults(t *testing.T) {
	expect(t, `package main

import "fmt"

func f(xs []string) (string, int)   { return xs[1], len(xs) }
func g(xs []string) (string, int)   { return xs[len(xs)-1], len(xs) }
func h(xs []string) (int, int, int) { return 0, len(xs), cap(xs) }

func Run() string {
	xs := []string{"a", "b", "c"}
	a, n := f(xs)
	b, m := g(xs)
	_, l, c := h(xs[:2])
	return fmt.Sprint(a, n, b, m, l, c)
}`, "b3c3 2 3")
}

// A select send case evaluates every operand of the value it sends.
func TestSelectSendOperands(t *testing.T) {
	expect(t, `package main

import "fmt"

type Message struct {
	Topic      string
	Key, Value []byte
}

var queue = make(chan Message, 10)

func put(name string) {
	value := []byte("v-" + name)
	select {
	case queue <- Message{Key: []byte(name), Value: value}:
	default:
	}
}

func Run() string {
	put("a")
	m := <-queue
	c := make(chan int, 1)
	n := 2
	select {
	case c <- n * 3:
	}
	return fmt.Sprintf("%s %s %d", m.Key, m.Value, <-c)
}`, "a v-a 6")
}
