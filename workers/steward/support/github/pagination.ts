export interface Page<T> {
  items: readonly T[];
  next?: string;
}

export async function collectAllPages<T>(
  firstUrl: string,
  load: (url: string) => Promise<Page<T>>,
  limits: { maxPages?: number; maxItems?: number } = {},
): Promise<readonly T[]> {
  const maxPages = limits.maxPages ?? 100;
  const maxItems = limits.maxItems ?? 10_000;
  const result: T[] = [];
  const seen = new Set<string>();
  let next: string | undefined = firstUrl;
  let pages = 0;
  while (next) {
    if (seen.has(next)) throw new Error("分页链接形成循环");
    if (++pages > maxPages) throw new Error("分页页数超过合同上限");
    seen.add(next);
    const page = await load(next);
    if (!Array.isArray(page.items)) throw new Error("分页响应不是项目数组");
    result.push(...page.items);
    if (result.length > maxItems) throw new Error("分页项目数超过合同上限");
    next = page.next;
  }
  return Object.freeze(result);
}

export function nextLink(headers: Headers): string | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  for (const entry of link.split(",")) {
    const match = entry.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}
