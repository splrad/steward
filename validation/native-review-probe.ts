export function summarizeChangedPaths(paths: readonly string[]) {
  const uniquePaths = [...new Set(paths)].sort();
  return { fileCount: uniquePaths.length, paths: uniquePaths };
}

export const inputOrderExample = summarizeChangedPaths(['b.ts', 'a.ts']);

export const duplicatePathExample = summarizeChangedPaths(['a.ts', 'a.ts', 'b.ts']);
