import {test,expect,type APIRequestContext,type BrowserContext,type Page,type WebSocketRoute} from '@playwright/test';

type Fixture={companyId:string;roomId:string;alexId:string;sarahId:string};
const roomUrl=(f:Fixture)=>`/rooms/${f.companyId}/${f.roomId}`;
async function send(page:Page,text:string){await page.getByRole('textbox',{name:'Message'}).fill(text);await page.getByRole('button',{name:'Send message'}).click()}
async function trigger(request:APIRequestContext,path:string,method:'post'|'delete'='post'){const response=await request[method](path);expect(response.ok(),await response.text()).toBeTruthy();return response.json()}
async function capturedToken(context:BrowserContext,email:string){
 const captured=await context.request.get(`/__e2e/auth-token?email=${encodeURIComponent(email)}`);
 const {token}=await captured.json();expect(token).toBeTruthy();return token as string;
}
async function authenticate(context:BrowserContext,email:string){
 const issued=await context.request.post('/v1/auth/sign-in-links',{data:{email}});expect(issued.ok()).toBeTruthy();
 const token=await capturedToken(context,email);
 const session=await context.request.post('/v1/auth/sessions',{data:{token}});expect(session.ok(),await session.text()).toBeTruthy();
}

test('signed-out invitee creates an account, resumes the invite, and shares live room state',async({browser,request},testInfo)=>{
 const fixture=await (await request.get('/__e2e/fixture')).json() as Fixture;
 const contextA=await browser.newContext(),contextB=await browser.newContext();
 await authenticate(contextA,'alex@multiplayer.local');
 const alex=await contextA.newPage(),invitee=await contextB.newPage();
 const email=`invitee-${Date.now()}@multiplayer.local`;
 try{
  await alex.goto(roomUrl(fixture));
  await expect(alex.getByRole('status')).toHaveText(/Live/);
  await alex.getByRole('button',{name:'Share'}).click();
  const dialog=alex.getByRole('dialog',{name:/Invite someone to Launch room/});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/single-use link/)).toBeVisible();
  const inviteUrl=await dialog.getByLabel('Invitation link').inputValue();
  expect(inviteUrl).toContain('/join#');
  await alex.screenshot({path:testInfo.outputPath('share-room.png'),fullPage:true});
  await dialog.getByRole('button',{name:'Close invitation'}).click();

  await invitee.goto(inviteUrl);
  await expect(invitee.getByRole('heading',{name:'Launch room'})).toBeVisible();
  await expect(invitee.getByText(/invited to collaborate in Multiplayer Studio/)).toBeVisible();
  await invitee.screenshot({path:testInfo.outputPath('join-room.png'),fullPage:true});
  await invitee.getByRole('button',{name:'Create an account'}).click();
  await expect(invitee.getByRole('heading',{name:'Create your account'})).toBeVisible();
  await invitee.getByLabel('Your name').fill('Invited Human');
  await invitee.getByLabel('Work email').fill(email);
  await invitee.getByRole('button',{name:/Create account/}).click();
  await expect(invitee.getByRole('heading',{name:'Check your email'})).toBeVisible();

  const token=await capturedToken(contextB,email);
  await invitee.goto(`/signin?token=${encodeURIComponent(token)}`);
  await expect(invitee).toHaveURL(new RegExp(`/rooms/${fixture.companyId}/${fixture.roomId}$`));
  await expect(invitee.getByRole('status')).toHaveText(/Live/);
  await expect(invitee.getByRole('heading',{name:'Launch room'})).toBeVisible();
  await expect(invitee.getByRole('button',{name:'Share'})).toHaveCount(0);

  await send(alex,'Account A realtime marker');
  await expect(invitee.getByText('Account A realtime marker')).toBeVisible();
  await send(invitee,'Account B realtime marker');
  await expect(alex.getByText('Account B realtime marker')).toBeVisible();
  await invitee.screenshot({path:testInfo.outputPath('joined-room.png'),fullPage:true});
 }finally{await contextA.close();await contextB.close()}
});

test('two humans supervise synchronized agent work, decisions, reconnect, and revocation',async({browser,request},testInfo)=>{
 const fixture=await (await request.get('/__e2e/fixture')).json() as Fixture;
 const contextA=await browser.newContext(),contextB=await browser.newContext();
 await Promise.all([authenticate(contextA,'alex@multiplayer.local'),authenticate(contextB,'sarah@multiplayer.local')]);
 let sarahSocket:WebSocketRoute|undefined,holdReconnect=false,releaseReconnect!:()=>void;
 const reconnectGate=new Promise<void>(resolve=>{releaseReconnect=resolve});
 await contextB.routeWebSocket(/\/stream(?:\?|$)/,async socket=>{
  sarahSocket=socket;
  if(holdReconnect)await reconnectGate;
  socket.connectToServer();
 });
 const alex=await contextA.newPage(),sarah=await contextB.newPage();
 try{
  await Promise.all([alex.goto(roomUrl(fixture)),sarah.goto(roomUrl(fixture))]);
  await Promise.all([expect(alex.getByRole('status')).toHaveText(/Live/),expect(sarah.getByRole('status')).toHaveText(/Live/)]);
  for(const page of [alex,sarah]){
   await expect(page.getByRole('heading',{name:'Launch room'})).toBeVisible();
   const participants=page.getByRole('complementary',{name:'Room participants'});
   for(const name of ['Alex Morgan','Sarah Chen',"Alex's Agent","Sarah's Agent"])await expect(participants.getByText(name,{exact:false}).first()).toBeVisible();
   await expect(participants.getByText('Never connected',{exact:true}).first()).toBeVisible();
  }
  const mobileContext=await browser.newContext({viewport:{width:390,height:844}}),mobile=await mobileContext.newPage();
  await authenticate(mobileContext,'alex@multiplayer.local');
  await mobile.goto(roomUrl(fixture));
  await expect(mobile.getByRole('heading',{name:'Launch room'})).toBeVisible();
  await expect(mobile.getByRole('textbox',{name:'Message'})).toBeVisible();
  await mobile.getByRole('button',{name:/agents/}).click();
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
  await expect(alex.getByText("Alex's Agent · Completed",{exact:true})).toBeVisible();

  expect((await trigger(request,'/__e2e/agent-b')).result).toBe('waiting_for_decision');
  const question='May I publish the verified launch note to the shared release workspace?';
  await alex.getByTestId('decision-card').getByRole('button',{name:'Review'}).click();
  await expect(alex.getByTestId('decision-card')).toContainText(question);
  await expect(sarah.getByText(/asked for a decision · Authorize launch note/)).toBeVisible();
  await expect(sarah.getByTestId('decision-card')).toHaveCount(0);
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
