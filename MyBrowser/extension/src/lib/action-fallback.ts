export async function runPreActionFallback<T>(
  prepare: () => Promise<void>,
  act: () => Promise<T>,
  fallback: () => Promise<T>,
  unknownOutcomeCode: string,
): Promise<T> {
  try {
    await prepare();
  } catch {
    return fallback();
  }

  try {
    return await act();
  } catch (error) {
    throw new Error(unknownOutcomeCode, { cause: error });
  }
}
