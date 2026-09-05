# Local Provider substitution

The maintainer experiment answers one bounded question: can one unchanged
consumer use the same semantic inputs, contract, result handling, and error
handling with two different time-zone engines through the current Host?

Run from this package in an owning-source workspace:

```sh
npm run check:local-substitution
```

It reads the adjacent `capability-contracts` and `migratory-time` source roots.
To use another checkout, set `OPENADAM_CAPABILITY_CONTRACTS_ROOT` and
`OPENADAM_MIGRATORY_TIME_SOURCE_ROOT` to absolute paths. The standards checkout
must contain the generated corpus module and Python `zoneinfo` witness. Install
each repository's declared development prerequisites first. The check reads
Provider sources without changing them.

The pilot requires POSIX and an available Python with `zoneinfo` and versioned
time-zone data. `OPENADAM_SUBSTITUTION_PYTHON` may select one absolute Python
executable; otherwise the safe command resolver selects `python3`. The generated
witness launcher invokes that interpreter in place. This matters on macOS,
where copying a system Python shim can prevent it from starting. The Host binds
and freezes the temporary launcher and adapter; the report explicitly records
the external interpreter command, actual executable, version, and unfrozen
status. It does not turn the witness into a self-contained release artifact.

The check creates and removes one private temporary witness binding and local
service. It prints one current JSON observation when invoked directly with
`node scripts/check-local-substitution.mjs`; npm may add its own preamble.
There is no implicit saved success report. A caller may redirect stdout to an
owner-selected observation file. An absent source prerequisite or unsupported
platform returns `incomplete` with exit 2. An invalid binding, failed execution,
semantic mismatch, or cleanup failure returns `failed` with exit 1.

## What executes

1. Validate the existing Profile and generated Differential Suite. Keep the 12
   fixed boundary/error cases, add 192 generated cases over UTC instants in
   2024–2028 and nine target zones, and preserve the seed and corpus digest.
2. Resolve two explicit local bindings for `time-zone.convert@0.2.0/convert`.
   Require the same current projected contract. Resolution must not start the
   JSONL target process or choose a Provider.
3. Execute one cold library call per Provider, then the entire corpus through
   the same consumer with sequential warm library calls. Changing only the
   explicit Provider coordinate must preserve outcomes.
4. Execute that corpus again using a separate CLI process over the runtime's
   private local service, in at most 128-call orders. The Provider sessions
   must remain warm. CLI process overhead and queued batch wall time are
   reported separately from sequential library timing.
5. Check source echo, target order, exact UTC instant, and wall-time/offset
   conservation for every generated success. Compare all semantic result
   fields except the suite-authorized `/context/timeZoneDatabase` provenance
   field, whose observed values remain separately reported. Preserve domain
   error code and retryability; diagnostic wording stays Provider-owned.
6. Reject a mismatched required contract and invalid input, then close the
   runtime and service before returning a passed observation. Host errors,
   missing results, changed Provider identity, and contract drift cannot count
   as two providers agreeing.

The consumer lives in `scripts/substitution-consumer.mjs`. It has no
Provider-specific input or result branch. Its source digest and complete
semantic-outcome digest identify the current comparison. Unit regressions
mutate results, ordering, identities, errors, and contracts to check that the
experiment can fail meaningfully.

## Reading the result

The result observes one consumer over two Host carriers. Both carriers use the
same Direct Runtime, so they are not two independent consumer implementations.
The Python witness uses a different domain engine but is not a second released
Provider product. A pass supports the tested substitution mechanics and
covered semantic agreement; it does not promote the Profile's conformance
level or establish all-zone/all-date interchangeability.

Cold timing includes first-call Host validation and launch preparation, but
not the preceding config preparation and contract projection. Warm library
timing includes each complete sequential work order. CLI-over-service timing
includes CLI startup, IPC, admission, the whole batch, and serialization; its
orders have different sizes and are not a per-call benchmark. Timings are local
observations with no pass threshold or automatic winner. Host-stage model
calls are zero. Agent tokens, money, generated-code effort, installation cost,
UI interaction, and adoption remain unobserved. Source revisions, dirty state,
binding digests and database values provide coordinates, not a frozen copy of
all imports, interpreters, libraries or operating-system data.

For complementary provider-boundary checks, run the standards repository's
ordinary conformance suite separately for each manifest and
`npm run check:time-zone-differential -- --generated`. The Host experiment does
not silently count those separate checks as completed.
