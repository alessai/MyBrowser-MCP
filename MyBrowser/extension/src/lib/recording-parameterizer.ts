import {
  RECORDING_NON_STRING_PATHS,
  TOOL_METADATA,
  type RecordingStringKind,
  type ToolName,
} from './tool-metadata';

export type VariableSource = 'text' | 'form' | 'select' | 'navigation' | 'clipboard';

export interface RequiredVariable {
  name: string;
  source: VariableSource;
  hint?: string;
}

export interface ParameterizationState {
  nextVariable: number;
}

export interface ParameterizedArgs {
  args: Record<string, unknown>;
  requiredVariables: RequiredVariable[];
}

export const MAX_RECORDED_URL_LENGTH = 8_192;

function bounded(value: string): string {
  return value.length <= MAX_RECORDED_URL_LENGTH
    ? value
    : value.slice(0, MAX_RECORDED_URL_LENGTH);
}

export function sanitizePageUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return bounded(`${url.origin}${url.pathname}`);
    }
    return '';
  } catch {
    return '';
  }
}

function isSensitiveNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0
      || (url.protocol !== 'http:' && url.protocol !== 'https:');
  } catch {
    return true;
  }
}

function placeholderSource(value: string): { name: string; source: VariableSource } | undefined {
  const match = /^\{\{((input|form|select|navigation|clipboard)_(\d+))\}\}$/.exec(value);
  if (!match) return undefined;
  const prefix = match[2];
  return {
    name: match[1]!,
    source: prefix === 'input' ? 'text' : prefix as VariableSource,
  };
}

function wildcardPath(path: string): string {
  const separator = path.lastIndexOf('.');
  return separator < 0 ? '*' : `${path.slice(0, separator)}.*`;
}

export function parameterizeArgs(
  toolName: ToolName,
  args: Record<string, unknown>,
  state: ParameterizationState,
): ParameterizedArgs {
  const metadata = TOOL_METADATA[toolName];
  if (!metadata.recordable || !('recordingStrings' in metadata)) {
    throw new Error('RECORDING_METADATA_MISMATCH');
  }

  const classifications = metadata.recordingStrings as Record<string, RecordingStringKind>;
  const configuredNonStringPaths = (RECORDING_NON_STRING_PATHS as Partial<
    Record<ToolName, readonly string[]>
  >)[toolName];
  if (!configuredNonStringPaths) throw new Error('RECORDING_METADATA_MISMATCH');
  const nonStringPaths = new Set<string>(configuredNonStringPaths);
  const requiredVariables: RequiredVariable[] = [];

  const transform = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      const kind = classifications[path] ?? classifications[wildcardPath(path)];
      if (!kind) throw new Error('RECORDING_METADATA_MISMATCH');
      if (kind === 'safe') return value;
      if (kind === 'navigation' && !isSensitiveNavigation(value)) {
        return sanitizePageUrl(value);
      }

      const counter = state.nextVariable;
      state.nextVariable += 1;
      const prefix = kind === 'text' ? 'input' : kind;
      const name = `${prefix}_${counter}`;
      requiredVariables.push({
        name,
        source: kind,
        hint: `${kind}_input_${counter}`,
      });
      return `{{${name}}}`;
    }

    if (Array.isArray(value)) {
      if (!Object.keys(classifications).some((key) => key.startsWith(`${path}.`))) {
        throw new Error('RECORDING_METADATA_MISMATCH');
      }
      return value.map((entry, index) => transform(entry, path ? `${path}.${index}` : `${index}`));
    }

    if (value && typeof value === 'object') {
      if (path && !Object.keys(classifications).some((key) => key.startsWith(`${path}.`))) {
        throw new Error('RECORDING_METADATA_MISMATCH');
      }
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path === 'fields' ? 'fields.*' : path ? `${path}.${key}` : key;
        result[key] = transform(entry, childPath);
      }
      return result;
    }

    if (!nonStringPaths.has(path)) throw new Error('RECORDING_METADATA_MISMATCH');
    return value;
  };

  return {
    args: transform(args, '') as Record<string, unknown>,
    requiredVariables,
  };
}

export function validateSanitizedArgs(
  toolName: string,
  args: Record<string, unknown>,
  variables: ReadonlyMap<string, VariableSource>,
  usedVariables: Set<string>,
): boolean {
  const metadata = TOOL_METADATA[toolName as ToolName];
  if (!metadata?.recordable || !('recordingStrings' in metadata)) return false;
  const classifications = metadata.recordingStrings as Record<string, RecordingStringKind>;
  const configuredNonStringPaths = (RECORDING_NON_STRING_PATHS as Partial<
    Record<ToolName, readonly string[]>
  >)[toolName as ToolName];
  if (!configuredNonStringPaths) return false;
  const nonStringPaths = new Set<string>(configuredNonStringPaths);

  const validate = (value: unknown, path: string): boolean => {
    if (typeof value === 'string') {
      const kind = classifications[path] ?? classifications[wildcardPath(path)];
      if (!kind) return false;
      if (kind === 'safe') return true;
      if (kind === 'navigation' && !isSensitiveNavigation(value)) {
        return sanitizePageUrl(value) === value;
      }
      const placeholder = placeholderSource(value);
      if (!placeholder || placeholder.source !== kind) return false;
      if (variables.get(placeholder.name) !== placeholder.source) return false;
      if (usedVariables.has(placeholder.name)) return false;
      usedVariables.add(placeholder.name);
      return true;
    }
    if (Array.isArray(value)) {
      if (!Object.keys(classifications).some((key) => key.startsWith(`${path}.`))) return false;
      return value.every((entry, index) => validate(entry, path ? `${path}.${index}` : `${index}`));
    }
    if (value && typeof value === 'object') {
      if (path && !Object.keys(classifications).some((key) => key.startsWith(`${path}.`))) return false;
      return Object.entries(value as Record<string, unknown>).every(([key, entry]) => (
        validate(entry, path === 'fields' ? 'fields.*' : path ? `${path}.${key}` : key)
      ));
    }
    return nonStringPaths.has(path);
  };

  return validate(args, '');
}
