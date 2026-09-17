import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Download,File as FileIcon,FileText,Image,Plus,X} from 'lucide-react';
import {commandKey,type RoomApi} from './api';
import type {Artifact,Member} from './types';
import './attachments.css';
import {PDFPreview} from './PDFPreview';
import {insertMention,mentionCandidates,mentionQuery,mentionRanges,type MentionRange,type MentionToken} from './mentions';

export const fileSize=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
export const previewKind=(type:string)=>['image/png','image/jpeg','image/webp','image/gif'].includes(type)?'image':type==='application/pdf'?'pdf':['text/plain','text/markdown','text/csv'].includes(type)?'text':null;

/** No storage URL navigation, no HTML/SVG interpretation. Text is always escaped by React. */
export function AttachmentCard({artifact,api}:{artifact:Artifact;api:Pick<RoomApi,'artifactBytes'>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [preview,setPreview]=useState<{url?:string;text?:string;pdf?:Blob}|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const kind=previewKind(artifact.content_type);
  useEffect(()=>()=>{if(preview?.url)URL.revokeObjectURL(preview.url)},[preview]);
  useEffect(()=>{if(preview)dialog.current?.showModal()},[preview]);
  const act=async(show:boolean)=>{
    if(busy)return;setBusy(true);setError('');
    try{
      const bytes=await api.artifactBytes(artifact.id);
      if(show&&kind==='text')setPreview({text:await bytes.text()});
      else if(show&&kind==='pdf')setPreview({pdf:bytes});
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
      {kind==='text'?<pre>{preview.text}</pre>:kind==='image'?<img src={preview.url} alt={artifact.filename}/>:preview.pdf&&<PDFPreview bytes={preview.pdf} filename={artifact.filename}/>}
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
export function AttachmentComposer({members,onSend,to,onAddressee,focusToken,api,ownerNames={}}:{members:Member[];onSend:(body:string,to:string|undefined,ids:string[],key:string,mentions:MentionRange[])=>Promise<void>;to:string;onAddressee:(id:string)=>void;focusToken:number;api:Pick<RoomApi,'uploadArtifact'>;ownerNames?:Record<string,string[]>}){
  const [body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[files,setFiles]=useState<PendingFile[]>([]),[menu,setMenu]=useState(false);
  const field=useRef<HTMLTextAreaElement>(null),picker=useRef<HTMLInputElement>(null);
  const sending=useRef(false),attempt=useRef<{payload:string;key:string}|null>(null);
  /* Mentions are chosen, not typed: the picker records who, and the ranges are worked out from the
     exact text at send time. They belong to messages to Everyone — Send to already routes a whole
     message to one participant. */
  const [tokens,setTokens]=useState<MentionToken[]>([]);
  const [picking,setPicking]=useState<{start:number;query:string;index:number}|null>(null);
  const listboxId=useId();
  const candidates=picking&&!to?mentionCandidates(members,picking.query,''):[];
  const track=(text:string,caret:number)=>{
    const found=to?null:mentionQuery(text,caret);
    setPicking(found?{...found,index:0}:null);
  };
  const choose=(member:Member)=>{
    if(!picking)return;
    const next=insertMention(body,picking,member);
    caretAfterUpdate.current=next.caret;
    setBody(next.text);setTokens(current=>[...current,{principal_id:member.principal_id,display_name:member.display_name}]);setPicking(null);
  };
  /* The caret goes after the inserted name in the same commit as the text. Deferring it to the
     next frame let a fast typist's next keys land before it moved, scrambling what they wrote. */
  const caretAfterUpdate=useRef<number|null>(null);
  useLayoutEffect(()=>{
    const caret=caretAfterUpdate.current,textarea=field.current;
    if(caret===null||!textarea)return;
    caretAfterUpdate.current=null;
    textarea.focus();textarea.setSelectionRange(caret,caret);
  },[body]);
  const attachControl=useRef<HTMLDivElement>(null),attachButton=useRef<HTMLButtonElement>(null),menuId=useId();
  useEffect(()=>{
    if(!menu)return;
    attachControl.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside=(event:Event)=>{if(!attachControl.current?.contains(event.target as Node))setMenu(false)};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setMenu(false);attachButton.current?.focus()}};
    document.addEventListener('pointerdown',outside);
    document.addEventListener('focusin',outside);
    document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape)};
  },[menu]);
  useEffect(()=>{if(focusToken)field.current?.focus()},[focusToken]);
  useLayoutEffect(()=>{
    const textarea=field.current;if(!textarea)return;
    // Measure content, not the surrounding grid. CSS keeps the familiar compact
    // two-line minimum and caps growth; longer drafts scroll inside the field.
    const resize=()=>{textarea.style.height='0px';textarea.style.height=`${textarea.scrollHeight}px`};
    resize();
    if(typeof ResizeObserver==='undefined'){
      window.addEventListener('resize',resize);
      return()=>window.removeEventListener('resize',resize);
    }
    let width=textarea.clientWidth;
    const observer=new ResizeObserver(()=>{if(textarea.clientWidth!==width){width=textarea.clientWidth;resize()}});
    observer.observe(textarea);
    return()=>observer.disconnect();
  },[body]);
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
      const text=body.trim();
      const ranges=to?[]:mentionRanges(text,tokens);
      const payload=JSON.stringify([text,to,ids,ranges]);
      if(attempt.current?.payload!==payload)attempt.current={payload,key:commandKey()};
      await onSend(text,to||undefined,ids,attempt.current.key,ranges);
      setBody('');setFiles([]);setTokens([]);setPicking(null);attempt.current=null;
    }catch(e){setError(`${(e as Error).message} Nothing has been cleared. Retry sending; uploaded files stay shared in this room.`)}
    finally{sending.current=false;setBusy(false)}
  };
  const chooseFile=(accept:string)=>{if(!picker.current)return;picker.current.accept=accept;setMenu(false);attachButton.current?.focus();picker.current.click()};
  return <form className="composer" aria-label="Send a room message" data-onboarding="conversation" onSubmit={e=>{e.preventDefault();void submit()}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()}} onDrop={e=>{e.preventDefault();add(Array.from(e.dataTransfer.files))}}>
    <div className="composer-meta"><label>Send to <select value={to} disabled={busy} onChange={e=>{onAddressee(e.target.value);setPicking(null)}}><option value="">Everyone</option>{members.map(m=><option value={m.principal_id} key={m.principal_id}>{m.display_name}</option>)}</select></label><span>Enter to send · Shift Enter for a new line</span></div>
    {files.length>0&&<details className="pending-files" open><summary>{files.length} attachment{files.length===1?'':'s'} · shared on upload</summary><ul>{files.map(item=><li key={item.key}><FileText size={16} aria-hidden="true"/><span className="pending-file-copy"><strong title={item.file.name}>{item.file.name}</strong><small title={item.error}>{fileSize(item.file.size)} · {item.artifact?'Uploaded':item.error??'Ready to upload'}</small></span><button type="button" disabled={busy} aria-label={`Remove ${item.file.name}`} onClick={()=>setFiles(current=>current.filter(p=>p.key!==item.key))}><X size={14}/></button></li>)}</ul></details>}
    <div className="composer-input"><div className="attach-control" ref={attachControl}><button ref={attachButton} type="button" aria-label="Add attachment" aria-haspopup="menu" aria-controls={menu?menuId:undefined} aria-expanded={menu} disabled={busy} onClick={()=>setMenu(v=>!v)} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setMenu(true)}}}><Plus size={18} aria-hidden="true"/></button>{menu&&<div id={menuId} className="attach-menu" role="menu" aria-label="Attachments" onKeyDown={e=>{
      if(e.key==='Tab'){setMenu(false);return}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
      e.preventDefault();
      const items=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const index=items.indexOf(document.activeElement as HTMLButtonElement);
      const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items[next]?.focus();
    }}>{[{label:'File',accept:'',Icon:FileIcon},{label:'Photo',accept:'image/*',Icon:Image},{label:'Document',accept:'application/pdf',Icon:FileText}].map(({label,accept,Icon})=><button type="button" role="menuitem" tabIndex={-1} key={label} onClick={()=>chooseFile(accept)}><Icon size={17} strokeWidth={1.7} aria-hidden="true"/><span>{label}</span></button>)}</div>}</div>
      <input hidden ref={picker} type="file" multiple aria-label="Choose attachments" onChange={e=>{add(Array.from(e.target.files??[]));e.target.value=''}}/>
      {candidates.length>0&&<ul id={listboxId} className="mention-picker" role="listbox" aria-label="Mention someone in this room">
        {candidates.map((member,index)=><li key={member.principal_id} id={`${listboxId}-${member.principal_id}`} role="option" aria-selected={index===picking!.index}
          onMouseDown={event=>{event.preventDefault();choose(member)}}>
          <span className={`mention-glyph ${member.kind}`} aria-hidden="true">{member.display_name.slice(0,1).toUpperCase()}</span>
          <span className="mention-name">{member.display_name}{member.kind==='agent'&&ownerNames[member.principal_id]?.length?<small>{ownerNames[member.principal_id]!.join(', ')}'s agent</small>:null}</span>
          <span className={`mention-kind ${member.kind}`}>{member.kind==='agent'?'Agent':'Human'}</span>
        </li>)}
      </ul>}
      <textarea ref={field} aria-label="Message" placeholder={to?'Write a message or drop a file…':'Write a message, @ to mention, or drop a file…'} value={body} disabled={busy} rows={2}
        aria-autocomplete="list" aria-expanded={candidates.length>0} aria-controls={candidates.length?listboxId:undefined}
        aria-activedescendant={candidates.length?`${listboxId}-${candidates[picking!.index]!.principal_id}`:undefined}
        onChange={e=>{setBody(e.target.value);track(e.target.value,e.target.selectionStart)}}
        onSelect={e=>track(e.currentTarget.value,e.currentTarget.selectionStart)}
        onKeyDown={e=>{
          if(candidates.length){
            if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const step=e.key==='ArrowDown'?1:-1;setPicking(current=>current&&{...current,index:(current.index+step+candidates.length)%candidates.length});return}
            if((e.key==='Enter'||e.key==='Tab')&&!e.nativeEvent.isComposing){e.preventDefault();choose(candidates[picking!.index]!);return}
            if(e.key==='Escape'){e.preventDefault();setPicking(null);return}
          }
          if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submit()}
        }}/><button disabled={busy||(!body.trim()&&!files.length)} aria-label="Send message">{busy?'…':'↑'}</button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
  </form>;
}
