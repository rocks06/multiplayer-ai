import {useEffect,useRef,useState} from 'react';
import {Download,FileText,Plus,X} from 'lucide-react';
import {commandKey,type RoomApi} from './api';
import type {Artifact,Member} from './types';
import './attachments.css';

export const fileSize=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
export const previewKind=(type:string)=>['image/png','image/jpeg','image/webp','image/gif'].includes(type)?'image':type==='application/pdf'?'pdf':['text/plain','text/markdown','text/csv'].includes(type)?'text':null;

/** No storage URL navigation, no HTML/SVG interpretation. Text is always escaped by React. */
export function AttachmentCard({artifact,api}:{artifact:Artifact;api:Pick<RoomApi,'artifactBytes'>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [preview,setPreview]=useState<{url?:string;text?:string}|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const kind=previewKind(artifact.content_type);
  useEffect(()=>()=>{if(preview?.url)URL.revokeObjectURL(preview.url)},[preview]);
  useEffect(()=>{if(preview)dialog.current?.showModal()},[preview]);
  const act=async(show:boolean)=>{
    if(busy)return;setBusy(true);setError('');
    try{
      const bytes=await api.artifactBytes(artifact.id);
      if(show&&kind==='text')setPreview({text:await bytes.text()});
      else {
        const url=URL.createObjectURL(new Blob([bytes],{type:show?artifact.content_type:'application/octet-stream'}));
        if(show)setPreview({url});
        else {const a=document.createElement('a');a.href=url;a.download=artifact.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);}
      }
    }catch(problem){setError((problem as Error).message)}finally{setBusy(false)}
  };
  const available=!artifact.status||artifact.status==='ready';
  return <article className="attachment-card" data-artifact-id={artifact.id} aria-label={`File: ${artifact.filename}`}>
    <FileText size={21} aria-hidden="true"/><div className="attachment-copy"><strong>{artifact.filename}</strong><small>{artifact.content_type} · {fileSize(artifact.byte_size)}</small>{artifact.creator_display_name&&<small>Shared by {artifact.creator_display_name}</small>}</div>
    <div className="attachment-actions"><button type="button" disabled={busy||!available||!kind} title={!kind?'Preview unavailable for this file type':undefined} onClick={()=>void act(true)}>Preview</button><button type="button" disabled={busy||!available} onClick={()=>void act(false)}><Download size={13}/>Download</button></div>
    {!available&&<p role="status">File unavailable — ask the sender to upload it again.</p>}
    {busy&&<small role="status">Reading file…</small>}{error&&<p className="form-error" role="alert">{error} Use Preview or Download to retry.</p>}
    {preview&&<dialog ref={dialog} className="file-preview" aria-label={`Preview: ${artifact.filename}`} onClose={()=>setPreview(null)}>
      <header><strong>{artifact.filename}</strong><button type="button" onClick={()=>dialog.current?.close()} aria-label="Close preview"><X size={18}/></button></header>
      {kind==='text'?<pre>{preview.text}</pre>:kind==='image'?<img src={preview.url} alt={artifact.filename}/>:<iframe title={artifact.filename} src={preview.url} sandbox=""/>}
    </dialog>}
  </article>;
}

