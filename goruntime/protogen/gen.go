// Package protogen generates Go from the course's .proto files, shaped like protoc-gen-go plus
// protoc-gen-go-grpc output (structs with getters, enums, oneof wrappers, XClient/NewXClient,
// XServer/UnimplementedXServer/RegisterXServer, X_ServiceDesc, the classic named stream
// interfaces), but plain Go the interpreter runs: messages are structs of exported fields with
// protoc-gen-go's `protobuf` tags (leetbuild/goruntime's proto, protojson and grpc models work from
// those tags), with no protoimpl state and no unsafe.
//
// Two departures from protoc's output, both forced by the interpreter: RegisterXServer registers a
// copy of X_ServiceDesc whose handlers are closures over the implementation (an interpreted value
// handed to native code loses its methods, so `srv.(XServer)` would fail there), and init registers
// enum names and oneof wrappers with the proto model (native code cannot ask interpreted types).
package protogen

import (
	"bytes"
	"fmt"
	"go/format"
	"path"
	"sort"
	"strings"
)

// Generate compiles proto sources (file name → source, e.g. "chat.proto") into Go files, keyed by
// path under src/ ("src/chat/gen/chat/chat.pb.go", "…/chat_grpc.pb.go"). importPaths maps a file's
// stem ("chat") to its Go import path ("chat/gen/chat"); a file absent from it uses its go_package
// option.
func Generate(files map[string]string, importPaths map[string]string) (map[string]string, error) {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	parsed := map[string]*protoFile{}
	var all []*protoFile
	for _, name := range names {
		f, err := parseFile(name, files[name])
		if err != nil {
			return nil, err
		}
		parsed[name] = f
		all = append(all, f)
	}
	for _, f := range all {
		for _, imp := range f.imports {
			if parsed[imp] == nil && parsed[path.Base(imp)] == nil {
				return nil, fmt.Errorf("%s: import %q is not among the files given", f.name, imp)
			}
		}
		stem := strings.TrimSuffix(f.name, ".proto")
		ip, ok := importPaths[stem]
		if !ok {
			ip, ok = importPaths[path.Base(stem)]
		}
		goPkgPath, goPkgName, _ := strings.Cut(f.goPackage, ";")
		if !ok {
			ip = goPkgPath
		}
		if ip == "" {
			return nil, fmt.Errorf("%s: no Go import path (give importPaths[%q] or option go_package)", f.name, stem)
		}
		f.importPath = ip
		switch {
		case goPkgName != "":
			f.goName = goPkgName
		case goPkgPath != "":
			f.goName = sanitize(path.Base(goPkgPath))
		case f.pkg != "":
			f.goName = sanitize(strings.ReplaceAll(f.pkg, ".", ""))
		default:
			f.goName = sanitize(path.Base(stem))
		}
	}
	// One Go package per import path: its files must agree on the package name.
	byPath := map[string]string{}
	for _, f := range all {
		if prev, ok := byPath[f.importPath]; ok && prev != f.goName {
			return nil, fmt.Errorf("%s: Go package %s conflicts with %s in %s", f.name, f.goName, prev, f.importPath)
		}
		byPath[f.importPath] = f.goName
	}
	types := map[string]any{} // full name → *message | *enum
	for _, f := range all {
		for _, m := range f.messages {
			types[m.full] = m
		}
		for _, e := range f.enums {
			types[e.full] = e
		}
	}
	for _, f := range all {
		if err := resolveFile(f, types); err != nil {
			return nil, err
		}
	}
	out := map[string]string{}
	for _, f := range all {
		stem := path.Base(strings.TrimSuffix(f.name, ".proto"))
		dir := "src/" + f.importPath + "/"
		src, err := genMessages(f)
		if err != nil {
			return nil, err
		}
		out[dir+stem+".pb.go"] = src
		if len(f.services) > 0 {
			src, err := genServices(f)
			if err != nil {
				return nil, err
			}
			out[dir+stem+"_grpc.pb.go"] = src
		}
	}
	return out, nil
}

