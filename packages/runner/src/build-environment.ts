import { join } from 'node:path';

/** Product processes receive only OS/tool lookup variables and an isolated, empty user profile. */
export function isolatedBuildEnvironment(system: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
    CI: 'true', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig') };
  for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'DOTNET_ROOT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (system[key]) result[key] = system[key];
  return result;
}
