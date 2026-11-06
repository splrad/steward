import {writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// The runner owns the output directory, but scanner-created files belong to root.
// Replace directory entries instead of truncating those files in place.
export async function replaceScanOutput(path,value){
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o640});
    await rename(temporary,path);
  }finally{await rm(temporary,{force:true});}
}
