import {lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname} from 'node:path';

export async function nativeTemporaryParent(errorCode) {
  const parent=tmpdir();
  if(process.platform!=='win32')return parent;
  const canonical=await realpath(parent);
  if(canonical!==parent) {
    // Accept the normal 8.3 spelling only after checking for a real link.
    for(let path=parent;path!==dirname(path);path=dirname(path))
      if((await lstat(path)).isSymbolicLink())throw Error(errorCode);
  }
  return canonical;
}
