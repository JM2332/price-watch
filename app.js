/* KML Foodservice - Price Watch
   Reads Nationwide Produce's daily price list and reports what changed against
   a previous day. Products are identified by DESCRIPTION + SIZE + COUNT + PACKAGING —
   Nationwide's own product codes track the consignment, not the product, and change
   whenever the grower or box mark changes even though the product is identical.
   Several growers may offer the same product on one day; every offer is kept and
   shown, and the comparison runs on the cheapest since buying here is cost-led. */

/* ---------------------------- Firebase ----------------------------
   Flip FIREBASE_CONFIGURED to true and fill in the real values once the
   Firebase project exists (Firestore + Email/Password auth enabled, one
   shared user created). Until then the app runs in local-only mode. */
const FIREBASE_CONFIGURED = true;
const firebaseConfig = {
  apiKey: "AIzaSyCb4_xR6RwLnBSErsLCCgqtXATzqu9SRAQ",
  authDomain: "kml-price-watch.firebaseapp.com",
  projectId: "kml-price-watch",
  storageBucket: "kml-price-watch.firebasestorage.app",
  messagingSenderId: "977468714983",
  appId: "1:977468714983:web:17442c97d0121abee45742"
};
const SHARED_LOGIN_EMAIL = 'jacob@kmlfoodservice.internal';

let auth = null, db = null, unsubscribeDays = null;
if (FIREBASE_CONFIGURED) {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
}

/* ------------------------------ data ------------------------------ */

const COUNTRY={AR:"Argentina",AT:"Austria",BE:"Belgium",BR:"Brazil",BZ:"Belize",CA:"Canada",
CI:"Ivory Coast",CL:"Chile",CN:"China",CO:"Colombia",CR:"Costa Rica",CY:"Cyprus",CZ:"Czechia",
DE:"Germany",DK:"Denmark",DO:"Dominican Rep.",EC:"Ecuador",EG:"Egypt",ES:"Spain",ET:"Ethiopia",
FR:"France",GB:"UK",GH:"Ghana",GR:"Greece",GT:"Guatemala",HN:"Honduras",HU:"Hungary",
ID:"Indonesia",IE:"Ireland",IL:"Israel",IN:"India",IT:"Italy",JE:"Jersey",JM:"Jamaica",
JP:"Japan",KE:"Kenya",LK:"Sri Lanka",LT:"Lithuania",MA:"Morocco",ML:"Mali",MX:"Mexico",
MY:"Malaysia",NG:"Nigeria",NI:"Nicaragua",NL:"Netherlands",NZ:"New Zealand",PE:"Peru",
PL:"Poland",PT:"Portugal",RS:"Serbia",RW:"Rwanda",SN:"Senegal",TH:"Thailand",TN:"Tunisia",
TR:"Turkey",TZ:"Tanzania",UG:"Uganda",US:"USA",UY:"Uruguay",VN:"Vietnam",ZA:"South Africa",
ZM:"Zambia",ZW:"Zimbabwe"};
const cname=c=>COUNTRY[String(c).toUpperCase()]||c;
const flag=c=>{ c=String(c).toUpperCase();
  return /^[A-Z]{2}$/.test(c)?String.fromCodePoint(...[...c].map(ch=>0x1F1E6+ch.charCodeAt(0)-65)):""; };

const BANDS=[
  {lo:20, hi:Infinity, label:"Major",       note:"20% or more"},
  {lo:10, hi:20,       label:"Significant", note:"10 to 20%"},
  {lo:5,  hi:10,       label:"Moderate",    note:"5 to 10%"},
  {lo:2,  hi:5,        label:"Minor",       note:"2 to 5%"},
  {lo:0,  hi:2,        label:"Negligible",  note:"under 2%"}
];

/* A product creeping up (or down) a little each day never trips a single
   day-to-day band — see HANDOVER.md. These catch that: cumulative move
   over the last CREEP_WINDOW recorded days, only surfaced if no single
   day in that window was already big enough to land in Major/Significant
   on its own (that's already visible above, no need to repeat it here). */
const CREEP_WINDOW=8, CREEP_MIN_POINTS=4, CREEP_THRESHOLD=10;

/* ---------------------------- storage ------------------------------
   Firestore (days/{date}, raw parsed rows — not the grouped output, so
   grouping/derivation logic can change later without re-importing old
   files) is the source of truth when signed in. localStorage is kept as
   an offline/instant-load cache, one key per day, same as the other
   KML tools. */

const IDX="pw:index", CFG="pw:cfg", DAY=d=>"pw:day:"+d;

let STORAGE_OK=(function(){
  try{ localStorage.setItem("pw:test","1"); localStorage.removeItem("pw:test"); return true; }
  catch(e){ return false; }
})();
const IN_FRAME=(function(){ try{ return window.self!==window.top; }catch(e){ return true; } })();
const MEM={};
function get(k,f){
  if(!STORAGE_OK) return (k in MEM)?MEM[k]:f;
  try{const v=localStorage.getItem(k);return v?JSON.parse(v):f;}catch(e){return f;}
}
function put(k,v){
  if(!STORAGE_OK){ MEM[k]=v; return true; }
  try{ localStorage.setItem(k,JSON.stringify(v)); return true; }
  catch(e){
    alert("Couldn't save locally — browser storage is full.\n\nUse Backup on the History tab to save a copy to a file, then remove some older lists.");
    return false;
  }
}
function del(k){ if(!STORAGE_OK){delete MEM[k];return;} try{localStorage.removeItem(k);}catch(e){} }

function cacheDay(date,payload){
  put(DAY(date),payload);
  const idx=Array.from(new Set(state.dates.concat([date]))).sort();
  put(IDX,idx); state.dates=idx;
}
function uncacheDay(date){
  del(DAY(date));
  state.dates=state.dates.filter(d=>d!==date);
  put(IDX,state.dates);
}

