#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
configuration="${1:-release}"
if [[ "${configuration}" != "debug" && "${configuration}" != "release" ]]; then
  print -u2 "configuration must be debug or release"
  exit 2
fi

cd "${suite_root}"
swift build -c "${configuration}" --product AgentHostManager
binary_path="$(swift build -c "${configuration}" --show-bin-path)/AgentHostManager"
app_path="${suite_root}/.build/Agent Host.app"
staging_path="${suite_root}/.build/Agent Host.app.staging-${$}"
if [[ ! -x "${binary_path}" || "${app_path}" != "${suite_root}/.build/Agent Host.app" ]]; then
  print -u2 "refusing to package unresolved build paths"
  exit 1
fi

rm -rf "${staging_path}"
mkdir -p "${staging_path}/Contents/MacOS" "${staging_path}/Contents/Resources/agent-host-suite"
cp "${binary_path}" "${staging_path}/Contents/MacOS/AgentHostManager"
cp "${suite_root}/macos/Info.plist" "${staging_path}/Contents/Info.plist"
for item in bin src catalog schemas package.json node_modules LICENSE NOTICE THIRD_PARTY_NOTICES.txt; do
  cp -R "${suite_root}/${item}" "${staging_path}/Contents/Resources/agent-host-suite/${item}"
done
node "${suite_root}/scripts/write-sbom.mjs" "${staging_path}/Contents/Resources/agent-host-suite/sbom.spdx.json"
codesign --force --sign - --timestamp=none "${staging_path}"
rm -rf "${app_path}"
mv "${staging_path}" "${app_path}"
print "${app_path}"
