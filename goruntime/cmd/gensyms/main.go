// Command gensyms writes the yaegi symbol tables the interpreter is given (goruntime/symbols): the
// standard library packages course code imports, the client libraries (go-redis, uuid), the
// in-process models under the import paths learner code uses, and the LeetBuild harness.
//
//	cd goruntime && go run ./cmd/gensyms
//
// Each package is extracted under its native path, then its table is keyed by the path learner
// code imports (`leetbuild/goruntime/models/kafkago` → `github.com/segmentio/kafka-go`). Generic
// packages (cmp, maps, slices) are not here: yaegi interprets them from source (stdlib/generic).
// `os` and `syscall` are not here either: their tables are hand-written (host/overrides), because
// their exported API differs between the host platform and js/wasm.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/traefik/yaegi/extract"
)

// pkg is one table: the package compiled into the runtime, and the import path learner code uses
// (empty: the same).
type pkg struct{ native, as string }

// excludes are symbols left out of a package's table (regexps): API that leaks internal packages.
var excludes = map[string][]string{
	"encoding/json":                {"^Options$"},                  // json v2 plumbing: its methods take encoding/json/internal types
	"github.com/redis/go-redis/v9": {"^Pooler$", "^PubSubPooler$"}, // return internal/pool stats types
	// The registry's hooks for the host and the harness (ctx.GRPC), not grpc-go's API.
	"leetbuild/goruntime/models/grpc": {
		"^Reset$", "^LearnerCalls$", "^Call$", "^Calls$", "^CallsTo$", "^PeerServer$", "^StopPeer$",
		"^SetLatency$", "^FailNext$", "^ClearFailures$", "^Serving$", "^HarnessClient$",
	},
}

var packages = []pkg{
	// The standard library, as far as course code and learner code reach.
	{"bufio", ""},
	{"bytes", ""},
	{"container/heap", ""},
	{"container/list", ""},
	{"context", ""},
	{"crypto/hmac", ""},
	{"crypto/md5", ""},
	{"crypto/rand", ""},
	{"crypto/sha1", ""},
	{"crypto/sha256", ""},
	{"crypto/sha512", ""},
	{"crypto/subtle", ""},
	{"crypto/tls", ""},
	{"crypto/x509", ""},
	{"database/sql", ""},
	{"database/sql/driver", ""},
	{"encoding/base64", ""},
	{"encoding/binary", ""},
	{"encoding/csv", ""},
	{"encoding/hex", ""},
	{"encoding/json", ""},
	{"errors", ""},
	{"fmt", ""},
	{"hash", ""},
	{"hash/crc32", ""},
	{"hash/fnv", ""},
	{"html", ""},
	{"io", ""},
	{"log", ""},
	{"math", ""},
	{"math/big", ""},
	{"math/bits", ""},
	{"math/rand/v2", ""},
	{"mime", ""},
	{"net", ""},
	{"net/http", ""},
	{"net/http/httptest", ""},
	{"net/netip", ""},
	{"net/url", ""},
	{"os/signal", ""},
	{"path", ""},
	{"reflect", ""},
	{"regexp", ""},
	{"sort", ""},
	{"strconv", ""},
	{"strings", ""},
	{"sync", ""},
	{"sync/atomic", ""},
	{"time", ""},
	{"unicode", ""},
	{"unicode/utf16", ""},
	{"unicode/utf8", ""},

	// Client libraries compiled in as they are.
	{"github.com/google/uuid", ""},
	{"github.com/redis/go-redis/v9", ""},

	// In-process models, under the paths learner code imports. A local package that does not exist
	// yet is skipped, so the list can name every model before each lands.
	{"leetbuild/goruntime/models/kafkago", "github.com/segmentio/kafka-go"},
	{"leetbuild/goruntime/models/confluent", "github.com/confluentinc/confluent-kafka-go/v2/kafka"},
	{"leetbuild/goruntime/models/grpc", "google.golang.org/grpc"},
	{"leetbuild/goruntime/models/grpc/codes", "google.golang.org/grpc/codes"},
	{"leetbuild/goruntime/models/grpc/status", "google.golang.org/grpc/status"},
	{"leetbuild/goruntime/models/grpc/metadata", "google.golang.org/grpc/metadata"},
	{"leetbuild/goruntime/models/grpc/peer", "google.golang.org/grpc/peer"},
	{"leetbuild/goruntime/models/grpc/credentials", "google.golang.org/grpc/credentials"},
	{"leetbuild/goruntime/models/grpc/credentials/insecure", "google.golang.org/grpc/credentials/insecure"},
	{"leetbuild/goruntime/models/protobuf/proto", "google.golang.org/protobuf/proto"},
	{"leetbuild/goruntime/models/protobuf/protojson", "google.golang.org/protobuf/encoding/protojson"},
	{"leetbuild/goruntime/models/pq", "github.com/lib/pq"},

	// The harness API (harness_test.go imports it as leetbuild/harness).
	{"leetbuild/goruntime/harness", "leetbuild/harness"},
}

