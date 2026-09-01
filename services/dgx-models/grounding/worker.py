import os
import re
import sys
from typing import Literal

import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor, AutoTokenizer


class LocateAnythingWorker:
    def __init__(
        self,
        model_path: str,
        device: str = "cuda",
        dtype: torch.dtype = torch.bfloat16,
        use_batch_runtime: bool = True,
        attn: str = "la_flash",
        vision_attn: str = "flash_attention_2",
        scheduler: str = "pipeline",
    ):
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is not available")
        self.device = device
        self.dtype = dtype
        self.use_batch_runtime = use_batch_runtime
        self.scheduler = scheduler

        if use_batch_runtime:
            if model_path not in sys.path:
                sys.path.insert(0, model_path)
            os.environ["LA_FLASH_MODEL"] = model_path
            os.environ["LA_FLASH_ATTN"] = attn
            os.environ["LA_FLASH_VISION_ATTN"] = vision_attn
            os.environ["LA_FLASH_HYBRID_SCHEDULER"] = scheduler
            from batch_utils import generate_batch_hybrid, get_last_hybrid_stats, load

            self._batch_generate = generate_batch_hybrid
            self._batch_stats = get_last_hybrid_stats
            self.tokenizer, self.processor, self.model = load()
            return

        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        self.model = AutoModel.from_pretrained(
            model_path,
            torch_dtype=dtype,
            trust_remote_code=True,
        ).to(device).eval()

    @torch.inference_mode()
    def predict(
        self,
        image: Image.Image,
        question: str,
        generation_mode: Literal["fast", "slow", "hybrid"] = "hybrid",
        max_new_tokens: int = 2048,
        temperature: float = 0.7,
        top_p: float = 0.9,
        top_k: int = 0,
        repetition_penalty: float = 1.1,
        verbose: bool = False,
    ) -> dict:
        if self.use_batch_runtime:
            if generation_mode != "hybrid":
                raise ValueError("The la_flash batch runtime supports generation_mode='hybrid'")
            answers = self._batch_generate(
                [(image.convert("RGB"), question)],
                temperature=temperature,
                top_p=None if top_p < 0 else top_p,
                top_k=None if top_k <= 0 else top_k,
                repetition_penalty=repetition_penalty,
                max_new_tokens=max_new_tokens,
                scheduler=self.scheduler,
                group_size=0,
            )
            result = {"answer": answers[0]}
            if verbose:
                result["stats"] = self._batch_stats()
            return result

        messages = [{"role": "user", "content": [
            {"type": "image", "image": image.convert("RGB")},
            {"type": "text", "text": question},
        ]}]
        text = self.processor.py_apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        images, videos = self.processor.process_vision_info(messages)
        inputs = self.processor(text=[text], images=images, videos=videos, return_tensors="pt").to(self.device)
        response = self.model.generate(
            pixel_values=inputs["pixel_values"].to(self.dtype),
            input_ids=inputs["input_ids"],
            attention_mask=inputs["attention_mask"],
            image_grid_hws=inputs.get("image_grid_hws"),
            tokenizer=self.tokenizer,
            max_new_tokens=max_new_tokens,
            use_cache=True,
            generation_mode=generation_mode,
            temperature=temperature,
            do_sample=temperature > 0,
            top_p=top_p,
            top_k=None if top_k <= 0 else top_k,
            repetition_penalty=repetition_penalty,
            verbose=verbose,
        )
        result = {"answer": response[0] if isinstance(response, tuple) else response}
        if isinstance(response, tuple) and len(response) >= 3:
            result["history"] = response[1]
            result["stats"] = response[2]
        return result

    def detect(self, image: Image.Image, categories: list[str], **kwargs) -> dict:
        return self.predict(image, f"Locate all the instances that matches the following description: {'</c>'.join(categories)}.", **kwargs)

    def ground_single(self, image: Image.Image, phrase: str, **kwargs) -> dict:
        return self.predict(image, f"Locate a single instance that matches the following description: {phrase}.", **kwargs)

    def ground_multi(self, image: Image.Image, phrase: str, **kwargs) -> dict:
        return self.predict(image, f"Locate all the instances that match the following description: {phrase}.", **kwargs)

    def ground_text(self, image: Image.Image, phrase: str, **kwargs) -> dict:
        return self.predict(image, f"Please locate the text referred as {phrase}.", **kwargs)

    def detect_text(self, image: Image.Image, **kwargs) -> dict:
        return self.predict(image, "Detect all the text in box format.", **kwargs)

    def ground_gui(self, image: Image.Image, phrase: str, output_type: str = "box", **kwargs) -> dict:
        prompt = f"Point to: {phrase}." if output_type == "point" else f"Locate the region that matches the following description: {phrase}."
        return self.predict(image, prompt, **kwargs)

    def point(self, image: Image.Image, phrase: str, **kwargs) -> dict:
        return self.predict(image, f"Point to: {phrase}.", **kwargs)

    @staticmethod
    def parse_boxes(answer: str, width: int, height: int) -> list[dict]:
        boxes = []
        for match in re.finditer(r"<box><(\d+)><(\d+)><(\d+)><(\d+)></box>", answer):
            x1, y1, x2, y2 = map(int, match.groups())
            boxes.append({"x1": x1 / 1000 * width, "y1": y1 / 1000 * height, "x2": x2 / 1000 * width, "y2": y2 / 1000 * height})
        return boxes

    @staticmethod
    def parse_points(answer: str, width: int, height: int) -> list[dict]:
        return [{"x": int(m.group(1)) / 1000 * width, "y": int(m.group(2)) / 1000 * height}
                for m in re.finditer(r"<box><(\d+)><(\d+)></box>", answer)]
