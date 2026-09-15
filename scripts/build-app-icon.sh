#!/bin/zsh
set -euo pipefail

# Builds macos/AgentHost.icns from the gear+track brand assets.
# Canonical design master is opaque full-bleed PNG; the shipped ICNS uses the
# legacy carrier (transparent exterior + rounded plate). Do not render from SVG.

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
prebuilt_icns="${suite_root}/macos/AgentHost.icns"
carrier_png="${suite_root}/macos/brand/AgentHost-carrier-1024.png"
output_icns="${suite_root}/macos/AgentHost.icns"
scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-host-icon.XXXXXX")"
cleanup() { rm -rf "${scratch_root}"; }
trap cleanup EXIT

if [[ -f "${carrier_png}" ]] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
  iconset="${scratch_root}/AgentHost.iconset"
  mkdir -p "${iconset}"
  for size in 16 32 128 256 512; do
    sips -z "${size}" "${size}" "${carrier_png}" --out "${iconset}/icon_${size}x${size}.png" >/dev/null
    retina=$((size * 2))
    sips -z "${retina}" "${retina}" "${carrier_png}" --out "${iconset}/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "${iconset}" -o "${output_icns}"
  print "${output_icns}"
  exit 0
fi

if [[ -f "${prebuilt_icns}" ]]; then
  print -u2 "sips/iconutil unavailable; keeping prebuilt ${prebuilt_icns}"
  print "${prebuilt_icns}"
  exit 0
fi

print -u2 "missing carrier PNG and prebuilt ICNS"
exit 1
