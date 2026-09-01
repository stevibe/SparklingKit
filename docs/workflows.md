# File-based Workflows — v1

## Purpose

SparklingKit workflows connect existing modules without exposing provider details or internal chunking. A workflow is a portable JSON document, a run remains attached to a normal file-based job, and every meaningful result remains a typed artifact.

The first release is intentionally a directed acyclic graph (DAG): it supports routing and branches, but not loops, arbitrary scripts, timers, or a general automation platform.

## Design principles

- **Artifact-first:** edges carry typed artifact sets, not untyped blobs or filesystem paths.
- **Portable:** definitions reference module and workflow IDs, never endpoint URLs, API keys, or model names.
- **Discoverable:** service-node ports come from the capability router and module registry.
- **Inspectable:** definitions, run snapshots, node state, and results remain JSON/files under `data/`.
- **Recoverable:** Redis schedules work, but a restart can reconstruct unfinished execution from disk.
- **Safe:** conditions use a small declarative predicate language; workflow JSON cannot execute JavaScript.
- **Simple by default:** a node only exposes parameters that materially change its result. Provider tuning stays in Settings.

## Durable layout

```text
data/
├── config/
│   └── workflows/
│       ├── read-and-translate.json
│       └── meeting-notes.json
└── jobs/<job-id>/
    ├── job.json
    ├── flows/
    │   └── <flow-run-id>.json
    ├── input/
    ├── work/
    └── output/
```

Workflow definitions are settings, but each gets its own file instead of expanding `settings.json` into a large, conflict-prone document. Writes must use the same atomic temporary-file-and-rename strategy as other durable JSON.

Each flow run stores an immutable snapshot of its definition. Editing a saved workflow therefore cannot alter an in-progress or historical run. Secrets are never copied into either file.

## Definition contract

```json
{
  "schemaVersion": 1,
  "id": "read-and-translate",
  "revision": 3,
  "name": "Read and translate",
  "description": "Extract text from an image or PDF, then translate it.",
  "enabled": true,
  "nodes": [
    {
      "id": "input",
      "type": "input",
      "position": { "x": 80, "y": 180 },
      "config": {
        "accepts": ["source-image", "source-pdf"],
        "multiple": true,
        "maximumFiles": 20
      }
    },
    {
      "id": "ocr",
      "type": "module",
      "position": { "x": 380, "y": 180 },
      "config": {
        "moduleId": "ocr",
        "workflowId": "auto",
        "params": {}
      }
    },
    {
      "id": "documents",
      "type": "select",
      "position": { "x": 680, "y": 180 },
      "config": {
        "kinds": ["document"],
        "mode": "all"
      }
    },
    {
      "id": "translate",
      "type": "module",
      "position": { "x": 980, "y": 180 },
      "config": {
        "moduleId": "translation",
        "workflowId": "translation.default",
        "params": {
          "sourceLanguage": "auto",
          "targetLanguage": "zh-Hant"
        }
      }
    },
    {
      "id": "end",
      "type": "end",
      "position": { "x": 1280, "y": 180 },
      "config": {
        "result": "incoming-artifacts"
      }
    }
  ],
  "edges": [
    {
      "id": "input-to-ocr",
      "from": { "nodeId": "input", "portId": "files" },
      "to": { "nodeId": "ocr", "portId": "input" },
      "artifactKinds": ["source-image", "source-pdf"]
    },
    {
      "id": "ocr-to-documents",
      "from": { "nodeId": "ocr", "portId": "output" },
      "to": { "nodeId": "documents", "portId": "input" },
      "artifactKinds": ["document"]
    },
    {
      "id": "documents-to-translate",
      "from": { "nodeId": "documents", "portId": "output" },
      "to": { "nodeId": "translate", "portId": "input" },
      "artifactKinds": ["document"]
    },
    {
      "id": "translate-to-end",
      "from": { "nodeId": "translate", "portId": "output" },
      "to": { "nodeId": "end", "portId": "input" },
      "artifactKinds": ["translation"]
    }
  ],
  "ui": {
    "viewport": { "x": 0, "y": 0, "zoom": 0.9 }
  },
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z"
}
```

`position` and `ui` are presentation state and have no execution meaning. The server ignores unknown UI fields.

