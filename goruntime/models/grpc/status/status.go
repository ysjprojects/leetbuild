// Package status is google.golang.org/grpc/status: an RPC's outcome (a code and a message) and the
// errors carrying one.
package status

import (
	"context"
	"errors"
	"fmt"

	"leetbuild/goruntime/models/grpc/codes"
)

// Status is an RPC status: a code and a message. A nil *Status is OK.
type Status struct {
	code    codes.Code
	message string
}

// New returns a Status with the code and message.
func New(c codes.Code, msg string) *Status { return &Status{code: c, message: msg} }

// Newf returns New(c, fmt.Sprintf(format, a...)).
func Newf(c codes.Code, format string, a ...any) *Status { return New(c, fmt.Sprintf(format, a...)) }

// Error returns an error carrying the code and message, nil for codes.OK.
func Error(c codes.Code, msg string) error { return New(c, msg).Err() }

// Errorf returns Error(c, fmt.Sprintf(format, a...)).
func Errorf(c codes.Code, format string, a ...any) error { return Error(c, fmt.Sprintf(format, a...)) }

// Code returns the status code (OK for a nil Status).
func (s *Status) Code() codes.Code {
	if s == nil {
		return codes.OK
	}
	return s.code
}

// Message returns the status message ("" for a nil Status).
func (s *Status) Message() string {
	if s == nil {
		return ""
	}
	return s.message
}

// Err returns an error carrying s, or nil when s is OK.
func (s *Status) Err() error {
	if s.Code() == codes.OK {
		return nil
	}
	return &statusError{s: s}
}

// Details returns the status details: none are modelled.
func (s *Status) Details() []any { return nil }

// String renders the status as its error does.
func (s *Status) String() string {
	return fmt.Sprintf("rpc error: code = %s desc = %s", s.Code(), s.Message())
}

// statusError is the error a Status becomes (grpc's internal status.Error).
type statusError struct{ s *Status }

func (e *statusError) Error() string { return e.s.String() }

// GRPCStatus returns the status the error carries.
func (e *statusError) GRPCStatus() *Status { return e.s }

// Is reports whether target is a status error with the same code and message.
func (e *statusError) Is(target error) bool {
	t, ok := target.(*statusError)
	return ok && t.s.Code() == e.s.Code() && t.s.Message() == e.s.Message()
}

type grpcStatus interface{ GRPCStatus() *Status }

// FromError returns the Status err carries (directly or wrapped) and true; for any other error,
// a Status with codes.Unknown and the error's text, and false. A nil err is (nil, true).
func FromError(err error) (s *Status, ok bool) {
	if err == nil {
		return nil, true
	}
	if gs, ok := err.(grpcStatus); ok {
		if st := gs.GRPCStatus(); st != nil {
			return st, true
		}
		return New(codes.Unknown, err.Error()), false
	}
	var gs grpcStatus
	if errors.As(err, &gs) {
		if st := gs.GRPCStatus(); st != nil {
			// Wrapped: the message is the whole error text, as grpc-go reports it.
			return New(st.Code(), err.Error()), true
		}
	}
	return New(codes.Unknown, err.Error()), false
}

// Convert is FromError without the flag.
func Convert(err error) *Status {
	s, _ := FromError(err)
	return s
}

// Code returns err's status code: OK for nil, Unknown for an error carrying no status.
func Code(err error) codes.Code {
	if err == nil {
		return codes.OK
	}
	var gs grpcStatus
	if errors.As(err, &gs) {
		return gs.GRPCStatus().Code()
	}
	return codes.Unknown
}

// FromContextError converts a context error: DeadlineExceeded and Canceled keep their meaning,
// anything else is Unknown; nil is nil.
func FromContextError(err error) *Status {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, context.DeadlineExceeded):
		return New(codes.DeadlineExceeded, err.Error())
	case errors.Is(err, context.Canceled):
		return New(codes.Canceled, err.Error())
	}
	if s, ok := FromError(err); ok {
		return s
	}
	return New(codes.Unknown, err.Error())
}
