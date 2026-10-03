const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('together',{invoke:(action,args)=>ipcRenderer.invoke('together',action,args),onUpdate:(callback)=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('update-state',listener);return()=>ipcRenderer.removeListener('update-state',listener);}});

