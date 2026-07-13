import {
  MAX_RECORDED_URL_LENGTH,
  parameterizeArgs,
  sanitizePageUrl,
  validateSanitizedArgs,
  type RequiredVariable,
  type VariableSource,
} from './recording-parameterizer';
import type { ToolName } from './tool-metadata';
import { isValidV2SessionId } from './session-id';
import { canonicalizeRecordingName } from './recording-name';

export interface RecordedStep {
  action: string;
  args: Record<string, unknown>;
  timestamp: number;
  durationMs: number;
  url: string;
  result?: unknown;
}

export interface Recording {
  name: string;
  startedAt: number;
  stoppedAt?: number;
  url: string;
  steps: RecordedStep[];
  requiredVariables: RequiredVariable[];
}

export interface RecordingListEntry {
  name: string;
  compatible: boolean;
  reason?: 'RECORDING_UNSUPPORTED_MULTI_TAB' | 'RECORDING_INVALID';
}

export interface RecordingStorage {
  get<T>(key: string): Promise<T | undefined>;
  has(key: string): Promise<boolean>;
  getKeys(): Promise<string[]>;
  getBytesInUse(keys: string[]): Promise<number>;
  set<T>(key: string, value: T): Promise<void>;
  setMany(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  removeMany(keys: string[]): Promise<void>;
}

export interface RecordingTransport {
  request(type: string, payload: unknown, timeoutMs: number): Promise<unknown>;
}

export interface RecordingAlarmScheduler {
  ensureRenewal(): Promise<void>;
  clearRenewal(): Promise<void>;
  ensureCleanup(sessionId: string): Promise<void>;
  clearCleanup(sessionId: string): Promise<void>;
  getCleanupSessionIds(): Promise<string[]>;
}

export interface PreparedStep {
  readonly id: string;
  readonly beganUnderRecording: true;
  readonly action: ToolName;
  readonly args: Record<string, unknown>;
  readonly timestamp: number;
  readonly requiredVariables: RequiredVariable[];
  readonly nextVariable: number;
  readonly finalReservedBytes: number;
}

export class RecordedActionFailure extends Error {
  constructor() {
    super('RECORDED_TOOL_ACTION_FAILED');
    this.name = 'RecordedActionFailure';
  }
}

export class RecordedStateFailure extends Error {
  constructor() {
    super('RECORDED_STATE_FAILED');
    this.name = 'RecordedStateFailure';
  }
}

export function isRecordedActionFailure(error: unknown): error is RecordedActionFailure {
  return error instanceof RecordedActionFailure;
}

export function isRecordedStateFailure(error: unknown): error is RecordedStateFailure {
  return error instanceof RecordedStateFailure;
}

export interface RecordingStopResult {
  extensionSaved: boolean;
  serverSaved: boolean;
  recording: Recording & { stoppedAt: number };
  error?: 'SERVER_PERSIST_FAILED'
    | 'LOCAL_RECORDING_CONFLICT'
    | 'LOCAL_PERSIST_FAILED'
    | 'ACTIVE_STATE_PERSIST_FAILED'
    | 'ACTIVE_STATE_CLEANUP_FAILED';
}

type PersistedRecordingStateStatus = 'active' | 'stopping' | 'cleanup';
type RecordingStateStatus = PersistedRecordingStateStatus | 'quarantined';
type CachedStopStatus = Omit<RecordingStopResult, 'recording'>;

interface ActiveRecording {
  sessionId: string;
  tabId: number;
  nextVariable: number;
  status: RecordingStateStatus;
  stopStatus?: CachedStopStatus;
  recording: Recording;
}

interface RecordingMarker {
  sessionId: string;
  status: PersistedRecordingStateStatus;
}

interface PendingReservation {
  sessionId: string;
  baseStepCount: number;
  baseNextVariable: number;
  finalReservedBytes: number;
  reservedAggregateDelta: number;
}

export interface RecordingLimits {
  maxSteps: number;
  maxRecordingBytes: number;
  maxAggregateBytes: number;
}

export const MAX_ACTIVE_RECORDING_STEPS = 1_000;
export const MAX_ACTIVE_RECORDING_BYTES = 2 * 1024 * 1024;
export const MAX_AGGREGATE_RECORDING_BYTES = 8 * 1024 * 1024;
export const MAX_CHROME_TAB_ID = 2_147_483_647;
export const MAX_RECORDING_TIMESTAMP_MS = 8_640_000_000_000_000;
export const MAX_RECORDED_DURATION_MS = 2_147_483_647;
export const MAX_REQUIRED_VARIABLES = 100_000;
export const RECORDING_RENEWAL_ALARM = 'active-recordings-renewal';
export const RECORDING_RENEWAL_MINUTES = 5;
export const RECORDING_CLEANUP_ALARM_PREFIX = 'recording-cleanup:';
export const RECORDING_CLEANUP_MINUTES = 1;

const ACTIVE_PREFIX = 'active-recording:';
const ACTIVE_MARKER_PREFIX = 'active-recording-index:';
const LEGACY_ACTIVE_INDEX_KEY = 'active-recording-index';
const COMPLETED_PREFIX = 'recording:';
const COMPLETED_DIGEST_PREFIX = 'recording-digest:';
const SERVER_TIMEOUT_MS = 10_000;
const COMMIT_OVERHEAD_BYTES = 1_024;
const COMMIT_DURATION_JSON_SLACK_BYTES = 32;
const WORST_STOP_STATUS: CachedStopStatus = {
  extensionSaved: false,
  serverSaved: false,
  error: 'ACTIVE_STATE_CLEANUP_FAILED',
};

class ChromeStorageAdapter implements RecordingStorage {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  async get<T>(key: string): Promise<T | undefined> {
    const values = await this.area.get(key);
    return values[key] as T | undefined;
  }

  async has(key: string): Promise<boolean> {
    return (await this.area.getBytesInUse(key)) > 0;
  }

  async getKeys(): Promise<string[]> {
    return this.area.getKeys();
  }

  async getBytesInUse(keys: string[]): Promise<number> {
    return await this.area.getBytesInUse(keys);
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async setMany(values: Record<string, unknown>): Promise<void> {
    await this.area.set(values);
  }

  async remove(key: string): Promise<void> {
    await this.area.remove(key);
  }

  async removeMany(keys: string[]): Promise<void> {
    await this.area.remove(keys);
  }
}

export class ChromeRecordingAlarmScheduler implements RecordingAlarmScheduler {
  async ensureRenewal(): Promise<void> {
    await chrome.alarms.create(RECORDING_RENEWAL_ALARM, {
      periodInMinutes: RECORDING_RENEWAL_MINUTES,
    });
  }

