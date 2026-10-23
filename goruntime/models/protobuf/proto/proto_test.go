package proto_test

import (
	"bytes"
	"encoding/hex"
	"math"
	"strings"
	"testing"

	"leetbuild/goruntime/models/protobuf/proto"
	"leetbuild/goruntime/models/protobuf/protojson"
)

// Native stand-ins for generated messages (the same tags protogen writes).

type Kind int32

const (
	Kind_UNKNOWN Kind = 0
	Kind_BOOK    Kind = 1
)

var (
	Kind_name  = map[int32]string{0: "UNKNOWN", 1: "BOOK"}
	Kind_value = map[string]int32{"UNKNOWN": 0, "BOOK": 1}
)

type Inner struct {
	Id string `protobuf:"bytes,1,opt,name=id,proto3" json:"id,omitempty"`
}

func (x *Inner) Reset()         { *x = Inner{} }
func (x *Inner) String() string { return protojson.Format(x) }
func (*Inner) ProtoMessage()    {}

type isAll_Choice interface{ isAll_Choice() }

type All_Name struct {
	Name string `protobuf:"bytes,20,opt,name=name,proto3,oneof"`
}

type All_Ref struct {
	Ref *Inner `protobuf:"bytes,21,opt,name=ref,proto3,oneof"`
}

func (*All_Name) isAll_Choice() {}
func (*All_Ref) isAll_Choice()  {}

type All struct {
	PageSize int32             `protobuf:"varint,1,opt,name=page_size,json=pageSize,proto3" json:"page_size,omitempty"`
	Count    int64             `protobuf:"varint,2,opt,name=count,proto3" json:"count,omitempty"`
	Big      uint64            `protobuf:"varint,3,opt,name=big,proto3" json:"big,omitempty"`
	Ids      []int32           `protobuf:"varint,4,rep,packed,name=ids,proto3" json:"ids,omitempty"`
	Neg      int32             `protobuf:"zigzag32,5,opt,name=neg,proto3" json:"neg,omitempty"`
	Score    float32           `protobuf:"fixed32,6,opt,name=score,proto3" json:"score,omitempty"`
	Ratio    float64           `protobuf:"fixed64,7,opt,name=ratio,proto3" json:"ratio,omitempty"`
	Data     []byte            `protobuf:"bytes,8,opt,name=data,proto3" json:"data,omitempty"`
	Kind     Kind              `protobuf:"varint,9,opt,name=kind,proto3,enum=test.Kind" json:"kind,omitempty"`
	Attrs    map[string]string `protobuf:"bytes,10,rep,name=attrs,proto3" json:"attrs,omitempty" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3"`
	Items    []*Inner          `protobuf:"bytes,11,rep,name=items,proto3" json:"items,omitempty"`
	Child    *Inner            `protobuf:"bytes,12,opt,name=child,proto3" json:"child,omitempty"`
	Opt      *string           `protobuf:"bytes,13,opt,name=opt,proto3,oneof" json:"opt,omitempty"`
	Flag     bool              `protobuf:"varint,14,opt,name=flag,proto3" json:"flag,omitempty"`
	Byid     map[int64]*Inner  `protobuf:"bytes,15,rep,name=byid,proto3" json:"byid,omitempty" protobuf_key:"varint,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3"`
	Choice   isAll_Choice      `protobuf_oneof:"choice"`
}

func (x *All) Reset()         { *x = All{} }
func (x *All) String() string { return protojson.Format(x) }
func (*All) ProtoMessage()    {}

func init() {
	proto.RegisterEnum("test.Kind", Kind_name, Kind_value)
	proto.RegisterOneofWrappers(&All{Choice: &All_Name{}}, &All{Choice: &All_Ref{}})
}

func full() *All {
	return &All{
		PageSize: 5, Count: -9, Big: math.MaxUint64, Ids: []int32{1, 2, 300}, Neg: -3,
		Score: 1.5, Ratio: 0.25, Data: []byte{0, 1, 2}, Kind: Kind_BOOK,
		Attrs: map[string]string{"b": "2", "a": "1"}, Items: []*Inner{{Id: "x"}, {}},
		Child: &Inner{Id: "c"}, Opt: proto.String(""), Flag: true,
		Byid: map[int64]*Inner{7: {Id: "seven"}}, Choice: &All_Ref{Ref: &Inner{Id: "r"}},
	}
}

