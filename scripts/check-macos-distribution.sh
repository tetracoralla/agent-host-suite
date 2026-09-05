#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
mode="${1:-internal-beta}"
release_catalog="${AGENT_HOST_RELEASE_CATALOG:-${suite_root}/.build/internal-beta/release-catalog}"
suite_version="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.suiteVersion)' "${release_catalog}/current.json")"
release_id="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.releaseId)' "${release_catalog}/current.json")"
package_version="$(node -e 'const pkg=require(process.argv[1]); process.stdout.write(pkg.version)' "${suite_root}/package.json")"
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

manifest_versions="$(node -e '
const manifest=require(process.argv[1])
if (manifest.schemaVersion !== "openadam.agent-host-macos-distribution.v0.1" || manifest.status !== "internal-beta" || manifest.platform !== "darwin-arm64") process.exit(1)
process.stdout.write([manifest.appVersion, manifest.suiteVersion, manifest.buildVersion].join("\n"))
' "${manifest_path}")"
manifest_app_version="${${(f)manifest_versions}[1]}"
manifest_suite_version="${${(f)manifest_versions}[2]}"
manifest_build_version="${${(f)manifest_versions}[3]}"
if [[ "${suite_version}" != "${package_version}" || "${manifest_app_version}" != "${package_version}" || "${manifest_suite_version}" != "${package_version}" ]]; then
  print -u2 "Host package, release catalog, and distribution manifest versions differ"
  exit 1
fi

manifest_release_id="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.suiteReleaseId)' "${manifest_path}")"
expected_catalog_sha="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.releaseCatalog.sha256)' "${manifest_path}")"
expected_catalog_files="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(String(manifest.releaseCatalog.files))' "${manifest_path}")"
external_catalog_identity="$(node "${script_dir}/hash-release-catalog.mjs" "${release_catalog}")"
external_catalog_sha="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.sha256)' "${external_catalog_identity}")"
external_catalog_files="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.files))' "${external_catalog_identity}")"
if [[ "${manifest_release_id}" != "${release_id}" || "${expected_catalog_sha}" != "${external_catalog_sha}" || "${expected_catalog_files}" != "${external_catalog_files}" ]]; then
  print -u2 "distribution manifest and release catalog identity differ"
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
bundled_launcher="${app_path}/Contents/MacOS/agent-host"
bundled_icon="${app_path}/Contents/Resources/AgentHost.icns"
bundled_suite="${app_path}/Contents/Resources/agent-host-suite"
bundled_provenance="${bundled_suite}/catalog/releases/build-provenance.json"
manager_app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app_path}/Contents/Info.plist")"
manager_build_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${app_path}/Contents/Info.plist")"
bundled_package_version="$(node -e 'const pkg=require(process.argv[1]); process.stdout.write(pkg.version)' "${bundled_suite}/package.json")"
bundled_suite_version="$(node -e 'const release=require(process.argv[1]); process.stdout.write(release.suiteVersion)' "${bundled_suite}/catalog/releases/current.json")"
bundled_release_id="$(node -e 'const release=require(process.argv[1]); process.stdout.write(release.releaseId)' "${bundled_suite}/catalog/releases/current.json")"
bundled_provenance_version="$(node -e 'const provenance=require(process.argv[1]); process.stdout.write(provenance.suiteVersion)' "${bundled_provenance}")"
if [[ "${manager_app_version}" != "${package_version}" || "${manager_build_version}" != "${manifest_build_version}" || "${bundled_package_version}" != "${package_version}" || "${bundled_suite_version}" != "${package_version}" || "${bundled_provenance_version}" != "${package_version}" ]]; then
  print -u2 "Manager, bundled Host, release catalog, source provenance, and distribution versions differ"
  exit 1
fi
bundled_catalog_identity="$(node "${script_dir}/hash-release-catalog.mjs" "${bundled_suite}/catalog/releases")"
bundled_catalog_sha="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value.sha256)' "${bundled_catalog_identity}")"
bundled_catalog_files="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.files))' "${bundled_catalog_identity}")"
if [[ "${bundled_release_id}" != "${release_id}" || "${bundled_catalog_sha}" != "${expected_catalog_sha}" || "${bundled_catalog_files}" != "${expected_catalog_files}" ]]; then
  print -u2 "bundled and external release catalogs differ"
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "${app_path}"
bootstrap_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-host-bootstrap-check.XXXXXX")"
AGENT_HOST_BOOTSTRAP_ROOT="${bootstrap_root}" "${bundled_launcher}" --help >/dev/null
mkdir -m 700 "${bootstrap_root}/status-state"
node -e '
const { writeFileSync } = require("node:fs")
const version = process.argv[1]
const destination = process.argv[2]
const timestamp = "2026-01-01T00:00:00.000Z"
writeFileSync(destination, JSON.stringify({ schemaVersion: "openadam.agent-host-state.v0.1", suiteVersion: version, channel: "release", profile: "standard", installedAt: timestamp, updatedAt: timestamp, components: {}, hosts: {}, runtime: {}, observability: {} }) + "\n", { mode: 0o600 })
' "${bundled_suite_version}" "${bootstrap_root}/status-state/state.json"
status_json="$(AGENT_HOST_BOOTSTRAP_ROOT="${bootstrap_root}" "${bundled_launcher}" status --state-root "${bootstrap_root}/status-state" --json)"
status_version="$(node -e 'const value=JSON.parse(process.argv[1]); if (value.status !== "ok" || value.configured !== true) process.exit(1); process.stdout.write(value.suiteVersion)' "${status_json}")"
if [[ "${status_version}" != "${package_version}" ]]; then
  print -u2 "bundled Host status version differs from the Manager and distribution identity"
  exit 1
fi
rm -rf "${bootstrap_root}"
[[ -s "${bundled_icon}" ]] || { print -u2 "app icon is missing"; exit 1; }
for document in README.md README.zh-CN.md docs/WINDOWS.md docs/WINDOWS.zh-CN.md docs/TRACE_PLANE.md docs/TRACE_PLANE.zh-CN.md; do
  [[ -s "${bundled_suite}/${document}" ]] || { print -u2 "bundled product document is missing: ${document}"; exit 1; }
done
[[ -s "${bundled_provenance}" ]] || { print -u2 "bundled source provenance is missing"; exit 1; }
expected_provenance_policy="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.sourceProvenance.policy)' "${manifest_path}")"
expected_provenance_sha="$(node -e 'const manifest=require(process.argv[1]); process.stdout.write(manifest.sourceProvenance.sha256.replace(/^sha256:/, ""))' "${manifest_path}")"
actual_provenance_sha="$(shasum -a 256 "${bundled_provenance}" | awk '{print $1}')"
if [[ "${expected_provenance_sha}" != "${actual_provenance_sha}" ]]; then
  print -u2 "distribution source provenance digest does not match the bundled record"
  exit 1
fi
if [[ "${mode}" == "public" && "${expected_provenance_policy}" != "remote-tagged" ]]; then
  print -u2 "public distribution requires remote-tagged source provenance"
  exit 1
fi
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
