#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
target_architecture="${AGENT_HOST_TARGET_ARCHITECTURE:-$(uname -m)}"
if [[ "${target_architecture}" != "arm64" && "${target_architecture}" != "x86_64" ]]; then
  print -u2 "AGENT_HOST_TARGET_ARCHITECTURE must be arm64 or x86_64"
  exit 2
fi
build_triple="${target_architecture}-apple-macosx14.0"
language_flags=()
if swiftc -swift-version 6 -typecheck - </dev/null >/dev/null 2>&1; then
  language_flags=(-Xswiftc -swift-version -Xswiftc 6)
  print "checking the manager in Swift 6 language mode"
else
  print "Swift 6 language mode is unavailable; checking the package's declared Swift language mode"
fi

cd "${suite_root}"
swift build \
  --triple "${build_triple}" \
  --scratch-path .build/swift-concurrency-check \
  "${language_flags[@]}" \
  -Xswiftc -warnings-as-errors
