import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import AjvModule from 'ajv/dist/2020.js';
const Ajv = AjvModule as unknown as typeof import('ajv').default;
const validate = new Ajv({strict:false}).compile(JSON.parse(readFileSync('schema/release-profile.schema.json','utf8')));
const profile = JSON.parse(readFileSync('config/profiles/release/layerscape.json','utf8'));
it.each(['beforeActions','afterChanges'])('accepts Chinese bullet-list content in %s',slot=>{
 const value=structuredClone(profile);
 value.releaseNotes.personalization={enabled:true,sections:[{id:'usage',type:'bullet-list',slot,title:'使用说明',items:['这是中文正文。']}]};
 expect(validate(value),JSON.stringify(validate.errors)).toBe(true);
 delete value.releaseNotes.personalization.sections[0].type;
 expect(validate(value)).toBe(false);
});
it('keeps asset-table constraints separate from bullet-list content',()=>{
 const value=structuredClone(profile);
 const section={id:'assets',type:'asset-table',slot:'beforeActions',title:'下载',items:['app-windows']};
 value.releaseNotes.personalization={enabled:true,sections:[section]};
 expect(validate(value)).toBe(true);
 section.slot='afterChanges';expect(validate(value)).toBe(false);
 section.slot='beforeActions';section.items=['这是正文。'];expect(validate(value)).toBe(false);
});
