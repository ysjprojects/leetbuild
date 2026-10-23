// Package goredis connects the real go-redis client to the runtime's Redis server: NewClient (and
// its siblings) dial a Conn that speaks RESP to go-redis and runs each round trip on the shared
// server, so a pipeline is one trip, MULTI/EXEC runs as a block, WATCH aborts a transaction whose
// keys changed, and SUBSCRIBE receives the server's publishes.
package goredis

import (
	"bytes"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"leetbuild/goruntime/world"
)

// Conn is one client connection: commands written since the last read are one round trip, run on
// the server when the client reads.
type Conn struct {
	server world.Redis

	mu      sync.Mutex
	in      []byte     // bytes written, not yet parsed
	queued  [][][]byte // commands of the trip in progress
	out     bytes.Buffer
	wake    chan struct{}
	closed  bool
	watched map[string]string // WATCHed key → its fingerprint when watched
	subs    map[string]func() // "c:<channel>" / "p:<pattern>" → unsubscribe
}

// NewConn is a connection to server.
func NewConn(server world.Redis) *Conn {
	return &Conn{server: server, wake: make(chan struct{}, 1)}
}

func (c *Conn) Write(b []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return 0, net.ErrClosed
	}
	c.in = append(c.in, b...)
	for {
		cmd, rest, ok, err := parseCommand(c.in)
		if err != nil {
			return 0, err
		}
		if !ok {
			break
		}
		c.in = rest
		c.queued = append(c.queued, cmd)
	}
	return len(b), nil
}

func (c *Conn) Read(b []byte) (int, error) {
	for {
		c.mu.Lock()
		if len(c.queued) > 0 {
			batch := c.queued
			c.queued = nil
			c.mu.Unlock()
			replies := c.trip(batch)
			c.mu.Lock()
			for _, r := range replies {
				writeReply(&c.out, r)
			}
		}
		if c.out.Len() > 0 {
			n, _ := c.out.Read(b)
			c.mu.Unlock()
			return n, nil
		}
		if c.closed {
			c.mu.Unlock()
			return 0, io.EOF
		}
		c.mu.Unlock()
		<-c.wake // a publish, or Close
	}
}

func (c *Conn) push(reply world.Reply) {
	c.mu.Lock()
	writeReply(&c.out, reply)
	c.mu.Unlock()
	c.signal()
}

func (c *Conn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *Conn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	subs := c.subs
	c.subs = nil
	c.mu.Unlock()
	for _, stop := range subs {
		stop()
	}
	c.signal()
	return nil
}

// Deadlines are the virtual clock's business (contexts), not the connection's: they are ignored.
func (c *Conn) SetDeadline(time.Time) error      { return nil }
func (c *Conn) SetReadDeadline(time.Time) error  { return nil }
func (c *Conn) SetWriteDeadline(time.Time) error { return nil }
func (c *Conn) LocalAddr() net.Addr              { return addr("client") }
func (c *Conn) RemoteAddr() net.Addr             { return addr("redis:6379") }

type addr string

func (a addr) Network() string { return "tcp" }
func (a addr) String() string  { return string(a) }

// trip runs one round trip and returns a reply per command written.
func (c *Conn) trip(batch [][][]byte) []world.Reply {
	replies := make([]world.Reply, 0, len(batch))
	var run [][][]byte // consecutive ordinary commands: one pipeline
	flush := func() {
		if len(run) == 0 {
			return
		}
		if len(run) == 1 {
			r, err := c.server.Execute(run[0], true)
			replies = append(replies, replyOrError(r, err))
		} else {
			for _, res := range c.server.Pipeline(run) {
				replies = append(replies, replyOrError(res.Reply, res.Err))
			}
		}
		run = nil
	}
	for i := 0; i < len(batch); i++ {
		cmd := batch[i]
		name := strings.ToUpper(string(cmd[0]))
		if name == "MULTI" {
			flush()
			end := i + 1
			for end < len(batch) && !isAny(batch[end][0], "EXEC", "DISCARD") {
				end++
			}
			replies = append(replies, c.transaction(batch[i+1:min(end, len(batch))], end < len(batch) && isAny(batch[end][0], "EXEC"))...)
			if end < len(batch) {
				i = end
			} else {
				i = len(batch)
			}
			continue
		}
		if local, ok := c.local(name, cmd); ok {
			flush()
			replies = append(replies, local)
			continue
		}
		run = append(run, cmd)
	}
	flush()
	return replies
}

