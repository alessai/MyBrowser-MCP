import { TOOL_METADATA, type RecordingStringKind, type ToolName } from './tool-metadata';

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
    if (url.origin !== 'null') return bounded(`${url.origin}${url.pathname}`);
    if (url.protocol === 'about:' || url.protocol === 'chrome:' || url.protocol === 'edge:') {
      return bounded(`${url.protocol}${url.pathname}`);
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
      || !['http:', 'https:', 'about:', 'chrome:', 'edge:'].includes(url.protocol);
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
      return value.map((entry, index) => transform(entry, path ? `${path}.${index}` : `${index}`));
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = transform(entry, path ? `${path}.${key}` : key);
      }
      return result;
    }

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
      return value.every((entry, index) => validate(entry, path ? `${path}.${index}` : `${index}`));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).every(([key, entry]) => (
        validate(entry, path ? `${path}.${key}` : key)
      ));
    }
    return true;
  };

  return validate(args, '');
}
