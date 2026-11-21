export function promotedControllerFixture(path: string, policy: string, deployment: string) {
  const ref = ['refs/heads/main', 'refs/heads/steward/validated-controller']
    .find(value => path.endsWith('/git/' + value.replace('refs/', 'ref/')));
  if (ref) return { ref, object: { type: 'commit', sha: policy } };
  const file = 'config/bounded-recheck.json';
  if (path.endsWith('/contents/' + file + '?ref=' + policy)) {
    const data = Buffer.from(JSON.stringify({ schemaVersion: 1, enabled: true, deploymentSha: deployment }));
    return { type: 'file', path: file, encoding: 'base64', size: data.length, content: data.toString('base64') };
  }
}
