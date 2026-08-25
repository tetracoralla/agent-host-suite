# Privacy

The standard profile does not collect prompts, tool inputs, tool results, file
contents, credentials, or Agent messages.

Direct Runtime observations are opt-in metadata. They may include selected
semantic and provider identifiers, terminal status, stable error code, timing,
serialized input/result byte counts, session state, and binding digests. They
exclude work-order identifiers, call identifiers, inputs, results, and error
messages.

Agent Tool Observer and Context Surface Analyzer are installed only after the
user enables the observability profile. Before enabling, the UI states that a
five-minute local Observer job and a weekly managed-catalog measurement are
created, and names the local Observer data directory. Disabling stops new
collection. Suite purge removes only suite-owned snapshots and history;
Observer's shared database is retained unless the user separately removes it
through that product's data lifecycle.

No observation is uploaded by default. A future remote destination requires a
separate product decision, consent, authentication, retention policy, and
security review.
