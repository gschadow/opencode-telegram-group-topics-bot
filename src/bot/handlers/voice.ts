import fs from "node:fs/promises";
import type { Context } from "grammy";
import { config } from "../../config.js";
import { isSttConfigured, transcribeAudio, type SttResult } from "../../stt/client.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import {
  downloadTelegramFile,
  removeDownloadedFile,
  type DownloadedFile,
} from "../utils/file-download.js";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export interface VoiceMessageDeps extends ProcessPromptDeps {
  isSttConfigured?: () => boolean;
  downloadTelegramFile?: (
    ctx: Context,
    fileId: string,
  ) => Promise<DownloadedFile | null>;
  transcribeAudio?: (audioBuffer: Buffer, filename: string) => Promise<SttResult>;
  processPrompt?: (
    ctx: Context,
    text: string,
    deps: ProcessPromptDeps,
    fileParts?: FilePartInput[],
    options?: { responseMode?: "text_only" | "text_and_tts" },
  ) => Promise<boolean>;
}

/**
 * Downloads the audio file from Telegram servers to a local temp file.
 *
 * @returns Temp file info, or null on failure
 */
async function downloadVoiceFile(
  ctx: Context,
  fileId: string,
): Promise<DownloadedFile | null> {
  try {
    const downloaded = await downloadTelegramFile(ctx.api, fileId);

    let filename = downloaded.fileName;
    if (filename.endsWith(".oga")) {
      filename = filename.slice(0, -4) + ".ogg";
    }

    logger.debug(`[Voice] Downloaded file: ${filename} (${downloaded.fileSize} bytes)`);
    return { localPath: downloaded.localPath, fileName: filename, fileSize: downloaded.fileSize };
  } catch (err) {
    logger.error("[Voice] Error downloading file from Telegram:", err);
    return null;
  }
}

/**
 * Creates the voice message handler function.
 *
 * The factory pattern is used so that `bot` and `ensureEventSubscription` dependencies
 * can be injected from createBot() without circular imports.
 */
export function createVoiceHandler(deps: VoiceMessageDeps) {
  return async (ctx: Context): Promise<void> => {
    await handleVoiceMessage(ctx, deps);
  };
}

/**
 * Handles incoming voice and audio messages:
 * 1. Checks if STT is configured
 * 2. Downloads the audio file from Telegram
 * 3. Sends "recognizing..." status message
 * 4. Calls STT API
 * 5. Shows recognized text
 * 6. Passes text to processUserPrompt
 */
export async function handleVoiceMessage(ctx: Context, deps: VoiceMessageDeps): Promise<void> {
  const sttConfigured = deps.isSttConfigured ?? isSttConfigured;
  const downloadFile = deps.downloadTelegramFile ?? downloadVoiceFile;
  const transcribe = deps.transcribeAudio ?? transcribeAudio;
  const processPrompt = deps.processPrompt ?? processUserPrompt;

  // Determine file_id from voice or audio message
  const voice = ctx.message?.voice;
  const audio = ctx.message?.audio;
  const fileId = voice?.file_id ?? audio?.file_id;

  if (!fileId) {
    logger.warn("[Voice] Received voice/audio message with no file_id");
    return;
  }

  // Check if STT is configured
  if (!sttConfigured()) {
    await ctx.reply(t("stt.not_configured"));
    return;
  }

  // Send "recognizing..." status message (will be edited later)
  const statusMessage = await ctx.reply(t("stt.recognizing"));

  try {
    // Download the audio file from Telegram
    const fileData = await downloadFile(ctx, fileId);
    if (!fileData) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMessage.message_id,
        t("stt.error", { error: "download failed" }),
      );
      return;
    }

    try {
      const audioBuffer = await fs.readFile(fileData.localPath);

      // Transcribe the audio
      const result = await transcribe(audioBuffer, fileData.fileName);

      const recognizedText = result.text.trim();
      if (!recognizedText) {
        await ctx.api.editMessageText(ctx.chat!.id, statusMessage.message_id, t("stt.empty_result"));
        return;
      }

      // Show the recognized text by editing the status message.
      // IMPORTANT: even if this edit fails (e.g. Telegram message length limits),
      // we still send the recognized text to OpenCode as a prompt.
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMessage.message_id,
          t("stt.recognized", { text: recognizedText }),
        );
      } catch (editError) {
        logger.warn("[Voice] Failed to edit status message with recognized text:", editError);
      }

      logger.info(`[Voice] Transcribed audio: ${recognizedText.length} chars`);

      const rawNotePrompt = config.stt.notePrompt.trim();
      const notePrompt = ["", "false", "0"].includes(rawNotePrompt.toLowerCase())
        ? ""
        : rawNotePrompt;
      const promptText = notePrompt ? `[Note: ${notePrompt}]\n${recognizedText}` : recognizedText;

      if (notePrompt) {
        logger.debug(`[Voice] Added STT note to LLM prompt: [Note: ${notePrompt}]`);
      }

      // Process the recognized text as a prompt
      await processPrompt(ctx, promptText, deps);
    } finally {
      await removeDownloadedFile(fileData.localPath);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "unknown error";
    logger.error("[Voice] Error processing voice message:", err);

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMessage.message_id,
        t("stt.error", { error: errorMessage }),
      );
    } catch {
      // If we can't edit the status message, try sending a new one
      await ctx.reply(t("stt.error", { error: errorMessage })).catch(() => {});
    }
  }
}
