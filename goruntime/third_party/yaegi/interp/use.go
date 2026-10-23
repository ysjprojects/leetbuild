package interp

import (
	"errors"
	"flag"
	"fmt"
	"go/constant"
	"log"
	"math/bits"
	"os"
	"path"
	"reflect"
	"strings"

	gen "github.com/traefik/yaegi/stdlib/generic"
)

// Symbols returns a map of interpreter exported symbol values for the given
// import path. If the argument is the empty string, all known symbols are
// returned.
func (interp *Interpreter) Symbols(importPath string) Exports {
	m := map[string]map[string]reflect.Value{}
	interp.mutex.RLock()
	defer interp.mutex.RUnlock()

	for k, v := range interp.srcPkg {
		if importPath != "" && k != importPath {
			continue
		}
		syms := map[string]reflect.Value{}
		for n, s := range v {
			if !canExport(n) {
				// Skip private non-exported symbols.
				continue
			}
			switch s.kind {
			case constSym:
				syms[n] = s.rval
			case funcSym:
				syms[n] = genFunctionWrapper(s.node)(interp.frame)
			case varSym:
				syms[n] = interp.frame.data[s.index]
			case typeSym:
				syms[n] = reflect.New(s.typ.TypeOf())
			}
		}

		if len(syms) > 0 {
			m[k] = syms
		}

		if importPath != "" {
			return m
		}
	}

	if importPath != "" && len(m) > 0 {
		return m
	}

	for k, v := range interp.binPkg {
		if importPath != "" && k != importPath {
			continue
		}
		m[k] = v
		if importPath != "" {
			return m
		}
	}

	return m
}

// getWrapper returns the wrapper type of the corresponding interface, trying
// first the composed ones, or nil if not found.
func getWrapper(n *node, t reflect.Type) reflect.Type {
	w := n.interp.binPkg[t.PkgPath()]["_"+t.Name()]
	if !w.IsValid() {
		// LeetBuild: a table registered under another import path than its types' package (a
		// model standing in for a library) holds its wrappers under that import path.
		w = n.interp.binPkg[n.interp.nativePkg[t.PkgPath()]]["_"+t.Name()]
	}
	if !w.IsValid() {
		panic(n.cfgErrorf("an interpreted value cannot stand in for %s here: the runtime has no wrapper for it", t))
	}
	lm := n.typ.methods()

	// mapTypes may contain composed interfaces wrappers to test against, from
	// most complex to simplest (guaranteed by construction of mapTypes). Find the
	// first for which the interpreter type has all the methods.
	for _, rt := range n.interp.mapTypes[w] {
		match := true
		for i := 1; i < rt.NumField(); i++ {
			// The interpreter type must have all required wrapper methods.
			if _, ok := lm[rt.Field(i).Name[1:]]; !ok {
				match = false
				break
			}
		}
		if match {
			return rt
		}
	}

	// Otherwise return the direct "non-composed" interface.
	return w.Type().Elem()
}

// Use loads binary runtime symbols in the interpreter context so
// they can be used in interpreted code.
func (interp *Interpreter) Use(values Exports) error {
	for k, v := range values {
		importPath := path.Dir(k)
		packageName := path.Base(k)

		if k == "." && v["MapTypes"].IsValid() {
			// Use mapping for special interface wrappers.
			for kk, vv := range v["MapTypes"].Interface().(map[reflect.Value][]reflect.Type) {
				interp.mapTypes[kk] = vv
			}
			continue
		}

		if importPath == "." {
			return fmt.Errorf("export path %[1]q is missing a package name; did you mean '%[1]s/%[1]s'?", k)
		}

		if importPath == selfPrefix {
			interp.hooks.Parse(v)
			continue
		}

		if interp.binPkg[importPath] == nil {
			interp.binPkg[importPath] = make(map[string]reflect.Value)
			interp.pkgNames[importPath] = packageName
		}

		for s, sym := range v {
			interp.binPkg[importPath][s] = sym
			// LeetBuild: index the table by the package path of its types (the generated
			// wrappers, named "_…", live in the symbols package), for getWrapper.
			if !strings.HasPrefix(s, "_") && sym.Kind() == reflect.Ptr && sym.IsNil() {
				if native := sym.Type().Elem().PkgPath(); native != "" && native != importPath {
					interp.nativePkg[native] = importPath
				}
			}
		}
		if k == selfPath {
			interp.binPkg[importPath]["Self"] = reflect.ValueOf(interp)
		}
	}

	// Checks if input values correspond to stdlib packages by looking for one
	// well known stdlib package path.
	if _, ok := values["fmt/fmt"]; ok {
		fixStdlib(interp)

		// Load stdlib generic source.
		for _, s := range gen.Sources {
			if _, err := interp.Compile(s); err != nil {
				return err
			}
		}
	}
	interp.mapPrintTypes()
	return nil
}

// printTypes are the interfaces fmt and log look for in their operands, most specific first.
var printTypes = []reflect.Type{
	reflect.TypeOf((*fmt.Formatter)(nil)).Elem(),
	reflect.TypeOf((*error)(nil)).Elem(),
	reflect.TypeOf((*fmt.Stringer)(nil)).Elem(),
}