function pushDayToCloud(date,payload){
  if(!db||!auth.currentUser) return;
  db.collection('days').doc(date).set(Object.assign({},payload,
    {updatedAt:firebase.firestore.FieldValue.serverTimestamp()})).catch(err=>console.error('Cloud sync failed for',date,err));
}
function deleteDayFromCloud(date){
  if(!db||!auth.currentUser) return;
  db.collection('days').doc(date).delete().catch(err=>console.error('Cloud delete failed for',date,err));
}
function subscribeDays(){
  if(!db) return;
  if(unsubscribeDays) unsubscribeDays();
  unsubscribeDays=db.collection('days').onSnapshot(snapshot=>{
    /* Every write resolves updatedAt (serverTimestamp()) from a pending
       local value to the real one a moment later, which fires this
       listener a second time for the exact same items/file — a full
       renderAll() on that spurious echo would tear down and rebuild every
       dropdown and product row on the page for no reason, and if a click
       or tap landed in that window it'd hit a DOM node that just got
       discarded. Only re-render when what's actually shown changed. */
    let changed=false;
    snapshot.docChanges().forEach(change=>{
      const date=change.doc.id;
      if(change.type==='removed'){
        if(state.dates.indexOf(date)>=0){ uncacheDay(date); changed=true; }
        return;
      }
      const data=change.doc.data();
      const existing=get(DAY(date),null);
      const same=existing&&existing.file===data.file&&JSON.stringify(existing.items)===JSON.stringify(data.items);
      if(same)return;
      cacheDay(date,{date,file:data.file,items:data.items});
      changed=true;
    });
    if(!changed)return;
    if(state.dates.length>=2){ state.older=state.dates[state.dates.length-2]; state.newer=state.dates[state.dates.length-1]; }
    else if(state.dates.length===1){ state.newer=state.dates[0]; state.older=null; }
    renderAll();
  },err=>console.error('Days subscription failed',err));
}

/* ---------------------- backup file (portable) --------------------- */
function exportArchive(){
  const days={};
  state.dates.forEach(d=>{ const day=get(DAY(d),null); if(day)days[d]=day; });
  const blob=new Blob([JSON.stringify({format:"pw-price-watch",version:1,
    saved:new Date().toISOString(),cfg:state.cfg,days},null,1)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="price-watch-backup-"+todayISO()+".json";
  a.click(); URL.revokeObjectURL(a.href);
  state.msg={tone:"ok",text:"Backup saved to your Downloads folder. Keep it somewhere safe — OneDrive is a good spot."};
  renderAll();
}
function importArchive(file){
  const fr=new FileReader();
  fr.onload=e=>{
    let data=null;
    try{ data=JSON.parse(e.target.result); }catch(err){}
    if(!data||data.format!=="pw-price-watch"||!data.days){
      state.msg={tone:"warn",text:"That isn't a Price Watch backup file."}; renderAll(); return;
    }
    let added=0,replaced=0;
    Object.keys(data.days).forEach(d=>{
      if(state.dates.indexOf(d)>=0)replaced++; else added++;
      cacheDay(d,data.days[d]);
      pushDayToCloud(d,data.days[d]);
    });
    if(data.cfg){ state.cfg=Object.assign(state.cfg,data.cfg); put(CFG,state.cfg); }
    state.newer=state.dates[state.dates.length-1]||null;
    state.older=state.dates.length>=2?state.dates[state.dates.length-2]:null;
    state.msg={tone:"ok",text:"Backup restored — "+added+" day"+(added===1?"":"s")+" added"+
      (replaced?", "+replaced+" already present and refreshed":"")+"."};
    renderAll();
  };
  fr.readAsText(file);
}

/* ------------------------------ state ------------------------------ */

let state={ dates:get(IDX,[]),
  cfg:get(CFG,{limit:40,openBands:[0,1,2],sort:"size"}),
  msg:null, older:null, newer:null, showAll:false, asText:false, q:"", productOverlay:null };
if(state.cfg.openBands==null)state.cfg.openBands=[0,1,2];
if(!state.cfg.sort)state.cfg.sort="size";
if(!state.cfg.limit)state.cfg.limit=40;
if(state.dates.length>=2){ state.older=state.dates[state.dates.length-2]; state.newer=state.dates[state.dates.length-1]; }
else if(state.dates.length===1){ state.newer=state.dates[0]; }

const dayOf=d=>{
  if(!d) return null;
  const raw=get(DAY(d),null);
  if(!raw) return null;
  return Object.assign({},raw,{groups:groupItems(raw.items).groups});
};
const money=n=>(n==null||isNaN(n))?"—":"£"+Number(n).toFixed(2);
const pct=n=>(n>0?"+":"")+n.toFixed(1)+"%";
const todayISO=()=>new Date().toISOString().slice(0,10);
function pretty(iso){ if(!iso)return"—"; const d=new Date(iso+"T00:00:00");
  return isNaN(d)?iso:d.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}); }
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function dateFromName(name){
  const m=String(name).match(/(\d{1,2})[_\-. ](\d{1,2})[_\-. ](\d{2,4})/);
  if(!m)return null;
  let d=m[1],mo=m[2],y=m[3]; if(y.length===2)y="20"+y;
  const iso=y+"-"+String(mo).padStart(2,"0")+"-"+String(d).padStart(2,"0");
  return isNaN(new Date(iso).getTime())?null:iso;
}
/* fallback: "Price List - Monday, 3 August 2026" in the top-left cell */
function dateFromSheet(rows){
  for(let i=0;i<Math.min(rows.length,6);i++){
    const t=String(rows[i][0]||"");
    const m=t.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if(m){ const d=new Date(m[1]+" "+m[2]+" "+m[3]);
      if(!isNaN(d))return d.toISOString().slice(0,10); }
  }
  return null;
}

/* ------------------------------ parser ---------------------------- */
function parseNationwide(rows){
  let hdrIdx=-1;
  for(let i=0;i<Math.min(rows.length,40);i++){
    const r=rows[i].map(c=>String(c==null?"":c).trim());
    if(r[0]==="Product"&&r[1]==="Description"){hdrIdx=i;break;}
  }
  if(hdrIdx<0)return null;
  const H=rows[hdrIdx].map(c=>String(c==null?"":c).trim());
  const col=n=>H.findIndex(h=>h.toLowerCase()===n.toLowerCase());
  const ci={group:col("Product"),desc:col("Description"),mark:col("Box Mark"),size:col("Size"),
    count:col("Count"),pack:col("Packaging"),weight:col("Weight"),price:col("Price")};
  if(ci.desc<0||ci.price<0)return null;

  /* Country of origin sits in a column with no heading. Find it by content:
     mostly two-letter codes. */
  ci.origin=-1;
  for(let c=0;c<Math.max(H.length,14);c++){
    if(c===ci.desc||c===ci.price||c===ci.pack||c===ci.mark)continue;
    let codes=0,filled=0;
    for(let r=hdrIdx+1;r<Math.min(rows.length,hdrIdx+400);r++){
      const v=String(rows[r][c]==null?"":rows[r][c]).trim();
      if(!v)continue;
      filled++;
      if(/^[A-Za-z]{2}$/.test(v))codes++;
    }
    if(filled>20&&codes>filled*0.8){ci.origin=c;break;}
  }

  const items=[]; let section=""; let dropped=0;
  for(let i=0;i<rows.length;i++){
    const r=rows[i].map(c=>String(c==null?"":c).trim());
    if(!r.some(Boolean))continue;
    if(r[ci.group]==="Product"&&r[ci.desc]==="Description")continue;
    if(r[ci.group]&&!r[ci.desc]){section=r[ci.group];continue;}
    if(!r[ci.desc])continue;
    const price=parseFloat(String(r[ci.price]).replace(/[^0-9.]/g,""));
    if(isNaN(price)||price<=0){dropped++;continue;}
    items.push({section,desc:r[ci.desc],mark:r[ci.mark]||"",size:r[ci.size]||"",
      count:r[ci.count]||"",pack:r[ci.pack]||"",weight:r[ci.weight]||"",
      origin:(ci.origin>=0?(r[ci.origin]||""):"").toUpperCase(),price});
  }
  return {items,dropped};
}

