import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const TTS_REQUEST_TIMEOUT_MS = 60_000;
const ORPHEUS_MAX_INPUT_CHARS = 190;

export interface TtsResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export function isTtsConfigured(): boolean {
  return Boolean(config.tts.apiUrl && config.tts.apiKey);
}

function isOrpheusModel(): boolean {
  return config.tts.model.includes("orpheus");
}

function chunkText(text: string, maxLen: number): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    let piece = sentence;
    while (piece.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(piece.slice(0, maxLen));
      piece = piece.slice(maxLen);
    }
    if (`${current} ${piece}`.trim().length > maxLen) {
      if (current) chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
}

async function requestSpeech(input: string, responseFormat: string): Promise<Buffer> {
  const url = `${config.tts.apiUrl}/audio/speech`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.tts.model,
        voice: config.tts.voice,
        input,
        response_format: responseFormat,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `TTS API returned HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("TTS API returned an empty audio response");
    }
    return buffer;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`TTS request timed out after ${TTS_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function concatAndConvertToMp3(wavBuffers: Buffer[]): Buffer {
  const workDir = mkdtempSync(join(tmpdir(), "tts-"));
  try {
    const listPath = join(workDir, "list.txt");
    const lines = wavBuffers.map((buffer, index) => {
      const chunkPath = join(workDir, `chunk-${String(index).padStart(3, "0")}.wav`);
      writeFileSync(chunkPath, buffer);
      return `file '${chunkPath}'`;
    });
    writeFileSync(listPath, `${lines.join("\n")}\n`);

    const wavPath = join(workDir, "combined.wav");
    const concat = spawnSync(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", wavPath],
      { encoding: "utf8" },
    );
    if (concat.status !== 0) {
      throw new Error(`ffmpeg concat failed: ${concat.stderr?.slice(-300) ?? "unknown error"}`);
    }

    const mp3Path = join(workDir, "output.mp3");
    const convert = spawnSync(
      "ffmpeg",
      ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3Path],
      { encoding: "utf8" },
    );
    if (convert.status !== 0) {
      throw new Error(`ffmpeg mp3 conversion failed: ${convert.stderr?.slice(-300) ?? "unknown error"}`);
    }

    return readFileSync(mp3Path);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function synthesizeOrpheus(input: string): Promise<TtsResult> {
  const chunks = chunkText(input, ORPHEUS_MAX_INPUT_CHARS);

  logger.debug(
    `[TTS] Orpheus synthesis: chunks=${chunks.length}, chars=${input.length}, voice=${config.tts.voice}`,
  );

  const wavBuffers: Buffer[] = [];
  for (const chunk of chunks) {
    wavBuffers.push(await requestSpeech(chunk, "wav"));
  }

  if (wavBuffers.length === 1) {
    return {
      buffer: wavBuffers[0],
      filename: "assistant-reply.wav",
      mimeType: "audio/wav",
    };
  }

  return {
    buffer: concatAndConvertToMp3(wavBuffers),
    filename: "assistant-reply.mp3",
    mimeType: "audio/mpeg",
  };
}

export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  if (!isTtsConfigured()) {
    throw new Error("TTS is not configured: set TTS API credentials");
  }

  const input = text.trim();
  if (!input) {
    throw new Error("TTS input text is empty");
  }

  if (isOrpheusModel()) {
    return synthesizeOrpheus(input);
  }

  logger.debug(
    `[TTS] Sending speech synthesis request: model=${config.tts.model}, voice=${config.tts.voice}, chars=${input.length}`,
  );

  const buffer = await requestSpeech(input, "mp3");
  logger.debug(`[TTS] Generated speech audio: ${buffer.length} bytes`);

  return {
    buffer,
    filename: "assistant-reply.mp3",
    mimeType: "audio/mpeg",
  };
}
