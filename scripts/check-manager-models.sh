#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/agent-host-manager-check.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
architecture=$(uname -m)

CLANG_MODULE_CACHE_PATH="$temporary/clang-cache" \
SWIFT_MODULE_CACHE_PATH="$temporary/swift-cache" \
swiftc \
  -target "${architecture}-apple-macosx14.0" \
  "$root/Sources/AgentHostManager/AgentHostModels.swift" \
  "$root/Sources/AgentHostManager/MonitoringHealth.swift" \
  "$root/Tests/AgentHostManagerChecks/main.swift" \
  -o "$temporary/manager-model-check"
"$temporary/manager-model-check"
