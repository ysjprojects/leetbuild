// Package netx is the runtime's network: in-memory listeners standing in for sockets. The host maps
// interpreted net.Listen to Listen; a gRPC server serving on such a listener is reachable by every
// client dialing that port, whatever host name it uses (":50051", "0.0.0.0:50051",
// "localhost:50051" and "keys:50051" are one address), and Dial connects an in-memory conn to it.
package netx

import (
	"errors"
	"net"
	"os"
	"strconv"
	"sync"
	"syscall"
)

var (
	mu        sync.Mutex
	listeners = map[string]*Listener{} // by Key
	nextPort  = 40000                  // ephemeral ports handed out for port 0
)

// Key is the address a listener is found by: its port ("50051"), or the path of a unix socket.
func Key(network, address string) (string, error) {
	if network == "unix" || network == "unixpacket" {
		return "unix:" + address, nil
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", err
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		if p, perr := net.LookupPort("tcp", port); perr == nil {
			return strconv.Itoa(p), nil
		}
		return "", &net.AddrError{Err: "invalid port", Addr: address}
	}
	return port, nil
}

// Listener is an in-memory listener: Accept returns the server ends of Dial's conns.
type Listener struct {
	key   string
	addr  net.Addr
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

// Listen returns a listener at address ("host:port"; port 0 picks a free one). A port already
// listened on fails with "bind: address already in use".
func Listen(network, address string) (net.Listener, error) {
	switch network {
	case "tcp", "tcp4", "tcp6", "unix", "unixpacket":
	default:
		return nil, &net.OpError{Op: "listen", Net: network, Err: net.UnknownNetworkError(network)}
	}
	key, err := Key(network, address)
	if err != nil {
		return nil, &net.OpError{Op: "listen", Net: network, Err: err}
	}
	mu.Lock()
	defer mu.Unlock()
	if key == "0" {
		for {
			nextPort++
			if _, taken := listeners[strconv.Itoa(nextPort)]; !taken {
				key = strconv.Itoa(nextPort)
				break
			}
		}
	}
	addr := listenAddr(network, address, key)
	if _, taken := listeners[key]; taken {
		return nil, &net.OpError{Op: "listen", Net: network, Addr: addr, Err: os.NewSyscallError("bind", syscall.EADDRINUSE)}
	}
	l := &Listener{key: key, addr: addr, conns: make(chan net.Conn, 128), done: make(chan struct{})}
	listeners[key] = l
	return l, nil
}

func listenAddr(network, address, key string) net.Addr {
	if network == "unix" || network == "unixpacket" {
		return &net.UnixAddr{Name: address, Net: network}
	}
	host, _, _ := net.SplitHostPort(address)
	port, _ := strconv.Atoi(key)
	ip := net.IPv6zero
	switch host {
	case "", "::":
	case "localhost":
		ip = net.IPv4(127, 0, 0, 1)
	default:
		if parsed := net.ParseIP(host); parsed != nil {
			ip = parsed
		} else {
			ip = net.IPv4(127, 0, 0, 1)
		}
	}
	return &net.TCPAddr{IP: ip, Port: port}
}

// Accept waits for the next Dial, or for Close.
func (l *Listener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, &net.OpError{Op: "accept", Net: l.addr.Network(), Addr: l.addr, Err: net.ErrClosed}
	}
}

// Close stops the listener; the port is free again.
func (l *Listener) Close() error {
	closed := false
	l.once.Do(func() {
		closed = true
		close(l.done)
		mu.Lock()
		if listeners[l.key] == l {
			delete(listeners, l.key)
		}
		mu.Unlock()
	})
	if !closed {
		return &net.OpError{Op: "close", Net: l.addr.Network(), Addr: l.addr, Err: net.ErrClosed}
	}
	return nil
}

// Addr is the address listened on.
func (l *Listener) Addr() net.Addr { return l.addr }

// Key is the address clients find this listener by.
func (l *Listener) Key() string { return l.key }

// Done is closed once the listener is closed.
func (l *Listener) Done() <-chan struct{} { return l.done }

// Lookup returns the open listener a client dialing address reaches.
func Lookup(network, address string) (*Listener, bool) {
	key, err := Key(network, address)
	if err != nil {
		return nil, false
	}
	mu.Lock()
	defer mu.Unlock()
	l, ok := listeners[key]
	return l, ok
}

// ErrRefused is a dial to an address nothing listens on.
var ErrRefused = errors.New("connect: connection refused")

// Dial connects to the listener at address: the returned conn's peer is what its Accept returns.
func Dial(network, address string) (net.Conn, error) {
	l, ok := Lookup(network, address)
	if !ok {
		return nil, &net.OpError{Op: "dial", Net: network, Err: ErrRefused}
	}
	client, server := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-l.done:
		return nil, &net.OpError{Op: "dial", Net: network, Err: ErrRefused}
	}
}

// Reset closes every listener (before each check).
func Reset() {
	mu.Lock()
	open := make([]*Listener, 0, len(listeners))
	for _, l := range listeners {
		open = append(open, l)
	}
	mu.Unlock()
	for _, l := range open {
		_ = l.Close()
	}
}