// transaction answers MULTI, each queued command, and EXEC (or DISCARD).
func (c *Conn) transaction(cmds [][][]byte, exec bool) []world.Reply {
	out := []world.Reply{world.Status("OK")}
	for range cmds {
		out = append(out, world.Status("QUEUED"))
	}
	watched := c.watched
	c.watched = nil
	if !exec {
		return append(out, world.Status("OK"))
	}
	for key, before := range watched {
		if c.server.Fingerprint([]byte(key)) != before {
			// A watched key changed: EXEC returns a null array and nothing runs.
			return append(out, nilArray{})
		}
	}
	results := c.server.Transaction(cmds)
	block := make([]world.Reply, len(results))
	for i, r := range results {
		block[i] = replyOrError(r.Reply, r.Err)
	}
	return append(out, block)
}

// local answers the commands the connection itself handles: the handshake, WATCH bookkeeping,
// and the subscribe family.
func (c *Conn) local(name string, cmd [][]byte) (world.Reply, bool) {
	switch name {
	case "HELLO":
		// Answered as a server without RESP3 would: go-redis then speaks RESP2.
		return &world.ReplyError{Message: "ERR unknown command 'HELLO'"}, true
	case "CLIENT":
		if len(cmd) > 1 {
			switch strings.ToUpper(string(cmd[1])) {
			case "ID":
				return int64(1), true
			case "GETNAME":
				return nil, true
			}
		}
		return world.Status("OK"), true
	case "SELECT", "AUTH", "READONLY", "READWRITE":
		return world.Status("OK"), true
	case "QUIT":
		return world.Status("OK"), true
	case "WATCH":
		if c.watched == nil {
			c.watched = map[string]string{}
		}
		for _, k := range cmd[1:] {
			if _, ok := c.watched[string(k)]; !ok {
				c.watched[string(k)] = c.server.Fingerprint(k)
			}
		}
		return world.Status("OK"), true
	case "UNWATCH":
		c.watched = nil
		return world.Status("OK"), true
	case "SUBSCRIBE", "PSUBSCRIBE":
		return c.subscribe(name == "PSUBSCRIBE", cmd[1:]), true
	case "UNSUBSCRIBE", "PUNSUBSCRIBE":
		return c.unsubscribe(name == "PUNSUBSCRIBE", cmd[1:]), true
	case "PING":
		if len(c.subs) > 0 {
			msg := []byte{}
			if len(cmd) > 1 {
				msg = cmd[1]
			}
			return []world.Reply{[]byte("pong"), msg}, true
		}
	}
	return nil, false
}

// multi is several replies sent for one command (SUBSCRIBE answers once per channel).
type multi []world.Reply

// nilArray is RESP's null array (*-1), what EXEC answers when a WATCH aborted it.
type nilArray struct{}

func (c *Conn) subscribe(pattern bool, names [][]byte) world.Reply {
	kind, prefix := "subscribe", "c:"
	if pattern {
		kind, prefix = "psubscribe", "p:"
	}
	if c.subs == nil {
		c.subs = map[string]func(){}
	}
	var out multi
	for _, name := range names {
		key := prefix + string(name)
		if _, ok := c.subs[key]; !ok {
			c.subs[key] = c.server.Subscribe(name, pattern, func(pat, channel, message []byte) {
				if pattern {
					c.push([]world.Reply{[]byte("pmessage"), pat, channel, message})
				} else {
					c.push([]world.Reply{[]byte("message"), channel, message})
				}
			})
		}
		out = append(out, []world.Reply{[]byte(kind), name, int64(len(c.subs))})
	}
	return out
}

