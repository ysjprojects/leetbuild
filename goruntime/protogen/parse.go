package protogen

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// ---- the parsed .proto ---------------------------------------------------------------------------

type protoFile struct {
	name      string // "chat.proto"
	pkg       string // "chat", "notes.v1"
	goPackage string // the go_package option
	imports   []string
	messages  []*message // every message, nested ones included, in declaration order
	enums     []*enum    // every enum, nested ones included
	services  []*service

	// Filled by Generate.
	goName     string // the Go package name
	importPath string
}

type message struct {
	file   *protoFile
	full   string // "pkg.Outer.Inner"
	rel    string // "Outer.Inner"
	parent *message
	fields []*field
	oneofs []*oneof
	nested map[string]bool // names of nested messages and enums
	goName string
}

type field struct {
	name     string
	number   int
	typ      string // as written
	repeated bool
	optional bool // proto3 optional
	mapKey   string
	oneof    *oneof

	// Resolved.
	msg    *message
	enum   *enum
	valMsg *message // map value types
	valEn  *enum
	goName string
	scope  string
}

type oneof struct {
	name   string
	fields []*field
	goName string
}

type enum struct {
	file   *protoFile
	full   string
	rel    string
	parent *message
	values []enumValue
	goName string
}

type enumValue struct {
	name   string
	number int
}

type service struct {
	name    string
	methods []*method
}

type method struct {
	name          string
	input, output string
	clientStreams bool
	serverStreams bool
	in, out       *message
}

// ---- tokens --------------------------------------------------------------------------------------

type parser struct {
	file   string
	toks   []token
	i      int
	parsed *protoFile
}

type token struct {
	text string
	line int
}

func tokenize(src string) ([]token, error) {
	var toks []token
	line := 1
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case strings.HasPrefix(src[i:], "//"):
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case strings.HasPrefix(src[i:], "/*"):
			end := strings.Index(src[i+2:], "*/")
			if end < 0 {
				return nil, fmt.Errorf("line %d: unterminated comment", line)
			}
			line += strings.Count(src[i:i+2+end], "\n")
			i += end + 4
		case c == '"' || c == '\'':
			j := i + 1
			for j < len(src) && src[j] != c {
				if src[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(src) {
				return nil, fmt.Errorf("line %d: unterminated string", line)
			}
			toks = append(toks, token{src[i : j+1], line})
			i = j + 1
		case c == '_' || c == '.' && i+1 < len(src) && isLetter(src[i+1]) || isLetter(c):
			j := i + 1
			for j < len(src) && (isLetter(src[j]) || isDigit(src[j]) || src[j] == '_' || src[j] == '.') {
				j++
			}
			toks = append(toks, token{src[i:j], line})
			i = j
		case isDigit(c) || c == '-' || c == '+':
			j := i + 1
			for j < len(src) && (isLetter(src[j]) || isDigit(src[j]) || src[j] == '.') {
				j++
			}
			toks = append(toks, token{src[i:j], line})
			i = j
		case strings.ContainsRune("{}=;<>,[]()", rune(c)):
			toks = append(toks, token{string(c), line})
			i++
		default:
			return nil, fmt.Errorf("line %d: unexpected %q", line, c)
		}
	}
	return toks, nil
}

func isLetter(c byte) bool { return c < 0x80 && unicode.IsLetter(rune(c)) }
func isDigit(c byte) bool  { return '0' <= c && c <= '9' }

func (p *parser) errorf(format string, args ...any) error {
	line := 0
	if p.i < len(p.toks) {
		line = p.toks[p.i].line
	} else if len(p.toks) > 0 {
		line = p.toks[len(p.toks)-1].line
	}
	return fmt.Errorf("%s:%d: %s", p.file, line, fmt.Sprintf(format, args...))
}

func (p *parser) peek() string {
	if p.i < len(p.toks) {
		return p.toks[p.i].text
	}
	return ""
}

func (p *parser) next() (string, error) {
	if p.i >= len(p.toks) {
		return "", p.errorf("unexpected end of file")
	}
	t := p.toks[p.i].text
	p.i++
	return t, nil
}

func (p *parser) expect(want string) error {
	got, err := p.next()
	if err != nil {
		return err
	}
	if got != want {
		p.i--
		return p.errorf("expected %q, got %q", want, got)
	}
	return nil
}

func (p *parser) ident() (string, error) {
	t, err := p.next()
	if err != nil {
		return "", err
	}
	if t == "" || !(isLetter(t[0]) || t[0] == '_' || t[0] == '.') {
		p.i--
		return "", p.errorf("expected a name, got %q", t)
	}
	return t, nil
}

