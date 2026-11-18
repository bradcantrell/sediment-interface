// Time model.step() for a few scenes. RIVER_HTML=<dir>/index.html node timing.js
const H=require('./h.js');const {run,S}=H;
const clips=[{start:0,dur:1e9}];
function scene(label, setup, n=400){
  run('obstacles=[];solidMaskDirty=true;u.fill(0);v.fill(0);model.restart();depthGrid=null;depthDirty=true;simTime=6.4;friction=0;fricDirty=true;bedPoints=[];if(depoGrid)depoGrid.fill(0)');
  run(setup);
  H.steps(100,{particles:false});
  const t0=process.hrtime.bigint();
  for(let k=0;k<n;k++){run('simTime+=DT');run('if(solidMaskDirty||solidMaskIsDynamic()){buildSolidMask();solidMaskDirty=false}');run('model.step()');}
  const ms=Number(process.hrtime.bigint()-t0)/1e6/n;
  const it = run('typeof macStats!=="undefined"?macStats.iters:"-"');
  console.log(label.padEnd(28), ms.toFixed(2),'ms/step', 'pcg iters', it);
}
console.log('canvas', S().width,'x',S().height);
scene('plain, no obstacle','');
scene('plain, gap wall', `obstacles=[{type:'rect',x:600,y:360,w:40,h:700,rotation:0,clips:${JSON.stringify(clips)}}];solidMaskDirty=true`);
scene('bed, gap wall', `bedPoints=[{x:150,z:10},{x:600,z:120},{x:1000,z:20}];rebuildUserBedGrid();depthDirty=true;obstacles=[{type:'rect',x:600,y:360,w:40,h:700,rotation:0,clips:${JSON.stringify(clips)}}];solidMaskDirty=true`);
scene('bed, friction 3, 3 objects', `friction=3;fricDirty=true;bedPoints=[{x:150,z:10},{x:600,z:120},{x:1000,z:20}];rebuildUserBedGrid();depthDirty=true;obstacles=[{type:'rect',x:300,y:200,w:60,h:120,rotation:20,clips:${JSON.stringify(clips)}},{type:'circle',x:700,y:400,w:90,h:90,rotation:0,clips:${JSON.stringify(clips)}},{type:'rect',x:950,y:250,w:40,h:300,rotation:0,clips:${JSON.stringify(clips)}}];solidMaskDirty=true`);
scene('dam spilling (full wall)', `obstacles=[{type:'rect',x:600,y:400,w:40,h:2400,rotation:0,clips:${JSON.stringify(clips)}}];solidMaskDirty=true`, 400);
