# Execution observation extensions

Work order v0.2 is the closed v0.1 order plus required `purpose`: `task`,
`diagnostic`, `validation`, or `unspecified`. The original v0.1 schema and reader
remain available; old orders observe an unspecified purpose. Purpose is supplied
by the caller, never guessed from IDs or result contents. Agent Host doctor
supplies `diagnostic`. The Socket action set and response v0.1 are unchanged. Work order v0.2 uses the
explicit host-request v0.2 schema; host-request v0.1 remains closed to v0.1 orders.

MCP providers may declare `io.openadam.executionOutcome.v1` in CallToolResult
`_meta`. It has exactly `status`, `items`, and `errorCodes`. Status is completed,
partial, error, cancelled or unknown. Items are null or closed integer counters
(total/completed/errors/cancelled/unknown); their sum must match. Error codes are
bounded stable identifiers with counts, without messages or input/result content.
The executable validator and execution observation schema define the limits.

Observation v0.2 records the purpose and a validated outcome wrapper. Missing
metadata becomes `not-reported`; malformed or contradictory metadata becomes
`invalid`. Neither changes the provider's result or the transport terminal state.
No arbitrary `result.status` field is interpreted. A valid partial batch remains
a successfully returned MCP result with separately visible item failures.

The passive Observer interprets these declared fields mechanically. A completed
result does not establish mathematical correctness, adoption, task quality or
value. These require task-specific evidence and the user's selected Agent.