func main() {
	lenient := flag.Bool("lenient", false, "skip local packages that do not type-check (a model under development) instead of failing")
	flag.Parse()
	out := "symbols"
	if err := os.MkdirAll(out, 0o755); err != nil {
		fail(err)
	}
	// Generate everything first: a failure leaves the previous generation in place.
	generated := map[string][]byte{}
	for _, p := range packages {
		local := strings.TrimPrefix(p.native, "leetbuild/goruntime/")
		isLocal := local != p.native
		if isLocal {
			if _, err := os.Stat(local); err != nil {
				fmt.Printf("skipped %s (not written yet)\n", p.native)
				continue
			}
		}
		ex := extract.Extractor{Dest: "symbols", Exclude: excludes[p.native]}
		var buf bytes.Buffer
		if _, err := ex.Extract(p.native, "", &buf); err != nil {
			if *lenient && isLocal {
				fmt.Printf("skipped %s (does not type-check: %v)\n", p.native, err)
				continue
			}
			fail(fmt.Errorf("%s: %w", p.native, err))
		}
		src := buf.Bytes()
		if p.as != "" {
			// The table key is "<import path>/<package name>"; learner code imports p.as.
			name := packageName(src)
			from := fmt.Sprintf("Symbols[%q]", path.Join(p.native, name))
			to := fmt.Sprintf("Symbols[%q]", path.Join(p.as, name))
			if !bytes.Contains(src, []byte(from)) {
				fail(fmt.Errorf("%s: no %s in the generated table", p.native, from))
			}
			src = bytes.Replace(src, []byte(from), []byte(to), 1)
		}
		file := filepath.Join(out, "gen_"+strings.NewReplacer("/", "_", ".", "_", "-", "_").Replace(p.native)+".go")
		generated[file] = src
	}
	// Replace the previous generation (hand-written files do not start with "gen_").
	old, _ := filepath.Glob(filepath.Join(out, "gen_*.go"))
	for _, f := range old {
		if _, kept := generated[f]; !kept {
			_ = os.Remove(f)
		}
	}
	for file, src := range generated {
		if err := os.WriteFile(file, src, 0o644); err != nil {
			fail(err)
		}
	}
	fmt.Printf("%d symbol tables written to %s\n", len(generated), out)
}

// packageName reads the package name off the generated `Symbols["<path>/<name>"]` key.
func packageName(src []byte) string {
	i := bytes.Index(src, []byte(`Symbols["`))
	if i < 0 {
		fail(fmt.Errorf("no Symbols key in the generated table"))
	}
	rest := src[i+len(`Symbols["`):]
	key := string(rest[:bytes.IndexByte(rest, '"')])
	return path.Base(key)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "gensyms:", err)
	os.Exit(1)
}
