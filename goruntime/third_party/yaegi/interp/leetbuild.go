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

// compileBinPkgSource interprets src, a generic part of the binary package at importPath that its
// symbol table cannot carry (sync/atomic's Pointer[T]), and registers it as the source package at
// that path (LeetBuild): a selector the binary package lacks falls through to it (nodeType2's
// binPkgT case), while every other symbol of the package stays the native one.
func (interp *Interpreter) compileBinPkgSource(importPath, src string) error {
	f, err := interp.parse(src, importPath, false)
	if err != nil {
		return err
	}
	pkgName, root, err := interp.ast(f)
	if err != nil {
		return err
	}
	if err := interp.gtaRetry([]*node{root}, importPath, pkgName); err != nil {
		return err
	}
	initNodes, err := interp.cfg(root, nil, importPath, pkgName)
	if err != nil {
		return err
	}
	interp.mutex.Lock()
	interp.srcPkg[importPath] = interp.scopes[importPath].sym
	interp.mutex.Unlock()
	_, err = interp.Execute(&Program{importPath, root, initNodes})
	return err
}

// getSrcSym makes the selector n read sym, a package-level symbol of a source package.
func (n *node) getSrcSym(sym *symbol) {
	n.findex = sym.index
	if sym.global {
		n.level = globalFrame
	}
	n.val = sym.node
	n.gen = nop
	n.action = aGetSym
	n.typ = sym.typ
	n.sym = sym
	n.recv = sym.recv
	n.rval = sym.rval
}
