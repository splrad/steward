import {open,mkdir} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createInflateRaw,crc32} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {buildLimits} from '../../core/src/build-manifest.js';

export const maxArtifactArchiveBytes=buildLimits.maxTotalBytes+16*1024*1024;
const check=(v:unknown)=>{if(!v)throw new Error('ARTIFACT_HANDOFF_INVALID');};
export interface ArtifactFile {path:string;size:number;sha256:string}
/** Parse only a flat file envelope; stream bytes to fresh files under the release build budgets. */
export async function extractArtifactFile(archive:string,directory:string):Promise<Map<string,ArtifactFile>>{
 const handle=await open(archive,'r');
 try{
  const size=(await handle.stat()).size;check(size>=22&&size<=maxArtifactArchiveBytes);
  const read=async(position:number,length:number)=>{
   check(Number.isSafeInteger(position)&&position>=0&&length>=0&&length<=131072&&position+length<=size);
   const b=Buffer.alloc(length);let offset=0;
   while(offset<length){const r=await handle.read(b,offset,length-offset,position+offset);check(r.bytesRead>0);offset+=r.bytesRead;}return b;
  };
  const tailStart=Math.max(0,size-65557),tail=await read(tailStart,size-tailStart);
  let e=-1;for(let p=tail.length-22;p>=0;p--)if(tail.readUInt32LE(p)===0x06054b50&&p+22+tail.readUInt16LE(p+20)===tail.length){e=p;break;}
  check(e>=0);const end=tailStart+e;
  check(tail.readUInt16LE(e+4)===0&&tail.readUInt16LE(e+6)===0);
  let count=tail.readUInt16LE(e+10),centralSize=tail.readUInt32LE(e+12),start=tail.readUInt32LE(e+16),centralEnd=end;
  const integer=(b:Buffer,p:number)=>{check(p+8<=b.length);const n=Number(b.readBigUInt64LE(p));check(Number.isSafeInteger(n));return n;};
  if(count===65535||centralSize===0xffffffff||start===0xffffffff){
   const locator=await read(end-20,20);check(locator.readUInt32LE(0)===0x07064b50&&locator.readUInt32LE(4)===0&&locator.readUInt32LE(16)===1);
   centralEnd=integer(locator,8);const z=await read(centralEnd,56);
   check(z.readUInt32LE(0)===0x06064b50&&integer(z,4)===44&&centralEnd+56===end-20&&z.readUInt32LE(16)===0&&z.readUInt32LE(20)===0);
   count=integer(z,32);check(integer(z,24)===count);centralSize=integer(z,40);start=integer(z,48);
  }else check(tail.readUInt16LE(e+8)===count);
  check(count>0&&count<=buildLimits.maxFiles&&start+centralSize===centralEnd);
  const names=new Set<string>(),entries:any[]=[];let cursor=start,total=0;
  for(let i=0;i<count;i++){
   const c=await read(cursor,46);check(c.readUInt32LE(0)===0x02014b50);
   const flags=c.readUInt16LE(8),method=c.readUInt16LE(10),crc=c.readUInt32LE(16),n=c.readUInt16LE(28),x=c.readUInt16LE(30),comment=c.readUInt16LE(32),mode=c.readUInt32LE(38)>>>16;
   let compressed=c.readUInt32LE(20),length=c.readUInt32LE(24),offset=c.readUInt32LE(42);
   check(cursor+46+n+x+comment<=centralEnd&&(flags&~0x808)===0&&[0,8].includes(method)&&c.readUInt16LE(34)===0&&(mode===0||(mode&0xf000)===0x8000));
   const extra=await read(cursor+46+n,x);
   if([compressed,length,offset].includes(0xffffffff)){
    let z:Buffer|undefined;for(let k=0;k<extra.length;){check(k+4<=extra.length);const tag=extra.readUInt16LE(k),len=extra.readUInt16LE(k+2);check(k+4+len<=extra.length);if(tag===1){check(!z);z=extra.subarray(k+4,k+4+len);}k+=4+len;}
    check(z);let k=0;if(length===0xffffffff){length=integer(z!,k);k+=8;}if(compressed===0xffffffff){compressed=integer(z!,k);k+=8;}if(offset===0xffffffff)offset=integer(z!,k);
   }
   total+=length;check(length>0&&length<=buildLimits.maxFileBytes&&compressed>0&&total<=buildLimits.maxTotalBytes);
   const nameBytes=await read(cursor+46,n),name=nameBytes.toString('utf8');
   check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)&&!/[. ]$/.test(name)&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)&&!names.has(name.toLowerCase()));names.add(name.toLowerCase());
   entries.push({name,nameBytes,flags,method,crc,compressed,length,offset});cursor+=46+n+x+comment;
  }
  check(cursor===centralEnd);entries.sort((a,b)=>a.offset-b.offset);
  await mkdir(directory,{recursive:true});let localEnd=0;const files=new Map<string,ArtifactFile>();
  for(const a of entries){
   check(a.offset===localEnd);const l=await read(a.offset,30);
   check(l.readUInt32LE(0)===0x04034b50&&l.readUInt16LE(6)===a.flags&&l.readUInt16LE(8)===a.method&&l.readUInt16LE(26)===a.nameBytes.length);
   const n=l.readUInt16LE(26),x=l.readUInt16LE(28),data=a.offset+30+n+x;
   check(data+a.compressed<=start&&(await read(a.offset+30,n)).equals(a.nameBytes));
   if(!(a.flags&8)){
    let compressed=l.readUInt32LE(18),length=l.readUInt32LE(22);
    if(compressed===0xffffffff||length===0xffffffff){
     const extra=await read(a.offset+30+n,x);let z:Buffer|undefined;
     for(let k=0;k<extra.length;){check(k+4<=extra.length);const len=extra.readUInt16LE(k+2);check(k+4+len<=extra.length);if(extra.readUInt16LE(k)===1){check(!z);z=extra.subarray(k+4,k+4+len);}k+=4+len;}
     check(z);let k=0;if(length===0xffffffff){length=integer(z!,k);k+=8;}if(compressed===0xffffffff)compressed=integer(z!,k);
    }
    check(l.readUInt32LE(14)===a.crc&&compressed===a.compressed&&length===a.length);
   }
   const file=join(directory,a.name),hash=createHash('sha256');let actual=0,crc=0;
   const bound=new Transform({transform(chunk:Buffer,_encoding,done){actual+=chunk.length;if(actual>a.length){done(new Error('ARTIFACT_HANDOFF_INVALID'));return;}crc=crc32(chunk,crc);hash.update(chunk);done(null,chunk);}});
   const source=createReadStream(archive,{start:data,end:data+a.compressed-1});
   if(a.method===8)await pipeline(source,createInflateRaw(),bound,createWriteStream(file,{flags:'wx'}));
   else await pipeline(source,bound,createWriteStream(file,{flags:'wx'}));
   check(actual===a.length&&crc===a.crc);localEnd=data+a.compressed;
   if(a.flags&8){
    let d=await read(localEnd,4);if(d.readUInt32LE(0)===0x08074b50)localEnd+=4;
    d=await read(localEnd,12);
    if(d.readUInt32LE(0)===a.crc&&d.readUInt32LE(4)===a.compressed&&d.readUInt32LE(8)===a.length)localEnd+=12;
    else {d=await read(localEnd,20);check(d.readUInt32LE(0)===a.crc&&integer(d,4)===a.compressed&&integer(d,12)===a.length);localEnd+=20;}
   }
   files.set(a.name,{path:file,size:actual,sha256:hash.digest('hex')});
  }
  check(localEnd===start);return files;
 }finally{await handle.close();}
}
