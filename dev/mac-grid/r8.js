// R8 verifier. usage: RIVER_HTML=<copy>/index.html node r8.js <wallH> <bedMode: drawn|flat|none> [steps]
const H=require('./h.js');const {run,S}=H;
const wallH=+process.argv[2]||560, mode=process.argv[3]||'drawn', N=+process.argv[4]||200;
if(mode==='drawn') run(`bedPoints=${JSON.stringify([{x:150,z:10},{x:600,z:120},{x:1000,z:20}])};rebuildUserBedGrid()`);
if(mode==='flat') run(`bedPoints=[{x:0,z:1},{x:1200,z:1}];rebuildUserBedGrid()`);
run(`obstacles=${JSON.stringify([{type:'rect',x:600,y:300,w:40,h:wallH,clips:[{start:0,dur:120}],rotation:0}])};solidMaskDirty=true;if(model.bedChanged)model.bedChanged()`);
const st=S(), U=st.U, V=st.V, NX=160, NY=90, IX=(i,j)=>i+j*162;
let peak=[0];
for(let s=0;s<N;s++){H.steps(1,{particles:false});
  const sol=S().solid;let m=0,mi=0,mj=0;
  for(let j=1;j<=NY;j++)for(let i=1;i<=NX;i++){const id=IX(i,j);if(sol[id])continue;const sp=Math.hypot(U[id],V[id]);if(sp>m){m=sp;mi=i;mj=j;}}
  if(m>peak[0])peak=[m,mi,mj,s+1];
}
const sol=S().solid, Hg=run('depthGrid');
let open=[];for(let i=1;i<=NX;i++){let o=0;for(let j=1;j<=NY;j++)if(!sol[IX(i,j)])o++;open.push(o)}
const minOpen=Math.min(...open), wallCols=open.map((o,k)=>o===minOpen?k+1:0).filter(x=>x);
const Q=i=>{let q=0;for(let j=1;j<=NY;j++){const id=IX(i,j);if(!sol[id])q+=(Hg?Hg[id]:1)*U[id];}return q;};
const Qin=Q(2);
console.log(`wallH=${wallH} mode=${mode} depthGrid=${!!Hg} solid=${run('solidMaskDirty')} openRows(min)=${minOpen}/90 at cols ${wallCols[0]}-${wallCols[wallCols.length-1]} inflow=${run('inflowVel')}`);
console.log(`peak |u| over run ${peak[0].toFixed(1)} at cell (${peak[1]},${peak[2]}) step ${peak[3]}; ratio to inflow ${(peak[0]/2.5).toFixed(1)}x; contraction bound 90/${minOpen}=${(90/minOpen).toFixed(1)}x`);
let qs=[2,40,70,wallCols[0]-1,wallCols[0],wallCols[wallCols.length-1]+1,90,100,110,113,118,123,130,150,159];
console.log('discharge Q(i)/Qin at columns: '+qs.map(i=>i+':'+(Q(i)/Qin).toFixed(2)).join(' '));
// profile at peak column
const pc=peak[1];let prof=[];for(let j=1;j<=NY;j+=3)prof.push(U[IX(pc,j)].toFixed(0));console.log('u profile at col',pc,'every 3 rows:',prof.join(' '));
let row=[];for(let i=Math.max(1,pc-8);i<=Math.min(NX,pc+8);i++)row.push(Math.hypot(U[IX(i,peak[2])],V[IX(i,peak[2])]).toFixed(1));console.log('speed along row',peak[2],'cols',pc-8,'..',pc+8,':',row.join(' '));
let fin=1;for(let k=0;k<U.length;k++)if(!Number.isFinite(U[k])||!Number.isFinite(V[k]))fin=0;console.log('all finite',!!fin);
