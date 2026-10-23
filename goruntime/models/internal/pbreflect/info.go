package pbreflect

import (
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Kind is a field's protobuf type.
type Kind int

// The protobuf scalar kinds, enums and messages.
const (
	BoolKind Kind = iota + 1
	Int32Kind
	Sint32Kind
	Sfixed32Kind
	Uint32Kind
	Fixed32Kind
	Int64Kind
	Sint64Kind
	Sfixed64Kind
	Uint64Kind
	Fixed64Kind
	FloatKind
	DoubleKind
	StringKind
	BytesKind
	EnumKind
	MessageKind
)

// Field is one field of a message, as its `protobuf` tag and Go type describe it.
type Field struct {
	Index    int // struct field index; -1 for a map entry's key and value
	Number   int32
	Name     string // the proto name
	JSONName string
	Kind     Kind
	Enum     string // the enum's full name, for EnumKind
	Repeated bool
	Packed   bool
	Optional bool // proto3 optional: a pointer to a scalar
	Map      bool
	Key      *Field // map entries
	Value    *Field
	Elem     reflect.Type // the Go type of one value (slice element, map value, pointee of optional)
	Oneof    *Oneof       // the oneof this field is a member of
	Wrapper  reflect.Type // a oneof member's wrapper (a pointer to a one-field struct)
}

// Oneof is a oneof: an interface-typed struct field holding one of the wrapper types.
type Oneof struct {
	Index int
	Name  string
}

// Message is the layout of one message struct.
type Message struct {
	Type   reflect.Type // the struct type
	Fields []*Field     // regular fields, in declaration order
	Oneofs []*Oneof
	// Order is the declaration order of fields and oneofs, for JSON: entries are *Field or *Oneof.
	Order    []any
	byNumber map[int32]*Field
	byName   map[string]*Field
}

var infos sync.Map // reflect.Type (struct) → *Message

// IsMessage reports whether t is a message pointer type: a pointer to a struct.
func IsMessage(t reflect.Type) bool {
	return t.Kind() == reflect.Pointer && t.Elem().Kind() == reflect.Struct
}

// Info returns the layout of the message struct type t.
func Info(t reflect.Type) (*Message, error) {
	if v, ok := infos.Load(t); ok {
		return v.(*Message), nil
	}
	m := &Message{Type: t, byNumber: map[int32]*Field{}, byName: map[string]*Field{}}
	for i := range t.NumField() {
		sf := t.Field(i)
		if name, ok := sf.Tag.Lookup("protobuf_oneof"); ok {
			o := &Oneof{Index: i, Name: name}
			m.Oneofs = append(m.Oneofs, o)
			m.Order = append(m.Order, o)
			continue
		}
		tag, ok := sf.Tag.Lookup("protobuf")
		if !ok {
			continue
		}
		f, err := parseField(tag, sf.Type)
		if err != nil {
			return nil, fmt.Errorf("proto: %s.%s: %w", t, sf.Name, err)
		}
		f.Index = i
		if f.Map {
			if f.Key, err = parseField(sf.Tag.Get("protobuf_key"), sf.Type.Key()); err != nil {
				return nil, fmt.Errorf("proto: %s.%s key: %w", t, sf.Name, err)
			}
			if f.Value, err = parseField(sf.Tag.Get("protobuf_val"), sf.Type.Elem()); err != nil {
				return nil, fmt.Errorf("proto: %s.%s value: %w", t, sf.Name, err)
			}
			f.Key.Index, f.Value.Index = -1, -1
		}
		m.Fields = append(m.Fields, f)
		m.Order = append(m.Order, f)
		m.byNumber[f.Number] = f
		m.byName[f.Name] = f
		m.byName[f.JSONName] = f
	}
	v, _ := infos.LoadOrStore(t, m)
	return v.(*Message), nil
}

// parseField reads a `protobuf` tag: "bytes,1,opt,name=room,json=roomId,proto3,enum=pkg.E,oneof".
func parseField(tag string, goType reflect.Type) (*Field, error) {
	parts := strings.Split(tag, ",")
	if len(parts) < 3 {
		return nil, fmt.Errorf("malformed protobuf tag %q", tag)
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("malformed field number in %q", tag)
	}
	f := &Field{Number: int32(n), Repeated: parts[2] == "rep"}
	oneofMember := false
	for _, p := range parts[3:] {
		switch {
		case p == "packed":
			f.Packed = true
		case strings.HasPrefix(p, "name="):
			f.Name = p[5:]
		case strings.HasPrefix(p, "json="):
			f.JSONName = p[5:]
		case strings.HasPrefix(p, "enum="):
			f.Enum = p[5:]
		case p == "oneof":
			oneofMember = true
		}
	}
	if f.JSONName == "" {
		f.JSONName = jsonName(f.Name)
	}
	elem := goType
	switch {
	case goType.Kind() == reflect.Map:
		f.Map, f.Repeated = true, true
		elem = goType.Elem()
	case f.Repeated:
		if goType.Kind() != reflect.Slice {
			return nil, fmt.Errorf("repeated field of type %s", goType)
		}
		elem = goType.Elem()
	case goType.Kind() == reflect.Pointer && goType.Elem().Kind() != reflect.Struct:
		f.Optional = oneofMember
		elem = goType.Elem()
	}
	f.Elem = elem
	if f.Map {
		f.Kind = MessageKind // a map entry is a message on the wire
		return f, nil
	}
	if f.Kind, err = kindOf(parts[0], elem, f.Enum != ""); err != nil {
		return nil, err
	}
	return f, nil
}

func kindOf(wire string, t reflect.Type, enum bool) (Kind, error) {
	k := t.Kind()
	switch wire {
	case "varint":
		switch {
		case k == reflect.Bool:
			return BoolKind, nil
		case k == reflect.Int32 && enum:
			return EnumKind, nil
		case k == reflect.Int32:
			return Int32Kind, nil
		case k == reflect.Int64:
			return Int64Kind, nil
		case k == reflect.Uint32:
			return Uint32Kind, nil
		case k == reflect.Uint64:
			return Uint64Kind, nil
		}
	case "zigzag32":
		if k == reflect.Int32 {
			return Sint32Kind, nil
		}
	case "zigzag64":
		if k == reflect.Int64 {
			return Sint64Kind, nil
		}
	case "fixed32":
		switch k {
		case reflect.Uint32:
			return Fixed32Kind, nil
		case reflect.Int32:
			return Sfixed32Kind, nil
		case reflect.Float32:
			return FloatKind, nil
		}
	case "fixed64":
		switch k {
		case reflect.Uint64:
			return Fixed64Kind, nil
		case reflect.Int64:
			return Sfixed64Kind, nil
		case reflect.Float64:
			return DoubleKind, nil
		}
	case "bytes":
		switch {
		case k == reflect.String:
			return StringKind, nil
		case k == reflect.Slice && t.Elem().Kind() == reflect.Uint8:
			return BytesKind, nil
		case IsMessage(t):
			return MessageKind, nil
		}
	}
	return 0, fmt.Errorf("wire type %q does not fit Go type %s", wire, t)
}

// jsonName is protoc's lowerCamelCase JSON name: underscores dropped, the letter after one upper-cased.
func jsonName(name string) string {
	var b strings.Builder
	upper := false
	for _, c := range name {
		if c == '_' {
			upper = true
			continue
		}
		if upper && 'a' <= c && c <= 'z' {
			c -= 'a' - 'A'
		}
		upper = false
		b.WriteRune(c)
	}
	return b.String()
}

// ByNumber returns the regular field numbered n, or the registered oneof member numbered n.
func (m *Message) ByNumber(n int32) *Field {
	if f := m.byNumber[n]; f != nil {
		return f
	}
	for _, o := range m.Oneofs {
		if mem := oneofMember(m.Type, o, func(f *Field) bool { return f.Number == n }); mem != nil {
			return mem.field
		}
	}
	return nil
}

// ByName returns the field named name (proto or JSON name), regular or registered oneof member.
func (m *Message) ByName(name string) *Field {
	if f := m.byName[name]; f != nil {
		return f
	}
	for _, o := range m.Oneofs {
		if mem := oneofMember(m.Type, o, func(f *Field) bool { return f.Name == name || f.JSONName == name }); mem != nil {
			return mem.field
		}
	}
	return nil
}

// FieldsByNumber returns the regular fields ordered by number.
func (m *Message) FieldsByNumber() []*Field {
	out := append([]*Field(nil), m.Fields...)
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// ---- oneofs --------------------------------------------------------------------------------------

type member struct {
	field    *Field
	template reflect.Value // an interpreted interface value of this member's wrapper (yaegi), or invalid
}

type oneofKey struct {
	t     reflect.Type
	index int
}

var (
	oneofMu      sync.Mutex
	oneofMembers = map[oneofKey][]*member{}
)

func oneofMember(t reflect.Type, o *Oneof, match func(*Field) bool) *member {
	oneofMu.Lock()
	defer oneofMu.Unlock()
	for _, mem := range oneofMembers[oneofKey{t, o.Index}] {
		if match(mem.field) {
			return mem
		}
	}
	return nil
}

// RegisterOneofWrappers records, from sample messages each holding one oneof member (a typed nil
// wrapper is enough), the wrapper types decoding needs: native code cannot ask an interpreted
// message for its wrappers.
func RegisterOneofWrappers(samples ...any) error {
	for _, s := range samples {
		v := Of(s)
		if !v.IsValid() || !IsMessage(v.Type()) || v.IsNil() {
			return fmt.Errorf("proto: RegisterOneofWrappers: %T is not a message pointer", s)
		}
		info, err := Info(v.Type().Elem())
		if err != nil {
			return err
		}
		for _, o := range info.Oneofs {
			raw := v.Elem().Field(o.Index)
			w := Unwrap(raw)
			if !w.IsValid() {
				continue
			}
			f, err := wrapperField(w.Type())
			if err != nil {
				return err
			}
			f.Oneof = o
			mem := &member{field: f}
			if isValueInterface(raw.Type()) {
				mem.template = raw
			}
			oneofMu.Lock()
			key := oneofKey{info.Type, o.Index}
			known := false
			for _, m := range oneofMembers[key] {
				known = known || m.field.Number == f.Number
			}
			if !known {
				oneofMembers[key] = append(oneofMembers[key], mem)
			}
			oneofMu.Unlock()
		}
	}
	return nil
}

// wrapperField describes the member a oneof wrapper type (*Msg_Member) holds.
func wrapperField(wt reflect.Type) (*Field, error) {
	if !IsMessage(wt) || wt.Elem().NumField() != 1 {
		return nil, fmt.Errorf("proto: %s is not a oneof wrapper", wt)
	}
	sf := wt.Elem().Field(0)
	f, err := parseField(sf.Tag.Get("protobuf"), sf.Type)
	if err != nil {
		return nil, fmt.Errorf("proto: oneof wrapper %s: %w", wt, err)
	}
	f.Index = 0
	f.Wrapper = wt
	return f, nil
}

// OneofGet returns the member set in oneof o of message struct value sv and its value, or nil.
func OneofGet(sv reflect.Value, o *Oneof) (*Field, reflect.Value, error) {
	w := Unwrap(sv.Field(o.Index))
	if !w.IsValid() || w.IsNil() {
		return nil, reflect.Value{}, nil
	}
	f, err := wrapperField(w.Type())
	if err != nil {
		return nil, reflect.Value{}, err
	}
	f.Oneof = o
	return f, w.Elem().Field(0), nil
}

// OneofSet stores a fresh wrapper for member f in its oneof and returns the wrapper's value field
// to fill.
func OneofSet(sv reflect.Value, f *Field) (reflect.Value, error) {
	slot := sv.Field(f.Oneof.Index)
	w := reflect.New(f.Wrapper.Elem())
	switch {
	case isValueInterface(slot.Type()):
		mem := oneofMember(sv.Type(), f.Oneof, func(m *Field) bool { return m.Number == f.Number })
		if mem == nil || !mem.template.IsValid() {
			return reflect.Value{}, fmt.Errorf("proto: oneof %s of %s: wrappers not registered", f.Oneof.Name, sv.Type())
		}
		slot.Set(viWith(mem.template, w))
	case slot.Kind() == reflect.Interface:
		slot.Set(w)
	default:
		return reflect.Value{}, fmt.Errorf("proto: oneof %s of %s is not an interface", f.Oneof.Name, sv.Type())
	}
	return w.Elem().Field(0), nil
}

// RegisterOneofType registers the wrapper types of a native message's oneof (tests, native messages):
// msg is a message pointer, wrappers its oneof's wrapper pointer types.
func RegisterOneofType(msg reflect.Type, oneofIndex int, wrappers ...reflect.Type) error {
	info, err := Info(msg.Elem())
	if err != nil {
		return err
	}
	for _, o := range info.Oneofs {
		if o.Index != oneofIndex {
			continue
		}
		for _, wt := range wrappers {
			f, err := wrapperField(wt)
			if err != nil {
				return err
			}
			f.Oneof = o
			oneofMu.Lock()
			oneofMembers[oneofKey{info.Type, o.Index}] = append(oneofMembers[oneofKey{info.Type, o.Index}], &member{field: f})
			oneofMu.Unlock()
		}
		return nil
	}
	return fmt.Errorf("proto: %s has no oneof at field %d", msg, oneofIndex)
}

// OneofMembers lists the registered members of oneof o of message type t, by number.
func OneofMembers(t reflect.Type, o *Oneof) []*Field {
	oneofMu.Lock()
	defer oneofMu.Unlock()
	var out []*Field
	for _, m := range oneofMembers[oneofKey{t, o.Index}] {
		out = append(out, m.field)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// ---- enums ---------------------------------------------------------------------------------------

type enumInfo struct {
	names  map[int32]string
	values map[string]int32
}

var (
	enumMu sync.RWMutex
	enums  = map[string]enumInfo{}
)

// RegisterEnum records an enum's names (the generated Foo_name and Foo_value maps) for protojson.
func RegisterEnum(name string, names map[int32]string, values map[string]int32) {
	enumMu.Lock()
	defer enumMu.Unlock()
	enums[name] = enumInfo{names: names, values: values}
}

// EnumName returns the name of value n of enum, if registered and known.
func EnumName(enum string, n int32) (string, bool) {
	enumMu.RLock()
	defer enumMu.RUnlock()
	s, ok := enums[enum].names[n]
	return s, ok
}

// EnumValue returns the number of the value named s of enum.
func EnumValue(enum, s string) (int32, bool) {
	enumMu.RLock()
	defer enumMu.RUnlock()
	n, ok := enums[enum].values[s]
	return n, ok
}