/* group by product spec; keep every grower's offer inside the group.
   Kept separate from parsing so it can be re-run against raw stored rows
   without needing the original file re-imported. */
function groupItems(items){
  const groups={};
  (items||[]).forEach(it=>{
    const k=[it.desc,it.size,it.count,it.pack].map(s=>String(s).toUpperCase().trim()).join("|");
    if(!groups[k])groups[k]={key:k,section:it.section,desc:it.desc,size:it.size,
      count:it.count,pack:it.pack,weight:it.weight,offers:[]};
    groups[k].offers.push({mark:it.mark,price:it.price,origin:it.origin});
  });
  Object.keys(groups).forEach(k=>{
    const g=groups[k];
    g.offers.sort((a,b)=>a.price-b.price);
    g.best=g.offers[0].price;
    g.origins=Array.from(new Set(g.offers.map(o=>o.origin).filter(Boolean))).sort();
  });
  return {groups};
}

/* ---------------------------- importing --------------------------- */
function handleFile(file){
  const fr=new FileReader();
  fr.onload=e=>{
    let parsed=null,rows=null;
    try{
      const wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});
      rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,blankrows:true,defval:""});
      parsed=parseNationwide(rows);
    }catch(err){ console.error(err); }
    if(!parsed||!parsed.items.length){
      state.msg={tone:"warn",text:"That doesn't look like a Nationwide list — no Product / Description header row found."};
      renderAll(); return;
    }
    const date=dateFromName(file.name)||dateFromSheet(rows)||todayISO();
    const existed=state.dates.indexOf(date)>=0;
    const payload={date,file:file.name,items:parsed.items};
    cacheDay(date,payload);
    pushDayToCloud(date,payload);
    state.newer=date; state.older=(function(){ const i=state.dates.indexOf(date); return i>0?state.dates[i-1]:null; })();
    state.showAll=false; state.asText=false;
    const g=groupItems(parsed.items).groups;
    const n=Object.keys(g).length;
    const withOrigin=Object.keys(g).filter(k=>g[k].origins.length).length;
    state.msg={tone:"ok",text:pretty(date)+(existed?" replaced":" loaded")+" — "+parsed.items.length+
      " priced rows covering "+n+" products"+(parsed.dropped?", "+parsed.dropped+" rows with no price ignored":"")+
      (withOrigin?"  ·  origin found on "+withOrigin+" of them":"  ·  no country of origin column found in this file")+"."};
    setActiveTab("changes");
    renderAll();
  };
  fr.onerror=()=>{ state.msg={tone:"warn",text:"Could not read that file."}; renderAll(); };
  fr.readAsArrayBuffer(file);
}

/* ----------------------------- compare ---------------------------- */
function buildReport(){
  const B=dayOf(state.newer); if(!B)return null;
  const A=dayOf(state.older);
  const total=Object.keys(B.groups).length;
  if(!A)return{first:true,total};
  const moved=[],added=[],gone=[],origins=[];let unchanged=0;
  const sameSet=(x,y)=>(x||[]).join(",")===(y||[]).join(",");
  Object.keys(B.groups).forEach(k=>{
    const b=B.groups[k], a=A.groups[k];
    if(!a){added.push(b);return;}
    if(a.origins&&b.origins&&a.origins.length&&b.origins.length&&!sameSet(a.origins,b.origins)){
      const o={}; for(const p in b)o[p]=b[p];
      o.wasOrigins=a.origins; o.was=a.best;
      o.delta=((b.best-a.best)/a.best)*100;
      origins.push(o);
    }
    const d=((b.best-a.best)/a.best)*100;
    if(Math.abs(d)<0.05){unchanged++;return;}
    const m={}; for(const p in b)m[p]=b[p];
    m.was=a.best; m.wasOffers=a.offers; m.delta=d; m.diff=b.best-a.best;
    moved.push(m);
  });
  Object.keys(A.groups).forEach(k=>{ if(!B.groups[k])gone.push(A.groups[k]); });
  moved.sort((x,y)=>Math.abs(y.delta)-Math.abs(x.delta));
  origins.sort((x,y)=>x.desc.localeCompare(y.desc));
  return{first:false,moved,added,gone,origins,unchanged,total};
}

/* Anchored to state.newer, not necessarily the latest stored day overall —
   the compare dropdowns let Jake pick an older "newer", and this should
   answer "as of the day I'm looking at", not silently look further ahead.
   dayOf() is precomputed once per date here rather than per product —
   productHistory() re-derives per product and is fine for a single click,
   but calling it once per product in a ~450-product list would re-run
   groupItems() over every stored day's rows for every single product. */
function buildCreepReport(){
  const B=dayOf(state.newer); if(!B)return [];
  const cutoff=state.dates.indexOf(state.newer);
  const relevantDates=state.dates.slice(0,cutoff+1);
  const days=relevantDates.map(d=>dayOf(d));
  const out=[];
  Object.keys(B.groups).forEach(k=>{
    const hist=days.map((day,i)=>day&&day.groups[k]?Object.assign({date:relevantDates[i]},day.groups[k]):null).filter(Boolean);
    if(hist.length<CREEP_MIN_POINTS)return;
    const window=hist.slice(-CREEP_WINDOW);
    if(window.length<CREEP_MIN_POINTS)return;
    const first=window[0], last=window[window.length-1];
    const cum=((last.best-first.best)/first.best)*100;
    if(Math.abs(cum)<CREEP_THRESHOLD)return;
    const prev=hist[hist.length-2];
    if(prev){
      const dayDelta=((last.best-prev.best)/prev.best)*100;
      if(Math.abs(dayDelta)>=BANDS[1].lo)return; /* already flagged Major/Significant today */
    }
    out.push(Object.assign({},last,{cum,days:window.length,from:first.best,fromDate:first.date}));
  });
  out.sort((a,b)=>Math.abs(b.cum)-Math.abs(a.cum));
  return out;
}

