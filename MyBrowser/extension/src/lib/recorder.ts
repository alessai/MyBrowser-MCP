import {
  MAX_RECORDED_URL_LENGTH,
  parameterizeArgs,
  sanitizePageUrl,
  validateSanitizedArgs,
  type RequiredVariable,
  type VariableSource,
} from './recording-parameterizer';
import type { ToolName } from './tool-metadata';

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

export interface RecordingStorage {
  get<T>(key: string): Promise<T | undefined>;
  has(key: string): Promise<boolean>;
  getKeys(): Promise<string[]>;
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
  ensureCleanup(): Promise<void>;
  clearCleanup(): Promise<void>;
}

export interface PreparedStep {
  readonly id: string;
  readonly beganUnderRecording: true;
  readonly action: ToolName;
  readonly args: Record<string, unknown>;
  readonly timestamp: number;
  readonly requiredVariables: RequiredVariable[];
  readonly nextVariable: number;
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

type RecordingStateStatus = 'active' | 'stopping' | 'cleanup';
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
  status: RecordingStateStatus;
}

interface PendingReservation {
  sessionId: string;
  baseStepCount: number;
  baseNextVariable: number;
  reservedRecordingBytes: number;
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
export const RECORDING_RENEWAL_ALARM = 'active-recordings-renewal';
export const RECORDING_RENEWAL_MINUTES = 5;
export const RECORDING_CLEANUP_ALARM = 'active-recordings-cleanup';
export const RECORDING_CLEANUP_MINUTES = 1;

const ACTIVE_PREFIX = 'active-recording:';
const ACTIVE_MARKER_PREFIX = 'active-recording-index:';
const LEGACY_ACTIVE_INDEX_KEY = 'active-recording-index';
const COMPLETED_PREFIX = 'recording:';
const COMPLETED_DIGEST_PREFIX = 'recording-digest:';
const SERVER_TIMEOUT_MS = 10_000;
const COMMIT_OVERHEAD_BYTES = 1_024;

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
    chrome.alarms.create(RECORDING_RENEWAL_ALARM, {
      periodInMinutes: RECORDING_RENEWAL_MINUTES,
    });
  }

  async clearRenewal(): Promise<void> {
    await chrome.alarms.clear(RECORDING_RENEWAL_ALARM);
  }

  async ensureCleanup(): Promise<void> {
    chrome.alarms.create(RECORDING_CLEANUP_ALARM, {
      periodInMinutes: RECORDING_CLEANUP_MINUTES,
    });
  }

  async clearCleanup(): Promise<void> {
    await chrome.alarms.clear(RECORDING_CLEANUP_ALARM);
  }
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
  if (!Number.isInteger(value.tabId) || (value.tabId as number) < 0) return false;
  if (!Number.isInteger(value.nextVariable) || (value.nextVariable as number) < 1) return false;
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
    || !Number.isFinite(recording.startedAt)
    || recording.startedAt < 0
    || typeof recording.url !== 'string') return false;
  if (value.status === 'active' && (hasStoppedAt || 'stopStatus' in value)) return false;
  if (value.status === 'stopping' && (!hasStoppedAt
    || typeof recording.stoppedAt !== 'number'
    || !Number.isFinite(recording.stoppedAt)
    || recording.stoppedAt < 0)) return false;
  if (value.status === 'cleanup' && hasStoppedAt && (
    typeof recording.stoppedAt !== 'number'
    || !Number.isFinite(recording.stoppedAt)
    || recording.stoppedAt < 0
  )) return false;
  if (!Array.isArray(recording.steps) || !Array.isArray(recording.requiredVariables)) return false;
  if (recording.steps.length > MAX_ACTIVE_RECORDING_STEPS
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
    if (typeof step.timestamp !== 'number' || !Number.isFinite(step.timestamp) || step.timestamp < 0) return false;
    if (typeof step.durationMs !== 'number' || !Number.isFinite(step.durationMs) || step.durationMs < 0) return false;
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
    || !Number.isFinite(value.stoppedAt)
    || value.stoppedAt < 0) {
    return false;
  }
  return isActiveRecording({
    sessionId: 'validation',
    tabId: 0,
    nextVariable: Array.isArray(value.requiredVariables) ? value.requiredVariables.length + 1 : 1,
    status: 'stopping',
    recording: value,
  }, 'validation');
}

