export const GLOBAL_KEEPALIVE_ALARM_NAME = "keepalive";

// Chrome 120+ minimum interval for periodic extension alarms: 0.5 minutes (30 seconds).
export const CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES = 0.5;

export const GLOBAL_KEEPALIVE_ALARM_CONFIG = Object.freeze({
  periodInMinutes: CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES,
});

export interface GlobalKeepaliveActions {
  retryTemporaryTabCleanup(): Promise<void>;
  retryRecordingCleanup(): Promise<void>;
  ensureAlive(): Promise<void>;
  reportTemporaryTabFailure(): void;
  reportRecordingFailure(): void;
}

export async function runGlobalKeepalive(actions: GlobalKeepaliveActions): Promise<void> {
  try {
    await actions.retryTemporaryTabCleanup();
  } catch {
    actions.reportTemporaryTabFailure();
  }
  try {
    await actions.retryRecordingCleanup();
  } catch {
    actions.reportRecordingFailure();
  }
  await actions.ensureAlive();
}