  async clearRenewal(): Promise<void> {
    await chrome.alarms.clear(RECORDING_RENEWAL_ALARM);
  }

  async ensureCleanup(sessionId: string): Promise<void> {
    await chrome.alarms.create(recordingCleanupAlarmName(sessionId), {
      periodInMinutes: RECORDING_CLEANUP_MINUTES,
    });
  }

  async clearCleanup(sessionId: string): Promise<void> {
    await chrome.alarms.clear(recordingCleanupAlarmName(sessionId));
  }

  async getCleanupSessionIds(): Promise<string[]> {
    const alarms = await chrome.alarms.getAll();
    return alarms
      .map((alarm) => recordingCleanupSessionId(alarm.name))
      .filter((sessionId): sessionId is string => sessionId !== null)
      .sort();
  }
}

export function recordingCleanupAlarmName(sessionId: string): string {
  return `${RECORDING_CLEANUP_ALARM_PREFIX}${sessionId}`;
}

export function recordingCleanupSessionId(alarmName: string): string | null {
  if (!alarmName.startsWith(RECORDING_CLEANUP_ALARM_PREFIX)) return null;
  const sessionId = alarmName.slice(RECORDING_CLEANUP_ALARM_PREFIX.length);
  return isValidV2SessionId(sessionId) ? sessionId : null;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isActiveRecording(
  value: unknown,
  sessionId: string,
): value is ActiveRecording {
  if (!isRecord(value) || value.sessionId !== sessionId) return false;
  const stateKeys = ['sessionId', 'tabId', 'nextVariable', 'status', 'recording'];
  if ('stopStatus' in value) stateKeys.push('stopStatus');
  if (!hasExactKeys(value, stateKeys)) return false;
  if (!Number.isSafeInteger(value.tabId)
    || (value.tabId as number) < 1
    || (value.tabId as number) > MAX_CHROME_TAB_ID) return false;
  if (!Number.isSafeInteger(value.nextVariable)
    || (value.nextVariable as number) < 1
    || (value.nextVariable as number) > MAX_REQUIRED_VARIABLES + 1) return false;
  if (value.status !== 'active' && value.status !== 'stopping' && value.status !== 'cleanup') return false;
  if ('stopStatus' in value) {
    if ((value.status !== 'stopping' && value.status !== 'cleanup') || !isRecord(value.stopStatus)) return false;
    const stopStatusKeys = ['extensionSaved', 'serverSaved'];
    if ('error' in value.stopStatus) stopStatusKeys.push('error');
    if (!hasExactKeys(value.stopStatus, stopStatusKeys)) return false;
    if (typeof value.stopStatus.extensionSaved !== 'boolean'
      || typeof value.stopStatus.serverSaved !== 'boolean') return false;
    if (value.stopStatus.extensionSaved && !value.stopStatus.serverSaved) return false;
    if ('error' in value.stopStatus && ![
      'SERVER_PERSIST_FAILED',
      'LOCAL_RECORDING_CONFLICT',
      'LOCAL_PERSIST_FAILED',
      'ACTIVE_STATE_PERSIST_FAILED',
      'ACTIVE_STATE_CLEANUP_FAILED',
    ].includes(value.stopStatus.error as string)) return false;
  }
  const recording = value.recording;
  if (!isRecord(recording) || typeof recording.name !== 'string') return false;
  const recordingKeys = ['name', 'startedAt', 'url', 'steps', 'requiredVariables'];
  const hasStoppedAt = 'stoppedAt' in recording;
  if (hasStoppedAt) recordingKeys.push('stoppedAt');
  if (!hasExactKeys(recording, recordingKeys)) return false;
  if (typeof recording.startedAt !== 'number'
    || !Number.isSafeInteger(recording.startedAt)
    || recording.startedAt < 0
    || recording.startedAt > MAX_RECORDING_TIMESTAMP_MS
    || typeof recording.url !== 'string') return false;
  if (value.status === 'active' && (hasStoppedAt || 'stopStatus' in value)) return false;
  if (value.status === 'stopping' && (!hasStoppedAt
    || typeof recording.stoppedAt !== 'number'
    || !Number.isSafeInteger(recording.stoppedAt)
    || recording.stoppedAt < 0
    || recording.stoppedAt > MAX_RECORDING_TIMESTAMP_MS)) return false;
  if (value.status === 'cleanup' && hasStoppedAt && (
    typeof recording.stoppedAt !== 'number'
    || !Number.isSafeInteger(recording.stoppedAt)
    || recording.stoppedAt < 0
    || recording.stoppedAt > MAX_RECORDING_TIMESTAMP_MS
  )) return false;
  if (!Array.isArray(recording.steps) || !Array.isArray(recording.requiredVariables)) return false;
  if (recording.steps.length > MAX_ACTIVE_RECORDING_STEPS
    || recording.requiredVariables.length > MAX_REQUIRED_VARIABLES
    || byteLength(recording) + COMMIT_OVERHEAD_BYTES > MAX_ACTIVE_RECORDING_BYTES) return false;
  if ('variables' in recording || sanitizePageUrl(recording.url) !== recording.url) return false;

  const variables = new Map<string, VariableSource>();
  for (const [index, variable] of recording.requiredVariables.entries()) {
    if (!isRecord(variable)) return false;
    const variableKeys = ['name', 'source'];
    if ('hint' in variable) variableKeys.push('hint');
    if (!hasExactKeys(variable, variableKeys)) return false;
    const { name, source, hint } = variable;
    if (typeof name !== 'string' || typeof source !== 'string') return false;
    if (!['text', 'form', 'select', 'navigation', 'clipboard'].includes(source)) return false;
    const match = /^(input|form|select|navigation|clipboard)_(\d+)$/.exec(name);
    if (!match) return false;
    if (Number(match[2]) !== index + 1) return false;
    const expectedSource = match[1] === 'input' ? 'text' : match[1];
    if (source !== expectedSource
      || (hint !== undefined && hint !== `${source}_input_${match[2]}`)) return false;
    if (variables.has(name)) return false;
    variables.set(name, source as VariableSource);
  }
  if (value.nextVariable !== recording.requiredVariables.length + 1) return false;

  const usedVariables = new Set<string>();
  for (const step of recording.steps) {
    if (!isRecord(step) || typeof step.action !== 'string' || !isRecord(step.args)) return false;
    if (!hasExactKeys(step, ['action', 'args', 'timestamp', 'durationMs', 'url'])) return false;
    if (typeof step.timestamp !== 'number'
      || !Number.isSafeInteger(step.timestamp)
      || step.timestamp < 0
      || step.timestamp > MAX_RECORDING_TIMESTAMP_MS) return false;
    if (typeof step.durationMs !== 'number'
      || !Number.isFinite(step.durationMs)
      || step.durationMs < 0
      || step.durationMs > MAX_RECORDED_DURATION_MS) return false;
    if (typeof step.url !== 'string' || sanitizePageUrl(step.url) !== step.url) return false;
    if (!validateSanitizedArgs(step.action, step.args, variables, usedVariables)) return false;
  }
  return usedVariables.size === variables.size
    && [...variables.keys()].every((name) => usedVariables.has(name));
}

function isRecordingMarker(value: unknown, sessionId: string): value is RecordingMarker {
  return isRecord(value)
    && hasExactKeys(value, ['sessionId', 'status'])
    && value.sessionId === sessionId
    && (value.status === 'active' || value.status === 'stopping' || value.status === 'cleanup');
}

export function isSanitizedRecording(
  value: unknown,
): value is Recording & { stoppedAt: number } {
  if (!isRecord(value)
    || typeof value.stoppedAt !== 'number'
    || !Number.isSafeInteger(value.stoppedAt)
    || value.stoppedAt < 0
    || value.stoppedAt > MAX_RECORDING_TIMESTAMP_MS) {
    return false;
  }
  return isActiveRecording({
    sessionId: 'validation',
    tabId: 1,
    nextVariable: Array.isArray(value.requiredVariables) ? value.requiredVariables.length + 1 : 1,
    status: 'stopping',
    recording: value,
  }, 'validation');
}

export class RecordingManager {
  private readonly active = new Map<string, ActiveRecording>();
  private readonly persistedFootprints = new Map<string, number>();
  private readonly replaying = new Set<string>();
  private readonly closedSessions = new Set<string>();
  private readonly cleanupFallbackSessions = new Set<string>();
  private readonly pending = new Map<string, PendingReservation>();
  private readonly sessionStorage: RecordingStorage;
  private readonly localStorage: RecordingStorage;
  private readonly transport: RecordingTransport;
  private readonly scheduler: RecordingAlarmScheduler;
  private readonly limits: RecordingLimits;
  private readonly now: () => number;
  private operationChain: Promise<void> = Promise.resolve();
  private accountingChain: Promise<void> = Promise.resolve();
  private preparedCounter = 0;

  constructor(options: {
    transport: RecordingTransport;
    sessionStorage?: RecordingStorage;
    localStorage?: RecordingStorage;
    scheduler?: RecordingAlarmScheduler;
    limits?: Partial<RecordingLimits>;
    now?: () => number;
  }) {
    this.transport = options.transport;
    this.sessionStorage = options.sessionStorage
      ?? new ChromeStorageAdapter(chrome.storage.session);
    this.localStorage = options.localStorage
      ?? new ChromeStorageAdapter(chrome.storage.local);
    this.scheduler = options.scheduler ?? new ChromeRecordingAlarmScheduler();
    this.limits = {
      maxSteps: options.limits?.maxSteps ?? MAX_ACTIVE_RECORDING_STEPS,
      maxRecordingBytes: options.limits?.maxRecordingBytes ?? MAX_ACTIVE_RECORDING_BYTES,
      maxAggregateBytes: options.limits?.maxAggregateBytes ?? MAX_AGGREGATE_RECORDING_BYTES,
    };
    this.now = options.now ?? Date.now;
  }

  start(sessionId: string, name: string, tabId: number, url: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isValidV2SessionId(sessionId)) throw new RecordedStateFailure();
      let canonicalName: string;
      try {
        canonicalName = canonicalizeRecordingName(name);
        if (await this.localStorage.has(`${COMPLETED_PREFIX}${canonicalName}`)
          || await this.localStorage.has(`${COMPLETED_DIGEST_PREFIX}${canonicalName}`)) {
          throw new Error('COMPLETED_RECORDING_EXISTS');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'COMPLETED_RECORDING_EXISTS') throw error;
        throw new RecordedStateFailure();
      }
      let cleanupSessions: Set<string>;
      try {
        cleanupSessions = await this.restoreAllUnlocked();
      } catch (error) {
        throw new RecordedStateFailure();
      }
      if (cleanupSessions.has(sessionId)
        || this.cleanupFallbackSessions.has(sessionId)
        || this.active.has(sessionId)) {
        throw new Error('ACTIVE_RECORDING_EXISTS');
      }
      const startedAt = this.now();
      if (!Number.isSafeInteger(tabId) || tabId < 1 || tabId > MAX_CHROME_TAB_ID
        || !Number.isSafeInteger(startedAt)
        || startedAt < 0
        || startedAt > MAX_RECORDING_TIMESTAMP_MS) {
        throw new RecordedStateFailure();
      }
      const sanitizedUrl = sanitizePageUrl(url);
      url = '';
      const state: ActiveRecording = {
        sessionId,
        tabId,
        nextVariable: 1,
        status: 'active',
        recording: {
          name: canonicalName,
          startedAt,
          url: sanitizedUrl,
          steps: [],
          requiredVariables: [],
        },
      };
      const completedProjection = { ...state.recording, stoppedAt: Number.MAX_SAFE_INTEGER };
      if (byteLength(completedProjection) + COMMIT_OVERHEAD_BYTES > this.limits.maxRecordingBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }
      if (this.aggregateReservedBytesWith(state) > this.limits.maxAggregateBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }
      this.active.set(sessionId, state);
      try {
        await this.persistActiveUnlocked(state);
      } catch {
        await this.rollbackFailedStartPersistenceUnlocked(state);
        throw new RecordedStateFailure();
      }
      try {
        await this.scheduler.ensureRenewal();
      } catch {
        this.active.delete(sessionId);
        try {
          await this.removeActiveStateUnlocked(sessionId);
        } catch {
          // A later restore rejects incomplete state before renewal.
        }
        throw new Error('SCHEDULE_RENEWAL_FAILED');
      }
    });
  }

