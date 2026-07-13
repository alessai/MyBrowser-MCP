import { describe, expect, it } from "vitest";

import { SERVER_RECORDING_ARGUMENT_CLASSIFICATION } from "./recording-classification.js";

type ExtensionRecordingMetadata = {
  TOOL_METADATA: Readonly<Record<string, {
    readonly recordable: boolean;
    readonly recordingStrings?: Readonly<Record<string, string>>;
  }>>;
  RECORDING_ARGUMENT_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>>;
  RECORDING_NUMERIC_BOUNDS: Readonly<Record<string, Readonly<Record<string, {
    readonly integer: boolean;
    readonly min: number;
    readonly max: number;
  }>>>>;
};

describe("recording argument classification conformance", () => {
  it("matches every extension recordable action, path, wildcard, type, and numeric bound", async () => {
    const extensionMetadataUrl = new URL(
      "../../../extension/src/lib/tool-metadata.ts",
      import.meta.url,
    ).href;
    const extension = await import(
      /* @vite-ignore */ extensionMetadataUrl
    ) as ExtensionRecordingMetadata;
    const normalizedExtensionContract = Object.fromEntries(
      Object.entries(extension.TOOL_METADATA)
        .filter(([, metadata]) => metadata.recordable)
        .map(([action, metadata]) => [action, {
          strings: metadata.recordingStrings ?? {},
          argumentTypes: extension.RECORDING_ARGUMENT_TYPES[action] ?? {},
          numericBounds: extension.RECORDING_NUMERIC_BOUNDS[action] ?? {},
        }]),
    );

    expect(SERVER_RECORDING_ARGUMENT_CLASSIFICATION)
      .toEqual(normalizedExtensionContract);
  });
});
