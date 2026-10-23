// Package pq is the in-process model of github.com/lib/pq, the Postgres driver for database/sql,
// registered as "postgres". Statements go to the runtime's database (Backend: one PGlite session
// shared with the TypeScript runtime) with their $n placeholders as written. Like a pool of size
// one, a transaction holds the single connection from BEGIN to COMMIT/ROLLBACK, so it is isolated
// from every other statement, which waits. Values travel in Postgres text format and decode the
// way lib/pq decodes them.
package pq

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"time"
)

// Common error types
var (
	ErrNotSupported           = errors.New("pq: Unsupported command")
	ErrInFailedTransaction    = errors.New("pq: Could not complete operation in a failed transaction")
	ErrSSLNotSupported        = errors.New("pq: SSL is not enabled on the server")
	ErrCouldNotDetectUsername = errors.New("pq: Could not detect default username. Please provide one explicitly")
)

func init() {
	sql.Register("postgres", &Driver{})
}

// Driver is the Postgres database driver.
type Driver struct{}

// Open opens a new connection to the database. name is a connection string; the runtime has one
// database, so its settings are not used.
func (d Driver) Open(name string) (driver.Conn, error) {
	return Open(name)
}

// Open opens a new connection to the database. dsn is a connection string; the runtime has one
// database, so its settings are not used.
func Open(dsn string) (_ driver.Conn, err error) {
	return &conn{}, nil
}

// Connector represents a fixed configuration for the pq driver with a given name. Connector
// satisfies the database/sql/driver Connector interface and can be used to create any number of
// DB Conn's via the database/sql OpenDB function.
type Connector struct {
	dsn string
}

// Connect returns a connection to the database using the fixed configuration of this Connector.
// Context is not used.
func (c *Connector) Connect(ctx context.Context) (driver.Conn, error) {
	return Open(c.dsn)
}

// Driver returns the underlying driver of this Connector.
func (c *Connector) Driver() driver.Driver {
	return &Driver{}
}

// NewConnector returns a connector for the pq driver in a fixed configuration with the given dsn.
// The returned connector can be used to create any number of equivalent Conn's. The returned
// connector is intended to be used with database/sql.OpenDB.
func NewConnector(dsn string) (*Connector, error) {
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		if _, err := ParseURL(dsn); err != nil {
			return nil, err
		}
	}
	return &Connector{dsn: dsn}, nil
}

// conn is one database/sql connection: a handle on the backend's single session. It holds the
// session (release non-nil) while a transaction is open.
type conn struct {
	release  func()
	txFailed bool // a statement of the open transaction failed: Postgres ignores the rest
	closed   bool
}

var (
	_ driver.Conn               = (*conn)(nil)
	_ driver.ConnBeginTx        = (*conn)(nil)
	_ driver.ConnPrepareContext = (*conn)(nil)
	_ driver.ExecerContext      = (*conn)(nil)
	_ driver.QueryerContext     = (*conn)(nil)
	_ driver.Pinger             = (*conn)(nil)
	_ driver.SessionResetter    = (*conn)(nil)
	_ driver.Validator          = (*conn)(nil)
)

func (c *conn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *conn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if c.closed {
		return nil, driver.ErrBadConn
	}
	return &stmt{c: c, query: query}, nil
}

// Close gives the session back, rolling back a transaction left open.
func (c *conn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	if c.release != nil {
		_, _ = run(context.Background(), "ROLLBACK", nil, true, true)
		c.endTx()
	}
	return nil
}

