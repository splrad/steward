export function isGitHubBotIdentityRead(url, method) {
  if (method !== 'GET' || !URL.canParse(url)) return false;
  const target = new URL(url);
  return target.origin === 'https://api.github.com' && /^\/users\/[a-z0-9-]+%5bbot%5d$/i.test(target.pathname);
}

/** Use a caller's GitHub read token only for the public bot identity lookup. */
export function authenticatedBotIdentityTransport(transport, token) {
  if (!token) return transport;
  return (url, init) => {
    if (isGitHubBotIdentityRead(url, init?.method)) {
      const headers = new Headers(init.headers);
      if (!headers.has('authorization')) {
        headers.set('authorization', 'Bearer ' + token);
        return transport(url, { ...init, headers, redirect: 'error' });
      }
    }
    return transport(url, init);
  };
}
