import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import {
  downloadTelegramFile,
  removeDownloadedFile,
  streamUrlToFile,
  toDataUri,
  formatFileSize,
  isFileSizeAllowed,
  isTextMimeType,
} from "../../../src/bot/utils/file-download.js";

const httpsGetMock = vi.hoisted(() => vi.fn());

vi.mock("node:https", async () => {
  return { get: httpsGetMock, default: { get: httpsGetMock } };
});

describe("bot/utils/file-download", () => {
  describe("toDataUri", () => {
    it("converts buffer to base64 data URI with correct MIME type", () => {
      const buffer = Buffer.from("Hello, World!");
      const dataUri = toDataUri(buffer, "text/plain");

      expect(dataUri).toBe("data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==");
    });

    it("handles image MIME types", () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic number
      const dataUri = toDataUri(buffer, "image/png");

      expect(dataUri).toMatch(/^data:image\/png;base64,/);
      expect(dataUri).toBe("data:image/png;base64,iVBORw==");
    });

    it("handles empty buffer", () => {
      const buffer = Buffer.from([]);
      const dataUri = toDataUri(buffer, "application/octet-stream");

      expect(dataUri).toBe("data:application/octet-stream;base64,");
    });
  });

  describe("isFileSizeAllowed", () => {
    it("returns true when file size is within limit", () => {
      expect(isFileSizeAllowed(100 * 1024, 200)).toBe(true); // 100KB < 200KB
      expect(isFileSizeAllowed(1024, 1)).toBe(true); // exactly at limit
    });

    it("returns false when file size exceeds limit", () => {
      expect(isFileSizeAllowed(300 * 1024, 200)).toBe(false); // 300KB > 200KB
      expect(isFileSizeAllowed(1025, 1)).toBe(false); // just over limit
    });

    it("returns true when file size is undefined (unknown)", () => {
      expect(isFileSizeAllowed(undefined, 100)).toBe(true);
    });
  });

  describe("formatFileSize", () => {
    it("formats bytes correctly", () => {
      expect(formatFileSize(0)).toBe("0B");
      expect(formatFileSize(500)).toBe("500B");
      expect(formatFileSize(1023)).toBe("1023B");
    });

    it("formats kilobytes correctly", () => {
      expect(formatFileSize(1024)).toBe("1.0KB");
      expect(formatFileSize(1536)).toBe("1.5KB");
      expect(formatFileSize(10240)).toBe("10.0KB");
    });

    it("formats megabytes correctly", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.0MB");
      expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5MB");
      expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0MB");
    });
  });

  describe("isTextMimeType", () => {
    it("returns true for text/* MIME types", () => {
      expect(isTextMimeType("text/plain")).toBe(true);
      expect(isTextMimeType("text/markdown")).toBe(true);
      expect(isTextMimeType("text/html")).toBe(true);
      expect(isTextMimeType("text/css")).toBe(true);
      expect(isTextMimeType("text/javascript")).toBe(true);
      expect(isTextMimeType("text/x-python")).toBe(true);
      expect(isTextMimeType("text/csv")).toBe(true);
    });

    it("returns true for whitelisted application/* types", () => {
      expect(isTextMimeType("application/json")).toBe(true);
      expect(isTextMimeType("application/xml")).toBe(true);
      expect(isTextMimeType("application/javascript")).toBe(true);
      expect(isTextMimeType("application/x-yaml")).toBe(true);
      expect(isTextMimeType("application/sql")).toBe(true);
    });

    it("returns false for other application/* types", () => {
      expect(isTextMimeType("application/pdf")).toBe(false);
      expect(isTextMimeType("application/zip")).toBe(false);
      expect(isTextMimeType("application/octet-stream")).toBe(false);
      expect(isTextMimeType("application/msword")).toBe(false);
    });

    it("returns false for image/* types", () => {
      expect(isTextMimeType("image/png")).toBe(false);
      expect(isTextMimeType("image/jpeg")).toBe(false);
      expect(isTextMimeType("image/gif")).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isTextMimeType(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isTextMimeType("")).toBe(false);
    });
  });

  describe("downloadTelegramFile", () => {
    beforeEach(async () => {
      httpsGetMock.mockClear();
      const { Readable } = await import("node:stream");
      httpsGetMock.mockImplementation(
        (_url: string, _options: unknown, callback: (response: unknown) => void) => {
          const response = Readable.from([Buffer.from("binary-audio-data")]) as NodeJS.ReadableStream & {
            statusCode?: number;
            headers?: Record<string, string | undefined>;
          };
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
        },
      );
    });

    afterAll(async () => {
      await fs.rm(path.join(os.tmpdir(), "opencode-telegram-bot-downloads"), {
        recursive: true,
        force: true,
      });
    });

    it("copies a file when file_path is an absolute local path (local Bot API server)", async () => {
      const sourcePath = path.join(
        os.tmpdir(),
        `src-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`,
      );
      await fs.writeFile(sourcePath, "local-audio-content");

      const api = {
        getFile: vi.fn().mockResolvedValue({ file_path: sourcePath, file_size: 20 }),
      } as unknown as Api;

      try {
        const result = await downloadTelegramFile(api, "file-id");

        expect(result.fileName).toBe(path.basename(sourcePath));
        expect(result.fileSize).toBe(Buffer.byteLength("local-audio-content"));
        expect(await fs.readFile(result.localPath, "utf-8")).toBe("local-audio-content");
        expect(httpsGetMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(sourcePath, { force: true });
      }
    });

    it("does not reject files larger than 20MB and streams them to disk", async () => {
      const api = {
        getFile: vi.fn().mockResolvedValue({
          file_path: "audio/file_1.oga",
          file_size: 30 * 1024 * 1024,
        }),
      } as unknown as Api;

      const result = await downloadTelegramFile(api, "file-id");

      expect(httpsGetMock).toHaveBeenCalled();
      expect(result.fileName).toBe("file_1.oga");
      expect(result.fileSize).toBe(Buffer.byteLength("binary-audio-data"));
      expect(await fs.readFile(result.localPath, "utf-8")).toBe("binary-audio-data");

      await removeDownloadedFile(result.localPath);
    });

    it("throws when Telegram returns no file_path", async () => {
      const api = {
        getFile: vi.fn().mockResolvedValue({ file_size: 10 }),
      } as unknown as Api;

      await expect(downloadTelegramFile(api, "file-id")).rejects.toThrow(
        "File path not available from Telegram",
      );
      expect(api.getFile).toHaveBeenCalledTimes(1);
    });

    it("retries a transient getFile failure and then succeeds", async () => {
      const resetError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const api = {
        getFile: vi
          .fn()
          .mockRejectedValueOnce(resetError)
          .mockResolvedValueOnce({ file_path: "audio/file_1.oga", file_size: 18 }),
      } as unknown as Api;

      const result = await downloadTelegramFile(api, "file-id", { retryBaseDelayMs: 0 });

      expect(api.getFile).toHaveBeenCalledTimes(2);
      expect(httpsGetMock).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(result.localPath, "utf-8")).toBe("binary-audio-data");

      await removeDownloadedFile(result.localPath);
    });

    it("retries a transient HTTP 5xx response and then succeeds", async () => {
      const api = {
        getFile: vi.fn().mockResolvedValue({ file_path: "audio/file_1.oga", file_size: 18 }),
      } as unknown as Api;

      const { Readable } = await import("node:stream");
      httpsGetMock.mockImplementationOnce(
        (_url: string, _options: unknown, callback: (response: unknown) => void) => {
          const response = Readable.from([]) as NodeJS.ReadableStream & {
            statusCode?: number;
            headers?: Record<string, string | undefined>;
          };
          response.statusCode = 503;
          response.headers = {};
          callback(response);
          return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() };
        },
      );

      const result = await downloadTelegramFile(api, "file-id", { retryBaseDelayMs: 0 });

      expect(httpsGetMock).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(result.localPath, "utf-8")).toBe("binary-audio-data");

      await removeDownloadedFile(result.localPath);
    });

    it("gives up after exhausting all attempts", async () => {
      const api = {
        getFile: vi.fn().mockRejectedValue(new Error("socket hang up")),
      } as unknown as Api;

      await expect(
        downloadTelegramFile(api, "file-id", { maxAttempts: 3, retryBaseDelayMs: 0 }),
      ).rejects.toThrow("socket hang up");
      expect(api.getFile).toHaveBeenCalledTimes(3);
    });

    it("does not retry permanent failures (file is too big)", async () => {
      const api = {
        getFile: vi.fn().mockRejectedValue(new Error("Bad Request: file is too big")),
      } as unknown as Api;

      await expect(downloadTelegramFile(api, "file-id")).rejects.toThrow("file is too big");
      expect(api.getFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("streamUrlToFile", () => {
    it("streams an HTTP response body to disk and returns the byte count", async () => {
      const payload = Buffer.from("streamed-payload-bytes");
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(payload);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;

      const destPath = path.join(
        os.tmpdir(),
        `stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );

      try {
        const bytes = await streamUrlToFile(`http://127.0.0.1:${port}/file`, destPath);
        expect(bytes).toBe(payload.length);
        expect(await fs.readFile(destPath)).toEqual(payload);
      } finally {
        await fs.rm(destPath, { force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("follows redirects", async () => {
      const payload = Buffer.from("redirected-payload");
      const server = http.createServer((req, res) => {
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/file" });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(payload);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;

      const destPath = path.join(
        os.tmpdir(),
        `stream-redirect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );

      try {
        const bytes = await streamUrlToFile(`http://127.0.0.1:${port}/redirect`, destPath);
        expect(bytes).toBe(payload.length);
        expect(await fs.readFile(destPath)).toEqual(payload);
      } finally {
        await fs.rm(destPath, { force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("rejects on non-2xx responses", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;

      const destPath = path.join(
        os.tmpdir(),
        `stream-404-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );

      try {
        await expect(
          streamUrlToFile(`http://127.0.0.1:${port}/missing`, destPath),
        ).rejects.toThrow("failed with HTTP 404");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
