import {protoFiles} from './proto';

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

/**
 * C++ support of the url-shortener starters: the keys proto and links.h, the links table (code → long
 * URL). Every Store goes through `links::table`, so a step's harness can put its own table in its
 * place (Go swaps the `store` variable instead).
 */
export const supportModulesCpp: Record<string, string> = {
  ...protoFiles,
  'links.h': `// The links table (provided): short code → long URL, kept in memory in the browser runtime.
#pragma once

#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace links {

// The table itself, which every Store reads and writes.
class Table {
 public:
  virtual ~Table() = default;

  virtual bool exists(const std::string& code) {
    std::lock_guard<std::mutex> guard(mu_);
    return urls_.count(code) > 0;
  }

  virtual void save(const std::string& code, const std::string& url) {
    std::lock_guard<std::mutex> guard(mu_);
    urls_[code] = url;
  }

  virtual std::optional<std::string> lookup(const std::string& code) {
    std::lock_guard<std::mutex> guard(mu_);
    const auto it = urls_.find(code);
    if (it == urls_.end()) return std::nullopt;
    return it->second;
  }

 private:
  std::mutex mu_;
  std::map<std::string, std::string> urls_;
};

inline Table memory;
inline Table* table = &memory;

}  // namespace links

// A handle on the links table.
class Store {
 public:
  // Whether code is taken.
  bool exists(const std::string& code) { return links::table->exists(code); }
  // Stores code → url.
  void save(const std::string& code, const std::string& url) { links::table->save(code, url); }
  // The URL saved for code, if there is one.
  std::optional<std::string> lookup(const std::string& code) { return links::table->lookup(code); }
};
`,
};
