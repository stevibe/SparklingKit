import os
import threading
import time
import uuid
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer


MODEL_PATH = os.getenv("MODEL_PATH", "/models/tencent/Hy-MT2-1.8B-FP8")
MODEL_NAME = os.getenv("MODEL_NAME", "Hy-MT2-1.8B-FP8")
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "4096"))

app = FastAPI(title="Hy-MT2-1.8B-FP8", version="1.0")
generation_lock = threading.Lock()
tokenizer = None
model = None


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[dict[str, Any]]
    temperature: float = 0.7
    top_p: float = 0.6
    top_k: int = 20
    repetition_penalty: float = 1.05
    max_tokens: int = Field(default=4096, ge=1)
    stream: bool = False


class TranslateRequest(BaseModel):
    text: str
    target_language: str
    source_language: str | None = None
    temperature: float = 0.7
    top_p: float = 0.6
    top_k: int = 20
    repetition_penalty: float = 1.05
    max_tokens: int = Field(default=4096, ge=1)


def load_model() -> None:
    global tokenizer, model
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_PATH,
        dtype=torch.bfloat16,
        device_map="auto",
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    ).eval()


def normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    normalized = []
    for message in messages:
        content = message.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                str(item.get("text", ""))
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            )
        normalized.append({"role": str(message.get("role", "user")), "content": str(content)})
    return normalized


def generate(messages: list[dict[str, Any]], request: Any) -> tuple[str, int, int]:
    assert tokenizer is not None and model is not None
    encoded = tokenizer.apply_chat_template(
        normalize_messages(messages),
        add_generation_prompt=True,
        return_tensors="pt",
        return_dict=True,
    ).to(model.device)
    input_ids = encoded["input_ids"]
    attention_mask = encoded.get("attention_mask")
    prompt_tokens = input_ids.shape[-1]
    max_tokens = min(int(request.max_tokens), MAX_NEW_TOKENS)
    with generation_lock, torch.inference_mode():
        output_ids = model.generate(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_new_tokens=max_tokens,
            temperature=float(request.temperature),
            top_p=float(request.top_p),
            top_k=int(request.top_k),
            repetition_penalty=float(request.repetition_penalty),
            do_sample=float(request.temperature) > 0,
            use_cache=True,
        )
    completion_ids = output_ids[0, prompt_tokens:]
    text = tokenizer.decode(completion_ids, skip_special_tokens=True).strip()
    return text, prompt_tokens, int(completion_ids.shape[-1])


@app.on_event("startup")
def startup() -> None:
    load_model()


@app.get("/health")
def health() -> dict[str, Any]:
    if model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "ok": True,
        "model": MODEL_NAME,
        "cuda_allocated_bytes": torch.cuda.memory_allocated() if torch.cuda.is_available() else 0,
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "tencent"}]}


@app.post("/v1/chat/completions")
def chat(request: ChatRequest) -> dict[str, Any]:
    if request.stream:
        raise HTTPException(status_code=400, detail="streaming is not supported by this service")
    started = time.perf_counter()
    text, prompt_tokens, completion_tokens = generate(request.messages, request)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_NAME,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "elapsed_seconds": round(time.perf_counter() - started, 4),
    }


@app.post("/translate")
def translate(request: TranslateRequest) -> dict[str, Any]:
    source = f" from {request.source_language}" if request.source_language else ""
    prompt = (
        f"Translate the following text{source} into {request.target_language}. "
        "Only output the translated result without any additional explanation:\n\n"
        f"{request.text}"
    )
    started = time.perf_counter()
    text, prompt_tokens, completion_tokens = generate([{"role": "user", "content": prompt}], request)
    return {
        "model": MODEL_NAME,
        "translation": text,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "elapsed_seconds": round(time.perf_counter() - started, 4),
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8334")), log_level="info")
