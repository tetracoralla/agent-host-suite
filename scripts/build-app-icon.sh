#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
suite_root="${script_dir:h}"
source_svg="${suite_root}/macos/AgentHostIcon.svg"
output_icns="${suite_root}/macos/AgentHost.icns"
scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-host-icon.XXXXXX")"
cleanup() { rm -rf "${scratch_root}"; }
trap cleanup EXIT

qlmanage -t -s 1024 -o "${scratch_root}" "${source_svg}" >/dev/null 2>&1
source_png="${scratch_root}/AgentHostIcon.svg.png"
if [[ ! -f "${source_png}" ]]; then
  print -u2 "failed to render AgentHostIcon.svg"
  exit 1
fi

iconset="${scratch_root}/AgentHost.iconset"
mkdir -p "${iconset}"
for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" "${source_png}" --out "${iconset}/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z "${retina}" "${retina}" "${source_png}" --out "${iconset}/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "${iconset}" -o "${output_icns}"
print "${output_icns}"
