import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { renderLinkcheckFirewall, linkcheckEnvironment } from '../src/linkcheck.js';
it('renders only literal configured DNS addresses with all private ranges blocked', async () => {
  const template = await readFile(new URL('../../../config/linkcheck/egress.nft', import.meta.url), 'utf8');
  const output = renderLinkcheckFirewall(template, '# resolver\nnameserver 10.0.2.3\nnameserver 2001:4860:4860::8888\n');
  expect(output).toContain('elements = { 10.0.2.3 }'); expect(output).toContain('elements = { 2001:4860:4860::8888 }');
  expect(output).toContain('udp dport 53 counter accept'); expect(output).not.toContain('tcp dport 53');
  expect(output).not.toContain('flush'); expect(output).toContain('168.63.129.16');
  for (const value of ['localhost', '10.0.2.3 accept', 'fe80::1%eth0', '$(id)', '', '1.2.3.4 5.6.7.8']) {
    expect(() => renderLinkcheckFirewall(template, 'nameserver ' + value)).toThrow('LINKCHECK');
  }
});
it('does not inherit credentials, proxies, HOME or client auth settings', () => {
  expect(linkcheckEnvironment({ PATH: '/usr/bin', LANG: 'C', HOME: '/private', GH_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture', HTTP_PROXY: 'fixture', HTTPS_PROXY: 'fixture', ALL_PROXY: 'fixture', NO_PROXY: 'fixture', CURL_HOME: '/private' })).toEqual({ PATH: '/usr/bin', LANG: 'C' });
});
