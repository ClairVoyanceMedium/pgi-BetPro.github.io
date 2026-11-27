/* Independent pre-match forecast, never derived from bookmakers.
 * Fixture identity verified before historical fitting. Existing score models reused.
 */
const bpForecastMemo=new Map(),bpForecastPending=new Map();
async function bpForecastFixture(q,feed,start,home,away){
 const base='https://site.api.espn.com/apis/site/v2/sports/'+feed;
 const getTarget=(c,id)=>{
  const at=Date.parse(c?.date||c?.startDate||''),st=c?.status?.type||{};
  if(!Number.isFinite(at)||Math.abs(at-start)>3*3600000||at<=Date.now()+120000||st.completed===true||st.state!=='pre')return null;
  const h=c?.competitors?.find(x=>x.homeAway==='home'),a=c?.competitors?.find(x=>x.homeAway==='away');
  if(!h?.team?.id||!a?.team?.id||String(h.team.id)===String(a.team.id)||!bpEvidenceName(bpEvidenceTeam(h),home)||!bpEvidenceName(bpEvidenceTeam(a),away))return null;
  return {id:String(id),start:at,home:{id:String(h.team.id),displayName:bpEvidenceTeam(h)},away:{id:String(a.team.id),displayName:bpEvidenceTeam(a)},url:base+'/summary?event='+encodeURIComponent(id)};
 };
 const direct=bpEvidenceText(q.id,20);
 if(q.feed===feed&&/^\d{5,12}$/.test(direct)){
  try{const d=await betproChatExternal(base+'/summary?event='+direct,{ttl:5*60000,maxBytes:1800000});const t=getTarget(d?.header?.competitions?.[0],direct);if(t)return t;}catch(_){}
 }
 const day=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(start)).map(x=>[x.type,x.value]));
 const dates=[...new Set([day.year+day.month+day.day,new Date(start).toISOString().slice(0,10).replace(/-/g,'')])];
 for(const date of dates){
  try{const url=base+'/scoreboard?dates='+date+'&limit=500',d=await betproChatExternal(url,{ttl:5*60000,maxBytes:2000000});
   const matches=(d.events||[]).map(e=>{const c=e.competitions?.[0];return getTarget(c,e.id);}).filter(Boolean);
   if(matches.length===1)return {...matches[0],url};if(matches.length>1)return null;
  }catch(_){}
 }
 return null;
}
async function bpPoissonCardForecast(env,q){
 const home=bpEvidenceText(q.home),away=bpEvidenceText(q.away),start=Date.parse(q.start||''),sport=bpEvidenceText(q.model_sport,40),feed=bpEvidenceFeed(q),now=Date.now();
 if(!['football','hockey','baseball','basketball','nfl','rugby'].includes(sport)||!feed||!home||!away||!Number.isFinite(start)||start<now+120000||start>now+4*86400000)return {ok:false,reason:'coverage'};
 const spec=sport==='football'?null:bpMSpecs(sport,q.competition).find(s=>s.feed===feed);
 if(sport==='football'?!feed.startsWith('soccer/'):!spec)return {ok:false,reason:'coverage'};
 const key=[sport,feed,bpEvidenceNorm(home),bpEvidenceNorm(away),new Date(start).toISOString()].join('|');
 const cached=bpForecastMemo.get(key);if(cached&&cached.until>now)return cached.value;
 if(bpForecastPending.has(key))return bpForecastPending.get(key);
 if(bpForecastPending.size>=2)return {ok:false,reason:'busy'};
 const task=(async()=>{
  const target=await bpForecastFixture(q,feed,start,home,away);if(!target)return {ok:false,reason:'fixture'};
  const hist=sport==='football'?await bpPHistory(env,home,away,q.competition,{feed,home:target.home,away:target.away}):await bpMHistory({spec,home:target.home,away:target.away});
  if(!hist?.ok)return {ok:false,reason:'history',home_matches:hist?.home_matches||0,away_matches:hist?.away_matches||0};
  if(Date.now()>=target.start-120000)return {ok:false,reason:'started'};
  if(!Array.isArray(hist.source_urls)||!hist.source_urls.length||hist.home_matches<5||hist.away_matches<5||hist.home_effective<2||hist.away_effective<2)return {ok:false,reason:'history'};
  const m=sport==='football'?bpPModel(hist,0,0,0):bpMForecast(hist,0,0,0,null);
  if(!m||m.error||!m.outcomes)return {ok:false,reason:'model'};
  const out=m.outcomes,values=[out.home_win,out.away_win,...(out.draw==null?[]:[out.draw])];
  if(values.some(v=>!Number.isFinite(v)||v<0||v>100)||Math.abs(values.reduce((a,b)=>a+b,0)-100)>.25)return {ok:false,reason:'model'};
  const quality=hist.home_matches>=12&&hist.away_matches>=12&&hist.home_effective>=5&&hist.away_effective>=5?'standard':'limited';
  return {ok:true,version:'poisson-card-v1',sport,home:target.home.displayName,away:target.away.displayName,start:new Date(target.start).toISOString(),
   model_type:sport==='football'?'poisson':sport==='hockey'||sport==='baseball'?'count':'normal',
   outcomes:out,fair_odds:{home:out.home_win>0?Math.round(10000/out.home_win)/100:null,away:out.away_win>0?Math.round(10000/out.away_win)/100:null,draw:out.draw>0?Math.round(10000/out.draw)/100:null},
   expected_final:m.expected_final,quality,home_matches:hist.home_matches,away_matches:hist.away_matches,
   home_effective:hist.home_effective,away_effective:hist.away_effective,source_urls:[target.url,...hist.source_urls].slice(0,5),checked_at:isoNow(),calibrated:false};
 })().catch(()=>({ok:false,reason:'unavailable'})).then(result=>{if(bpForecastMemo.size>=160)bpForecastMemo.delete(bpForecastMemo.keys().next().value);bpForecastMemo.set(key,{value:result,until:Math.min(start-120000,Date.now()+(result.ok?15:3)*60000)});return result;}).finally(()=>bpForecastPending.delete(key));
 bpForecastPending.set(key,task);return task;
}
