from __future__ import annotations

import csv
import json
import os
import platform
import re
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PORT = int(os.getenv("PORT", "8330"))
PROC_ROOT = Path(os.getenv("PROC_ROOT", "/proc"))
MIB = 1024 * 1024

SERVICE_SPECS = (
    ("llm", "LLM", int(os.getenv("LLM_PORT", "8331"))),
    ("ocr", "OCR", int(os.getenv("OCR_PORT", "8332"))),
    ("asr", "ASR", int(os.getenv("ASR_PORT", "8333"))),
    ("translation", "Translation", int(os.getenv("TRANSLATION_PORT", "8334"))),
    ("grounding", "Grounding", int(os.getenv("GROUNDING_PORT", "8335"))),
    ("image-generation", "Image generation", int(os.getenv("IMAGE_GENERATION_PORT", "8336"))),
)
SERVICE_BY_PORT = {port: {"id": service_id, "label": label} for service_id, label, port in SERVICE_SPECS}
PROCESS_SIGNATURES = {
    "hy_server.py": ("translation", "Translation", int(os.getenv("TRANSLATION_PORT", "8334")), "Hy-MT2-1.8B-FP8"),
    "locate_server.py": ("grounding", "Grounding", int(os.getenv("GROUNDING_PORT", "8335")), "nvidia/LocateAnything-3B"),
    "/app/server.py": ("image-generation", "Image generation", int(os.getenv("IMAGE_GENERATION_PORT", "8336")), "Z-Image-Turbo"),
}


def optional_number(value: str, cast: type[int] | type[float] = float) -> int | float | None:
    cleaned = value.strip()
    if not cleaned or cleaned.upper() in {"N/A", "[N/A]", "NOT SUPPORTED"}:
        return None
    try:
        return cast(float(cleaned))
    except ValueError:
        return None


def nvidia_smi(fields: str, target: str = "gpu") -> list[list[str]]:
    command = [
        "nvidia-smi",
        f"--query-{target}={fields}",
        "--format=csv,noheader,nounits",
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=5, check=True)
    return [row for row in csv.reader(StringIO(completed.stdout)) if row]


def gpu_status() -> dict[str, Any]:
    fields = "index,name,utilization.gpu,temperature.gpu,power.draw,memory.total,memory.used,memory.free"
    rows = nvidia_smi(fields)
    devices = []
    for row in rows:
        if len(row) < 8:
            continue
        total_mib = optional_number(row[5], int)
        used_mib = optional_number(row[6], int)
        free_mib = optional_number(row[7], int)
        devices.append({
            "index": optional_number(row[0], int),
            "name": row[1].strip(),
            "utilizationPercent": optional_number(row[2], int),
            "temperatureC": optional_number(row[3], int),
            "powerWatts": optional_number(row[4]),
            "memory": {
                "totalBytes": total_mib * MIB if total_mib is not None else None,
                "usedBytes": used_mib * MIB if used_mib is not None else None,
                "freeBytes": free_mib * MIB if free_mib is not None else None,
            },
        })
    processes = gpu_processes()
    return {
        "devices": devices,
        "processes": processes,
        "allocatedProcessMemoryBytes": sum(process["usedMemoryBytes"] or 0 for process in processes),
    }


def read_process_file(pid: int, name: str) -> bytes:
    try:
        return (PROC_ROOT / str(pid) / name).read_bytes()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return b""


def process_parent(pid: int) -> int | None:
    text = read_process_file(pid, "status").decode("utf-8", "replace")
    match = re.search(r"^PPid:\s+(\d+)$", text, re.MULTILINE)
    return int(match.group(1)) if match else None


def process_args(pid: int) -> list[str]:
    return [part.decode("utf-8", "replace") for part in read_process_file(pid, "cmdline").split(b"\0") if part]


def process_safe_environment(pid: int) -> dict[str, str]:
    allowed = {"PORT", "MODEL_NAME", "HY_MODEL_NAME", "LOCATE_MODEL_REPO", "MODEL_REPO"}
    result: dict[str, str] = {}
    for item in read_process_file(pid, "environ").split(b"\0"):
        if b"=" not in item:
            continue
        raw_key, raw_value = item.split(b"=", 1)
        key = raw_key.decode("utf-8", "replace")
        if key in allowed:
            result[key] = raw_value.decode("utf-8", "replace")
    return result


def flag_value(args: list[str], flag: str) -> str | None:
    for index, value in enumerate(args):
        if value == flag and index + 1 < len(args):
            return args[index + 1]
        if value.startswith(f"{flag}="):
            return value.split("=", 1)[1]
    return None


