import {createHash} from 'node:crypto';

export const defaultBuildWorkflow = '.github/workflows/steward-release-publish.yml';
export const channelWorkflow = '.github/workflows/steward-release-channels.yml';
export const githubDeliveryStep = 'upload-github-release';
export const githubDeliveryJobStep = 'Upload GitHub release delivery';
export const workflowPathPattern = '^\\.github/workflows/[^/\\\\:\\u0000-\\u001f\\u007f-\\u009f*!?{}()[\\]<>|"]{1,192}\\.ya?ml$(?![\\s\\S])';
const workflowPath = new RegExp(workflowPathPattern);

export function isBuildWorkflow(path: unknown): path is string {
  return typeof path === 'string' && !/\p{Surrogate}/u.test(path) && path !== channelWorkflow && workflowPath.test(path);
}

export function encodeRepositoryPath(path:string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function dispatchWorkflow(request: {purpose: string; buildWorkflow?: string}): string {
  return request.purpose === 'build' ? request.buildWorkflow ?? defaultBuildWorkflow : channelWorkflow;
}

type MatrixRow = Record<string,unknown>;
const matrixRecord=(value:unknown):value is MatrixRow=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

export function staticMatrixRows(matrix:unknown,maxCombinations=Infinity):MatrixRow[]|null {
  if(!matrix)return [{}];
  if(!matrixRecord(matrix))return null;
  const axes=Object.entries(matrix).filter(([key])=>key!=='include'&&key!=='exclude');
  const include=matrix.include??[],exclude=matrix.exclude??[];
  if(!Array.isArray(include)||!include.every(matrixRecord)||!Array.isArray(exclude)||!exclude.every(matrixRecord)
    ||!axes.every((axis):axis is [string,unknown[]]=>Array.isArray(axis[1])))return null;
  let combinations:MatrixRow[]=axes.length?[{}]:[];
  for(const [key,options] of axes) {
    if(combinations.length*options.length>maxCombinations)return null;
    combinations=combinations.flatMap(row=>options.map(value=>({...row,[key]:value})));
  }
  const base=combinations.filter(row=>!exclude.some(entry=>Object.entries(entry).every(([key,value])=>row[key]===value)));
  const rows=base.map(row=>({...row}));
  for(const entry of include) {
    let merged=false;
    base.forEach((row,index)=>{
      if(axes.every(([key])=>!Object.hasOwn(entry,key)||entry[key]===row[key])) {
        rows[index]={...rows[index],...entry};merged=true;
      }
    });
    if(!merged)rows.push({...entry});
  }
  return rows;
}

export function releasePleaseUnitId(path:string,component:unknown):string {
  const input=component??(path==='.'?'root':path.split('/').at(-1));
  const name=typeof input==='string'?input.toLowerCase():'';
  return /^[a-z][a-z0-9-]{0,63}$/.test(name)?name:'unit-'+createHash('sha256').update(path).digest('hex').slice(0,32);
}
