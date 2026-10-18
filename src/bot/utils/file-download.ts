import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import type { Api } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const TELEGRAM_FILE_URL_BASE = "https://api.telegram.org/file/bot";
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 60_000;
const TELEGRAM_DOWNLOAD_MAX_REDIRECTS = 3;
const TELEGRAM_DOWNLOAD_MAX_ATTEMPTS = 3;
const TELEGRAM_DOWNLOAD_RETRY_BASE_DELAY_MS = 500;
const DOWNLOAD_TEMP_DIR = path.join(os.tmpdir(), "opencode-telegram-bot-downloads");

export interface DownloadedFile {
  /** Absolute path to the downloaded file on the local filesystem. */
  localPath: string;
  /** Base filename as reported by Telegram. */
  fileName: string;
  /** Size in bytes. */
  fileSize: number;
}

export interface DownloadRetryOptions {
  /** Total attempts (including the first). Default {@link TELEGRAM_DOWNLOAD_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Base backoff delay in ms; doubles per retry (plus jitter). Default 500. */
  retryBaseDelayMs?: number;
}

let telegramDownloadAgent: https.RequestOptions["agent"] | null | undefined;

function getTelegramDownloadAgent(): https.RequestOptions["agent"] | undefined {
  if (telegramDownloadAgent !== undefined) {
    return telegramDownloadAgent || undefined;
  }

  const proxyUrl = config.telegram.proxyUrl.trim();
  if (!proxyUrl) {
    telegramDownloadAgent = null;
    return undefined;
  }

  telegramDownloadAgent = proxyUrl.startsWith("socks")
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);

  logger.info(`[FileDownload] Using Telegram download proxy: ${proxyUrl.replace(/\/\/.*@/, "//***@")}`);
  return telegramDownloadAgent;
}

/**
 * Streams the response body of an HTTP(S) GET to a local file.
 *
 * Returns the number of bytes written. Follows up to
 * {@link TELEGRAM_DOWNLOAD_MAX_REDIRECTS} redirects. The file is streamed to
 * disk in chunks, so arbitrarily large files only consume bounded memory.
 */
export async function streamUrlToFile(url: string, destinationPath: string): Promise<number> {
  return streamUrlToFileInternal(url, destinationPath, 0);
}

function streamUrlToFileInternal(
  url: string,
  destinationPath: string,
  redirectDepth: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const requestModule = targetUrl.protocol === "http:" ? http : https;

    const request = requestModule.get(
      targetUrl,
      { agent: getTelegramDownloadAgent() },
      (response) => {
        const statusCode = response.statusCode ?? 0;

        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          response.resume();

          if (redirectDepth >= TELEGRAM_DOWNLOAD_MAX_REDIRECTS) {
            reject(new Error("Too many redirects while downloading Telegram file"));
            return;
          }

          const redirectUrl = new URL(response.headers.location, targetUrl).toString();
          void streamUrlToFileInternal(redirectUrl, destinationPath, redirectDepth + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Telegram file download failed with HTTP ${statusCode}`));
          return;
        }

        const output = fs.createWriteStream(destinationPath);
        let receivedBytes = 0;

        output.on("error", reject);
        response.on("error", (err) => {
          output.destroy();
          reject(err);
        });
        response.on("data", (chunk: Buffer | string) => {
          receivedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        });
        output.on("finish", () => resolve(receivedBytes));

        response.pipe(output);
      },
    );

    request.on("error", reject);
    request.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Telegram file download timed out after ${TELEGRAM_DOWNLOAD_TIMEOUT_MS}ms`),
      );
    });
  });
}

/**
 * Download a file from Telegram servers, streaming it to a local temp file.
 *
 * Downloads are written to disk in chunks (never fully buffered in memory), so
 * the only file-size constraint is what the Telegram server allows:
 * - Cloud Bot API (`api.telegram.org`) caps downloads at 20 MB server-side.
 * - A local Bot API server has no size limit and returns an absolute local
 *   path in `file_path`, which is copied directly from disk here.
 *
 * Callers must clean up the temp file with {@link removeDownloadedFile}.
 *
 * @param api Grammy API instance
 * @param fileId Telegram file_id
 * @returns Downloaded file location and metadata
 */
