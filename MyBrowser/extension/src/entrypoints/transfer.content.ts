// Content script entrypoint (isolated world, shared DOM): registers the file
// transfer handlers so the background SW can drive uploads into file inputs.
// WXT auto-registers this via defineContentScript.

import { addMessageHandler } from '../lib/messaging';
import {
  handleTransferCommit,
  handleTransferPut,
  handleTransferReset,
} from '../lib/transfer-content';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    addMessageHandler('transfer_reset', async (payload) =>
      handleTransferReset(payload as Parameters<typeof handleTransferReset>[0]));
    addMessageHandler('transfer_put', async (payload) =>
      handleTransferPut(payload as Parameters<typeof handleTransferPut>[0]));
    addMessageHandler('transfer_commit', async (payload) =>
      handleTransferCommit(payload as Parameters<typeof handleTransferCommit>[0]));
  },
});
