import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createDeflateRaw,crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {extractArtifactFile} from '../src/artifact-file.js';
import {zip} from './fixtures/artifact-envelope.js';
async function checkArchive(bytes:Buffer,verify:(files:Awaited<ReturnType<typeof extractArtifactFile>>)=>Promise<void>|void){
 const home=await mkdtemp(join(tmpdir(),'artifact-disk-test-'));
 try{const path=join(home,'archive');await writeFile(path,bytes);await verify(await extractArtifactFile(path,join(home,'out')));}
 finally{await rm(home,{recursive:true,force:true});}
}
it.each([0,8])('streams ordinary ZIP method %s with exact hashes',async method=>{
 await checkArchive(zip('asset.bin',Buffer.from('abc'),0,method),async files=>{
  expect(await readFile(files.get('asset.bin')!.path,'utf8')).toBe('abc');
  expect(files.get('asset.bin')!.sha256).toBe(createHash('sha256').update('abc').digest('hex'));
 });
});
it.each(['../a','a/b','a\\b','CON.exe','foo.'])('rejects invalid release asset name %s',async name=>{
 await expect(checkArchive(zip(name),()=>{})).rejects.toThrow('ARTIFACT_HANDOFF_INVALID');
});
it('retains the established release budget above the old 256 MiB intake cap',async()=>{
 const block=Buffer.alloc(1024*1024),hash=createHash('sha256');let crc=0;
 async function* content(){for(let i=0;i<257;i++){hash.update(block);crc=crc32(block,crc);yield block;}}
 const chunks:Buffer[]=[];for await(const c of Readable.from(content()).pipe(createDeflateRaw()))chunks.push(c);
 const data=Buffer.concat(chunks),base=zip('asset.bin'),nameLength=9,l=Buffer.from(base.subarray(0,30+nameLength));
 const c=Buffer.from(base.subarray(base.length-22-46-nameLength,base.length-22)),e=Buffer.from(base.subarray(-22));
 l.writeUInt16LE(8,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(257*1024*1024,22);
 c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(257*1024*1024,24);e.writeUInt32LE(l.length+data.length,16);
 await checkArchive(Buffer.concat([l,data,c,e]),async files=>{const f=files.get('asset.bin')!;expect(f.size).toBe(257*1024*1024);expect((await stat(f.path)).size).toBe(f.size);expect(f.sha256).toBe(hash.digest('hex'));});
},30000);
it('reads ZIP64 sizes and directory records without accepting oversized assets',async()=>{
 const b=zip('a.bin',Buffer.from('abc')),n=5;
 const l=Buffer.from(b.subarray(0,30)),c=Buffer.from(b.subarray(30+n+3,30+n+3+46)),e=Buffer.from(b.subarray(-22));
 const extra=Buffer.alloc(20);extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(3n,4);extra.writeBigUInt64LE(3n,12);
 l.writeUInt32LE(0xffffffff,18);l.writeUInt32LE(0xffffffff,22);l.writeUInt16LE(extra.length,28);
 c.writeUInt32LE(0xffffffff,20);c.writeUInt32LE(0xffffffff,24);c.writeUInt16LE(extra.length,30);
 const local=Buffer.concat([l,Buffer.from('a.bin'),extra,Buffer.from('abc')]),central=Buffer.concat([c,Buffer.from('a.bin'),extra]);
 const z=Buffer.alloc(56),loc=Buffer.alloc(20);z.writeUInt32LE(0x06064b50);z.writeBigUInt64LE(44n,4);z.writeBigUInt64LE(1n,24);z.writeBigUInt64LE(1n,32);z.writeBigUInt64LE(BigInt(central.length),40);z.writeBigUInt64LE(BigInt(local.length),48);
 loc.writeUInt32LE(0x07064b50);loc.writeBigUInt64LE(BigInt(local.length+central.length),8);loc.writeUInt32LE(1,16);e.writeUInt32LE(0xffffffff,12);e.writeUInt32LE(0xffffffff,16);
 await checkArchive(Buffer.concat([local,central,z,loc,e]),async files=>expect(await readFile(files.get('a.bin')!.path,'utf8')).toBe('abc'));
 extra.writeBigUInt64LE(BigInt(1024**3+1),4);
 await expect(checkArchive(Buffer.concat([local,c,Buffer.from('a.bin'),extra,z,loc,e]),()=>{})).rejects.toThrow('ARTIFACT_HANDOFF_INVALID');
});
it('rejects link metadata and CRC corruption',async()=>{
 await expect(checkArchive(zip('a.bin',Buffer.from('abc'),0xa000),()=>{})).rejects.toThrow();
 const b=zip('a.bin');b[35]=b[35]!^1;await expect(checkArchive(b,()=>{})).rejects.toThrow();
});
it.each([false,true])('reads a streamed ZIP data descriptor (signature=%s)',async signature=>{
 const base=zip('a.bin',Buffer.from('abc')),n=5;
 const local=Buffer.from(base.subarray(0,30+n+3)),central=Buffer.from(base.subarray(30+n+3,-22)),end=Buffer.from(base.subarray(-22));
 local.writeUInt16LE(8,6);local.fill(0,14,26);central.writeUInt16LE(8,8);
 const descriptor=Buffer.alloc(signature?16:12),offset=signature?4:0;
 if(signature)descriptor.writeUInt32LE(0x08074b50);
 descriptor.writeUInt32LE(crc32(Buffer.from('abc')),offset);descriptor.writeUInt32LE(3,offset+4);descriptor.writeUInt32LE(3,offset+8);
 end.writeUInt32LE(local.length+descriptor.length,16);
 await checkArchive(Buffer.concat([local,descriptor,central,end]),files=>expect(files.get('a.bin')!.size).toBe(3));
 descriptor.writeUInt32LE(4,offset+8);
 await expect(checkArchive(Buffer.concat([local,descriptor,central,end]),()=>{})).rejects.toThrow();
});
