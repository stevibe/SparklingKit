export interface ReleaseManifest {
  version: string;
}

export const releaseManifestUrl = "https://run.sparklingkit.com/stable/version.json";

function versionParts(value: string) {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function displayVersion(value?: string) {
  if (!value) return "Checking version";
  const parts = versionParts(value);
  return parts ? `v${parts.join(".")}` : value;
}

export function isNewerVersion(current: string | undefined, candidate: string | undefined) {
  if (!current || !candidate) return false;
  const currentParts = versionParts(current);
  const candidateParts = versionParts(candidate);
  if (!currentParts || !candidateParts) return false;
  for (let index = 0; index < currentParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) return candidateParts[index] > currentParts[index];
  }
  return false;
}

export async function latestRelease(signal?: AbortSignal) {
  const response = await fetch(releaseManifestUrl, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Release manifest returned ${response.status}`);
  const manifest = await response.json() as Partial<ReleaseManifest>;
  if (!manifest.version || !versionParts(manifest.version)) throw new Error("Release manifest has an invalid version");
  return manifest as ReleaseManifest;
}
