// No blow-up: a long run with friction at its maximum, a drawn bed, deposit building, three
// obstacles (one timed in and out), painted friction, inflow at its maximum. Steps the way
// draw() does (mask, model, particles) and records the peak speed and any non-finite value.
// usage: RIVER_HTML=... node longrun.js [steps] [friction] [inflow]
const H=require('./h.js');const {run,S}=H;
const N=+process.argv[2]||6000, fr=process.argv[3]||'3', inflow=process.argv[4]||'5';
const clips=[{start:0,dur:1e9}];
run(`friction=${fr};fricDirty=true;inflowVel=${inflow};bedPoints=[{x:150,z:10},{x:600,z:120},{x:1000,z:20}];rebuildUserBedGrid();depthDirty=true`);
run(`ensureFricGrid();paintFriction(width*0.3,height*0.5,1);paintFriction(width*0.32,height*0.55,1)`);
run(`obstacles=[{type:'rect',x:300,y:200,w:60,h:120,rotation:20,clips:${JSON.stringify(clips)}},{type:'circle',x:700,y:400,w:90,h:90,rotation:0,clips:${JSON.stringify(clips)}},{type:'rect',x:950,y:250,w:40,h:300,rotation:0,clips:[{start:5,dur:10}]}];solidMaskDirty=true`);
let peak=0,bad=0,restarts=0;const t0=Date.now();
for(let s=1;s<=N;s++){
  run('simTime+=DT;if(solidMaskDirty||solidMaskIsDynamic()){buildSolidMask();solidMaskDirty=false};model.step()');
  if(!run('flowFinite()')){restarts++;run('restartFlow(true)');}
  run('updateParticles()');
  if(s%6===0){run("model.bedChanged()");}   // the deposit enters the depth about every 0.5 s, as draw() has it
  if(s%10===0){const U=S().U,V=S().V;for(let k=0;k<U.length;k++){const q=Math.hypot(U[k],V[k]);if(!Number.isFinite(q))bad++;else if(q>peak)peak=q;}}
}
const dep=run('depoGrid.reduce((a,b)=>a+b,0)');
console.log(`steps ${N} friction ${fr} inflow ${inflow}: peak speed ${peak.toFixed(1)} (${(peak/inflow).toFixed(1)}x inflow), non-finite samples ${bad}, flow restarts ${restarts}, deposit total ${dep.toFixed(0)}, particles ${S().particles.length}, ${((Date.now()-t0)/N).toFixed(1)} ms/step incl. particles`);