func (c *Conn) unsubscribe(pattern bool, names [][]byte) world.Reply {
	kind, prefix := "unsubscribe", "c:"
	if pattern {
		kind, prefix = "punsubscribe", "p:"
	}
	if len(names) == 0 {
		for key := range c.subs {
			if strings.HasPrefix(key, prefix) {
				names = append(names, []byte(key[2:]))
			}
		}
	}
	var out multi
	for _, name := range names {
		if stop, ok := c.subs[prefix+string(name)]; ok {
			stop()
			delete(c.subs, prefix+string(name))
		}
		out = append(out, []world.Reply{[]byte(kind), name, int64(len(c.subs))})
	}
	if len(out) == 0 {
		out = append(out, []world.Reply{[]byte(kind), nil, int64(len(c.subs))})
	}
	return out
}

func isAny(name []byte, names ...string) bool {
	for _, n := range names {
		if strings.EqualFold(string(name), n) {
			return true
		}
	}
	return false
}

func replyOrError(r world.Reply, err error) world.Reply {
	if err != nil {
		var re *world.ReplyError
		if errors.As(err, &re) {
			return re
		}
		return &world.ReplyError{Message: "ERR " + err.Error()}
	}
	return r
}

// ---- RESP ----------------------------------------------------------------------------------------

var errProtocol = errors.New("redis: protocol error from the client")

// parseCommand reads one `*N` array of bulk strings off buf (what a client sends).
func parseCommand(buf []byte) (cmd [][]byte, rest []byte, ok bool, err error) {
	if len(buf) == 0 {
		return nil, buf, false, nil
	}
	if buf[0] != '*' {
		// An inline command: space-separated words on one line.
		line, after, found := bytes.Cut(buf, []byte("\r\n"))
		if !found {
			return nil, buf, false, nil
		}
		return bytes.Fields(line), after, true, nil
	}
	n, after, found, err := parseInt(buf[1:])
	if err != nil || !found {
		return nil, buf, false, err
	}
	cmd = make([][]byte, 0, n)
	for range n {
		if len(after) == 0 {
			return nil, buf, false, nil
		}
		if after[0] != '$' {
			return nil, buf, false, errProtocol
		}
		size, body, found, err := parseInt(after[1:])
		if err != nil || !found {
			return nil, buf, false, err
		}
		if len(body) < size+2 {
			return nil, buf, false, nil
		}
		cmd = append(cmd, append([]byte(nil), body[:size]...))
		after = body[size+2:]
	}
	return cmd, after, true, nil
}

func parseInt(buf []byte) (int, []byte, bool, error) {
	line, after, found := bytes.Cut(buf, []byte("\r\n"))
	if !found {
		return 0, buf, false, nil
	}
	n, err := strconv.Atoi(string(line))
	if err != nil {
		return 0, buf, false, errProtocol
	}
	return n, after, true, nil
}

// writeReply encodes a reply as RESP2.
func writeReply(w *bytes.Buffer, r world.Reply) {
	switch v := r.(type) {
	case nil:
		w.WriteString("$-1\r\n")
	case nilArray:
		w.WriteString("*-1\r\n")
	case multi:
		for _, one := range v {
			writeReply(w, one)
		}
	case world.Status:
		w.WriteString("+" + string(v) + "\r\n")
	case *world.ReplyError:
		w.WriteString("-" + strings.ReplaceAll(v.Message, "\r\n", " ") + "\r\n")
	case int64:
		w.WriteString(":" + strconv.FormatInt(v, 10) + "\r\n")
	case int:
		w.WriteString(":" + strconv.Itoa(v) + "\r\n")
	case float64:
		writeBulk(w, []byte(strconv.FormatFloat(v, 'f', -1, 64)))
	case []byte:
		writeBulk(w, v)
	case string:
		writeBulk(w, []byte(v))
	case []world.Reply:
		w.WriteString("*" + strconv.Itoa(len(v)) + "\r\n")
		for _, one := range v {
			writeReply(w, one)
		}
	default:
		writeBulk(w, []byte("unsupported reply"))
	}
}

func writeBulk(w *bytes.Buffer, b []byte) {
	w.WriteString("$" + strconv.Itoa(len(b)) + "\r\n")
	w.Write(b)
	w.WriteString("\r\n")
}
