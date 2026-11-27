/* Poisson match evidence: real structured ESPN data, no odds credits, no D1/KV writes. */
const bpEvidencePending=new Map(),bpEvidenceCache=new Map();
const bpEvidenceFeeds=new Set(['basketball/nba','basketball/wnba','basketball/mens-college-basketball','basketball/womens-college-basketball','football/nfl','football/college-football','hockey/nhl','baseball/mlb','rugby/164205','rugby/267979','rugby/180659','rugby/271937','rugby-league/3']);
function bpEvidenceText(v,n=140){return String(v??'').trim().slice(0,n);}
function bpEvidenceNorm(v){return bpEvidenceText(v,200).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function bpEvidenceName(a,b){const x=bpEvidenceNorm(a),y=bpEvidenceNorm(b);return x.length>=3&&y.length>=3&&(x===y||(Math.min(x.length,y.length)>=8&&(x.startsWith(y)||y.startsWith(x))));}
function bpEvidenceTeam(c){return c?.team?.displayName||c?.team?.name||c?.athlete?.displayName||c?.athlete?.name||'';}
function bpEvidencePair(competitors,home,away){if(!Array.isArray(competitors)||competitors.length!==2)return false;const a=bpEvidenceTeam(competitors[0]),b=bpEvidenceTeam(competitors[1]);return (bpEvidenceName(a,home)&&bpEvidenceName(b,away))||(bpEvidenceName(a,away)&&bpEvidenceName(b,home));}
function bpEvidenceFeed(q){
 const raw=bpEvidenceText(q.feed,90),sport=bpEvidenceText(q.sport,90);
 const permitted=new Set([...bpEvidenceFeeds,...Object.values(BETPRO_SETTLE_FEEDS),...betproFollowFeedsForSport(sport)]);
 if(permitted.has(raw)&&/^(soccer|basketball|football|hockey|baseball|rugby|rugby-league)\/[a-z0-9.-]+$/.test(raw))return raw;
 return betproFollowFeedsForSport(sport).find(f=>/^(soccer|basketball|football|hockey|baseball|rugby|rugby-league)\/[a-z0-9.-]+$/.test(f))||null;
}
function bpEvidenceExtract(data,home,away,start){
 const header=data?.header?.competitions?.[0],at=Date.parse(header?.date||data?.header?.competitions?.[0]?.startDate||'');
 if(!bpEvidencePair(header?.competitors,home,away)||!Number.isFinite(at)||Math.abs(at-start)>3*3600000)return null;
 const names=header.competitors.map(bpEvidenceTeam),inMatch=n=>names.some(x=>bpEvidenceName(x,n));
 const injuries=[],suspensions=[],lineups=[],form=[],standings=[];
 for(const sec of Array.isArray(data.injuries)?data.injuries:[]){
  const team=bpEvidenceText(sec.team?.displayName||sec.displayName);if(!inMatch(team))continue;
  for(const p of (Array.isArray(sec.injuries)?sec.injuries:[]).slice(0,20)){
   const player=bpEvidenceText(p.athlete?.displayName||p.athlete?.fullName),date=Date.parse(p.date||p.lastUpdated||''),status=bpEvidenceText(p.status||p.type?.description,80);
   if(!player||!status||!Number.isFinite(date)||date>Date.now()+300000||Date.now()-date>7*86400000)continue;
   const note=bpEvidenceText(p.shortComment,180),reason=bpEvidenceText(p.details?.type||p.type?.description,80);
   const item={team,player,status,date:new Date(date).toISOString(),note};
   if(/suspend|suspension|disciplin/i.test(status+' '+reason+' '+note))suspensions.push(item);else injuries.push(item);
  }
 }
 for(const r of Array.isArray(data.rosters)?data.rosters:[]){
  const team=bpEvidenceText(r.team?.displayName);if(!inMatch(team))continue;
  const players=Array.isArray(r.roster)?r.roster:[];
  const starters=players.filter(p=>p.starter===true||p.starting===true||p.isStarter===true).map(p=>bpEvidenceText(p.athlete?.displayName||p.displayName||p.name)).filter(Boolean);
  if(starters.length>=5)lineups.push({team,players:starters.slice(0,30)});
 }
 for(const f of Array.isArray(data.lastFiveGames)?data.lastFiveGames:[]){
  const team=bpEvidenceText(f.team?.displayName);if(!inMatch(team))continue;
  const results=(Array.isArray(f.events)?f.events:[]).map(e=>({date:Date.parse(e.gameDate||e.date||''),result:String(e.gameResult||'').toUpperCase(),opponent:bpEvidenceText(e.opponent?.displayName),score:bpEvidenceText(e.score,50)})).filter(e=>['W','L','D','T'].includes(e.result)&&Number.isFinite(e.date)&&e.date<Math.min(Date.now(),start)&&e.date>Date.now()-180*86400000).sort((a,b)=>b.date-a.date).slice(0,5).map(e=>({...e,date:new Date(e.date).toISOString()}));
  if(results.length)form.push({team,results});
 }
 for(const row of (data.standings?.groups||[]).flatMap(g=>g.standings?.entries||[])){
  const team=bpEvidenceText(row.team?.displayName||row.team);if(!inMatch(team))continue;
  const stats=(Array.isArray(row.stats)?row.stats:[]).filter(s=>['points','gamesPlayed','wins','losses','ties','rank'].includes(s.name)).map(s=>({name:s.name,value:bpEvidenceText(s.displayValue??s.value,30)})).filter(s=>s.value);
  if(stats.length)standings.push({team,stats});
 }
 return {injuries,suspensions,lineups,form,standings};
}
async function bpPoissonEvidence(q){
 const home=bpEvidenceText(q.home),away=bpEvidenceText(q.away),start=Date.parse(q.start||''),feed=bpEvidenceFeed(q);
 if(!home||!away||!Number.isFinite(start)||Math.abs(start-Date.now())>4*86400000||!feed)return{ok:false,reason:'coverage'};
 const key=[feed,bpEvidenceNorm(home),bpEvidenceNorm(away),new Date(start).toISOString()].join('|');
 const cached=bpEvidenceCache.get(key);if(cached&&cached.until>Date.now())return cached.value;
 if(bpEvidencePending.has(key))return bpEvidencePending.get(key);
 if(bpEvidencePending.size>=4)return{ok:false,reason:'busy'};
 const task=(async()=>{
  const base='https://site.api.espn.com/apis/site/v2/sports/'+feed;
  let id='',data=null;
  const directId=bpEvidenceText(q.id,20);
  // Only accept event ID from the same exact ESPN feed, and validate both participants and date in the summary.
  if(q.feed===feed&&/^\d{5,12}$/.test(directId)){
   try{const d=await betproChatExternal(base+'/summary?event='+directId,{ttl:10*60000,maxBytes:1800000});if(bpEvidenceExtract(d,home,away,start)){id=directId;data=d;}}catch(_){}
  }
  if(!data){
   const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(start));
   const parts=Object.fromEntries(day.map(x=>[x.type,x.value])),dates=[parts.year+parts.month+parts.day,new Date(start).toISOString().slice(0,10).replace(/-/g,'')];
   const distinct=[...new Set(dates)];
   for(const date of distinct){
    try{
     const d=await betproChatExternal(base+'/scoreboard?dates='+date+'&limit=500',{ttl:10*60000,maxBytes:2000000});
     const candidates=(d.events||[]).filter(e=>{const c=e.competitions?.[0],at=Date.parse(c?.date||e.date||'');return Number.isFinite(at)&&Math.abs(at-start)<=3*3600000&&bpEvidencePair(c?.competitors,home,away);});
     if(candidates.length!==1)continue;const candidate=bpEvidenceText(candidates[0].id,20);if(!/^\d{5,12}$/.test(candidate))continue;
     const summary=await betproChatExternal(base+'/summary?event='+candidate,{ttl:10*60000,maxBytes:1800000});if(bpEvidenceExtract(summary,home,away,start)){id=candidate;data=summary;break;}
    }catch(_){}
   }
  }
  const facts=data?bpEvidenceExtract(data,home,away,start):null;
  const result=facts?{ok:true,source:'ESPN',source_url:base+'/summary?event='+id,checked_at:new Date().toISOString(),facts}: {ok:false,reason:'unavailable'};
  if(bpEvidenceCache.size>=120)bpEvidenceCache.delete(bpEvidenceCache.keys().next().value);
  bpEvidenceCache.set(key,{value:result,until:Date.now()+(facts?10:3)*60000});return result;
 })().catch(()=>({ok:false,reason:'unavailable'})).finally(()=>bpEvidencePending.delete(key));
 bpEvidencePending.set(key,task);return task;
}
