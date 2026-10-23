package yaegitest

import "testing"

// errors.As into an interpreted interface, == with an interpreted error, a typed nil pointer in an
// error, and fmt printing the elements of slices, maps and structs through their methods.
func TestInterpretedErrorsAndPrintedElements(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"as iface", `w := fmt.Errorf("w: %w", codeErr{4}); var t coder; ok := errors.As(w, &t); return fmt.Sprint(ok, t != nil && t.Code() == 4)`, "true true"},
		{"as iface direct", `var e error = codeErr{4}; var t coder; ok := errors.As(e, &t); return fmt.Sprint(ok)`, "true"},
		{"eq sentinel", `e := get(); return fmt.Sprint(e == errNF, e != errNF)`, "true false"},
		{"eq sentinel var", `var e error = errNF; return fmt.Sprint(e == errNF)`, "true"},
		{"eq other", `var e error = &pErr{"nf"}; return fmt.Sprint(e == errNF)`, "false"},
		{"eq native", `var e error = sentinel; return fmt.Sprint(e == sentinel)`, "true"},
		{"typed nil", `var p *pErr; var e error = p; return fmt.Sprint(e != nil, e == nil)`, "true false"},
		{"typed nil returned", `return fmt.Sprint(typedNil() != nil)`, "true"},
		{"untyped nil", `var e error; return fmt.Sprint(e == nil, okNil() == nil)`, "true true"},
		{"slice stringer", `return fmt.Sprint([]named{"x", "y"})`, "[named:x named:y]"},
		{"map stringer", `return fmt.Sprint(map[string]named{"a": "x"})`, "map[a:named:x]"},
		{"struct stringer", `type h struct{ N named }; return fmt.Sprintf("%v", h{"x"})`, "{named:x}"},
		{"slice errors", `return fmt.Sprint([]error{myErr{"a"}, sentinel})`, "[err:a sentinel]"},
		{"branch on sentinel", `if e := get(); e == errNF { return "nf" }; return "other"`, "nf"},
		{"branch on typed nil", `if e := typedNil(); e != nil { return "non-nil" }; return "nil"`, "non-nil"},
		{"pointer to struct", `type h struct{ N named; E error }; return fmt.Sprintf("%+v", &h{"x", myErr{"a"}})`, "&{N:named:x E:err:a}"},
		{"nested", `return fmt.Sprint(map[string][]named{"k": {"x"}})`, "map[k:[named:x]]"},
		{"nil slice", `var s []named; return fmt.Sprint(s, len(s))`, "[] 0"},
		{"slice ptr stringer", `return fmt.Sprint([]*pStr{{"z"}})`, "[pstr:z]"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expect(t, `package main

import (
	"errors"
	"fmt"
)

type myErr struct{ m string }

func (e myErr) Error() string { return "err:" + e.m }

type pErr struct{ m string }

func (e *pErr) Error() string { return "perr:" + e.m }

type codeErr struct{ code int }

func (c codeErr) Error() string { return "code" }
func (c codeErr) Code() int     { return c.code }

type coder interface{ Code() int }

type named string

func (s named) String() string { return "named:" + string(s) }

type pStr struct{ s string }

func (p *pStr) String() string { return "pstr:" + p.s }

var sentinel = errors.New("sentinel")

var errNF = &pErr{"nf"}

func get() error { return errNF }

func typedNil() error { var p *pErr; return p }

func okNil() error { return nil }

func Run() string { `+c.body+` }`, c.want)
		})
	}
}
