# SparklingKit

SparklingKit is a private, file-based AI workbench for OCR, transcription, translation, grounding, text-to-image generation, and chat. It connects to independently configurable inference services and keeps durable state as ordinary files under one data directory.

The included defaults point to the DGX Spark services:

| Workload | Endpoint | Model |
| --- | --- | --- |
| DGX Spark status | `http://192.0.2.10:8330/v1/status` | Host, GPU, processes, and model health |
| Multimodal chat and presets | `http://192.0.2.10:8331/v1` | `qwen36-35b-a3b-nvfp4` |
| OCR | `http://192.0.2.10:8332/v1` | `Unlimited-OCR` |
| Speech to text | `http://192.0.2.10:8333/v1` | `Qwen3-ASR-1.7B` |
| Translation | `http://192.0.2.10:8334/v1` | `Hy-MT2-1.8B-FP8` |
| Grounding | `http://192.0.2.10:8335/v1` | `nvidia/LocateAnything-3B` |
| Image generation | `http://192.0.2.10:8336/v1` | `Z-Image-Turbo` |

Every service can be enabled, configured, and tested independently from **Settings → Model services**. OCR, Transcription, Translation, Grounding, Text to image, and Chat are executable modules.

## Run with Docker

Docker Compose starts the app and a persistent Redis queue:

```bash
docker compose up --build
```

Open [http://localhost:8787](http://localhost:8787). Application files are written to `./data`; Redis queue state is stored in the named `redis-data` volume.

On a DGX Spark, the lightweight status reporter is available through the Spark
Compose overlay:

```bash
docker compose -f compose.spark.yaml up -d --build dgx-status
```

The image is compatible with `linux/amd64` and `linux/arm64`. It includes `ffmpeg`, `ffprobe`, `pdftotext`, and `pdftoppm`.

## Local development

Use Node.js 22 or newer, Redis, ffmpeg, and Poppler:

```bash
cp .env.example .env
npm install
npm run dev
```

The Vite frontend runs at `http://localhost:5173` and proxies `/api` to the API at `http://localhost:8787`.
Choose the timezone used for new job and chat folder names from **Settings → General**. Existing folder names are not rewritten.

The Workbench is a task grid for the most common actions: format-aware file intake, live text translation, text-to-image generation, a chat starter, and a Grounding shortcut. Quick Translation refreshes its ephemeral preview after a short typing pause; **Save** creates a normal durable Translation job. File intake only enables compatible modules: recordings use Transcription, images and PDFs use OCR, and one UTF-8 text, Markdown, or HTML file can go directly to Translation.

Each module workspace includes a flat, full-height history rail at the right edge on desktop. Source files and generated outputs are both selectable and previewable from a job's file explorer.

The **Workflows** workspace provides a typed drag-and-drop graph for connecting services. Definitions are ordinary versioned JSON files. Input, Select, If, Switch, Merge, End, and Fail nodes can be combined with OCR, Transcription, Translation, Grounding, Text to image, LLM Prompt, and Create chat nodes. The same capability router used by module handoffs prevents incompatible connections.

Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

## Data layout

```text
data/
├── config/
│   ├── settings.json
│   ├── secrets.json
│   ├── prompts/*.json
│   └── workflows/*.json
├── jobs/<timestamp_name>/
│   ├── job.json
│   ├── flows/*.json
│   ├── input/
│   ├── work/
│   └── output/
├── chats/<timestamp_chat>/chat.json
└── logs/
```

`job.json` is updated with an atomic write-and-rename. Schema version 2 records typed artifacts, their lineage, and independent workflow runs. API keys are stored separately in `secrets.json` with mode `0600`. Redis coordinates work but is not the database; the data directory remains a complete, portable record.

## API highlights

- `POST /api/jobs` — multipart upload in the `files` field, with `type=audio|image|pdf`
- `POST /api/modules/translation/preview` — produce an ephemeral live-translation preview
- `POST /api/modules/translation/text` — create a durable translation job from pasted text
- `POST /api/modules/translation/files` — translate one UTF-8 text, Markdown, or HTML upload
- `POST /api/modules/text-to-image/jobs` — create a prompt-backed image-generation job
- `POST /api/modules/grounding/jobs` — upload one image and locate up to 12 text queries
- `GET /api/jobs` and `GET /api/jobs/:id`
- `GET /api/modules` — discover capabilities, compatible artifacts, routes, and provider readiness
- `GET/POST /api/workflows` — list or create JSON workflow definitions
- `PUT /api/workflows/:workflowId` and `POST /api/workflows/:workflowId/validate`
- `POST /api/workflows/:workflowId/runs` — start a flow from uploaded files, text, or existing artifacts
- `GET /api/jobs/:id/flows/:flowRunId` — inspect durable per-node state
- `POST /api/jobs/:id/flows/:flowRunId/cancel` and `/retry`
- `GET /api/jobs/:id/artifacts` and `GET /api/jobs/:id/runs`
- `POST /api/jobs/:id/runs` — start a compatible downstream workflow such as Translation
- `POST /api/jobs/:id/runs/:runId/cancel`
- `GET /api/jobs/:id/events` — live SSE progress
- `POST /api/jobs/:id/presets/:slug`
- `GET/PUT /api/settings`
- `GET/PUT /api/prompts/:slug`
- `GET /api/health`
- `POST /api/chats` and `POST /api/chats/:id/messages` — streaming SSE chat

## Notes

- Every PDF page is rasterized and sent through the configured Unlimited-OCR endpoint. SparklingKit never substitutes native text extraction for model OCR.
- Audio/video is normalized to mono PCM WAV and chunked before transcription. Finished jobs emit Markdown, JSON, SRT, and VTT.
- Work continues in BullMQ after a browser closes. The UI reconnects to job progress over SSE.
- Translation consumes an existing text artifact and adds its result to the same work item; source files and prior results are not replaced.
- Translation also supports quick text and direct text-file modes with source/target language selection, swapping, remembered recent languages, and durable job history. Its 38 language choices mirror the official Hy-MT2 catalog.
- Grounding searches one image for multiple text queries and returns a framed SVG preview plus normalized JSON box annotations.
- Text to image calls an OpenAI-compatible `/images/generations` endpoint and accepts base64, data-URL, or downloadable URL responses.
- See [`docs/architecture.md`](docs/architecture.md) for module and provider contracts.
