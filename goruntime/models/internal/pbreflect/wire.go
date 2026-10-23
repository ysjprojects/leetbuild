package pbreflect

import (
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
)

// Wire types.
const (
	wireVarint  = 0
	wireFixed64 = 1
	wireBytes   = 2
	wireFixed32 = 5
)

// ErrTruncated is a malformed encoding.
var ErrTruncated = errors.New("proto: cannot parse invalid wire-format data")

// Marshal encodes the message m points to in the protobuf binary format, fields by number.
func Marshal(m reflect.Value) ([]byte, error) {
	if m.Kind() != reflect.Pointer || m.Type().Elem().Kind() != reflect.Struct {
		return nil, fmt.Errorf("proto: %s is not a message pointer", m.Type())
	}
	if m.IsNil() {
		return []byte{}, nil
	}
	return appendMessage(nil, m.Elem())
}

type numbered struct {
	f *Field
	v reflect.Value
}

func appendMessage(b []byte, sv reflect.Value) ([]byte, error) {
	info, err := Info(sv.Type())
	if err != nil {
		return nil, err
	}
	fields := make([]numbered, 0, len(info.Fields)+len(info.Oneofs))
	for _, f := range info.Fields {
		fields = append(fields, numbered{f, sv.Field(f.Index)})
	}
	for _, o := range info.Oneofs {
		f, v, err := OneofGet(sv, o)
		if err != nil {
			return nil, err
		}
		if f != nil {
			fields = append(fields, numbered{f, v})
		}
	}
	sort.SliceStable(fields, func(i, j int) bool { return fields[i].f.Number < fields[j].f.Number })
	for _, nf := range fields {
		if b, err = appendField(b, nf.f, nf.v); err != nil {
			return nil, err
		}
	}
	return b, nil
}

func appendField(b []byte, f *Field, v reflect.Value) ([]byte, error) {
	var err error
	switch {
	case f.Map:
		if v.Len() == 0 {
			return b, nil
		}
		keys := v.MapKeys()
		sortKeys(keys)
		for _, k := range keys {
			var entry []byte
			if entry, err = appendValue(entry, f.Key, k, true); err != nil {
				return nil, err
			}
			if entry, err = appendValue(entry, f.Value, v.MapIndex(k), true); err != nil {
				return nil, err
			}
			b = appendTag(b, f.Number, wireBytes)
			b = appendVarint(b, uint64(len(entry)))
			b = append(b, entry...)
		}
		return b, nil
	case f.Repeated:
		n := v.Len()
		if n == 0 {
			return b, nil
		}
		if packable(f.Kind) {
			var packed []byte
			for i := range n {
				packed = appendScalar(packed, f.Kind, v.Index(i))
			}
			b = appendTag(b, f.Number, wireBytes)
			b = appendVarint(b, uint64(len(packed)))
			return append(b, packed...), nil
		}
		for i := range n {
			if b, err = appendValue(b, f, v.Index(i), true); err != nil {
				return nil, err
			}
		}
		return b, nil
	case f.Optional:
		if v.IsNil() {
			return b, nil
		}
		return appendValue(b, f, v.Elem(), true)
	}
	return appendValue(b, f, v, f.Oneof != nil)
}

// appendValue appends one value of f with its tag; implicit-presence zero values are skipped
// unless always.
func appendValue(b []byte, f *Field, v reflect.Value, always bool) ([]byte, error) {
	if f.Kind == MessageKind {
		if v.IsNil() {
			if !always || f.Oneof == nil {
				return b, nil
			}
		}
		var body []byte
		if !v.IsNil() {
			var err error
			if body, err = appendMessage(nil, v.Elem()); err != nil {
				return nil, err
			}
		}
		b = appendTag(b, f.Number, wireBytes)
		b = appendVarint(b, uint64(len(body)))
		return append(b, body...), nil
	}
	if !always && v.IsZero() {
		return b, nil
	}
	switch f.Kind {
	case StringKind, BytesKind:
		b = appendTag(b, f.Number, wireBytes)
		b = appendVarint(b, uint64(v.Len()))
		if f.Kind == StringKind {
			return append(b, v.String()...), nil
		}
		return append(b, v.Bytes()...), nil
	}
	b = appendTag(b, f.Number, wireTypeOf(f.Kind))
	return appendScalar(b, f.Kind, v), nil
}

func packable(k Kind) bool { return k != StringKind && k != BytesKind && k != MessageKind }

func wireTypeOf(k Kind) int {
	switch k {
	case Fixed32Kind, Sfixed32Kind, FloatKind:
		return wireFixed32
	case Fixed64Kind, Sfixed64Kind, DoubleKind:
		return wireFixed64
	case StringKind, BytesKind, MessageKind:
		return wireBytes
	}
	return wireVarint
}

