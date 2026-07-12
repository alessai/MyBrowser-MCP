import type { IStateManager } from "./state-manager.js";

export type RpcAuthContext = {
  role: "client";
  sessionId: string;
};

const INTERNAL_RPC_METHODS = new Set([
  "clearEventHandlersForBrowser",
  "pushEvent",
]);

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function deny(): never {
  throw new Error("AUTH_ROLE_VIOLATION");
}

export async function dispatchHubRpc(
  stateManager: IStateManager,
  auth: RpcAuthContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (auth.role !== "client" || INTERNAL_RPC_METHODS.has(method)) deny();

  switch (method) {
    case "removeSession":
      await stateManager.removeSession(auth.sessionId);
      return { ok: true };
    case "touchSession":
      await stateManager.touchSession(auth.sessionId);
      return { ok: true };
    case "listSessions":
      return await stateManager.listSessions();

    case "claimTab":
      return await stateManager.claimTab(auth.sessionId, requireString(params, "tabKey"));
    case "releaseTab":
      return await stateManager.releaseTab(auth.sessionId, requireString(params, "tabKey"));
    case "transferTab":
      return await stateManager.transferTab(
        auth.sessionId,
        requireString(params, "toSessionId"),
        requireString(params, "tabKey"),
      );
    case "releaseAllTabs":
      await stateManager.releaseAllTabs(auth.sessionId);
      return { ok: true };
    case "isTabAvailable":
      return await stateManager.isTabAvailable(requireString(params, "tabKey"), auth.sessionId);
    case "getTabOwner":
      return await stateManager.getTabOwner(requireString(params, "tabKey"));
    case "shouldEnforceOwnership":
      return await stateManager.shouldEnforceOwnership();
    case "getSessionName":
      return await stateManager.getSessionName(requireString(params, "sessionId"));

    case "reserveRecording":
      return await stateManager.reserveRecording(
        auth.sessionId,
        requireString(params, "name"),
        requireNumber(params, "leaseMs"),
      );
    case "renewRecordingReservation":
      return await stateManager.renewRecordingReservation(
        auth.sessionId,
        requireString(params, "name"),
        requireNumber(params, "leaseMs"),
      );
    case "releaseRecordingReservation":
      return await stateManager.releaseRecordingReservation(
        auth.sessionId,
        requireString(params, "name"),
      );
    case "hasRecordingReservation":
      return await stateManager.hasRecordingReservation(
        auth.sessionId,
        requireString(params, "name"),
      );

    case "selectBrowser":
      await stateManager.selectBrowser(auth.sessionId, requireString(params, "browserId"));
      return { ok: true };
    case "getSessionBrowser":
      return await stateManager.getSessionBrowser(auth.sessionId);
    case "setDefaultBrowser":
      return await stateManager.setDefaultBrowser(requireString(params, "browserId"));
    case "getDefaultBrowser":
      return await stateManager.getDefaultBrowser();
    case "clearDefaultBrowser":
      await stateManager.clearDefaultBrowser();
      return { ok: true };
    case "resolveBrowserTarget":
      return await stateManager.resolveBrowserTarget(auth.sessionId);
    case "listBrowsers":
      return await stateManager.listBrowsers();

    case "sharedGet":
      return await stateManager.sharedGet(requireString(params, "key"));
    case "sharedSet":
      await stateManager.sharedSet(requireString(params, "key"), params.value);
      return { ok: true };
    case "sharedDelete":
      return await stateManager.sharedDelete(requireString(params, "key"));
    case "sharedList":
      return await stateManager.sharedList();

    case "notesList":
      return await stateManager.notesList(
        typeof params.status === "string"
          ? (params.status as "pending" | "archived" | "all")
          : "pending",
      );
    case "notesGet":
      return await stateManager.notesGet(requireString(params, "id"));
    case "notesArchive":
      return await stateManager.notesArchive(
        requireString(params, "id"),
        typeof params.resolution === "string" ? params.resolution : undefined,
      );
    case "notesUnarchive":
      return await stateManager.notesUnarchive(requireString(params, "id"));
    case "notesDelete":
      return await stateManager.notesDelete(requireString(params, "id"), params.force === true);

    case "registerEventHandler":
      return await stateManager.registerEventHandler(
        auth.sessionId,
        requireString(params, "browserId"),
        requireString(params, "event") as
          | "dialog"
          | "beforeunload"
          | "new_tab"
          | "network_timeout",
        requireString(params, "action") as "dismiss" | "accept" | "emit" | "ignore",
        params.options as Record<string, unknown> | undefined,
      );
    case "unregisterEventHandler":
      return await stateManager.unregisterEventHandler(
        auth.sessionId,
        requireString(params, "handlerId"),
      );
    case "listEventHandlers":
      return await stateManager.listEventHandlers(
        auth.sessionId,
        typeof params.browserId === "string" ? params.browserId : undefined,
      );
    case "clearEventHandlersForSession":
      await stateManager.clearEventHandlersForSession(auth.sessionId);
      return { ok: true };
    case "hasMatchingEventHandler":
      return await stateManager.hasMatchingEventHandler(
        auth.sessionId,
        requireString(params, "browserId"),
        requireString(params, "event") as
          | "dialog"
          | "beforeunload"
          | "new_tab"
          | "network_timeout",
        requireString(params, "queueName"),
      );
    case "waitForEvent":
      return await stateManager.waitForEvent(
        auth.sessionId,
        requireString(params, "queueName"),
        typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000,
      );

    case "acquireLock":
      return await stateManager.acquireLock(
        auth.sessionId,
        requireString(params, "name"),
        typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000,
        typeof params.ttlMs === "number" ? params.ttlMs : undefined,
      );
    case "releaseLock":
      return await stateManager.releaseLock(auth.sessionId, requireString(params, "name"));
    case "listLocks":
      return await stateManager.listLocks();
    case "releaseLocksForSession":
      await stateManager.releaseLocksForSession(auth.sessionId);
      return { ok: true };
    default:
      return deny();
  }
}
