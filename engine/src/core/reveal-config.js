const defaults={hash:true,transition:'none',backgroundTransition:'none',controls:false,progress:false,center:false,slideNumber:false,width:1920,height:1080,margin:0,minScale:0.2,maxScale:2,navigationMode:'linear'};
const allowed=new Set(['width','height','transition','controls','progress','slideNumber']);
export function revealConfig(overrides={}){return {...defaults,...Object.fromEntries(Object.entries(overrides).filter(([key])=>allowed.has(key)))}}