def resolve_process_service(pid: int) -> dict[str, Any]:
    current = pid
    visited: set[int] = set()
    for _ in range(12):
        if current in visited or current <= 1:
            break
        visited.add(current)
        args = process_args(current)
        joined_args = " ".join(args)
        for signature, (service_id, label, service_port, service_model) in PROCESS_SIGNATURES.items():
            if signature in joined_args:
                return {"service": service_id, "serviceLabel": label, "port": service_port, "model": service_model}
        environment = process_safe_environment(current)
        raw_port = flag_value(args, "--port") or environment.get("PORT")
        try:
            port = int(raw_port) if raw_port else None
        except ValueError:
            port = None
        if port in SERVICE_BY_PORT:
            spec = SERVICE_BY_PORT[port]
            model = (
                flag_value(args, "--served-model-name")
                or environment.get("MODEL_NAME")
                or environment.get("HY_MODEL_NAME")
                or environment.get("LOCATE_MODEL_REPO")
                or environment.get("MODEL_REPO")
            )
            return {"service": spec["id"], "serviceLabel": spec["label"], "port": port, "model": model}
        parent = process_parent(current)
        if not parent or parent == current:
            break
        current = parent
    return {"service": None, "serviceLabel": None, "port": None, "model": None}


def gpu_processes() -> list[dict[str, Any]]:
    try:
        rows = nvidia_smi("pid,process_name,used_memory", "compute-apps")
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return []
    processes = []
    for row in rows:
        if len(row) < 3:
            continue
        pid = optional_number(row[0], int)
        used_mib = optional_number(row[2], int)
        if pid is None:
            continue
        processes.append({
            "pid": pid,
            "processName": row[1].strip(),
            "usedMemoryBytes": used_mib * MIB if used_mib is not None else None,
            **resolve_process_service(pid),
        })
    return processes


def parse_meminfo(text: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        match = re.search(r"(\d+)", raw)
        if match:
            values[key] = int(match.group(1)) * 1024
    return values


def host_status() -> dict[str, Any]:
    values = parse_meminfo((PROC_ROOT / "meminfo").read_text())
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    swap_total = values.get("SwapTotal", 0)
    swap_free = values.get("SwapFree", 0)
    uptime_text = (PROC_ROOT / "uptime").read_text().split()[0]
    load = (PROC_ROOT / "loadavg").read_text().split()[:3]
    return {
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "uptimeSeconds": float(uptime_text),
        "loadAverage": [float(value) for value in load],
        "memory": {
            "totalBytes": total,
            "availableBytes": available,
            "usedBytes": max(0, total - available),
            "usedPercent": round((total - available) * 100 / total, 1) if total else 0,
        },
        "swap": {
            "totalBytes": swap_total,
            "freeBytes": swap_free,
            "usedBytes": max(0, swap_total - swap_free),
            "usedPercent": round((swap_total - swap_free) * 100 / swap_total, 1) if swap_total else 0,
        },
    }


def check_service(spec: tuple[str, str, int]) -> dict[str, Any]:
    service_id, label, port = spec
    started = time.perf_counter()
    endpoint = f"http://127.0.0.1:{port}/v1/models"
    try:
        request = Request(endpoint, headers={"Accept": "application/json"})
        with urlopen(request, timeout=3) as response:
            payload = json.loads(response.read())
        models = [item.get("id") for item in payload.get("data", []) if item.get("id")]
        return {
            "id": service_id,
            "label": label,
            "port": port,
            "baseUrl": f"http://127.0.0.1:{port}",
            "ok": True,
            "latencyMs": round((time.perf_counter() - started) * 1000),
            "models": models,
        }
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        return {
            "id": service_id,
            "label": label,
            "port": port,
            "baseUrl": f"http://127.0.0.1:{port}",
            "ok": False,
            "latencyMs": round((time.perf_counter() - started) * 1000),
            "models": [],
            "error": str(error),
        }


def status_payload() -> dict[str, Any]:
    with ThreadPoolExecutor(max_workers=len(SERVICE_SPECS)) as executor:
        services = list(executor.map(check_service, SERVICE_SPECS))
    gpu_error = None
    try:
        gpu = gpu_status()
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        gpu = {"devices": [], "processes": [], "allocatedProcessMemoryBytes": 0}
        gpu_error = str(error)
    return {
        "ok": all(service["ok"] for service in services) and bool(gpu["devices"]),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": host_status(),
        "gpu": gpu,
        "gpuError": gpu_error,
        "services": services,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "SparklingKitDGXStatus/1.0"

    def log_message(self, message: str, *args: Any) -> None:
        print(f"[http] {self.address_string()} {message % args}", flush=True)

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            self.send_json({"ok": True})
            return
        if self.path.rstrip("/") in {"/status", "/v1/status"}:
            try:
                self.send_json(status_payload())
            except Exception as error:
                self.send_json({"ok": False, "error": str(error)}, 500)
            return
        self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"DGX Spark status reporter listening on {PORT}", flush=True)
    server.serve_forever()
