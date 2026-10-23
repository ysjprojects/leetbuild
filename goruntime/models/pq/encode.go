// Text-format encoding and decoding of Postgres values. The time and bytea code is ported from
// github.com/lib/pq v1.10.9 (encode.go): MIT License, Copyright (c) 2011-2013 'pq' Contributors,
// Portions Copyright (C) 2011 Blake Mizerany.

package pq

import (
	"bytes"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Postgres type OIDs the driver decodes (pg_type.oid).
const (
	oidBool        uint32 = 16
	oidBytea       uint32 = 17
	oidChar        uint32 = 18
	oidName        uint32 = 19
	oidInt8        uint32 = 20
	oidInt2        uint32 = 21
	oidInt4        uint32 = 23
	oidText        uint32 = 25
	oidOID         uint32 = 26
	oidJSON        uint32 = 114
	oidFloat4      uint32 = 700
	oidFloat8      uint32 = 701
	oidUnknown     uint32 = 705
	oidBpchar      uint32 = 1042
	oidVarchar     uint32 = 1043
	oidDate        uint32 = 1082
	oidTime        uint32 = 1083
	oidTimestamp   uint32 = 1114
	oidTimestamptz uint32 = 1184
	oidInterval    uint32 = 1186
	oidTimetz      uint32 = 1266
	oidNumeric     uint32 = 1700
	oidUUID        uint32 = 2950
	oidJSONB       uint32 = 3802
)

// typeNames are the names lib/pq reports as ColumnTypeDatabaseTypeName; arrays are "_<elem>".
var typeNames = map[uint32]string{
	oidBool: "BOOL", oidBytea: "BYTEA", oidChar: "CHAR", oidName: "NAME", oidInt8: "INT8", oidInt2: "INT2",
	oidInt4: "INT4", oidText: "TEXT", oidOID: "OID", oidJSON: "JSON", oidFloat4: "FLOAT4", oidFloat8: "FLOAT8",
	oidUnknown: "UNKNOWN", oidBpchar: "BPCHAR", oidVarchar: "VARCHAR", oidDate: "DATE", oidTime: "TIME",
	oidTimestamp: "TIMESTAMP", oidTimestamptz: "TIMESTAMPTZ", oidInterval: "INTERVAL", oidTimetz: "TIMETZ",
	oidNumeric: "NUMERIC", oidUUID: "UUID", oidJSONB: "JSONB",
	1000: "_BOOL", 1001: "_BYTEA", 1002: "_CHAR", 1003: "_NAME", 1016: "_INT8", 1005: "_INT2", 1007: "_INT4",
	1009: "_TEXT", 1028: "_OID", 199: "_JSON", 1021: "_FLOAT4", 1022: "_FLOAT8", 1014: "_BPCHAR",
	1015: "_VARCHAR", 1182: "_DATE", 1183: "_TIME", 1115: "_TIMESTAMP", 1185: "_TIMESTAMPTZ",
	1187: "_INTERVAL", 1270: "_TIMETZ", 1231: "_NUMERIC", 2951: "_UUID", 3807: "_JSONB",
}

// arrayElems maps an array type to its element type.
var arrayElems = map[uint32]uint32{
	1000: oidBool, 1001: oidBytea, 1002: oidChar, 1003: oidName, 1016: oidInt8, 1005: oidInt2, 1007: oidInt4,
	1009: oidText, 1028: oidOID, 199: oidJSON, 1021: oidFloat4, 1022: oidFloat8, 1014: oidBpchar,
	1015: oidVarchar, 1182: oidDate, 1183: oidTime, 1115: oidTimestamp, 1185: oidTimestamptz,
	1187: oidInterval, 1270: oidTimetz, 1231: oidNumeric, 2951: oidUUID, 3807: oidJSONB,
}

// sessionLocation is the session's TimeZone: PGlite runs in UTC.
var sessionLocation = time.UTC

// encodeArg turns a driver value into what the backend sends: nil (NULL), the text format, or
// []byte sent as is (lib/pq sends byte slices in binary format, so they land verbatim in bytea and
// text columns alike).
func encodeArg(v driver.Value) (any, error) {
	switch x := v.(type) {
	case nil:
		return nil, nil
	case []byte:
		return x, nil
	}
	text, err := encodeText(v)
	if err != nil {
		return nil, err
	}
	return string(text), nil
}

// encodeText is lib/pq's text encoding of a driver value.
func encodeText(v driver.Value) ([]byte, error) {
	switch x := v.(type) {
	case int64:
		return strconv.AppendInt(nil, x, 10), nil
	case float64:
		return strconv.AppendFloat(nil, x, 'f', -1, 64), nil
	case []byte:
		return x, nil
	case string:
		return []byte(x), nil
	case bool:
		return strconv.AppendBool(nil, x), nil
	case time.Time:
		return formatTs(x), nil
	}
	return nil, fmt.Errorf("pq: encode: unknown type for %T", v)
}

// textDecode is lib/pq's decoding of a text-format column value into a driver value.
func textDecode(s []byte, typ uint32) (driver.Value, error) {
	switch typ {
	case oidChar, oidVarchar, oidText, oidBpchar, oidName, oidUUID:
		return string(s), nil
	case oidBytea:
		b, err := parseBytea(s)
		if err != nil {
			return nil, fmt.Errorf("pq: %s", err)
		}
		return b, nil
	case oidTimestamptz:
		return parseTs(sessionLocation, string(s))
	case oidTimestamp, oidDate:
		return parseTs(nil, string(s))
	case oidTime:
		return mustParse("15:04:05", typ, s)
	case oidTimetz:
		return mustParse("15:04:05-07", typ, s)
	case oidBool:
		return len(s) > 0 && s[0] == 't', nil
	case oidInt8, oidInt4, oidInt2:
		i, err := strconv.ParseInt(string(s), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("pq: %s", err)
		}
		return i, nil
	case oidFloat4, oidFloat8:
		f, err := strconv.ParseFloat(string(s), 64)
		if err != nil {
			return nil, fmt.Errorf("pq: %s", err)
		}
		return f, nil
	}
	return s, nil
}

var time2400Regex = regexp.MustCompile(`^(24:00(?::00(?:\.0+)?)?)(?:[Z+-].*)?$`)

func mustParse(f string, typ uint32, s []byte) (time.Time, error) {
	str := string(s)

	// Check for a minute and second offset in the timezone.
	if typ == oidTimestamptz || typ == oidTimetz {
		for i := 3; i <= 6; i += 3 {
			if len(str) >= i && str[len(str)-i] == ':' {
				f += ":00"
				continue
			}
			break
		}
	}

	// Go does not parse 24:00: parse 00:00 and add a day.
	var is2400Time bool
	switch typ {
	case oidTimetz, oidTime:
		if matches := time2400Regex.FindStringSubmatch(str); matches != nil {
			str = "00:00:00" + str[len(matches[1]):]
			is2400Time = true
		}
	}
	t, err := time.Parse(f, str)
	if err != nil {
		return time.Time{}, fmt.Errorf("pq: decode: %s", err)
	}
	if is2400Time {
		t = t.Add(24 * time.Hour)
	}
	return t, nil
}

var errInvalidTimestamp = errors.New("invalid timestamp")

type timestampParser struct {
	err error
}

func (p *timestampParser) expect(str string, char byte, pos int) {
	if p.err != nil {
		return
	}
	if pos+1 > len(str) {
		p.err = errInvalidTimestamp
		return
	}
	if c := str[pos]; c != char && p.err == nil {
		p.err = fmt.Errorf("expected '%v' at position %v; got '%v'", char, pos, c)
	}
}

func (p *timestampParser) mustAtoi(str string, begin int, end int) int {
	if p.err != nil {
		return 0
	}
	if begin < 0 || end < 0 || begin > end || end > len(str) {
		p.err = errInvalidTimestamp
		return 0
	}
	result, err := strconv.Atoi(str[begin:end])
	if err != nil {
		if p.err == nil {
			p.err = fmt.Errorf("expected number; got '%v'", str)
		}
		return 0
	}
	return result
}

// locations caches the fixed zones of the offsets the server sent.
var locations = struct {
	sync.Mutex
	m map[int]*time.Location
}{m: map[int]*time.Location{}}

func fixedZone(offset int) *time.Location {
	locations.Lock()
	defer locations.Unlock()
	loc, ok := locations.m[offset]
	if !ok {
		loc = time.FixedZone("", offset)
		locations.m[offset] = loc
	}
	return loc
}

var infinityTs = struct {
	sync.Mutex
	enabled            bool
	negative, positive time.Time
}{}

const (
	infinityTsEnabledAlready        = "pq: infinity timestamp enabled already"
	infinityTsNegativeMustBeSmaller = "pq: infinity timestamp: negative value must be smaller (before) than positive"
)

// EnableInfinityTs controls the handling of Postgres' "-infinity" and "infinity" timestamps.
//
// If EnableInfinityTs is not called, "-infinity" and "infinity" decode to []byte("-infinity") and
// []byte("infinity"). Once it has been called, they decode to negative and positive, and time.Time
// values at or past them encode to "-infinity" / "infinity". It panics if negative >= positive or
// when called twice.
func EnableInfinityTs(negative time.Time, positive time.Time) {
	infinityTs.Lock()
	defer infinityTs.Unlock()
	if infinityTs.enabled {
		panic(infinityTsEnabledAlready)
	}
	if !negative.Before(positive) {
		panic(infinityTsNegativeMustBeSmaller)
	}
	infinityTs.enabled = true
	infinityTs.negative = negative
	infinityTs.positive = positive
}

func infinity() (bool, time.Time, time.Time) {
	infinityTs.Lock()
	defer infinityTs.Unlock()
	return infinityTs.enabled, infinityTs.negative, infinityTs.positive
}

func parseTs(currentLocation *time.Location, str string) (driver.Value, error) {
	switch str {
	case "-infinity", "infinity":
		if enabled, negative, positive := infinity(); enabled {
			if str == "infinity" {
				return positive, nil
			}
			return negative, nil
		}
		return []byte(str), nil
	}
	t, err := ParseTimestamp(currentLocation, str)
	if err != nil {
		return nil, err
	}
	return t, nil
}

// ParseTimestamp parses Postgres' text format. It returns a time.Time in currentLocation iff that
// time's offset agrees with the offset sent from the Postgres server. Otherwise, ParseTimestamp
// returns a time.Time with the fixed offset offset provided by the Postgres server.
func ParseTimestamp(currentLocation *time.Location, str string) (time.Time, error) {
	p := timestampParser{}

	monSep := strings.IndexRune(str, '-')
	// this is Gregorian year, not ISO Year
	// In Gregorian system, the year 1 BC is followed by AD 1
	year := p.mustAtoi(str, 0, monSep)
	daySep := monSep + 3
	month := p.mustAtoi(str, monSep+1, daySep)
	p.expect(str, '-', daySep)
	timeSep := daySep + 3
	day := p.mustAtoi(str, daySep+1, timeSep)

	minLen := monSep + len("01-01") + 1

	isBC := strings.HasSuffix(str, " BC")
	if isBC {
		minLen += 3
	}

	var hour, minute, second int
	if len(str) > minLen {
		p.expect(str, ' ', timeSep)
		minSep := timeSep + 3
		p.expect(str, ':', minSep)
		hour = p.mustAtoi(str, timeSep+1, minSep)
		secSep := minSep + 3
		p.expect(str, ':', secSep)
		minute = p.mustAtoi(str, minSep+1, secSep)
		secEnd := secSep + 3
		second = p.mustAtoi(str, secSep+1, secEnd)
	}
	remainderIdx := monSep + len("01-01 00:00:00") + 1
	// Three optional (but ordered) sections follow: the fractional seconds, the time zone offset,
	// and the BC designation.

	nanoSec := 0
	tzOff := 0

	if remainderIdx < len(str) && str[remainderIdx] == '.' {
		fracStart := remainderIdx + 1
		fracOff := strings.IndexAny(str[fracStart:], "-+Z ")
		if fracOff < 0 {
			fracOff = len(str) - fracStart
		}
		fracSec := p.mustAtoi(str, fracStart, fracStart+fracOff)
		nanoSec = fracSec * (1000000000 / int(math.Pow(10, float64(fracOff))))

		remainderIdx += fracOff + 1
	}
	if tzStart := remainderIdx; tzStart < len(str) && (str[tzStart] == '-' || str[tzStart] == '+') {
		// time zone separator is always '-' or '+' or 'Z' (UTC is +00)
		var tzSign int
		switch c := str[tzStart]; c {
		case '-':
			tzSign = -1
		case '+':
			tzSign = +1
		default:
			return time.Time{}, fmt.Errorf("expected '-' or '+' at position %v; got %v", tzStart, c)
		}
		tzHours := p.mustAtoi(str, tzStart+1, tzStart+3)
		remainderIdx += 3
		var tzMin, tzSec int
		if remainderIdx < len(str) && str[remainderIdx] == ':' {
			tzMin = p.mustAtoi(str, remainderIdx+1, remainderIdx+3)
			remainderIdx += 3
		}
		if remainderIdx < len(str) && str[remainderIdx] == ':' {
			tzSec = p.mustAtoi(str, remainderIdx+1, remainderIdx+3)
			remainderIdx += 3
		}
		tzOff = tzSign * ((tzHours * 60 * 60) + (tzMin * 60) + tzSec)
	} else if tzStart < len(str) && str[tzStart] == 'Z' {
		// time zone Z separator indicates UTC is +00
		remainderIdx += 1
	}

	var isoYear int

	if isBC {
		isoYear = 1 - year
		remainderIdx += 3
	} else {
		isoYear = year
	}
	if remainderIdx < len(str) {
		return time.Time{}, fmt.Errorf("expected end of input, got %v", str[remainderIdx:])
	}
	t := time.Date(isoYear, time.Month(month), day,
		hour, minute, second, nanoSec,
		fixedZone(tzOff))

	if currentLocation != nil {
		// Set the location of the returned Time based on the session's TimeZone value, but only if
		// the local time zone database agrees with the remote database on the offset.
		lt := t.In(currentLocation)
		_, newOff := lt.Zone()
		if newOff == tzOff {
			t = lt
		}
	}

	return t, p.err
}

// formatTs formats t into a format postgres understands.
func formatTs(t time.Time) []byte {
	if enabled, negative, positive := infinity(); enabled {
		if !t.After(negative) {
			return []byte("-infinity")
		}
		if !t.Before(positive) {
			return []byte("infinity")
		}
	}
	return FormatTimestamp(t)
}

// FormatTimestamp formats t into Postgres' text format for timestamps.
func FormatTimestamp(t time.Time) []byte {
	// Need to send dates before 0001 A.D. with " BC" suffix, instead of the minus sign preferred
	// by Go. Beware, "0000" in ISO is "1 BC", "-0001" is "2 BC" and so on.
	bc := false
	if t.Year() <= 0 {
		// flip year sign, and add 1, e.g: "0" will be "1", and "-10" will be "11"
		t = t.AddDate((-t.Year())*2+1, 0, 0)
		bc = true
	}
	b := []byte(t.Format("2006-01-02 15:04:05.999999999Z07:00"))

	_, offset := t.Zone()
	offset %= 60
	if offset != 0 {
		// RFC3339Nano already printed the minus sign
		if offset < 0 {
			offset = -offset
		}

		b = append(b, ':')
		if offset < 10 {
			b = append(b, '0')
		}
		b = strconv.AppendInt(b, int64(offset), 10)
	}

	if bc {
		b = append(b, " BC"...)
	}
	return b
}

// parseBytea parses a bytea value received from the server, in the "hex" or the legacy "escape"
// format.
func parseBytea(s []byte) (result []byte, err error) {
	if len(s) >= 2 && bytes.Equal(s[:2], []byte("\\x")) {
		s = s[2:]
		result = make([]byte, hex.DecodedLen(len(s)))
		if _, err := hex.Decode(result, s); err != nil {
			return nil, err
		}
		return result, nil
	}
	for len(s) > 0 {
		if s[0] == '\\' {
			// escaped '\\'
			if len(s) >= 2 && s[1] == '\\' {
				result = append(result, '\\')
				s = s[2:]
				continue
			}

			// '\\' followed by an octal number
			if len(s) < 4 {
				return nil, fmt.Errorf("invalid bytea sequence %v", s)
			}
			r, err := strconv.ParseUint(string(s[1:4]), 8, 8)
			if err != nil {
				return nil, fmt.Errorf("could not parse bytea value: %s", err.Error())
			}
			result = append(result, byte(r))
			s = s[4:]
		} else {
			// An unescaped, raw byte: read in as many as possible in one go.
			i := bytes.IndexByte(s, '\\')
			if i == -1 {
				result = append(result, s...)
				break
			}
			result = append(result, s[:i]...)
			s = s[i:]
		}
	}
	return result, nil
}

// NullTime represents a time.Time that may be null. NullTime implements the sql.Scanner interface
// so it can be used as a scan destination, similar to sql.NullString.
type NullTime struct {
	Time  time.Time
	Valid bool // Valid is true if Time is not NULL
}

// Scan implements the Scanner interface.
func (nt *NullTime) Scan(value interface{}) error {
	nt.Time, nt.Valid = value.(time.Time)
	return nil
}

// Value implements the driver Valuer interface.
func (nt NullTime) Value() (driver.Value, error) {
	if !nt.Valid {
		return nil, nil
	}
	return nt.Time, nil
}
