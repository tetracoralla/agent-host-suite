# Package release checklist

This checklist prepares the Direct Execution Runtime package inside an Agent
Host source and compatibility release. It does not authorize pushing Agent
Host, publishing an npm package, or enabling hosted settings.

1. Confirm the intended revision contains no local provider configuration,
   credentials, `.verify/` output, Socket files, or machine-specific paths.
2. Run `npm ci`, `npm run check`, `npm run audit:production`, and, on a machine
   with the maintainer pilot providers, `npm run check:local-pilots`.
3. Inspect `npm pack --json` and install the tarball in an empty directory.
   `npm run check:package` performs this mechanically, including the persistent
   service cold/warm route, config-backed exact resolution without target
   execution, and clean shutdown.
4. Confirm `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`, and the
   README are present in both source and package surfaces.
5. Review the Agent Host Git diff and history for secrets, personal data,
   generated output, large files, and misleading completion claims before a
   push.
6. Require the Agent Host CI and hosted security configuration separately;
   local files cannot establish those hosted settings.
7. Create an Agent Host tag or GitHub release only after the owner explicitly
   authorizes that publication step. The Runtime package remains `private` and
   is not an npm release.
