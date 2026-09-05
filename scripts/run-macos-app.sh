#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
export AGENT_HOST_CLI="${suite_root}/bin/agent-host.mjs"
export AGENT_HOST_NODE="$(command -v node)"
explicit_release_manifest="${AGENT_HOST_RELEASE_MANIFEST:-}"
release_manifest="${explicit_release_manifest:-${suite_root}/.build/internal-beta/release-catalog/current.json}"
release_catalog="${release_manifest:h}"
if [[ -f "${release_manifest}" && -f "${release_catalog}/build-provenance.json" ]]; then
  node "${suite_root}/scripts/check-release-source-provenance.mjs" "${release_catalog}" >/dev/null
  export AGENT_HOST_RELEASE_MANIFEST="${release_manifest}"
elif [[ -n "${explicit_release_manifest}" ]]; then
  print -u2 "The selected release manifest has no valid adjacent build provenance."
  exit 1
else
  unset AGENT_HOST_RELEASE_MANIFEST
fi
cd "${suite_root}"
swift run AgentHostManager