  prepareStep(
    sessionId: string,
    toolName: ToolName,
    args: Record<string, unknown>,
    tabId: number,
  ): Promise<PreparedStep | null> {
    return this.enqueue(async () => {
      await this.restoreAllUnlocked();
      if (this.closedSessions.has(sessionId)) return null;
      const active = this.active.get(sessionId);
      if (!active || this.replaying.has(sessionId) || active.tabId !== tabId) return null;
      if (active.status !== 'active') return null;
      if ([...this.pending.values()].some((entry) => entry.sessionId === sessionId)) {
        throw new Error('RECORDING_ACTION_IN_PROGRESS');
      }
      if (active.recording.steps.length >= this.limits.maxSteps) {
        throw new Error('RECORDING_STATE_LIMIT');
      }

      const parameterState = { nextVariable: active.nextVariable };
      const parameterized = parameterizeArgs(toolName, args, parameterState);
      args = {};
      const timestamp = this.now();
      if (!Number.isSafeInteger(timestamp)
        || timestamp < 0
        || timestamp > MAX_RECORDING_TIMESTAMP_MS) throw new RecordedStateFailure();
      const conservativeStep: RecordedStep = {
        action: toolName,
        args: parameterized.args,
        timestamp: MAX_RECORDING_TIMESTAMP_MS,
        durationMs: 0,
        url: '\u0000'.repeat(MAX_RECORDED_URL_LENGTH),
      };
      const projectedActiveRecording: Recording = {
        ...active.recording,
        steps: [...active.recording.steps, conservativeStep],
        requiredVariables: [
          ...active.recording.requiredVariables,
          ...parameterized.requiredVariables,
        ],
      };
      const projectedRecording: Recording & { stoppedAt: number } = {
        ...projectedActiveRecording,
        stoppedAt: MAX_RECORDING_TIMESTAMP_MS,
      };
      const finalReservedBytes = byteLength(projectedRecording)
        + COMMIT_DURATION_JSON_SLACK_BYTES
        + COMMIT_OVERHEAD_BYTES;
      if (finalReservedBytes > this.limits.maxRecordingBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }

      const projectedActive: ActiveRecording = {
        ...active,
        nextVariable: parameterState.nextVariable,
        recording: projectedActiveRecording,
      };
      const reservedAggregateDelta = Math.max(
        0,
        this.reservedStateBytes(projectedActive) - this.reservedStateBytes(active),
      )
        + COMMIT_DURATION_JSON_SLACK_BYTES
        + COMMIT_OVERHEAD_BYTES;
      if (this.aggregateReservedBytesWith() + reservedAggregateDelta
        > this.limits.maxAggregateBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }

      const prepared: PreparedStep = {
        id: `prepared_${++this.preparedCounter}`,
        beganUnderRecording: true,
        action: toolName,
        args: parameterized.args,
        timestamp,
        requiredVariables: parameterized.requiredVariables,
        nextVariable: parameterState.nextVariable,
        finalReservedBytes,
      };
      this.pending.set(prepared.id, {
        sessionId,
        baseStepCount: active.recording.steps.length,
        baseNextVariable: active.nextVariable,
        finalReservedBytes,
        reservedAggregateDelta,
      });
      return clone(prepared);
    });
  }

