import {DomainError} from '../../../packages/domain/src/index.js';
import {DeterministicFakeProvider,FakeProviderError,type FakeScriptStep} from '../../../packages/provider-fake/src/index.js';
import {AgentRuntimeService,type RunLease} from '../../api/src/agent-runtime/runtime-service.js';

export class SimulatedWorkerCrash extends Error {constructor(message='Simulated worker process crash'){super(message)}}
export interface WorkerHooks {beforeTool?:(lease:RunLease,step:Extract<FakeScriptStep,{kind:'tool'}>)=>Promise<void>|void;afterTool?:(lease:RunLease,step:Extract<FakeScriptStep,{kind:'tool'}>,result:unknown)=>Promise<void>|void;}

export class AgentWorker {
 constructor(private readonly runtime:AgentRuntimeService,private readonly provider:DeterministicFakeProvider,private readonly options:{workerId:string;leaseMs:number;hooks?:WorkerHooks}){}
 async runOnce():Promise<'idle'|'completed'|'failed'|'retry_scheduled'|'cancelled'> {
  const lease=await this.runtime.claimNext(this.options.workerId,this.options.leaseMs);if(!lease)return 'idle';
  const heartbeat=setInterval(()=>{void this.runtime.renewLease(lease,this.options.leaseMs)},Math.max(10,Math.floor(this.options.leaseMs/3)));heartbeat.unref();
  try {
   while(true){
    const step=lease.script[lease.checkpoint_step];
    if(!step)return await this.runtime.completeRun(lease);
    const context=await this.runtime.contextForRun(lease.id);
    const stepAttempt=Number(lease.checkpoint?.step_attempt??0)+1;
    let instruction;
    try{instruction=await this.provider.next(step,context as any,stepAttempt)}catch(error){
     if(error instanceof FakeProviderError){if(error.retryable)return await this.runtime.scheduleRetry(lease,{code:error.code,message:error.message},stepAttempt);return await this.runtime.failRun(lease,{code:error.code,message:error.message})}
     throw error;
    }
    if(instruction.kind==='complete')return await this.runtime.completeRun(lease);
    if(instruction.kind==='advance'){try{await this.runtime.checkpoint(lease,step)}catch(error){if(error instanceof DomainError&&error.code==='stale_agent_run'){await this.runtime.reconcileInvalidRuns();return 'cancelled'}throw error}continue}
    try{
     await this.options.hooks?.beforeTool?.(lease,instruction.step);
     const result=await this.runtime.executeTool(lease,instruction.step);
     await this.options.hooks?.afterTool?.(lease,instruction.step,result);
     await this.runtime.checkpoint(lease,instruction.step,result);
    }catch(error){
     if(error instanceof SimulatedWorkerCrash)throw error;
     if(error instanceof DomainError){
      if(error.code==='stale_agent_run'){await this.runtime.reconcileInvalidRuns();return 'cancelled'};
      return await this.runtime.failRun(lease,{code:error.code,message:error.message});
     }
     return await this.runtime.failRun(lease,{code:'tool_error',message:error instanceof Error?error.message:String(error)});
    }
   }
  } finally {clearInterval(heartbeat)}
 }
}
