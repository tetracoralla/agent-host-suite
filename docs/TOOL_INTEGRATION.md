# Agent Host tool integration v0.1

This local contract admits one already-real Agent tool into an immutable Agent
Host compatibility set. It is not a marketplace listing, ranking system, or
universal plugin standard.

## Required claims

Each component archive is closed over the exact macOS runtime it needs and is
bound by version, platform, byte length, SHA-256, license files, notices, SBOM,
entrypoints, and identity files. The archive may bind the suite-owned Node
runtime into its plugin; it must not resolve `node` or another executable from
the developer's shell at use time.

The component descriptor's `integration` value validates against
`schemas/agent-host-tool-integration.schema.v0.1.json` and declares only:

- the tool's human name and one task-oriented summary;
- the contained Codex marketplace and plugin roots;
- the exact MCP stdio command, arguments, working directory, expected tool
  names, and health timeout;
- optional workspace environment variable names whose value is supplied by the
  calling Agent app, never a workspace restriction;
- uninstall ownership fixed to `agent-host-created-only`.

Ratings, screenshots, categories for discovery, payment, reviews, featured
placement, and speculative host adapters are deliberately absent.

## Admission

An integration is admitted only when the release builder and installed probe
confirm all of the following from unpacked immutable bytes:

1. no links, special files, source-checkout paths, or unbound absolute runtime
   commands occur in the component;
2. every expected MCP tool is present and advertises both `inputSchema` and
   `outputSchema`;
3. the real stdio server starts within its declared cold-start window;
4. Codex can install the contained marketplace without adopting unrelated
   user-owned entries;
5. update and uninstall record and restore only the entries they displaced.

Tool success is not task success. Product-specific Skills keep the remaining
judgment and routing method; Agent Host owns only installation, compatibility,
health, recovery, and removal.

## Current profile

`local-dogfood` composes the Standard set with the locally admitted tools. It
exists so this Mac can exercise stranger-equivalent installed bytes while
Agents retain normal access to every authorized `tools-dev` repository.
Changing source does not change an installed tool until a new immutable
compatibility set is built and activated.
