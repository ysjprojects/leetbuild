package symbols

// The generated log table routes Fatal through these (yaegi's extract does so for every log table):
// interpreted code must not exit the runtime, so Fatal panics, and the runtime reports the panic.
// Adapted from yaegi's stdlib/restricted.go (Apache 2.0, see third_party/yaegi/LICENSE).

import (
	"io"
	"log"
)

func logFatal(v ...interface{})            { log.Panic(v...) }
func logFatalf(f string, v ...interface{}) { log.Panicf(f, v...) }
func logFatalln(v ...interface{})          { log.Panicln(v...) }

type logLogger struct {
	l *log.Logger
}

func logNew(out io.Writer, prefix string, flag int) *logLogger {
	return &logLogger{log.New(out, prefix, flag)}
}

func (l *logLogger) Fatal(v ...interface{})            { l.l.Panic(v...) }
func (l *logLogger) Fatalf(f string, v ...interface{}) { l.l.Panicf(f, v...) }
func (l *logLogger) Fatalln(v ...interface{})          { l.l.Panicln(v...) }
func (l *logLogger) Flags() int                        { return l.l.Flags() }
func (l *logLogger) Output(d int, s string) error      { return l.l.Output(d, s) }
func (l *logLogger) Panic(v ...interface{})            { l.l.Panic(v...) }
func (l *logLogger) Panicf(f string, v ...interface{}) { l.l.Panicf(f, v...) }
func (l *logLogger) Panicln(v ...interface{})          { l.l.Panicln(v...) }
func (l *logLogger) Prefix() string                    { return l.l.Prefix() }
func (l *logLogger) Print(v ...interface{})            { l.l.Print(v...) }
func (l *logLogger) Printf(f string, v ...interface{}) { l.l.Printf(f, v...) }
func (l *logLogger) Println(v ...interface{})          { l.l.Println(v...) }
func (l *logLogger) SetFlags(flag int)                 { l.l.SetFlags(flag) }
func (l *logLogger) SetOutput(w io.Writer)             { l.l.SetOutput(w) }
func (l *logLogger) Writer() io.Writer                 { return l.l.Writer() }
