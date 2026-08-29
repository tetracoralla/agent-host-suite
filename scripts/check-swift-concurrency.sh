#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
language_flags=()
if swiftc -swift-version 6 -typecheck - </dev/null >/dev/null 2>&1; then
  language_flags=(-Xswiftc -swift-version -Xswiftc 6)
  print "checking the manager in Swift 6 language mode"
else
  print "Swift 6 language mode is unavailable; checking the package's declared Swift language mode"
fi

cd "${suite_root}"
swift build \
  --scratch-path .build/swift-concurrency-check \
  "${language_flags[@]}" \
  -Xswiftc -warnings-as-errors
