import {useState,type ReactNode} from 'react';

/**
 * Asking before something irreversible, without leaving the product to do it.
 *
 * `window.confirm` looked like the simple answer and was the reason Delete room and Remove agent
 * did nothing at all: a host that does not implement the dialog returns false immediately and
 * shows nothing, so the guard `if (!confirm(...)) return;` silently swallowed every click. Owning
 * the dialog removes that dependency entirely — and it can do the two things the browser's cannot,
 * which are to show that the work is happening and to say so when it fails.
 *
 * Everything destructive in the product goes through this, so none of it can fail quietly again.
 */
export function useConfirm(){
  const [asking,setAsking]=useState<Ask|null>(null);
  return {
    /** Ask, then run. The dialog stays up, and says so, if the work fails. */
    confirm:(ask:Ask)=>setAsking(ask),
    dialog:asking?<ConfirmDialog ask={asking} onClose={()=>setAsking(null)}/>:null,
  };
}

export interface Ask {
  title:string;
  detail:ReactNode;
  /** The word on the button that does it. Says what happens, never "OK". */
  action:string;
  run:()=>Promise<void>;
}

function ConfirmDialog({ask,onClose}:{ask:Ask;onClose:()=>void}){
  const [busy,setBusy]=useState(false);
  const [failed,setFailed]=useState<string|null>(null);

  const go=async()=>{
    setBusy(true);setFailed(null);
    try{ await ask.run(); onClose() }
    catch(problem){
      // The one thing a silent failure never did: say what went wrong, and stay open.
      setFailed(problem instanceof Error&&problem.message?problem.message:'That did not work.');
      setBusy(false);
    }
  };

  return <div className="confirm-scrim" role="presentation" onClick={busy?undefined:onClose}>
    <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"
      onClick={event=>event.stopPropagation()}>
      <h2 id="confirm-title">{ask.title}</h2>
      <div className="confirm-detail">{ask.detail}</div>
      {failed&&<p className="form-error" role="alert">{failed}</p>}
      <div className="confirm-actions">
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="danger" onClick={go} disabled={busy} autoFocus>
          {busy?'Working…':ask.action}
        </button>
      </div>
    </div>
  </div>;
}