`workflowId: "auto"` asks the capability router to resolve the correct registered workflow for each input kind. A mixed set can be grouped into compatible module runs and gathered back into one node output.

## Node catalog

### Service nodes

Service nodes use the current module contracts and provider settings:

| Node | Accepts | Produces | Notes |
| --- | --- | --- | --- |
| OCR | Images and PDFs | Documents and structured data | Selects image or PDF workflow automatically. |
| Transcription | Audio and video | Transcript, subtitle, and structured data | Chunking remains internal. |
| Translation | Text-based artifacts | Translation | Language parameters belong to the node. |
| Grounding | Images | Grounded image and annotations | Queries belong to the node. |
| Text to image | Text-based artifacts or a prompt parameter | Generated image | Canvas options belong to the node. |
| LLM prompt | Text, structured data, and optionally images | Text or document | Image input is enabled only when the configured LLM declares vision support. |
| Create chat | Router-compatible references | Linked conversation | A terminal handoff because a human conversation is interactive. |

The LLM prompt node is the deterministic workflow counterpart to Chat. It enables summarization, classification, rewriting, and extraction without pretending that an interactive conversation completes automatically.

### Generic nodes

The useful minimum is:

- **Input:** exactly one per workflow and always the first source. It declares accepted artifact kinds, single/multiple selection, and limits.
- **Select:** keeps artifacts by kind, role, or producing node. This is essential because one service can produce several results.
- **If:** evaluates a safe predicate and forwards the same artifacts through `true` or `false`.
- **Switch:** evaluates ordered cases and forwards through one matching port or `default`.
- **Merge:** reunites exclusive or parallel branches. `all` waits for every active input; `any` continues with the first successful input.
- **End:** marks a successful terminal path and declares which incoming artifacts are user-facing results.
- **Fail:** stops the active path with a readable reason. This is useful for explicit validation branches.

Delay, HTTP request, shell command, loop, arbitrary code, and user-defined plug-in nodes are outside v1. Retry, timeout, and cancellation remain service-run behavior instead of separate graph nodes.

## Typed ports and connection rules

Every port exposes a set of `ArtifactKind` values. The editor asks the capability router for those sets rather than duplicating them in UI code.

An edge is valid when:

```text
edge.artifactKinds is a non-empty subset of
sourcePort.produces intersect destinationPort.accepts
```

The editor only highlights compatible target handles while dragging. The server runs the same validation when saving and again when starting a run. Server validation is authoritative.

Port behavior:

- Input output kinds come from `config.accepts`.
- Module input/output kinds come from `ModuleContract.accepts` and `ModuleContract.produces`.
- LLM and Chat image ports reflect the configured capability flags.
- If and Switch output ports preserve the incoming kind set.
- Select narrows its output set.
- Merge emits the union of its connected inputs.
- End and Fail have no output port.

A provider being offline is a save-time warning, not a schema error, so workflows remain portable. It becomes a clear run-time blocked state if the required service is still unavailable when execution reaches that node.

## Condition language

Conditions are JSON and never executable source text:

```json
{
  "all": [
    { "fact": "artifact.kind", "operator": "in", "value": ["document", "transcript"] },
    { "fact": "artifact.metadata.language", "operator": "notEqual", "value": "en" }
  ]
}
```

Initially supported facts should be limited to stable data:

- `artifact.kind`
- `artifact.mimeType`
- `artifact.role`
- `artifact.metadata.*`
- `input.fileCount`
- `run.status`
- declared workflow variables

