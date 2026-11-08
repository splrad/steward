import { expect, it } from 'vitest';
import actual from './fixtures/quality-comment-4505551497.json' with { type: 'json' };
import { prepareQualitySource, qualityBatchInput, qualityDigest, qualitySegmentKey, reconcileQualitySources,
  decodeQualityCache, renderQualitySummary, type QualitySource } from '../src/quality-language-summary.js';

const source=(bodyMarkdown:string):QualitySource=>({...actual,bodyMarkdown});
const context={repositoryId:1296724484,pullRequestNumber:304,head:'a'.repeat(40),configVersion:'existing-v1',observedAt:'2026-11-08T00:00:00Z'};
const output=(segment:any)=>{const {bodyMarkdown,...identity}=segment;return {...identity,problemZh:'原文说明问题。',impactZh:'原文未说明。',suggestionZh:'原文说明修正方向。'};};

it('covers the complete real finding, including trailing HTML prose, in one bounded batch',()=>{
  expect(Buffer.byteLength(actual.bodyMarkdown)).toBe(812);
  const prepared=prepareQualitySource(actual);
  expect(prepared.source).toEqual(actual);
  expect(prepared.preservedBlocks).toEqual([]);
  expect(prepared.segments).toHaveLength(1);
  expect(prepared.segments[0]!.bodyMarkdown).toBe(actual.bodyMarkdown);
  expect(prepared.segments[0]!.bodyMarkdown).toContain('No new imports, methods, or definitions are needed.');
  expect(prepared.segments[0]!.originalIdentifiers).toContain("<code>else if (value === 'first') return 'two';</code>");
  expect(prepared.segments[0]!.originalIdentifiers.some(x=>x.startsWith('<a class="Link"'))).toBe(true);
  expect(Buffer.byteLength(qualityBatchInput(prepared.segments))).toBeLessThanOrEqual(24*1024);
});