function specOf(g){ return [g.size,g.count,g.pack,g.section].filter(Boolean).join(" · "); }

/* -------------------------- product history ------------------------
   Every stored day's raw rows are re-grouped on read (see dayOf), so a
   product's price trend can be read back across every day it appears in,
   not just the two being compared on the Changes tab. */
function productHistory(key){
  return state.dates.map(d=>{
    const day=dayOf(d);
    const g=day&&day.groups[key];
    return g?Object.assign({date:d},g):null;
  }).filter(Boolean);
}

/* Simple line chart, hand-rolled (no charting library). Points are spaced
   evenly by import order rather than by real calendar distance — imports
   land roughly daily, and even spacing keeps the axis readable when a day
   or two gets missed. Endpoint and extremes get direct labels; every value
   is also in the table underneath, so nothing depends on hovering a dot. */
function trendSVG(hist){
  const W=640,H=210,padL=48,padR=14,padT=18,padB=26;
  const innerW=W-padL-padR, innerH=H-padT-padB;
  const prices=hist.map(h=>h.best);
  const rawLo=Math.min.apply(null,prices), rawHi=Math.max.apply(null,prices);
  let lo=rawLo, hi=rawHi;
  if(lo===hi){ const pad=Math.max(0.5,lo*0.1); lo-=pad; hi+=pad; }
  else { const pad=(hi-lo)*0.15; lo-=pad; hi+=pad; }
  const x=i=>hist.length>1?padL+(i/(hist.length-1))*innerW:padL+innerW/2;
  const y=p=>padT+innerH-((p-lo)/(hi-lo))*innerH;
  const pts=hist.map((h,i)=>[x(i),y(h.best)]);

  const gridLines=[0,0.5,1].map(t=>{
    const gy=padT+innerH*t, val=hi-(hi-lo)*t;
    return '<line class="trend-grid" x1="'+padL+'" x2="'+(W-padR)+'" y1="'+gy+'" y2="'+gy+'"/>'+
      '<text class="trend-axis-label" x="'+(padL-8)+'" y="'+(gy+3)+'" text-anchor="end">'+money(val)+'</text>';
  }).join("");

  const maxIdx=prices.indexOf(rawHi), minIdx=prices.indexOf(rawLo), lastIdx=hist.length-1;
  const dots=hist.map((h,i)=>{
    const p=pts[i], tip='<title>'+esc(pretty(h.date))+': '+money(h.best)+'</title>';
    return '<circle class="trend-dot-hit" cx="'+p[0]+'" cy="'+p[1]+'" r="12">'+tip+'</circle>'+
      '<circle class="trend-dot" cx="'+p[0]+'" cy="'+p[1]+'" r="4">'+tip+'</circle>';
  }).join("");

  const labeled=new Set();
  let labels="";
  [lastIdx,maxIdx,minIdx].forEach(i=>{
    if(labeled.has(i))return; labeled.add(i);
    const p=pts[i];
    const anchor=i===0?"start":(i===lastIdx?"end":"middle");
    labels+='<text class="trend-end-label" x="'+p[0]+'" y="'+(p[1]-12)+'" text-anchor="'+anchor+'">'+money(hist[i].best)+'</text>';
  });

  const xLabels=(hist.length>1?[0,lastIdx]:[0]).map(i=>
    '<text class="trend-axis-label" x="'+pts[i][0]+'" y="'+(H-6)+'" text-anchor="'+(i===0?"start":"end")+'">'+esc(pretty(hist[i].date))+'</text>').join("");

  return '<svg class="trend-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+
    gridLines+'<polyline class="trend-line" points="'+pts.map(p=>p.join(",")).join(" ")+'"/>'+
    dots+labels+xLabels+'</svg>';
}

function trendTableHTML(hist){
  const withDelta=hist.map((h,i)=>Object.assign({},h,{
    delta:i>0?((h.best-hist[i-1].best)/hist[i-1].best)*100:null
  }));
  const rows=withDelta.slice().reverse().map(h=>
    '<tr><td>'+pretty(h.date)+'</td><td class="num">'+money(h.best)+'</td>'+
    '<td class="num">'+(h.delta==null?"—":pct(h.delta))+'</td>'+
    '<td class="secondary">'+(h.offers.length>1?h.offers.length+" growers":esc(h.offers[0].mark||"unbranded"))+'</td>'+
    '<td class="secondary">'+(h.origins&&h.origins.length?h.origins.map(c=>flag(c)+" "+esc(cname(c))).join(", "):"—")+'</td></tr>'
  ).join("");
  return '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Price</th><th>Change</th><th>Grower</th><th>Origin</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function renderProductOverlay(){
  const key=state.productOverlay;
  if(!key)return;
  const hist=productHistory(key);
  const titleEl=document.getElementById("product-overlay-title");
  const specEl=document.getElementById("product-overlay-spec");
  const body=document.getElementById("product-overlay-body");
  if(!hist.length){
    titleEl.textContent="Not found"; specEl.textContent="";
    body.innerHTML='<p class="secondary">No stored history for this product.</p>';
    return;
  }
  const g=hist[hist.length-1];
  titleEl.textContent=g.desc;
  specEl.textContent=specOf(g)+"  ·  "+hist.length+" day"+(hist.length===1?"":"s")+" recorded";
  let h="";
  if(hist.length<2)h+='<p class="panel-hint">Only one day recorded so far — the trend fills in as more lists are imported.</p>';
  h+=trendSVG(hist)+trendTableHTML(hist);
  body.innerHTML=h;
}
function openProductHistory(key){
  state.productOverlay=key;
  /* Show the overlay before rendering into it, and catch render errors,
     so a bad edge case shows a message instead of the click silently
     doing nothing — "nothing happened" is much harder to diagnose than
     a visible error. */
  document.getElementById("product-overlay").classList.remove("hidden");
  try{ renderProductOverlay(); }
  catch(err){
    console.error("Product history render failed",err);
    document.getElementById("product-overlay-body").innerHTML=
      '<p class="secondary">Something went wrong showing this product\'s history. Close this and try clicking it again.</p>';
  }
}
function closeProductOverlay(){
  state.productOverlay=null;
  document.getElementById("product-overlay").classList.add("hidden");
}

