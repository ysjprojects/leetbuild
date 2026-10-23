package interp

import (
	"reflect"
	"strings"
	"sync/atomic"
)

// adot produces an AST dot(1) directed acyclic graph for the given node. For debugging only.
// func (n *node) adot() { n.astDot(dotWriter(n.interp.dotCmd), n.ident) }

// genAST returns a new AST where generic types are replaced by instantiated types.
func genAST(sc *scope, root *node, types []*itype) (*node, bool, error) {
	typeParam := map[string]*node{}
	pindex := 0
	tname := ""
	rtname := ""
	recvrPtr := false
	fixNodes := []*node{}
	var gtree func(*node, *node) (*node, error)
	sname := root.child[0].ident + "["
	if root.kind == funcDecl {
		sname = root.child[1].ident + "["
	}

	// Input type parameters must be resolved prior AST generation, as compilation
	// of generated AST may occur in a different scope.
	for _, t := range types {
		sname += t.id() + ","
	}
	sname = strings.TrimSuffix(sname, ",") + "]"

	gtree = func(n, anc *node) (*node, error) {
		nod := copyNode(n, anc, false)
		switch n.kind {
		case funcDecl, funcType:
			nod.val = nod

		case identExpr:
			// Replace generic type by instantiated one.
			nt, ok := typeParam[n.ident]
			if !ok {
				break
			}
			nod = copyNode(nt, anc, true)
			nod.typ = nt.typ

		case indexExpr:
			// Catch a possible recursive generic type definition
			if root.kind != typeSpec {
				break
			}
			if root.child[0].ident != n.child[0].ident {
				break
			}
			nod := copyNode(n.child[0], anc, false)
			fixNodes = append(fixNodes, nod)
			return nod, nil

		case fieldList:
			//  Node is the type parameters list of a generic function.
			if root.kind == funcDecl && n.anc == root.child[2] && childPos(n) == 0 {
				// Fill the types lookup table used for type substitution.
				for _, c := range n.child {
					l := len(c.child) - 1
					for _, cc := range c.child[:l] {
						if pindex >= len(types) {
							return nil, cc.cfgErrorf("undefined type for %s", cc.ident)
						}
						t, err := nodeType(c.interp, sc, c.child[l])
						if err != nil {
							return nil, err
						}
						if err := checkConstraint(types[pindex], t); err != nil {
							return nil, err
						}
						typeParam[cc.ident] = copyNode(cc, cc.anc, false)
						typeParam[cc.ident].ident = types[pindex].id()
						typeParam[cc.ident].typ = types[pindex]
						pindex++
					}
				}
				// Skip type parameters specification, so generated func doesn't look generic.
				return nod, nil
			}

			// Node is the receiver of a generic method.
			if root.kind == funcDecl && n.anc == root && childPos(n) == 0 && len(n.child) > 0 {
				rtn := n.child[0].child[1]
				// Method receiver is a generic type if it takes some type parameters.
				if rtn.kind == indexExpr || rtn.kind == indexListExpr || (rtn.kind == starExpr && (rtn.child[0].kind == indexExpr || rtn.child[0].kind == indexListExpr)) {
					if rtn.kind == starExpr {
						// Method receiver is a pointer on a generic type.
						rtn = rtn.child[0]
						recvrPtr = true
					}
					rtname = rtn.child[0].ident + "["
					for _, cc := range rtn.child[1:] {
						if pindex >= len(types) {
							return nil, cc.cfgErrorf("undefined type for %s", cc.ident)
						}
						it := types[pindex]
						typeParam[cc.ident] = copyNode(cc, cc.anc, false)
						typeParam[cc.ident].ident = it.id()
						typeParam[cc.ident].typ = it
						rtname += it.id() + ","
						pindex++
					}
					rtname = strings.TrimSuffix(rtname, ",") + "]"
				}
			}

			// Node is the type parameters list of a generic type.
			if root.kind == typeSpec && n.anc == root && childPos(n) == 1 {
				// Fill the types lookup table used for type substitution.
				tname = n.anc.child[0].ident + "["
				for _, c := range n.child {
					l := len(c.child) - 1
					for _, cc := range c.child[:l] {
						if pindex >= len(types) {
							return nil, cc.cfgErrorf("undefined type for %s", cc.ident)
						}
						it := types[pindex]
						t, err := nodeType(c.interp, sc, c.child[l])
						if err != nil {
							return nil, err
						}
						if err := checkConstraint(types[pindex], t); err != nil {
							return nil, err
						}
						typeParam[cc.ident] = copyNode(cc, cc.anc, false)
						typeParam[cc.ident].ident = it.id()
						typeParam[cc.ident].typ = it
						tname += it.id() + ","
						pindex++
					}
				}
				tname = strings.TrimSuffix(tname, ",") + "]"
				return nod, nil
			}
		}

		for _, c := range n.child {
			gn, err := gtree(c, nod)
			if err != nil {
				return nil, err
			}
			nod.child = append(nod.child, gn)
		}
		return nod, nil
	}

	if nod, found := root.interp.generic[sname]; found {
		return nod, true, nil
	}

	r, err := gtree(root, root.anc)
	if err != nil {
		return nil, false, err
	}
	root.interp.generic[sname] = r
	r.param = append(r.param, types...)
	if tname != "" {
		for _, nod := range fixNodes {
			nod.ident = tname
		}
		r.child[0].ident = tname
	}
	if rtname != "" {
		// Replace method receiver type by synthetized ident.
		nod := r.child[0].child[0].child[1]
		if recvrPtr {
			nod = nod.child[0]
		}
		nod.kind = identExpr
		nod.ident = rtname
		nod.child = nil
	}
	// r.adot() // Used for debugging only.
	return r, false, nil
}