func TestWireFormatMatchesProtobuf(t *testing.T) {
	for _, c := range []struct {
		msg  proto.Message
		want string
	}{
		{&All{PageSize: 1000}, "08e807"},
		{&All{Ids: []int32{1, 2, 3}}, "2203010203"},
		{&All{Neg: -1}, "2801"},
		{&All{Count: -1}, "10ffffffffffffffffff01"},
		{&All{Child: &Inner{Id: "hi"}}, "62040a026869"},
		{&All{Opt: proto.String("")}, "6a00"},
		{&All{Choice: &All_Name{Name: ""}}, "a20100"},
		{&All{Attrs: map[string]string{"k": "v"}}, "52060a016b120176"},
		{&All{}, ""},
	} {
		b, err := proto.Marshal(c.msg)
		if err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(b); got != c.want {
			t.Errorf("%+v: got %s, want %s", c.msg, got, c.want)
		}
	}
}

func TestBinaryRoundTrip(t *testing.T) {
	in := full()
	b, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if proto.Size(in) != len(b) {
		t.Fatalf("Size %d, encoding %d", proto.Size(in), len(b))
	}
	out := &All{PageSize: 99, Ids: []int32{42}}
	if err := proto.Unmarshal(b, out); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(in, out) {
		t.Fatalf("round trip differs:\n%v\n%v", in, out)
	}
	if out.Choice.(*All_Ref).Ref.Id != "r" || *out.Opt != "" || out.Byid[7].Id != "seven" {
		t.Fatalf("decoded %+v", out)
	}
	clone := proto.Clone(in).(*All)
	clone.Items[0].Id = "changed"
	if in.Items[0].Id != "x" || !proto.Equal(in, full()) {
		t.Fatal("Clone shares memory with the original")
	}
	if proto.Equal(in, &All{}) || !proto.Equal(&All{}, &All{}) {
		t.Fatal("Equal")
	}
	merged := &All{PageSize: 1, Ids: []int32{9}}
	proto.Merge(merged, &All{Ids: []int32{10}, Count: 3})
	if merged.PageSize != 1 || len(merged.Ids) != 2 || merged.Count != 3 {
		t.Fatalf("Merge: %+v", merged)
	}
	if err := proto.Unmarshal([]byte{0x0a, 0x05, 'a'}, &All{}); err == nil {
		t.Fatal("truncated input must fail")
	}
}

func TestJSONMapping(t *testing.T) {
	b, err := protojson.Marshal(full())
	if err != nil {
		t.Fatal(err)
	}
	want := `{"pageSize":5,"count":"-9","big":"18446744073709551615","ids":[1,2,300],"neg":-3,"score":1.5,"ratio":0.25,"data":"AAEC","kind":"BOOK","attrs":{"a":"1","b":"2"},"items":[{"id":"x"},{}],"child":{"id":"c"},"opt":"","flag":true,"byid":{"7":{"id":"seven"}},"ref":{"id":"r"}}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
	out := &All{}
	if err := protojson.Unmarshal(b, out); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(full(), out) {
		t.Fatalf("JSON round trip differs: %v", out)
	}
	// Proto names, numbers as strings and enum numbers are accepted; unknown fields are not.
	if err := protojson.Unmarshal([]byte(`{"page_size":"7","kind":1,"name":"n"}`), out); err != nil {
		t.Fatal(err)
	}
	if out.PageSize != 7 || out.Kind != Kind_BOOK || out.Choice.(*All_Name).Name != "n" || out.Count != 0 {
		t.Fatalf("got %+v", out)
	}
	if err := protojson.Unmarshal([]byte(`{"nope":1}`), out); err == nil {
		t.Fatal("unknown field must fail")
	}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal([]byte(`{"nope":1,"flag":true}`), out); err != nil || !out.Flag {
		t.Fatalf("DiscardUnknown: %v %+v", err, out)
	}
	opts := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true, UseEnumNumbers: true}
	b, _ = opts.Marshal(&All{PageSize: 2})
	for _, part := range []string{`"page_size":2`, `"count":"0"`, `"ids":[]`, `"child":null`, `"kind":0`, `"attrs":{}`} {
		if !bytes.Contains(b, []byte(part)) {
			t.Errorf("EmitUnpopulated output %s lacks %s", b, part)
		}
	}
	if bytes.Contains(b, []byte(`"opt"`)) || bytes.Contains(b, []byte(`"name"`)) {
		t.Errorf("unset optional and oneof fields are not emitted: %s", b)
	}
	if s := protojson.Format(&Inner{Id: "x"}); !strings.Contains(s, `"id": "x"`) {
		t.Errorf("Format: %s", s)
	}
}
