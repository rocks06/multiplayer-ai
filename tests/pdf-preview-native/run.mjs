// node tests/pdf-preview-native/run.mjs — isolated real macOS WKWebView acceptance.
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url));
const evidence=await mkdtemp(join(tmpdir(),'mpai-pdf-preview-'));
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:true}});
try{
  await server.listen();
  const port=server.httpServer.address().port;
  const url=`http://127.0.0.1:${port}/tests/pdf-preview-native/`;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('swift',process.env.MPAI_FULL_SWIFT==='1'?['test']:['test','--filter','PDFPreviewTests'],{cwd:join(root,'apps/connector-macos'),env:{...process.env,PDF_PREVIEW_TEST_URL:url,PDF_PREVIEW_EVIDENCE_DIR:evidence},stdio:'inherit'});
    child.on('error',reject);child.on('exit',resolve);
  });
  console.log(`PDF preview evidence: ${evidence}`);
  process.exitCode=result??1;
}finally{await server.close()}
