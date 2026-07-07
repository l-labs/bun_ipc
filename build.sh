#!/bin/sh
# Build liblconn — the C connector library that src/ffi.ts dlopens.
# Compiles the vendored source in ./native into ./build; no other
# files are needed, so a checkout of this repo builds standalone.
set -e

cd "$(dirname "$0")"                    # run from the repo root always
mkdir -p build

case "$(uname -s)" in
  Darwin) LIB=build/liblconn.dylib; OSFLAGS="-DMAC" ;;
  *)      LIB=build/liblconn.so;    OSFLAGS="" ;;
esac

# -fwrapv: serialization arithmetic relies on wrapping signed overflow.
# -fno-strict-aliasing: the K object model type-puns by design (headers
#   overlay payloads; (I*)/(J*) views of byte buffers). gcc -O2 exploits
#   strict aliasing and miscompiles the deserializer without this flag
#   (function-valued replies hang or over-allocate); clang happens to
#   be lenient, which is why macOS builds never showed it.
# The source compiles warning-clean: no -w / -Wno-implicit-* silencers.
${CC:-cc} -O2 -fPIC -shared -fwrapv -fno-strict-aliasing -D_GNU_SOURCE \
  $OSFLAGS -Inative native/lconn.c -lpthread -o "$LIB"

echo "built $LIB"
