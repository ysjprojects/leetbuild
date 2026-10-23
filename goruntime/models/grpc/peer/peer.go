// Package peer is google.golang.org/grpc/peer: who is at the other end of an RPC.
package peer

import (
	"context"
	"net"

	"leetbuild/goruntime/models/grpc/credentials"
)

// Peer is an RPC's other end.
type Peer struct {
	Addr      net.Addr
	LocalAddr net.Addr
	AuthInfo  credentials.AuthInfo
}

type peerKey struct{}

// NewContext returns ctx carrying p.
func NewContext(ctx context.Context, p *Peer) context.Context {
	return context.WithValue(ctx, peerKey{}, p)
}

// FromContext returns the peer in ctx, if any.
func FromContext(ctx context.Context) (*Peer, bool) {
	p, ok := ctx.Value(peerKey{}).(*Peer)
	return p, ok
}

// String renders the peer's address.
func (p *Peer) String() string {
	if p == nil || p.Addr == nil {
		return "Peer<nil>"
	}
	return "Peer{Addr: '" + p.Addr.String() + "'}"
}
