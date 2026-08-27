#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
mode="${1:-internal-beta}"
release_catalog="${AGENT_HOST_RELEASE_CATALOG:-${suite_root}/.build/internal-beta/release-catalog}"
suite_version="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.suiteVersion)' "${release_catalog}/current.json")"
dmg_path="${2:-${suite_root}/.build/internal-beta/distribution/Agent-Host-${suite_version}-darwin-arm64.dmg}"
manifest_path="${3:-${suite_root}/.build/internal-beta/distribution/Agent-Host-${suite_version}-darwin-arm64.json}"

if [[ "${mode}" != "internal-beta" && "${mode}" != "public" ]]; then
  print -u2 "mode must be internal-beta or public"
  exit 2
fi
if [[ ! -f "${dmg_path}" || ! -f "${manifest_path}" ]]; then
  print -u2 "distribution DMG or manifest is missing"
  exit 1
fi

expected_file="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.artifact.file)' "${manifest_path}")"
expected_sha="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.artifact.sha256.replace(/^sha256:/, ""))' "${manifest_path}")"
expected_bytes="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(String(manifest.artifact.bytes))' "${manifest_path}")"
actual_sha="$(shasum -a 256 "${dmg_path}" | awk '{print $1}')"
actual_bytes="$(stat -f %z "${dmg_path}")"
if [[ "${expected_file}" != "${dmg_path:t}" || "${expected_sha}" != "${actual_sha}" || "${expected_bytes}" != "${actual_bytes}" ]]; then
  print -u2 "distribution manifest does not match the DMG"
  exit 1
fi

hdiutil verify "${dmg_path}" >/dev/null
mount_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-host-distribution.XXXXXX")"
cleanup() {
  hdiutil detach "${mount_root}" >/dev/null 2>&1 || true
  rmdir "${mount_root}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
hdiutil attach -nobrowse -readonly -mountpoint "${mount_root}" "${dmg_path}" >/dev/null
app_path="${mount_root}/Agent Host.app"
bundled_node="${app_path}/Contents/Resources/agent-host-runtime/node"
bundled_cli="${app_path}/Contents/Resources/agent-host-suite/bin/agent-host.mjs"
bundled_icon="${app_path}/Contents/Resources/AgentHost.icns"

codesign --verify --deep --strict --verbose=2 "${app_path}"
"${bundled_node}" "${bundled_cli}" --help >/dev/null
[[ -s "${bundled_icon}" ]] || { print -u2 "app icon is missing"; exit 1; }
if rg -a -l '/(Users|home)/[^/]+/(Development/)?tools-dev/' "${app_path}" >/dev/null; then
  print -u2 "distribution contains a tools-dev source path"
  exit 1
fi

if [[ "${mode}" == "internal-beta" ]]; then
  signing_kind="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.signing.kind)' "${manifest_path}")"
  notarized="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(String(manifest.notarization.stapled))' "${manifest_path}")"
  signature="$(codesign -d --verbose=4 "${app_path}" 2>&1)"
  if [[ "${signing_kind}" != "ad-hoc" || "${notarized}" != "false" || "${signature}" != *"Signature=adhoc"* ]]; then
    print -u2 "internal Beta signing metadata does not match the app"
    exit 1
  fi
else
  codesign -d --verbose=4 "${app_path}" 2>&1 | rg 'Authority=Developer ID Application:' >/dev/null
  xcrun stapler validate "${app_path}"
  spctl --assess --type execute --verbose=4 "${app_path}"
fi

print "${mode} distribution checks passed: ${dmg_path}"