export async function downloadTelegramFile(
  api: Api,
  fileId: string,
  options: DownloadRetryOptions = {},
): Promise<DownloadedFile> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? TELEGRAM_DOWNLOAD_MAX_ATTEMPTS);
  const retryBaseDelayMs = Math.max(
    0,
    options.retryBaseDelayMs ?? TELEGRAM_DOWNLOAD_RETRY_BASE_DELAY_MS,
  );

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await downloadTelegramFileOnce(api, fileId);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableDownloadError(err)) {
        throw err;
      }

      const delay = computeRetryDelayMs(attempt, retryBaseDelayMs);
      logger.warn(
        `[FileDownload] Attempt ${attempt}/${maxAttempts} failed for fileId=${fileId}; ` +
          `retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(delay);
    }
  }
}

async function downloadTelegramFileOnce(api: Api, fileId: string): Promise<DownloadedFile> {
  logger.debug(`[FileDownload] Getting file info for fileId=${fileId}`);

  const file = await api.getFile(fileId);

  if (!file.file_path) {
    throw new Error("File path not available from Telegram");
  }

  const fileName = file.file_path.split(/[\\/]/).pop() || "file";
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";

  await fsPromises.mkdir(DOWNLOAD_TEMP_DIR, { recursive: true });
  const localPath = path.join(
    DOWNLOAD_TEMP_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`,
  );

  try {
    if (path.isAbsolute(file.file_path)) {
      // Local Bot API server: file_path is an absolute path on this host.
      logger.debug(`[FileDownload] Copying local Bot API server file: ${file.file_path}`);
      await fsPromises.copyFile(file.file_path, localPath);
      const fileSize = (await fsPromises.stat(localPath)).size;
      logger.debug(`[FileDownload] Copied ${fileSize} bytes to ${localPath}`);
      return { localPath, fileName, fileSize };
    }

    const fileUrl = `${TELEGRAM_FILE_URL_BASE}${config.telegram.token}/${file.file_path}`;
    logger.debug(
      `[FileDownload] Streaming ${fileUrl.replace(config.telegram.token, "***")} to ${localPath}`,
    );

    const fileSize = await streamUrlToFile(fileUrl, localPath);
    logger.debug(`[FileDownload] Downloaded ${fileSize} bytes`);

    return { localPath, fileName, fileSize };
  } catch (err) {
    await removeDownloadedFile(localPath);
    throw err;
  }
}

function computeRetryDelayMs(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * (baseDelayMs / 2));
  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether a failed download is worth retrying.
 *
 * Telegram file downloads fail intermittently (server-side 5xx, CDN hiccups,
 * connection resets, brief "file not yet available" windows). A single retry
 * with backoff almost always recovers these, which is why forwarding the same
 * voice message by hand also works. Permanent failures (file too big, auth,
 * redirect loops) are not retried.
 */
export function isRetryableDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();

  if (lower.includes("too many redirects")) {
    return false;
  }
  if (lower.includes("file is too big")) {
    return false;
  }
  if (lower.includes("file path not available")) {
    return false;
  }

  const errorCode = (error as { error_code?: unknown } | null)?.error_code;
  if (typeof errorCode === "number" && (errorCode === 401 || errorCode === 403)) {
    return false;
  }

  return true;
}

/**
 * Remove a temp file previously returned by {@link downloadTelegramFile}.
 * Safe to call on paths that do not exist.
 */
export async function removeDownloadedFile(localPath: string): Promise<void> {
  await fsPromises.rm(localPath, { force: true }).catch(() => {});
}

/**
 * Convert buffer to base64 data URI
 * @param buffer File buffer
 * @param mimeType MIME type (e.g., "image/jpeg")
 * @returns Data URI string
 */
export function toDataUri(buffer: Buffer, mimeType: string): string {
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Check if photo size is within limits
 * @param fileSize Photo size in bytes
 * @param maxSizeKb Maximum size in KB (from config)
 * @returns true if within limit
 */
export function isFileSizeAllowed(fileSize: number | undefined, maxSizeKb: number): boolean {
  if (!fileSize) {
    return true; // Unknown size, allow (will be checked on download)
  }

  const maxBytes = maxSizeKb * 1024;
  return fileSize <= maxBytes;
}

/**
 * Get human-readable photo size
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const APPLICATION_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/sql",
]);

export function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  if (mimeType.startsWith("text/")) {
    return true;
  }

  return APPLICATION_TEXT_MIME_TYPES.has(mimeType);
}