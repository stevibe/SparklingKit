import { promises as fs } from "node:fs";
import path from "node:path";
import type { EndpointConfig, EndpointHealth } from "./models.js";

function url(baseUrl: string, route: string) {
  return `${baseUrl.replace(/\/$/, "")}/${route.replace(/^\//, "")}`;
}

function headers(endpoint: EndpointConfig, json = true): HeadersInit {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

function requestSignal(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseError(response: Response) {
  const body = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ""}`;
}

export async function checkEndpoint(kind: EndpointHealth["kind"], endpoint: EndpointConfig): Promise<EndpointHealth> {
  const started = performance.now();
  if (endpoint.enabled === false || !endpoint.baseUrl || !endpoint.model) {
    return {
      kind,
      enabled: false,
      ok: false,
      latencyMs: 0,
      model: endpoint.model,
      availableModels: [],
      error: "Not configured",
    };
  }
  try {
    const response = await fetch(url(endpoint.baseUrl, "models"), {
      headers: headers(endpoint, false),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(await responseError(response));
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    return {
      kind,
      enabled: true,
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      model: endpoint.model,
      availableModels: payload.data?.flatMap((item) => (item.id ? [item.id] : [])) || [],
    };
  } catch (error) {
    return {
      kind,
      enabled: true,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      model: endpoint.model,
      availableModels: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function chatCompletion(
  endpoint: EndpointConfig,
  messages: Array<{ role: string; content: unknown }>,
  params: { temperature?: number; maxTokens?: number; extraBody?: Record<string, unknown> } = {},
  signal?: AbortSignal,
) {
  const response = await fetch(url(endpoint.baseUrl, "chat/completions"), {
    method: "POST",
    headers: headers(endpoint),
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      temperature: params.temperature ?? 0.2,
      max_tokens: params.maxTokens ?? 4096,
      stream: false,
      ...params.extraBody,
    }),
    signal: requestSignal(10 * 60_000, signal),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  const message = payload.choices?.[0]?.message;
  const content = message?.content?.trim();
  if (!content) throw new Error("The endpoint returned no content");
  return content;
}

export async function ocrImage(endpoint: EndpointConfig, file: string, pageLabel: string, signal?: AbortSignal) {
  const bytes = await fs.readFile(file);
  const extension = path.extname(file).slice(1).toLowerCase();
  const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : "image/png";
  const output = await chatCompletion(
    endpoint,
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "document parsing.",
          },
          { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
        ],
      },
    ],
    {
      temperature: 0,
      maxTokens: 8192,
      extraBody: { skip_special_tokens: false, images_config: { image_mode: "gundam" } },
    },
    signal,
  );
  return cleanOcrOutput(output, pageLabel);
}

function cleanOcrOutput(value: string, pageLabel: string) {
  const cleaned = value
    .replace(/(?:<\|det\|>)?title\s*\[[^\]]+\](?:<\|\/det\|>)?/gi, "# ")
    .replace(/(?:<\|det\|>)?[a-z_]+\s*\[[^\]]+\](?:<\|\/det\|>)?/gi, "")
    .replace(/<\|[^|]+\|>/g, "")
    .trim();
  if (!cleaned) throw new Error(`The OCR endpoint returned no text for ${pageLabel}`);
  return cleaned;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export async function transcribeAudio(
  endpoint: EndpointConfig,
  file: string,
  offset = 0,
  options: { maxCompletionTokens?: number; timeoutMs?: number } = {},
  signal?: AbortSignal,
) {
  const bytes = await fs.readFile(file);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), path.basename(file));
  form.append("model", endpoint.model);
  // Qwen3-ASR currently supports the OpenAI JSON response but not verbose_json.
  // Chunk boundaries provide subtitle timing when the server omits segments.
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (options.maxCompletionTokens) form.append("max_completion_tokens", String(options.maxCompletionTokens));
  const response = await fetch(url(endpoint.baseUrl, "audio/transcriptions"), {
    method: "POST",
    headers: headers(endpoint, false),
    body: form,
    signal: requestSignal(options.timeoutMs || 20 * 60_000, signal),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const payload = (await response.json()) as {
    text?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };
  const text = cleanAsrText(payload.text || "");
  const segments: TranscriptSegment[] = (payload.segments || [])
    .filter((segment) => segment.text)
    .map((segment) => ({
      start: offset + (segment.start || 0),
      end: offset + (segment.end || segment.start || 0),
      text: segment.text!.trim(),
    }));
  return { text, segments };
}

function cleanAsrText(value: string) {
  return value
    .replace(/^language\s+[^<\r\n]+<asr_text>/i, "")
    .replace(/^<asr_text>/i, "")
    .replace(/<\/asr_text>$/i, "")
    .trim();
}

export async function openChatStream(
  endpoint: EndpointConfig,
  messages: Array<{
    role: string;
    content: string | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;
  }>,
  temperature: number,
  signal?: AbortSignal,
) {
  const response = await fetch(url(endpoint.baseUrl, "chat/completions"), {
    method: "POST",
    headers: headers(endpoint),
    body: JSON.stringify({ model: endpoint.model, messages, temperature, stream: true }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) : AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error("The endpoint returned no response stream");
  return response.body;
}

export interface GeneratedImageResult {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: ".png" | ".jpg" | ".webp";
  revisedPrompt?: string;
}

function imageFormat(bytes: Buffer, advertised?: string | null): Pick<GeneratedImageResult, "mimeType" | "extension"> {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mimeType: "image/jpeg", extension: ".jpg" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mimeType: "image/webp", extension: ".webp" };
  if (advertised?.includes("jpeg") || advertised?.includes("jpg")) return { mimeType: "image/jpeg", extension: ".jpg" };
  if (advertised?.includes("webp")) return { mimeType: "image/webp", extension: ".webp" };
  return { mimeType: "image/png", extension: ".png" };
}

export async function generateImage(
  endpoint: EndpointConfig,
  prompt: string,
  options: { size?: string } = {},
  signal?: AbortSignal,
): Promise<GeneratedImageResult> {
  const response = await fetch(url(endpoint.baseUrl, "images/generations"), {
    method: "POST",
    headers: headers(endpoint),
    body: JSON.stringify({ model: endpoint.model, prompt, n: 1, size: options.size || "1024x1024", response_format: "b64_json" }),
    signal: requestSignal(30 * 60_000, signal),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const payload = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
  const item = payload.data?.[0];
  if (!item) throw new Error("The image endpoint returned no image");
  let bytes: Buffer;
  let advertised: string | null | undefined;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, "base64");
  } else if (item.url?.startsWith("data:")) {
    const match = item.url.match(/^data:([^;,]+)?;base64,(.+)$/s);
    if (!match) throw new Error("The image endpoint returned an invalid data URL");
    advertised = match[1];
    bytes = Buffer.from(match[2], "base64");
  } else if (item.url) {
    const imageResponse = await fetch(new URL(item.url, endpoint.baseUrl), { signal: requestSignal(10 * 60_000, signal) });
    if (!imageResponse.ok) throw new Error(`Could not download the generated image: ${await responseError(imageResponse)}`);
    advertised = imageResponse.headers.get("content-type");
    bytes = Buffer.from(await imageResponse.arrayBuffer());
  } else {
    throw new Error("The image endpoint returned neither image data nor an image URL");
  }
  if (!bytes.length) throw new Error("The image endpoint returned an empty image");
  return { bytes, ...imageFormat(bytes, advertised), revisedPrompt: item.revised_prompt };
}

export interface GroundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GroundingResult {
  answer: string;
  imageWidth: number;
  imageHeight: number;
  boxes: GroundingBox[];
  points: Array<{ x: number; y: number }>;
}

export async function groundImage(
  endpoint: EndpointConfig,
  file: string,
  query: string,
  signal?: AbortSignal,
): Promise<GroundingResult> {
  const bytes = await fs.readFile(file);
  const extension = path.extname(file).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mime }), path.basename(file));
  form.append("task", "ground_text");
  form.append("phrase", query);
  form.append("output_type", "box");
  const serviceRoot = endpoint.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const response = await fetch(`${serviceRoot}/predict-upload`, {
    method: "POST",
    headers: headers(endpoint, false),
    body: form,
    signal: requestSignal(10 * 60_000, signal),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const payload = (await response.json()) as {
    answer?: string;
    image_width?: number;
    image_height?: number;
    boxes?: Array<{ x1?: number; y1?: number; x2?: number; y2?: number }>;
    points?: Array<{ x?: number; y?: number }>;
  };
  const imageWidth = Number(payload.image_width);
  const imageHeight = Number(payload.image_height);
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("The grounding endpoint returned invalid image dimensions");
  }
  const boxes = (payload.boxes || []).flatMap((box) => {
    const values = [box.x1, box.y1, box.x2, box.y2].map(Number);
    if (!values.every(Number.isFinite)) return [];
    const [x1, y1, x2, y2] = values;
    if (x2 <= x1 || y2 <= y1) return [];
    return [{
      x1: Math.max(0, Math.min(imageWidth, x1)),
      y1: Math.max(0, Math.min(imageHeight, y1)),
      x2: Math.max(0, Math.min(imageWidth, x2)),
      y2: Math.max(0, Math.min(imageHeight, y2)),
    }];
  });
  const points = (payload.points || []).flatMap((point) => {
    const x = Number(point.x); const y = Number(point.y);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
  });
  return { answer: payload.answer || "", imageWidth, imageHeight, boxes, points };
}
