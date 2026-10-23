// Package builtins supplies the Go 1.21 min, max and clear builtins the interpreter lacks: each
// package of a source tree that uses them undeclared gets an injected file (min and max generic over
// the ordered types, clear on Clear, exported to interpreted code by Table).
package builtins

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path"
	"reflect"
	"sort"
	"strings"
	"testing/fstest"
)

// File is the name of the injected file.
const File = "zz_leetbuild_builtins.go"

// ImportKey is the symbol-table key under which Table must be registered with interp.Use.
const ImportKey = "leetbuild/builtins/builtins"

// Inject adds min, max and clear to every package directory of tree that uses them undeclared.
func Inject(tree fstest.MapFS) {
	dirs := map[string]map[string]string{}
	for p, f := range tree {
		if !strings.HasSuffix(p, ".go") {
			continue
		}
		dir := path.Dir(p)
		if dirs[dir] == nil {
			dirs[dir] = map[string]string{}
		}
		dirs[dir][path.Base(p)] = string(f.Data)
	}
	keys := make([]string, 0, len(dirs))
	for d := range dirs {
		keys = append(keys, d)
	}
	sort.Strings(keys)
	for _, dir := range keys {
		pkg, need := missing(dirs[dir])
		if len(need) == 0 || pkg == "" {
			continue
		}
		tree[dir+"/"+File] = &fstest.MapFile{Data: []byte(source(pkg, need))}
	}
}

// Table is the symbol table of the leetbuild/builtins package the injected clear calls.
func Table() map[string]reflect.Value {
	return map[string]reflect.Value{"Clear": reflect.ValueOf(Clear)}
}

// Clear empties a map or zeroes a slice's elements, as the builtin clear does.
func Clear(x any) {
	v := reflect.ValueOf(x)
	switch v.Kind() {
	case reflect.Map, reflect.Slice:
		v.Clear()
	}
}

func source(pkg string, need map[string]bool) string {
	var b strings.Builder
	b.WriteString("package " + pkg + "\n\n")
	if need["clear"] {
		b.WriteString("import lbbuiltins \"leetbuild/builtins\"\n\n")
	}
	if need["min"] || need["max"] {
		b.WriteString("type lbOrdered interface {\n\t~int | ~int8 | ~int16 | ~int32 | ~int64 | ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr | ~float32 | ~float64 | ~string\n}\n\n")
	}
	if need["min"] {
		b.WriteString("func min[T lbOrdered](x T, y ...T) T {\n\tfor _, v := range y {\n\t\tif v < x {\n\t\t\tx = v\n\t\t}\n\t}\n\treturn x\n}\n\n")
	}
	if need["max"] {
		b.WriteString("func max[T lbOrdered](x T, y ...T) T {\n\tfor _, v := range y {\n\t\tif v > x {\n\t\t\tx = v\n\t\t}\n\t}\n\treturn x\n}\n\n")
	}
	if need["clear"] {
		b.WriteString("func clear(x any) { lbbuiltins.Clear(x) }\n")
	}
	return b.String()
}

// missing reports which of min, max, clear a package's files use without declaring them at package
// level, and the package name.
func missing(files map[string]string) (pkg string, need map[string]bool) {
	fset := token.NewFileSet()
	declared := map[string]bool{}
	used := map[string]bool{}
	for name, src := range files {
		f, err := parser.ParseFile(fset, name, src, parser.SkipObjectResolution)
		if err != nil {
			continue // the compiler reports it
		}
		if pkg == "" || !strings.HasSuffix(name, "_test.go") {
			pkg = f.Name.Name
		}
		for _, d := range f.Decls {
			switch decl := d.(type) {
			case *ast.FuncDecl:
				if decl.Recv == nil {
					declared[decl.Name.Name] = true
				}
			case *ast.GenDecl:
				for _, spec := range decl.Specs {
					switch s := spec.(type) {
					case *ast.ValueSpec:
						for _, n := range s.Names {
							declared[n.Name] = true
						}
					case *ast.TypeSpec:
						declared[s.Name.Name] = true
					}
				}
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if id, ok := call.Fun.(*ast.Ident); ok && (id.Name == "min" || id.Name == "max" || id.Name == "clear") {
					used[id.Name] = true
				}
			}
			return true
		})
	}
	need = map[string]bool{}
	for name := range used {
		if !declared[name] {
			need[name] = true
		}
	}
	return pkg, need
}