func copyNode(n, anc *node, recursive bool) *node {
	var i interface{}
	nindex := atomic.AddInt64(&n.interp.nindex, 1)
	nod := &node{
		debug:  n.debug,
		anc:    anc,
		interp: n.interp,
		index:  nindex,
		level:  n.level,
		nleft:  n.nleft,
		nright: n.nright,
		kind:   n.kind,
		pos:    n.pos,
		action: n.action,
		gen:    n.gen,
		val:    &i,
		rval:   n.rval,
		ident:  n.ident,
		meta:   n.meta,
	}
	nod.start = nod
	if recursive {
		for _, c := range n.child {
			nod.child = append(nod.child, copyNode(c, nod, true))
		}
	}
	return nod
}

// inferTypesFromCall returns the types of the type parameters of the generic function fun, in
// declaration order: the explicit type arguments first, then those inferred from the call
// arguments args (LeetBuild: rewritten). Each argument's type is unified with its parameter's type
// expression; a typed argument wins over an untyped constant, untyped constants alone give their
// default type (the widest kind among them), and a parameter whose constraint has a core type
// (S ~[]E) yields the type parameters in it. The former version listed one type per parameter,
// positionally, so func[T](x T, y ...T) took T from an untyped x, and S ~[]E never inferred E.
func inferTypesFromCall(sc *scope, fun *node, explicit []*itype, args []*node, spread bool) ([]*itype, error) {
	ftn := fun.typ.node
	var names []string
	constraints := map[string]*node{}
	for _, c := range ftn.child[0].child {
		for _, cc := range c.child[:len(c.child)-1] {
			names = append(names, cc.ident)
			constraints[cc.ident] = c.lastChild()
		}
	}
	if len(explicit) > len(names) {
		return nil, fun.cfgErrorf("got %d type arguments but %s has %d type parameters", len(explicit), fun.child[1].ident, len(names))
	}
	bound := map[string]*itype{}
	for i, t := range explicit {
		bound[names[i]] = t
	}
	bind := func(name string, t *itype) {
		old := bound[name]
		switch {
		case t == nil || t.cat == nilT:
		case old == nil:
			bound[name] = t
		case old.untyped && !t.untyped:
			bound[name] = t
		case old.untyped && t.untyped && untypedRank(t) > untypedRank(old):
			bound[name] = t
		}
	}

	var unify func(p *node, t *itype)
	unify = func(p *node, t *itype) {
		if p == nil || t == nil {
			return
		}
		switch p.kind {
		case identExpr:
			if _, ok := constraints[p.ident]; ok {
				bind(p.ident, t)
			}
		case parenExpr:
			unify(p.child[0], t)
		case arrayType, starExpr, chanType, chanTypeSend, chanTypeRecv:
			unify(p.lastChild(), elemOf(t))
		case mapType:
			k, v := keyElemOf(t)
			unify(p.child[0], k)
			unify(p.child[1], v)
		case funcType:
			u := t.underlying()
			if u.cat != funcT {
				return
			}
			if len(p.child) > 1 {
				unifyFields(p.child[1], u.arg, unify)
			}
			if len(p.child) > 2 {
				unifyFields(p.child[2], u.ret, unify)
			}
		}
	}

	ai := 0
	for _, c := range ftn.child[1].child {
		p := c.lastChild()
		for k := max(1, len(c.child)-1); k > 0; k-- { // yaegi's module is go1.21: no range over int
			if p.kind == ellipsisExpr {
				if spread {
					if ai < len(args) {
						unify(p.child[0], elemOf(args[ai].typ))
					}
					ai = len(args)
				}
				for ; ai < len(args); ai++ {
					unify(p.child[0], args[ai].typ)
				}
				break
			}
			if ai < len(args) {
				unify(p, args[ai].typ)
			}
			ai++
		}
	}

	// Core types: a bound S ~[]E binds E to its element type.
	for range names {
		for _, name := range names {
			t := bound[name]
			c := constraints[name]
			if t == nil || c == nil {
				continue
			}
			if c.kind == unaryExpr && len(c.child) == 1 {
				c = c.child[0] // ~T
			}
			switch c.kind {
			case arrayType, mapType, starExpr, chanType, chanTypeSend, chanTypeRecv, funcType:
				unify(c, t.underlying())
			}
		}
	}

	types := make([]*itype, 0, len(names))
	for _, name := range names {
		t := bound[name]
		if t == nil {
			break // genAST reports the type it lacks
		}
		if t.untyped {
			t = untypedDefault(sc, t)
		}
		types = append(types, t)
	}
	return types, nil
}

