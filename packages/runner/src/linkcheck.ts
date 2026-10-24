import { isIP } from 'node:net';

export function renderLinkcheckFirewall(template: string, resolvConf: string): string {
  const addresses: string[] = [];
  for (const line of resolvConf.split(/\r?\n/)) {
    const clean = line.replace(/[;#].*$/, '').trim(); if (!clean || !clean.startsWith('nameserver')) continue;
    const match = /^nameserver\s+([^\s]+)$/.exec(clean);
    if (!match || !isIP(match[1]!) || match[1]!.includes('%')) throw new Error('LINKCHECK: DNS must be a literal IP');
    addresses.push(match[1]!);
  }
  if (!addresses.length) throw new Error('LINKCHECK: no configured nameserver');
  let rendered = template;
  for (const [token, family] of [['@@DNS_IPV4@@', 4], ['@@DNS_IPV6@@', 6]] as const) {
    if (rendered.split(token).length !== 2) throw new Error('LINKCHECK: invalid trusted firewall template');
    const values = [...new Set(addresses.filter(address => isIP(address) === family))];
    rendered = rendered.replace(token, values.length ? `elements = { ${values.join(', ')} }` : '');
  }
  if (rendered.includes('@@')) throw new Error('LINKCHECK: unresolved firewall token');
  return rendered;
}
/** Use only platform/tool discovery variables; never inherit HTTP auth or proxy configuration. */
export function linkcheckEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']) if (environment[key]) clean[key] = environment[key];
  return clean;
}
