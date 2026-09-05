# Product model

## User and task

The direct user is an Agent Host operator or Provider maintainer who already
has a typed Capability implementation behind one HTTPS endpoint. They need to
bind it into the same local Capability JSONL execution seam as a local program
without embedding an API key in a Skill, Provider Manifest, process argument,
environment variable, request, or source checkout.

There is no human application or Agent-visible generic invocation tool.

## Objects and ownership

| Object | Owner | Contains |
|---|---|---|
| Capability Profile | Capability standards | Stable typed meaning, semantics, errors |
| Provider product | Provider maintainer | Remote implementation, deployment, manifest, adapter package |
| Provider Instance | Current Host/operator | Endpoint, closed operation set, credential reference, health |
| Capability HTTP Bridge | Agent Host package | JSONL-to-HTTP carrier and boundary checks |
| Direct Execution Runtime | Host runtime | Contract admission, execution bounds, provider process lifecycle |
| Skill | Provider product | Applicability and remaining human/Agent judgment |

The bridge does not make the remote service conformant. Provider conformance
still runs against the Profile and Provider Manifest. Endpoint and credential
availability are current Instance observations, not Profile claims.

A model-backed Provider has the same outer shape. A simple inference Provider
may contain only a typed context adapter, one bounded model call, and a result
adapter. An Agent-runner Provider may additionally own a harness, tools, loop,
turn/tool budgets, cancellation and termination policy. Both compositions
belong to the Provider product. Model identity, stochastic semantics,
provenance, budgets, and errors must be exposed in the selected Capability
contract or provider-specific result where they affect callers. A Skill that
asks the calling Agent to reason again remains guidance rather than an
independently installable Provider, but it is a valid route for unresolved
main-Agent judgment.

This bridge does not create a model-backed inference or Agent-runner Provider by
itself and does not silently call a model. The private development
`agent-tool-labs/packages/skill-partition-advisor` example exercises one
bounded model-inference
node with a provider-specific, secret-free Instance and isolated Agent Host
import. That pilot does not change this HTTP carrier, supply a Capability
binding, or establish model quality; credentials, cost, privacy, variability,
and evaluation authority remain explicit Provider/Instance concerns.

## Local adapter contract

The executable accepts exactly:

```text
openadam-capability-http-bridge --instance FILE
```

It reads strict newline-delimited Capability JSONL requests:

```json
{"id":"call-1","operationId":"run","input":{}}
```

The instance's closed operation list rejects any other operation. Each accepted
line becomes one HTTP POST:

```json
{
  "schemaVersion": "openadam.remote-capability-request.v0.1",
  "capabilityId": "org.example.capability",
  "capabilityVersion": "1.0.0",
  "id": "call-1",
  "operationId": "run",
  "input": {}
}
```

The endpoint returns HTTP 200, `application/json`, and exactly one envelope:

```json
{
  "schemaVersion": "openadam.remote-capability-response.v0.1",
  "id": "call-1",
  "ok": true,
  "result": {}
}
```

or:

```json
{
  "schemaVersion": "openadam.remote-capability-response.v0.1",
  "id": "call-1",
  "ok": false,
  "error": {
    "code": "DECLARED_DOMAIN_ERROR",
    "message": "The provider rejected the request.",
    "retryable": false
  }
}
```

The bridge removes only the remote envelope's schema version and returns the
ordinary Capability JSONL envelope unchanged. The Host validates input, output,
declared error code, and Profile-owned retryability.

## Transport failure semantics

DNS/TLS/connectivity failure, timeout, redirect, HTTP status other than 200,
wrong media type, response overflow, malformed/duplicate JSON, wrong
correlation, and invalid remote envelope are transport failures. The bridge
terminates non-zero without inventing a provider domain error. Direct Execution
Runtime therefore replaces the poisoned process and reports a Host transport or
provider-availability error.

There is no automatic retry. Whether another attempt is safe depends on the
Capability's effects and the caller's policy, not the HTTP library.

## Credentials and privacy

`auth.kind: macos-keychain-bearer` names one Keychain service and account. The
adapter resolves it with `/usr/bin/security`, bounds the returned token, and
places it only in the outbound Authorization header. Lookup output and errors
are never copied to stderr or JSONL. The instance file, process arguments,
environment, source, and diagnostics contain no token.

This is a retrieval path, not a credential vault or provisioning flow. The
operator owns Keychain creation, rotation, endpoint authorization, data-egress
approval, and service terms. The current Direct Runtime proves a local adapter
process, not absence of network egress; registration of a real remote Instance
must therefore retain an explicit network/endpoint approval outside the
Capability semantic claim.

## Current completion boundary

The implemented boundary is:

- strict instance and JSON parsing;
- fixed HTTPS endpoint, with numeric loopback HTTP only for tests;
- closed Capability and operation identity on every request;
- bounded request, timeout, response, error message, and Keychain output;
- no redirects or retries;
- exact result/error preservation;
- a real Direct Runtime loopback HTTP pilot with a frozen instance descriptor;
- zero model calls and no persistent provider process in the pilot.

Not yet claimed: a production remote endpoint, installed Agent Host lifecycle,
cross-platform credential provider, network sandbox/egress enforcement,
model-backed inference/Agent-runner semantics, or owner privacy/business acceptance.
