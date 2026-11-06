import { createPrivateKey } from 'node:crypto';

// Offline helper only. Caller must keep returned material in protected memory/stdin.
// Never log, persist in the workspace, or pass a PEM in command-line arguments.
export function toPKCS8(pem) {
  return createPrivateKey(pem).export({type: 'pkcs8', format: 'pem'});
}
