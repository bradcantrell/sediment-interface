// A wall dropped into running water: discharge behind it, step by step after the drop.
// usage: RIVER_HTML=... node drop.js <bed|plain> <full|gap>
const H=require('./h.js');const {run,S}=H;
const bed=process.argv[2]==='bed', kind=process.argv[3]||'full';
run('obstacles=[];solidMaskDirty=true;u.fill(0);v.fill(0);model.restart();depthGrid=null;depthDirty=true;simTime=6.4');
if(bed)run('bedPoints=[{x:150,z:10},{x:600,z:120},{x:1000,z:20}];rebuildUserBedGrid();depthDirty=true');else run('bedPoints=[];depthDirty=true');
H.steps(300,{particles:false});
const Q=(i)=>{const u=S().U,sol=S().solid,hg=run('depthGrid');let s=0;for(let j=1;j<=90;j++){const id=i+j*162;if(!sol[id])s+=(hg?hg[id]:1)*u[id];}return s};
const Q0=Q(15);
const obs = kind==='full' ? {type:'rect',x:600,y:400,w:40,h:2000} : {type:'rect',x:600,y:360,w:40,h:700};
run(`obstacles=[${JSON.stringify({...obs,rotation:0,clips:[{start:0,dur:1e9}]})}];solidMaskDirty=true`);
let line=[];
for(let s=1;s<=300;s++){H.steps(1,{particles:false}); if([1,2,5,10,50,100,300].includes(s)) line.push(`${s}:${(100*Q(100)/Q0).toFixed(0)}%/${(100*Q(15)/Q0).toFixed(0)}%`);}
console.log(`${bed?'bed  ':'plain'} ${kind} wall dropped at step 300. Q behind (col 100) / Q upstream (col 15), as % of Q upstream before the drop: ${line.join(' ')}`);
