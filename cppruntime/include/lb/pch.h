// What every program the runtime compiles starts with (src/lib/runtime/cpp.ts force-includes it
// ahead of the learner's file): the headers its harness and its check table include anyway, so a
// program sees what it saw before, only in another order. The runtime precompiles this header once
// per runtime pack (src/lib/runtime/cpp/pch.ts) and compiles programs against the PCH when it has
// it, against this header when not: the same program either way.
#pragma once

// cpp-httplib includes OpenSSL's headers only when this is defined before <httplib.h>. Course files
// define it, as real code does, but here <httplib.h> has been included before their define is
// read: defined here, the OpenSSL models are part of every program, and a course file needs no
// define of its own. One it has anyway still compiles (with a value, clang warns of a redefinition).
#define CPPHTTPLIB_OPENSSL_SUPPORT

#include <lb/checks.h>
#include <leetbuild/harness.h>
