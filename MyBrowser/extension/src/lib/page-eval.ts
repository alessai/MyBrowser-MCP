interface PageEvalEnvelope {
  value?: unknown;
  error?: string;
}

export async function evaluateInMainWorld(tabId: number, code: string): Promise<PageEvalEnvelope> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (source: string) => {
      try {
        const value = await (0, eval)(source);
        return JSON.stringify({ value });
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    args: [code],
  });
  if (typeof injection?.result !== 'string') throw new Error('PAGE_EVAL_FAILED');
  return JSON.parse(injection.result) as PageEvalEnvelope;
}
