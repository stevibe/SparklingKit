# SparklingKit Architecture

## System shape

SparklingKit is a modular monolith. Product capabilities are modules, inference servers are providers, durable results are artifacts, and each invocation is a workflow run.

```text
Source files
    │
    ▼
Job / work item
    ├── artifacts ───────────────┐
    └── workflow runs            │
            ├── steps            │
            └── provider calls   │
                    │            │
                    └── new artifacts
                                 │
                 summarize / translate / ground / generate / chat
```

Redis coordinates execution. The `/data` directory owns durable state and must be sufficient to inspect, back up, and recover work.

The visual workflow layer composes these same modules and artifacts as a versioned, file-based DAG. It does not introduce another execution or storage model. See [`workflows.md`](workflows.md).

## Domain boundaries

### Module

A user-facing capability such as OCR, Transcription, Translation, Grounding, Text to image, or Chat. A module declares accepted and produced artifact kinds, actions, provider requirements, route metadata, and implementation availability.

The authoritative catalog is `src/server/modules/registry.ts` and is exposed through `GET /api/modules`.

### Provider

A model endpoint implementing a capability. Providers are configuration and transport concerns; they are not navigation items or workflows. Translation and grounding therefore receive independent endpoints even when they temporarily use the same protocol as an LLM.

### Job

A portable work container holding sources, generated artifacts, and workflow history. The compatibility `type` field can be `audio|image|pdf|text`; new logic must use `moduleId`, `workflowId`, and artifact kinds.

### Workflow run

One invocation of a module workflow. Runs have their own IDs, status, progress, parameters, input and output artifact IDs, warnings, cancellation state, and timestamps.

BullMQ messages identify a run. The worker dispatches through `src/server/modules/executors.ts`; the queue does not import individual module behavior.

### Artifact

A source or generated file with a stable ID, kind, MIME type, role, producing run, ancestry, and metadata. Filenames are presentation and storage details, not type information.

Structured canonical artifacts are required where positional provenance matters:

- OCR: pages, blocks, and normalized bounding boxes.
- Transcription: segments and time ranges.
- Grounding: versioned image annotations with pixel-coordinate boxes, query labels, and source lineage. Future provider types may add text spans, PDF page boxes, or time ranges.
- Redaction: a derivative plus an audit report; originals are immutable.
- Text to image: the written prompt is a source artifact and each generated bitmap is a derived image artifact.

## Durable layout

The existing layout remains compatible:

```text
data/
├── config/
│   ├── settings.json
│   ├── secrets.json
│   ├── prompts/
│   └── workflows/               # saved workflow definitions
├── jobs/<job-id>/
│   ├── job.json
│   ├── flows/                   # durable flow-run snapshots
│   ├── input/
│   ├── work/
│   └── output/
├── chats/<chat-id>/chat.json
└── logs/
```

`job.json` schema version 2 contains the artifact catalog and workflow runs. `input/` is source material, `work/` is disposable checkpoint data, and `output/` contains user-facing files.

Module history is a filtered projection of jobs and their workflow runs, not a separate data store. Saved quick-text and direct text-file translations therefore create the same durable job/run/artifact records as other file-based work. Debounced live Translation previews in the Workbench and Translation module call the shared Translation service adapter without writing a job; choosing **Save** enters the normal durable workflow. These preview surfaces do not own a second result store.

## Compatibility rules

- A v1 job is normalized in memory when read.
- `audio` maps to `transcription.default`.
- `image` maps to `ocr.images`.
- `pdf` maps to `ocr.pdf`.
- Existing output filenames are inferred into typed artifacts.
- `outputFiles` remains available as a compatibility projection.
- Old BullMQ `job` and `preset` messages can drain after an upgrade.
- Migrations must be additive and must not bulk-rewrite user folders without an explicit migration command.

## Module addition checklist

1. Add the module descriptor to the registry.
2. Define a typed provider request and result contract.
3. Implement a workflow executor and register its workflow ID.
4. Declare accepted and produced artifact kinds.
5. Snapshot effective settings into the run parameters where reproducibility requires it.
6. Write checkpoints only beneath the run's `work/` area.
7. Return final user-facing files as artifacts with lineage.
8. Add provider contract, cancellation, recovery, and artifact-lineage tests.
9. Let generic navigation, settings, and artifact-action surfaces discover the module.

## Grounding and redaction requirements

Grounding cannot be represented as plain generated prose. The current image workflow stores normalized pixel-coordinate boxes in `grounding.annotations.json` and creates a non-destructive SVG overlay for immediate visual review. The original image remains unchanged.

Redaction is a two-stage workflow:

1. Detect and preview sensitive regions.
2. Confirm and render a derivative in which the underlying content is actually removed.

Drawing an opaque rectangle over selectable PDF text is not a valid redaction. The original artifact is never overwritten.
