package pbreflect

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
)

// JSONOptions are protojson's marshalling options.
type JSONOptions struct {
	Multiline       bool
	Indent          string
	UseProtoNames   bool
	UseEnumNumbers  bool
	EmitUnpopulated bool
}

// MarshalJSON renders the message m points to in the protobuf JSON mapping.
func MarshalJSON(m reflect.Value, o JSONOptions) ([]byte, error) {
	if m.Kind() != reflect.Pointer || m.Type().Elem().Kind() != reflect.Struct {
		return nil, fmt.Errorf("proto: %s is not a message pointer", m.Type())
	}
	var buf bytes.Buffer
	if m.IsNil() {
		buf.WriteString("{}")
	} else if err := writeMessage(&buf, m.Elem(), o); err != nil {
		return nil, err
	}
	if o.Multiline || o.Indent != "" {
		indent := o.Indent
		if indent == "" {
			indent = "  "
		}
		var out bytes.Buffer
		if err := json.Indent(&out, buf.Bytes(), "", indent); err != nil {
			return nil, err
		}
		return out.Bytes(), nil
	}
	return buf.Bytes(), nil
}

func writeMessage(buf *bytes.Buffer, sv reflect.Value, o JSONOptions) error {
	info, err := Info(sv.Type())
	if err != nil {
		return err
	}
	buf.WriteByte('{')
	first := true
	emit := func(f *Field, v reflect.Value) error {
		if !first {
			buf.WriteByte(',')
		}
		first = false
		name := f.JSONName
		if o.UseProtoNames {
			name = f.Name
		}
		writeString(buf, name)
		buf.WriteByte(':')
		return writeField(buf, f, v, o)
	}
	for _, item := range info.Order {
		switch it := item.(type) {
		case *Field:
			v := sv.Field(it.Index)
			if !o.EmitUnpopulated && unpopulated(it, v) {
				continue
			}
			if it.Optional && v.IsNil() {
				continue
			}
			if err := emit(it, v); err != nil {
				return err
			}
		case *Oneof:
			f, v, err := OneofGet(sv, it)
			if err != nil {
				return err
			}
			if f == nil {
				continue
			}
			if err := emit(f, v); err != nil {
				return err
			}
		}
	}
	buf.WriteByte('}')
	return nil
}

func unpopulated(f *Field, v reflect.Value) bool {
	switch {
	case f.Map, f.Repeated:
		return v.Len() == 0
	case f.Optional, f.Kind == MessageKind:
		return v.IsNil()
	}
	return v.IsZero()
}

func writeField(buf *bytes.Buffer, f *Field, v reflect.Value, o JSONOptions) error {
	switch {
	case f.Map:
		buf.WriteByte('{')
		keys := v.MapKeys()
		sortKeys(keys)
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeString(buf, mapKeyString(k))
			buf.WriteByte(':')
			if err := writeValue(buf, f.Value, v.MapIndex(k), o); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
		return nil
	case f.Repeated:
		buf.WriteByte('[')
		for i := range v.Len() {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeValue(buf, f, v.Index(i), o); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	case f.Optional:
		return writeValue(buf, f, v.Elem(), o)
	}
	return writeValue(buf, f, v, o)
}

func mapKeyString(k reflect.Value) string {
	switch k.Kind() {
	case reflect.String:
		return k.String()
	case reflect.Bool:
		return strconv.FormatBool(k.Bool())
	case reflect.Int32, reflect.Int64:
		return strconv.FormatInt(k.Int(), 10)
	}
	return strconv.FormatUint(k.Uint(), 10)
}

func writeValue(buf *bytes.Buffer, f *Field, v reflect.Value, o JSONOptions) error {
	switch f.Kind {
	case MessageKind:
		if v.IsNil() {
			if f.Oneof != nil {
				buf.WriteString("{}")
			} else {
				buf.WriteString("null")
			}
			return nil
		}
		return writeMessage(buf, v.Elem(), o)
	case BoolKind:
		buf.WriteString(strconv.FormatBool(v.Bool()))
	case Int32Kind, Sint32Kind, Sfixed32Kind:
		buf.WriteString(strconv.FormatInt(v.Int(), 10))
	case Uint32Kind, Fixed32Kind:
		buf.WriteString(strconv.FormatUint(v.Uint(), 10))
	case Int64Kind, Sint64Kind, Sfixed64Kind:
		writeString(buf, strconv.FormatInt(v.Int(), 10))
	case Uint64Kind, Fixed64Kind:
		writeString(buf, strconv.FormatUint(v.Uint(), 10))
	case FloatKind, DoubleKind:
		bits := 64
		if f.Kind == FloatKind {
			bits = 32
		}
		x := v.Float()
		switch {
		case math.IsNaN(x):
			writeString(buf, "NaN")
		case math.IsInf(x, 1):
			writeString(buf, "Infinity")
		case math.IsInf(x, -1):
			writeString(buf, "-Infinity")
		default:
			buf.WriteString(formatFloat(x, bits))
		}
	case StringKind:
		writeString(buf, v.String())
	case BytesKind:
		writeString(buf, base64.StdEncoding.EncodeToString(v.Bytes()))
	case EnumKind:
		n := int32(v.Int())
		if name, ok := EnumName(f.Enum, n); ok && !o.UseEnumNumbers {
			writeString(buf, name)
		} else {
			buf.WriteString(strconv.FormatInt(int64(n), 10))
		}
	}
	return nil
}

// formatFloat renders like encoding/json (and protojson): shortest repr, exponent only when large/small.
func formatFloat(x float64, bits int) string {
	abs := math.Abs(x)
	format := byte('f')
	if abs != 0 && (bits == 64 && (abs < 1e-6 || abs >= 1e21) || bits == 32 && (float32(abs) < 1e-6 || float32(abs) >= 1e21)) {
		format = 'e'
	}
	s := strconv.FormatFloat(x, format, -1, bits)
	if format == 'e' {
		// clean up e-09 to e-9
		n := len(s)
		if n >= 4 && s[n-4] == 'e' && s[n-3] == '-' && s[n-2] == '0' {
			s = s[:n-2] + s[n-1:]
		}
	}
	return s
}

func writeString(buf *bytes.Buffer, s string) {
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	buf.Truncate(buf.Len() - 1) // the encoder's newline
}

// ---- decoding ------------------------------------------------------------------------------------

// UnmarshalJSON parses the protobuf JSON mapping into the message m points to (reset first).
func UnmarshalJSON(b []byte, m reflect.Value, discardUnknown bool) error {
	if m.Kind() != reflect.Pointer || m.Type().Elem().Kind() != reflect.Struct || m.IsNil() {
		return fmt.Errorf("proto: Unmarshal needs a non-nil message pointer, got %s", m.Type())
	}
	m.Elem().Set(reflect.Zero(m.Type().Elem()))
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return fmt.Errorf("proto: syntax error: %w", err)
	}
	if dec.More() {
		return fmt.Errorf("proto: syntax error: unexpected data after the top-level value")
	}
	return readMessage(tree, m.Elem(), discardUnknown)
}

