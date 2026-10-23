package harness

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"

	"leetbuild/goruntime/world"
)

// HTTP sends requests to a handler in process, as a client on the network would.
type HTTP struct {
	ctx     *Ctx
	handler http.Handler
	tls     bool
	remote  string
	// server is the program's server the client talks to (Program.HTTP): its requests count as in
	// flight there, and it refuses them once the server stopped listening. nil for ctx.HTTP(h).
	server *world.HTTPServer
}

// HTTP is a client of any handler (the learner's mux, a constructor's return).
func (c *Ctx) HTTP(h http.Handler) *HTTP {
	return &HTTP{ctx: c, handler: h, remote: "203.0.113.10:51000"}
}

// on binds the client to the program's server s.
func (c *Ctx) on(s *world.HTTPServer) *HTTP {
	h := c.HTTP(s.Handler)
	h.tls, h.server = s.TLS, s
	return h
}

// From is the same client sending from another address (RemoteAddr, "ip:port").
func (h *HTTP) From(remote string) *HTTP {
	c := *h
	c.remote = remote
	return &c
}

// Response is what the handler answered.
type Response struct {
	ctx    *Ctx
	Status int
	Header http.Header
	Body   []byte
}

// Text is the body as text.
func (r *Response) Text() string { return string(r.Body) }

// JSON decodes the body into a map, slice, string, number (float64) or bool; the check fails when
// the body is not JSON.
func (r *Response) JSON() any {
	var v any
	if err := json.Unmarshal(r.Body, &v); err != nil {
		r.ctx.Fatalf("the response body is not JSON (%v): %q", err, truncate(string(r.Body), 200))
	}
	return v
}

// Decode decodes the JSON body into v; the check fails when it cannot.
func (r *Response) Decode(v any) {
	if err := json.Unmarshal(r.Body, v); err != nil {
		r.ctx.Fatalf("the response body does not decode into %T (%v): %q", v, err, truncate(string(r.Body), 200))
	}
}

// Do sends method path with body (nil, a string, []byte, an io.Reader, or anything else as JSON)
// and header pairs ("Content-Type", "text/plain", …).
func (h *HTTP) Do(method, path string, body any, header ...string) *Response {
	req := h.request(method, path, body, header)
	if h.server != nil {
		defer h.server.Begin()()
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return h.response(rec)
}

// Hold sends a request that stays in flight: the handler runs until its first write, which waits
// for release, as for a client still reading the response. Hold returns once the handler waits
// there (or finished without writing); release lets it finish and returns the response. A server
// shut down meanwhile waits for it (http.Server.Shutdown drains requests in flight).
func (h *HTTP) Hold(method, path string, body any, header ...string) (release func() *Response) {
	req := h.request(method, path, body, header)
	end := func() {}
	if h.server != nil {
		end = h.server.Begin()
	}
	rec := httptest.NewRecorder()
	w := &heldWriter{rec: rec, gate: make(chan struct{}), reached: make(chan struct{})}
	done := make(chan struct{})
	world.Go(func() {
		defer close(done)
		defer end()
		h.handler.ServeHTTP(w, req)
	})
	select {
	case <-w.reached:
	case <-done:
	}
	var once sync.Once
	return func() *Response {
		once.Do(func() { close(w.gate) })
		<-done
		return h.response(rec)
	}
}

// request builds the request Do and Hold send; a server no longer listening refuses it.
func (h *HTTP) request(method, path string, body any, header []string) *http.Request {
	if h.server != nil && h.server.Closed() {
		h.ctx.Fatalf("%s %s: connection refused, the server on %s stopped listening", method, path, h.server.Addr)
	}
	var reader io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case string:
		reader = strings.NewReader(b)
	case []byte:
		reader = bytes.NewReader(b)
	case io.Reader:
		reader = b
	default:
		data, err := json.Marshal(b)
		if err != nil {
			h.ctx.Fatalf("encoding the request body: %v", err)
		}
		reader = bytes.NewReader(data)
		contentType = "application/json"
	}
	scheme := "http"
	if h.tls {
		scheme = "https"
	}
	req := httptest.NewRequest(method, scheme+"://app.local"+path, reader)
	req = req.WithContext(context.Background())
	req.RemoteAddr = h.remote
	if h.tls {
		req.TLS = &tls.ConnectionState{Version: tls.VersionTLS13, HandshakeComplete: true, ServerName: "app.local"}
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if len(header)%2 != 0 {
		h.ctx.Fatalf("header arguments come in name, value pairs: %q", header)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Add(header[i], header[i+1])
	}
	if host := req.Header.Get("Host"); host != "" {
		req.Host = host
	}
	return req
}

func (h *HTTP) response(rec *httptest.ResponseRecorder) *Response {
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return &Response{ctx: h.ctx, Status: res.StatusCode, Header: res.Header, Body: body}
}

// heldWriter is a ResponseWriter whose first write waits for the gate (Hold's release).
type heldWriter struct {
	rec     *httptest.ResponseRecorder
	gate    chan struct{}
	reached chan struct{}
	once    sync.Once
}

func (w *heldWriter) wait() {
	w.once.Do(func() { close(w.reached) })
	<-w.gate
}

func (w *heldWriter) Header() http.Header { return w.rec.Header() }

func (w *heldWriter) Write(b []byte) (int, error) {
	w.wait()
	return w.rec.Write(b)
}

func (w *heldWriter) WriteHeader(code int) {
	w.wait()
	w.rec.WriteHeader(code)
}

func (w *heldWriter) Flush() { w.wait() }

// Get sends GET path.
func (h *HTTP) Get(path string, header ...string) *Response { return h.Do("GET", path, nil, header...) }

// Head sends HEAD path.
func (h *HTTP) Head(path string, header ...string) *Response {
	return h.Do("HEAD", path, nil, header...)
}

// Delete sends DELETE path.
func (h *HTTP) Delete(path string, header ...string) *Response {
	return h.Do("DELETE", path, nil, header...)
}

// Options sends OPTIONS path.
func (h *HTTP) Options(path string, header ...string) *Response {
	return h.Do("OPTIONS", path, nil, header...)
}

// Post sends POST path with body.
func (h *HTTP) Post(path string, body any, header ...string) *Response {
	return h.Do("POST", path, body, header...)
}

// Put sends PUT path with body.
func (h *HTTP) Put(path string, body any, header ...string) *Response {
	return h.Do("PUT", path, body, header...)
}

// Patch sends PATCH path with body.
func (h *HTTP) Patch(path string, body any, header ...string) *Response {
	return h.Do("PATCH", path, body, header...)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
