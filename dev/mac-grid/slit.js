// Flux through the 2-row slot between the R8 wall tip and the bank, over time, MAC.
const H=require('./h.js');const {run,S}=H;
run(`bedPoints=[];rebuildUserBedGrid();depthDirty=true;obstacles=[{type:'rect',x:600,y:300,w:40,h:560,clips:[{start:0,dur:1e9}],rotation:0}];solidMaskDirty=true;buildSolidMask();solidMaskDirty=false;u.fill(2.5);v.fill(0);model.restart();u.fill(2.5);v.fill(0)`);
const mode=process.env.NOADV?'proj only':'full step';
if(process.env.NOADV) run('globalThis.__adv=true');
for(const n of [1,2,3,5,10,30,100,200]){
  while(run('globalThis.__k=(globalThis.__k||0)')<n){run('simTime+=DT;model.step();globalThis.__k++');}
  const r=run(`(()=>{const M=mac;let top=0,bot=0,tot=0,mx=0;for(let j=1;j<=NY;j++){let c=IX(81,j);let q=M.hU[c]*M.uF[c];tot+=q;if(j<=2)top+=q;else bot+=q;}
   for(let c=0;c<SIZE;c++){mx=Math.max(mx,Math.abs(M.uF[c]),Math.abs(M.vF[c]));}
   let row=[];for(let j=1;j<=4;j++)row.push(M.uF[IX(81,j)].toFixed(1));return [top,bot,tot,mx,row.join(' ')]})()`);
  console.log(mode,'step',n,'slot',r[0].toFixed(1),'gap',r[1].toFixed(1),'total',r[2].toFixed(1),'slot share',(100*r[0]/r[2]).toFixed(0)+'%','max face',r[3].toFixed(1),'u rows1-4 at col81',r[4]);
}
