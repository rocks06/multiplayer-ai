import {test,expect} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';

// Real browser + production components/CSS, explicitly fake upload/send boundary.
// Existing end-to-end suites exercise persistence; this suite never connects to a DB.
let server:ViteDevServer,origin:string,fixtureSource='';
test.beforeAll(async()=>{
  server=await createServer({configFile:false,appType:'custom',plugins:[{name:'attachment-fixture',resolveId(id){if(id==='/attachment-fixture.js')return '\0attachment-fixture'},load(id){if(id==='\0attachment-fixture')return fixtureSource}}],root:fileURLToPath(new URL('../../apps/web',import.meta.url)),server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'}});
  server.middlewares.use('/__attachments',async(_req,res,next)=>{
    try{
      const html=await server.transformIndexHtml('/__attachments',`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      :root{--surface:#fff;--ink:#242424;--ink-2:#737373;--line:#dedede;--soft:#f3f3f3}body{margin:16px;font:14px -apple-system,BlinkMacSystemFont,sans-serif}.composer{position:fixed;bottom:24px;left:16px;right:16px}.composer-meta{margin-bottom:8px}.composer-meta span{display:none}textarea{font:inherit}button{cursor:pointer}
      </style></head><body><button id="outside">Outside</button><div id="root"></div><script type="module">
      import React from 'react';import {createRoot} from 'react-dom/client';import {AttachmentComposer,AttachmentCard} from '/src/Attachments.tsx';
      const h=React.createElement;window.uploads=[];window.sends=[];const bytes=new Map();
      const api={uploadArtifact:async(file)=>{window.uploads.push(file.name);const a={id:String(window.uploads.length),filename:file.name,content_type:file.type,byte_size:file.size,status:'ready'};bytes.set(a.id,file);return a},artifactBytes:async(id)=>bytes.get(id)};
      function Fixture(){const [cards,setCards]=React.useState([]);return h(React.Fragment,null,...cards.map(a=>h(AttachmentCard,{key:a.id,artifact:a,api})),h(AttachmentComposer,{members:[],to:'',onAddressee:()=>{},focusToken:0,api,onSend:async(body,to,ids,key)=>{window.sends.push({body,ids,key});setCards(ids.map(id=>({id,filename:bytes.get(id).name,content_type:bytes.get(id).type,byte_size:bytes.get(id).size,status:'ready'})))}}))}
      createRoot(document.getElementById('root')).render(h(Fixture));
      </script></body></html>`.replace(/<script type="module">([\s\S]*?)<\/script>/,(_match,source)=>{fixtureSource=source;return '<script type="module" src="/attachment-fixture.js"></script>'}));
      res.setHeader('Content-Type','text/html');res.end(html);
    }catch(error){next(error)}
  });
  await server.listen();origin=server.resolvedUrls!.local[0]!;
});
test.afterAll(async()=>{await server?.close()});
test.beforeEach(async({page})=>{await page.goto(`${origin}__attachments`)});

test('compact icon menu toggles and dismisses outside and on Escape',async({page},testInfo)=>{
  const plus=page.getByRole('button',{name:'Add attachment',exact:true}),menu=page.getByRole('menu');
  await plus.click();await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['File','Photo','Document']);
  await expect(menu.locator('svg')).toHaveCount(3);
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(180);
  await menu.screenshot({path:testInfo.outputPath('attachment-popover.png')});
  await plus.click();await expect(menu).toHaveCount(0);
  await plus.click();await page.locator('#outside').click();await expect(menu).toHaveCount(0);
  await plus.click();await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(plus).toBeFocused();
  await plus.focus();await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitem',{name:'File',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitem',{name:'Photo',exact:true})).toBeFocused();
  await page.keyboard.press('End');await expect(page.getByRole('menuitem',{name:'Document',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');await expect(menu).toHaveCount(0);
});

for(const [label,accept] of [['File',''],['Photo','image/*'],['Document','application/pdf']]){
  test(`${label} picker closes, preserves a compact removable chip and resets for reselection`,async({page})=>{
    await page.setViewportSize({width:375,height:667});
    const plus=page.getByRole('button',{name:'Add attachment',exact:true});await plus.click();
    const chooser=page.waitForEvent('filechooser');await page.getByRole('menuitem',{name:label,exact:true}).click();
    const input=await chooser;await expect(page.getByRole('menu')).toHaveCount(0);
    expect(await input.element().getAttribute('accept')).toBe(accept);
    await input.setFiles({name:'quarterly-report-with-a-very-long-name.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n%%EOF')});
    const chip=page.locator('.pending-files li');await expect(chip).toContainText('quarterly-report');
    expect((await chip.boundingBox())!.height).toBeLessThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Remove quarterly-report-with-a-very-long-name.pdf'}).click();await expect(chip).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles({name:'proof.txt',mimeType:'text/plain',buffer:Buffer.from('Attachment preview proof')});
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await expect(chip).toHaveCount(0);await expect(page.locator('.attachment-card')).toContainText('proof.txt');
    await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Attachment preview proof');
    await page.getByRole('button',{name:'Close preview'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(()=>({uploads:(window as any).uploads,sends:(window as any).sends.length}))).toEqual({uploads:['proof.txt'],sends:1});
  });
}
