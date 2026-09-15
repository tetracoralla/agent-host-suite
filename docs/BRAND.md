# Agent Host identity

Agent Host is the quiet local dock for a compatible set of Agent tools. Its
identity should feel warm, concrete, and local — a seed of capability on the
machine — rather than anthropomorphic AI chrome.

The mark is a carved wooden acorn (cupule + nut). It reads as growth, local
storage, and a small durable unit you can hold. It intentionally avoids robot
heads, sparkles, brains, terminals, nested frames, and generic AI gradients.

Source assets:

- `macos/AgentHostIcon.png` is the canonical full-color application icon
  (1024×1024, transparent background).
- `macos/AgentHostMenuBar.svg` is the monochrome small-size symbol.
- `macos/AgentHostIcon.svg` is retained only as a historical reference; do not
  regenerate the app icon from it.
- `scripts/build-app-icon.sh` renders `AgentHost.icns` for the macOS bundle from
  the PNG master.

The product name stays `Agent Host`. Repository, package, bundle identifier,
and integration schema names remain stable and separate from later marketing
or distribution decisions.
