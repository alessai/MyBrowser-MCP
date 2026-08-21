export async function runPreActionFallback<T>(
  prepare: () => Promise<void>,
  act: () => Promise<T>,
  fallback: () => Promise<T>,
  unknownOutcomeCode: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    await prepare();
  } catch {
    signal?.throwIfAborted();
    return fallback();
  }

  try {
    return await act();
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(unknownOutcomeCode, { cause: error });
  }
}

export async function runActionOnce<T>(
  act: () => Promise<T>,
  unknownOutcomeCode: string,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await act();
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(unknownOutcomeCode, { cause: error });
  }
}
