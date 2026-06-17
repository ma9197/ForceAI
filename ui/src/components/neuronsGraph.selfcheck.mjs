// neuronsGraph.selfcheck.mjs — node, no deps. Mirrors buildEdges() exactly. Run: node this-file.mjs
// Verifies the one-blob topology's MUST-hold properties at scale; append churn is reported (not asserted).
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
const CHORDS_PER_NODE=3;
function buildEdges(nodes){
  const N=nodes.length; if(N<2) return [];
  const ord=nodes.slice().sort((a,b)=>(hash(a.id)-hash(b.id))||(a.id<b.id?-1:a.id>b.id?1:0));
  const seen=new Set(); const links=[];
  const add=(i,j)=>{ if(i===j||i<0||j<0||i>=N||j>=N) return;
    const a=i<j?i:j,b=i<j?j:i,key=a*N+b; if(seen.has(key)) return; seen.add(key);
    links.push({source:ord[a].id,target:ord[b].id}); };
  for(let i=0;i<N;i++){ add(i,(i+1)%N);
    for(let c=0;c<CHORDS_PER_NODE;c++) add(i,hash(ord[i].id+':'+c)%N); }
  const every=Math.max(1,Math.ceil(links.length/400));
  for(let i=0;i<links.length;i++) links[i].__p=i%every===0?1:0;
  return links;
}
const TYPES=['fact','voice','report','stat','observation','lesson','principle','sticker','summary'];
// Realistic ids: `${type}:${rowId}` exactly like App.buildNeurons emits — so the sort/cross-type
// checks exercise the SAME id distribution as production (an earlier mirror used random ids and so
// never caught that an id-sort clusters every type together along the backbone ring).
function makeNodes(n,seed=''){ const a=[]; const ctr={}; for(let i=0;i<n;i++){ const type=TYPES[hash(seed+'k'+i)%TYPES.length];
  ctr[type]=(ctr[type]||0)+1; const id=seed+type+':'+ctr[type];
  a.push({id,type,t:hash('t'+id)}); } return a; }

function check(N){
  const nodes=makeNodes(N);
  const links=buildEdges(nodes);
  const typeOf=new Map(nodes.map(n=>[n.id,n.type]));
  const ids=new Set(nodes.map(n=>n.id));
  // (a) connectivity via union-find
  const idx=new Map([...ids].map((id,i)=>[id,i])); const p=[...ids].map((_,i)=>i);
  const find=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;};
  let bad=0;
  for(const l of links){ if(!ids.has(l.source)||!ids.has(l.target)) bad++; else p[find(idx.get(l.source))]=find(idx.get(l.target)); }
  const comps=new Set([...idx.values()].map(find)).size;
  // (b) cross-type fraction
  let cross=0; for(const l of links) if(typeOf.get(l.source)!==typeOf.get(l.target)) cross++;
  const crossFrac=cross/links.length;
  // (c) min degree (no orphans)
  const deg=new Map([...ids].map(id=>[id,0]));
  for(const l of links){ deg.set(l.source,deg.get(l.source)+1); deg.set(l.target,deg.get(l.target)+1); }
  const minDeg=Math.min(...deg.values()), avgDeg=links.length*2/N;
  // (d) particle cap
  const particles=links.filter(l=>l.__p).length;
  // (e) append churn report (NOT asserted — N-dependent chords intentionally re-route on append)
  const grown=buildEdges([...nodes,...makeNodes(5,'NEW-')]);
  const grownSet=new Set(grown.map(l=>l.source<l.target?l.source+'|'+l.target:l.target+'|'+l.source));
  const base=links.map(l=>l.source<l.target?l.source+'|'+l.target:l.target+'|'+l.source);
  const survived=base.filter(k=>grownSet.has(k)).length;

  console.log(`N=${N}`, {edges:links.length, components:comps, undefinedOrOOR:bad, minDegree:minDeg,
    crossTypeFraction:+crossFrac.toFixed(3), avgDegree:+avgDeg.toFixed(2), particles,
    appendSurvived:`${survived}/${base.length} (${(100*survived/base.length).toFixed(0)}%)`});
  console.assert(bad===0, `FAIL N=${N}: edge with undefined/out-of-range endpoint (would crash d3-force)`);
  console.assert(comps===1, `FAIL N=${N}: not a single connected component → blob would split`);
  // >0.7 = edges are type-blind (random ~= each type's complement). The id-sort regression dropped
  // this to ~0.5-0.6 (backbone chained same-types); the absolute floor only needs to separate those.
  console.assert(crossFrac>0.7, `FAIL N=${N}: edges biased toward same-type (would cluster by colour)`);
  console.assert(minDeg>=2, `FAIL N=${N}: an orphan/low-degree node exists`);
  return bad===0 && comps===1 && crossFrac>0.7 && minDeg>=2;
}
const ok = [50, 1000, 4000].map(check).every(Boolean);
console.log(ok ? 'PASS ✅ (one connected, color-blind, crash-free mesh at every scale)' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