  commitStep(
    sessionId: string,
    prepared: PreparedStep,
    details: { durationMs: number; currentUrl: string },
  ): Promise<void> {
    return this.enqueue(async () => {
      const reservation = this.pending.get(prepared.id);
      const active = this.active.get(sessionId);
      if (
        !reservation
        || reservation.sessionId !== sessionId
        || this.closedSessions.has(sessionId)
        || !active
        || active.status !== 'active'
        || active.recording.steps.length !== reservation.baseStepCount
        || active.nextVariable !== reservation.baseNextVariable
        || prepared.finalReservedBytes !== reservation.finalReservedBytes
      ) {
        throw new Error('INVALID_PREPARED_RECORDING_STEP');
      }

      const sanitizedUrl = sanitizePageUrl(details.currentUrl);
      details.currentUrl = '';
      const step: RecordedStep = {
        action: prepared.action,
        args: clone(prepared.args),
        timestamp: prepared.timestamp,
        durationMs: Number.isFinite(details.durationMs)
          ? Math.min(MAX_RECORDED_DURATION_MS, Math.max(0, details.durationMs))
          : 0,
        url: sanitizedUrl,
      };
      const updated: ActiveRecording = {
        ...active,
        nextVariable: prepared.nextVariable,
        recording: {
          ...active.recording,
          steps: [...active.recording.steps, step],
          requiredVariables: [
            ...active.recording.requiredVariables,
            ...clone(prepared.requiredVariables),
          ],
        },
      };
      const completedProjection = {
        ...updated.recording,
        stoppedAt: MAX_RECORDING_TIMESTAMP_MS,
      };
      if (byteLength(completedProjection) > reservation.finalReservedBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }
      if (this.aggregateReservedBytesWith(updated, prepared.id)
        > this.limits.maxAggregateBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }

      this.active.set(sessionId, updated);
      this.pending.delete(prepared.id);
      await this.persistActiveUnlocked(updated);
    });
  }

  discardStep(sessionId: string, prepared: PreparedStep): Promise<void> {
    return this.enqueue(async () => {
      const reservation = this.pending.get(prepared.id);
      if (reservation?.sessionId === sessionId) this.pending.delete(prepared.id);
    });
  }