Operators are `equal`, `notEqual`, `in`, `notIn`, `exists`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`, `contains`, and `startsWith`. Regular expressions are deliberately excluded from v1.

If content understanding is required, users should connect an LLM prompt/classification node and branch on its structured result instead of placing model behavior inside If.

## Validation

A definition cannot run until it passes all structural checks:

1. Schema version, IDs, node configs, and parameters are valid.
2. There is exactly one Input and at least one End or Create chat terminal.
3. The graph has no cycles and every node is reachable from Input.
4. Every active branch can reach a terminal node.
5. Every edge has at least one compatible artifact kind.
6. Module and workflow IDs exist in the current registry.
7. If has both outputs connected; Switch has a default output and unique case values.
8. Merge modes cannot create an impossible wait after an exclusive branch.
9. Configured safety limits are respected, initially 50 nodes and 100 edges.

Saving may retain an invalid draft for editor recovery, but only a validated revision can be enabled or run. Validation errors identify the node, port, and corrective action.

## Execution model

A flow run is an orchestrator over existing module workflow runs, not a replacement for them.

1. Validate and snapshot the selected workflow definition.
2. Create or reuse a normal job and materialize the Input artifacts.
3. Persist node states as `pending`, `ready`, `running`, `succeeded`, `failed`, `skipped`, `blocked`, or `cancelled`.
4. Execute each ready service node as a normal registered module run within the flow worker.
5. When it finishes, record its output artifact IDs, evaluate routing nodes synchronously, and schedule newly ready nodes.
6. Mark unchosen branches `skipped`; Merge waits only for active branches.
7. End collects the terminal artifacts. The flow succeeds after every active path has ended.

The coordinator never enqueues a child and waits for another worker on the same queue. It executes the registered module run directly, checkpoints the durable flow state, and advances to the next ready node. This works with worker concurrency of one and avoids nested-queue deadlocks. Independent branches execute deterministically in v1; parallel scheduling can be added later without changing the JSON contract.

Cancellation marks the flow cancelled, cancels queued node runs, aborts the active provider request through the existing cancellation signal, and leaves completed artifacts intact. Retry restarts the failed node and downstream path, not earlier successful nodes, unless the user explicitly chooses a full rerun.

Redis messages contain only stable IDs. On startup, the recovery pass reads unfinished `flows/*.json`, reconciles their node runs with `job.json`, and requeues ready or interrupted work idempotently.

## Flow-run file

The durable run file contains:

- flow run ID, job ID, status, progress, timestamps, and cancellation state;
- workflow ID, revision, and complete definition snapshot;
- initial input artifact IDs and terminal output artifact IDs;
- effective variables;
- per-node state, attempt count, child module-run IDs, input/output artifact IDs, error, and timestamps;
- selected branch ports and skipped-node reasons.

Provider secrets and raw bearer tokens must never be included. Module-run parameters continue to snapshot only non-secret effective settings required for reproducibility.

## API surface

```text
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/:workflowId
PUT    /api/workflows/:workflowId
DELETE /api/workflows/:workflowId
POST   /api/workflows/:workflowId/validate
POST   /api/workflows/:workflowId/runs
GET    /api/jobs/:jobId/flows/:flowRunId
POST   /api/jobs/:jobId/flows/:flowRunId/cancel
POST   /api/jobs/:jobId/flows/:flowRunId/retry
GET    /api/jobs/:jobId/flows/:flowRunId/events
```

Starting a run may accept multipart files for a new job or existing artifact IDs for a continuation. The Input contract validates either form.

## Editor experience

Use `@xyflow/react` for the desktop/tablet canvas rather than implementing pointer math, selection, keyboard navigation, zoom, and accessible handles from scratch.

The screen has three functional areas:

- node palette with service and generic groups;
- canvas with drag/drop, typed handles, minimap, zoom, undo/redo, and fit-to-view;
- contextual inspector for the selected node or edge.

Connections use artifact-family color only as a secondary cue; text and icons retain meaning without color. Invalid targets do not accept a drop. Save validates the graph and Start opens the file/text input appropriate to the Input node.

Phone users should be able to start, monitor, cancel, inspect, and reuse workflows. A compact vertical node outline is preferable to forcing full freeform canvas editing on a narrow screen. Full graph authoring can remain a desktop/tablet feature in v1.

## Implementation status and sequence

Implemented:

1. Workflow definition, node, edge, validation-result, and flow-run contracts.
2. Capability-router-backed typed port discovery.
3. Atomic workflow definition storage and CRUD/validation APIs.
4. Durable Input, Module, Select, If, Switch, Merge, End, and Fail execution.
5. Recovery, retry, cancellation, LLM Prompt, and Create chat behavior.
6. Visual editor, workflow library, run history, and mobile vertical editor outline.

Next:

1. Add a starter-template gallery beyond the built-in OCR flow.
2. Add richer workflow run visualization to the job detail page.
3. Add optional parallel branch scheduling while preserving deterministic persisted state.

The first integration fixture should run without the browser and assert artifact lineage across the complete graph. The editor is a client of this contract, not the owner of workflow meaning.
