import {test,expect,type BrowserContext} from '@playwright/test';

/* Against the real API, database and built web app: the @mention picker, structured vs hand-typed
   mentions, the Home unread badge, and read receipts. The room is created here; names are fixtures. */
type Fixture={companyId:string;alexId:string;sarahId:string;agentAId:string};
async function authenticate(context:BrowserContext,email:string){
 const issued=await context.request.post('/v1/auth/sign-in-links',{data:{email}});expect(issued.ok()).toBeTruthy();
 const captured=await context.request.get(`/__e2e/auth-token?email=${encodeURIComponent(email)}`);
 const {token}=await captured.json();expect(token).toBeTruthy();
 const session=await context.request.post('/v1/auth/sessions',{data:{token}});expect(session.ok(),await session.text()).toBeTruthy();
}

test('mention picker, highlighted structured mentions, Home unread badge and read receipts',async({browser,request},testInfo)=>{
 const f=await (await request.get('/__e2e/fixture')).json() as Fixture;
 const alexContext=await browser.newContext(),sarahContext=await browser.newContext();
 await authenticate(alexContext,'alex@multiplayer.local');await authenticate(sarahContext,'sarah@multiplayer.local');
 const key=()=>({'idempotency-key':crypto.randomUUID()});
 const api=alexContext.request;
 const project=await (await api.post(`/v1/companies/${f.companyId}/projects`,{data:{name:'Mention fixture',objective:'Exercise attention'}})).json();
 const room=await (await api.post(`/v1/companies/${f.companyId}/projects/${project.id}/rooms`,{data:{name:'Attention room'}})).json();
 for(const [principal,role] of [[f.sarahId,'contributor'],[f.agentAId,'worker_agent']] as const)
  expect((await api.post(`/v1/companies/${f.companyId}/rooms/${room.id}/members`,{data:{principal_id:principal,role,responsibilities:''},headers:key()})).ok()).toBeTruthy();
 const alex=await alexContext.newPage(),sarah=await sarahContext.newPage();
 try{
  await alex.goto(`/rooms/${f.companyId}/${room.id}`);
  await expect(alex.getByRole('heading',{name:'Attention room'})).toBeVisible();
  // The first-visit tour takes focus when it appears; this test is about the composer, not the tour.
  const skipTour=alex.getByRole('button',{name:'Skip'});
  if(await skipTour.isVisible({timeout:1500}).catch(()=>false))await skipTour.click();
  const field=alex.getByRole('textbox',{name:'Message'});
  await field.click();
  await field.pressSequentially('Please @Sa');
  const picker=alex.getByRole('listbox',{name:'Mention someone in this room'});
  await expect(picker).toBeVisible();
  const box=(await picker.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);expect(box.height).toBeGreaterThan(20);
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('option',{name:/Sarah Chen/})).toContainText('Human');
  await alex.keyboard.press('Backspace');await alex.keyboard.press('Backspace');
  // With nothing typed after @, everyone in the room is offered: people and agents alike.
  await expect(picker.getByRole('option',{name:/Agent/})).toContainText('Agent');
  await field.pressSequentially('Sa');
  await alex.keyboard.press('Enter');
  await expect(field).toHaveValue('Please @Sarah Chen ');
  await field.pressSequentially('can you review?');
  await alex.screenshot({path:testInfo.outputPath('composer-picker.png')});
  await alex.keyboard.press('Enter');
  const structured=alex.locator('.message .mention',{hasText:'@Sarah Chen'});
  await expect(structured).toBeVisible();
  // Typed by hand without choosing: plain text, stored without a mention.
  if(await skipTour.isVisible().catch(()=>false))await skipTour.click();
  await field.click();
  await field.pressSequentially('@Sarah Chen typed by hand');
  await alex.keyboard.press('Escape');
  await alex.keyboard.press('Enter');
  await expect(alex.getByText('@Sarah Chen typed by hand')).toBeVisible();
  await expect(alex.locator('.message',{hasText:'typed by hand'}).locator('.mention')).toHaveCount(0);
  const snapshot=await (await api.get(`/v1/companies/${f.companyId}/rooms/${room.id}/snapshot`)).json();
  const [structuredMessage,handTyped]=snapshot.messages.slice(-2);
  expect(structuredMessage.mentions.map((m:any)=>m.principal_id)).toEqual([f.sarahId]);
  expect(handTyped.mentions).toEqual([]);

  // Sarah's Home: a round unread count on the room's card, cleared once she has the room open.
  await alex.goto('/home');
  await sarah.goto('/home');
  const card=sarah.getByRole('button',{name:/^Attention room, 2 unread, 1 mention/});
  await expect(card).toBeVisible();
  await expect(card.locator('.unread-badge')).toHaveText('2');
  const badge=(await card.locator('.unread-badge').boundingBox())!,frame=(await card.boundingBox())!;
  expect(badge.x+badge.width).toBeGreaterThan(frame.x+frame.width-12);expect(badge.y).toBeLessThan(frame.y+4);
  await sarah.screenshot({path:testInfo.outputPath('home-unread.png')});
  await card.click();
  await expect(sarah.getByRole('heading',{name:'Attention room'})).toBeVisible();
  await expect.poll(async()=>(await (await sarahContext.request.get(`/v1/companies/${f.companyId}/rooms`)).json()).rooms.find((r:any)=>r.room_id===room.id).unread_count,{timeout:5000}).toBe(0);
  await sarah.goto('/home');
  await expect(sarah.getByRole('button',{name:'Attention room'})).toBeVisible();
  await expect(sarah.getByRole('button',{name:'Attention room'}).locator('.unread-badge')).toHaveCount(0);

  // Alex sees who read his message, by name when asked.
  await alex.goto(`/rooms/${f.companyId}/${room.id}`);
  const receipt=alex.locator('.message',{hasText:'can you review?'}).getByRole('button',{name:/Seen by 1/});
  await expect(receipt).toBeVisible();
  await receipt.click();
  await expect(alex.locator('.message',{hasText:'can you review?'}).locator('.receipts dd')).toHaveText('Sarah Chen');
  await alex.screenshot({path:testInfo.outputPath('receipts.png')});
 }finally{await alexContext.close();await sarahContext.close()}
});
