#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/agent-host-manager-check.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

swiftc \
  "$root/Sources/AgentHostManager/AgentHostModels.swift" \
  "$root/Sources/AgentHostManager/MonitoringHealth.swift" \
  "$root/Tests/AgentHostManagerChecks/main.swift" \
  -o "$temporary/manager-model-check"
"$temporary/manager-model-check"