export function RoomFiles({api,sequence}:{api:RoomApi;sequence:number}){
  const [files,setFiles]=useState<Artifact[]>([]),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{let live=true;void api.artifacts().then(data=>{if(live){setFiles(data.artifacts??[]);setError('')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[api,sequence,retry]);
  return <details className="room-files"><summary className="section-label">Files · {files.length}</summary>
    <div className="rail-section-content">{error?<p role="alert">Files could not be loaded. <button onClick={()=>setRetry(n=>n+1)}>Retry</button></p>:files.length?files.map(file=><AttachmentCard key={file.id} artifact={file} api={api}/>):<p className="small-empty">No shared files yet. Attach a file with +.</p>}</div>
  </details>;
}

type PendingFile={key:string;file:File;artifact?:Artifact;error?:string};
export function AttachmentComposer({members,onSend,to,onAddressee,focusToken,api}:{members:Member[];onSend:(body:string,to:string|undefined,ids:string[],key:string)=>Promise<void>;to:string;onAddressee:(id:string)=>void;focusToken:number;api:Pick<RoomApi,'uploadArtifact'>}){
  const [body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[files,setFiles]=useState<PendingFile[]>([]),[menu,setMenu]=useState(false);
  const field=useRef<HTMLTextAreaElement>(null),picker=useRef<HTMLInputElement>(null);
  const sending=useRef(false),attempt=useRef<{payload:string;key:string}|null>(null);
  useEffect(()=>{if(focusToken)field.current?.focus()},[focusToken]);
  const add=(incoming:File[])=>{if(sending.current)return;setError('');setFiles(current=>[...current,...incoming.map(file=>({key:commandKey(),file,error:file.size===0?'File is empty':file.size>50*1024*1024?'File exceeds 50 MB':undefined}))]);setMenu(false)};
  const submit=async()=>{
    if(sending.current||(!body.trim()&&!files.length))return;
    if(files.length>10){setError('Attach at most ten files per message. Remove extra files before sending.');return;}
    if(files.some(item=>item.file.size===0||item.file.size>50*1024*1024)){setError('Remove invalid files before sending.');return;}
    sending.current=true;setBusy(true);setError('');
    try{
      const ids:string[]=[];
      for(const item of files){
        let artifact=item.artifact;
        if(!artifact){
          try {artifact=await api.uploadArtifact(item.file);const uploaded=artifact;setFiles(current=>current.map(p=>p.key===item.key?{...p,artifact:uploaded,error:undefined}:p));}
          catch(e){setFiles(current=>current.map(p=>p.key===item.key?{...p,error:(e as Error).message}:p));throw e;}
        }
        ids.push(artifact.id);
      }
      const payload=JSON.stringify([body.trim(),to,ids]);
      if(attempt.current?.payload!==payload)attempt.current={payload,key:commandKey()};
      await onSend(body.trim(),to||undefined,ids,attempt.current.key);
      setBody('');setFiles([]);attempt.current=null;
    }catch(e){setError(`${(e as Error).message} Nothing has been cleared. Retry sending; uploaded files stay shared in this room.`)}
    finally{sending.current=false;setBusy(false)}
  };
  const choose=(accept:string)=>{if(!picker.current)return;picker.current.accept=accept;picker.current.click();setMenu(false)};
  return <form className="composer" aria-label="Send a room message" data-onboarding="conversation" onSubmit={e=>{e.preventDefault();void submit()}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()}} onDrop={e=>{e.preventDefault();add(Array.from(e.dataTransfer.files))}}>
    <div className="composer-meta"><label>Send to <select value={to} disabled={busy} onChange={e=>onAddressee(e.target.value)}><option value="">Everyone</option>{members.map(m=><option value={m.principal_id} key={m.principal_id}>{m.display_name}</option>)}</select></label><span>Enter to send · Shift Enter for a new line</span></div>
    {files.length>0&&<details className="pending-files" open><summary>{files.length} attachment{files.length===1?'':'s'} · shared on upload</summary><ul>{files.map(item=><li key={item.key}><span>{item.file.name} · {fileSize(item.file.size)} <small>{item.artifact?'Uploaded':item.error??'Ready to upload'}</small></span><button type="button" disabled={busy} aria-label={`Remove ${item.file.name}`} onClick={()=>setFiles(current=>current.filter(p=>p.key!==item.key))}><X size={14}/></button></li>)}</ul></details>}
    <div className="composer-input"><div className="attach-control"><button type="button" aria-label="Add attachment" aria-expanded={menu} disabled={busy} onClick={()=>setMenu(v=>!v)}><Plus size={18}/></button>{menu&&<div className="attach-menu" role="menu" onKeyDown={e=>{if(e.key==='Escape')setMenu(false)}}>{[['File',''],['Photo/Image','image/*'],['Document/PDF','application/pdf'],['Other file','']].map(([label,accept])=><button type="button" role="menuitem" key={label} onClick={()=>choose(accept!)}>{label}</button>)}</div>}</div>
      <input hidden ref={picker} type="file" multiple aria-label="Choose attachments" onChange={e=>{add(Array.from(e.target.files??[]));e.target.value=''}}/>
      <textarea ref={field} aria-label="Message" placeholder="Write a message or drop a file…" value={body} disabled={busy} rows={2} onChange={e=>setBody(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submit()}}}/><button disabled={busy||(!body.trim()&&!files.length)} aria-label="Send message">{busy?'…':'↑'}</button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
  </form>;
}
