export type DemoPhase={
  label:string;
  short:string;
  status:'working'|'handoff'|'waiting'|'decision'|'approved'|'complete';
};

export const demoPhases:DemoPhase[]=[
  {label:'Coleman investigates the release evidence.',short:'Coleman begins the work.',status:'working'},
  {label:'Coleman sends verified findings directly to JJ.',short:'Coleman → JJ',status:'handoff'},
  {label:'JJ replies and starts assembling the release.',short:'JJ starts.',status:'handoff'},
  {label:'JJ waits for Coleman’s final verification.',short:'JJ waits on Coleman.',status:'waiting'},
  {label:'JJ asks a human to authorize publication.',short:'The work needs you.',status:'decision'},
  {label:'You approve the exact proposed action.',short:'You approve.',status:'approved'},
  {label:'JJ continues automatically with the instruction.',short:'JJ continues.',status:'approved'},
  {label:'The coordinated work is complete.',short:'Work completed.',status:'complete'},
];