// mapPrintTypes maps the print functions of fmt and log, as currently loaded (an override table
// replaces them), to printTypes (LeetBuild): callBin then wraps an interpreted operand that has
// Error, String or Format, which fmt otherwise prints as a bare struct. The extracted symbol
// tables carry no MapTypes.
func (interp *Interpreter) mapPrintTypes() {
	for pkg, names := range map[string][]string{
		"fmt": {"Append", "Appendf", "Appendln", "Errorf", "Fprint", "Fprintf", "Fprintln", "Print", "Printf", "Println", "Sprint", "Sprintf", "Sprintln"},
		"log": {"Fatal", "Fatalf", "Fatalln", "Panic", "Panicf", "Panicln", "Print", "Printf", "Println"},
	} {
		p := interp.binPkg[pkg]
		for _, name := range names {
			if v, ok := p[name]; ok && v.Kind() == reflect.Func && interp.mapTypes[v] == nil {
				interp.mapTypes[v] = printTypes
			}
		}
	}
}

// fixStdlib redefines interpreter stdlib symbols to use the standard input,
// output and errror assigned to the interpreter. The changes are limited to
// the interpreter only.
// Note that it is possible to escape the virtualized stdio by
// read/write directly to file descriptors 0, 1, 2.
func fixStdlib(interp *Interpreter) {
	p := interp.binPkg["fmt"]
	if p == nil {
		return
	}

	stdin, stdout, stderr := interp.stdin, interp.stdout, interp.stderr

	p["Print"] = reflect.ValueOf(func(a ...interface{}) (n int, err error) { return fmt.Fprint(stdout, a...) })
	p["Printf"] = reflect.ValueOf(func(f string, a ...interface{}) (n int, err error) { return fmt.Fprintf(stdout, f, a...) })
	p["Println"] = reflect.ValueOf(func(a ...interface{}) (n int, err error) { return fmt.Fprintln(stdout, a...) })

	p["Scan"] = reflect.ValueOf(func(a ...interface{}) (n int, err error) { return fmt.Fscan(stdin, a...) })
	p["Scanf"] = reflect.ValueOf(func(f string, a ...interface{}) (n int, err error) { return fmt.Fscanf(stdin, f, a...) })
	p["Scanln"] = reflect.ValueOf(func(a ...interface{}) (n int, err error) { return fmt.Fscanln(stdin, a...) })

	// Update mapTypes to virtualized symbols as well.
	interp.mapTypes[p["Print"]] = interp.mapTypes[reflect.ValueOf(fmt.Print)]
	interp.mapTypes[p["Printf"]] = interp.mapTypes[reflect.ValueOf(fmt.Printf)]
	interp.mapTypes[p["Println"]] = interp.mapTypes[reflect.ValueOf(fmt.Println)]
	interp.mapTypes[p["Scan"]] = interp.mapTypes[reflect.ValueOf(fmt.Scan)]
	interp.mapTypes[p["Scanf"]] = interp.mapTypes[reflect.ValueOf(fmt.Scanf)]
	interp.mapTypes[p["Scanln"]] = interp.mapTypes[reflect.ValueOf(fmt.Scanln)]

	if p = interp.binPkg["flag"]; p != nil {
		c := flag.NewFlagSet(os.Args[0], flag.PanicOnError)
		c.SetOutput(stderr)
		p["CommandLine"] = reflect.ValueOf(&c).Elem()
	}

	if p = interp.binPkg["log"]; p != nil {
		l := log.New(stderr, "", log.LstdFlags)
		// Restrict Fatal symbols to panic instead of exit.
		p["Fatal"] = reflect.ValueOf(l.Panic)
		p["Fatalf"] = reflect.ValueOf(l.Panicf)
		p["Fatalln"] = reflect.ValueOf(l.Panicln)

		p["Flags"] = reflect.ValueOf(l.Flags)
		p["Output"] = reflect.ValueOf(l.Output)
		p["Panic"] = reflect.ValueOf(l.Panic)
		p["Panicf"] = reflect.ValueOf(l.Panicf)
		p["Panicln"] = reflect.ValueOf(l.Panicln)
		p["Prefix"] = reflect.ValueOf(l.Prefix)
		p["Print"] = reflect.ValueOf(l.Print)
		p["Printf"] = reflect.ValueOf(l.Printf)
		p["Println"] = reflect.ValueOf(l.Println)
		p["SetFlags"] = reflect.ValueOf(l.SetFlags)
		p["SetOutput"] = reflect.ValueOf(l.SetOutput)
		p["SetPrefix"] = reflect.ValueOf(l.SetPrefix)
		p["Writer"] = reflect.ValueOf(l.Writer)

		// Update mapTypes to virtualized symbols as well.
		interp.mapTypes[p["Print"]] = interp.mapTypes[reflect.ValueOf(log.Print)]
		interp.mapTypes[p["Printf"]] = interp.mapTypes[reflect.ValueOf(log.Printf)]
		interp.mapTypes[p["Println"]] = interp.mapTypes[reflect.ValueOf(log.Println)]
		interp.mapTypes[p["Panic"]] = interp.mapTypes[reflect.ValueOf(log.Panic)]
		interp.mapTypes[p["Panicf"]] = interp.mapTypes[reflect.ValueOf(log.Panicf)]
		interp.mapTypes[p["Panicln"]] = interp.mapTypes[reflect.ValueOf(log.Panicln)]
	}

	if p = interp.binPkg["os"]; p != nil {
		p["Args"] = reflect.ValueOf(&interp.args).Elem()
		if interp.specialStdio {
			// Inherit streams from interpreter even if they do not have a file descriptor.
			p["Stdin"] = reflect.ValueOf(&stdin).Elem()
			p["Stdout"] = reflect.ValueOf(&stdout).Elem()
			p["Stderr"] = reflect.ValueOf(&stderr).Elem()
		} else {
			// Inherits streams from interpreter only if they have a file descriptor and preserve original type.
			if s, ok := stdin.(*os.File); ok {
				p["Stdin"] = reflect.ValueOf(&s).Elem()
			}
			if s, ok := stdout.(*os.File); ok {
				p["Stdout"] = reflect.ValueOf(&s).Elem()
			}
			if s, ok := stderr.(*os.File); ok {
				p["Stderr"] = reflect.ValueOf(&s).Elem()
			}
		}
		if !interp.unrestricted {
			// In restricted mode, scripts can only access to a passed virtualized env, and can not write the real one.
			getenv := func(key string) string { return interp.env[key] }
			p["Clearenv"] = reflect.ValueOf(func() { interp.env = map[string]string{} })
			p["ExpandEnv"] = reflect.ValueOf(func(s string) string { return os.Expand(s, getenv) })
			p["Getenv"] = reflect.ValueOf(getenv)
			p["LookupEnv"] = reflect.ValueOf(func(key string) (s string, ok bool) { s, ok = interp.env[key]; return })
			p["Setenv"] = reflect.ValueOf(func(key, value string) error { interp.env[key] = value; return nil })
			p["Unsetenv"] = reflect.ValueOf(func(key string) error { delete(interp.env, key); return nil })
			p["Environ"] = reflect.ValueOf(func() (a []string) {
				for k, v := range interp.env {
					a = append(a, k+"="+v)
				}
				return
			})
		}
	}

	if p = interp.binPkg["math/bits"]; p != nil {
		// Do not trust extracted value maybe from another arch.
		p["UintSize"] = reflect.ValueOf(constant.MakeInt64(bits.UintSize))
	}

	if p = interp.binPkg["errors"]; p != nil {
		p["As"] = reflect.ValueOf(errorsAs) // LeetBuild
	}
}

