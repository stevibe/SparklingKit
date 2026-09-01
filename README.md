# SparklingKit

> A local-first, file-oriented AI workspace for OCR, transcription, translation, visual grounding, image generation, chat, and reusable workflows.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](https://nodejs.org/)

SparklingKit turns files into durable, reusable AI work. It connects to independently hosted inference services, keeps sources and generated results together, and records processing history as ordinary files rather than hiding it inside a database.

The application is designed for private workstations, home labs, and local-network AI servers. Models are not bundled: bring compatible services, configure their endpoints, and enable only the capabilities you need.

SparklingKit’s reference deployment runs **six specialized models on a single NVIDIA DGX Spark with 128 GB of unified memory**. Instead of asking one general model to handle every medium, the workspace routes each task to a focused OCR, speech, translation, grounding, image, or multimodal language model—all from one machine and one interface. A repository-owned starter script handles the model downloads, service builds, memory-safe startup order, readiness checks, system monitor, and SparklingKit itself.

## Why SparklingKit?

AI work rarely ends after one operation. After recording a meeting, you may want to transcribe it, turn the transcript into a concise summary, and then chat with the result to revisit a decision or find an action item. When a large scanned PDF arrives, you may need to extract it into readable text before summarizing, translating, or asking questions about it. SparklingKit keeps these steps connected instead of treating each one as an isolated task.

The same applies to images: generate one from a prompt, pass it directly into visual grounding, and search for a person, object, text region, or other detail inside it. Every source and generated result remains a typed artifact with its files, lineage, and processing history, so you can always see where it came from and choose a compatible **Continue with** action.

SparklingKit is built around small, atomic capabilities—OCR, transcription, translation, grounding, image generation, and language-model reasoning—that can be combined without coupling the underlying services. For repeatable work, the node-based workflow editor lets you connect those same capabilities with typed inputs, conditions, branches, merges, and explicit file outputs. Design the flow once, then run it again with a new recording, document, image, or piece of text.

For workloads involving recorded meetings, private documents, scanned PDFs, and personal images, we strongly recommend running models locally whenever suitable hardware is available. Local inference keeps sensitive material on infrastructure you control, avoids repeatedly uploading large files, and gives you direct ownership of model selection, capacity, availability, and data retention. SparklingKit is designed local-first: source files, generated artifacts, processing history, workflow definitions, and service endpoints remain under your control. It is not local-only, however. Compatible cloud APIs can also be configured as service endpoints, allowing SparklingKit to serve as one consistent interface for local models, cloud-hosted models, or a deliberate combination of both.

## One DGX Spark, six AI services

The reference stack deliberately fits six complementary models onto one DGX Spark:

| Capability | Model | Role in SparklingKit |
| --- | --- | --- |
| Multimodal LLM | [`nvidia/Qwen3.6-35B-A3B-NVFP4`](https://huggingface.co/nvidia/Qwen3.6-35B-A3B-NVFP4) | Chat, vision-aware references, summarization, and workflow prompts |
| OCR | [`baidu/Unlimited-OCR`](https://huggingface.co/baidu/Unlimited-OCR) | Page and image text extraction |
| Speech recognition | [`Qwen/Qwen3-ASR-1.7B`](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | Audio/video transcription and subtitles |
| Translation | [`tencent/Hy-MT2-1.8B-FP8`](https://huggingface.co/tencent/Hy-MT2-1.8B-FP8) | Dedicated multilingual translation |
| Visual grounding | [`nvidia/LocateAnything-3B`](https://huggingface.co/nvidia/LocateAnything-3B) | Query-driven object and region location |
| Image generation | [`Tongyi-MAI/Z-Image-Turbo`](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | Fast text-to-image generation |

This gives a small team or individual a practical multimodal workspace without sending every file to a hosted provider. SparklingKit supplies the shared UI, file history, artifact routing, workflows, queueing, and progress monitoring; the six model servers stay independently replaceable.

## Choose your deployment

SparklingKit has two independently deployable layers:

1. the **AI service layer**—the six reference models and optional DGX system monitor; and
2. the **workspace layer**—the SparklingKit web application, API, Redis queue, and file data.

Keeping that boundary explicit supports three practical setups without maintaining three different products:

| Setup | AI services | SparklingKit | Best for |
| --- | --- | --- | --- |
| **All in one** | DGX Spark | Same DGX Spark | The simplest out-of-the-box experience |
| **Split** | DGX Spark | Another server | Keeping the DGX focused on inference or sharing it across a network |
| **SparklingKit only** | Your endpoints | Any Docker host | Existing local services, cloud APIs, or a custom mix |

## Install the workspace

The recommended distribution is a prebuilt multi-platform container with a small Docker Compose bundle. It runs SparklingKit and Redis together; model weights are never included in the application image.

```bash
curl -fsSLO https://run.sparklingkit.com/stable/install.sh
less install.sh
bash install.sh
```

Open `http://localhost:54321`, or `http://SERVER-IP:54321` from another device on the trusted network. The installation directory is deliberately portable:

```text
sparklingkit/
├── compose.yaml
├── sparklingkit
└── data/                 # settings, jobs, files, chats, workflows, and Redis state
```

The Compose file pulls `ghcr.io/stevibe/sparklingkit` for the host's architecture. It bind-mounts `./data` directly into the application so backing up or moving the workspace does not require extracting a Docker volume.

On the first visit, choose one of three tabs:

### Run models locally

Choose this when SparklingKit and the six models run on the same DGX Spark. Onboarding provides both the hosted, checksum-verified installer and the GitHub-source command, then verifies all six services through Docker's host gateway before applying anything.

### Run models remotely

Choose this when the model stack runs on another DGX Spark. Run the same model installer on the DGX, enter its trusted-network hostname or IP in onboarding, and verify ports 8331–8336. The optional monitor uses port 8330. Keep these ports behind a firewall, LAN, or VPN.

### Configure endpoints manually

Configure only the services you need. Every provider has independent URL, model, API-key, enable, capability, and connection-test controls. Compatible local services and cloud APIs can be mixed.

Reopen onboarding from **Settings → General → Deployment**. Existing configurations are clearly identified, and a reference preset remains staged until **Apply and continue** is pressed. Changing deployment endpoints does not remove jobs, chats, workflows, or files.

### GitHub-source installation

The hosted installer is only a convenience. The equivalent auditable source path is:

```bash
git clone https://github.com/stevibe/SparklingKit.git
cd SparklingKit
./distribution/install.sh --from-source --dir ../sparklingkit-install
```

Developers can continue to use `docker compose up -d --build` from the repository root.

## Upgrade and operate

Run these commands inside the installation directory:

```bash
./sparklingkit update     # verify release assets, pull, recreate, and health-check
./sparklingkit status
./sparklingkit logs
./sparklingkit stop       # never removes ./data
./sparklingkit rollback   # restore the app image used before the last update
```

The default `latest` image follows stable releases. Set `SPARKLINGKIT_IMAGE=ghcr.io/stevibe/sparklingkit:0.2.0` in `.env` to pin an installation. The update command records the previous local image before recreating the application, while the bind-mounted data remains untouched.

See [Application deployment and upgrades](docs/deployment.md) for network binding, pinned releases, rollback limits, backups, and release artifacts.

Set `HF_TOKEN` in the shell when the DGX model download requires authentication or additional download capacity:

```bash
HF_TOKEN=hf_... ./scripts/start-dgx-spark.sh --accept-model-licenses
```

Model weights are downloaded from their publishers and are not part of SparklingKit's Apache 2.0 distribution. Review their terms before setup. In particular, the current `nvidia/LocateAnything-3B` license restricts it to non-commercial and research use. The acceptance flag records that you completed this review; it does not alter or override upstream terms.

The DGX starter enables the status reporter, which surfaces unified-memory use, CUDA allocations, GPU utilization and temperature, plus model-service health in the sidebar. See the [DGX Spark deployment guide](docs/dgx-spark.md) for hosted and source installation, prerequisites, network layout, storage locations, operational commands, and model-license notes.

## Modules

| Module | Typical input | Output |
| --- | --- | --- |
| OCR | Images, scanned PDFs | Markdown documents and structured page data |
| Transcription | Audio and video | Markdown transcripts, JSON segments, SRT, and VTT |
| Translation | Pasted text, documents, transcripts | Translated text or document artifacts |
| Grounding | Images and text queries | Framed image preview and normalized box annotations |
| Text to image | Prompt or compatible text result | Generated image |
| Chat | Text, documents, structured data, and optionally images | Referenced conversation |

Each module has its own history rail, source preview, and detail view. Jobs, chats, source files, and generated files can be renamed or deleted. Compatible outputs expose actions such as translating a transcript, grounding a generated image, creating an image from text, or opening a result in chat.

## Workbench

The Workbench collects common actions into a lightweight grid:

- format-aware file intake for OCR, transcription, and document translation;
- debounced live text translation with an explicit **Save** action;
- text-to-image generation with common canvas sizes;
- a chat starter;
- a shortcut to image grounding;
- enabled reusable workflows;
- searchable recent work.

Global search covers work, conversations, tools, and generated artifacts. Service health and the optional machine-status monitor remain visible from the collapsible sidebar.

## File-based workflows

The visual workflow editor composes the same modules used everywhere else in SparklingKit. Definitions are versioned JSON files stored under `data/config/workflows/`; each run stores an immutable definition snapshot with the job.

Service nodes:

- OCR
- Transcription
- Translation
- Grounding
- Text to image
- LLM prompt
- Create chat

Generic nodes:

- **Input** declares accepted artifact types.
- **Select** narrows results by artifact kind.
- **If** and **Switch** route artifacts through declarative conditions.
- **Merge** rejoins active branches.
- **Save to file** stores incoming content or explicitly defined text.
- **End** collects a successful result.
- **Fail** ends a path with a readable error.

Connections are allowed only when a producer and consumer share compatible artifact types. Workflow JSON cannot execute arbitrary JavaScript or shell commands.

Service nodes store their output by default. Turn off **Store the result** for an intermediate value that should exist only during execution; downstream nodes can still consume it, and SparklingKit removes it when the run finishes. Use **Save to file** when a particular intermediate result should become a durable artifact.

During execution the run view highlights the active node and records succeeded, skipped, failed, or cancelled paths. Historical workflow jobs retain this node diagram, selected branches, durations, child service runs, and artifact lineage.

See [Workflow design and JSON contracts](docs/workflows.md) for details.

## Manual source deployment

### Requirements

- Docker Engine with Docker Compose
- One or more compatible local, remote, or cloud inference services

For a source-built Compose deployment, clone and configure the project:

```bash
git clone https://github.com/stevibe/SparklingKit.git
cd SparklingKit
cp .env.example .env
```

Either leave endpoint URLs empty to use browser onboarding or edit `.env` with services already available on your network, then start the application:

```bash
docker compose up -d --build
```

Open [http://localhost:54321](http://localhost:54321).

Application state is written to `./data`. The release bundle also stores Redis state under `./data/.redis`; the development Compose file uses a named Redis volume. The application image includes `ffmpeg`, `ffprobe`, `pdftotext`, and `pdftoppm` and supports `linux/amd64` and `linux/arm64`.

Environment variables bootstrap a new `settings.json`; saved settings take precedence on later starts so upgrades do not replace a user's endpoints. After first launch, manage providers from **Settings → Services** or reopen **Settings → General → Deployment**. If you are deploying the complete reference stack directly on a DGX Spark, use `scripts/start-dgx-spark.sh` instead.

## Service configuration

Every provider can be enabled, edited, and tested independently. The same six-model DGX Spark reference deployment is exposed on adjacent ports so a fresh SparklingKit instance is straightforward to connect:

| Port | Capability | Reference model/backend |
| ---: | --- | --- |
| 8330 | Optional system status | Lightweight Python API |
| 8331 | Multimodal LLM | Qwen3.6-35B-A3B NVFP4 / vLLM |
| 8332 | OCR | Unlimited-OCR |
| 8333 | Speech recognition | Qwen3-ASR-1.7B |
| 8334 | Translation | Hy-MT2-1.8B-FP8 |
| 8335 | Grounding | LocateAnything-3B |
| 8336 | Image generation | Z-Image-Turbo / Diffusers |

The system-status service is optional. Leave its URL empty to hide the GPU/memory block without affecting service health indicators.

LLM settings declare text and image input capabilities. SparklingKit uses those flags when deciding whether images can be attached to Chat or connected to LLM workflow nodes.

Advanced settings expose machine-dependent processing controls, including transcription chunk size and overlap, adaptive splitting, request timeouts, PDF rasterization, queue concurrency, retries, and work-directory retention. Display timezone is selected separately under **Settings → General**.

### Optional DGX Spark status reporter

The repository includes a small read-only status service for NVIDIA DGX Spark deployments. The full DGX starter enables it automatically; to add it to an otherwise manual deployment, run:

```bash
docker compose -f compose.spark.yaml up -d --build dgx-status
```

Point **Settings → Services → System monitor** to its base URL. SparklingKit runs normally without it.

## Local development

### Requirements

- Node.js 22 or newer
- Redis
- ffmpeg and ffprobe
- Poppler (`pdftotext` and `pdftoppm`)

```bash
cp .env.example .env
npm install
npm run dev
```

The API runs at `http://localhost:54321`. Vite runs at `http://localhost:5173` and proxies `/api` to the API.

Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

## Architecture

SparklingKit is a TypeScript modular monolith:

```text
React client
    │
    ▼
Express API ───────────► configurable inference services
    │
    ├── BullMQ / Redis       execution coordination
    │
    └── data/                durable source of truth
          ├── settings and workflow definitions
          ├── jobs, artifacts, and flow snapshots
          └── chats and references
```

Core ideas:

- A **module** is a user-facing capability.
- A **provider** is the configured model endpoint behind that capability.
- A **job** is a portable container for sources, artifacts, and runs.
- An **artifact** is a typed file with stable identity and lineage.
- A **workflow run** is a durable invocation with independent progress, cancellation, outputs, and errors.

Redis may be restarted or rebuilt without replacing the file-based record. Job manifests use atomic write-and-rename updates, and API keys are stored separately in `data/config/secrets.json` with restrictive file permissions.

Read [Architecture](docs/architecture.md) and the [modular-monolith ADR](docs/adr/0001-modular-monolith.md) before adding a module or changing storage contracts.

## Data layout

```text
data/
├── config/
│   ├── settings.json
│   ├── secrets.json
│   ├── prompts/*.json
│   └── workflows/*.json
├── jobs/<job-id>/
│   ├── job.json
│   ├── flows/*.json
│   ├── input/
│   ├── work/
│   └── output/
├── chats/<chat-id>/chat.json
└── logs/
```

Back up the entire `data/` directory to preserve configuration, work history, source files, chats, and generated results. Redis is operational state, not the permanent record.

## API overview

| Area | Endpoints |
| --- | --- |
| Health and configuration | `GET /api/health`, `GET/PUT /api/settings`, `GET /api/modules` |
| Search | `GET /api/search` |
| Jobs | `GET/POST /api/jobs`, job/file rename and delete routes, cancellation, SSE progress |
| Artifacts and runs | `GET /api/jobs/:id/artifacts`, `GET/POST /api/jobs/:id/runs` |
| Translation | preview, pasted-text, and uploaded-document routes under `/api/modules/translation` |
| Grounding | `POST /api/modules/grounding/jobs` |
| Image generation | `POST /api/modules/text-to-image/jobs` |
| Chat | chat CRUD and streaming messages under `/api/chats` |
| Workflows | definition CRUD/validation and durable flow runs under `/api/workflows` |

See the server routes and [architecture documentation](docs/architecture.md) for request contracts.

## Security and privacy

SparklingKit currently assumes a trusted user and trusted network. It does not provide built-in authentication or multi-tenant isolation. Do not expose it directly to the public internet; place it behind an authenticated reverse proxy, VPN, or equivalent access control.

Uploaded content is sent to the inference endpoints you configure. A self-hosted SparklingKit deployment is only as private as those services and the surrounding network. Review endpoint ownership, logs, retention, and transport security before processing sensitive material.

Grounding overlays are previews, not secure redaction. A visible rectangle over an image or selectable PDF text does not remove the underlying information.

## Contributing

Issues and pull requests are welcome. Before opening a pull request:

1. Keep module compatibility rules in the shared capability router rather than duplicating them in UI code.
2. Preserve the file-based storage model and artifact lineage.
3. Add or update tests for behavioral changes.
4. Run `npm run typecheck`, `npm test`, and `npm run build`.
5. Avoid committing `.env`, `data/`, model credentials, or user files.

The project is currently pre-1.0, so APIs and persisted schemas may still evolve. Migrations should remain additive and must not silently rewrite user folders.

## License

SparklingKit is licensed under the [Apache License 2.0](LICENSE).

Third-party packages and model services remain subject to their respective license terms.

Copyright 2026 Steven Lei.
