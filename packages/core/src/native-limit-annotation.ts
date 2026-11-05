/** GitHub's platform annotations are separate from user-controlled job annotations. */
export function nativeRerunLimitAnnotation(html:string,repository:string,runId:number):boolean {
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!Number.isSafeInteger(runId)||runId<1||Buffer.byteLength(html)>384*1024)return false;
  const source=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const regions=[...source.matchAll(/<div\b([^>]*\baria-label="Annotations"[^>]*)>/g)];
  if(regions.length!==1)return false;
  const region=regions[0]!,path=`/${repository}/actions/runs/${runId}`;
  if(!region[1]!.includes('role="region"')||!region[1]!.includes(`data-url="${path}/annotations_partial"`))return false;
  const start=region.index!+region[0].length,end=source.indexOf('</table>',start);
  if(end<0)return false;
  const section=source.slice(start,end),blocks=[...section.matchAll(/<annotation-message\b[^>]*>([\s\S]*?)<\/annotation-message>/g)];
  const expected="You've exceeded the maximum number of rerun attempts (50) for this workflow run.";
  let matches=0;
  for(const block of blocks){
    const value=block[1]!;
    if(value.includes('<annotation-message'))return false;
    const links=[...value.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    if(links.length!==1||links[0]![1]!==`${path}/workflow`||links[0]![2]!.trim()!=='<strong>Error</strong>')continue;
    const messages=[...value.matchAll(/<div\b[^>]*\bdata-target="annotation-message.annotationContainer"[^>]*>\s*<div>([^<]*)<\/div>\s*<\/div>/g)];
    if(messages.length!==1)return false;
    const message=messages[0]![1]!.replace(/&#39;|&apos;/g,"'").trim();
    if(message===expected)matches++;
  }
  return matches===1;
}
