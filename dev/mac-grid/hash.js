// Seeded hash of u, v, particles and deposit over a fixed script. Run with SCORE=1 against the
// committed stam/ copy and a copy holding the old model.js (git show 727dbb1:model.js); equal
// hashes mean the old path is unchanged.
// Seeded fixed script (SCORE=1 seeds random): flat, then drawn bed with a cross-section and
// obstacles, friction global + painted, restart. Hash of u, v, particles and deposit.
const H=require('./h.js');const {run,S}=H;const crypto=require('crypto');
const h=crypto.createHash('sha256');const add=()=>{h.update(Buffer.from(S().U.buffer));h.update(Buffer.from(S().V.buffer));h.update(JSON.stringify(S().particles.map(p=>[p.x,p.y])));h.update(Buffer.from(run('depoGrid').buffer));};
H.steps(100);add();
run(`bedPoints=[{x:150,z:10},{x:600,z:120},{x:1000,z:20}];bedXSections=[{x:600,points:[{y:100,z:0},{y:500,z:40}]}];rebuildUserBedGrid();obstacles=[{type:'rect',x:400,y:300,w:60,h:200,rotation:15,clips:[{start:0,dur:1e9}]},{type:'circle',x:800,y:200,w:80,h:80,rotation:0,clips:[{start:0,dur:1e9}]}];solidMaskDirty=true`);
H.steps(150);add();
run('friction=1.2;ensureFricGrid();paintFriction(width*0.5,height*0.5,1)');H.steps(150);add();
run('restartFlow(false)');H.steps(100);add();
console.log(h.digest('hex').slice(0,16));
