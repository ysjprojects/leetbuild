package pbreflect

import (
	"fmt"
	"reflect"
)

// DeepCopy returns a deep copy of v: pointers, structs, slices, maps and interface values (native
// and interpreted) are copied, so nothing the copy holds is shared with v.
func DeepCopy(v reflect.Value) reflect.Value {
	if !v.IsValid() {
		return v
	}
	t := v.Type()
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return reflect.Zero(t)
		}
		n := reflect.New(t.Elem())
		n.Elem().Set(DeepCopy(v.Elem()))
		return n
	case reflect.Struct:
		if isValueInterface(t) {
			inner := viGet(v)
			if !inner.IsValid() {
				return v
			}
			return viWith(v, DeepCopy(inner))
		}
		n := reflect.New(t).Elem()
		for i := range t.NumField() {
			if f := n.Field(i); f.CanSet() {
				f.Set(DeepCopy(v.Field(i)))
			}
		}
		return n
	case reflect.Interface:
		if v.IsNil() {
			return reflect.Zero(t)
		}
		n := reflect.New(t).Elem()
		n.Set(DeepCopy(v.Elem()))
		return n
	case reflect.Slice:
		if v.IsNil() {
			return reflect.Zero(t)
		}
		n := reflect.MakeSlice(t, v.Len(), v.Len())
		if t.Elem().Kind() == reflect.Uint8 {
			reflect.Copy(n, v)
			return n
		}
		for i := range v.Len() {
			n.Index(i).Set(DeepCopy(v.Index(i)))
		}
		return n
	case reflect.Array:
		n := reflect.New(t).Elem()
		for i := range v.Len() {
			n.Index(i).Set(DeepCopy(v.Index(i)))
		}
		return n
	case reflect.Map:
		if v.IsNil() {
			return reflect.Zero(t)
		}
		n := reflect.MakeMapWithSize(t, v.Len())
		it := v.MapRange()
		for it.Next() {
			n.SetMapIndex(DeepCopy(it.Key()), DeepCopy(it.Value()))
		}
		return n
	}
	return v
}

// Transfer is a message crossing the wire: dst (a message pointer) gets a copy of src's content.
// Same types copy deeply; different message types go through the binary encoding, as a real
// receiver would decode bytes into its own type. dst is reset first.
func Transfer(dst, src any) error {
	d := Of(dst)
	if !d.IsValid() || d.Kind() != reflect.Pointer || d.IsNil() {
		return fmt.Errorf("grpc: error while unmarshaling: destination %T is not a non-nil pointer", dst)
	}
	s := Of(src)
	if !s.IsValid() || (s.Kind() == reflect.Pointer && s.IsNil()) {
		d.Elem().Set(reflect.Zero(d.Type().Elem()))
		return nil
	}
	if s.Type() == d.Type() {
		d.Elem().Set(DeepCopy(s.Elem()))
		return nil
	}
	if s.Type() == d.Type().Elem() {
		d.Elem().Set(DeepCopy(s))
		return nil
	}
	b, err := Marshal(s)
	if err != nil {
		return fmt.Errorf("grpc: error while marshaling: %w", err)
	}
	if err := Unmarshal(b, d, false); err != nil {
		return fmt.Errorf("grpc: error while unmarshaling: %w", err)
	}
	return nil
}
