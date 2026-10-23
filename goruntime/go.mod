module leetbuild/goruntime

go 1.27

require (
	github.com/google/uuid v1.6.0
	github.com/redis/go-redis/v9 v9.23.0
	github.com/traefik/yaegi v0.16.2-0.20260209085605-fcb76d1ece0c
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	go.uber.org/atomic v1.12.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
)

replace github.com/traefik/yaegi => ./third_party/yaegi
