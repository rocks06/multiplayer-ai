import {test,expect,type BrowserContext} from '@playwright/test';
import {readFile} from 'node:fs/promises';

// Synthetic PNG, not a user file and not a model-produced artifact. These tests exercise the
// real local API/database/storage/realtime/browser boundary, without contacting an agent/model.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=','base64');
let cachedCookies:Awaited<ReturnType<BrowserContext['cookies']>>|undefined;
async function authenticate(context:BrowserContext){
 if(cachedCookies){await context.addCookies(cachedCookies);return;}
 const email='alex@multiplayer.local';
 expect((await context.request.post('/v1/auth/sign-in-links',{data:{email}})).ok()).toBeTruthy();
 const {token}=await (await context.request.get(`/__e2e/auth-token?email=${encodeURIComponent(email)}`)).json();
 expect((await context.request.post('/v1/auth/sessions',{data:{token}})).ok()).toBeTruthy();
 cachedCookies=await context.cookies();
}

test('a live agent attachment arrives without reload and downloads its exact bytes',async({browser,request},testInfo)=>{
 const f=await (await request.get('/__e2e/fixture')).json();
 const context=await browser.newContext({viewport:{width:1280,height:720}});
 await authenticate(context);
 const page=await context.newPage();
 try{
  await page.goto(`/rooms/${f.companyId}/${f.roomId}`);
  await expect(page.getByRole('textbox',{name:'Message'})).toBeVisible();
  const minted=await context.request.post(`/v1/companies/${f.companyId}/agents/${f.agentAId}/gateway-credentials`,{data:{label:'isolated browser test'}});
  expect(minted.ok(),await minted.text()).toBeTruthy();
  const credential=(await minted.json()).credential_token;
  const sessionResponse=await context.request.post('/v1/agent-gateway/v1/sessions',{
   headers:{authorization:`Bearer ${credential}`},data:{room_id:f.roomId}});
  expect(sessionResponse.ok(),await sessionResponse.text()).toBeTruthy();
  const session=await sessionResponse.json();
  const headers={authorization:`Bearer ${session.session_token}`};
  const base=`/v1/agent-gateway/v1/sessions/${session.session_id}`;
  const uploaded=await context.request.post(`${base}/artifacts?filename=agent-proof.png&content_type=image%2Fpng`,{
   headers:{...headers,'content-type':'application/octet-stream'},data:png});
  expect(uploaded.ok(),await uploaded.text()).toBeTruthy();
  const artifact=await uploaded.json();
  const sent=await context.request.post(`${base}/messages`,{
   headers:{...headers,'idempotency-key':crypto.randomUUID()},
   data:{body:'Browser artifact delivery proof',artifact_ids:[artifact.id]}});
  expect(sent.ok(),await sent.text()).toBeTruthy();
  const message=page.locator('article').filter({hasText:'Browser artifact delivery proof'});
  await expect(message).toContainText('agent-proof.png');
  await expect(message.getByRole('button',{name:/Preview/})).toBeVisible();
  const downloadEvent=page.waitForEvent('download');
  await message.getByRole('button',{name:/Download/}).click();
  const download=await downloadEvent;
  expect(download.suggestedFilename()).toBe('agent-proof.png');
  expect(await readFile((await download.path())!)).toEqual(png);
  await page.screenshot({path:testInfo.outputPath('artifact-live-air-size.png'),fullPage:true});
 }finally{await context.close()}
});

test('human plus picker supports removal, file-only send and preview',async({page,context})=>{
  const fixture=await(await page.request.get('/__e2e/fixture')).json();await authenticate(context);
  await page.goto(`/rooms/${fixture.companyId}/${fixture.roomId}`);
  await page.getByRole('button',{name:'Add attachment',exact:true}).click();
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('menuitem',{name:'Photo/Image'}).click();
  await(await chooser).setFiles({name:'human-image.png',mimeType:'image/png',buffer:png});
  await expect(page.getByRole('button',{name:'Remove human-image.png'})).toBeVisible();
  await page.getByRole('button',{name:'Remove human-image.png'}).click();
  await expect(page.getByRole('button',{name:'Remove human-image.png'})).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles({name:'human-image.png',mimeType:'image/png',buffer:png});
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  const card=page.locator('[data-artifact-id]').filter({hasText:'human-image.png'}).first();
  await expect(card).toBeVisible();await card.getByRole('button',{name:'Preview',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Preview: human-image.png'})).toBeVisible();
  await expect(page.getByRole('img',{name:'human-image.png',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close preview'}).click();
  await expect(page.getByRole('dialog',{name:'Preview: human-image.png'})).toHaveCount(0);
});

test('room fits laptop viewports while its composer remains visible',async({browser,request},testInfo)=>{
 const f=await (await request.get('/__e2e/fixture')).json();
 const context=await browser.newContext();await authenticate(context);
 const page=await context.newPage();
 try{
  await page.goto(`/rooms/${f.companyId}/${f.roomId}`);
  for(const size of [{width:1280,height:720},{width:1440,height:900},{width:1024,height:640}]){
   await page.setViewportSize(size);
   const composer=page.getByRole('textbox',{name:'Message'});
   await expect(composer).toBeVisible();
   const box=await composer.boundingBox();
   expect(box!.y+box!.height).toBeLessThanOrEqual(size.height);
   expect(await page.evaluate(()=>({
    horizontal:document.documentElement.scrollWidth>document.documentElement.clientWidth,
    vertical:document.documentElement.scrollHeight>document.documentElement.clientHeight,
    shell:[...document.querySelectorAll('.shell-body')].some(el=>el.scrollHeight>el.clientHeight+1),
   }))).toEqual({horizontal:false,vertical:false,shell:false});
  }
  await page.screenshot({path:testInfo.outputPath('room-1024x640.png'),fullPage:true});
 }finally{await context.close()}
});
