// Package credentials is google.golang.org/grpc/credentials: what secures a connection (transport
// credentials) and what authenticates each call (per-RPC credentials). In the in-process runtime
// no bytes are encrypted: TLS credentials only say which kind of channel was asked for, and
// per-RPC credentials add their metadata to every call.
package credentials

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
)

// AuthInfo is what a handshake established about the peer.
type AuthInfo interface {
	AuthType() string
}

// ProtocolInfo describes a transport's security protocol.
type ProtocolInfo struct {
	ProtocolVersion  string
	SecurityProtocol string
	SecurityVersion  string
	ServerName       string
}

// TransportCredentials secure a connection.
type TransportCredentials interface {
	ClientHandshake(ctx context.Context, authority string, rawConn net.Conn) (net.Conn, AuthInfo, error)
	ServerHandshake(rawConn net.Conn) (net.Conn, AuthInfo, error)
	Info() ProtocolInfo
	Clone() TransportCredentials
	OverrideServerName(serverName string) error
}

// PerRPCCredentials attach metadata (a token) to every call.
type PerRPCCredentials interface {
	GetRequestMetadata(ctx context.Context, uri ...string) (map[string]string, error)
	RequireTransportSecurity() bool
}

// SecurityLevel is a connection's protection level.
type SecurityLevel int

// Security levels.
const (
	InvalidSecurityLevel SecurityLevel = iota
	NoSecurity
	IntegrityOnly
	PrivacyAndIntegrity
)

// String names the level.
func (s SecurityLevel) String() string {
	switch s {
	case NoSecurity:
		return "NoSecurity"
	case IntegrityOnly:
		return "IntegrityOnly"
	case PrivacyAndIntegrity:
		return "PrivacyAndIntegrity"
	}
	return "invalid SecurityLevel"
}

// CommonAuthInfo holds the security level every AuthInfo reports.
type CommonAuthInfo struct {
	SecurityLevel SecurityLevel
}

// GetCommonAuthInfo returns the CommonAuthInfo.
func (c CommonAuthInfo) GetCommonAuthInfo() CommonAuthInfo { return c }

// TLSInfo is the AuthInfo of a TLS connection.
type TLSInfo struct {
	State tls.ConnectionState
	CommonAuthInfo
}

// AuthType returns "tls".
func (TLSInfo) AuthType() string { return "tls" }

type tlsCreds struct {
	config *tls.Config
}

func (c *tlsCreds) ClientHandshake(_ context.Context, _ string, conn net.Conn) (net.Conn, AuthInfo, error) {
	return conn, TLSInfo{CommonAuthInfo: CommonAuthInfo{SecurityLevel: PrivacyAndIntegrity}}, nil
}

func (c *tlsCreds) ServerHandshake(conn net.Conn) (net.Conn, AuthInfo, error) {
	return conn, TLSInfo{CommonAuthInfo: CommonAuthInfo{SecurityLevel: PrivacyAndIntegrity}}, nil
}

func (c *tlsCreds) Info() ProtocolInfo {
	return ProtocolInfo{SecurityProtocol: "tls", SecurityVersion: "1.2", ServerName: c.config.ServerName}
}

func (c *tlsCreds) Clone() TransportCredentials { return &tlsCreds{config: c.config.Clone()} }

func (c *tlsCreds) OverrideServerName(name string) error {
	c.config.ServerName = name
	return nil
}

// NewTLS returns TLS transport credentials from a tls.Config.
func NewTLS(c *tls.Config) TransportCredentials {
	if c == nil {
		c = &tls.Config{}
	}
	return &tlsCreds{config: c.Clone()}
}

// NewClientTLSFromCert returns client TLS credentials trusting cp (nil: the system roots).
func NewClientTLSFromCert(cp *x509.CertPool, serverNameOverride string) TransportCredentials {
	return NewTLS(&tls.Config{ServerName: serverNameOverride, RootCAs: cp})
}

// NewServerTLSFromCert returns server TLS credentials presenting cert.
func NewServerTLSFromCert(cert *tls.Certificate) TransportCredentials {
	return NewTLS(&tls.Config{Certificates: []tls.Certificate{*cert}})
}

// ErrNoFiles is returned by the file-based constructors: the runtime has no file system.
var ErrNoFiles = errors.New("credentials: no certificate files in this runtime")

// NewClientTLSFromFile would read a CA certificate file: there are none in this runtime.
func NewClientTLSFromFile(certFile, serverNameOverride string) (TransportCredentials, error) {
	return nil, ErrNoFiles
}

// NewServerTLSFromFile would read a certificate and key file: there are none in this runtime.
func NewServerTLSFromFile(certFile, keyFile string) (TransportCredentials, error) {
	return nil, ErrNoFiles
}
