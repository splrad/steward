import {expect,it} from 'vitest';
import {staticMatrixRows} from '../src/release-workflow.js';

it('bounds include-only rows and rows appended to established matrix axes',()=>{
  const cli={unit:'cli'},docs={unit:'docs'},tools={unit:'tools'};
  expect(staticMatrixRows({include:[cli,docs]},2)).toEqual([cli,docs]);
  expect(staticMatrixRows({include:[cli,docs,tools]},2)).toBeNull();
  expect(staticMatrixRows({unit:['cli','docs'],include:[tools]},2)).toBeNull();
  expect(staticMatrixRows(undefined,0)).toBeNull();
});

it('counts actual appended rows after exclusions and allows merges at the row limit',()=>{
  expect(staticMatrixRows({unit:['cli','docs'],exclude:[{unit:'docs'}],
    include:[{label:'stable'},{unit:'cli',permission:'read'},{unit:'tools'},{release:true}]},2)).toEqual([
    {unit:'cli',label:'stable',permission:'read',release:true},{unit:'tools'},
  ]);
});