func (c *conn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

// BeginTx takes the connection and opens a transaction: `BEGIN` with the isolation level and the
// access mode, as lib/pq sends it.
func (c *conn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if c.closed {
		return nil, driver.ErrBadConn
	}
	if c.release != nil {
		return nil, errors.New("pq: there is already a transaction in progress")
	}
	var mode string
	switch sql.IsolationLevel(opts.Isolation) {
	case sql.LevelDefault:
	case sql.LevelReadUncommitted:
		mode = " ISOLATION LEVEL READ UNCOMMITTED"
	case sql.LevelReadCommitted:
		mode = " ISOLATION LEVEL READ COMMITTED"
	case sql.LevelRepeatableRead:
		mode = " ISOLATION LEVEL REPEATABLE READ"
	case sql.LevelSerializable:
		mode = " ISOLATION LEVEL SERIALIZABLE"
	default:
		return nil, fmt.Errorf("pq: isolation level not supported: %d", opts.Isolation)
	}
	if opts.ReadOnly {
		mode += " READ ONLY"
	} else {
		mode += " READ WRITE"
	}
	b, err := currentBackend()
	if err != nil {
		return nil, err
	}
	release, err := b.Hold(ctx)
	if err != nil {
		return nil, err
	}
	c.release, c.txFailed = release, false
	if _, err := run(ctx, "BEGIN"+mode, nil, true, true); err != nil {
		c.endTx()
		return nil, err
	}
	return &tx{c: c}, nil
}

func (c *conn) endTx() {
	release := c.release
	c.release, c.txFailed = nil, false
	if release != nil {
		release()
	}
}

func (c *conn) Ping(ctx context.Context) error {
	if c.closed {
		return driver.ErrBadConn
	}
	_, err := currentBackend()
	return err
}

func (c *conn) ResetSession(ctx context.Context) error {
	if c.closed {
		return driver.ErrBadConn
	}
	return nil
}

func (c *conn) IsValid() bool { return !c.closed }

func (c *conn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	res, err := c.statement(ctx, query, namedValues(args))
	if err != nil {
		return nil, err
	}
	if res.Affected < 0 {
		return driver.RowsAffected(len(res.Rows)), nil
	}
	return driver.RowsAffected(res.Affected), nil
}

func (c *conn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	res, err := c.statement(ctx, query, namedValues(args))
	if err != nil {
		return nil, err
	}
	return &rows{res: res}, nil
}

// statement runs one statement on this connection: inside its transaction when one is open.
func (c *conn) statement(ctx context.Context, query string, args []driver.Value) (BackendResult, error) {
	if c.closed {
		return BackendResult{}, driver.ErrBadConn
	}
	if err := ctx.Err(); err != nil {
		return BackendResult{}, err
	}
	held := c.release != nil
	res, err := run(ctx, query, args, held, true)
	if held {
		upper := strings.ToUpper(strings.TrimSpace(query))
		switch {
		case err != nil:
			c.txFailed = true
		case strings.HasPrefix(upper, "ROLLBACK TO"):
			c.txFailed = false
		}
	}
	return res, err
}

func namedValues(args []driver.NamedValue) []driver.Value {
	values := make([]driver.Value, len(args))
	for i, a := range args {
		values[i] = a.Value
	}
	return values
}

type tx struct{ c *conn }

// Commit sends COMMIT and gives the connection back. In a transaction a statement of which failed,
// Postgres rolls back instead, and Commit reports ErrInFailedTransaction (as lib/pq does).
func (t *tx) Commit() error {
	c := t.c
	if c.release == nil {
		return sql.ErrTxDone
	}
	failed := c.txFailed
	_, err := run(context.Background(), "COMMIT", nil, true, true)
	c.endTx()
	if err != nil {
		return err
	}
	if failed {
		return ErrInFailedTransaction
	}
	return nil
}

// Rollback sends ROLLBACK and gives the connection back.
func (t *tx) Rollback() error {
	c := t.c
	if c.release == nil {
		return sql.ErrTxDone
	}
	_, err := run(context.Background(), "ROLLBACK", nil, true, true)
	c.endTx()
	return err
}

type stmt struct {
	c     *conn
	query string
}

var (
	_ driver.StmtExecContext  = (*stmt)(nil)
	_ driver.StmtQueryContext = (*stmt)(nil)
)

func (s *stmt) Close() error  { return nil }
func (s *stmt) NumInput() int { return -1 }

func (s *stmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.c.ExecContext(context.Background(), s.query, valuesNamed(args))
}

func (s *stmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.c.QueryContext(context.Background(), s.query, valuesNamed(args))
}

func (s *stmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.c.ExecContext(ctx, s.query, args)
}

func (s *stmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	return s.c.QueryContext(ctx, s.query, args)
}

func valuesNamed(args []driver.Value) []driver.NamedValue {
	named := make([]driver.NamedValue, len(args))
	for i, v := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: v}
	}
	return named
}

