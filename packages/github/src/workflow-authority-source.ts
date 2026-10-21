import {selectContractAuthority} from '../../core/src/workflow-contract-authority.js';
/** The same GitHub file contract is used before deployment and at runtime. */
export function decodeAuthoritySource(file: any): {version:1;repositories:Record<string,unknown>} {
 if(file?.type!=='file' || file.encoding!=='base64' || typeof file.content!=='string' || file.content.length>100000
   || !Number.isSafeInteger(file.size) || file.size<0 || file.size>65536) throw new Error('CONTRACT_EVALUATOR_SOURCE');
 const bytes=Buffer.from(file.content,'base64');
 if(bytes.length!==file.size || bytes.length>65536) throw new Error('CONTRACT_EVALUATOR_SOURCE');
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 selectContractAuthority(value,1); return value;
}
