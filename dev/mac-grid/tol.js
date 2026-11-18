// PCG iterations, time and face discharge against MAC_TOL (gap wall over a drawn bed). Needs
// MAC_TOL and MAC_MAX_ITERS made `let` in mac/model.js first:
//   sed -i "s/^const MAC_TOL = /let MAC_TOL = /; s/^const MAC_MAX_ITERS = /let MAC_MAX_ITERS = /" mac/model.js
const H=require('./h.js');const {run,S}=H;
const clips=[{start:0,dur:1e9}];
const W=162;
function faceQ(i){return run(`(()=>{let s=0;for(let j=1;j<=NY;j++){let c=IX(${i},j);s+=mac.hU[c]*mac.uF[c];}return s})()`)}
for (const [tol,maxit] of [[1e-5,400],[1e-4,400],[1e-3,400],[1e-2,400],[1,0]]) {
  run(`MAC_TOL=${tol};MAC_MAX_ITERS=${maxit}`);
  run('obstacles=[];solidMaskDirty=true;u.fill(0);v.fill(0);model.restart();depthGrid=null;depthDirty=true;simTime=6.4;friction=0;fricDirty=true;bedPoints=[{x:150,z:10},{x:600,z:120},{x:1000,z:20}];rebuildUserBedGrid();depthDirty=true');
  run(`obstacles=[{type:'rect',x:600,y:360,w:40,h:700,rotation:0,clips:${JSON.stringify(clips)}}];solidMaskDirty=true`);
  H.steps(150,{particles:false});
  const t0=process.hrtime.bigint(); let its=0;
  for(let k=0;k<150;k++){run('simTime+=DT');run('model.step()');its+=run('macStats.iters');}
  const ms=Number(process.hrtime.bigint()-t0)/1e6/150;
  const q=[0,15,60,79,81,100,140,160].map(faceQ);
  console.log(`tol ${tol} its ${(its/150).toFixed(1)} ${ms.toFixed(2)} ms  faceQ ${q.map(x=>x.toFixed(2)).join(' ')}  spread ${((Math.max(...q)-Math.min(...q))/q[0]*100).toFixed(3)}%`);
}
