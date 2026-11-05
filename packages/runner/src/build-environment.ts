import { join } from 'node:path';

/** Product processes receive only OS/tool lookup variables and an isolated, empty user profile. */
export function isolatedBuildEnvironment(system: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
    CI: 'true', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig') };
  for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'DOTNET_ROOT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (system[key]) result[key] = system[key];
  return result;
}

/** One explicitly selected repository credential; gh cannot read the user's login/config. */
export function isolatedGitHubEnvironment(system: NodeJS.ProcessEnv, home: string, token: string | undefined): NodeJS.ProcessEnv {
  if (!token?.trim() || /[\r\n\0]/.test(token)) throw new Error('GH_CREDENTIAL_REQUIRED');
  const result: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, GH_CONFIG_DIR: home,
    GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', CI: 'true',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig'),
  };
  for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (system[key]) result[key] = system[key];
  }
  return result;
}
