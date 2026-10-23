package harness

import (
	"reflect"

	"leetbuild/goruntime/world"
)

// Instance is another instance of the learner's program in the check's world: the same build
// started again as a second process on the same host, with fresh package variables and its own
// pid, sharing Redis, the broker, the database and the clock (the TypeScript harness's
// ctx.modules.purge() followed by a second ctx.load).
type Instance struct {
	ctx    *Ctx
	lookup func(name string) (reflect.Value, bool)
}

// Instance starts another instance of the learner's program; the check fails when it cannot.
func (c *Ctx) Instance() *Instance {
	if world.SpawnInstance == nil {
		c.Fatalf("this runtime cannot start a second instance of the program")
	}
	lookup, err := world.SpawnInstance()
	if err != nil {
		c.Fatalf("a second instance of the program did not start: %v", err)
	}
	return &Instance{ctx: c, lookup: lookup}
}

// Get is the instance's package-level name: a function, to assert to its type
// (b.Get("runConsumer").(func(context.Context))), or a variable's current value.
func (in *Instance) Get(name string) any {
	v, ok := in.lookup(name)
	if !ok || !v.IsValid() {
		in.ctx.Fatalf("the program has no package-level %s", name)
	}
	return v.Interface()
}

// Set assigns the instance's package-level variable name. The value must have the variable's type
// as the instance sees it: the instance compiled its own copy of every type, so build values that
// involve the program's types inside the instance, from its own copy of the harness file
// (b.Set("localDeliver", b.Get("recordDelivery"))).
func (in *Instance) Set(name string, value any) {
	v, ok := in.lookup(name)
	if !ok || !v.IsValid() {
		in.ctx.Fatalf("the program has no package-level %s", name)
	}
	if !v.CanSet() {
		in.ctx.Fatalf("%s is not a variable of the program", name)
	}
	nv := reflect.ValueOf(value)
	switch {
	case !nv.IsValid():
		v.Set(reflect.Zero(v.Type()))
	case nv.Type().AssignableTo(v.Type()):
		v.Set(nv)
	case nv.Type().ConvertibleTo(v.Type()):
		v.Set(nv.Convert(v.Type()))
	default:
		in.ctx.Fatalf("%s is a %s in the instance, the value a %s: build the value inside the instance (b.Get of its copy of a harness function)", name, v.Type(), nv.Type())
	}
}