/* Days imported before origin tracking existed have no origin data — it can't
   be recovered from what's stored, the .xls has to be read again. */
function daysMissingOrigin(){
  return state.dates.filter(d=>{
    const day=dayOf(d); if(!day)return false;
    const ks=Object.keys(day.groups);
    if(!ks.length)return false;
    return !ks.some(k=>day.groups[k].origins&&day.groups[k].origins.length);
  });
}
function originHTML(list){
  if(!list||!list.length)return "";
  return '<span class="origin-tag">'+list.map(c=>flag(c)+" "+esc(cname(c))).join(", ")+'</span>';
}
function originText(list){ return (list||[]).map(c=>cname(c)).join(", "); }

function originNote(rep){
  const L=["Produce origin changes — "+pretty(state.newer),""];
  rep.origins.forEach(o=>{
    L.push("  "+o.desc+(o.size?" ("+o.size+")":""));
    L.push("      now from "+originText(o.origins)+"  (was "+originText(o.wasOrigins)+")");
  });
  L.push("");
  L.push("Seasonal changes can bring a difference in size, appearance and flavour.");
  L.push("Please get in touch if you'd like more detail on any of these.");
  return L.join("\n");
}

function textReport(rep,all,risers,fallers,buckets){
  const L=["Nationwide price changes — "+pretty(state.newer)+" vs "+pretty(state.older),
    all.length+" products changed ("+risers.length+" up, "+fallers.length+" down) out of "+rep.total,""];
  const fmt=m=>{
    let s="  "+pct(m.delta).padStart(7)+"  "+money(m.was)+" -> "+money(m.best)+"  "+m.desc+
      ((m.size||m.count)?" ("+[m.size,m.count].filter(Boolean).join(" ")+")":"");
    if(m.offers.length>1) s+="\n"+m.offers.map(o=>"            "+money(o.price)+"  "+(o.mark||"unbranded")).join("\n");
    return s;
  };
  BANDS.forEach((band,i)=>{
    const rowsIn=buckets[i];
    if(!rowsIn.length)return;
    L.push(band.label.toUpperCase()+" — "+band.note+" ("+rowsIn.length+")");
    sortMoved(rowsIn).forEach(m=>L.push(fmt(m)));
    L.push("");
  });
  if(rep.origins&&rep.origins.length){L.push("COMING FROM SOMEWHERE NEW ("+rep.origins.length+")");
    rep.origins.forEach(o=>L.push("  "+o.desc+": "+originText(o.wasOrigins)+" -> "+originText(o.origins)));
    L.push("");}
  if(rep.added.length){L.push("NEW TO THE LIST");
    rep.added.forEach(a=>L.push("  "+money(a.best)+"  "+a.desc+(a.size?" ("+a.size+")":"")));L.push("");}
  if(rep.gone.length){L.push("NO LONGER LISTED");
    rep.gone.forEach(a=>L.push("  "+a.desc+(a.size?" ("+a.size+")":"")+"  was "+money(a.best)));}
  return L.join("\n");
}

