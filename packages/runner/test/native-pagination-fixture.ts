import { Octokit } from '@octokit/rest';
import { nativePages, type NativePages } from '../src/release-pipeline.js';
import type { GhCommand } from '../src/gh-release.js';

/** Existing native-response fixtures pass through the real official iterator with an offline transport. */
export function fixtureNativePages(gh: GhCommand): NativePages {
  return (path, collection) => nativePages(path, collection, new Octokit({ auth: 'fixture-only', request: {
    fetch: async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const page = Number(url.searchParams.get('page') ?? '1');
      url.searchParams.delete('page');
      const pages = JSON.parse(await gh(['api', '--paginate', '--slurp', url.pathname.slice(1) + url.search]));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (page < pages.length) { url.searchParams.set('page', String(page + 1)); headers.link = `<${url.href}>; rel="next"`; }
      const response = new Response(JSON.stringify(pages[page - 1]), { status: 200, headers });
      Object.defineProperty(response, 'url', { value: url.href });
      return response;
    },
  }, log: { debug() {}, info() {}, warn() {}, error() {} } }));
}
