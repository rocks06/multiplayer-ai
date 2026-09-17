import {test,expect,type Page} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';

// Real RoomApp/Shell/Transcript/AttachmentComposer and CSS; all transport is an
// explicit in-memory fixture. No API process, database, migration or reset hooks.
let server:ViteDevServer,origin:string;
const company='00000000-0000-4000-8000-000000000001',room='00000000-0000-4000-8000-000000000002',person='00000000-0000-4000-8000-000000000003';
test.beforeAll(async()=>{
  server=await createServer({configFile:false,appType:'custom',root:fileURLToPath(new URL('../../apps/web',import.meta.url)),server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'},plugins:[{
    name:'empty-room-fixture',resolveId(id){if(id==='/layout-fixture.js')return '\0layout-fixture'},load(id){if(id==='\0layout-fixture')return `import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));`},
  }]});
  server.middlewares.use('/home',async(_req,res,next)=>{try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/home', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/layout-fixture.js"></script></body></html>'))}catch(error){next(error)}});
  server.middlewares.use('/rooms/',async(_req,res,next)=>{try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/rooms/', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/layout-fixture.js"></script></body></html>'))}catch(error){next(error)}});
  await server.listen();origin=server.resolvedUrls!.local[0]!;
});
test.afterAll(async()=>{await server?.close()});
async function openRoom(page:Page,dense=false,moving=false,withAgent=false,path?:string){
  await page.addInitScript(({company,room,person,dense,moving,withAgent})=>{
    localStorage.setItem(`mpai:onboarding:v1:layout-user:${company}`,'done');
    const snapshot={room:{id:room,name:'Layout room',last_event_seq:0,project_id:'p',project_name:'Layout project',objective:'Keep the conversation readable'},snapshot_seq:0,
      members:[{principal_id:person,display_name:'Alex',kind:'human',role:'manager',responsibilities:'Review work'},
        ...(withAgent?[{principal_id:'fixture-agent',display_name:'Fixture Agent',kind:'agent',role:'worker_agent',responsibilities:'',agent_presence:'connected',agent_connection:'connected'}]:[])],tasks:[],
      messages:dense?Array.from({length:70},(_,i)=>({id:`m${i}`,sender_principal_id:person,sender_name:'Alex',sender_kind:'human',body_text:`Message ${i}: The conversation stays readable while the controls stay in place.`,created_at:new Date(1700000000000+i*60000).toISOString()})):[],
      briefing:{briefing_seq:0,project_objective:'Keep the conversation readable',participants:[],joining_principal:{principal_id:person,role:'manager',responsibilities:'Review work'},active_tasks:[],relevant_completed_work:[],blockers:[],relevant_artifacts:[],important_recent_activity:[],unresolved_decisions:[]}};
    window.fetch=async(input,init)=>{
      // Recording how far a person has read is not a change to the room, and is answered on its own.
      if(init?.method==='POST'&&new URL(String(input),location.origin).pathname.endsWith('/read'))return new Response(JSON.stringify({last_read_seq:0}),{headers:{'content-type':'application/json'}});
      if(init?.method && init.method!=='GET'){(window as any).fixtureMutations=((window as any).fixtureMutations??0)+1;((window as any).fixtureRequests??=[]).push(`${init.method} ${new URL(String(input),location.origin).pathname}`)}
      const url=String(input),path=new URL(url,location.origin).pathname;
      let data:unknown;
      if(path==='/v1/auth/me')data={user:{id:'layout-user',email:'layout@example.test',display_name:'Alex'},companies:[{company_id:company,company_name:'Layout studio',principal_id:person,display_name:'Alex'}]};
      else if(path.endsWith('/snapshot'))data=snapshot;
      else if(path.endsWith('/rooms'))data={rooms:[{room_id:room,name:'Layout room',project_name:'Layout project'}]};
      else if(path.endsWith('/members/fixture-agent')&&init?.method==='DELETE')data={status:'removed'};
      else if(path.endsWith('/agents')&&withAgent)data={agents:[{agent_id:'fixture-agent-id',principal_id:'fixture-agent',display_name:'Fixture Agent',status:'active',rooms:[{room_id:room,name:'Layout room'}],runtime:{type:'hermes',version:'0.21.0'},connector:{enrolled:true,presence:'connected',room_id:room,room_name:'Layout room',runtime_status:'idle'}},{agent_id:'second-id',principal_id:'second-agent',display_name:'Second Fixture Agent',status:'active',rooms:[],runtime:null,connector:{enrolled:false,presence:'never',room_id:null,room_name:null,runtime_status:null}}]};
      else if(path.endsWith('/agents'))data={agents:moving?[{agent_id:'agent',principal_id:'moving-principal',display_name:'JJ',status:'active',rooms:[],connector:{enrolled:true,presence:'connected',room_id:'room-a',room_name:'Room A',runtime_status:'idle'}}]:[]};
      else if(path.endsWith('/artifacts'))data={artifacts:[]};
      else if(path.endsWith('/messages')&&init?.method==='POST')data={ok:true};
      else throw new Error(`Unexpected fixture request: ${url}`);
      return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    };
    class FixtureSocket{
      static OPEN=1;readyState=1;onmessage:((event:{data:string})=>void)|null=null;onclose:(()=>void)|null=null;
      constructor(){setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'resumed',after_seq:0,latest_seq:0})}),0)}
      send(){}close(){this.readyState=3;this.onclose?.()}
    }
    Object.defineProperty(window,'WebSocket',{value:FixtureSocket});
  },{company,room,person,dense,moving,withAgent});
  if(path){await page.goto(`${origin}${path}`);return}
  await page.goto(`${origin}rooms/${company}/${room}`);
  await expect(page.getByRole('heading',{name:'Layout room'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Message',exact:true})).toBeVisible();
}
for(const viewport of [{width:1440,height:900},{width:800,height:600}])test(`a room fills the window at ${viewport.width}x${viewport.height} with no bar above it, and its M goes Home`,async({page})=>{
  await page.setViewportSize(viewport);await openRoom(page);
  await expect(page.locator('.shell-bar')).toHaveCount(0);
  const header=(await page.locator('.room-header').boundingBox())!;
  expect(header.y).toBeLessThanOrEqual(12);
  const room=(await page.locator('.room-app').boundingBox())!;
  expect(room.y+room.height).toBeGreaterThanOrEqual(viewport.height-14);
  for(const name of ['Layout room'])await expect(page.getByRole('heading',{name})).toBeVisible();
  const home=page.getByRole('button',{name:'Home',exact:true});
  await expect(home).toHaveText('M');
  await home.click();
  await expect(page).toHaveURL(/\/home$/);
});
test('Remove from room asks in a dialog over the whole window, then removes only this room membership',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await openRoom(page,false,false,true);
  await page.getByRole('button',{name:'Supervise Fixture Agent'}).click();
  for(const name of ['Message Fixture Agent','Pause Fixture Agent','Disconnect from room','Remove from room'])await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Remove from room',exact:true}).click();
  const dialog=page.getByRole('alertdialog');
  await expect(dialog).toContainText('Remove Fixture Agent from this room?');
  const box=(await dialog.boundingBox())!;
  // Drawn over the window, not clipped inside the side panel it was opened from.
  expect(box.x+box.width/2).toBeGreaterThan(1440*0.3);expect(box.x+box.width/2).toBeLessThan(1440*0.7);
  expect(await page.evaluate(()=>(window as any).fixtureRequests??[])).toEqual([]);
  await dialog.getByRole('button',{name:'Remove from room',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).fixtureRequests)).toEqual([`DELETE /v1/companies/${company}/rooms/${room}/members/fixture-agent`]);
});
test('Create room lists each agent as one aligned row: checkbox, then its name, then optional detail',async({page})=>{
  await page.setViewportSize({width:1280,height:900});await openRoom(page,false,false,true,'home');
  await page.getByRole('button',{name:/Create room/}).first().click();
  const group=page.getByRole('group',{name:'Which agents belong here?'});
  await expect(group.getByRole('checkbox')).toHaveCount(2);
  for(const [name,detail] of [['Fixture Agent','Hermes · 0.21.0'],['Second Fixture Agent',null]] as const){
    const row=group.locator('label.home-check',{hasText:name}).first();
    const box=(await row.getByRole('checkbox').boundingBox())!,label=(await row.getByText(name,{exact:true}).boundingBox())!,frame=(await row.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(20);
    expect(label.x-(box.x+box.width)).toBeGreaterThanOrEqual(4);
    expect(label.x-(box.x+box.width)).toBeLessThanOrEqual(16);
    expect(box.x-frame.x).toBeLessThanOrEqual(16);
    expect(Math.abs((box.y+box.height/2)-(frame.y+frame.height/2))).toBeLessThanOrEqual(6);
    if(detail)await expect(row.getByText(detail,{exact:true})).toBeVisible();
  }
  await group.getByText('Fixture Agent',{exact:true}).click();
  await expect(group.getByRole('checkbox',{name:/^Fixture Agent/})).toBeChecked();
  await page.screenshot({path:test.info().outputPath('create-room-agents.png')});
});
for(const accept of [false,true])test(`move agent confirmation ${accept?'confirm':'cancel'} never mutates membership or credentials in the browser`,async({page})=>{
  await page.setViewportSize({width:1440,height:900});await openRoom(page,false,true);
  await page.getByRole('button',{name:'Add agent',exact:true}).click();
  await page.getByRole('combobox',{name:'Add an agent already in this workspace'}).selectOption('moving-principal');
  const dialog=page.getByRole('alertdialog');
  await expect(dialog).toContainText('JJ is currently connected to Room A. Move it to Layout room?');
  expect(await page.evaluate(()=>(window as any).fixtureMutations??0)).toBe(0);
  await dialog.getByRole('button',{name:accept?'Move agent':'Cancel',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).fixtureMutations??0)).toBe(0);
});