  stop(sessionId: string): Promise<RecordingStopResult> {
    return this.enqueue(async () => {
      try {
        await this.restoreSessionUnlocked(sessionId);
      } catch {
        throw new RecordedStateFailure();
      }
      let state = this.active.get(sessionId);
      if (!state && this.closedSessions.has(sessionId)) {
        throw new Error('RECORDING_CLEANUP_PENDING');
      }
      if (!state) throw new Error('NO_ACTIVE_RECORDING');
      if (state.status === 'quarantined') throw new RecordedStateFailure();
      if (state.status === 'cleanup') throw new Error('RECORDING_CLEANUP_PENDING');
      if ([...this.pending.values()].some((entry) => entry.sessionId === sessionId)) {
        throw new Error('RECORDING_ACTION_IN_PROGRESS');
      }

      let recording: Recording & { stoppedAt: number };
      if (state.status === 'stopping') {
        recording = clone(state.recording) as Recording & { stoppedAt: number };
      } else {
        const stoppedAt = this.now();
        if (!Number.isSafeInteger(stoppedAt)
          || stoppedAt < 0
          || stoppedAt > MAX_RECORDING_TIMESTAMP_MS) throw new RecordedStateFailure();
        recording = { ...clone(state.recording), stoppedAt };
        const stoppingState: ActiveRecording = {
          ...state,
          status: 'stopping',
          recording,
        };
        if (this.aggregateReservedBytesWith(stoppingState) > this.limits.maxAggregateBytes) {
          throw new RecordedStateFailure();
        }
        this.active.set(sessionId, stoppingState);
        try {
          await this.persistActiveUnlocked(stoppingState);
        } catch {
          this.active.set(sessionId, state);
          return {
            extensionSaved: false,
            serverSaved: false,
            recording,
            error: 'ACTIVE_STATE_PERSIST_FAILED',
          };
        }
        state = stoppingState;
        await this.refreshRenewalAlarmUnlocked();
      }

      if (state.stopStatus?.serverSaved === false) {
        return {
          ...clone(state.stopStatus),
          recording,
        };
      }

      let serverSaved = state.stopStatus?.serverSaved === true;
      if (!serverSaved) {
        try {
          const response = await this.transport.request('persistRecording', {
            sessionId,
            payload: recording,
          }, SERVER_TIMEOUT_MS);
          serverSaved = isRecord(response) && response.ok === true;
        } catch {
          serverSaved = false;
        }

        if (!serverSaved) {
          const result: RecordingStopResult = {
            extensionSaved: false,
            serverSaved: false,
            recording,
            error: 'SERVER_PERSIST_FAILED',
          };
          state = await this.cacheStopStatusUnlocked(state, result);
          return result;
        }

        state = await this.cacheStopStatusUnlocked(state, {
          extensionSaved: false,
          serverSaved: true,
          recording,
        });
      }

      if (state.stopStatus?.extensionSaved !== true) {
        let localError: RecordingStopResult['error'];
        try {
          const localResult = await this.persistCompletedUnlocked(recording);
          if (localResult === 'conflict') localError = 'LOCAL_RECORDING_CONFLICT';
        } catch {
          localError = 'LOCAL_PERSIST_FAILED';
        }

        if (localError) {
          const result: RecordingStopResult = {
            extensionSaved: false,
            serverSaved: true,
            recording,
            error: localError,
          };
          await this.cacheStopStatusUnlocked(state, result);
          await this.finishStopUnlocked(sessionId);
          return result;
        }

        state = await this.cacheStopStatusUnlocked(state, {
          extensionSaved: true,
          serverSaved: true,
          recording,
        });
      }

      const result: RecordingStopResult = {
        extensionSaved: true,
        serverSaved: true,
        recording,
      };
      if (!await this.finishStopUnlocked(sessionId)) {
        result.error = 'ACTIVE_STATE_CLEANUP_FAILED';
      }
      return result;
    });
  }

  private async cacheStopStatusUnlocked(
    state: ActiveRecording,
    result: RecordingStopResult,
  ): Promise<ActiveRecording> {
    const updated: ActiveRecording = {
      ...state,
      stopStatus: {
        extensionSaved: result.extensionSaved,
        serverSaved: result.serverSaved,
        ...(result.error ? { error: result.error } : {}),
      },
    };
    if (this.aggregateReservedBytesWith(updated) > this.limits.maxAggregateBytes) {
      throw new RecordedStateFailure();
    }
    this.active.set(updated.sessionId, updated);
    try {
      await this.persistActiveUnlocked(updated);
    } catch {
      // The sanitized in-memory result remains retryable; restart retries the last durable phase.
    }
    return updated;
  }

  setReplaying(sessionId: string, replaying: boolean): void {
    if (replaying) this.replaying.add(sessionId);
    else this.replaying.delete(sessionId);
  }

  async abortSession(sessionId: string): Promise<void> {
    this.closedSessions.add(sessionId);
    try { await this.scheduler.ensureCleanup(sessionId); } catch { /* queued cleanup still runs */ }
    try {
      await this.enqueue(() => this.abortSessionUnlocked(sessionId));
    } catch {
      throw new RecordedStateFailure();
    }
  }

