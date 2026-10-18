import fs from "node:fs/promises";
import { readFile } from "node:fs/promises";

import { cleanupBotRuntime, createBot } from "../bot/index.js";
import { config } from "../config.js";
import { reconcileStoredModelSelection } from "../model/manager.js";
import { loadSettings } from "../settings/manager.js";
import { processManager } from "../process/manager.js";
import { warmupSessionDirectoryCache } from "../session/cache-manager.js";
import { createScheduledTaskRuntime } from "../scheduled-task/runtime.js";
import { getRuntimeMode } from "../runtime/mode.js";
import { getRuntimePaths } from "../runtime/paths.js";
import { clearServiceStateFile } from "../service/manager.js";
import { getServiceStateFilePathFromEnv, isServiceChildProcess } from "../service/runtime.js";
import { logger } from "../utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 5000;

// Startup network resilience. On boot the machine may come up before DNS/network
// is actually usable, so the first Telegram calls can hang (fetch with no timeout)
// or fail. Without this the CLI promise rejects/hangs while the event loop stays
// alive on its intervals/SSE handles, leaving a zombie process that never polls
// Telegram and never triggers systemd's Restart=on-failure. Retry forever with a
// per-attempt timeout and capped exponential backoff instead.
const STARTUP_CALL_TIMEOUT_MS = 20_000;
const STARTUP_RETRY_BASE_MS = 2_000;
const STARTUP_RETRY_MAX_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startupRetryDelayMs(attempt: number): number {
  return Math.min(STARTUP_RETRY_MAX_MS, STARTUP_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 5));
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// Guard a startup network call that could otherwise hang indefinitely when the
// connection is blackholed (the original boot failure mode).
function withStartupTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${STARTUP_CALL_TIMEOUT_MS}ms`)),
      STARTUP_CALL_TIMEOUT_MS,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getBotVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const packageJsonContent = await readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };

    return packageJson.version ?? "unknown";
  } catch (error) {
    logger.warn("[App] Failed to read bot version", error);
    return "unknown";
  }
}

export async function startBotApp(): Promise<void> {
  const mode = getRuntimeMode();
  const runtimePaths = getRuntimePaths();
  const version = await getBotVersion();

  logger.info(`Starting OpenCode Telegram Group Topics Bot v${version}...`);
  logger.info(`Config loaded from ${runtimePaths.envFilePath}`);
  logger.info(`Allowed User ID: ${config.telegram.allowedUserId}`);
  logger.debug(`[Runtime] Application start mode: ${mode}`);

  await loadSettings();
  await processManager.initialize();
  await reconcileStoredModelSelection();
  await warmupSessionDirectoryCache();

  const bot = createBot();
  const scheduledTaskRuntime = createScheduledTaskRuntime(bot);
  scheduledTaskRuntime.start();

  let shutdownStarted = false;
  let serviceStateCleared = false;
  let shutdownTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearManagedServiceState = async (): Promise<void> => {
    if (!isServiceChildProcess() || serviceStateCleared) {
      return;
    }

    const stateFilePath = getServiceStateFilePathFromEnv();
    if (!stateFilePath) {
      return;
    }

    try {
      await fs.access(stateFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        serviceStateCleared = true;
        return;
      }

      throw error;
    }

    await clearServiceStateFile(stateFilePath);
    serviceStateCleared = true;
  };

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    logger.info(`[App] Received ${signal}, shutting down...`);
    cleanupBotRuntime(`app_shutdown_${signal.toLowerCase()}`);
    scheduledTaskRuntime.stop();

    shutdownTimeout = setTimeout(() => {
      logger.warn(`[App] Shutdown did not finish in ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit.`);
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    shutdownTimeout.unref?.();

    try {
      bot.stop();
    } catch (error) {
      logger.warn("[App] Failed to stop Telegram bot cleanly", error);
    }

    void clearManagedServiceState().catch((error) => {
      logger.warn("[App] Failed to clear managed service state", error);
    });
  };

  const handleSigint = (): void => shutdown("SIGINT");
  const handleSigterm = (): void => shutdown("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  const retryOneShot = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    for (;;) {
      try {
        return await run();
      } catch (error) {
        if (shutdownStarted) {
          throw error;
        }

        attempt += 1;
        const delayMs = startupRetryDelayMs(attempt);
        logger.warn(
          `[App] ${label} failed (attempt ${attempt}): ${describeError(error)}. Retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  };

  const webhookInfo = await retryOneShot("getWebhookInfo", () =>
    withStartupTimeout(bot.api.getWebhookInfo(), "getWebhookInfo"),
  );
  if (webhookInfo.url) {
    logger.info(`[Bot] Webhook detected: ${webhookInfo.url}, removing...`);
    await retryOneShot("deleteWebhook", () =>
      withStartupTimeout(bot.api.deleteWebhook(), "deleteWebhook"),
    );
    logger.info("[Bot] Webhook removed, switching to long polling");
  }

  try {
    let startAttempt = 0;
    for (;;) {
      try {
        await bot.start({
          onStart: (botInfo) => {
            startAttempt = 0;
            logger.info(`Bot @${botInfo.username} started!`);
          },
        });
        break;
      } catch (error) {
        if (shutdownStarted) {
          break;
        }

        startAttempt += 1;
        const delayMs = startupRetryDelayMs(startAttempt);
        logger.warn(
          `[App] Telegram long-polling start failed (attempt ${startAttempt}): ${describeError(error)}. Retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }
    cleanupBotRuntime("app_shutdown_complete");
    scheduledTaskRuntime.stop();
    await clearManagedServiceState().catch((error) => {
      logger.warn("[App] Failed to clear managed service state", error);
    });
    // Force-exit: after all cleanup, lingering handles (DB connections, intervals,
    // in-flight HTTP) would otherwise keep the event loop alive indefinitely.
    process.exit(0);
  }
}