func readMessage(tree any, sv reflect.Value, discard bool) error {
	obj, ok := tree.(map[string]any)
	if !ok {
		return fmt.Errorf("proto: invalid value for message %s: %s", sv.Type(), show(tree))
	}
	info, err := Info(sv.Type())
	if err != nil {
		return err
	}
	seenOneof := map[int]string{}
	for key, raw := range obj {
		f := info.ByName(key)
		if f == nil {
			if discard {
				continue
			}
			return fmt.Errorf("proto: unknown field %q", key)
		}
		if raw == nil && !(f.Kind == EnumKind && f.Enum == "google.protobuf.NullValue") {
			continue // null: the default
		}
		if f.Oneof != nil {
			if prev, dup := seenOneof[f.Oneof.Index]; dup {
				return fmt.Errorf("proto: error parsing %q, oneof %s is already set by %q", key, f.Oneof.Name, prev)
			}
			seenOneof[f.Oneof.Index] = key
			slot, err := OneofSet(sv, f)
			if err != nil {
				return err
			}
			if err := readValue(raw, f, slot, discard); err != nil {
				return err
			}
			continue
		}
		fv := sv.Field(f.Index)
		switch {
		case f.Map:
			obj, ok := raw.(map[string]any)
			if !ok {
				return fmt.Errorf("proto: invalid value for map field %s: %s", f.Name, show(raw))
			}
			mv := reflect.MakeMapWithSize(fv.Type(), len(obj))
			for ks, vraw := range obj {
				k := reflect.New(fv.Type().Key()).Elem()
				if err := readMapKey(ks, f.Key, k); err != nil {
					return err
				}
				val := reflect.New(fv.Type().Elem()).Elem()
				if vraw != nil {
					if err := readValue(vraw, f.Value, val, discard); err != nil {
						return err
					}
				}
				if f.Value.Kind == MessageKind && val.IsNil() {
					val.Set(reflect.New(val.Type().Elem()))
				}
				mv.SetMapIndex(k, val)
			}
			fv.Set(mv)
		case f.Repeated:
			arr, ok := raw.([]any)
			if !ok {
				return fmt.Errorf("proto: invalid value for repeated field %s: %s", f.Name, show(raw))
			}
			sl := reflect.MakeSlice(fv.Type(), len(arr), len(arr))
			for i, e := range arr {
				if err := readValue(e, f, sl.Index(i), discard); err != nil {
					return err
				}
			}
			fv.Set(sl)
		case f.Optional:
			p := reflect.New(f.Elem)
			if err := readValue(raw, f, p.Elem(), discard); err != nil {
				return err
			}
			fv.Set(p)
		default:
			if err := readValue(raw, f, fv, discard); err != nil {
				return err
			}
		}
	}
	return nil
}

