package kafkacourse_test

import "testing"

// Interpreted code cancelling a synchronous write to a stalled broker gets ctx.Err() at once.
func TestInterpretedCancelEndsAStalledWrite(t *testing.T) {
	run(t, "app.go", `package main

import "github.com/segmentio/kafka-go"

var w = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "outbox", Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}
`, `package main

import (
	"context"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"
	"leetbuild/harness"
)

func CheckCancel(ctx *harness.Ctx) {
	ctx.Kafka.Stall("outbox")
	c, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(3 * time.Second)
		cancel()
	}()
	start := time.Now()
	err := w.WriteMessages(c, kafka.Message{Key: []byte("k"), Value: []byte("v")})
	ctx.Assert(errors.Is(err, context.Canceled), "got %v", err)
	ctx.Equal(time.Since(start), 3*time.Second, "returns at the cancel")
}
`, "CheckCancel")
}
