package protogen

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"leetbuild/goruntime/yaegitest"
)

const richProto = `syntax = "proto3";

package shop.v1;

option go_package = "shop/gen/shop;shopv1";

import "common.proto";

// Every shape the generator handles.
message Order {
  enum Status {
    STATUS_UNSPECIFIED = 0;
    STATUS_OPEN = 1;
    STATUS_SHIPPED = 2;
  }
  message Line {
    string sku = 1;
    uint32 qty = 2;
    sint64 delta = 3;
  }
  string order_id = 1;
  Status status = 2;
  repeated Line lines = 3;
  map<string, Line> by_sku = 4;
  map<int32, string> notes = 5;
  optional string coupon = 6;
  repeated Status history = 7;
  common.Money total = 8;
  oneof payment {
    string card_token = 9;
    common.Money credit = 10;
    Status forced = 11;
  }
  bytes blob = 12;
  double weight = 13;
  fixed64 checksum = 14;
  repeated int64 ids = 15 [packed = true];
  bool gift = 16;
}

service Orders {
  rpc Get(GetRequest) returns (Order);
  rpc Watch(GetRequest) returns (stream Order) {}
  rpc Import(stream Order) returns (common.Money);
  rpc Sync(stream Order) returns (stream Order);
}

message GetRequest { string order_id = 1; }
`

const commonProto = `syntax = "proto3";
package common;
message Money {
  string currency = 1;
  int64 cents = 2;
}
enum Unit { UNIT_UNSPECIFIED = 0; UNIT_KG = 1; }
`

