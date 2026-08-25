import {test,expect,type APIRequestContext,type Page,type WebSocketRoute} from '@playwright/test';

type Fixture={companyId:string;roomId:string;alexId:string;sarahId:string};
const roomUrl=(f:Fixture,principal:string)=>`/rooms/${f.companyId}/${f.roomId}?principal=${principal}`;
async function send(page:Page,text:string){await page.getByRole('textbox',{name:'Message'}).fill(text);await page.getByRole('button',{name:'Send message'}).click()}
async function trigger(request:APIRequestContext,path:string,method:'post'|'delete'='post'){const response=await request[method](path);expect(response.ok(),await response.text()).toBeTruthy();return response.json()}

test('two humans supervise synchronized agent work, decisions, reconnect, and revocation',async({browser,request},testInfo)=>{
 const fixture=await (await request.get('/__e2e/fixture')).json() as Fixture;
 const contextA=await browser.newContext(),contextB=await browser.newContext();
 let sarahSocket:WebSocketRoute|undefined,holdReconnect=false,releaseReconnect!:()=>void;
 const reconnectGate=new Promise<void>(resolve=>{releaseReconnect=resolve});
 await contextB.routeWebSocket(/\/stream(?:\?|$)/,async socket=>{
  sarahSocket=socket;
  if(holdReconnect)await reconnectGate;
  socket.connectToServer();
 });
 const alex=await contextA.newPage(),sarah=await contextB.newPage();
 try{
  await Promise.all([alex.goto(roomUrl(fixture,fixture.alexId)),sarah.goto(roomUrl(fixture,fixture.sarahId))]);
  await Promise.all([expect(alex.getByRole('status')).toHaveText(/Live/),expect(sarah.getByRole('status')).toHaveText(/Live/)]);
  for(const page of [alex,sarah]){
   await expect(page.getByRole('heading',{name:'Launch room'})).toBeVisible();
   for(const name of ['Alex Morgan','Sarah Chen',"Alex's Agent","Sarah's Agent"])await expect(page.getByText(name,{exact:false}).first()).toBeVisible();
   await expect(page.getByText(/Working · worker agent/).first()).toBeVisible();
  }
  const mobileContext=await browser.newContext({viewport:{width:390,height:844}}),mobile=await mobileContext.newPage();
  await mobile.goto(roomUrl(fixture,fixture.alexId));
  await expect(mobile.getByRole('heading',{name:'Launch room'})).toBeVisible();
  await expect(mobile.getByRole('textbox',{name:'Message'})).toBeVisible();
  await expect(mobile.getByText('Shared work',{exact:true})).toBeVisible();
  expect(await mobile.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  await mobile.waitForTimeout(350);
  await mobile.screenshot({path:testInfo.outputPath('room-mobile.png'),fullPage:true});
  await mobileContext.close();
  await alex.waitForTimeout(350);
  await alex.screenshot({path:testInfo.outputPath('room-working.png'),fullPage:true});

  expect((await trigger(request,'/__e2e/agent-a')).result).toBe('completed');
  const handoff='Source review complete: retention and setup-time claims are verified. Use citations A12 and B07.';
  await Promise.all([expect(alex.getByText(handoff)).toBeVisible(),expect(sarah.getByText(handoff)).toBeVisible()]);
  await expect(alex.getByRole('button',{name:'Verify launch claims: Completed'})).toBeVisible();

  expect((await trigger(request,'/__e2e/agent-b')).result).toBe('waiting_for_decision');
  const question='May I publish the verified launch note to the shared release workspace?';
  await Promise.all([expect(alex.getByTestId('decision-card')).toContainText(question),expect(sarah.getByTestId('decision-card')).toContainText(question)]);
  await expect(sarah.getByText('A room manager can resolve this decision.')).toBeVisible();
  await expect(sarah.getByRole('button',{name:'Approve'})).toHaveCount(0);
  await alex.waitForTimeout(350);
  await alex.screenshot({path:testInfo.outputPath('room-decision.png'),fullPage:true});

  await alex.getByPlaceholder('Add a condition or next step').fill('Proceed with citations visible');
  await alex.getByRole('button',{name:'Approve'}).click();
  await Promise.all([expect(alex.getByTestId('decision-card')).toHaveCount(0),expect(sarah.getByTestId('decision-card')).toHaveCount(0)]);
  expect((await trigger(request,'/__e2e/agent-b')).result).toBe('completed');
  const resumed='Approval received. I am applying the instruction and preparing the release note now.';
  await Promise.all([expect(alex.getByText(resumed)).toBeVisible(),expect(sarah.getByText(resumed)).toBeVisible()]);

  holdReconnect=true;
  await sarahSocket!.close({code:1012,reason:'E2E disconnect window'});
  await expect(sarah.getByRole('status')).toHaveText(/Offline|Reconnecting/);
  await send(alex,'Reconnect marker: room state advanced while Sarah was offline.');
  await expect(alex.getByText('Reconnect marker: room state advanced while Sarah was offline.')).toBeVisible();
  releaseReconnect();
  await expect(sarah.getByRole('status')).toHaveText(/Live/,{timeout:12_000});
  await expect(sarah.getByText('Reconnect marker: room state advanced while Sarah was offline.')).toBeVisible();

  await trigger(request,'/__e2e/sarah-access','delete');
  await expect(sarah.getByRole('alert')).toContainText('Room access removed');
  await expect(alex.getByRole('status')).toHaveText(/Live/);
 }finally{await contextA.close();await contextB.close()}
});