async function measure(page:Page){return page.evaluate(()=>{
  const box=(selector:string)=>{const e=document.querySelector<HTMLElement>(selector)!;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop,rows:getComputedStyle(e).gridTemplateRows}};
  return {viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},shell:box('.shell-body'),room:box('.room-app'),header:box('.room-header'),worktable:box('.worktable'),conversation:box('.conversation'),transcript:box('.transcript'),composer:box('.composer'),textarea:box('.composer textarea')};
})}
for(const viewport of [{width:1440,height:900},{width:1024,height:640},{width:1280,height:480},{width:800,height:600},{width:375,height:667}]){
  for(const dense of [false,true])test(`${dense?'populated':'empty'} ${viewport.width}x${viewport.height} keeps room controls bounded`,async({page},info)=>{
    await page.setViewportSize(viewport);await openRoom(page,dense);
    const before=await measure(page);console.log(JSON.stringify({case:info.title,...before}));
    await page.screenshot({path:info.outputPath('room.png'),fullPage:true});
    await info.attach('measurements',{body:JSON.stringify(before,null,2),contentType:'application/json'});
    expect(before.document.width).toBeLessThanOrEqual(viewport.width);
    expect(before.document.height).toBeLessThanOrEqual(viewport.height);
    expect(before.shell.scrollHeight).toBeLessThanOrEqual(before.shell.clientHeight);
    expect(before.header.scrollHeight).toBeLessThanOrEqual(before.header.clientHeight);
    const headerChildren=await page.locator('.room-header').evaluate(e=>Array.from(e.children).filter(child=>getComputedStyle(child).display!=='none').map(child=>{const r=child.getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right}}));
    for(const child of headerChildren){expect(child.top).toBeGreaterThanOrEqual(before.header.y);expect(child.bottom).toBeLessThanOrEqual(before.header.bottom);expect(child.right).toBeLessThanOrEqual(viewport.width)}
    expect(before.composer.height).toBeLessThanOrEqual(100);
    expect(before.textarea.height).toBeLessThanOrEqual(48);
    expect(before.composer.bottom).toBeLessThanOrEqual(viewport.height);
    expect(before.transcript.height).toBeGreaterThan(viewport.height*0.35);
    expect(before.worktable.bottom).toBeGreaterThan(viewport.height-75);
    if(dense){
      expect(before.transcript.scrollHeight).toBeGreaterThan(before.transcript.clientHeight);
      await page.locator('.transcript').evaluate(e=>{e.scrollTop=0});
      await page.locator('.transcript').hover();await page.mouse.wheel(0,400);
      await expect.poll(async()=>(await measure(page)).transcript.scrollTop).toBeGreaterThan(0);
      const after=await measure(page);expect(after.header).toEqual(before.header);expect(after.composer).toEqual(before.composer);expect(after.worktable).toEqual(before.worktable);
    }
    const field=page.getByRole('textbox',{name:'Message',exact:true});
    await field.fill('A short line\nA second line\nA third line\nA fourth line');
    const grown=await measure(page);expect(grown.textarea.height).toBeGreaterThan(before.textarea.height);
    await field.fill(Array.from({length:30},(_,i)=>`Line ${i}`).join('\n'));
    const capped=await measure(page);expect(capped.textarea.height).toBeLessThanOrEqual(120);expect(capped.textarea.scrollHeight).toBeGreaterThan(capped.textarea.clientHeight);
    expect(capped.composer.bottom).toBe(before.composer.bottom);
    await page.screenshot({path:info.outputPath('long-draft.png')});
    await info.attach('draft-measurements',{body:JSON.stringify({grown,capped},null,2),contentType:'application/json'});
    await field.fill('');expect((await measure(page)).textarea.height).toBe(before.textarea.height);
    await field.fill('Send and return to compact');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(field).toHaveValue('');expect((await measure(page)).textarea.height).toBe(before.textarea.height);
    const plus=page.getByRole('button',{name:'Add attachment',exact:true});
    await plus.click();await expect(page.getByRole('menu',{name:'Attachments'})).toBeVisible();
    const menu=(await page.getByRole('menu').boundingBox())!;expect(menu.y).toBeGreaterThanOrEqual(0);expect(menu.x+menu.width).toBeLessThanOrEqual(viewport.width);
    await plus.click();await expect(page.getByRole('menu')).toHaveCount(0);
    await plus.click();await page.keyboard.press('Escape');await expect(plus).toBeFocused();
    await plus.click();await page.locator('.section-heading').click();await expect(page.getByRole('menu')).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles({name:'layout-note.txt',mimeType:'text/plain',buffer:Buffer.from('Layout fixture')});
    expect((await page.locator('.pending-files li').boundingBox())!.height).toBeLessThanOrEqual(44);
    await page.getByRole('button',{name:'Remove layout-note.txt'}).click();await expect(page.locator('.pending-files li')).toHaveCount(0);
    // The rail's last section remains reachable without moving the room shell.
    if(viewport.width<900)await page.locator('.oversight-trigger').click();
    await page.locator('.activity>summary').scrollIntoViewIfNeeded();await expect(page.locator('.activity>summary')).toBeInViewport();
    if(viewport.width<900)await page.locator('.sheet-bar button').click();
    expect((await measure(page)).composer).toEqual(before.composer);
    if(viewport.width>=1180){await page.getByRole('button',{name:'Briefing',exact:false}).click();const briefing=await measure(page);expect(briefing.composer.bottom).toBe(before.composer.bottom);expect(briefing.shell.scrollHeight).toBe(briefing.shell.clientHeight)}
  });
}
for(const colorScheme of ['light','dark'] as const)test(`the send button uses the app's primary-action colours and states in ${colorScheme} mode`,async({page})=>{
  await page.emulateMedia({colorScheme});
  await page.setViewportSize({width:1440,height:900});await openRoom(page);
  const send=page.getByRole('button',{name:'Send message'});
  const look=()=>send.evaluate(el=>{const s=getComputedStyle(el),root=getComputedStyle(document.documentElement);
    const probe=(v:string)=>{const d=document.createElement('i');d.style.color=`var(${v})`;document.body.append(d);const c=getComputedStyle(d).color;d.remove();return c};
    return {background:s.backgroundColor,color:s.color,opacity:s.opacity,ink:probe('--ink'),onInk:probe('--on-ink'),moss:probe('--moss'),scheme:root.colorScheme}});
  // Nothing to send: the usual dimmed primary, not a different colour.
  await expect(send).toBeDisabled();
  let state=await look();
  expect(state.background).toBe(state.ink);expect(state.color).toBe(state.onInk);expect(state.opacity).toBe('0.4');
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Ready to send');
  await expect(send).toBeEnabled();
  await page.waitForTimeout(200);
  state=await look();
  expect(state.background).toBe(state.ink);expect(state.color).toBe(state.onInk);expect(state.opacity).toBe('1');
  // The arrow stays legible against its own background in either theme.
  expect(state.color).not.toBe(state.background);
  await send.hover();await page.waitForTimeout(200);
  state=await look();
  expect(state.background).toBe(state.ink);expect(state.background).not.toBe(state.moss);expect(state.opacity).toBe('0.88');
});
