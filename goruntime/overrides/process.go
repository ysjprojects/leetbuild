package overrides

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"reflect"
	"sync"
	"syscall"

	"leetbuild/goruntime/world"
)

// Process is the per-check view of the learner's process: its environment, the course's files it
// may read, where its log output goes, and its pid (a second instance of the program is another
// process on the same host).
type Process struct {
	Env    map[string]string
	Files  fs.FS // course support files by path (certificates, fixtures); nil: none
	Stderr io.Writer
	Pid    int // what os.Getpid and syscall.Getpid report; 0 means 1
}

func (p *Process) pid() int {
	if p.Pid == 0 {
		return 1
	}
	return p.Pid
}

// exit ends the program (not the runtime): it records the exit and unwinds the calling goroutine.
func exit(code int, message string) {
	world.Process.Exit(code, message)
	panic(world.ExitPanic{Code: code, Message: message})
}

// Os is the hand-written `os` table: what server programs reach for, with exit and the environment
// kept inside the check.
func (p *Process) Os() map[string]reflect.Value {
	env := p.Env
	if env == nil {
		env = map[string]string{}
	}
	var mu sync.Mutex
	return map[string]reflect.Value{
		"Exit": reflect.ValueOf(func(code int) { exit(code, fmt.Sprintf("exit status %d", code)) }),
		"Getenv": reflect.ValueOf(func(key string) string {
			mu.Lock()
			defer mu.Unlock()
			return env[key]
		}),
		"LookupEnv": reflect.ValueOf(func(key string) (string, bool) {
			mu.Lock()
			defer mu.Unlock()
			v, ok := env[key]
			return v, ok
		}),
		"Setenv": reflect.ValueOf(func(key, value string) error {
			mu.Lock()
			defer mu.Unlock()
			env[key] = value
			return nil
		}),
		"Unsetenv": reflect.ValueOf(func(key string) error {
			mu.Lock()
			defer mu.Unlock()
			delete(env, key)
			return nil
		}),
		"Environ": reflect.ValueOf(func() []string {
			mu.Lock()
			defer mu.Unlock()
			out := make([]string, 0, len(env))
			for k, v := range env {
				out = append(out, k+"="+v)
			}
			return out
		}),
		"ExpandEnv": reflect.ValueOf(func(s string) string {
			return os.Expand(s, func(k string) string {
				mu.Lock()
				defer mu.Unlock()
				return env[k]
			})
		}),
		"Expand":   reflect.ValueOf(os.Expand),
		"Hostname": reflect.ValueOf(func() (string, error) { return "app-1", nil }),
		"Getpid":   reflect.ValueOf(func() int { return p.pid() }),
		"Getppid":  reflect.ValueOf(func() int { return 0 }),
		"Args":     reflect.ValueOf(&[]string{"app"}).Elem(),
		"ReadFile": reflect.ValueOf(func(name string) ([]byte, error) {
			if p.Files == nil {
				return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
			}
			return fs.ReadFile(p.Files, name)
		}),
		"Stdout":      reflect.ValueOf(&os.Stdout).Elem(),
		"Stderr":      reflect.ValueOf(&os.Stderr).Elem(),
		"Stdin":       reflect.ValueOf(&os.Stdin).Elem(),
		"Interrupt":   reflect.ValueOf(&os.Interrupt).Elem(),
		"Kill":        reflect.ValueOf(&os.Kill).Elem(),
		"ErrNotExist": reflect.ValueOf(&os.ErrNotExist).Elem(),
		"ErrExist":    reflect.ValueOf(&os.ErrExist).Elem(),
		"IsNotExist":  reflect.ValueOf(os.IsNotExist),
		"IsExist":     reflect.ValueOf(os.IsExist),
		"Signal":      reflect.ValueOf((*os.Signal)(nil)),
		"File":        reflect.ValueOf((*os.File)(nil)),
		"FileMode":    reflect.ValueOf((*os.FileMode)(nil)),
		"PathError":   reflect.ValueOf((*os.PathError)(nil)),
	}
}

