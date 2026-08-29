# Agent Host identity

Agent Host is the quiet local dock for a compatible set of Agent tools. Its
identity should feel precise, native to macOS, and operational rather than
anthropomorphic.

The symbol is a dark graphite tile with two blue-to-teal docking brackets
around one white connection port. The brackets mean "contained local
environment" and "connection"; the center means one known activation point.
It intentionally avoids robot heads, sparkles, brains, anchors, terminals, and
generic AI gradients.

Source assets:

- `macos/AgentHostIcon.svg` is the canonical full-color application icon.
- `macos/AgentHostMenuBar.svg` is the monochrome small-size symbol.
- `scripts/build-app-icon.sh` deterministically renders `AgentHost.icns` for
  the macOS bundle.

The product name stays `Agent Host`. Repository, package, bundle identifier,
and integration schema names remain stable and separate from later marketing
or distribution decisions.
