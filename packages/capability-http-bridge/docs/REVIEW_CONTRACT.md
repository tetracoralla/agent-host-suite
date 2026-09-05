# Review contract

Review the current bridge as one local adapter, Provider Instance descriptor,
credential lookup, remote HTTP boundary, and Direct Runtime composition. A
loopback green check is not a production endpoint or privacy approval.

## Durable invariants

1. One exact instance file fixes endpoint, Capability identity, closed
   operation allowlist, auth reference, timeout, and response-byte limit.
2. Cleartext HTTP is accepted only for numeric loopback. URLs with credentials,
   query, fragment, redirects, or an unbounded endpoint are rejected.
3. Tokens appear only in the outbound Authorization header. They never enter
   files, arguments, environment, work orders, JSONL, stdout, or diagnostics.
4. Every remote request repeats the selected Capability id/version,
   correlation id, operation id, and unchanged structured input.
5. Remote success and declared domain errors remain exact. Transport failure
   terminates the adapter so the Host owns the failure; it is never renamed as
   a domain error.
6. Duplicate JSON keys, unknown fields/operations, partial or overlong input,
   wrong correlation, wrong media type, non-200 status, response overflow, and
   malformed remote envelopes fail closed.
7. No automatic redirect or retry occurs.
8. The bridge is never projected as a generic Agent tool and never selects a
   Provider, endpoint, model, or Capability.

## Current checks

```sh
npm run check
```

The adapter tests exercise success/error preservation and negative transport
boundaries. The Direct Runtime pilot materializes a temporary complete
Capability Provider, freezes adapter plus instance identities, crosses a real
loopback HTTP server, validates the result through the current Profile schemas,
and verifies per-call process cleanup.

Separately report:

- repository regression;
- Direct Runtime carrier pilot;
- production endpoint and credential availability;
- network/privacy authorization;
- installed Agent flow;
- Capability conformance and substitution;
- owner acceptance.

Independent review should also inspect contradictions next to the covered
route: alternate URL spellings, IPv6 and DNS rebinding assumptions, Keychain
failure text, streaming bodies without Content-Length, response compression,
timeout during body read, session replacement, and whether any Host UI or
resolver overstates local execution as no network egress.
