declare global{interface Window{together?:{invoke:(action:string,args?:unknown)=>Promise<{ok:boolean;data?:any;error?:string}>;onUpdate:(callback:(state:any)=>void)=>()=>void}}}
export async function native(action:string,args?:unknown){if(!window.together)throw new Error('This feature is available in the installed desktop app.');const result=await window.together.invoke(action,args);if(!result.ok)throw new Error(result.error);return result.data;}

