
globalThis.__pcbgolfRouteBatch = async function(tools, batchSize = 12) {
  const repo = "B44ken/PCBGolf", branch = "route-v0";
  const boardFetch = await tools.mcp__GitHub__fetch({url:"https://api.github.com/repos/B44ken/PCBGolf/git/blobs/5c8b2a9f38a7fd2cd5f8faeb8fc10a454d6d5b54"});
  const board = boardFetch.result.content;

  function blocks(t, kind) {
    const out=[]; let i=0, needle="("+kind;
    while((i=t.indexOf(needle,i))>=0) {
      const d=t[i+needle.length];
      if(!/\s/.test(d)){i+=needle.length;continue}
      let dep=0,q=false,e=false,j=i;
      for(;j<t.length;j++){
        const c=t[j];
        if(q){if(e)e=false;else if(c==="\\")e=true;else if(c==='"')q=false}
        else {if(c==='"')q=true;else if(c==="(")dep++;else if(c===")"&&--dep===0){j++;break}}
      }
      out.push(t.slice(i,j)); i=j;
    }
    return out;
  }
  const prop=(x,k)=>(x.match(new RegExp('\\(property\\s+"'+k+'"\\s+"([^"]*)"'))||[])[1]||"";
  function at(x){const m=x.match(/\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?/);return m?[+m[1],+m[2],+(m[3]||0)]:[0,0,0]}
  function rot(x,y,a){const t=a*Math.PI/180,c=Math.cos(t),s=Math.sin(t);return[x*c-y*s,x*s+y*c]}

  const pads=[], padByKey=new Map(), netPads=new Map();
  for(const f of blocks(board,"footprint")){
    const ref=prop(f,"Reference"),fa=at(f);
    for(const p of blocks(f,"pad")){
      const m=p.match(/^\(pad\s+"([^"]*)"\s+([^\s)]+)/); if(!m)continue;
      const nm=p.match(/\(net\s+"([^"]+)"\)/), net=nm?nm[1]:null;
      const pa=at(p), sz=p.match(/\(size\s+([\d.]+)\s+([\d.]+)/), w=sz?+sz[1]:.6,h=sz?+sz[2]:.6;
      const q=rot(pa[0],pa[1],fa[2]), x=fa[0]+q[0], y=fa[1]+q[1];
      const ang=((fa[2]+pa[2])%360+360)%360, th=ang*Math.PI/180;
      const bw=Math.abs(Math.cos(th))*w+Math.abs(Math.sin(th))*h, bh=Math.abs(Math.sin(th))*w+Math.abs(Math.cos(th))*h;
      const type=m[2], ls=(p.match(/\(layers\s+([^)]+)\)/)||[])[1]||"";
      const o={ref,pin:m[1],net,x,y,w:bw,h:bh,type,layers:ls,fcx:fa[0],fcy:fa[1]};
      pads.push(o); padByKey.set(ref+":"+m[1],o);
      if(net){if(!netPads.has(net))netPads.set(net,[]);netPads.get(net).push(o)}
    }
  }
  const routable=[...netPads.entries()].filter(([n,p])=>p.length>1).map(([name,pads],i)=>({name,pads,idx:i+1}));
  const netIndex=new Map(routable.map(n=>[n.name,n.idx]));

  let state=null, stateFile=null;
  try {
    stateFile=await tools.mcp__GitHub__fetch_file({repository_full_name:repo,path:"tools/route-state.json",ref:branch});
    state=JSON.parse(stateFile.result.content);
    if(!state || state.version!==2) state=null;
  } catch(e) {}
  const step=.2, margin=8;
  let xmin=Math.min(...pads.map(p=>p.x-p.w/2)),xmax=Math.max(...pads.map(p=>p.x+p.w/2)),
      ymin=Math.min(...pads.map(p=>p.y-p.h/2)),ymax=Math.max(...pads.map(p=>p.y+p.h/2));
  const ox=Math.floor((xmin-margin)/step)*step, oy=Math.floor((ymin-margin)/step)*step,
        nx=Math.ceil((xmax+margin-ox)/step)+1, ny=Math.ceil((ymax+margin-oy)/step)+1, N=nx*ny;
  const I=(x,y)=>y*nx+x, clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),
        GX=x=>clamp(Math.round((x-ox)/step),0,nx-1), GY=y=>clamp(Math.round((y-oy)/step),0,ny-1);

  if(!state) state={version:2,grid:{step,ox,oy,nx,ny},done:[],failed:[],routes:[],stubs:[]};
  if(state.grid.nx!==nx||state.grid.ny!==ny||state.grid.step!==step) throw new Error("route-state grid mismatch");

  const stat=[new Int32Array(N),new Int32Array(N)]; stat[0].fill(-1);stat[1].fill(-1);
  const mergeOwner=(a,b)=>a===-1?b:a===b?a:-2;
  for(const p of pads){
    const own=p.net&&netIndex.get(p.net)||-2, exp=.15;
    const xa=GX(p.x-p.w/2-exp), xb=GX(p.x+p.w/2+exp), ya=GY(p.y-p.h/2-exp), yb=GY(p.y+p.h/2+exp);
    const lays=p.type.includes("thru")?[0,1]:p.layers.includes("B.Cu")?[1]:[0];
    for(const l of lays)for(let y=ya;y<=yb;y++)for(let x=xa;x<=xb;x++){const k=I(x,y);stat[l][k]=mergeOwner(stat[l][k],own)}
  }
  const dyn=[new Int32Array(N),new Int32Array(N)];dyn[0].fill(-1);dyn[1].fill(-1);
  const blocked=(l,k,n)=>(stat[l][k]!==-1&&stat[l][k]!==n)||(dyn[l][k]!==-1&&dyn[l][k]!==n);
  function reserveCell(l,k,n){if(dyn[l][k]===-1||dyn[l][k]===n)dyn[l][k]=n;else throw new Error("dynamic route collision")}
  function canVia(k,n){
    const x=k%nx,y=(k/nx)|0;
    for(const l of [0,1])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy;if(xx<0||xx>=nx||yy<0||yy>=ny)return false;
      const q=I(xx,yy);if(blocked(l,q,n))return false;
    }
    return true;
  }
  function reserveVia(k,n){
    const x=k%nx,y=(k/nx)|0;
    for(const l of [0,1])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)reserveCell(l,I(x+dx,y+dy),n);
  }
  function expandPolyline(poly, cb){
    for(let i=0;i<poly.length-1;i++){
      let [x,y,l]=poly[i], [x2,y2,l2]=poly[i+1];
      if(l!==l2){cb(x,y,l,true);continue}
      const dx=Math.sign(x2-x),dy=Math.sign(y2-y); cb(x,y,l,false);
      while(x!==x2||y!==y2){x+=dx;y+=dy;cb(x,y,l,false)}
    }
    if(poly.length){const [x,y,l]=poly.at(-1);cb(x,y,l,false)}
  }
  // Rehydrate prior routes and stubs.
  for(const r of state.routes){
    const n=netIndex.get(r.net); if(!n)continue;
    expandPolyline(r.poly,(x,y,l,via)=>{const k=I(x,y);reserveCell(l,k,n);if(via)reserveVia(k,n)});
  }
  for(const s of state.stubs){
    const n=netIndex.get(s.net); if(!n)continue;
    for(const [x,y] of s.cells) reserveCell(0,I(x,y),n);
  }

  class Heap{
    constructor(){this.a=[]}
    push(n){let a=this.a,i=a.length;a.push(n);while(i){let p=(i-1)>>1;if(a[p][0]<=n[0])break;a[i]=a[p];i=p}a[i]=n}
    pop(){const a=this.a;if(!a.length)return null;const r=a[0],x=a.pop();if(a.length){let i=0;while(1){let l=i*2+1;if(l>=a.length)break;let rr=l+1,j=rr<a.length&&a[rr][0]<a[l][0]?rr:l;if(a[j][0]>=x[0])break;a[i]=a[j];i=j}a[i]=x}return r}
    get length(){return this.a.length}
  }
  function astar(net,sx,sy,sl,tx,ty,tl){
    const size=N*2, INF=1e30, g=new Float64Array(size), prev=new Int32Array(size), seen=new Uint8Array(size), heap=new Heap();
    g.fill(INF);prev.fill(-1);
    const sid=sl*N+I(sx,sy),tid=tl*N+I(tx,ty);g[sid]=0;heap.push([Math.abs(sx-tx)+Math.abs(sy-ty),sid]);
    let found=-1,iter=0;
    while(heap.length&&iter++<450000){
      const z=heap.pop(),u=z[1];if(seen[u])continue;seen[u]=1;if(u===tid){found=u;break}
      const l=(u/N)|0,k=u%N,x=k%nx,y=(k/nx)|0;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const xx=x+dx,yy=y+dy;if(xx<0||xx>=nx||yy<0||yy>=ny)continue;
        const kk=I(xx,yy);if(blocked(l,kk,net)&&kk!==I(tx,ty))continue;
        const v=l*N+kk, orient=l===0?(dy?1.12:1):(dx?1.12:1),ng=g[u]+orient;
        if(ng<g[v]){g[v]=ng;prev[v]=u;heap.push([ng+Math.abs(xx-tx)+Math.abs(yy-ty),v])}
      }
      if(canVia(k,net)){const ol=1-l,v=ol*N+k,ng=g[u]+7;if(ng<g[v]){g[v]=ng;prev[v]=u;heap.push([ng+Math.abs(x-tx)+Math.abs(y-ty),v])}}
    }
    if(found<0)return null;
    const p=[];for(let u=found;u!==-1;u=prev[u]){const l=(u/N)|0,k=u%N;p.push([k%nx,(k/nx)|0,l])}return p.reverse()
  }
  function compress(path){
    if(path.length<=2)return path;
    const out=[path[0]];let pd=[path[1][0]-path[0][0],path[1][1]-path[0][1],path[1][2]-path[0][2]];
    for(let i=1;i<path.length-1;i++){const d=[path[i+1][0]-path[i][0],path[i+1][1]-path[i][1],path[i+1][2]-path[i][2]];if(d[0]!==pd[0]||d[1]!==pd[1]||d[2]!==pd[2])out.push(path[i]);pd=d}
    out.push(path.at(-1));return out
  }
  function lineCells(x0,y0,x1,y1){
    const out=[];let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy,x=x0,y=y0;
    while(1){out.push([x,y]);if(x===x1&&y===y1)break;const e2=2*err;if(e2>=dy){err+=dy;x+=sx}if(e2<=dx){err+=dx;y+=sy}}
    return out
  }
  function terminal(p,n){
    const cx=GX(p.x),cy=GY(p.y);
    if(p.type.includes("thru") || Math.min(p.w,p.h)>=.75){
      if(p.type.includes("thru"))return {x:cx,y:cy,layers:[0,1],stub:null,exact:[p.x,p.y]};
      if(canVia(I(cx,cy),n))return {x:cx,y:cy,layers:[0,1],stub:null,exact:[p.x,p.y],viaInPad:true};
    }
    let dx=p.x-p.fcx,dy=p.y-p.fcy;
    const dirs=[];
    if(Math.abs(dx)>=Math.abs(dy)) dirs.push([Math.sign(dx)||1,0],[0,Math.sign(dy)||1],[0,-(Math.sign(dy)||1)],[-(Math.sign(dx)||1),0]);
    else dirs.push([0,Math.sign(dy)||1],[Math.sign(dx)||1,0],[-(Math.sign(dx)||1),0],[0,-(Math.sign(dy)||1)]);
    for(const [ux,uy] of dirs){
      for(const extra of [.45,.7,1.0,1.4,1.8]){
        const ex=GX(p.x+ux*(Math.abs(ux)*p.w/2+Math.abs(uy)*p.h/2+extra)),ey=GY(p.y+uy*(Math.abs(ux)*p.w/2+Math.abs(uy)*p.h/2+extra));
        const cells=lineCells(cx,cy,ex,ey);
        let ok=true;
        for(const [x,y] of cells){const k=I(x,y);const st=stat[0][k],dyv=dyn[0][k];if((st!==-1&&st!==n)||(dyv!==-1&&dyv!==n)){ok=false;break}}
        if(ok)return {x:ex,y:ey,layers:[0],stub:{cells,exact:[p.x,p.y],end:[ox+ex*step,oy+ey*step]},exact:[p.x,p.y]};
      }
    }
    return null
  }
  function routeNet(net){
    const terms=[];
    for(const p of net.pads){const t=terminal(p,net.idx);if(!t)return {ok:false,why:"no pad escape",pad:[p.ref,p.pin]};terms.push({...t,ref:p.ref,pin:p.pin})}
    // Reserve all terminal stubs after confirming they exist.
    for(const t of terms)if(t.stub){for(const [x,y] of t.stub.cells)reserveCell(0,I(x,y),net.idx);state.stubs.push({net:net.name,ref:t.ref,pin:t.pin,cells:t.stub.cells,exact:t.stub.exact,end:t.stub.end})}
    const connected=[terms[0]],todo=terms.slice(1),polys=[];
    while(todo.length){
      let bi=0,bj=0,bd=1e9;
      for(let i=0;i<todo.length;i++)for(let j=0;j<connected.length;j++){const d=Math.abs(todo[i].x-connected[j].x)+Math.abs(todo[i].y-connected[j].y);if(d<bd){bd=d;bi=i;bj=j}}
      const a=todo.splice(bi,1)[0],b=connected[bj];let best=null;
      for(const sl of a.layers)for(const tl of b.layers){const p=astar(net.idx,a.x,a.y,sl,b.x,b.y,tl);if(p&&(!best||p.length<best.length))best=p}
      if(!best)return {ok:false,why:"maze failed",from:[a.ref,a.pin],to:[b.ref,b.pin]};
      for(let i=0;i<best.length;i++){const [x,y,l]=best[i],k=I(x,y);reserveCell(l,k,net.idx);if(i&&best[i-1][2]!==l)reserveVia(k,net.idx)}
      const poly=compress(best);state.routes.push({net:net.name,poly});polys.push(poly);connected.push(a)
    }
    return {ok:true,paths:polys.length}
  }
  function bboxScore(n){const xs=n.pads.map(p=>p.x),ys=n.pads.map(p=>p.y);return Math.max(...xs)-Math.min(...xs)+Math.max(...ys)-Math.min(...ys)}
  const doneSet=new Set(state.done);
  const order=routable.slice().sort((a,b)=>{
    const hi=x=>/(?:^USB_D_|^STM_D_|_D_[NP]$|^SD_(?:CLK|CMD|D[0-3])$)/.test(x.name)?0:1;
    let d=hi(a)-hi(b);if(d)return d;
    const p=x=>/^(GND|\+12V|\+5V|\+3V3|VDDLDO)$/.test(x.name)?1:0;d=p(a)-p(b);if(d)return d;
    return (a.pads.length-b.pads.length)||bboxScore(a)-bboxScore(b)
  }).filter(n=>!doneSet.has(n.name));

  const attempted=[],failed=[];
  for(const net of order.slice(0,batchSize)){
    const r=routeNet(net);attempted.push({net:net.name,pads:net.pads.length,result:r});
    if(!r.ok){failed.push({net:net.name,...r});break}
    state.done.push(net.name);
  }
  state.failed=failed;
  const content=JSON.stringify(state);
  let wr;
  if(stateFile?.result?.sha) wr=await tools.mcp__GitHub__update_file({repository_full_name:repo,path:"tools/route-state.json",content,message:"advance grid route",sha:stateFile.result.sha,branch});
  else wr=await tools.mcp__GitHub__create_file({repository_full_name:repo,path:"tools/route-state.json",content,message:"initialize grid route",branch});
  return {grid:{nx,ny,cells:N,step},done:state.done.length,total:routable.length,remaining:routable.length-state.done.length,attempted,failed,routes:state.routes.length,stubs:state.stubs.length,commit:wr.result?.commit_sha};
};
