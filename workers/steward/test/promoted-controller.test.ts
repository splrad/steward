import {expect,it} from 'vitest';
import {promotedController} from '../src/bounded-controller.js';
import type {GitReader} from '../src/bounded-recheck-github.js';
import {PendingPromotion} from '../src/release-promotion.js';
import {promotedControllerFixture} from './promoted-controller-fixture.js';

it('requires adoption of the live deployment even when the main commit stays the same',async()=>{
  const policy='a'.repeat(40),adopted='b'.repeat(40);
  const reader={json:async(_id:number,path:string)=>promotedControllerFixture(path,policy,adopted)} as GitReader;
  await expect(promotedController(reader,adopted)).resolves.toBe(policy);
  await expect(promotedController(reader,'c'.repeat(40))).rejects.toBeInstanceOf(PendingPromotion);
});

it('binds the waiter to the deployment broker when promoted main is behind',async()=>{
  const policy='a'.repeat(40),previous='b'.repeat(40),deployment='c'.repeat(40);
  const names:string[]=[];
  const env={BOUNDED_RECHECK:{
    idFromName:(name:string)=>{names.push(name);return name;},
    get:()=>({fetch:async()=>Response.json({generation:4})}),
  }};
  const reader={json:async(_id:number,path:string)=>
    promotedControllerFixture(path,path.endsWith('/validated-controller')?previous:policy,deployment)} as GitReader;
  await expect(promotedController(reader,deployment,env as any)).rejects.toMatchObject({sha:deployment,generation:4});
  expect(names).toHaveLength(1);
  expect(names[0]).toContain(deployment);
});
