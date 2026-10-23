package yaegitest

import (
	"fmt"
	"reflect"
	"testing"
	"testing/fstest"

	"github.com/traefik/yaegi/interp"

	"leetbuild/goruntime/symbols"
)

// nativeTP, nativeOffsets and nativePoints stand in for a model package's native types (a Kafka
// topic-partition keyed offsets map).
type nativeTP struct {
	Topic     string
	Partition int
}

type nativeOffsets map[nativeTP]int64

type nativePoints []nativeTP

// Composite literals with elided types inside native composite types, a map key among them,
// directly or through an alias.
func TestElidedNativeCompositeTypes(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"elided key", `o := nat.Offsets{{Topic: "t", Partition: 0}: 1}; return fmt.Sprint(o)`, "map[{t 0}:1]"},
		{"elided key alias", `o := Offs{{Topic: "t", Partition: 0}: 1}; return fmt.Sprint(o)`, "map[{t 0}:1]"},
		{"explicit key", `o := nat.Offsets{nat.TP{Topic: "t"}: 1}; return fmt.Sprint(o)`, "map[{t 0}:1]"},
		{"elided slice elem", `p := nat.Points{{Topic: "t"}}; return fmt.Sprint(p)`, "[{t 0}]"},
		{"elided map value", `m := map[string]nat.TP{"a": {Topic: "t"}}; return fmt.Sprint(m)`, "map[a:{t 0}]"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fs := fstest.MapFS{"src/main/main.go": &fstest.MapFile{Data: []byte("package main\n\nimport (\"fmt\"; \"nat\")\n\ntype Offs = nat.Offsets\n\nvar _ = fmt.Sprint\n\nfunc Run() string { " + c.body + " }\n")}}
			i := interp.New(interp.Options{GoPath: ".", SourcecodeFilesystem: fs})
			if err := i.Use(symbols.Symbols); err != nil {
				t.Fatal(err)
			}
			if err := i.Use(interp.Exports{"nat/nat": {
				"TP":      reflect.ValueOf((*nativeTP)(nil)),
				"Offsets": reflect.ValueOf((*nativeOffsets)(nil)),
				"Points":  reflect.ValueOf((*nativePoints)(nil)),
			}}); err != nil {
				t.Fatal(err)
			}
			var err error
			func() {
				defer func() {
					if r := recover(); r != nil {
						err = fmt.Errorf("%v", r)
					}
				}()
				err = i.EvalTest("main")
			}()
			if err != nil {
				t.Fatal(err)
			}
			f := i.Symbols("main")["main"]["Run"]
			if got := f.Call(nil)[0].String(); got != c.want {
				t.Errorf("got %q want %q", got, c.want)
			}
		})
	}
}
