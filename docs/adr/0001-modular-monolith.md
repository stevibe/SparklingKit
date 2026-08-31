# ADR 0001: Modular monolith with file-backed durability

Status: Accepted

## Context

SparklingKit began with three hardcoded processing paths. Translation, grounding, redaction, and further file workflows require independently extensible behavior without making installation or operation more complex.

## Decision

- Keep one deployable Node.js application.
- Separate modules, providers, workflow execution, and infrastructure through TypeScript contracts.
- Keep job folders and manifests as durable state.
- Use Redis and BullMQ only for coordination and active execution.
- Add compiled-in modules through registries first.
- Defer externally installed executable plugins until versioning, permissions, and trust boundaries are proven.

## Consequences

- New capabilities can be added without changing queue semantics or file storage conventions.
- Users retain a single Docker deployment and portable data folder.
- Compatibility readers and schema migrations become permanent architectural responsibilities.
- Module code must not depend directly on Express routes or React UI components.
- A module failure cannot be allowed to corrupt source artifacts or unrelated workflow history.
