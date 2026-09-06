# Report v0.9

This additive report adds `currentComponentBinding` to tool groups. It follows
contiguous retained component identity (version, artifact and declared tools),
so another component's release does not reset the window. Replacement, removal,
exposure changes and rollback create boundaries. Counts remain declared-binding
observations; an older open Agent session can still use older executable code.
`observedSinceMs` is an observed lower bound, not an inferred installation date.

Direct Runtime observation v0.2 adds caller-declared `purpose` and optional
provider-declared outcome metadata. The v0.1 reader remains supported and its
purpose/outcome are unspecified/not-reported. Terminal transport completion stays
separate from partial batch results and failed/cancelled items. Unknown data is
never filled in from free-form result content. `runtimeErrorCodes` reports only
stable codes with source and version; codes from different observation layers
must not be summed as independent failures.

`versionHistory` includes current and archived version/purpose aggregates across
retained observations, outside the report's sliding time window. Raw events
still follow configured retention. On cleanup, aggregates and hash-only receipts
are written atomically before deletion. Receipts prevent source rotation/replay
from counting the same execution twice. Aggregate metadata, receipts and small
deployment boundaries remain until explicit Observer state removal. Records
already deleted before this feature cannot be reconstructed.

Database version 11 remains readable by the installed older reader. New tables
are additive. The legacy semantic table stores the v0.1 projection, and the
side table retains the original wire version and new outcome/purpose metadata.
An older collector cannot ingest v0.2 events, so rollback must restore a compatible
Runtime/Observer pair. It will report an unsupported source rather than discard
or silently reinterpret the new events. Reinstall/upgrade reuses the same state.