function exportCsv(rep){
  const L=["Band,Description,Size,Count,Packaging,Section,Origin,Was,Now,Change GBP,Change %,Growers today"];
  sortMoved(rep.moved).forEach(m=>{
    const g=m.offers.map(o=>(o.mark||"unbranded")+" "+money(o.price)+
      (o.origin?" ["+cname(o.origin)+"]":"")).join(" | ");
    L.push([BANDS[bandOf(m.delta)].label,'"'+m.desc.replace(/"/g,'""')+'"','"'+m.size+'"','"'+m.count+'"','"'+m.pack+'"',
      '"'+m.section+'"','"'+(m.origins||[]).map(cname).join(", ")+'"',
      m.was.toFixed(2),m.best.toFixed(2),m.diff.toFixed(2),m.delta.toFixed(1),
      '"'+g.replace(/"/g,'""')+'"'].join(","));
  });
  const blob=new Blob([L.join("\n")],{type:"text/csv"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="nationwide-changes-"+state.newer+".csv";
  a.click(); URL.revokeObjectURL(a.href);
}

function bandOf(d){
  const a=Math.abs(d);
  for(let i=0;i<BANDS.length;i++) if(a>=BANDS[i].lo && a<BANDS[i].hi) return i;
  return BANDS.length-1;
}
function sortMoved(list){
  const s=state.cfg.sort;
  const c=list.slice();
  if(s==="size")      c.sort((x,y)=>Math.abs(y.delta)-Math.abs(x.delta));
  else if(s==="up")   c.sort((x,y)=>y.delta-x.delta);
  else if(s==="down") c.sort((x,y)=>x.delta-y.delta);
  else if(s==="cash") c.sort((x,y)=>Math.abs(y.diff)-Math.abs(x.diff));
  else if(s==="name") c.sort((x,y)=>x.desc.localeCompare(y.desc));
  return c;
}

/* ---------------------------- rendering --------------------------- */
function offersHTML(offers){
  if(offers.length<2)return "";
  return '<div class="growers-list">'+offers.map((o,i)=>
    '<div><b class="'+(i===0?"best":"")+'">'+money(o.price)+'</b><span>'+esc(o.mark||"unbranded")+
    (o.origin?' &middot; '+flag(o.origin)+" "+esc(cname(o.origin)):"")+'</span></div>').join("")+'</div>';
}
function movedHTML(m,maxAbs){
  const w=Math.min(100,(Math.abs(m.delta)/maxAbs)*100);
  return '<div class="pw-row pw-clickable" data-product="'+esc(m.key)+'"><div class="pw-name"><b>'+esc(m.desc)+'</b><div class="pw-spec">'+esc(specOf(m))+
    (m.offers.length>1?'  ·  '+m.offers.length+' growers':'')+'</div>'+
    originHTML(m.origins)+
    '<div class="pw-bar" style="width:'+w+'%;background:'+(m.delta>0?"var(--danger)":"var(--ok)")+'"></div>'+
    offersHTML(m.offers)+'</div>'+
    '<span class="pw-was">'+money(m.was)+'→</span><span class="pw-now">'+money(m.best)+'</span>'+
    '<span class="pw-pct '+(m.delta>0?"pw-up":"pw-down")+'">'+pct(m.delta)+'</span></div>';
}
function creepHTML(c){
  return '<div class="pw-row pw-clickable" data-product="'+esc(c.key)+'"><div class="pw-name"><b>'+esc(c.desc)+'</b><div class="pw-spec">'+esc(specOf(c))+
    '  ·  '+c.days+' days since '+pretty(c.fromDate)+'</div>'+
    originHTML(c.origins)+'</div>'+
    '<span class="pw-was">'+money(c.from)+'→</span><span class="pw-now">'+money(c.best)+'</span>'+
    '<span class="pw-pct '+(c.cum>0?"pw-up":"pw-down")+'">'+pct(c.cum)+'</span></div>';
}
function plainHTML(g,was){
  return '<div class="pw-row pw-clickable" data-product="'+esc(g.key)+'"><div class="pw-name"><b>'+esc(g.desc)+'</b><div class="pw-spec">'+esc(specOf(g))+'</div>'+
    originHTML(g.origins)+'</div>'+
    '<span class="'+(was?"pw-was":"pw-now")+'">'+(was?"was ":"")+money(g.best)+'</span></div>';
}

function renderAlerts(){
  let h="";
  if(FIREBASE_CONFIGURED===false){
    h+='<div class="alert"><b>Cloud sync isn\'t set up yet.</b>&nbsp;Changes are only saved on this device until the Firebase project is configured — see HANDOVER.md.</div>';
  }
  if(!STORAGE_OK){
    h+='<div class="alert"><b>Nothing is being saved locally.</b>&nbsp;This browser is blocking storage'+
       (IN_FRAME?", because the page is running inside a preview window rather than on its own":"")+
       '. Save this file to your computer and open it directly to keep lists between visits.</div>';
  }
  const stale=daysMissingOrigin();
  if(stale.length){
    h+='<div class="alert"><b>No country of origin on '+
       (stale.length===1?pretty(stale[0]):stale.length+" of the stored days")+'.</b>&nbsp;'+
       'They were imported before origin tracking was added. Drop the same .xls files in again on the Import tab and it\'ll appear.</div>';
  }
  if(state.msg){
    h+='<div class="alert'+(state.msg.tone==="ok"?" ok":"")+'">'+esc(state.msg.text)+
      '<button class="btn-outline sm" data-act="dismiss">Dismiss</button></div>';
  }
  document.getElementById("global-alerts").innerHTML=h;
}

function renderChanges(){
  const el=document.getElementById("changes-body");
  const rep=buildReport();
  if(!rep){
    el.innerHTML='<div class="empty-state"><p>No price lists loaded yet. Add one to get started — once there are two days in, this page shows what moved.</p>'+
      '<button class="btn-primary" data-goto="import">Import a list</button></div>';
    return;
  }
  if(rep.first){
    el.innerHTML='<div class="empty-state"><p><b>'+pretty(state.newer)+'</b> is in — '+rep.total+
      ' products.<br>Nothing to compare it against yet. Add another day and the changes appear here.</p>'+
      '<button class="btn-primary" data-goto="import">Import another day</button></div>';
    return;
  }

  const all=rep.moved;
  const buckets=BANDS.map(()=>[]);
  all.forEach(m=>{buckets[bandOf(m.delta)].push(m);});
  const risers=all.filter(m=>m.delta>0), fallers=all.filter(m=>m.delta<0);
  const maxAbs=all.length?Math.max.apply(null,all.map(m=>Math.abs(m.delta))):1;
  const headline=buckets[0].length+buckets[1].length;

  let h='<div class="stat-grid">'+
    '<div class="stat-card headline"><div class="stat-value">'+headline+'</div><div class="stat-label">Worth a look</div>'+
    '<div class="stat-sub">'+pretty(state.newer)+' vs '+pretty(state.older)+' &middot; moved 10% or more &middot; '+all.length+' changed of '+rep.total+' products</div></div>'+
    '<div class="stat-card up"><div class="stat-value">'+risers.length+'</div><div class="stat-label">Up</div></div>'+
    '<div class="stat-card down"><div class="stat-value">'+fallers.length+'</div><div class="stat-label">Down</div></div>'+
    '<div class="stat-card"><div class="stat-value">'+rep.unchanged+'</div><div class="stat-label">Same</div></div>'+
    (rep.added.length?'<div class="stat-card"><div class="stat-value">'+rep.added.length+'</div><div class="stat-label">New</div></div>':'')+
    (rep.gone.length?'<div class="stat-card"><div class="stat-value">'+rep.gone.length+'</div><div class="stat-label">Gone</div></div>':'')+
    '</div>';

  h+='<div class="inline-form">'+
    '<label>Compare<select data-set="older">'+
      state.dates.filter(d=>d!==state.newer).map(d=>'<option value="'+d+'"'+(d===state.older?" selected":"")+'>'+pretty(d)+'</option>').join("")+
    '</select></label>'+
    '<label>With<select data-set="newer">'+
      state.dates.map(d=>'<option value="'+d+'"'+(d===state.newer?" selected":"")+'>'+pretty(d)+'</option>').join("")+
    '</select></label>'+
    '<label>Order by<select data-set="sort">'+
      [["size","Biggest move first"],["cash","Biggest £ change"],["up","Rises first"],
       ["down","Falls first"],["name","Product name"]]
      .map(o=>'<option value="'+o[0]+'"'+(state.cfg.sort===o[0]?" selected":"")+'>'+o[1]+'</option>').join("")+
    '</select></label>'+
    '</div>';

  if(state.asText){
    h+='<div class="table-wrap" style="padding:16px">'+
      '<p class="secondary" style="margin:0 0 10px">Click in the box to select it, then copy.</p>'+
      '<textarea readonly class="report-text" id="report-ta">'+esc(textReport(rep,all,risers,fallers,buckets))+'</textarea>'+
      '<div style="display:flex;gap:8px;margin-top:10px">'+
      '<button class="btn-primary" data-act="copy-report">Copy to clipboard</button>'+
      '<button class="btn-outline" data-act="untext">Back to list</button></div></div>';
    el.innerHTML=h; return;
  }

  const creep=buildCreepReport();

  if(!all.length&&!creep.length){
    h+='<div class="empty-state"><p>Not a single price changed between these two days.</p></div>';
    el.innerHTML=h; return;
  }

  if(all.length){
    BANDS.forEach((band,i)=>{
      const rowsIn=buckets[i];
      if(!rowsIn.length)return;
      const open=state.cfg.openBands.indexOf(i)>=0;
      const up=rowsIn.filter(m=>m.delta>0).length, dn=rowsIn.length-up;
      h+='<div class="band-group"><div class="band-head'+(open?" open":"")+'" data-band="'+i+'">'+
         '<span class="band-title"><span class="caret">▸</span>'+band.label+' <span class="band-note">'+band.note+'</span></span>'+
         '<span class="band-counts">'+rowsIn.length+' &middot; <span class="pw-up">'+up+' up</span> <span class="pw-down">'+dn+' down</span></span></div>';
      if(open){
        h+='<div class="band-body">';
        const shown=state.showAll?rowsIn:rowsIn.slice(0,state.cfg.limit);
        sortMoved(shown).forEach(m=>{h+=movedHTML(m,maxAbs);});
        if(rowsIn.length>shown.length)
          h+='<div class="band-more">and '+(rowsIn.length-shown.length)+
             ' more in this band <button class="btn-outline sm" data-act="showall">Show all</button></div>';
        h+='</div>';
      }
      h+='</div>';
    });
  }

  [["creepup","Creeping up",creep.filter(c=>c.cum>0)],
   ["creepdown","Creeping down",creep.filter(c=>c.cum<0)]].forEach(([bandId,label,rowsIn])=>{
    if(!rowsIn.length)return;
    const open=state.cfg.openBands.indexOf(bandId)>=0;
    h+='<div class="band-group"><div class="band-head'+(open?" open":"")+'" data-band="'+bandId+'">'+
       '<span class="band-title"><span class="caret">▸</span>'+label+'</span>'+
       '<span class="band-counts">'+rowsIn.length+'</span></div>';
    if(open){
      h+='<div class="band-body">'+
         '<p class="panel-hint" style="padding:12px 16px 0">Moved '+CREEP_THRESHOLD+'%+ '+(bandId==="creepup"?"up":"down")+
         ' over the last '+CREEP_WINDOW+' recorded days without any single day being big enough on its own to land in Major or Significant above.</p>';
      rowsIn.forEach(c=>{h+=creepHTML(c);});
      h+='</div>';
    }
    h+='</div>';
  });

  if(rep.origins&&rep.origins.length){
    const open=state.cfg.openBands.indexOf("org")>=0;
    h+='<div class="band-group"><div class="band-head'+(open?" open":"")+'" data-band="org">'+
       '<span class="band-title"><span class="caret">▸</span>Coming from somewhere new</span>'+
       '<span class="band-counts">'+rep.origins.length+'</span></div>';
    if(open){
      h+='<div class="band-body">'+
         '<p class="panel-hint" style="padding:12px 16px 0">Worth telling customers about — a change of country usually means a change of season, and often of size, look or taste.</p>';
      rep.origins.forEach(o=>{
        h+='<div class="pw-row"><div class="pw-name"><b>'+esc(o.desc)+'</b><div class="pw-spec">'+esc(specOf(o))+'</div>'+
           '<div class="origin-shift"><span class="was">'+o.wasOrigins.map(c=>flag(c)+" "+esc(cname(c))).join(", ")+
           '</span><span class="arr">→</span><span class="now">'+
           o.origins.map(c=>flag(c)+" "+esc(cname(c))).join(", ")+'</span></div></div>'+
           '<span class="pw-now">'+money(o.best)+'</span></div>';
      });
      h+='<div style="padding:12px 16px"><button class="btn-outline sm" data-act="orgtext">Copy a customer note</button></div>';
      h+='</div>';
    }
    h+='</div>';
  }
  if(rep.added.length){
    h+='<div class="band-group"><div class="band-head" style="cursor:default"><span class="band-title">New to the list</span><span class="band-counts">'+rep.added.length+'</span></div><div class="band-body">';
    rep.added.slice(0,state.showAll?9999:15).forEach(a=>{h+=plainHTML(a,false);});
    if(!state.showAll&&rep.added.length>15)h+='<div class="band-more">and '+(rep.added.length-15)+' more</div>';
    h+='</div></div>';
  }
  if(rep.gone.length){
    h+='<div class="band-group"><div class="band-head" style="cursor:default"><span class="band-title">No longer listed</span><span class="band-counts">'+rep.gone.length+'</span></div><div class="band-body">';
    rep.gone.slice(0,state.showAll?9999:15).forEach(a=>{h+=plainHTML(a,true);});
    if(!state.showAll&&rep.gone.length>15)h+='<div class="band-more">and '+(rep.gone.length-15)+' more</div>';
    h+='</div></div>';
  }
  h+='<div class="panel-actions" style="margin-top:6px">'+
    '<button class="btn-primary" data-act="csv">Export CSV</button>'+
    '<button class="btn-outline" data-act="text">Copy as text</button></div>';
  el.innerHTML=h;
}

function renderImport(){
  const el=document.getElementById("import-summary");
  el.innerHTML=state.dates.length?'<p class="stored-note">'+state.dates.length+' day'+
    (state.dates.length===1?"":"s")+' stored, '+pretty(state.dates[0])+' to '+pretty(state.dates[state.dates.length-1])+'.</p>':'';
}

function renderList(){
  const heading=document.getElementById("list-heading");
  const el=document.getElementById("list-body");
  const B=dayOf(state.newer);
  if(!B){ heading.textContent="Full list"; el.innerHTML='<div class="empty-state"><p>No list loaded yet.</p></div>'; return; }
  heading.textContent=pretty(state.newer)+" — "+Object.keys(B.groups).length+" products";
  const all=Object.keys(B.groups).map(k=>B.groups[k]).sort((a,b)=>a.desc.localeCompare(b.desc));
  const q=state.q.toUpperCase();
  const hits=q?all.filter(g=>g.desc.toUpperCase().indexOf(q)>=0):all;
  let h='<div class="band-group"><div class="band-body">';
  hits.slice(0,150).forEach(g=>{
    h+='<div class="pw-row pw-clickable" data-product="'+esc(g.key)+'"><div class="pw-name"><b>'+esc(g.desc)+'</b><div class="pw-spec">'+esc(specOf(g))+
      (g.offers.length>1?'  ·  '+g.offers.length+' growers':'')+'</div>'+
      originHTML(g.origins)+offersHTML(g.offers)+
      '</div><span class="pw-now">'+money(g.best)+'</span></div>';
  });
  h+='</div></div>';
  if(hits.length>150)h+='<p class="secondary" style="padding:10px 2px">Showing 150 of '+hits.length+'. Search to narrow it down.</p>';
  if(!hits.length)h='<div class="empty-state"><p>Nothing matching that.</p></div>';
  el.innerHTML=h;
}

function renderHistory(){
  const el=document.getElementById("history-body");
  if(!state.dates.length){ el.innerHTML='<div class="empty-state"><p>Nothing stored yet.</p></div>'; return; }
  let h='<div class="table-wrap"><table><thead><tr><th>Date</th><th>Products</th><th>File</th><th></th></tr></thead><tbody>';
  state.dates.slice().reverse().forEach(d=>{
    const day=dayOf(d);
    h+='<tr><td>'+pretty(d)+'</td><td class="num">'+(day?Object.keys(day.groups).length:"—")+'</td>'+
       '<td class="secondary">'+(day&&day.file?esc(day.file):"—")+'</td>'+
       '<td><button class="btn-outline sm" data-del="'+d+'">Remove</button></td></tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

function renderAll(){
  document.getElementById("band-limit").value=state.cfg.limit;
  document.getElementById("list-search").value=state.q;
  renderAlerts();
  renderChanges();
  renderImport();
  renderList();
  renderHistory();
  wireDynamic();
}

/* ------------------------------ tabs ------------------------------ */
function setActiveTab(tab){
  document.querySelectorAll(".tab-btn").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  document.querySelectorAll(".tab-panel").forEach(p=>p.classList.toggle("active",p.id==="tab-"+tab));
}

/* ------------------------------ wiring ----------------------------- */
function wireStatic(){
  document.querySelectorAll(".tab-btn").forEach(b=>{
    b.onclick=()=>{ setActiveTab(b.dataset.tab); state.showAll=false; state.asText=false; renderAll(); };
  });

  document.getElementById("list-search").oninput=e=>{
    const p=e.target.selectionStart; state.q=e.target.value; renderList(); wireDynamic();
    const s2=document.getElementById("list-search"); s2.focus(); s2.setSelectionRange(p,p);
  };

  document.getElementById("band-limit").onchange=e=>{
    const n=Number(e.target.value); if(!isNaN(n)){ state.cfg.limit=Math.max(0,n); put(CFG,state.cfg); renderChanges(); }
  };

  document.getElementById("backup-btn").onclick=exportArchive;
  document.getElementById("restore-btn").onclick=()=>document.getElementById("archive-input").click();
  document.getElementById("archive-input").onchange=e=>{ if(e.target.files[0])importArchive(e.target.files[0]); e.target.value=""; };

  const drop=document.getElementById("drop"), fileInput=document.getElementById("file-input");
  drop.onclick=()=>fileInput.click();
  fileInput.onchange=()=>{ if(fileInput.files[0])handleFile(fileInput.files[0]); fileInput.value=""; };
  ["dragenter","dragover"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add("over");}));
  ["dragleave","drop"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove("over");}));
  drop.addEventListener("drop",e=>{ const f=e.dataTransfer.files[0]; if(f)handleFile(f); });

  document.getElementById("product-overlay-close").onclick=closeProductOverlay;
  document.getElementById("product-overlay").addEventListener("click",e=>{
    if(e.target.id==="product-overlay")closeProductOverlay();
  });
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"&&!document.getElementById("product-overlay").classList.contains("hidden"))closeProductOverlay();
  });
}

function wireDynamic(){
  document.querySelectorAll("[data-goto]").forEach(b=>{b.onclick=()=>{ setActiveTab(b.dataset.goto); };});

  document.querySelectorAll("[data-product]").forEach(el=>{
    el.onclick=()=>openProductHistory(el.dataset.product);
  });

  document.querySelectorAll("[data-act]").forEach(b=>{b.onclick=()=>{
    const a=b.dataset.act;
    if(a==="dismiss")state.msg=null;
    else if(a==="showall")state.showAll=true;
    else if(a==="text")state.asText=true;
    else if(a==="untext")state.asText=false;
    else if(a==="csv"){exportCsv(buildReport());return;}
    else if(a==="orgtext"){
      const t=originNote(buildReport());
      const ta=document.createElement("textarea");
      ta.value=t; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      try{document.execCommand("copy");b.textContent="Copied";
        setTimeout(()=>{b.textContent="Copy a customer note";},1500);}catch(e){}
      document.body.removeChild(ta);
      return;
    }
    else if(a==="copy-report"){
      const ta=document.getElementById("report-ta"); ta.select();
      try{document.execCommand("copy");b.textContent="Copied";
        setTimeout(()=>{b.textContent="Copy to clipboard";},1500);}catch(e){}
      return;
    }
    renderAll();
  };});

  document.querySelectorAll("[data-set]").forEach(el=>{
    el.onchange=()=>{
      const k=el.dataset.set;
      if(k==="older"||k==="newer"){ state[k]=el.value; state.showAll=false; }
      else if(k==="sort"){ state.cfg.sort=el.value; put(CFG,state.cfg); }
      renderAll();
    };
  });

  document.querySelectorAll("[data-del]").forEach(b=>{b.onclick=()=>{
    const d=b.dataset.del;
    if(!confirm("Remove "+pretty(d)+"?"))return;
    uncacheDay(d);
    deleteDayFromCloud(d);
    if(state.newer===d||state.older===d){
      state.newer=state.dates[state.dates.length-1]||null;
      state.older=state.dates.length>=2?state.dates[state.dates.length-2]:null;
    }
    renderAll();
  };});

  document.querySelectorAll("[data-band]").forEach(el=>{el.onclick=()=>{
    const raw=el.dataset.band;
    const i=isNaN(Number(raw))?raw:Number(raw);
    const o=state.cfg.openBands.slice();
    const at=o.indexOf(i);
    if(at>=0)o.splice(at,1); else o.push(i);
    state.cfg.openBands=o; put(CFG,state.cfg); renderAll();
  };});
}

/* ------------------------------ login ------------------------------ */
const loginOverlay=document.getElementById("login-overlay");
const loginForm=document.getElementById("login-form");
const loginPasscode=document.getElementById("login-passcode");
const loginError=document.getElementById("login-error");
let booted=false;

function boot(){
  wireStatic();
  renderAll();
}

if(FIREBASE_CONFIGURED){
  loginForm.addEventListener("submit", async e=>{
    e.preventDefault();
    const btn=loginForm.querySelector("button");
    btn.disabled=true; loginError.textContent="";
    try{ await auth.signInWithEmailAndPassword(SHARED_LOGIN_EMAIL, loginPasscode.value); }
    catch(err){ loginError.textContent="Incorrect passcode."; }
    finally{ btn.disabled=false; }
  });
  auth.onAuthStateChanged(user=>{
    if(user){
      loginOverlay.classList.add("hidden");
      loginPasscode.value="";
      document.getElementById("sync-user").textContent="Synced";
      if(!booted){ booted=true; boot(); }
      subscribeDays();
    }else{
      loginOverlay.classList.remove("hidden");
      if(unsubscribeDays){ unsubscribeDays(); unsubscribeDays=null; }
    }
  });
}else{
  loginOverlay.classList.add("hidden");
  document.getElementById("sync-user").textContent="Local only";
  boot();
}