func (p *parser) integer() (int, error) {
	t, err := p.next()
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(t, 0, 64)
	if err != nil {
		p.i--
		return 0, p.errorf("expected a number, got %q", t)
	}
	return int(n), nil
}

// skipStatement skips to the end of a statement or block.
func (p *parser) skipStatement() error {
	for p.i < len(p.toks) {
		t, _ := p.next()
		switch t {
		case ";":
			return nil
		case "{":
			return p.skipBlock()
		}
	}
	return p.errorf("unexpected end of file")
}

// skipBlock skips to the "}" matching an already consumed "{".
func (p *parser) skipBlock() error {
	depth := 1
	for depth > 0 {
		t, err := p.next()
		if err != nil {
			return err
		}
		switch t {
		case "{":
			depth++
		case "}":
			depth--
		}
	}
	return nil
}

// skipOptions skips a field's [options].
func (p *parser) skipOptions() error {
	if p.peek() != "[" {
		return nil
	}
	for {
		t, err := p.next()
		if err != nil {
			return err
		}
		if t == "]" {
			return nil
		}
	}
}

// ---- grammar -------------------------------------------------------------------------------------

func parseFile(name, src string) (*protoFile, error) {
	toks, err := tokenize(src)
	if err != nil {
		return nil, fmt.Errorf("%s:%w", name, err)
	}
	p := &parser{file: name, toks: toks, parsed: &protoFile{name: name}}
	f := p.parsed
	for p.i < len(p.toks) {
		t, _ := p.next()
		switch t {
		case "syntax", "edition":
			if err := p.expect("="); err != nil {
				return nil, err
			}
			v, _ := p.next()
			if t == "syntax" && v != `"proto3"` && v != `'proto3'` {
				return nil, p.errorf("only proto3 is supported, got syntax %s", v)
			}
			if err := p.expect(";"); err != nil {
				return nil, err
			}
		case "package":
			if f.pkg, err = p.ident(); err != nil {
				return nil, err
			}
			if err := p.expect(";"); err != nil {
				return nil, err
			}
		case "import":
			if q := p.peek(); q == "public" || q == "weak" {
				p.i++
			}
			s, err := p.next()
			if err != nil {
				return nil, err
			}
			f.imports = append(f.imports, strings.Trim(s, `"'`))
			if err := p.expect(";"); err != nil {
				return nil, err
			}
		case "option":
			name, err := p.ident()
			if err != nil {
				return nil, err
			}
			if err := p.expect("="); err != nil {
				return nil, err
			}
			v, err := p.next()
			if err != nil {
				return nil, err
			}
			if name == "go_package" {
				f.goPackage = strings.Trim(v, `"'`)
			}
			if err := p.expect(";"); err != nil {
				return nil, err
			}
		case "message":
			if _, err := p.message(nil); err != nil {
				return nil, err
			}
		case "enum":
			if _, err := p.enum(nil); err != nil {
				return nil, err
			}
		case "service":
			if err := p.service(); err != nil {
				return nil, err
			}
		case ";":
		case "extend":
			return nil, p.errorf("extensions are not supported")
		default:
			p.i--
			return nil, p.errorf("unexpected %q", t)
		}
	}
	return f, nil
}

func (p *parser) qualify(parent *message, name string) (rel, full string) {
	rel = name
	if parent != nil {
		rel = parent.rel + "." + name
	}
	full = rel
	if p.parsed.pkg != "" {
		full = p.parsed.pkg + "." + rel
	}
	return rel, full
}

