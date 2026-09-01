# DGX Spark reference deployment

SparklingKit treats inference and the workspace as two independent deployment layers. The reference stack can co-locate both layers on one NVIDIA DGX Spark with 128 GB of unified memory, or the DGX can serve only the six specialized models while SparklingKit runs on another host.

## Deployment paths

### All in one

Install the prebuilt workspace on the DGX Spark:

```bash
curl -fsSLO https://run.sparklingkit.com/stable/install.sh
less install.sh
bash install.sh
```

Open `http://DGX-IP:54321`, select **Run models locally**, and use the model command shown there. The hosted model path is:

```bash
curl -fsSLO https://run.sparklingkit.com/dgx/stable/install.sh
less install.sh
bash install.sh --accept-model-licenses
```

The source-based combined starter remains available for developers and contributors:

```bash
./scripts/start-dgx-spark.sh --accept-model-licenses
```

The release installation keeps the prebuilt workspace lifecycle independent from the models, making application upgrades much smaller and safer.

### Split across two machines

On the DGX Spark, run the hosted model installer above, or use the inference layer from GitHub source:

```bash
./scripts/start-dgx-models.sh --accept-model-licenses
```

On the server that will own the workspace files, install the prebuilt application:

```bash
curl -fsSLO https://run.sparklingkit.com/stable/install.sh
less install.sh
bash install.sh
```

Open the workspace, select **Run models remotely**, and enter the DGX hostname or trusted-network IP reachable from the application container. SparklingKit configures the seven adjacent reference ports, verifies all six AI services, then stores the endpoint selection in its settings. The model host does not receive the application's job database, chat history, or durable workspace files.

Ports 8330–8336 bind on the DGX host for this mode. Restrict them to the application server or a trusted private network; the reference adapters are not intended to be exposed directly to the public internet.

### SparklingKit with other providers

No DGX stack is required. Install the prebuilt workspace, then choose **Configure manually** during onboarding. Configure compatible local, remote, or cloud endpoints independently.

## What the DGX starter does

Run from the repository root:

```bash
./scripts/start-dgx-spark.sh --accept-model-licenses
```

The script:

1. verifies Linux ARM64, Docker Compose, NVIDIA GPU access, and the CUDA 13 toolchain used by Qwen3-ASR;
2. builds SparklingKit and the thin model API adapters;
3. downloads six pinned model revisions from their publishers into `data/dgx-models/`;
4. starts the model servers one at a time and waits for each health endpoint;
5. starts the read-only system monitor; and
6. for an all-in-one deployment, starts Redis and SparklingKit before reporting the workspace URL.

The first run downloads a substantial amount of model data and builds several ARM64 CUDA images. Later runs reuse both the model files and Docker cache. Set `HF_TOKEN` in the command environment if Hugging Face authentication is required:

```bash
HF_TOKEN=hf_... ./scripts/start-dgx-spark.sh --accept-model-licenses
```

## Reference services

| Port | Service | Model/backend |
| ---: | --- | --- |
| 8330 | System status | Lightweight read-only Python API |
| 8331 | Multimodal LLM | `nvidia/Qwen3.6-35B-A3B-NVFP4` / vLLM 0.24.0 |
| 8332 | OCR | `baidu/Unlimited-OCR` / vLLM |
| 8333 | Speech recognition | `Qwen/Qwen3-ASR-1.7B` / vLLM + Qwen ASR |
| 8334 | Translation | `tencent/Hy-MT2-1.8B-FP8` / Transformers |
| 8335 | Visual grounding | `nvidia/LocateAnything-3B` / NVIDIA `la_flash` runtime |
| 8336 | Image generation | `Tongyi-MAI/Z-Image-Turbo` / Diffusers 0.40.0 |
| 54321 | SparklingKit | Web application and API |

Port 54321 is present only in an all-in-one deployment. The ports and co-residency settings are defined in `compose.dgx.yaml`. The conservative KV-cache budgets, concurrency limits, and sequential startup order are intentional for a 128 GB unified-memory machine.

## Operations

```bash
# Start and reuse existing models and image layers
./scripts/start-dgx-spark.sh

# Inspect containers and all service endpoints
./scripts/start-dgx-spark.sh status

# Stop containers without deleting models, jobs, or Redis data
./scripts/start-dgx-spark.sh stop

# Inspect or stop a models-only deployment
./scripts/start-dgx-models.sh status
./scripts/start-dgx-models.sh stop
```

Advanced options:

```bash
./scripts/start-dgx-spark.sh --skip-download
./scripts/start-dgx-spark.sh --skip-build
```

Persistent files stay beneath `data/`:

- `data/dgx-models/` — pinned publisher model snapshots;
- `data/dgx-runtime/` — model runtime caches;
- `data/dgx-outputs/` — native service outputs; and
- the existing SparklingKit data directories — jobs, chats, workflows, uploads, settings, and generated artifacts.

Docker volumes retain Redis queue state. The stop command does not remove any persistent data.

Application upgrades are managed separately from the model stack. In the directory created by the release installer, run:

```bash
./sparklingkit update
```

The prebuilt image is pulled and recreated while `./data` remains mounted in place. `./sparklingkit rollback` restores the application image recorded immediately before the last update. Neither operation downloads the six model weights again.

## Model terms

SparklingKit and its service adapters are licensed under Apache 2.0. Model weights are separate works and remain governed by the terms published on each model card. Review those terms before downloading or deploying the reference stack.

At the time this reference stack was prepared, `nvidia/LocateAnything-3B` was published for non-commercial and research use. Do not assume SparklingKit's Apache 2.0 license grants commercial rights to that model. Recheck the upstream terms when deploying, because model publishers may update them independently.

## Using different services

The DGX stack is a recommended reference configuration, not a requirement. SparklingKit can connect to other local endpoints, services hosted elsewhere on a trusted network, compatible cloud APIs, or a mixture of these. For those deployments, use `scripts/start-sparklingkit.sh --configure-later` or use `compose.yaml`, copy `.env.example` to `.env`, and configure providers in onboarding or under **Settings → Services**.

Saved settings are intentionally retained across restarts and upgrades. To move an existing installation between all-in-one, split, and custom layouts, open **Settings → General → Deployment**. The guided setup updates endpoints without deleting jobs, chats, workflows, or files.
