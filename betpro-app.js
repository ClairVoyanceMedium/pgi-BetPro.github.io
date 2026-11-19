const NO_RELIABLE_CARD_MESSAGE = 'Aucune carte n’est fiable pour l’instant.';
// ═══════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════
const WORKER_URL = 'https://pgi-betpro.peritoregroupindustries.workers.dev';
// ⚠️ AUTH_TOKEN est visible côté client (n'importe qui peut l'inspecter dans le code source).
// Ce n'est PAS une vraie sécurité — juste un filtre basique anti-bot.
// Toute action sensible (écriture KV, résultats, secrets) doit être validée côté Worker.
const AUTH_TOKEN = 'PgiBetProWinMoney';

// Toutes les requêtes d'interface sont bornées. Une API externe lente ne peut
// donc plus laisser un bouton, le ticker ou un écran bloqué indéfiniment.
// Le quatrième argument est additif : tous les anciens appels restent valides.
// Cache strictement réservé aux lectures de catalogue et de tableau de bord.
// Les scans, les cotes Live, les historiques, les écritures et les commandes
// continuent d'interroger le moteur normalement pour préserver leur fraîcheur.
const BETPRO_READ_CACHE_PREFIX='betpro-read-v1:';
const BETPRO_READ_CACHE_INFLIGHT=new Map();
const BETPRO_READ_CACHE_MEMORY=new Map();
function betproReadCacheTtl(path){
  if(path==='/api/sports')return 10*60*1000;
  if(path==='/api/quotas')return 20*1000;
  if(path.startsWith('/api/turf/upcoming?date_filter='))return 60000;
  if(path.startsWith('/api/ticker?'))return 90*1000;
  if(path.startsWith('/api/news?'))return 90*1000;
  return 0;
}
async function api(path, method='GET', body=null, requestOptions={}) {
  const ttl=(String(method).toUpperCase()==='GET'&&body==null&&!requestOptions.signal&&!requestOptions.noCache)
    ?betproReadCacheTtl(path):0;
  if(ttl){
    const now=Date.now();
    const memory=BETPRO_READ_CACHE_MEMORY.get(path);
    if(memory&&now>=memory.ts&&now-memory.ts<ttl)return memory.data;
    try{
      const saved=localStorage.getItem(BETPRO_READ_CACHE_PREFIX+path);
      if(saved){
        const entry=JSON.parse(saved);
        if(entry&&entry.ts&&now>=entry.ts&&now-entry.ts<ttl){
          BETPRO_READ_CACHE_MEMORY.set(path,entry);
          return entry.data;
        }
        localStorage.removeItem(BETPRO_READ_CACHE_PREFIX+path);
      }
    }catch(_){}
    const existing=BETPRO_READ_CACHE_INFLIGHT.get(path);
    if(existing)return existing;
  }
  const execute=async()=>{
    const timeoutMs=Math.min(120000,Math.max(1000,Number(requestOptions.timeoutMs)||35000));
    const controller=new AbortController();
    const externalSignal=requestOptions.signal||null;
    let timedOut=false;
    const abortFromExternal=()=>controller.abort();
    if(externalSignal){
      if(externalSignal.aborted)controller.abort();
      else externalSignal.addEventListener('abort',abortFromExternal,{once:true});
    }
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    const opts={
      method,
      signal:controller.signal,
      headers:{'Authorization':'Bearer '+AUTH_TOKEN,'Content-Type':'application/json'}
    };
    if(body)opts.body=JSON.stringify(body);
    try{
      const response=await fetch(WORKER_URL+path,opts);
      if(!response.ok){
        const errorData=await response.json().catch(()=>({}));
        throw new Error(errorData.error||'HTTP '+response.status);
      }
      const data=await response.json();
      if(ttl&&data&&data.ok!==false&&!data.error){
        const entry={ts:Date.now(),data};
        BETPRO_READ_CACHE_MEMORY.set(path,entry);
        try{
          const serialized=JSON.stringify(entry);
          if(serialized.length<450000)localStorage.setItem(BETPRO_READ_CACHE_PREFIX+path,serialized);
        }catch(_){}
      }
      return data;
    }catch(error){
      if(controller.signal.aborted){
        if(timedOut)throw new Error('Délai dépassé après '+Math.round(timeoutMs/1000)+' s');
        throw new Error('Requête annulée');
      }
      throw error;
    }finally{
      clearTimeout(timer);
      if(externalSignal)externalSignal.removeEventListener('abort',abortFromExternal);
    }
  };
  const pending=execute();
  if(ttl)BETPRO_READ_CACHE_INFLIGHT.set(path,pending);
  try{return await pending;}
  finally{
    if(ttl&&BETPRO_READ_CACHE_INFLIGHT.get(path)===pending)
      BETPRO_READ_CACHE_INFLIGHT.delete(path);
  }
}
// ═══════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function enc(s){ return encodeURIComponent(s||''); }
function fmtDate(s){ if(!s) return ''; try{ return new Date(s).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); } catch(_){ return s; } }
function fmtDT(s){ if(!s) return ''; try{ return new Date(s).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); } catch(_){ return s; } }

// ── Date locale (France) — évite les décalages UTC autour de minuit ──
function localDateStr(d){
  const p = n => String(n).padStart(2,'0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}
// Jour local France d'une date ISO quelconque (même logique que le Worker, via Intl/Europe-Paris).
// Essentiel pour comparer correctement une date de match à la date demandée par l'utilisateur,
// quel que soit le fuseau du navigateur.
function frenchDateStrClient(dateInput){
  try{
    const d = new Date(dateInput);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Paris', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
    const y = parts.find(p=>p.type==='year')?.value;
    const m = parts.find(p=>p.type==='month')?.value;
    const day = parts.find(p=>p.type==='day')?.value;
    return (y&&m&&day) ? `${y}-${m}-${day}` : d.toISOString().slice(0,10);
  }catch(_){ return new Date(dateInput).toISOString().slice(0,10); }
}
// Normalisation de noms d'équipes : accent-insensible, casse-insensible, ponctuation retirée.
// Utilisée pour retrouver le "vrai" match dans les cotes réelles sans dépendre d'une saisie exacte.
function normTeamName(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\b(fc|cf|afc|sc|ac|as|us|cd|ud|ca|club|calcio|de|le|la|les|el)\b/g,'')
    .replace(/[^a-z0-9]/g,'')
    .trim();
}
function teamNamesMatch(inputName, realName){
  const a = normTeamName(inputName), b = normTeamName(realName);
  if(!a || !b) return false;
  if(a===b) return true;
  if(a.length>=4 && (b.includes(a) || a.includes(b))) return true;
  return false;
}

let _toastT;
function toast(msg, type='') {
  const d=document.getElementById('toasts'); if(!d) return;
  const t=document.createElement('div'); t.className='toast '+(type||''); t.textContent=msg;
  d.appendChild(t); setTimeout(()=>t.remove(), 3800);
}

// ═══════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════
function go(name) {
  document.querySelectorAll('.sec').forEach(s=>s.classList.remove('on'));
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('on'));
  document.getElementById('s-'+name)?.classList.add('on');
  document.querySelector('[data-s="'+name+'"]')?.classList.add('on');
  cSb();
  if(name==='results')  loadResults();
  if(name==='notes')    { notesLoad(); notesRender(); notesSyncCloud(); }
  if(name==='dash')     { setTimeout(loadTicker, 500); setTimeout(loadProfessionalMaturity, 700); }
  if(name==='methods')  { lossRender(); initMethods(); }
  if(name==='settings') { loadSettings(); loadSysStatus(); loadAIStatus(); }
  if(name==='perf')     { loadPerformances(); }
  if(name==='live')     { loadLive(); if(betProActiveEngine==='classic') loadUpcoming(); }
  if(name==='blackjack') bjInit();
  if(name==='hkjc')     hkjcInit();
  else                  hkjcStopAutoRefresh();
  if(name==='turf')     turfInit();
  else                  turfStopAutoRefresh();
}
function tSb(){ document.getElementById('sb').classList.toggle('open'); document.getElementById('ov').classList.toggle('on'); }
function cSb(){ document.getElementById('sb').classList.remove('open'); document.getElementById('ov').classList.remove('on'); }

// ═══════════════════════════════════════════════
//  BLOCAGE DU PULL-TO-REFRESH (rafraîchissement au scroll)
//  overscroll-behavior-y:contain (CSS) suffit sur la majorité des navigateurs
//  modernes. Ce verrou JS est un filet de sécurité pour les WebViews plus
//  anciennes qui ignorent overscroll-behavior : on empêche uniquement le
//  "tirer vers le bas" quand on est déjà tout en haut de la page, sans
//  jamais bloquer le scroll normal ni le scroll interne des zones dédiées
//  (chat, ticker, listes) qui gèrent leur propre défilement.
(function initPullToRefreshBlock(){
  let startY = 0;
  document.addEventListener('touchstart', function(e){
    if(e.touches && e.touches.length===1) startY = e.touches[0].clientY;
  }, {passive:true});
  document.addEventListener('touchmove', function(e){
    if(!e.touches || e.touches.length!==1) return;
    const y = e.touches[0].clientY;
    const pullingDown = y > startY;
    const atTop = (window.scrollY||document.documentElement.scrollTop||0) <= 0;
    // Ne bloque que le geste de "tirer vers le bas depuis le tout haut de la page",
    // et seulement si la cible n'est pas elle-même un conteneur scrollable interne
    // encore scrollable vers le haut (pour ne jamais casser le scroll du chat/ticker).
    if(atTop && pullingDown){
      let el = e.target;
      let insideScrollable = false;
      while(el && el !== document.body){
        if(el.scrollHeight > el.clientHeight && el.scrollTop > 0){ insideScrollable = true; break; }
        el = el.parentElement;
      }
      if(!insideScrollable) e.preventDefault();
    }
  }, {passive:false});
})();

// ═══════════════════════════════════════════════
//  SCAN CACHE
// ═══════════════════════════════════════════════
const SCAN_CACHE_TTL = 45*60*1000;
function getScanCache(k){try{const r=localStorage.getItem('pgi_scan_'+k);if(!r)return null;const{data,ts}=JSON.parse(r);if(Date.now()-ts>SCAN_CACHE_TTL){localStorage.removeItem('pgi_scan_'+k);return null;}return{data,age:Math.round((Date.now()-ts)/60000)};}catch(_){return null;}}
function setScanCache(k,d){try{localStorage.setItem('pgi_scan_'+k,JSON.stringify({data:d,ts:Date.now()}));}catch(_){}}
function clearScanCache(){try{Object.keys(localStorage).filter(k=>k.startsWith('pgi_scan_')).forEach(k=>localStorage.removeItem(k));}catch(_){}toast('Cache vidé','ok');}

// ═══════════════════════════════════════════════
//  SÉCURITÉ LIGUES INVALIDES — auto-exclusion après échecs répétés
//  (n'affiche jamais d'erreur à l'utilisateur, ne bloque jamais le scan)
// ═══════════════════════════════════════════════
const LEAGUE_FAIL_KEY = 'pgi_league_fails_v1';
const LEAGUE_FAIL_THRESHOLD = 4;
function leagueFailLoad(){ try{ return JSON.parse(localStorage.getItem(LEAGUE_FAIL_KEY)||'{}'); }catch(_){ return {}; } }
function leagueFailSave(o){ try{ localStorage.setItem(LEAGUE_FAIL_KEY, JSON.stringify(o)); }catch(_){} }
function leagueFailRecord(sport){ const f=leagueFailLoad(); f[sport]=(f[sport]||0)+1; leagueFailSave(f); }
function leagueFailReset(sport){ const f=leagueFailLoad(); if(f[sport]){ delete f[sport]; leagueFailSave(f); } }
function isLeagueExcluded(sport){ const f=leagueFailLoad(); return (f[sport]||0) >= LEAGUE_FAIL_THRESHOLD; }

// ═══════════════════════════════════════════════
//  VALIDATION DYNAMIQUE DES CLÉS DE LIGUES — via /api/sports du Worker
// ═══════════════════════════════════════════════
let _validSportKeysCache = null; // null = pas encore chargé/indisponible ; Set = chargé
async function loadValidSportKeys() {
  try {
    const d = await api('/api/sports');
    const raw = d.sports || d.keys || d.data || [];
    const keys = raw.map(s => (typeof s === 'string' ? s : (s.key || s.sport || ''))).filter(Boolean);
    if(keys.length) _validSportKeysCache = new Set(keys);

    const soccerEntries = raw
      .filter(s => typeof s === 'object' && s.key && s.key.indexOf('soccer_') === 0 && s.active !== false)
      .map(s => ({ sport:s.key, market:'h2h', label:s.title||s.key }));
    if(soccerEntries.length) FOOTBALL_LEAGUES = soccerEntries;
  } catch(_) { /* endpoint absent ou Worker indisponible → pas de filtrage dynamique, fallback statique */ }
}
function isValidSportKey(sport) {
  if(!_validSportKeysCache) return true;
  return _validSportKeysCache.has(sport);
}

// ═══════════════════════════════════════════════
//  SCAN MODE
// ═══════════════════════════════════════════════
const SCAN_MODES={eco:{maxLeagues:12,markets:1},standard:{maxLeagues:25,markets:2},complet:{maxLeagues:999,markets:5}};
let currentScanMode='standard';
function setScanMode(mode,el){
  currentScanMode=mode;
  ['eco','standard','complet'].forEach(m=>document.getElementById('smode-'+m)?.classList.remove('on'));
  el?.classList.add('on');
  const desc={eco:'Éco — Top 12 ligues, 1 marché. Cache 45min.',standard:'Standard — Couverture large, 2 marchés. Cache 45min.',complet:'Complet — les 5 marchés du site. Sans cache.'}[mode]||'';
  const el2=document.getElementById('smode-desc');if(el2)el2.textContent=desc;
}

// ═══════════════════════════════════════════════
//  SPORT FILTER
// ═══════════════════════════════════════════════
let liveSportFilter='all', liveSportSet=new Set(['all']);
let _scanAllOpps=[], _scanScoreFilter=65, _scanDirFilter='all';
function setScanSport(el){
  const sport=el.dataset.sport||'all';
  if(sport==='all'){liveSportSet=new Set(['all']);}
  else{if(el.classList.contains('on')){liveSportSet.delete(sport);if(!liveSportSet.size)liveSportSet=new Set(['all']);}else{liveSportSet.delete('all');liveSportSet.add(sport);}}
  liveSportFilter=liveSportSet.has('all')?'all':[...liveSportSet].sort().join(',');
  document.querySelectorAll('.ssb').forEach(b=>b.classList.toggle('on',liveSportSet.has('all')?b.dataset.sport==='all':liveSportSet.has(b.dataset.sport||'')));
  if(document.querySelector('.dir-card')||document.querySelector('.oc')){filterScanCards();}
}
const LIVE_SPORT_KEYS={soccer:['soccer'],basketball:['basketball','nba'],tennis:['tennis'],rugby:['rugby'],icehockey:['icehockey','hockey'],baseball:['baseball'],mma:['mma','boxing'],americanfootball:['americanfootball','nfl'],handball:['handball'],volleyball:['volleyball']};
function matchesSportFilter(sport,filter){if(filter==='all')return true;const name=String(sport||'').toLowerCase();return String(filter||'').split(',').some(cat=>{const keys=LIVE_SPORT_KEYS[cat]||[cat];return keys.some(k=>name.includes(k));});}
function filterScanCards(){document.querySelectorAll('#scan-res [data-sport-key],#scan-classic-res [data-sport-key]').forEach(c=>{c.style.display=matchesSportFilter(c.dataset.sportKey||'',liveSportFilter)?'':'none';});}

// ═══════════════════════════════════════════════
//  LEAGUES PAR SPORT — FOOTBALL INCLUS (DÉTECTION DYNAMIQUE)
// ═══════════════════════════════════════════════
const FOOTBALL_LEAGUES_FALLBACK = [
  { sport:'soccer_epl', market:'h2h', label:'Premier League' },
  { sport:'soccer_france_ligue1', market:'h2h', label:'Ligue 1' },
  { sport:'soccer_spain_la_liga', market:'h2h', label:'Liga' },
  { sport:'soccer_germany_bundesliga', market:'h2h', label:'Bundesliga' },
  { sport:'soccer_italy_serie_a', market:'h2h', label:'Serie A' },
  { sport:'soccer_netherlands_eredivisie', market:'h2h', label:'Eredivisie' },
  { sport:'soccer_portugal_primeira_liga', market:'h2h', label:'Primeira Liga' },
  { sport:'soccer_ucl', market:'h2h', label:'Champions League' },
  { sport:'soccer_uel', market:'h2h', label:'Europa League' },
  { sport:'soccer_fifa_world_cup', market:'h2h', label:'Coupe du monde' },
  { sport:'soccer_conmebol_copa_america', market:'h2h', label:'Copa América' },
  { sport:'soccer_concacaf_gold_cup', market:'h2h', label:'Gold Cup' },
  { sport:'soccer_mls', market:'h2h', label:'MLS' },
  { sport:'soccer_mexico_ligamx', market:'h2h', label:'Liga MX' },
  { sport:'soccer_japan_j_league', market:'h2h', label:'J-League' },
  { sport:'soccer_australia_aleague', market:'h2h', label:'A-League' },
  { sport:'soccer_turkey_super_liga', market:'h2h', label:'Süper Lig' },
];
let FOOTBALL_LEAGUES = FOOTBALL_LEAGUES_FALLBACK.slice();

const FOOTBALL_EXTRA_MARKETS_BY_MODE = { eco: [], standard: ['totals'], complet: ['totals','spreads','btts','double_chance'] };
function getFootballScanEntries(mode) {
  const extra = FOOTBALL_EXTRA_MARKETS_BY_MODE[mode] || [];
  const entries = [];
  FOOTBALL_LEAGUES.forEach(l => {
    entries.push({ sport:l.sport, market:'h2h' });
    extra.forEach(mk => entries.push({ sport:l.sport, market:mk }));
  });
  return entries;
}

function getScanLeaguesByMode(mode) {
  const football = getFootballScanEntries(mode);
  if(mode === 'eco') {
    return [
      ...football,
      {sport:'basketball_nba',market:'h2h'},
      {sport:'tennis_atp',market:'h2h'},
      {sport:'mma_mixed_martial_arts',market:'h2h'},
      {sport:'icehockey_nhl',market:'h2h'},
      {sport:'baseball_mlb',market:'h2h'},
      {sport:'rugbyunion_premiership',market:'h2h'},
    ];
  }
  if(mode === 'complet') {
    return [
      ...football,
      {sport:'basketball_nba',market:'h2h'},{sport:'basketball_nba',market:'spreads'},
      {sport:'basketball_euroleague',market:'h2h'},
      {sport:'tennis_atp',market:'h2h'},{sport:'tennis_wta',market:'h2h'},
      {sport:'tennis_atp_french_open',market:'h2h'},{sport:'tennis_wta_french_open',market:'h2h'},
      {sport:'mma_mixed_martial_arts',market:'h2h'},{sport:'boxing_boxing',market:'h2h'},
      {sport:'icehockey_nhl',market:'h2h'},{sport:'icehockey_nhl',market:'totals'},
      {sport:'rugbyunion_premiership',market:'h2h'},
      {sport:'baseball_mlb',market:'h2h'},
      {sport:'americanfootball_nfl',market:'h2h'},
      {sport:'aussierules_afl',market:'h2h'},
    ];
  }
  return [
    ...football,
    {sport:'basketball_nba',market:'h2h'},{sport:'basketball_nba',market:'spreads'},
    {sport:'basketball_euroleague',market:'h2h'},
    {sport:'tennis_atp',market:'h2h'},{sport:'tennis_wta',market:'h2h'},
    {sport:'tennis_atp_french_open',market:'h2h'},{sport:'tennis_wta_french_open',market:'h2h'},
    {sport:'mma_mixed_martial_arts',market:'h2h'},{sport:'boxing_boxing',market:'h2h'},
    {sport:'icehockey_nhl',market:'h2h'},
    {sport:'rugbyunion_premiership',market:'h2h'},
    {sport:'baseball_mlb',market:'h2h'},
    {sport:'americanfootball_nfl',market:'h2h'},
  ];
}

// ═══════════════════════════════════════════════
//  MAPPING SPORT → LIGUES ACTIVES (évite les scans disproportionnés)
// ═══════════════════════════════════════════════
function bucketActiveSportsByCategory() {
  const buckets = { soccer:[], basketball:[], tennis:[], icehockey:[], americanfootball:[], baseball:[], rugby:[], mma:[], handball:[], volleyball:[] };
  if(!_validSportKeysCache) return buckets;
  _validSportKeysCache.forEach(k => {
    const key = (k||'').toLowerCase();
    if(key.indexOf('soccer_') === 0) buckets.soccer.push(k);
    else if(key.indexOf('basketball_') === 0) buckets.basketball.push(k);
    else if(key.indexOf('tennis_') === 0) buckets.tennis.push(k);
    else if(key.indexOf('icehockey_') === 0) buckets.icehockey.push(k);
    else if(key.indexOf('americanfootball_') === 0 || key.includes('nfl')) buckets.americanfootball.push(k);
    else if(key.indexOf('baseball_') === 0) buckets.baseball.push(k);
    else if(key.includes('rugby')) buckets.rugby.push(k);
    else if(key.includes('mma') || key.includes('boxing')) buckets.mma.push(k);
    else if(key.indexOf('handball_') === 0) buckets.handball.push(k);
    else if(key.indexOf('volleyball_') === 0) buckets.volleyball.push(k);
  });
  return buckets;
}

const SPORT_STATIC_FALLBACK = {
  soccer: FOOTBALL_LEAGUES_FALLBACK.map(l => l.sport),
  basketball: ['basketball_nba','basketball_euroleague'],
  tennis: ['tennis_atp','tennis_wta','tennis_atp_french_open','tennis_wta_french_open'],
  icehockey: ['icehockey_nhl'],
  americanfootball: ['americanfootball_nfl'],
  baseball: ['baseball_mlb'],
  rugby: ['rugbyunion_premiership'],
  mma: ['mma_mixed_martial_arts','boxing_boxing'],
  // Handball : aucune clé statique fiable dans la durée — on ne s'appuie que sur la
  // détection dynamique via /api/sports (bucketActiveSportsByCategory). Si aucune
  // ligue handball n'est active à l'instant, le scan handball retourne 0 requête au
  // lieu de cibler une compétition qui pourrait ne plus exister.
  handball: [],
  // Volleyball : à la date d'ajout de ce sport, The Odds API ne référence encore
  // AUCUNE clé "volleyball_*" dans son catalogue officiel — donc aucun fallback
  // statique n'existe (inventer une clé produirait des requêtes systématiquement
  // vides ou en échec, sans jamais remonter de vraie cote). Le filtre Volleyball
  // reste 100% dynamique via /api/sports : si The Odds API ajoute un jour des
  // ligues de volleyball, le scan les détectera automatiquement sans modification
  // de code. En attendant, le scan Volleyball affichera honnêtement 0 opportunité
  // plutôt que d'inventer une analyse.
  volleyball: [],
};

const SPORT_SCAN_CAPS          = { soccer:15, basketball:6, tennis:6, icehockey:4, americanfootball:3, baseball:3, rugby:4, mma:6, handball:3, volleyball:3 };
const SPORT_SCAN_CAPS_ALL_MODE = { soccer:8,  basketball:2, tennis:3, icehockey:1, americanfootball:1, baseball:1, rugby:1, mma:2, handball:1, volleyball:1 };

function getLeaguesForSportFilter(filter, mode) {
  const buckets = bucketActiveSportsByCategory();
  const extraMarketsByMode = { eco: [], standard: ['totals'], complet: ['totals','btts'] };
  const extraMarkets = extraMarketsByMode[mode] || [];

  function entriesForCategory(cat, cap) {
    const dynamic = buckets[cat] || [];
    const keys = (dynamic.length ? dynamic : (SPORT_STATIC_FALLBACK[cat] || [])).slice(0, cap);
    const out = [];
    keys.forEach(k => {
      out.push({ sport:k, market:'h2h' });
      if(cat === 'soccer') extraMarkets.forEach(mk => out.push({ sport:k, market:mk }));
    });
    return out;
  }

  if(filter && filter !== 'all') {
    const cats=[...new Set(String(filter).split(',').filter(cat=>Object.prototype.hasOwnProperty.call(SPORT_SCAN_CAPS,cat)))];
    return cats.flatMap(cat=>entriesForCategory(cat,cats.length===1?(SPORT_SCAN_CAPS[cat]||8):(SPORT_SCAN_CAPS_ALL_MODE[cat]||3)));
  }

  let out = [];
  Object.keys(SPORT_SCAN_CAPS_ALL_MODE).forEach(cat => {
    out = out.concat(entriesForCategory(cat, SPORT_SCAN_CAPS_ALL_MODE[cat]));
  });
  return out;
}

// ═══════════════════════════════════════════════
//  LIVE SCAN — avec football
// ═══════════════════════════════════════════════
let _scanDateFilter = 'all';

function setScanDateFilter(val, el) {
  _scanDateFilter = val;
  document.querySelectorAll('#scan-date-btns .fbtn').forEach(b=>b.classList.remove('on'));
  el?.classList.add('on');
  const wrap = document.getElementById('scan-custom-date-wrap');
  if(wrap) wrap.style.display = val==='custom' ? 'block' : 'none';
}

function getScanDateParams() {
  const now   = new Date();
  const today = localDateStr(now);

  if(_scanDateFilter === 'all')  return {};
  if(_scanDateFilter === 'today') return { date_filter:'today', date_from:today, date_to:today };

  if(_scanDateFilter === 'tomorrow') {
    const d = new Date(now); d.setDate(d.getDate()+1);
    const tom = localDateStr(d);
    return { date_filter:'tomorrow', date_from:tom, date_to:tom };
  }
  if(_scanDateFilter === 'week') {
    const d = new Date(now); d.setDate(d.getDate()+7);
    return { date_filter:'week', date_from:today, date_to:localDateStr(d) };
  }
  if(_scanDateFilter === 'weekend') {
    const day = now.getDay();
    const diff = day===0 ? 6 : day===6 ? 7 : (6-day);
    const sat = new Date(now); sat.setDate(sat.getDate()+diff);
    const sun = new Date(sat); sun.setDate(sun.getDate()+1);
    return { date_filter:'weekend', date_from:localDateStr(sat), date_to:localDateStr(sun) };
  }
  if(_scanDateFilter === '7d') {
    const d = new Date(now); d.setDate(d.getDate()+7);
    return { date_filter:'7d', date_from:today, date_to:localDateStr(d) };
  }
  if(_scanDateFilter === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth()+1, 0);
    return { date_filter:'month', date_from:today, date_to:localDateStr(d) };
  }
  if(_scanDateFilter === 'custom') {
    return {
      date_filter:'custom',
      date_from: document.getElementById('scan-date-from')?.value || today,
      date_to:   document.getElementById('scan-date-to')?.value   || today,
    };
  }
  return {};
}

// ═══════════════════════════════════════════════
//  SCAN ÉQUILIBRÉ MULTI-SPORTS — évite que le football écrase tout
//  quand le filtre est "Tout". Standard d'abord par sport, fallback expert
//  uniquement pour un sport qui ne sort aucune carte standard, jamais pour
//  le rattrapage (lossAutoSearch continue d'utiliser 'standard' seul).
// ═══════════════════════════════════════════════
function sportFamilyFromKey(sport) {
  const s = String(sport || '').toLowerCase();
  if (s.includes('soccer')) return 'soccer';
  if (s.includes('basket')) return 'basketball';
  if (s.includes('tennis')) return 'tennis';
  if (s.includes('mma') || s.includes('boxing') || s.includes('box')) return 'mma';
  if (s.includes('icehockey') || s.includes('hockey')) return 'icehockey';
  if (s.includes('baseball')) return 'baseball';
  if (s.includes('rugby')) return 'rugby';
  if (s.includes('americanfootball') || s.includes('nfl')) return 'americanfootball';
  if (s.includes('handball')) return 'handball';
  if (s.includes('volleyball') || s.includes('volley')) return 'volleyball';
  return 'other';
}

function tierRankForSort(tier) {
  if (tier === 'premium') return 0;
  if (tier === 'solid') return 1;
  if (tier === 'basic') return 2;
  return 9;
}

// Filtre de sécurité minimal appliqué aux cartes issues du fallback expert
// PAR SPORT (jamais utilisé pour le rattrapage) — évite qu'une carte trop
// faible (Kelly négatif, EV quasi nulle, données insuffisantes) s'affiche
// simplement parce qu'un sport n'a rien sorti en standard.
function isSafeExpertScanCard(res) {
  if (!res || !res.shouldDisplay || res.direction !== 'play') return false;
  if ((res.evSimple || 0) < 1.02) return false;
  if ((res.edgeProb || 0) < 1.0) return false;
  if ((res.kellyFull || 0) <= 0) return false;
  if ((res.dataQualityScore || 0) < 25) return false;
  if ((res.reliabilityScore || 0) < 58) return false;
  return true;
}

function sortScanCardsBalanced(a, b) {
  const ra = a._res || computeDirection(a);
  const rb = b._res || computeDirection(b);

  const ta = tierRankForSort(ra.tier);
  const tb = tierRankForSort(rb.tier);
  if (ta !== tb) return ta - tb;

  const rsa = ra.reliabilityScore || 0;
  const rsb = rb.reliabilityScore || 0;
  if (Math.abs(rsb - rsa) >= 2) return rsb - rsa;

  const dqsa = ra.dataQualityScore || 0;
  const dqsb = rb.dataQualityScore || 0;
  if (dqsb !== dqsa) return dqsb - dqsa;

  const eva = ra.evSimple || 0;
  const evb = rb.evSimple || 0;
  if (Math.abs(evb - eva) > 0.001) return evb - eva;

  const tA = a.start_time ? new Date(a.start_time).getTime() : Infinity;
  const tB = b.start_time ? new Date(b.start_time).getTime() : Infinity;
  return tA - tB;
}

// buildBalancedScanCards — groupe par famille de sport, teste chaque groupe
// en standard, ne retente en expert (seuils de sécurité isSafeExpertScanCard)
// que si CE sport précis n'a sorti aucune carte standard. Plafonne le
// football à 4 cartes et les autres sports à 3 quand le filtre est "Tout",
// pour garantir de la diversité au lieu de laisser le foot tout occuper.
function betproBenterMarketIsActionable(o,now=Date.now()){
  const start=Date.parse(o?.start_time||o?.commence_time||o?.event_start_at||'');
  const status=String(o?.status||o?.event_status||'').toLowerCase();
  return Number.isFinite(start)&&start>now+120000
    &&Number.isFinite(Number(o?.odds))&&Number(o.odds)>=1.25
    &&String(o?.selection||'').trim().length>0
    &&Array.isArray(o?.all_bookmakers)&&o.all_bookmakers.length>0
    &&!['final','cancelled','canceled','ended','finished','ft','aet','pen'].includes(status);
}
function betproBenterIsActionable(o,now=Date.now()){
  if(!betproBenterMarketIsActionable(o,now))return false;
  const result=o._res||computeDirection(o);
  return result?.shouldDisplay===true&&result.direction==='play';
}

function buildBalancedScanCards(allDeduped, sportFilterVal) {
  const bySport = {};

  allDeduped.forEach(o => {
    const fam = sportFamilyFromKey(o.sport || o._sport);
    if (!bySport[fam]) bySport[fam] = [];
    bySport[fam].push(o);
  });

  const selected = [];

  Object.keys(bySport).forEach(fam => {
    const items = bySport[fam];

    const standardCards = [];
    items.forEach(o => {
      const res = computeDirection(o, {
        mode: 'standard',
        bankroll: 200,
        riskProfile: 'conservateur'
      });
      o._res = res;
      o._dir = res.direction;
      if (res.shouldDisplay && res.direction === 'play') {
        standardCards.push(o);
      }
    });

    let sportCards = standardCards;

    // Fallback expert par sport, seulement si ce sport ne sort aucune carte
    // standard — corrige le problème "2 cartes foot suffisent à bloquer
    // le fallback global" en le rendant local à chaque sport.
    if (!sportCards.length && items.length) {
      const expertCards = [];
      items.forEach(o => {
        const res = computeDirection(o, {
          mode: 'expert',
          bankroll: 200,
          riskProfile: 'conservateur'
        });
        o._res = res;
        o._dir = res.direction;
        if (isSafeExpertScanCard(res)) {
          expertCards.push(o);
        }
      });
      sportCards = expertCards;
    }

    sportCards.sort(sortScanCardsBalanced);

    if (sportFilterVal === 'all') {
      const cap = fam === 'soccer' ? 4 : 3;
      selected.push(...sportCards.slice(0, cap));
    } else {
      selected.push(...sportCards.slice(0, 18));
    }
  });

  selected.sort(sortScanCardsBalanced);
  return selected.slice(0, 18);
}

let liveScanAbortController = null;
let liveScanRunSequence = 0;

async function doLiveScan() {
  // Une relance annule proprement une éventuelle ancienne exécution orpheline.
  if (liveScanAbortController) liveScanAbortController.abort();
  const scanRun = ++liveScanRunSequence;
  const scanController = new AbortController();
  liveScanAbortController = scanController;
  const scanDeadlineMs = 75000;
  const scanDeadlineTimer = setTimeout(() => scanController.abort(), scanDeadlineMs);
  const btn = document.getElementById('scan-btn');
  const cnt = document.getElementById('scan-res');
  btn.className = 'scan-main-btn scanning';
  document.getElementById('scan-btn-ico').innerHTML = '<span class="scan-radar"></span>';
  document.getElementById('scan-btn-txt').textContent = 'SCAN EN COURS…';
  btn.disabled = true;

  // BUG CORRIGÉ : tout le corps du scan est maintenant protégé par try/finally.
  // Avant, si une erreur inattendue survenait (parsing, computeDirection, etc.),
  // le bouton restait bloqué sur "SCAN EN COURS…" avec disabled=true en
  // permanence — seul un rechargement de page permettait de relancer un scan.
  // Le finally garantit désormais que le bouton revient TOUJOURS à son état
  // normal, que le scan réussisse, échoue, ou se termine tôt via le cache.
  try {
    cnt.innerHTML = '<div class="ls"><div class="sp"></div><p>Scan multi-sports en cours (football inclus)…</p></div>';

    const toScan = getLeaguesForSportFilter(liveSportFilter, currentScanMode);
    // BUG CORRIGÉ : getLeaguesForSportFilter() résout déjà lui-même le choix entre
    // ligues dynamiques (confirmées actives par /api/sports) et ligues de repli
    // statiques (quand la catégorie n'a aucune entrée dynamique). Appliquer ENSUITE
    // isValidSportKey() sur le résultat annulait systématiquement ce repli : une
    // ligue statique n'est utilisée QUE si elle est absente de _validSportKeysCache,
    // donc le filtre isValidSportKey() la rejetait presque à coup sûr — ce qui
    // ramenait "Requêtes lancées" à 0 pour tout sport autre que le football (le
    // football, lui, est reconstruit en direct depuis /api/sports et passe donc
    // toujours ce filtre). On ne garde que l'exclusion empirique isLeagueExcluded()
    // (basée sur de vrais échecs de requête observés), qui est fiable pour tous les sports.
    const toScanSafe = toScan.filter(l => !isLeagueExcluded(l.sport));
    toast('Scan mode ' + currentScanMode.toUpperCase() + ' — ' + toScanSafe.length + ' requêtes', 'ok');

    const allOpps = [];
    let totalGamesReceived = 0;
    let totalOppsBeforeFilter = 0;
    let completedRequests = 0;
    let timedOutRequests = 0;
    const _dateParams = (typeof getScanDateParams==='function') ? getScanDateParams() : {};
    const _dateKey   = Object.keys(_dateParams).length ? '_'+JSON.stringify(_dateParams) : '';
    const cacheKey   = 'scan_'+currentScanMode+'_'+liveSportFilter+_dateKey;
    if (currentScanMode !== 'complet') {
      const cached = getScanCache(cacheKey);
      if (cached) {
        renderScanResults(cached.data, cnt, cached.age);
        return;
      }
    }

    // Fetch en parallèle — maximum 6 à la fois pour éviter la saturation
    const chunk = 6;
    for (let i = 0; i < toScanSafe.length; i += chunk) {
      if (scanController.signal.aborted) break;
      const batch = toScanSafe.slice(i, i+chunk);
      const results = await Promise.allSettled(batch.map(({sport,market}) =>
        (()=>{const _qd=getScanDateParams();const _qs=Object.keys(_qd).map(k=>'&'+enc(k)+'='+enc(_qd[k])).join('');return api('/api/analyze?sport='+enc(sport)+'&market='+enc(market)+'&mode=quick'+_qs,'GET',null,{timeoutMs:20000,signal:scanController.signal});})().then(d => {
          completedRequests++;
          leagueFailReset(sport);
          totalGamesReceived += (d.games_count||0);
          totalOppsBeforeFilter += (d.opportunities_before_filter != null ? d.opportunities_before_filter : (d.opportunities||[]).length);
          const opps = (d.opportunities||[]);
          opps.forEach(o => { o._sport = sport; o.sport = sport; });
          return opps;
        }).catch(error=>{
          const message=String(error?.message||error||'');
          // Un délai réseau ou l'échéance globale n'est pas une preuve que la
          // ligue est invalide : ne jamais la bannir du prochain scan.
          if (/Délai dépassé/i.test(message)) timedOutRequests++;
          else if (/Paramètres invalides|HTTP 422|Marché non compatible/i.test(message)) leagueFailRecord(sport);
          return [];
        })
      ));
      results.forEach(r => { if(r.status==='fulfilled') allOpps.push(...r.value); });
    }

    // Dédoublonner
    const seen = new Set();
    const deduped = allOpps.filter(o => {
      const k = (o.home_team||'')+'|'+(o.away_team||'')+'|'+(o.market||'')+'|'+(o.selection||'');
      if(seen.has(k)) return false; seen.add(k); return true;
    });

    // Garder uniquement les cartes JOUER (play), triées par tier puis fiabilité puis date proche.
    // Seuil d'entrée assoupli (score brut >=50 au lieu de 60) : le tri fin se fait ensuite par
    // le moteur William Benter (computeDirection), pas par ce pré-filtre grossier.
    const allDeduped = deduped.filter(o => (o.score?.total || 0) >= 45 && betproBenterMarketIsActionable(o));

    // Nouveau scan équilibré multi-sports :
    // - standard d'abord par sport
    // - fallback expert par sport si CE sport ne sort rien (jamais global)
    // - limitation football (max 4) quand "Tout" est sélectionné, 3 par autre sport
    // - jusqu'à 18 cartes visibles, sans jamais toucher au rattrapage
    let filtered = buildBalancedScanCards(allDeduped, liveSportFilter);

    const bySportDiag = {};
    allDeduped.forEach(o => {
      const fam = sportFamilyFromKey(o.sport || o._sport);
      if (!bySportDiag[fam]) bySportDiag[fam] = { raw:0, displayed:0 };
      bySportDiag[fam].raw++;
    });
    filtered.forEach(o => {
      const fam = sportFamilyFromKey(o.sport || o._sport);
      if (!bySportDiag[fam]) bySportDiag[fam] = { raw:0, displayed:0 };
      bySportDiag[fam].displayed++;
    });

    const diag = {
      requestsLaunched: toScanSafe.length,
      gamesReceived: totalGamesReceived,
      rawOpportunities: totalOppsBeforeFilter || allOpps.length,
      dedupedOpportunities: allDeduped.length,
      displayedCards: filtered.length,
      rejectedByEngine: Math.max(0, allDeduped.length - filtered.length),
      completedRequests,
      timedOutRequests,
      deadlineReached: scanController.signal.aborted,
      bySport: bySportDiag,
    };

    if (currentScanMode !== 'complet') setScanCache(cacheKey, filtered);

    renderScanResults(filtered, cnt, 0, diag);
    loadQuotas();
  } catch (e) {
    cnt.innerHTML = `<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ Erreur pendant le scan : ${esc(e.message || String(e))}</div></div>`;
    toast('Erreur scan: '+(e.message||String(e)), 'err');
  } finally {
    clearTimeout(scanDeadlineTimer);
    if (scanRun === liveScanRunSequence) {
      liveScanAbortController = null;
      btn.className = 'scan-main-btn ready';
      document.getElementById('scan-btn-ico').textContent = '🟠';
      document.getElementById('scan-btn-txt').textContent = 'RELANCER LE SCAN BENTER';
      btn.disabled = false;
      // Le ticker demeure un flux indépendant et se remet à jour après le scan.
      setTimeout(loadTicker, 100);
    }
  }
}

function renderScanResults(opps, cnt, cacheAge, diag) {
  // Filtre reapplique aussi aux caches de scans, apres expiration d'une cote.
  opps=(Array.isArray(opps)?opps:[]).filter(o=>betproBenterIsActionable(o));
  if (!opps.length) {
    const d = diag || {};
    let reason;
    if(d.deadlineReached) reason = `le scan a atteint sa limite de sécurité ; ${d.completedRequests||0} requête(s) ont répondu et ${d.timedOutRequests||0} ont dépassé le délai. Vous pouvez relancer sans recharger la page.`;
    else if(!d.requestsLaunched) reason = 'aucune requête n\'a pu être lancée (sport invalide ou clés Odds API indisponibles).';
    else if(!d.gamesReceived) reason = 'aucun match n\'a été retourné par l\'API pour cette sélection (hors saison, ou aucune rencontre programmée dans la période choisie).';
    else if(!d.rawOpportunities) reason = 'des matchs existent mais aucun bookmaker n\'a publié de cote exploitable pour ce marché actuellement.';
    else reason = 'les seuils du moteur (probabilité, edge, EV, qualité de données) ont rejeté tous les signaux disponibles — essayez le mode Complet, un autre sport, ou élargissez la période.';
    cnt.innerHTML = `<div class="empty">
      <div class="empty-i">🔍</div>
      <div class="empty-t">${esc(NO_RELIABLE_CARD_MESSAGE)}</div>
      <div class="empty-s" style="text-align:left;max-width:440px;margin:10px auto 0">
        <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:12px 14px;font-family:var(--mo);font-size:11px;line-height:2">
          <div>Requêtes lancées&nbsp;: <strong>${d.requestsLaunched||0}</strong></div>
          <div>Requêtes terminées&nbsp;: <strong>${d.completedRequests||0}</strong></div>
          <div>Délais dépassés&nbsp;: <strong>${d.timedOutRequests||0}</strong></div>
          <div>Matchs reçus&nbsp;: <strong>${d.gamesReceived||0}</strong></div>
          <div>Opportunités brutes reçues&nbsp;: <strong>${d.rawOpportunities||0}</strong></div>
          <div>Rejetées par le moteur&nbsp;: <strong>${d.rejectedByEngine||0}</strong></div>
        </div>
        <div style="margin-top:10px;font-size:12px;color:var(--mu)">Raison probable : ${esc(reason)}</div>
      </div>
    </div>`;
    return;
  }
  betproRememberScan('Benter',opps);
  _scanAllOpps = opps;

  const sPortCount = {};
  opps.forEach(o => { const s=getSportLabel(o.sport||''); sPortCount[s]=(sPortCount[s]||0)+1; });
  const statsHtml = Object.entries(sPortCount).slice(0,6).map(([s,n])=>
    `<div class="stat-cell"><div class="sv">${n}</div><label>${s}</label></div>`
  ).join('');

  const cacheInfo = cacheAge > 0 ? `<span class="bdg bca">Cache ${cacheAge}min</span>` : '';

  const diagHtml = diag && diag.bySport
    ? `<div style="background:var(--sf2);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:10px;color:var(--dm);font-family:var(--mo);line-height:1.7">
        ${Object.entries(diag.bySport).map(([sport,d]) =>
          `${sport}: ${d.displayed}/${d.raw}`
        ).join(' · ')}
      </div>`
    : '';

  const lowCountInfo = opps.length <= 3
    ? `<div class="info" style="font-size:11px;margin-bottom:10px">
        Peu de cartes affichées : le moteur ne montre que les sélections qui passent les filtres EV, edge, Kelly, stabilité et qualité des données. Les requêtes lancées ne sont pas des paris jouables.
      </div>`
    : '';

  cnt.innerHTML = `
    <div class="sbar">
      <div class="sdot"></div>
      <span><strong>${opps.length}</strong> opportunité(s) — directions claires uniquement</span>
      ${cacheInfo}
      <span style="margin-left:auto;color:var(--dm)">${fmtDT(new Date().toISOString())}</span>
    </div>
    ${diagHtml}
    ${lowCountInfo}
    <div class="scan-stats" style="grid-template-columns:repeat(auto-fill,minmax(80px,1fr));margin-bottom:14px">${statsHtml}</div>
    <div class="opp-grid">
      ${opps.map((o,i)=>renderDirectionCard(o,i,'scan-res')).join('')}
    </div>`;
  betproEnhanceScanFollow('scan-res',opps,'Benter');
}

// ═══════════════════════════════════════════════
//  DIRECTION CARD — carte avec verdict clair
// ═══════════════════════════════════════════════
function buildWhyBox(o, s, impliedProb, trueProb, evPct) {
  var reasons = [];
  var sport = (o.sport||o._sport||'').toLowerCase();
  var odds = o.odds||0;
  var market = o.market||'h2h';
  var sel = (o.selection||'').toLowerCase();
  var tot = (s&&s.total)||0;
  var bms = o.all_bookmakers||[];
  var subs = (s&&s.subscores)||{};
  var startTime = o.start_time ? new Date(o.start_time) : null;
  var now = new Date();

  if(odds>=1.40&&odds<=1.90) reasons.push("Cote de favori ("+odds+") dans une zone souvent équilibrée entre risque et rendement. Probabilité implicite "+impliedProb+"%, à confirmer avant mise.");
  else if(odds>1.90&&odds<=2.40) reasons.push("Cote équilibrée ("+odds+") : zone potentiellement intéressante. Prob. implicite "+impliedProb+"%, estimée "+trueProb+"%. À vérifier avant toute décision.");
  else if(odds>2.40&&odds<=3.50) reasons.push("Cote outsider ("+odds+") : potentiel de valeur si le marché sous-estime la sélection. EV estimé "+(evPct>=0?"+":"")+evPct+"%. Risque réel plus élevé — peut perdre malgré une EV positive.");
  else if(odds>3.50) reasons.push("Cote haute ("+odds+") : outsider marqué, risque important. Mise très prudente recommandée.");
  else if(odds<1.40) reasons.push("Favori marqué ("+odds+") : probabilité implicite "+impliedProb+"%. Gain limité en cas de victoire — mise prudente recommandée.");

  if(evPct>8) reasons.push("Valeur espérée élevée : EV +"+evPct+"% — signal statistique favorable, à confirmer par les données du match. Aucune combinaison de données ne garantit un résultat.");
  else if(evPct>3) reasons.push("EV positif ("+evPct+"%) — avantage statistique modeste sur le marché, sans certitude de gain sur ce match précis.");
  else if(evPct>0) reasons.push("EV marginalement positif (+"+evPct+"%) — potentiellement rentable sur une longue série de paris similaires, jamais garanti match par match.");
  else if(evPct<-5) reasons.push("EV négatif ("+evPct+"%) : le marché favorise le bookmaker ici.");

  if(tot>=85) reasons.push("Score élevé ("+tot+"/100) : plusieurs indicateurs convergent, mais cela ne garantit pas l'issue du match.");
  else if(tot>=75) reasons.push("Signal correct ("+tot+"/100) : convergence des indicateurs quantitatifs, au-dessus du seuil de confiance retenu par le moteur.");
  else if(tot>=65) reasons.push("Signal standard ("+tot+"/100) : marché potentiellement intéressant, à vérifier sur Pinnacle ou Piwi247 avant toute décision.");

  if(market==='h2h'&&sport.includes('soccer')) {
    reasons.push("Football 1X2 : risque du nul, seuils renforcés. Résultat final 90 min — les favoris gagnent souvent plus fréquemment en ligues majeures, mais cette tendance générale ne s'applique pas à chaque match pris isolément.");
    if(sel.includes('draw')||sel==='x') reasons.push("Pari Match Nul : résultat parfois sous-évalué par le marché, sans que cela soit garanti sur ce match.");
  }
  if(market==='totals'&&sport.includes('soccer')) reasons.push("Total buts : donnée à titre indicatif, très dépendante de la météo, du contexte et de l'enjeu du match — à confirmer avant mise.");
  if(market==='btts') reasons.push("Both Teams To Score : la probabilité varie fortement selon les compétitions et doit être vérifiée au cas par cas.");
  if(market==='spreads') reasons.push("Handicap asiatique : profil de risque différent du 1X2 classique, à évaluer selon le contexte précis du match.");
  if(market==='h2h'&&sport.includes('basket')) reasons.push("1X2 Basketball : marché liquide, pas de nul. Forme récente et avantage domicile sont des facteurs à considérer, sans certitude sur l'issue.");
  if(market==='h2h'&&(sport.includes('tennis')||sport.includes('mma'))) reasons.push("Duel individuel : marché binaire. État physique, blessures récentes et historique tête-à-tête pèsent sur l'issue, sans la déterminer.");

  if(startTime) {
    var hoursUntil = (startTime-now)/3600000;
    if(hoursUntil<2) reasons.push("Match imminent (dans "+Math.round(hoursUntil*60)+" min) : la cote peut encore évoluer — vérifier les compositions officielles annoncées.");
    else if(hoursUntil<6) reasons.push("Match dans "+Math.round(hoursUntil)+"h : surveiller les annonces de composition (H-1h) et les conditions météo locales.");
    else if(hoursUntil<24) reasons.push("Match dans "+Math.round(hoursUntil)+"h : temps suffisant pour vérifier blessures, suspensions et tendance des cotes avant de décider.");
    else reasons.push("Match dans "+Math.round(hoursUntil/24)+" jour(s) : la cote peut encore évoluer significativement d'ici le coup d'envoi.");
  }

  if(sport.includes('soccer')||sport.includes('rugby')||sport.includes('americanfootball')) {
    reasons.push("Facteur météo (football/rugby/NFL) : pluie et vent fort peuvent influencer le style de jeu — donnée à vérifier le jour J, pas un facteur déterminant à lui seul.");
  }
  if(sport.includes('tennis')) {
    reasons.push("Tennis : chaleur, vent et surface (terre/gazon/dur) peuvent influencer la performance des joueurs — à confirmer avant mise, jamais un facteur isolé décisif.");
  }

  if(bms.length>=8) reasons.push(bms.length+" bookmakers comparés : consensus de marché large, cote de référence plus fiable — cela reste un indicateur, pas une garantie.");
  else if(bms.length>=5) reasons.push(bms.length+" bookmakers comparés : consensus correct.");
  else if(bms.length>=2) reasons.push(bms.length+" bookmakers seulement : liquidité limitée, à confirmer manuellement sur Pinnacle.");

  if(subs.stability>=15) reasons.push("Stabilité des cotes élevée ("+subs.stability+"/20) : faible dispersion inter-bookmakers, signal de marché plus cohérent.");
  if(subs.consensus>=18) reasons.push("Consensus élevé ("+subs.consensus+"/20) entre bookmakers sur cette sélection.");
  if(subs.odds_value>=18) reasons.push("Valeur de cote au-dessus de la moyenne du marché ("+subs.odds_value+"/25).");

  if(tot>=75&&evPct>0) reasons.push("Signal statistique favorable : vérifier sur Piwi247 ou Pinnacle que la cote est toujours disponible avant toute décision. Peut perdre malgré une EV positive.");
  else if(tot>=65) reasons.push("Signal à surveiller : attendre confirmation (composition officielle, tendance de cote) avant de valider.");

  if(!reasons.length) reasons.push("Score "+tot+"/100. Prob. implicite "+impliedProb+"%, estimée "+trueProb+"%. EV "+(evPct>=0?"+":"")+evPct+"%. "+bms.length+" bookmakers comparés. Analyse probabiliste — aucun pari garanti.");

  return reasons.map(function(r){
    return '<div style="display:flex;gap:7px;align-items:flex-start;margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,.04)">'
      +'<span style="color:var(--gr);flex-shrink:0;font-size:13px">&#8226;</span>'
      +'<span style="font-size:11px;color:#94a3b8;line-height:1.65">'+esc(r)+'</span>'
      +'</div>';
  }).join('');
}

function translateSelection(sel, market, home, away, line) {
  sel = (sel||'').trim();
  home = home||''; away = away||'';
  const ln = line!=null ? ' '+(line>0?'+':'')+line : '';
  if(market==='h2h'){
    if(sel===home) return 'Victoire '+home;
    if(sel===away) return 'Victoire '+away;
    if(sel.toLowerCase()==='draw'||sel==='X'||sel.toLowerCase()==='nul') return 'Match nul';
  }
  if(market==='totals'){
    if(sel.toLowerCase().startsWith('over'))  return 'Plus de '+(line||sel.replace(/over/i,'').trim())+' buts/pts';
    if(sel.toLowerCase().startsWith('under')) return 'Moins de '+(line||sel.replace(/under/i,'').trim())+' buts/pts';
  }
  if(market==='btts'){
    if(sel.toLowerCase()==='yes') return 'Les deux equipes marquent (Oui)';
    if(sel.toLowerCase()==='no')  return 'Min. une equipe ne marque pas (Non)';
  }
  if(market==='spreads'){
    if(sel.includes(home)||sel.toLowerCase().includes('home')) return home+' handicap'+ln+' pts';
    if(sel.includes(away)||sel.toLowerCase().includes('away')) return away+' handicap'+ln+' pts';
    return sel+ln+' pts (Handicap)';
  }
  if(market==='double_chance'){
    if(sel==='1X') return home+' ou Match nul';
    if(sel==='X2') return 'Match nul ou '+away;
    if(sel==='12') return home+' ou '+away+' (sans nul)';
  }
  return sel+(ln?ln:'');
}

// ═══════════════════════════════════════════════════════════════════════
//  PGI BetPro — Moteur William Benter v2.0
// ═══════════════════════════════════════════════════════════════════════
function getSportDataRules(sport, market) {
  const s = (sport||'').toLowerCase();
  const m = (market||'h2h').toLowerCase();

  const defaults = {
    minBookmakers: 3, maxOddsHighProbability: 2.20, minDataQuality: 50,
    minModelProb: 0.58, minEdge: 0.035, minEV: 1.09, varianceLevel: 'medium',
    kellyMultiplier: 0.85, allowRecovery: false,
    preferredMarkets: ['h2h'], warningText: null
  };

  if(s.includes('soccer')||s.includes('football')) {
    const r = { ...defaults, varianceLevel:'high', kellyMultiplier:0.75,
      warningText:'Football : risque nul — préférer double chance ou BTTS' };
    if(m==='h2h') {
      r.minEdge=0.05; r.minModelProb=0.62; r.minBookmakers=3;
      r.maxOddsHighProbability=1.85; r.minDataQuality=55;
      r.warningText='1X2 football : le nul augmente la variance. Edge fort requis.';
    } else if(m==='btts'||m==='totals') {
      r.minEdge=0.03; r.minModelProb=0.56; r.varianceLevel='medium';
      r.kellyMultiplier=0.90; r.minDataQuality=48;
      r.preferredMarkets=['btts','totals'];
      r.warningText=null;
    } else if(m==='double_chance') {
      r.minEdge=0.025; r.minModelProb=0.70; r.minEV=1.06;
      r.varianceLevel='low'; r.kellyMultiplier=0.95;
    } else if(m==='spreads') {
      r.minEdge=0.035; r.minModelProb=0.56; r.kellyMultiplier=0.80;
    }
    return r;
  }
  if(s.includes('basket')) {
    return { ...defaults, varianceLevel:'medium-low', kellyMultiplier:0.88,
      minEdge:0.03, minModelProb:0.60, maxOddsHighProbability:2.30,
      preferredMarkets:['h2h','spreads','totals'], allowRecovery:true,
      warningText:'Basketball : attention aux absences de joueurs clés et back-to-back.'
    };
  }
  if(s.includes('tennis')) {
    return { ...defaults, varianceLevel:'medium', kellyMultiplier:0.80,
      minEdge:0.04, minModelProb:0.62, maxOddsHighProbability:2.20,
      minDataQuality:52, preferredMarkets:['h2h'],
      warningText:'Tennis : dépendant surface, blessures et forme récente.'
    };
  }
  if(s.includes('baseball')) {
    return { ...defaults, varianceLevel:'high', kellyMultiplier:0.65,
      minEdge:0.06, minModelProb:0.58, maxOddsHighProbability:2.00,
      minDataQuality:60, preferredMarkets:['h2h'],
      warningText:'Baseball : très dépendant du lanceur partant. Données insuffisantes = rejet.'
    };
  }
  if(s.includes('hockey')||s.includes('icehockey')) {
    return { ...defaults, varianceLevel:'high', kellyMultiplier:0.75,
      minEdge:0.045, minModelProb:0.58, maxOddsHighProbability:2.10,
      minDataQuality:52,
      warningText:'Hockey : variance élevée. Gardien et forme récente déterminants.'
    };
  }
  if(s.includes('mma')||s.includes('boxing')||s.includes('box')) {
    return { ...defaults, varianceLevel:'very-high', kellyMultiplier:0.45,
      minEdge:0.08, minModelProb:0.65, maxOddsHighProbability:1.80,
      minDataQuality:65, minBookmakers:3, allowRecovery:false,
      warningText:'MMA/Boxe : variance maximale. Rattrapage interdit. Mise très réduite.'
    };
  }
  if(s.includes('rugby')) {
    return { ...defaults, varianceLevel:'high', kellyMultiplier:0.72,
      minEdge:0.05, minModelProb:0.58, maxOddsHighProbability:2.10,
      minDataQuality:55,
      warningText:'Rugby : blessures et météo très impactants.'
    };
  }
  if(s.includes('american')||s.includes('nfl')) {
    return { ...defaults, varianceLevel:'high', kellyMultiplier:0.72,
      minEdge:0.05, minModelProb:0.58, maxOddsHighProbability:2.10,
      minDataQuality:55,
      warningText:'NFL : forte variance. Préférer spreads avec données suffisantes.'
    };
  }
  if(s.includes('hand')) {
    return { ...defaults, varianceLevel:'medium', kellyMultiplier:0.80,
      minEdge:0.04, minModelProb:0.60, maxOddsHighProbability:2.20,
      minDataQuality:50,
      warningText:'Handball : domicile/extérieur et niveau champion déterminants.'
    };
  }
  if(s.includes('volleyball') || s.includes('volley')) {
    // Volleyball : format en sets (au meilleur des 5), scoring proche du
    // handball en termes de variance. Prudence renforcée tant que l'app n'a
    // pas d'historique réel sur ce sport (voir SPORT_STATIC_FALLBACK).
    return { ...defaults, varianceLevel:'medium', kellyMultiplier:0.75,
      minEdge:0.045, minModelProb:0.60, maxOddsHighProbability:2.10,
      minDataQuality:52,
      warningText:'Volleyball : format en sets, forme du jour et rotation déterminants.'
    };
  }
  return defaults;
}

function estimateModelProbabilityV3(o, rules, dqs) {
  const odds   = o.odds || 0;
  if(odds <= 1) return 0;

  const subs  = o.score?.subscores || {};
  const bms   = (o.all_bookmakers||[]).length;
  const tot   = o.score?.total || 0;

  const impliedProb = 1 / odds;

  let rawAdj = 0;
  rawAdj += ((tot - 65) / 100) * 0.07;
  rawAdj += ((subs.stability||0) - 10) / 20 * 0.03;
  rawAdj += ((subs.consensus||0) - 10) / 20 * 0.026;
  rawAdj += ((subs.odds_value||0) - 12.5) / 25 * 0.03;
  rawAdj += ((subs.plausibility||0) - 10) / 20 * 0.016;

  const bmConfidence = Math.min(1, bms / 8);
  const varianceWeight = {
    'very-high': 0.55, 'high': 0.75, 'medium': 1.0, 'medium-low': 1.10, 'low': 1.20
  }[rules.varianceLevel || 'medium'] || 1.0;

  let adj = rawAdj * bmConfidence * varianceWeight;

  if(dqs < 40)       adj -= 0.045;
  else if(dqs < 55)  adj -= 0.025;
  else if(dqs < 70)  adj -= 0.010;

  if(odds > 2.50) adj -= 0.03;
  else if(odds > 2.00) adj -= 0.015;

  const isStrongFavoriteZone    = odds >= 1.25 && odds <= 1.65;
  const isVeryHighInternalScore = tot >= 82;
  const isStrongData            = dqs >= 70;
  const isStrongConsensus       = (subs.stability||0) >= 15 && (subs.consensus||0) >= 15;
  const isEnoughBookmakers      = bms >= 5;
  if(isStrongFavoriteZone && isVeryHighInternalScore && isStrongData && isStrongConsensus && isEnoughBookmakers) {
    adj += 0.035;
  }

  const maxDelta = Math.min(0.14, impliedProb * 0.40);
  const clampedAdj = Math.min(maxDelta, Math.max(-maxDelta, adj));

  let modelProb = impliedProb + clampedAdj;

  return Math.min(0.93, Math.max(0.03, modelProb));
}

function resolveBetResult(card, finalResult) {
  try {
    const mkt = (card.market||'h2h').toLowerCase();
    const sel = (card.selection||'').toLowerCase();
    const home = (card.home||'').toLowerCase();
    const away = (card.away||'').toLowerCase();
    const homeScore = finalResult.homeScore ?? finalResult.home_score;
    const awayScore = finalResult.awayScore ?? finalResult.away_score;

    if(homeScore == null || awayScore == null) return 'pending';

    const total = homeScore + awayScore;
    const homeDiff = homeScore - awayScore;

    if(mkt==='h2h'||mkt==='moneyline') {
      const homeWin = homeScore > awayScore;
      const awayWin = awayScore > homeScore;
      const isDraw  = homeScore === awayScore;
      if(sel.includes(home)||sel==='home'||sel==='1')  return homeWin?'win':'loss';
      if(sel.includes(away)||sel==='away'||sel==='2')  return awayWin?'win':'loss';
      if(sel==='draw'||sel==='x'||sel==='nul')         return isDraw?'win':'loss';
      return 'pending';
    }
    if(mkt==='btts') {
      const both = homeScore>0 && awayScore>0;
      if(sel==='yes') return both?'win':'loss';
      if(sel==='no')  return both?'loss':'win';
      return 'pending';
    }
    if(mkt==='totals') {
      const line = (card.line != null) ? parseFloat(card.line) : null;
      if(line === null || isNaN(line)) return 'pending';
      if(total > line && sel.toLowerCase().includes('over'))  return 'win';
      if(total < line && sel.toLowerCase().includes('under')) return 'win';
      if(total === line) return 'void';
      return 'loss';
    }
    if(mkt==='spreads') {
      const line = (card.line != null) ? parseFloat(card.line) : null;
      if(line === null || isNaN(line)) return 'pending';
      const adjScore = sel.includes(home) ? homeDiff + line : awayScore - homeScore + line;
      if(adjScore > 0) return 'win';
      if(adjScore === 0) return 'void';
      return 'loss';
    }
    if(mkt==='double_chance') {
      const homeWin=homeScore>awayScore, awayWin=awayScore>homeScore, isDraw=homeScore===awayScore;
      if(sel==='1x') return (homeWin||isDraw)?'win':'loss';
      if(sel==='x2') return (awayWin||isDraw)?'win':'loss';
      if(sel==='12') return (homeWin||awayWin)?'win':'loss';
      return 'pending';
    }
    return 'pending';
  } catch(e) { return 'pending'; }
}

async function updatePendingBetResults(opts) {
  const refreshUI = (opts && opts.refreshUI !== false) ? true : false;
  const allCards = histLocalLoad();
  const pending  = allCards.filter(c => normalizeCardStatus(c) === 'pending' && c.startTime);
  if(!pending.length) { toast('Aucune carte en attente','ok'); return 0; }

  const FINAL_STATUSES = ['final','finished','completed','ended'];
  const now = Date.now();
  let updated = 0;

  for(const card of pending) {
    try {
      const matchTime = new Date(card.startTime).getTime();
      if(now - matchTime < 7200000) continue;

      const res = await api(`/api/results/match?sport=${enc(card.sport)}&home=${enc(card.home)}&away=${enc(card.away)}&date=${enc(card.startTime.slice(0,10))}`);
      if(!res || !res.result) continue;

      const statusRaw = ((res.result.status || res.status || '')+'').toLowerCase();
      if(!FINAL_STATUSES.includes(statusRaw)) continue;

      const homeScore = res.result.homeScore ?? res.result.home_score;
      const awayScore = res.result.awayScore ?? res.result.away_score;
      if(homeScore == null || awayScore == null) continue;

      const result = resolveBetResult(card, res.result);
      if(result === 'pending') continue;

      await updateBetCardResult(card.id, result, res.closingOdds||null);
      updated++;
    } catch(_) {}
  }

  if(updated > 0) {
    toast(updated + ' résultat(s) mis à jour','ok');
    if(refreshUI) loadPerformances();
  } else if(refreshUI) {
    toast('Aucun résultat confirmé pour le moment','ok');
  }
  return updated;
}

async function syncLocalToCloud() {
  const local = histLocalLoad();
  if(!local.length) return;
  let synced = 0;
  for(const card of local.slice(0, 50)) {
    try {
      await histKVSave(card);
      synced++;
    } catch(_) {}
  }
  toast(`${synced} carte(s) synchronisées vers KV`,'ok');
}

function importHistoryJSON(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    const cards = Array.isArray(data) ? data : (data.cards || data.history || []);
    if(!cards.length) { toast('Aucune carte dans le fichier','err'); return; }
    const local = histLocalLoad();
    const existingIds = new Set(local.map(c=>c.id));
    let added = 0;
    cards.forEach(c => {
      if(!c.id) return;
      if(!existingIds.has(c.id)) {
        c.source = c.source || 'import_csv';
        local.unshift(c);
        added++;
      }
    });
    histLocalSave(local);
    toast(`${added} carte(s) importée(s)`,'ok');
    loadPerformances();
  } catch(e) { toast('Erreur import JSON: '+e.message,'err'); }
}

function importHistoryCSV(csvText) {
  try {
    const lines = csvText.trim().split('\n');
    if(lines.length < 2) { toast('CSV vide','err'); return; }
    const headers = lines[0].split(',').map(h=>h.replace(/"/g,'').trim());
    const local = histLocalLoad();
    const existingIds = new Set(local.map(c=>c.id));
    let added = 0;
    for(let i=1; i<lines.length; i++) {
      const vals = lines[i].split(',').map(v=>v.replace(/"/g,'').trim());
      const card = {};
      headers.forEach((h,j) => { card[h] = vals[j]||''; });
      if(!card.id) continue;
      if(existingIds.has(card.id)) continue;
      card.source = card.source || 'import_csv';
      card.odds = parseFloat(card.odds)||0;
      card.reliabilityScore = parseInt(card.reliabilityScore)||0;
      local.unshift(card);
      added++;
    }
    histLocalSave(local);
    toast(`${added} carte(s) importée(s) depuis CSV`,'ok');
    loadPerformances();
  } catch(e) { toast('Erreur import CSV: '+e.message,'err'); }
}

function triggerImportFile(type) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = type==='csv' ? '.csv,text/csv' : '.json,application/json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if(!file) return;
    const text = await file.text();
    if(type==='csv') importHistoryCSV(text);
    else importHistoryJSON(text);
  };
  input.click();
}

function getSportReliabilityRules(sport, market) {
  const s = (sport||'').toLowerCase();
  const m = (market||'h2h').toLowerCase();
  const rules = { minBM: 3, maxOdds: 3.5, minEdge: 0.04, varianceFactor: 1.0, kellyMult: 1.0 };

  if(s.includes('soccer')) {
    rules.varianceFactor = 0.9;
    if(m==='h2h') { rules.minBM=3; rules.minEdge=0.045; }
    if(m==='btts'||m==='totals') { rules.minEdge=0.03; rules.varianceFactor=0.85; }
    if(m==='spreads') { rules.minEdge=0.035; }
    if(s.includes('ligamx')||s.includes('japan')||s.includes('australia')) rules.minBM=4;
  }
  if(s.includes('basket')) {
    rules.varianceFactor = 0.85; rules.minEdge=0.035;
    if(m==='spreads'||m==='totals') { rules.varianceFactor=0.80; }
  }
  if(s.includes('tennis')) {
    rules.varianceFactor = 0.80; rules.minEdge=0.04; rules.kellyMult=0.8;
  }
  if(s.includes('mma')||s.includes('boxing')) {
    rules.varianceFactor = 0.65; rules.minEdge=0.07; rules.kellyMult=0.5; rules.maxOdds=3.0;
  }
  if(s.includes('rugby')) {
    rules.varianceFactor = 0.75; rules.minEdge=0.05; rules.minBM=3;
  }
  if(s.includes('hockey')) {
    rules.varianceFactor = 0.80; rules.minEdge=0.04;
  }
  if(s.includes('baseball')) {
    rules.varianceFactor = 0.70; rules.minEdge=0.06; rules.kellyMult=0.7;
  }
  if(s.includes('americanfootball')||s.includes('nfl')) {
    rules.varianceFactor = 0.75; rules.minEdge=0.05; rules.minBM=3;
  }
  if(s.includes('handball')) {
    rules.varianceFactor = 0.80; rules.minEdge=0.04;
  }
  if(s.includes('volleyball')) {
    // Volleyball : peu de données historiques pour l'instant sur cette app,
    // traité avec la même prudence que le handball (variance modérée).
    rules.varianceFactor = 0.78; rules.minEdge=0.045;
  }
  return rules;
}

function estimateModelProbability(o, rules) { return estimateModelProbabilityV2(o, rules, calcDataQualityScore(o)); }

function calculateKellyStake(modelProb, odds, bankroll, riskProfile, maxStakePct, sportRules) {
  bankroll = bankroll || 200;
  maxStakePct = maxStakePct || 0.03;
  if(odds <= 1 || modelProb <= 0) return 0;

  const kellyFull = ((odds - 1) * modelProb - (1 - modelProb)) / (odds - 1);
  if(kellyFull <= 0) return 0;

  const fractions = { conservateur: 0.25, modere: 0.35, agressif: 0.50 };
  const fraction  = fractions[riskProfile] || 0.25;

  const caps = { conservateur: 0.02, modere: 0.03, agressif: 0.05 };
  const cap   = Math.min(maxStakePct, caps[riskProfile] || 0.02);

  const sportMult = (sportRules && sportRules.kellyMult) || 1.0;

  let stake = bankroll * kellyFull * fraction * sportMult;
  stake = Math.min(stake, bankroll * cap);
  stake = Math.max(0, stake);

  return Math.round(stake * 2) / 2;
}

function calculateCLV(initialOdds, closingOdds) {
  if(!initialOdds || !closingOdds || closingOdds <= 1) return null;
  const clv = (initialOdds / closingOdds - 1) * 100;
  return Math.round(clv * 10) / 10;
}

// ═══════════════════════════════════════════════════════════════════
//  MÉMOIRE & APPRENTISSAGE HISTORIQUE
// ═══════════════════════════════════════════════════════════════════
function getOddsZone(odds) {
  const o = odds || 0;
  if(o >= 1.25 && o <= 1.50) return '1.25-1.50';
  if(o > 1.50 && o <= 1.80)  return '1.51-1.80';
  if(o > 1.80 && o <= 2.20)  return '1.81-2.20';
  if(o > 2.20 && o <= 2.80)  return '2.21-2.80';
  if(o > 2.80)               return '2.81+';
  return 'other';
}

function normalizeCardStatus(card) {
  const s = ((card && card.status) || '').toLowerCase();
  if(s==='win'||s==='won')   return 'win';
  if(s==='loss'||s==='lost') return 'loss';
  if(s==='void'||s==='push'||s==='refund') return 'void';
  return 'pending';
}

function getSettledCards(cards) {
  return (cards||[]).filter(c => normalizeCardStatus(c) !== 'pending');
}

function calcGroupStats(cards) {
  const settled = getSettledCards(cards);
  const won  = settled.filter(c=>normalizeCardStatus(c)==='win');
  const lost = settled.filter(c=>normalizeCardStatus(c)==='loss');
  const voided = settled.filter(c=>normalizeCardStatus(c)==='void');
  const wl = won.length + lost.length;
  const winRate = wl>0 ? Math.round(won.length/wl*1000)/10 : null;

  const wlCards = settled.filter(c => normalizeCardStatus(c)!=='void');
  const totalStake = wlCards.reduce((s,c)=>s+(c.virtualStake||VIRTUAL_STAKE),0);
  const totalGain  = wlCards.reduce((s,c)=>s+(c.virtualGain||0),0);
  const roi = totalStake>0 ? Math.round(totalGain/totalStake*1000)/10 : null;

  return { total:settled.length, won:won.length, lost:lost.length, voided:voided.length, winRate, roi, totalStake, totalGain };
}

function getSportFamily(sport) {
  const s = (sport||'').toLowerCase();
  if(s.includes('soccer'))  return 'soccer';
  if(s.includes('basket'))  return 'basketball';
  if(s.includes('tennis'))  return 'tennis';
  if(s.includes('mma')||s.includes('box')) return 'mma';
  if(s.includes('hockey'))  return 'icehockey';
  if(s.includes('rugby'))   return 'rugby';
  if(s.includes('baseball'))return 'baseball';
  if(s.includes('american')||s.includes('nfl')) return 'americanfootball';
  if(s.includes('hand'))    return 'handball';
  if(s.includes('volley'))  return 'volleyball';
  return s || 'other';
}

function filterCardsByGroup(cards, ctx, level) {
  const fam    = getSportFamily(ctx.sport);
  const market = (ctx.market||'h2h').toLowerCase();
  const zone   = getOddsZone(ctx.odds);
  return (cards||[]).filter(c => {
    if(getSportFamily(c.sport) !== fam) return false;
    if(level === 'sport') return true;
    if((c.market||'h2h').toLowerCase() !== market) return false;
    if(level === 'sport_market') return true;
    if((c.tier||'') !== (ctx.tier||'')) return false;
    if(level === 'sport_market_tier') return true;
    return getOddsZone(c.odds) === zone;
  });
}

function getHistoricalAdjustment(cards, context) {
  context = context || {};
  const levels = context.tier
    ? ['sport_market_tier_zone','sport_market_tier','sport_market','sport']
    : ['sport_market','sport'];

  let chosen = null, chosenLevel = null;
  for(const level of levels) {
    const stats = calcGroupStats(filterCardsByGroup(cards, context, level));
    if(stats.total >= 100) { chosen = stats; chosenLevel = level; break; }
    if(!chosen || level === levels[levels.length-1]) { chosen = stats; chosenLevel = level; }
  }

  const base = {
    status:'insufficient', volume: chosen?chosen.total:0, roi: chosen?chosen.roi:null,
    winRate: chosen?chosen.winRate:null, confidence:'low',
    scoreAdjustment:0, edgeAdjustment:0, evAdjustment:0, dqsAdjustment:0,
    reason:'Historique insuffisant pour ajuster les seuils (minimum 100 cartes réglées requis).'
  };
  if(!chosen || chosen.total < 100) return base;

  const vol = chosen.total, roi = chosen.roi, wr = chosen.winRate;
  const confidence = vol>=1000?'very-high':vol>=500?'high':'medium';
  let status='neutral', scoreAdj=0, edgeAdj=0, evAdj=0, dqsAdj=0;
  let reason = `Historique (${chosenLevel}) : ${vol} cartes réglées, ROI ${roi!==null?roi+'%':'—'}.`;

  if(vol < 500) {
    if(roi!==null && roi>5)       { status='positive'; scoreAdj=1;   edgeAdj=-0.002; evAdj=-0.005; dqsAdj=-1; reason+=' Tendance prudente — assouplissement très léger.'; }
    else if(roi!==null && roi<-5) { status='negative'; scoreAdj=-1;  edgeAdj=0.003;  evAdj=0.005;  dqsAdj=1;  reason+=' Tendance prudente — durcissement léger.'; }
  } else if(vol < 1000) {
    if(roi!==null && roi>10)       { status='positive'; scoreAdj=4;   edgeAdj=-0.006; evAdj=-0.012; dqsAdj=-4; reason+=' Historique fiable et positif.'; }
    else if(roi!==null && roi>5)   { status='positive'; scoreAdj=2;   edgeAdj=-0.004; evAdj=-0.008; dqsAdj=-2; }
    else if(roi!==null && roi<-15) { status='blocked';  scoreAdj=-15; edgeAdj=0.02;   evAdj=0.04;   dqsAdj=10; reason+=' ROI très négatif — combinaison rejetée sauf signal exceptionnel.'; }
    else if(roi!==null && roi<-10) { status='negative'; scoreAdj=-8;  edgeAdj=0.012;  evAdj=0.02;   dqsAdj=6;  reason+=' Forte pénalité — seuils durcis.'; }
    else if(roi!==null && roi<-5)  { status='negative'; scoreAdj=-4;  edgeAdj=0.006;  evAdj=0.012;  dqsAdj=3; }
  } else {
    if(roi!==null && roi>10)       { status='positive'; scoreAdj=6;   edgeAdj=-0.008; evAdj=-0.015; dqsAdj=-6; reason+=' Historique très solide et positif.'; }
    else if(roi!==null && roi>5)   { status='positive'; scoreAdj=3;   edgeAdj=-0.005; evAdj=-0.01;  dqsAdj=-3; }
    else if(roi!==null && roi<-15) { status='blocked';  scoreAdj=-18; edgeAdj=0.025;  evAdj=0.045;  dqsAdj=12; reason+=' ROI très négatif sur large historique — rejet sauf sélection exceptionnellement forte.'; }
    else if(roi!==null && roi<-10) { status='negative'; scoreAdj=-10; edgeAdj=0.015;  evAdj=0.025;  dqsAdj=8; }
    else if(roi!==null && roi<-5)  { status='negative'; scoreAdj=-5;  edgeAdj=0.008;  evAdj=0.015;  dqsAdj=4; }
  }
  return { status, volume:vol, roi, winRate:wr, confidence, scoreAdjustment:scoreAdj, edgeAdjustment:edgeAdj, evAdjustment:evAdj, dqsAdjustment:dqsAdj, reason };
}

function applyHistoricalAdjustmentToThresholds(cfg, adj) {
  const out = Object.assign({}, cfg);
  if(!adj || adj.status==='insufficient') return out;
  out.edgeMin = Math.max(0.015, (out.edgeMin||0) + (adj.edgeAdjustment||0));
  out.evMin   = Math.max(1.02,  (out.evMin||0)  + (adj.evAdjustment||0));
  out.dqsMin  = Math.max(30,    (out.dqsMin!=null?out.dqsMin:40) + (adj.dqsAdjustment||0));
  return out;
}

function valueBetEngine(o, options) { return valueBetEngineV2(o, options); }

function calcDataQualityScore(o) {
  const bms   = (o.all_bookmakers||[]).length;
  const subs  = o.score?.subscores || {};
  const stab  = (subs.stability||0)/20;
  const cons  = (subs.consensus||0)/20;
  const tot   = o.score?.total || 0;

  let dq = 50;
  if(bms >= 8)      dq += 25;
  else if(bms >= 5) dq += 18;
  else if(bms >= 3) dq += 10;
  else if(bms >= 2) dq += 4;
  else              dq -= 20;

  dq += Math.round(stab * 15);
  dq += Math.round(cons * 10);

  if(tot >= 80) dq += 5;
  else if(tot >= 70) dq += 2;
  else if(tot < 55) dq -= 8;

  return Math.min(100, Math.max(0, dq));
}

function estimateModelProbabilityV2(o, rules, dqs) {
  const odds   = o.odds || 0;
  if(odds <= 1) return 0;

  const subs  = o.score?.subscores || {};
  const bms   = (o.all_bookmakers||[]).length;
  const tot   = o.score?.total || 0;
  const sport = (o.sport||o._sport||'').toLowerCase();
  const market= (o.market||'h2h').toLowerCase();

  const sportBasePrior = {
    soccer_h2h: 0.43, soccer_totals: 0.55, soccer_btts: 0.50, soccer_spreads: 0.52,
    basketball_h2h: 0.60, basketball_spreads: 0.52, basketball_totals: 0.54,
    tennis_h2h: 0.62, mma_h2h: 0.58, boxing_h2h: 0.58, icehockey_h2h: 0.52,
    baseball_h2h: 0.54, americanfootball_h2h: 0.56, rugby_h2h: 0.55, handball_h2h: 0.58,
    volleyball_h2h: 0.60,
  };
  const sportKey = sport.includes('soccer') ? `soccer_${market}`
    : sport.includes('basket') ? `basketball_${market}`
    : sport.includes('tennis') ? 'tennis_h2h'
    : sport.includes('mma')    ? 'mma_h2h'
    : sport.includes('boxing') ? 'boxing_h2h'
    : sport.includes('hockey') ? 'icehockey_h2h'
    : sport.includes('base')   ? 'baseball_h2h'
    : sport.includes('american')||sport.includes('nfl') ? 'americanfootball_h2h'
    : sport.includes('rugby')  ? 'rugby_h2h'
    : sport.includes('hand')   ? 'handball_h2h'
    : sport.includes('volley') ? 'volleyball_h2h'
    : 'soccer_h2h';
  const prior = sportBasePrior[sportKey] || 0.52;

  let adjustment = 0;
  const scoreAdj = ((tot - 65) / 100) * 0.06;
  adjustment += scoreAdj;
  const stab = (subs.stability||0)/20;
  adjustment += stab * 0.025;
  const cons = (subs.consensus||0)/20;
  adjustment += cons * 0.020;
  const bmAdj = Math.min(0.02, bms * 0.002);
  adjustment += bmAdj;
  if(dqs < 40)       adjustment -= 0.04;
  else if(dqs < 55)  adjustment -= 0.02;
  const variance = rules.varianceFactor || 1.0;
  adjustment -= (1 - variance) * 0.03;

  let modelProb = prior + adjustment;
  modelProb = Math.min(0.93, Math.max(0.05, modelProb));
  return modelProb;
}

function getSportRiskAdjustment(sport, market, dqs) {
  const s = (sport||'').toLowerCase();
  const m = (market||'h2h').toLowerCase();
  let riskMultiplier = 1.0;
  let maxOddsHP = 2.50;

  if(s.includes('mma')||s.includes('boxing')) {
    riskMultiplier = 0.55; maxOddsHP = 1.80;
  } else if(s.includes('tennis')) {
    riskMultiplier = 0.80; maxOddsHP = 2.20;
  } else if(s.includes('basket')) {
    riskMultiplier = m==='h2h' ? 0.85 : 0.78; maxOddsHP = 2.30;
  } else if(s.includes('soccer')) {
    riskMultiplier = m==='h2h' ? 0.78 : 0.88;
    maxOddsHP = m==='h2h' ? 2.00 : 2.40;
  } else if(s.includes('hockey')) {
    riskMultiplier = 0.80; maxOddsHP = 2.20;
  } else if(s.includes('base')) {
    riskMultiplier = 0.72; maxOddsHP = 2.10;
  } else if(s.includes('american')||s.includes('nfl')) {
    riskMultiplier = 0.78; maxOddsHP = 2.20;
  } else if(s.includes('rugby')) {
    riskMultiplier = 0.76; maxOddsHP = 2.30;
  } else if(s.includes('hand')) {
    riskMultiplier = 0.82; maxOddsHP = 2.30;
  } else if(s.includes('volleyball') || s.includes('volley')) {
    riskMultiplier = 0.76; maxOddsHP = 2.10;
  }

  if(dqs < 50) riskMultiplier *= 0.85;

  return { riskMultiplier, maxOddsHP };
}

function computeDisplayConfidence(tier, rs) {
  const clamp01 = t => Math.max(0, Math.min(1, t));
  if(tier === 'premium') {
    const t = clamp01((rs - 88) / (100 - 88));
    return Math.round(85 + t * 13);
  }
  if(tier === 'solid') {
    const t = clamp01((rs - 78) / (88 - 78));
    return Math.round(68 + t * 17);
  }
  const t = clamp01((rs - 55) / (78 - 55));
  return Math.round(55 + t * 13);
}

function valueBetEngineV2(o, options) {
  options = options || {};
  const mode        = options.mode || 'standard';
  const bankroll     = options.bankroll || 200;
  const riskProfile  = options.riskProfile || 'conservateur';

  const odds   = o.odds || 0;
  const sport  = (o.sport||o._sport||'').toLowerCase();
  const market = (o.market||'h2h').toLowerCase();
  const bms    = o.all_bookmakers || [];
  const tot    = o.score?.total || 0;

  let dqs = 0, impliedProb = 0, modelProb = 0, edgeProb = 0, evSimple = 0, evNet = 0, evPct = 0;
  let carriedHistAdj = null;

  const REJECT = (reason, extraWarn) => ({
    direction:'avoid', shouldDisplay:false, tier:'none', tierLabel:'', tierColor:'',
    reliabilityScore:0, displayConf:0, confScore:0,
    impliedProb, modelProb, edgeProb, evSimple, evNet, evPct,
    kellyFull:0, kellyFraction:0, stakeRecommended:0,
    dataQualityScore: dqs, historicalAdjustment: carriedHistAdj,
    decision:'reject', warning: extraWarn||reason, reason,
    disclaimer: 'Analyse probabiliste — aucun pari garanti.', mode
  });

  if(!odds || odds <= 1) return REJECT('Cote invalide');
  if(odds < 1.25)        return REJECT('Cote trop courte (<1.25)');

  dqs = calcDataQualityScore(o);
  const rules   = (typeof getSportDataRules==='function') ? getSportDataRules(sport,market) : getSportReliabilityRules(sport,market);
  const riskAdj = getSportRiskAdjustment(sport, market, dqs);

  let cfg = {
    prudent:  { evMin:1.07, edgeMin:0.025, oddsMax:riskAdj.maxOddsHP,      scoreMin:68, bmMin:2, probMin:0.53, dqsMin:35 },
    standard: { evMin:1.04, edgeMin:0.015, oddsMax:riskAdj.maxOddsHP*1.15, scoreMin:62, bmMin:2, probMin:0.50, dqsMin:30 },
    expert:   { evMin:1.02, edgeMin:0.010, oddsMax:riskAdj.maxOddsHP*1.30, scoreMin:58, bmMin:1, probMin:0.48, dqsMin:25 },
  }[mode] || { evMin:1.04, edgeMin:0.015, oddsMax:2.80, scoreMin:62, bmMin:2, probMin:0.50, dqsMin:30 };

  if(odds > cfg.oddsMax) return REJECT(`Cote trop haute (${odds} > ${cfg.oddsMax.toFixed(2)}) pour mode haute probabilité`);

  impliedProb = 1 / odds;
  modelProb   = (typeof estimateModelProbabilityV3==='function') ? estimateModelProbabilityV3(o, rules, dqs) : estimateModelProbabilityV2(o, rules, dqs);

  const histCardsAll = (typeof histLocalLoad==='function') ? histLocalLoad() : [];
  const preHistAdj = getHistoricalAdjustment(histCardsAll, {
    sport, market, tier:null, odds, modelProb, edgeProb:null, evSimple:null, dataQualityScore:dqs
  });
  carriedHistAdj = preHistAdj;
  cfg = applyHistoricalAdjustmentToThresholds(cfg, preHistAdj);

  if(modelProb < cfg.probMin) return REJECT(`Probabilité modèle trop faible: ${(modelProb*100).toFixed(1)}% < ${(cfg.probMin*100).toFixed(0)}%`);

  edgeProb = modelProb - impliedProb;
  if(edgeProb < cfg.edgeMin) return REJECT(`Avantage insuffisant : ${(edgeProb*100).toFixed(1)}% < ${(cfg.edgeMin*100).toFixed(1)}% requis`);

  evSimple = modelProb * odds;
  evNet    = (modelProb * (odds - 1)) - (1 - modelProb);
  evPct    = Math.round(evNet * 100);
  if(evSimple < cfg.evMin) return REJECT(`Valeur attendue insuffisante : ${evSimple.toFixed(3)} < ${cfg.evMin.toFixed(3)} requis`);

  if(bms.length < cfg.bmMin) return REJECT(`Opérateurs insuffisants : ${bms.length} < ${cfg.bmMin}`);
  if(dqs < cfg.dqsMin) return REJECT(`Qualité de données insuffisante: ${dqs} < ${cfg.dqsMin}`);

  const kellyFull = Math.max(0, ((odds - 1)*modelProb - (1 - modelProb)) / (odds - 1));
  if(kellyFull <= 0) return REJECT('Kelly négatif');
  const kellyFractions = { conservateur:0.25, modere:0.35, agressif:0.50 };
  const kellyFraction  = kellyFractions[riskProfile] || 0.25;
  const stakeRaw = bankroll * kellyFull * kellyFraction * riskAdj.riskMultiplier;
  const caps = { conservateur:0.02, modere:0.03, agressif:0.05 };
  let stakeRecommended = Math.round(Math.min(stakeRaw, bankroll*(caps[riskProfile]||0.02)) * 2) / 2;

  const subs = o.score?.subscores || {};
  const edgePctFromFraction = edgeProb * 100;
  function computeReliability(edgePctVal) {
    let rs = tot * 0.40;
    rs += modelProb * 100 * 0.25;
    if(edgePctVal >= 8)      rs += 12;
    else if(edgePctVal >= 6) rs += 8;
    else if(edgePctVal >= 4) rs += 5;
    else if(edgePctVal >= 3) rs += 2;
    if(evSimple >= 1.18)      rs += 8;
    else if(evSimple >= 1.14) rs += 5;
    else if(evSimple >= 1.10) rs += 2;
    if(bms.length >= 8)      rs += 6;
    else if(bms.length >= 5) rs += 4;
    else if(bms.length >= 3) rs += 2;
    rs += (dqs / 100) * 8;
    rs += ((subs.stability||0)/20) * 5;
    rs -= (1 - riskAdj.riskMultiplier) * 12;
    if(odds > 2.00) rs -= 5;
    if(odds > 2.50) rs -= 5;
    return rs;
  }
  let reliabilityScore = computeReliability(edgePctFromFraction) + (preHistAdj.scoreAdjustment||0);
  reliabilityScore = Math.min(100, Math.max(0, Math.round(reliabilityScore)));

  if(reliabilityScore < cfg.scoreMin) return REJECT(`Score insuffisant: ${reliabilityScore} < ${cfg.scoreMin}`);

  function determineTier(rs) {
    const isPremium = rs >= 88 && evSimple >= 1.12 && edgePctFromFraction >= 4.5
      && modelProb >= 0.64 && odds >= 1.25 && odds <= 2.10 && dqs >= 60 && bms.length >= 3;
    const isSolid = rs >= 78 && evSimple >= 1.08 && edgePctFromFraction >= 3.0
      && modelProb >= 0.58 && odds <= 2.50 && dqs >= 50 && bms.length >= 2;
    if(isPremium) {
      return { tier:'premium', tierLabel:'TRÈS FORTE', tierColor:'var(--gr)',
        displayConf: computeDisplayConfidence('premium', rs) };
    }
    if(isSolid) {
      return { tier:'solid', tierLabel:'TRÈS SOLIDE', tierColor:'var(--am)',
        displayConf: computeDisplayConfidence('solid', rs) };
    }
    return { tier:'basic', tierLabel:'SOLIDE', tierColor:'var(--neon)',
      displayConf: computeDisplayConfidence('basic', rs) };
  }
  let tierInfo = determineTier(reliabilityScore);

  let fullHistAdj = getHistoricalAdjustment(histCardsAll, {
    sport, market, tier:tierInfo.tier, odds, modelProb, edgeProb:edgePctFromFraction, evSimple, dataQualityScore:dqs
  });
  carriedHistAdj = fullHistAdj;

  if(fullHistAdj.status === 'blocked') {
    const exceptional = tierInfo.tier==='premium' && evSimple>=1.20 && edgePctFromFraction>=7 && dqs>=75 && reliabilityScore>=92;
    if(!exceptional) {
      return REJECT('Historique négatif sur cette combinaison sport/marché/tier/cote — carte rejetée par prudence.', fullHistAdj.reason);
    }
  } else if(fullHistAdj.status === 'negative') {
    const cfg2 = applyHistoricalAdjustmentToThresholds(cfg, fullHistAdj);
    if(edgeProb < cfg2.edgeMin) return REJECT(`Avantage insuffisant après durcissement historique : ${(edgeProb*100).toFixed(1)}% < ${(cfg2.edgeMin*100).toFixed(1)}%`, fullHistAdj.reason);
    if(evSimple < cfg2.evMin)   return REJECT(`Valeur attendue insuffisante après durcissement historique : ${evSimple.toFixed(3)} < ${cfg2.evMin.toFixed(3)}`, fullHistAdj.reason);
    if(dqs < cfg2.dqsMin)       return REJECT(`Données insuffisantes après durcissement historique: ${dqs} < ${cfg2.dqsMin}`, fullHistAdj.reason);

    reliabilityScore = Math.max(0, reliabilityScore + (fullHistAdj.scoreAdjustment||0));
    if(reliabilityScore < cfg.scoreMin) return REJECT(`Score insuffisant après durcissement historique: ${reliabilityScore} < ${cfg.scoreMin}`, fullHistAdj.reason);

    tierInfo = determineTier(reliabilityScore);
  }

  let sportHistAdj = null;
  if (typeof getHistoricalSportAdjustment === 'function') {
    try {
      sportHistAdj = getHistoricalSportAdjustment({
        sport, competition: o.competition || o.sport_title || '',
        market, bookmaker: o.bookmaker || '',
        team: o.home_team || o.away_team || '',
      });
    } catch (_) { sportHistAdj = null; }
  }
  if (sportHistAdj && sportHistAdj.scoreAdjustment) {
    reliabilityScore = Math.max(0, Math.min(100, reliabilityScore + sportHistAdj.scoreAdjustment));
    if (reliabilityScore < cfg.scoreMin) {
      return REJECT(`Score insuffisant après ajustement sportif avancé: ${reliabilityScore} < ${cfg.scoreMin}`, sportHistAdj.reason);
    }
    tierInfo = determineTier(reliabilityScore);
  }

  const { tier, tierLabel, tierColor, displayConf } = tierInfo;

  const warns = [];
  if(dqs < 55)                 warns.push('Données limitées — confirmer sur Pinnacle');
  if(riskAdj.riskMultiplier < 0.75) warns.push('Sport à variance élevée — mise réduite');
  if(odds > 1.90)              warns.push('Cote outsider — risque accru');
  if(bms.length < 4)           warns.push('Peu de bookmakers');
  if(sport.includes('mma')||sport.includes('box')) warns.push('MMA/Boxe : variance maximale');
  if(fullHistAdj.status === 'negative') warns.push('Historique récent défavorable sur cette combinaison — seuils durcis');
  if(fullHistAdj.status === 'blocked')  warns.push('Historique négatif sur cette combinaison — carte exceptionnelle retenue avec prudence renforcée');
  if(sportHistAdj && sportHistAdj.status === 'negative') warns.push('Historique sportif avancé défavorable sur cette combinaison précise');

  const reason = `Prob. modèle ${(modelProb*100).toFixed(1)}% contre prob. implicite ${(impliedProb*100).toFixed(1)}% — avantage +${(edgeProb*100).toFixed(1)}% — valeur attendue ${evSimple.toFixed(3)} — qualité des données : ${dqs}%`;
  const disclaimer = 'Carte retenue car les critères de probabilité, valeur, stabilité et risque sont alignés à ce jour. Analyse probabiliste — aucun pari garanti, une valeur attendue positive peut tout de même perdre.';

  return {
    direction:'play', shouldDisplay:true, tier, tierLabel, tierColor,
    reliabilityScore, displayConf, confScore:reliabilityScore,
    impliedProb: Math.round(impliedProb*1000)/10,
    modelProb:   Math.round(modelProb*1000)/10,
    edgeProb:    Math.round(edgeProb*1000)/10,
    evSimple:    Math.round(evSimple*1000)/1000,
    evNet:       Math.round(evNet*1000)/1000,
    evPct,
    kellyFull:   Math.round(kellyFull*1000)/10,
    kellyFraction: Math.round(kellyFraction*100),
    stakeRecommended, dataQualityScore: dqs,
    historicalAdjustment: fullHistAdj,
    sportHistoricalAdjustment: sportHistAdj || null,
    decision:'value_bet', warning: warns.join(' · ')||null,
    reason, disclaimer, mode
  };
}

function computeDirection(o, options) {
  const opts = options || { mode: 'standard', bankroll: 200, riskProfile: 'conservateur' };
  const result = (typeof valueBetEngineV2 === 'function') ? valueBetEngineV2(o, opts) : valueBetEngine(o, opts);

  if(!result.shouldDisplay) {
    return {
      direction: 'avoid', shouldDisplay: false,
      tier: 'none', tierLabel: '', tierColor: '',
      reliabilityScore: 0, displayConf: 0, confScore: 0,
      impliedProb: result.impliedProb || 0,
      modelProb: result.modelProb || 0,
      edgeProb: result.edgeProb || 0,
      evSimple: result.evSimple || 0,
      evNet: result.evNet || 0,
      evPct: result.evPct || 0,
      kellyFull: 0, kellyFraction: 0, stakeRecommended: 0,
      dataQualityScore: result.dataQualityScore||0,
      historicalAdjustment: result.historicalAdjustment||null,
      sportHistoricalAdjustment: result.sportHistoricalAdjustment || null,
      decision: 'reject',
      warning: result.warning || null,
      reason: result.reason || 'Critères insuffisants',
      disclaimer: result.disclaimer || 'Analyse probabiliste — aucun pari garanti.',
      trueProb: result.modelProb || 0,
      ev: result.evNet || 0,
    };
  }

  return {
    direction: 'play', shouldDisplay: true,
    tier: result.tier, tierLabel: result.tierLabel, tierColor: result.tierColor,
    reliabilityScore: result.reliabilityScore, displayConf: result.displayConf, confScore: result.reliabilityScore,
    impliedProb: result.impliedProb, modelProb: result.modelProb, edgeProb: result.edgeProb,
    evSimple: result.evSimple, evNet: result.evNet, evPct: result.evPct,
    kellyFull: result.kellyFull, kellyFraction: result.kellyFraction, stakeRecommended: result.stakeRecommended,
    dataQualityScore: result.dataQualityScore||0,
    historicalAdjustment: result.historicalAdjustment||null,
    sportHistoricalAdjustment: result.sportHistoricalAdjustment || null,
    decision: 'value_bet', warning: result.warning || null, reason: result.reason,
    disclaimer: result.disclaimer || 'Analyse probabiliste — aucun pari garanti.',
    trueProb: result.modelProb, ev: result.evNet,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Historique & Performance (KV + localStorage) — MÉMOIRE DES CARTES
// ═══════════════════════════════════════════════════════════════════
const HIST_KEY   = 'pgi_bet_history_v1';
const HIST_IDX   = 'pgi_bet_index_v1';
const VIRTUAL_STAKE = 10;

function makeBetCardId(o, det) {
  const s  = (o.sport||o._sport||'').slice(0,12).replace(/[^a-z0-9]/gi,'');
  const h  = (o.home_team||'').slice(0,10).replace(/[^a-z0-9]/gi,'');
  const a  = (o.away_team||'').slice(0,10).replace(/[^a-z0-9]/gi,'');
  const mk = (o.market||'').slice(0,8).replace(/[^a-z0-9]/gi,'');
  const sl = (o.selection||'').slice(0,10).replace(/[^a-z0-9]/gi,'');
  const ln = o.line!=null?String(o.line).replace(/[^0-9.]/g,''):'';
  const md = (o.start_time||o.commence_time||det||new Date().toISOString()).slice(0,10);
  return (s+'_'+h+'_'+a+'_'+mk+'_'+sl+(ln?'_'+ln:'')+'_'+md).toLowerCase();
}

function histLocalLoad() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)||'[]'); } catch(_) { return []; }
}
function histLocalSave(arr) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(arr)); } catch(_) {}
}

async function histKVSave(card) {
  try { await api('/api/history/add', 'POST', { card }); return true; } catch(_) { return false; }
}
async function histKVUpdate(cardId, fields) {
  try { await api('/api/history/update', 'POST', { id: cardId, fields }); return true; } catch(_) { return false; }
}
async function histKVDelete(cardId) {
  try { await api('/api/history/delete', 'POST', { id: cardId }); return true; } catch(_) { return false; }
}
async function histKVLoad(filters) {
  try {
    const qs = filters ? '?'+Object.entries(filters).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&') : '';
    const result = await api('/api/history/list'+qs);
    return {
      cards: result.cards || result.history || result.entries || [],
      total: result.total || 0,
      limit: result.limit ?? (filters && filters.limit) ?? null,
      offset: result.offset ?? (filters && filters.offset) ?? 0,
      nextOffset: (result.next_offset !== undefined ? result.next_offset : result.nextOffset) ?? null,
      has_more: result.has_more ?? null,
    };
  } catch(_) { return { cards:[], total:0, limit:null, offset:0, nextOffset:null, has_more:null }; }
}

async function histKVLoadAll(filters) {
  let all = [];
  let offset = 0;
  let pagesLoaded = 0;
  const limit = 500;

  while (pagesLoaded < 50) {
    const page = await histKVLoad({ ...(filters||{}), limit, offset });
    const cards = page.cards || [];
    all.push(...cards);
    pagesLoaded++;

    if (!cards.length) break;
    if (page.has_more === false) break;
    if (page.nextOffset == null && cards.length < limit) break;

    offset = page.nextOffset != null ? page.nextOffset : offset + limit;
  }

  return { cards: all, total: all.length, pagesLoaded };
}

async function saveBetCard(o, engineResult, options) {
  const now = new Date().toISOString();
  const cardId = makeBetCardId(o, now);
  const local = histLocalLoad();
  const existingIndex = local.findIndex(c => c.id === cardId);

  if(existingIndex >= 0) {
    const existing = local[existingIndex];
    const newOdds = o.odds || 0;
    if(newOdds && newOdds !== (existing.latestOdds||existing.odds||0)) {
      existing.latestOdds = newOdds;
      existing.bestOdds   = Math.max(existing.bestOdds||existing.odds||0, newOdds);
      existing.oddsHistory = existing.oddsHistory || [{odds:existing.odds||0, at:existing.detectedAt, bookmaker:existing.bookmaker||''}];
      existing.oddsHistory.push({ odds:newOdds, at:now, bookmaker:o.bookmaker||'' });
      existing.oddsHistory = existing.oddsHistory.slice(-20);
      local[existingIndex] = existing;
      histLocalSave(local);
      histKVUpdate(cardId, existing).catch(()=>{});
    }
    return cardId;
  }

  const card = {
    id: cardId, detectedAt: now,
    sport: o.sport||o._sport||'', competition: o.competition||o.sport_title||'',
    home: o.home_team||'', away: o.away_team||'',
    market: o.market||'', selection: o.selection||'', line: o.line!=null?o.line:null,
    odds: o.odds||0, initialOdds: o.odds||0, latestOdds: o.odds||0, bestOdds: o.odds||0,
    oddsHistory: [{ odds:o.odds||0, at:now, bookmaker:o.bookmaker||'' }],
    bookmaker: o.bookmaker||'',
    tier: engineResult.tier||'', tierLabel: engineResult.tierLabel||'',
    reliabilityScore: engineResult.reliabilityScore||0, displayConf: engineResult.displayConf||0,
    impliedProb: engineResult.impliedProb||0, modelProb: engineResult.modelProb||0, edgeProb: engineResult.edgeProb||0,
    evSimple: engineResult.evSimple||0, evNet: engineResult.evNet||0, evPct: engineResult.evPct||0,
    kellyFull: engineResult.kellyFull||0, kellyFraction: engineResult.kellyFraction||0,
    stakeRecommended: engineResult.stakeRecommended||0, dataQualityScore: engineResult.dataQualityScore||0,
    virtualStake: VIRTUAL_STAKE,
    status: 'pending',
    virtualGain: null, virtualROI: null, resolvedAt: null,
    closingOdds: null, closingLineValue: null,
    userPlayed: false, userStake: null, userResult: null,
    startTime: o.start_time||o.commence_time||null,
    mode: engineResult.mode||'standard',
    reason: engineResult.reason||'',
    source: (options&&options.source) || 'moteur_reel',
  };

  try {
    if(typeof saveSportMatchHistory === 'function') {
      card.sportHistoryId = saveSportMatchHistory({
        sport: card.sport, competition: card.competition,
        home: card.home, away: card.away,
        market: card.market, selection: card.selection,
        odds: card.odds, bookmaker: card.bookmaker,
        startTime: card.startTime, source: card.source,
      });
    }
  } catch(_) { card.sportHistoryId = card.sportHistoryId || null; }

  local.unshift(card);
  if(local.length > 5000) local.splice(5000);
  histLocalSave(local);
  histKVSave(card).catch(()=>{});

  return cardId;
}

async function updateBetCardResult(cardId, result, closingOdds) {
  const local = histLocalLoad();
  const idx   = local.findIndex(c => c.id === cardId);
  if(idx < 0) return;

  const card  = local[idx];
  const stake = card.virtualStake || VIRTUAL_STAKE;
  card.status = result;
  card.resolvedAt = new Date().toISOString();
  if(result === 'win') {
    card.virtualGain = Math.round((stake * card.odds - stake)*100)/100;
    card.virtualROI  = Math.round((card.virtualGain / stake)*1000)/10;
  } else if(result === 'loss') {
    card.virtualGain = -stake;
    card.virtualROI  = -100;
  } else {
    card.virtualGain = 0;
    card.virtualROI  = 0;
  }
  if(closingOdds) {
    card.closingOdds      = closingOdds;
    card.closingLineValue = calculateCLV(card.odds, closingOdds);
  }

  if(card.sportHistoryId && typeof updateSportMatchResult === 'function') {
    try {
      updateSportMatchResult(card.sportHistoryId, {
        status: result,
        finalScore: card.finalScore || null,
        closingOdds: closingOdds || card.closingOdds || null,
      });
    } catch(_) {}
  }

  local[idx] = card;
  histLocalSave(local);
  histKVUpdate(cardId, card).catch(()=>{});
}

function calcHistStats(cards, period) {
  const now = Date.now();
  const periodMs = { today:86400000, '7d':604800000, '30d':2592000000, '90d':7776000000, all:Infinity };

  let filtered = cards;
  if(period && period !== 'all' && period !== 'custom') {
    const ms = periodMs[period] || Infinity;
    filtered = cards.filter(c => now - new Date(c.detectedAt).getTime() <= ms);
  }

  const settled = getSettledCards(filtered);
  const won  = settled.filter(c=>normalizeCardStatus(c)==='win');
  const lost = settled.filter(c=>normalizeCardStatus(c)==='loss');
  const voided = settled.filter(c=>normalizeCardStatus(c)==='void');
  const wl = won.length + lost.length;

  const wlCards = settled.filter(c=>normalizeCardStatus(c)!=='void');
  const totalVStake = wlCards.reduce((s,c)=>s+(c.virtualStake||VIRTUAL_STAKE),0);
  const totalVGain  = wlCards.reduce((s,c)=>s+(c.virtualGain||0),0);
  const roi = totalVStake>0 ? Math.round(totalVGain/totalVStake*1000)/10 : null;
  const winRate = wl>0 ? Math.round(won.length/wl*1000)/10 : null;

  let maxWin=0,curWin=0,maxLoss=0,curLoss=0;
  [...settled].sort((a,b)=>new Date(a.detectedAt)-new Date(b.detectedAt)).forEach(c=>{
    const st = normalizeCardStatus(c);
    if(st==='win'){curWin++;maxWin=Math.max(maxWin,curWin);curLoss=0;}
    else if(st==='loss'){curLoss++;maxLoss=Math.max(maxLoss,curLoss);curWin=0;}
    else{curWin=0;curLoss=0;}
  });

  const byTier = {};
  ['premium','solid','basic'].forEach(t=>{
    const g = calcGroupStats(settled.filter(c=>c.tier===t));
    byTier[t] = { total:g.total, won:g.won, winRate:g.winRate, roi:g.roi, reliable:g.total>=100 };
  });

  const fams = [...new Set(settled.map(c=>getSportFamily(c.sport)))];
  const bySport = fams.map(fam=>{
    const g = calcGroupStats(settled.filter(c=>getSportFamily(c.sport)===fam));
    return { sport:fam, total:g.total, won:g.won, winRate:g.winRate, roi:g.roi, reliable:g.total>=100 };
  }).sort((a,b)=>(b.roi??-999)-(a.roi??-999));

  const mkts = [...new Set(settled.map(c=>(c.market||'h2h').toLowerCase()))];
  const byMarket = mkts.map(mk=>{
    const g = calcGroupStats(settled.filter(c=>(c.market||'h2h').toLowerCase()===mk));
    return { market:mk, total:g.total, won:g.won, winRate:g.winRate, roi:g.roi, reliable:g.total>=100 };
  }).sort((a,b)=>(b.roi??-999)-(a.roi??-999));

  const zones = ['1.25-1.50','1.51-1.80','1.81-2.20','2.21-2.80','2.81+'];
  const byOddsZone = zones.map(z=>{
    const g = calcGroupStats(settled.filter(c=>getOddsZone(c.odds)===z));
    return { zone:z, total:g.total, won:g.won, winRate:g.winRate, roi:g.roi, reliable:g.total>=100 };
  });

  const smKeys = [...new Set(settled.map(c=>getSportFamily(c.sport)+'|'+(c.market||'h2h').toLowerCase()))];
  const bySportMarket = smKeys.map(k=>{
    const [fam,mk]=k.split('|');
    const g = calcGroupStats(settled.filter(c=>getSportFamily(c.sport)===fam && (c.market||'h2h').toLowerCase()===mk));
    return { sport:fam, market:mk, total:g.total, won:g.won, winRate:g.winRate, roi:g.roi, reliable:g.total>=100 };
  });

  const smtKeys = [...new Set(settled.map(c=>getSportFamily(c.sport)+'|'+(c.market||'h2h').toLowerCase()+'|'+(c.tier||'')))];
  const bySportMarketTier = smtKeys.map(k=>{
    const [fam,mk,tier]=k.split('|');
    const g = calcGroupStats(settled.filter(c=>getSportFamily(c.sport)===fam && (c.market||'h2h').toLowerCase()===mk && (c.tier||'')===tier));
    return { sport:fam, market:mk, tier, total:g.total, won:g.won, winRate:g.winRate, roi:g.roi, reliable:g.total>=100 };
  });

  const clvCards = settled.filter(c=>c.closingLineValue!=null);
  const avgCLV = clvCards.length ? Math.round(clvCards.reduce((s,c)=>s+c.closingLineValue,0)/clvCards.length*10)/10 : null;
  const avgDQS = filtered.length ? Math.round(filtered.reduce((s,c)=>s+(c.dataQualityScore||0),0)/filtered.length) : null;
  const avgEVS = filtered.length ? Math.round(filtered.reduce((s,c)=>s+(c.evSimple||0),0)/filtered.length*1000)/1000 : null;

  return {
    total: filtered.length, settled: settled.length,
    pending: filtered.filter(c=>normalizeCardStatus(c)==='pending').length,
    won:won.length, lost:lost.length, voided:voided.length,
    winRate, roi, totalVGain:Math.round(totalVGain*100)/100,
    maxWin, maxLoss, byTier, bySport, avgCLV,
    avgOdds: filtered.length ? Math.round(filtered.reduce((s,c)=>s+c.odds,0)/filtered.length*100)/100 : null,
    avgScore: filtered.length ? Math.round(filtered.reduce((s,c)=>s+c.reliabilityScore,0)/filtered.length*10)/10 : null,
    avgEV: avgEVS, avgDQS, byMarket, byOddsZone, bySportMarket, bySportMarketTier,
    avgKelly: filtered.length ? Math.round(filtered.reduce((s,c)=>s+(c.kellyFull||0),0)/filtered.length*100)/10 : null,
    reliable: settled.length >= 100,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  MODULE OPTIONNEL — HISTORIQUE SPORTIF AVANCÉ
// ═══════════════════════════════════════════════════════════════════
const SPORT_MATCH_HIST_KEY = 'pgi_sport_match_history_v1';

function _sportHistLoad() {
  try { return JSON.parse(localStorage.getItem(SPORT_MATCH_HIST_KEY) || '[]'); } catch(_) { return []; }
}
function _sportHistSave(arr) {
  try { localStorage.setItem(SPORT_MATCH_HIST_KEY, JSON.stringify(arr)); } catch(_) {}
}

function _sportHistNormalizeIdPart(s) {
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9_]/g,'_')
    .replace(/_+/g,'_')
    .replace(/^_+|_+$/g,'');
}

async function sportHistKVSave(entry) {
  try { const response=await api('/api/sport-history/add', 'POST', { entry }); return response?.ok===true; } catch(_) { return false; }
}
async function sportHistKVUpdate(id, fields) {
  try { const response=await api('/api/sport-history/update', 'POST', { id, fields }); return response?.ok===true; } catch(_) { return false; }
}
async function sportHistKVDelete(id) {
  try { await api('/api/sport-history/delete', 'POST', { id }); return true; } catch(_) { return false; }
}
async function sportHistKVLoad(filters) {
  try {
    const qs = filters ? '?'+Object.entries(filters).map(([k,v])=>k+'='+encodeURIComponent(v)).join('&') : '';
    const result = await api('/api/sport-history/list'+qs);
    return {
      entries: result.entries || [],
      total: result.total || 0,
      limit: result.limit ?? (filters && filters.limit) ?? null,
      offset: result.offset ?? (filters && filters.offset) ?? 0,
      nextOffset: (result.next_offset !== undefined ? result.next_offset : result.nextOffset) ?? null,
      has_more: result.has_more ?? null,
    };
  } catch(_) { return { entries:[], total:0, limit:null, offset:0, nextOffset:null, has_more:null, failed:true }; }
}
async function sportHistKVLoadAll(filters) {
  let all = [];
  let offset = 0;
  let pagesLoaded = 0;
  const limit = 500;
  while (pagesLoaded < 50) {
    const page = await sportHistKVLoad({ ...(filters||{}), limit, offset });
    if(page.failed)throw new Error('Lecture de l’historique distant indisponible');
    const entries = page.entries || [];
    all.push(...entries);
    pagesLoaded++;
    if (!entries.length) break;
    if (page.has_more === false) break;
    if (page.nextOffset == null && entries.length < limit) break;
    offset = page.nextOffset != null ? page.nextOffset : offset + limit;
  }
  return { entries: all, total: all.length, pagesLoaded };
}
function mergeSportHistories(local, remote) {
  const map = {};
  (local||[]).forEach(e => { if(e && e.id) map[e.id] = e; });
  (remote||[]).forEach(e => {
    if(!e || !e.id) return;
    const cur = map[e.id];
    if(!cur) { map[e.id] = e; return; }
    const curResolved = ['win','loss','void'].includes((cur.status||'').toLowerCase());
    const newResolved = ['win','loss','void'].includes((e.status||'').toLowerCase());
    if(curResolved && !newResolved) return;
    if(!curResolved && newResolved) { map[e.id] = e; return; }
    const curT = cur.updatedAt ? new Date(cur.updatedAt).getTime() : 0;
    const newT = e.updatedAt ? new Date(e.updatedAt).getTime() : 0;
    if(!cur.updatedAt && !e.updatedAt) return;
    if(newT > curT) map[e.id] = e;
  });
  return Object.values(map);
}
// Ne republie plus chaque fiche à chaque ouverture. La mémoire locale
// reste fusionnée avec le serveur, et seules les entrées manquantes ou
// réellement incomplètes sont envoyées.
let sportHistoryCloudSnapshot=null;
async function syncSportHistoryLocalToCloud(){
  if(!(sportHistoryCloudSnapshot instanceof Map))return;
  try{
    const local=_sportHistLoad();
    const completeStatus=v=>['win','loss','void'].includes(String(v||'').toLowerCase());
    const descriptive=['competition','sport','market','selection','bookmaker','oddsOpening','oddsDetected','source'];
    for(const e of local.slice(0,200)){
      if(!e||!e.id)continue;
      const saved=sportHistoryCloudSnapshot.get(e.id);
      if(!saved){
        const added=await sportHistKVSave(e);
        if(!added)continue;
        if(completeStatus(e.status)){
          const updated=await sportHistKVUpdate(e.id,{
            status:e.status,finalScore:e.finalScore??null,
            closingOdds:e.oddsClosing??null,clv:e.clv??null,
            resolvedAt:e.resolvedAt??null,updatedAt:e.updatedAt
          });
          if(!updated)continue;
        }
        sportHistoryCloudSnapshot.set(e.id,e);
        continue;
      }
      const missingDescription=descriptive.some(key=>
        (saved[key]===null||saved[key]===undefined||saved[key]==='')&&
        e[key]!==null&&e[key]!==undefined&&e[key]!=='');
      const newlyResolved=completeStatus(e.status)&&!completeStatus(saved.status);
      if(!missingDescription&&!newlyResolved)continue;
      if(!(await sportHistKVSave(e)))continue;
      if(newlyResolved){
        await sportHistKVUpdate(e.id,{
          status:e.status,finalScore:e.finalScore??null,
          closingOdds:e.oddsClosing??null,clv:e.clv??null,
          resolvedAt:e.resolvedAt??null,updatedAt:e.updatedAt
        });
      }
      sportHistoryCloudSnapshot.set(e.id,e);
    }
  }catch(error){console.warn('Synchronisation historique sportif différée',error?.message||error);}
}
async function loadSportHistoryFromCloud(){
  sportHistoryCloudSnapshot=null;
  try{
    const remote=await sportHistKVLoadAll();
    sportHistoryCloudSnapshot=new Map(remote.entries.filter(e=>e&&e.id).map(e=>[e.id,e]));
    if(remote.entries&&remote.entries.length){
      const local=_sportHistLoad();
      const merged=mergeSportHistories(local,remote.entries);
      merged.sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
      _sportHistSave(merged);
    }
  }catch(_){sportHistoryCloudSnapshot=null;}
}

function saveSportMatchHistory(matchData) {
  if(!matchData || !matchData.home || !matchData.away) return null;
  const entries = _sportHistLoad();
  const safeStartTime = matchData.startTime ? String(matchData.startTime).slice(0,16) : 'no_start_time';
  const idParts = [
    matchData.sport, matchData.competition, matchData.home, matchData.away,
    matchData.market||'h2h', matchData.selection||'', safeStartTime,
  ].map(_sportHistNormalizeIdPart);
  const id = matchData.id ? _sportHistNormalizeIdPart(matchData.id) : idParts.filter(Boolean).join('_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');
  const existing = entries.find(e => e.id === id);
  if (existing) {
    sportHistKVSave(existing).catch(() => {});
    return id;
  }
  entries.unshift({
    id,
    home: matchData.home, away: matchData.away,
    competition: matchData.competition || '', sport: matchData.sport || '',
    market: matchData.market || 'h2h', selection: matchData.selection || '',
    oddsOpening: matchData.oddsOpening ?? matchData.odds ?? null,
    oddsDetected: matchData.odds ?? null,
    oddsClosing: null, clv: null,
    bookmaker: matchData.bookmaker || '',
    status: 'pending', finalScore: null,
    source: matchData.source || 'moteur_reel',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolvedAt: null,
  });
  if(entries.length > 5000) entries.length = 5000;
  _sportHistSave(entries);
  sportHistKVSave(entries[0]).catch(()=>{});
  return id;
}

function updateSportMatchResult(id, result) {
  const entries = _sportHistLoad();
  const idx = entries.findIndex(e => e.id === id);
  if (idx < 0) return false;

  const e = entries[idx];
  const currentStatus = (e.status || 'pending').toLowerCase();

  if (['win', 'loss', 'void'].includes(currentStatus)) return false;

  const allowedStatuses = ['win', 'loss', 'void', 'pending'];
  const incomingStatus = result && allowedStatuses.includes(result.status)
    ? result.status
    : currentStatus;

  e.status = incomingStatus;

  if (result && result.finalScore != null) {
    e.finalScore = result.finalScore;
  }

  if (result && result.closingOdds != null) {
    e.oddsClosing = result.closingOdds;
  }

  if (e.oddsClosing && e.oddsDetected) {
    e.clv = calculateCLV(e.oddsDetected, e.oddsClosing);
  }

  e.updatedAt = new Date().toISOString();

  if (['win', 'loss', 'void'].includes(incomingStatus)) {
    e.resolvedAt = e.updatedAt;
  }

  entries[idx] = e;
  _sportHistSave(entries);

  sportHistKVUpdate(id, {
    status: e.status,
    finalScore: e.finalScore ?? null,
    closingOdds: e.oddsClosing ?? null,
    oddsClosing: e.oddsClosing ?? null,
    clv: e.clv ?? null,
    resolvedAt: e.resolvedAt ?? null,
    updatedAt: e.updatedAt,
  }).catch(() => {});

  return true;
}

function getSportHistory(filters) {
  filters = filters || {};
  return _sportHistLoad().filter(e => {
    if(filters.sport && getSportFamily(e.sport) !== getSportFamily(filters.sport)) return false;
    if(filters.competition && e.competition !== filters.competition) return false;
    if(filters.market && e.market !== filters.market) return false;
    if(filters.bookmaker && e.bookmaker !== filters.bookmaker) return false;
    if(filters.team && e.home !== filters.team && e.away !== filters.team) return false;
    return true;
  });
}

function _sportStatsFor(entries) {
  const settled = entries.filter(e => ['win','loss','void'].includes(e.status));
  const won = settled.filter(e => e.status === 'win').length;
  const lost = settled.filter(e => e.status === 'loss').length;
  const wl = won + lost;
  const winRate = wl > 0 ? Math.round(won/wl*1000)/10 : null;
  const clvEntries = settled.filter(e => e.clv != null);
  const avgCLV = clvEntries.length ? Math.round(clvEntries.reduce((s,e)=>s+e.clv,0)/clvEntries.length*10)/10 : null;
  return { total: entries.length, settled: settled.length, won, lost, winRate, avgCLV, reliable: settled.length >= 100 };
}

function calcTeamStats(teamName) { return teamName ? _sportStatsFor(getSportHistory({ team: teamName })) : _sportStatsFor([]); }
function calcCompetitionStats(competition) { return _sportStatsFor(getSportHistory({ competition })); }
function calcMarketStats(market) { return _sportStatsFor(getSportHistory({ market })); }
function calcOddsZoneStats(zone) { return _sportStatsFor(_sportHistLoad().filter(e => getOddsZone(e.oddsDetected) === zone)); }
function calcBookmakerStats(bookmaker) { return _sportStatsFor(getSportHistory({ bookmaker })); }

function getHistoricalSportAdjustment(context) {
  context = context || {};
  const stats = _sportStatsFor(getSportHistory(context));

  if(stats.settled < 100) {
    return {
      status:'insufficient', volume:stats.settled, settled:stats.settled,
      winRate:null, avgCLV:null, scoreAdjustment:0,
      reason:'Historique sportif avancé insuffisant (minimum 100 entrées réglées requis).',
    };
  }

  const wr = stats.winRate, clv = stats.avgCLV;
  let scoreAdjustment = 0, status = 'neutral';
  let reason = `${stats.settled} entrées réglées, réussite ${wr!=null?wr+'%':'—'}, CLV ${clv!=null?(clv>0?'+':'')+clv+'%':'—'}.`;

  if(stats.settled < 500) {
    if(clv != null && clv > 0) {
      scoreAdjustment = clv > 1 ? 2 : 1;
      status = 'positive';
    }
  } else {
    const winRatePositive     = wr != null && wr >= 52;
    const winRateVeryNegative = wr != null && wr <= 35;
    const clvPositive         = clv != null && clv > 0;
    const clvVeryNegative     = clv != null && clv <= -2;

    if(winRatePositive && clvPositive) {
      scoreAdjustment = clv > 3 ? 5 : (clv > 1.5 ? 4 : 3);
      status = 'positive';
    } else if(winRateVeryNegative || clvVeryNegative) {
      let severity = 3;
      if(clv != null && clv <= -5) severity = Math.max(severity, 7);
      else if(clv != null && clv <= -2) severity = Math.max(severity, 5);
      if(wr != null && wr <= 20) severity = Math.max(severity, 8);
      else if(wr != null && wr <= 28) severity = Math.max(severity, 6);
      else if(wr != null && wr <= 35) severity = Math.max(severity, 4);
      scoreAdjustment = -Math.min(8, severity);
      status = 'negative';
    }
  }

  if(status === 'positive') reason += ' Bonus prudent appliqué.';
  else if(status === 'negative') reason += ' Malus de prudence appliqué.';

  return { status, volume:stats.settled, settled:stats.settled, winRate:wr, avgCLV:clv, scoreAdjustment, reliable:stats.reliable, reason };
}

function calcAdvancedSportHistoryGlobalStats() {
  const entries = _sportHistLoad();
  const settled = entries.filter(e => ['win','loss','void'].includes(e.status));
  const won = settled.filter(e => e.status==='win').length;
  const lost = settled.filter(e => e.status==='loss').length;
  const wl = won+lost;
  const winRate = wl>0 ? Math.round(won/wl*1000)/10 : null;
  const clvEntries = settled.filter(e => e.clv != null);
  const avgCLV = clvEntries.length ? Math.round(clvEntries.reduce((s,e)=>s+e.clv,0)/clvEntries.length*10)/10 : null;
  const pending = entries.filter(e => e.status==='pending').length;
  return { total: entries.length, settled: settled.length, pending, won, lost, winRate, avgCLV, reliable: settled.length>=100 };
}

function renderAdvancedSportHistoryStats() {
  const stats = calcAdvancedSportHistoryGlobalStats();
  let el = document.getElementById('perf-adv-sporthist-stats');
  if(!el) {
    const globalEl = document.getElementById('perf-global-stats');
    if(!globalEl) return;
    el = document.createElement('div');
    el.id = 'perf-adv-sporthist-stats';
    globalEl.after(el);
  }
  const insufficientNote = stats.settled < 100
    ? `<div style="font-size:10px;color:var(--am);margin-top:6px">&#9888; Historique sportif avancé insuffisant — minimum 100 entrées réglées requis.</div>` : '';
  el.innerHTML = `<div class="card" style="margin-bottom:12px"><div class="ct">Historique sportif avancé</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px">
      <div class="tsm-cell"><div class="sv">${stats.total}</div><label>Entrées totales</label></div>
      <div class="tsm-cell"><div class="sv">${stats.settled}</div><label>Réglées</label></div>
      <div class="tsm-cell"><div class="sv">${stats.pending}</div><label>En attente</label></div>
      <div class="tsm-cell"><div class="sv">${stats.winRate!=null?stats.winRate+'%':'—'}</div><label>Taux réussite</label></div>
      <div class="tsm-cell"><div class="sv">${stats.avgCLV!=null?(stats.avgCLV>0?'+':'')+stats.avgCLV+'%':'—'}</div><label>CLV moyenne</label></div>
    </div>
    ${insufficientNote}
  </div>`;
}

function generateConclusion(stats, period) {
  const lines = [];
  const { settled, roi, byTier, bySport, maxLoss } = stats;

  if(settled < 100) {
    lines.push({text:`Historique insuffisant (${settled} cartes réglées, minimum 100 requis). Aucune conclusion fiable pour le moment.`, color:'gray'});
    lines.push({text:'⚠️ Les statistiques passées ne garantissent pas les résultats futurs. Analyse probabiliste uniquement.', color:'gray'});
    return lines;
  }

  if(settled < 500)       lines.push({text:`Tendance prudente (${settled} cartes réglées). Ajustements légers tant que 500 cartes ne sont pas atteintes.`, color:'orange'});
  else if(settled < 1000) lines.push({text:`Historique exploitable (${settled} cartes réglées). Ajustements significatifs activés.`, color:'green'});
  else                    lines.push({text:`Historique très solide (${settled} cartes réglées). Ajustements avancés, restent probabilistes.`, color:'green'});

  if(roi !== null) {
    if(roi > 5)            lines.push({text:`ROI global : +${roi}% — tendance positive.`, color:'green'});
    else if(roi > 0)       lines.push({text:`ROI global : +${roi}% — positif mais marge faible.`, color:'orange'});
    else if(settled>=500)  lines.push({text:`ROI global : ${roi}% — négatif sur échantillon significatif. Seuils à durcir.`, color:'red'});
    else                   lines.push({text:`ROI global : ${roi}% — négatif, à surveiller.`, color:'red'});
  }

  const reliableSports = (bySport||[]).filter(s=>s.total>=500);
  if(reliableSports.length) {
    const best = reliableSports[0], worst = reliableSports[reliableSports.length-1];
    if(best.roi>0)   lines.push({text:`Signal le plus favorable (volume suffisant) : ${best.sport} (ROI ${best.roi}%, ${best.total} cartes).`, color:'green'});
    if(worst.roi<-5) lines.push({text:`Sport à surveiller (volume suffisant) : ${worst.sport} (ROI ${worst.roi}%, ${worst.total} cartes).`, color:'red'});
  } else {
    lines.push({text:'Aucun sport n\'a encore atteint 500 cartes — aucune recommandation forte possible pour l\'instant.', color:'gray'});
  }

  const p = byTier && byTier.premium;
  if(p && p.total>=100) {
    if(p.roi>8)       lines.push({text:`TOP PREMIUM : signal positif (ROI ${p.roi}%, réussite ${p.winRate}%).`, color:'green'});
    else if(p.roi>0)  lines.push({text:`TOP PREMIUM : signal légèrement positif (ROI ${p.roi}%).`, color:'orange'});
    else              lines.push({text:`TOP PREMIUM : signal négatif (ROI ${p.roi}%) — seuils à renforcer.`, color:'red'});
  }

  if(maxLoss >= 10) lines.push({text:`Série maximale de pertes : ${maxLoss}. Gestion bankroll critique.`, color:'red'});
  else if(maxLoss >= 6) lines.push({text:`Série maximale de pertes : ${maxLoss}. Prudence recommandée.`, color:'orange'});

  lines.push({text:'⚠️ Les statistiques passées ne garantissent pas les résultats futurs. Analyse probabiliste uniquement — aucun gain n\'est promis.', color:'gray'});
  return lines;
}

function exportHistoryCSV() {
  const data = histLocalLoad();
  if(!data.length) { toast('Historique vide','err'); return; }
  const headers = ['id','detectedAt','sport','home','away','market','selection','odds','tier','reliabilityScore','impliedProb','modelProb','edgeProb','evSimple','kellyFull','stakeRecommended','dataQualityScore','virtualStake','status','virtualGain','virtualROI','closingOdds','closingLineValue'];
  const rows = data.map(c => headers.map(h => JSON.stringify(c[h]??'')).join(','));
  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'betpro_history_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
  toast('Export CSV OK','ok');
}

function exportHistoryJSON() {
  const data = histLocalLoad();
  if(!data.length) { toast('Historique vide','err'); return; }
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'betpro_history_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();
  toast('Export JSON OK','ok');
}

function copyTeamNames(btn) {
  var home = btn.dataset.home || '';
  var away = btn.dataset.away || '';
  var text = (home + ' ' + away).trim();
  if(navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function(){
      var orig = btn.textContent;
      btn.textContent = 'Copie!';
      setTimeout(function(){ btn.textContent = orig; }, 1500);
    });
  }
}
function copyMatchText(match,sel,odds,btn){ const t=`${match} — ${sel} @ ${odds}`; navigator.clipboard?.writeText(t).then(()=>{btn.textContent='✓ Copié';btn.classList.add('copied');setTimeout(()=>{btn.textContent='📋 Copier';btn.classList.remove('copied');},1500);}).catch(()=>{}); }
function copyCard(btn,match){ navigator.clipboard?.writeText(match).then(()=>{btn.textContent='✓ Copié';btn.classList.add('copied');setTimeout(()=>{btn.textContent='📋 Copier';btn.classList.remove('copied');},1500);}); }

function getSportLabel(sport){
  if(sport.includes('soccer')) return '⚽ Foot';
  if(sport.includes('basketball')) return '🏀 Basket';
  if(sport.includes('tennis')) return '🎾 Tennis';
  if(sport.includes('mma')||sport.includes('box')) return '🥊 MMA';
  if(sport.includes('hockey')) return '🏒 Hockey';
  if(sport.includes('rugby')) return '🏉 Rugby';
  if(sport.includes('baseball')) return '⚾ Baseball';
  if(sport.includes('football')) return '🏈 NFL';
  if(sport.includes('volley')) return '🏐 Volley';
  return '🏆 Sport';
}

// ═══════════════════════════════════════════════
//  ANALYZE CIBLÉE
// ═══════════════════════════════════════════════
async function doAnalyze(){
  const sport=document.getElementById('sel-sport').value,market=document.getElementById('sel-market').value,mode=document.getElementById('sel-mode').value,minScore=parseInt(document.getElementById('sel-minscore').value);
  const btn=document.getElementById('abtn'),cnt=document.getElementById('dash-res');
  btn.disabled=true;btn.innerHTML='<span class="sp" style="width:12px;height:12px;border-width:2px"></span> Analyse…';
  cnt.innerHTML='<div class="ls"><div class="sp"></div><p>Interrogation…</p></div>';
  try{
    const d=await api('/api/analyze?sport='+enc(sport)+'&market='+enc(market)+'&mode='+enc(mode));
    const opps=(d.opportunities||[]).filter(o=>(o.score?.total||0)>=minScore);
    cnt.innerHTML='';
    if(d.warning)cnt.innerHTML+='<div class="warn">⚠ '+esc(d.warning)+'</div>';
    if(d.key_used)cnt.innerHTML+=`<div style="font-size:9px;color:var(--dm);font-family:var(--mo);margin-bottom:8px">🔑 Clé ${d.key_used}/${d.keys_available||1} utilisée</div>`;
    cnt.innerHTML+=`<div class="sbar"><div class="sdot"></div><span>${opps.length} opportunité(s)</span>${d.cached?'<span class="bdg bca">Cache</span>':''}<span style="margin-left:auto;color:var(--dm)">${fmtDT(d.analyzed_at)}</span></div>`;
    cnt.innerHTML+=renderOpps(opps);loadQuotas();toast(opps.length+' opportunité(s)','ok');
  }catch(e){cnt.innerHTML=`<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">${esc(e.message)}</div></div>`;toast('Erreur: '+e.message,'err');}
  btn.disabled=false;btn.innerHTML='<span>⚡</span> Analyser';
}

function evidencePct(v){const n=Number(v);return Number.isFinite(n)?(n*100).toFixed(1)+'%':'—';}
function renderProfessionalEvidence(e){
  if(!e)return'';
  const rows=[
    ['Partants actifs',e.runners_active],['Places payées',e.paid_places],['Non-partants',Array.isArray(e.non_runners)?(e.non_runners.join(', ')||'Aucun'):null],
    ['Cote contrôlée',e.odds],['Probabilité modèle',e.model_probability!=null?evidencePct(e.model_probability):null],
    ['Probabilité conservatrice',e.conservative_probability!=null?evidencePct(e.conservative_probability):null],
    ['Probabilité marché',e.market_probability!=null?evidencePct(e.market_probability):null],['Avantage conservateur',e.edge_conservative!=null?evidencePct(e.edge_conservative):null],
    ['Valeur attendue conservatrice',e.expected_value!=null?evidencePct(e.expected_value):null],['Échantillon de validation',e.validation_size],
    ['Historique de l’entité',e.historical_samples],['Opérateurs',e.bookmakers],['Fraîcheur des données',e.data_age_minutes!=null?Number(e.data_age_minutes).toFixed(1)+' min':null],
    ['Qualité données',e.data_quality_score!=null?e.data_quality_score+'/100':null],['Départ',e.start_time?fmtDT(e.start_time):null],
  ].filter(([,v])=>v!==null&&v!==undefined&&v!=='');
  if(!rows.length)return'';
  return `<div style="margin-top:10px;padding:10px;border:1px solid rgba(0,212,255,.18);border-radius:6px;background:rgba(0,212,255,.035)"><div style="font-size:9px;color:var(--neon);font-family:var(--mo);font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px">Preuves de validation</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:5px">${rows.map(([l,v])=>`<div style="background:var(--sf2);border-radius:4px;padding:5px 7px"><div style="font-size:8px;color:var(--dm);text-transform:uppercase">${esc(l)}</div><div style="font-size:10px;color:var(--tx);font-family:var(--mo);margin-top:2px">${esc(String(v))}</div></div>`).join('')}</div></div>`;
}

function renderOpps(opps){
  if(!opps?.length)return'<div class="empty"><div class="empty-i">🔍</div><div class="empty-t">'+esc(NO_RELIABLE_CARD_MESSAGE)+'</div><div class="empty-s">Le moteur s’abstient tant que les cotes, l’historique et la validation hors échantillon ne sont pas suffisants.</div></div>';
  return '<div class="opp-grid">'+opps.map((o,i)=>renderDirectionCard(o,i,'main')).join('')+'</div>';
}
function ssRow(l,v){const n=parseInt(v)||0,c=n>=70?'var(--neon)':n>=50?'var(--am)':'var(--re)';return`<div class="ssr"><span class="ssl">${l}</span><div class="sst"><div class="ssf" style="width:${n}%;background:${c}"></div></div><span class="ssv">${n}</span></div>`;}

// ═══════════════════════════════════════════════════════════════════════
//  ANALYSE MANUELLE — recherche ancrée sur les VRAIES cotes (The Odds API)
// ═══════════════════════════════════════════════════════════════════════
function getCheckedMarkets(){return[...document.querySelectorAll('#m-markets-wrap input:checked')].map(c=>c.value);}

async function findRealMatchOpportunities(home, away, sportFamily, dateStr, markets){
  const leagues = getLeaguesForSportFilter(sportFamily && sportFamily!=='all' ? sportFamily : 'all', 'complet');
  const marketsToQuery = (markets && markets.length) ? markets : ['h2h'];

  const queries = [];
  const seenQ = new Set();
  leagues.forEach(l => {
    marketsToQuery.forEach(mk => {
      const key = l.sport+'|'+mk;
      if(seenQ.has(key)) return;
      seenQ.add(key);
      queries.push({ sport:l.sport, market:mk });
    });
  });

  const allRawOpps = [];
  const chunk = 6;
  for(let i=0;i<queries.length;i+=chunk){
    const batch = queries.slice(i,i+chunk);
    const results = await Promise.allSettled(batch.map(({sport,market}) =>
      api('/api/analyze?sport='+enc(sport)+'&market='+enc(market)+'&mode=quick').then(d=>{
        const opps = (d.opportunities||[]);
        opps.forEach(o=>{ o._sport=sport; o.sport=sport; o.market=o.market||market; });
        return opps;
      }).catch(()=>[])
    ));
    results.forEach(r=>{ if(r.status==='fulfilled') allRawOpps.push(...r.value); });
  }

  const teamMatches = allRawOpps.filter(o => {
    const h = o.home_team||'', a = o.away_team||'';
    const directMatch  = teamNamesMatch(home,h) && teamNamesMatch(away,a);
    const reverseMatch = teamNamesMatch(home,a) && teamNamesMatch(away,h);
    return directMatch || reverseMatch;
  });

  if(!teamMatches.length){
    return { found:false, reason:`Aucun match "${home} vs ${away}" trouvé dans les cotes actuellement disponibles (ni aujourd'hui, ni à venir). Vérifiez l'orthographe des équipes ou réessayez plus près de la date du match — les bookmakers ne publient généralement les cotes que quelques jours à l'avance.` };
  }

  const byMatch = {};
  teamMatches.forEach(o=>{
    const k = (o.home_team||'')+'|'+(o.away_team||'')+'|'+(o.start_time||o.commence_time||'');
    if(!byMatch[k]) byMatch[k] = [];
    byMatch[k].push(o);
  });
  let candidateKeys = Object.keys(byMatch);

  if(dateStr){
    const withDate = candidateKeys.filter(k=>{
      const first = byMatch[k][0];
      const st = first.start_time||first.commence_time;
      return st && frenchDateStrClient(st) === dateStr;
    });
    if(withDate.length){ candidateKeys = withDate; }
    else {
      const sorted = candidateKeys.slice().sort((k1,k2)=>{
        const t1 = new Date(byMatch[k1][0].start_time||byMatch[k1][0].commence_time||0).getTime();
        const t2 = new Date(byMatch[k2][0].start_time||byMatch[k2][0].commence_time||0).getTime();
        return t1-t2;
      });
      const nearest = byMatch[sorted[0]][0];
      const nearestDate = nearest.start_time ? frenchDateStrClient(nearest.start_time) : null;
      return {
        found:false,
        reason: nearestDate
          ? `Le match "${home} vs ${away}" n'est pas programmé le ${dateStr}. La prochaine rencontre trouvée dans les cotes disponibles est le ${nearestDate} (heure de Paris). Modifiez la date ou laissez le champ vide pour l'analyser automatiquement.`
          : `Le match "${home} vs ${away}" n'a pas de cote disponible pour le ${dateStr}.`,
      };
    }
  }

  const now = Date.now();
  candidateKeys = candidateKeys
    .map(k=>({ k, t: new Date(byMatch[k][0].start_time||byMatch[k][0].commence_time||0).getTime() }))
    .filter(x=>!dateStr ? (x.t >= now - 3*3600000) : true)
    .sort((a,b)=>a.t-b.t)
    .map(x=>x.k);

  if(!candidateKeys.length){
    return { found:false, reason:`Les seules rencontres "${home} vs ${away}" trouvées dans les cotes sont déjà terminées ou trop anciennes pour être analysées. Aucune analyse n'est produite sur un match déjà joué.` };
  }

  const chosenKey = candidateKeys[0];
  const chosenOpps = byMatch[chosenKey];
  const ref = chosenOpps[0];

  return {
    found: true,
    home: ref.home_team, away: ref.away_team,
    sport: ref.sport||ref._sport, competition: ref.competition||ref.sport_title||ref.sport||'',
    start_time: ref.start_time||ref.commence_time||null,
    opportunities: chosenOpps,
  };
}

async function doManualAnalyze(){
  const home=document.getElementById('m-home').value.trim();
  const away=document.getElementById('m-away').value.trim();
  if(!home||!away){toast('Entrez les deux équipes','err');return;}
  const sportFamily = document.getElementById('m-sport-family')?.value || 'all';
  const dateStr = document.getElementById('m-date')?.value || '';
  const markets = getCheckedMarkets();

  const btn=document.getElementById('mbtn');
  btn.disabled=true;btn.innerHTML='<span class="sp" style="width:12px;height:12px;border-width:2px"></span> Recherche du vrai match…';
  document.getElementById('manual-res').innerHTML='<div class="ls"><div class="sp"></div><p>Recherche dans les cotes réelles (peut prendre quelques secondes)…</p></div>';

  try{
    const result = await findRealMatchOpportunities(home, away, sportFamily, dateStr, markets);
    document.getElementById('manual-res').innerHTML = renderManualMatchResult(result, {home,away,dateStr});
    toast(result.found ? 'Match trouvé et analysé' : 'Match introuvable dans les cotes actuelles', result.found?'ok':'err');
  }catch(e){
    document.getElementById('manual-res').innerHTML=`<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">Erreur: ${esc(e.message)}</div></div>`;
    toast('Erreur: '+e.message,'err');
  }
  btn.disabled=false;btn.innerHTML='🎯 Rechercher le vrai match &amp; analyser';
}

function loadFile(){const file=document.getElementById('m-file').files[0];if(!file)return;const r=new FileReader();r.onload=e=>document.getElementById('m-csv').value=e.target.result;r.readAsText(file);}

async function doCSVAnalyze(){
  const raw=document.getElementById('m-csv').value.trim();
  if(!raw){toast('Aucune donnée','err');return;}
  const rows=raw.split('\n').filter(l=>l.trim()).map(l=>{
    const p=l.split(';').map(s=>s.trim());
    return { home:p[0], away:p[1], competition:p[2]||null, date:p[3]||'' };
  }).filter(m=>m.home&&m.away);
  if(!rows.length){toast('Format invalide','err');return;}

  const sportFamily = document.getElementById('m-csv-sport-family')?.value || 'all';
  const markets = getCheckedMarkets();
  const btn=document.getElementById('csvbtn');
  btn.disabled=true;btn.innerHTML=`<span class="sp" style="width:12px;height:12px;border-width:2px"></span> ${rows.length} match(s)…`;
  document.getElementById('manual-res').innerHTML=`<div class="ls"><div class="sp"></div><p>Recherche des vrais matchs pour ${rows.length} ligne(s)…</p></div>`;

  try{
    const results = [];
    for(const row of rows){
      try{
        const r = await findRealMatchOpportunities(row.home, row.away, sportFamily, row.date||'', markets);
        results.push({ input:row, result:r });
      }catch(e){
        results.push({ input:row, result:{ found:false, reason:'Erreur lors de la recherche: '+e.message } });
      }
    }
    document.getElementById('manual-res').innerHTML = results.map(({input,result})=>renderManualMatchResult(result, {home:input.home, away:input.away, dateStr:input.date})).join('');
    const foundCount = results.filter(r=>r.result.found).length;
    toast(`${foundCount}/${rows.length} match(s) trouvé(s) et analysé(s)`, foundCount?'ok':'err');
  }catch(e){
    document.getElementById('manual-res').innerHTML=`<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">Erreur: ${esc(e.message)}</div></div>`;
    toast('Erreur: '+e.message,'err');
  }
  btn.disabled=false;btn.innerHTML='📂 Analyser la liste';
}

function renderManualMatchResult(result, inputCtx){
  if(!result || !result.found){
    return `<div class="card" style="border-color:rgba(245,158,11,.35)">
      <div class="ct">${esc(inputCtx.home||'?')} vs ${esc(inputCtx.away||'?')}${inputCtx.dateStr?' — '+esc(inputCtx.dateStr):''}</div>
      <div class="warn" style="margin-bottom:0">&#9888; ${esc(result?.reason||"Match introuvable dans les cotes disponibles actuellement.")}</div>
    </div>`;
  }

  const dirResults = result.opportunities.map(o=>({ o, res: computeDirection(o, {mode:'standard', bankroll:200, riskProfile:'conservateur'}) }));
  const startInfo = result.start_time ? fmtDT(result.start_time) + ' (heure de Paris)' : 'Horaire non communiqué par les bookmakers';

  let html = `<div class="card">
    <div class="ct">${esc(result.home)} vs ${esc(result.away)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      <span class="bdg bsp">${esc(result.competition||result.sport||'')}</span>
      <span class="bdg bsr">${esc(startInfo)}</span>
    </div>`;

  const playable = dirResults.filter(x=>x.res.shouldDisplay && x.res.direction==='play');
  if(!playable.length){
    html += `<div class="info" style="margin-bottom:0">Match confirmé avec de vraies cotes, mais aucune sélection ne franchit les seuils prudents du moteur pour l'instant (${dirResults.length} marché(s) analysé(s)). Cela peut changer à mesure que les cotes évoluent avant le coup d'envoi.</div>`;
  } else {
    html += '<div class="opp-grid">' + playable.map((x,i)=>renderDirectionCard(x.o, 'manual-'+i, 'manual-res')).join('') + '</div>';
  }
  html += '</div>';
  return html;
}

// ═══════════════════════════════════════════════
//  LIVE & UPCOMING — avec direction de pari
// ═══════════════════════════════════════════════
function getLiveAllLeagues() {
  return [
    ...FOOTBALL_LEAGUES.map(l => ({ sport:l.sport, market:'h2h' })),
    {sport:'basketball_nba',market:'h2h'},{sport:'basketball_euroleague',market:'h2h'},
    {sport:'tennis_atp',market:'h2h'},{sport:'tennis_wta',market:'h2h'},
    {sport:'tennis_atp_french_open',market:'h2h'},{sport:'tennis_wta_french_open',market:'h2h'},
    {sport:'rugbyunion_premiership',market:'h2h'},{sport:'icehockey_nhl',market:'h2h'},
    {sport:'baseball_mlb',market:'h2h'},{sport:'mma_mixed_martial_arts',market:'h2h'},
    {sport:'americanfootball_nfl',market:'h2h'},
  ];
}

// BetPro live v140. Source-of-truth: confirmed in-play fixtures only.
// Distinct from prematch Classique/Benter scans and their betting recommendations.
const BETPRO_LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','INT','LIVE']);
let betproLiveRequestSequence = 0;
let betproLiveFixtureSnapshots = new Map();

function betproLiveIsActive(m){
  const id=String(m?.fixture_id??'');
  const status=String(m?.status||'').toUpperCase();
  return m?.is_live===true && /^\d{1,12}$/.test(id) && BETPRO_LIVE_STATUSES.has(status)
    && String(m.home||'').trim().length>0 && String(m.away||'').trim().length>0;
}
function betproLiveTimeLabel(m){
  if(m.source==='api-football')return betproLiveMinuteLabel(m)||String(m.status_label||'En direct');
  const info=String(m.status_label||'').trim();
  const clock=String(m.clock||'').trim();
  return info || (m.period ? `Période ${m.period}${clock?' · '+clock:''}`:'En direct');
}
function betproLiveSportName(s){
  const map={soccer:'Football',basketball_nba:'Basket NBA',basketball_ncaab:'Basket NCAA',americanfootball_nfl:'Football US NFL',americanfootball_ncaaf:'Football US NCAA',icehockey_nhl:'Hockey NHL',baseball_mlb:'Baseball MLB'};
  return map[s]||String(s||'Sport');
}
function betproLiveCard(m){
  const id=String(m.fixture_id),sport=m.sport||'soccer';
  const score=m.score||{},hasScore=score.home!=null&&score.away!=null;
  const lbl=betproLiveTimeLabel(m),key=m.source+':'+sport+':'+id;
  const source=m.source==='api-football'?'API-Football':'ESPN';
  const events=Array.isArray(m.events)?m.events:[];
  const cards=events.filter(e=>String(e.type).toLowerCase()==='card').slice(-3).map(e=>`${e.minute??'?'}′ ${e.detail||'Carton'}`);
  return `<div class="betpro-real-live-card" data-live-key="${esc(key)}">
    <div class="betpro-real-live-head"><span class="betpro-real-live-flag">● EN DIRECT</span><span>${esc(betproLiveSportName(sport))} · ${esc(m.competition||'Compétition non indiquée')}</span><span class="betpro-real-live-clock">${esc(lbl)}</span></div>
    <div class="betpro-real-live-body"><div class="betpro-real-live-name">${betproClassicSportIcon(sport)} ${esc(m.home)} <span style="color:var(--dm)">vs</span> ${esc(m.away)}</div>
      <div class="betpro-real-live-meta"><span>Rencontre n° ${esc(id)}</span>${m.round?`<span>${esc(m.round)}</span>`:''}<span>Source : ${esc(source)}</span></div>
      <div class="betpro-real-live-score">${hasScore?`${esc(String(score.home))} <span>:</span> ${esc(String(score.away))}`:'Score non communiqué'}</div>
      <div class="betpro-real-live-sub">${m.source==='api-football'?'Minute officielle : '+esc(lbl):'Période et chronomètre officiels : '+esc(lbl)}${cards.length?' · Cartons : '+esc(cards.join(' ; ')):''}</div>
      <div class="betpro-real-live-actions"><button type="button" class="btn bp" onclick="betproAnalyzeRealLive('${esc(key)}', this)">Analyser ce match en direct</button><span>Analyse fondée sur les statistiques, pas seulement sur le score</span></div>
      <div class="betpro-real-live-analysis" id="betpro-live-analysis-${esc(id)}-${esc(sport)}"></div>
    </div>
  </div>`;
}
async function betproLoadRealLive(containerId){
  const cnt=document.getElementById(containerId);if(!cnt)return;
  const seq=++betproLiveRequestSequence;
  cnt.innerHTML='<div class="ls"><div class="sp"></div><p>Lecture des scores officiellement confirmés en direct…</p></div>';
  try{
    const d=await api('/api/live','GET',null,{timeoutMs:20000});
    if(seq!==betproLiveRequestSequence)return;
    if(d?.ok===false && !Array.isArray(d.live_matches))throw Error(d?.error||'Flux direct indisponible');
    const active=(Array.isArray(d.live_matches)?d.live_matches:[]).filter(betproLiveIsActive);
    const unique=new Map();for(const m of active)unique.set(m.source+':'+m.sport+':'+m.fixture_id,m);
    const matches=[...unique.values()].sort((a,b)=>{
      const sA=betproLiveSportName(a.sport),sB=betproLiveSportName(b.sport);
      return sA.localeCompare(sB,'fr')||String(a.competition||'').localeCompare(String(b.competition||''),'fr')||Number(b.minute||0)-Number(a.minute||0);
    });
    betproLiveFixtureSnapshots=new Map(matches.map(m=>[m.source+':'+m.sport+':'+m.fixture_id,{...m,_loadedAt:Date.now()}]));
    const fetchDate=betproClassicDate(d.fetched_at||new Date().toISOString());
    const warnings=(Array.isArray(d.source_warnings)?d.source_warnings:[]);
    const serverNote=d.cached?' · données réutilisées pendant leur courte durée de validité':'';
    const liveTitle=`<div class="sbar"><span style="color:var(--re);font-weight:800">● MATCHS RÉELLEMENT EN COURS</span><span>${matches.length} rencontre(s) live confirmée(s)</span><span style="margin-left:auto">Relevé : ${esc(fetchDate)}${serverNote}</span></div>`;
    const warningNote=warnings.length?`<div class="info" style="font-size:10px">Certaines sources sont momentanément indisponibles : ${esc(warnings.slice(0,3).join(' ; '))}. Aucun match non confirmé n'a été ajouté.</div>`:'';
    const empty=`<div class="empty"><div class="empty-t">Aucun match actuellement confirmé en direct par les sources consultées.</div><div class="empty-s">Les rencontres programmées restent uniquement dans la rubrique « Matchs à venir ». Réactualisez le Live pour un nouveau relevé.</div></div>`;
    cnt.innerHTML=liveTitle+warningNote+(matches.length?'<div class="betpro-real-live-grid">'+matches.map(betproLiveCard).join('')+'</div>':empty);
  }catch(err){if(seq===betproLiveRequestSequence)cnt.innerHTML='<div class="warn">Flux live indisponible : '+esc(err?.message||String(err))+'. Aucun match programmé ne sera substitué à un vrai match en direct.</div>';}
}

function betproLiveNum(v){
  if(v==null||v==='')return null;
  const n=Number(String(v).replace('%','').replace(',','.').trim());return Number.isFinite(n)?n:null;
}
function betproLiveStatsForMatch(match, response){
  const arr=Array.isArray(response.teams)?response.teams:[];
  let home=arr.find(x=>match.home_id!=null&&String(x.team_id)===String(match.home_id));
  let away=arr.find(x=>match.away_id!=null&&String(x.team_id)===String(match.away_id));
  // ESPN official team id can be missing in a fixture; compare exact display names, never assume order.
  const clean=s=>String(s||'').toLocaleLowerCase('fr').replace(/[^a-z0-9]+/g,'').trim();
  if(!home)home=arr.find(x=>clean(x.team_name)===clean(match.home));
  if(!away)away=arr.find(x=>clean(x.team_name)===clean(match.away));
  return home&&away&&home!==away?{home:home.stats||{},away:away.stats||{}}:null;
}
function betproLiveStat(stats,key){
  return betproLiveNum(stats?.[key]);
}
function betproLiveEvidence(name,a,b,unit=''){
  const left=a==null?'–':String(a)+(unit||''),right=b==null?'–':String(b)+(unit||'');
  return `<div class="betpro-real-live-stat"><span>${esc(left)}</span><span>${esc(name)}</span><span>${esc(right)}</span></div>`;
}
function betproLiveClamp(v,a,b){return Math.max(a,Math.min(b,v));}
function betproLivePoisson(k,lambda){
  let factorial=1;for(let j=2;j<=k;j++)factorial*=j;
  return Math.exp(-lambda)*Math.pow(lambda,k)/factorial;
}
function betproLiveHeuristicFootball(m,stat){
  const home=stat.home,away=stat.away;
  const rows=[
    ['Tirs cadrés','shots_on_goal'],['Tirs totaux','total_shots'],['Tirs dans la surface','shots_insidebox'],
    ['Expected goals','expected_goals'],['Possession','ball_possession'],['Corners','corner_kicks'],
    ['Cartons rouges','red_cards'],['Cartons jaunes','yellow_cards']
  ];
  const pairs=Object.fromEntries(rows.map(([label,k])=>[k,[betproLiveStat(home,k),betproLiveStat(away,k)]]));
  const available=rows.filter(([label,k])=>pairs[k][0]!=null&&pairs[k][1]!=null);
  const shotData=(pairs.shots_on_goal[0]!=null&&pairs.shots_on_goal[1]!=null)||(pairs.total_shots[0]!=null&&pairs.total_shots[1]!=null);
  const minute=betproLiveNum(m.minute),homeScore=betproLiveNum(m.score?.home),awayScore=betproLiveNum(m.score?.away);
  const dataHtml='<div class="betpro-real-live-stathead"><span>'+esc(m.home)+'</span><span>STATISTIQUES LIVE</span><span>'+esc(m.away)+'</span></div>'+
    available.map(([label,k])=>betproLiveEvidence(label,...pairs[k],k==='ball_possession'?' %':'')).join('');
  const onlyData={html:dataHtml};
  if(!shotData||available.length<3||minute==null||minute<12||homeScore==null||awayScore==null||m.status==='P')return{
    ...onlyData,abstain:true,reason:'Données insuffisantes pour une analyse approfondie : tirs, autres indicateurs et minute vérifiée requis. Aucun favori n’est déduit du seul score.'
  };
  const [hSog,aSog]=pairs.shots_on_goal,[hShot,aShot]=pairs.total_shots,[hBox,aBox]=pairs.shots_insidebox,
    [hXg,aXg]=pairs.expected_goals,[hPoss,aPoss]=pairs.ball_possession,[hCorner,aCorner]=pairs.corner_kicks,[hRed,aRed]=pairs.red_cards;
  const parts=[];
  const add=(a,b,denom,weight,label)=>{if(a!=null&&b!=null){const diff=(a-b)/denom;parts.push({label,signal:betproLiveClamp(diff,-1.5,1.5),weight,diff:a-b});}};
  add(hSog,aSog,3,.34,'tirs cadrés');add(hShot,aShot,7,.19,'tirs');add(hBox,aBox,5,.16,'occasions dans la surface');
  add(hXg,aXg,1,.36,'xG');add(hPoss,aPoss,25,.06,'possession');add(hCorner,aCorner,5,.07,'corners');
  const sumWeights=parts.reduce((a,b)=>a+b.weight,0);
  let pressure=sumWeights?parts.reduce((a,p)=>a+p.signal*p.weight,0)/sumWeights:0;
  const redDiff=hRed!=null&&aRed!=null?aRed-hRed:0;
  pressure=betproLiveClamp(pressure+.44*redDiff,-1.45,1.45);
  const maxMinute=['ET','BT'].includes(String(m.status||''))?120:90;
  const remaining=Math.max(1,maxMinute-minute);
  // Conditional scoring intensities. This is deliberately a transparent, uncalibrated
  // Poisson scenario model, not an empirical or market-calibrated probability of winning.
  const lHome=betproLiveClamp(1.38*remaining/90*Math.exp(.65*pressure),.008,4);
  const lAway=betproLiveClamp(1.15*remaining/90*Math.exp(-.65*pressure),.008,4);
  let homeWin=0,draw=0,awayWin=0,mass=0;
  for(let x=0;x<=12;x++)for(let y=0;y<=12;y++){
    const p=betproLivePoisson(x,lHome)*betproLivePoisson(y,lAway);mass+=p;
    if(homeScore+x>awayScore+y)homeWin+=p;
    else if(homeScore+x===awayScore+y)draw+=p;else awayWin+=p;
  }
  homeWin/=mass;draw/=mass;awayWin/=mass;
  const quality=betproLiveClamp(.3+available.length*.055+Math.min(1,(hSog||0)+(aSog||0))*0.014+Math.min(1,minute/65)*.13,.30,.90);
  const market=[{name:m.home,p:homeWin,kind:'home'},{name:'Match nul',p:draw,kind:'draw'},{name:m.away,p:awayWin,kind:'away'}].sort((a,b)=>b.p-a.p);
  const lead=market[0],margin=market[0].p-market[1].p;
  const verdict=margin<.095?'Issue très ouverte':lead.kind==='draw'?'Match nul le plus probable':lead.name;
  const explanations=[];
  const dynamic=parts.filter(x=>x.weight>=.15).sort((a,b)=>Math.abs(b.signal*b.weight)-Math.abs(a.signal*a.weight)).slice(0,3);
  for(const p of dynamic){
    if(Math.abs(p.diff)<.001)continue;
    explanations.push(`${p.label} : avantage ${p.diff>0?m.home:m.away} (${Math.abs(p.diff).toLocaleString('fr-FR')}).`);
  }
  if(redDiff!==0)explanations.unshift(`Supériorité numérique : ${redDiff>0?m.home:m.away} (${Math.abs(redDiff)} carton(s) rouge(s) d’écart).`);
  if(pressure>.22 && homeScore<awayScore)explanations.unshift(`${m.home} est mené mais exerce la pression statistique la plus forte.`);
  if(pressure<-.22 && awayScore<homeScore)explanations.unshift(`${m.away} est mené mais exerce la pression statistique la plus forte.`);
  explanations.push(`Temps réglementaire restant estimé : ${Math.max(0,Math.round(remaining))} min. Les scénarios tiennent compte du score, sans choisir automatiquement le leader.`);
  const topPct=(lead.p*100).toLocaleString('fr-FR',{maximumFractionDigits:1});
  return{...onlyData,abstain:false,verdict,predictedTop:topPct,home:homeWin,draw,away:awayWin,
    quality,explanations,dominant:pressure>0.18?m.home:pressure<-.18?m.away:'équilibrée',
    green:lead.p>=.70&&quality>=.65&&margin>=.15,
    method:'Simulation Poisson conditionnelle intégrant tirs, xG si disponibles, possession, corners et cartons. Hypothèses non calibrées sur un historique de matchs live.'};
}
function betproLiveEspnMetric(stats,keys){
  for(const k of keys){const key=Object.keys(stats||{}).find(x=>x===k||x.toLowerCase()===k.toLowerCase());if(key){const n=betproLiveNum(stats[key]);if(n!=null)return n;}}
  return null;
}
function betproLiveHeuristicOther(m,stat){
  const s=m.sport,home=stat.home,away=stat.away;
  const keys=s.includes('basketball')?[
    ['% tirs réussis',['fieldgoalpct','field_goal_pct','fg_pct']],['% tirs à trois points',['threepointpct','three_point_pct','threepointfieldgoalpct']],
    ['Rebonds',['totalrebounds','total_rebounds','rebounds']],['Passes décisives',['assists']],['Pertes de balle',['turnovers']]
  ]:s.includes('icehockey')?[
    ['Tirs',['shots','shotsongoal','shots_on_goal']],['Supériorités',['powerplays','power_play_goals']],['Mises en jeu gagnées',['faceoffwins','faceoffs_won']]
  ]:s.includes('americanfootball')?[
    ['Yards totaux',['totalyards','total_yards']],['Premières tentatives',['firstdowns','first_downs']],['3e tentatives réussies',['thirddowneff','third_down_efficiency']],['Pertes de balle',['turnovers']]
  ]:s.includes('baseball')?[
    ['Coups sûrs',['hits']],['Erreurs',['errors']],['Buts sur balles',['walks','bases_on_balls']]
  ]:[];
  const observations=[];
  for(const [label,aliases] of keys){const a=betproLiveEspnMetric(home,aliases),b=betproLiveEspnMetric(away,aliases);if(a!=null&&b!=null)observations.push({label,a,b});}
  const html='<div class="betpro-real-live-stathead"><span>'+esc(m.home)+'</span><span>STATISTIQUES LIVE</span><span>'+esc(m.away)+'</span></div>'+observations.map(o=>betproLiveEvidence(o.label,o.a,o.b)).join('');
  if(observations.length<3)return{html,abstain:true,reason:'L’API fournit le score et le chronomètre, mais pas assez de données de jeu indépendantes pour établir un pronostic professionnel. Aucun favori n’est fabriqué.'};
  const directions=observations.map(x=>({label:x.label,advantage:x.label==='Pertes de balle' || x.label==='Erreurs'?Math.sign(x.b-x.a):Math.sign(x.a-x.b)}));
  const balance=directions.reduce((n,x)=>n+x.advantage,0);
  const fav=Math.abs(balance)<2?null:balance>0?m.home:m.away;
  return {html,abstain:!fav,reason:!fav?'Les indicateurs du match sont contradictoires. Le moteur s’abstient.':null,
    verdict:fav?'Orientation statistique : '+fav:null,
    quality:betproLiveClamp(observations.length/8,.35,.65),green:false,
    explanations:observations.map(o=>`${o.label} : ${m.home} ${o.a} / ${m.away} ${o.b}.`),
    method:'Comparaison multi-indicateurs non calibrée. Aucun pourcentage de victoire n’est calculé sans modèle validé pour ce sport.'};
}

// Dedicated match-direction assessment. This is a sports trend signal, never a
// fabricated bookmaker quote or a claim of positive betting expected value.
function betproLiveTrendDetails(m,stat,analysis,fetchedAt){
  const sport=String(m.sport||''),home=stat?.home||{},away=stat?.away||{};
  const specs=sport==='soccer'?[
    ['xG',['expected_goals','expectedgoals','xg'],.65,3.4,1],
    ['Tirs cadrés',['shots_on_goal','shots_on_target','shotsontarget','shotsongoal'],3,3,1],
    ['Tirs dans la surface',['shots_insidebox','shotsinsidebox','shots_in_box'],4,2,1],
    ['Tirs totaux',['total_shots','totalshots','shots'],7,1.3,1],
    ['Corners',['corner_kicks','corners','cornerkicks'],4,.65,1],
    ['Possession',['ball_possession','possession','possessionpct'],18,.35,1],
    ['Cartons rouges',['red_cards','redcards'],1,2.7,-1]
  ]:sport.includes('basketball')?[
    ['% tirs réussis',['fieldgoalpct','field_goal_pct','fg_pct'],13,2.6,1],
    ['% à trois points',['threepointpct','three_point_pct','threepointfieldgoalpct'],18,1,1],
    ['Rebonds',['totalrebounds','total_rebounds','rebounds'],12,1.3,1],
    ['Passes décisives',['assists'],9,1.2,1],
    ['Pertes de balle',['turnovers'],5,1.8,-1]
  ]:sport.includes('icehockey')?[
    ['Tirs cadrés',['shots','shotsongoal','shots_on_goal','shots_on_target'],10,2.6,1],
    ['Mises en jeu gagnées',['faceoffwins','faceoffs_won'],12,.7,1],
    ['Supériorités numériques',['powerplays','power_play_goals'],2,.8,1]
  ]:sport.includes('americanfootball')?[
    ['Yards gagnés',['totalyards','total_yards'],130,2.1,1],
    ['Premières tentatives',['firstdowns','first_downs'],8,1.6,1],
    ['3e tentatives réussies',['thirddowneff','third_down_efficiency'],18,.7,1],
    ['Pertes de balle',['turnovers'],2,2.6,-1]
  ]:sport.includes('baseball')?[
    ['Coups sûrs',['hits'],4,2.2,1],
    ['Buts sur balles',['walks','bases_on_balls'],3,.6,1],
    ['Erreurs',['errors'],1,1.6,-1]
  ]:[];
  const observations=[];
  for(const [label,names,scale,weight,polarity] of specs){
    const h=betproLiveEspnMetric(home,names),a=betproLiveEspnMetric(away,names);
    if(h===null||a===null)continue;
    const difference=(h-a)*polarity;
    const signal=betproLiveClamp(difference/scale,-1.4,1.4);
    observations.push({label,home:h,away:a,signal,weight,importance:Math.abs(signal*weight)});
  }
  const weightSum=observations.reduce((s,x)=>s+x.weight,0);
  const balance=weightSum?observations.reduce((s,x)=>s+x.signal*x.weight,0)/weightSum:0;
  const side=balance>.0001?1:balance<-.0001?-1:0;
  const supportive=observations.filter(x=>x.signal*side>=.22).length;
  const opposing=observations.filter(x=>x.signal*side<-.22).length;
  const highValue=observations.some(x=>x.weight>=1.6&&x.signal*side>=.18);
  const valid=observations.length>=2&&side!==0&&supportive>=2&&highValue&&Math.abs(balance)>=.22;
  const strong=valid&&observations.length>=3&&supportive>=3&&Math.abs(balance)>=.46&&opposing<=1;
  const staleMs=Date.now()-Date.parse(fetchedAt||'');
  const stale=!Number.isFinite(staleMs)||staleMs<0||staleMs>150000;
  const paused=['HT','INT','BT','P'].includes(String(m.status||'').toUpperCase());
  const selected=valid?(side>0?m.home:m.away):null;
  const sorted=observations.filter(x=>x.signal*side>.15).sort((x,y)=>y.importance-x.importance).slice(0,3);
  const evidence=sorted.map(x=>`${x.label} : ${x.home} à ${x.away}`).join(' · ');
  const grade=stale?'actualiser':paused?'pause':strong?'fort':valid?'modere':observations.length>=2?'equilibre':'limite';
  const name=grade==='fort'?'TENDANCE FORTE':grade==='modere'?'AVANTAGE STATISTIQUE':grade==='equilibre'?'MATCH PARTAGÉ':grade==='limite'?'DONNÉES LIMITÉES':grade==='pause'?'MATCH EN PAUSE':'ACTUALISER LES DONNÉES';
  const direction=selected?'Avantage observé : '+selected:observations.length>=2?'Aucun avantage net entre les deux équipes':'Impossible de conclure à partir des statistiques disponibles';
  const scoreHome=betproLiveNum(m.score?.home),scoreAway=betproLiveNum(m.score?.away);
  const contrary=selected&&scoreHome!==null&&scoreAway!==null&&((side>0&&scoreHome<scoreAway)||(side<0&&scoreAway<scoreHome));
  const time=betproLiveTimeLabel(m)||'Chronomètre indisponible';
  const reason=grade==='actualiser'?'Le dernier relevé statistique a dépassé 2 min 30. Il faut l’actualiser.'
    :grade==='pause'?'Jeu momentanément arrêté : vérifier la tendance après la reprise.'
    :valid?`${supportive} indicateurs favorables${opposing?' et '+opposing+' contradictoire(s)':''}. ${contrary?'L’équipe dominante est néanmoins menée au score.':'La domination est fondée sur le jeu, pas seulement sur le score.'}`
    :observations.length>=2?'Les indicateurs disponibles ne montrent pas de supériorité suffisamment concordante.':'La source ne fournit pas encore deux indicateurs de jeu comparables.';
  return {grade,name,selected,direction,time,reason,evidence,metrics:observations.length,valid,strong,stale,paused};
}
function betproLiveSimpleTiming(m,analysis,statsFetchedAt,stat){
  const trend=betproLiveTrendDetails(m,stat,analysis,statsFetchedAt);
  const state=trend.grade==='fort'||trend.grade==='modere'?'positive':trend.grade==='actualiser'||trend.grade==='pause'?'wait':'neutral';
  return `<div class="betpro-live-decision ${state}" role="status">
    <span class="betpro-live-decision-label">${esc(trend.name)}${trend.selected?' · '+esc(trend.selected):''}</span>
    <p><strong>Direction :</strong> ${esc(trend.direction)}</p>
    <p><strong>Moment :</strong> ${esc(trend.time)} · ${trend.stale?'Actualisation nécessaire':trend.paused?'Contrôler à la reprise':trend.valid?'Vérifier la persistance au prochain relevé':'Attendre de nouvelles statistiques'}</p>
    ${trend.evidence?`<p><strong>Indices :</strong> ${esc(trend.evidence)}</p>`:''}
    <p><strong>Interprétation :</strong> ${esc(trend.reason)}</p>
    <p class="betpro-live-market-note"><strong>Rentabilité du pari :</strong> cote en direct non vérifiée ; aucun avantage financier démontré. La tendance sportive ne signifie pas « JOUER ».</p>
  </div>`;
}
async function betproAnalyzeRealLive(key,button){
  const m=betproLiveFixtureSnapshots.get(key);
  if(!m){toast('Rencontre non disponible : actualisez le direct.','err');return;}
  const el=document.getElementById('betpro-live-analysis-'+m.fixture_id+'-'+m.sport);
  if(!el)return;
  if(Date.now()-m._loadedAt>150000){el.innerHTML='<div class="warn">Le score n’est plus assez récent. Actualisez le Live avant de lancer une nouvelle analyse.</div>';return;}
  button.disabled=true;button.textContent='Analyse statistique en cours…';
  el.innerHTML='<div class="ls"><div class="sp"></div><p>Chargement des statistiques officielles…</p></div>';
  try{
    const query=new URLSearchParams({source:m.source,fixture:String(m.fixture_id),sport:m.sport});
    const d=await api('/api/live/analysis?'+query.toString(),'GET',null,{timeoutMs:16000});
    if(!d?.ok)throw Error(d?.error||'Statistiques non disponibles');
    const stats=betproLiveStatsForMatch(m,d);
    if(!stats){el.innerHTML='<div class="info">Les deux équipes ne sont pas identifiables avec certitude dans les statistiques reçues. Aucune prédiction non vérifiée.</div>';return;}
    const a=m.sport==='soccer'?betproLiveHeuristicFootball(m,stats):betproLiveHeuristicOther(m,stats);
    const date=d.fetched_at?betproClassicDate(d.fetched_at):'non transmis';
    const disclaimer='<div class="betpro-live-footnote">Analyse indicative à partir de statistiques observées. Les estimations ne sont pas calibrées sur un historique indépendant et ne remplacent pas des cotes live vérifiées. Aucune recommandation de mise automatique.</div>';
    if(a.abstain){el.innerHTML=`<div class="betpro-real-live-panel">${betproLiveSimpleTiming(m,a,d.fetched_at,stats)}<strong>ANALYSE PROBABILISTE LIMITÉE</strong><p>${esc(a.reason)}</p>${a.html}${disclaimer}<small>Dernières statistiques : ${esc(date)}</small></div>`;return;}
    const pct=x=>(100*x).toLocaleString('fr-FR',{maximumFractionDigits:1})+' %';
    const probs=a.home!=null?`<div class="betpro-real-live-outcomes"><span>${esc(m.home)} : ${pct(a.home)}</span><span>Nul : ${pct(a.draw)}</span><span>${esc(m.away)} : ${pct(a.away)}</span></div>`:'';
    el.innerHTML=`<div class="betpro-real-live-panel ${a.green?'betpro-real-live-strong':''}">${betproLiveSimpleTiming(m,a,d.fetched_at,stats)}<div class="betpro-real-live-verdict">${a.green?'SIGNAL STATISTIQUE FORT':'ANALYSE LIVE DÉTAILLÉE'}<strong>${esc(a.verdict)}</strong></div>
      ${a.predictedTop?`<p>Scénario dominant du modèle : ${esc(a.predictedTop)}. Ce chiffre est une simulation heuristique, pas une probabilité calibrée.</p>`:''}
      ${probs}${a.html}
      <div class="betpro-real-live-reasons">${(a.explanations||[]).map(x=>'<p>• '+esc(x)+'</p>').join('')}</div>
      <div class="betpro-real-live-method">Méthode : ${esc(a.method)}</div>
      ${disclaimer}<small>Statistiques reçues : ${esc(date)}</small></div>`;
  }catch(err){el.innerHTML='<div class="warn">Analyse indisponible : '+esc(err.message||String(err))+'. Aucun pronostic n’est extrapolé du seul score.</div>';}
  finally{button.disabled=false;button.textContent='Actualiser l’analyse de ce match';}
}

async function loadLiveBenter(){return betproLoadRealLive('live-cnt');}

let upcTab='h', upcHours=12, upcDays=1;
function setUpcomingTab(t){upcTab=t;['h','d','date'].forEach(x=>{document.getElementById('upc-tab-'+x)?.classList.toggle('on',x===t);document.getElementById('upc-panel-'+x).style.display=x===t?'block':'none';});}
function selectHours(h){upcHours=h;['3','6','12','24'].forEach(x=>document.getElementById('h-btn-'+x)?.classList.toggle('on',String(h)===x));}
function selectDays(d){upcDays=d;['1','3','7'].forEach(x=>document.getElementById('d-btn-'+x)?.classList.toggle('on',String(d)===x));}

async function loadUpcomingBenter(){
  const cnt=document.getElementById('upcoming-cnt');
  cnt.innerHTML='<div class="ls"><div class="sp"></div><p>Chargement à venir…</p></div>';
  try{
    const promises=getLiveAllLeagues().filter(l=>!isLeagueExcluded(l.sport)).slice(0,14).map(({sport,market})=>
      api('/api/analyze?sport='+enc(sport)+'&market='+enc(market)+'&mode=quick')
        .then(d=>(d.opportunities||[]).map(o=>({...o,_sport:sport})))
        .catch(()=>[])
    );
    const results=await Promise.all(promises);
    let all=[];results.forEach(r=>all=[...all,...r]);
    const now=new Date();
    let horizon=upcTab==='h'?upcHours*60:upcDays*24*60;
    if(upcTab==='date'){
      const from=document.getElementById('upc-from').value,to=document.getElementById('upc-to').value;
      if(from&&to){const fromD=new Date(from),toD=new Date(to);all=all.filter(o=>{const st=new Date(o.start_time||0);return st>=fromD&&st<=toD;});}
    } else {
      all=all.filter(o=>{const st=o.start_time;if(!st)return true;const diff=(new Date(st)-now)/60000;return diff>=0&&diff<=horizon;});
    }
    const seen=new Set();
    all=all.filter(o=>{const k=(o.home_team||'')+'|'+(o.away_team||'')+'|'+(o.market||'');if(seen.has(k))return false;seen.add(k);return true;});
    all=all.filter(o=>(o.score?.total||0)>=60);
    all.forEach(o=>{o._dir=computeDirection(o).direction;});
    all=all.filter(o=>o._dir==='play');
    all.sort((a,b)=>{
      const ta=a.start_time?new Date(a.start_time).getTime():Infinity;
      const tb=b.start_time?new Date(b.start_time).getTime():Infinity;
      if(Math.abs(ta-tb)>3600000) return ta-tb;
      return (b.score?.total||0)-(a.score?.total||0);
    });
    if(!all.length){cnt.innerHTML='<div class="empty"><div class="empty-i">📅</div><div class="empty-t">Aucun match à venir trouvé</div></div>';return;}
    cnt.innerHTML=`<div class="sbar"><div class="sdot"></div><span>${all.length} match(s) à venir avec direction</span></div>`;
    cnt.innerHTML+='<div class="opp-grid">'+all.map((o,i)=>renderDirectionCard(o,i,'upc')).join('')+'</div>';
  }catch(e){cnt.innerHTML=`<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ ${esc(e.message)}</div></div>`;}
}

// Le suivi des résultats ne s'active que par une sélection explicite.
const betproFollowCatalog=new Map();
let betproFollowSelected=new Set();
function betproFollowIdentifier(c){
 const t=[c.engine,c.sport,c.home,c.away,c.startTime,c.market,c.selection,c.line??'']
  .join('|').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 let a=2166136261,b=2654435761;
 for(let i=0;i<t.length;i++){a=Math.imul(a^t.charCodeAt(i),16777619);b=Math.imul(b^t.charCodeAt(i),2246822519);}
 return 'follow_'+(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
function betproFollowBenterPayload(o){
 return{engine:'Benter',sport:String(o.sport||o._sport||''),home:String(o.home_team||''),away:String(o.away_team||''),
 market:String(o.market||''),selection:String(o.selection||''),line:o.line??null,odds:o.odds??null,
 startTime:o.start_time||o.commence_time||'',competition:String(o.competition||o.sport_title||'')};
}
function betproFollowClassicPayload(m){
 const c=m.consensus||{},odds=Number(m.classic_value?.best_price)>1?Number(m.classic_value.best_price):Number(c.median_market_odds);
 return{engine:'Classique',sport:String(m.sport||''),home:String(m.home_name||m.home||''),away:String(m.away_name||m.away||''),
 market:'h2h',selection:c.choice==='draw'?'draw':String(c.favorite||''),line:null,odds:Number.isFinite(odds)?odds:null,
 startTime:m.start_time||m.event_start_at||'',competition:String(m.competition||m.sport_label||'')};
}
function betproFollowPaint(){
 document.querySelectorAll('[data-betpro-follow-id]').forEach(el=>{
  if(el.disabled)return;const selected=betproFollowSelected.has(el.dataset.betproFollowId);
  el.classList.toggle('is-followed',selected);el.setAttribute('aria-pressed',selected?'true':'false');
  el.textContent=selected?'✓ Retirer du suivi':'Suivre le résultat';
 });
}
async function betproFollowRefresh(){
 try{const d=await api('/api/results/tracked','GET',null,{noCache:true,timeoutMs:15000});
  if(!d?.ok)throw Error(d?.error||'Suivi non disponible');
  betproFollowSelected=new Set((d.items||[]).map(x=>x.id));betproFollowPaint();
 }catch(e){console.warn('Suivi non disponible',e?.message||e);}
}
async function betproToggleFollow(btn,id){
 if(!btn||btn.disabled)return;
 const card=betproFollowCatalog.get(id);
 if(!card){toast('Sélection indisponible : relance un scan.','err');return;}
 const remove=betproFollowSelected.has(id);btn.disabled=true;btn.textContent='Enregistrement…';
 try{const d=await api('/api/results/tracked','POST',{action:remove?'remove':'add',card},{timeoutMs:20000});
  if(!d?.ok)throw Error(d?.error||'Enregistrement impossible');
  betproFollowSelected=new Set((d.items||[]).map(x=>x.id));
  toast(remove?'Pronostic retiré du suivi.':'Pronostic ajouté au suivi.','ok');
  if(document.getElementById('s-results')?.classList.contains('on'))loadResults();
 }catch(e){toast(e?.message||'Erreur de suivi','err');}
 finally{btn.disabled=false;betproFollowPaint();}
}
function betproEnhanceScanFollow(containerId,items,engine){
 const wrap=document.getElementById(containerId);if(!wrap||!Array.isArray(items))return;
 const cards=[...wrap.querySelectorAll('.opp-grid > .dir-card')];
 for(let i=0;i<items.length;i++){
  const el=engine==='Benter'?wrap.querySelector('#dc-scan-res-'+i):cards[i];if(!el)continue;
  const body=el.querySelector('.dir-body')||el.children[1];if(!body)continue;
  const data=engine==='Benter'?betproFollowBenterPayload(items[i]):betproFollowClassicPayload(items[i]);
  if(!data.home||!data.away||!data.selection||!Number.isFinite(Date.parse(data.startTime)))continue;
  const id=betproFollowIdentifier(data),card={...data,id};betproFollowCatalog.set(id,card);
  const button=document.createElement('button');button.type='button';button.className='betpro-follow-btn';
  button.dataset.betproFollowId=id;button.setAttribute('aria-pressed','false');
  button.textContent='Suivre le résultat';
  button.addEventListener('click',event=>{event.stopPropagation();betproToggleFollow(button,id);});
  body.appendChild(button);
 }
 betproFollowPaint();
 betproFollowRefresh();
}
// Module Classique : séparation stricte du code et des résultats Benter.
const BETPRO_CLASSIC_UI_VERSION='v117-dual-live-isolated';
let betProActiveEngine='classic';
let betProClassicScanSeq=0,betProClassicLiveSeq=0,betProClassicUpcomingSeq=0;
function setBetProEngine(engine){
  if(engine!=='classic'&&engine!=='benter')return;
  betProActiveEngine=engine;
  try{sessionStorage.setItem('betpro-live-engine-v1',engine)}catch(_){ }
  const isClassic=engine==='classic';
  const switchDisplay=(id,show)=>{const el=document.getElementById(id);if(el)el.style.display=show?'':'none';};
  switchDisplay('scan-res',!isClassic);switchDisplay('scan-classic-res',isClassic);
  switchDisplay('live-cnt',!isClassic);switchDisplay('live-classic-cnt',isClassic);
  switchDisplay('upcoming-cnt',!isClassic);switchDisplay('upcoming-classic-cnt',isClassic);
  document.getElementById('scan-classic-btn')?.classList.toggle('engine-selected',isClassic);
  document.getElementById('scan-btn')?.classList.toggle('engine-selected',!isClassic);
  document.getElementById('live-switch-classic')?.classList.toggle('on',isClassic);
  document.getElementById('live-switch-benter')?.classList.toggle('on',!isClassic);
  const label=document.getElementById('scan-engine-indicator');
  if(label)label.textContent=isClassic?'Mode Classique sélectionné : consensus bookmakers, sans Benter.':'Mode Benter sélectionné : règles et filtres scientifiques du système existant.';
  const liveLabel=document.getElementById('live-engine-explanation');
  if(liveLabel)liveLabel.textContent=isClassic?'Direct : résultats et statistiques confirmés, sans mélanger le calendrier des rencontres. Analyse in-play indépendante du scan Classique.':'Direct : résultats et statistiques confirmés, analyse in-play indépendante du moteur Benter historique.';
  if(document.getElementById('s-live')?.classList.contains('on')){loadLive();loadUpcoming();}
}
function betproClassicPct(value){const v=Number(value);return Number.isFinite(v)&&v>=0&&v<=1?(v*100).toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1})+' %':'—';}
function betproClassicDate(value){
  const d=new Date(value||'');
  if(!Number.isFinite(d.getTime()))return 'Horaire de coup d’envoi non transmis';
  return d.toLocaleString('fr-FR',{timeZone:'Europe/Paris',weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function betproLiveMinuteLabel(match){
  const code=String(match?.status||match?.match_status||'').toUpperCase();
  if(code==='HT')return 'Mi-temps';
  if(['FT','AET','PEN'].includes(code))return 'Terminé';
  const raw=match?.minute;
  if(raw===null||raw===undefined||raw==='')return '';
  const min=Number(raw);
  if(!Number.isFinite(min)||min<0||min>200)return '';
  const extra=Number(match.extra_minute);
  if(min===0)return 'Coup d’envoi';
  return String(Math.floor(min))+(Number.isFinite(extra)&&extra>0&&extra<=30?'+'+Math.floor(extra):'')+'e minute';
}
function betproClassicSportIcon(sport){const x=String(sport||'').toLowerCase();return x.includes('soccer')?'⚽':x.includes('basket')?'🏀':x.includes('tennis')?'🎾':x.includes('hockey')?'🏒':x.includes('baseball')?'⚾':x.includes('handball')?'🤾':x.includes('volley')?'🏐':x.includes('rugby')?'🏉':x.includes('mma')||x.includes('box')?'🥊':x.includes('americanfootball')?'🏈':'🏆';}
// Carte Classique : mêmes classes, mêmes couleurs et même composition que la
// carte historique rendue par renderDirectionCard du HTML fourni par l'utilisateur.
// Aucun passage par computeDirection ou les probabilités du moteur Benter.
function betproClassicToggleCard(el,evt){
  if(evt&&evt.target.closest('button,a,input'))return;
  el.classList.toggle('xp');
  el.setAttribute('aria-expanded',el.classList.contains('xp')?'true':'false');
}
function betproClassicCard(match,idx){
  const c=match.consensus||{},ind=match.indicative||{},verified=c.status==='ok',oneSource=!verified&&ind.status==='single_source',archived=!verified&&ind.status==='historical';
  const quote=verified?c:(oneSource||archived)?ind:null,hasMarket=!!quote;
  const home=String(match.home_name||match.home||'?'),away=String(match.away_name||match.away||'?');
  const competition=String(match.competition||match.sport_label||match.sport||'Rencontre');
  const score=match.score||null,scoreKnown=!!score&&(score.home!=null||score.away!=null);
  const isLive=!!match.is_live;
  const startValue=match.start_time||match.event_start_at;
  const start=startValue?betproClassicDate(startValue):(isLive?'En direct · coup d’envoi non transmis':'Horaire à confirmer'),sport=String(match.sport||'');
  const liveMinute=betproLiveMinuteLabel(match);
  const marketValue=verified?match.classic_value:null;
  const consistency=verified&&Number.isFinite(Number(c.consensus_score))?Math.max(0,Math.min(95,Math.round(Number(c.consensus_score)))):null;
  const positiveValue=verified&&!!marketValue?.positive_value;
  const bookmakerAgreement=verified&&Number(c.bookmakers||0)>0?Number(c.agreement||0)/Number(c.bookmakers):0;
  const highMarketProbability=verified&&Number(c.probability||0)>=BETPRO_CLASSIC_GREEN_MARKET_PROBABILITY
    &&consistency>=70&&Number(c.bookmakers||0)>=2&&bookmakerAgreement>=.65;
  const strongConsensus=verified&&consistency>=75&&Number(c.bookmakers||0)>=3
    &&bookmakerAgreement>=.66&&Number(c.probability||0)>=(c.draw_included?.42:.52);
  const strong=highMarketProbability||strongConsensus;
  const tier=strong?'dir-play':'dir-watch';
  const color=strong?'var(--gr)':'var(--am)';
  const verdict=highMarketProbability?'FAVORI À FORTE PROBABILITÉ':strongConsensus?'CONSENSUS BOOKMAKERS FORT':verified?'TENDANCE DES BOOKMAKERS':archived?'ANCIENNES COTES DE MARCHÉ':oneSource?'INDICATION DE MARCHÉ':isLive?'RENCONTRE EN DIRECT':'RENCONTRE À SUIVRE';
  const headValue=highMarketProbability?Math.round(Number(c.probability)*100)+' %':verified&&consistency!==null?consistency+'/100':archived?'ARCHIVE':oneSource?'1 source':isLive?'LIVE':'PROGRAMMÉ';
  const headCaption=highMarketProbability?'probabilité de marché':verified&&consistency!==null?'cohérence des cotes':archived?'cote ancienne':oneSource?'cote isolée':'statut';
  const fav=hasMarket?String(quote.favorite||''):'',prob=hasMarket?betproClassicPct(quote.probability):'';
  const price=verified?(Number(marketValue?.best_price)>1?Number(marketValue.best_price):Number(c.median_market_odds||0)):Number(ind.market_odds||0);
  const priceDisplay=Number.isFinite(price)&&price>1?price.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}):null;
  const quoteRows=Array.isArray(match.bookmaker_quotes)?match.bookmaker_quotes.filter(v=>Number(v.odds)>1).slice(0,8):[];
  const n=verified?Number(c.bookmakers||0):(oneSource||archived)?Number(ind.source_count||1):0;
  const marketType=(c.draw_included||quote?.draw_probability!=null||/^(soccer_|handball_)/.test(sport))?'1X2':'Gagnant';
  const bettingLabel=verified?'Favori estimé par le marché':archived?'Probabilité déduite d’anciennes cotes, non actualisée':oneSource?'Tendance d’un bookmaker':scoreKnown?'Score en direct':'Rencontre enregistrée';
  const chosenLabel=hasMarket?fav:scoreKnown?`${score.home??'–'} – ${score.away??'–'}`:'Match à venir';
  const oddsBlock=priceDisplay?`<span class="dir-odds">@ ${priceDisplay}</span>`:'';
  const pBlock=hasMarket?`<span class="dir-prob" style="color:#cdd9e8">${archived?'Prob. historique estimée':'Probabilité de marché'} : ${prob}</span>`:'';
  const evBlock=positiveValue&&marketValue?`<span class="dir-ev pos">EV théorique +${esc(Number(marketValue.estimated_ev_pct).toLocaleString('fr-FR',{maximumFractionDigits:1}))} %</span>`:'';
  const details=verified?
   `Consensus de ${n} bookmaker(s) indépendants. Accord sur le favori : ${Number(c.agreement)||0}/${n}. Les probabilités proviennent des cotes corrigées de la marge, pas du modèle Benter.`:
   archived?`Probabilités tirées des dernières cotes historiques disponibles, observées le ${esc(betproClassicDate(ind.last_odds_at))}. Elles ne reflètent pas nécessairement le marché actuel et ne sont pas validées par Benter.`:
   oneSource?`Estimation normalisée tirée d’une seule cote complète (${esc(ind.bookmaker||'opérateur')}). Elle n’est pas confirmée par un second bookmaker.`:
   `Rencontre enregistrée pour ${esc(start)}. Le score et les cotes ne sont affichés que lorsque des observations réelles existent.`;
  const probabilities=hasMarket?`<div style="margin:9px 0 10px;display:flex;gap:6px;flex-wrap:wrap">
    <span class="bdg bsp">${esc(home)} ${betproClassicPct(quote.home_probability)}</span>
    ${quote.draw_probability!=null?`<span class="bdg bca">Nul ${betproClassicPct(quote.draw_probability)}</span>`:''}
    <span class="bdg bsp">${esc(away)} ${betproClassicPct(quote.away_probability)}</span>
  </div>`:'';
  const bookieDetails=quoteRows.length?`<div style="margin:0 0 10px">
     <div style="font-size:9px;color:var(--dm);font-family:var(--mo);text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">Bookmakers (${quoteRows.length})</div>
     ${quoteRows.map((v,k)=>`<div class="om-bm-row"><span style="flex:1;color:#dce8fa">${esc(v.bookmaker)}</span><span style="font-family:var(--mo);font-weight:700;color:${k===0?'var(--gr)':'#d0d9ec'}">${Number(v.odds).toFixed(2)}</span>${k===0?'<span style="background:rgba(0,255,157,.15);color:var(--gr);border-radius:3px;font-size:9px;font-family:var(--mo);padding:1px 5px;font-weight:700">BEST</span>':''}</div>`).join('')}
  </div>`:'';
  const verifiedStats=verified?`<div style="margin-bottom:8px">
    ${ssRow('Indice de cohérence',consistency??0)}
    ${ssRow('Accord bookmakers',n?Math.round(100*(Number(c.agreement||0)/n)):0)}
    ${ssRow('Probabilité du favori',Math.round(Number(c.probability||0)*100))}
  </div>`:'';
  const realScore=scoreKnown?`<span class="bdg blv" style="font-weight:800">Score ${esc(String(score.home??'–'))} : ${esc(String(score.away??'–'))}</span>`:'';
  const footnote=highMarketProbability?'Vert = probabilité de marché élevée (≥75 %), pas une garantie de rendement. Vérifier la cote chez le bookmaker.':verified?'Consensus de marché indicatif, non validé par Benter. Aucun gain garanti.':archived?'Ancienne cote, indicative seulement, susceptible d’avoir changé.':oneSource?'Une seule source : indication exploratoire, pas une validation indépendante.':'Les cotes manquantes ne sont jamais inventées.';
  return `<div class="dir-card ${tier}" data-engine="classic" data-sport-key="${esc(sport)}" data-tier="${strong?'strong':'moderate'}" role="button" tabindex="0" aria-expanded="false"
      onclick="betproClassicToggleCard(this,event)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();betproClassicToggleCard(this,event)}">
    <div class="dir-banner"><span style="font-size:10px;font-weight:700">${verdict}</span>
      <span style="margin-left:auto;font-family:var(--mo);font-size:15px;font-weight:700;color:${color}">${headValue}</span>
      <span style="font-family:var(--mo);font-size:9px;color:${color};opacity:.75;margin-left:4px">${headCaption}</span></div>
    <div class="dir-body"><div class="dir-match">${betproClassicSportIcon(sport)} ${esc(home)} <span style="color:var(--dm)">vs</span> ${esc(away)}</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px"><span class="bdg bsp">${esc(competition)}</span><span class="bdg bmk">${marketType}</span>
      <span class="bdg bsr">${esc(start)}</span>${isLive?'<span class="bdg blv">EN DIRECT</span>':''}${isLive&&liveMinute?`<span class="bdg blv" style="font-weight:800">${esc(liveMinute)}</span>`:''}${realScore}</div>
      <div class="dir-sel"><span class="dir-sel-name">${esc(chosenLabel)}</span>${oddsBlock}${pBlock}${evBlock}</div>
      <div style="font:500 10px var(--mo);color:#cbd6e9;margin-top:5px">${bettingLabel}</div>
    </div>
    <div class="dir-detail"><div style="background:linear-gradient(135deg,rgba(245,158,11,.02),rgba(0,212,255,.03));border:1px solid ${strong?'rgba(0,255,157,.12)':'rgba(245,158,11,.2)'};border-radius:6px;padding:12px;margin-bottom:10px">
      <div style="font-size:9px;color:#b7c5df;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;font-family:var(--mo);font-weight:700">Pourquoi cette tendance ?</div>
      <div style="font-size:11px;color:#dce6f7;line-height:1.7">${details}</div>
      ${probabilities}
      ${verified&&marketValue&&Number.isFinite(Number(marketValue.estimated_ev_pct))?`<div style="font-size:10px;color:#cad5e9">Meilleure cote : ${priceDisplay||'–'} (${esc(marketValue.best_bookmaker||'')}) · EV indicative ${esc(Number(marketValue.estimated_ev_pct).toFixed(1))} %. Calculée avec les mêmes cotes.</div>`:''}
    </div>${bookieDetails}${verifiedStats}
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px"><span style="font-size:10px;color:#becde3">${footnote}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${bookieLinkHtml()}<button class="copy-btn" onclick="event.stopPropagation();copyTeamNames(this)" data-home="${esc(home)}" data-away="${esc(away)}">&#128203; Copier</button></div>
      </div>
    </div>
  </div>`;
}

// Le Scan Classique affiche uniquement des cotes pre-match encore exploitables.
// Les rencontres sans cotes, les archives et les simples programmes restent
// disponibles dans les rubriques de calendrier, pas dans les resultats du scan.
const BETPRO_CLASSIC_GREEN_MARKET_PROBABILITY = 0.75;
function betproClassicIsActionable(match,now=Date.now()){
  const c=match?.consensus||{};
  const start=Date.parse(match?.start_time||match?.event_start_at||'');
  const observed=Date.parse(c.last_odds_at||'');
  const quotedPrice=Number(match?.classic_value?.best_price)>1
    ? Number(match.classic_value.best_price) : Number(c.median_market_odds);
  const maxAge=start-now<=86400000?21600000:86400000;
  const status=String(match?.status||'').toLowerCase();
  return c.status==='ok'&&Number(c.bookmakers)>=2
    &&['home','away','draw'].includes(c.choice)
    &&String(c.favorite||'').trim().length>0
    &&Number(c.probability)>0&&Number(c.probability)<1
    &&Number.isFinite(quotedPrice)&&quotedPrice>1.001
    &&Number.isFinite(start)&&start>now+120000
    &&Number.isFinite(observed)&&observed<=now+30000
    &&observed>=now-maxAge&&observed<start
    &&!['final','cancelled','canceled','ended','finished','ft','aet','pen'].includes(status);
}


async function doClassicScan(){
  setBetProEngine('classic');
  const seq=++betProClassicScanSeq,btn=document.getElementById('scan-classic-btn'),cnt=document.getElementById('scan-classic-res');if(!cnt||!btn)return;
  btn.disabled=true;document.getElementById('scan-classic-txt').textContent='SCAN LIVE CLASSIQUE';
  cnt.innerHTML='<div class="ls"><div class="sp"></div><p>Récupération des rencontres et comparaison des bookmakers internationaux…</p></div>';
  try{
    const dateParams=getScanDateParams(),selected=liveSportFilter==='all'?['all']:liveSportFilter.split(',').filter(Boolean);
    const responses=await Promise.allSettled(selected.map(sport=>{
      const params=new URLSearchParams({scope:'scan',sport,limit:'75',...dateParams});
      return api('/api/classic/scan?'+params,'GET',null,{timeoutMs:25000});
    }));
    const good=responses.filter(r=>r.status==='fulfilled'&&r.value?.ok).map(r=>r.value);
    const d=good.length?{ok:true,events:[...new Map(good.flatMap(x=>x.events||[]).map(x=>[String(x.event_id||x.sport+':'+x.home_name+':'+x.away_name),x])).values()],
      candidate_events:good.reduce((n,x)=>n+Number(x.candidate_events||0),0),generated_at:good[0].generated_at,rescue_warnings:good.flatMap(x=>x.rescue_warnings||[]),supported_sports:[...new Set(good.flatMap(x=>x.supported_sports||[]))],quota_blocked:good.some(x=>x.quota_blocked)}
      :{ok:false,error:'Aucune source de cotes disponible pour les sports sélectionnés.'};
    if(seq!==betProClassicScanSeq)return;
    if(!d?.ok)throw Error(d?.error||'Scan classique indisponible');
    const candidates=Array.isArray(d.events)?d.events:[];
    const identified=Math.max(candidates.length,Number(d.candidate_events||0));
    const now=Date.now();
    const events=candidates.filter(e=>betproClassicIsActionable(e,now))
      .sort((a,b)=>{
        const strongA=Number(a.consensus?.probability)>=BETPRO_CLASSIC_GREEN_MARKET_PROBABILITY?1:0;
        const strongB=Number(b.consensus?.probability)>=BETPRO_CLASSIC_GREEN_MARKET_PROBABILITY?1:0;
        return strongB-strongA||Number(b.classic_value?.positive_value||0)-Number(a.classic_value?.positive_value||0)
          ||Number(b.consensus?.consensus_score||0)-Number(a.consensus?.consensus_score||0);
      });
    const missingProvider=selected.filter(x=>['icehockey','tennis','rugby','handball','baseball','volleyball'].includes(x)&&!(d.supported_sports||[]).includes(x));
    const d1Limit=(d.rescue_warnings||[]).some(x=>/D1_ERROR|daily row write limit|exceeded D1/i.test(x?.reason||''));
    const issue=events.length===0&&d1Limit?'Limite quotidienne d’écriture Cloudflare D1 atteinte. Le rattrapage des cotes est suspendu temporairement, sans fabriquer de cartes.':
      events.length===0&&d.quota_blocked?'Budget de crédits Odds API protégé. Les appels supplémentaires sont suspendus.':
      events.length===0&&missingProvider.length?'Aucune compétition active chez le fournisseur de cotes pour : '+missingProvider.join(', ')+'.':'';
    const warning=issue?'<div class="warn" style="margin-bottom:11px">'+esc(issue)+'</div>':'';
    const warn='<div class="classic-subtext" style="margin-bottom:12px">Analyse indépendante de Benter : consensus de bookmakers, sans garantie de victoire. Si les cotes manquent, un rattrapage ciblé peut utiliser des crédits Odds API dans les limites prévues.</div>'+warning;
    betproRememberScan('Classique',events);
    cnt.innerHTML=`<div class="sbar"><span style="color:#dccaff;font-weight:800">SCAN LIVE CLASSIQUE</span><span>${events.length} cote(s) exploitable(s) · ${Math.max(0,identified-events.length)} rencontre(s) sans marché exploitable</span><span style="margin-left:auto">${esc(betproClassicDate(d.generated_at))}</span></div>`+warn+(events.length?'<div class="opp-grid">'+events.map(betproClassicCard).join('')+'</div>':'<div class="empty"><div class="empty-t">Aucune cote exploitable actuellement. '+identified+' rencontre(s) enregistrée(s), mais aucun marché assez fiable pour une carte de pari. Les rencontres ne sont pas présentées comme des paris.</div></div>');
    betproEnhanceScanFollow('scan-classic-res',events,'Classique');
  }catch(e){if(seq===betProClassicScanSeq)cnt.innerHTML='<div class="warn">Scan Classique indisponible : '+esc(e?.message||String(e))+'</div>';}
  finally{if(seq===betProClassicScanSeq){btn.disabled=false;document.getElementById('scan-classic-txt').textContent='SCAN LIVE CLASSIQUE';}}
}
// Les fonctions Benter d'origine sont conservées intégralement et isolées.
async function loadLive(){if(betProActiveEngine==='benter')return loadLiveBenter();return loadLiveClassic();}
async function loadUpcoming(){if(betProActiveEngine==='benter')return loadUpcomingBenter();return loadUpcomingClassic();}
async function loadLiveClassic(){return betproLoadRealLive('live-classic-cnt');}

async function loadUpcomingClassic(){
 const seq=++betProClassicUpcomingSeq,cnt=document.getElementById('upcoming-classic-cnt');if(!cnt)return;
 cnt.innerHTML='<div class="ls"><div class="sp"></div><p>Rencontres à venir (Classique)…</p></div>';
 try{
  const params=new URLSearchParams({scope:'upcoming',limit:'75'});
  if(upcTab==='h')params.set('hours',String(upcHours));else if(upcTab==='d')params.set('hours',String(upcDays*24));
  else{const f=document.getElementById('upc-from')?.value,t=document.getElementById('upc-to')?.value;if(f)params.set('date_from',f);if(t)params.set('date_to',t);}
  const d=await api('/api/classic/scan?'+params,'GET',null,{timeoutMs:20000});if(seq!==betProClassicUpcomingSeq)return;
  if(!d?.ok)throw Error(d?.error||'Calendrier indisponible');const matches=d.events||[];
  cnt.innerHTML=`<div class="sbar"><span style="color:#dfc7ff;font-weight:800">À VENIR · CLASSIQUE</span><span>${matches.length} rencontre(s)</span></div>`+(matches.length?'<div class="opp-grid">'+matches.map(betproClassicCard).join('')+'</div>':'<div class="info">Aucune rencontre enregistrée dans cette fenêtre.</div>');
 }catch(e){if(seq===betProClassicUpcomingSeq)cnt.innerHTML='<div class="warn">Rencontres Classique : '+esc(e?.message||String(e))+'</div>';}
}
try{const last=sessionStorage.getItem('betpro-live-engine-v1');betProActiveEngine=last==='benter'?'benter':'classic';}catch(_){betProActiveEngine='classic';}
// La sélection n'appelle aucun service en arrière-plan au chargement.
setBetProEngine(betProActiveEngine);

// ═══════════════════════════════════════════════
//  RÉSULTATS
// ═══════════════════════════════════════════════
// Résultats lisibles, issus des historiques réels; jamais de score extrapolé.
const BETPRO_SCAN_RESULT_ARCHIVE='betpro_scan_result_archive_v1';
let betproResultsSequence=0;
let betproResultsLastData=null;
function betproReadScanArchive(){
  try{const data=JSON.parse(localStorage.getItem(BETPRO_SCAN_RESULT_ARCHIVE)||'[]');return Array.isArray(data)?data:[];}catch(_){return[];}
}
function betproRememberScan(engine,items){
  if(!Array.isArray(items)||!items.length)return;
  try{
    const at=new Date().toISOString();
    const history=betproReadScanArchive();
    const oldIds=new Set(history.map(x=>x.id));
    const newRows=[];
    for(const item of items.slice(0,70)){
      if(!item||typeof item!=='object')continue;
      const isClassic=engine==='Classique',c=item.consensus||{};
      const home=String((isClassic?item.home_name:item.home_team)||item.home||'').trim();
      const away=String((isClassic?item.away_name:item.away_team)||item.away||'').trim();
      const sport=String(item.sport||item._sport||'');
      const start=String(item.start_time||item.event_start_at||item.commence_time||'');
      const choice=String(isClassic?(c.favorite||''):(item.selection||''));
      if(!home||!away||!choice||!start||!Number.isFinite(Date.parse(start)))continue;
      const id=[engine,sport,home,away,start.slice(0,16),choice,String(item.market||'h2h')].join('|').toLowerCase();
      if(oldIds.has(id))continue;
      oldIds.add(id);
      const odds=isClassic?(Number(item.classic_value?.best_price)>1?Number(item.classic_value.best_price):Number(c.median_market_odds)):Number(item.odds);
      newRows.push({id,engine,sport,home,away,at,start,selection:choice,
        market:String(item.market||(isClassic?'consensus':'h2h')),odds:Number.isFinite(odds)&&odds>1?odds:null,
        competition:String(item.competition||item.sport_title||'')});
    }
    if(newRows.length){
      const all=[...newRows,...history].slice(0,300);
      const serialized=JSON.stringify(all);
      if(serialized.length<250000)localStorage.setItem(BETPRO_SCAN_RESULT_ARCHIVE,serialized);
    }
  }catch(error){console.warn('Archive locale des scans indisponible',error?.message||error);}
}
function betproResultDate(value){
  const ts=Date.parse(value||'');
  return Number.isFinite(ts)?new Date(ts).toLocaleString('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Date non disponible';
}
function betproResultNormalize(row,source){
  if(!row||typeof row!=='object')return null;
  const pair=String(row.event_name||'').split(/\s+-\s+|\s+vs\s+/i);
  const home=String(row.home||row.home_team||row.team_home||(pair.length===2?pair[0]:'')).trim();
  const away=String(row.away||row.away_team||row.team_away||(pair.length===2?pair[1]:'')).trim();
  if(!home||!away)return null;
  const sport=String(row.sport||row._sport||'');
  const market=String(row.market||'h2h');
  const selection=String(row.selection||'');
  const start=String(row.startTime||row.start_time||row.event_start_at||row.commence_time||'');
  const detected=String(row.detectedAt||row.createdAt||row.detected_at||row.created_at||'');
  const raw=String(row.status||row.settlement_status||'pending').toLowerCase();
  const status=['win','won'].includes(raw)?'win':['loss','lost'].includes(raw)?'loss':['void','push','refund'].includes(raw)?'void':'pending';
  const id=[sport,home,away,market,selection].join('|').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9|]/g,'');
  const odds=Number(row.odds??row.oddsDetected??row.odds_detected);
  return {id,recordId:String(row.id||''),home,away,sport,market,selection,start,detected,status,
    odds:Number.isFinite(odds)&&odds>1?odds:null,competition:String(row.competition||row.sport_title||''),
    bookmaker:String(row.bookmaker||''),source,updatedAt:String(row.updatedAt||row.updated_at||''),
    score:String(row.finalScore||''),resultSource:String(row.resultSource||'')};
}
function betproResultMerge(primary,secondary){
  const entries=new Map();
  for(const [data,source] of [[primary,'Cartes BetPro'],[secondary,'Historique sportif']]){
    for(const raw of data){
      const card=betproResultNormalize(raw,source);
      if(!card)continue;
      const previous=entries.get(card.id);
      if(!previous){entries.set(card.id,card);continue;}
      const resolved=card.status!=='pending',prevResolved=previous.status!=='pending';
      if(resolved&&!prevResolved)entries.set(card.id,{...previous,...card});
      else if(prevResolved&&!resolved)continue;
      else if(previous.source==='Historique sportif'&&source==='Cartes BetPro')entries.set(card.id,{...previous,...card});
    }
  }
  return [...entries.values()].sort((a,b)=>
    (Date.parse(b.detected||b.start||'')||0)-(Date.parse(a.detected||a.start||'')||0));
}
function betproResultRow(row,mode='history'){
  const status=row.status||'pending';
  const startMs=Date.parse(row.start||'');
  const detectedMs=Date.parse(row.detected||'');
  const due=(Number.isFinite(startMs)&&startMs<Date.now()-21600000)
    ||(!Number.isFinite(startMs)&&Number.isFinite(detectedMs)&&detectedMs<Date.now()-7*86400000);
  const label=mode==='scan'?'SÉLECTION ARCHIVÉE':status==='win'?'GAGNÉ':status==='loss'?'PERDU':status==='void'?'ANNULÉ':due?'ISSUE NON VÉRIFIÉE':'EN ATTENTE';
  const hue=mode==='scan'?'var(--neon)':status==='win'?'var(--gr)':status==='loss'?'var(--re)':status==='void'?'var(--mu)':'var(--am)';
  const clean=t=>esc(String(t||''));
  const quote=row.odds!=null?' · Cote '+Number(row.odds).toLocaleString('fr-FR',{maximumFractionDigits:2}):'';
  const selected=row.selection?' · Sélection : '+clean(row.selection):'';
  const date=row.start?'Rencontre : '+betproResultDate(row.start):'Date du match non conservée';
  const proof=mode!=='scan'&&status!=='pending'&&row.score?' · Score final confirmé : '+clean(row.score)+' ('+clean(row.resultSource||'source enregistrée')+')':'';
  return '<div class="betpro-results-row">'
    +'<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">'
    +'<strong style="font-size:12px;color:var(--tx)">'+clean(row.home)+' / '+clean(row.away)+'</strong>'
    +'<span style="font:700 9px var(--mo);color:'+hue+'">'+label+'</span></div>'
    +'<div style="font-size:10px;color:var(--mu);margin-top:5px;line-height:1.65">'
    +clean(row.competition||row.sport||'Sport')+selected+clean(quote)+proof+'</div>'
    +'<div style="font-size:9px;color:var(--dm);margin-top:4px">'+clean(date)
    +' · '+(mode==='scan'?'Scan '+clean(row.engine)+' : '+betproResultDate(row.at):'Enregistré : '+betproResultDate(row.detected))+'</div>'
    +'</div>';
}
function betproResultSection(title,rows,empty,mode='history'){
  return '<div class="card betpro-results-section"><div class="ct">'+title+'</div>'
    +(rows.length?rows.slice(0,15).map(x=>betproResultRow(x,mode)).join('')
      +(rows.length>15?'<details><summary class="betpro-results-more">Afficher '+(rows.length-15)+' autre(s) fiche(s)</summary>'+rows.slice(15,100).map(x=>betproResultRow(x,mode)).join('')+'</details>':'')
      :'<p style="color:var(--mu);font-size:11px;line-height:1.6">'+empty+'</p>')
    +'</div>';
}
function betproResultsBottomStats(stats,cards){
  if(!stats?.ok){
    return '<div class="card betpro-results-section" id="betpro-stats-live"><div class="ct">Statistiques sportives actualisées</div>'
      +'<p style="color:var(--mu);font-size:11px">Statistiques Cloudflare indisponibles momentanément. Les historiques restent consultables.</p></div>';
  }
  const done=Number(stats.win||0)+Number(stats.loss||0),p=x=>Number(x).toLocaleString('fr-FR',{maximumFractionDigits:1});
  const card=(name,value,sub)=>'<div class="tsm-cell"><div class="sv" style="color:var(--tx)">'+value+'</div><label>'+name+'</label>'
    +(sub?'<div style="font-size:9px;color:var(--dm);margin-top:5px">'+sub+'</div>':'')+'</div>';
  const sports=Object.entries(stats.by_sport||{}).sort((a,b)=>Number(b[1].total||0)-Number(a[1].total||0));
  const last=stats.last_check?betproResultDate(stats.last_check):'Aucun contrôle effectué';
  const pct=stats.rate==null?'—':p(stats.rate)+' %';
  const roi=stats.virtual_roi==null?'—':(stats.virtual_roi>0?'+':'')+p(stats.virtual_roi)+' %';
  const byDay=Object.entries(stats.by_day||{}).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,12);
  let html='<div class="card betpro-results-section" id="betpro-stats-live">'
   +'<div class="ct">Statistiques sportives actualisées</div>'
   +'<div class="tracker-summary">'
   +card('Cartes analysées',Number(stats.total||0),'Historique serveur')
   +card('Taux de réussite',pct,done+' pronostics départagés')
   +card('ROI virtuel',roi,'Simulation à mises fictives')
   +card('Non vérifiés',Number(stats.unverified||0),'Rencontres déjà passées')
   +'</div>'
   +'<div class="info" style="font-size:10px;line-height:1.7;margin-top:9px">Taux de réussite calculé sur les seuls pronostics gagnés ou perdus confirmés. Les matchs en attente et annulés sont exclus. Le ROI virtuel n’est pas un gain réel.</div>'
   +'<p style="font:10px var(--mo);color:var(--mu);margin:12px 0 8px">Dernier contrôle des scores : '+esc(last)+' · Source : ESPN. Les matchs non trouvés ou ambigus restent non vérifiés.</p>'
   +'<div class="ct" style="margin-top:13px">Bilan par sport</div>';
  if(sports.length){
    html+='<div style="overflow-x:auto"><table class="betpro-results-table"><thead><tr><th>Sport</th><th>Cartes</th><th>Gagnés</th><th>Perdus</th><th>Réussite</th></tr></thead><tbody>';
    html+=sports.map(([sport,s])=>{
      const decided=Number(s.win||0)+Number(s.loss||0);
      return '<tr><td>'+esc(typeof getSportLabel==='function'?getSportLabel(sport):sport)+'</td>'
        +'<td>'+Number(s.total||0)+'</td><td>'+Number(s.win||0)+'</td><td>'+Number(s.loss||0)+'</td>'
        +'<td>'+(decided?p(Math.round(1000*Number(s.win||0)/decided)/10)+' %':'—')+'</td></tr>';
    }).join('');
    html+='</tbody></table></div>';
  }else html+='<p style="color:var(--mu);font-size:11px">Aucun historique sportif disponible.</p>';
  html+='<details style="margin-top:12px"><summary class="betpro-results-more">Historique des vérifications récentes</summary>';
  html+=byDay.length?byDay.map(([date,day])=>'<div class="betpro-results-row"><strong>'+esc(date)+'</strong>'
     +' · '+Number(day.win||0)+' gagnés · '+Number(day.loss||0)+' perdus · '+Number(day.void||0)+' annulés</div>').join('')
    :'<p style="font-size:11px;color:var(--mu)">Aucune vérification concluante enregistrée.</p>';
  html+='</details></div>';
  return html;
}
async function betproVerifyResultsNow(){
  const btn=document.getElementById('betpro-results-verify');
  if(btn){btn.disabled=true;btn.textContent='Vérification des scores…';}
  try{
    const report=await api('/api/results/verify','POST',null,{timeoutMs:60000,noCache:true});
    if(report?.ok===false)throw Error(report.error||'Vérification impossible');
    const message=report?.skipped?'Contrôle déjà effectué récemment.'
      :Number(report?.verified||0)+' résultat(s) confirmé(s) à partir des scores ESPN.';
    toast(message,'ok');
    await loadResults();
  }catch(e){toast('Vérification : '+e.message,'err');}
  finally{if(btn){btn.disabled=false;btn.textContent='Vérifier les scores';}}
}
function betproRenderResults(primary,advanced,oldAnalysis,remoteLabel,stats){
  const target=document.getElementById('res-cnt');if(!target)return;
  const cards=betproResultMerge(primary,advanced);
  const settled=cards.filter(x=>x.status!=='pending');
  const pending=cards.filter(x=>x.status==='pending');
  const wins=settled.filter(x=>x.status==='win').length,losses=settled.filter(x=>x.status==='loss').length;
  const archived=betproReadScanArchive();
  const count=(label,n)=>'<div class="tsm-cell"><div class="sv" style="color:var(--tx)">'+n+'</div><label>'+label+'</label></div>';
  let html='<div class="info" style="font-size:11px;line-height:1.7;margin-bottom:12px">Historique des analyses et sélections enregistrées. Une sélection ou un match terminé ne devient un gain ou une perte que si son résultat a été confirmé.</div>'
    +'<div class="tracker-summary" style="margin-bottom:12px">'
    +count('Cartes enregistrées',cards.length)+count('Gagnées',wins)+count('Perdues',losses)+count('Non réglées',pending.length)
    +'</div><p style="color:var(--dm);font:10px var(--mo);margin:0 0 12px">'+esc(remoteLabel)+'</p>'
    +betproResultSection('Résultats confirmés',settled,'Aucun résultat de pari confirmé pour le moment. Les sélections sans score officiel restent non réglées.')
    +betproResultSection('Sélections enregistrées · résultat à confirmer',pending,'Aucune sélection en attente actuellement.')
    +betproResultSection('Dernières sélections issues des scans',archived,'Aucune sélection de scan archivée sur cet appareil. Après un scan produisant des cartes exploitables, elles seront enregistrées ici.','scan');
  const legacyItems=Array.isArray(oldAnalysis?.opportunities)?oldAnalysis.opportunities:[];
  const oldTime=Date.parse(oldAnalysis?.analyzed_at||'');
  const age=Number.isFinite(oldTime)?Date.now()-oldTime:Infinity;
  const oldLabel=Number.isFinite(oldTime)?betproResultDate(oldAnalysis.analyzed_at):'date non indiquée';
  const isOld=age>86400000;
  const summary=legacyItems.length?legacyItems.length+' propositions archivées · analyse du '+oldLabel:'Aucune ancienne analyse disponible';
  html+='<details class="card betpro-results-section" style="margin-bottom:14px">'
    +'<summary class="betpro-results-more">Anciennes analyses des marchés · '+esc(summary)+'</summary>'
    +'<div class="info" style="font-size:11px;margin-top:11px">'+(isOld?'Attention : données historiques. Les cotes et rencontres peuvent être expirées.':'Ces analyses ne constituent pas des résultats de matchs.')+' Aucun résultat sportif final n’est déduit de ces propositions.</div>'
    +(legacyItems.length?legacyItems.slice(0,35).map(o=>betproResultRow({...betproResultNormalize({home:o.home_team,away:o.away_team,sport:o.sport,market:o.market,selection:o.selection,start:o.start_time||o.commence_time,detected:oldAnalysis.analyzed_at,odds:o.odds},'Archive'),engine:'archive',at:oldAnalysis.analyzed_at},'scan')).join(''):'')
    +'</details>';
  if(!cards.length&&!archived.length&&!legacyItems.length)html+='<div class="info">Aucun historique disponible : ouvrez le Tableau de bord et lancez un scan. Seules les sélections effectivement détectées seront sauvegardées.</div>';
  html+=betproResultsBottomStats(stats,cards);
  target.innerHTML=html;
}
// L'ancien bouton "Vider" reste compatible, mais n'efface que le cache historique
// du serveur; le bouton n'est plus présenté comme supprimant tous les historiques.
async function clearResults(){
  if(!confirm('Effacer seulement les anciennes analyses du cache serveur ? Les historiques de cartes et de scans restent conservés.'))return;
  try{await api('/api/results','DELETE');toast('Ancien cache vidé ; historiques préservés.','ok');loadResults();}
  catch(e){toast('Erreur : '+e.message,'err');}
}
// Le suivi et ses statistiques utilisent exclusivement les cartes sélectionnées.
function betproChosenResultRow(item){
 const row=betproResultNormalize({...item,detectedAt:item.selectedAt},'Suivi personnel');
 if(!row||!/^[A-Za-z0-9_-]+$/.test(String(item.id||'')))return'';
 betproFollowCatalog.set(item.id,item);
 const button='<button type="button" class="betpro-follow-btn is-followed" data-betpro-follow-id="'+item.id+'" aria-pressed="true" onclick="event.stopPropagation();betproToggleFollow(this,\''+item.id+'\')">Retirer du suivi</button>';
 return '<div class="betpro-chosen-card">'+betproResultRow(row)
  +'<div style="font-size:10px;color:var(--mu);margin:0 0 7px">Scan '+esc(item.engine||'')+' · Sélectionné le '+betproResultDate(item.selectedAt)+(item.phase==='en_direct'?' · Sélection en direct':'')+'</div>'
  +'<div style="display:flex;justify-content:flex-end;margin:0 0 12px">'+button+'</div></div>';
}
function betproRenderChosenResults(items,stats){
 const target=document.getElementById('res-cnt');if(!target)return;
 const chosen=[...items].sort((a,b)=>(Date.parse(b.selectedAt||'')||0)-(Date.parse(a.selectedAt||'')||0));
 const settled=chosen.filter(x=>['win','loss','void'].includes(String(x.status||'')));
 const pending=chosen.filter(x=>!['win','loss','void'].includes(String(x.status||'')));
 const stat=(name,val)=>'<div class="tsm-cell"><div class="sv" style="color:var(--tx)">'+val+'</div><label>'+name+'</label></div>';
 const section=(name,rows,empty)=>'<div class="card betpro-results-section"><div class="ct">'+name+'</div>'
   +(rows.length?rows.slice(0,15).map(betproChosenResultRow).join('')
      +(rows.length>15?'<details><summary class="betpro-results-more">Afficher '+(rows.length-15)+' autres pronostics</summary>'+rows.slice(15).map(betproChosenResultRow).join('')+'</details>':'')
      :'<p style="font-size:11px;color:var(--mu);line-height:1.7">'+empty+'</p>')+'</div>';
 let html='<div class="info" style="font-size:11px;line-height:1.7;margin-bottom:14px">Suivi personnel : seuls les pronostics que tu as sélectionnés sur les cartes Scan Live sont contrôlés et comptabilisés ici.</div>'
   +'<div class="tracker-summary" style="margin-bottom:14px">'
   +stat('Mes sélections',chosen.length)+stat('Gagnées',settled.filter(x=>x.status==='win').length)
   +stat('Perdues',settled.filter(x=>x.status==='loss').length)+stat('À vérifier',pending.length)+'</div>';
 if(!chosen.length){
  html+='<div class="card betpro-results-section"><div class="ct">Aucun pronostic sélectionné</div>'
   +'<p style="font-size:12px;color:var(--mu);line-height:1.75">Effectue un Scan Live Classique ou Benter, puis appuie sur « Suivre le résultat » sur les cartes de ton choix. Elles apparaîtront ici sur tous tes appareils.</p></div>';
 }else{
  html+=section('Mes résultats confirmés',settled,'Aucun des pronostics choisis n’a encore un score officiel confirmé.')
    +section('Mes pronostics en attente',pending,'Toutes tes sélections ont été vérifiées.');
 }
 html+=betproResultsBottomStats(stats,chosen);
 target.innerHTML=html;
}
async function loadResults(){
 const target=document.getElementById('res-cnt');if(!target)return;
 const seq=++betproResultsSequence;
 target.innerHTML='<div class="ls"><div class="sp"></div><p>Chargement de mes pronostics suivis…</p></div>';
 const responses=await Promise.allSettled([
  api('/api/results/tracked','GET',null,{timeoutMs:16000,noCache:true}),
  api('/api/results/settlement-stats','GET',null,{timeoutMs:16000,noCache:true})
 ]);
 if(seq!==betproResultsSequence)return;
 const items=responses[0].status==='fulfilled'&&responses[0].value?.ok?responses[0].value.items:null;
 const stats=responses[1].status==='fulfilled'&&responses[1].value?.ok?responses[1].value:null;
 if(!Array.isArray(items)){
  target.innerHTML='<div class="card"><div style="color:var(--re)">Suivi momentanément indisponible. Utilise « Actualiser ».</div></div>';return;
 }
 betproFollowSelected=new Set(items.map(x=>x.id));
 betproRenderChosenResults(items,stats);
 betproFollowPaint();
}


// ═══════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════
async function loadSettings(){try{const s=await api('/api/settings');document.getElementById('s-minscore').value=s.min_alert_score||75;document.getElementById('s-maxalerts').value=s.max_alerts_per_day||5;document.getElementById('s-minodds').value=s.alert_min_odds||1.40;document.getElementById('s-maxodds').value=s.alert_max_odds||5.00;document.getElementById('s-scan').value=String(s.scan_enabled!==false);}catch(e){toast('Erreur: '+e.message,'err');}}
async function saveSettings(){try{await api('/api/settings','POST',{min_alert_score:parseInt(document.getElementById('s-minscore').value),max_alerts_per_day:parseInt(document.getElementById('s-maxalerts').value),alert_min_odds:parseFloat(document.getElementById('s-minodds').value),alert_max_odds:parseFloat(document.getElementById('s-maxodds').value),scan_enabled:document.getElementById('s-scan').value==='true'});toast('Sauvegardé ✓','ok');}catch(e){toast('Erreur: '+e.message,'err');}}
async function testAlert(){try{const d=await api('/api/test-alert','POST');toast(d.message||(d.ok?'✓ Envoyé':'⚠ Non envoyé'),d.ok?'ok':'');}catch(e){toast('Erreur: '+e.message,'err');}}
async function loadSysStatus(){const cnt=document.getElementById('sysstatus');try{const q=await api('/api/quotas');const op=Math.round((q.odds_api_monthly_limit-q.odds_api_credits_remaining)/q.odds_api_monthly_limit*100);const activeKey=(q.active_key_idx||0)+1;const keysTotal=q.keys_total||1;cnt.innerHTML=`<div class="ct">Quotas API</div><div style="margin-bottom:8px"><div style="font-size:10px;color:var(--dm);font-family:var(--mo);margin-bottom:4px">Odds API — Clé ${activeKey}/${keysTotal} active · ${q.odds_api_credits_remaining} crédits restants</div><div class="qtr"><div class="qfi ${op<60?'g':op<85?'a':'r'}" style="width:${op}%"></div></div></div><div class="info" style="font-size:11px">💡 Rotation automatique: jusqu'à 6 clés (ODDS_API_KEY à ODDS_API_KEY_6).</div>`;}catch(e){cnt.innerHTML=`<div class="ct">Quotas API</div><div style="color:var(--re)">Erreur: ${esc(e.message)}</div>`;}}
async function loadQuotas(){const el=document.getElementById('qfoot');try{const q=await api('/api/quotas');const activeKey=(q.active_key_idx||0)+1;const op=Math.round((q.odds_api_monthly_limit-q.odds_api_credits_remaining)/q.odds_api_monthly_limit*100);el.innerHTML=`<div class="qbl"><span>Odds API (K${activeKey}/${q.keys_total||1})</span><span>${q.odds_api_credits_remaining} cr.</span></div><div class="qtr"><div class="qfi ${op<60?'g':op<85?'a':'r'}" style="width:${op}%"></div></div>`;}catch(_){}}

// ═══════════════════════════════════════════════
//  CHAT + TTS simplifié
// ═══════════════════════════════════════════════
let chatHistory=[];
function getCtx(){const home=document.getElementById('ctx-home')?.value.trim(),away=document.getElementById('ctx-away')?.value.trim(),sh=document.getElementById('ctx-sh')?.value,sa=document.getElementById('ctx-sa')?.value,min=document.getElementById('ctx-min')?.value,comp=document.getElementById('ctx-comp')?.value.trim();const ctx={};if(home)ctx.home=home;if(away)ctx.away=away;if(sh)ctx.score_home=parseInt(sh)||0;if(sa)ctx.score_away=parseInt(sa)||0;if(min)ctx.minute=parseInt(min);if(comp)ctx.competition=comp;return Object.keys(ctx).length?ctx:null;}
function clearCtx(){['ctx-home','ctx-away','ctx-sh','ctx-sa','ctx-min','ctx-comp'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});}
function clearChat(){chatHistory=[];document.getElementById('chat-wrap').innerHTML='<div class="msg bot"><div class="msg-ico">🤖</div><div><div class="msg-bub">Conversation effacée.</div></div></div>';}
function chatKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}}
function sendQuick(q){document.getElementById('chat-input').value=q;sendChat();}

const TTS={enabled:false,speed:1.0,volume:1.0,voiceIdx:-1,utterance:null,msgId:0};
function ttsGetVoices(){return new Promise(res=>{const v=speechSynthesis.getVoices();if(v.length){res(v);return;}speechSynthesis.onvoiceschanged=()=>res(speechSynthesis.getVoices());});}
async function ttsInit(){if(!('speechSynthesis' in window))return;const voices=await ttsGetVoices();const sel=document.getElementById('tts-voice');if(!sel)return;sel.innerHTML='<option value="">Voix auto</option>';voices.forEach((v,i)=>{const opt=document.createElement('option');opt.value=i;opt.textContent=v.name+(v.lang?' ('+v.lang+')':'');if(v.lang&&v.lang.startsWith('fr'))opt.style.color='#22d3a5';sel.appendChild(opt);});}
function ttsBestFrVoice(voices){return voices.find(v=>v.lang==='fr-FR'&&v.localService!==false)||voices.find(v=>v.lang==='fr-FR')||voices.find(v=>v.lang&&v.lang.startsWith('fr'))||voices[0];}
function ttsSpeak(text,replayBtnId){
  if(!('speechSynthesis' in window))return;
  ttsStop();
  const voices=speechSynthesis.getVoices();
  const voice=TTS.voiceIdx>=0?voices[TTS.voiceIdx]:ttsBestFrVoice(voices);
  const clean = text
    .replace(/\*\*(.*?)\*\*/g,'$1')
    .replace(/`(.*?)`/g,'$1')
    .replace(/#{1,3}\s/g,'')
    .replace(/(\d+\.\d+)/g, n => n.replace('.', ' virgule '))
    .replace(/([\d]+)%/g, '$1 pourcent')
    .replace(/([\d]+)€/g, '$1 euros')
    .replace(/\+([\d]+)/g, 'plus $1')
    .replace(/EV\s*/g, 'espérance de valeur ')
    .replace(/\bEPL\b/g, 'Premier League')
    .replace(/\bMMA\b/g, 'MMA')
    .replace(/\bNBA\b/g, 'NBA')
    .replace(/\bUCL\b/g, 'Ligue des Champions')
    .replace(/\b1X2\b/g, 'un X deux')
    .replace(/\bBTTS\b/g, 'les deux équipes marquent')
    .replace(/\bO\/U\b/g, 'Over Under')
    .replace(/\bHC\b/g, 'handicap')
    .replace(/→/g, 'vers')
    .replace(/·/g, ',')
    .replace(/—/g, ',')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/[^\wÀ-ÿ\s.,!?;:€%+\-°]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const utter=new SpeechSynthesisUtterance(clean);
  utter.voice=voice||null;utter.rate=TTS.speed;utter.volume=TTS.volume;utter.lang='fr-FR';
  TTS.utterance=utter;
  const stopBtn=document.getElementById('tts-stop-btn');
  const statusEl=document.getElementById('tts-status');
  const replayBtn=replayBtnId?document.getElementById(replayBtnId):null;
  if(stopBtn)stopBtn.style.display='';
  if(statusEl)statusEl.textContent='🔊 Lecture…';
  if(replayBtn)replayBtn.textContent='🔊…';
  utter.onend=utter.onerror=()=>{TTS.utterance=null;if(stopBtn)stopBtn.style.display='none';if(statusEl)statusEl.textContent='';if(replayBtn)replayBtn.textContent='🔊 Relire';};
  speechSynthesis.speak(utter);
}
function ttsStop(){if(speechSynthesis.speaking||speechSynthesis.pending)speechSynthesis.cancel();TTS.utterance=null;const stopBtn=document.getElementById('tts-stop-btn');const statusEl=document.getElementById('tts-status');if(stopBtn)stopBtn.style.display='none';if(statusEl)statusEl.textContent='';}
function ttsToggleAuto(){
  TTS.enabled=!TTS.enabled;
  const btn=document.getElementById('tts-main-btn');
  const lbl=document.getElementById('tts-main-lbl');
  if(TTS.enabled){btn?.classList.add('on');if(lbl)lbl.textContent='Voix ON';}
  else{btn?.classList.remove('on');if(lbl)lbl.textContent='Voix OFF';ttsStop();}
  toast(TTS.enabled?'🔊 Lecture auto activée':'🔇 Lecture auto désactivée','ok');
}
function ttsSetSpeed(v){TTS.speed=parseFloat(v)||1.0;}
function ttsSetVoice(v){TTS.voiceIdx=v===''?-1:parseInt(v);}
function ttsReplay(msgId){const el=document.getElementById('tts-msg-'+msgId);if(!el)return;ttsSpeak(el.dataset.raw||el.textContent,'tts-r-'+msgId);}

function appendMsg(role,msgContent,meta){
  const wrap=document.getElementById('chat-wrap');const div=document.createElement('div');div.className='msg '+role;
  const msgId=++TTS.msgId;
  const formatted=esc(msgContent).replace(/\*\*(.+?)\*\*/g,'<strong style="color:var(--tx)">$1</strong>').replace(/`(.+?)`/g,'<code>$1</code>').replace(/\n/g,'<br>');
  const ico=role==='user'?'👤':'🤖';
  const replayHtml=role==='bot'?`<div style="margin-top:5px"><button id="tts-r-${msgId}" style="background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.2);border-radius:5px;color:var(--pu);font-size:9px;font-family:var(--mo);padding:3px 8px;cursor:pointer" onclick="ttsReplay(${msgId})">🔊 Relire</button></div>`:'';
  div.innerHTML=`<div class="msg-ico">${ico}</div><div style="flex:1;min-width:0"><div class="msg-bub" id="tts-msg-${msgId}" data-raw="${esc(msgContent).replace(/"/g,'&quot;')}">${formatted}</div>${meta?`<div class="chat-meta">${esc(meta)}</div>`:''} ${replayHtml}</div>`;
  wrap.appendChild(div);wrap.scrollTop=wrap.scrollHeight;
  if(role==='bot'&&TTS.enabled&&msgContent.length>2){setTimeout(()=>ttsSpeak(msgContent,'tts-r-'+msgId),300);}
}

async function sendChat(){const input=document.getElementById('chat-input'),btn=document.getElementById('chat-btn'),q=input.value.trim();if(!q)return;chatHistory.push({role:'user',content:q});appendMsg('user',q);input.value='';btn.disabled=true;btn.innerHTML='<span class="sp" style="width:12px;height:12px;border-width:2px"></span>';const wrap=document.getElementById('chat-wrap');const typing=document.createElement('div');typing.className='msg bot';typing.id='typing';typing.innerHTML='<div class="msg-ico">🤖</div><div class="msg-bub" style="color:var(--dm)">Analyse…</div>';wrap.appendChild(typing);wrap.scrollTop=wrap.scrollHeight;try{const d=await api('/api/chat','POST',{messages:chatHistory.slice(-10),context:getCtx()});typing.remove();chatHistory.push({role:'assistant',content:d.response||''});appendMsg('bot',d.response||'Pas de réponse.',d.provider&&d.model?d.provider+' · '+d.model:null);}catch(e){typing.remove();appendMsg('bot','❌ Erreur: '+e.message);}btn.disabled=false;btn.innerHTML='▶';}
async function loadAIStatus(){const box=document.getElementById('ai-status-box');if(!box)return;try{const d=await api('/api/ai-info');box.innerHTML=d.configured?`<div class="ok-box">✅ IA opérationnelle — <span class="provider-badge pb-${d.provider}">${d.provider} · ${d.model}</span></div>`:`<div class="warn">⚠️ IA non configurée — exécutez <code>wrangler secret put AI_PROVIDER</code></div>`;const badge=document.getElementById('ai-badge');if(badge&&d.configured){badge.className='provider-badge pb-'+d.provider;badge.textContent='⚡ '+d.provider+' · '+d.model;}}catch(_){}}
async function runLiveModelUI(){const home=document.getElementById('ctx-home')?.value.trim(),away=document.getElementById('ctx-away')?.value.trim();if(!home||!away){toast('Renseignez les équipes','err');return;}const sh=parseInt(document.getElementById('ctx-sh')?.value)||0,sa=parseInt(document.getElementById('ctx-sa')?.value)||0,min=parseInt(document.getElementById('ctx-min')?.value)||45,comp=document.getElementById('ctx-comp')?.value.trim();const btn=document.getElementById('live-model-btn'),res=document.getElementById('live-model-res');btn.disabled=true;btn.innerHTML='<span class="sp" style="width:11px;height:11px;border-width:2px"></span> Modèle…';res.innerHTML='<div class="ls" style="padding:24px"><div class="sp"></div><p>Calcul Poisson…</p></div>';try{const d=await api('/api/live-analysis','POST',{home,away,competition:comp||null,minute:min,score_home:sh,score_away:sa});let html='<div style="background:linear-gradient(135deg,rgba(239,68,68,.08),rgba(245,158,11,.05));border:1px solid rgba(239,68,68,.25);border-radius:12px;padding:18px;margin-bottom:13px">';html+=`<div style="text-align:center;margin-bottom:10px"><span style="font-family:var(--mo);font-size:13px;font-weight:700;color:var(--re);padding:3px 10px;background:rgba(239,68,68,.15);border-radius:5px;display:inline-block">⏱ ${min}'</span></div>`;const m=d.model;if(m){const pHW=m.outcomes.home_win,pD=m.outcomes.draw,pAW=m.outcomes.away_win;html+=`<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--mu);font-family:var(--mo);margin-bottom:3px"><span style="color:var(--neon)">${esc(home)} ${pHW}%</span><span>Nul ${pD}%</span><span style="color:var(--pu)">${pAW}% ${esc(away)}</span></div><div style="height:6px;background:var(--bd);border-radius:4px;overflow:hidden;display:flex"><div style="width:${pHW}%;background:var(--neon)"></div><div style="width:${pD}%;background:var(--mu)"></div><div style="width:${pAW}%;background:var(--pu)"></div></div></div>`;html+=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:8px;margin-bottom:12px"><div style="background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:9px;text-align:center"><div style="font-family:var(--mo);font-size:18px;font-weight:700;margin-bottom:2px">${m.totals.over_15}%</div><label style="font-size:9px;color:var(--dm);text-transform:uppercase;letter-spacing:.06em;display:block">Over 1.5</label></div><div style="background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:9px;text-align:center"><div style="font-family:var(--mo);font-size:18px;font-weight:700;margin-bottom:2px">${m.totals.over_25}%</div><label style="font-size:9px;color:var(--dm);text-transform:uppercase;letter-spacing:.06em;display:block">Over 2.5</label></div><div style="background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:9px;text-align:center"><div style="font-family:var(--mo);font-size:18px;font-weight:700;margin-bottom:2px">${m.btts}%</div><label style="font-size:9px;color:var(--dm);text-transform:uppercase;letter-spacing:.06em;display:block">BTTS</label></div><div style="background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:9px;text-align:center"><div style="font-family:var(--mo);font-size:18px;font-weight:700;margin-bottom:2px">${m.next_goal.within_5min}%</div><label style="font-size:9px;color:var(--dm);text-transform:uppercase;letter-spacing:.06em;display:block">But/5min</label></div></div>`;}const ai=d.ai_analysis;if(ai&&!ai.parse_error){html+='<div style="background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.2);border-radius:8px;padding:13px;margin-top:12px"><div style="font-size:10px;color:var(--dm);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">🤖 Analyse IA</div>';if(ai.resume)html+=`<div style="font-size:12px;color:var(--mu);line-height:1.65;margin-bottom:11px;padding:8px 11px;background:var(--sf2);border-radius:6px">${esc(ai.resume)}</div>`;if(ai.paris_recommandes?.length)ai.paris_recommandes.forEach(p=>{const cc=p.confiance>=70?'var(--neon)':p.confiance>=55?'var(--gr)':p.confiance>=40?'var(--am)':'var(--re)';html+=`<div style="background:var(--sf2);border-radius:6px;padding:9px 11px;margin-bottom:6px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--neon)">${esc(p.pari||'?')}</span><span style="font-size:10px;font-family:var(--mo);color:${cc}">${p.confiance||'?'}%</span></div>${p.raisonnement?`<div style="font-size:11px;color:var(--mu)">${esc(p.raisonnement)}</div>`:''}</div>`;});if(ai.verdict_final)html+=`<div style="background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.2);border-radius:7px;padding:10px 13px"><div style="font-size:12px;color:var(--mu)">${esc(ai.verdict_final)}</div></div>`;html+='</div>';}html+=`<p style="font-size:10px;color:var(--dm);margin-top:11px">⚠️ Modèle probabiliste. Aucun gain garanti.</p></div>`;res.innerHTML=html;toast('Analyse terminée','ok');}catch(e){res.innerHTML=`<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ ${esc(e.message)}</div></div>`;toast('Erreur: '+e.message,'err');}btn.disabled=false;btn.innerHTML='📡 Analyse Poisson';}

// ═══════════════════════════════════════════════
//  STRATÉGIE
// ═══════════════════════════════════════════════
let stratImgB64=null,stratImgType=null,selectedRisk='conservateur';
function selectRisk(r){selectedRisk=r;['conservateur','modere','agressif'].forEach(id=>document.getElementById('rp-'+id)?.classList.remove('sel'));document.getElementById('rp-'+r)?.classList.add('sel');}
function handleDrop(e){e.preventDefault();document.getElementById('upload-zone').classList.remove('drag');const file=e.dataTransfer.files[0];if(file)processImageFile(file);}
function handleImgChange(e){const file=e.target.files[0];if(file)processImageFile(file);}
function processImageFile(file){stratImgType=file.type||'image/jpeg';const reader=new FileReader();reader.onload=ev=>{const dataUrl=ev.target.result;stratImgB64=dataUrl.split(',')[1];const preview=document.getElementById('img-preview');if(file.type.startsWith('image/')){preview.src=dataUrl;preview.style.display='block';}document.querySelector('.upload-t').textContent='✅ '+file.name;toast('Image chargée','ok');};reader.readAsDataURL(file);}
function resetStrategy(){stratImgB64=null;stratImgType=null;document.getElementById('strat-img').value='';document.getElementById('img-preview').style.display='none';document.getElementById('strat-text').value='';document.getElementById('strat-res').innerHTML='';}
async function doStrategy(){const bankroll=parseFloat(document.getElementById('strat-bankroll').value),betsText=document.getElementById('strat-text').value.trim();const btn=document.getElementById('strat-btn'),res=document.getElementById('strat-res');if(!bankroll||bankroll<1){toast('Bankroll invalide','err');return;}if(!stratImgB64&&!betsText){toast('Image ou texte requis','err');return;}btn.disabled=true;btn.innerHTML='<span class="sp" style="width:13px;height:13px;border-width:2px"></span> Analyse…';res.innerHTML='<div class="ls"><div class="sp"></div><p>Calcul…</p></div>';try{const payload={bankroll,risk_profile:selectedRisk};if(stratImgB64){payload.image_b64=stratImgB64;payload.image_type=stratImgType;}if(betsText)payload.bets_text=betsText;const d=await api('/api/strategy','POST',payload);if(d.strategy){const s=d.strategy,strategy=s.strategy||[],rejected=s.bets_rejected||[],summary=s.bankroll_summary||{};const invested=summary.invested||strategy.reduce((a,b)=>a+(b.stake||0),0);res.innerHTML=`<div class="strat-summary"><div class="ss-cell"><div class="sv" style="color:var(--am)">${invested.toFixed(0)}€</div><label>Investi</label></div><div class="ss-cell"><div class="sv" style="color:var(--gr)">${(summary.potential_gain_max||0).toFixed(0)}€</div><label>Gain max</label></div><div class="ss-cell"><div class="sv" style="color:${(summary.expected_value||0)>=0?'var(--gr)':'var(--re)'}">${(summary.expected_value||0)>0?'+':''}${(summary.expected_value||0).toFixed(2)}€</div><label>EV</label></div><div class="ss-cell"><div class="sv">${(summary.roi_espere||0).toFixed(1)}%</div><label>ROI espéré</label></div></div>${strategy.map((b,i)=>`<div class="bet-row ${i===0?'top1':i===1?'top2':i===2?'top3':''}"><div style="display:flex;gap:10px;align-items:flex-start"><div class="stake-badge" style="min-width:80px"><div class="sam">${b.stake||0}€</div><div class="sal">${b.stake_pct||0}%</div></div><div style="flex:1"><div style="font-family:var(--hd);font-size:13px;font-weight:700">${esc(b.match||'?')}</div><div style="font-family:var(--mo);font-size:12px;color:var(--neon);font-weight:700;margin-top:3px">${esc(b.selection||'?')} @ ${b.odds||'?'}</div>${b.raisonnement?`<p style="font-size:11px;color:var(--mu);margin-top:6px;line-height:1.65">${esc(b.raisonnement)}</p>`:''}</div></div></div>`).join('')}${rejected.length?`<div style="opacity:.65"><div style="font-size:10px;color:var(--dm);text-transform:uppercase;letter-spacing:.07em;margin:12px 0 8px">❌ Paris rejetés</div>${rejected.map(b=>`<div class="bet-row rejected"><span style="font-size:12px;color:var(--mu)">${esc(b.match||'?')} — ${esc(b.raison||'Edge insuffisant')}</span></div>`).join('')}</div>`:''}<div class="verdict-final"><div class="vf-t">Verdict</div><div class="vf-c">${esc(s.verdict||'—')}</div></div><p style="font-size:10px;color:var(--dm);margin-top:12px">⚠️ ${esc(s.disclaimer||'Analyse probabiliste.')}</p>`;}else{res.innerHTML=`<div class="warn">⚠ L'IA n'a pas pu analyser. Vérifiez votre saisie.</div><pre style="font-size:10px">${esc(d.raw||'')}</pre>`;}toast('Analyse terminée','ok');}catch(e){res.innerHTML=`<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">Erreur: ${esc(e.message)}</div></div>`;toast('Erreur: '+e.message,'err');}btn.disabled=false;btn.innerHTML='🏆 Calculer';}

// ═══════════════════════════════════════════════
//  RATTRAPAGE INTELLIGENT — LOGIQUE COMPLETE
// ═══════════════════════════════════════════════════════════════════

const LOSS_KEY = 'pgi_loss_history_v3';
let lossPeriodFilter = 'all';
let recoverySport = 'all';
let selectedMethod = 'pgi_prudente';

function lossLoad(){
  try{ const raw=localStorage.getItem(LOSS_KEY); return raw?JSON.parse(raw):{entries:[]}; }
  catch(_){ return {entries:[]}; }
}
function lossSave(data){
  try{ localStorage.setItem(LOSS_KEY,JSON.stringify(data)); }catch(_){}
  api('/api/notes','PUT',{notes:[{id:'pgi_loss_v3',title:'LossTracker',body:JSON.stringify(data),updatedAt:new Date().toISOString()}]}).catch(function(){});
}
async function lossLoadCloud(){
  try{
    var d=await api('/api/notes');
    var note=(d.notes||[]).find(function(n){return n.id==='pgi_loss_v3';});
    if(note&&note.body){
      var parsed=JSON.parse(note.body);
      var local=lossLoad();
      if((parsed.entries||[]).length>(local.entries||[]).length){ lossSave(parsed); return parsed; }
    }
  }catch(_){}
  return lossLoad();
}

function lossSetPeriod(p,el){
  lossPeriodFilter=p;
  document.querySelectorAll('#loss-period-btns .fbtn, #loss-hist-period-btns .fbtn').forEach(function(b){b.classList.remove('on');});
  if(el) el.classList.add('on');
  lossRender();
}
function lossFilterByPeriod(entries){
  if(lossPeriodFilter==='all') return entries;
  var ms={
    live: 7200000,
    today: 172800000,
    day: 86400000,
    tonight: 86400000,
    tomorrow: 172800000,
    '2d': 172800000,
    '3d': 259200000,
    '7d': 604800000,
    week: 604800000,
    month: 2592000000
  }[lossPeriodFilter] || Infinity;
  var now=Date.now();
  return entries.filter(function(e){ return now-new Date(e.date).getTime()<=ms; });
}
function setRecoverySport(sport,el){
  recoverySport=sport;
  document.querySelectorAll('#recovery-sport-btns .fbtn').forEach(function(b){b.classList.remove('on');});
  if(el) el.classList.add('on');
}

function calcRecoveryStake(totalLost, lastOdds, method, bankroll) {
  bankroll = bankroll || 200;
  const safeOdds = Math.max(1.01, lastOdds||1.80);
  let nextStake = 0, coteCible = safeOdds, expl = '', riskLevel = 'low';
  if(!method || method === 'pgi_prudente') {
    const targetRecov = totalLost * 0.40;
    nextStake = targetRecov / Math.max(0.10, safeOdds - 1);
    nextStake = Math.min(nextStake, bankroll * 0.02);
    nextStake = Math.max(0.50, Math.round(nextStake * 2) / 2);
    riskLevel = 'low';
    expl = 'Récupération prudente PGI : protection bankroll prioritaire, récupération progressive. Aucune garantie, peut perdre malgré une EV positive.';
  } else if(method === 'martingale') {
    nextStake = Math.min(totalLost, bankroll * 0.05);
    riskLevel = 'very-high';
    expl = 'Martingale plafonnée : risque très élevé, non recommandée par défaut. Plafond 5% bankroll.';
  } else if(method === 'fibonacci') {
    const fib=[1,1,2,3,5,8,13,21,34,55,89];
    const n = Math.min(8, Math.max(0, Math.round(totalLost/5)));
    nextStake = Math.min((bankroll*0.005)*(fib[n]||13), bankroll*0.04);
    nextStake = Math.round(nextStake*2)/2;
    riskLevel = 'high'; expl = 'Fibonacci — risque élevé, plafond 4% bankroll.';
  } else if(method === 'dalembert') {
    nextStake = Math.min((bankroll*0.005)+Math.round(totalLost/10), bankroll*0.03);
    nextStake = Math.round(nextStake*2)/2;
    riskLevel = 'medium'; expl = "D'Alembert — plafond 3% bankroll.";
  } else if(method === 'kelly') {
    nextStake = Math.min(bankroll*0.015, totalLost*0.20);
    nextStake = Math.round(nextStake*2)/2;
    riskLevel = 'medium'; expl = 'Kelly fractionnel — plafond 1.5% bankroll.';
  } else if(method === 'flat') {
    nextStake = Math.min(bankroll*0.01, 10);
    nextStake = Math.round(nextStake*2)/2;
    riskLevel = 'low'; expl = 'Mise fixe.';
  } else if(method === 'labouchere') {
    nextStake = Math.min(bankroll*0.005*3, bankroll*0.03);
    nextStake = Math.round(nextStake*2)/2;
    riskLevel = 'high'; expl = 'Labouchère — risque élevé, plafond 3% bankroll.';
  } else {
    nextStake = Math.min(5, bankroll*0.01);
    expl = 'Méthode inconnue — mise minimale.';
  }
  nextStake = Math.max(0.50, nextStake);
  return { nextStake, coteCible, expl, riskLevel, totalLost };
}


function lossAdd(){
  var match=document.getElementById('loss-match')?.value.trim();
  var stake=parseFloat(document.getElementById('loss-stake')?.value);
  var odds=parseFloat(document.getElementById('loss-odds')?.value);
  var sel=document.getElementById('loss-sel')?.value.trim()||'';
  var result=document.getElementById('loss-result')?.value||'loss';
  var sport=document.getElementById('loss-sport-sel')?.value||'all';

  if(!match){toast('Renseignez le match','err');return;}
  if(!stake||stake<=0){toast('Mise invalide','err');return;}
  if(!odds||odds<=1){toast('Cote invalide (>1)','err');return;}

  var data=lossLoad();
  var gain=result==='win'?parseFloat(((stake*odds)-stake).toFixed(2)):0;
  data.entries.unshift({
    id:Date.now(), match:match, sel:sel, odds:odds, stake:stake, sport:sport,
    result:result, amount_lost:result==='loss'?stake:0, amount_won:result==='win'?gain:0,
    date:new Date().toISOString(), recovered:false
  });
  lossSave(data);

  ['loss-match','loss-sel','loss-stake','loss-odds'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});

  toast(result==='win'?'Gain enregistre (+'+gain.toFixed(2)+' €)!':'Perte enregistree.', result==='win'?'ok':'');

  lossRender();
  if(result==='loss' && selectedMethod){
    setTimeout(function(){ lossAutoSearch(); }, 400);
  }
}


function lossResetSession(){
  if(!confirm('Remettre a zero ? Tous les paris seront effaces et une nouvelle session commence.')) return;
  lossSave({entries:[]});
  toast('Session remise a zero !','ok');
  lossRender();
}
function lossMarkRecovered(){
  if(!confirm('Marquer toute la session comme recuperee ?')) return;
  var data=lossLoad();
  data.entries=data.entries.map(function(e){return Object.assign({},e,{recovered:true});});
  lossSave(data);
  toast('Session recuperee !','ok');
  lossRender();
}
function lossClearAll(){
  if(!confirm('Effacer tout l\'historique ? (Irreversible)')) return;
  lossSave({entries:[]});
  toast('Historique efface','ok');
  lossRender();
}
function lossDeleteEntry(id){
  var data=lossLoad();
  data.entries=data.entries.filter(function(e){return e.id!==id;});
  lossSave(data);
  lossRender();
}

function lossRender(){
  var data=lossLoad();
  var allEntries=data.entries||[];
  var filteredEntries=lossFilterByPeriod(allEntries);

  var wins=filteredEntries.filter(function(e){return e.result==='win';});
  var losses=filteredEntries.filter(function(e){return e.result==='loss';});
  var voids=filteredEntries.filter(function(e){return e.result==='void';});
  var totalBets=wins.length+losses.length;
  var winRate=totalBets>0?Math.round(wins.length/totalBets*100):0;
  var totalWon=wins.reduce(function(s,e){return s+(e.amount_won||0);},0);
  var totalLostPeriod=losses.reduce(function(s,e){return s+(e.amount_lost||0);},0);
  var netPL=totalWon-totalLostPeriod;
  var activeLosses=allEntries.filter(function(e){return !e.recovered&&e.result==='loss';});
  var totalActiveLost=activeLosses.reduce(function(s,e){return s+(e.amount_lost||0);},0);
  var lastOdds=activeLosses.length>0?activeLosses[0].odds:2.0;

  var statsPanel=document.getElementById('loss-stats-panel');
  var panel=document.getElementById('loss-recovery-panel');
  var histCard=document.getElementById('loss-history-card');
  var histList=document.getElementById('loss-history-list');

  if(statsPanel&&allEntries.length>0){
    var plColor=netPL>=0?'var(--gr)':'var(--re)';
    var chartE=[...filteredEntries].reverse().slice(-15);
    var maxV=Math.max.apply(null,chartE.map(function(e){return Math.max(e.amount_lost||0,e.amount_won||0);}));
    maxV=Math.max(maxV,1);
    statsPanel.innerHTML='<div class="card">'
      +'<div class="ct">Statistiques'+( lossPeriodFilter!=='all'?' — periode filtree':'')+'</div>'
      +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-bottom:12px">'
      +'<div class="tsm-cell"><div class="sv" style="color:var(--gr)">'+wins.length+'</div><label>Gagnes</label></div>'
      +'<div class="tsm-cell"><div class="sv" style="color:var(--re)">'+losses.length+'</div><label>Perdus</label></div>'
      +'<div class="tsm-cell"><div class="sv" style="color:var(--am)">'+voids.length+'</div><label>Void</label></div>'
      +'<div class="tsm-cell"><div class="sv" style="color:'+(winRate>=55?'var(--gr)':winRate>=40?'var(--am)':'var(--re)')+'">'+winRate+'%</div><label>% Gain</label></div>'
      +'<div class="tsm-cell"><div class="sv" style="color:'+plColor+'">'+(netPL>=0?'+':'')+netPL.toFixed(2)+' €</div><label>P&L net</label></div>'
      +'<div class="tsm-cell"><div class="sv" style="color:var(--re)">-'+totalActiveLost.toFixed(2)+' €</div><label>A recuperer</label></div>'
      +'</div>'
      +(totalBets>0?'<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:9px;color:var(--dm);font-family:var(--mo);margin-bottom:3px"><span style="color:var(--gr)">Gagnes '+winRate+'% ('+wins.length+')</span><span style="color:var(--re)">Perdus '+(100-winRate)+'% ('+losses.length+')</span></div><div style="height:6px;background:var(--bd);border-radius:3px;overflow:hidden;display:flex"><div style="width:'+winRate+'%;background:var(--gr)"></div><div style="width:'+(100-winRate)+'%;background:var(--re)"></div></div></div>':'')
      +(chartE.length>1?'<div style="display:flex;align-items:flex-end;gap:3px;height:48px;padding:0 2px">'
        +chartE.map(function(e){var val=e.result==='win'?(e.amount_won||0):(e.amount_lost||0);var h=Math.max(4,Math.round(val/maxV*44));var c=e.result==='win'?'var(--gr)':e.result==='loss'?'var(--re)':'var(--am)';return '<div title="'+esc(e.match)+'" style="flex:1;height:'+h+'px;background:'+c+';border-radius:1px 1px 0 0;opacity:.85;min-width:5px"></div>';}).join('')
        +'</div><div style="display:flex;gap:10px;font-size:9px;color:var(--dm);font-family:var(--mo);margin-top:4px"><span style="color:var(--gr)">Gain</span><span style="color:var(--re)">Perte</span><span style="color:var(--am)">Void</span></div>':'')
      +'</div>';
  } else if(statsPanel){ statsPanel.innerHTML=''; }

  if(!panel) return;

  if(!allEntries.length){
    panel.innerHTML='<div class="info">Aucun pari enregistre. Saisissez un resultat ci-dessus.</div>';
    if(histCard) histCard.style.display='none';
    return;
  }

  var panelHtml='';
  if(totalActiveLost>0){
    var bankroll = parseFloat(document.getElementById('loss-bankroll-input')?.value || '200') || 200;
    var calc = calcRecoveryStake(totalActiveLost, lastOdds, selectedMethod, bankroll);
    var gainNet=(calc.nextStake*(calc.coteCible-1)-totalActiveLost).toFixed(2);

    var sportBtns=[
      {val:'basketball',label:'Basket'},
      {val:'tennis',label:'Tennis'},
      {val:'mma',label:'MMA'},
      {val:'soccer',label:'Foot'},
      {val:'icehockey',label:'Hockey'},
      {val:'rugby',label:'Rugby'},
      {val:'all',label:'Tous'},
    ];

    panelHtml+='<div class="recovery-banner">'
      +'<div class="rb-label">Pertes actives a recuperer ('+activeLosses.length+' paris)</div>'
      +'<div class="rb-loss-total">-'+totalActiveLost.toFixed(2)+' €</div>'
      +'<div style="height:1px;background:rgba(167,139,250,.2);margin:12px 0"></div>'
      +'<div class="rb-label">Mise recommandee — '+(selectedMethod||'Standard')+' (aperçu, recalculée par match ci-dessous)</div>'
      +'<div class="rb-next-stake">'+calc.nextStake.toFixed(2)+' €</div>'
      +'<div class="rb-odds-target">Cote de référence @ '+calc.coteCible.toFixed(2)+'</div>'
      +'<div class="rb-expl">'+esc(calc.expl)+'<br>Gain net indicatif si victoire : <strong style="color:var(--gr)">'+gainNet+' €</strong><br>Ne misez que ce que vous pouvez perdre. Aucun pari garanti.</div>'
      +'</div>'
      +'<div style="margin-bottom:10px">'
      +'<div style="font-size:10px;color:var(--dm);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;font-family:var(--mo)">Sport prioritaire (facultatif)</div>'
      +'<div style="display:flex;gap:6px;flex-wrap:wrap" id="recovery-sport-btns">'
      +sportBtns.map(function(s){return '<button class="fbtn '+(s.val===recoverySport?'on':'')+'" onclick="setRecoverySport(\''+s.val+'\',this)">'+s.label+'</button>';}).join('')
      +'</div></div>'
      +'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">'
      +'<button class="btn bp" onclick="lossAutoSearch()">Trouver matchs pour récupération prudente</button>'
      +'<button class="btn bs" onclick="lossAutoSearch(1.70)">Aperçu @ 1.70</button>'
      +'<button class="btn bs" onclick="lossAutoSearch(2.50)">Aperçu @ 2.50</button>'
      +'</div>'
      +'<div id="loss-search-results"></div>';
  } else if(allEntries.length>0){
    panelHtml+='<div class="ok-box">Session equilibree ou beneficiaire !</div>';
  }
  panel.innerHTML=panelHtml;

  if(histCard) histCard.style.display='';
  if(histList){
    var toShow=filteredEntries;
    if(!toShow.length){ histList.innerHTML='<div style="text-align:center;padding:20px;color:var(--dm);font-size:12px">Aucun signal probabiliste cette periode.</div>'; return; }
    histList.innerHTML=toShow.map(function(e){
      var icon=e.result==='win'?'OK':e.result==='void'?'-':'PERDU';
      var amtColor=e.result==='win'?'var(--gr)':e.result==='loss'?'var(--re)':'var(--am)';
      var amtStr=e.result==='win'?'+'+(e.amount_won||0).toFixed(2)+' €':e.result==='loss'?'-'+(e.amount_lost||0).toFixed(2)+' €':'Void';
      var sl={soccer:'Football',basketball:'Basket',mma:'MMA',tennis:'Tennis',icehockey:'Hockey',rugby:'Rugby',baseball:'Baseball',americanfootball:'NFL'}[e.sport]||'Sport';
      return '<div class="loss-entry '+(!e.recovered&&e.result==='loss'?'active-loss':'')+'">'
        +'<div style="flex:1;min-width:0">'
        +'<div class="le-match">'+sl+' | '+esc(e.match)+(e.sel?' - '+esc(e.sel):'')+'</div>'
        +'<div style="display:flex;gap:6px;align-items:center;margin-top:3px;flex-wrap:wrap">'
        +'<span class="le-odds">@ '+e.odds+'</span><span class="le-stake">'+e.stake+' €</span>'
        +' '+icon+' '
        +(e.recovered?'<span class="bdg" style="background:var(--grb);color:var(--gr)">Recupere</span>':'')
        +'<span class="le-date">'+fmtDT(e.date)+'</span>'
        +'</div></div>'
        +'<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">'
        +'<span style="font-family:var(--mo);font-weight:700;color:'+amtColor+';font-size:13px">'+amtStr+'</span>'
        +'<button onclick="lossDeleteEntry('+e.id+')" style="background:none;border:none;color:var(--dm);cursor:pointer;font-size:11px;padding:2px">X</button>'
        +'</div></div>';
    }).join('');
  }
}

let _lossPeriod = 'today';
function setLossPeriod(val, el) {
  _lossPeriod = val;
  lossPeriodFilter = val;
  document.querySelectorAll('#loss-period-btns .fbtn, #loss-hist-period-btns .fbtn').forEach(b=>b.classList.remove('on'));
  if(el) el.classList.add('on');
  const w = document.getElementById('loss-custom-date-wrap');
  if(w) w.style.display = val==='custom'?'block':'none';
  lossRender();
}
function getLossSport() { return document.getElementById('loss-sport-filter')?.value||'all'; }
function getLossPeriodParams() {
  const now=new Date();
  const today=localDateStr(now);
  if(_lossPeriod==='live') return {date_filter:'live'};
  if(_lossPeriod==='tonight') {
    return {date_filter:'range',date_from:today,date_to:today,hour_from:'18',hour_to:'23'};
  }
  if(_lossPeriod==='tomorrow') { const d=new Date(now);d.setDate(d.getDate()+1);const t=localDateStr(d);return {date_filter:'range',date_from:t,date_to:t}; }
  if(_lossPeriod==='3d') { const d=new Date(now);d.setDate(d.getDate()+3);return {date_filter:'range',date_from:today,date_to:localDateStr(d)}; }
  if(_lossPeriod==='7d') { const d=new Date(now);d.setDate(d.getDate()+7);return {date_filter:'range',date_from:today,date_to:localDateStr(d)}; }
  if(_lossPeriod==='custom') { return {date_filter:'range',date_from:document.getElementById('loss-date-from')?.value||today,date_to:document.getElementById('loss-date-to')?.value||today}; }
  const d=new Date(now);d.setDate(d.getDate()+1);
  return {date_filter:'range',date_from:today,date_to:localDateStr(d)};
}
function filterOpsByPeriod(opps, pp) {
  if(!pp||(!pp.date_from&&pp.date_filter!=='live')) return opps;
  if(pp.date_filter==='live') { const now=Date.now();return opps.filter(o=>{const st=o.start_time||o.commence_time; if(!st) return false; const d=(new Date(st).getTime()-now)/60000;return d>=-60&&d<=120;}); }
  const from=new Date(pp.date_from+'T00:00:00').getTime();
  const to=pp.date_to?new Date(pp.date_to+'T23:59:59').getTime():from+86400000*7;
  return opps.filter(o=>{
    const st=o.start_time||o.commence_time; if(!st) return !pp.date_filter;
    const t=new Date(st).getTime(); if(t<from||t>to) return false;
    if(pp.hour_from||pp.hour_to){const h=new Date(st).getHours();
      if(pp.hour_from&&h<parseInt(pp.hour_from))return false;if(pp.hour_to&&h>parseInt(pp.hour_to))return false;}
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════
//  lossAutoSearch — recherche de rattrapage
// ═══════════════════════════════════════════════════════════════════
function matchRecoverySportFilter(leagueSport, filter) {
  if(!filter || filter==='all') return true;
  const s = (leagueSport||'').toLowerCase();
  const f = (filter||'').toLowerCase();
  const SPORT_ALIASES = {
    soccer: ['soccer'],
    basket: ['basket','basketball'],
    basketball: ['basket','basketball'],
    tennis: ['tennis'],
    mma: ['mma','boxing'],
    boxing: ['mma','boxing'],
    hockey: ['hockey','icehockey'],
    icehockey: ['hockey','icehockey'],
    rugby: ['rugby'],
    baseball: ['baseball'],
    american: ['american','americanfootball','nfl'],
    americanfootball: ['american','americanfootball','nfl'],
    nfl: ['american','americanfootball','nfl'],
    handball: ['handball'],
    volleyball: ['volleyball','volley'],
  };
  const keys = SPORT_ALIASES[f] || [f];
  return keys.some(k => s.includes(k));
}

async function lossAutoSearch(forcedOdds){
  const data    = lossLoad();
  const losses  = (data.entries||[]).filter(e=>!e.recovered && e.result==='loss');
  if(!losses.length){ toast('Aucune perte active','err'); return; }

  const method    = selectedMethod || 'pgi_prudente';
  const totalLost = losses.reduce((s,e)=>s+(e.stake||0),0);
  const lastOdds  = forcedOdds || losses[losses.length-1]?.odds || 1.80;
  const bankroll  = parseFloat(document.getElementById('loss-bankroll-input')?.value||'200')||200;
  const cnt = document.getElementById('loss-search-results');

  const histCards    = histLocalLoad();
  const settledCount = getSettledCards(histCards).length;
  const ultraPrudent = settledCount < 100;

  const _sortedAll = [...(data.entries||[])].sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  let consecutiveLosses = 0;
  for(const _e of _sortedAll) { if(_e.result==='loss' && !_e.recovered) consecutiveLosses++; else break; }

  if(consecutiveLosses >= 5){
    if(cnt) cnt.innerHTML = '<div class="warn" style="color:var(--re)">&#128683; Rattrapage bloqué : série de pertes trop élevée. Protection bankroll activée.</div>';
    toast('Rattrapage bloqué — protection bankroll','err');
    return;
  }

  let banners = '';
  if(consecutiveLosses >= 3) {
    banners += `<div class="warn" style="color:var(--am)">&#9888; ${consecutiveLosses} pertes consécutives — prudence renforcée.</div>`;
  }
  if(ultraPrudent) {
    banners += `<div class="warn" style="color:var(--am)">&#9888; Historique insuffisant (${settledCount} cartes réglées sur 100 requises) — mode ultra prudent activé : sélections TRÈS FORTES uniquement, mise plafonnée à 1% de la bankroll. Niveau FORT désactivé.</div>`;
  }

  if(cnt) cnt.innerHTML = banners + '<div class="ls"><div class="sp"></div><p>Analyse des opportunités en cours…</p></div>';

  const periodParams = getLossPeriodParams();
  const sportFilter  = getLossSport();
  const periodQS = Object.keys(periodParams).map(k=>'&'+encodeURIComponent(k)+'='+encodeURIComponent(periodParams[k])).join('');
  const ALL_LEAGUES = [
    ...FOOTBALL_LEAGUES.map(l => ({ sport:l.sport, market:'h2h' })),
    {sport:'basketball_nba',market:'h2h'},{sport:'basketball_euroleague',market:'h2h'},
    {sport:'tennis_atp',market:'h2h'},{sport:'tennis_wta',market:'h2h'},
    {sport:'mma_mixed_martial_arts',market:'h2h'},{sport:'boxing_boxing',market:'h2h'},
    {sport:'icehockey_nhl',market:'h2h'},{sport:'americanfootball_nfl',market:'h2h'},
    {sport:'baseball_mlb',market:'h2h'},{sport:'rugbyunion_premiership',market:'h2h'},
  ];
  const leagues = ALL_LEAGUES.filter(l=>matchRecoverySportFilter(l.sport, sportFilter))
    .filter(l=>!isLeagueExcluded(l.sport));

  const candidates = [];
  let blockedByHistory = false;

  for(const {sport, market} of leagues){
    try{
      const d = await api('/api/analyze?sport='+enc(sport)+'&market='+enc(market)+'&mode=standard'+periodQS);
      if(d.error || d.status==='error') { leagueFailRecord(sport); continue; }
      leagueFailReset(sport);
      const opps = d.opportunities||[];
      for(const o of filterOpsByPeriod(opps, periodParams)){
        const res = computeDirection(o, {mode:'standard', bankroll, riskProfile:'conservateur'});
        if(!res.shouldDisplay || res.direction!=='play') continue;

        if(res.tier === 'basic') continue;
        if(ultraPrudent && res.tier === 'solid') continue;

        if((res.evSimple||0) < 1.10) continue;
        if((res.kellyFull||0) <= 0) continue;
        if((res.edgeProb||0) < 4) continue;
        if(res.tier==='premium' && (res.dataQualityScore||0) < 60) continue;
        if(res.tier==='solid'   && (res.dataQualityScore||0) < 55) continue;

        if((sport.includes('mma')||sport.includes('box')) && method==='pgi_prudente') continue;
        if(sport.includes('soccer') && market==='h2h' && (res.modelProb||0) < 68) continue;

        const hAdj = res.historicalAdjustment || getHistoricalAdjustment(histCards, {
          sport, market, tier:res.tier, odds:o.odds, modelProb:res.modelProb,
          edgeProb:res.edgeProb, evSimple:res.evSimple, dataQualityScore:res.dataQualityScore
        });
        if(hAdj && (hAdj.status === 'blocked' || (hAdj.status==='negative' && hAdj.volume>=500 && (hAdj.roi||0) < -10))){
          blockedByHistory = true;
          continue;
        }

        candidates.push({...o, _sport:sport, _res:res, _hAdj:hAdj});
      }
    }catch(_){ leagueFailRecord(sport); }
  }

  candidates.sort((a,b)=>{
    if(recoverySport && recoverySport!=='all'){
      const pa = getSportFamily(a._sport)===recoverySport?0:1;
      const pb = getSportFamily(b._sport)===recoverySport?0:1;
      if(pa!==pb) return pa-pb;
    }
    const ta=a._res.tier==='premium'?0:1, tb=b._res.tier==='premium'?0:1;
    if(ta!==tb) return ta-tb;
    const rs=(b._res.reliabilityScore||0)-(a._res.reliabilityScore||0);
    if(rs!==0) return rs;
    const ds=(b._res.dataQualityScore||0)-(a._res.dataQualityScore||0);
    if(ds!==0) return ds;
    const es=(b._res.evSimple||0)-(a._res.evSimple||0);
    if(Math.abs(es)>0.001) return es>0?-1:1;
    const tA=a.start_time?new Date(a.start_time).getTime():Infinity;
    const tB=b.start_time?new Date(b.start_time).getTime():Infinity;
    return tA-tB;
  });

  if(!candidates.length){
    let msg = NO_RELIABLE_CARD_MESSAGE + ' Les cotes ou la validation statistique ne suffisent pas pour ce filtre.';
    if(blockedByHistory) msg = NO_RELIABLE_CARD_MESSAGE + ' L’historique récent de cette combinaison sport/marché impose l’abstention.';
    if(cnt) cnt.innerHTML = banners + `<div class="warn">&#128269; ${esc(msg)}</div>`;
    toast(NO_RELIABLE_CARD_MESSAGE,'');
    return;
  }

  const best = candidates.slice(0,5);
  let html = banners + `<div class="sbar"><div class="sdot" style="background:var(--gr)"></div>
    <span><strong>${best.length}</strong> opportunité(s) de rattrapage — ${esc(method)}</span>
    <span style="margin-left:auto;font-size:9px;color:var(--dm)">Bankroll: ${bankroll.toFixed(0)} €</span>
  </div>`;

  best.forEach((o)=>{
    const res = o._res, hAdj = o._hAdj;
    const recoveryForCard = calcRecoveryStake(totalLost, o.odds, method, bankroll);

    let finalRecoveryStake, stakeReducedNote, tierMsg;
    if(res.tier === 'premium') {
      finalRecoveryStake = recoveryForCard.nextStake;
      if(ultraPrudent) finalRecoveryStake = Math.min(finalRecoveryStake, bankroll*0.01);
      stakeReducedNote = ultraPrudent ? ' (plafonnée 1% — historique insuffisant)' : '';
      tierMsg = 'Rattrapage autorisé sur une sélection TRÈS FORTE, dans la limite de bankroll définie.';
    } else {
      finalRecoveryStake = recoveryForCard.nextStake * 0.60;
      stakeReducedNote = ' (réduite -40%)';
      tierMsg = 'Rattrapage autorisé uniquement avec mise réduite sur TRÈS SOLIDE.';
    }
    finalRecoveryStake = Math.round(finalRecoveryStake * 2) / 2;

    const tierCfg = {
      premium: {color:'var(--gr)', label:'TRÈS FORTE', icon:'&#128142;'},
      solid:   {color:'var(--am)', label:'TRÈS SOLIDE', icon:'&#11088;'},
    }[res.tier] || {color:'var(--neon)',label:'SOLIDE',icon:'&#9650;'};
    const selDisplay = translateSelection(o.selection,o.market,o.home_team,o.away_team,o.line);

    const histLine = (!hAdj || hAdj.status==='insufficient')
      ? `Ajustement historique : insuffisant — ${hAdj?hAdj.volume:0} cartes, aucune conclusion fiable`
      : `Ajustement historique : ${hAdj.status==='positive'?'positif':hAdj.status==='negative'?'négatif':'neutre'} — ${hAdj.volume} cartes, ROI ${hAdj.roi!=null?(hAdj.roi>0?'+':'')+hAdj.roi+'%':'—'}${hAdj.winRate!=null?', réussite '+hAdj.winRate+'%':''}`;

    const pgiStrong=pgiIsStrongSportsSignal(o,res);
    const globalConfidence=Math.round(pgiClamp100(res.displayConf||0));
    if(pgiStrong){tierCfg.label='SÉLECTION TRÈS FORTE À JOUER';tierCfg.color='#39ff14';tierCfg.icon='&#10003;';}
    html += `<div class="live-card${pgiStrong?' pgi-signal-tres-fort':''}" style="border-color:${tierCfg.color};margin-bottom:8px">
      <div style="padding:8px 12px;background:rgba(0,0,0,.2);display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--bd)">
        <span style="font-size:10px;font-weight:800;color:${tierCfg.color}">${tierCfg.icon} ${tierCfg.label}</span>
        <span style="margin-left:auto;font-family:var(--mo);font-size:14px;font-weight:700;color:${tierCfg.color}">Confiance globale : ${globalConfidence}%</span>
      </div>
      <div class="lc-head">
        <div style="flex:1">
          <div class="lc-teams">&#9917; ${esc(o.home_team||'?')} <span style="color:var(--dm)">vs</span> ${esc(o.away_team||'?')}</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
            <span class="bdg bsp">${esc(o.competition||o._sport||'')}</span>
            <span class="bdg bmk">${o.market||''}</span>
          </div>
          <div style="margin-top:8px">
            <div style="font-family:var(--mo);font-size:13px;font-weight:700;color:var(--am)">${esc(selDisplay)} @ ${o.odds}</div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px">
              <div style="text-align:center;background:var(--sf2);border-radius:4px;padding:4px">
                <div style="font-family:var(--mo);font-size:11px;font-weight:700;color:var(--neon)">${res.modelProb}%</div>
                <div style="font-size:8px;color:var(--dm)">Prob. modèle</div>
              </div>
              <div style="text-align:center;background:var(--sf2);border-radius:4px;padding:4px">
                <div style="font-family:var(--mo);font-size:11px;font-weight:700;color:var(--gr)">+${res.edgeProb}%</div>
                <div style="font-size:8px;color:var(--dm)">Avantage sur la cote</div>
              </div>
              <div style="text-align:center;background:var(--sf2);border-radius:4px;padding:4px">
                <div style="font-family:var(--mo);font-size:11px;font-weight:700;color:var(--am)">${res.evSimple?res.evSimple.toFixed(3):'—'}</div>
                <div style="font-size:8px;color:var(--dm)">Valeur attendue</div>
              </div>
              <div style="text-align:center;background:rgba(0,255,157,.07);border:1px solid rgba(0,255,157,.2);border-radius:4px;padding:4px">
                <div style="font-family:var(--mo);font-size:11px;font-weight:700;color:var(--gr)">${finalRecoveryStake.toFixed(2)} €</div>
                <div style="font-size:8px;color:var(--dm)">Mise récup.${stakeReducedNote}</div>
              </div>
            </div>
            <div style="font-size:9px;color:var(--dm);font-family:var(--mo);margin-top:6px">${esc(histLine)}</div>
          </div>
        </div>
      </div>
      <div style="padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid var(--bd)">
        ${bookieLinkHtml()}
        <button onclick="event.stopPropagation();copyTeamNames(this)" data-home="${esc(o.home_team||'')}" data-away="${esc(o.away_team||'')}"
          style="background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);border-radius:4px;color:var(--neon);font-size:10px;font-family:var(--mo);padding:5px 10px;cursor:pointer">&#128203; Copier</button>
        <div style="font-size:9px;color:${tierCfg.color};font-family:var(--mo);align-self:center">${esc(tierMsg)}</div>
      </div>
    </div>`;
  });

  html += '<div style="font-size:10px;color:var(--dm);text-align:center;margin-top:10px;font-style:italic">Analyse probabiliste — aucun pari garanti. Peut perdre malgré une EV positive.</div>';
  html += '<div style="font-size:10px;color:var(--am);text-align:center;margin-top:6px;font-style:italic">&#9888; Le rattrapage augmente le risque. Si vous êtes fatigué, énervé ou en série négative, ne jouez pas.</div>';
  if(cnt) cnt.innerHTML = html;
}

async function lossSearchMatches(targetOdds, customLeagues){ await lossAutoSearch(targetOdds); }
async function lossSearchMatchesSport(cote){ await lossAutoSearch(cote); }

// ═══════════════════════════════════════════════
//  METHODES GRID — selectMethod declenche calcul auto
// ═══════════════════════════════════════════════
const METHODS = [
  {id:'pgi_prudente',ico:'&#9733;',name:'Stratégie PGI prudente',
   sub:'TRÈS FORTE / FORTE uniquement — protection de la bankroll prioritaire',
   risk:'mr-low',riskLabel:'Faible à modéré',isDefault:true},
  {id:'martingale',ico:'M',name:'Martingale plafonnée',sub:'Double apres chaque perte',risk:'mr-vhi',riskLabel:'Tres eleve'},
  {id:'fibonacci',ico:'F',name:'Fibonacci',sub:'Suite de Fibonacci',risk:'mr-hi',riskLabel:'Eleve'},
  {id:'dalembert',ico:'D',name:"D'Alembert",sub:'+1 unite apres perte',risk:'mr-med',riskLabel:'Modere'},
  {id:'labouchere',ico:'L',name:'Labouchere',sub:'Sequence personnalisee',risk:'mr-hi',riskLabel:'Élevé'},
  {id:'flat',ico:'=',name:'Mise fixe',sub:'Mise constante',risk:'mr-low',riskLabel:'Faible'},
  {id:'kelly',ico:'K',name:'Kelly fractionnel',sub:'Optimisation mathematique',risk:'mr-med',riskLabel:'Modere'},
];

function initMethods() {
  const grid = document.getElementById('m-strat-grid');
  if (!grid) return;
  grid.innerHTML = METHODS.map(function(m) {
    var isSel = selectedMethod===m.id;
    return '<div class="m-strat-card'+(isSel?' sel':'')+'" data-mid="'+m.id+'" onclick="selectMethod(this.dataset.mid)">'
      +'<div class="msc-ico">'+m.ico+'</div>'
      +'<div class="msc-name">'+m.name+'</div>'
      +'<div class="msc-sub">'+m.sub+'</div>'
      +'<div class="msc-risk '+m.risk+'">'+m.riskLabel+'</div>'
      +'</div>';
  }).join('');
  lossRender();
  lossLoadCloud().then(function(){ lossRender(); }).catch(function(){});
}

function selectMethod(id) {
  selectedMethod = id;
  document.querySelectorAll('.m-strat-card').forEach(function(c){
    var isSelected = c.dataset.mid === id;
    c.classList.toggle('sel', isSelected);
  });
  lossRender();
  var data = lossLoad();
  var active = (data.entries||[]).filter(function(e){ return !e.recovered && e.result==='loss'; });
  if(active.length > 0) {
    setTimeout(function(){ lossAutoSearch(); }, 400);
  }
  toast('Strategie: '+id,'ok');
}

// ═══════════════════════════════════════════════
//  TICKER — couverture équilibrée de tous les sports + PMU/Turf
// ═══════════════════════════════════════════════
const TICKER_SPORT_COLORS = {
  soccer:     {bg:'rgba(34,197,94,.15)',color:'#4ade80'},
  basketball: {bg:'rgba(251,146,60,.15)',color:'#fb923c'},
  tennis:     {bg:'rgba(167,139,250,.15)',color:'var(--pu)'},
  mma:        {bg:'rgba(239,68,68,.2)',color:'#fca5a5'},
  boxing:     {bg:'rgba(239,68,68,.15)',color:'var(--re)'},
  icehockey:  {bg:'rgba(0,212,255,.15)',color:'var(--neon)'},
  americanfootball:{bg:'rgba(245,158,11,.15)',color:'var(--am)'},
  baseball:   {bg:'rgba(34,211,165,.15)',color:'var(--gr)'},
  rugby:      {bg:'rgba(167,139,250,.12)',color:'var(--pu)'},
  handball:   {bg:'rgba(56,189,248,.15)',color:'#7dd3fc'},
  volleyball: {bg:'rgba(250,204,21,.15)',color:'#facc15'},
  turf:       {bg:'rgba(167,255,190,.15)',color:'#7ee8a0'},
};

const TICKER_SPORT_ORDER = [
  'soccer', 'boxing', 'mma', 'basketball', 'turf', 'tennis', 'rugby',
  'icehockey', 'baseball', 'americanfootball', 'handball', 'volleyball',
];
const TICKER_LABELS = {
  soccer:'⚽ FOOTBALL', boxing:'🥊 BOXE', mma:'🥋 MMA', basketball:'🏀 BASKETBALL', turf:'🐎 PMU',
  tennis:'🎾 TENNIS', rugby:'🏉 RUGBY', icehockey:'🏒 HOCKEY SUR GLACE',
  baseball:'⚾ BASEBALL', americanfootball:'🏈 FOOTBALL US', handball:'🤾 HANDBALL',
  volleyball:'🏐 VOLLEY-BALL',
};

function tickerCategory(sport) {
  const value = String(sport || '').toLowerCase();
  if (value.includes('turf') || value.includes('pmu') || value.includes('horse')) return 'turf';
  if (value.includes('americanfootball') || value.includes('nfl')) return 'americanfootball';
  if (value.includes('icehockey') || value.includes('hockey')) return 'icehockey';
  if (value.includes('basket')) return 'basketball';
  if (value.includes('tennis')) return 'tennis';
  if (value.includes('rugby')) return 'rugby';
  if (value.includes('baseball')) return 'baseball';
  if (value.includes('handball')) return 'handball';
  if (value.includes('volley')) return 'volleyball';
  if (value.includes('boxing') || value.includes('boxe')) return 'boxing';
  if (value.includes('mma')) return 'mma';
  if (value.includes('soccer') || value === 'football' || value.includes('football_')) return 'soccer';
  return value || 'sport';
}

// Glossaire déterministe appliqué avant ET après la traduction IA. Il empêche
// les traductions littérales erronées comme « panier de basket » et distingue
// toujours le football européen du football américain.
const TICKER_FRENCH_SPORT_NAMES = {
  soccer:'football', boxing:'boxe', mma:'arts martiaux mixtes (MMA)', basketball:'basketball', turf:'courses hippiques PMU',
  tennis:'tennis', rugby:'rugby', icehockey:'hockey sur glace', baseball:'baseball',
  americanfootball:'football américain et NFL', handball:'handball', volleyball:'volley-ball',
};
const TICKER_TRANSLATION_CACHE_KEY = 'pgi_ticker_translations_v3';
const TICKER_TRANSLATION_CACHE_MAX = 240;

function tickerFrenchSportName(sport) {
  const category = tickerCategory(sport);
  return TICKER_FRENCH_SPORT_NAMES[category] || 'sport';
}

function normalizeTickerFrenchText(text, sport) {
  let value = String(text || '').trim();
  if (!value) return '';
  const category = tickerCategory(sport);

  value = value
    .replace(/\bpanier(?:s)?\s+(?:de\s+)?basket(?:-?ball)?\b/gi, 'basketball')
    .replace(/\bbasket[ -]?ball\b/gi, 'basketball')
    .replace(/\bhockey\s+(?:de|sur\s+la)\s+glace\b/gi, 'hockey sur glace')
    .replace(/\bvolley\s*ball\b/gi, 'volley-ball')
    .replace(/\bbase[ -]?ball\b/gi, 'baseball')
    .replace(/\bfootball\s+américain\s+américain\b/gi, 'football américain')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1');

  if (category === 'soccer') {
    value = value.replace(/\bsoccer\b/gi, 'football');
  } else if (category === 'basketball') {
    value = value.replace(/\bjeu\s+de\s+basket\b/gi, 'basketball');
  } else if (category === 'americanfootball') {
    value = value
      .replace(/\bfootball\s+US\b/gi, 'football américain')
      .replace(/\bfootball américain\s*\/\s*NFL\b/gi, 'NFL');
  } else if (category === 'icehockey') {
    value = value.replace(/\bice hockey\b/gi, 'hockey sur glace');
  } else if (category === 'boxing') {
    value = value.replace(/\bboxing\b/gi, 'boxe');
  } else if (category === 'mma') {
    value = value.replace(/\bmixed martial arts\b/gi, 'MMA').replace(/\bboxing\b/gi,'boxe');
  } else if (category === 'volleyball') {
    value = value.replace(/\bvolleyball\b/gi, 'volley-ball');
  }
  return value.trim();
}


// Les pays participant aux rencontres internationales sont affichés en français.
// Les noms de clubs, joueurs et combattants restent des noms propres inchangés.
const TICKER_FRENCH_COUNTRIES={
  'Albania':'Albanie','Armenia':'Arménie','Austria':'Autriche','Belarus':'Biélorussie',
  'Belgium':'Belgique','Bosnia and Herzegovina':'Bosnie-Herzégovine',
  'Croatia':'Croatie','Czech Republic':'République tchèque','Czechia':'Tchéquie',
  'Denmark':'Danemark','England':'Angleterre','Finland':'Finlande','France':'France',
  'Georgia':'Géorgie','Germany':'Allemagne','Greece':'Grèce','Hungary':'Hongrie',
  'Iceland':'Islande','Ireland':'Irlande','Israel':'Israël','Italy':'Italie',
  'Latvia':'Lettonie','Lithuania':'Lituanie','Montenegro':'Monténégro',
  'Netherlands':'Pays-Bas','North Macedonia':'Macédoine du Nord','Northern Ireland':'Irlande du Nord',
  'Norway':'Norvège','Poland':'Pologne','Portugal':'Portugal','Romania':'Roumanie',
  'San Marino':'Saint-Marin','Scotland':'Écosse','Serbia':'Serbie',
  'Slovakia':'Slovaquie','Slovenia':'Slovénie','Spain':'Espagne',
  'Sweden':'Suède','Switzerland':'Suisse','Turkey':'Turquie',
  'Ukraine':'Ukraine','Wales':'Pays de Galles','United States':'États-Unis'
};
function tickerFrenchMatchTitle(art){
  const category=tickerCategory(art.sport);
  const nationMatch=category==='soccer' && /(?:international|nations|euro|world_cup)/i.test(String(art.sport_key||'')+' '+String(art.description||''));
  const translate=team=>{
    const name=String(team||'').trim();
    return nationMatch?(TICKER_FRENCH_COUNTRIES[name]||name):name;
  };
  const home=translate(art.home_name),away=translate(art.away_name);
  if(home&&away)return home+' contre '+away;
  return normalizeTickerFrenchText(art.title||'',art.sport).replace(/\s+-\s+/,' contre ');
}
// Traductions locales fidèles pour quelques titres ESPN au format répétitif.
// Les autres titres doivent recevoir une vraie traduction avant publication.
function tickerOfflineFrenchNews(art){
  const s=String(art?.title||'').trim(),subject=tickerFrenchSportName(art?.sport);
  let m=s.match(/^(.+?)\s+(?:face|faces)\s+(.+?)\s+on\s+(\d+)-game win streak$/i);
  if(m)return `${m[1]} affronte ${m[2]} après ${m[3]} victoires consécutives`;
  m=s.match(/^(.+?)\s+take(?:s)? on\s+(.+?)\s+on\s+(\d+)-game skid$/i);
  if(m)return `${m[1]} affronte ${m[2]} après ${m[3]} défaites consécutives`;
  m=s.match(/^(.+?)\s+and\s+(.+?)\s+face off in conference matchup$/i);
  if(m)return `${m[1]} et ${m[2]} s'affrontent dans leur conférence`;
  m=s.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+?)$/i);
  if(m)return `${m[1]} contre ${m[2]}`;
  m=s.match(/^(.+?)\s+(?:hosts|host)\s+(.+?)$/i);
  if(m)return `${m[1]} reçoit ${m[2]}`;
  if(/Sunday's fantasy basketball adds and bets to make in the NBA/i.test(s))
    return 'NBA : sélections fantasy et paris à examiner ce dimanche';
  return null;
}
function tickerHasFrenchArticleTitle(art){
  if(art?.is_match||art?._turfRaceId)return true;
  // Google Actualités fournit déjà des titres en français : aucune traduction AI
  // n'est nécessaire pour les afficher, et les rencontres restent prioritaires.
  if(art?.language==='fr' && String(art?.source||'').startsWith('Google Actualités')){
    const title=String(art.title||'').trim();
    return title.length>=12 && !/[<>]/.test(title);
  }
  const title=String(art?._translatedTitle||'').trim();
  if(!title||title.toLocaleLowerCase('fr')===String(art?.title||'').trim().toLocaleLowerCase('fr'))return false;
  // Détecte une traduction restée massivement en anglais.
  if(/\b(?:faces|face off|win streak|skid|take on|against|preview|breaking|ranking|players to watch|recap)\b/i.test(title))return false;
  return true;
}

function tickerTranslationFingerprint(art) {
  const input = [tickerCategory(art?.sport), art?.title || '', art?.description || ''].join('|');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function tickerReadTranslationCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(TICKER_TRANSLATION_CACHE_KEY) || '{}');
    return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
  } catch (_) { return {}; }
}

function tickerWriteTranslationCache(cache) {
  try {
    const entries = Object.entries(cache || {})
      .sort((a,b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
      .slice(0, TICKER_TRANSLATION_CACHE_MAX);
    localStorage.setItem(TICKER_TRANSLATION_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (_) {}
}

// Un tour par catégorie avant de passer au deuxième élément. Ainsi le PMU
// reste visible sans repousser le football, le MMA et les autres sports sous
// plusieurs écrans. Les doublons et les flux surabondants sont plafonnés.
function buildBalancedTickerItems(sportItems, turfItems, maxItems = 120) {
  // Augmente la couverture sans évincer les vrais articles de presse.
  const groups = new Map(),seen=new Set();
  for(const item of [...(sportItems||[]),...(turfItems||[])]) {
    if(item?.is_status)continue;const title=String(item?.title||'').trim();if(!title)continue;
    const category=tickerCategory(item.sport),fp=(category+'|'+title).toLocaleLowerCase('fr');
    if(seen.has(fp))continue;seen.add(fp);
    if(!groups.has(category))groups.set(category,{matches:[],articles:[]});
    const group=groups.get(category),bucket=item.is_match?group.matches:group.articles;
    if(bucket.length<(item.is_match?10:40))bucket.push({...item,sport:category});
  }
  const buckets=new Map();
  for(const [category,group] of groups){
    // Le fil choisit d'abord les publications les plus récentes, et non les premières dans le cache.
    group.articles.sort((a,b)=>(Date.parse(b.published||'')||0)-(Date.parse(a.published||'')||0));
    let entries;
    if(group.matches.length){
      // Rencontres toujours prioritaires, mais les nouvelles en français restent visibles.
      // Maximum 8 rencontres et 2 actualités par sport, sans remplacer les affiches.
      const matches=group.matches.slice(0,8), articles=group.articles.slice(0,2);
      entries=[...matches.slice(0,3),...articles.slice(0,1),
        ...matches.slice(3),...articles.slice(1)];
    }else entries=group.articles.slice(0,4);
    buckets.set(category,entries);
  }
  const extraCategories=[...buckets.keys()].filter(x=>!TICKER_SPORT_ORDER.includes(x)).sort();
  const order=[...TICKER_SPORT_ORDER,...extraCategories],balanced=[];
  for(let round=0;round<12&&balanced.length<maxItems;round++) {
    for(const category of order){const item=buckets.get(category)?.[round];if(item)balanced.push(item);if(balanced.length>=maxItems)break;}
  }
  return balanced;
}

function getTickerStyle(sport) {
  for (const [key,style] of Object.entries(TICKER_SPORT_COLORS)) {
    if ((sport||'').toLowerCase().includes(key)) return style;
  }
  return {bg:'rgba(78,106,138,.15)',color:'var(--mu)'};
}

// L'article original provient uniquement du champ URL publié par le fournisseur.
// Ne jamais fabriquer une adresse à partir d'un titre ou rediriger vers la page d'accueil.
function tickerExactArticleUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    if (/^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/i.test(url.hostname)) return '';
    return url.href;
  } catch (_) { return ''; }
}

// Google Traduction ouvre la même URL, langue détectée automatiquement, cible FR.
// L'article d'origine reste accessible si la traduction du site est indisponible.
function tickerFrenchArticleUrl(original) {
  return original ? 'https://translate.google.com/translate?sl=auto&tl=fr&hl=fr&u=' + encodeURIComponent(original) : '';
}

let tickerPaused = false;
let tickerAnimFrame = null;
let tickerLoadSequence = 0;
const tickerScrollState = { position:0, userScrolling:false, lastTouch:0, lastFrame:0 };
function tickerToggle() {
  tickerPaused = !tickerPaused;
  tickerScrollState.lastFrame = 0;
  const btn = document.getElementById('ticker-pause-btn');
  if (btn) btn.textContent = tickerPaused ? '▶ Reprendre' : '⏸ Pause';
}

const TICKER_EMERGENCY_SPORTS = [
  ['⚽ FOOTBALL','Football'],['🥊 MMA','MMA'],['🏀 BASKETBALL','Basketball'],
  ['🎾 TENNIS','Tennis'],['🏉 RUGBY','Rugby'],['🏒 HOCKEY','Hockey sur glace'],
  ['⚾ BASEBALL','Baseball'],['🏈 FOOTBALL US','Football américain'],
  ['🤾 HANDBALL','Handball'],['🏐 VOLLEY','Volley-ball'],['🐎 PMU','PMU Turf']
];

// Les badges ne disparaissent jamais : avant la première réponse, ou si un
// fournisseur est momentanément lent, l'interface affiche l'état de veille.
function renderTickerSafetyFallback(message='Actualisation des actualités sportives…', force=false) {
  const inner=document.getElementById('news-ticker-inner');
  const clone=document.getElementById('news-ticker-clone');
  const source=document.getElementById('ticker-source');
  if(!inner)return;
  if(!force&&inner.querySelector('.ticker-item:not(.ticker-safety)'))return;
  const html=`<div class="ticker-loading" role="status" style="padding:15px;color:#b8cce2;font:11px var(--mo);text-align:center">${esc(message)}</div>`;
  inner.innerHTML=html;
  if(clone)clone.innerHTML=html;
  if(source)source.textContent='Flux multisports et PMU';
}

// getTurfTickerArticles — transforme les prochaines courses PMU (déjà
// normalisées côté Worker par /api/turf/upcoming) en items de ticker,
// dans le même format que les articles sportifs. Best-effort : si la
// source PMU échoue, le ticker continue avec les autres sports sans
// bloquer ni afficher d'erreur (même philosophie que le reste du ticker).
// Secours local sans consommation D1 : le dernier calendrier vérifié est conservé
// si un fournisseur ou le quota Cloudflare devient temporairement indisponible.
const BETPRO_TICKER_FIXTURES_STORE='pgi_betpro_ticker_fixtures_v125';
const BETPRO_TICKER_TURF_STORE='pgi_betpro_ticker_turf_v125';
function betproTickerReadLocal(key){
  try { const o=JSON.parse(localStorage.getItem(key)||'null');
    return o&&Array.isArray(o.items)?o.items:[]; }catch(_){return [];}
}
function betproTickerFutureMatches(items){
  const now=Date.now(),ids=new Set();
  return (Array.isArray(items)?items:[]).filter(x=>{
    const start=Date.parse(x?.event_start_at||'');
    if(!x?.is_match||!x.event_id||!x.home_name||!x.away_name||!Number.isFinite(start)||start<=now+120000||ids.has(x.event_id))return false;
    ids.add(x.event_id);return true;
  }).map(x=>{
    const clean={...x};
    if(/^boxing(?:_|$)/i.test(String(clean.sport_key||'')))clean.sport='boxing';
    else if(/^mma(?:_|$)/i.test(String(clean.sport_key||'')))clean.sport='mma';
    if(clean.market_consensus?.status==='ok'){
      const checked=Date.parse(clean.market_consensus.last_odds_at||''),start=Date.parse(clean.event_start_at),maxAge=start-now<=86400000?21600000:86400000;
      if(!Number.isFinite(checked)||checked>now+30000||now-checked>maxAge)clean.market_consensus=null;
    }
    return clean;
  }).slice(0,100);
}
function betproTickerSaveLocal(key,items){
  try{localStorage.setItem(key,JSON.stringify({items,at:new Date().toISOString()}));}catch(_){}
}
async function getTurfTickerArticles(){
  const fetchDay=async(dateFilter)=>{
    const response=await api('/api/turf/upcoming?date_filter='+enc(dateFilter),'GET',null,{timeoutMs:11000});
    return Array.isArray(response?.races)?response.races:[];
  };
  const now=Date.now();
  try{
    let races=await fetchDay('today');
    races=races.filter(r=>{
      const time=Date.parse(r.start_time||'');
      if(Number.isFinite(time))return time>=now-300000;
      if(r.date&&r.time){const alt=Date.parse(`${r.date}T${r.time}:00Z`);return Number.isFinite(alt)&&alt>=now-300000;}
      return false;
    }).sort((a,b)=>Date.parse(a.start_time||0)-Date.parse(b.start_time||0));
    // Une fois les courses du jour terminées, publier celles de demain,
    // jamais d'anciennes courses présentées comme de prochaines épreuves.
    if(!races.length){
      races=(await fetchDay('tomorrow')).filter(r=>Number.isFinite(Date.parse(r.start_time||''))&&Date.parse(r.start_time)>now).sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time));
    }
    const selected=races.slice(0,8),items=selected.map(r=>{
      const time=Date.parse(r.start_time||'');
      const displayTime=Number.isFinite(time)?new Date(time).toLocaleString('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):String(r.time||'');
      return {sport:'turf',title:`${r.hippodrome} ${r.reunion}${r.race_number} — ${r.race_name||'Course PMU'}`,
        description:[r.discipline||'',r.distance?r.distance+' m':'',r.runners_count?r.runners_count+' partants':'',r.is_quinte?'QUINTÉ+':'','Départ '+displayTime].filter(Boolean).join(' · '),
        published:r.start_time||new Date().toISOString(),link:'',is_match:true,_label:'🐎 PMU',_turfRaceId:r.race_id};
    });
    if(items.length)betproTickerSaveLocal(BETPRO_TICKER_TURF_STORE,items);
    return items.length?items:betproTickerReadLocal(BETPRO_TICKER_TURF_STORE).filter(x=>Date.parse(x.published||'')>now-300000).slice(0,8);
  }catch(e){
    console.warn('Ticker PMU : reprise du dernier calendrier enregistré.',e?.message||e);
    return betproTickerReadLocal(BETPRO_TICKER_TURF_STORE).filter(x=>Date.parse(x.published||'')>now-300000).slice(0,8);
  }
}


// Actualités internationales traduites : récupération indépendante et non
// bloquante, sans modification des rencontres, des courses ou des pronostics.
const BETPRO_GLOBAL_FR_NEWS_KEY = 'pgi_betpro_news_fraiches_v155';
const BETPRO_GLOBAL_FR_SPORTS = 'soccer,boxing,mma,basketball,tennis,rugby,icehockey,baseball,americanfootball,handball,volleyball';
let betproGlobalNewsRequest = null;
let betproGlobalNewsLastCheck = 0;
function betproTickerReadGlobalNews() {
  try {
    const data = JSON.parse(localStorage.getItem(BETPRO_GLOBAL_FR_NEWS_KEY) || 'null');
    if (!data || !Array.isArray(data.items) || !data.at) return [];
    const age = Date.now() - Date.parse(data.at);
    if (!Number.isFinite(age) || age < 0 || age > 90 * 60000) return [];
    return data.items.filter(article => {
      const pub = Date.parse(article?.published || '');
      return !article?.is_match && (article?._translatedTitle || article?.language === 'fr')
        && Number.isFinite(pub) && pub <= Date.now() + 3600000
        && Date.now() - pub < ((['boxing','mma','rugby','handball','volleyball','baseball'].includes(article.sport) ? 7 : 3) * 86400000);
    }).slice(0, 32);
  } catch (_) { return []; }
}
function betproLoadTranslatedNewsInBackground() {
  if (betproGlobalNewsRequest || Date.now() - betproGlobalNewsLastCheck < 120000) return;
  betproGlobalNewsLastCheck = Date.now();
  betproGlobalNewsRequest = api('/api/news/translated?sports=' + enc(BETPRO_GLOBAL_FR_SPORTS),
    'GET', null, {timeoutMs: 28000}).then(payload => {
      if (!Array.isArray(payload?.news) || !payload.news.length) return;
      const news = payload.news.filter(article => !article?.is_match &&
        typeof article._translatedTitle === 'string' &&
        article._translatedTitle.trim() &&
        article.link && article.published).slice(0, 32);
      if (!news.length) return;
      const old = betproTickerReadGlobalNews();
      const signature = items => JSON.stringify(items.map(i =>
        [i.sport, i.link, i._translatedTitle, i.published]));
      if (signature(news) === signature(old)) return;
      try {
        localStorage.setItem(BETPRO_GLOBAL_FR_NEWS_KEY,
          JSON.stringify({at: new Date().toISOString(), items: news}));
      } catch (_) {}
      if (!document.hidden && document.getElementById('news-ticker-inner')) {
        setTimeout(() => loadTicker().catch(e =>
          console.warn('Rafraîchissement des news traduites indisponible', e?.message || e)), 300);
      }
    }).catch(error => {
      console.warn('Actualités traduites : conservation du cache existant', error?.message || error);
    }).finally(() => { betproGlobalNewsRequest = null; });
}

async function getSportTickerArticles(){
  betproLoadTranslatedNewsInBackground();
  const sports='soccer,boxing,mma,basketball,tennis,rugby,icehockey,baseball,americanfootball,handball,volleyball';
  const local=betproTickerFutureMatches(betproTickerReadLocal(BETPRO_TICKER_FIXTURES_STORE));
  try{
    const data=await api('/api/ticker?sports='+enc(sports),'GET',null,{timeoutMs:14000});
    const incoming=Array.isArray(data?.items)?data.items:[];
    const matches=betproTickerFutureMatches(incoming.filter(x=>x?.is_match));
    const unique=new Set(matches.map(x=>String(x.event_id)));
    const restored=local.filter(x=>!unique.has(String(x.event_id)));
    const combined=[...matches,...restored].sort((a,b)=>Date.parse(a.event_start_at)-Date.parse(b.event_start_at));
    if(combined.length)betproTickerSaveLocal(BETPRO_TICKER_FIXTURES_STORE,combined);
    return{items:[...combined,...betproTickerReadGlobalNews(),...incoming.filter(x=>!x?.is_match&&!x?.is_status)],
      meta:{...data,fixtures_visible:combined.length,fixtures_from_local:restored.length}};
  }catch(error){
    // La panne de l'API principale ne transforme plus le flux en simples titres.
    try{
      const legacy=await api('/api/news?sports='+enc(sports),'GET',null,{timeoutMs:11000});
      return{items:[...local,...betproTickerReadGlobalNews(),...(legacy.news||[])],meta:{...legacy,degraded:true,fixtures_from_local:local.length}};
    }catch(_){
      console.warn('Ticker multisports temporairement indisponible:',error?.message||error);
      return{items:[...local,...betproTickerReadGlobalNews()],meta:{degraded:true,fixtures_from_local:local.length}};
    }
  }
}

function tickerMatchMarketHtml(art){
  if(!art?.is_match || art._turfRaceId || tickerCategory(art.sport)==='turf')return '';
  const m=art.market_consensus;
  // Un match reste visible sans consensus; seuls les favoris étayés sont affichés.
  if(!m || m.status!=='ok' || Number(m.bookmakers)<2 || !Number.isFinite(Number(m.probability)) || Number(m.probability)<=0 || Number(m.probability)>1) return '';
  const pct=value=>Number.isFinite(Number(value))?(Math.round(Number(value)*1000)/10).toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1})+' %':'—';
  const books=Math.max(0,Number(m.bookmakers)||0);
  const providerNames=Array.isArray(m.providers)?m.providers.filter(Boolean).slice(0,4).join(', '):'';
  const observed=Number.isFinite(Date.parse(m.last_odds_at||''))?new Date(m.last_odds_at).toLocaleString('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'date inconnue';
  const home=String(art.home_name||'Domicile'),away=String(art.away_name||'Extérieur');
  const draw=m.draw_probability==null?'':` · Nul ${pct(m.draw_probability)}`;
  const breakdown=`${esc(home)} ${pct(m.home_probability)}${draw} · ${esc(away)} ${pct(m.away_probability)}`;
  const favorite=String(m.favorite||'Aucun favori identifiable');
  const quality=m.quality==='marqué'?'favori marqué':m.quality==='modéré'?'favori modéré':'marché serré, tendance indicative';
  return `<div class="ticker-consensus">
    <span class="ticker-consensus-label">FAVORI SELON LES BOOKMAKERS</span>
    <span class="ticker-consensus-team">${esc(favorite)}</span>
    <span class="ticker-consensus-figure">${pct(m.probability)}</span>
    <div class="ticker-consensus-breakdown">${breakdown}</div>
    <div class="ticker-consensus-detail">${books} bookmaker${books>1?'s':''} indépendant${books>1?'s':''} · ${quality} · cote médiane ${Number(m.median_market_odds||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})} · cotations du ${esc(observed)}${providerNames?' · '+esc(providerNames):''}</div>
    <div class="ticker-consensus-detail">Estimation de marché corrigée de la marge, sans garantie de résultat. Distincte des modèles BetPro.</div>
  </div>`;
}

// Recherche multisports rapide: affichage instantané depuis le dernier résultat
// encore exploitable, actualisation parallèle et traductions non bloquantes.
const BETPRO_TICKER_FAST_SNAPSHOT_KEY='betpro_ticker_snapshot_v1';
const tickerTranslateJobs=new Map(),tickerTranslateAttempts=new Map();
let tickerRefreshPending=null;
function betproTickerReadFastSnapshot(){
  try{
    const saved=JSON.parse(localStorage.getItem(BETPRO_TICKER_FAST_SNAPSHOT_KEY)||'null');
    const now=Date.now();
    if(!saved||!Array.isArray(saved.items)||!Number.isFinite(saved.at)||saved.at>now+30000||now-saved.at>6*3600000)return[];
    const matches=betproTickerFutureMatches(saved.items.filter(x=>x?.is_match&&!x?._turfRaceId));
    const turf=saved.items.filter(x=>x?._turfRaceId&&Number.isFinite(Date.parse(x.published||''))&&Date.parse(x.published)>now-300000);
    const articles=saved.items.filter(x=>{
      if(!x||x.is_match||x.is_status||!tickerHasFrenchArticleTitle(x))return false;
      const t=Date.parse(x.published||''),ttl=['boxing','mma','rugby','handball','volleyball','baseball'].includes(String(x.sport))?7*86400000:3*86400000;
      return Number.isFinite(t)&&t<=now+3600000&&now-t<ttl;
    });
    return buildBalancedTickerItems([...matches,...articles],turf);
  }catch(_){return[];}
}
function betproTickerSaveFastSnapshot(items){
  try{
    const payload=JSON.stringify({at:Date.now(),items:items.slice(0,120)});
    if(payload.length<=450000)localStorage.setItem(BETPRO_TICKER_FAST_SNAPSHOT_KEY,payload);
  }catch(_){}
}
function betproTickerRender(news,sportPayload,loadSequence,persistSnapshot=false){
  if(loadSequence!==tickerLoadSequence)return;
  try{
    const inner = document.getElementById('news-ticker-inner');
    const clone = document.getElementById('news-ticker-clone');
    const source = document.getElementById('ticker-source');
    if (!inner) return;

    const sportCategories = new Set(news.filter(item => tickerCategory(item.sport) !== 'turf').map(item => tickerCategory(item.sport)));
    const hasTurf = news.some(item => tickerCategory(item.sport) === 'turf');
    const degraded = !!sportPayload.meta?.degraded;
    const completeMultisport = sportCategories.size >= 11;
    if (source) source.textContent = news.length
      ? `${news.filter(x=>x.is_match).length} rencontres · ${news.filter(x=>!x.is_match&&!x.is_status&&tickerHasFrenchArticleTitle(x)).length} actus FR · ${sportCategories.size} sport${sportCategories.size>1?'s':''}${hasTurf?' + PMU':''}${completeMultisport?' · couverture complète':(degraded?' · flux partiel':'')}`
      : 'Flux momentanément indisponible';
    if (!news.length) {
      if (tickerAnimFrame) cancelAnimationFrame(tickerAnimFrame);
      tickerAnimFrame = null;
      renderTickerSafetyFallback('Flux en cours de mise à jour. Seules les rencontres et actualités vérifiées sont publiées.', true);
      return;
    }

    const sorted = news;
    sorted.forEach((art,i) => { art._id = 'tk'+i; });

    // Seules les actualités ESPN ont besoin d'une traduction. Les affiches D1
    // contiennent surtout des noms propres et ne doivent jamais être réécrites.
    // Le cache stabilise les libellés et évite une nouvelle requête à chaque
    // retour sur le tableau de bord.
    const translationCache = tickerReadTranslationCache();
    const cacheMaxAge = 30 * 86400000;
    const toTranslate = [];
    for (const art of sorted) {
      if (art.sport === 'turf' || art.is_status || art.is_match || String(art.source||'').toUpperCase() !== 'ESPN') continue;
      if (tickerHasFrenchArticleTitle(art)) continue; // déjà traduit côté Worker
      const cacheKey = tickerTranslationFingerprint(art);
      const cached = translationCache[cacheKey];
      if (cached && Date.now() - Number(cached.at||0) < cacheMaxAge) {
        art._translatedTitle = normalizeTickerFrenchText(cached.title || art.title, art.sport);
        art._translatedDescription = normalizeTickerFrenchText(cached.description || art.description, art.sport);
      } else {
        const offline=tickerOfflineFrenchNews(art);
        if(offline){
          art._translatedTitle=offline;
          art._translatedDescription='';
          translationCache[cacheKey]={title:offline,description:'',at:Date.now()};
        } else {
          art._translationCacheKey=cacheKey;
          toTranslate.push(art);
        }
      }
    }
    tickerWriteTranslationCache(translationCache);

    // Traduction en arrière-plan pour ne pas bloquer les rencontres.
    if (toTranslate.length) {
      const key=toTranslate.map(tickerTranslationFingerprint).join('|');
      const last=tickerTranslateAttempts.get(key)||0;
      if(!tickerTranslateJobs.has(key)&&Date.now()-last>=5*60*1000){
        tickerTranslateAttempts.set(key,Date.now());
        if(tickerTranslateAttempts.size>40)tickerTranslateAttempts.delete(tickerTranslateAttempts.keys().next().value);
        const work=(async()=>{
      try {
        const blocks = toTranslate.map(art => [
          `SPORT: ${tickerFrenchSportName(art.sport)}`,
          `TITRE: ${art.title || ''}`,
          `DESCRIPTION: ${art.description || ''}`,
        ].join('\n')).join('\n---\n');
        const resp = await api('/api/chat', 'POST', {
          messages: [{role:'user', content:
`Traduis ces actualités sportives en français naturel, précis et concis.
Le champ SPORT fixe obligatoirement le contexte.

GLOSSAIRE OBLIGATOIRE :
soccer = football ; basketball = basketball, jamais « panier de basket » ;
american football = football américain ou NFL ; ice hockey = hockey sur glace ;
boxing = boxe ; baseball = baseball ; volleyball = volley-ball.

Conserve exactement les noms de clubs, équipes, joueurs, compétitions et lieux.
Ne traduis jamais un nom propre. N'invente aucune information.
Pour chaque bloc, réponds exactement sous cette forme :
TITRE: traduction
DESCRIPTION: traduction
Sépare les blocs uniquement par --- et ne donne aucun commentaire.

${blocks}`}]
        }, {timeoutMs:8000});
        if (loadSequence !== tickerLoadSequence) return;
        const rawTranslation = String(resp.response || resp.content || '')
          .replace(/```(?:text|plaintext)?/gi,'').replace(/```/g,'').trim();
        const translatedBlocks = rawTranslation ? rawTranslation.split(/\s*\n?---\n?\s*/) : [];
        translatedBlocks.forEach((block, i) => {
          const art = toTranslate[i];
          if (!art) return;
          const titleMatch = block.match(/(?:^|\n)\s*TITRE\s*:\s*([^\n]+)/i);
          const descriptionMatch = block.match(/(?:^|\n)\s*DESCRIPTION\s*:\s*([\s\S]*)$/i);
          if(!titleMatch?.[1]?.trim())return;
          const translatedTitle = normalizeTickerFrenchText(titleMatch[1], art.sport);
          const translatedDescription = normalizeTickerFrenchText(descriptionMatch?.[1] || '', art.sport);
          art._translatedTitle = translatedTitle;
          art._translatedDescription = translatedDescription;
          translationCache[art._translationCacheKey] = {
            title:translatedTitle, description:translatedDescription, at:Date.now(),
          };
        });
        tickerWriteTranslationCache(translationCache);
      } catch (translationError) {
        console.warn('Traduction ticker indisponible:', translationError && translationError.message ? translationError.message : translationError);
      }
        })();
        tickerTranslateJobs.set(key,work);
        void work.then(()=>{
          if(loadSequence===tickerLoadSequence&&toTranslate.some(tickerHasFrenchArticleTitle))
            betproTickerRender(news,sportPayload,loadSequence);
        }).finally(()=>{if(tickerTranslateJobs.get(key)===work)tickerTranslateJobs.delete(key);});
      }
    }
    const renderItem = (art) => {
      const style = getTickerStyle(art.sport||'');
      const label = art._label || TICKER_LABELS[tickerCategory(art.sport)] || '🏆 SPORT';
      const displayTitle = art.is_match&&!art._turfRaceId ? tickerFrenchMatchTitle(art) : normalizeTickerFrenchText(art._translatedTitle || art.title || '', art.sport);
      const displayDescription = normalizeTickerFrenchText((art.is_match||art._turfRaceId)?(art.description||''):(art._translatedDescription||''), art.sport);
      const marketLine = tickerMatchMarketHtml(art);

      let dateStr = '';
      if (art.published) {
        try {
          const pub = new Date(art.published);
          dateStr = pub.toLocaleDateString('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',year:'2-digit'})
            + ' ' + pub.toLocaleTimeString('fr-FR',{timeZone:'Europe/Paris',hour:'2-digit',minute:'2-digit'});
        } catch(_) {}
      }

      // Les affiches sportives D1 ne sont pas des articles : on ne leur invente pas de lien.
      const originalArticle = (!art.is_status && !art.is_match && !art._turfRaceId)
        ? tickerExactArticleUrl(art.link) : '';
      const nativeFrench=art.language==='fr' && String(art.source||'').startsWith('Google Actualités');
      const frenchArticle = nativeFrench?originalArticle:tickerFrenchArticleUrl(originalArticle);
      const titleHtml = frenchArticle
        ? `<a href="${esc(frenchArticle)}" target="_blank" rel="noopener noreferrer" title="${nativeFrench?'Lire l’article original en français':'Lire cet article en français (traduction automatique)'}">${esc(displayTitle)}</a>`
        : esc(displayTitle);
      const turfAttr = art._turfRaceId ? ` data-turf-race="${esc(art._turfRaceId)}"` : '';
      const clickable = !!(frenchArticle || art._turfRaceId);
      return `<div class="ticker-item ${art.is_match?'ticker-match':''}" data-href="${esc(frenchArticle)}"${turfAttr}${clickable?' role="link" tabindex="0"':''} style="${clickable?'cursor:pointer;':'cursor:default;'}">
        <span class="ticker-sport-badge" style="background:${style.bg};color:${style.color}">${label}</span>
        <div style="flex:1;min-width:0">
          <div class="ticker-title" id="ticker-t-${art._id||Math.random().toString(36).slice(2)}">${titleHtml}</div>
          ${displayDescription?`<div class="ticker-description">${esc(displayDescription.slice(0,220))}${displayDescription.length>220?'…':''}</div>`:''}
          ${art.source?`<div class="ticker-meta">Source : ${esc(art.source)}</div>`:''}
          ${dateStr?`<div class="ticker-meta">${art.is_match?'Rencontre le':'Publié le'} ${esc(dateStr)} (Paris)</div>`:''}
          ${marketLine}
          ${frenchArticle?`<div class="ticker-read-links"><a class="ticker-read-primary" href="${esc(frenchArticle)}" target="_blank" rel="noopener noreferrer">${nativeFrench?'Lire l’article en français':'Lire la traduction française'}</a>${nativeFrench?'':`<a class="ticker-read-original" href="${esc(originalArticle)}" target="_blank" rel="noopener noreferrer" title="Voir l’article original">Article original</a>`}</div>`:''}
          ${art._turfRaceId?`<div class="ticker-meta" style="color:#a8efc0">Voir la course PMU dans BetPro</div>`:''}
        </div>
      </div>`;
    };

    // Conserver toutes les rencontres; un article ESPN sans titre français
    // reste en réserve jusqu'à traduction vérifiable, sans titre anglais affiché.
    const visibleItems=sorted.filter(tickerHasFrenchArticleTitle);
    if(persistSnapshot && !sportPayload?.meta?.degraded) betproTickerSaveFastSnapshot(visibleItems);
    const html = visibleItems.map(renderItem).join('');
    inner.innerHTML = html;
    if (clone) clone.innerHTML = html;

    const tickerBox = document.getElementById('news-ticker-scroll-box');
    const tickerList = document.getElementById('news-ticker-list');
    if(tickerList) tickerList.classList.remove('auto-scroll');

    // Vitesse indépendante du taux de rafraîchissement de l'écran. L'ancien
    // incrément fixe accélérait sur un écran 120 Hz et saccadait à 30 Hz.
    const TICKER_SPEED_PX_PER_SECOND = 30;
    let tickerScrollHeight=inner.scrollHeight, tickerHeightMeasuredAt=0;
    tickerScrollState.position = 0;
    tickerScrollState.userScrolling = false;
    tickerScrollState.lastTouch = 0;
    tickerScrollState.lastFrame = 0;
    if (tickerBox) tickerBox.scrollTop = 0;

    function tickerAnimate(frameTime) {
      const previousFrame = tickerScrollState.lastFrame || frameTime;
      const elapsedMs = Math.min(64, Math.max(0, frameTime - previousFrame));
      tickerScrollState.lastFrame = frameTime;
      if(!tickerPaused && !tickerScrollState.userScrolling && tickerBox) {
        tickerScrollState.position += TICKER_SPEED_PX_PER_SECOND * (elapsedMs / 1000);
        if(frameTime-tickerHeightMeasuredAt>2000){tickerScrollHeight=inner.scrollHeight;tickerHeightMeasuredAt=frameTime;}
        const loopHeight = tickerScrollHeight;
        if(loopHeight > 0 && tickerScrollState.position >= loopHeight) tickerScrollState.position -= loopHeight;
        tickerBox.scrollTop = tickerScrollState.position;
      }
      tickerAnimFrame = requestAnimationFrame(tickerAnimate);
    }
    if(tickerAnimFrame) cancelAnimationFrame(tickerAnimFrame);
    tickerAnimFrame = requestAnimationFrame(tickerAnimate);

    function setupTickerClicks(container) {
      if(!container) return;
      container.querySelectorAll('.ticker-item[role="link"]').forEach(el => {
        const activate = (e) => {
          // Les liens natifs gèrent eux-mêmes l'ouverture et l'accès à l'original.
          // Cela évite d'ouvrir deux onglets quand on touche un lien sur mobile.
          if(e.target.closest('a')) return;
          const turfId = el.dataset.turfRace;
          if(turfId) {
            e.preventDefault();
            go('turf');
            setTimeout(()=>turfSelectRace(turfId), 300);
            return;
          }
          const url = el.dataset.href;
          if(url) {
            e.preventDefault();
            // Activation synchronisée sur le clic utilisateur (pas de popup différée).
            const a=document.createElement('a');
            a.href=url;a.target='_blank';a.rel='noopener noreferrer';
            document.body.appendChild(a);a.click();a.remove();
          }
        };
        el.addEventListener('click', activate);
        el.addEventListener('keydown', e => {
          if((e.key==='Enter'||e.key===' ')&&e.target===el){
            e.preventDefault();activate(e);
          }
        });
      });
    }
    setupTickerClicks(inner);
    setupTickerClicks(clone);

    if(tickerBox && !tickerBox._tickerInit) {
      tickerBox._tickerInit = true;
      tickerBox.addEventListener('mouseenter', () => { tickerScrollState.userScrolling = true; });
      tickerBox.addEventListener('mouseleave', () => {
        tickerScrollState.position = tickerBox.scrollTop;
        tickerScrollState.userScrolling = false;
        tickerScrollState.lastFrame = 0;
      });
      tickerBox.addEventListener('touchstart', () => {
        tickerScrollState.userScrolling = true;
        tickerScrollState.lastTouch = Date.now();
      }, {passive:true});
      tickerBox.addEventListener('touchend', () => {
        tickerScrollState.lastTouch = Date.now();
        setTimeout(() => {
          if(Date.now() - tickerScrollState.lastTouch >= 1800) {
            tickerScrollState.position = tickerBox.scrollTop;
            tickerScrollState.userScrolling = false;
            tickerScrollState.lastFrame = 0;
          }
        }, 2000);
      });
      tickerBox.addEventListener('scroll', () => {
        if(tickerScrollState.userScrolling) tickerScrollState.position = tickerBox.scrollTop;
      }, {passive:true});
    }

  }catch(error){
    console.warn('Rendu du flux multisports indisponible',error?.message||error);
  }
}
async function loadTicker(){
  if(tickerRefreshPending)return tickerRefreshPending;
  const loadSequence=++tickerLoadSequence;
  const saved=betproTickerReadFastSnapshot();
  if(saved.length)betproTickerRender(saved,{meta:{degraded:true}},loadSequence);
  else{
    const localMatches=betproTickerFutureMatches(betproTickerReadLocal(BETPRO_TICKER_FIXTURES_STORE));
    const localTurf=betproTickerReadLocal(BETPRO_TICKER_TURF_STORE).filter(x=>Number.isFinite(Date.parse(x.published||''))&&Date.parse(x.published)>Date.now()-300000);
    const immediate=buildBalancedTickerItems([...localMatches,...betproTickerReadGlobalNews()],localTurf);
    if(immediate.length)betproTickerRender(immediate,{meta:{degraded:true}},loadSequence);
    else renderTickerSafetyFallback('Connexion aux flux en cours…');
  }
  const task=(async()=>{
    let sportPayload={items:[...betproTickerFutureMatches(betproTickerReadLocal(BETPRO_TICKER_FIXTURES_STORE)),...betproTickerReadGlobalNews()],meta:{degraded:true}};
    let turfItems=betproTickerReadLocal(BETPRO_TICKER_TURF_STORE).filter(x=>Number.isFinite(Date.parse(x.published||''))&&Date.parse(x.published)>Date.now()-300000);
    let sportsLoaded=false,turfLoaded=false;
    const show=()=>{
      if(loadSequence!==tickerLoadSequence)return;
      const feed=buildBalancedTickerItems(sportPayload.items,turfItems);
      if(feed.length)betproTickerRender(feed,sportPayload,loadSequence,sportsLoaded&&!sportPayload?.meta?.degraded);
      else renderTickerSafetyFallback('Flux en cours de mise à jour. Seules les rencontres et actualités vérifiées sont publiées.',false);
    };
    await Promise.allSettled([
      getSportTickerArticles().then(value=>{sportPayload=value;sportsLoaded=true;show();}),
      getTurfTickerArticles().then(value=>{turfItems=value;turfLoaded=true;show();})
    ]);
    if(!sportsLoaded&&!turfLoaded)renderTickerSafetyFallback('Flux momentanément indisponible',false);
  })();
  tickerRefreshPending=task;
  try{return await task;}
  finally{if(tickerRefreshPending===task)tickerRefreshPending=null;}
}

// ═══════════════════════════════════════════════
//  NOTES
// ═══════════════════════════════════════════════
let notes=[],noteSaveTimer=null,notesSyncPromise=null,notesFlushPromise=null,notesDeletedPending=new Set();

function notesReadJson(key, fallback){
  try {const raw=localStorage.getItem(key);return raw?JSON.parse(raw):fallback;}
  catch(_){return fallback;}
}
function notesDateMs(note){const n=Date.parse(note?.updatedAt||note?.createdAt||'');return Number.isFinite(n)?n:0;}
function notesNormalize(raw){
  if(!raw||typeof raw.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id))return null;
  const at=new Date().toISOString();
  return{id:raw.id,title:String(raw.title||''),body:String(raw.body||''),createdAt:raw.createdAt||raw.updatedAt||at,
    updatedAt:raw.updatedAt||raw.createdAt||at,unsaved:raw.unsaved===true};
}
function notesMerge(base, others, removedIds=new Set()){
  const values=new Map();
  for(const value of [...(Array.isArray(base)?base:[]),...(Array.isArray(others)?others:[])]){
    const n=notesNormalize(value);if(!n||removedIds.has(n.id))continue;
    const prev=values.get(n.id);
    if(!prev||notesDateMs(n)>notesDateMs(prev)||(notesDateMs(n)===notesDateMs(prev)&&n.unsaved&&!prev.unsaved))values.set(n.id,n);
  }
  return[...values.values()].sort((a,b)=>notesDateMs(b)-notesDateMs(a));
}
function notesSetStatus(message,kind='neutral'){
  const lbl=document.getElementById('notes-sync-lbl'),dot=document.getElementById('notes-sync-dot');
  if(lbl)lbl.textContent=message;
  if(dot)dot.style.background=kind==='ok'?'var(--gr)':kind==='error'?'var(--re)':kind==='loading'?'var(--am)':'var(--dm)';
}
function notesLoad(){
  const disk=notesReadJson('pgi_notes_v2',[]),backup=notesReadJson('pgi_notes_v2_backup',[]);
  const deleted=notesReadJson('pgi_notes_v2_deleted',[]);
  notesDeletedPending=new Set([...(notesDeletedPending||[]),...(Array.isArray(deleted)?deleted:[])]);
  notes=notesMerge(notes,notesMerge(disk,backup,notesDeletedPending),notesDeletedPending);
  return notes;
}
function notesSave(){
  const serialized=JSON.stringify(notes);
  try{
    localStorage.setItem('pgi_notes_v2_backup',serialized);
    localStorage.setItem('pgi_notes_v2',serialized);
    localStorage.setItem('pgi_notes_v2_deleted',JSON.stringify([...notesDeletedPending]));
    return true;
  }catch(e){
    notesSetStatus('Stockage local indisponible, synchronisation serveur requise','error');
    return false;
  }
}
function notesScheduleSave(){
  if(noteSaveTimer)clearTimeout(noteSaveTimer);
  noteSaveTimer=setTimeout(()=>{noteSaveTimer=null;notesFlushDirty().catch(()=>{});},700);
}
async function notesFlushDirty(){
  if(notesFlushPromise)return notesFlushPromise;
  notesFlushPromise=(async()=>{
    let attempts=0;
    try{
      while(attempts++<15){
        const pending=notes.filter(x=>x.unsaved).slice(0,20)
          .map(x=>({id:x.id,title:x.title,body:x.body,createdAt:x.createdAt,updatedAt:x.updatedAt}));
        const deletions=[...notesDeletedPending].slice(0,50);
        if(!pending.length&&!deletions.length)return true;
        notesSetStatus('Sauvegarde sur Cloudflare…','loading');
        const response=await api('/api/notes','PUT',{notes:pending,deleted_ids:deletions},{timeoutMs:16000});
        if(!response?.ok||response.saved!==pending.length||response.deleted!==deletions.length)
          throw new Error(response?.error||'Confirmation de sauvegarde non reçue');
        for(const saved of pending){
          const current=notes.find(n=>n.id===saved.id);
          if(current&&current.updatedAt===saved.updatedAt)current.unsaved=false;
        }
        for(const id of deletions)notesDeletedPending.delete(id);
        notesSave();
        const active=document.activeElement;
        const editing=active?.matches?.('.note-title-input,.note-body');
        if(!editing&&document.getElementById('s-notes')?.classList.contains('on'))notesRender();
      }
      return !notes.some(x=>x.unsaved)&&!notesDeletedPending.size;
    }catch(error){
      notesSetStatus('Notes conservées localement. Synchronisation à réessayer.','error');
      return false;
    }finally{
      if(!notes.some(x=>x.unsaved)&&!notesDeletedPending.size)notesSetStatus('Sauvegarde Cloudflare confirmée','ok');
    }
  })();
  try{return await notesFlushPromise;}
  finally{notesFlushPromise=null;}
}
async function notesSyncCloud(){
  if(notesSyncPromise)return notesSyncPromise;
  notesSyncPromise=(async()=>{
    notesLoad();
    notesSetStatus('Récupération des notes sur Cloudflare…','loading');
    try{
      const result=await api('/api/notes','GET',null,{timeoutMs:18000});
      if(!result?.ok||!Array.isArray(result.notes))throw Error(result?.error||'Réponse notes invalide');
      const remoteDeleted=new Set(Array.isArray(result.deleted_ids)?result.deleted_ids:[]);
      const toExclude=new Set([...notesDeletedPending,...remoteDeleted]);
      notes=notesMerge(result.notes,notes,toExclude);
      // Une ancienne version de BetPro pouvait annoncer « sauvegardée » alors que
      // la note était absente du serveur. Réparer ces notes locales sans les perdre.
      const byRemoteId=new Map(result.notes.map(n=>[String(n.id),n]));
      for(const note of notes){
        const remote=byRemoteId.get(note.id);
        if(!remote||notesDateMs(note)>notesDateMs(remote)
          ||(notesDateMs(note)===notesDateMs(remote)&&(note.title!==remote.title||note.body!==remote.body)))note.unsaved=true;
      }
      // Les suppressions déjà confirmées sur le serveur n'ont pas à être renvoyées.
      for(const id of remoteDeleted)notesDeletedPending.delete(id);
      notesSave();
      const editing=document.activeElement?.matches?.('.note-title-input,.note-body');
      if(!editing)notesRender();
      notesSetStatus(result.storage==='KV'?'Notes retrouvées dans Cloudflare KV':'Notes retrouvées dans Cloudflare D1','ok');
      if(notes.some(n=>n.unsaved)||notesDeletedPending.size)await notesFlushDirty();
    }catch(error){
      // La mémoire locale et son double de secours ne sont jamais écrasés par un GET en échec.
      notesSetStatus('Cloudflare indisponible. Notes locales préservées.','error');
      if(notes.some(n=>n.unsaved)||notesDeletedPending.size)notesScheduleSave();
    }
  })();
  try{return await notesSyncPromise;}
  finally{notesSyncPromise=null;}
}

function notesRender(){
  const list=document.getElementById('notes-list'),empty=document.getElementById('notes-empty');
  const countLbl=document.getElementById('notes-count-lbl'),badge=document.getElementById('notes-badge');
  if(countLbl)countLbl.textContent=notes.length+' note(s)';
  if(badge){badge.textContent=notes.length;badge.style.display=notes.length?'':'none';}
  if(!notes.length){if(list)list.innerHTML='';if(empty)empty.style.display='';return;}
  if(empty)empty.style.display='none';
  if(!list)return;
  list.innerHTML=notes.map(n=>{
    const nid=n.id;
    const created=n.createdAt?'<div style="font-size:9px;color:var(--dm);font-family:var(--mo);margin-top:2px">Créée le '+fmtDT(n.createdAt)+'</div>':'';
    const modified=n.updatedAt&&n.updatedAt!==n.createdAt?
      '<div class="note-mod-date" style="font-size:9px;color:var(--dm);font-family:var(--mo)">Modifiée le '+fmtDT(n.updatedAt)+'</div>':'';
    const saved=n.unsaved?'<span class="note-tag note-unsaved note-sync-tag">À synchroniser</span>':
      '<span class="note-tag note-saved note-sync-tag">Sauvegardée</span>';
    return '<div class="note-card '+(n.unsaved?'unsaved':'')+'" id="note-'+nid+'">'
      +'<input class="note-title-input" value="'+esc(n.title||'')+'" placeholder="Titre..." oninput="noteEdit(\''+nid+'\',\'title\',this.value)">'
      +'<textarea class="note-body" oninput="noteEdit(\''+nid+'\',\'body\',this.value);autoResize(this)">'+esc(n.body||'')+'</textarea>'
      +'<div class="note-footer"><div class="note-dates">'+created+modified+'</div>'
      +'<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'+saved
      +'<button onclick="noteSaveManual(\''+nid+'\')" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:linear-gradient(135deg,#ff7043,#ff5722);border:none;border-radius:4px;color:#fff;font-size:10px;font-family:var(--mo);font-weight:700;cursor:pointer">Enregistrer</button>'
      +'<button onclick="notesDeleteById(\''+nid+'\')" style="background:none;border:none;color:var(--dm);cursor:pointer;font-size:12px;padding:2px">Suppr.</button>'
      +'</div></div></div>';
  }).join('');
  list.querySelectorAll('textarea.note-body').forEach(autoResize);
}
function autoResize(t){t.style.height='auto';t.style.height=t.scrollHeight+'px';}
function notesNew(){
  const now=new Date().toISOString(),id=Date.now().toString(36)+Math.random().toString(36).slice(2,9);
  notes.unshift({id,title:'',body:'',createdAt:now,updatedAt:now,unsaved:true});
  notesSave();notesRender();notesScheduleSave();
  setTimeout(()=>document.querySelector('.note-title-input')?.focus(),100);
}
function noteEdit(noteId,field,val){
  const note=notes.find(n=>n.id===noteId);if(!note||!['title','body'].includes(field))return;
  note[field]=val;note.updatedAt=new Date().toISOString();note.unsaved=true;
  notesSave();notesScheduleSave();
  const card=document.getElementById('note-'+noteId);
  if(card){
    card.classList.add('unsaved');
    const tag=card.querySelector('.note-sync-tag');
    if(tag){tag.textContent='À synchroniser';tag.className='note-tag note-unsaved note-sync-tag';}
    const modEl=card.querySelector('.note-mod-date');
    if(modEl)modEl.textContent='Modifiée le '+fmtDT(note.updatedAt);
  }
}
async function noteSaveManual(noteId){
  const note=notes.find(n=>n.id===noteId);
  if(!note){toast('Note introuvable','err');return;}
  const card=document.getElementById('note-'+noteId);
  if(card){
    const title=card.querySelector('.note-title-input'),body=card.querySelector('.note-body');
    if(title)note.title=title.value;
    if(body)note.body=body.value;
  }
  note.updatedAt=new Date().toISOString();note.unsaved=true;
  const localSaved=notesSave();
  if(noteSaveTimer){clearTimeout(noteSaveTimer);noteSaveTimer=null;}
  const synced=await notesFlushDirty();
  const current=notes.find(n=>n.id===noteId);
  if(synced&&current&&!current.unsaved)toast('Note enregistrée sur Cloudflare','ok');
  else toast(localSaved?'Note conservée localement, Cloudflare indisponible':'Sauvegarde impossible, veuillez réessayer','err');
}
function notesDeleteById(noteId){
  if(!confirm('Supprimer cette note ?'))return;
  notesDeletedPending.add(noteId);
  notes=notes.filter(n=>n.id!==noteId);
  notesSave();notesRender();notesScheduleSave();
}
function notesDelete(i){if(notes[i])notesDeleteById(notes[i].id);}


const QUICK_QUESTIONS = [
  'Quel est le meilleur signal probabiliste ce match ?','Over 2.5 ou Under 2.5 ?','Quelle est la probabilité BTTS ?',
  'Quelle mise avec Kelly ?','Y a-t-il de la valeur sur la cote ?','Analyse la forme des équipes.',
];
function initQuickQuestions() {
  const wrap=document.getElementById('quick-questions-wrap');
  if(!wrap)return;
  wrap.innerHTML=QUICK_QUESTIONS.map((q,i)=>{
    const safe = q.replace(/'/g,"&#39;").replace(/"/g,'&quot;');
    return `<button class="fbtn" onclick="document.getElementById('chat-input').value='${safe}';sendChat();" style="font-size:11px">${q}</button>`;
  }).join('');
}

// ═══════════════════════════════════════════════
//  LIEN BOOKMAKER CONFIGURABLE — sécurisé
// ═══════════════════════════════════════════════
const BOOKIE_KEY = 'pgi_bookie_config';
const BOOKIE_DEFAULT_URL = 'https://www.piwi247.com/customer';

function bookieLoad() {
  try {
    const raw = localStorage.getItem(BOOKIE_KEY);
    return raw ? JSON.parse(raw) : { name: 'Piwi247', url: BOOKIE_DEFAULT_URL };
  } catch(_) { return { name: 'Piwi247', url: BOOKIE_DEFAULT_URL }; }
}

function bookieSave(name, url) {
  try { localStorage.setItem(BOOKIE_KEY, JSON.stringify({ name: name.trim(), url: url.trim() })); return true; }
  catch(_) { return false; }
}

// Cinq autres liens, dans le même navigateur et avec le même crayon que Piwi247.
const BOOKIE_EXTRA_KEY = 'pgi_bookie_extra_links_v1';
let bookieEditingSlot = null;
function bookieValidHttps(value){
  try{const u=new URL(String(value||''));return u.protocol==='https:'&&!!u.hostname&&!u.username&&!u.password;}
  catch(_){return false;}
}
function bookieExtraLoad(){
  let stored=[];
  try{const data=JSON.parse(localStorage.getItem(BOOKIE_EXTRA_KEY)||'[]');if(Array.isArray(data))stored=data;}
  catch(_){}
  return Array.from({length:5},(_,i)=>({
    name:String(stored[i]?.name||'').slice(0,70),
    url:bookieValidHttps(stored[i]?.url)?String(stored[i].url).slice(0,2048):''
  }));
}
function bookieExtraSave(index,name,url){
  if(!Number.isInteger(index)||index<0||index>=5)return false;
  const all=bookieExtraLoad();all[index]={name:name.trim().slice(0,70),url:url.trim().slice(0,2048)};
  try{localStorage.setItem(BOOKIE_EXTRA_KEY,JSON.stringify(all));return true;}
  catch(_){return false;}
}
function bookieExtraRender(){
  const target=document.getElementById('bookie-extra-links');if(!target)return;
  target.innerHTML=bookieExtraLoad().map((item,i)=>{
    const ready=bookieValidHttps(item.url),label=item.name||(ready?'Lien '+(i+1):'Ajouter un lien '+(i+1));
    const open=ready?'':' onclick="bookieEditModal('+i+');return false;"';
    return '<div class="bookie-extra-row">'
      +'<a class="bookie-extra-link'+(ready?'':' empty')+'" href="'+(ready?esc(item.url):'#')+'"'
      +open+' target="'+(ready?'_blank':'_self')+'" rel="noopener noreferrer" title="'+esc(label)+'">'
      +'<span aria-hidden="true">&#128279;</span><span>'+esc(label)+'</span></a>'
      +'<button class="bookie-extra-edit" type="button" onclick="bookieEditModal('+i+')" aria-label="Modifier le lien '+(i+1)+'" title="Modifier le lien '+(i+1)+'">&#9998;</button>'
      +'</div>';
  }).join('');
}

function bookieApply() {
  const cfg = bookieLoad();
  const safeUrl = /^https:\/\//i.test(cfg.url||'') ? cfg.url : BOOKIE_DEFAULT_URL;
  document.querySelectorAll('.bookie-link').forEach(el => { el.href = safeUrl; });
  const sidebar = document.getElementById('bookie-sidebar-link');
  if (sidebar) sidebar.href = safeUrl;
  const sName = document.getElementById('bookie-sidebar-name');
  if (sName) sName.textContent = (cfg.name || 'Bookmaker') + ' — Mon compte';
  bookieExtraRender();
}

function bookieLinkHtml() {
  const cfg = bookieLoad();
  const safeUrl  = /^https:\/\//i.test(cfg.url||'') ? cfg.url : BOOKIE_DEFAULT_URL;
  const safeName = esc(cfg.name||'Bookmaker');
  return '<a href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer" class="bookie-link"'
    + ' style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:rgba(0,212,255,.12);border:1px solid rgba(0,212,255,.3);border-radius:4px;color:var(--neon);font-size:10px;font-family:var(--mo);font-weight:700;text-decoration:none">'
    + '&#127919; ' + safeName + '</a>';
}

function bookieEditModal(slot=null) {
  bookieEditingSlot=Number.isInteger(slot)&&slot>=0&&slot<5?slot:null;
  const cfg = bookieEditingSlot===null?bookieLoad():bookieExtraLoad()[bookieEditingSlot];
  const nameEl = document.getElementById('bookie-modal-name');
  const urlEl  = document.getElementById('bookie-modal-url');
  const titleEl=document.getElementById('bookie-modal-heading');
  if (nameEl) {nameEl.value = cfg.name||'';nameEl.placeholder=bookieEditingSlot===null?'Piwi247':'Nom du lien '+(bookieEditingSlot+1);}
  if (urlEl) {urlEl.value=cfg.url||'';urlEl.placeholder='https://exemple.com/mon-compte';}
  if (titleEl) titleEl.textContent=bookieEditingSlot===null?'✎ Modifier le lien bookmaker':'✎ Modifier le lien personnalisé '+(bookieEditingSlot+1)+'/5';
  const modal = document.getElementById('bookie-modal');
  if (modal) { modal.style.display = 'flex';nameEl?.focus(); }
}

function bookieModalClose() {
  const modal = document.getElementById('bookie-modal');
  if (modal) modal.style.display = 'none';
  bookieEditingSlot=null;
}

function bookieModalSave() {
  const slot=bookieEditingSlot;
  const name = (document.getElementById('bookie-modal-name')?.value || '').trim().slice(0,70) || (slot===null?'Piwi247':'Lien '+(slot+1));
  const url  = (document.getElementById('bookie-modal-url')?.value || '').trim();
  if (!bookieValidHttps(url)) { toast('Adresse invalide : URL HTTPS complète requise', 'err'); return; }
  const saved=slot===null?bookieSave(name,url):bookieExtraSave(slot,name,url);
  if(!saved){toast('Impossible de sauvegarder le lien dans ce navigateur','err');return;}
  bookieApply();
  bookieModalClose();
  toast(name + ' sauvegardé', 'ok');
}

async function initStatusBadges() {
  try {
    const q = await api('/api/quotas');
    const ok = q.odds_api_credits_remaining > 0;
    const setDot = (id, c) => { const el=document.getElementById(id); if(el) el.style.background=c; };
    const setLbl = (id, txt, c) => { const el=document.getElementById(id); if(el){el.textContent=txt;if(c)el.style.color=c;} };
    const setInfo = (id, txt) => { const el=document.getElementById(id); if(el) el.textContent=txt; };
    setDot('cf-dot','var(--gr)'); setLbl('cf-label','CLOUDFLARE','var(--gr)'); setInfo('cf-info','Connecte');
    setDot('odds-dot', ok?'var(--neon)':'var(--re)');
    setLbl('odds-label','ODDS API', ok?'var(--neon)':'var(--re)');
    setInfo('odds-info', ok ? q.odds_api_credits_remaining+' cr. restants' : 'Quota epuise');
    setDot('m-cf-dot','var(--gr)'); setLbl('m-cf-lbl','CF','var(--gr)');
    setDot('m-odds-dot', ok?'var(--neon)':'var(--re)'); setLbl('m-odds-lbl','OA', ok?'var(--neon)':'var(--re)');
  } catch(_) {}
}

let maturityLoading=false,collectionDiagnostic=null;
function collectionDiagnosticText(s){
  const n=v=>v===null||v===undefined||v===''?'non mesuré':Number.isFinite(Number(v))?new Intl.NumberFormat('fr-FR').format(Number(v)):'inconnu';
  const date=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('fr-FR',{timeZone:'Europe/Paris'}):'non disponible';
  const state=v=>({collecting:'données reçues',partial:'collecte partielle',unavailable:'source en erreur',incomplete:'collecte incomplète',not_published:'aucune réunion détectée au dernier passage',unknown:'non vérifié',success:'terminé sans erreur déclarée',error:'erreur',running:'en cours'})[v]||'non vérifié';
  const lines=['PGI BetPro : diagnostic de collecte','Données contrôlées le '+date(s.checked_at)+' (heure de Paris)', 'Totaux historiques relevés le '+date(s.volume_checked_at||s.checked_at)+' (actualisation au maximum deux fois par jour).','Score technique : '+n(s.health?.score)+'/100. Ce score ne mesure pas la fiabilité des paris.'];
  if(s.collection?.historical_stats_deferred)lines.push('Mode économie D1 : certains totaux de cotes et de prédictions ne sont plus recalculés par balayage intégral. Non mesuré ne signifie pas zéro.');
  if(s.diagnostic_stale)lines.push('Dernier diagnostic conservé en cache, potentiellement ancien.');
  const components=s.health?.score_components;
  if(Array.isArray(components)){
    const penalties=components.filter(x=>Number(x.penalty)>0);
    lines.push('Causes du score :');
    for(const x of penalties)lines.push('• '+x.label+' : −'+n(x.penalty)+' points'+(x.state==='no_successful_data'?' ; aucune collecte avec données et sans erreur enregistrée':x.state==='stale'?' ; dernière collecte avec données et sans erreur il y a '+Number(x.age_hours).toFixed(1)+' h':'')+'.');
    if(!penalties.length)lines.push('Aucune pénalité technique enregistrée.');
  }else lines.push('Détail du score indisponible dans ce Worker.');
  for(const warning of s.health?.warnings||[])lines.push('• '+String(warning));
  lines.push('', 'PMU Placé : '+n(s.pmu?.official_place_dividends)+' dividendes officiels après course.');
  lines.push('Cotes Placé pré-course vérifiées : '+(s.pmu?.verified_pre_race_place_quotes==null?'non mesurées dans cette version':n(s.pmu.verified_pre_race_place_quotes))+'.');
  lines.push('Source Placé configurée : '+(typeof s.pmu?.place_feed_configured==='boolean'?(s.pmu.place_feed_configured?'oui ; réception à vérifier':'non'):'non vérifié')+'.');
  lines.push('Le seuil de 500 courses mesure le volume ; il ne valide aucun modèle à lui seul.');
  lines.push('', 'Modèles :');
  if(Array.isArray(s.models_by_family))for(const f of s.models_by_family)lines.push(({SPORT:'Multisports',PMU:'PMU',HKJC:'Hong Kong (tranches de calibration)'})[f.family]+' : '+n(f.active_models)+' actifs sur '+n(f.models)+'.');
  else lines.push('Multisports : '+n(s.benter?.active_models)+' segments actifs. PMU et HKJC : non détaillés dans ce Worker.');
  lines.push('Un modèle marqué actif reste soumis aux filtres de chaque carte.');
  const hk=s.hkjc;
  lines.push('', 'HONG KONG');
  if(hk){lines.push('Programmes : '+n(hk.races)+' courses ; '+state(hk.source_status)+'.');lines.push('Dernier contrôle de source : '+date(hk.last_source_check)+'.');lines.push('Cotes : '+n(hk.odds_snapshots)+' observations, dont '+n(hk.verified_odds_snapshots)+' avec provenance pré-course v30 ; dernière observation : '+date(hk.last_odds)+'.');lines.push('Résultats : '+n(hk.results)+' partants, '+n(hk.resolved_races)+' courses ; dernier résultat : '+date(hk.last_result)+'.');}
  else lines.push('Courses : '+n(s.coverage?.hkjc_races)+' ; source : '+state(s.coverage?.hkjc_source)+'. Détail des cotes/résultats indisponible.');
  lines.push('', 'Dernières tentatives de collecte :');
  const labels={pmu_snapshot:'Programmes PMU',pmu_results:'Résultats PMU',sports_snapshot:'Cotes multisports',sports_results:'Résultats multisports',hkjc_racecards:'Programmes HKJC',hkjc_odds:'Cotes HKJC',hkjc_results:'Résultats HKJC'};
  const runs=s.collection?.latest_attempts;
  for(const [type,label]of Object.entries(labels)){const r=Array.isArray(runs)?runs.find(x=>x.collector_type===type):null;lines.push(label+' : '+(r?state(r.status)+' ; '+date(r.finished_at||r.started_at)+' ; vus '+n(r.items_seen)+' ; écritures '+n(r.items_written)+' ; erreurs '+n(r.error_count)+(r.reason?' ; '+r.reason:''):'aucune tentative disponible dans le diagnostic')+'.');}
  lines.push('Une exécution sans donnée peut correspondre à une attente ou à un report de budget.');
  const q=s.quotas;lines.push('', 'QUOTAS API');
  if(q?.available){lines.push(n(q.keys_total)+' clés : '+n(q.keys_available)+' disponibles, '+n(q.keys_exhausted)+' épuisées, '+n(q.keys_unknown)+' non vérifiées, '+n(q.keys_invalid)+' invalides, '+n(q.keys_cooldown)+' temporisées.');lines.push('Crédits confirmés restants : '+n(q.remaining)+' ; période : '+String(q.period||'inconnue')+'.');lines.push('Budget du jour restant : '+n(q.monthly_budget?.remaining_today)+' ; dernière réponse fournisseur : '+date(q.last_fetch_at)+'.');}
  else lines.push('Quotas non disponibles dans ce diagnostic.');
  lines.push('', 'ARCHIVES','Dernier archivage : '+date(s.r2?.last_archive)+'.','Dernière relecture : '+date(s.r2?.last_replay)+'.', 'Archive à jour : '+(s.r2?.archive_caught_up===true?'oui':s.r2?.archive_caught_up===false?'non confirmé':'inconnu')+'.');
  return lines.join('\n');
}
function exportCollectionDiagnostic(){
  if(!collectionDiagnostic)return;
  const url=URL.createObjectURL(new Blob([collectionDiagnosticText(collectionDiagnostic)],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='PGI-BetPro-Diagnostic-'+new Date().toISOString().slice(0,10)+'.txt';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function loadProfessionalMaturity(){
  if(maturityLoading||document.hidden)return;
  const panel=document.getElementById('maturity-panel');if(!panel)return;
  maturityLoading=true;
  const nf=new Intl.NumberFormat('fr-FR');
  try{
    const s=await api('/api/maturity/status');if(!s?.ok||!s.health)throw new Error(s?.error||'Diagnostic incomplet');
    collectionDiagnostic=s;
    const eventRows=Array.isArray(s.collection?.events)?s.collection.events:[],eventCount=eventRows.reduce((n,r)=>n+Number(r.events||0),0),health=Number(s.health.score),status=String(s.health.status||'INDISPONIBLE'),pmuRaces=Number(s.pmu?.detailed_races||0),target=Math.max(1,Number(s.pmu?.target_races||500)),percent=Math.min(100,Math.round(pmuRaces*100/target)),r2=s.r2||{};
    const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
    set('maturity-checked','État : '+(s.checked_at?new Date(s.checked_at).toLocaleString('fr-FR'):'date inconnue')+' · compteurs : '+(s.volume_checked_at?new Date(s.volume_checked_at).toLocaleString('fr-FR'):'date du contrôle')+'.');
    set('maturity-events',nf.format(eventCount));set('maturity-odds',s.collection?.odds_snapshots==null?'—':nf.format(Number(s.collection.odds_snapshots)));set('maturity-pmu',nf.format(pmuRaces));set('maturity-models',nf.format(Number(s.benter?.active_models||0)));
    // Compteurs HKJC indépendants des courses PMU françaises.
    set('maturity-hkjc',s.hkjc?.races==null?'—':nf.format(Math.max(0,Number(s.hkjc.races)||0)));
    set('maturity-hkjc-odds',s.hkjc?.verified_odds_snapshots==null?'Cotes vérifiées : non mesurées':'Cotes vérifiées : '+nf.format(Math.max(0,Number(s.hkjc.verified_odds_snapshots)||0)));
    set('maturity-pmu-label','PMU France : '+String(s.pmu?.stage||'construction').toLowerCase());
    set('maturity-pmu-value',nf.format(pmuRaces)+' / '+nf.format(target)+' courses');
    const bar=document.getElementById('maturity-pmu-bar');if(bar)bar.style.width=percent+'%';
    const badge=document.getElementById('maturity-health');if(badge){badge.textContent=status+' · '+Math.round(health)+'/100';badge.style.color=health>=90?'var(--gr)':health>=70?'var(--am)':'var(--re)';badge.style.borderColor=health>=90?'rgba(31,209,132,.35)':health>=70?'rgba(255,190,74,.35)':'rgba(255,86,106,.35)';badge.dataset.level=health>=90?'healthy':health>=70?'warning':'critical';}
    set('maturity-decision',s.benter?.active_models>0?'Multisports : segments actifs, admissibilité contrôlée carte par carte.':'Multisports : aucun segment Benter actif actuellement.');
    set('maturity-storage','Mémoire : D1 + R2 · liaison '+(r2.binding_configured?'configurée':'absente')+' · lecteur '+(r2.reader_configured?'configuré':'absent')+' · archive '+(r2.archive_caught_up?'à jour':'à vérifier')+'.');
    const summary=[];
    for(const cause of s.health?.score_components||[])if(cause.penalty>0)summary.push(cause.label+' : −'+cause.penalty+' points.');
    for(const warning of s.health?.warnings||[])summary.push(String(warning));
    summary.push('PMU Placé : '+nf.format(Number(s.pmu?.official_place_dividends||0))+' dividendes après course ; '+(s.pmu?.verified_pre_race_place_quotes==null?'cotes pré-course non mesurées':nf.format(s.pmu.verified_pre_race_place_quotes)+' cotes pré-course vérifiées')+'.');
    if(s.hkjc)summary.push('Hong Kong : '+nf.format(s.hkjc.races)+' courses, '+nf.format(s.hkjc.odds_snapshots)+' cotes, '+nf.format(s.hkjc.resolved_races)+' courses avec résultats.');
    else summary.push('Hong Kong : détail indisponible dans ce Worker.');
    summary.push('Le volume de courses ne suffit pas à valider un modèle.');
    set('maturity-summary',summary.join('\n'));
    const details=document.getElementById('maturity-details');if(details){details.textContent=collectionDiagnosticText(s);details.style.whiteSpace='pre-wrap';}
    const button=document.getElementById('maturity-export');if(button)button.disabled=false;
  }catch(e){
    const badge=document.getElementById('maturity-health');if(badge){badge.textContent='CONTRÔLE INDISPONIBLE';badge.style.color='var(--re)';}
    const details=document.getElementById('maturity-details');if(details){details.textContent='Erreur de diagnostic : '+String(e?.message||e).slice(0,240);details.style.whiteSpace='pre-wrap';}
    const checked=document.getElementById('maturity-checked');if(checked)checked.textContent=collectionDiagnostic?'Actualisation impossible. Dernier état : '+new Date(collectionDiagnostic.checked_at).toLocaleString('fr-FR')+' · compteurs : '+new Date(collectionDiagnostic.volume_checked_at||collectionDiagnostic.checked_at).toLocaleString('fr-FR')+'.':'Actualisation impossible. Aucun diagnostic reçu.';
  }finally{maturityLoading=false;}
}

document.addEventListener('DOMContentLoaded', () => {
  bookieApply();
  notesLoad();
  notesRender();
  notesSyncCloud();
  initStatusBadges();
  initQuickQuestions();
  loadQuotas();
  ttsInit();
  loadTicker();
  // Actualisation du DIRECT uniquement si l'onglet Live est ouvert et visible.
  // Ne change ni le ticker des rencontres à venir ni les scans Classique/Benter.
  setInterval(() => {
    if (!document.hidden && document.getElementById('s-live')?.classList.contains('on')) {
      loadLive().catch(e => console.warn('Rafraîchissement Live indisponible', e?.message || e));
    }
  }, 90 * 1000);
  setInterval(()=>{if(!document.hidden && document.getElementById('s-dash')?.classList.contains('on'))loadTicker();},10*60*1000);
  setInterval(()=>{if(!document.hidden && document.getElementById('s-results')?.classList.contains('on'))loadResults();},10*60*1000);
  loadProfessionalMaturity();
  setInterval(()=>{if(!document.hidden && document.getElementById('s-dash')?.classList.contains('on'))loadProfessionalMaturity();},60*60*1000);
  loadValidSportKeys();
  lossLoadCloud().then(()=>{
    if(document.getElementById('s-methods')?.classList.contains('on')) lossRender();
  }).catch(()=>{});
  loadSportHistoryFromCloud()
    .then(() => syncSportHistoryLocalToCloud())
    .catch(() => {});
});

// ═══════════════════════════════════════════════
//  DIRECTION CARD — carte avec verdict clair + ajustement historique visible
// ═══════════════════════════════════════════════
const _cardsQueuedThisSession = new Map();

function pgiClamp100(v){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(100,n)):0;}
function pgiQuality100(v){const n=Number(v);if(!Number.isFinite(n))return 0;return pgiClamp100(n<=1?n*100:n);}
function pgiFraction(v){const n=Number(v);if(!Number.isFinite(n))return 0;return Math.abs(n)>1?n/100:n;}
function pgiConfidenceFr(v){return({LOW:'Faible',MEDIUM:'Moyenne',HIGH:'Élevée',low:'Faible',medium:'Moyenne',high:'Élevée'})[String(v)]||String(v||'Non déterminée');}

/* Indice de robustesse lisible, distinct d'une garantie de gain. Les données
   déjà calculées par chaque moteur restent la source de vérité. */
function pgiHkjcGlobalConfidence(c){
  const level=({LOW:46,MEDIUM:70,HIGH:86})[String(c?.confidence||'').toUpperCase()]||42;
  const quality=pgiQuality100(c?.data_quality_score);
  const edge=Math.max(0,pgiFraction(c?.edge));
  const ev=Math.max(0,pgiFraction(c?.expected_value));
  const value=Math.min(100,(edge/0.08)*55+(ev/0.12)*45);
  let score=level*.55+quality*.30+value*.15;
  if(c?.decision!=='BET')score=Math.min(score,69);
  if(Number(c?.field_size||0)<8)score=Math.min(score,64);
  return Math.round(pgiClamp100(score));
}
function pgiTurfGlobalConfidence(d){
  const probability=pgiClamp100(d?.confidence);
  const e=d?.evidence||{};
  const quality=pgiQuality100(e.data_quality_score);
  const edge=Math.max(0,pgiFraction(e.edge_conservative));
  const ev=Math.max(0,pgiFraction(e.expected_value));
  const value=Math.min(100,(edge/0.08)*55+(ev/0.12)*45);
  let score=probability*.55+quality*.30+value*.15;
  if(Number(e.runners_active||0)<8)score=Math.min(score,64);
  return Math.round(pgiClamp100(score));
}
const BETPRO_BENTER_GREEN_MODEL_PROBABILITY = 70;
function betproBenterIsHighProbability(o,res){
  return res?.shouldDisplay===true&&res.direction==='play'
    &&Number(res.modelProb)>=BETPRO_BENTER_GREEN_MODEL_PROBABILITY
    &&Number(res.displayConf)>=75&&Number(res.reliabilityScore)>=78
    &&Number(res.dataQualityScore)>=55&&Number(res.edgeProb)>=2
    &&Number(res.evSimple)>=1.04
    &&Array.isArray(o?.all_bookmakers)&&o.all_bookmakers.length>=2;
}

function pgiIsStrongSportsSignal(o,res){
  return res?.direction==='play'&&res?.tier==='premium'&&Number(res.reliabilityScore||0)>=92&&Number(res.displayConf||0)>=90&&Number(res.dataQualityScore||0)>=70&&Number(res.edgeProb||0)>=5&&Number(res.evSimple||0)>=1.12;
}
function pgiIsStrongHkjcSignal(c){
  const market=String(c?.market||'').toUpperCase();
  return c?.decision==='BET'&&String(c?.confidence||'').toUpperCase()==='HIGH'&&pgiQuality100(c?.data_quality_score)>=80&&Number(c?.field_size||0)>=8&&pgiFraction(c?.edge)>=(market==='WIN'?.05:.04)&&pgiFraction(c?.expected_value)>=(market==='WIN'?.08:.06)&&pgiHkjcGlobalConfidence(c)>=85;
}
function pgiIsStrongTurfSignal(d){
  const positive=['favorable','placé fiable','carte validée','carte placé validée','carte gagnant validée','jouable'];
  const rec=String(d?.recommendation||'').toLowerCase();
  const e=d?.evidence||{};
  const approved=!rec||positive.includes(rec);
  return approved&&pgiTurfGlobalConfidence(d)>=82&&pgiQuality100(e.data_quality_score)>=70&&Number(e.runners_active||0)>=8&&pgiFraction(e.edge_conservative)>=.04&&pgiFraction(e.expected_value)>=.06;
}
function pgiGlobalConfidenceBadge(score){return '<span class="bdg" style="background:rgba(0,212,255,.10);color:#7ae8ff;border:1px solid rgba(0,212,255,.28)">Confiance globale : '+Math.round(pgiClamp100(score))+' %</span>';}

function renderDirectionCard(o, i, containerId) {
  const s   = o.score || {};
  const res = o._res || computeDirection(o);

  if(res.shouldDisplay && res.direction==='play') {
    const _cid = makeBetCardId(o, o.start_time||o.commence_time||new Date().toISOString());
    if(_cardsQueuedThisSession.get(_cid) !== o.odds) {
      _cardsQueuedThisSession.set(_cid, o.odds);
      saveBetCard(o, res, {}).catch(()=>{});
    }
  }

  if(!res.shouldDisplay || res.direction !== 'play') return '';

  const { tier, tierLabel, tierColor, reliabilityScore, displayConf,
          impliedProb, modelProb, edgeProb, evSimple, evPct, evNet,
          kellyFull, kellyFraction, stakeRecommended,
          warning, reason, dataQualityScore, disclaimer, historicalAdjustment,
          sportHistoricalAdjustment } = res;

  const histBadge = (function(){
    if(!historicalAdjustment) return '';
    const map = {positive:'positif',neutral:'neutre',negative:'négatif',blocked:'négatif',insufficient:'insuffisant'};
    const label = map[historicalAdjustment.status]||'neutre';
    const color = historicalAdjustment.status==='positive'?'var(--gr)'
      : (historicalAdjustment.status==='negative'||historicalAdjustment.status==='blocked')?'var(--re)'
      : historicalAdjustment.status==='insufficient'?'var(--dm)':'var(--am)';
    const roiTxt = historicalAdjustment.roi!=null?`, ROI ${historicalAdjustment.roi>0?'+':''}${historicalAdjustment.roi}%`:'';
    const wrTxt  = historicalAdjustment.winRate!=null?`, réussite ${historicalAdjustment.winRate}%`:'';
    return `<div style="font-size:9px;color:${color};font-family:var(--mo);margin-top:4px">Ajustement historique : ${label} — ${historicalAdjustment.volume} cartes${roiTxt}${wrTxt}</div>`;
  })();

  const sportHistBadge = (function(){
    if(!sportHistoricalAdjustment) return '';
    if(sportHistoricalAdjustment.status === 'insufficient') {
      return `<div style="font-size:9px;color:var(--dm);font-family:var(--mo);margin-top:2px">Historique sportif avancé : insuffisant — ${sportHistoricalAdjustment.volume} entrée(s)</div>`;
    }
    const color = sportHistoricalAdjustment.status==='positive'?'var(--gr)'
      : sportHistoricalAdjustment.status==='negative'?'var(--re)':'var(--am)';
    const wrTxt  = sportHistoricalAdjustment.winRate!=null ? `réussite ${sportHistoricalAdjustment.winRate}%` : 'réussite —';
    const clvTxt = sportHistoricalAdjustment.avgCLV!=null ? `CLV ${sportHistoricalAdjustment.avgCLV>0?'+':''}${sportHistoricalAdjustment.avgCLV}%` : 'CLV —';
    return `<div style="font-size:9px;color:${color};font-family:var(--mo);margin-top:2px">Historique sportif avancé : ${sportHistoricalAdjustment.volume} entrées, ${wrTxt}, ${clvTxt}</div>`;
  })();

  const sport = o.sport || o._sport || '';
  const ico   = sport.includes('soccer')?'&#9917;':sport.includes('basket')?'&#127936;'
    :sport.includes('tennis')?'&#127934;':sport.includes('mma')||sport.includes('box')?'&#129354;'
    :sport.includes('hockey')?'&#127944;':sport.includes('rugby')?'&#127945;'
    :sport.includes('base')?'&#9918;':sport.includes('football')?'&#127944;':'&#127942;';

  const mktLabel = {h2h:'1X2',totals:'O/U',btts:'BTTS',double_chance:'DC',spreads:'HC'}[o.market]||(o.market||'');
  const selDisplay = translateSelection(o.selection, o.market, o.home_team, o.away_team, o.line!=null?o.line:null);
  const bms  = o.all_bookmakers||[];
  const subs = s.subscores||{};

  const tierCfg = {
    premium: { border:'var(--gr)',  bg:'rgba(0,255,157,.04)', bannerBg:'rgba(0,255,157,.18)', label:'TRÈS FORTE', icon:'&#128142;' },
    solid:   { border:'var(--am)',  bg:'rgba(245,158,11,.03)',bannerBg:'rgba(245,158,11,.16)','label':'FORTE', icon:'&#11088;' },
    basic:   { border:'var(--neon)',bg:'rgba(0,212,255,.03)', bannerBg:'rgba(0,212,255,.14)','label':'JOUABLE', icon:'&#9654;' },
  }[tier] || { border:'var(--bd)', bg:'', bannerBg:'rgba(78,106,138,.12)', label:tierLabel, icon:'&#9654;' };

  const pgiStrong=pgiIsStrongSportsSignal(o,res);
  const pgiGreen=pgiStrong||betproBenterIsHighProbability(o,res);
  if(pgiGreen&&!pgiStrong){tierCfg.label='PROBABILITÉ MODÈLE ÉLEVÉE';tierCfg.border='var(--gr)';tierCfg.bg='rgba(0,255,157,.04)';tierCfg.bannerBg='rgba(0,255,157,.16)';tierCfg.icon='&#10003;';}
  if(pgiStrong){tierCfg.label='SÉLECTION TRÈS FORTE À JOUER';tierCfg.border='#39ff14';tierCfg.bannerBg='rgba(57,255,20,.18)';tierCfg.icon='&#10003;';}
  const bannerColor=pgiGreen?'var(--gr)':tierColor;

  const stakeNote = tier==='basic'
    ? '<div style="font-size:9px;color:var(--am);font-family:var(--mo);margin-top:4px">&#9888; SOLIDE — mise prudente, jamais utilisée en rattrapage</div>'
    : tier==='solid'
    ? '<div style="font-size:9px;color:var(--gr);font-family:var(--mo);margin-top:4px">Rattrapage autorisé uniquement avec mise réduite</div>'
    : '<div style="font-size:9px;color:var(--gr);font-family:var(--mo);margin-top:4px">&#9989; Rattrapage autorisé, dans la limite de bankroll définie. Aucune garantie.</div>';

  return `<div class="dir-card${pgiStrong?' pgi-signal-tres-fort':''}" data-sport-key="${sport}" data-tier="${tier}"
    style="border:1px solid ${tierCfg.border};background:${tierCfg.bg};border-radius:8px;overflow:hidden;margin-bottom:10px;cursor:pointer;transition:all .2s"
    id="dc-${containerId}-${i}" onclick="tDC(this,event)">

    <div style="padding:7px 14px;display:flex;align-items:center;gap:8px;background:${tierCfg.bannerBg}">
      <span style="font-size:12px">${tierCfg.icon}</span>
      <span style="font-family:var(--hd);font-size:10px;font-weight:800;letter-spacing:.08em;color:${bannerColor}">${tierCfg.label}</span>
      <span style="margin-left:auto;font-family:var(--mo);font-size:18px;font-weight:800;color:${bannerColor}">${displayConf}%</span>
      <span style="font-family:var(--mo);font-size:9px;color:${bannerColor};opacity:.75">confiance globale</span>
    </div>

    <div style="padding:12px 14px">
      <div style="font-family:var(--hd);font-size:13px;font-weight:700;margin-bottom:4px">
        ${ico} ${esc(o.home_team||'?')} <span style="color:var(--dm)">vs</span> ${esc(o.away_team||'?')}
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">
        <span class="bdg bgr">À JOUER</span>
        <span class="bdg bsp">${esc(o.competition||sport)}</span>
        <span class="bdg bmk">${mktLabel}</span>
        ${o.start_time?`<span class="bdg bsr">${fmtDate(o.start_time)}</span>`:''}
        ${dataQualityScore?`<span class="bdg" style="background:rgba(78,106,138,.15);color:var(--mu)">Qualité des données : ${dataQualityScore}%</span>`:''}
      </div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-family:var(--mo);font-size:13px;font-weight:700;color:var(--tx)">${esc(selDisplay)}</span>
        <span style="font-family:var(--mo);font-size:20px;font-weight:700;color:var(--am)">@ ${o.odds||'?'}</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:5px;margin-bottom:8px">
        <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:5px;padding:6px 8px;text-align:center">
          <div style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--mu)">${impliedProb}%</div>
          <div style="font-size:8px;color:var(--dm);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Prob. bookmaker</div>
        </div>
        <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:5px;padding:6px 8px;text-align:center">
          <div style="font-family:var(--mo);font-size:12px;font-weight:700;color:${tierColor}">${modelProb}%</div>
          <div style="font-size:8px;color:var(--dm);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Prob. modèle</div>
        </div>
        <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:5px;padding:6px 8px;text-align:center">
          <div style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--gr)">+${edgeProb}%</div>
          <div style="font-size:8px;color:var(--dm);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Avantage sur la cote</div>
        </div>
        <div style="background:var(--sf2);border:1px solid var(--bd);border-radius:5px;padding:6px 8px;text-align:center">
          <div style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--am)">${evSimple?evSimple.toFixed(3):'—'}</div>
          <div style="font-size:8px;color:var(--dm);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Valeur attendue</div>
        </div>
        ${kellyFull?`<div style="background:var(--sf2);border:1px solid var(--bd);border-radius:5px;padding:6px 8px;text-align:center"><div style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--pu)">${kellyFull}%</div><div style="font-size:8px;color:var(--dm);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Kelly</div></div>`:''}
        ${stakeRecommended?`<div style="background:rgba(0,255,157,.06);border:1px solid rgba(0,255,157,.2);border-radius:5px;padding:6px 8px;text-align:center"><div style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--gr)">${stakeRecommended} €</div><div style="font-size:8px;color:var(--dm);text-transform:uppercase;letter-spacing:.04em;margin-top:2px">Mise conseillée</div></div>`:''}
      </div>

      ${warning?`<div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:5px;padding:6px 10px;font-size:10px;color:var(--am);margin-bottom:6px">&#9888; ${esc(warning)}</div>`:''}
      ${histBadge}
      ${sportHistBadge}
      ${renderProfessionalEvidence(o.card_evidence)}
      ${stakeNote}
    </div>

    <div class="dir-detail" style="padding:0 14px 12px;display:none">
      <div style="background:linear-gradient(135deg,rgba(0,255,157,.04),rgba(0,212,255,.03));border:1px solid rgba(0,212,255,.12);border-radius:6px;padding:12px;margin-bottom:10px">
        <div style="font-size:9px;color:var(--dm);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;font-family:var(--mo);font-weight:700">Analyse William Benter</div>
        ${buildWhyBox(o, s, impliedProb, modelProb, evPct)}
        ${reason?`<div style="font-size:10px;color:var(--mu);margin-top:8px;padding-top:8px;border-top:1px solid var(--bd)"><strong>Raison :</strong> ${esc(reason)}</div>`:''}
        <div style="font-size:10px;color:var(--dm);margin-top:6px;font-style:italic">${esc(disclaimer||'Analyse probabiliste — aucun pari garanti. Peut perdre malgré une EV positive.')}</div>
      </div>

      <div style="margin-bottom:10px">
        ${ssRow('Valeur cote', subs.odds_value)}
        ${ssRow('Stabilité cotes', subs.stability)}
        ${ssRow('Consensus bookmakers', subs.consensus)}
        ${ssRow('Plausibilité', subs.plausibility)}
      </div>

      ${bms.length>1?`<div style="margin-bottom:10px"><div style="font-size:9px;color:var(--dm);font-family:var(--mo);text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">Opérateurs (${bms.length})</div>${bms.slice().sort((a,b)=>b.odds-a.odds).slice(0,5).map((b,bi)=>`<div class="om-bm-row"><span style="flex:1;font-size:11px">${esc(b.bookmaker||b.name||'?')}</span><span style="font-family:var(--mo);font-weight:700;color:${bi===0?'var(--gr)':'var(--mu)'}">${b.odds}</span>${bi===0?'<span style="background:rgba(0,255,157,.15);color:var(--gr);border-radius:3px;font-size:8px;padding:1px 5px;font-weight:700">MEILLEURE COTE</span>':''}</div>`).join('')}</div>`:''}

      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-top:10px">
        <span style="font-size:10px;color:var(--dm)">&#9888;&#65039; Analyse probabiliste — aucun gain garanti.</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${bookieLinkHtml()}
          <button class="copy-btn" onclick="event.stopPropagation();copyTeamNames(this)"
            data-home="${esc(o.home_team||'')}" data-away="${esc(o.away_team||'')}">&#128203; Copier</button>
        </div>
      </div>
    </div>
  </div>`;
}

function tDC(el, evt){
  if(evt&&evt.target.closest('button,a,input')) return;
  const detail = el.querySelector('.dir-detail');
  if(detail) detail.style.display = detail.style.display==='none'?'block':'none';
}

// ═══════════════════════════════════════════════════════════════════
//  MODULE PERFORMANCES — Statistiques & Conclusions
// ═══════════════════════════════════════════════════════════════════

let _perfPeriod = '30d';
let _perfCustomFrom = null;
let _perfCustomTo   = null;

function setPerfPeriod(p, el) {
  _perfPeriod = p;
  document.querySelectorAll('#perf-period-btns .fbtn').forEach(b=>b.classList.remove('on'));
  el?.classList.add('on');
  const customDiv = document.getElementById('perf-custom-dates');
  if(customDiv) customDiv.style.display = p==='custom' ? 'block' : 'none';
  if(p !== 'custom') loadPerformances();
}

function filterByPeriod(cards, period) {
  if(period === 'all') return cards;
  const ms = {today:86400000,'7d':604800000,'30d':2592000000,'90d':7776000000}[period]||Infinity;
  const now = Date.now();
  return cards.filter(c => now - new Date(c.detectedAt).getTime() <= ms);
}

function getPerfCards() {
  let cards = histLocalLoad();
  const sportF  = document.getElementById('perf-sport-filter')?.value  || 'all';
  const tierF   = document.getElementById('perf-tier-filter')?.value   || 'all';
  const sourceF = document.getElementById('perf-source-filter')?.value || 'all';

  if(sportF !== 'all') cards = cards.filter(c => (c.sport||'').toLowerCase().includes(sportF));
  if(tierF !== 'all') cards = cards.filter(c => c.tier === tierF);
  if(sourceF !== 'all') cards = cards.filter(c => (c.source||'moteur_reel') === sourceF);

  if(_perfPeriod === 'custom') {
    const from = _perfCustomFrom || document.getElementById('perf-date-from')?.value;
    const to   = _perfCustomTo   || document.getElementById('perf-date-to')?.value;
    if(from) cards = cards.filter(c => c.detectedAt >= from);
    if(to)   cards = cards.filter(c => c.detectedAt <= to+'T23:59:59Z');
  } else if(_perfPeriod !== 'all') {
    cards = filterByPeriod(cards, _perfPeriod);
  }
  return cards;
}

async function loadPerformances() {
  const syncEl = document.getElementById('perf-sync-info');
  if(syncEl) syncEl.textContent = 'Synchronisation…';

  let pagesLoaded = 0, remoteCount = 0;
  try {
    const remote = await histKVLoadAll();
    pagesLoaded = remote.pagesLoaded || 0;
    remoteCount = remote.cards ? remote.cards.length : 0;
    if(remote.cards && remote.cards.length) {
      const local = histLocalLoad();
      const merged = mergeHistories(local, remote.cards);
      histLocalSave(merged);
    }
  } catch(_) {}

  const cards = getPerfCards();
  const stats = calcHistStats(cards, 'all');

  loadUniversalLedgerStats();
  renderPerfGlobal(stats, cards.length);
  renderAdvancedSportHistoryStats();
  renderPerfByTier(cards);
  renderPerfConclusion(stats);
  renderPerfBySport(stats);
  renderPerfByMarket(stats);
  renderPerfByOddsZone(stats);
  renderPerfHistList(cards);

  if(syncEl) {
    const pageLabel = pagesLoaded > 0 ? ` · ${pagesLoaded} page(s) KV chargée(s) · ${remoteCount} carte(s)` : '';
    syncEl.textContent = 'Dernière sync : ' + fmtDT(new Date().toISOString()) + pageLabel;
  }
}

async function loadUniversalLedgerStats() {
  const el=document.getElementById('universal-ledger-stats'); if(!el)return;
  const days={today:1,'7d':7,'30d':30,'90d':90,all:36500}[_perfPeriod]||3650;
  try {
    const d=await api('/api/ledger/stats?period_days='+days);
    if(!d.ok){el.innerHTML='<div class="info">La base historique D1 sera active dès que le binding BET_DB sera ajouté.</div>';return;}
    const seg=d.segments||[];
    const sport=seg.filter(x=>x.universe==='SPORT');
    const pmu=seg.filter(x=>x.universe==='PMU');
    const sum=a=>({n:a.reduce((s,x)=>s+(x.total||0),0),w:a.reduce((s,x)=>s+(x.wins||0),0),l:a.reduce((s,x)=>s+(x.losses||0),0),p:a.reduce((s,x)=>s+(Number(x.roi||0)*(x.total||0)),0)});
    const S=sum(sport),P=sum(pmu),fmt=x=>x.n?((x.p/x.n)>=0?'+':'')+(x.p/x.n).toFixed(1)+'%':'—';
    el.innerHTML=`<div class="card"><div class="ct">Historique universel D1 — tous sports et tous paris PMU</div><div class="strat-summary">
      <div class="ss-cell"><div class="sv" style="color:var(--neon)">${S.n}</div><label>Paris sportifs réglés</label></div>
      <div class="ss-cell"><div class="sv" style="color:var(--gr)">${P.n}</div><label>Paris PMU réglés</label></div>
      <div class="ss-cell"><div class="sv">${fmt(S)}</div><label>ROI sports pondéré</label></div>
      <div class="ss-cell"><div class="sv">${fmt(P)}</div><label>ROI PMU pondéré</label></div></div>
      <div style="font-size:10px;color:var(--dm)">${seg.length} segment(s) distinct(s) par sport, marché et type de pari. Les apprentissages ne sont jamais mélangés.</div></div>`;
  }catch(e){el.innerHTML='<div class="info">Historique D1 non encore relié : '+esc(e.message)+'</div>';}
}

function mergeHistories(local, remote) {
  const map = {};
  [...local, ...remote].forEach(c => { map[c.id] = c; });
  return Object.values(map).sort((a,b)=>new Date(b.detectedAt)-new Date(a.detectedAt));
}

function renderPerfGlobal(stats, total) {
  const el = document.getElementById('perf-global-stats');
  if(!el) return;
  const roi = stats.roi;
  const roiColor = roi===null?'var(--mu)':roi>5?'var(--gr)':roi>0?'var(--am)':'var(--re)';
  el.innerHTML = `<div class="card"><div class="ct">&#128202; Statistiques globales</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px">
      <div class="tsm-cell"><div class="sv">${total}</div><label>Cartes totales</label></div>
      <div class="tsm-cell"><div class="sv">${stats.pending}</div><label>En attente</label></div>
      <div class="tsm-cell"><div class="sv" style="color:var(--gr)">${stats.won}</div><label>Gagnées</label></div>
      <div class="tsm-cell"><div class="sv" style="color:var(--re)">${stats.lost}</div><label>Perdues</label></div>
      <div class="tsm-cell"><div class="sv">${stats.winRate!==null?stats.winRate+'%':'—'}</div><label>Taux réussite</label></div>
      <div class="tsm-cell"><div class="sv" style="color:${roiColor}">${roi!==null?(roi>0?'+':'')+roi+'%':'—'}</div><label>ROI virtuel</label></div>
      <div class="tsm-cell"><div class="sv">${stats.totalVGain>0?'+':''}&nbsp;${stats.totalVGain} €</div><label>Gain/perte</label></div>
      <div class="tsm-cell"><div class="sv">${stats.avgOdds||'—'}</div><label>Cote moy.</label></div>
      <div class="tsm-cell"><div class="sv">${stats.avgScore||'—'}</div><label>Score moy.</label></div>
      <div class="tsm-cell"><div class="sv">${stats.maxWin}</div><label>Série gains</label></div>
      <div class="tsm-cell"><div class="sv" style="color:var(--re)">${stats.maxLoss}</div><label>Série pertes</label></div>
      <div class="tsm-cell"><div class="sv">${stats.avgCLV!==null?stats.avgCLV+'%':'—'}</div><label>CLV moy.</label></div>
      <div class="tsm-cell"><div class="sv">${stats.avgEV!==null?stats.avgEV.toFixed(3):'—'}</div><label>EV moy.</label></div>
      <div class="tsm-cell"><div class="sv">${stats.avgDQS!==null?stats.avgDQS+'%':'—'}</div><label>DQS moy.</label></div>
      <div class="tsm-cell"><div class="sv">${stats.avgKelly!==null?stats.avgKelly+'%':'—'}</div><label>Kelly moy.</label></div>
    </div>
  </div>`;
}

function renderPerfByTier(cards) {
  const el = document.getElementById('perf-tier-stats');
  if(!el) return;
  const tiers = [
    {id:'premium',label:'TRÈS FORTE',color:'var(--gr)',icon:'&#128142;'},
    {id:'solid',  label:'TRÈS SOLIDE',color:'var(--am)',icon:'&#11088;'},
    {id:'basic',  label:'SOLIDE',      color:'var(--neon)',icon:'&#9650;'},
  ];
  const html = tiers.map(t => {
    const g = calcGroupStats(cards.filter(c=>c.tier===t.id));
    const roiColor = g.roi===null?'var(--mu)':g.roi>5?'var(--gr)':g.roi>0?'var(--am)':'var(--re)';
    return `<div style="background:var(--sf2);border:1px solid ${t.color};border-radius:8px;padding:12px;flex:1;min-width:120px;text-align:center">
      <div style="font-size:11px;color:${t.color};font-weight:800;margin-bottom:8px">${t.icon} ${t.label}</div>
      <div style="font-family:var(--mo);font-size:18px;font-weight:700;margin-bottom:2px">${g.total}</div>
      <div style="font-size:9px;color:var(--dm);margin-bottom:6px">cartes réglées${g.total<100?' (insuffisant)':''}</div>
      <div style="font-family:var(--mo);font-size:14px;font-weight:700;color:${g.winRate!==null&&g.winRate>=55?'var(--gr)':'var(--mu)'}">${g.winRate!==null?g.winRate+'%':'—'}</div>
      <div style="font-size:9px;color:var(--dm);margin-bottom:4px">taux réussite</div>
      <div style="font-family:var(--mo);font-size:14px;font-weight:700;color:${roiColor}">${g.roi!==null?(g.roi>0?'+':'')+g.roi+'%':'—'}</div>
      <div style="font-size:9px;color:var(--dm)">ROI virtuel</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="card"><div class="ct">Performance par niveau</div><div style="display:flex;gap:8px;flex-wrap:wrap">${html}</div></div>`;
}

function renderPerfConclusion(stats) {
  const el = document.getElementById('perf-conclusion');
  if(!el) return;
  const lines = generateConclusion(stats, _perfPeriod);
  const colorMap = {green:'var(--gr)',orange:'var(--am)',red:'var(--re)',gray:'var(--dm)'};
  const html = lines.map(l=>`<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;padding:7px 10px;background:var(--sf2);border-radius:5px;border-left:3px solid ${colorMap[l.color]||'var(--dm)'}">
    <span style="font-size:11px;color:var(--mu);line-height:1.6">${esc(l.text)}</span>
  </div>`).join('');
  el.innerHTML = `<div class="card"><div class="ct">&#129302; Conclusion automatique du moteur</div>${html}</div>`;
}

function renderPerfBySport(stats) {
  const el = document.getElementById('perf-sport-stats');
  if(!el) return;
  if(!stats.bySport?.length) { el.innerHTML=''; return; }
  const rows = stats.bySport.slice(0,10).map(s=>{
    const roiColor=s.roi===null?'var(--mu)':s.roi>5?'var(--gr)':s.roi>0?'var(--am)':'var(--re)';
    const reliable = s.total>=500?'&#9989;':s.total>=100?'&#9889;':'&#128683;';
    return `<tr>
      <td>${esc(s.sport)}</td>
      <td>${s.total}</td>
      <td>${s.won}</td>
      <td>${s.winRate!==null?s.winRate+'%':'—'}</td>
      <td style="color:${roiColor};font-family:var(--mo);font-weight:700">${s.roi!==null?(s.roi>0?'+':'')+s.roi+'%':'—'}</td>
      <td style="text-align:center">${reliable}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<div class="card"><div class="ct">Performance par sport</div>
    <table class="tracker-table"><thead><tr><th>Sport</th><th>Total</th><th>Gagnées</th><th>% Réussite</th><th>ROI</th><th>Fiabilité</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div style="font-size:9px;color:var(--dm);margin-top:6px">&#9989; ≥500 cartes réglées · &#9889; ≥100 · &#128683; &lt;100 (insuffisant, pas de recommandation forte)</div>
  </div>`;
}

function renderPerfByMarket(stats) {
  let el = document.getElementById('perf-market-stats');
  if(!el) {
    const sportEl = document.getElementById('perf-sport-stats');
    if(!sportEl) return;
    el = document.createElement('div');
    el.id = 'perf-market-stats';
    sportEl.after(el);
  }
  if(!stats.byMarket?.length) { el.innerHTML=''; return; }
  const mktLabels = {h2h:'1X2/H2H',totals:'Over/Under',btts:'BTTS',spreads:'Handicap',double_chance:'Double Chance'};
  const rows = stats.byMarket.map(m=>{
    const roiC = m.roi===null?'var(--mu)':m.roi>5?'var(--gr)':m.roi>0?'var(--am)':'var(--re)';
    return `<tr><td>${mktLabels[m.market]||m.market}</td><td>${m.total}</td><td>${m.won}</td><td>${m.winRate!==null?m.winRate+'%':'—'}</td><td style="color:${roiC};font-family:var(--mo);font-weight:700">${m.roi!==null?(m.roi>0?'+':'')+m.roi+'%':'—'}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="card" style="margin-bottom:12px"><div class="ct">Performance par marché</div>
    <table class="tracker-table"><thead><tr><th>Marché</th><th>Total</th><th>Gagnées</th><th>% Réussite</th><th>ROI</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div style="font-size:9px;color:var(--dm);margin-top:6px">⚠️ Les performances passées ne garantissent pas les résultats futurs.</div>
  </div>`;
}

function renderPerfByOddsZone(stats) {
  let el = document.getElementById('perf-oddszone-stats');
  if(!el) {
    const marketEl = document.getElementById('perf-market-stats') || document.getElementById('perf-sport-stats');
    if(!marketEl) return;
    el = document.createElement('div');
    el.id = 'perf-oddszone-stats';
    marketEl.after(el);
  }
  if(!stats.byOddsZone?.length) { el.innerHTML=''; return; }
  const rows = stats.byOddsZone.map(z=>{
    const roiC = z.roi===null?'var(--mu)':z.roi>5?'var(--gr)':z.roi>0?'var(--am)':'var(--re)';
    const reliable = z.total>=500?'&#9989;':z.total>=100?'&#9889;':'&#128683;';
    return `<tr><td>${esc(z.zone)}</td><td>${z.total}</td><td>${z.won}</td><td>${z.winRate!==null?z.winRate+'%':'—'}</td><td style="color:${roiC};font-family:var(--mo);font-weight:700">${z.roi!==null?(z.roi>0?'+':'')+z.roi+'%':'—'}</td><td style="text-align:center">${reliable}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="card" style="margin-bottom:12px"><div class="ct">Performance par zone de cote</div>
    <table class="tracker-table"><thead><tr><th>Zone de cote</th><th>Total</th><th>Gagnées</th><th>% Réussite</th><th>ROI</th><th>Fiabilité</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div style="font-size:9px;color:var(--dm);margin-top:6px">&#9989; ≥500 cartes réglées · &#9889; ≥100 · &#128683; &lt;100 (insuffisant, pas de recommandation forte) — les performances passées ne garantissent pas les résultats futurs.</div>
  </div>`;
}

function renderPerfHistList(cards) {
  const el    = document.getElementById('perf-hist-list');
  const count = document.getElementById('perf-hist-count');
  if(!el) return;
  if(count) count.textContent = cards.length + ' cartes';
  if(!cards.length) {
    el.innerHTML = '<div class="empty" style="padding:28px"><div class="empty-i">&#128200;</div><div class="empty-t">Aucune carte enregistrée</div><div class="empty-s">Les cartes proposées par le moteur sont enregistrées automatiquement.</div></div>';
    return;
  }
  const tierColors = {premium:'var(--gr)',solid:'var(--am)',basic:'var(--neon)'};
  const tierLabels = {premium:'TOP',solid:'SOLIDE+',basic:'SOLIDE'};
  el.innerHTML = cards.slice(0,100).map(c=>{
    const statusColor = c.status==='win'?'var(--gr)':c.status==='loss'?'var(--re)':c.status==='void'?'var(--am)':'var(--dm)';
    const statusLabel = c.status==='win'?'✅ Gagné':c.status==='loss'?'❌ Perdu':c.status==='void'?'— Void':'⏳ Attente';
    const tc = tierColors[c.tier]||'var(--mu)';
    const tl = tierLabels[c.tier]||c.tierLabel||'';
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--bd);flex-wrap:wrap">
      <span style="font-size:9px;font-family:var(--mo);font-weight:700;color:${tc};min-width:50px">${tl}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:700;color:var(--tx)">${esc(c.home||'?')} vs ${esc(c.away||'?')}</div>
        <div style="font-size:9px;color:var(--dm);font-family:var(--mo)">${esc(c.sport||'')} · ${esc(c.selection||'')} @ ${c.odds} · ${fmtDT(c.detectedAt)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;font-weight:700;color:${statusColor}">${statusLabel}</div>
        ${c.virtualGain!==null?`<div style="font-size:9px;font-family:var(--mo);color:${c.virtualGain>=0?'var(--gr)':'var(--re)'}">${c.virtualGain>=0?'+':''}${c.virtualGain} €</div>`:''}
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button onclick="updateBetCardResult('${esc(c.id)}','win');loadPerformances()" style="background:rgba(34,211,165,.12);border:1px solid rgba(34,211,165,.3);color:var(--gr);border-radius:3px;font-size:9px;padding:3px 7px;cursor:pointer;font-family:var(--mo)">Gagné</button>
        <button onclick="updateBetCardResult('${esc(c.id)}','loss');loadPerformances()" style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:var(--re);border-radius:3px;font-size:9px;padding:3px 7px;cursor:pointer;font-family:var(--mo)">Perdu</button>
        <button onclick="updateBetCardResult('${esc(c.id)}','void');loadPerformances()" style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:var(--am);border-radius:3px;font-size:9px;padding:3px 6px;cursor:pointer;font-family:var(--mo)">Void</button>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════
//  BLACKJACK DIRECTIONNEL
//  Comptage Hi-Lo · Direction claire · Stratégie de base · Chat contextuel
//  Aide statistique et pédagogique uniquement — aucun gain garanti.
//  VRAIES FACES DE CARTES : pips positionnés (2-10) + figures illustrées
//  originales pour Valet/Dame/Roi (silhouettes distinctes par rang), au
//  lieu d'une simple icône de couleur centrale.
// ═══════════════════════════════════════════════════════════════════════

const BJ_CARD_ORDER  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const BJ_CARD_VALUES = { A:-1, '2':1,'3':1,'4':1,'5':1,'6':1, '7':0,'8':0,'9':0, '10':-1, J:-1, Q:-1, K:-1 };
const BJ_CARD_FR     = { A:'As', '2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9','10':'10', J:'Valet', Q:'Dame', K:'Roi' };
const BJ_CARD_BJVALUE= { A:11, '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10, J:10, Q:10, K:10 };
const BJ_SUITS = [
  { key:'hearts',   symbol:'♥', label:'Cœur',   color:'red'   },
  { key:'diamonds', symbol:'♦', label:'Carreau', color:'red'   },
  { key:'clubs',    symbol:'♣', label:'Trèfle',  color:'black' },
  { key:'spades',   symbol:'♠', label:'Pique',   color:'black' },
];
const BJ_SUIT_SYMBOL = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' };
const BJ_SUIT_ICON_SVG = {
  hearts:   '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="currentColor"/></svg>',
  diamonds: '<svg viewBox="0 0 24 24"><polygon points="12,2 21,12 12,22 3,12" fill="currentColor"/></svg>',
  clubs:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.2" r="4.2" fill="currentColor"/><circle cx="7.3" cy="14" r="4.2" fill="currentColor"/><circle cx="16.7" cy="14" r="4.2" fill="currentColor"/><rect x="10.4" y="14.5" width="3.2" height="7.5" rx="1" fill="currentColor"/></svg>',
  spades:   '<svg viewBox="0 0 24 24"><path d="M12 2C9.2 6 3.2 10.3 3.2 14.8a4.8 4.8 0 0 0 8.16 3.42c-.25 2.02-1.2 3.3-2.86 3.78h6.9c-1.66-.48-2.61-1.76-2.86-3.78a4.8 4.8 0 0 0 8.16-3.42C20.8 10.3 14.8 6 12 2z" fill="currentColor"/></svg>',
};
function bjCardKey(rank, suit){ return rank+'_'+(suit||''); }

// ── VRAIES FACES DE CARTES ────────────────────────────────────────────
// Positions des pips (1-indexé, grille 5 lignes x 3 colonnes) par rang —
// dispositions classiques d'un jeu de cartes français (approximatives,
// suffisantes à cette taille d'affichage). A = 1 pip central, 10 = 10 pips.
const BJ_PIP_LAYOUT = {
  'A':  [[3,2]],
  '2':  [[1,2],[5,2]],
  '3':  [[1,2],[3,2],[5,2]],
  '4':  [[1,1],[1,3],[5,1],[5,3]],
  '5':  [[1,1],[1,3],[3,2],[5,1],[5,3]],
  '6':  [[1,1],[1,3],[3,1],[3,3],[5,1],[5,3]],
  '7':  [[1,1],[1,3],[2,2],[3,1],[3,3],[5,1],[5,3]],
  '8':  [[1,1],[1,3],[2,2],[3,1],[3,3],[4,2],[5,1],[5,3]],
  '9':  [[1,1],[1,3],[2,1],[2,3],[3,2],[4,1],[4,3],[5,1],[5,3]],
  '10': [[1,1],[1,3],[2,1],[2,3],[2,2],[4,2],[4,1],[4,3],[5,1],[5,3]],
};
// Figures illustrées originales pour Valet / Dame / Roi — silhouettes
// distinctes (pas de reproduction d'un jeu de cartes existant) : le Valet
// est une simple silhouette de profil sans couronne, la Dame porte une
// couronne pointue avec chevelure, le Roi porte une couronne à 3 pointes
// avec barbe. currentColor hérite du rouge/noir de la couleur de la carte.
const BJ_FACE_ART = {
  J: '<svg viewBox="0 0 40 60"><path d="M20 6c-4 0-7 3-7 7 0 3 1.5 5.5 3.5 6.8L14 24h12l-2.5-4.2C25.5 18.5 27 16 27 13c0-4-3-7-7-7z" fill="currentColor"/><path d="M12 26h16l3 8-2 20H11l-2-20z" fill="currentColor" opacity=".85"/><rect x="17" y="19" width="6" height="6" fill="currentColor" opacity=".6"/></svg>',
  Q: '<svg viewBox="0 0 40 60"><path d="M20 4l2.2 4.2L27 6l-1 5.2L31 13l-4.2 2.6L29 20l-5-1-1 5-3-4-3 4-1-5-5 1 2.2-4.4L9 13l4.8-1.8L12.8 6l4.8 2.2z" fill="currentColor"/><circle cx="20" cy="20" r="7" fill="currentColor"/><path d="M11 28h18l3 8-2 18H10l-2-18z" fill="currentColor" opacity=".85"/></svg>',
  K: '<svg viewBox="0 0 40 60"><path d="M10 14l4 6 6-8 6 8 4-6 2 10H8z" fill="currentColor"/><circle cx="20" cy="24" r="7.5" fill="currentColor"/><path d="M13 20c2-2 5-3 7-3s5 1 7 3" stroke="currentColor" stroke-width="1.6" fill="none" opacity=".7"/><path d="M10 32h20l3 8-2 16H9l-2-16z" fill="currentColor" opacity=".85"/></svg>',
};
function bjBuildCardFaceInner(rank, suitKey) {
  const iconSvg = BJ_SUIT_ICON_SVG[suitKey] || '';
  const corner = `<div class="bjc-corner"><span class="bjc-corner-rank">${rank}</span>${iconSvg}</div>`;
  if (rank === 'J' || rank === 'Q' || rank === 'K') {
    return corner + `<div class="bj-face-illustration">${BJ_FACE_ART[rank]}</div>`;
  }
  const layout = BJ_PIP_LAYOUT[rank] || [];
  const pipsHtml = layout.map(([r,c]) => `<div class="bj-pip-cell pip-r${r} pip-c${c}">${iconSvg}</div>`).join('');
  return corner + `<div class="bj-pip-grid">${pipsHtml}</div>`;
}

const BJ_STORAGE_KEY = 'pgi_bj_session_v1';
let BJ_STATE = null;
let BJ_INITIALIZED = false;
let BJ_PENDING_RESUME = null;
let BJ_PENDING_DECK_CHANGE = null;

function bjDefaultState() {
  return {
    config: { decks:'6', gameType:'live', tableMin:null, bankroll:null, risk:'prudent', strategy:'directional' },
    cardsSeen: [],
    redoStack: [],
    correctionsWindow: [],
    selectedCards: {},
    audio: { enabled:false },
    createdAt: new Date().toISOString(),
  };
}
function bjSaveState(){ try{ localStorage.setItem(BJ_STORAGE_KEY, JSON.stringify(BJ_STATE)); }catch(_){} }
function bjLoadStateRaw(){ try{ const raw=localStorage.getItem(BJ_STORAGE_KEY); return raw?JSON.parse(raw):null; }catch(_){ return null; } }

function bjInit(){
  if(BJ_INITIALIZED){ bjRenderAll(); return; }
  BJ_INITIALIZED = true;
  const saved = bjLoadStateRaw();
  if(saved && Array.isArray(saved.cardsSeen) && saved.cardsSeen.length>0){
    BJ_STATE = bjDefaultState();
    if(!saved.selectedCards) saved.selectedCards = {};
    BJ_PENDING_RESUME = saved;
    const btn = document.getElementById('bj-resume-btn');
    if(btn) btn.style.display = '';
  } else {
    BJ_STATE = saved || bjDefaultState();
    if(!BJ_STATE.selectedCards) BJ_STATE.selectedCards = {};
  }
  bjPopulateCardsGrid();
  bjPopulateHandSelects();
  bjSyncConfigInputs();
  bjRenderAll();
}
function bjResumeSession(){
  if(BJ_PENDING_RESUME){ BJ_STATE = BJ_PENDING_RESUME; BJ_PENDING_RESUME=null; }
  if(!BJ_STATE.selectedCards) BJ_STATE.selectedCards = {};
  const btn = document.getElementById('bj-resume-btn');
  if(btn) btn.style.display='none';
  bjSyncConfigInputs();
  bjRenderAll();
  toast('Session reprise','ok');
}
function bjNewSession(){
  if(BJ_STATE && BJ_STATE.cardsSeen && BJ_STATE.cardsSeen.length && !confirm('Démarrer une nouvelle session ? La session en cours sera remplacée.')) return;
  BJ_STATE = bjDefaultState();
  BJ_PENDING_RESUME = null;
  const btn = document.getElementById('bj-resume-btn');
  if(btn) btn.style.display='none';
  bjSaveState();
  bjSyncConfigInputs();
  bjRenderAll();
  toast('Nouvelle session','ok');
}

// ── Population UI statique ───────────────────────────────────────────
// Grille étalée : 4 rangées (une par couleur), 13 cartes par rangée —
// chaque bouton affiche maintenant la VRAIE face de la carte (pips
// positionnés pour 2-10, figure illustrée pour Valet/Dame/Roi, gros pip
// central pour l'As) au lieu d'une simple icône générique de couleur.
function bjPopulateCardsGrid(){
  const grid = document.getElementById('bj-cards-grid');
  if(!grid || grid.dataset.filled) return;
  grid.innerHTML = BJ_SUITS.map(s => {
    const cells = BJ_CARD_ORDER.map(rank=>{
      const v = BJ_CARD_VALUES[rank];
      const cls = v>0?'bjc-plus':v<0?'bjc-minus':'bjc-zero';
      const vTxt = v>0?'+1':v<0?'-1':'0';
      const key = bjCardKey(rank, s.key);
      const faceInner = bjBuildCardFaceInner(rank, s.key);
      return `<div class="bj-card-btn bj-suit-${s.color} ${cls}" data-card="${rank}" data-suit="${s.key}" data-cardkey="${key}" onclick="bjOnCardClick('${rank}','${s.key}', this)">
        <div class="bj-card-face">${faceInner}</div>
        <div class="bjc-val">${vTxt}</div>
      </div>`;
    }).join('');
    return `<div class="bj-suit-row">
      <div class="bj-suit-label">${s.symbol} ${s.label}</div>
      <div class="bj-suit-cells">${cells}</div>
    </div>`;
  }).join('');
  grid.dataset.filled = '1';
}
function bjPopulateHandSelects(){
  const opts = '<option value="">—</option>' + BJ_CARD_ORDER.map(c=>`<option value="${c}">${c}</option>`).join('');
  ['bj-hand-c1','bj-hand-c2','bj-hand-dealer'].forEach(id=>{
    const el = document.getElementById(id);
    if(el && !el.dataset.filled){ el.innerHTML = opts; el.dataset.filled='1'; }
  });
}
function bjSyncConfigInputs(){
  const cfg = BJ_STATE.config;
  const $ = id=>document.getElementById(id);
  if($('bj-cfg-decks')) $('bj-cfg-decks').value = cfg.decks;
  if($('bj-cfg-type')) $('bj-cfg-type').value = cfg.gameType;
  if($('bj-cfg-tablemin')) $('bj-cfg-tablemin').value = cfg.tableMin||'';
  if($('bj-cfg-bankroll')) $('bj-cfg-bankroll').value = cfg.bankroll||'';
  if($('bj-cfg-strategy')) $('bj-cfg-strategy').value = cfg.strategy;
  bjSelectRisk(cfg.risk, true);
}

// ── Saisie des cartes — sélection persistante, carte par carte ──────
function bjOnCardClick(rank, suit, el){
  if(!BJ_STATE) return;
  if(!BJ_STATE.selectedCards) BJ_STATE.selectedCards = {};

  const key = bjCardKey(rank, suit);
  const existingId = BJ_STATE.selectedCards[key];
  if(existingId){
    bjRemoveCard(existingId);
  } else {
    const entry = { id: 'c'+Date.now()+Math.random().toString(36).slice(2,6), card:rank, suit, source:'manual', at:new Date().toISOString() };
    BJ_STATE.cardsSeen.push(entry);
    BJ_STATE.redoStack = [];
    BJ_STATE.selectedCards[key] = entry.id;
    bjSaveState();
    bjRenderAll();
  }
  if(el){ el.classList.remove('bj-flash'); void el.offsetWidth; el.classList.add('bj-flash'); }
}

function bjSyncCardButtonStates(){
  const grid = document.getElementById('bj-cards-grid');
  if(!grid || !BJ_STATE) return;
  grid.querySelectorAll('.bj-card-btn').forEach(btn=>{
    const key = btn.dataset.cardkey;
    const isSel = !!(BJ_STATE.selectedCards && BJ_STATE.selectedCards[key]);
    btn.classList.toggle('selected', isSel);
  });
}

function bjAddCard(card, source, suit){
  if(!BJ_STATE || !BJ_CARD_VALUES.hasOwnProperty(card)) return;
  const entry = { id: 'c'+Date.now()+Math.random().toString(36).slice(2,6), card, suit: suit||null, source: source||'manual', at: new Date().toISOString() };
  BJ_STATE.cardsSeen.push(entry);
  BJ_STATE.redoStack = [];
  bjSaveState();
  bjRenderAll();
}
function bjRemoveCard(id){
  if(!BJ_STATE) return;
  const idx = BJ_STATE.cardsSeen.findIndex(c=>c.id===id);
  if(idx<0) return;
  const removed = BJ_STATE.cardsSeen[idx];
  BJ_STATE.cardsSeen.splice(idx,1);
  const key = bjCardKey(removed.card, removed.suit);
  if(BJ_STATE.selectedCards && BJ_STATE.selectedCards[key] === id){
    delete BJ_STATE.selectedCards[key];
  }
  bjTrackCorrection();
  bjSaveState();
  bjRenderAll();
}
function bjUndo(){
  if(!BJ_STATE || !BJ_STATE.cardsSeen.length){ toast('Aucune carte à annuler','err'); return; }
  const removed = BJ_STATE.cardsSeen.pop();
  BJ_STATE.redoStack.push(removed);
  const key = bjCardKey(removed.card, removed.suit);
  if(BJ_STATE.selectedCards && BJ_STATE.selectedCards[key] === removed.id){
    delete BJ_STATE.selectedCards[key];
  }
  bjTrackCorrection();
  bjSaveState();
  bjRenderAll();
}
function bjRedo(){
  if(!BJ_STATE || !BJ_STATE.redoStack.length){ toast('Rien à rétablir','err'); return; }
  const card = BJ_STATE.redoStack.pop();
  BJ_STATE.cardsSeen.push(card);
  if(!BJ_STATE.selectedCards) BJ_STATE.selectedCards = {};
  if(card.suit){
    BJ_STATE.selectedCards[bjCardKey(card.card, card.suit)] = card.id;
  }
  bjSaveState();
  bjRenderAll();
}
function bjTrackCorrection(){
  const now = Date.now();
  BJ_STATE.correctionsWindow = (BJ_STATE.correctionsWindow||[]).filter(t => now-t < 5*60*1000);
  BJ_STATE.correctionsWindow.push(now);
}

// ── Reset main / reset sabot complet ─────────────────────────────────
function bjResetHand(){
  if(!BJ_STATE) return;
  BJ_STATE.cardsSeen = [];
  BJ_STATE.redoStack = [];
  BJ_STATE.selectedCards = {};
  bjSaveState();
  bjRenderAll();
  toast('Main réinitialisée','ok');
}
function bjResetShoeConfirm(){
  if(!confirm('Confirmer le reset complet du sabot ? Cette action efface toutes les cartes sorties.')) return;
  bjResetShoe();
}
function bjResetShoe(){
  if(!BJ_STATE) return;
  BJ_STATE.cardsSeen = [];
  BJ_STATE.redoStack = [];
  BJ_STATE.correctionsWindow = [];
  BJ_STATE.selectedCards = {};
  bjSaveState();
  bjRenderAll();
  toast('Sabot réinitialisé','ok');
}

// ── Comptage Hi-Lo ────────────────────────────────────────────────────
function bjCalculateRunningCount(){
  if(!BJ_STATE) return 0;
  return (BJ_STATE.cardsSeen||[]).reduce((s,c)=>s+(BJ_CARD_VALUES[c.card]||0),0);
}
function bjTotalCardsInShoe(){
  if(!BJ_STATE) return null;
  const d = BJ_STATE.config.decks;
  if(d==='unknown' || !d) return null;
  return parseInt(d,10)*52;
}
function bjCalculateTrueCount(){
  const total = bjTotalCardsInShoe();
  const running = bjCalculateRunningCount();
  if(total===null) return { trueCount:null, decksRemaining:null, cardsRemaining:null };
  const seen = BJ_STATE.cardsSeen.length;
  const cardsRemaining = Math.max(0, total - seen);
  const decksRemaining = Math.max(cardsRemaining/52, 0.25);
  const trueCount = Math.round((running/decksRemaining)*10)/10;
  return { trueCount, decksRemaining: Math.round(decksRemaining*100)/100, cardsRemaining };
}

// ── Détection d'incohérences ─────────────────────────────────────────
function bjCheckConsistency(){
  if(!BJ_STATE) return [];
  const warnings = [];
  const cfg = BJ_STATE.config;
  const cards = BJ_STATE.cardsSeen;
  if(cfg.decks !== 'unknown'){
    const decks = parseInt(cfg.decks,10);
    const maxAces = decks*4;
    const maxTens = decks*16;
    const acesSeen = cards.filter(c=>c.card==='A').length;
    const tensSeen = cards.filter(c=>['10','J','Q','K'].includes(c.card)).length;
    if(acesSeen > maxAces) warnings.push(`Tu as saisi plus d'As (${acesSeen}) que possible pour ${decks} deck(s) (max ${maxAces}). Vérifie le nombre de decks ou corrige l'historique.`);
    if(tensSeen > maxTens) warnings.push(`Tu as saisi plus de cartes à 10 points (${tensSeen}) que possible pour ${decks} deck(s) (max ${maxTens}). Vérifie le nombre de decks ou corrige l'historique.`);
    const total = decks*52;
    if(cards.length > total) warnings.push(`Le nombre total de cartes saisies (${cards.length}) dépasse la taille du sabot configuré (${total}). Réinitialise le sabot ou corrige le nombre de decks.`);
  }
  const recentCorrections = (BJ_STATE.correctionsWindow||[]).length;
  if(recentCorrections >= 6) warnings.push('Beaucoup de corrections récentes — la fiabilité du comptage est réduite.');
  return warnings;
}

// ── Niveau de confiance ───────────────────────────────────────────────
function bjEstimateConfidence(){
  if(!BJ_STATE) return { level:'vlow', label:'Très faible', reason:'Session non initialisée.' };
  const cfg = BJ_STATE.config;
  const seen = BJ_STATE.cardsSeen.length;
  const recentCorrections = (BJ_STATE.correctionsWindow||[]).length;

  if(cfg.decks === 'unknown') return { level:'vlow', label:'Très faible', reason:'Nombre de decks inconnu — le true count ne peut pas être fiable.' };
  if(seen < 12) return { level:'low', label:'Faible', reason:'Moins de 12 cartes vues — échantillon trop réduit.' };
  if(recentCorrections >= 4) return { level:'med', label:'Moyenne', reason:'Plusieurs corrections récentes — vérifie la cohérence de ta saisie.' };

  const inco = bjCheckConsistency();
  if(inco.length) return { level:'low', label:'Faible', reason:inco[0] };

  if(seen > 40) return { level:'high', label:'Haute', reason:'Decks connus et échantillon large — estimation fiable.' };
  return { level:'med', label:'Moyenne', reason:'Comptage cohérent, échantillon encore modéré.' };
}

// ── Gestion de mise ───────────────────────────────────────────────────
const BJ_BET_GRID = {
  prudent:  [{max:1, mult:1},{max:3, mult:1.5},{max:Infinity, mult:2}],
  standard: [{max:1, mult:1},{max:2, mult:1.5},{max:3, mult:2},{max:Infinity, mult:3}],
  agressif: [{max:1, mult:1},{max:2, mult:2},{max:3, mult:3},{max:Infinity, mult:4}],
};
const BJ_BANKROLL_CAP_PCT = { prudent:0.02, standard:0.03, agressif:0.05 };

function bjSuggestBet(trueCount, riskLevel){
  const cfg = BJ_STATE.config;
  const tableMin = parseFloat(cfg.tableMin);
  const bankroll = parseFloat(cfg.bankroll);
  const grid = BJ_BET_GRID[riskLevel] || BJ_BET_GRID.prudent;

  let mult = grid[0].mult;
  if(trueCount != null){
    for(const step of grid){ if(trueCount <= step.max){ mult = step.mult; break; } }
  }

  if(!tableMin || isNaN(tableMin)){
    return { amount:null, multiplier:mult, text:`${mult}x la mise minimale (montant non calculable — mise minimale de table non renseignée)` };
  }
  let amount = Math.round(tableMin*mult*100)/100;

  if(bankroll && !isNaN(bankroll) && bankroll>0){
    const capPct = BJ_BANKROLL_CAP_PCT[riskLevel] || 0.02;
    const cap = bankroll*capPct;
    if(amount > cap){ amount = Math.round(cap*100)/100; }
  }
  return { amount, multiplier:mult, text: `${amount}€ (${mult}x la mise minimale)` };
}

// ── Moteur de décision principal ─────────────────────────────────────
function getBlackjackDecision(state){
  state = state || BJ_STATE;
  if(!state) return { direction:'DONNÉES INSUFFISANTES', dirKey:'unknown', action:'Initialise une session.', riskLevel:'prudent', confidence:'Très faible', runningCount:0, trueCount:null, suggestedBet:null, reason:'Session non initialisée.', warnings:[] };

  const cfg = state.config;
  const seen = state.cardsSeen.length;
  const running = bjCalculateRunningCount();
  const { trueCount } = bjCalculateTrueCount();
  const confidence = bjEstimateConfidence();
  const warnings = bjCheckConsistency();
  const risk = cfg.risk || 'prudent';

  if(cfg.decks === 'unknown'){
    return {
      direction:'DONNÉES INSUFFISANTES', dirKey:'unknown',
      action:'Ne pas augmenter la mise, observer davantage.',
      riskLevel:risk, confidence: confidence.label, runningCount: running, trueCount: null,
      suggestedBet: bjSuggestBet(null, risk).text,
      reason:'Le nombre de decks est inconnu, donc le true count n\'est pas fiable.',
      warnings,
    };
  }

  if(seen < 12){
    return {
      direction:'ATTENDS', dirKey:'wait',
      action:'Observe davantage de cartes avant toute décision.',
      riskLevel:risk, confidence: confidence.label, runningCount: running, trueCount,
      suggestedBet: bjSuggestBet(trueCount, risk).text,
      reason:'Pas assez de cartes vues (moins de 12) pour une décision fiable.',
      warnings,
    };
  }

  const entryThresholds = { prudent:2.5, standard:2.0, agressif:1.5 };
  const boostThresholds = { prudent:4.0, standard:3.0, agressif:2.5 };
  const entryTh = entryThresholds[risk] ?? 2.5;
  const boostTh = boostThresholds[risk] ?? 4.0;

  let direction, dirKey, action, reason;

  if(trueCount <= 0){
    direction='NE RENTRE PAS'; dirKey='avoid';
    action='Reste en mise minimale ou n\'entre pas.';
    reason=`Le true count (${trueCount>=0?'+':''}${trueCount}) est négatif ou nul — avantage insuffisant.`;
  } else if(trueCount < 1.5){
    direction='ATTENDS'; dirKey='wait';
    action='Mise minimale, avantage encore trop faible.';
    reason=`Le true count (+${trueCount}) est positif mais reste faible.`;
  } else if(trueCount < entryTh){
    direction='JOUE EN MISE MINIMALE'; dirKey='wait';
    action='Tu peux jouer mais reste en mise minimale à ce niveau de risque.';
    reason=`Le true count (+${trueCount}) est correct mais sous ton seuil d'entrée (${entryTh}) en profil ${risk}.`;
  } else if(trueCount < boostTh){
    direction='SITUATION FAVORABLE'; dirKey='good';
    action='Entrée possible avec une mise contrôlée.';
    reason=`Le true count (+${trueCount}) dépasse ton seuil d'entrée (${entryTh}) en profil ${risk}.`;
  } else {
    direction='AVANTAGE FORT MAIS RISQUE À CONTRÔLER'; dirKey='strong';
    action='Augmentation de mise possible selon bankroll — variance toujours élevée.';
    reason=`Le true count (+${trueCount}) est très favorable (seuil d'augmentation ${boostTh} atteint en profil ${risk}).`;
    if(risk==='agressif') warnings.push('Mode agressif — la variance reste importante même avec un avantage fort.');
  }

  if((confidence.level === 'vlow' || confidence.level === 'low') && (dirKey==='good' || dirKey==='strong')){
    direction='JOUE PRUDEMMENT'; dirKey='watch';
    action='Confiance insuffisante pour confirmer un avantage fort — reste prudent.';
    reason += ' Cependant la confiance dans les données actuelles est faible : ' + confidence.reason;
  }

  return {
    direction, dirKey, action, riskLevel:risk, confidence: confidence.label,
    runningCount: running, trueCount,
    suggestedBet: bjSuggestBet(trueCount, risk).text,
    reason, warnings,
  };
}

// ── Stratégie de base — tables complètes ──────────────────────────────
const BJ_DEALER_COLS = ['2','3','4','5','6','7','8','9','10','A'];

const BJ_HARD_STRATEGY = {
  5:  ['H','H','H','H','H','H','H','H','H','H'],
  6:  ['H','H','H','H','H','H','H','H','H','H'],
  7:  ['H','H','H','H','H','H','H','H','H','H'],
  8:  ['H','H','H','H','H','H','H','H','H','H'],
  9:  ['H','D','D','D','D','H','H','H','H','H'],
  10: ['D','D','D','D','D','D','D','D','H','H'],
  11: ['D','D','D','D','D','D','D','D','D','D'],
  12: ['H','H','S','S','S','H','H','H','H','H'],
  13: ['S','S','S','S','S','H','H','H','H','H'],
  14: ['S','S','S','S','S','H','H','H','H','H'],
  15: ['S','S','S','S','S','H','H','H','H','H'],
  16: ['S','S','S','S','S','H','H','H','H','H'],
  17: ['S','S','S','S','S','S','S','S','S','S'],
  18: ['S','S','S','S','S','S','S','S','S','S'],
  19: ['S','S','S','S','S','S','S','S','S','S'],
  20: ['S','S','S','S','S','S','S','S','S','S'],
  21: ['S','S','S','S','S','S','S','S','S','S'],
};
const BJ_SOFT_STRATEGY = {
  13: ['H','H','H','D','D','H','H','H','H','H'],
  14: ['H','H','H','D','D','H','H','H','H','H'],
  15: ['H','H','D','D','D','H','H','H','H','H'],
  16: ['H','H','D','D','D','H','H','H','H','H'],
  17: ['H','D','D','D','D','H','H','H','H','H'],
  18: ['S','D','D','D','D','S','S','H','H','H'],
  19: ['S','S','S','S','S','S','S','S','S','S'],
  20: ['S','S','S','S','S','S','S','S','S','S'],
};
const BJ_PAIR_STRATEGY = {
  'A':  ['P','P','P','P','P','P','P','P','P','P'],
  '10': ['S','S','S','S','S','S','S','S','S','S'],
  '9':  ['P','P','P','P','P','S','P','P','S','S'],
  '8':  ['P','P','P','P','P','P','P','P','P','P'],
  '7':  ['P','P','P','P','P','P','H','H','H','H'],
  '6':  ['P','P','P','P','P','H','H','H','H','H'],
  '5':  ['D','D','D','D','D','D','D','D','H','H'],
  '4':  ['H','H','H','P','P','H','H','H','H','H'],
  '3':  ['P','P','P','P','P','P','H','H','H','H'],
  '2':  ['P','P','P','P','P','P','H','H','H','H'],
};

function bjHandTotal(cards){
  let total=0, aces=0;
  cards.forEach(c=>{
    total += BJ_CARD_BJVALUE[c] || 0;
    if(c==='A') aces++;
  });
  while(total>21 && aces>0){ total-=10; aces--; }
  const soft = aces>0 && total<=21;
  return { total, soft };
}

function getBasicStrategyAction(playerCards, dealerUpcard){
  const dCol = BJ_DEALER_COLS.indexOf(dealerUpcard);
  if(dCol<0) return null;
  if(playerCards.length===2 && playerCards[0]===playerCards[1]){
    const row = BJ_PAIR_STRATEGY[playerCards[0]];
    if(row) return { action: row[dCol], context:'pair', rank:playerCards[0] };
  }
  const { total, soft } = bjHandTotal(playerCards);
  if(soft && BJ_SOFT_STRATEGY[total]) return { action: BJ_SOFT_STRATEGY[total][dCol], context:'soft', total };
  const hardTotal = Math.min(Math.max(total,5),21);
  const row = BJ_HARD_STRATEGY[hardTotal];
  if(row) return { action: row[dCol], context:'hard', total };
  return null;
}

function bjEvaluateHand(){
  const c1 = document.getElementById('bj-hand-c1').value;
  const c2 = document.getElementById('bj-hand-c2').value;
  const dc = document.getElementById('bj-hand-dealer').value;
  const box = document.getElementById('bj-strategy-res');
  if(!c1||!c2||!dc){ toast('Sélectionne tes 2 cartes et la carte du croupier','err'); return; }
  const res = getBasicStrategyAction([c1,c2], dc);
  if(!res){ box.innerHTML = '<div class="warn">Combinaison non reconnue.</div>'; return; }
  const ACTION_LABELS = { H:'TIRER', S:'RESTER', D:'DOUBLER (sinon tirer)', P:'SPLITTER', R:'ABANDONNER (sinon tirer)' };
  const ACTION_CLASS  = { H:'bj-act-hit', S:'bj-act-stand', D:'bj-act-double', P:'bj-act-split', R:'bj-act-surrender' };
  const d = getBlackjackDecision(BJ_STATE);
  const tcNote = d.trueCount==null ? '' : ` Le true count actuel (${d.trueCount>=0?'+':''}${d.trueCount}) reste une information complémentaire, mais la stratégie de base prime pour cette main.`;
  box.innerHTML = `<div class="bj-strategy-result">
    <div class="bj-strategy-action ${ACTION_CLASS[res.action]||''}">${ACTION_LABELS[res.action]||res.action}</div>
    <div style="font-size:11px;color:var(--mu);line-height:1.6">Stratégie de base : ${ACTION_LABELS[res.action]||res.action}.${tcNote} Suis la stratégie de base sauf règle avancée explicitement paramétrée.</div>
  </div>`;
}

// ── Chat contextuel — ne devine jamais, s'appuie uniquement sur l'état ──
function bjFormatDecisionAnswer(d){
  return `Décision : ${d.direction}\nRaison : ${d.reason}\nNiveau de confiance : ${d.confidence}\nAction recommandée : ${d.action}`;
}

function answerBlackjackQuestion(question, state){
  state = state || BJ_STATE;
  if(!state) return 'Session non initialisée — commence par saisir des cartes.';
  const q = (question||'').toLowerCase();
  const d = getBlackjackDecision(state);
  const tcTxt = d.trueCount==null ? 'indisponible (decks inconnus)' : (d.trueCount>=0?'+':'')+d.trueCount;

  if(/quitt/.test(q)){
    if(d.dirKey==='avoid') return `Tu peux envisager de rester en mise minimale ou de quitter : ${d.reason}`;
    return `Rien n'indique qu'il faille quitter maintenant. ${d.reason}`;
  }
  if(/augment/.test(q)){
    if(d.dirKey==='good' || d.dirKey==='strong') return `Augmentation envisageable. ${d.reason} Mise suggérée : ${d.suggestedBet}.`;
    return `Non, ne pas augmenter pour l'instant. ${d.reason}`;
  }
  if(/attend/.test(q)){
    if(d.dirKey==='wait' || d.dirKey==='unknown' || d.dirKey==='avoid') return `Oui, attends. ${d.reason}`;
    return `Pas nécessairement. ${d.reason} Une entrée prudente est envisageable.`;
  }
  if(/risque/.test(q)){
    const riskTxt = d.dirKey==='strong'?'élevé (variance importante malgré l\'avantage)':d.dirKey==='avoid'?'défavorable':d.dirKey==='good'?'modéré':'faible à modéré';
    return `Niveau de risque actuel : ${riskTxt}. Profil choisi : ${d.riskLevel}. Confiance : ${d.confidence}.`;
  }
  if(/pourquoi/.test(q) || /explique/.test(q)){
    return `${bjFormatDecisionAnswer(d)}\nCartes vues : ${state.cardsSeen.length}. Running count : ${d.runningCount>=0?'+':''}${d.runningCount}. True count : ${tcTxt}.`;
  }
  if(/miser|combien|mise\b/.test(q)){
    if(!state.config.tableMin) return `Impossible de calculer un montant précis : la mise minimale de table n'est pas renseignée. Direction actuelle : ${d.direction} (${d.action})`;
    return `Mise suggérée : ${d.suggestedBet}. ${d.reason}`;
  }
  if(/count|comptage|sabot|favorable/.test(q)){
    return `Running count : ${d.runningCount>=0?'+':''}${d.runningCount}. True count : ${tcTxt}. ${d.reason}`;
  }
  if(/rentr|jouer|entre|joue\b/.test(q)){
    if(d.dirKey==='avoid') return `Non. ${d.reason} True count : ${tcTxt}. ${d.action}`;
    if(d.dirKey==='wait' || d.dirKey==='unknown') return `Pas encore. ${d.reason} True count : ${tcTxt}. ${d.action}`;
    return `Oui, entrée possible. ${d.reason} True count : ${tcTxt}, confiance ${d.confidence}. ${d.action}`;
  }
  return bjFormatDecisionAnswer(d);
}

function bjAppendChatMsg(role, text){
  const wrap = document.getElementById('bj-chat-wrap');
  if(!wrap) return;
  const div = document.createElement('div');
  div.className = 'msg '+role;
  const ico = role==='user' ? '👤' : '🃏';
  div.innerHTML = `<div class="msg-ico">${ico}</div><div><div class="msg-bub">${esc(text).replace(/\n/g,'<br>')}</div></div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}
function bjSendChat(){
  const input = document.getElementById('bj-chat-input');
  const q = input.value.trim();
  if(!q) return;
  bjAppendChatMsg('user', q);
  input.value='';
  const answer = answerBlackjackQuestion(q, BJ_STATE);
  setTimeout(()=>bjAppendChatMsg('bot', answer), 150);
}
function bjChatKey(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); bjSendChat(); } }
function bjAskQuestion(q){
  bjAppendChatMsg('user', q);
  const answer = answerBlackjackQuestion(q, BJ_STATE);
  setTimeout(()=>bjAppendChatMsg('bot', answer), 150);
  document.getElementById('bj-chat-wrap')?.scrollIntoView({behavior:'smooth', block:'nearest'});
}

// ── Reconnaissance audio FR/EN — Web Speech API ──────────────────────
const BJ_WORD_MAP = {
  'as':'A','ace':'A',
  'deux':'2','two':'2',
  'trois':'3','three':'3',
  'quatre':'4','four':'4',
  'cinq':'5','five':'5',
  'six':'6',
  'sept':'7','seven':'7',
  'huit':'8','eight':'8',
  'neuf':'9','nine':'9',
  'dix':'10','ten':'10',
  'valet':'J','jack':'J',
  'dame':'Q','reine':'Q','queen':'Q',
  'roi':'K','king':'K',
};
const BJ_SUIT_WORD_MAP = {
  'coeur':'hearts','cœur':'hearts','coeurs':'hearts','cœurs':'hearts','heart':'hearts','hearts':'hearts',
  'carreau':'diamonds','carreaux':'diamonds','diamond':'diamonds','diamonds':'diamonds','diamant':'diamonds','diamants':'diamonds',
  'trefle':'clubs','trèfle':'clubs','trefles':'clubs','trèfles':'clubs','club':'clubs','clubs':'clubs',
  'pique':'spades','piques':'spades','spade':'spades','spades':'spades',
};
const BJ_FILLER_WORDS = new Set(['de',"d'",'du','des','of','the','la','le','les','un','une','a','à']);

function bjNormalizeWord(w){
  w = (w||'').toLowerCase().trim().replace(/[.,!?]/g,'');
  w = w.replace(/^[a-zàâäéèêëïîôöùûüç]['’]/i, '');
  if(/^(10|[2-9])$/.test(w)) return w;
  return BJ_WORD_MAP[w] || null;
}

function parseAudioCardsWithSuit(transcript){
  const words = (transcript||'').toLowerCase()
    .replace(/dealer|croupier|carte|card/g,' ')
    .split(/[\s,;.!?]+/).filter(Boolean);
  const pairs = [];
  const unmatchedRanks = [];
  let i = 0;
  while(i < words.length){
    const rank = bjNormalizeWord(words[i]);
    if(!rank){ i++; continue; }
    let j = i+1;
    while(j < words.length && BJ_FILLER_WORDS.has(words[j])) j++;
    const suit = j < words.length ? BJ_SUIT_WORD_MAP[words[j]] : null;
    if(suit){ pairs.push({ rank, suit }); i = j+1; }
    else { unmatchedRanks.push(rank); i++; }
  }
  return { pairs, unmatchedRanks };
}

let BJ_RECOGNITION = null;
function bjToggleAudio(){
  if(!BJ_STATE) return;
  if(BJ_STATE.audio.enabled){ bjStopAudio(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ toast('Reconnaissance vocale non disponible sur ce navigateur.','err'); return; }
  BJ_RECOGNITION = new SR();
  BJ_RECOGNITION.lang = 'fr-FR';
  BJ_RECOGNITION.continuous = true;
  BJ_RECOGNITION.interimResults = false;
  BJ_RECOGNITION.maxAlternatives = 5;
  BJ_RECOGNITION.onresult = (e)=>{
    for(let i = e.resultIndex; i < e.results.length; i++){
      const result = e.results[i];
      if(!result.isFinal) continue;
      bjHandleAudioResult(result);
    }
  };
  BJ_RECOGNITION.onerror = (e)=>{
    const err = e && e.error;
    if(err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture'){
      toast('🎙 Micro indisponible ou accès refusé','err');
      bjStopAudio();
    }
  };
  BJ_RECOGNITION.onend = ()=>{ if(BJ_STATE.audio.enabled){ try{ BJ_RECOGNITION.start(); }catch(_){} } };
  try{ BJ_RECOGNITION.start(); }catch(_){ toast('Impossible de démarrer l\'écoute audio','err'); return; }
  BJ_STATE.audio.enabled = true;
  bjSaveState();
  bjRenderAudioStatus();
  const btn = document.getElementById('bj-audio-btn'); if(btn) btn.textContent = '⏹ Stop audio';
  toast('Écoute audio activée — reconnaissance instantanée, aucune validation requise','ok');
}
function bjStopAudio(){
  if(!BJ_STATE) return;
  BJ_STATE.audio.enabled = false;
  if(BJ_RECOGNITION){ try{ BJ_RECOGNITION.stop(); }catch(_){} }
  bjSaveState();
  bjRenderAudioStatus();
  const btn = document.getElementById('bj-audio-btn'); if(btn) btn.textContent = "🎙 Activer l'écoute audio";
}

function bjHandleAudioResult(result){
  let best = null;
  const nAlt = result && result.length ? result.length : 0;
  for(let a = 0; a < nAlt; a++){
    const alt = result[a];
    const transcript = alt && alt.transcript;
    if(!transcript) continue;
    const parsed = parseAudioCardsWithSuit(transcript);
    if(!best) best = parsed;
    if(parsed.pairs.length){ best = parsed; break; }
  }
  if(!best) return;
  const { pairs, unmatchedRanks } = best;
  if(!pairs.length && !unmatchedRanks.length) return;

  pairs.forEach(({rank,suit})=>{
    const key = bjCardKey(rank, suit);
    const wasSelected = !!(BJ_STATE.selectedCards && BJ_STATE.selectedCards[key]);
    bjOnCardClick(rank, suit, null);
    toast('🎙 '+rank+(BJ_SUIT_SYMBOL[suit]||'')+(wasSelected?' retirée':' ajoutée'), 'ok');
  });

  if(!pairs.length && unmatchedRanks.length){
    toast('🎙 Rang entendu mais couleur non précisée — dites par ex. "10 de cœur"','err');
  }
}

// ── Rendu UI ──────────────────────────────────────────────────────────
function bjRenderDirection(){
  const wrap = document.getElementById('bj-direction-wrap');
  if(!wrap || !BJ_STATE) return;
  const d = getBlackjackDecision(BJ_STATE);
  const dirClass = { unknown:'bj-dir-unknown', wait:'bj-dir-wait', avoid:'bj-dir-avoid', watch:'bj-dir-watch', good:'bj-dir-good', strong:'bj-dir-strong' }[d.dirKey] || 'bj-dir-unknown';
  wrap.innerHTML = `<div class="bj-direction ${dirClass}">
    <div class="bj-dir-label">${esc(d.direction)}</div>
    <div class="bj-dir-sub">${esc(d.action)}<br>${esc(d.reason)}</div>
  </div>`;
}

function bjRenderCounters(){
  const wrap = document.getElementById('bj-counters-wrap');
  if(!wrap || !BJ_STATE) return;
  const running = bjCalculateRunningCount();
  const { trueCount, decksRemaining, cardsRemaining } = bjCalculateTrueCount();
  const conf = bjEstimateConfidence();
  const confCls = { vlow:'bj-conf-vlow', low:'bj-conf-low', med:'bj-conf-med', high:'bj-conf-high' }[conf.level] || 'bj-conf-med';
  const tcTxt = trueCount==null ? '—' : (trueCount>=0?'+':'')+trueCount;
  wrap.innerHTML = `<div class="bj-counters">
    <div class="bj-counter-cell"><div class="bcv" style="color:${running>=0?'var(--gr)':'var(--re)'}">${running>=0?'+':''}${running}</div><label>Running Count</label></div>
    <div class="bj-counter-cell"><div class="bcv" style="color:var(--neon)">${tcTxt}</div><label>True Count</label></div>
    <div class="bj-counter-cell"><div class="bcv">${BJ_STATE.cardsSeen.length}</div><label>Cartes vues</label></div>
    <div class="bj-counter-cell"><div class="bj-conf-badge ${confCls}">${conf.label}</div><label style="margin-top:5px">Confiance</label></div>
  </div>
  <div style="font-size:10px;color:var(--dm);font-family:var(--mo);text-align:center;margin-bottom:10px">
    ${cardsRemaining!=null?`${cardsRemaining} cartes restantes · ${decksRemaining} deck(s) restant(s) estimé(s)`:'True count estimé indisponible — sabot inconnu'}
  </div>`;
}

function bjRenderIncoherence(){
  const wrap = document.getElementById('bj-incoherence-wrap');
  if(!wrap) return;
  const warns = bjCheckConsistency();
  wrap.innerHTML = warns.length ? warns.map(w=>`<div class="bj-incoherence">&#9888;&#65039; ${esc(w)}</div>`).join('') : '';
}

function bjRenderHistory(){
  const wrap = document.getElementById('bj-history-wrap');
  if(!wrap || !BJ_STATE) return;
  const cards = BJ_STATE.cardsSeen;
  if(!cards.length){ wrap.innerHTML = '<div class="bj-hist-empty">Aucune carte enregistrée.</div>'; }
  else {
    wrap.innerHTML = cards.map(c=>{
      const suitSym = BJ_SUIT_SYMBOL[c.suit] || '';
      const suitColorStyle = (c.suit==='hearts'||c.suit==='diamonds') ? 'color:#ef4444' : '';
      return `<span class="bj-hist-chip" title="Cliquer pour supprimer" onclick="bjRemoveCard('${c.id}')">${esc(c.card)}<span style="${suitColorStyle}">${suitSym}</span></span>`;
    }).join('');
  }
  const total = bjTotalCardsInShoe();
  const fillPct = total ? Math.min(100, Math.round(cards.length/total*100)) : 0;
  const fillEl = document.getElementById('bj-shoe-fill');
  if(fillEl) fillEl.style.width = fillPct+'%';

  const smallCards = cards.filter(c=>['2','3','4','5','6'].includes(c.card)).length;
  const bigCards = cards.filter(c=>['10','J','Q','K','A'].includes(c.card)).length;
  const statsEl = document.getElementById('bj-shoe-stats');
  if(statsEl){
    const pctSmall = cards.length ? Math.round(smallCards/cards.length*100) : 0;
    const pctBig = cards.length ? Math.round(bigCards/cards.length*100) : 0;
    statsEl.textContent = `${cards.length} carte(s) vue(s) · ${pctSmall}% petites cartes (2-6) · ${pctBig}% grosses cartes (10-A)`;
  }
}

function bjRenderAudioStatus(){
  const dot = document.getElementById('bj-audio-dot');
  const txt = document.getElementById('bj-audio-status-txt');
  if(!BJ_STATE) return;
  if(dot) dot.classList.toggle('on', !!BJ_STATE.audio.enabled);
  if(txt) txt.textContent = BJ_STATE.audio.enabled ? 'Écoute active…' : 'Écoute désactivée';
}

function bjRenderSessionBanner(){
  const wrap = document.getElementById('bj-session-banner-wrap');
  if(!wrap) return;
  if(BJ_PENDING_RESUME){
    wrap.innerHTML = `<div class="bj-session-banner">
      <span style="font-size:12px;color:var(--pu)">&#128190; Une session précédente (${BJ_PENDING_RESUME.cardsSeen.length} carte(s)) a été trouvée.</span>
      <button class="btn bp" onclick="bjResumeSession()">Reprendre</button>
    </div>`;
  } else { wrap.innerHTML=''; }
}

function bjRenderAll(){
  if(!BJ_STATE) return;
  bjRenderSessionBanner();
  bjRenderDirection();
  bjRenderCounters();
  bjRenderIncoherence();
  bjRenderHistory();
  bjRenderAudioStatus();
  bjSyncCardButtonStates();
}

// ── Configuration ─────────────────────────────────────────────────────
function bjOnDecksChange(newVal){
  if(!BJ_STATE) return;
  if(BJ_STATE.cardsSeen.length > 0 && newVal !== BJ_STATE.config.decks){
    BJ_PENDING_DECK_CHANGE = newVal;
    const wrap = document.getElementById('bj-deck-confirm-wrap');
    if(wrap) wrap.innerHTML = `<div class="bj-deck-confirm">
      &#9888;&#65039; Changer le nombre de decks en cours de session peut fausser le comptage (${BJ_STATE.cardsSeen.length} carte(s) déjà enregistrée(s)).
      <div class="bg" style="margin-top:8px">
        <button class="btn bp" onclick="bjConfirmDeckChange()">Confirmer le changement</button>
        <button class="btn bs" onclick="bjCancelDeckChange()">Annuler</button>
      </div>
    </div>`;
  } else {
    BJ_STATE.config.decks = newVal;
    bjUpdateConfig();
  }
}
function bjConfirmDeckChange(){
  BJ_STATE.config.decks = BJ_PENDING_DECK_CHANGE;
  BJ_PENDING_DECK_CHANGE = null;
  const wrap = document.getElementById('bj-deck-confirm-wrap');
  if(wrap) wrap.innerHTML='';
  bjUpdateConfig();
}
function bjCancelDeckChange(){
  const el = document.getElementById('bj-cfg-decks');
  if(el) el.value = BJ_STATE.config.decks;
  BJ_PENDING_DECK_CHANGE = null;
  const wrap = document.getElementById('bj-deck-confirm-wrap');
  if(wrap) wrap.innerHTML='';
}

function bjUpdateConfig(){
  if(!BJ_STATE) return;
  const $ = id=>document.getElementById(id);
  if($('bj-cfg-type'))     BJ_STATE.config.gameType = $('bj-cfg-type').value;
  if($('bj-cfg-tablemin')) BJ_STATE.config.tableMin = $('bj-cfg-tablemin').value ? parseFloat($('bj-cfg-tablemin').value) : null;
  if($('bj-cfg-bankroll')) BJ_STATE.config.bankroll = $('bj-cfg-bankroll').value ? parseFloat($('bj-cfg-bankroll').value) : null;
  if($('bj-cfg-strategy')) BJ_STATE.config.strategy = $('bj-cfg-strategy').value;
  bjSaveState();
  bjRenderAll();
}

function bjSelectRisk(risk, silent){
  if(!BJ_STATE) return;
  BJ_STATE.config.risk = risk;
  ['prudent','standard','agressif'].forEach(r=>document.getElementById('bj-risk-'+r)?.classList.remove('sel'));
  document.getElementById('bj-risk-'+risk)?.classList.add('sel');
  if(!silent){ bjSaveState(); bjRenderAll(); }
}

// ── Alias de compatibilité ─────────────────────────────────────────────
function addCard(card){ bjAddCard(card); }
function removeCard(cardId){ bjRemoveCard(cardId); }
function undoLastCard(){ bjUndo(); }
function redoCard(){ bjRedo(); }
function resetShoe(){ bjResetShoe(); }
function calculateRunningCount(){ return bjCalculateRunningCount(); }
function calculateTrueCount(){ return bjCalculateTrueCount().trueCount; }
function estimateConfidence(){ return bjEstimateConfidence(); }
function suggestBet(){ const tc = bjCalculateTrueCount().trueCount; return bjSuggestBet(tc, BJ_STATE ? BJ_STATE.config.risk : 'prudent'); }

// ═══════════════════════════════════════════════════════════════════════
//  PGI • BetPro — HKJC HONG KONG (frontend)
// ═══════════════════════════════════════════════════════════════════════
let hkjcTrack='ST',hkjcMarket='PLACE',hkjcTimer=null,hkjcLoaded=false;
let hkjcSelectedDate='',hkjcInFlight=false,hkjcPendingReload=false,hkjcLastRefresh=0,hkjcRetryAfter=0;
// Affichage par défaut sur la date de Paris : à 17h en France, Hong Kong est
// déjà au lendemain. L'utilisateur garde accès à la réunion du jour français.
function hkjcParisDate(){
  try {
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
    return p.year+'-'+p.month+'-'+p.day;
  } catch(_) { return new Date().toISOString().slice(0,10); }
}
function hkjcHongKongDate(){
  try {
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
    return p.year+'-'+p.month+'-'+p.day;
  } catch(_) { return new Date().toISOString().slice(0,10); }
}
function hkjcDefaultMeetingDate(){
  const today=hkjcParisDate(),base=new Date(today+'T12:00:00Z');
  // Réunions HKJC régulières le mercredi et le dimanche. En l'absence
  // de réunion aujourd'hui, proposer la prochaine date probable au lieu
  // d'afficher automatiquement une journée sans courses.
  for(let offset=0;offset<7;offset++){
    const d=new Date(base.getTime()+offset*86400000),weekday=d.getUTCDay();
    if(weekday===0||weekday===3)return d.toISOString().slice(0,10);
  }
  return today;
}
function hkjcInitDate(){
  if(!hkjcSelectedDate)hkjcSelectedDate=hkjcDefaultMeetingDate();
  const input=document.getElementById('hkjc-date-filter');
  if(input&&input.value!==hkjcSelectedDate)input.value=hkjcSelectedDate;
  return hkjcSelectedDate;
}
function hkjcSetDate(v){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(v||'')))return;
  hkjcSelectedDate=v;hkjcRetryAfter=0;hkjcLoad();
}
function hkjcOfficialLinks(date=hkjcInitDate()){
  const dateArg=encodeURIComponent(date.replace(/-/g,'/'));
  const track=(hkjcTrack==='HV'?'HV':'ST');
  const official='https://racing.hkjc.com/en-us/local/information/';
  const entries=official+'entries?racedate='+dateArg+'&Racecourse='+track;
  const results=official+'localresults?racedate='+dateArg+'&Racecourse='+track;
  return '<div style="font-size:10px;color:var(--dm);margin:9px 0;line-height:1.7">'
    +'Réunion consultée : <strong>'+esc(date)+'</strong> · '+'<a href="'+entries+'" target="_blank" rel="noopener noreferrer" style="text-decoration:underline">Programme officiel HKJC</a>'
    +' · <a href="'+results+'" target="_blank" rel="noopener noreferrer" style="text-decoration:underline">Résultats officiels</a>'
    +'</div>';
}
function hkjcPct(v){if(v==null||v==='')return'—';const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1}).format(n*100)+' %':'—';}
function hkjcNum(v,d=2){if(v==null||v==='')return'—';const n=Number(v),digits=Math.max(0,Math.min(6,Number(d)||0));return Number.isFinite(n)?new Intl.NumberFormat('fr-FR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n):'—';}
function hkjcDateTime(v){if(!v)return'—';try{return new Date(v).toLocaleString('fr-FR',{timeZone:'Asia/Hong_Kong',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' HK';}catch(_){return esc(v);}}
function hkjcSetTrack(track,btn){hkjcTrack=track;document.querySelectorAll('#hkjc-track-buttons .fbtn').forEach(x=>x.classList.remove('on'));btn?.classList.add('on');hkjcRetryAfter=0;hkjcLoad();}
function hkjcSetMarket(market,btn){hkjcMarket=market;document.querySelectorAll('#hkjc-market-buttons .fbtn').forEach(x=>x.classList.remove('on'));btn?.classList.add('on');hkjcRetryAfter=0;hkjcLoad();}
async function hkjcInit(){
  hkjcInitDate();
  if(!hkjcLoaded){hkjcLoaded=true;await hkjcLoad();}
  hkjcStopAutoRefresh();
  hkjcTimer=setInterval(()=>{
    if(document.hidden||!document.getElementById('s-hkjc')?.classList.contains('on'))return;
    if(Date.now()<hkjcRetryAfter||hkjcInFlight||Date.now()-hkjcLastRefresh<300000)return;
    hkjcLoad(true);
  },60000);
}
function hkjcStopAutoRefresh(){if(hkjcTimer){clearInterval(hkjcTimer);hkjcTimer=null;}}
function hkjcResponse(result){
  if(result.status!=='fulfilled')throw result.reason||new Error('Réponse non reçue');
  const d=result.value;
  if(!d||d.ok===false)throw new Error(d?.error||'Source HKJC temporairement indisponible');
  return d;
}
function hkjcErrorMessage(e){
  const m=String(e?.message||e||'Erreur inconnue');
  if(/exceeded D1|row read limit|rows read|D1.*quota|quota.*D1/i.test(m))return 'Quota de lecture Cloudflare D1 épuisé. Les courses ne sont pas absentes : leur consultation dans BetPro est temporairement bloquée.';
  return m;
}
async function hkjcLoad(silent=false){
  if(hkjcInFlight){hkjcPendingReload=true;return;}
  hkjcInFlight=true;hkjcLastRefresh=Date.now();
  const statusEl=document.getElementById('hkjc-status'),racesEl=document.getElementById('hkjc-races'),cardsEl=document.getElementById('hkjc-cards'),verdictEl=document.getElementById('hkjc-verdict');
  if(!statusEl||!racesEl||!cardsEl){hkjcInFlight=false;return;}
  const date=hkjcInitDate(),links=hkjcOfficialLinks(date);
  if(!silent){racesEl.innerHTML='<div class="ls"><div class="sp"></div><p>Chargement de la réunion du '+esc(date)+'…</p></div>';cardsEl.innerHTML='<div class="ls"><div class="sp"></div><p>Chargement des probabilités '+esc(hkjcMarket)+'…</p></div>';}
  try {
    if(hkjcTrack==='CH'){
      statusEl.innerHTML='<div class="info">Conghua est suivi pour les entraînements. Aucune réunion publique locale n’est garantie pour cette piste sans flux agréé.</div>';
      racesEl.innerHTML=links+'<div class="info">Sélectionne Sha Tin ou Happy Valley pour les réunions HKJC locales.</div>';
      cardsEl.innerHTML='<div class="info">Prédictions non disponibles pour la piste d’entraînement Conghua.</div>';
      verdictEl.textContent='Aucune réunion publique locale confirmée pour Conghua.';
      return;
    }
    // Un service peut échouer sans masquer les réponses valides des autres.
    const [rs,rr,rp]=await Promise.allSettled([
      api('/api/hkjc/status'),
      api('/api/hkjc/races?date='+enc(date)+'&track='+enc(hkjcTrack)),
      api('/api/hkjc/predictions?date='+enc(date)+'&track='+enc(hkjcTrack)+'&market='+enc(hkjcMarket))
    ]);
    let hadErrors=false,quotaError=false;
    try{
      const status=hkjcResponse(rs),c=status.counts||{},active=Number(c.active_models||0);
      const display=(key)=>c[key]==null?'Indisponible':Number(c[key]).toLocaleString('fr-FR');
      statusEl.innerHTML='<div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">'
       +'<span class="bdg '+(active?'bgr':'bgo')+'">Modèles actifs : '+display('active_models')+'</span>'
       +'<span class="bdg bsp">Réunions enregistrées : '+display('meetings')+'</span>'
       +'<span class="bdg bsp">Courses enregistrées : '+display('races')+'</span>'
       +'<span class="bdg bsp">Cotes enregistrées : '+display('odds_snapshots')+'</span>'
       +'<span class="bdg bsp">Résultats enregistrés : '+display('results')+'</span></div>';
    }catch(e){hadErrors=true;const msg=hkjcErrorMessage(e);quotaError=quotaError||msg.includes('Quota de lecture');statusEl.innerHTML='<div class="warn">État des collectes non vérifiable : '+esc(msg)+'</div>';}
    try{
      const races=hkjcResponse(rr);
      racesEl.innerHTML=links;
      if(Array.isArray(races.races)&&races.races.length){
        const raceResults=document.createElement('div');racesEl.appendChild(raceResults);hkjcRenderRaces(races.races,raceResults);
      }else{
        racesEl.innerHTML+= '<div class="info">Aucune course enregistrée dans BetPro pour cette date et cette piste. Vérifie le programme officiel avant de conclure à l’absence de réunion.</div>';
      }
    }catch(e){hadErrors=true;const msg=hkjcErrorMessage(e);quotaError=quotaError||msg.includes('Quota de lecture');racesEl.innerHTML=links+'<div class="warn">Données de réunion non accessibles : '+esc(msg)+'</div>';}
    try{
      const pred=hkjcResponse(rp);
      verdictEl.className=pred.bets?.length?'info':'warn';
      verdictEl.textContent=pred.verdict||'Aucune sélection fiable actuellement.';
      hkjcRenderCards(pred.cards||[],cardsEl);
    }catch(e){hadErrors=true;const msg=hkjcErrorMessage(e);quotaError=quotaError||msg.includes('Quota de lecture');verdictEl.className='warn';verdictEl.textContent='Prédictions non disponibles : '+msg;cardsEl.innerHTML='<div class="warn">Aucune probabilité ne peut être certifiée pour cette réunion tant que les données manquent.</div>';}
    if(hadErrors)hkjcRetryAfter=Date.now()+(quotaError?1800000:600000);
    else hkjcRetryAfter=0;
  }catch(e){
    hkjcRetryAfter=Date.now()+600000;
    const msg=esc(hkjcErrorMessage(e));
    statusEl.innerHTML='<div class="warn">Diagnostic HKJC momentanément inaccessible : '+msg+'</div>';
    racesEl.innerHTML=links+'<div class="warn">Données non accessibles : '+msg+'</div>';
    cardsEl.innerHTML='<div class="warn">Aucune prédiction confirmée.</div>';
  }finally{hkjcInFlight=false;if(hkjcPendingReload){hkjcPendingReload=false;hkjcLoad();}}
}
function hkjcRenderRaces(races,el){
  if(!races.length){el.innerHTML='<div class="empty"><div class="empty-i">🐎</div><div class="empty-t">Aucune réunion '+esc(hkjcTrack)+' chargée pour aujourd’hui</div><div style="font-size:10px;color:var(--dm);margin-top:5px">La collecte incrémentale conservera les prochaines réunions disponibles.</div></div>';return;}
  el.innerHTML=races.map(r=>'<div class="live-card" onclick="hkjcShowRace(\''+esc(r.race_id)+'\')" style="cursor:pointer"><div class="lc-head"><div style="flex:1"><div class="lc-teams">'+esc(r.racecourse_name||r.racecourse_code)+' — Course '+esc(r.race_number)+'</div><div class="lc-meta"><span class="bdg bsp">'+hkjcDateTime(r.race_time)+'</span><span class="bdg">'+esc(r.surface||'surface inconnue')+'</span><span class="bdg">'+esc(r.distance||'—')+' m</span><span class="bdg bgo">'+Number(r.field_size||0)+' partants · '+Number(r.paid_places||0)+' places</span></div><div style="font-size:9px;color:var(--dm);margin-top:5px">'+esc(r.going||'going non disponible')+' · '+esc(r.class||'classe non disponible')+'</div></div></div></div>').join('');
}
async function hkjcShowRace(raceId){try{const d=await api('/api/hkjc/race?race_id='+enc(raceId));if(!d.ok)throw new Error(d.error||'Course introuvable');const list=(d.runners||[]).map(h=>'n°'+esc(h.horse_number)+' '+esc(h.horse_name)+' · corde '+esc(h.draw??'—')+' · '+esc(h.jockey_name||'jockey inconnu')).join('\n');alert((d.race.racecourse_name||d.race.racecourse_code)+' — Course '+d.race.race_number+'\n'+d.race.field_size+' partants, '+d.race.paid_places+' places rémunérées\n\n'+list);}catch(e){toast('HKJC : '+e.message,'err');}}
function hkjcMetric(label,value){return'<div style="background:var(--bg2);border:1px solid var(--bd);padding:8px;border-radius:6px"><div style="font-size:8px;color:var(--dm);text-transform:uppercase">'+label+'</div><div style="font-family:var(--mo);font-weight:700;margin-top:3px">'+value+'</div></div>';}
function hkjcRenderCards(cards,el){
  if(!cards.length){el.innerHTML='<div class="empty"><div class="empty-i">🧠</div><div class="empty-t">Aucune prédiction HKJC exploitable actuellement</div><div style="font-size:10px;color:var(--dm);margin-top:5px">Le moteur attend des partants, des règles de places, des cotes et une calibration suffisante.</div></div>';return;}
  el.innerHTML=cards.map(c=>{const bet=c.decision==='BET',strong=pgiIsStrongHkjcSignal(c),globalConfidence=pgiHkjcGlobalConfidence(c),value=bet?'AVANTAGE RENTABLE VALIDÉ':Number(c.edge)>0?'AVANTAGE TROP FAIBLE':'AUCUN AVANTAGE',color=bet?'var(--gr)':Number(c.edge)>0?'var(--go)':'var(--re)',label=c.market==='WIN'?'PROBABILITÉ GAGNANT':'PROBABILITÉ PLACÉ';let reasons=[];try{reasons=JSON.parse(c.reasons||'[]');}catch(_){}
    return '<div class="card'+(strong?' pgi-signal-tres-fort':'')+'" style="border-left:3px solid '+color+';margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><div class="ct" style="margin:0;border:0;padding:0">'+esc(c.racecourse_code)+' R'+esc(c.race_number)+' · n°'+esc(c.horse_number)+' '+esc(c.horse_name)+'</div><div style="font-size:10px;color:var(--dm);margin-top:4px">'+hkjcDateTime(c.race_time)+' · '+Number(c.field_size||0)+' partants · '+Number(c.paid_places||0)+' places rémunérées</div></div><span class="bdg" style="background:'+color+'22;color:'+color+'">'+(bet?'À JOUER':'NE PAS JOUER')+'</span></div><div class="fg" style="grid-template-columns:repeat(4,minmax(110px,1fr));margin-top:12px">'+hkjcMetric('Cote',hkjcNum(c.odds,2))+hkjcMetric('Probabilité modèle',hkjcPct(c.model_probability))+hkjcMetric('Probabilité marché',hkjcPct(c.market_probability))+hkjcMetric(label,hkjcPct(c.calibrated_probability))+hkjcMetric('Cote juste',hkjcNum(c.fair_odds,2))+hkjcMetric('Avantage sur le marché',hkjcPct(c.edge))+hkjcMetric('Valeur attendue',hkjcPct(c.expected_value))+hkjcMetric('Niveau de confiance',esc(pgiConfidenceFr(c.confidence)))+'</div><div style="margin-top:10px"><span class="bdg" style="background:'+color+'22;color:'+color+'">'+value+'</span><span style="margin-left:7px">'+pgiGlobalConfidenceBadge(globalConfidence)+'</span><span style="font-size:9px;color:var(--dm);margin-left:7px">Qualité des données '+hkjcPct(c.data_quality_score)+'</span></div>'+(reasons.length?'<div style="font-size:9px;color:var(--dm);margin-top:7px">Motifs de prudence : '+reasons.map(esc).join(' · ')+'</div>':'')+'<div style="font-size:9px;color:var(--dm);margin-top:5px">'+esc(c.place_rules||'')+'</div></div>';
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════
//  PGI • BetPro — MODULE PMU / TURF FRANCE (frontend)
//  Entièrement séparé du système sport et du blackjack. Toutes les
//  fonctions sont préfixées "turf". Rattrapage PMU intelligent : scanne
//  les courses à venir et propose la meilleure carte selon le type de
//  pari choisi (placé/gagnant/quinté), via /api/turf/recovery/scan.
// ═══════════════════════════════════════════════════════════════════════

let TURF_SELECTED_RACE = null;
let TURF_UPCOMING_CACHE = [];
let turfRecoveryType = 'simple_place';
let TURF_REFRESH_INTERVAL = null;
const TURF_REFRESH_MS = 30000; // cadence de contrôle légère ; appels réseau adaptatifs, uniquement onglet actif
let TURF_LAST_AUTO_REFRESH = 0, TURF_REFRESH_RUNNING = false;

async function turfInit() {
  await turfLoadSources();
  await turfLoadUpcoming();
  turfLoadHistory();
  TURF_LAST_AUTO_REFRESH=Date.now();
  turfStartAutoRefresh();
}

// ── Auto-actualisation temps réel ──────────────────────────────────────
// Tant que la section PMU reste affichée : la liste des courses à venir
// et, si une course est sélectionnée, ses cotes sont rechargées en continu
// (sans jamais réinitialiser le panneau d'analyse déjà affiché). L'intervalle
// s'arrête automatiquement dès qu'on quitte l'onglet PMU pour ne jamais
// tourner inutilement en arrière-plan.
function turfStartAutoRefresh() {
  if (TURF_REFRESH_INTERVAL) clearInterval(TURF_REFRESH_INTERVAL);
  TURF_REFRESH_INTERVAL = setInterval(turfAutoRefreshTick, TURF_REFRESH_MS);
}
function turfStopAutoRefresh() {
  if (TURF_REFRESH_INTERVAL) { clearInterval(TURF_REFRESH_INTERVAL); TURF_REFRESH_INTERVAL = null; }
}
async function turfAutoRefreshTick() {
  const sectionOn = document.getElementById('s-turf')?.classList.contains('on');
  if (!sectionOn) { turfStopAutoRefresh(); return; }
  if (document.hidden || TURF_REFRESH_RUNNING) return;
  // Une course consultée garde des cotes actualisées à la minute.
  // Sans sélection, trois minutes suffisent pour actualiser les programmes.
  const minimumInterval = TURF_SELECTED_RACE ? 60000 : 180000;
  const now = Date.now();
  if (now - TURF_LAST_AUTO_REFRESH < minimumInterval) return;
  TURF_LAST_AUTO_REFRESH = now;
  TURF_REFRESH_RUNNING = true;
  try {
    await turfLoadUpcoming(true);
    if (TURF_SELECTED_RACE) await turfRefreshRaceOdds();
  } finally {
    TURF_REFRESH_RUNNING = false;
  }
}

async function turfLoadSources() {
  const el = document.getElementById('turf-sources-status');
  if (!el) return;
  try {
    const d = await api('/api/turf/sources');
    const active = d.sources.find(s => s.id === d.active_source);
    const srcCount = active?.sources_configured ? ` (${active.sources_configured} source(s) en rotation)` : '';
    el.innerHTML = `<div style="display:flex;align-items:center;gap:6px;font-size:10px;font-family:var(--mo)">
      <div style="width:7px;height:7px;border-radius:50%;background:${active?.status==='disponible'?'var(--gr)':'var(--re)'}"></div>
      <span>Source active : ${esc(active?.label||d.active_source)}${srcCount} — secours : ${esc(d.fallback_source)}</span>
    </div>`;
  } catch (e) {
    el.innerHTML = `<div style="font-size:10px;color:var(--re)">Sources indisponibles : ${esc(e.message)}</div>`;
  }
}

// ── Bloc 1 — Courses à venir ──────────────────────────────────────────
let turfDateFilter = 'today';
function turfSetDateFilter(val, el) {
  turfDateFilter = val;
  document.querySelectorAll('#turf-date-btns .fbtn').forEach(b => b.classList.remove('on'));
  el?.classList.add('on');
  turfLoadUpcoming();
}

let turfDisciplineFilter = 'all', turfQuinteOnly = false;
function turfSetDisciplineFilter(val, el) {
  turfDisciplineFilter = val;
  document.querySelectorAll('#turf-discipline-btns .fbtn').forEach(b => { if(b.id!=='turf-quinte-toggle') b.classList.remove('on'); });
  el?.classList.add('on');
  turfLoadUpcoming();
}
function turfToggleQuinteOnly(el) {
  turfQuinteOnly = !turfQuinteOnly;
  el?.classList.toggle('on', turfQuinteOnly);
  turfLoadUpcoming();
}
function turfApplyRaceFilters(races) {
  return races.filter(r => {
    if (turfDisciplineFilter !== 'all' && r.discipline !== turfDisciplineFilter) return false;
    if (turfQuinteOnly && !r.is_quinte) return false;
    return true;
  });
}

async function turfLoadUpcoming(silent) {
  const cnt = document.getElementById('turf-races-list');
  if (!cnt) return;
  if (!silent) cnt.innerHTML = '<div class="ls"><div class="sp"></div><p>Chargement des courses PMU…</p></div>';
  try {
    const d = await api('/api/turf/upcoming?date_filter=' + enc(turfDateFilter) + '&_t=' + Date.now());
    TURF_UPCOMING_CACHE = d.races || [];
    if (!TURF_UPCOMING_CACHE.length) {
      const diag = d.diagnostic || {};
      cnt.innerHTML = `<div class="empty"><div class="empty-i">🐎</div><div class="empty-t">Aucune course PMU trouvée</div>
        <div class="empty-s">${esc(diag.raison_si_vide || 'Aucune donnée disponible pour cette période.')}</div></div>`;
      return;
    }
    const filtered = turfApplyRaceFilters(TURF_UPCOMING_CACHE);
    if (!filtered.length) {
      cnt.innerHTML = `<div class="empty"><div class="empty-i">🐎</div><div class="empty-t">Aucune course ne correspond à ces filtres</div></div>`;
      return;
    }
    cnt.innerHTML = `<div class="sbar"><div class="live-dot"></div><span><strong>${filtered.length}</strong> course(s) — source: ${esc((d.sources_used||[]).join(', ')||'—')}</span><span style="margin-left:auto;font-size:9px;color:var(--dm);font-family:var(--mo)">&#128260; Actualisation auto · ${new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span></div>`
      + filtered.map(r => turfRenderRaceCard(r)).join('');
  } catch (e) {
    if (!silent) cnt.innerHTML = `<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ ${esc(e.message)}</div></div>`;
  }
}

function turfRenderRaceCard(r) {
  const discIco = { trot: '🐴', plat: '🏇', obstacle: '🚧' }[r.discipline] || '🐎';
  return `<div class="dir-card" style="border:1px solid var(--bd);cursor:pointer" onclick="turfSelectRace('${esc(r.race_id)}')">
    <div class="dir-body" style="padding:10px 14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="dir-match">${discIco} ${esc(r.hippodrome)} — ${esc(r.reunion)}${esc(r.race_number)}</div>
        ${r.is_quinte ? '<span class="bdg bca">QUINTÉ+</span>' : ''}
      </div>
      <div style="font-size:11px;color:var(--mu);margin-top:2px">${esc(r.race_name||'')}</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
        <span class="bdg bsr">${r.time||'?'}</span>
        <span class="bdg bsp">${esc(r.discipline)}</span>
        ${r.distance?`<span class="bdg bsr">${r.distance}m</span>`:''}
        ${r.runners_count?`<span class="bdg bmk">${r.runners_count} partants</span>`:''}
        <span class="bdg" style="background:rgba(78,106,138,.15);color:var(--mu)">Qualité des données : ${r.data_quality_score}%</span>
      </div>
    </div>
  </div>`;
}

// ── Bloc 2/3 — Sélection d'une course + partants ──────────────────────
async function turfSelectRace(raceId) {
  TURF_SELECTED_RACE = raceId;
  const detailEl = document.getElementById('turf-race-detail');
  if (!detailEl) return;
  detailEl.innerHTML = '<div class="ls"><div class="sp"></div><p>Chargement de la course…</p></div>';
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const d = await api('/api/turf/race?race_id=' + enc(raceId));
    if (!d.ok) { detailEl.innerHTML = `<div class="warn">⚠ ${esc(d.error||'Course indisponible')}</div>`; return; }
    turfRenderRaceDetail(d);
    turfAppendChatMsg('bot', `Course sélectionnée : ${d.hippodrome} — ${d.race_name||''}. Pose-moi une question (ex: "gagnant ?", "placé ?", "je joue le 8 ?").`);
  } catch (e) {
    detailEl.innerHTML = `<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ ${esc(e.message)}</div></div>`;
  }
}

function turfRenderRaceDetail(d) {
  const el = document.getElementById('turf-race-detail');
  const activeRunners=(d.runners||[]).filter(r=>!r.is_non_partant).length;
  const nonRunners=(d.runners||[]).filter(r=>r.is_non_partant).length;
  const paidPlaces=activeRunners>=8?3:(activeRunners>=4?2:1);
  const runnersHtml = (d.runners||[]).map(r => `
    <tr data-runner-num="${esc(String(r.number))}"${r.is_non_partant?' style="opacity:.4"':''}>
      <td style="font-family:var(--mo);font-weight:700">${r.number}</td>
      <td>${esc(r.name)}${r.is_non_partant?' <span class="bdg" style="background:var(--reb);color:var(--re)">NP</span>':''}</td>
      <td style="font-size:10px">${esc(r.jockey_driver||'—')}</td>
      <td style="font-size:10px">${esc(r.trainer||'—')}</td>
      <td style="font-size:10px;font-family:var(--mo)">${esc(r.music||'—')}</td>
      <td class="turf-odds-cell" style="font-family:var(--mo);color:var(--am)">${r.odds!=null?r.odds:'—'}</td>
    </tr>`).join('');

  el.innerHTML = `<div class="card">
    <div class="ct" style="display:flex;align-items:center;gap:8px">
      <span>${esc(d.hippodrome)} — ${esc(d.race_name||'')}</span>
      <span class="live-dot" style="margin-left:auto"></span>
      <span id="turf-odds-updated" style="font-size:9px;color:var(--dm);font-family:var(--mo);font-weight:400;text-transform:none;letter-spacing:0">cotes en direct</span>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <span class="bdg bsp">${esc(d.discipline)}</span>
      ${d.distance?`<span class="bdg bsr">${d.distance}m</span>`:''}
      ${d.corde?`<span class="bdg bsr">Corde ${esc(d.corde)}</span>`:''}
      ${d.terrain?`<span class="bdg bsr">Terrain ${esc(d.terrain)}</span>`:''}
      ${d.is_quinte?'<span class="bdg bca">QUINTÉ+</span>':''}
      <span class="bdg bmk">${activeRunners} partants actifs</span>
      ${nonRunners?`<span class="bdg" style="background:var(--reb);color:var(--re)">${nonRunners} non-partant(s)</span>`:''}
      <span class="bdg bsr">${paidPlaces} place(s) payée(s)</span>
      <span class="bdg" style="background:rgba(78,106,138,.15);color:var(--mu)">Qualité des données : ${d.data_quality_score}%</span>
    </div>
    <div style="overflow-x:auto">
      <table class="tracker-table" id="turf-runners-table"><thead><tr><th>N°</th><th>Cheval</th><th>Jockey/Driver</th><th>Entraîneur</th><th>Musique</th><th>Cote</th></tr></thead>
      <tbody>${runnersHtml}</tbody></table>
    </div>
  </div>
  <div class="card">
    <div class="ct">Boutons rapides</div>
    <div class="bg" style="flex-wrap:wrap">
      <button class="btn bp" onclick="turfAskQuick('should_play')">Dois-je jouer cette course ?</button>
      <button class="btn bs" onclick="turfAskQuick('winner')">Cheval gagnant</button>
      <button class="btn bs" onclick="turfAskQuick('place')">Cheval placé</button>
      <button class="btn bs" onclick="turfAskQuick('quinte_order')">Quinté ordre</button>
      <button class="btn bs" onclick="turfAskQuick('quinte_desordre')">Quinté désordre</button>
      <button class="btn bs" onclick="turfAskQuick('quinte_speculative')">Quinté spéculatif</button>
      <button class="btn bs" onclick="turfAskQuick('outsider')">Outsider value</button>
      <button class="btn bs" onclick="turfAskQuick('avoid')">Favori à éviter</button>
    </div>
  </div>
  <div id="turf-analysis-result"></div>`;
}

// ── Rafraîchissement des cotes uniquement (temps réel) ─────────────────
// Appelée en continu tant qu'une course reste sélectionnée : recharge les
// cotes depuis la source PMU et met à jour uniquement les cellules
// concernées dans le tableau déjà affiché — ne touche jamais au panneau
// d'analyse (#turf-analysis-result) ni au chat, pour ne pas effacer ce que
// l'utilisateur est en train de lire.
async function turfRefreshRaceOdds() {
  if (!TURF_SELECTED_RACE) return;
  try {
    const d = await api('/api/turf/race?race_id=' + enc(TURF_SELECTED_RACE) + '&_t=' + Date.now());
    if (!d.ok) return; // échec silencieux — l'affichage existant reste inchangé plutôt que de casser la page
    (d.runners||[]).forEach(r => {
      const row = document.querySelector(`#turf-runners-table tr[data-runner-num="${CSS.escape(String(r.number))}"]`);
      if (!row) return;
      const oddsCell = row.querySelector('.turf-odds-cell');
      if (oddsCell) oddsCell.textContent = r.odds != null ? r.odds : '—';
    });
    const updatedEl = document.getElementById('turf-odds-updated');
    if (updatedEl) updatedEl.textContent = 'cotes actualisées à ' + new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  } catch (_) { /* échec silencieux — nouvelle tentative au prochain tick */ }
}

// ── Bloc 4/5 — Boutons rapides + affichage de l'analyse ───────────────
async function turfAskQuick(questionType) {
  if (!TURF_SELECTED_RACE) { toast('Sélectionnez d\'abord une course', 'err'); return; }
  const resEl = document.getElementById('turf-analysis-result');
  if (resEl) resEl.innerHTML = '<div class="ls"><div class="sp"></div><p>Analyse en cours…</p></div>';
  try {
    const d = await api('/api/turf/ask', 'POST', {
      race_id: TURF_SELECTED_RACE, question_type: questionType,
      bankroll: turfGetBankroll(), risk_profile: 'prudent',
    });
    turfRenderAskResult(d);
    turfAppendChatMsg('bot', d.answer || 'Réponse indisponible.');
  } catch (e) {
    if (resEl) resEl.innerHTML = `<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ ${esc(e.message)}</div></div>`;
  }
}

function turfGetBankroll() {
  return parseFloat(document.getElementById('turf-bankroll-input')?.value || '200') || 200;
}

function turfRenderAskResult(d) {
  const el = document.getElementById('turf-analysis-result');
  if (!el) return;
  if (!d.ok) { el.innerHTML = `<div class="warn">⚠ ${esc(d.error||'Analyse indisponible')}</div>`; return; }

  const recoColor = { favorable:'var(--gr)', 'placé fiable':'var(--gr)', 'carte validée':'var(--gr)', 'carte placé validée':'var(--gr)', 'carte gagnant validée':'var(--gr)', 'outsider value':'var(--am)', 'jouable':'var(--gr)',
    'jouable seulement placé':'var(--am)', 'trop risqué':'var(--re)', 'favori surcoté':'var(--re)', 'à éviter':'var(--re)',
    'course à passer':'var(--re)' }[d.recommendation] || 'var(--neon)';

  const globalConfidence=pgiTurfGlobalConfidence(d);
  const strong=pgiIsStrongTurfSignal(d);
  const recommendationFr={
    'outsider value':'Outsider avec avantage statistique',
    'jouable seulement placé':'À jouer uniquement placé',
    'favori surcoté':'Favori trop coté',
  }[String(d.recommendation||'').toLowerCase()]||d.recommendation;

  el.innerHTML = `<div class="card${strong?' pgi-signal-tres-fort':''}" style="border-color:${recoColor}">
    <div class="ct">Analyse</div>
    <div style="font-size:13px;font-weight:700;margin-bottom:8px">${esc(d.answer||'')}</div>
    ${d.recommendation?`<span class="bdg" style="background:${recoColor}22;color:${recoColor};border:1px solid ${recoColor}55">${esc(recommendationFr)}</span>`:''}
    <span style="margin-left:6px">${pgiGlobalConfidenceBadge(globalConfidence)}</span>
    ${d.confidence!=null?`<div style="margin-top:8px;font-family:var(--mo);font-size:20px;font-weight:700;color:${recoColor}">${d.confidence}%</div><div style="font-size:9px;color:var(--dm)">${esc(d.confidence_label||'Probabilité conservatrice')}</div>`:''}
    ${renderProfessionalEvidence(d.evidence)}
    ${(d.reasons||[]).length?`<div style="margin-top:10px">${d.reasons.map(r=>`<div style="font-size:11px;color:var(--mu);padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)">• ${esc(r)}</div>`).join('')}</div>`:''}
    ${d.stake_recommended?`<div style="margin-top:8px;font-size:11px;color:var(--gr)">Mise conseillée : ${d.stake_recommended}€</div>`:''}
    <div style="font-size:10px;color:var(--dm);margin-top:10px;font-style:italic">${(d.warnings||[]).join(' ')}</div>
  </div>`;
}

// ── Bloc 6 — Chat PMU contextuel ───────────────────────────────────────
function turfAppendChatMsg(role, text) {
  const wrap = document.getElementById('turf-chat-wrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const ico = role === 'user' ? '👤' : '🐎';
  div.innerHTML = `<div class="msg-ico">${ico}</div><div><div class="msg-bub">${esc(text).replace(/\n/g,'<br>')}</div></div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function turfDetectQuestionType(text) {
  const q = text.toLowerCase();
  const horseMatch = q.match(/\b(\d{1,2})\b/);
  if (/quint[ée].*ordre|ordre.*quint/.test(q)) return { type: 'quinte_order' };
  if (/quint[ée].*(d[ée]sordre|d[ée]sordonn)/.test(q)) return { type: 'quinte_desordre' };
  if (/quint[ée].*sp[ée]cul/.test(q)) return { type: 'quinte_speculative' };
  if (/gagnant/.test(q)) return { type: 'winner' };
  if (/plac[ée]/.test(q)) return { type: 'place' };
  if (/outsider/.test(q)) return { type: 'outsider' };
  if (/[ée]viter|surcot[ée]|dangereux/.test(q)) return { type: 'avoid' };
  if (/dois.je jouer|jouer cette course|passer/.test(q)) return { type: 'should_play' };
  if (/perdu|rattrapage|r[ée]cup[ée]r/.test(q)) return { type: 'recovery' };
  if (horseMatch && /jou|avis|pens|mise|parie/.test(q)) return { type: 'horse_opinion', horse_number: parseInt(horseMatch[1], 10) };
  return { type: 'custom' };
}

async function turfSendChat() {
  const input = document.getElementById('turf-chat-input');
  const q = input.value.trim();
  if (!q) return;
  if (!TURF_SELECTED_RACE) { toast('Sélectionnez d\'abord une course PMU', 'err'); return; }
  turfAppendChatMsg('user', q);
  input.value = '';
  const detected = turfDetectQuestionType(q);
  try {
    const d = await api('/api/turf/ask', 'POST', {
      race_id: TURF_SELECTED_RACE, question_type: detected.type, horse_number: detected.horse_number,
      question: q, bankroll: turfGetBankroll(), risk_profile: 'prudent',
    });
    turfRenderAskResult(d);
    turfAppendChatMsg('bot', d.answer || 'Je n\'ai pas pu répondre à cette question sur la course sélectionnée.');
  } catch (e) {
    turfAppendChatMsg('bot', '❌ Erreur : ' + e.message);
  }
}
function turfChatKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); turfSendChat(); } }

// ═══════════════════════════════════════════════════════════════════════
//  RATTRAPAGE PMU INTELLIGENT — scanne les courses à venir et propose la
//  MEILLEURE opportunité pour le type de pari choisi (placé/gagnant/
//  quinté). Le Quinté spéculatif n'est jamais proposé en rattrapage
//  (règle explicite : jamais de quinté agressif en rattrapage).
// ═══════════════════════════════════════════════════════════════════════
function turfSetRecoveryType(bt, el) {
  turfRecoveryType = bt;
  document.querySelectorAll('.turf-recov-type-btn').forEach(b => b.classList.remove('on'));
  el?.classList.add('on');
}

async function turfRunRecoveryScan() {
  const btn = document.getElementById('turf-recovery-btn');
  const resEl = document.getElementById('turf-recovery-result');
  const bankroll = parseFloat(document.getElementById('turf-recovery-bankroll')?.value || '200') || 200;
  const dateFilter = document.getElementById('turf-recovery-period')?.value || 'today';

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="sp" style="width:12px;height:12px;border-width:2px"></span> Recherche…'; }
  resEl.innerHTML = '<div class="ls"><div class="sp"></div><p>Scan des prochaines courses PMU en cours (peut prendre quelques secondes)…</p></div>';

  try {
    const d = await api('/api/turf/recovery/scan', 'POST', { bet_type: turfRecoveryType, bankroll, date_filter: dateFilter });

    if (d.blocked) {
      resEl.innerHTML = `<div class="warn" style="color:var(--re)">&#128683; ${esc(d.message)}</div>`;
      toast('Rattrapage PMU non disponible pour ce choix', 'err');
      return;
    }
    if (!d.opportunities || !d.opportunities.length) {
      resEl.innerHTML = `<div class="warn">&#128269; ${esc(d.message||'Aucune opportunité de rattrapage disponible actuellement.')}</div>`;
      toast('Aucune opportunité pour l\'instant', '');
      return;
    }

    const betTypeLabels = { simple_place:'Placé', simple_gagnant:'Gagnant', quinte_desordre:'Quinté désordre prudent', quinte_order:'Quinté ordre' };
    let html = `<div class="sbar"><div class="sdot" style="background:var(--gr)"></div>
      <span><strong>${d.opportunities.length}</strong> opportunité(s) — ${esc(betTypeLabels[d.bet_type]||d.bet_type)} · ${d.races_scanned||0} course(s) scannée(s)</span>
    </div>`;

    d.opportunities.forEach(o => {
      const isQuinte = d.bet_type === 'quinte_desordre' || d.bet_type === 'quinte_order';
      const globalConfidence=pgiTurfGlobalConfidence(o);
      const strong=pgiIsStrongTurfSignal(o);
      const selDisplay = isQuinte
        ? (d.bet_type === 'quinte_order' ? `Ordre : ${o.order.join(' - ')}` : `Bases ${o.bases.join(', ')} + complément ${o.complement.join(', ')}`)
        : `N°${o.horse} ${esc(o.name||'')} @ ${o.odds||'?'}`;
      html += `<div class="live-card${strong?' pgi-signal-tres-fort':''}" style="margin-bottom:8px">
        <div class="lc-head">
          <div style="flex:1">
            <div class="lc-teams">🐎 ${esc(o.hippodrome)} — ${esc(o.race_name||'')}</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
              <span class="bdg bsr">${o.time||'?'}</span>
              <span class="bdg bmk">${esc(betTypeLabels[o.bet_type]||o.bet_type)}</span>
              ${pgiGlobalConfidenceBadge(globalConfidence)}
            </div>
            <div style="margin-top:8px;font-family:var(--mo);font-size:13px;font-weight:700;color:var(--am)">${selDisplay}</div>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin-top:6px">
              <div style="text-align:center;background:var(--sf2);border-radius:4px;padding:4px">
                <div style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--neon)">${o.confidence}%</div>
                <div style="font-size:8px;color:var(--dm)">${esc(o.confidence_label||'Probabilité conservatrice')}</div>
              </div>
              <div style="text-align:center;background:rgba(0,255,157,.07);border:1px solid rgba(0,255,157,.2);border-radius:4px;padding:4px">
                <div style="font-family:var(--mo);font-size:12px;font-weight:700;color:var(--gr)">${o.stake_recommended}€</div>
                <div style="font-size:8px;color:var(--dm)">Mise conseillée</div>
              </div>
            </div>
            ${renderProfessionalEvidence(o.evidence)}
          </div>
        </div>
        <div style="padding:8px 12px;border-top:1px solid var(--bd)">
          <button class="btn bs" style="font-size:10px" onclick="turfSelectRace('${esc(o.race_id)}')">Voir la course</button>
        </div>
      </div>`;
    });

    html += `<div style="font-size:10px;color:var(--dm);text-align:center;margin-top:10px;font-style:italic">${esc(d.disclaimer||'Analyse probabiliste — aucun pari garanti.')}</div>`;
    resEl.innerHTML = html;
    toast(d.opportunities.length + ' opportunité(s) de rattrapage trouvée(s)', 'ok');
  } catch (e) {
    resEl.innerHTML = `<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ ${esc(e.message)}</div></div>`;
    toast('Erreur: ' + e.message, 'err');
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '&#128269; Trouver la meilleure solution pour me refaire'; }
}

async function turfRegisterResult() {
  const match = document.getElementById('turf-loss-match')?.value.trim();
  const stake = parseFloat(document.getElementById('turf-loss-stake')?.value);
  const odds = parseFloat(document.getElementById('turf-loss-odds')?.value);
  const result = document.getElementById('turf-loss-result')?.value || 'loss';
  const betType = document.getElementById('turf-loss-bet-type')?.value || 'simple_place';

  if (!match) { toast('Renseignez la course/le cheval', 'err'); return; }
  if (!stake || stake <= 0) { toast('Mise invalide', 'err'); return; }

  // Extraction best-effort du numéro de cheval et de l'hippodrome depuis le
  // texte libre (ex: "Vincennes — n°8") pour que la mémoire Benter turf
  // puisse segmenter correctement — reste facultatif, la saisie fonctionne
  // même sans ce format précis (juste moins précis pour la mémoire).
  const horseMatch = match.match(/n[°o]?\s*(\d{1,2})/i);
  const hippodrome = match.split(/[—-]/)[0].trim() || null;

  try {
    await api('/api/turf/recovery/register-loss', 'POST', {
      match, stake, odds: odds||null, result,
      horse: horseMatch ? horseMatch[1] : null,
      hippodrome, bet_type: betType,
    });
    toast(result === 'win' ? 'Gain enregistré — mémoire Benter turf mise à jour' : result === 'void' ? 'Void enregistré' : 'Perte enregistrée — mémoire Benter turf mise à jour', result==='loss'?'':'ok');
    ['turf-loss-match','turf-loss-stake','turf-loss-odds'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
    turfLoadHistory();
  } catch (e) {
    toast('Erreur: ' + e.message, 'err');
  }
}

// ── Mise à jour automatique des résultats PMU en attente ──────────────
// Pendant de updatePendingBetResults() côté sport : interroge la source
// d'arrivées et règle les paris pending quand une correspondance fiable
// est trouvée. Ne devine jamais un résultat — un pari sans hippodrome/
// numéro de cheval clairement identifié reste en attente avec la raison
// exacte affichée. Chaque résolution alimente directement la mémoire
// Benter turf (getTurfHistoricalAdjustment) pour les analyses futures.
async function turfAutoUpdateResults() {
  const btn = document.getElementById('turf-autoupdate-btn');
  const statusEl = document.getElementById('turf-autoupdate-status');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="sp" style="width:11px;height:11px;border-width:2px"></span> Vérification…'; }
  if (statusEl) statusEl.textContent = 'Interrogation de la source de résultats PMU…';
  try {
    const d = await api('/api/turf/history/auto-update', 'POST');
    if (statusEl) {
      statusEl.innerHTML = `${esc(d.message||'')} (${d.checked||0} pari(s) en attente vérifié(s))`;
    }
    toast(d.updated > 0 ? `${d.updated} résultat(s) PMU mis à jour — mémoire enrichie` : 'Aucun résultat confirmé pour le moment', d.updated>0?'ok':'');
    if (d.updated > 0) { turfLoadHistory(); turfLoadSources(); }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Erreur : ' + e.message;
    toast('Erreur: ' + e.message, 'err');
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '&#128257; Mettre à jour automatiquement les résultats PMU'; }
}

// ── Bloc 7 — Historique PMU (séparé du sport) ─────────────────────────
async function turfLoadHistory() {
  const cnt = document.getElementById('turf-history-list');
  if (!cnt) return;
  cnt.innerHTML = '<div class="ls"><div class="sp"></div><p>Chargement…</p></div>';
  try {
    const d = await api('/api/turf/history/list?limit=100');
    if (!d.entries?.length) { cnt.innerHTML = '<div class="empty"><div class="empty-i">🐎</div><div class="empty-t">Aucun pari PMU enregistré</div></div>'; return; }
    cnt.innerHTML = d.entries.map(e => `<div class="live-card">
      <div class="lc-head">
        <div style="flex:1">
          <div class="lc-teams">${esc(e.hippodrome||e.match||'?')} — n°${esc(e.horse||'?')} ${esc(e.betType||'')}</div>
          <div class="lc-meta">
            <span class="bdg bsp">${esc(e.discipline||'')}</span>
            <span class="bdg bsr">${e.odds||'?'} @</span>
            <span class="bdg" style="background:${e.status==='win'?'var(--grb)':e.status==='loss'?'var(--reb)':'rgba(78,106,138,.15)'};color:${e.status==='win'?'var(--gr)':e.status==='loss'?'var(--re)':'var(--mu)'}">${esc(e.status||'pending')}</span>
          </div>
        </div>
      </div>
    </div>`).join('');
  } catch (e) {
    cnt.innerHTML = `<div class="card" style="border-color:var(--re)"><div style="color:var(--re)">❌ ${esc(e.message)}</div></div>`;
  }
}
