// Package proto is google.golang.org/protobuf/proto for the in-process runtime: the binary wire
// format, equality, cloning and merging over the plain message structs leetbuild's protogen
// generates (exported fields carrying protoc-gen-go's `protobuf` tags; no protoimpl state).
//
// Generated messages implement Message (ProtoMessage, Reset, String). The encoding is the real
// protobuf binary format, fields by number, map entries by key.
package proto

import (
	"errors"
	"reflect"

	"leetbuild/goruntime/models/internal/pbreflect"
)

// Message is a generated message.
type Message interface {
	ProtoMessage()
	Reset()
	String() string
}

// Error matches every error this package returns (errors.Is(err, proto.Error)).
var Error = errors.New("proto: error")

type protoError struct{ err error }

func (e *protoError) Error() string        { return e.err.Error() }
func (e *protoError) Unwrap() error        { return e.err }
func (e *protoError) Is(target error) bool { return target == Error }

func wrap(err error) error {
	if err == nil {
		return nil
	}
	return &protoError{err}
}

// message is the pointer behind m, or an error when m is not a message pointer.
func message(m any) (reflect.Value, error) {
	v := pbreflect.Of(m)
	if !v.IsValid() {
		return v, wrap(errors.New("proto: nil message"))
	}
	if !pbreflect.IsMessage(v.Type()) {
		return v, wrap(errors.New("proto: " + v.Type().String() + " is not a message pointer"))
	}
	return v, nil
}

// MarshalOptions configures Marshal.
type MarshalOptions struct {
	AllowPartial  bool
	Deterministic bool // map entries are always written in key order
	UseCachedSize bool
}

// Marshal returns the wire-format encoding of m.
func Marshal(m Message) ([]byte, error) { return MarshalOptions{}.Marshal(m) }

// Marshal returns the wire-format encoding of m.
func (o MarshalOptions) Marshal(m Message) ([]byte, error) {
	if m == nil {
		return nil, nil
	}
	v, err := message(m)
	if err != nil {
		return nil, err
	}
	b, err := pbreflect.Marshal(v)
	return b, wrap(err)
}

// MarshalAppend appends the wire-format encoding of m to b.
func (o MarshalOptions) MarshalAppend(b []byte, m Message) ([]byte, error) {
	out, err := o.Marshal(m)
	if err != nil {
		return b, err
	}
	return append(b, out...), nil
}

// Size returns the size in bytes of m's encoding.
func (o MarshalOptions) Size(m Message) int {
	b, _ := o.Marshal(m)
	return len(b)
}

// Size returns the size in bytes of m's encoding.
func Size(m Message) int { return MarshalOptions{}.Size(m) }

// UnmarshalOptions configures Unmarshal.
type UnmarshalOptions struct {
	Merge          bool // keep m's fields, as Merge does, instead of resetting m first
	AllowPartial   bool
	DiscardUnknown bool // unknown fields are always dropped: generated messages keep none
	RecursionLimit int
}

// Unmarshal parses the wire-format message in b into m (reset first).
func Unmarshal(b []byte, m Message) error { return UnmarshalOptions{}.Unmarshal(b, m) }

// Unmarshal parses the wire-format message in b into m.
func (o UnmarshalOptions) Unmarshal(b []byte, m Message) error {
	v, err := message(m)
	if err != nil {
		return err
	}
	if v.IsNil() {
		return wrap(errors.New("proto: Unmarshal into a nil message"))
	}
	return wrap(pbreflect.Unmarshal(b, v, o.Merge))
}

// Equal reports whether x and y are equal messages (see google.golang.org/protobuf/proto.Equal).
func Equal(x, y Message) bool {
	vx, vy := pbreflect.Of(x), pbreflect.Of(y)
	if vx.IsValid() && vx.Kind() == reflect.Pointer && vx.IsNil() {
		vx = reflect.Value{}
	}
	if vy.IsValid() && vy.Kind() == reflect.Pointer && vy.IsNil() {
		vy = reflect.Value{}
	}
	if vx.IsValid() != vy.IsValid() || (vx.IsValid() && vx.Type() != vy.Type()) {
		return false
	}
	return pbreflect.Equal(vx, vy)
}