func readMapKey(s string, f *Field, k reflect.Value) error {
	switch k.Kind() {
	case reflect.String:
		k.SetString(s)
	case reflect.Bool:
		b, err := strconv.ParseBool(s)
		if err != nil {
			return fmt.Errorf("proto: invalid map key %q", s)
		}
		k.SetBool(b)
	case reflect.Int32, reflect.Int64:
		n, err := strconv.ParseInt(s, 10, k.Type().Bits())
		if err != nil {
			return fmt.Errorf("proto: invalid map key %q", s)
		}
		k.SetInt(n)
	default:
		n, err := strconv.ParseUint(s, 10, k.Type().Bits())
		if err != nil {
			return fmt.Errorf("proto: invalid map key %q", s)
		}
		k.SetUint(n)
	}
	return nil
}

func show(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func readValue(raw any, f *Field, v reflect.Value, discard bool) error {
	bad := func() error {
		return fmt.Errorf("proto: invalid value for %s field %s: %s", kindName(f.Kind), f.Name, show(raw))
	}
	switch f.Kind {
	case MessageKind:
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		return readMessage(raw, v.Elem(), discard)
	case BoolKind:
		b, ok := raw.(bool)
		if !ok {
			return bad()
		}
		v.SetBool(b)
	case StringKind:
		s, ok := raw.(string)
		if !ok {
			return bad()
		}
		v.SetString(s)
	case BytesKind:
		s, ok := raw.(string)
		if !ok {
			return bad()
		}
		b, err := decodeBase64(s)
		if err != nil {
			return bad()
		}
		v.SetBytes(b)
	case EnumKind:
		switch x := raw.(type) {
		case string:
			n, ok := EnumValue(f.Enum, x)
			if !ok {
				if discard {
					return nil
				}
				return bad()
			}
			v.SetInt(int64(n))
		case json.Number:
			n, err := strconv.ParseInt(string(x), 10, 32)
			if err != nil {
				return bad()
			}
			v.SetInt(n)
		default:
			return bad()
		}
	case FloatKind, DoubleKind:
		var x float64
		switch r := raw.(type) {
		case json.Number:
			var err error
			if x, err = strconv.ParseFloat(string(r), 64); err != nil {
				return bad()
			}
		case string:
			switch r {
			case "NaN":
				x = math.NaN()
			case "Infinity":
				x = math.Inf(1)
			case "-Infinity":
				x = math.Inf(-1)
			default:
				var err error
				if x, err = strconv.ParseFloat(r, 64); err != nil {
					return bad()
				}
			}
		default:
			return bad()
		}
		if f.Kind == FloatKind && !math.IsInf(x, 0) && !math.IsNaN(x) && math.Abs(x) > math.MaxFloat32 {
			return bad()
		}
		v.SetFloat(x)
	default: // integers
		var s string
		switch r := raw.(type) {
		case json.Number:
			s = string(r)
		case string:
			s = r
		default:
			return bad()
		}
		bits := 64
		switch f.Kind {
		case Int32Kind, Sint32Kind, Sfixed32Kind, Uint32Kind, Fixed32Kind:
			bits = 32
		}
		switch f.Kind {
		case Uint32Kind, Fixed32Kind, Uint64Kind, Fixed64Kind:
			n, err := parseUint(s, bits)
			if err != nil {
				return bad()
			}
			v.SetUint(n)
		default:
			n, err := parseInt(s, bits)
			if err != nil {
				return bad()
			}
			v.SetInt(n)
		}
	}
	return nil
}

// parseInt accepts an integer, or a float with an integral value ("1e3", "5.0"), as protojson does.
func parseInt(s string, bits int) (int64, error) {
	if n, err := strconv.ParseInt(s, 10, bits); err == nil {
		return n, nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f != math.Trunc(f) || f < -math.Pow(2, float64(bits-1)) || f >= math.Pow(2, float64(bits-1)) {
		return 0, fmt.Errorf("not an integer")
	}
	return int64(f), nil
}

func parseUint(s string, bits int) (uint64, error) {
	if n, err := strconv.ParseUint(s, 10, bits); err == nil {
		return n, nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f != math.Trunc(f) || f < 0 || f >= math.Pow(2, float64(bits)) {
		return 0, fmt.Errorf("not an unsigned integer")
	}
	return uint64(f), nil
}

func decodeBase64(s string) ([]byte, error) {
	enc := base64.StdEncoding
	if strings.ContainsAny(s, "-_") {
		enc = base64.URLEncoding
	}
	if len(s)%4 != 0 {
		enc = enc.WithPadding(base64.NoPadding)
	}
	return enc.DecodeString(s)
}

func kindName(k Kind) string {
	return [...]string{"", "bool", "int32", "sint32", "sfixed32", "uint32", "fixed32", "int64", "sint64", "sfixed64", "uint64", "fixed64", "float", "double", "string", "bytes", "enum", "message"}[k]
}
