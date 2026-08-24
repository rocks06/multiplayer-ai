export type FakeToolName='room.send_message'|'task.get'|'task.list_eligible'|'task.update_status'|'task.complete';
export type FakeScriptStep=
 | {kind:'tool';id:string;name:FakeToolName;arguments:Record<string,unknown>}
 | {kind:'barrier';id:string;name:string}
 | {kind:'expect_message';id:string;includes:string;sender_principal_id?:string}
 | {kind:'transient_failure';id:string;times:number}
 | {kind:'permanent_failure';id:string;message:string}
 | {kind:'complete';id:string};
export type FakeScript=FakeScriptStep[];

export interface FakeContext {messages:Array<{body_text:string;sender_principal_id:string}>;[key:string]:unknown}
export type FakeInstruction={kind:'tool';step:Extract<FakeScriptStep,{kind:'tool'}>}|{kind:'advance'}|{kind:'complete'};

export class FakeProviderError extends Error {
 constructor(message:string,public readonly retryable:boolean,public readonly code='provider_error'){super(message)}
}

export class FakeBarrierController {
 private blocked=new Set<string>();
 private releases=new Map<string,Array<()=>void>>();
 private observers=new Map<string,Array<()=>void>>();
 async block(name:string){
  this.blocked.add(name); for(const notify of this.observers.get(name)??[])notify(); this.observers.delete(name);
  await new Promise<void>(resolve=>{const list=this.releases.get(name)??[];list.push(resolve);this.releases.set(name,list)});
  this.blocked.delete(name);
 }
 waitUntilBlocked(name:string){if(this.blocked.has(name))return Promise.resolve();return new Promise<void>(resolve=>{const list=this.observers.get(name)??[];list.push(resolve);this.observers.set(name,list)})}
 release(name:string){for(const release of this.releases.get(name)??[])release();this.releases.delete(name)}
}

export class DeterministicFakeProvider {
 readonly kind='deterministic-fake';
 constructor(private readonly barriers=new FakeBarrierController()){}
 async next(step:FakeScriptStep|undefined,context:FakeContext,stepAttempt:number):Promise<FakeInstruction>{
  if(!step)return {kind:'complete'};
  switch(step.kind){
   case 'tool': return {kind:'tool',step};
   case 'barrier': await this.barriers.block(step.name); return {kind:'advance'};
   case 'expect_message': {
    const found=context.messages.some(message=>message.body_text.includes(step.includes)&&(!step.sender_principal_id||message.sender_principal_id===step.sender_principal_id));
    if(!found)throw new FakeProviderError(`Expected message containing: ${step.includes}`,true,'expected_message_missing');
    return {kind:'advance'};
   }
   case 'transient_failure': if(stepAttempt<=step.times)throw new FakeProviderError('Scripted transient provider failure',true,'provider_transient'); return {kind:'advance'};
   case 'permanent_failure': throw new FakeProviderError(step.message,false,'provider_permanent');
   case 'complete': return {kind:'complete'};
  }
 }
}
