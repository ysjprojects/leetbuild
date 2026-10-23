// Package codes is google.golang.org/grpc/codes: the canonical gRPC status codes.
package codes

import (
	"fmt"
	"strconv"
)

// A Code is a gRPC status code.
type Code uint32

// The canonical codes.
const (
	OK                 Code = 0
	Canceled           Code = 1
	Unknown            Code = 2
	InvalidArgument    Code = 3
	DeadlineExceeded   Code = 4
	NotFound           Code = 5
	AlreadyExists      Code = 6
	PermissionDenied   Code = 7
	ResourceExhausted  Code = 8
	FailedPrecondition Code = 9
	Aborted            Code = 10
	OutOfRange         Code = 11
	Unimplemented      Code = 12
	Internal           Code = 13
	Unavailable        Code = 14
	DataLoss           Code = 15
	Unauthenticated    Code = 16
)

var names = [...]string{
	"OK", "Canceled", "Unknown", "InvalidArgument", "DeadlineExceeded", "NotFound", "AlreadyExists",
	"PermissionDenied", "ResourceExhausted", "FailedPrecondition", "Aborted", "OutOfRange",
	"Unimplemented", "Internal", "Unavailable", "DataLoss", "Unauthenticated",
}

// wireNames are the JSON (and grpc-gateway) names: "DEADLINE_EXCEEDED".
var wireNames = [...]string{
	"OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS",
	"PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE",
	"UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
}

// String is the code's name ("DeadlineExceeded"), or "Code(n)".
func (c Code) String() string {
	if int(c) < len(names) {
		return names[c]
	}
	return "Code(" + strconv.FormatInt(int64(c), 10) + ")"
}

// UnmarshalJSON accepts a code as a number or as its quoted upper-case name ("NOT_FOUND").
func (c *Code) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	if c == nil {
		return fmt.Errorf("nil receiver passed to UnmarshalJSON")
	}
	if n, err := strconv.ParseUint(string(b), 10, 32); err == nil {
		if n >= uint64(len(names)) {
			return fmt.Errorf("invalid code: %d", n)
		}
		*c = Code(n)
		return nil
	}
	s, err := strconv.Unquote(string(b))
	if err == nil {
		for i, name := range wireNames {
			if name == s {
				*c = Code(i)
				return nil
			}
		}
	}
	return fmt.Errorf("invalid code: %q", string(b))
}
