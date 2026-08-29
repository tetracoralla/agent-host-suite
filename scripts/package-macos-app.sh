#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
configuration="${1:-release}"
release_catalog="${AGENT_HOST_RELEASE_CATALOG:-${suite_root}/.build/internal-beta/release-catalog}"
bundled_profile="${AGENT_HOST_BUNDLED_PROFILE:-standard}"
if [[ "${configuration}" != "debug" && "${configuration}" != "release" ]]; then
  print -u2 "configuration must be debug or release"
  exit 2
fi

cd "${suite_root}"
swift build -c "${configuration}" --product AgentHostManager
swift build -c "${configuration}" --product AgentHostCLIShim
binary_path="$(swift build -c "${configuration}" --show-bin-path)/AgentHostManager"
shim_path="$(swift build -c "${configuration}" --show-bin-path)/AgentHostCLIShim"
app_path="${suite_root}/.build/Agent Host.app"
staging_path="${suite_root}/.build/Agent Host.app.staging-${$}"
bundled_catalog="${staging_path}.catalog"
cleanup() {
  rm -rf "${staging_path}" "${bundled_catalog}"
}
trap cleanup EXIT
if [[ ! -x "${binary_path}" || ! -x "${shim_path}" || "${app_path}" != "${suite_root}/.build/Agent Host.app" ]]; then
  print -u2 "refusing to package unresolved build paths"
  exit 1
fi
if [[ ! -f "${release_catalog}/current.json" || ! -d "${release_catalog}/artifacts" ]]; then
  print -u2 "bound release catalog is unavailable; run npm run build:internal-beta-artifacts first"
  exit 1
fi
node "${suite_root}/scripts/stage-bundled-release-catalog.mjs" "${release_catalog}" "${bundled_catalog}" "${bundled_profile}" >/dev/null

rm -rf "${staging_path}"
mkdir -p "${staging_path}/Contents/MacOS" "${staging_path}/Contents/Resources/agent-host-suite"
cp "${binary_path}" "${staging_path}/Contents/MacOS/AgentHostManager"
cp "${shim_path}" "${staging_path}/Contents/MacOS/agent-host"
/usr/bin/strip -S -x "${staging_path}/Contents/MacOS/AgentHostManager"
/usr/bin/strip -S -x "${staging_path}/Contents/MacOS/agent-host"
cp "${suite_root}/macos/Info.plist" "${staging_path}/Contents/Info.plist"
if [[ ! -f "${suite_root}/macos/AgentHost.icns" ]]; then
  "${suite_root}/scripts/build-app-icon.sh" >/dev/null
fi
cp "${suite_root}/macos/AgentHost.icns" "${staging_path}/Contents/Resources/AgentHost.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${AGENT_HOST_APP_BUILD_VERSION:-1}" "${staging_path}/Contents/Info.plist"
for item in bin src catalog schemas skills package.json node_modules LICENSE NOTICE THIRD_PARTY_NOTICES.txt; do
  cp -R "${suite_root}/${item}" "${staging_path}/Contents/Resources/agent-host-suite/${item}"
done
cp "${bundled_catalog}/current.json" "${staging_path}/Contents/Resources/agent-host-suite/catalog/releases/current.json"
rm -rf "${staging_path}/Contents/Resources/agent-host-suite/catalog/releases/artifacts"
cp -R "${bundled_catalog}/artifacts" "${staging_path}/Contents/Resources/agent-host-suite/catalog/releases/artifacts"
node "${suite_root}/scripts/write-sbom.mjs" "${staging_path}/Contents/Resources/agent-host-suite/sbom.spdx.json"
codesign --force --sign - --timestamp=none "${staging_path}/Contents/MacOS/agent-host"
codesign --force --sign - --timestamp=none "${staging_path}"
rm -rf "${app_path}"
mv "${staging_path}" "${app_path}"
rm -rf "${bundled_catalog}"
trap - EXIT
print "${app_path}"