// instantiateFunc returns the generic function fun (its funcDecl) instantiated with the explicit
// type arguments, the others inferred from their constraints' core types (slices.Reverse[[]int]
// gives E), and compiled (LeetBuild).
func (interp *Interpreter) instantiateFunc(sc *scope, fun *node, explicit []*itype, importPath, pkgName string) (*node, error) {
	types, err := inferTypesFromCall(sc, fun, explicit, nil, false)
	if err != nil {
		return nil, err
	}
	g, found, err := genAST(sc, fun, types)
	if err != nil {
		return nil, err
	}
	if !found {
		if _, err = interp.cfg(g, fun.scope, importPath, pkgName); err != nil {
			return nil, err
		}
		if err = genRun(g.child[3]); err != nil { // closures of the function body
			return nil, err
		}
	}
	return g, nil
}

// unifyFields unifies the parameter or result types of a func type expression with ts.
func unifyFields(fields *node, ts []*itype, unify func(*node, *itype)) {
	i := 0
	for _, f := range fields.child {
		for k := max(1, len(f.child)-1); k > 0; k-- {
			if i < len(ts) {
				unify(f.lastChild(), ts[i])
			}
			i++
		}
	}
}

// elemOf is the element type of a slice, array, pointer, chan or map type, or nil.
func elemOf(t *itype) *itype {
	if t == nil {
		return nil
	}
	t = t.underlying()
	if t.cat == valueT {
		switch t.rtype.Kind() {
		case reflect.Slice, reflect.Array, reflect.Ptr, reflect.Chan, reflect.Map:
			return valueTOf(t.rtype.Elem())
		}
		return nil
	}
	return t.val
}

// keyElemOf is the key and element types of a map type, or nils.
func keyElemOf(t *itype) (*itype, *itype) {
	if t == nil {
		return nil, nil
	}
	t = t.underlying()
	if t.cat == valueT {
		if t.rtype.Kind() == reflect.Map {
			return valueTOf(t.rtype.Key()), valueTOf(t.rtype.Elem())
		}
		return nil, nil
	}
	if t.cat != mapT {
		return nil, nil
	}
	return t.key, t.val
}

// untypedRank orders untyped constant kinds as Go's default type selection does.
func untypedRank(t *itype) int {
	switch t.TypeOf().Kind() {
	case reflect.Int32:
		return 1
	case reflect.Float32, reflect.Float64:
		return 2
	case reflect.Complex64, reflect.Complex128:
		return 3
	}
	return 0
}

// untypedDefault is the default type of an untyped constant type.
func untypedDefault(sc *scope, t *itype) *itype {
	name := "int"
	switch t.TypeOf().Kind() {
	case reflect.Bool:
		name = "bool"
	case reflect.String:
		name = "string"
	case reflect.Int32:
		name = "rune"
	case reflect.Float32, reflect.Float64:
		name = "float64"
	case reflect.Complex64, reflect.Complex128:
		name = "complex128"
	}
	if d := sc.getType(name); d != nil {
		return d
	}
	return t
}

func checkConstraint(it, ct *itype) error {
	if len(ct.constraint) == 0 && len(ct.ulconstraint) == 0 {
		return nil
	}
	for _, c := range ct.constraint {
		if it.equals(c) || it.matchDefault(c) {
			return nil
		}
	}
	for _, c := range ct.ulconstraint {
		if it.underlying().equals(c) || it.matchDefault(c) {
			return nil
		}
	}
	return it.node.cfgErrorf("%s does not implement %s", it.id(), ct.id())
}
