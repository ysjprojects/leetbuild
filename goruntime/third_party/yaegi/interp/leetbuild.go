package interp

import "reflect"

// Lookup returns the package-level symbol name of the source package at importPath, exported or
// not: a function, a variable's current value, a constant (LeetBuild: a harness reaching into a
// second instance of the learner's program). A variable holding an interpreted function comes back
// as a callable func, as Symbols returns declared functions.
func (interp *Interpreter) Lookup(importPath, name string) (reflect.Value, bool) {
	interp.mutex.RLock()
	defer interp.mutex.RUnlock()
	s, ok := interp.srcPkg[importPath][name]
	if !ok {
		return reflect.Value{}, false
	}
	switch s.kind {
	case constSym:
		return s.rval, true
	case funcSym:
		return genFunctionWrapper(s.node)(interp.frame), true
	case varSym:
		v := interp.frame.data[s.index]
		if v.IsValid() && v.CanInterface() {
			if n, ok := v.Interface().(*node); ok {
				return genFunctionWrapper(n)(interp.frame), true
			}
		}
		return v, true
	}
	return reflect.Value{}, false
}