// rows walks a result the backend returned whole, decoding each row as it is read.
type rows struct {
	res  BackendResult
	next int
}

var (
	_ driver.RowsColumnTypeDatabaseTypeName = (*rows)(nil)
	_ driver.RowsColumnTypeScanType         = (*rows)(nil)
)

func (r *rows) Columns() []string {
	names := make([]string, len(r.res.Columns))
	for i, c := range r.res.Columns {
		names[i] = c.Name
	}
	return names
}

func (r *rows) Close() error {
	r.next = len(r.res.Rows)
	return nil
}

func (r *rows) Next(dest []driver.Value) error {
	if r.next >= len(r.res.Rows) {
		return io.EOF
	}
	raw := r.res.Rows[r.next]
	r.next++
	for i := range dest {
		if i >= len(raw) || raw[i] == nil {
			dest[i] = nil
			continue
		}
		v, err := textDecode([]byte(*raw[i]), r.res.Columns[i].OID)
		if err != nil {
			return err
		}
		dest[i] = v
	}
	return nil
}

// ColumnTypeDatabaseTypeName returns the column's type name in upper case ("INT8", "TEXT",
// "_TEXT" for text[]), "" for a type the driver does not know.
func (r *rows) ColumnTypeDatabaseTypeName(index int) string {
	return typeNames[r.res.Columns[index].OID]
}

// ColumnTypeScanType returns the Go type the column's values decode to.
func (r *rows) ColumnTypeScanType(index int) reflect.Type {
	switch r.res.Columns[index].OID {
	case oidChar, oidVarchar, oidText, oidBpchar, oidName, oidUUID:
		return reflect.TypeOf("")
	case oidInt8, oidInt4, oidInt2:
		return reflect.TypeOf(int64(0))
	case oidFloat4, oidFloat8:
		return reflect.TypeOf(float64(0))
	case oidBool:
		return reflect.TypeOf(false)
	case oidDate, oidTime, oidTimetz, oidTimestamp, oidTimestamptz:
		return reflect.TypeOf(time.Time{})
	}
	return reflect.TypeOf([]byte(nil))
}

// QuoteIdentifier quotes an "identifier" (e.g. a table or a column name) to be used as part of an
// SQL statement. Any double quotes in name will be escaped. The quoted identifier will be case
// sensitive when used in a query. If the input string contains a zero byte, the result will be
// truncated immediately before it.
func QuoteIdentifier(name string) string {
	end := strings.IndexRune(name, 0)
	if end > -1 {
		name = name[:end]
	}
	return `"` + strings.Replace(name, `"`, `""`, -1) + `"`
}

// BufferQuoteIdentifier satisfies the same purpose as QuoteIdentifier, but backed by a byte buffer.
func BufferQuoteIdentifier(name string, buffer *bytes.Buffer) {
	end := strings.IndexRune(name, 0)
	if end > -1 {
		name = name[:end]
	}
	buffer.WriteRune('"')
	buffer.WriteString(strings.Replace(name, `"`, `""`, -1))
	buffer.WriteRune('"')
}

// QuoteLiteral quotes a 'literal' (e.g. a parameter, often used to pass literal to DDL and other
// statements that do not accept parameters) to be used as part of an SQL statement. Any single
// quotes in name will be escaped. Any backslashes (i.e. "\") will be replaced by two backslashes
// (i.e. "\\") and the C-style escape identifier that PostgreSQL provides ('E') will be prepended to
// the string.
func QuoteLiteral(literal string) string {
	literal = strings.Replace(literal, `'`, `''`, -1)
	if strings.Contains(literal, `\`) {
		literal = strings.Replace(literal, `\`, `\\`, -1)
		literal = ` E'` + literal + `'`
	} else {
		literal = `'` + literal + `'`
	}
	return literal
}
