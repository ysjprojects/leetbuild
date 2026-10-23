package netx

import (
	"io"
	"strings"
	"testing"
)

func TestListenDialAccept(t *testing.T) {
	t.Cleanup(Reset)
	lis, err := Listen("tcp", ":50051")
	if err != nil {
		t.Fatal(err)
	}
	if lis.Addr().String() != "[::]:50051" {
		t.Fatalf("addr %s", lis.Addr())
	}
	for _, addr := range []string{"localhost:50051", "0.0.0.0:50051", "notes:50051", "127.0.0.1:50051"} {
		if _, ok := Lookup("tcp", addr); !ok {
			t.Fatalf("%s does not reach :50051", addr)
		}
	}
	if _, err := Listen("tcp", "0.0.0.0:50051"); err == nil || !strings.Contains(err.Error(), "address already in use") {
		t.Fatalf("second Listen: %v", err)
	}
	client, err := Dial("tcp", "svc:50051")
	if err != nil {
		t.Fatal(err)
	}
	server, err := lis.Accept()
	if err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = client.Write([]byte("ping")); _ = client.Close() }()
	got, _ := io.ReadAll(server)
	if string(got) != "ping" {
		t.Fatalf("read %q", got)
	}
	_ = lis.Close()
	if _, err := lis.Accept(); err == nil {
		t.Fatal("Accept after Close must fail")
	}
	if _, err := Dial("tcp", "svc:50051"); err == nil {
		t.Fatal("Dial after Close must fail")
	}
	if _, err := Listen("tcp", ":50051"); err != nil {
		t.Fatalf("the port is free again: %v", err)
	}
}

func TestEphemeralAndUnix(t *testing.T) {
	t.Cleanup(Reset)
	a, _ := Listen("tcp", ":0")
	b, _ := Listen("tcp", "localhost:0")
	if a.Addr().String() == b.Addr().String() {
		t.Fatalf("port 0 handed out %s twice", a.Addr())
	}
	u, err := Listen("unix", "/tmp/app.sock")
	if err != nil || u.Addr().String() != "/tmp/app.sock" {
		t.Fatalf("unix: %v %v", u, err)
	}
	if _, err := Listen("udp", ":1"); err == nil {
		t.Fatal("udp is not supported")
	}
}
