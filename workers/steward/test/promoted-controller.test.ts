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
