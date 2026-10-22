export function summarizeChangedPaths(paths: readonly string[]) {
  const uniquePaths = [...new Set(paths)].sort();
  return { fileCount: uniquePaths.length, paths: uniquePaths };
}
