import {it,expect} from 'vitest';
const modulePath = new URL('../../../scripts/generation-ticket-envelope.mjs',import.meta.url).href;
const {sealTicket,openTicket,ticketContext}=await import(modulePath);
it('encrypts the bearer and authenticates the exact run binding and key',()=>{
 const key='a'.repeat(64),plain=Buffer.from(JSON.stringify({token:'release-generation-graph.secret'}));
 const env={GITHUB_REPOSITORY_ID:'1296724484',GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_SHA:'b'.repeat(40)};
 const context=ticketContext(env),sealed=sealTicket(plain,key,context);
 expect(sealed).not.toContain('release-generation-graph.secret');
 expect(openTicket(sealed,key,context)).toEqual(plain);
 expect(()=>openTicket(sealed,'c'.repeat(64),context)).toThrow();
 for(const field of Object.keys(env))expect(()=>openTicket(sealed,key,ticketContext({...env,[field]:field==='GITHUB_WORKFLOW_SHA'?'c'.repeat(40):'99'}))).toThrow();
 const changed=JSON.parse(sealed);const bytes=Buffer.from(changed.ciphertext,'base64');bytes[0]=bytes[0]!^1;changed.ciphertext=bytes.toString('base64');
 expect(()=>openTicket(JSON.stringify(changed),key,context)).toThrow();
 expect(()=>sealTicket(plain,'',context)).toThrow('TICKET_KEY');
});