it.each([
  '<div><p>Check <span>nested <strong>conditions</strong></span>.</p><p>Keep the final explanation.</p></div>',
  '<div>Check <code>src/a.ts</code> and <a href="/target">the original link</a>. Missing closing container.',
  'An orphan </p><p>still has an explanation, then incomplete <span',
  '<a href="/target"><code>value</a> remains code</code> and ends with explanation.',
  'Check <code>value\n\n  next</code> carefully.\n\nKeep the following paragraph.',
  '<template><p>The template contains a real explanation.</p></template>',
])('does not omit prose or markup in nested/incomplete HTML: %s',body=>{
  const result=prepareQualitySource(source(body));
  expect(result.chinese).toBe(false);
  expect(result.preservedBlocks).toEqual([]);
  expect(result.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
});

it.each([
  'Escape \\<pre> before rendering. This causes data loss.',
  'Do not execute \\<script> or \\<style> here. Preserve the explanation.',
  'See [the literal target](https://example.com/<pre>) before rendering.',
  'Use `<pre>` literally. The following explanation must remain.',
])('respects Markdown escapes/code/link targets before recognizing HTML: %s',body=>{
  const p=prepareQualitySource(source(body));
  expect(p.preservedBlocks).toEqual([]);
  expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
});

it('protects Markdown links and reference definitions while classifying only link labels',()=>{
  const link='[complete English label](https://example.com/path/to/file.ts "title")';
  const body='Check inputs. '.repeat(438)+link+' Then handle errors. '.repeat(500);
  const p=prepareQualitySource(source(body));
  expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  expect(p.segments.filter(s=>s.bodyMarkdown.includes(link))).toHaveLength(1);
  expect(p.segments.flatMap(s=>s.originalIdentifiers)).toContain(link);
  const definition='[original]: https://example.com/path/to/file.ts "Original title"';
  const reference=prepareQualitySource(source('Read [the explanation][original].\n\n'+definition));
  expect(reference.segments.flatMap(s=>s.originalIdentifiers)).toContain('[the explanation][original]');
  expect(reference.segments.flatMap(s=>s.originalIdentifiers)).toContain(definition);
  expect(prepareQualitySource(source('[中文](english-target)')).chinese).toBe(true);
  expect(prepareQualitySource(source('[中文][EnglishReference]\n\n[EnglishReference]: english-target')).chinese).toBe(true);
  expect(prepareQualitySource(source('[English explanation](中文)')).chinese).toBe(false);
  expect(prepareQualitySource(source('Read [<code>src/file.ts</code> explanation](target).')).segments[0]!.bodyMarkdown)
    .toContain('[<code>src/file.ts</code> explanation](target)');
});

it('keeps Markdown and HTML code/log bytes and treats literal tags inside code as code',()=>{
  const md='```text\r\n<pre>EXACT $text 🧪</pre>\r\n```';
  const html='<pre class="log">\r\n<code>EXACT &lt;value&gt;\r\n\tTOKEN</code>\r\n</pre>';
  const p=prepareQualitySource(source('Before the code.\n\n'+md+'\n\n<div>After Markdown.</div>\n'+html+'\n<p>After HTML.</p>'));
  expect(p.preservedBlocks).toEqual([md,html]);
  const prose=p.segments.map(s=>s.bodyMarkdown).join('');
  expect(prose).toContain('Before the code.');expect(prose).toContain('After Markdown.');expect(prose).toContain('After HTML.');
  expect(prose).not.toContain('TOKEN');expect(prose).not.toContain('EXACT');
});

it('does not mistake code-only or Chinese HTML with code for untranslated English',()=>{
  for(const body of ['```js\nconst x = "<pre>";\n```','<pre><code>const x = 1;</code></pre>',
    '<code>src/foo.ts</code>','<p>请检查 <code>API_KEY</code> 和 <a href="https://example.com">链接</a>。</p>']) {
    expect(prepareQualitySource(source(body)).segments).toEqual([]);
  }
  expect(prepareQualitySource(source('<p>请检查输入。</p><p>This loses data.</p>')).chinese).toBe(false);
});

it.each(['address','article','aside','blockquote','center','dd','details','dialog','dir','div','dl','dt',
  'fieldset','figcaption','figure','footer','form','h1','h2','h3','h4','h5','h6','header','hgroup',
  'iframe','legend','li','main','menu','nav','ol','p','search','section','summary','textarea','ul','body','html','head','tr','td','th','tbody','thead','tfoot'])
  ('keeps independent English prose visible in adjacent %s containers',tag=>{
    const body=`<${tag}>请检查。</${tag}><${tag}>This loses data.</${tag}>`;
    const p=prepareQualitySource(source(body));
    expect(p.chinese).toBe(false);
    expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  });

it('keeps table cell and caption language boundaries in valid table markup',()=>{
  for(const body of [
    '<table><caption>请检查。</caption><caption>This loses data.</caption></table>',
    '<table><tbody><tr><td>请检查。</td><td>This loses data.</td></tr></tbody></table>',
    '<table><tfoot><tr><th>请检查。</th><th>This loses data.</th></tr></tfoot></table>',
  ]) {
    const p=prepareQualitySource(source(body));
    expect(p.chinese).toBe(false);expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  }
});

it('packs complete short paragraphs and protects inline code/link atoms at long UTF-8 boundaries',()=>{
  const atom='<code>src/🧪.ts</code>',body='Check inputs. '.repeat(438)+atom+' Then handle errors. '.repeat(500);
  const p=prepareQualitySource(source(body));
  expect(p.segments.length).toBeGreaterThan(1);
  expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  expect(p.segments.filter(s=>s.bodyMarkdown.includes(atom))).toHaveLength(1);
  expect(p.segments.flatMap(s=>s.originalIdentifiers)).toContain(atom);
  for(const s of p.segments){expect(Buffer.byteLength(s.bodyMarkdown)).toBeLessThanOrEqual(6*1024);expect(s.bodyMarkdown).not.toContain('\ufffd');qualityBatchInput([s]);}
  expect(()=>prepareQualitySource(source('Check this code: <code>'+'x'.repeat(7*1024)+'</code>'))).toThrow('QUALITY_INPUT_LIMIT');
  const boundary=prepareQualitySource(source('x'.repeat(6*1024)+'\n\n'+'y'.repeat(6*1024)));
  expect(boundary.segments).toHaveLength(3);expect(boundary.segments.every(s=>s.bodyMarkdown.trim())).toBe(true);
  const item=prepareQualitySource(source('Check inputs.')).segments[0]!;
  expect(()=>qualityBatchInput(Array.from({length:11},()=>item))).toThrow('QUALITY_INPUT_LIMIT');
  expect(()=>qualityBatchInput([{...item,bodyMarkdown:'x'.repeat(24*1024)}])).toThrow('QUALITY_INPUT_LIMIT');
});

it.each(['<span data-version="1.2?x!">','<div title="🧪.v1?">','<custom-element data-url="a.b/c?x=1">',
    '<body data-version="1.2?x!">','<html title="🧪.v1?">','<head title="ignored!">',
    '<td title="ignored.cell?">'])
  ('does not split ordinary HTML tag syntax at a UTF-8 boundary: %s',tag=>{
    const close=`</${tag.match(/^<([^ >]+)/)![1]}>`;
    const body='x'.repeat(6138)+tag+'The following explanation is complete. '.repeat(200)+close;
    const p=prepareQualitySource(source(body));
    expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
    expect(p.segments.filter(s=>s.bodyMarkdown.includes(tag))).toHaveLength(1);
    expect(p.segments.filter(s=>s.bodyMarkdown.includes(close))).toHaveLength(1);
    for(const segment of p.segments)expect(Buffer.byteLength(segment.bodyMarkdown)).toBeLessThanOrEqual(6*1024);
  });

it('rejects an oversized indivisible HTML tag instead of truncating its syntax',()=>{
  expect(()=>prepareQualitySource(source('Check <span title="'+'x'.repeat(7*1024)+'">this finding.</span>')))
    .toThrow('QUALITY_INPUT_LIMIT');
});

it('isolates legacy keys even without a caller config bump and retains their results/attempts',async()=>{
  let cache=await reconcileQualitySources(null,context,[source('Check inputs.')]);
  const key=cache.heads[context.head]!.keys[0]!,entry=cache.entries[key]!,segment=entry.segment;
  // Pre-v2 key algorithm, using the actual stored segment and caller config.
  const {sha256Hex}=await import('../src/fingerprint.js');
  const oldKey=await qualityDigest([segment.sourceCommentId,segment.sourceCommit,await sha256Hex(segment.bodyMarkdown),context.configVersion,
    segment.segmentIndex,segment.sourceUrl,segment.severity,segment.originalIdentifiers]);
  expect(oldKey).not.toBe(await qualitySegmentKey(segment,context.configVersion));
  entry.key=oldKey;entry.result=output(segment);entry.attempts=[{startedAt:context.observedAt,status:'COMPLETE',model:'offline',usage:{requests:1}}];
  cache.entries={[oldKey]:entry};cache.heads[context.head]!.keys=[oldKey];
  const before=structuredClone(cache);
  cache=await reconcileQualitySources(cache,context,[source('Check inputs.')]);
  expect(cache.entries[oldKey]).toEqual(before.entries[oldKey]);
  expect(cache.heads[context.head]!.keys).toEqual([key]);
  expect(cache.entries[key]!.result).toBeNull();expect(cache.entries[key]!.attempts).toEqual([]);
  expect(decodeQualityCache(cache,1296724484,304)).toEqual(cache);
  expect(renderQualitySummary(cache).pending).toBe(1);
  cache.entries[key]!.result=output(cache.entries[key]!.segment);
  const again=await reconcileQualitySources(cache,context,[source('Check inputs.')]);
  expect(again.entries[key]!.result).not.toBeNull();expect(again.entries[oldKey]).toEqual(before.entries[oldKey]);
});


it.each(['span','em','strong','a','custom-element'])('does not skip English inside inline %s markup',tag=>{
  const body=`请检查。<${tag}>Fix bug.</${tag}>`;
  const p=prepareQualitySource(source(body));
  expect(p.chinese).toBe(false);expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
});

it.each(['First.\r\n\r\nSecond.','First.\n \t\n\nSecond.','\r\nFirst.\n\nSecond.\r\n',
  'First. '.repeat(900)+'\r\n \r\nSecond. '.repeat(100)])
  ('retains paragraph separator bytes in model input',body=>{
    const p=prepareQualitySource(source(body));
    expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
    for(const s of p.segments)expect(Buffer.byteLength(s.bodyMarkdown)).toBeLessThanOrEqual(6*1024);
  });


const roundtripCases=[6138,6144,6150].flatMap(bytes=>['x'.repeat(bytes),'🧪'.repeat(Math.floor(bytes/4))+'abc'].flatMap(text=>
  ['', '\r\n'].flatMap(prefix=>['\n\n','\r\n \t\r\n'].flatMap(separator=>['', '请检查。<span>Fix bug.</span>'].map(tail=>
    prefix+text+separator+tail)))));
it.each(roundtripCases)('round-trips bounded UTF-8, separators and inline HTML without empty segments %#',async body=>{
  const src=source(body),prepared=prepareQualitySource(src);
  expect(prepared.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  for(const s of prepared.segments){expect(s.bodyMarkdown.trim()).not.toBe('');expect(Buffer.byteLength(s.bodyMarkdown)).toBeLessThanOrEqual(6144);qualityBatchInput([s]);}
  const cache=await reconcileQualitySources(null,context,[src]);
  const decoded=decodeQualityCache(JSON.parse(JSON.stringify(cache)),1296724484,304);
  expect(decoded).toEqual(cache);
  expect(await reconcileQualitySources(decoded,context,[src])).toEqual(cache);
});

it('keeps a full-size prose chunk plus trailing code cache-decodable',async()=>{
  const code='```js\nfoo();\n```',body='x'.repeat(6144)+'\n\n'+code;
  const p=prepareQualitySource(source(body));
  expect(p.preservedBlocks).toEqual([code]);
  expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe('x'.repeat(6144)+'\n\n\n\n');
  expect(p.segments.every(s=>s.bodyMarkdown.trim()&&Buffer.byteLength(s.bodyMarkdown)<=6144)).toBe(true);
  const cache=await reconcileQualitySources(null,context,[source(body)]);
  expect(decodeQualityCache(JSON.parse(JSON.stringify(cache)),1296724484,304)).toEqual(cache);
});

it('does not cut an indivisible tag to make a whitespace-only tail valid',()=>{
  const tag='<span title="'+'x'.repeat(6144-17)+'">';
  expect(Buffer.byteLength(tag)).toBeLessThanOrEqual(6144);
  const body='English. '+tag+'\n\n';
  const p=prepareQualitySource(source(body));
  expect(p.segments.every(s=>s.bodyMarkdown.trim()&&Buffer.byteLength(s.bodyMarkdown)<=6144)).toBe(true);
  expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  expect(p.segments.filter(s=>s.bodyMarkdown.includes(tag))).toHaveLength(1);
  const fullTag='<span title="'+'x'.repeat(6144-15)+'">';
  expect(Buffer.byteLength(fullTag)).toBe(6144);
  expect(()=>prepareQualitySource(source('English. '+fullTag+'\n\n'))).toThrow('QUALITY_INPUT_LIMIT');
});


it.each(['<p>请检查。Fix bug.</p>','<span>请检查 Fix bug</span>',
  '<p>请检查输入以便避免后续处理过程中出现不可预期的问题。Retry.</p>',
  '请检查 Fix bug','<p>Fix bug。请检查输入。</p>','<p>请检查。FIX BUG.</p>'])
  ('never hides English prose behind Chinese volume in one language unit: %s',body=>{
    const p=prepareQualitySource(source(body));
    expect(p.chinese).toBe(false);expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  });

it('keeps dense HTML UTF-16 positions and complete text through one-pass masks',async()=>{
  const body='<div>'+Array.from({length:180},(_,i)=>`<span>🧪 请检查 ${i} Fix bug.</span>\r\n`).join('')+'</div>';
  const p=prepareQualitySource(source(body));
  expect(p.segments.map(s=>s.bodyMarkdown).join('')).toBe(body);
  for(const s of p.segments)expect(Buffer.byteLength(s.bodyMarkdown)).toBeLessThanOrEqual(6144);
  const cache=await reconcileQualitySources(null,context,[source(body)]);
  expect(decodeQualityCache(JSON.parse(JSON.stringify(cache)),1296724484,304)).toEqual(cache);
});
