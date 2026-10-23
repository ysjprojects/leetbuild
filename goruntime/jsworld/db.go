//go:build js

package jsworld

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"syscall/js"

	"leetbuild/goruntime/models/pq"
)

// jsDB is the driver's backend over the shared JavaScript Db (bridge.db): its single-connection
// lock, its statement path, PGlite behind it.
type jsDB struct{ b js.Value }

// await blocks the calling goroutine until the promise settles (the runtime idles meanwhile, so
// PGlite gets the event loop).
func await(p js.Value) (js.Value, error) {
	type outcome struct {
		v   js.Value
		err error
	}
	ch := make(chan outcome, 1)
	var then, catch js.Func
	then = js.FuncOf(func(_ js.Value, args []js.Value) any {
		then.Release()
		catch.Release()
		v := js.Undefined()
		if len(args) > 0 {
			v = args[0]
		}
		ch <- outcome{v: v}
		return nil
	})
	catch = js.FuncOf(func(_ js.Value, args []js.Value) any {
		then.Release()
		catch.Release()
		msg := "the database call failed"
		if len(args) > 0 {
			msg = js.Global().Get("String").Invoke(args[0]).String()
		}
		ch <- outcome{err: errors.New(msg)}
		return nil
	})
	p.Call("then", then, catch)
	o := <-ch
	return o.v, o.err
}

func (d *jsDB) Hold(ctx context.Context) (func(), error) {
	type held struct {
		release js.Value
		err     error
	}
	ch := make(chan held, 1)
	go func() {
		v, err := await(d.b.Call("hold"))
		ch <- held{v, err}
	}()
	select {
	case h := <-ch:
		if h.err != nil {
			return nil, h.err
		}
		var once sync.Once
		return func() { once.Do(func() { h.release.Invoke() }) }, nil
	case <-ctx.Done():
		// Give the connection back as soon as it is ours.
		go func() {
			if h := <-ch; h.err == nil {
				h.release.Invoke()
			}
		}()
		return nil, ctx.Err()
	}
}

func (d *jsDB) Run(_ context.Context, st pq.BackendStatement) (pq.BackendResult, error) {
	args := js.Global().Get("Array").New(len(st.Args))
	for i, a := range st.Args {
		switch v := a.(type) {
		case nil:
			args.SetIndex(i, js.Null())
		case string:
			args.SetIndex(i, v)
		case []byte:
			arr := js.Global().Get("Uint8Array").New(len(v))
			js.CopyBytesToJS(arr, v)
			args.SetIndex(i, arr)
		}
	}
	v, err := await(d.b.Call("run", st.SQL, args, st.Held, st.Counted))
	if err != nil {
		return pq.BackendResult{}, err
	}
	var reply struct {
		pq.BackendResult
		Error map[string]string `json:"error"`
	}
	if err := json.Unmarshal([]byte(v.String()), &reply); err != nil {
		return pq.BackendResult{}, err
	}
	if reply.Error != nil {
		return pq.BackendResult{}, serverError(reply.Error)
	}
	return reply.BackendResult, nil
}

func (d *jsDB) Reset(schema string) error {
	_, err := await(d.b.Call("reset", schema))
	return err
}

// serverError is the server's error fields as lib/pq reports them; without a SQLSTATE it is a
// plain error (the database was not reachable).
func serverError(f map[string]string) error {
	if f["code"] == "" {
		return errors.New(f["message"])
	}
	return &pq.Error{
		Severity: f["severity"], Code: pq.ErrorCode(f["code"]), Message: f["message"], Detail: f["detail"],
		Hint: f["hint"], Position: f["position"], InternalPosition: f["internalPosition"],
		InternalQuery: f["internalQuery"], Where: f["where"], Schema: f["schema"], Table: f["table"],
		Column: f["column"], DataTypeName: f["dataType"], Constraint: f["constraint"], File: f["file"],
		Line: f["line"], Routine: f["routine"],
	}
}
