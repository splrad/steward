import { isAbsolute } from 'node:path';

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
 * @returns {import('@github/copilot-sdk').CopilotClientOptions}
 */
export function isolatedCopilotClientOptions(directory, token, system = process.env) {
  if (!token?.trim() || /[\r\n\0]/.test(token)) throw new Error('COPILOT_CREDENTIAL_REQUIRED');
  return {
    connection: { kind: 'stdio' }, mode: 'empty', baseDirectory: directory, workingDirectory: directory,
    gitHubToken: token, useLoggedInUser: false, builtinPluginDirectories: [], logLevel: 'none',
    env: isolatedCopilotEnvironment(system, directory),
  };
}

/**
 * @param {string} directory
 * @param {string} systemMessage
 * @returns {import('@github/copilot-sdk').SessionConfig}
 */
export function isolatedCopilotSessionOptions(directory, systemMessage) {
  if (!isAbsolute(directory)) throw new Error('COPILOT_ISOLATION_DIRECTORY');
  return {
    workingDirectory: directory, configDirectory: directory, enableConfigDiscovery: false,
    availableTools: [], tools: [], mcpServers: {}, customAgents: [], instructionDirectories: [],
    infiniteSessions: { enabled: false }, memory: { enabled: false },
    onPermissionRequest: () => ({ kind: 'reject' }),
    systemMessage: { mode: 'append', content: systemMessage },
  };
}
