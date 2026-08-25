# Security policy

## Supported versions

Before 1.0, only the latest tagged release receives security fixes. The
development channel is not a supported end-user distribution.

## Reporting a vulnerability

Use the repository's private GitHub Security Advisory reporting flow. Do not
open a public issue for a suspected credential exposure, arbitrary code
execution, path escape, unsafe update, or uninstall ownership defect.

Include the affected version, platform, host adapter, reproduction steps, and
whether the issue requires a malicious Provider artifact or can occur with the
published compatibility set. Do not include real credentials or private user
data in the report.

## Trust boundary

Agent Host Suite installs executable Provider artifacts and creates user-level
background services. Published compatibility releases therefore require exact
artifact hashes, retained licenses and SBOMs, code-signing verification where
the platform provides it, and fail-closed handling of unknown or conflicting
host entries.
