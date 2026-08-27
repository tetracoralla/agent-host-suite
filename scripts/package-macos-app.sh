#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
configuration="${1:-release}"
release_catalog="${AGENT_HOST_RELEASE_CATALOG:-${suite_root}/.build/internal-beta/release-catalog}"
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
if [[ ! -f "${release_catalog}/current.json" || ! -d "${release_catalog}/artifacts" ]]; then
  print -u2 "bound release catalog is unavailable; run npm run build:internal-beta-artifacts first"
  exit 1
fi

rm -rf "${staging_path}"
mkdir -p "${staging_path}/Contents/MacOS" "${staging_path}/Contents/Resources/agent-host-suite" "${staging_path}/Contents/Resources/agent-host-runtime"
cp "${binary_path}" "${staging_path}/Contents/MacOS/AgentHostManager"
/usr/bin/strip -S -x "${staging_path}/Contents/MacOS/AgentHostManager"
cp "${suite_root}/macos/Info.plist" "${staging_path}/Contents/Info.plist"
if [[ ! -f "${suite_root}/macos/AgentHost.icns" ]]; then
  "${suite_root}/scripts/build-app-icon.sh" >/dev/null
fi
cp "${suite_root}/macos/AgentHost.icns" "${staging_path}/Contents/Resources/AgentHost.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${AGENT_HOST_APP_BUILD_VERSION:-1}" "${staging_path}/Contents/Info.plist"
for item in bin src catalog schemas package.json node_modules LICENSE NOTICE THIRD_PARTY_NOTICES.txt; do
  cp -R "${suite_root}/${item}" "${staging_path}/Contents/Resources/agent-host-suite/${item}"
done
cp "${release_catalog}/current.json" "${staging_path}/Contents/Resources/agent-host-suite/catalog/releases/current.json"
rm -rf "${staging_path}/Contents/Resources/agent-host-suite/catalog/releases/artifacts"
cp -R "${release_catalog}/artifacts" "${staging_path}/Contents/Resources/agent-host-suite/catalog/releases/artifacts"
node_archive_name="$(node -e 'const manifest=require(process.argv[1]); const item=manifest.components.find((component)=>component.id==="node-runtime"); if (!item) process.exit(1); process.stdout.write(item.artifact.url.replace(/^artifacts\//, ""))' "${release_catalog}/current.json")"
node_extract="${staging_path}.node"
rm -rf "${node_extract}"
mkdir -p "${node_extract}"
/usr/bin/tar -xzf "${release_catalog}/artifacts/${node_archive_name}" -C "${node_extract}"
cp "${node_extract}/bin/node" "${staging_path}/Contents/Resources/agent-host-runtime/node"
chmod 755 "${staging_path}/Contents/Resources/agent-host-runtime/node"
rm -rf "${node_extract}"
node "${suite_root}/scripts/write-sbom.mjs" "${staging_path}/Contents/Resources/agent-host-suite/sbom.spdx.json"
codesign --force --sign - --timestamp=none "${staging_path}/Contents/Resources/agent-host-runtime/node"
codesign --force --sign - --timestamp=none "${staging_path}"
rm -rf "${app_path}"
mv "${staging_path}" "${app_path}"
print "${app_path}"
