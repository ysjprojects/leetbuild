//go:build js

// Command wasm is the Go runtime compiled to WebAssembly (public/go/runtime.wasm.gz). It wires the
// world to the JavaScript side (globalThis.__lbGo, from src/lib/runtime/go.ts) and exposes
// globalThis.__lbGoRuntime:
//
//	run(jobJSON, checkId) → Promise<resultJSON>   one check of a RunJob (host.Job → host.Result)
//	metrics() → JSON                              the Go-side resources' counters for the last check
package main

import (
	"encoding/json"
	"syscall/js"

	"leetbuild/goruntime/host"
	"leetbuild/goruntime/jsworld"
	"leetbuild/goruntime/models/grpc"
	"leetbuild/goruntime/models/kafka"
	"leetbuild/goruntime/models/netx"
	"leetbuild/goruntime/protogen"
)

func main() {
	jsworld.Install(js.Global().Get("__lbGo"))
	wire()
	api := js.Global().Get("Object").New()
	api.Set("run", js.FuncOf(func(_ js.Value, args []js.Value) any {
		jobJSON, id := args[0].String(), args[1].String()
		return promise(func() string {
			var job host.Job
			if err := json.Unmarshal([]byte(jobJSON), &job); err != nil {
				return encode(host.Result{ID: id, Message: "the runtime received a malformed job: " + err.Error()})
			}
			return encode(host.RunCheck(&job, id))
		})
	}))
	api.Set("metrics", js.FuncOf(func(js.Value, []js.Value) any {
		return encode(host.Metrics())
	}))
	js.Global().Set("__lbGoRuntime", api)
	select {}
}

// wire registers the Go-native models with the host: their per-check reset (grpc.Reset resets the
// in-memory network too), their learner-only counters under the RunMetrics names, the in-memory
// listeners behind interpreted net.Listen, and stub generation from the course's .proto files.
func wire() {
	host.Resets = append(host.Resets, kafka.Reset, grpc.Reset)
	host.MetricHooks = append(host.MetricHooks, func(m map[string]int) {
		m["kafkaProduced"], m["kafkaDelivered"], m["kafkaCommits"] = kafka.Metrics()
		m["grpcCalls"] = grpc.LearnerCalls()
	})
	host.Listen = netx.Listen
	host.GenerateStubs = protogen.Generate
}

func encode(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `{"message":"the runtime could not encode its result"}`
	}
	return string(b)
}

// promise resolves with work's result, computed on its own goroutine (a js.Func must not block).
func promise(work func() string) js.Value {
	var handler js.Func
	handler = js.FuncOf(func(_ js.Value, args []js.Value) any {
		handler.Release()
		resolve := args[0]
		go func() { resolve.Invoke(work()) }()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}
