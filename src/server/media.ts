import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function abortError() {
  const error = new Error("Job stopped");
  error.name = "AbortError";
  return error;
}

export function runCommand(command: string, args: string[], timeoutMs = 20 * 60_000, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(abortError()));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`${command} timed out`)));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-1200)}`));
      });
    });
  });
}

export async function normalizeAudio(input: string, output: string, sampleRate: number, signal?: AbortSignal) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le", output], undefined, signal);
}

export async function audioDuration(file: string, signal?: AbortSignal) {
  const { stdout } = await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], undefined, signal);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration)) throw new Error("Could not determine audio duration");
  return duration;
}

export async function splitAudio(file: string, folder: string, targetSec: number, overlapSec: number, signal?: AbortSignal) {
  const duration = await audioDuration(file, signal);
  await fs.mkdir(folder, { recursive: true });
  if (duration <= targetSec + 5) return [{ file, start: 0, end: duration }];
  const silenceEnds = await findSilenceEnds(file, signal).catch((error) => {
    if (signal?.aborted) throw error;
    return [];
  });
  const chunks: Array<{ file: string; start: number; end: number }> = [];
  let cursor = 0;
  let index = 0;
  while (cursor < duration) {
    const idealEnd = Math.min(cursor + targetSec, duration);
    const candidates = silenceEnds.filter((point) => point >= cursor + targetSec * 0.65 && point <= cursor + targetSec * 1.25);
    const end = idealEnd === duration || !candidates.length
      ? idealEnd
      : candidates.reduce((closest, point) => Math.abs(point - idealEnd) < Math.abs(closest - idealEnd) ? point : closest);
    const start = Math.max(0, cursor - (index ? overlapSec : 0));
    const length = end - start;
    const chunk = path.join(folder, `chunk-${String(index + 1).padStart(4, "0")}.wav`);
    await runCommand("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", file, "-t", String(length), "-c:a", "pcm_s16le", chunk,
    ], undefined, signal);
    chunks.push({ file: chunk, start, end });
    cursor = end;
    index += 1;
  }
  return chunks;
}

export async function extractAudio(input: string, output: string, startSec: number, durationSec: number, signal?: AbortSignal) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.max(0, startSec)), "-i", input,
    "-t", String(Math.max(0.1, durationSec)), "-c:a", "pcm_s16le", output,
  ], undefined, signal);
}

async function findSilenceEnds(file: string, signal?: AbortSignal) {
  const { stderr } = await runCommand("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=n=-35dB:d=0.35", "-f", "null", "-",
  ], undefined, signal);
  return [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
}

export async function rasterizePdf(file: string, folder: string, dpi: number, signal?: AbortSignal) {
  await fs.mkdir(folder, { recursive: true });
  const prefix = path.join(folder, "page");
  await runCommand("pdftoppm", ["-png", "-r", String(dpi), file, prefix], 60 * 60_000, signal);
  return (await fs.readdir(folder))
    .filter((name) => name.startsWith("page-") && name.endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(folder, name));
}

export function srtTimestamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function vttTimestamp(seconds: number) {
  return srtTimestamp(seconds).replace(",", ".");
}
