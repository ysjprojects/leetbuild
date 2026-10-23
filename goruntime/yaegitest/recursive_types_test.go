package yaegitest

import (
	"reflect"
	"runtime"
	"testing"
)

const recursiveTypes = `package main

import "fmt"

type List struct {
	Val  int
	Next *List
}

type Node struct {
	Val  int
	Next *Node
}

type Tree struct {
	Name     string
	Children []*Tree
	ByName   map[string]*Tree
	Parent   *Tree
}

type Dir struct {
	Name     string
	Children []*Dir
	ByName   map[string]*Dir
	Parent   *Dir
}

type A struct {
	Name string
	B    *B
	Bs   []B
}

type B struct {
	N  int
	A  *A
	As map[string]*A
}

type G struct {
	Vals  []G
	M     map[int]G
	F     func(*G) *G
	Ch    chan *G
}

type Msg struct {
	state  int
	Id     string
	Parts  []*Part
	Parent *Msg
}

type Part struct {
	Id    string
	Owner *Msg
	Sub   []*Part
	Data  []byte
}

func build(n int) string {
	var l *List
	var nd *Node
	root := &Tree{Name: "root", ByName: map[string]*Tree{}}
	droot := &Dir{Name: "root", ByName: map[string]*Dir{}}
	a := &A{Name: "a"}
	g := G{M: map[int]G{}}
	m := &Msg{Id: "m"}
	for i := 0; i < n; i++ {
		l = &List{Val: i, Next: l}
		nd = &Node{Val: i, Next: nd}
		c := &Tree{Name: fmt.Sprint(i), Parent: root, ByName: map[string]*Tree{}}
		root.Children = append(root.Children, c)
		root.ByName[c.Name] = c
		d := &Dir{Name: fmt.Sprint(i), Parent: droot}
		droot.Children = append(droot.Children, d)
		droot.ByName[d.Name] = d
		b := B{N: i, A: a, As: map[string]*A{"x": a}}
		a.Bs = append(a.Bs, b)
		a.B = &b
		g.Vals = append(g.Vals, G{})
		g.M[i] = G{Vals: []G{{}}}
		p := &Part{Id: fmt.Sprint(i), Owner: m, Data: make([]byte, 64)}
		p.Sub = append(p.Sub, &Part{Id: "s", Owner: m})
		m.Parts = append(m.Parts, p)
		m = &Msg{Id: fmt.Sprint(i), Parent: m}
	}
	s := 0
	for x := l; x != nil; x = x.Next {
		s += x.Val
	}
	for x := nd; x != nil; x = x.Next {
		s += x.Val
	}
	for _, c := range root.Children {
		s += len(c.Parent.Children)
	}
	for _, d := range droot.Children {
		s += len(d.Parent.Children)
	}
	for _, b := range a.Bs {
		s += b.N + len(b.A.Bs)
	}
	for x := m; x != nil; x = x.Parent {
		for _, p := range x.Parts {
			s += len(p.Sub) + len(p.Owner.Parts) + len(p.Data)
		}
	}
	return fmt.Sprint(s, len(g.Vals), len(g.M))
}

func Run() string { return build(200) }
`

// Recursive and mutually recursive interpreted struct types, built and walked under constant
// garbage collection, across many interpreters in one process (as the wasm runtime runs checks).
func TestRecursiveTypesUnderGC(t *testing.T) {
	var want string
	for i := 0; i < 30; i++ {
		runtime.GC()
		got := run(t, recursiveTypes)
		if want == "" {
			want = got
		}
		if got != want {
			t.Fatalf("run %d: %s, want %s", i, got, want)
		}
	}
}

// checkLayout fails when a struct type reachable from rt (through pointers, slices, maps, arrays,
// chans and fields) has a field reaching past its end, or when a stand-in for a recursive type (a
// zero-size struct) is still reachable. Type strings are no evidence: reflect computes them when it
// builds a type, before the recursive fields are retyped.
func checkLayout(t *testing.T, rt reflect.Type, seen map[reflect.Type]bool) {
	t.Helper()
	if seen[rt] {
		return
	}
	seen[rt] = true
	switch rt.Kind() {
	case reflect.Ptr, reflect.Slice, reflect.Array, reflect.Chan:
		checkLayout(t, rt.Elem(), seen)
	case reflect.Map:
		checkLayout(t, rt.Key(), seen)
		checkLayout(t, rt.Elem(), seen)
	case reflect.Struct:
		if rt.Size() == 0 {
			t.Errorf("a stand-in for a recursive type is still reachable: %v", rt)
		}
		for i := 0; i < rt.NumField(); i++ {
			f := rt.Field(i)
			if f.Offset+f.Type.Size() > rt.Size() {
				t.Errorf("%v: field %s (%v) ends at %d, past the struct's size %d", rt, f.Name, f.Type, f.Offset+f.Type.Size(), rt.Size())
			}
			checkLayout(t, f.Type, seen)
		}
	}
}

// The reflect types of recursive interpreted structs: every field fits its struct, and none keeps
// the stand-in it had while the recursion was built, whatever the order the types are first needed
// in (a struct holding by value one that holds it through a slice; mutual recursion).
func TestRecursiveTypeLayout(t *testing.T) {
	for name, src := range map[string]string{
		"value then slice":     "type B struct{ As []A; Name string }\ntype A struct{ B B; N int }\n\nvar KeepA []A\nvar KeepB []B\n",
		"slice then value":     "type A struct{ B B; N int }\ntype B struct{ As []A; Name string }\n\nvar KeepA []A\nvar KeepB []B\n",
		"built through a func": "type B struct{ As []A; Name string }\ntype A struct{ B B; N int }\n\nfunc mk() B { return B{} }\n\nvar KeepB []B\nvar KeepA []A\n",
		"array by value":       "type T struct{ Kids [2]U }\ntype U struct{ Up *T; N int }\n\nvar KeepA []T\nvar KeepB []U\n",
		"mutual pointers":      "type Msg struct{ Id string; Parts []*Part; Parent *Msg }\ntype Part struct{ Id string; Owner *Msg; Sub []*Part; Data []byte }\n\nvar KeepA []Msg\nvar KeepB []Part\n",
		"maps and funcs":       "type G struct{ Vals []G; M map[int]G; F func(*G) *G; Ch chan *H }\ntype H struct{ G G; Hs map[string]*H }\n\nvar KeepA []G\nvar KeepB []H\n",
	} {
		t.Run(name, func(t *testing.T) {
			i, err := Compile(map[string]string{"src/main/main.go": "package main\n\n" + src})
			if err != nil {
				t.Fatal(err)
			}
			seen := map[reflect.Type]bool{}
			for _, v := range []string{"KeepA", "KeepB"} {
				checkLayout(t, i.Symbols("main")["main"][v].Type(), seen)
			}
		})
	}
}
