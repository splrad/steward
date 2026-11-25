export {staticMatrixRows} from '../packages/runner/dist/index.js';

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

export function repositoryPath(value, root = false) {
  if (root && value === '.') return value;
  requireValue(typeof value === 'string' && value.length && !/[\\:*?"<>|\x00-\x1f$]/.test(value)
    && value.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase())),
    'Expected a literal repository-relative path');
  return value;
}

// Actions supplies these values for each run, including a fresh attempt on rerun.
const runField={run_id:'id',run_number:'run_number',run_attempt:'run_attempt'};
const archiveField=/\$\{\{\s*(matrix\.[\w-]+|github\.(?:run_id|run_number|run_attempt))\s*\}\}/g;
export function supportedArchiveName(pattern) {
  return typeof pattern==='string' && !pattern.replace(archiveField,'').includes('${{');
}

export function runArchiveName(template,run) {
  if(!supportedArchiveName(template))return undefined;
  let complete=true;
  const name=template.replace(archiveField,(_,field)=>{
    const value=field.startsWith('github.') && run?.[runField[field.slice(7)]];
    if(!Number.isSafeInteger(value)||value<=0){complete=false;return '';}
    return String(value);
  });
  return complete?name:undefined;
}

export function matchesMatrixName(pattern,name) {
  if(typeof pattern!=='string'||typeof name!=='string')return false;
  const parts=pattern.split(/\$\{\{\s*matrix\.[\w-]+\s*\}\}/);
  if(parts.some(s=>s.includes('${{')))return false;
  if(parts.length===1)return parts[0]===name;
  if(!name.startsWith(parts[0])||!name.endsWith(parts.at(-1)))return false;
  let end=parts[0].length;
  for(const literal of parts.slice(1,-1)){
    const i=name.indexOf(literal,end+1);
    if(i<=end)return false;
    end=i+literal.length;
  }
  return end<name.length-parts.at(-1).length;
}

// Map a native upload to a stable selection. Ambiguous boundaries stay unselected.
export function observedArchiveTemplate(pattern,name,run) {
  if(!supportedArchiveName(pattern)||typeof name!=='string'||name.includes('${{'))return undefined;
  const tokens=pattern.matchAll(/\$\{\{\s*github\.(?:run_id|run_number|run_attempt)\s*\}\}/g);
  let from=0,start=0,template='';
  for(const token of tokens){
    const value=runArchiveName(token[0],run);
    if(value===undefined)return undefined;
    const prefix=pattern.slice(from,token.index);
    let boundary;
    for(let i=name.indexOf(value,start);i!==-1;i=name.indexOf(value,i+1)){
      if(!matchesMatrixName(prefix,name.slice(start,i)))continue;
      if(boundary!==undefined)return undefined;
      boundary=i;
    }
    if(boundary===undefined)return undefined;
    template+=name.slice(start,boundary)+token[0];
    start=boundary+value.length;from=token.index+token[0].length;
  }
  return matchesMatrixName(pattern.slice(from),name.slice(start))?template+name.slice(start):undefined;
}
