#!/bin/zsh
set -euo pipefail

mode="${1:-run}"
script_dir="${0:A:h}"
suite_root="${script_dir:h}"
app_path="${suite_root}/.build/Agent Host.app"
process_name="AgentHostManager"

pkill -x "${process_name}" >/dev/null 2>&1 || true
"${suite_root}/scripts/package-macos-app.sh" debug >/dev/null

export AGENT_HOST_DEVELOPMENT_ROOT="${suite_root:h}"

case "${mode}" in
  run)
    /usr/bin/open -n "${app_path}"
    ;;
  --debug|debug)
    lldb -- "${app_path}/Contents/MacOS/${process_name}"
    ;;
  --logs|logs)
    /usr/bin/open -n "${app_path}"
    /usr/bin/log stream --info --style compact --predicate "process == \"${process_name}\""
    ;;
  --telemetry|telemetry)
    /usr/bin/open -n "${app_path}"
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "io.github.tetracoralla.agent-host-suite.manager"'
    ;;
  --verify|verify)
    /usr/bin/open -n "${app_path}"
    sleep 1
    pgrep -x "${process_name}" >/dev/null
    ;;
  *)
    print -u2 "usage: $0 [run|--debug|--logs|--telemetry|--verify]"
    exit 2
    ;;
esac
