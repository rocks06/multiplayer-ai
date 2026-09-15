import {useEffect,useState} from 'react';

type PDFReply={token?:string;pages?:number;image?:string};
type PDFBridge={postMessage:(message:Record<string,unknown>)=>Promise<PDFReply>};
export function nativePDFBridge():PDFBridge|undefined {
  return (window as unknown as {webkit?:{messageHandlers?:{multiplayerPDF?:PDFBridge}}}).webkit?.messageHandlers?.multiplayerPDF;
}

function base64(bytes:Blob):Promise<string>{
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{const data=String(reader.result).split(',')[1];if(data)resolve(data);else reject(new Error('This PDF is empty.'))};
    reader.onerror=()=>reject(new Error('Could not read this PDF.'));
    reader.readAsDataURL(bytes);
  });
}

/** The native renderer only returns inert PNG pixels, never PDF-provided markup or URLs. */
export function PDFPreview({bytes,filename}:{bytes:Blob;filename:string}){
  const [session,setSession]=useState<{token:string;pages:number}|null>(null);
  const [page,setPage]=useState(0),[image,setImage]=useState(''),[error,setError]=useState('');
  const [loaded,setLoaded]=useState(false);
  const [url,setURL]=useState('');
  const bridge=nativePDFBridge();
  useEffect(()=>{
    if(!bridge){
      const blob=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      setURL(blob);return()=>URL.revokeObjectURL(blob);
    }
    let live=true,token:string|undefined;
    setSession(null);setPage(0);setImage('');setError('');
    void base64(bytes).then(data=>live?bridge.postMessage({action:'open',data}):undefined).then(reply=>{
      if(!reply)return;
      token=reply.token;
      if(!token||!Number.isInteger(reply.pages)||reply.pages!<1)throw new Error('Could not open this PDF.');
      if(live)setSession({token,pages:reply.pages!});
      else void bridge.postMessage({action:'close',token}).catch(()=>{});
    }).catch(e=>{if(live)setError(e instanceof Error?e.message:String(e))});
    return()=>{live=false;if(token)void bridge.postMessage({action:'close',token}).catch(()=>{})};
  },[bytes,bridge]);
  useEffect(()=>{
    if(!bridge||!session)return;
    let live=true;setImage('');setLoaded(false);setError('');
    void bridge.postMessage({action:'page',token:session.token,page}).then(reply=>{
      if(!reply.image?.startsWith('data:image/png;base64,'))throw new Error('Could not render this PDF page.');
      if(live)setImage(reply.image);
    }).catch(e=>{if(live)setError(e instanceof Error?e.message:String(e))});
    return()=>{live=false};
  },[bridge,session,page]);
  if(!bridge)return <div className="pdf-browser-preview"><p>If the PDF is blank, close Preview and use Download to open it in your PDF reader.</p><iframe title={filename} src={url||undefined} sandbox=""/></div>;
  return <section className="pdf-preview" aria-label={`PDF pages: ${filename}`}>
    {session&&<nav aria-label="PDF pages"><button type="button" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous</button><span aria-live="polite">Page {page+1} of {session.pages}</span><button type="button" disabled={page+1===session.pages} onClick={()=>setPage(p=>p+1)}>Next</button></nav>}
    {error?<p role="alert">{error} Close Preview and retry, or use Download.</p>:<>
      {!loaded&&<p role="status">Rendering PDF page…</p>}
      {image&&<div className="pdf-page-scroll"><img src={image} alt={`${filename} — page ${page+1}`} onLoad={()=>setLoaded(true)} onError={()=>setError('Could not display this PDF page.')}/></div>}
    </>}
  </section>;
}
