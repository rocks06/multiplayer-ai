import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {RoomApi} from './api';
import type {ConnectionState,RoomEvent,RoomIdentity,RoomSnapshot} from './types';

interface RoomSession {
  api:RoomApi;snapshot:RoomSnapshot|null;connection:ConnectionState;lastEvent:RoomEvent|null;
  error:string|null;refresh:()=>Promise<void>;
}

export function useRoomSession(identity:RoomIdentity):RoomSession{
  const api=useMemo(()=>new RoomApi(identity),[identity.companyId,identity.roomId,identity.principalId]);
  const [snapshot,setSnapshot]=useState<RoomSnapshot|null>(null);
  const [connection,setConnection]=useState<ConnectionState>('connecting');
  const [lastEvent,setLastEvent]=useState<RoomEvent|null>(null);
  const [error,setError]=useState<string|null>(null);
  const cursor=useRef(0);
  const socket=useRef<WebSocket|null>(null);
  const refreshQueued=useRef(false);
  const alive=useRef(true);
  const revoked=useRef(false);

  const refresh=useCallback(async()=>{
    const next=await api.snapshot();
    if(!alive.current)return;
    cursor.current=Math.max(cursor.current,next.snapshot_seq);
    setSnapshot(next);setError(null);
  },[api]);

  useEffect(()=>{
    alive.current=true;revoked.current=false;
    let retry=0,timer:number|undefined;
    const intentionallyClosed=new WeakSet<WebSocket>();
    const reconcile=()=>{
      if(refreshQueued.current)return;
      refreshQueued.current=true;
      queueMicrotask(()=>void refresh().catch(e=>setError((e as Error).message)).finally(()=>{refreshQueued.current=false}));
    };
    const resync=async()=>{
      setConnection('resyncing');
      if(socket.current){intentionallyClosed.add(socket.current);socket.current.close()}
      try{await refresh();if(alive.current&&!revoked.current)connect()}catch(e){setError((e as Error).message);setConnection('offline')}
    };
    const connect=()=>{
      if(!alive.current||revoked.current)return;
      setConnection(retry?'reconnecting':'connecting');
      const ws=new WebSocket(api.streamUrl(cursor.current));socket.current=ws;
      ws.onmessage=message=>{
        const frame=JSON.parse(String(message.data)) as Record<string,any>;
        if(frame.type==='resumed'||frame.type==='snapshot'){retry=0;setConnection('live');return}
        if(frame.type==='event'){
          const event=frame.event as RoomEvent;
          if(event.room_seq<=cursor.current)return;
          if(event.room_seq!==cursor.current+1){void resync();return}
          cursor.current=event.room_seq;setLastEvent(event);
          if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ack',room_seq:cursor.current}));
          reconcile();return;
        }
        if(frame.type==='resync_required'){void resync();return}
        if(frame.type==='access_revoked'||(frame.type==='protocol_error'&&['room_access_denied','forbidden','gateway_session_invalid'].includes(frame.code))){
          revoked.current=true;setConnection('revoked');setError('Your access to this room has been removed.');ws.close();return;
        }
        if(frame.type==='protocol_error'){setError(frame.message??'Realtime connection failed.');setConnection('offline')}
      };
      ws.onclose=()=>{
        if(intentionallyClosed.has(ws))return;
        if(!alive.current||revoked.current)return;
        setConnection(navigator.onLine?'reconnecting':'offline');
        const delay=Math.min(400*2**retry++,5000);
        timer=window.setTimeout(connect,delay);
      };
      ws.onerror=()=>ws.close();
    };
    void refresh().then(connect).catch(e=>{setError((e as Error).message);setConnection('offline')});
    return()=>{alive.current=false;if(timer)clearTimeout(timer);socket.current?.close()};
  },[api,refresh]);

  return {api,snapshot,connection,lastEvent,error,refresh};
}
