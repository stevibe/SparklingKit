import base64
import os
from functools import lru_cache
from io import BytesIO
from typing import Literal

import requests
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from pydantic import BaseModel, Field

from worker import LocateAnythingWorker


TaskName = Literal["detect", "ground_single", "ground_multi", "ground_text", "detect_text", "ground_gui", "point", "custom"]


class PredictRequest(BaseModel):
    image: str
    task: TaskName = "custom"
    question: str | None = None
    categories: list[str] = Field(default_factory=list)
    phrase: str | None = None
    output_type: Literal["box", "point"] = "box"
    generation_mode: Literal["fast", "slow", "hybrid"] | None = None
    max_new_tokens: int | None = None
    temperature: float = 0.7
    top_p: float = 0.9
    top_k: int = 0
    repetition_penalty: float = 1.1
    verbose: bool = False


app = FastAPI(title="LocateAnything-3B", version="1.0")


def env_true(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() in {"1", "true", "yes"}


@lru_cache(maxsize=1)
def get_worker() -> LocateAnythingWorker:
    return LocateAnythingWorker(
        model_path=os.getenv("MODEL_PATH", "/models/nvidia/LocateAnything-3B"),
        device=os.getenv("DEVICE", "cuda"),
        dtype=torch.bfloat16,
        use_batch_runtime=env_true("USE_BATCH_RUNTIME", "true"),
        attn=os.getenv("LA_ATTN", "la_flash"),
        vision_attn=os.getenv("LA_VISION_ATTN", "flash_attention_2"),
        scheduler=os.getenv("LA_SCHEDULER", "pipeline"),
    )


def load_image(reference: str) -> Image.Image:
    if reference.startswith("data:image"):
        try:
            _, encoded = reference.split("base64,", 1)
            return Image.open(BytesIO(base64.b64decode(encoded))).convert("RGB")
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid data URL image") from exc
    if reference.startswith(("http://", "https://")):
        response = requests.get(reference, timeout=30)
        response.raise_for_status()
        return Image.open(BytesIO(response.content)).convert("RGB")
    path = reference[7:] if reference.startswith("file://") else reference
    if not os.path.exists(path):
        raise HTTPException(status_code=400, detail=f"image path does not exist: {path}")
    return Image.open(path).convert("RGB")


def run_task(image: Image.Image, request: PredictRequest) -> dict:
    worker = get_worker()
    kwargs = {
        "generation_mode": request.generation_mode or os.getenv("GENERATION_MODE", "hybrid"),
        "max_new_tokens": request.max_new_tokens or int(os.getenv("MAX_NEW_TOKENS", "2048")),
        "temperature": request.temperature,
        "top_p": request.top_p,
        "top_k": request.top_k,
        "repetition_penalty": request.repetition_penalty,
        "verbose": request.verbose,
    }
    if request.task == "detect":
        if not request.categories:
            raise HTTPException(status_code=400, detail="categories is required")
        result = worker.detect(image, request.categories, **kwargs)
    elif request.task == "detect_text":
        result = worker.detect_text(image, **kwargs)
    elif request.task in {"ground_single", "ground_multi", "ground_text", "ground_gui", "point"}:
        if not request.phrase:
            raise HTTPException(status_code=400, detail="phrase is required")
        if request.task == "ground_single":
            result = worker.ground_single(image, request.phrase, **kwargs)
        elif request.task == "ground_multi":
            result = worker.ground_multi(image, request.phrase, **kwargs)
        elif request.task == "ground_text":
            result = worker.ground_text(image, request.phrase, **kwargs)
        elif request.task == "ground_gui":
            result = worker.ground_gui(image, request.phrase, request.output_type, **kwargs)
        else:
            result = worker.point(image, request.phrase, **kwargs)
    else:
        if not request.question:
            raise HTTPException(status_code=400, detail="question is required")
        result = worker.predict(image, request.question, **kwargs)
    width, height = image.size
    answer = result.get("answer", "")
    result.update({"image_width": width, "image_height": height, "boxes": worker.parse_boxes(answer, width, height), "points": worker.parse_points(answer, width, height)})
    return result


@app.on_event("startup")
def startup() -> None:
    get_worker()


@app.get("/health")
def health() -> dict:
    if get_worker.cache_info().currsize == 0:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "ok": True,
        "model": os.getenv("MODEL_NAME", "nvidia/LocateAnything-3B"),
        "batch_runtime": env_true("USE_BATCH_RUNTIME", "true"),
        "attention": os.getenv("LA_ATTN", "la_flash"),
        "cuda_allocated_bytes": torch.cuda.memory_allocated() if torch.cuda.is_available() else 0,
    }


@app.get("/v1/models")
def models() -> dict:
    name = os.getenv("MODEL_NAME", "nvidia/LocateAnything-3B")
    return {"object": "list", "data": [{"id": name, "object": "model", "owned_by": "nvidia"}]}


@app.post("/predict")
def predict(request: PredictRequest) -> dict:
    return run_task(load_image(request.image), request)


@app.post("/predict-upload")
async def predict_upload(
    image: UploadFile = File(...),
    task: TaskName = Form("custom"),
    question: str | None = Form(None),
    categories: str | None = Form(None),
    phrase: str | None = Form(None),
    output_type: Literal["box", "point"] = Form("box"),
) -> dict:
    pil_image = Image.open(BytesIO(await image.read())).convert("RGB")
    request = PredictRequest(
        image="upload",
        task=task,
        question=question,
        categories=[x.strip() for x in (categories or "").split(",") if x.strip()],
        phrase=phrase,
        output_type=output_type,
    )
    return run_task(pil_image, request)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8335")), log_level="info")
