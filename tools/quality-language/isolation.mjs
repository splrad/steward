import { isAbsolute } from 'node:path';
import { RuntimeConnection } from '@microsoft/copilot-sdk';

/** @param {NodeJS.ProcessEnv} system @param {string} directory */
export function isolatedCopilotEnvironment(system, directory) {
  if (!isAbsolute(directory)) throw new Error('COPILOT_ISOLATION_DIRECTORY');
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, COPILOT_HOME: directory,
    CI: 'true', GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (system[key]) environment[key] = system[key];
  }
  return environment;
}

/**
 * The caller creates a fresh empty directory and removes it after client.stop().
 * No SDK process or session is started by this function.
 * @param {string} directory
 * @param {string} token
 * @param {NodeJS.ProcessEnv} [system]
 * @returns {import('@microsoft/copilot-sdk').CopilotClientOptions}
 */
export function isolatedCopilotClientOptions(directory, token, system = process.env) {
  if (!token?.trim() || /[\r\n\0]/.test(token)) throw new Error('COPILOT_CREDENTIAL_REQUIRED');
  return {
    mode: 'empty',
    runtime: RuntimeConnection.forSpawnedStdio({
      baseDirectory: directory, workingDirectory: directory, env: isolatedCopilotEnvironment(system, directory),
    }),
    github: { token, useLoggedInUser: false },
    plugins: { builtinDirectories: [] },
    observability: { logLevel: 'none' },
  };
}

/**
 * @param {string} directory
 * @param {string} systemMessage
 * @returns {import('@microsoft/copilot-sdk').CreateSessionOptions}
 */
export function isolatedCopilotSessionOptions(directory, systemMessage) {
  if (!isAbsolute(directory)) throw new Error('COPILOT_ISOLATION_DIRECTORY');
  return {
    workingDirectory: directory, configDirectory: directory, enableConfigDiscovery: false,
    tools: { availableTools: [], definitions: [] },
    mcp: { servers: {} },
    agents: { definitions: [], includedBuiltinAgents: [] },
    instructions: { skipCustomInstructions: true, directories: [] },
    state: { infiniteSessions: { enabled: false }, memory: { enabled: false } },
    permissions: { onRequest: () => ({ kind: 'reject' }) },
    systemMessage: { mode: 'append', content: systemMessage },
  };
}
