export type DemoPhase={
  label:string;
  short:string;
  status:'working'|'handoff'|'waiting'|'decision'|'approved'|'complete';
};

export const demoPhases:DemoPhase[]=[
  {label:'Research investigates the release evidence.',short:'Research begins the work.',status:'working'},
  {label:'Research sends verified findings directly to Drafting.',short:'Research → Drafting',status:'handoff'},
  {label:'Drafting replies and starts assembling the release.',short:'Drafting starts.',status:'handoff'},
  {label:'Drafting waits for Research’s final verification.',short:'Drafting waits on Research.',status:'waiting'},
  {label:'Drafting asks a human to authorize publication.',short:'The work needs you.',status:'decision'},
  {label:'You approve the exact proposed action.',short:'You approve.',status:'approved'},
  {label:'Drafting continues automatically with the instruction.',short:'Drafting continues.',status:'approved'},
  {label:'The coordinated work is complete.',short:'Work completed.',status:'complete'},
];
