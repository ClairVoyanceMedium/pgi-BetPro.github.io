/* BetPro advanced tracked-result analytics v1.
 * Pure read-only calculations: fixed equal theoretical stakes, confirmed outcomes,
 * frozen recorded odds, distinct pre-match/live cohorts; no external calls.
 */
const EDGES=[1,1.2,1.3,1.4,1.5,1.6,1.7,1.8,1.9,2,2.2,2.5,3,4,5,7,10,20,10000];
const fmt=x=>Number(x).toFixed(2).replace('.',',');
const rnd=(x,d=2)=>Number.isFinite(x)?Number(x.toFixed(d)):null;
const norm=x=>String(x??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function family(raw){
 const s=norm(raw);
 if(/^(americanfootball|american football|nfl|football americain)/.test(s))return 'Football américain';
 if(/^(soccer|football)/.test(s))return 'Football';
 if(/^(basketball|basket)/.test(s))return 'Basketball';
 if(/^tennis/.test(s))return 'Tennis';
 if(/^(rugby|rugbyleague|rugbyunion)/.test(s))return 'Rugby';
 if(/^(icehockey|ice hockey|hockey)/.test(s))return 'Hockey sur glace';
 if(/^baseball/.test(s))return 'Baseball';
 if(/^mma/.test(s))return 'MMA';
 if(/^(boxing|boxe)/.test(s))return 'Boxe';
 if(/^handball/.test(s))return 'Handball';
 if(/^volley/.test(s))return 'Volley-ball';
 if(/^(formula|formule|f1)/.test(s))return 'Formule 1';
 return 'Autres sports';
}
function bandIndex(o){for(let i=0;i<EDGES.length-1;i++)if(o>=EDGES[i]&&o<EDGES[i+1])return i;return -1;}
function bandLabel(lo,hi){return hi===10000?fmt(lo)+' et plus':fmt(lo)+' à < '+fmt(hi);}
function bucket(){return {n:0,w:0,profit:0,sq:0,odds:0,winOdds:0,lossOdds:0,implied:0,days:new Map()};}
function add(g,r){
 const p=r.w?r.o-1:-1;g.n++;g.w+=r.w;g.profit+=p;g.sq+=p*p;g.odds+=r.o;g.implied+=1/r.o;
 if(r.w)g.winOdds+=r.o;else g.lossOdds+=r.o;
 const a=g.days.get(r.day)||{n:0,p:0};a.n++;a.p+=p;g.days.set(r.day,a);
}
function merge(g,h){for(const k of ['n','w','profit','sq','odds','winOdds','lossOdds','implied'])g[k]+=h[k];
 for(const [d,a] of h.days){const v=g.days.get(d)||{n:0,p:0};v.n+=a.n;v.p+=a.p;g.days.set(d,v);}return g;}
function metrics(g,z=1.96){
 const n=g.n,days=g.days.size,mu=n?g.profit/n:0,rate=n?g.w/n:0;
 let se=null;if(n>=30&&days>=10){let ss=0;for(const v of g.days.values())ss+=(v.p-v.n*mu)**2;se=Math.sqrt(days/(days-1)*ss)/n;}
 const lower=se==null?null:100*(mu-z*se),upper=se==null?null:100*(mu+z*se);
 const den=1+z*z/(n||1),wilson=n?100*(rate+z*z/(2*n)-z*Math.sqrt(rate*(1-rate)/n+z*z/(4*n*n)))/den:null;
 return {n,wins:g.w,losses:n-g.w,days,rate:n?rnd(100*rate,1):null,rate_floor:rnd(wilson,1),
  avg_odds:n?rnd(g.odds/n):null,win_odds:g.w?rnd(g.winOdds/g.w):null,loss_odds:n>g.w?rnd(g.lossOdds/(n-g.w)):null,
  implied:n?rnd(100*g.implied/n,1):null,roi:n?rnd(100*mu,2):null,profit:n?rnd(10*g.profit):null,
  stake:10*n,roi_floor:rnd(lower),roi_ceiling:rnd(upper),
  sample:n<30?'insuffisant':n<100||days<10?'préliminaire':n<300||days<20?'modéré':'plus robuste'};
}
function ranked(a,b){const av=a.n>=30&&a.roi_floor!==null,bv=b.n>=30&&b.roi_floor!==null;if(av!==bv)return av?-1:1;return av?b.roi_floor-a.roi_floor||b.n-a.n:b.n-a.n;}
function groupRows(rows,fn){const groups=new Map();for(const r of rows){const k=fn(r),g=groups.get(k)||bucket();add(g,r);groups.set(k,g);}return [...groups].map(([label,g])=>({label,...metrics(g)})).sort(ranked);}
function aggregateRows(rows){const g=bucket();for(const r of rows)add(g,r);return g;}
function phaseStats(rows){
 const bands=groupRows(rows,r=>bandLabel(EDGES[r.bin],EDGES[r.bin+1]));
 return {overall:metrics(aggregateRows(rows)),bands,sports:groupRows(rows,r=>r.sport),sport_odds:groupRows(rows,r=>r.sport+' | '+bandLabel(EDGES[r.bin],EDGES[r.bin+1])),
 engines:groupRows(rows,r=>r.engine),engine_odds:groupRows(rows,r=>r.engine+' | '+bandLabel(EDGES[r.bin],EDGES[r.bin+1])),
 sport_engine_odds:groupRows(rows,r=>r.sport+' | '+r.engine+' | '+bandLabel(EDGES[r.bin],EDGES[r.bin+1])),
 sport_market:groupRows(rows,r=>r.sport+' | '+r.market),origins:groupRows(rows,r=>r.origin),outsiders:groupRows(rows.filter(r=>r.outsider),r=>r.outsider+' | '+r.sport),
 months:groupRows(rows,r=>r.day.slice(0,7)).sort((a,b)=>b.label.localeCompare(a.label))};
}
/* A single interval chosen per cohort using only early observations.
 * All late observations are held out by UTC match day. Fixed candidate grid,
 * no peeking at the holdout to choose the interval. Bonferroni conservative
 * normal bound for up to 26 cohort reports (3.3 ~ 0.001 one-sided).
 */
function discover(rows,label){
 if(rows.length<100)return null;
 const sorted=rows.slice().sort((a,b)=>a.day.localeCompare(b.day));
 const cut=sorted[Math.floor(sorted.length*.7)]?.day;if(!cut)return null;
 const early=Array.from({length:EDGES.length-1},bucket),late=Array.from({length:EDGES.length-1},bucket);
 let tn=0,vn=0;
 for(const r of sorted){const training=r.day<cut;add((training?early:late)[r.bin],r);if(training)tn++;else vn++;}
 if(tn<50||vn<30)return null;
 let best=null;
 // Fixed 1–4 adjacent bands, up to 5.00; higher odds remain descriptive.
 for(let i=0;i<EDGES.length-1&&EDGES[i]<5;i++){
  const g=bucket();
  for(let j=i;j<Math.min(i+4,EDGES.length-1)&&EDGES[j+1]<=5;j++){
   merge(g,early[j]);if(g.n<50||g.days.size<10)continue;
   const m=metrics(g);if(m.roi_floor==null)continue;
   if(!best||m.roi_floor>best.train.roi_floor||(m.roi_floor===best.train.roi_floor&&m.n>best.train.n))best={lo:i,hi:j,train:m};
  }
 }
 if(!best)return null;
 const g=bucket();for(let i=best.lo;i<=best.hi;i++)merge(g,late[i]);
 const holdout=metrics(g,3.3);
 return {label,range:bandLabel(EDGES[best.lo],EDGES[best.hi+1]),cut_day:cut,train:best.train,holdout,
  status:holdout.n<30||holdout.days<10?'validation insuffisante':best.train.roi_floor>0&&holdout.n>=100&&holdout.days>=20&&holdout.roi_floor>0?'signal historique confirmé sur période séparée':'avantage non démontré'};
}
export function betproAdvancedStats(cards){
 const excluded={pending:0,void:0,unverified:0,unknown_odds:0,unknown_phase:0,duplicates:0};
 const rows=[],seen=new Set();
 // Archived and active cards are already merged by the caller. Do not count
 // a re-added pending record in place of an archived verified outcome.
 for(const c of cards){
  if(!c?.id)continue;if(seen.has(c.id)){excluded.duplicates++;continue;}seen.add(c.id);
  if(c.status==='void'){excluded.void++;continue;}if(!['win','loss'].includes(c.status)){excluded.pending++;continue;}
  if(!c.resultSource){excluded.unverified++;continue;}
  const o=Number(c.odds),bin=bandIndex(o);if(!Number.isFinite(o)||o<=1||bin<0){excluded.unknown_odds++;continue;}
  const start=Date.parse(c.startTime||''),selected=Date.parse(c.selectedAt||''),resolved=Date.parse(c.resolvedAt||'');
  if(!Number.isFinite(start)||!Number.isFinite(selected)||!Number.isFinite(resolved)||resolved<selected||!['avant_match','en_direct'].includes(c.phase)||(c.phase==='avant_match')!==(selected<start)){excluded.unknown_phase++;continue;}
  const engine=['Benter','Classique'].includes(c.engine)?c.engine:'Non renseigné';
  const origin=c.selectionOrigin==='Poisson'?'Interface Poisson (marché / choix)':c.selectionOrigin==='Scan'?'Scan '+engine:'Origine non documentée';
  rows.push({o,bin,w:c.status==='win'?1:0,day:new Date(start).toISOString().slice(0,10),phase:c.phase,sport:family(c.sport),engine,market:String(c.market||'Non renseigné'),origin,outsider:['direct','independent'].includes(c.trackedOutsider)?c.trackedOutsider:null});
 }
 const phases={},windows=[];
 for(const phase of ['avant_match','en_direct']){
  const cohort=rows.filter(r=>r.phase===phase);phases[phase]=phaseStats(cohort);
  const global=discover(cohort,'Tous les sports');if(global)windows.push({phase,...global});
  const sports=new Set(cohort.map(r=>r.sport));for(const sport of sports){const x=discover(cohort.filter(r=>r.sport===sport),sport);if(x)windows.push({phase,...x});}
 }
 return {version:'advanced-v1',eligible:rows.length,excluded,phases,windows,stake_eur:10,updated_at:new Date().toISOString(),method:'Cotes enregistrées à la sélection, résultats confirmés; unités à mise fixe, intervalles approximatifs groupés par jour UTC, comparaison chronologique indépendante de la sélection de plage.'};
}
