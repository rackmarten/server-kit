import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Evenly spaced timestamps across the middle of a video, skipping a margin at each end -- title
// cards, black fades, and intro/outro logos tend to sit right at the boundaries and aren't
// representative of the rest of the content. The two fractions are independent (not one shared
// symmetric margin) since an intro and an outro aren't generally the same length.
export const evenlySpacedTimestamps = (
  durationSeconds: number,
  count: number,
  skipStartFraction = 0,
  skipEndFraction = 0,
): number[] => {
  if (count <= 1) return [durationSeconds / 2];
  const startMargin = durationSeconds * skipStartFraction;
  const endMargin = durationSeconds * skipEndFraction;
  const usable = Math.max(durationSeconds - startMargin - endMargin, 0);
  return Array.from({ length: count }, (_, i) => startMargin + (usable * (i + 0.5)) / count);
};

const runFfmpeg = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- ffmpeg is resolved from PATH by design
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${String(code)}: ${stderr.slice(-800)}`));
    });
  });

// Sharpness score via ffmpeg's `blurdetect` filter (lower score = sharper, per ffmpeg's own
// docs). CPU-only, no OpenCV/Python dependency -- reuses the ffmpeg binary already required for
// extraction.
const scoreBlur = (framePath: string): Promise<number> =>
  new Promise((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- ffmpeg is resolved from PATH by design
    const proc = spawn("ffmpeg", ["-i", framePath, "-vf", "blurdetect", "-f", "null", "-"]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg blurdetect exited ${String(code)}: ${stderr.slice(-400)}`));
        return;
      }
      const match = /blur:\s*([\d.]+)/.exec(stderr);
      // No match is unexpected (blurdetect always logs one line per frame) but not worth failing
      // the whole batch over -- treat it as maximally blurry so this frame just never gets
      // preferred over one that did score cleanly.
      resolve(match ? Number(match[1]) : 1);
    });
  });

export interface ExtractFramesOptions {
  // Anything ffmpeg's own `-i` accepts: a local file path or a URL (e.g. an HTTP stream endpoint
  // that supports range requests).
  source: string;
  timestampsSeconds: number[];
  // Extra args inserted before `-i` (e.g. `-headers` for an authenticated stream URL).
  extraFfmpegArgs?: string[];
  // Runs ffmpeg's `blurdetect` filter on each extracted frame and attaches the score. Off by
  // default since it roughly doubles the ffmpeg invocations for a batch.
  scoreSharpness?: boolean;
}

export interface ExtractedFrame {
  timestampSeconds: number;
  bytes: Buffer;
  mimeType: "image/jpeg";
  // Lower = sharper. Only present when `scoreSharpness` was requested.
  sharpnessScore?: number;
}

// Extracts one JPEG per given timestamp, ready to upload as a batch of blobs (e.g. to an
// inference gateway's vision endpoint, one request per frame, or composited into a contact sheet by the caller).
// Frees its own temp directory before returning either way.
export const extractFrames = async (options: ExtractFramesOptions): Promise<ExtractedFrame[]> => {
  const {
    source,
    timestampsSeconds,
    extraFfmpegArgs = [],
    scoreSharpness: shouldScoreSharpness = false,
  } = options;
  const dir = await mkdtemp(path.join(tmpdir(), "server-kit-frames-"));
  try {
    const frames: ExtractedFrame[] = [];
    for (const [i, timestamp] of timestampsSeconds.entries()) {
      const outPath = path.join(dir, `frame-${String(i)}.jpg`);
      await runFfmpeg([
        "-y",
        ...extraFfmpegArgs,
        "-ss",
        timestamp.toFixed(2),
        "-i",
        source,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        outPath,
      ]);
      const [bytes, sharpnessScore] = await Promise.all([
        readFile(outPath),
        shouldScoreSharpness ? scoreBlur(outPath) : Promise.resolve(undefined),
      ]);
      frames.push({ timestampSeconds: timestamp, bytes, mimeType: "image/jpeg", sharpnessScore });
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
