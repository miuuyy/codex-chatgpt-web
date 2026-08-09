export interface SystemDefaultBrowserExecutableOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveSystemDefaultBrowserExecutable(
  options?: SystemDefaultBrowserExecutableOptions,
): string;
