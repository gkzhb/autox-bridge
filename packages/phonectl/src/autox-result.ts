// Result-directory notification boundary. Notifications are hints, not records;
// the file read remains authoritative. Adapter isolates OS event scheduling.
export interface ResultEvents<T> {
  read(): Promise<T>;
  subscribe(notify: () => void, fail: (error: Error) => void): () => void;
}
export function awaitResult<T>(events: ResultEvents<T>, deadline: number): {result:Promise<T>; close:()=>void} {
  let reading=false,done=false,dirty=false;
  let unsubscribe=()=>{};
  let timer:ReturnType<typeof setTimeout>|undefined;
  const close=()=>{done=true;unsubscribe();if(timer)clearTimeout(timer);};
  const result=new Promise<T>((resolve,reject)=>{
    const fail=(e:Error)=>{if(!done){close();reject(e);}};
    const check=async()=>{
      dirty=true;if(reading||done)return;reading=true;
      try {
        do {
          dirty=false;
          try {
            const value=await events.read();
            if(!done){if(Date.now()>deadline){fail(Object.assign(new Error('AutoX result deadline reached'),{code:'AUTOX_TIMEOUT'}));}else{close();resolve(value);}}
          } catch(e){if((e as {code?:string}).code!=='ENOENT')fail(e as Error);}
        } while(dirty&&!done);
      } finally{reading=false;}
    };
    unsubscribe=events.subscribe(()=>{void check();},fail);
    timer=setTimeout(()=>fail(Object.assign(new Error('AutoX result deadline reached; cancellation unconfirmed'),{code:'AUTOX_TIMEOUT'})),Math.max(1,deadline-Date.now()));
    void check();
  });
  return {result,close};
}