func appendScalar(b []byte, k Kind, v reflect.Value) []byte {
	switch k {
	case BoolKind:
		if v.Bool() {
			return append(b, 1)
		}
		return append(b, 0)
	case Int32Kind, Int64Kind, EnumKind:
		return appendVarint(b, uint64(v.Int()))
	case Uint32Kind, Uint64Kind:
		return appendVarint(b, v.Uint())
	case Sint32Kind, Sint64Kind:
		n := v.Int()
		return appendVarint(b, uint64(n<<1)^uint64(n>>63))
	case Fixed32Kind:
		return appendFixed32(b, uint32(v.Uint()))
	case Sfixed32Kind:
		return appendFixed32(b, uint32(int32(v.Int())))
	case FloatKind:
		return appendFixed32(b, math.Float32bits(float32(v.Float())))
	case Fixed64Kind:
		return appendFixed64(b, v.Uint())
	case Sfixed64Kind:
		return appendFixed64(b, uint64(v.Int()))
	case DoubleKind:
		return appendFixed64(b, math.Float64bits(v.Float()))
	}
	return b
}

func appendTag(b []byte, n int32, wire int) []byte { return appendVarint(b, uint64(n)<<3|uint64(wire)) }

func appendVarint(b []byte, x uint64) []byte {
	for x >= 0x80 {
		b = append(b, byte(x)|0x80)
		x >>= 7
	}
	return append(b, byte(x))
}

func appendFixed32(b []byte, x uint32) []byte {
	return append(b, byte(x), byte(x>>8), byte(x>>16), byte(x>>24))
}

func appendFixed64(b []byte, x uint64) []byte {
	return append(b, byte(x), byte(x>>8), byte(x>>16), byte(x>>24), byte(x>>32), byte(x>>40), byte(x>>48), byte(x>>56))
}

func sortKeys(keys []reflect.Value) {
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		switch a.Kind() {
		case reflect.String:
			return a.String() < b.String()
		case reflect.Bool:
			return !a.Bool() && b.Bool()
		case reflect.Int32, reflect.Int64:
			return a.Int() < b.Int()
		case reflect.Uint32, reflect.Uint64:
			return a.Uint() < b.Uint()
		}
		return false
	})
}

// ---- decoding ------------------------------------------------------------------------------------

// Unmarshal decodes b into the message m points to; without merge, m is reset first.
func Unmarshal(b []byte, m reflect.Value, merge bool) error {
	if m.Kind() != reflect.Pointer || m.Type().Elem().Kind() != reflect.Struct || m.IsNil() {
		return fmt.Errorf("proto: Unmarshal needs a non-nil message pointer, got %s", m.Type())
	}
	if !merge {
		m.Elem().Set(reflect.Zero(m.Type().Elem()))
	}
	return decodeMessage(b, m.Elem())
}

type decoder struct {
	b []byte
}

func (d *decoder) varint() (uint64, error) {
	var x uint64
	for shift := uint(0); shift < 64; shift += 7 {
		if len(d.b) == 0 {
			return 0, ErrTruncated
		}
		c := d.b[0]
		d.b = d.b[1:]
		x |= uint64(c&0x7f) << shift
		if c < 0x80 {
			return x, nil
		}
	}
	return 0, ErrTruncated
}

func (d *decoder) fixed(n int) (uint64, error) {
	if len(d.b) < n {
		return 0, ErrTruncated
	}
	var x uint64
	for i := range n {
		x |= uint64(d.b[i]) << (8 * i)
	}
	d.b = d.b[n:]
	return x, nil
}

func (d *decoder) bytes() ([]byte, error) {
	n, err := d.varint()
	if err != nil {
		return nil, err
	}
	if uint64(len(d.b)) < n {
		return nil, ErrTruncated
	}
	out := d.b[:n]
	d.b = d.b[n:]
	return out, nil
}

func (d *decoder) skip(wire int) error {
	var err error
	switch wire {
	case wireVarint:
		_, err = d.varint()
	case wireFixed64:
		_, err = d.fixed(8)
	case wireFixed32:
		_, err = d.fixed(4)
	case wireBytes:
		_, err = d.bytes()
	default:
		err = ErrTruncated
	}
	return err
}

// raw reads one value of the given wire type as an integer, or a byte slice for wireBytes.
func (d *decoder) raw(wire int) (uint64, []byte, error) {
	switch wire {
	case wireVarint:
		x, err := d.varint()
		return x, nil, err
	case wireFixed64:
		x, err := d.fixed(8)
		return x, nil, err
	case wireFixed32:
		x, err := d.fixed(4)
		return x, nil, err
	case wireBytes:
		b, err := d.bytes()
		return 0, b, err
	}
	return 0, nil, ErrTruncated
}

