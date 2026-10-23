// Package insecure is google.golang.org/grpc/credentials/insecure: credentials that disable
// transport security.
package insecure

import (
	"context"
	"net"

	"leetbuild/goruntime/models/grpc/credentials"
)

// NewCredentials returns credentials that disable transport security.
func NewCredentials() credentials.TransportCredentials { return insecureTC{} }

type insecureTC struct{}

func (insecureTC) ClientHandshake(_ context.Context, _ string, conn net.Conn) (net.Conn, credentials.AuthInfo, error) {
	return conn, info{credentials.CommonAuthInfo{SecurityLevel: credentials.NoSecurity}}, nil
}

func (insecureTC) ServerHandshake(conn net.Conn) (net.Conn, credentials.AuthInfo, error) {
	return conn, info{credentials.CommonAuthInfo{SecurityLevel: credentials.NoSecurity}}, nil
}

func (insecureTC) Info() credentials.ProtocolInfo {
	return credentials.ProtocolInfo{SecurityProtocol: "insecure"}
}

func (insecureTC) Clone() credentials.TransportCredentials { return insecureTC{} }

func (insecureTC) OverrideServerName(string) error { return nil }

type info struct{ credentials.CommonAuthInfo }

func (info) AuthType() string { return "insecure" }
