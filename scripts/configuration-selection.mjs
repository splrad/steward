import {staticMatrixRows} from './configuration-build.mjs';

const must=(condition,message)=>{if(!condition)throw Error(message);};

export function channelUploadSteps(job,id,mode,unitId,channelId,row) {
  const resolve=value=>String(value??'').replace(/\$\{\{\s*(matrix\.unitId|matrix\.channelId|inputs\.mode)\s*\}\}/g,
    (_,field)=>field==='inputs.mode'?mode:String(row[field.slice(7)]??''));
  if(resolve(job.name??id)!==mode+'/'+channelId+'/'+unitId)return [];
  const receipt='channel-${{ inputs.request_key }}-'+unitId+'-'+channelId+'-${{ github.run_id }}-${{ github.run_attempt }}';
  return (job.steps??[]).filter(step=>/^actions\/upload-artifact@[a-f0-9]{40}$/.test(step.uses??'')
    && resolve(step.with?.name)===receipt && step.with?.path==='report.json');
}

export function assertChannelWorkflow(workflow,targets,nativeJobs=new Set()) {
  const dispatch=workflow?.on?.workflow_dispatch, required=['cycle_id','source_sha','execution_sha','controller_sha','targets_json','mode','operation_key','request_key'];
  must(dispatch && Object.keys(workflow.on).length===1 && required.every(k=>dispatch.inputs?.[k]?.type==='string' && dispatch.inputs[k].required===true)
    && workflow['run-name']==='Channels ${{ inputs.mode }} ${{ inputs.request_key }}','渠道入口必须声明原生调度输入和运行名');
  for(const {unitId,channelId} of targets) for(const mode of ['submit','verify']) {
    const name=mode+'/'+channelId+'/'+unitId;
    const matches=Object.entries(workflow.jobs??{}).flatMap(([id,job])=>{
      // Dynamic matrices are supplied by the product's runtime. Static ones must actually contain the target.
      const declared=staticMatrixRows(job.strategy?.matrix);
      if(!declared && !nativeJobs.has(name)) return [];
      const rows=declared??[{unitId,channelId}];
      return rows.flatMap(row=>channelUploadSteps(job,id,mode,unitId,channelId,row));
    });
    must(matches.length===1,'缺少唯一的渠道作业或原生回执 '+name);
  }
}
