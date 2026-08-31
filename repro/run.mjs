import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function parseArgs(argv) {
  const a = { k: 10, out: path.join("repro", "results") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--k") a.k = Number(argv[++i]);
    else if (argv[i] === "--out") a.out = argv[++i];
  }
  return a;
}
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function recallAtK(ids, rel, k) { const top = ids.slice(0,k); const hit = top.filter(id=>rel.has(id)).length; return rel.size? hit/rel.size : 0; }
function precisionAtK(ids, rel, k) { const top = ids.slice(0,k); const hit = top.filter(id=>rel.has(id)).length; return k? hit/k : 0; }
function mrr(ids, rel) { for(let i=0;i<ids.length;i++) if(rel.has(ids[i])) return 1/(i+1); return 0; }
function ndcgAtK(ids, rel, k) {
  const top = ids.slice(0,k);
  let dcg=0; for(let i=0;i<top.length;i++) if(rel.has(top[i])) dcg+=1/Math.log2(i+2);
  const ideal = Math.min(k, rel.size); let idcg=0; for(let i=0;i<ideal;i++) idcg+=1/Math.log2(i+2);
  return idcg? dcg/idcg : 0;
}

const args = parseArgs(process.argv);
const dataset = JSON.parse(fs.readFileSync(path.join("repro","dataset.json"),"utf8"));
const dbPath = path.join(os.tmpdir(), `repro-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { retrieve } = await import("../dist/core/retrieval-engine.js");

const rels = [];
for (let i=0;i<dataset.topics.length;i++) {
  const tk = dataset.topics[i].token;
  const ids = [
    createMemory({ type:"PREFERENCE", content:`${tk} recommended approach is option A with flag enabled`, importance:0.8, confidence:0.9 }),
    createMemory({ type:"PREFERENCE", content:`${tk} recommended approach is option A with flag enabled`, importance:0.7, confidence:0.8 }),
    createMemory({ type:"PREFERENCE", content:`${tk} recommended approach is option B not A`, importance:0.6, confidence:0.7 }),
    createMemory({ type:"PREFERENCE", content:`${tk} legacy approach was option C`, validUntil:"2020-01-01T00:00:00Z", importance:0.5, confidence:0.6 }),
    createMemory({ type:"FACT", content:`${tk} note: team agreed on approach A`, importance:0.7, confidence:0.8 }),
  ];
  rels.push({ query: dataset.topics[i].query, relevant: new Set(ids) });
}
for (let d=0; d<30; d++) createMemory({ type:"FACT", content:`Distractor note ${d} about an unrelated subject matter`, importance:0.3, confidence:0.4 });

const K = args.k;
const r1=[],r3=[],r5=[],r10=[],p1=[],p3=[],p5=[],p10=[],mrrs=[],n5=[],n10=[];
for (const {query, relevant} of rels) {
  const res = retrieve(query, {limit: K});
  const ids = res.map(r=>r.id);
  r1.push(recallAtK(ids,relevant,1)); r3.push(recallAtK(ids,relevant,3)); r5.push(recallAtK(ids,relevant,5)); r10.push(recallAtK(ids,relevant,10));
  p1.push(precisionAtK(ids,relevant,1)); p3.push(precisionAtK(ids,relevant,3)); p5.push(precisionAtK(ids,relevant,5)); p10.push(precisionAtK(ids,relevant,10));
  mrrs.push(mrr(ids,relevant)); n5.push(ndcgAtK(ids,relevant,5)); n10.push(ndcgAtK(ids,relevant,10));
}
const metrics = {
  recallAt1: mean(r1), recallAt3: mean(r3), recallAt5: mean(r5), recallAt10: mean(r10),
  precisionAt1: mean(p1), precisionAt3: mean(p3), precisionAt5: mean(p5), precisionAt10: mean(p10),
  mrr: mean(mrrs), ndcgAt5: mean(n5), ndcgAt10: mean(n10),
};
console.log(`Recall@5=${metrics.recallAt5.toFixed(3)} Precision@5=${metrics.precisionAt5.toFixed(3)} MRR=${metrics.mrr.toFixed(3)} NDCG@5=${metrics.ndcgAt5.toFixed(3)}`);
fs.mkdirSync(args.out, {recursive:true});
fs.writeFileSync(path.join(args.out,"latest.json"), JSON.stringify({metrics, datasetVersion: dataset.datasetVersion, timestamp: new Date().toISOString()}, null, 2));
for (const s of ["", "-wal","-shm"]) try{fs.rmSync(dbPath+s,{force:true})}catch{}
