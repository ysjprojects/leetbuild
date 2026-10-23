package pq

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"reflect"
	"strings"
)

// The harness's side of the database (goruntime/harness DB view). Not part of lib/pq's API.

// HarnessRun runs one statement for the harness: autocommit (it waits for a transaction holding
// the connection to end), not counted as the learner's, logged and probed like any statement.
// Arguments are Go values: driver.Valuer, the types database/sql converts (ints, uints, floats,
// bool, string, []byte, time.Time, pointers to them, nil) and slices, which go as Postgres arrays
// (`= ANY($1)`). Rows come back keyed by column name, decoded for comparison: integers int64,
// floats float64, bool, text/varchar/uuid string, numeric string, bytea []byte, date/timestamp
// time.Time, json/jsonb decoded with encoding/json, arrays []any of their elements, NULL nil,
// anything else its text.
func HarnessRun(ctx context.Context, sql string, args ...any) (rows []map[string]any, affected int64, err error) {
	values := make([]driver.Value, len(args))
	for i, a := range args {
		if values[i], err = harnessArg(a); err != nil {
			return nil, 0, err
		}
	}
	res, err := run(ctx, sql, values, false, false)
	if err != nil {
		return nil, 0, err
	}
	rows = make([]map[string]any, len(res.Rows))
	for i, raw := range res.Rows {
		row := make(map[string]any, len(res.Columns))
		for j, col := range res.Columns {
			if j >= len(raw) || raw[j] == nil {
				row[col.Name] = nil
				continue
			}
			if row[col.Name], err = harnessValue(col.OID, []byte(*raw[j])); err != nil {
				return nil, 0, err
			}
		}
		rows[i] = row
	}
	affected = res.Affected
	if affected < 0 {
		affected = int64(len(res.Rows))
	}
	return rows, affected, nil
}

// HarnessAfter runs fn once, right after the first statement whose text contains pattern
// (case-insensitive) has run, succeeded or failed, before its caller sees the outcome (Db.after).
func HarnessAfter(pattern string, fn func()) {
	world.Lock()
	defer world.Unlock()
	world.probes = append(world.probes, &probe{pattern: strings.ToLower(pattern), fn: fn})
}

// HarnessLog returns copies of the transaction events (BEGIN / COMMIT / ROLLBACK, in order) and of
// the query log.
func HarnessLog() (events []string, queries []LoggedQuery) {
	world.Lock()
	defer world.Unlock()
	return append([]string{}, world.events...), append([]LoggedQuery{}, world.queries...)
}

// HarnessClear empties the logs and drops the probes (Db.clear): a check starts from nothing.
func HarnessClear() {
	world.Lock()
	defer world.Unlock()
	world.events, world.queries, world.probes = nil, nil, nil
}

// HarnessReset clears the logs and probes, drops every table and applies schema (Db.reset).
func HarnessReset(schema string) error {
	HarnessClear()
	b, err := currentBackend()
	if err != nil {
		return err
	}
	return b.Reset(schema)
}

func harnessArg(a any) (driver.Value, error) {
	if v, ok := a.(driver.Valuer); ok {
		return v.Value()
	}
	if a != nil {
		if rv := reflect.ValueOf(a); (rv.Kind() == reflect.Slice || rv.Kind() == reflect.Array) && rv.Type().Elem().Kind() != reflect.Uint8 {
			return GenericArray{a}.Value()
		}
	}
	return driver.DefaultParameterConverter.ConvertValue(a)
}

func harnessValue(oid uint32, s []byte) (any, error) {
	if elem, ok := arrayElems[oid]; ok {
		dims, elems, err := parseArray(s, []byte{','})
		if err != nil {
			return nil, err
		}
		values := make([]any, len(elems))
		for i, e := range elems {
			if e == nil {
				continue
			}
			if values[i], err = harnessValue(elem, e); err != nil {
				return nil, err
			}
		}
		return nest(values, dims), nil
	}
	switch oid {
	case oidNumeric:
		return string(s), nil
	case oidJSON, oidJSONB:
		var v any
		if err := json.Unmarshal(s, &v); err != nil {
			return string(s), nil
		}
		return v, nil
	}
	v, err := textDecode(s, oid)
	if err != nil {
		return nil, err
	}
	if b, ok := v.([]byte); ok && oid != oidBytea {
		return string(b), nil
	}
	return v, nil
}

// nest shapes the flat elements of a multi-dimensional array into nested []any.
func nest(values []any, dims []int) []any {
	if len(dims) <= 1 {
		return values
	}
	step := len(values) / dims[0]
	out := make([]any, dims[0])
	for i := range out {
		out[i] = nest(values[i*step:(i+1)*step], dims[1:])
	}
	return out
}
