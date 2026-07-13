export const GLOBAL_KEEPALIVE_ALARM_NAME = "keepalive";

// Chrome 120+ minimum interval for periodic extension alarms: 0.5 minutes (30 seconds).
export const CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES = 0.5;

export const GLOBAL_KEEPALIVE_ALARM_CONFIG = Object.freeze({
  periodInMinutes: CHROME_120_MINIMUM_PERIODIC_ALARM_MINUTES,
});
