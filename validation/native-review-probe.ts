export function summarizeChangedPaths(paths: readonly string[]) {
  const uniquePaths = [...new Set(paths)].sort();
  return { fileCount: uniquePaths.length, paths: uniquePaths };
}

export const duplicatePathExample = summarizeChangedPaths(['b.ts', 'a.ts', 'b.ts']);
export const emptyPathExample = summarizeChangedPaths([]);
export const caseSensitivePathExample = summarizeChangedPaths(['src/a.ts', 'src/A.ts', 'src/a.ts']);
