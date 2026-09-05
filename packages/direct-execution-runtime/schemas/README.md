# Schema provenance

All schema files in this directory are distributed under this repository's
Apache-2.0 license. They fall into two roles.

## Runtime-owned schemas

Direct Execution Runtime owns the provider configuration, work order, contract
selection, closed resolution request/result, host request, host response, host service observation, and
metadata-only execution observation schemas. They describe
this implementation's host boundary, not a universal Agent or provider ABI.
The resolution result distinguishes a configured projected-operation envelope
from an exact operation identity observed in a current live contract.
JSON Schema is the structural veto only. Consumers that accept a resolution
result as a JavaScript value must also call the exported
`validateResolutionResult`, which enforces selection/candidate/request target
identity, provider/transport alignment, exact and status counts, and result
precedence. The schema alone cannot express all of those equality relations.

## Compatibility copies

- `capability-profile.schema.v0.3.json` and
  `provider-manifest.schema.v0.3.json` mirror the Apache-2.0
  `capability-contracts` sources.
- `capability-jsonl-envelope.schema.v0.1.json` mirrors the closed canonical
  adapter envelope from `capability-contracts`. Its error object permits exact
  `{code,message}` and `{code,message,retryable}` compatibility forms; the
  bound Capability Profile remains authoritative for retryability.
- `procedure-profile.schema.v0.5.json` and
  `procedure-implementation-manifest.schema.v0.5.json` mirror the Apache-2.0
  `procedure-contracts` sources.
- `evals-direct-driver-request.schema.json` and
  `evals-direct-driver-result.schema.json` mirror the direct-host adapter
  contract maintained in the private
  `agent-tool-labs/packages/agent-tool-evals` package. openAdam releases these
  copies under Apache-2.0 in this distribution; this does not license or
  publish the rest of that private package.

`provider-config.schema.v0.2.json` and
`host-service-observation.schema.v0.1.json` retain the exact previous
runtime-owned envelopes for rollback and compatibility testing. Their current
counterparts are v0.3 and v0.2 respectively; fields are never added under an
old closed-schema identity.

Compatibility copies make the installable runtime self-contained. They do not
transfer semantic ownership to this project. The maintainer-only local pilot
compares the current copies byte-for-byte with the sibling sources before
exercising the cross-repository route. Older bundled standards-schema copies
remain historical package inputs; the two runtime-owned compatibility schemas
above remain live rollback inputs.
