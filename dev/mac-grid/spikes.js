// Item 20: speed spikes below a near-closed wall (the R8 scene). For each step: the peak speed
// anywhere, the peak speed in open water (more than 5 cells from any solid cell), and the worst
// single-cell spike (a cell's speed over the mean of its 8 neighbours, open water, speed > inflow).
// usage: RIVER_HTML=... node spikes.js <drawn|none> [steps]
const H=require('./h.js');const {run,S}=H;
const mode=process.argv[2]||'drawn', N=+process.argv[3]||200;
if(mode==='drawn') run(`bedPoints=${JSON.stringify([{x:150,z:10},{x:600,z:120},{x:1000,z:20}])};rebuildUserBedGrid()`);
run(`obstacles=${JSON.stringify([{type:'rect',x:600,y:300,w:40,h:560,clips:[{start:0,dur:1e9}],rotation:0}])};solidMaskDirty=true;if(model.bedChanged)model.bedChanged()`);
const NX=160,NY=90,IX=(i,j)=>i+j*162;
H.steps(1,{particles:false});
const sol=S().solid; const far=new Uint8Array(sol.length);
for(let j=1;j<=NY;j++)for(let i=1;i<=NX;i++){let ok=1;for(let dj=-5;dj<=5&&ok;dj++)for(let di=-5;di<=5;di++){const ii=i+di,jj=j+dj;if(ii>=1&&ii<=NX&&jj>=1&&jj<=NY&&sol[IX(ii,jj)]){ok=0;break;}}far[IX(i,j)]=ok;}
let peak=[0],farPeak=[0],spike=[0];
const U=S().U,V=S().V,inflow=run('inflowVel');
for(let s=1;s<N;s++){H.steps(1,{particles:false});
  for(let j=2;j<NY;j++)for(let i=2;i<NX;i++){const c=IX(i,j);if(sol[c])continue;const sp=Math.hypot(U[c],V[c]);
    if(sp>peak[0])peak=[sp,i,j,s+1];
    if(!far[c])continue;
    if(sp>farPeak[0])farPeak=[sp,i,j,s+1];
    let m=0;for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++)if(di||dj)m+=Math.hypot(U[c+di+dj*162],V[c+di+dj*162]);m/=8;
    if(sp>inflow&&sp/m>spike[0])spike=[sp/m,i,j,s+1,sp];}
}
const f=(a)=>`${a[0].toFixed(1)} (${(a[0]/inflow).toFixed(1)}x inflow) at (${a[1]},${a[2]}) step ${a[3]}`;
console.log(`${mode}: peak anywhere ${f(peak)} | peak in open water ${f(farPeak)} | worst single-cell spike ${spike[0].toFixed(2)}x its neighbours at (${spike[1]},${spike[2]}) speed ${(spike[4]||0).toFixed(1)}`);
