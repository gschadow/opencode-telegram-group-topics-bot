import {
  getCurrentSession as getSettingsSession,
  getScopedSessions,
  setCurrentSession as setSettingsSession,
  clearSession as clearSettingsSession,
  SessionInfo,
} from "../settings/manager.js";
import { parseScopeKey, SCOPE_CONTEXT } from "../bot/scope.js";
import { logger } from "../utils/logger.js";

export type { SessionInfo };

const GLOBAL_SCOPE_KEY = "global";

const sessionsByScope = new Map<string, SessionInfo>();
const scopeBySessionId = new Map<string, string>();
let hydrated = false;

function isTopicScopeKey(scopeKey: string): boolean {
  return parseScopeKey(scopeKey)?.context === SCOPE_CONTEXT.GROUP_TOPIC;
}

// A session id must belong to exactly one scope. A "New session - <ts>" title means
// the session was bound but never used/renamed yet, so a renamed (non-placeholder)
// binding is the more trustworthy owner when resolving a duplicate.
function isPlaceholderSessionTitle(title: string): boolean {
  return /^New session - /.test(title);
}

function ensureSessionsLoaded(): void {
  if (hydrated) {
    return;
  }

  hydrated = true;

  const scopedSessions = getScopedSessions();
  for (const [scopeKey, sessionInfo] of Object.entries(scopedSessions)) {
    if (!sessionInfo.id || !sessionInfo.title || !sessionInfo.directory) {
      logger.warn(`[SessionManager] Skipping invalid session for scope ${scopeKey}: missing id/title/directory`);
      continue;
    }

    const existingScope = scopeBySessionId.get(sessionInfo.id);
    if (existingScope && existingScope !== scopeKey) {
      const existingInfo = sessionsByScope.get(existingScope);
      const existingIsReal = existingInfo ? !isPlaceholderSessionTitle(existingInfo.title) : false;
      const incomingIsReal = !isPlaceholderSessionTitle(sessionInfo.title);
      const keepIncoming = incomingIsReal && !existingIsReal;
      const keepScope = keepIncoming ? scopeKey : existingScope;
      const clearScope = keepIncoming ? existingScope : scopeKey;

      logger.warn(
        `[SessionManager] Duplicate session ${sessionInfo.id} bound to ${existingScope} and ${scopeKey}; keeping ${keepScope}, clearing binding ${clearScope} to prevent cross-group leakage`,
      );

      if (keepIncoming) {
        sessionsByScope.delete(existingScope);
        scopeBySessionId.delete(sessionInfo.id);
        sessionsByScope.set(scopeKey, sessionInfo);
        scopeBySessionId.set(sessionInfo.id, scopeKey);
      }

      clearSettingsSession(clearScope);
      continue;
    }

    sessionsByScope.set(scopeKey, sessionInfo);
    scopeBySessionId.set(sessionInfo.id, scopeKey);
  }

  const settingsSession = getSettingsSession();
  if (!settingsSession) {
    return;
  }

  sessionsByScope.set(GLOBAL_SCOPE_KEY, settingsSession);
  scopeBySessionId.set(settingsSession.id, GLOBAL_SCOPE_KEY);
}

export function setCurrentSession(
  sessionInfo: SessionInfo,
  scopeKey: string = GLOBAL_SCOPE_KEY,
): void {
  ensureSessionsLoaded();

  const previous = sessionsByScope.get(scopeKey);
  if (isTopicScopeKey(scopeKey) && previous && previous.id !== sessionInfo.id) {
    logger.warn(
      `[SessionManager] Rejecting session switch in immutable topic scope: scope=${scopeKey}, existing=${previous.id}, requested=${sessionInfo.id}`,
    );
    return;
  }

  if (previous && previous.id !== sessionInfo.id) {
    scopeBySessionId.delete(previous.id);
  }

  const previousScopeForSession = scopeBySessionId.get(sessionInfo.id);
  if (previousScopeForSession && previousScopeForSession !== scopeKey) {
    sessionsByScope.delete(previousScopeForSession);
    // Persist the removal too: leaving the old scope pointing at this session in
    // settings.json made the next hydrate bind one session to two scopes, which
    // routed one group's messages into another group's session.
    clearSettingsSession(previousScopeForSession);
  }

  sessionsByScope.set(scopeKey, sessionInfo);
  scopeBySessionId.set(sessionInfo.id, scopeKey);

  if (scopeKey === GLOBAL_SCOPE_KEY) {
    setSettingsSession(sessionInfo, scopeKey);
    return;
  }

  setSettingsSession(sessionInfo, scopeKey);
}

export function getCurrentSession(scopeKey: string = GLOBAL_SCOPE_KEY): SessionInfo | null {
  ensureSessionsLoaded();
  return sessionsByScope.get(scopeKey) ?? null;
}

export function clearSession(scopeKey: string = GLOBAL_SCOPE_KEY): void {
  ensureSessionsLoaded();

  const session = sessionsByScope.get(scopeKey);
  if (session) {
    scopeBySessionId.delete(session.id);
  }

  sessionsByScope.delete(scopeKey);

  if (scopeKey === GLOBAL_SCOPE_KEY) {
    clearSettingsSession(scopeKey);
    return;
  }

  clearSettingsSession(scopeKey);
}

export function getScopeForSession(sessionId: string): string | null {
  ensureSessionsLoaded();
  return scopeBySessionId.get(sessionId) ?? null;
}

export function registerSessionScope(sessionId: string, scopeKey: string): void {
  ensureSessionsLoaded();
  scopeBySessionId.set(sessionId, scopeKey);

  const sessionInfo = sessionsByScope.get(scopeKey);
  if (!sessionInfo || sessionInfo.id !== sessionId) {
    return;
  }

  setSettingsSession(sessionInfo, scopeKey);
}

export function getSessionById(sessionId: string): SessionInfo | null {
  ensureSessionsLoaded();
  const scopeKey = scopeBySessionId.get(sessionId);
  if (!scopeKey) {
    return null;
  }

  return sessionsByScope.get(scopeKey) ?? null;
}
