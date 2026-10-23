/**
 * Hand-written Go packages the url-shortener starters import but no step builds: `shortener/links`,
 * the links table (code → long URL).
 */
export const supportModulesGo: Record<string, string> = {
  'shortener/links/links.go': `// Package links is the links table: short code → long URL.
package links

import (
	"context"
	"sync"
)

// Store is the links table.
type Store interface {
	// Exists reports whether code is taken.
	Exists(ctx context.Context, code string) (bool, error)
	// Save stores code → url.
	Save(ctx context.Context, code, url string) error
	// Lookup returns the URL saved for code, "" when there is none.
	Lookup(ctx context.Context, code string) (string, error)
}

// Open opens the table at dsn. In the browser runtime the table lives in memory.
func Open(dsn string) Store { return &table{urls: map[string]string{}} }

type table struct {
	mu   sync.Mutex
	urls map[string]string
}

func (t *table) Exists(_ context.Context, code string) (bool, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.urls[code]
	return ok, nil
}

func (t *table) Save(_ context.Context, code, url string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.urls[code] = url
	return nil
}

func (t *table) Lookup(_ context.Context, code string) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.urls[code], nil
}
`,
};
