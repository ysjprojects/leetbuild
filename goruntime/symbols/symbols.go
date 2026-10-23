// Package symbols holds the yaegi symbol tables the interpreter resolves imports with: generated
// tables (gen_*.go, by cmd/gensyms) and the hand-written ones for packages whose exported API is
// platform-specific (os, syscall).
package symbols

import "reflect"

// Symbols maps "<import path>/<package name>" to that package's exported values and types.
var Symbols = map[string]map[string]reflect.Value{}