  expireReservation(sessionId: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      await this.restoreSessionUnlocked(sessionId);
      const state = this.active.get(sessionId);
      if (state?.status === 'active' && state.recording.name === name) {
        await this.finishStopUnlocked(sessionId);
      }
    });
  }

  restoreSession(sessionId: string): Promise<boolean> {
    return this.enqueue(() => this.restoreSessionUnlocked(sessionId));
  }

  renewPersistedSessions(): Promise<void> {
    return this.enqueue(async () => {
      const cleanupSessions = await this.retryCleanupAlarmsUnlocked();
      const sessionIds = await this.persistedSessionIdsUnlocked();
      for (const sessionId of sessionIds) {
        if (cleanupSessions.has(sessionId)) continue;
        const restored = await this.restoreSessionUnlocked(sessionId, false);
        if (!restored) continue;
        const active = this.active.get(sessionId)!;
        if (active.status === 'cleanup') {
          await this.finishStopUnlocked(sessionId);
          continue;
        }
        if (active.status !== 'active' && active.status !== 'quarantined') continue;
        try {
          const response = await this.transport.request('renewRecordingReservation', {
            sessionId,
            name: active.recording.name,
          }, SERVER_TIMEOUT_MS);
          if (this.closedSessions.has(sessionId)
            || !isRecord(response)
            || response.ok !== true) {
            await this.finishStopUnlocked(sessionId);
          } else if (active.status === 'quarantined') {
            const promoted: ActiveRecording = { ...active, status: 'active' };
            this.active.set(sessionId, promoted);
            try {
              await this.persistActiveUnlocked(promoted);
            } catch {
              await this.finishStopUnlocked(sessionId);
            }
          }
        } catch {
          if (active.status === 'quarantined' || this.closedSessions.has(sessionId)) {
            await this.finishStopUnlocked(sessionId);
          }
          // Same-worker active state retains its existing authority on transient renewal failure.
        }
      }
    });
  }

  retryCleanupStates(): Promise<void> {
    return this.enqueue(async () => {
      const cleanupSessions = await this.retryCleanupAlarmsUnlocked();
      const sessionIds = new Set(await this.persistedSessionIdsUnlocked());
      for (const sessionId of this.active.keys()) sessionIds.add(sessionId);
      for (const sessionId of sessionIds) {
        if (cleanupSessions.has(sessionId)) continue;
        await this.restoreSessionUnlocked(sessionId, false);
        if (this.active.get(sessionId)?.status === 'cleanup') {
          await this.finishStopUnlocked(sessionId);
        }
      }
    });
  }

  retryCleanupSession(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isValidV2SessionId(sessionId)) throw new RecordedStateFailure();
      await this.retryCleanupSessionUnlocked(sessionId);
    });
  }

  snapshot(): {
    active: ActiveRecording[];
    replayingSessions: string[];
    prepared: Array<{ id: string; sessionId: string }>;
  } {
    return clone({
      active: [...this.active.values()].filter((state) => (
        state.status === 'active' || state.status === 'stopping'
      )),
      replayingSessions: [...this.replaying].sort(),
      prepared: [...this.pending].map(([id, reservation]) => ({
        id,
        sessionId: reservation.sessionId,
      })),
    });
  }

  isRecording(sessionId: string): boolean {
    const status = this.active.get(sessionId)?.status;
    return status === 'active' || status === 'stopping';
  }

  private async restoreAllUnlocked(): Promise<Set<string>> {
    const cleanupSessions = await this.retryCleanupAlarmsUnlocked();
    const sessionIds = new Set(await this.persistedSessionIdsUnlocked());
    for (const sessionId of this.cleanupFallbackSessions) cleanupSessions.add(sessionId);
    for (const sessionId of this.active.keys()) sessionIds.add(sessionId);
    for (const sessionId of sessionIds) {
      if (cleanupSessions.has(sessionId)) continue;
      await this.restoreSessionUnlocked(sessionId, false);
      if (this.active.get(sessionId)?.status === 'cleanup') {
        cleanupSessions.add(sessionId);
        await this.finishStopUnlocked(sessionId);
      }
    }
    return cleanupSessions;
  }

  private async restoreSessionUnlocked(
    sessionId: string,
    consultCleanupAlarms = true,
  ): Promise<boolean> {
    if (consultCleanupAlarms) {
      const cleanupSessions = new Set(await this.scheduler.getCleanupSessionIds());
      if (cleanupSessions.has(sessionId)) {
        await this.retryCleanupSessionUnlocked(sessionId);
        return false;
      }
    }
    const marker = await this.sessionStorage.get<unknown>(`${ACTIVE_MARKER_PREFIX}${sessionId}`);
    if (!isRecordingMarker(marker, sessionId)) {
      await this.removeActiveStateUnlocked(sessionId);
      return false;
    }
    const inMemory = this.active.get(sessionId);
    if (inMemory) {
      this.persistedFootprints.set(sessionId, this.reservedStateBytes(inMemory));
      if (this.closedSessions.has(sessionId) && inMemory.status === 'cleanup') return true;
      if (inMemory.status === marker.status
        || (inMemory.status === 'quarantined' && marker.status === 'active')) return true;
      await this.removeActiveStateUnlocked(sessionId);
      return false;
    }
    const stored = await this.sessionStorage.get<unknown>(`${ACTIVE_PREFIX}${sessionId}`);
    if (!isActiveRecording(stored, sessionId) || stored.status !== marker.status) {
      await this.removeActiveStateUnlocked(sessionId);
      return false;
    }
    const completedProjection = { ...stored.recording, stoppedAt: Number.MAX_SAFE_INTEGER };
    if (stored.recording.steps.length > this.limits.maxSteps
      || byteLength(completedProjection) + COMMIT_OVERHEAD_BYTES > this.limits.maxRecordingBytes) {
      await this.removeActiveStateUnlocked(sessionId);
      return false;
    }
    const restored: ActiveRecording = stored.status === 'active'
      ? { ...clone(stored), status: 'quarantined' }
      : clone(stored);
    this.persistedFootprints.set(sessionId, this.reservedStateBytes(stored));
    this.active.set(sessionId, restored);
    if (this.aggregateReservedBytesWith() > this.limits.maxAggregateBytes) {
      this.active.delete(sessionId);
      await this.removeActiveStateUnlocked(sessionId);
      return false;
    }
    if (stored.status === 'active') await this.scheduler.ensureRenewal();
    else if (stored.status === 'cleanup') {
      try { await this.scheduler.ensureCleanup(sessionId); } catch { /* persisted cleanup is authoritative */ }
      await this.refreshRenewalAlarmUnlocked();
    } else await this.refreshRenewalAlarmUnlocked();
    return true;
  }

  private reservedStateBytes(state: ActiveRecording): number {
    const persisted = state.status === 'quarantined'
      ? { ...state, status: 'active' as const }
      : state;
    const currentBytes = byteLength(persisted)
      + byteLength({ sessionId: state.sessionId, status: persisted.status });
    if (persisted.status === 'cleanup') return currentBytes;
    const stopped: ActiveRecording = {
      ...persisted,
      status: 'stopping',
      stopStatus: WORST_STOP_STATUS,
      recording: {
        ...persisted.recording,
        stoppedAt: MAX_RECORDING_TIMESTAMP_MS,
      },
    };
    const stoppedBytes = byteLength(stopped)
      + byteLength({ sessionId: state.sessionId, status: stopped.status });
    return Math.max(currentBytes, stoppedBytes);
  }

  private aggregateReservedBytesWith(
    replacement?: ActiveRecording,
    excludedPendingId?: string,
  ): number {
    const footprints = new Map(this.persistedFootprints);
    for (const [sessionId, state] of this.active) {
      footprints.set(sessionId, this.reservedStateBytes(state));
    }
    if (replacement) {
      footprints.set(replacement.sessionId, this.reservedStateBytes(replacement));
    }
    let total = [...footprints.values()].reduce((sum, bytes) => sum + bytes, 0);
    for (const [id, reservation] of this.pending) {
      if (id !== excludedPendingId) total += reservation.reservedAggregateDelta;
    }
    return total;
  }

  private async persistActiveUnlocked(state: ActiveRecording): Promise<void> {
    if (state.status === 'quarantined') throw new RecordedStateFailure();
    this.persistedFootprints.set(state.sessionId, this.reservedStateBytes(state));
    await this.sessionStorage.setMany({
      [`${ACTIVE_PREFIX}${state.sessionId}`]: clone(state),
      [`${ACTIVE_MARKER_PREFIX}${state.sessionId}`]: {
        sessionId: state.sessionId,
        status: state.status,
      },
    });
  }

  private async rollbackFailedStartPersistenceUnlocked(state: ActiveRecording): Promise<void> {
    this.cleanupFallbackSessions.add(state.sessionId);
    const cleanupState: ActiveRecording = { ...state, status: 'cleanup' };
    this.closedSessions.add(state.sessionId);
    this.active.delete(state.sessionId);
    try { await this.scheduler.ensureCleanup(state.sessionId); } catch { /* persisted cleanup is fallback */ }
    try { await this.persistActiveUnlocked(cleanupState); } catch { /* alarm or partial write remains authoritative */ }
    await this.retryCleanupSessionUnlocked(state.sessionId);
  }

  private async persistedSessionIdsUnlocked(): Promise<string[]> {
    const keys = await this.sessionStorage.getKeys();
    const invalidMarkerKeys = keys.filter((key) => {
      if (!key.startsWith(ACTIVE_MARKER_PREFIX)) return false;
      return !isValidV2SessionId(key.slice(ACTIVE_MARKER_PREFIX.length));
    });
    if (invalidMarkerKeys.length > 0) {
      await this.sessionStorage.removeMany(invalidMarkerKeys.flatMap((key) => {
        const sessionId = key.slice(ACTIVE_MARKER_PREFIX.length);
        return [key, `${ACTIVE_PREFIX}${sessionId}`];
      }));
    }
    const sessionIds = new Set(keys
      .filter((key) => key.startsWith(ACTIVE_MARKER_PREFIX))
      .map((key) => key.slice(ACTIVE_MARKER_PREFIX.length))
      .filter(isValidV2SessionId));
    if (keys.includes(LEGACY_ACTIVE_INDEX_KEY)) {
      await this.sessionStorage.removeMany([LEGACY_ACTIVE_INDEX_KEY]);
    }
    const orphanSnapshotSessionIds = keys.flatMap((key) => {
      if (!key.startsWith(ACTIVE_PREFIX)) return [];
      const sessionId = key.slice(ACTIVE_PREFIX.length);
      return keys.includes(`${ACTIVE_MARKER_PREFIX}${sessionId}`) ? [] : [sessionId];
    });
    for (const sessionId of orphanSnapshotSessionIds) {
      this.cleanupFallbackSessions.add(sessionId);
      await this.retryCleanupSessionUnlocked(sessionId);
    }
    return [...sessionIds].sort();
  }

  private async removeActiveStateUnlocked(sessionId: string): Promise<void> {
    await this.sessionStorage.removeMany([
      `${ACTIVE_PREFIX}${sessionId}`,
      `${ACTIVE_MARKER_PREFIX}${sessionId}`,
    ]);
    this.persistedFootprints.delete(sessionId);
    this.cleanupFallbackSessions.delete(sessionId);
    this.active.delete(sessionId);
    this.replaying.delete(sessionId);
    for (const [id, reservation] of this.pending) {
      if (reservation.sessionId === sessionId) this.pending.delete(id);
    }
    this.closedSessions.delete(sessionId);
  }

  private async persistCompletedUnlocked(
    recording: Recording & { stoppedAt: number },
  ): Promise<'created' | 'existing-identical' | 'conflict'> {
    const key = `${COMPLETED_PREFIX}${recording.name}`;
    const digestKey = `${COMPLETED_DIGEST_PREFIX}${recording.name}`;
    const serialized = JSON.stringify(recording);
    const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    const digest = [...new Uint8Array(digestBytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const [exists, digestExists] = await Promise.all([
      this.localStorage.has(key),
      this.localStorage.has(digestKey),
    ]);
    if (exists || digestExists) {
      if (!exists || !digestExists) return 'conflict';
      const existingDigest = await this.localStorage.get<unknown>(digestKey);
      if (existingDigest !== digest) return 'conflict';
      const existing = await this.localStorage.get<unknown>(key);
      if (!isSanitizedRecording(existing) || JSON.stringify(existing) !== serialized) return 'conflict';
      return 'existing-identical';
    }
    await this.localStorage.setMany({ [key]: recording, [digestKey]: digest });
    return 'created';
  }

  private async finishStopUnlocked(sessionId: string): Promise<boolean> {
    const current = this.active.get(sessionId);
    if (!current) return true;
    try { await this.scheduler.ensureCleanup(sessionId); } catch { /* persisted cleanup is fallback */ }
    if (current.status !== 'cleanup') {
      const cleanupState: ActiveRecording = { ...current, status: 'cleanup' };
      if (this.aggregateReservedBytesWith(cleanupState) > this.limits.maxAggregateBytes) {
        return false;
      }
      this.active.set(sessionId, cleanupState);
      try {
        await this.persistActiveUnlocked(cleanupState);
      } catch {
        try { await this.scheduler.ensureCleanup(sessionId); } catch { /* retried on restore/startup */ }
        await this.refreshRenewalAlarmUnlocked();
        return false;
      }
    }
    await this.refreshRenewalAlarmUnlocked();
    try {
      await this.removeActiveStateUnlocked(sessionId);
    } catch {
      this.hideSessionForCleanupUnlocked(sessionId);
      try { await this.scheduler.ensureCleanup(sessionId); } catch { /* retried on restore/startup */ }
      return false;
    }
    await this.refreshRenewalAlarmUnlocked();
    try { await this.scheduler.clearCleanup(sessionId); } catch { /* stale tombstones retry safely */ }
    return true;
  }

  private async retryCleanupAlarmsUnlocked(): Promise<Set<string>> {
    const cleanupSessions = new Set(await this.scheduler.getCleanupSessionIds());
    for (const sessionId of this.cleanupFallbackSessions) cleanupSessions.add(sessionId);
    for (const sessionId of cleanupSessions) {
      await this.retryCleanupSessionUnlocked(sessionId);
    }
    return cleanupSessions;
  }

  private async retryCleanupSessionUnlocked(sessionId: string): Promise<boolean> {
    await this.accountCleanupFootprintUnlocked(sessionId);
    this.hideSessionForCleanupUnlocked(sessionId);
    try {
      await this.removeActiveStateUnlocked(sessionId);
    } catch {
      this.closedSessions.add(sessionId);
      try { await this.scheduler.ensureCleanup(sessionId); } catch { /* periodic retry remains best effort */ }
      return false;
    }
    try { await this.scheduler.clearCleanup(sessionId); } catch { /* stale tombstones retry safely */ }
    return true;
  }

  private async accountCleanupFootprintUnlocked(sessionId: string): Promise<void> {
    if (this.persistedFootprints.has(sessionId)) return;
    const keys = [`${ACTIVE_MARKER_PREFIX}${sessionId}`, `${ACTIVE_PREFIX}${sessionId}`];
    try {
      const bytes = await this.sessionStorage.getBytesInUse(keys);
      this.persistedFootprints.set(
        sessionId,
        Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : this.limits.maxAggregateBytes,
      );
    } catch {
      this.persistedFootprints.set(sessionId, this.limits.maxAggregateBytes);
    }
  }

  private hideSessionForCleanupUnlocked(sessionId: string): void {
    this.closedSessions.add(sessionId);
    this.active.delete(sessionId);
    this.replaying.delete(sessionId);
    for (const [id, reservation] of this.pending) {
      if (reservation.sessionId === sessionId) this.pending.delete(id);
    }
  }

  private async refreshRenewalAlarmUnlocked(): Promise<void> {
    try {
      const keys = await this.sessionStorage.getKeys();
      let hasActive = [...this.active.values()].some((state) => state.status === 'active');
      for (const key of keys) {
        if (hasActive || !key.startsWith(ACTIVE_MARKER_PREFIX)) continue;
        const sessionId = key.slice(ACTIVE_MARKER_PREFIX.length);
        const marker = await this.sessionStorage.get<unknown>(key);
        if (isRecordingMarker(marker, sessionId) && marker.status === 'active') hasActive = true;
      }
      if (hasActive) await this.scheduler.ensureRenewal();
      else await this.scheduler.clearRenewal();
    } catch {
      // Stale alarms are harmless because renewal ignores non-active states.
    }
  }

  private async abortSessionUnlocked(sessionId: string): Promise<void> {
    await this.restoreSessionUnlocked(sessionId, false);
    await this.finishStopUnlocked(sessionId);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.withAccounting(operation);
    const result = this.operationChain.then(run, run);
    this.operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private withAccounting<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.accountingChain.then(operation, operation);
    this.accountingChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function runRecordedAction<T>(options: {
  manager: RecordingManager;
  sessionId: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  tabId: number;
  run: () => Promise<T>;
  currentUrl: () => Promise<string>;
}): Promise<T> {
  let prepared: PreparedStep | null;
  try {
    prepared = await options.manager.prepareStep(
      options.sessionId,
      options.toolName,
      options.args,
      options.tabId,
    );
  } catch (error) {
    options.args = {};
    if (error instanceof Error && error.message === 'RECORDING_STATE_LIMIT') throw error;
    throw new RecordedStateFailure();
  }
  options.args = {};
  const startedAt = performance.now();
  let result: T;
  try {
    result = await options.run();
  } catch (error) {
    if (prepared) await options.manager.discardStep(options.sessionId, prepared);
    if (prepared?.beganUnderRecording) throw new RecordedActionFailure();
    throw error;
  }

  if (!prepared) return result;
  let currentUrl = '';
  try {
    currentUrl = await options.currentUrl();
  } catch {
    // The action succeeded; an unavailable page URL is recorded as empty metadata.
  }
  try {
    await options.manager.commitStep(options.sessionId, prepared, {
      durationMs: performance.now() - startedAt,
      currentUrl,
    });
  } catch {
    await options.manager.discardStep(options.sessionId, prepared);
    throw new Error('RECORDING_COMMIT_FAILED');
  }
  return result;
}

const completedStorage = (): RecordingStorage => new ChromeStorageAdapter(chrome.storage.local);

export async function loadRecordingFromStorage(
  name: string,
  storage: RecordingStorage = completedStorage(),
): Promise<Recording | null> {
  const canonicalName = canonicalizeRecordingName(name);
  const key = `${COMPLETED_PREFIX}${canonicalName}`;
  const recording = await storage.get<unknown>(key);
  if (recording === undefined) return null;
  if (!isSanitizedRecording(recording) || recording.name !== canonicalName) {
    await storage.remove(key);
    await storage.remove(`${COMPLETED_DIGEST_PREFIX}${canonicalName}`);
    return null;
  }
  return recording;
}

const UNSUPPORTED_REPLAY_ACTIONS = new Set([
  'new_tab',
  'select_tab',
  'close_tab',
  'browser_new_tab',
  'browser_select_tab',
  'browser_close_tab',
]);

function inspectStoredRecording(value: unknown): Omit<RecordingListEntry, 'name'> {
  if (!isRecord(value)) return { compatible: false, reason: 'RECORDING_INVALID' };
  const stepsDescriptor = Object.getOwnPropertyDescriptor(value, 'steps');
  if (!stepsDescriptor || !('value' in stepsDescriptor) || !Array.isArray(stepsDescriptor.value)) {
    return { compatible: false, reason: 'RECORDING_INVALID' };
  }
  for (let index = 0; index < stepsDescriptor.value.length; index += 1) {
    const stepDescriptor = Object.getOwnPropertyDescriptor(stepsDescriptor.value, String(index));
    if (!stepDescriptor || !('value' in stepDescriptor) || !isRecord(stepDescriptor.value)) {
      return { compatible: false, reason: 'RECORDING_INVALID' };
    }
    const actionDescriptor = Object.getOwnPropertyDescriptor(stepDescriptor.value, 'action');
    if (!actionDescriptor || !('value' in actionDescriptor)
      || typeof actionDescriptor.value !== 'string') {
      return { compatible: false, reason: 'RECORDING_INVALID' };
    }
    if (UNSUPPORTED_REPLAY_ACTIONS.has(actionDescriptor.value)) {
      return { compatible: false, reason: 'RECORDING_UNSUPPORTED_MULTI_TAB' };
    }
  }
  return { compatible: true };
}

export async function listRecordingsFromStorage(
  storage: RecordingStorage = completedStorage(),
): Promise<RecordingListEntry[]> {
  const keys = (await storage.getKeys())
    .filter((key) => key.startsWith(COMPLETED_PREFIX))
    .sort();
  return Promise.all(keys.map(async (key) => {
    const name = key.slice(COMPLETED_PREFIX.length);
    const compatibility = inspectStoredRecording(await storage.get<unknown>(key));
    return { name, ...compatibility };
  }));
}

export async function loadRecordingForReplay(
  name: string,
  storage: RecordingStorage = completedStorage(),
): Promise<Recording | null> {
  const canonicalName = canonicalizeRecordingName(name);
  const key = `${COMPLETED_PREFIX}${canonicalName}`;
  const value = await storage.get<unknown>(key);
  if (value === undefined) return null;
  const compatibility = inspectStoredRecording(value);
  if (compatibility.reason === 'RECORDING_UNSUPPORTED_MULTI_TAB') {
    throw new Error('RECORDING_UNSUPPORTED_MULTI_TAB');
  }
  if (!compatibility.compatible
    || !isSanitizedRecording(value)
    || value.name !== canonicalName) {
    await storage.remove(key);
    await storage.remove(`${COMPLETED_DIGEST_PREFIX}${canonicalName}`);
    throw new Error('RECORDING_INVALID');
  }
  return value;
}

export async function deleteRecordingFromStorage(name: string): Promise<void> {
  const canonicalName = canonicalizeRecordingName(name);
  const storage = completedStorage();
  await storage.remove(`${COMPLETED_PREFIX}${canonicalName}`);
  await storage.remove(`${COMPLETED_DIGEST_PREFIX}${canonicalName}`);
}
