const check=(value,code)=>{if(!value)throw Error('BOOTSTRAP_'+code);};
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function decodeAcceptanceTarget(value) {
  check(value&&Object.keys(value).sort().join(',')==='purpose,repositoryId,schemaVersion'&&value.schemaVersion===1
    &&value.purpose==='bootstrap-only'&&positive(value.repositoryId),'ACCEPTANCE_TARGET');
  return value.repositoryId;
}
export function parseAcceptanceTarget(text) {
  try{return decodeAcceptanceTarget(JSON.parse(text));}
  catch{throw Error('BOOTSTRAP_ACCEPTANCE_TARGET_INVALID');}
}