// Signals beyond the ones every platform's syscall package has get stable values of their own, so
// the table compiles for js/wasm (whose syscall has only a few signals) and for the host's tests.
const (
	sigHUP  = syscall.Signal(101)
	sigUSR1 = syscall.Signal(110)
	sigUSR2 = syscall.Signal(112)
	sigPIPE = syscall.Signal(113)
	sigALRM = syscall.Signal(114)
)

// Syscall is the hand-written `syscall` table: the signal names server programs subscribe to.
func (p *Process) Syscall() map[string]reflect.Value {
	return map[string]reflect.Value{
		"Signal":  reflect.ValueOf((*syscall.Signal)(nil)),
		"SIGINT":  reflect.ValueOf(syscall.SIGINT),
		"SIGTERM": reflect.ValueOf(syscall.SIGTERM),
		"SIGQUIT": reflect.ValueOf(syscall.SIGQUIT),
		"SIGKILL": reflect.ValueOf(syscall.SIGKILL),
		"SIGHUP":  reflect.ValueOf(sigHUP),
		"SIGUSR1": reflect.ValueOf(sigUSR1),
		"SIGUSR2": reflect.ValueOf(sigUSR2),
		"SIGPIPE": reflect.ValueOf(sigPIPE),
		"SIGALRM": reflect.ValueOf(sigALRM),
		"Getpid":  reflect.ValueOf(func() int { return p.pid() }),
	}
}

// Signal is `os/signal` on the process model: the harness delivers signals (ctx's program Signal).
func Signal() map[string]reflect.Value {
	return map[string]reflect.Value{
		"Notify": reflect.ValueOf(world.Process.Notify),
		"Stop":   reflect.ValueOf(world.Process.Stop),
		"NotifyContext": reflect.ValueOf(func(parent context.Context, sigs ...os.Signal) (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancelCause(parent)
			c := make(chan os.Signal, 1)
			world.Process.Notify(c, sigs...)
			go func() {
				select {
				case sig := <-c:
					cancel(fmt.Errorf("%v signal received", sig))
				case <-ctx.Done():
				}
				world.Process.Stop(c)
			}()
			return ctx, func() { cancel(context.Canceled) }
		}),
		"Ignore":  reflect.ValueOf(func(...os.Signal) {}),
		"Ignored": reflect.ValueOf(func(os.Signal) bool { return false }),
		"Reset":   reflect.ValueOf(func(...os.Signal) {}),
	}
}

// Log replaces log's Fatal family: the message goes to the program's log output, then the program
// exits with status 1 (the runtime goes on). The rest of `log` is yaegi's (writing to stderr).
func (p *Process) Log() map[string]reflect.Value {
	logger := log.New(p.Stderr, "", log.LstdFlags)
	fatal := func(s string) {
		_ = logger.Output(3, s)
		exit(1, "log.Fatal: "+trimNewline(s))
	}
	return map[string]reflect.Value{
		"Fatal":   reflect.ValueOf(func(v ...any) { fatal(fmt.Sprint(v...)) }),
		"Fatalf":  reflect.ValueOf(func(format string, v ...any) { fatal(fmt.Sprintf(format, v...)) }),
		"Fatalln": reflect.ValueOf(func(v ...any) { fatal(fmt.Sprintln(v...)) }),
	}
}

func trimNewline(s string) string {
	for len(s) > 0 && s[len(s)-1] == '\n' {
		s = s[:len(s)-1]
	}
	return s
}

// IsExit reports whether a recovered panic is a program exit, and its record.
func IsExit(r any) (world.ExitPanic, bool) {
	switch v := r.(type) {
	case world.ExitPanic:
		return v, true
	case error:
		var e world.ExitPanic
		if errors.As(v, &e) {
			return e, true
		}
	}
	return world.ExitPanic{}, false
}
