package pbreflect

import (
	"bytes"
	"reflect"
)

// Equal reports whether two message pointers are equal as protobuf defines it: same type, same
// populated fields with equal values (floats by ==, so NaN differs from itself); two nil (invalid)
// messages are equal, a nil and a non-nil one are not.
func Equal(a, b reflect.Value) bool {
	if !a.IsValid() || !b.IsValid() {
		return !a.IsValid() && !b.IsValid()
	}
	if a.Type() != b.Type() {
		return false
	}
	if a.IsNil() || b.IsNil() {
		return a.IsNil() && b.IsNil()
	}
	return equalMessage(a.Elem(), b.Elem())
}

func equalMessage(a, b reflect.Value) bool {
	info, err := Info(a.Type())
	if err != nil {
		return false
	}
	for _, f := range info.Fields {
		if !equalField(f, a.Field(f.Index), b.Field(f.Index)) {
			return false
		}
	}
	for _, o := range info.Oneofs {
		fa, va, errA := OneofGet(a, o)
		fb, vb, errB := OneofGet(b, o)
		if errA != nil || errB != nil {
			return false
		}
		if fa == nil || fb == nil {
			if fa != fb {
				return false
			}
			continue
		}
		if fa.Number != fb.Number || !equalValue(fa, va, vb) {
			return false
		}
	}
	return true
}

func equalField(f *Field, a, b reflect.Value) bool {
	switch {
	case f.Map:
		if a.Len() != b.Len() {
			return false
		}
		it := a.MapRange()
		for it.Next() {
			bv := b.MapIndex(it.Key())
			if !bv.IsValid() || !equalValue(f.Value, it.Value(), bv) {
				return false
			}
		}
		return true
	case f.Repeated:
		if a.Len() != b.Len() {
			return false
		}
		for i := range a.Len() {
			if !equalValue(f, a.Index(i), b.Index(i)) {
				return false
			}
		}
		return true
	case f.Optional:
		if a.IsNil() || b.IsNil() {
			return a.IsNil() == b.IsNil()
		}
		return equalValue(f, a.Elem(), b.Elem())
	}
	return equalValue(f, a, b)
}

func equalValue(f *Field, a, b reflect.Value) bool {
	switch f.Kind {
	case MessageKind:
		if a.IsNil() || b.IsNil() {
			return a.IsNil() == b.IsNil()
		}
		return equalMessage(a.Elem(), b.Elem())
	case BytesKind:
		return bytes.Equal(a.Bytes(), b.Bytes())
	case FloatKind, DoubleKind:
		return a.Float() == b.Float()
	case StringKind:
		return a.String() == b.String()
	case BoolKind:
		return a.Bool() == b.Bool()
	case Uint32Kind, Uint64Kind, Fixed32Kind, Fixed64Kind:
		return a.Uint() == b.Uint()
	}
	return a.Int() == b.Int()
}
