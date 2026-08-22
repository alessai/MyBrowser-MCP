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
