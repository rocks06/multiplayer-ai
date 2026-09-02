import {useEffect,useLayoutEffect,useState} from 'react';

const VERSION='v1';
const EVENT='mpai:onboarding-restart';
const steps=[
  {anchor:'rooms',text:'Rooms are where people and AI agents work together.'},
  {anchor:'agents',text:'Connect AI agents already running on your devices.'},
  {anchor:'conversation',text:'Give the room one objective. Agents can coordinate with each other automatically.'},
  {anchor:'shared-work',text:'Humans and agents can create, assign, and complete work here.'},
  {anchor:'needs-you',text:'Agents only interrupt you when they need a decision or approval.'},
  {anchor:'live-activity',text:'See what each agent is doing, waiting on, or handing off.'},
] as const;

export const onboardingStorageKey=(identityKey:string)=>`mpai:onboarding:${VERSION}:${identityKey}`;
export const restartOnboarding=()=>window.dispatchEvent(new Event(EVENT));

/** Small, non-modal coach marks attached to the real product surface. */
export function ContextualOnboarding({identityKey}:{identityKey:string}){
  const key=onboardingStorageKey(identityKey);
  const [step,setStep]=useState<number|null>(()=>localStorage.getItem(key)==='done'?null:Number(localStorage.getItem(key)??0));
  const [box,setBox]=useState<DOMRect|null>(null);
  const current=step===null?null:steps[step];

  useLayoutEffect(()=>{
    if(!current){setBox(null);return}
    const place=()=>setBox(document.querySelector<HTMLElement>(`[data-onboarding="${current.anchor}"]`)?.getBoundingClientRect()??null);
    place();
    const observer=new MutationObserver(place);observer.observe(document.body,{childList:true,subtree:true,attributes:true});
    addEventListener('resize',place);addEventListener('scroll',place,true);
    return()=>{observer.disconnect();removeEventListener('resize',place);removeEventListener('scroll',place,true)};
  },[current?.anchor]);
  useEffect(()=>{
    const restart=()=>{localStorage.removeItem(key);setStep(0)};
    addEventListener(EVENT,restart);return()=>removeEventListener(EVENT,restart);
  },[key]);
  useEffect(()=>{if(step!==null)localStorage.setItem(key,String(step))},[key,step]);

  if(step===null||!current||!box)return null;
  const width=286;
  const left=Math.max(12,Math.min(innerWidth-width-12,box.left));
  const below=box.bottom+12;
  const top=below+190<innerHeight?below:Math.max(12,box.top-194);
  const finish=()=>{localStorage.setItem(key,'done');setStep(null)};
  return <aside className="coachmark" role="dialog" aria-label={`Onboarding ${step+1} of ${steps.length}`}
    style={{left,top,width}}>
    <p className="coachmark-count">{step+1} / {steps.length}</p>
    <p>{current.text}</p>
    <div className="coachmark-actions">
      <button type="button" onClick={finish}>Skip</button>
      <span/>
      {step>0&&<button type="button" onClick={()=>setStep(step-1)}>Back</button>}
      <button type="button" className="coachmark-next" onClick={()=>step===steps.length-1?finish():setStep(step+1)}>{step===steps.length-1?'Done':'Next'}</button>
    </div>
  </aside>;
}