export class RecordingManager {
  private readonly active = new Map<string, ActiveRecording>();
  private readonly replaying = new Set<string>();
  private readonly pending = new Map<string, PendingReservation>();
  private readonly sessionStorage: RecordingStorage;
  private readonly localStorage: RecordingStorage;
  private readonly transport: RecordingTransport;
  private readonly scheduler: RecordingAlarmScheduler;
  private readonly limits: RecordingLimits;
  private readonly now: () => number;
  private operationChain: Promise<void> = Promise.resolve();
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
      const cleanupSessions = await this.restoreAllUnlocked();
      if (cleanupSessions.has(sessionId) || this.active.has(sessionId)) {
        throw new Error('ACTIVE_RECORDING_EXISTS');
      }
      const sanitizedUrl = sanitizePageUrl(url);
      url = '';
      const state: ActiveRecording = {
        sessionId,
        tabId,
        nextVariable: 1,
        status: 'active',
        recording: {
          name,
          startedAt: this.now(),
          url: sanitizedUrl,
          steps: [],
          requiredVariables: [],
        },
      };
      const completedProjection = { ...state.recording, stoppedAt: Number.MAX_SAFE_INTEGER };
      if (byteLength(completedProjection) + COMMIT_OVERHEAD_BYTES > this.limits.maxRecordingBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }
      const aggregateBytes = this.aggregateBytesWith(state);
      if (aggregateBytes + COMMIT_OVERHEAD_BYTES > this.limits.maxAggregateBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }
      this.active.set(sessionId, state);
      try {
        await this.persistActiveUnlocked(state);
        await this.scheduler.ensureRenewal();
      } catch {
        this.active.delete(sessionId);
        try {
          await this.removeActiveStateUnlocked(sessionId);
        } catch {
          // A later restore rejects incomplete state before renewal.
        }
        throw new Error('RECORDING_START_FAILED');
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
      const conservativeStep: RecordedStep = {
        action: toolName,
        args: parameterized.args,
        timestamp,
        durationMs: Number.MAX_SAFE_INTEGER,
        url: 'x'.repeat(MAX_RECORDED_URL_LENGTH * 6),
      };
      const projectedRecording: Recording & { stoppedAt: number } = {
        ...active.recording,
        stoppedAt: Number.MAX_SAFE_INTEGER,
        steps: [...active.recording.steps, conservativeStep],
        requiredVariables: [
          ...active.recording.requiredVariables,
          ...parameterized.requiredVariables,
        ],
      };
      const reservedRecordingBytes = byteLength(projectedRecording) + COMMIT_OVERHEAD_BYTES;
      if (reservedRecordingBytes > this.limits.maxRecordingBytes) {
        throw new Error('RECORDING_STATE_LIMIT');
      }

      const projectedActive: ActiveRecording = {
        ...active,
        nextVariable: parameterState.nextVariable,
        recording: projectedRecording,
      };
      const currentBytes = byteLength(active);
      const projectedBytes = byteLength(projectedActive);
      const reservedAggregateDelta = Math.max(0, projectedBytes - currentBytes)
        + COMMIT_OVERHEAD_BYTES;
      const pendingBytes = [...this.pending.values()]
        .reduce((total, entry) => total + entry.reservedAggregateDelta, 0);
      const aggregateBytes = this.aggregateBytesWith();
      if (aggregateBytes + pendingBytes + reservedAggregateDelta > this.limits.maxAggregateBytes) {
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
      };
      this.pending.set(prepared.id, {
        sessionId,
        baseStepCount: active.recording.steps.length,
        baseNextVariable: active.nextVariable,
        reservedRecordingBytes,
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
        || !active
        || active.status !== 'active'
        || active.recording.steps.length !== reservation.baseStepCount
        || active.nextVariable !== reservation.baseNextVariable
      ) {
        throw new Error('INVALID_PREPARED_RECORDING_STEP');
      }

      const sanitizedUrl = sanitizePageUrl(details.currentUrl);
      details.currentUrl = '';
      const step: RecordedStep = {
        action: prepared.action,
        args: clone(prepared.args),
        timestamp: prepared.timestamp,
        durationMs: Number.isFinite(details.durationMs) ? Math.max(0, details.durationMs) : 0,
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
        stoppedAt: Number.MAX_SAFE_INTEGER,
      };
      if (byteLength(completedProjection) + COMMIT_OVERHEAD_BYTES > reservation.reservedRecordingBytes) {
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
      await this.restoreSessionUnlocked(sessionId);
      let state = this.active.get(sessionId);
      if (!state) throw new Error('NO_ACTIVE_RECORDING');
      if (state.status === 'cleanup') throw new Error('RECORDING_CLEANUP_PENDING');
      if ([...this.pending.values()].some((entry) => entry.sessionId === sessionId)) {
        throw new Error('RECORDING_ACTION_IN_PROGRESS');
      }

      let recording: Recording & { stoppedAt: number };
      if (state.status === 'stopping') {
        recording = clone(state.recording) as Recording & { stoppedAt: number };
      } else {
        recording = { ...clone(state.recording), stoppedAt: this.now() };
        const stoppingState: ActiveRecording = {
          ...state,
          status: 'stopping',
          recording,
        };
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

  abortSession(sessionId: string): Promise<void> {
    return this.enqueue(() => this.abortSessionUnlocked(sessionId));
  }

  expireReservation(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.restoreSessionUnlocked(sessionId);
      if (this.active.get(sessionId)?.status === 'active') {
        await this.finishStopUnlocked(sessionId);
      }
    });
  }

  restoreSession(sessionId: string): Promise<boolean> {
    return this.enqueue(() => this.restoreSessionUnlocked(sessionId));
  }

  renewPersistedSessions(): Promise<void> {
    return this.enqueue(async () => {
      const sessionIds = await this.persistedSessionIdsUnlocked();
      for (const sessionId of sessionIds) {
        const restored = await this.restoreSessionUnlocked(sessionId);
        if (!restored) continue;
        const active = this.active.get(sessionId)!;
        if (active.status === 'cleanup') {
          await this.finishStopUnlocked(sessionId);
          continue;
        }
        if (active.status !== 'active') continue;
        try {
          const response = await this.transport.request('renewRecordingReservation', {
            sessionId,
            name: active.recording.name,
          }, SERVER_TIMEOUT_MS);
          if (!isRecord(response) || response.ok !== true) {
            await this.finishStopUnlocked(sessionId);
          }
        } catch {
          // Preserve sanitized restart state for the next alarm attempt.
        }
      }
    });
  }

  retryCleanupStates(): Promise<void> {
    return this.enqueue(async () => {
      const sessionIds = new Set(await this.persistedSessionIdsUnlocked());
      for (const sessionId of this.active.keys()) sessionIds.add(sessionId);
      for (const sessionId of sessionIds) {
        await this.restoreSessionUnlocked(sessionId);
        if (this.active.get(sessionId)?.status === 'cleanup') {
          await this.finishStopUnlocked(sessionId);
        }
      }
      await this.refreshCleanupAlarmUnlocked();
    });
  }

  snapshot(): {
    active: ActiveRecording[];
    replayingSessions: string[];
    prepared: Array<{ id: string; sessionId: string }>;
  } {
    return clone({
      active: [...this.active.values()].filter((state) => state.status !== 'cleanup'),
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
    const sessionIds = new Set(await this.persistedSessionIdsUnlocked());
    for (const sessionId of this.active.keys()) sessionIds.add(sessionId);
    const cleanupSessions = new Set<string>();
    for (const sessionId of sessionIds) {
      await this.restoreSessionUnlocked(sessionId);
      if (this.active.get(sessionId)?.status === 'cleanup') {
        cleanupSessions.add(sessionId);
        await this.finishStopUnlocked(sessionId);
      }
    }
    return cleanupSessions;
  }

  private async restoreSessionUnlocked(sessionId: string): Promise<boolean> {
    const marker = await this.sessionStorage.get<unknown>(`${ACTIVE_MARKER_PREFIX}${sessionId}`);
    if (!isRecordingMarker(marker, sessionId)) {
      await this.removeActiveStateUnlocked(sessionId);
      return false;
    }
    const inMemory = this.active.get(sessionId);
    if (inMemory) {
      if (inMemory.status === marker.status) return true;
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
    this.active.set(sessionId, clone(stored));
    if (this.aggregateBytesWith() + COMMIT_OVERHEAD_BYTES
      > this.limits.maxAggregateBytes) {
      this.active.delete(sessionId);
      await this.removeActiveStateUnlocked(sessionId);
      return false;
    }
    if (stored.status === 'active') await this.scheduler.ensureRenewal();
    else if (stored.status === 'cleanup') {
      await this.scheduler.ensureCleanup();
      await this.refreshRenewalAlarmUnlocked();
    } else await this.refreshRenewalAlarmUnlocked();
    return true;
  }

  private aggregateBytesWith(replacement?: ActiveRecording): number {
    let total = 0;
    for (const [sessionId, state] of this.active) {
      total += byteLength(replacement?.sessionId === sessionId ? replacement : state);
      const markerState = replacement?.sessionId === sessionId ? replacement : state;
      total += byteLength({ sessionId, status: markerState.status });
    }
    if (replacement && !this.active.has(replacement.sessionId)) {
      total += byteLength(replacement);
      total += byteLength({ sessionId: replacement.sessionId, status: replacement.status });
    }
    return total;
  }

  private async persistActiveUnlocked(state: ActiveRecording): Promise<void> {
    await this.sessionStorage.setMany({
      [`${ACTIVE_PREFIX}${state.sessionId}`]: clone(state),
      [`${ACTIVE_MARKER_PREFIX}${state.sessionId}`]: {
        sessionId: state.sessionId,
        status: state.status,
      },
    });
  }

  private async persistedSessionIdsUnlocked(): Promise<string[]> {
    const keys = await this.sessionStorage.getKeys();
    const isSessionId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
    const sessionIds = new Set(keys
      .filter((key) => key.startsWith(ACTIVE_MARKER_PREFIX))
      .map((key) => key.slice(ACTIVE_MARKER_PREFIX.length))
      .filter(isSessionId));
    if (keys.includes(LEGACY_ACTIVE_INDEX_KEY)) {
      const orphanSnapshots = keys.filter((key) => {
        if (!key.startsWith(ACTIVE_PREFIX)) return false;
        const sessionId = key.slice(ACTIVE_PREFIX.length);
        return isSessionId(sessionId) && !keys.includes(`${ACTIVE_MARKER_PREFIX}${sessionId}`);
      });
      await this.sessionStorage.removeMany([LEGACY_ACTIVE_INDEX_KEY, ...orphanSnapshots]);
    }
    return [...sessionIds].sort();
  }

  private async removeActiveStateUnlocked(sessionId: string): Promise<void> {
    await this.sessionStorage.removeMany([
      `${ACTIVE_PREFIX}${sessionId}`,
      `${ACTIVE_MARKER_PREFIX}${sessionId}`,
    ]);
    this.active.delete(sessionId);
    this.replaying.delete(sessionId);
    for (const [id, reservation] of this.pending) {
      if (reservation.sessionId === sessionId) this.pending.delete(id);
    }
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
    if (current.status !== 'cleanup') {
      const cleanupState: ActiveRecording = { ...current, status: 'cleanup' };
      this.active.set(sessionId, cleanupState);
      try {
        await this.persistActiveUnlocked(cleanupState);
      } catch {
        try { await this.scheduler.ensureCleanup(); } catch { /* retried on restore/startup */ }
        await this.refreshRenewalAlarmUnlocked();
        return false;
      }
    }
    try { await this.scheduler.ensureCleanup(); } catch { /* removal can still complete */ }
    await this.refreshRenewalAlarmUnlocked();
    try {
      await this.removeActiveStateUnlocked(sessionId);
    } catch {
      try { await this.scheduler.ensureCleanup(); } catch { /* retried on restore/startup */ }
      return false;
    }
    await this.refreshRenewalAlarmUnlocked();
    await this.refreshCleanupAlarmUnlocked();
    return true;
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

  private async refreshCleanupAlarmUnlocked(): Promise<void> {
    try {
      const keys = await this.sessionStorage.getKeys();
      let hasCleanup = [...this.active.values()].some((state) => state.status === 'cleanup');
      for (const key of keys) {
        if (hasCleanup || !key.startsWith(ACTIVE_MARKER_PREFIX)) continue;
        const sessionId = key.slice(ACTIVE_MARKER_PREFIX.length);
        const marker = await this.sessionStorage.get<unknown>(key);
        if (isRecordingMarker(marker, sessionId) && marker.status === 'cleanup') hasCleanup = true;
      }
      if (hasCleanup) await this.scheduler.ensureCleanup();
      else await this.scheduler.clearCleanup();
    } catch {
      // Startup and the persisted cleanup marker retry this best-effort alarm update.
    }
  }

  private async abortSessionUnlocked(sessionId: string): Promise<void> {
    await this.restoreSessionUnlocked(sessionId);
    await this.finishStopUnlocked(sessionId);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(() => undefined, () => undefined);
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
  } catch {
    options.args = {};
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

export async function loadRecordingFromStorage(name: string): Promise<Recording | null> {
  const storage = completedStorage();
  const key = `${COMPLETED_PREFIX}${name}`;
  const recording = await storage.get<unknown>(key);
  if (recording === undefined) return null;
  if (!isSanitizedRecording(recording)) {
    await storage.remove(key);
    await storage.remove(`${COMPLETED_DIGEST_PREFIX}${name}`);
    return null;
  }
  return recording;
}

export async function listRecordingsFromStorage(): Promise<string[]> {
  const keys = await completedStorage().getKeys();
  return keys
    .filter((key) => key.startsWith(COMPLETED_PREFIX))
    .map((key) => key.slice(COMPLETED_PREFIX.length));
}

export async function deleteRecordingFromStorage(name: string): Promise<void> {
  const storage = completedStorage();
  await storage.remove(`${COMPLETED_PREFIX}${name}`);
  await storage.remove(`${COMPLETED_DIGEST_PREFIX}${name}`);
}