func TestGeneratedCodeShape(t *testing.T) {
	out, err := Generate(map[string]string{"shop.proto": richProto, "common.proto": commonProto},
		map[string]string{"common": "shop/gen/common"})
	if err != nil {
		t.Fatal(err)
	}
	space := regexp.MustCompile(`[ \t]+`)
	pbgo := space.ReplaceAllString(out["src/shop/gen/shop/shop.pb.go"], " ")
	grpcgo := space.ReplaceAllString(out["src/shop/gen/shop/shop_grpc.pb.go"], " ")
	for _, want := range []string{
		"package shopv1",
		`OrderId string ` + "`" + `protobuf:"bytes,1,opt,name=order_id,json=orderId,proto3" json:"order_id,omitempty"` + "`",
		"Status Order_Status `protobuf:\"varint,2,opt,name=status,proto3,enum=shop.v1.Order_Status\"",
		"Order_STATUS_OPEN Order_Status = 1",
		"Lines []*Order_Line",
		"BySku map[string]*Order_Line",
		"Coupon *string",
		"Total *common_common.Money",
		"Payment isOrder_Payment `protobuf_oneof:\"payment\"`",
		"type Order_CardToken struct",
		"func (x *Order) GetCoupon() string",
		"func (x *Order) GetCredit() *common_common.Money",
		"Ids []int64 `protobuf:\"varint,15,rep,packed,name=ids,proto3\"",
		`proto.RegisterEnum("shop.v1.Order_Status", Order_Status_name, Order_Status_value)`,
	} {
		if !strings.Contains(pbgo, want) {
			t.Errorf("shop.pb.go lacks %q", want)
		}
	}
	for _, want := range []string{
		`Orders_Get_FullMethodName = "/shop.v1.Orders/Get"`,
		"Watch(ctx context.Context, in *GetRequest, opts ...grpc.CallOption) (Orders_WatchClient, error)",
		"Import(ctx context.Context, opts ...grpc.CallOption) (Orders_ImportClient, error)",
		"CloseAndRecv() (*common_common.Money, error)",
		"SendAndClose(*common_common.Money) error",
		"type Orders_SyncServer interface",
		"mustEmbedUnimplementedOrdersServer()",
		"var Orders_ServiceDesc = grpc.ServiceDesc{",
		"func RegisterOrdersServer(s grpc.ServiceRegistrar, srv OrdersServer)",
	} {
		if !strings.Contains(grpcgo, want) {
			t.Errorf("shop_grpc.pb.go lacks %q", want)
		}
	}
	if _, ok := out["src/shop/gen/common/common.pb.go"]; !ok {
		t.Fatalf("no common.pb.go in %v", keys(out))
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestGeneratedCodeRunsUnderYaegi(t *testing.T) {
	out, err := Generate(map[string]string{"shop.proto": richProto, "common.proto": commonProto},
		map[string]string{"common": "shop/gen/common"})
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"src/main/main.go": `package main

import (
	"fmt"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	common "shop/gen/common"
	pb "shop/gen/shop"
)

func order() *pb.Order {
	coupon := "SAVE"
	return &pb.Order{
		OrderId: "o-1",
		Status:  pb.Order_STATUS_SHIPPED,
		Lines:   []*pb.Order_Line{{Sku: "a", Qty: 2, Delta: -5}},
		BySku:   map[string]*pb.Order_Line{"a": {Sku: "a", Qty: 2}},
		Notes:   map[int32]string{3: "fragile"},
		Coupon:  &coupon,
		History: []pb.Order_Status{pb.Order_STATUS_OPEN, pb.Order_STATUS_SHIPPED},
		Total:   &common.Money{Currency: "EUR", Cents: 1250},
		Payment: &pb.Order_Credit{Credit: &common.Money{Currency: "EUR", Cents: 5}},
		Blob:    []byte{1, 2},
		Weight:  1.5,
		Ids:     []int64{1, -2},
		Gift:    true,
	}
}

func Run() string {
	in := order()
	b, err := proto.Marshal(in)
	if err != nil {
		return "marshal: " + err.Error()
	}
	out := &pb.Order{}
	if err := proto.Unmarshal(b, out); err != nil {
		return "unmarshal: " + err.Error()
	}
	if !proto.Equal(in, out) {
		return "binary round trip differs: " + out.String()
	}
	if out.GetCredit().GetCents() != 5 || out.GetCardToken() != "" || out.GetCoupon() != "SAVE" || out.GetStatus().String() != "STATUS_SHIPPED" {
		return "getters: " + out.String()
	}
	j, err := protojson.Marshal(in)
	if err != nil {
		return "json: " + err.Error()
	}
	back := &pb.Order{}
	if err := protojson.Unmarshal(j, back); err != nil {
		return "json back: " + err.Error()
	}
	if !proto.Equal(in, back) {
		return "json round trip differs: " + string(j)
	}
	forced := &pb.Order{Payment: &pb.Order_Forced{Forced: pb.Order_STATUS_OPEN}}
	b, _ = proto.Marshal(forced)
	f2 := &pb.Order{}
	_ = proto.Unmarshal(b, f2)
	if f2.GetForced() != pb.Order_STATUS_OPEN {
		return "enum oneof"
	}
	var nilOrder *pb.Order
	if nilOrder.GetOrderId() != "" || nilOrder.GetLines() != nil || nilOrder.GetCredit() != nil {
		return "nil getters"
	}
	if pb.Order_Status(7).String() != "7" || common.Unit_UNIT_KG.String() != "UNIT_KG" {
		return "enum String"
	}
	return fmt.Sprint(string(j))
}

func main() {}
`}
	for p, src := range out {
		files[p] = src
	}
	i, err := yaegitest.Compile(files)
	if err != nil {
		t.Fatal(err)
	}
	run, err := i.Func("Run")
	if err != nil {
		t.Fatal(err)
	}
	got := run.Call(nil)[0].Interface().(string)
	want := `{"orderId":"o-1","status":"STATUS_SHIPPED","lines":[{"sku":"a","qty":2,"delta":"-5"}],"bySku":{"a":{"sku":"a","qty":2}},"notes":{"3":"fragile"},"coupon":"SAVE","history":["STATUS_OPEN","STATUS_SHIPPED"],"total":{"currency":"EUR","cents":"1250"},"credit":{"currency":"EUR","cents":"5"},"blob":"AQI=","weight":1.5,"ids":["1","-2"],"gift":true}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestGenerateErrors(t *testing.T) {
	for _, c := range []struct{ src, want string }{
		{`syntax = "proto2"; message A {}`, "only proto3"},
		{`syntax = "proto3"; import "google/protobuf/timestamp.proto"; message A {}`, "not among the files given"},
		{`syntax = "proto3"; message A { Missing m = 1; }`, "unknown type Missing"},
		{`syntax = "proto3"; enum E { E_ONE = 1; }`, "first value must be 0"},
		{`syntax = "proto3"; message A { string x = 1 }`, `expected ";"`},
	} {
		_, err := Generate(map[string]string{"a.proto": c.src}, map[string]string{"a": "a/gen/a"})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.src, err, c.want)
		}
	}
}

// Every course .proto generates (the yaegi compile of each is in models/grpc's course tests).
func TestEveryCourseProtoGenerates(t *testing.T) {
	paths, err := filepath.Glob("../../src/data/problems/*/proto/*.proto")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no course protos: %v", err)
	}
	byDir := map[string]map[string]string{}
	for _, p := range paths {
		src, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		dir := filepath.Dir(p)
		if byDir[dir] == nil {
			byDir[dir] = map[string]string{}
		}
		byDir[dir][filepath.Base(p)] = string(src)
	}
	for dir, files := range byDir {
		paths := map[string]string{}
		for name := range files {
			stem := strings.TrimSuffix(name, ".proto")
			paths[stem] = "course/gen/" + stem
		}
		if _, err := Generate(files, paths); err != nil {
			t.Errorf("%s: %v", dir, err)
		}
	}
}
