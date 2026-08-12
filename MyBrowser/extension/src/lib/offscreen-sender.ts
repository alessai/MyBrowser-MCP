interface SenderIdentity {
  id?: string;
  url?: string;
  tab?: unknown;
}

export function isTrustedOffscreenSender(
  sender: SenderIdentity | undefined,
  extensionId: string,
  offscreenUrl: string,
): boolean {
  return sender?.id === extensionId && sender.url === offscreenUrl && sender.tab === undefined;
}
