# Agent Host identity

Agent Host is the quiet local dock for a compatible set of Agent tools. Its
identity should feel precise, industrial, and operational rather than
anthropomorphic.

The mark is a side-view conveyor structure: a white gear as the visual anchor
with a cyan track opening to the right, on a cobalt-to-indigo full-bleed
gradient. It reads as local drive and continuous work. It intentionally avoids
robot heads, sparkles, brains, terminals, nested frames, and generic AI chrome.

Source assets:

- `macos/brand/AgentHost-1024.png` (and `AgentHost-master-1254.png`) is the
  canonical full-bleed design master (opaque blue plate).
- `macos/brand/AgentHost-carrier-1024.png` is the macOS legacy ICNS carrier
  (transparent exterior + rounded plate). Do not derive web/full-bleed assets
  from the carrier.
- `macos/AgentHost.icns` is the shipped Dock icon (`CFBundleIconFile=AgentHost`).
- `macos/AgentHostIcon.png` mirrors the 1024 design master for convenience.
- `macos/AgentHostMenuBar.svg` remains a separate monochrome template; it is
  not auto-derived from the color mark.
- `macos/AgentHostIcon.svg` is historical only; `scripts/build-app-icon.sh`
  must not render the app icon from it.
- `scripts/build-app-icon.sh` rebuilds `AgentHost.icns` from the carrier PNG
  when `sips`/`iconutil` are available; otherwise it keeps the prebuilt ICNS.

The product name stays `Agent Host`. Repository, package, bundle identifier,
and integration schema names remain stable and separate from later marketing
or distribution decisions.
