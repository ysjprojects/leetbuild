// Package pbreflect is what the protobuf and gRPC models share: messages seen through reflection
// over their struct fields and `protobuf` tags (the generated messages are interpreted structs, so
// their methods are invisible to native code), the binary wire format, the protojson mapping and
// the deep copy a message gets when it crosses the in-process "wire".
package pbreflect

import (
	"reflect"
	"unsafe"
)

// An interpreted value of an interpreted interface type (a oneof field, for instance) is stored by
// yaegi as interp.valueInterface{node *node; value reflect.Value}: the node carries the method set,
// the value the dynamic value. Native code reads and rebuilds these through the struct's layout.
const yaegiInterp = "github.com/traefik/yaegi/interp"

func isValueInterface(t reflect.Type) bool {
	return t.Kind() == reflect.Struct && t.Name() == "valueInterface" && t.PkgPath() == yaegiInterp
}

// viValueField is the index of valueInterface's `value reflect.Value` field.
func viValueField(t reflect.Type) int {
	for i := range t.NumField() {
		if f := t.Field(i); f.Name == "value" && f.Type == reflect.TypeOf(reflect.Value{}) {
			return i
		}
	}
	panic("pbreflect: yaegi's valueInterface has no value field")
}

// viGet returns the dynamic value an interpreted interface value holds (invalid when nil).
func viGet(v reflect.Value) reflect.Value {
	c := reflect.New(v.Type()).Elem()
	c.Set(v)
	f := c.Field(viValueField(v.Type()))
	return *(*reflect.Value)(unsafe.Pointer(f.UnsafeAddr()))
}

// viWith returns template (an interpreted interface value) holding inner instead: same node, so the
// interpreter keeps seeing the dynamic type's methods.
func viWith(template, inner reflect.Value) reflect.Value {
	c := reflect.New(template.Type()).Elem()
	c.Set(template)
	f := c.Field(viValueField(template.Type()))
	*(*reflect.Value)(unsafe.Pointer(f.UnsafeAddr())) = inner
	return c
}

// isWrapper reports whether t is a yaegi interface wrapper (a struct whose first field is IValue):
// what native code receives when interpreted code passes a value where a native interface with
// methods is expected (proto.Message).
func isWrapper(t reflect.Type) bool {
	return t.Kind() == reflect.Struct && t.NumField() > 0 && t.Field(0).Name == "IValue" && t.Field(0).Type.Kind() == reflect.Interface
}

// Unwrap returns the concrete value behind v: through interfaces, yaegi interface wrappers and
// interpreted interface values.
func Unwrap(v reflect.Value) reflect.Value {
	for v.IsValid() {
		switch {
		case v.Kind() == reflect.Interface:
			if v.IsNil() {
				return reflect.Value{}
			}
			v = v.Elem()
		case isValueInterface(v.Type()):
			v = viGet(v)
		case isWrapper(v.Type()):
			v = v.Field(0)
		default:
			return v
		}
	}
	return v
}

// Of is Unwrap(reflect.ValueOf(m)).
func Of(m any) reflect.Value { return Unwrap(reflect.ValueOf(m)) }

// Rewrap returns a value of wrapper's type (a yaegi interface wrapper, or anything else) holding
// inner: for a wrapper, a new wrapper around inner whose methods are given by methods (by method
// name); otherwise inner itself.
func Rewrap(wrapper reflect.Type, inner reflect.Value, methods map[string]any) reflect.Value {
	if !isWrapper(wrapper) {
		return inner
	}
	w := reflect.New(wrapper).Elem()
	w.Field(0).Set(inner)
	for i := 1; i < wrapper.NumField(); i++ {
		f := wrapper.Field(i)
		if fn, ok := methods[f.Name[1:]]; ok {
			w.Field(i).Set(reflect.ValueOf(fn))
		}
	}
	return w
}