func sanitize(s string) string {
	var b strings.Builder
	for i, c := range s {
		switch {
		case c == '_' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || i > 0 && '0' <= c && c <= '9':
			b.WriteRune(c)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// ---- resolution and names ------------------------------------------------------------------------

var scalars = map[string]string{
	"double": "float64", "float": "float32",
	"int32": "int32", "int64": "int64", "uint32": "uint32", "uint64": "uint64",
	"sint32": "int32", "sint64": "int64", "fixed32": "uint32", "fixed64": "uint64",
	"sfixed32": "int32", "sfixed64": "int64", "bool": "bool", "string": "string", "bytes": "[]byte",
}

var wireTypes = map[string]string{
	"double": "fixed64", "float": "fixed32",
	"int32": "varint", "int64": "varint", "uint32": "varint", "uint64": "varint",
	"sint32": "zigzag32", "sint64": "zigzag64", "fixed32": "fixed32", "fixed64": "fixed64",
	"sfixed32": "fixed32", "sfixed64": "fixed64", "bool": "varint", "string": "bytes", "bytes": "bytes",
}

// resolveName finds a type reference from scope ("pkg.Outer"), innermost scope first.
func resolveName(types map[string]any, name, scope string) any {
	if strings.HasPrefix(name, ".") {
		return types[name[1:]]
	}
	for s := scope; ; {
		cand := name
		if s != "" {
			cand = s + "." + name
		}
		if t, ok := types[cand]; ok {
			return t
		}
		if s == "" {
			return nil
		}
		if i := strings.LastIndex(s, "."); i >= 0 {
			s = s[:i]
		} else {
			s = ""
		}
	}
}

func resolveFile(f *protoFile, types map[string]any) error {
	for _, e := range f.enums {
		e.goName = GoCamelCase(e.rel)
	}
	for _, m := range f.messages {
		m.goName = GoCamelCase(m.rel)
	}
	for _, m := range f.messages {
		used := map[string]bool{"Reset": true, "String": true, "ProtoMessage": true, "ProtoReflect": true, "Descriptor": true}
		for _, o := range m.oneofs {
			o.goName = GoCamelCase(o.name)
			for used[o.goName] {
				o.goName += "_"
			}
			used[o.goName] = true
		}
		for _, fd := range m.fields {
			fd.goName = GoCamelCase(fd.name)
			for used[fd.goName] || used["Get"+fd.goName] {
				fd.goName += "_"
			}
			used[fd.goName] = true
			if fd.mapKey != "" {
				if _, ok := scalars[fd.mapKey]; !ok || fd.mapKey == "double" || fd.mapKey == "float" || fd.mapKey == "bytes" {
					return fmt.Errorf("%s: map key type %s of %s.%s is not allowed", f.name, fd.mapKey, m.full, fd.name)
				}
			}
			if _, ok := scalars[fd.typ]; ok {
				continue
			}
			switch t := resolveName(types, fd.typ, m.full).(type) {
			case *message:
				if fd.mapKey != "" {
					fd.valMsg = t
				} else {
					fd.msg = t
				}
			case *enum:
				if fd.mapKey != "" {
					fd.valEn = t
				} else {
					fd.enum = t
				}
			default:
				if strings.HasPrefix(strings.TrimPrefix(fd.typ, "."), "google.protobuf.") {
					return fmt.Errorf("%s: %s.%s uses the well-known type %s, which is not supported", f.name, m.full, fd.name, fd.typ)
				}
				return fmt.Errorf("%s: unknown type %s in %s.%s", f.name, fd.typ, m.full, fd.name)
			}
		}
	}
	for _, s := range f.services {
		scope := f.pkg
		for _, md := range s.methods {
			in, ok := resolveName(types, md.input, scope).(*message)
			if !ok {
				return fmt.Errorf("%s: %s.%s: unknown message %s", f.name, s.name, md.name, md.input)
			}
			out, ok := resolveName(types, md.output, scope).(*message)
			if !ok {
				return fmt.Errorf("%s: %s.%s: unknown message %s", f.name, s.name, md.name, md.output)
			}
			md.in, md.out = in, out
		}
	}
	return nil
}

// GoCamelCase is protoc-gen-go's name mangling: "page_size" → "PageSize", "Outer.inner" → "Outer_Inner".
func GoCamelCase(s string) string {
	var b []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '.' && i+1 < len(s) && isASCIILower(s[i+1]):
			// skip '.' in ".{{lowercase}}"
		case c == '.':
			b = append(b, '_')
		case c == '_' && (i == 0 || s[i-1] == '.'):
			b = append(b, 'X')
		case c == '_' && i+1 < len(s) && isASCIILower(s[i+1]):
			// skip '_' in "_{{lowercase}}"
		case isDigit(c):
			b = append(b, c)
		default:
			if isASCIILower(c) {
				c -= 'a' - 'A'
			}
			b = append(b, c)
			for ; i+1 < len(s) && isASCIILower(s[i+1]); i++ {
				b = append(b, s[i+1])
			}
		}
	}
	return string(b)
}

func isASCIILower(c byte) bool { return 'a' <= c && c <= 'z' }

// jsonName is protoc's JSON name.
func jsonName(name string) string {
	var b strings.Builder
	upper := false
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c == '_' {
			upper = true
			continue
		}
		if upper && isASCIILower(c) {
			c -= 'a' - 'A'
		}
		upper = false
		b.WriteByte(c)
	}
	return b.String()
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// ---- code ----------------------------------------------------------------------------------------

// gen writes one file: the body is generated first, the imports it used are added after.
type gen struct {
	f       *protoFile
	body    bytes.Buffer
	imports map[string]string // path → alias
}

func newGen(f *protoFile) *gen { return &gen{f: f, imports: map[string]string{}} }

func (g *gen) p(format string, args ...any) {
	fmt.Fprintf(&g.body, format, args...)
	g.body.WriteByte('\n')
}

func (g *gen) use(path, alias string) string {
	g.imports[path] = alias
	return alias
}

// qual is the Go name of a type from this file's package, qualified when it lives elsewhere.
func (g *gen) qual(f *protoFile, goName string) string {
	if f.importPath == g.f.importPath {
		return goName
	}
	alias := sanitize(f.goName) + "_" + sanitize(path.Base(strings.TrimSuffix(f.name, ".proto")))
	return g.use(f.importPath, alias) + "." + goName
}

func (g *gen) msgType(m *message) string { return g.qual(m.file, m.goName) }
func (g *gen) enumType(e *enum) string   { return g.qual(e.file, e.goName) }

func (g *gen) finish(header string) (string, error) {
	var out bytes.Buffer
	out.WriteString(header)
	fmt.Fprintf(&out, "package %s\n\n", g.f.goName)
	if len(g.imports) > 0 {
		paths := make([]string, 0, len(g.imports))
		for p := range g.imports {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		out.WriteString("import (\n")
		for _, p := range paths {
			fmt.Fprintf(&out, "\t%s %q\n", g.imports[p], p)
		}
		out.WriteString(")\n\n")
	}
	out.Write(g.body.Bytes())
	src, err := format.Source(out.Bytes())
	if err != nil {
		return "", fmt.Errorf("protogen: %s: generated code does not parse: %w\n%s", g.f.name, err, out.String())
	}
	return string(src), nil
}

func header(f *protoFile) string {
	return fmt.Sprintf("// Code generated by leetbuild protogen from %s. DO NOT EDIT.\n// source: %s\n\n", f.name, f.name)
}

// goType is a field's Go type (one value for repeated and map values).
func (g *gen) valueType(typ string, m *message, e *enum) string {
	switch {
	case m != nil:
		return "*" + g.msgType(m)
	case e != nil:
		return g.enumType(e)
	}
	return scalars[typ]
}

func (g *gen) fieldType(fd *field) string {
	switch {
	case fd.mapKey != "":
		return "map[" + scalars[fd.mapKey] + "]" + g.valueType(fd.typ, fd.valMsg, fd.valEn)
	case fd.repeated:
		return "[]" + g.valueType(fd.typ, fd.msg, fd.enum)
	case fd.optional && fd.msg == nil:
		return "*" + g.valueType(fd.typ, fd.msg, fd.enum)
	}
	return g.valueType(fd.typ, fd.msg, fd.enum)
}

// tag is a field's protobuf struct tag body.
func protoTag(typ string, number int, label, name string, msg *message, en *enum, extra string) string {
	wire := wireTypes[typ]
	if msg != nil {
		wire = "bytes"
	}
	if en != nil {
		wire = "varint"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s,%d,%s,", wire, number, label)
	if label == "rep" && msg == nil && wire != "bytes" {
		b.WriteString("packed,")
	}
	fmt.Fprintf(&b, "name=%s,", name)
	if j := jsonName(name); j != name {
		fmt.Fprintf(&b, "json=%s,", j)
	}
	b.WriteString("proto3")
	if en != nil {
		fmt.Fprintf(&b, ",enum=%s", enumTagName(en))
	}
	b.WriteString(extra)
	return b.String()
}

func (g *gen) fieldTag(fd *field) string {
	switch {
	case fd.mapKey != "":
		key := protoTag(fd.mapKey, 1, "opt", "key", nil, nil, "")
		val := protoTag(fd.typ, 2, "opt", "value", fd.valMsg, fd.valEn, "")
		return fmt.Sprintf("`protobuf:\"bytes,%d,rep,name=%s,proto3\" json:\"%s,omitempty\" protobuf_key:\"%s\" protobuf_val:\"%s\"`",
			fd.number, fd.name, fd.name, key, val)
	case fd.repeated:
		return fmt.Sprintf("`protobuf:\"%s\" json:\"%s,omitempty\"`", protoTag(fd.typ, fd.number, "rep", fd.name, fd.msg, fd.enum, ""), fd.name)
	case fd.optional:
		return fmt.Sprintf("`protobuf:\"%s\" json:\"%s,omitempty\"`", protoTag(fd.typ, fd.number, "opt", fd.name, fd.msg, fd.enum, ",oneof"), fd.name)
	}
	return fmt.Sprintf("`protobuf:\"%s\" json:\"%s,omitempty\"`", protoTag(fd.typ, fd.number, "opt", fd.name, fd.msg, fd.enum, ""), fd.name)
}

// zero is the getter's default for a field.
func (g *gen) zero(fd *field) string {
	switch {
	case fd.mapKey != "", fd.repeated, fd.msg != nil:
		return "nil"
	case fd.enum != nil:
		return g.qual(fd.enum.file, enumValueName(fd.enum, fd.enum.values[0].name))
	}
	switch scalars[fd.typ] {
	case "bool":
		return "false"
	case "string":
		return `""`
	case "[]byte":
		return "nil"
	}
	return "0"
}

// enumValueName is protoc-gen-go's constant name: Enum_VALUE at top level, Parent_VALUE nested.
func enumValueName(e *enum, value string) string {
	if e.parent != nil {
		return e.parent.goName + "_" + value
	}
	return e.goName + "_" + value
}

// enumTagName is how protoc-gen-go names an enum in a field tag: "pkg.Outer_Inner".
func enumTagName(e *enum) string {
	name := strings.ReplaceAll(e.rel, ".", "_")
	if e.file.pkg != "" {
		return e.file.pkg + "." + name
	}
	return name
}

// wrapperName is the Go type of a oneof member's wrapper.
func wrapperName(m *message, fd *field) string {
	name := m.goName + "_" + fd.goName
	for m.nested[strings.TrimPrefix(name, m.goName+"_")] || nestedGoName(m, name) {
		name += "_"
	}
	return name
}

func nestedGoName(m *message, goName string) bool {
	for _, n := range m.file.messages {
		if n.goName == goName {
			return true
		}
	}
	for _, e := range m.file.enums {
		if e.goName == goName {
			return true
		}
	}
	return false
}

func genMessages(f *protoFile) (string, error) {
	g := newGen(f)
	var inits []string
	for _, e := range f.enums {
		g.p("type %s int32", e.goName)
		g.p("")
		g.p("const (")
		for _, v := range e.values {
			g.p("\t%s %s = %d", enumValueName(e, v.name), e.goName, v.number)
		}
		g.p(")")
		g.p("")
		g.p("// Enum value maps for %s.", e.goName)
		g.p("var (")
		g.p("\t%s_name = map[int32]string{", e.goName)
		seen := map[int]bool{}
		for _, v := range e.values {
			if !seen[v.number] {
				seen[v.number] = true
				g.p("\t\t%d: %q,", v.number, v.name)
			}
		}
		g.p("\t}")
		g.p("\t%s_value = map[string]int32{", e.goName)
		for _, v := range e.values {
			g.p("\t\t%q: %d,", v.name, v.number)
		}
		g.p("\t}")
		g.p(")")
		g.p("")
		g.p("func (x %s) Enum() *%s {", e.goName, e.goName)
		g.p("\tp := new(%s)", e.goName)
		g.p("\t*p = x")
		g.p("\treturn p")
		g.p("}")
		g.p("")
		g.p("func (x %s) String() string {", e.goName)
		g.p("\tif name, ok := %s_name[int32(x)]; ok {", e.goName)
		g.p("\t\treturn name")
		g.p("\t}")
		g.p("\treturn %s.Itoa(int(x))", g.use("strconv", "strconv"))
		g.p("}")
		g.p("")
		inits = append(inits, fmt.Sprintf("\t%s.RegisterEnum(%q, %s_name, %s_value)", g.use("google.golang.org/protobuf/proto", "proto"), enumTagName(e), e.goName, e.goName))
	}
	for _, m := range f.messages {
		g.p("type %s struct {", m.goName)
		done := map[*oneof]bool{}
		for _, fd := range m.fields {
			if fd.oneof != nil {
				if !done[fd.oneof] {
					done[fd.oneof] = true
					g.p("\t// Types that are valid to be assigned to %s:", fd.oneof.goName)
					for _, of := range fd.oneof.fields {
						g.p("\t//\t*%s", wrapperName(m, of))
					}
					g.p("\t%s is%s_%s `protobuf_oneof:\"%s\"`", fd.oneof.goName, m.goName, fd.oneof.goName, fd.oneof.name)
				}
				continue
			}
			g.p("\t%s %s %s", fd.goName, g.fieldType(fd), g.fieldTag(fd))
		}
		g.p("}")
		g.p("")
		g.p("func (x *%s) Reset() { *x = %s{} }", m.goName, m.goName)
		g.p("")
		g.p("func (x *%s) String() string { return %s.MarshalOptions{}.Format(x) }", m.goName, g.use("google.golang.org/protobuf/encoding/protojson", "protojson"))
		g.p("")
		g.p("func (*%s) ProtoMessage() {}", m.goName)
		g.p("")
		done = map[*oneof]bool{}
		for _, fd := range m.fields {
			if fd.oneof != nil {
				o := fd.oneof
				if !done[o] {
					done[o] = true
					g.p("func (x *%s) Get%s() is%s_%s {", m.goName, o.goName, m.goName, o.goName)
					g.p("\tif x != nil {")
					g.p("\t\treturn x.%s", o.goName)
					g.p("\t}")
					g.p("\treturn nil")
					g.p("}")
					g.p("")
				}
				g.p("func (x *%s) Get%s() %s {", m.goName, fd.goName, g.fieldType(fd))
				g.p("\tif x, ok := x.Get%s().(*%s); ok {", o.goName, wrapperName(m, fd))
				g.p("\t\treturn x.%s", fd.goName)
				g.p("\t}")
				g.p("\treturn %s", g.zero(fd))
				g.p("}")
				g.p("")
				continue
			}
			g.p("func (x *%s) Get%s() %s {", m.goName, fd.goName, g.valueOrSelf(fd))
			if fd.optional && fd.msg == nil {
				g.p("\tif x != nil && x.%s != nil {", fd.goName)
				g.p("\t\treturn *x.%s", fd.goName)
			} else {
				g.p("\tif x != nil {")
				g.p("\t\treturn x.%s", fd.goName)
			}
			g.p("\t}")
			g.p("\treturn %s", g.zero(fd))
			g.p("}")
			g.p("")
		}
		for _, o := range m.oneofs {
			g.p("type is%s_%s interface {", m.goName, o.goName)
			g.p("\tis%s_%s()", m.goName, o.goName)
			g.p("}")
			g.p("")
			var samples []string
			for _, fd := range o.fields {
				w := wrapperName(m, fd)
				g.p("type %s struct {", w)
				g.p("\t%s %s `protobuf:\"%s\"`", fd.goName, g.valueType(fd.typ, fd.msg, fd.enum),
					protoTag(fd.typ, fd.number, "opt", fd.name, fd.msg, fd.enum, ",oneof"))
				g.p("}")
				g.p("")
				g.p("func (*%s) is%s_%s() {}", w, m.goName, o.goName)
				g.p("")
				samples = append(samples, fmt.Sprintf("&%s{%s: &%s{}}", m.goName, o.goName, w))
			}
			inits = append(inits, fmt.Sprintf("\t%s.RegisterOneofWrappers(%s)", g.use("google.golang.org/protobuf/proto", "proto"), strings.Join(samples, ", ")))
		}
	}
	if len(inits) > 0 {
		g.p("func init() {")
		for _, line := range inits {
			g.p("%s", line)
		}
		g.p("}")
	}
	return g.finish(header(f))
}

// valueOrSelf is a getter's return type: the pointee for an optional scalar.
func (g *gen) valueOrSelf(fd *field) string {
	if fd.optional && fd.msg == nil {
		return g.valueType(fd.typ, fd.msg, fd.enum)
	}
	return g.fieldType(fd)
}
