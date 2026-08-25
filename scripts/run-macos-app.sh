#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
export AGENT_HOST_CLI="${suite_root}/bin/agent-host.mjs"
export AGENT_HOST_NODE="$(command -v node)"
cd "${suite_root}"
swift run AgentHostManager