// Clone returns a deep copy of m (nil for nil).
func Clone(m Message) Message {
	if m == nil {
		return nil
	}
	v := pbreflect.Of(m)
	if !v.IsValid() || !pbreflect.IsMessage(v.Type()) {
		return nil
	}
	c := pbreflect.DeepCopy(v)
	// An interpreted message reached us inside a yaegi interface wrapper: hand the copy back in a
	// wrapper of the same type, so `proto.Clone(m).(*pb.T)` works in the interpreter.
	return pbreflect.Rewrap(reflect.TypeOf(m), c, wrapperMethods(c)).Interface().(Message)
}

// wrapperMethods are the Message methods of an interpreted message, natively.
func wrapperMethods(v reflect.Value) map[string]any {
	return map[string]any{
		"ProtoMessage": func() {},
		"Reset":        func() { v.Elem().Set(reflect.Zero(v.Type().Elem())) },
		"String": func() string {
			b, _ := pbreflect.MarshalJSON(v, pbreflect.JSONOptions{})
			return string(b)
		},
	}
}

// Merge merges src into dst: populated scalar fields overwrite, repeated fields append, maps merge
// and messages merge recursively — what decoding src's encoding over dst does.
func Merge(dst, src Message) {
	d, err := message(dst)
	if err != nil {
		panic(err)
	}
	s, err := message(src)
	if err != nil {
		panic(err)
	}
	b, err := pbreflect.Marshal(s)
	if err != nil {
		panic(err)
	}
	if err := pbreflect.Unmarshal(b, d, true); err != nil {
		panic(err)
	}
}

// Reset clears every field of m.
func Reset(m Message) {
	v, err := message(m)
	if err != nil || v.IsNil() {
		return
	}
	v.Elem().Set(reflect.Zero(v.Type().Elem()))
}

// CheckInitialized returns nil: proto3 messages have no required fields.
func CheckInitialized(m Message) error { return nil }

// Bool stores v in a new bool and returns a pointer to it (proto3 optional fields).
func Bool(v bool) *bool { return new(v) }

// Int32 stores v in a new int32 and returns a pointer to it.
func Int32(v int32) *int32 { return new(v) }

// Int64 stores v in a new int64 and returns a pointer to it.
func Int64(v int64) *int64 { return new(v) }

// Uint32 stores v in a new uint32 and returns a pointer to it.
func Uint32(v uint32) *uint32 { return new(v) }

// Uint64 stores v in a new uint64 and returns a pointer to it.
func Uint64(v uint64) *uint64 { return new(v) }

// Float32 stores v in a new float32 and returns a pointer to it.
func Float32(v float32) *float32 { return new(v) }

// Float64 stores v in a new float64 and returns a pointer to it.
func Float64(v float64) *float64 { return new(v) }

// String stores v in a new string and returns a pointer to it.
func String(v string) *string { return new(v) }

// RegisterEnum records a generated enum's names, for the JSON mapping (as golang/protobuf's
// RegisterEnum did). Generated code calls it from init.
func RegisterEnum(typeName string, nameMap map[int32]string, valueMap map[string]int32) {
	pbreflect.RegisterEnum(typeName, nameMap, valueMap)
}

// RegisterOneofWrappers records a generated message's oneof wrapper types, from sample messages
// each holding one member (a typed nil wrapper is enough); decoding a oneof needs them. Generated
// code calls it from init, in place of protoc-gen-go's XXX_OneofWrappers.
func RegisterOneofWrappers(samples ...any) {
	if err := pbreflect.RegisterOneofWrappers(samples...); err != nil {
		panic(err)
	}
}
