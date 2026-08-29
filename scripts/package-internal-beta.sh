#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
release_catalog="${AGENT_HOST_RELEASE_CATALOG:-${suite_root}/.build/internal-beta/release-catalog}"
distribution_root="${suite_root}/.build/internal-beta/distribution"
distribution_staging="${suite_root}/.build/internal-beta/dmg-root-${$}"

if [[ "${release_catalog}" != ${suite_root}/.build/internal-beta/* || ! -f "${release_catalog}/current.json" ]]; then
  print -u2 "refusing to package an unresolved internal Beta catalog"
  exit 1
fi
suite_version="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.suiteVersion)' "${release_catalog}/current.json")"
build_version="${AGENT_HOST_APP_BUILD_VERSION:-23}"
dmg_path="${distribution_root}/Agent-Host-${suite_version}-darwin-arm64.dmg"
manifest_path="${distribution_root}/Agent-Host-${suite_version}-darwin-arm64.json"

AGENT_HOST_RELEASE_CATALOG="${release_catalog}" AGENT_HOST_BUNDLED_PROFILE="local-dogfood" AGENT_HOST_APP_BUILD_VERSION="${build_version}" "${script_dir}/package-macos-app.sh" release
app_path="${suite_root}/.build/Agent Host.app"
codesign --verify --deep --strict --verbose=2 "${app_path}"
bootstrap_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-host-bootstrap-check.XXXXXX")"
AGENT_HOST_BOOTSTRAP_ROOT="${bootstrap_root}" "${app_path}/Contents/MacOS/agent-host" --help >/dev/null
rm -rf "${bootstrap_root}"

rm -rf "${distribution_staging}"
mkdir -p "${distribution_staging}" "${distribution_root}"
cp -R "${app_path}" "${distribution_staging}/Agent Host.app"
ln -s /Applications "${distribution_staging}/Applications"
hdiutil create -volname "Agent Host Beta" -srcfolder "${distribution_staging}" -ov -format UDZO "${dmg_path}" >/dev/null
rm -rf "${distribution_staging}"
AGENT_HOST_APP_BUILD_VERSION="${build_version}" node "${script_dir}/write-internal-beta-distribution.mjs" "${dmg_path}" "${release_catalog}/current.json" "${manifest_path}"
print "${dmg_path}"
print "${manifest_path}"
