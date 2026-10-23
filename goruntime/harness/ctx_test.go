package harness

import "testing"

func TestEqualComparesNumbersByValueAtAnyDepth(t *testing.T) {
	cases := []struct {
		got, want any
		equal     bool
	}{
		{1, int64(1), true},
		{[]any{1, "a"}, []any{int64(1), "a"}, true},
		{map[string]any{"n": 2, "xs": []any{1.0}}, map[string]any{"n": 2.0, "xs": []any{uint8(1)}}, true},
		{[]any{1}, []any{"1"}, false},
		{[]any{1, 2}, []any{1}, false},
		{map[string]any{"n": 1}, map[string]any{"m": 1}, false},
		{[]string(nil), []string{}, false},
		{nil, []string(nil), false},
		{nil, nil, true},
	}
	for _, c := range cases {
		if got := equal(c.got, c.want); got != c.equal {
			t.Errorf("equal(%#v, %#v) = %v, want %v", c.got, c.want, got, c.equal)
		}
	}
}
