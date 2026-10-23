// Package protojson is google.golang.org/protobuf/encoding/protojson for the in-process runtime:
// the protobuf JSON mapping over leetbuild's generated message structs (lowerCamelCase names,
// 64-bit integers as strings, enums by name, bytes as base64, unpopulated fields omitted).
// Output is compact (the real package randomises its whitespace; never compare bytes).
package protojson

import (
	"errors"

	"leetbuild/goruntime/models/internal/pbreflect"
	"leetbuild/goruntime/models/protobuf/proto"
)

// MarshalOptions configures Marshal.
type MarshalOptions struct {
	Multiline         bool
	Indent            string
	AllowPartial      bool
	UseProtoNames     bool
	UseEnumNumbers    bool
	EmitUnpopulated   bool
	EmitDefaultValues bool
}

// Marshal renders m in the protobuf JSON format.
func Marshal(m proto.Message) ([]byte, error) { return MarshalOptions{}.Marshal(m) }

// Format renders m as JSON for humans (multi-line), "{}" for nil.
func Format(m proto.Message) string { return MarshalOptions{Multiline: true}.Format(m) }

// Format renders m with these options, "" on failure.
func (o MarshalOptions) Format(m proto.Message) string {
	if m == nil {
		return "{}"
	}
	b, err := o.Marshal(m)
	if err != nil {
		return ""
	}
	return string(b)
}

// Marshal renders m in the protobuf JSON format.
func (o MarshalOptions) Marshal(m proto.Message) ([]byte, error) {
	if m == nil {
		return []byte("{}"), nil
	}
	v := pbreflect.Of(m)
	if !v.IsValid() || !pbreflect.IsMessage(v.Type()) {
		return nil, errors.New("protojson: not a message pointer")
	}
	return pbreflect.MarshalJSON(v, pbreflect.JSONOptions{
		Multiline:       o.Multiline,
		Indent:          o.Indent,
		UseProtoNames:   o.UseProtoNames,
		UseEnumNumbers:  o.UseEnumNumbers,
		EmitUnpopulated: o.EmitUnpopulated || o.EmitDefaultValues,
	})
}

// UnmarshalOptions configures Unmarshal.
type UnmarshalOptions struct {
	AllowPartial   bool
	DiscardUnknown bool
	RecursionLimit int
}

// Unmarshal parses JSON into m (reset first); field names may be the JSON or the proto names.
func Unmarshal(b []byte, m proto.Message) error { return UnmarshalOptions{}.Unmarshal(b, m) }

// Unmarshal parses JSON into m (reset first).
func (o UnmarshalOptions) Unmarshal(b []byte, m proto.Message) error {
	v := pbreflect.Of(m)
	if !v.IsValid() || !pbreflect.IsMessage(v.Type()) || v.IsNil() {
		return errors.New("protojson: Unmarshal needs a non-nil message pointer")
	}
	return pbreflect.UnmarshalJSON(b, v, o.DiscardUnknown)
}
