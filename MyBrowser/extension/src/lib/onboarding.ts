interface TutorialDependencies {
  getUrl: (path: string) => string;
  createTab: (url: string) => Promise<unknown>;
}

export async function openInstallTutorial(
  reason: string,
  dependencies: TutorialDependencies,
): Promise<boolean> {
  if (reason !== 'install') return false;
  await dependencies.createTab(dependencies.getUrl('/tutorial.html'));
  return true;
}

const SHORTCUT_SETTINGS_URL = 'chrome://extensions/shortcuts';

export async function openShortcutSettings(dependencies: {
  openTab?: (url: string) => Promise<unknown>;
  copy: (text: string) => Promise<void>;
}): Promise<'opened' | 'copied' | 'manual'> {
  if (dependencies.openTab) {
    try {
      await dependencies.openTab(SHORTCUT_SETTINGS_URL);
      return 'opened';
    } catch {
      // Chrome can reject internal URLs in restricted contexts.
    }
  }
  try {
    await dependencies.copy(SHORTCUT_SETTINGS_URL);
    return 'copied';
  } catch {
    return 'manual';
  }
}
