package kafka

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// ConfigValue supports the following types:
//
//	bool, int, string, any type with the standard String() interface
type ConfigValue interface{}

// ConfigMap is a map containing standard librdkafka configuration properties as documented in:
// https://github.com/confluentinc/librdkafka/tree/master/CONFIGURATION.md
//
// The special property "default.topic.config" (optional) is a ConfigMap
// containing default topic configuration properties.
//
// The use of "default.topic.config" is deprecated,
// topic configuration properties shall be specified in the standard ConfigMap.
// For backwards compatibility, "default.topic.config" (if supplied)
// takes precedence.
type ConfigMap map[string]ConfigValue

// SetKey sets configuration property key to value.
//
// For user convenience a key prefixed with {topic}. will be
// set on the "default.topic.config" sub-map, this use is deprecated.
func (m ConfigMap) SetKey(key string, value ConfigValue) error {
	if strings.HasPrefix(key, "{topic}.") {
		_, found := m["default.topic.config"]
		if !found {
			m["default.topic.config"] = ConfigMap{}
		}
		m["default.topic.config"].(ConfigMap)[strings.TrimPrefix(key, "{topic}.")] = value
	} else {
		m[key] = value
	}
	return nil
}

// Set implements flag.Set (command line argument parser) as a convenience
// for `-X key=value` config.
func (m ConfigMap) Set(kv string) error {
	i := strings.Index(kv, "=")
	if i == -1 {
		return newErrorFromString(ErrInvalidArg, "Expected key=value")
	}
	return m.SetKey(kv[:i], kv[i+1:])
}

// Get finds the given key in the ConfigMap and returns its value.
// If the key is not found `defval` is returned.
// If the key is found but the type does not match that of `defval` (unless nil)
// an ErrInvalidArg error is returned.
func (m ConfigMap) Get(key string, defval ConfigValue) (ConfigValue, error) {
	return m.get(key, defval)
}

func (m ConfigMap) get(key string, defval ConfigValue) (ConfigValue, error) {
	if strings.HasPrefix(key, "{topic}.") {
		defconfCv, found := m["default.topic.config"]
		if !found {
			return defval, nil
		}
		return defconfCv.(ConfigMap).get(strings.TrimPrefix(key, "{topic}."), defval)
	}
	v, ok := m[key]
	if !ok {
		return defval, nil
	}
	if defval != nil && reflect.TypeOf(defval) != reflect.TypeOf(v) {
		return nil, newErrorFromString(ErrInvalidArg, fmt.Sprintf("%s expects type %T, not %T", key, defval, v))
	}
	return v, nil
}

func (m ConfigMap) clone() ConfigMap {
	m2 := make(ConfigMap)
	for k, v := range m {
		m2[k] = v
	}
	return m2
}

// lookup is the property as librdkafka reads it (a topic property may sit in default.topic.config,
// which takes precedence), as text.
func (m ConfigMap) lookup(keys ...string) (string, bool) {
	for _, key := range keys {
		if sub, ok := m["default.topic.config"].(ConfigMap); ok {
			if v, ok := sub[key]; ok {
				return value2string(v), true
			}
		}
		if v, ok := m[key]; ok {
			return value2string(v), true
		}
	}
	return "", false
}

func value2string(v ConfigValue) string {
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x
	case fmt.Stringer:
		return x.String()
	default:
		return fmt.Sprint(x)
	}
}

func (m ConfigMap) boolean(def bool, keys ...string) (bool, error) {
	s, ok := m.lookup(keys...)
	if !ok {
		return def, nil
	}
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "t", "1", "yes", "on":
		return true, nil
	case "false", "f", "0", "no", "off":
		return false, nil
	}
	return false, newErrorFromString(ErrInvalidArg, fmt.Sprintf("Invalid value \"%s\" for configuration property \"%s\"", s, keys[0]))
}

func (m ConfigMap) integer(def int, keys ...string) (int, error) {
	s, ok := m.lookup(keys...)
	if !ok {
		return def, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, newErrorFromString(ErrInvalidArg, fmt.Sprintf("Invalid value \"%s\" for configuration property \"%s\"", s, keys[0]))
	}
	return n, nil
}

func (m ConfigMap) millis(def time.Duration, keys ...string) (time.Duration, error) {
	n, err := m.integer(int(def/time.Millisecond), keys...)
	return time.Duration(n) * time.Millisecond, err
}

// text is every property as text, for the harness.
func (m ConfigMap) text() map[string]string {
	out := map[string]string{}
	for k, v := range m {
		if sub, ok := v.(ConfigMap); ok {
			for sk, sv := range sub {
				out[sk] = value2string(sv)
			}
			continue
		}
		out[k] = value2string(v)
	}
	return out
}