func decodeMessage(b []byte, sv reflect.Value) error {
	info, err := Info(sv.Type())
	if err != nil {
		return err
	}
	d := &decoder{b: b}
	for len(d.b) > 0 {
		tag, err := d.varint()
		if err != nil {
			return err
		}
		num, wire := int32(tag>>3), int(tag&7)
		f := info.ByNumber(num)
		if f == nil {
			if err := d.skip(wire); err != nil {
				return err
			}
			continue
		}
		x, body, err := d.raw(wire)
		if err != nil {
			return err
		}
		if err := decodeField(sv, f, wire, x, body); err != nil {
			return err
		}
	}
	return nil
}

func decodeField(sv reflect.Value, f *Field, wire int, x uint64, body []byte) error {
	switch {
	case f.Oneof != nil:
		slot, err := OneofSet(sv, f)
		if err != nil {
			return err
		}
		return decodeInto(slot, f, wire, x, body)
	case f.Map:
		if wire != wireBytes {
			return ErrTruncated
		}
		mv := sv.Field(f.Index)
		if mv.IsNil() {
			mv.Set(reflect.MakeMap(mv.Type()))
		}
		k := reflect.New(mv.Type().Key()).Elem()
		val := reflect.New(mv.Type().Elem()).Elem()
		d := &decoder{b: body}
		for len(d.b) > 0 {
			tag, err := d.varint()
			if err != nil {
				return err
			}
			ew := int(tag & 7)
			ex, eb, err := d.raw(ew)
			if err != nil {
				return err
			}
			switch tag >> 3 {
			case 1:
				err = decodeInto(k, f.Key, ew, ex, eb)
			case 2:
				err = decodeInto(val, f.Value, ew, ex, eb)
			}
			if err != nil {
				return err
			}
		}
		if f.Value.Kind == MessageKind && val.IsNil() {
			val.Set(reflect.New(val.Type().Elem()))
		}
		mv.SetMapIndex(k, val)
		return nil
	case f.Repeated:
		sl := sv.Field(f.Index)
		if wire == wireBytes && packable(f.Kind) {
			d := &decoder{b: body}
			w := wireTypeOf(f.Kind)
			for len(d.b) > 0 {
				ex, _, err := d.raw(w)
				if err != nil {
					return err
				}
				e := reflect.New(f.Elem).Elem()
				if err := decodeInto(e, f, w, ex, nil); err != nil {
					return err
				}
				sl.Set(reflect.Append(sl, e))
			}
			return nil
		}
		e := reflect.New(f.Elem).Elem()
		if err := decodeInto(e, f, wire, x, body); err != nil {
			return err
		}
		sl.Set(reflect.Append(sl, e))
		return nil
	case f.Optional:
		p := reflect.New(f.Elem)
		if err := decodeInto(p.Elem(), f, wire, x, body); err != nil {
			return err
		}
		sv.Field(f.Index).Set(p)
		return nil
	}
	return decodeInto(sv.Field(f.Index), f, wire, x, body)
}

// decodeInto stores one value into v (a settable value of f's element type).
func decodeInto(v reflect.Value, f *Field, wire int, x uint64, body []byte) error {
	if wire != wireTypeOf(f.Kind) {
		return fmt.Errorf("proto: field %s: wrong wire type %d", f.Name, wire)
	}
	switch f.Kind {
	case MessageKind:
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		return decodeMessage(body, v.Elem())
	case StringKind:
		v.SetString(string(body))
	case BytesKind:
		v.SetBytes(append([]byte{}, body...))
	case BoolKind:
		v.SetBool(x != 0)
	case Int32Kind, EnumKind:
		v.SetInt(int64(int32(x)))
	case Int64Kind:
		v.SetInt(int64(x))
	case Uint32Kind:
		v.SetUint(uint64(uint32(x)))
	case Uint64Kind:
		v.SetUint(x)
	case Sint32Kind, Sint64Kind:
		v.SetInt(int64(x>>1) ^ -int64(x&1))
	case Fixed32Kind:
		v.SetUint(uint64(uint32(x)))
	case Sfixed32Kind:
		v.SetInt(int64(int32(uint32(x))))
	case FloatKind:
		v.SetFloat(float64(math.Float32frombits(uint32(x))))
	case Fixed64Kind:
		v.SetUint(x)
	case Sfixed64Kind:
		v.SetInt(int64(x))
	case DoubleKind:
		v.SetFloat(math.Float64frombits(x))
	}
	return nil
}