// errorsAs is errors.As that also finds an interpreted error type (LeetBuild): its reflect type
// has no Error method, so errors.As rejected the target, and the chain holds _error wrappers of
// the interpreted values.
func errorsAs(err error, target any) bool {
	if t, ok := target.(asTarget); ok {
		return walkErrors(err, t.match)
	}
	tv := reflect.ValueOf(target)
	if target == nil || tv.Kind() != reflect.Ptr || tv.IsNil() {
		panic("errors: target must be a non-nil pointer")
	}
	et := tv.Type().Elem()
	if et.Kind() == reflect.Interface || et.Implements(printTypes[1]) { // printTypes[1] is error
		return errors.As(err, target)
	}
	return walkErrors(err, func(err error) bool {
		if iv, ok := wrappedError(err); ok {
			if v := reflect.ValueOf(iv); v.Type().AssignableTo(et) {
				tv.Elem().Set(v)
				return true
			}
		}
		x, ok := err.(interface{ As(any) bool })
		return ok && x.As(target)
	})
}

// asTarget is the target of errors.As when it points to an interpreted interface (LeetBuild):
// callBin passes it so errorsAs knows the interface, which the reflect type does not carry.
type asTarget struct {
	ptr    reflect.Value // the *valueInterface target
	iface  *itype
	interp *Interpreter
}

// match stores err's interpreted value in the target when its type implements the interface.
func (t asTarget) match(err error) bool {
	iv, ok := wrappedError(err)
	if !ok {
		return false
	}
	v := reflect.ValueOf(iv)
	dn, ok := t.interp.errNodes.Load(v.Type())
	if !ok || !dn.(*node).typ.implements(t.iface) {
		return false
	}
	t.ptr.Elem().Set(reflect.ValueOf(valueInterface{dn.(*node), v}))
	return true
}

// walkErrors calls match on err and the errors it wraps, depth first, until match is true.
func walkErrors(err error, match func(error) bool) bool {
	for err != nil {
		if match(err) {
			return true
		}
		switch u := err.(type) {
		case interface{ Unwrap() error }:
			err = u.Unwrap()
		case interface{ Unwrap() []error }:
			for _, e := range u.Unwrap() {
				if walkErrors(e, match) {
					return true
				}
			}
			return false
		default:
			return false
		}
	}
	return false
}