func (p *parser) message(parent *message) (*message, error) {
	name, err := p.ident()
	if err != nil {
		return nil, err
	}
	m := &message{file: p.parsed, parent: parent, nested: map[string]bool{}}
	m.rel, m.full = p.qualify(parent, name)
	p.parsed.messages = append(p.parsed.messages, m)
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	for p.peek() != "}" {
		t, err := p.next()
		if err != nil {
			return nil, err
		}
		switch t {
		case "message":
			n, err := p.message(m)
			if err != nil {
				return nil, err
			}
			m.nested[n.rel[len(m.rel)+1:]] = true
		case "enum":
			e, err := p.enum(m)
			if err != nil {
				return nil, err
			}
			m.nested[e.rel[len(m.rel)+1:]] = true
		case "option", "reserved", "extensions":
			if err := p.skipStatement(); err != nil {
				return nil, err
			}
		case ";":
		case "oneof":
			oname, err := p.ident()
			if err != nil {
				return nil, err
			}
			o := &oneof{name: oname}
			m.oneofs = append(m.oneofs, o)
			if err := p.expect("{"); err != nil {
				return nil, err
			}
			for p.peek() != "}" {
				if p.peek() == "option" {
					p.i++
					if err := p.skipStatement(); err != nil {
						return nil, err
					}
					continue
				}
				typ, err := p.ident()
				if err != nil {
					return nil, err
				}
				f, err := p.field(typ)
				if err != nil {
					return nil, err
				}
				f.oneof = o
				o.fields = append(o.fields, f)
				m.fields = append(m.fields, f)
			}
			p.i++
		case "map":
			if err := p.expect("<"); err != nil {
				return nil, err
			}
			key, err := p.ident()
			if err != nil {
				return nil, err
			}
			if err := p.expect(","); err != nil {
				return nil, err
			}
			val, err := p.ident()
			if err != nil {
				return nil, err
			}
			if err := p.expect(">"); err != nil {
				return nil, err
			}
			f, err := p.field(val)
			if err != nil {
				return nil, err
			}
			f.mapKey = key
			m.fields = append(m.fields, f)
		case "group":
			return nil, p.errorf("groups are not supported")
		default:
			typ := t
			label := ""
			if t == "repeated" || t == "optional" || t == "required" {
				label = t
				if typ, err = p.ident(); err != nil {
					return nil, err
				}
			}
			if label == "required" {
				return nil, p.errorf("required fields are not proto3")
			}
			f, err := p.field(typ)
			if err != nil {
				return nil, err
			}
			f.repeated = label == "repeated"
			f.optional = label == "optional"
			m.fields = append(m.fields, f)
		}
	}
	p.i++
	return m, nil
}

// field parses `name = number [options];` after its type.
func (p *parser) field(typ string) (*field, error) {
	name, err := p.ident()
	if err != nil {
		return nil, err
	}
	if err := p.expect("="); err != nil {
		return nil, err
	}
	n, err := p.integer()
	if err != nil {
		return nil, err
	}
	if err := p.skipOptions(); err != nil {
		return nil, err
	}
	if err := p.expect(";"); err != nil {
		return nil, err
	}
	return &field{name: name, number: n, typ: typ}, nil
}

func (p *parser) enum(parent *message) (*enum, error) {
	name, err := p.ident()
	if err != nil {
		return nil, err
	}
	e := &enum{file: p.parsed, parent: parent}
	e.rel, e.full = p.qualify(parent, name)
	p.parsed.enums = append(p.parsed.enums, e)
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	for p.peek() != "}" {
		t, err := p.next()
		if err != nil {
			return nil, err
		}
		switch t {
		case "option", "reserved":
			if err := p.skipStatement(); err != nil {
				return nil, err
			}
			continue
		case ";":
			continue
		}
		if err := p.expect("="); err != nil {
			return nil, err
		}
		n, err := p.integer()
		if err != nil {
			return nil, err
		}
		if err := p.skipOptions(); err != nil {
			return nil, err
		}
		if err := p.expect(";"); err != nil {
			return nil, err
		}
		e.values = append(e.values, enumValue{name: t, number: n})
	}
	p.i++
	if len(e.values) == 0 || e.values[0].number != 0 {
		return nil, p.errorf("enum %s: the first value must be 0", e.full)
	}
	return e, nil
}

func (p *parser) service() error {
	name, err := p.ident()
	if err != nil {
		return err
	}
	s := &service{name: name}
	p.parsed.services = append(p.parsed.services, s)
	if err := p.expect("{"); err != nil {
		return err
	}
	for p.peek() != "}" {
		t, err := p.next()
		if err != nil {
			return err
		}
		switch t {
		case "option":
			if err := p.skipStatement(); err != nil {
				return err
			}
			continue
		case ";":
			continue
		case "rpc":
		default:
			p.i--
			return p.errorf("unexpected %q in service %s", t, name)
		}
		m := &method{}
		if m.name, err = p.ident(); err != nil {
			return err
		}
		if err := p.expect("("); err != nil {
			return err
		}
		if p.peek() == "stream" {
			p.i++
			m.clientStreams = true
		}
		if m.input, err = p.ident(); err != nil {
			return err
		}
		if err := p.expect(")"); err != nil {
			return err
		}
		if err := p.expect("returns"); err != nil {
			return err
		}
		if err := p.expect("("); err != nil {
			return err
		}
		if p.peek() == "stream" {
			p.i++
			m.serverStreams = true
		}
		if m.output, err = p.ident(); err != nil {
			return err
		}
		if err := p.expect(")"); err != nil {
			return err
		}
		if p.peek() == "{" {
			p.i++
			if err := p.skipBlock(); err != nil {
				return err
			}
		} else if err := p.expect(";"); err != nil {
			return err
		}
		s.methods = append(s.methods, m)
	}
	p.i++
	return nil
}
