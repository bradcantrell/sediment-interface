// R3 verify: discharge past obstacles. node r3_repro.js [bed] ; env DEVELOPED=1 drops the wall into a running river
// env PATCH=1 loads ./patched/index.html (advect with a solid check along the backtrace) for root-cause isolation.
process.env.RIVER_HTML = process.env.RIVER_HTML || (__dirname+'/stam/index.html');
const H=require('./h.js');const {run,S}=H;
const bed=process.argv[2]==='bed';
const clips=[{start:0,dur:1e9}];
const st=S(); console.log('canvas',st.width,'x',st.height,'cellW',st.cellW.toFixed(2),'cellH',st.cellH.toFixed(2),'PATCH',!!process.env.PATCH);
function Q(i){const u=S().U,sol=S().solid,hg=run('depthGrid');let s=0,open=0,mx=0;for(let j=1;j<=90;j++){const id=i+j*162;if(sol[id])continue;open++;s+=(hg?hg[id]:1)*u[id];}return {q:s,open}}
function maxSpeed(){const u=S().U,v=S().V,sol=S().solid;let m=0;for(let k=0;k<u.length;k++){if(sol[k])continue;const s=Math.hypot(u[k],v[k]);if(s>m)m=s}return m}
function trial(label,obs){
  run('obstacles=[];solidMaskDirty=true;u.fill(0);v.fill(0);uPrev.fill(0);vPrev.fill(0);p.fill(0);model.restart();depthGrid=null;depthDirty=true;simTime=6.4');
  if(bed)run('bedPoints=[{x:150,z:10},{x:600,z:120},{x:1000,z:20}];rebuildUserBedGrid();depthDirty=true');else run('bedPoints=[];depthDirty=true');
  if(process.env.DEVELOPED){H.steps(300,{particles:false});}
  run(`obstacles=${JSON.stringify(obs)};solidMaskDirty=true`);
  H.steps(300,{particles:false});
  // locate wall columns
  const sol=S().solid;let cols=[];for(let i=1;i<=160;i++){let n=0;for(let j=1;j<=90;j++)if(sol[i+j*162])n++;if(n)cols.push(i+':'+n)}
  const up=Q(15),dn=Q(140);let wq=null,wi=null;for(const c of cols){const i=+c.split(':')[0];const q=Q(i);if(!wq||q.open<wq.open){wq=q;wi=i}}
  const r=`${label.padEnd(30)} solidCols ${cols.length?cols[0]+'..'+cols[cols.length-1]:'-'} Qup ${up.q.toFixed(1)} Qwall(col ${wi},open ${wq&&wq.open}) ${wq?wq.q.toFixed(1):'-'} (${wq?(100*wq.q/up.q).toFixed(0):'-'}%) Qdown ${dn.q.toFixed(1)} (${(100*dn.q/up.q).toFixed(0)}%) maxSpeed ${maxSpeed().toFixed(1)}`;
  console.log(r);
}
const rect=(x,y,w,h)=>({type:'rect',x,y,w,h,rotation:0,clips});
console.log(bed?'drawn bed (projectDepth)':'no bed (project)', process.env.DEVELOPED?'DEVELOPED':'from rest');
trial('no obstacle',[]);
trial('full wall 40px',[rect(600,400,40,2000)]);
trial('full wall 150px',[rect(600,400,150,2000)]);
trial('full wall 300px',[rect(600,400,300,2000)]);
if(!process.env.NOGAP)trial('gap wall 40px h700',[rect(600,360,40,700)]);
if(!process.env.NOGAP)trial('gap wall 300px h700',[rect(600,360,300,700)]);
