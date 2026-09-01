import base64
import os
import secrets
import threading
import time
import uuid
from io import BytesIO
from pathlib import Path
from typing import Literal

import torch
import uvicorn
from diffusers import ZImagePipeline
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


MODEL_PATH = os.getenv("MODEL_PATH", "/models/Tongyi-MAI/Z-Image-Turbo")
MODEL_NAME = os.getenv("MODEL_NAME", "Z-Image-Turbo")
ATTENTION_BACKEND = os.getenv("ATTENTION_BACKEND", "flash")
DEFAULT_STEPS = int(os.getenv("DEFAULT_STEPS", "9"))
MAX_PIXELS = int(os.getenv("MAX_PIXELS", str(2048 * 2048)))
OUTPUT_DIR = Path("/outputs")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Z-Image-Turbo", version="1.0")
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")
generation_lock = threading.Lock()
pipe = None
active_attention_backend = "unloaded"


class ImageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    n: int = Field(default=1, ge=1, le=1)
    size: str = "1024x1024"
    response_format: Literal["url", "b64_json"] = "url"
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    steps: int | None = Field(default=None, ge=2, le=50)
    guidance_scale: float = Field(default=0.0, ge=0.0, le=20.0)


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    steps: int | None = Field(default=None, ge=2, le=50)
    guidance_scale: float = Field(default=0.0, ge=0.0, le=20.0)
    response_format: Literal["url", "b64_json"] = "url"


def validate_dimensions(width: int, height: int) -> None:
    if width % 16 or height % 16:
        raise HTTPException(status_code=400, detail="width and height must be multiples of 16")
    if width * height > MAX_PIXELS:
        raise HTTPException(status_code=400, detail=f"image area exceeds MAX_PIXELS={MAX_PIXELS}")


def parse_size(size: str) -> tuple[int, int]:
    try:
        width_text, height_text = size.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail="size must look like 1024x1024") from exc
    validate_dimensions(width, height)
    return width, height


def load_pipeline() -> None:
    global pipe, active_attention_backend
    pipe = ZImagePipeline.from_pretrained(
        MODEL_PATH,
        dtype=torch.bfloat16,
        device_map="cuda",
        low_cpu_mem_usage=True,
        local_files_only=True,
    )
    pipe.set_progress_bar_config(disable=True)
    pipe.vae.enable_slicing()
    pipe.vae.enable_tiling()
    active_attention_backend = "sdpa"
    if ATTENTION_BACKEND:
        try:
            pipe.transformer.set_attention_backend(ATTENTION_BACKEND)
            active_attention_backend = ATTENTION_BACKEND
        except Exception as exc:
            print(f"attention backend {ATTENTION_BACKEND!r} unavailable; using SDPA: {exc}", flush=True)


def generate_image(
    prompt: str,
    width: int,
    height: int,
    seed: int | None,
    steps: int | None,
    guidance_scale: float,
) -> dict:
    if pipe is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    validate_dimensions(width, height)
    actual_seed = seed if seed is not None else secrets.randbelow(2**31 - 1)
    actual_steps = steps or DEFAULT_STEPS
    generator = torch.Generator(device="cuda").manual_seed(actual_seed)
    started = time.perf_counter()
    with generation_lock, torch.inference_mode():
        image = pipe(
            prompt=prompt,
            height=height,
            width=width,
            num_inference_steps=actual_steps,
            guidance_scale=guidance_scale,
            generator=generator,
        ).images[0]
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
    elapsed = time.perf_counter() - started
    filename = f"z-image-{int(time.time())}-{uuid.uuid4().hex[:10]}.png"
    output_path = OUTPUT_DIR / filename
    image.save(output_path, format="PNG")
    return {
        "filename": filename,
        "path": str(output_path),
        "seed": actual_seed,
        "width": width,
        "height": height,
        "steps": actual_steps,
        "guidance_scale": guidance_scale,
        "elapsed_seconds": round(elapsed, 4),
    }


def encode_png(path: str) -> str:
    with open(path, "rb") as handle:
        return base64.b64encode(handle.read()).decode("ascii")


def response_data(result: dict, response_format: str, base_url: str) -> dict:
    if response_format == "b64_json":
        return {"b64_json": encode_png(result["path"])}
    return {"url": f"{base_url.rstrip('/')}/outputs/{result['filename']}"}


@app.on_event("startup")
def startup() -> None:
    load_pipeline()


@app.get("/health")
def health() -> dict:
    if pipe is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "ok": True,
        "model": MODEL_NAME,
        "dtype": "bfloat16",
        "attention_backend": active_attention_backend,
        "cuda_allocated_bytes": torch.cuda.memory_allocated(),
        "cuda_reserved_bytes": torch.cuda.memory_reserved(),
    }


@app.get("/v1/models")
def models() -> dict:
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "Tongyi-MAI"}]}


@app.post("/generate")
def generate(request: GenerateRequest, http_request: Request) -> dict:
    result = generate_image(
        request.prompt,
        request.width,
        request.height,
        request.seed,
        request.steps,
        request.guidance_scale,
    )
    result["image"] = response_data(result, request.response_format, str(http_request.base_url))
    return {"model": MODEL_NAME, **result}


@app.post("/v1/images/generations")
def openai_images(request: ImageRequest, http_request: Request) -> dict:
    width, height = parse_size(request.size)
    result = generate_image(
        request.prompt,
        width,
        height,
        request.seed,
        request.steps,
        request.guidance_scale,
    )
    return {
        "created": int(time.time()),
        "model": MODEL_NAME,
        "data": [response_data(result, request.response_format, str(http_request.base_url))],
        "seed": result["seed"],
        "size": request.size,
        "steps": result["steps"],
        "elapsed_seconds": result["elapsed_seconds"],
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8336")), log_level="info")
