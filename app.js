const COLS=['customers','loans','txns','capital','expenses','cashups','meetings','deposits','activity'];
const LS={get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
let session=LS.get('gapson.session',null);
let S={settings:{},customers:{},loans:{},txns:{},capital:{},expenses:{},cashups:{}};
Object.assign(S,LS.get('gapson.cache',{})); COLS.forEach(c=>{ if(!S[c]) S[c]={}; });
let POSONLY=location.hash==='#pos'||!!(session&&session.user.role==='collector');
let posMode=POSONLY?'round':'keypad', roundQ='', cashDate='', cashCounted='', cashNote='';
let outbox=LS.get('gapson.outbox',[]);
let me=session?session.user.id:'p1';
let db=null, dbTried=false, tab='home', flushing=false;
let custQuery='', custFilter='all', loanFilter='open', sheetMode=null;
const DEFAULT_TPL="{business}\nRECEIPT {receipt}\nDate: {date}\nCustomer: {customer}\n{type}: {amount}\n{balance}\nReceived by: {partner}\nThank you for doing business with us.";
const DEFAULT_EXP_TPL="{business}\nEXPENSE {receipt}\nDate: {date}\nFor: {note}\nAmount: {amount}\nPaid by: {partner}";

/* Speed: work each figure out once per data change instead of re-adding everything on every screen. */
let DV=0, _memo=new Map(), _idx=null;
const bump=()=>{ DV++; _memo.clear(); _idx=null; };
const memo=(name,fn)=>(x)=>{ const k=name+'|'+x; if(_memo.has(k)) return _memo.get(k); const v=fn(x); _memo.set(k,v); return v; };
function idx(){ if(_idx) return _idx; const byCid={}, repByLoan={}, loansByCid={};
  for(const t of Object.values(S.txns)){ (byCid[t.cid]=byCid[t.cid]||[]).push(t); if(t.kind==='repayment') repByLoan[t.loanId]=(repByLoan[t.loanId]||0)+num(t.amount); }
  for(const [id,l] of Object.entries(S.loans)) (loansByCid[l.cid]=loansByCid[l.cid]||[]).push(id);
  return _idx={byCid,repByLoan,loansByCid}; }
const persist=()=>{ bump(); LS.set('gapson.cache',S);LS.set('gapson.outbox',outbox)};
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const num=v=>{const n=parseFloat(v);return isFinite(n)?n:0};
const money=n=>'GH₵ '+num(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate=d=>{if(!d)return'—';const p=d.split('-');return `${+p[2]} ${MON[+p[1]-1]} ${p[0]}`};
const set_=()=>S.settings||{};
const pname=p=>{ if(p==='p1'||p==='p2') return set_()[p+'name']||(p==='p1'?'Partner 1':'Partner 2'); const c=(set_().collectors||[]).find(x=>x.id===p); return c?c.name:(session&&session.user.id===p?session.user.name:'Collector'); };
const people=()=>[{id:'p1',name:pname('p1'),role:'Partner'},{id:'p2',name:pname('p2'),role:'Partner'},...(set_().collectors||[]).map(c=>({id:c.id,name:c.name,role:'Collector'}))];
const meSelect=()=>`<div class="spread" style="font-size:15px;color:var(--ink)"><b>${esc(pname(me))}${session&&session.user.role==='collector'?' (Collector)':''}</b><button type="button" class="btn sm" data-act="logout">Log out</button></div>`;
const biz=()=>set_().business||'GAPSON SUSU ENT';
const initials=n=>String(n||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
const byDate=(a,b)=>(a.date||'').localeCompare(b.date||'')||((a.at||0)-(b.at||0));
const pad=(n,l=3)=>String(n).padStart(l,'0');
const $=s=>document.querySelector(s);

/* ---------- storage & sync (Google Sheets through Apps Script) ---------- */
const CFG=window.GAPSON_CONFIG||{};
let lastPull=0, syncErr='', since=LS.get('gapson.since',0), lastFull=LS.get('gapson.lastFull',0), roundCol='';
const isCollector=()=>!!(session&&session.user.role==='collector');
function save(col,id,data){
  if(typeof viewOnly==='function'&&viewOnly()) return toast('View only. '+pname(controller())+' controls the app.');
  data={...data};
  if(col==='settings') S.settings=data; else S[col][id]=data;
  outbox.push({op:'set',col,id,data}); persist(); render(); flush();
}
function removeDoc(col,id){ if(viewOnly()) return toast('View only. '+pname(controller())+' controls the app.'); delete S[col][id]; outbox.push({op:'del',col,id}); persist(); render(); flush(); }
function overlay(col,m){ for(const o of outbox){ if(o.col!==col)continue; if(o.op==='set')m[o.id]=o.data; else delete m[o.id]; } return m; }
async function api(body){
  const r=await fetch(CFG.SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body),redirect:'follow'});
  if(!r.ok) throw new Error('Server error '+r.status);
  const j=await r.json();
  if(!j.ok){ const e=new Error(j.error||'Server refused the request'); e.server=true; throw e; }
  return j;
}
/* full = whole book from the sheet; otherwise only the changes since the last sync. */
function applyServer(j,full){
  const data=j&&j.data; if(!data) return;
  const before=JSON.stringify([COLS.map(c=>full?S[c]:Object.keys(S[c]).length),S.settings]);
  const delta=!full&&COLS.some(c=>Object.keys(data[c]||{}).length);
  for(const col of COLS){
    const base=full?{}:{...S[col]};
    for(const [id,d] of Object.entries(data[col]||{})){ if(d&&d._deleted) delete base[id]; else base[id]=d; }
    S[col]=overlay(col,base);
  }
  if(j.custIds){ // collector: keep only the customers the sheet still gives them
    const ok=new Set(j.custIds), pending=new Set(outbox.filter(o=>o.col==='customers').map(o=>o.id));
    for(const id of Object.keys(S.customers)) if(!ok.has(id)&&!pending.has(id)) delete S.customers[id];
    for(const col of ['txns','loans']) for(const [id,d] of Object.entries(S[col])) if(d.cid&&!S.customers[d.cid]) delete S[col][id];
  }
  let s={...(data.settings||{})}; const p=outbox.filter(o=>o.col==='settings').pop(); if(p) s={...s,...p.data};
  S.settings=s;
  if(j.serverTime){ since=j.serverTime; LS.set('gapson.since',since); }
  if(full){ lastFull=Date.now(); LS.set('gapson.lastFull',lastFull); }
  lastPull=Date.now(); persist();
  const after=JSON.stringify([COLS.map(c=>full?S[c]:Object.keys(S[c]).length),S.settings]);
  if(delta||before!==after) render(); else syncPill();
}
async function flush(){
  if(!session||flushing||!navigator.onLine||!CFG.SCRIPT_URL){ syncPill(); return; }
  flushing=true; syncErr=''; syncPill();
  const who={user:session.user.id,pin:session.pin};
  try{
    while(outbox.length){
      const batch=outbox.slice(0,40), from=lastFull?since:0;
      const j=await api({...who,action:'push',ops:batch,since:from});
      outbox.splice(0,batch.length); persist();
      if(j.rejected&&j.rejected.length){ toast('Not saved: '+j.rejected[0].reason); lastFull=0; }
      applyServer(j,!from);
    }
    const needFull=!lastFull||Date.now()-lastFull>30*60000;
    if(needFull||Date.now()-lastPull>45000){
      const j=await api({...who,action:'pull',since:needFull?0:since});
      if(j.user){ session.user=j.user; LS.set('gapson.session',session); }
      applyServer(j,needFull);
    }
  }catch(e){
    syncErr=e.message||'Sync problem';
    if(e.server&&/PIN/i.test(e.message)) toast('Your PIN was changed. Log out and log in again.');
  }finally{ flushing=false; syncPill(); }
}
function syncPill(){
  const el=$('#sync'); if(!el) return; const n=outbox.length; el.title='';
  if(!session){ el.className='sync'; el.textContent='Not logged in'; return; }
  if(!navigator.onLine){ el.className='sync wait'; el.textContent=n?`Offline · ${n} to sync`:'Offline'; return; }
  if(syncErr){ el.className='sync wait'; el.textContent=n?`${n} waiting · retrying`:'Sync problem'; el.title=syncErr; return; }
  if(n){ el.className='sync wait'; el.textContent=`Syncing ${n}…`; return; }
  el.className='sync ok'; el.textContent='Synced';
}
addEventListener('online',()=>flush()); addEventListener('offline',syncPill); setInterval(flush,20000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ lastPull=0; if(Date.now()-lastFull>10*60000) lastFull=0; flush(); } });
function viewLogin(){
  if(!CFG.SCRIPT_URL||/PASTE/.test(CFG.SCRIPT_URL)) return `<div class="section"><h2>Almost ready</h2><div class="card">Open <b>config.js</b> and paste your Apps Script web app link. The README explains it in step 5.</div></div>`;
  return `<form id="loginForm" class="section" style="max-width:420px;margin:24px auto">
   <div style="display:grid;justify-items:center;gap:8px;text-align:center"><svg class="logo" style="width:76px;height:76px" aria-hidden="true"><use href="#logo"/></svg><h2>${esc(biz())}</h2><p class="muted small" style="margin:0">Log in with your name and PIN. You need internet the first time only.</p></div>
   <label>Your name<input id="l_user" autocomplete="username" required></label>
   <label>PIN<input id="l_pin" type="password" inputmode="numeric" autocomplete="current-password" required></label>
   <button class="btn pri block" type="submit">Log in</button>
   <p class="small" id="l_msg" style="margin:0;color:var(--bad)"></p></form>`;
}
function doLogin(){
  const user=$('#l_user').value.trim(), pin=$('#l_pin').value.trim(), msg=$('#l_msg'); msg.textContent='Checking…';
  api({action:'pull',user,pin,since:0}).then(j=>{
    session={user:j.user,pin}; LS.set('gapson.session',session); me=j.user.id; outbox=[];
    applyServer(j,true); POSONLY=location.hash==='#pos'||j.user.role==='collector'; posMode=POSONLY?'round':'keypad'; applyMode();
  }).catch(err=>{ msg.textContent=!navigator.onLine?'You need internet to log in the first time.':(err.server?err.message:'Could not reach the server. Check the link in config.js and your internet.'); });
}
function doLogout(){
  session=null; me='p1'; outbox=[]; S={settings:{}}; COLS.forEach(c=>S[c]={});
  since=0; lastFull=0; try{ ['gapson.session','gapson.cache','gapson.outbox','gapson.since','gapson.lastFull'].forEach(k=>localStorage.removeItem(k)); }catch(e){}
  closeSheet(); tab='home'; $('#view').innerHTML=''; render();
}
setTimeout(flush,300);

/* ---------- business maths ---------- */
const commissionOf=memo('com',function(cid){
  const c=S.customers[cid]||{}; const months={};
  for(const t of (idx().byCid[cid]||[])) if(t.kind==='contribution'){ const m=(t.date||'').slice(0,7); (months[m]=months[m]||[]).push(t); }
  let total=0; const byMonth={};
  for(const [m,list] of Object.entries(months)){ list.sort(byDate); const sum=list.reduce((s,t)=>s+num(t.amount),0); const k=Math.min(num(c.daily)||num(list[0].amount),sum); byMonth[m]=k; total+=k; }
  return {total,byMonth};
});
const loanStats=memo('loan',function(id){
  const l=S.loans[id]||{}; const amount=num(l.amount), rate=num(l.rate), interest=amount*rate/100, total=amount+interest;
  const paid=idx().repByLoan[id]||0;
  const remaining=total-paid;
  const status=remaining<-0.005?'Overpaid':remaining<=0.005?'Paid':(l.due&&l.due<today()?'Overdue':'Owing');
  return {id,...l,amount,rate,interest,total,paid,remaining,status,intRecv:total>0?Math.min(paid,total)*interest/total:0};
});
const custStats=memo('cust',function(cid){
  let paid=0,wd=0;
  for(const t of (idx().byCid[cid]||[])){ if(t.kind==='contribution')paid+=num(t.amount); else if(t.kind==='withdrawal')wd+=num(t.amount); }
  const com=commissionOf(cid).total;
  const loans=(idx().loansByCid[cid]||[]).map(id=>loanStats(id));
  return {paid,wd,com,balance:paid-wd-com,owing:loans.reduce((s,l)=>s+Math.max(0,l.remaining),0),loans};
});
const totals=memo('tot',function(){
  const T={contrib:0,wd:0,loansOut:0,repaid:0,capital:0,exp:0,com:0,intRecv:0,outstanding:0,overdue:0,active:0,cap:{p1:0,p2:0},todayIn:0,monthIn:0};
  const td=today(), tm=td.slice(0,7);
  for(const t of Object.values(S.txns)){ const a=num(t.amount);
    if(t.kind==='contribution'){T.contrib+=a; if(t.date===td)T.todayIn+=a; if((t.date||'').startsWith(tm))T.monthIn+=a;}
    else if(t.kind==='withdrawal')T.wd+=a; else if(t.kind==='repayment'){T.repaid+=a; if(t.date===td)T.todayIn+=a; if((t.date||'').startsWith(tm))T.monthIn+=a;} }
  for(const id of Object.keys(S.loans)){ const L=loanStats(id); T.loansOut+=L.amount; T.intRecv+=L.intRecv; if(L.remaining>0.005){T.outstanding+=L.remaining;T.active++;} if(L.status==='Overdue')T.overdue++; }
  for(const c of Object.values(S.capital)){ const a=num(c.amount); T.capital+=a; if(c.partner in T.cap)T.cap[c.partner]+=a; }
  for(const e of Object.values(S.expenses)) T.exp+=num(e.amount);
  for(const cid of Object.keys(S.customers)) T.com+=commissionOf(cid).total;
  T.cash=T.capital+T.contrib-T.wd-T.loansOut+T.repaid-T.exp;
  T.bank=bankTotals().total; T.inHand=T.cash-T.bank;
  T.owedCust=T.contrib-T.wd-T.com;
  T.profit=T.com+T.intRecv-T.exp;
  T.share=shares(T.cap);
  return T;
});
function shares(cap){
  const s=set_();
  if(s.shareMode==='fixed'){ const a=Math.min(100,Math.max(0,num(s.p1pct??50))); return {p1:a/100,p2:(100-a)/100,mode:'fixed'}; }
  const tot=cap.p1+cap.p2; return {p1:tot>0?cap.p1/tot:.5,p2:tot>0?cap.p2/tot:.5,mode:'capital'};
}
const monthly=memo('mon',function(n){ n=n||6;
  const out=[]; const d=new Date(); d.setDate(1);
  for(let i=n-1;i>=0;i--){ const x=new Date(d.getFullYear(),d.getMonth()-i,1); out.push({m:x.getFullYear()+'-'+pad(x.getMonth()+1,2),label:MON[x.getMonth()],com:0,int:0,exp:0}); }
  const idx=Object.fromEntries(out.map((o,i)=>[o.m,i]));
  for(const cid of Object.keys(S.customers)){ const bm=commissionOf(cid).byMonth; for(const m in bm) if(m in idx) out[idx[m]].com+=bm[m]; }
  const ls={}; for(const id of Object.keys(S.loans)) ls[id]=loanStats(id);
  for(const t of Object.values(S.txns)) if(t.kind==='repayment'&&ls[t.loanId]){ const m=(t.date||'').slice(0,7); if(m in idx){ const L=ls[t.loanId]; out[idx[m]].int+=L.total>0?num(t.amount)*L.interest/L.total:0; } }
  for(const e of Object.values(S.expenses)){ const m=(e.date||'').slice(0,7); if(m in idx) out[idx[m]].exp+=num(e.amount); }
  out.forEach(o=>o.profit=o.com+o.int-o.exp); return out;
});
const custList=()=>Object.entries(S.customers).map(([id,c])=>({id,...c})).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
const hasExamples=()=>[...COLS.map(c=>Object.values(S[c]))].flat().some(d=>d&&d.ex);
const statusPill=s=>`<span class="pill ${s==='Paid'?'good':s==='Overdue'||s==='Overpaid'?'bad':'warn'}">${s}</span>`;
const KIND={contribution:'Susu payment',withdrawal:'Susu withdrawal',loan:'Loan given',repayment:'Loan repayment'};

/* ---------- views ---------- */
function render(){
  bump();
  if(!session){ document.body.classList.add('posonly'); $('#view').innerHTML=viewLogin(); syncPill(); return; }
  document.body.classList.toggle('viewonly',viewOnly()); if(viewOnly()&&tab==='pos'){ tab='home'; $('#view').innerHTML=''; }
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  const v=$('#view');
  setNavLabels();
  if(tab==='home') v.innerHTML=loansMode()?viewHomeLoans():viewHome();
  else if(tab==='customers'&&loansMode()){ if(!v.querySelector('#borSearch')) v.innerHTML=viewBorrowers(); drawBorrowers(); }
  else if(tab==='customers'){ if(!v.querySelector('#custSearch')) v.innerHTML=viewCustomers(); else v.querySelectorAll('[data-cf]').forEach(b=>b.classList.toggle('on',b.dataset.cf===custFilter)); drawCustList(); }
  else if(tab==='partners'&&document.activeElement&&document.activeElement.closest&&document.activeElement.closest('#setForm')){ /* keep the form while someone is typing */ }
  else if(tab==='pos'&&loansMode()&&lendTab!=='other'){ if(!v.querySelector('#lendRoot')){ v.innerHTML=viewLend(); lendDraw(); } }
  else if(tab==='pos'){ if(!v.querySelector('#posRoot')){ v.innerHTML=viewPOS(); posDraw(); } else if(posMode==='keypad') posRefreshSelects(); else if(posMode==='round') drawRound(); else if(!(document.activeElement&&document.activeElement.closest&&document.activeElement.closest('#posBody'))) cashDraw(); }
  else if(tab==='loans') v.innerHTML=viewLoans();
  else if(tab==='partners') v.innerHTML=viewPartners();
  if(sheetMode&&sheetMode.live) sheetMode.live();
  syncPill();
}
function viewHome(){
  const T=totals(), M=monthly(); const maxv=Math.max(1,...M.map(o=>Math.abs(o.profit)));
  const recent=[...Object.entries(S.txns).map(([id,t])=>({id,...t,_c:'txn'})),...Object.entries(S.expenses).map(([id,e])=>({id,...e,kind:'expense'})),...Object.entries(S.capital).map(([id,c])=>({id,...c,kind:'capital'}))].sort(byDate).reverse().slice(0,8);
  return `
  ${viewOnly()?`<div class="banner" style="margin-bottom:14px">&#128274; View only. ${esc(pname(controller()))} controls the app. You can see everything but not record or change.</div>`:''}
  ${!isCollector()&&nextMeeting()?`<div style="margin-bottom:14px">${mtCard(nextMeeting(),true)}</div>`:''}
  ${hasExamples()?`<div class="banner" style="margin-bottom:14px">Entries marked EXAMPLE are practice data. Remove them in Partners → Settings when you start for real.</div>`:''}
  <div class="section">
    <div class="hero"><span class="lbl">Cash with the business</span><span class="big num">${money(T.cash)}</span>
    <span class="sub">In hand <b class="num">${money(T.inHand)}</b> · Bank/MoMo <b class="num">${money(T.bank)}</b></span>
    <span class="sub" style="opacity:.7">Partners' money + susu in − payouts − loans out + repayments − expenses</span></div>
    <div class="stats">
      <div class="stat"><span class="k">Profit so far</span><span class="v ${T.profit<0?'bad':''}">${money(T.profit)}</span></div>
      <div class="stat"><span class="k">Collected today</span><span class="v">${money(T.todayIn)}</span></div>
      <div class="stat"><span class="k">Owed to susu customers</span><span class="v">${money(T.owedCust)}</span></div>
      <div class="stat"><span class="k">Loans still owed</span><span class="v">${money(T.outstanding)}</span></div>
      <div class="stat"><span class="k">Commission earned</span><span class="v">${money(T.com)}</span></div>
      <div class="stat"><span class="k">Overdue loans</span><span class="v ${T.overdue?'bad':''}">${T.overdue}</span></div>
    </div>
  </div>
  <div class="section"><div class="spread"><h2>Partner shares</h2><button class="btn sm" data-tab="partners">Details</button></div>
    <div class="card" style="display:grid;gap:10px">
      <div class="split"><span style="width:${(T.share.p1*100).toFixed(1)}%"></span><span style="width:${(T.share.p2*100).toFixed(1)}%"></span></div>
      <div class="spread small"><span><i class="dot" style="background:var(--brand)"></i>${esc(pname('p1'))} · ${(T.share.p1*100).toFixed(0)}% · <b class="num">${money(T.profit*T.share.p1)}</b></span></div>
      <div class="spread small"><span><i class="dot" style="background:var(--gold)"></i>${esc(pname('p2'))} · ${(T.share.p2*100).toFixed(0)}% · <b class="num">${money(T.profit*T.share.p2)}</b></span></div>
    </div></div>
  <div class="section"><h2>Profit by month</h2>
    <div class="card bars">${M.map(o=>`<div class="bar"><span class="muted">${o.label}</span><div class="track"><div class="fill ${o.profit<0?'neg':''}" style="width:${(Math.abs(o.profit)/maxv*100).toFixed(1)}%"></div></div><span class="num">${money(o.profit)}</span></div>`).join('')}
    <p class="small muted" style="margin:4px 0 0">Profit = commission + loan interest received − expenses.</p></div></div>
  ${followUp()}
  <div class="section"><div class="spread"><h2>Recent activity</h2><button class="btn sm gold" data-tab="pos">+ Record</button></div>
    <div class="list">${recent.length?recent.map(activityRow).join(''):`<div class="empty">Nothing recorded yet. Tap <b>Record</b> to add a susu payment, loan or expense.</div>`}</div></div>`;
}
function activityRow(r){
  let title, sub, amt=money(r.amount), cls='';
  if(r.kind==='expense'){ title='Expense · '+esc(r.note||''); cls='color:var(--bad)'; amt='− '+amt; }
  else if(r.kind==='capital'){ title=(num(r.amount)<0?'Capital taken out · ':'Capital put in · ')+esc(pname(r.partner)); }
  else { const c=S.customers[r.cid]; title=esc(KIND[r.kind]||r.kind)+' · '+esc(c?c.name:'(deleted customer)'); if(r.kind==='withdrawal'||r.kind==='loan'){cls='color:var(--bad)';amt='− '+amt;} }
  sub=fmtDate(r.date)+(r.by?' · by '+esc(pname(r.by)):'');
  return `<div class="item"><div class="main"><div class="t">${title} ${r.ex?'<span class="pill gold">Example</span>':''}</div><div class="s">${sub}</div></div><div class="amt" style="${cls}">${amt}</div></div>`;
}
function viewCustomers(){
  return `<div class="section"><div class="spread"><h2>Customers</h2><button class="btn sm pri" data-act="newCust">+ New customer</button></div>
  <input id="custSearch" type="search" placeholder="Search name or phone" value="${esc(custQuery)}" aria-label="Search customers">
  <div class="chips">${[['all','All'],['susu','Susu'],['loan','Borrowers']].map(([k,l])=>`<button class="chip ${custFilter===k?'on':''}" data-cf="${k}">${l}</button>`).join('')}</div>
  <div class="list" id="custList"></div></div>`;
}
function drawCustList(){
  const q=custQuery.toLowerCase().trim();
  const rows=custList().filter(c=>(!q||(c.name||'').toLowerCase().includes(q)||(c.phone||'').replace(/\s/g,'').includes(q.replace(/\s/g,'')))&&(custFilter==='all'||(custFilter==='susu'?c.type!=='loan':c.type!=='susu')));
  const el=$('#custList'); if(!el)return;
  el.innerHTML=rows.length?rows.map(c=>{ const st=custStats(c.id); return `<button class="item" data-act="openCust" data-id="${c.id}"><span class="av">${esc(initials(c.name))}</span><span class="main"><span class="t">${esc(c.name)} ${c.ex?'<span class="pill gold">Example</span>':''}</span><span class="s" style="display:block">${esc(c.no||'')} · ${esc(c.phone||'no phone')}${c.collector?' · '+esc(pname(c.collector)):''}</span></span><span class="amt">${money(st.balance)}${st.owing>0?`<span class="s" style="display:block;color:var(--bad)">owes ${money(st.owing)}</span>`:''}</span></button>`; }).join('')
    :`<div class="empty">${Object.keys(S.customers).length?'No customer matches that search.':'No customers yet. Tap <b>+ New customer</b> to enrol the first one.'}</div>`;
}
function viewLoans(){
  const all=Object.keys(S.loans).map(loanStats).sort(byDate).reverse(); const T=totals();
  const rows=all.filter(l=>loanFilter==='all'||(loanFilter==='open'?(l.status==='Owing'||l.status==='Overdue'):loanFilter==='overdue'?l.status==='Overdue':(l.status==='Paid'||l.status==='Overpaid')));
  return `<div class="section"><div class="spread"><h2>Loans</h2><button class="btn sm pri" data-act="pos" data-kind="loan">+ New loan</button></div>
  <div class="stats"><div class="stat"><span class="k">Given out</span><span class="v">${money(T.loansOut)}</span></div><div class="stat"><span class="k">Still owed</span><span class="v">${money(T.outstanding)}</span></div>
  <div class="stat"><span class="k">Interest received</span><span class="v">${money(T.intRecv)}</span></div><div class="stat"><span class="k">Overdue</span><span class="v ${T.overdue?'bad':''}">${T.overdue}</span></div></div>
  ${loansDue().length?`<div class="spread"><h3>Due in 7 days or overdue</h3></div><div class="list">${loansDue().map(dueRow).join('')}</div>`:''}
  <div class="chips">${[['open','Owing'],['overdue','Overdue'],['done','Paid'],['all','All']].map(([k,l])=>`<button class="chip ${loanFilter===k?'on':''}" data-lf="${k}">${l}</button>`).join('')}</div>
  <div class="list">${rows.length?rows.map(l=>{const c=S.customers[l.cid];return `<button class="item" data-act="openCust" data-id="${l.cid}"><span class="main"><span class="t">${esc(c?c.name:'(deleted)')} · ${esc(l.no||'')} ${l.ex?'<span class="pill gold">Example</span>':''}</span><span class="s" style="display:block">${money(l.amount)} at ${l.rate}% · due ${fmtDate(l.due)}</span></span><span class="amt">${money(Math.max(0,l.remaining))}<span style="display:block;margin-top:3px">${statusPill(l.status)}</span></span></button>`}).join(''):`<div class="empty">No loans in this list.</div>`}</div></div>`;
}
function viewPartners(){
  const T=totals(), s=set_(); const capRows=Object.entries(S.capital).map(([id,c])=>({id,...c})).sort(byDate).reverse();
  const expRows=Object.entries(S.expenses).map(([id,e])=>({id,...e})).sort(byDate).reverse();
  const card=p=>`<div class="card" style="display:grid;gap:6px;border-top:4px solid ${p==='p1'?'var(--brand)':'var(--gold)'}">
     <div class="spread"><h3>${esc(pname(p))}</h3><span class="pill">${(T.share[p]*100).toFixed(1)}%</span></div>
     <div class="spread small"><span class="muted">Money put in</span><b class="num">${money(T.cap[p])}</b></div>
     <div class="spread small"><span class="muted">Share of profit</span><b class="num">${money(T.profit*T.share[p])}</b></div>
     <div class="spread small"><span class="muted">Entries recorded</span><b class="num">${[...Object.values(S.txns),...Object.values(S.expenses)].filter(x=>x.by===p).length}</b></div></div>`;
  return `<div class="section"><h2>Partners</h2>
   <div class="grid2">${card('p1')}${card('p2')}</div>
   <div class="card small muted">Profit split: <b style="color:var(--ink)">${T.share.mode==='fixed'?`fixed ${(T.share.p1*100).toFixed(0)} / ${(T.share.p2*100).toFixed(0)}`:'by money each partner put in'}</b>. Total profit ${money(T.profit)} = commission ${money(T.com)} + interest ${money(T.intRecv)} − expenses ${money(T.exp)}. Change the split in Settings below.</div>
  </div>
  ${meetingsSection()}
  ${bankSection()}
  ${activitySection()}
  <div class="section"><div class="spread"><h2>Money put in</h2><button class="btn sm pri" data-act="pos" data-kind="capital">+ Add</button></div>
   <div class="list">${capRows.length?capRows.map(c=>rowWithDelete(`${esc(pname(c.partner))} ${c.ex?'<span class="pill gold">Example</span>':''}`,`${fmtDate(c.date)} · ${esc(c.note||'')}`,money(c.amount),'capital',c.id)).join(''):`<div class="empty">Record the money each partner puts into the business here.</div>`}</div></div>
  <div class="section"><div class="spread"><h2>Expenses</h2><button class="btn sm pri" data-act="pos" data-kind="expense">+ Add</button></div>
   <div class="list">${expRows.length?expRows.map(e=>rowWithDelete(`${esc(e.note||'Expense')} ${e.ex?'<span class="pill gold">Example</span>':''}`,`${fmtDate(e.date)} · paid by ${esc(pname(e.by))}`,money(e.amount),'expenses',e.id,'exp')).join(''):`<div class="empty">No expenses yet. Transport, books, airtime and other costs go here.</div>`}</div></div>
  <div class="section"><h2>Collectors</h2>
   <div class="list">${(s.collectors||[]).length?(s.collectors||[]).map(c=>{ const td=today(), tm=td.slice(0,7); let d=0,m=0; for(const t of Object.values(S.txns)) if(t.by===c.id&&(t.kind==='contribution'||t.kind==='repayment')){ if(t.date===td)d+=num(t.amount); if((t.date||'').startsWith(tm))m+=num(t.amount); }
     return `<div class="item"><span class="av">${esc(initials(c.name))}</span><div class="main"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.phone||'no phone')} · today ${money(d)} · this month ${money(m)}</div></div><button class="btn sm danger" data-act="delCollector" data-id="${c.id}">Remove</button></div>`; }).join(''):'<div class="empty">No collectors yet. Add the people who collect susu for you.</div>'}</div>
   <div class="card" style="display:grid;gap:10px"><div class="grid2"><label>Collector name<input id="col_name"></label><label>Phone<input id="col_phone" inputmode="tel"></label></div><label>PIN for logging in (4–6 digits)<input id="col_pin" inputmode="numeric"></label><button class="btn pri" data-act="addCollector">Add collector</button>
   <p class="small muted" style="margin:0">Collectors log in with their name and PIN. They only see the POS, and the sheet only sends them what they need.</p></div>
  </div>
  <div class="section susu-only"><div class="spread"><h2>Cash-ups</h2><button class="btn sm" data-act="pos-cash">Do cash-up</button></div>
   <div class="list">${Object.entries(S.cashups).map(([k,c])=>({id:k,...c})).sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,10).map(c=>`<div class="item"><div class="main"><div class="t">${esc(pname(c.person))} · ${fmtDate(c.date)}</div><div class="s">Expected ${money(c.expected)} · counted ${money(c.counted)}${c.note?' · '+esc(c.note):''}</div></div>${cashStatus(num(c.diff))}</div>`).join('')||'<div class="empty">End-of-day cash counts from partners and collectors show here.</div>'}</div></div>
  <div class="section"><h2>Settings</h2>
   ${lockCard()}
   ${backupCard()}
   <form class="card" id="setForm" style="display:grid;gap:12px">
    <label>App type<select id="s_mode"><option value="loans" ${(s.mode||'loans')==='loans'?'selected':''}>Loans only (simple)</option><option value="susu" ${s.mode==='susu'?'selected':''}>Susu + Loans (full)</option></select></label>
    <label>Business name<input id="s_business" value="${esc(s.business||'GAPSON SUSU ENT')}"></label>
    <div class="grid2"><label>Partner 1 name<input id="s_p1name" value="${esc(s.p1name||'')}" placeholder="Partner 1"></label><label>Partner 1 phone<input id="s_p1phone" inputmode="tel" value="${esc(s.p1phone||'')}"></label>
    <label>Partner 2 name<input id="s_p2name" value="${esc(s.p2name||'')}" placeholder="Partner 2"></label><label>Partner 2 phone<input id="s_p2phone" inputmode="tel" value="${esc(s.p2phone||'')}"></label></div>
    <div class="grid2"><label>How profit is shared<select id="s_shareMode"><option value="capital" ${s.shareMode!=='fixed'?'selected':''}>By money each put in</option><option value="fixed" ${s.shareMode==='fixed'?'selected':''}>Fixed percentage</option></select></label>
    <label>Partner 1 % (if fixed)<input id="s_p1pct" type="number" min="0" max="100" step="1" value="${esc(s.p1pct??50)}"></label></div>
    <div class="grid2"><label>Default loan interest %<input id="s_rate" type="number" min="0" step="0.5" value="${esc(s.rate??10)}"></label>
    <label>Missed payment alert after (days)<input id="s_missDays" type="number" min="1" step="1" value="${esc(s.missDays||2)}"></label></div>
    <label>Receipt message (customers)<textarea id="s_tpl">${esc(s.tpl||DEFAULT_TPL)}</textarea></label>
    <label>Expense message (to partner)<textarea id="s_exptpl" style="min-height:90px">${esc(s.exptpl||DEFAULT_EXP_TPL)}</textarea></label>
    <p class="small muted" style="margin:0">Words in {brackets} fill themselves: {business} {receipt} {date} {customer} {type} {amount} {balance} {partner} {note}</p>
    <button class="btn pri block" type="submit">Save settings</button>
   </form>
   <div class="card" style="display:grid;gap:10px">
    <div class="small muted" style="display:grid;gap:6px;font-weight:600">Logged in as ${meSelect()}</div>
    <p class="small muted" style="margin:0">Everything you record is marked with your name. PINs are changed in the Users sheet.</p>
   </div>
   <div class="card small muted susu-only" style="display:grid;gap:6px"><b style="color:var(--ink)">Commission rule</b>One day's contribution per customer per month. The app uses the customer's daily amount, or their first payment that month if no daily amount is set.</div>
   ${hasExamples()?`<button class="btn danger block" data-act="clearEx">Remove all example entries</button>`:''}
  </div>`;
}
/* Entries are locked to whoever recorded them. Customers and settings are shared. */
const LOCKED=['txns','loans','expenses','capital','cashups','deposits'];
const ownerOf=(col,d)=>!d?'':col==='cashups'?d.person:(d.by||(col==='capital'?d.partner:''));
const mineDoc=(col,id)=>{ if(!LOCKED.includes(col)) return true; const o=ownerOf(col,S[col][id]); return !o||o===me; };
const lockPill=(col,id)=>`<span class="pill" title="Only ${esc(pname(ownerOf(col,S[col][id])))} can change this">&#128274; ${esc(pname(ownerOf(col,S[col][id])))}</span>`;
const delBtn=(col,id,label='Delete')=>mineDoc(col,id)?`<button class="btn sm danger" data-act="del" data-col="${col}" data-id="${id}">${label}</button>`:lockPill(col,id);
function rowWithDelete(t,s,amt,col,id,kind){
  return `<div class="item"><div class="main"><div class="t">${t}</div><div class="s">${s}</div></div><div class="amt">${amt}</div>${kind==='exp'?`<button class="btn sm" data-act="shareExp" data-id="${id}" aria-label="Send">Send</button>`:''}${delBtn(col,id)}</div>`;
}

/* ---------- POS ---------- */
let pos={kind:'contribution',amt:'',cid:'',loanId:''};
const POSKINDS=[['contribution','Susu pay'],['withdrawal','Withdraw'],['repayment','Loan pay'],['loan','New loan'],['expense','Expense'],['bank','Bank/MoMo'],['capital','Capital']];
const posKinds=()=>{ let k=POSONLY?POSKINDS.filter(([x])=>x!=='loan'&&x!=='capital'):POSKINDS; if(loansMode()) k=k.filter(([x])=>x!=='contribution'&&x!=='withdrawal'); return k; };
function viewPOS(){
  return `<div id="posRoot" class="section">
   <div class="spread"><h2>${POSONLY?'Point of sale':'Record'}</h2></div>
   <div class="small muted" style="display:grid;gap:6px;font-weight:600">Recording as ${meSelect()}</div>
   <div class="seg">${[['round','Daily round'],['keypad','Keypad'],['cashup','Cash-up']].map(([k,l])=>`<button class="segb ${posMode===k?'on':''}" data-pm="${k}">${l}</button>`).join('')}</div>
   <div id="posBody" style="display:grid;gap:12px"></div></div>`;
}
function posDraw(){
  document.querySelectorAll('.segb').forEach(b=>b.classList.toggle('on',b.dataset.pm===posMode));
  if(posMode==='round') roundDraw(); else if(posMode==='cashup') cashDraw(); else { $('#posBody').innerHTML=keypadHTML(); keypadDraw(); }
}
function keypadHTML(){
  if(!posKinds().some(([k])=>k===pos.kind)) pos.kind=posKinds()[0][0];
  return `<div class="kinds">${posKinds().map(([k,l])=>`<button class="kind ${pos.kind===k?'on':''}" data-pk="${k}">${l}</button>`).join('')}</div>
   <div id="posWho"></div>
   <div class="display"><span class="lbl" id="posLbl"></span><span class="amt" id="posAmt"></span><span class="small" id="posHint" style="opacity:.75"></span></div>
   <div class="quick">${[5,10,20,50].map(n=>`<button class="key" data-q="${n}">+${n}</button>`).join('')}</div>
   <div class="keys">${['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k=>`<button class="key" data-k="${k}">${k}</button>`).join('')}</div>
   <div id="posExtra" style="display:grid;gap:10px"></div>
   <button class="btn pri block" data-act="posSave" style="padding:16px;font-size:17px">Save</button>`;
}

/* ---------- daily round ---------- */
function todayPaid(){ const td=today(), m={}; for(const [id,t] of Object.entries(S.txns)) if(t.kind==='contribution'&&t.date===td) (m[t.cid]=m[t.cid]||[]).push({id,...t}); for(const k in m) m[k].sort(byDate); return m; }
function roundDraw(){
  const cols=set_().collectors||[];
  $('#posBody').innerHTML=`${!isCollector()&&cols.length?`<label>Show customers of<select id="roundCol"><option value="">Everyone</option><option value="none" ${roundCol==='none'?'selected':''}>No collector</option>${cols.map(k=>`<option value="${esc(k.id)}" ${roundCol===k.id?'selected':''}>${esc(k.name)}</option>`).join('')}</select></label>`:''}<div class="card" id="roundSum" style="display:grid;gap:8px"></div>
   <div class="row" style="flex-wrap:nowrap"><input id="roundSearch" type="search" placeholder="Search customer" value="${esc(roundQ)}" aria-label="Search customers" style="flex:1"><button class="btn sm" data-act="newCust" style="flex:none">+ New</button></div>
   <div class="list" id="roundList"></div>`;
  drawRound();
}
function drawRound(){
  const sumEl=$('#roundSum'), listEl=$('#roundList'); if(!sumEl||!listEl) return;
  const paid=todayPaid(), list=custList().filter(c=>c.type!=='loan'&&(isCollector()||!roundCol||(roundCol==='none'?!c.collector:c.collector===roundCol)));
  const n=list.filter(c=>paid[c.id]).length, all=Object.values(paid).flat();
  const total=all.reduce((s,t)=>s+num(t.amount),0), mine=all.filter(t=>t.by===me).reduce((s,t)=>s+num(t.amount),0);
  const pct=list.length?n/list.length*100:0;
  sumEl.innerHTML=`<div class="spread"><b>${n} of ${list.length} paid today</b><b class="num">${money(total)}</b></div>
   <div class="split"><span style="width:${pct.toFixed(1)}%"></span><span style="width:0"></span></div>
   <div class="small muted">You (${esc(pname(me))}) collected <b class="num" style="color:var(--ink)">${money(mine)}</b> today. Tap a name's button to record their usual daily amount.</div>`;
  const q=roundQ.toLowerCase().trim();
  const rows=list.filter(c=>!q||(c.name||'').toLowerCase().includes(q)||(c.phone||'').replace(/\s/g,'').includes(q.replace(/\s/g,'')))
    .sort((a,b)=>(!!paid[a.id]-!!paid[b.id])||(a.name||'').localeCompare(b.name||''));
  listEl.innerHTML=rows.length?rows.map(c=>{
    const p=paid[c.id], d=num(c.daily);
    const right=p?`<span class="pill good">Paid ${money(p.reduce((s,t)=>s+num(t.amount),0))}</span><button class="btn sm" data-act="resend" data-id="${p[p.length-1].id}">Send</button>${delBtn('txns',p[p.length-1].id,'Undo')}`
      :(d?`<button class="btn sm pri" data-act="collect" data-id="${c.id}">Collect ${money(d)}</button>`:'')+`<button class="btn sm" data-act="other" data-id="${c.id}">${d?'Other':'Enter amount'}</button>`+(missedInfo(c).days>=missLimit()?`<button class="btn sm" data-act="missRemind" data-id="${c.id}">Remind</button>`:'');
    return `<div class="item" style="flex-wrap:wrap"><span class="av">${esc(initials(c.name))}</span><div class="main"><div class="t">${esc(c.name)} ${c.ex?'<span class="pill gold">Example</span>':''}</div><div class="s">${esc(c.no||'')} · ${d?'daily '+money(d):'no daily amount set'} · balance ${money(custStats(c.id).balance)}${(()=>{const i=missedInfo(c);return !p&&i.days>=missLimit()?` · <b style="color:var(--bad)">missed ${i.days} days</b>`:''})()}</div></div><div class="row" style="justify-content:flex-end;flex:1 1 100%;padding-left:48px">${right}</div></div>`;
  }).join(''):`<div class="empty">${list.length?'No customer matches that search.':'No susu customers yet. Tap <b>+ New</b> to enrol one.'}</div>`;
}
function collect(cid){
  const c=S.customers[cid]; if(!c) return; if(todayPaid()[cid]) return toast(c.name+' has already paid today.');
  const id=uid(); save('txns',id,{kind:'contribution',cid,amount:num(c.daily),date:today(),note:'',by:me,at:Date.now()});
  toast(`${c.name}: ${money(c.daily)} collected`);
}

/* ---------- cash-up ---------- */
function expectedFor(person,date){
  const r={susu:0,repay:0,wd:0,loans:0,exp:0,dep:0,bw:0};
  for(const t of Object.values(S.txns)) if(t.by===person&&t.date===date){ const a=num(t.amount); if(t.kind==='contribution')r.susu+=a; else if(t.kind==='repayment')r.repay+=a; else if(t.kind==='withdrawal')r.wd+=a; }
  for(const l of Object.values(S.loans)) if(l.by===person&&l.date===date) r.loans+=num(l.amount);
  for(const e of Object.values(S.expenses)) if(e.by===person&&e.date===date) r.exp+=num(e.amount);
  for(const d of Object.values(S.deposits)) if(d.by===person&&d.date===date){ if(d.type==='withdraw') r.bw+=num(d.amount); else r.dep+=num(d.amount); }
  r.expected=r.susu+r.repay-r.wd-r.loans-r.exp-r.dep+r.bw; return r;
}
const cashStatus=d=>Math.abs(d)<0.005?'<span class="pill good">Balanced</span>':d<0?`<span class="pill bad">Short ${money(-d)}</span>`:`<span class="pill warn">Over ${money(d)}</span>`;
function cashDraw(){
  const date=cashDate||today(), r=expectedFor(me,date), id=date+'_'+me, ex=S.cashups[id];
  const counted=cashCounted!==''?cashCounted:(ex?String(ex.counted):'');
  const diff=counted===''?null:num(counted)-r.expected;
  const hist=Object.entries(S.cashups).map(([k,c])=>({id:k,...c})).filter(c=>POSONLY?c.person===me:true).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||((b.at||0)-(a.at||0))).slice(0,12);
  const line=(l,v,neg)=>`<div class="spread small"><span class="muted">${l}</span><span class="num">${neg?'− ':''}${money(v)}</span></div>`;
  $('#posBody').innerHTML=`<label>Day<input id="cashDate" type="date" value="${date}"></label>
   <div class="card" style="display:grid;gap:6px">
    <h3>Cash ${esc(pname(me))} should have</h3>
    ${line('Susu collected',r.susu)}${line('Loan repayments received',r.repay)}${line('Susu withdrawals paid out',r.wd,1)}${line('Loans given out',r.loans,1)}${line('Expenses paid',r.exp,1)}${line('Put into bank/MoMo',r.dep,1)}${line('Taken out of bank/MoMo',r.bw)}
    <div class="spread" style="border-top:1px solid var(--line);padding-top:8px"><b>Expected cash</b><b class="num">${money(r.expected)}</b></div>
   </div>
   <label>Cash counted in hand<input id="cashCounted" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(counted)}" placeholder="Count the money, type the total"></label>
   <div id="cashDiff">${diff===null?'':cashStatus(diff)}</div>
   <label>Note (optional)<input id="cashNote" value="${esc(cashNote||(ex?ex.note||'':''))}" placeholder="e.g. Gave GH₵50 change to Ama"></label>
   <button class="btn pri block" data-act="saveCash" style="padding:14px">${ex?'Update cash-up':'Save cash-up'}</button>
   <h3>Past cash-ups</h3>
   <div class="list">${hist.length?hist.map(c=>`<div class="item"><div class="main"><div class="t">${esc(pname(c.person))} · ${fmtDate(c.date)}</div><div class="s">Expected ${money(c.expected)} · counted ${money(c.counted)}${c.note?' · '+esc(c.note):''}</div></div>${cashStatus(num(c.diff))}<button class="btn sm" data-act="sendCash" data-id="${c.id}">Send</button></div>`).join(''):'<div class="empty">No cash-ups yet. Count your cash at the end of the day and save it here.</div>'}</div>`;
}
function saveCash(){
  const date=cashDate||today(), raw=$('#cashCounted').value; if(raw==='') return toast('Type the cash you counted.');
  const r=expectedFor(me,date), counted=num(raw), id=date+'_'+me;
  save('cashups',id,{date,person:me,expected:r.expected,counted,diff:counted-r.expected,note:$('#cashNote').value.trim(),detail:r,at:Date.now()});
  cashCounted=''; cashNote=''; sendCash(id);
}
function sendCash(id){
  const c=S.cashups[id]; if(!c) return; const d=c.detail||{}; const s=set_();
  const text=`${biz()}\nCASH-UP · ${fmtDate(c.date)}\nBy: ${pname(c.person)}\nSusu collected: ${money(d.susu)}\nRepayments: ${money(d.repay)}\nWithdrawals paid: ${money(d.wd)}\nLoans given: ${money(d.loans)}\nExpenses: ${money(d.exp)}\nTo bank/MoMo: ${money(d.dep)}\nFrom bank/MoMo: ${money(d.bw)}\nExpected cash: ${money(c.expected)}\nCounted cash: ${money(c.counted)}\nResult: ${Math.abs(c.diff)<0.005?'Balanced':(c.diff<0?'SHORT '+money(-c.diff):'OVER '+money(c.diff))}${c.note?'\nNote: '+c.note:''}`;
  const to=c.person==='p1'?'p2':'p1';
  openSheet(()=>`<div class="spread"><h2>Cash-up saved</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre><p class="small muted" style="margin:0">Send this to ${esc(pname(to))}.</p>${sendButtons(text,s[to+'phone']||'')}`);
}
function custOptions(sel,filter){ const list=custList().filter(filter||(()=>true)); return `<option value="">— pick customer —</option>`+list.map(c=>`<option value="${c.id}" ${c.id===sel?'selected':''}>${esc(c.name)}${c.phone?' · '+esc(c.phone):''}</option>`).join(''); }
function loanOptions(sel){ const ls=Object.keys(S.loans).map(loanStats).filter(l=>l.remaining>0.005); return `<option value="">— pick loan —</option>`+ls.map(l=>`<option value="${l.id}" ${l.id===sel?'selected':''}>${esc(S.customers[l.cid]?.name||'?')} · ${esc(l.no)} · owes ${money(l.remaining)}</option>`).join(''); }
function keypadDraw(){
  const k=pos.kind; document.querySelectorAll('.kind').forEach(b=>b.classList.toggle('on',b.dataset.pk===k));
  const who=$('#posWho'), ex=$('#posExtra'), s=set_();
  if(k==='contribution'||k==='withdrawal'||k==='loan'){
    who.innerHTML=`<div class="row" style="flex-wrap:nowrap"><select id="posCid" aria-label="Customer" style="flex:1">${custOptions(pos.cid,k==='loan'?c=>c.type!=='susu':k==='withdrawal'||k==='contribution'?c=>c.type!=='loan':null)}</select><button class="btn sm" data-act="newCust" style="flex:none">+ New</button></div>`;
  } else if(k==='repayment'){ who.innerHTML=`<select id="posLoan" aria-label="Loan">${loanOptions(pos.loanId)}</select>`; }
  else if(k==='capital'){ who.innerHTML=`<select id="posPartner" aria-label="Partner"><option value="p1" ${me==='p1'?'selected':''}>${esc(pname('p1'))}</option><option value="p2" ${me==='p2'?'selected':''}>${esc(pname('p2'))}</option></select>`; }
  else who.innerHTML='';
  const d=`<label>Date<input id="posDate" type="date" value="${today()}"></label>`;
  if(k==='loan') ex.innerHTML=`<div class="grid2"><label>Interest %<input id="posRate" type="number" step="0.5" min="0" value="${esc(s.rate??10)}"></label><label>Due date<input id="posDue" type="date"></label></div>${d}`;
  else if(k==='expense') ex.innerHTML=`<label>What was it for?<input id="posNote" placeholder="e.g. Transport to market"></label>${d}`;
  else if(k==='bank') ex.innerHTML=`<div class="grid2"><label>Type<select id="posBankType"><option value="deposit">Put into bank/MoMo</option><option value="withdraw">Take out of bank/MoMo</option></select></label><label>Account<input id="posAccount" list="accList" value="${esc(accountNames()[0])}"><datalist id="accList">${accountNames().map(a=>`<option value="${esc(a)}">`).join('')}</datalist></label></div><label>Note (optional)<input id="posNote" placeholder="e.g. Reference number"></label>${d}`;
  else if(k==='capital') ex.innerHTML=`<label>Note<input id="posNote" placeholder="e.g. Starting capital (use − for money taken out)"></label>${d}`;
  else ex.innerHTML=`<label>Note (optional)<input id="posNote"></label>${d}`;
  posAmt(); posHint();
  ['posCid','posLoan'].forEach(i=>{const e=$('#'+i); if(e) e.onchange=()=>{ if(i==='posCid')pos.cid=e.value; else pos.loanId=e.value; posHint(); };});
}
function posRefreshSelects(){ const a=$('#posCid'); if(a){ const v=a.value; a.innerHTML=custOptions(v||pos.cid,pos.kind==='loan'?c=>c.type!=='susu':c=>c.type!=='loan'); } const b=$('#posLoan'); if(b){ b.innerHTML=loanOptions(b.value||pos.loanId); } posHint(); }
function posAmt(){ const lbl={contribution:'Susu payment',withdrawal:'Withdrawal',repayment:'Loan repayment',loan:'Loan amount',expense:'Expense',capital:'Capital',bank:'Bank / MoMo'}[pos.kind]; $('#posLbl').textContent=lbl; $('#posAmt').textContent='GH₵ '+(pos.amt||'0'); }
function posHint(){
  const h=$('#posHint'); if(!h) return; let t='';
  if((pos.kind==='contribution'||pos.kind==='withdrawal')&&pos.cid&&S.customers[pos.cid]){ const st=custStats(pos.cid), c=S.customers[pos.cid]; t=`Balance ${money(st.balance)}${num(c.daily)?' · daily '+money(c.daily):''}`; }
  else if(pos.kind==='repayment'&&pos.loanId&&S.loans[pos.loanId]){ const L=loanStats(pos.loanId); t=`Left to pay ${money(L.remaining)} of ${money(L.total)}`; }
  else if(pos.kind==='loan'){ const r=num($('#posRate')?.value); const a=num(pos.amt); t=a?`Interest ${money(a*r/100)} · to repay ${money(a+a*r/100)}`:''; }
  h.textContent=t;
}
function posKey(k){ let a=pos.amt; if(k==='⌫')a=a.slice(0,-1); else if(k==='.'){ if(!a.includes('.'))a=(a||'0')+'.'; } else { if(a.includes('.')&&a.split('.')[1].length>=2)return; a=(a==='0'?'':a)+k; } pos.amt=a.slice(0,10); posAmt(); posHint(); }
function posSave(){
  const k=pos.kind, a=num(pos.amt), date=$('#posDate')?.value||today(), note=($('#posNote')?.value||'').trim();
  if(!a&&k!=='capital') return toast('Type an amount first.');
  if(k==='capital'&&!a) return toast('Type an amount first.');
  const at=Date.now(), id=uid();
  if(k==='contribution'||k==='withdrawal'){
    const cid=$('#posCid').value; if(!cid) return toast('Pick a customer.');
    if(k==='withdrawal'&&a>custStats(cid).balance+0.005) return toast(`Not enough susu balance. Available: ${money(custStats(cid).balance)}`);
    save('txns',id,{kind:k,cid,amount:a,date,note,by:me,at}); receipt('txn',id);
  } else if(k==='loan'){
    const cid=$('#posCid').value; if(!cid) return toast('Pick a borrower.');
    const no='L'+pad(Object.keys(S.loans).length+1);
    save('loans',id,{cid,amount:a,rate:num($('#posRate').value),due:$('#posDue').value||'',date,no,note,by:me,at}); receipt('loan',id);
  } else if(k==='repayment'){
    const loanId=$('#posLoan').value; if(!loanId) return toast('Pick the loan being paid.');
    const L=loanStats(loanId); if(a>L.remaining+0.005) return toast(`That is more than what is left: ${money(L.remaining)}`);
    save('txns',id,{kind:'repayment',cid:L.cid,loanId,amount:a,date,note,by:me,at}); receipt('txn',id);
  } else if(k==='expense'){
    if(!note) return toast('Say what the expense was for.');
    save('expenses',id,{amount:a,note,date,by:me,at}); receipt('exp',id);
  } else if(k==='bank'){
    const account=($('#posAccount').value||'').trim(); if(!account) return toast('Type the account, e.g. MTN MoMo or GCB Bank.');
    const type=$('#posBankType').value; save('deposits',id,{type,account,amount:a,note,date,by:me,at});
    toast((type==='withdraw'?'Taken out of ':'Put into ')+account+': '+money(a));
  } else if(k==='capital'){
    save('capital',id,{partner:$('#posPartner').value,amount:a,note,date,by:me,at}); toast('Capital saved.');
  }
  pos.amt=''; posAmt(); posHint();
  const n=$('#posNote'); if(n) n.value='';
}

/* ---------- receipts ---------- */
function fill(tpl,vars){ return tpl.replace(/\{(\w+)\}/g,(m,k)=>k in vars?vars[k]:m).replace(/\n{2,}/g,'\n'); }
function waNum(p){ let d=String(p||'').replace(/\D/g,''); if(d.startsWith('00'))d=d.slice(2); if(d.length===10&&d.startsWith('0'))d='233'+d.slice(1); if(d.length===9)d='233'+d; return d; }
function receiptText(type,id){
  const s=set_();
  if(type==='exp'){ const e=S.expenses[id]; return {text:fill(s.exptpl||DEFAULT_EXP_TPL,{business:biz(),receipt:'E-'+id.slice(-6).toUpperCase(),date:fmtDate(e.date),note:e.note||'',amount:money(e.amount),partner:pname(e.by),customer:'',type:'Expense',balance:''}),phone:s[(e.by==='p1'?'p2':'p1')+'phone']||'',to:pname(e.by==='p1'?'p2':'p1')}; }
  let rec,typeLabel,bal,cid;
  if(type==='loan'){ const L=loanStats(id); cid=L.cid; typeLabel=`Loan given (${L.no}, ${L.rate}% interest)`; bal=`Total to repay: ${money(L.total)}${L.due?' by '+fmtDate(L.due):''}`; rec=L; }
  else { const t=S.txns[id]; rec=t; cid=t.cid; typeLabel=KIND[t.kind];
    if(t.kind==='repayment'){ const L=loanStats(t.loanId); bal=`Loan ${L.no} left to pay: ${money(Math.max(0,L.remaining))}`; }
    else bal=`Susu balance: ${money(custStats(cid).balance)}`; }
  const c=S.customers[cid]||{};
  return {text:fill(s.tpl||DEFAULT_TPL,{business:biz(),receipt:'R-'+id.slice(-6).toUpperCase(),date:fmtDate(rec.date),customer:c.name||'',type:typeLabel,amount:money(rec.amount),balance:bal,partner:pname(rec.by),note:rec.note||''}),phone:c.phone||'',to:c.name||'customer'};
}
function sendButtons(text,phone){
  const w=waNum(phone), body=encodeURIComponent(text);
  return `<div class="grid2"><a class="btn wa block" target="_blank" rel="noopener" href="https://wa.me/${w}?text=${body}">WhatsApp</a>
   <a class="btn block" href="sms:${esc(String(phone||'').replace(/[^\d+]/g,''))}?body=${body}">SMS text</a></div>
   <button class="btn block" data-act="copy">Copy message</button>
   <p class="small muted" style="margin:0">${phone?`Sends to ${esc(phone)}.`:'No phone number saved, so you will pick the contact.'} The app cannot see if the message went, so check WhatsApp or your messages. If SMS doesn't open, copy the message and paste it.</p>`;
}
function receipt(type,id){
  const r=receiptText(type,id);
  openSheet(()=>`<div class="spread"><h2>${type==='exp'?'Expense saved':'Receipt'}</h2><button class="btn sm" data-act="close">Done</button></div>
   <pre class="receipt" id="rcpt">${esc(r.text)}</pre>${type==='exp'?`<p class="small muted" style="margin:0">Send this record to ${esc(r.to)}.</p>`:''}${sendButtons(r.text,r.phone)}`);
}

/* ---------- customer sheets ---------- */
function custForm(id){
  const c=id?S.customers[id]:{}; const s=set_();
  openSheet(()=>`<div class="spread"><h2>${id?'Edit customer':'New customer'}</h2><button class="btn sm" data-act="close">Cancel</button></div>
   <form id="custForm" style="display:grid;gap:12px" data-id="${id||''}">
    <label>Full name<input id="c_name" required value="${esc(c.name||'')}"></label>
    <div class="grid2"><label>Phone (WhatsApp)<input id="c_phone" inputmode="tel" value="${esc(c.phone||'')}" placeholder="024 000 0000"></label>
    <label class="susu-only">Type<select id="c_type"><option value="both" ${!c.type||c.type==='both'?'selected':''}>Susu + loans</option><option value="susu" ${c.type==='susu'?'selected':''}>Susu only</option><option value="loan" ${c.type==='loan'?'selected':''}>Loans only</option></select></label></div>
    <div class="grid2"><label class="susu-only">Daily susu amount<input id="c_daily" type="number" min="0" step="0.5" value="${esc(c.daily||'')}"></label><label>Date enrolled<input id="c_joined" type="date" value="${esc(c.joined||today())}"></label></div>
    <label>Location<input id="c_loc" value="${esc(c.loc||'')}"></label>
    <label>Guarantor (name & phone)<input id="c_guar" value="${esc(c.guar||'')}"></label>
    ${isCollector()?'':`<label class="susu-only">Collector<select id="c_collector"><option value="">No collector (partners collect)</option>${(s.collectors||[]).map(k=>`<option value="${esc(k.id)}" ${c.collector===k.id?'selected':''}>${esc(k.name)}</option>`).join('')}</select></label>`}
    <label><span><input type="checkbox" id="c_send" ${id?'':'checked'} style="width:auto;margin-right:8px">Send a welcome message after saving</span></label>
    <button class="btn pri block" type="submit">Save customer</button></form>`);
}
function welcome(id){
  const c=S.customers[id]; const text=`${biz()}\nWelcome, ${c.name}!\nYou are enrolled as customer ${c.no}.${num(c.daily)?`\nDaily susu: ${money(c.daily)}.`:''}\nCommission: one day's contribution each month.\nThank you.`;
  openSheet(()=>`<div class="spread"><h2>Customer saved</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre>${sendButtons(text,c.phone)}`);
}
function openCust(id){
  if(loansMode()) return openCustLoans(id);
  openSheet(()=>{
    const c=S.customers[id]; if(!c) return `<div class="spread"><h2>Customer removed</h2><button class="btn sm" data-act="close">Close</button></div>`;
    const st=custStats(id);
    const tx=Object.entries(S.txns).filter(([,t])=>t.cid===id).map(([tid,t])=>({id:tid,...t})).sort(byDate).reverse();
    return `<div class="spread"><div class="row"><span class="av">${esc(initials(c.name))}</span><div><h2>${esc(c.name)}</h2><div class="small muted">${esc(c.no||'')} · ${esc(c.phone||'no phone')}${c.loc?' · '+esc(c.loc):''}</div></div></div><button class="btn sm" data-act="close">Close</button></div>
    <div class="stats"><div class="stat"><span class="k">Susu balance</span><span class="v">${money(st.balance)}</span></div><div class="stat"><span class="k">Loan owed</span><span class="v ${st.owing>0?'bad':''}">${money(st.owing)}</span></div>
    <div class="stat"><span class="k">Paid in</span><span class="v">${money(st.paid)}</span></div><div class="stat"><span class="k">Commission taken</span><span class="v">${money(st.com)}</span></div></div>
    <div class="grid2"><button class="btn pri" data-act="pos" data-kind="contribution" data-cid="${id}">Susu pay</button><button class="btn" data-act="pos" data-kind="withdrawal" data-cid="${id}">Withdraw</button>
    <button class="btn" data-act="pos" data-kind="loan" data-cid="${id}">New loan</button><button class="btn wa" data-act="statement" data-id="${id}">Send statement</button></div>
    ${st.balance>0.005&&c.type!=='loan'?`<button class="btn gold block wr" data-act="payout" data-id="${id}">Pay out ${money(st.balance)} (end of cycle)</button>`:''}
    ${(()=>{const i=missedInfo(c);return c.type!=='loan'&&i.days>=missLimit()?`<div class="banner">Missed payments: ${i.days} days since ${i.lp?fmtDate(i.lp):'joining'}. <button class="btn sm" data-act="missRemind" data-id="${id}">Remind</button></div>`:''})()}
    ${st.loans.length?`<h3>Loans</h3><div class="list">${st.loans.map(l=>`<div class="item"><div class="main"><div class="t">${esc(l.no)} · ${money(l.amount)} at ${l.rate}%</div><div class="s">Given ${fmtDate(l.date)} · due ${fmtDate(l.due)} · paid ${money(l.paid)} of ${money(l.total)}</div></div>${statusPill(l.status)}${delBtn('loans',l.id)}</div>`).join('')}</div>`:''}
    <h3>History</h3><div class="list">${tx.length?tx.map(t=>`<div class="item"><div class="main"><div class="t">${esc(KIND[t.kind])}${t.note?' · '+esc(t.note):''}</div><div class="s">${fmtDate(t.date)} · by ${esc(pname(t.by))}</div></div><div class="amt">${money(t.amount)}</div><button class="btn sm" data-act="resend" data-id="${t.id}">Receipt</button>${delBtn('txns',t.id)}</div>`).join(''):`<div class="empty">No payments yet.</div>`}</div>
    <div class="grid2"><button class="btn" data-act="editCust" data-id="${id}">Edit details</button><button class="btn danger" data-act="del" data-col="customers" data-id="${id}">Delete customer</button></div>`;
  },true);
}
function statement(id){
  const c=S.customers[id], st=custStats(id);
  const text=`${biz()}\nSTATEMENT · ${fmtDate(today())}\nCustomer: ${c.name} (${c.no||''})\nTotal paid in: ${money(st.paid)}\nWithdrawn: ${money(st.wd)}\nCommission: ${money(st.com)}\nSusu balance: ${money(st.balance)}`+(st.loans.length?`\nLoans owed: ${money(st.owing)}`+st.loans.filter(l=>l.remaining>0.005).map(l=>`\n  ${l.no}: ${money(l.remaining)} left${l.due?' (due '+fmtDate(l.due)+')':''}`).join(''):'')+`\nThank you.`;
  openSheet(()=>`<div class="spread"><h2>Statement</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre>${sendButtons(text,c.phone)}`);
}

/* ---------- control lock ---------- */
const controller=()=>set_().controller||'';
const viewOnly=()=>!!(session&&session.user.role==='partner'&&controller()&&controller()!==me);
const otherPartner=()=>me==='p1'?'p2':'p1';
function lockCard(){
  const c=controller(), other=otherPartner();
  let body;
  if(!c) body=`<p class="small muted" style="margin:0">Off. Both partners can record and change things.</p>
    <button class="btn pri" data-act="lockMe">Lock app to me (${esc(pname(me))})</button>`;
  else if(c===me) body=`<p class="small" style="margin:0"><b>You control the app.</b> ${esc(pname(other))} can only view.</p>
    <div class="grid2"><button class="btn" data-act="unlock">Unlock</button><button class="btn" data-act="handover">Hand control to ${esc(pname(other))}</button></div>`;
  else body=`<p class="small" style="margin:0"><b>${esc(pname(c))} controls the app.</b> You can view everything, but only ${esc(pname(c))} can record or change things.</p>`;
  return `<div class="card" style="display:grid;gap:10px"><div class="spread"><h3>&#128274; Control lock</h3><span class="pill ${c?'warn':'good'}">${c?'On':'Off'}</span></div>${body}</div>`;
}
function setController(id){ save('settings','main',{...set_(),controller:id}); toast(id?(id===me?'App locked to you. Your partner can only view.':'Control handed to '+pname(id)+'.'):'Unlocked. Both partners can record.'); }

/* ---------- meetings ---------- */
const REPEAT={none:'One-off',weekly:'Every week',biweekly:'Every 2 weeks',monthly:'Every month'};
const mtList=()=>Object.entries(S.meetings).map(([id,m])=>({id,...m}));
const mtWhen=m=>(m.date||'')+'T'+(m.time||'00:00');
function nextMeeting(){ const now=today()+'T00:00'; return mtList().filter(m=>m.status!=='done'&&mtWhen(m)>=now).sort((a,b)=>mtWhen(a).localeCompare(mtWhen(b)))[0]; }
function fmtTime(t){ if(!t) return ''; const [h,m]=t.split(':').map(Number); return `${((h+11)%12)+1}:${String(m).padStart(2,'0')} ${h<12?'am':'pm'}`; }
function daysTo(d){ const a=new Date(today()+'T00:00'), b=new Date(d+'T00:00'); return Math.round((b-a)/86400000); }
function whenLabel(m){ const n=daysTo(m.date); return n===0?'Today':n===1?'Tomorrow':n<0?`${-n} day${n===-1?'':'s'} ago`:`In ${n} days`; }
function addRepeat(date,rep){ const d=new Date(date+'T00:00'); if(rep==='weekly') d.setDate(d.getDate()+7); else if(rep==='biweekly') d.setDate(d.getDate()+14); else if(rep==='monthly'){ const day=d.getDate(); d.setDate(1); d.setMonth(d.getMonth()+1); d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate())); } else return ''; return d.getFullYear()+'-'+pad(d.getMonth()+1,2)+'-'+pad(d.getDate(),2); }
function calLink(m){
  const st=(m.date||'').replace(/-/g,'')+'T'+(m.time||'09:00').replace(':','')+'00';
  const e=new Date(mtWhen(m)); e.setHours(e.getHours()+1);
  const en=e.getFullYear()+pad(e.getMonth()+1,2)+pad(e.getDate(),2)+'T'+pad(e.getHours(),2)+pad(e.getMinutes(),2)+'00';
  const rr={weekly:'RRULE:FREQ=WEEKLY',biweekly:'RRULE:FREQ=WEEKLY;INTERVAL=2',monthly:'RRULE:FREQ=MONTHLY'}[m.repeat];
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text='+encodeURIComponent(biz()+': '+(m.title||'Meeting'))+'&dates='+st+'/'+en+'&ctz=Africa/Accra&details='+encodeURIComponent(m.agenda||'')+'&location='+encodeURIComponent(m.place||'')+(rr?'&recur='+encodeURIComponent(rr):'');
}
function mtCard(m,big){
  return `<div class="card" style="display:grid;gap:8px;${big?'border-left:5px solid var(--gold)':''}">
    <div class="spread"><div><div class="small muted" style="font-weight:600">${big?'NEXT MEETING · ':''}${esc(whenLabel(m))}</div><h3>${esc(m.title||'Partners meeting')}</h3></div><span class="pill">${esc(REPEAT[m.repeat]||'One-off')}</span></div>
    <div class="small">${fmtDate(m.date)}${m.time?' · '+fmtTime(m.time):''}${m.place?' · '+esc(m.place):''}</div>
    ${m.agenda?`<div class="small muted" style="white-space:pre-wrap">${esc(m.agenda)}</div>`:''}
    <div class="row"><button class="btn sm pri wr" data-act="mtReport" data-id="${m.id}">Write report</button><button class="btn sm" data-act="mtRemind" data-id="${m.id}">Send reminder</button><a class="btn sm" target="_blank" rel="noopener" href="${calLink(m)}">Add to Google Calendar</a><button class="btn sm wr" data-act="mtEdit" data-id="${m.id}">Edit</button></div></div>`;
}
function meetingsSection(){
  const nx=nextMeeting(), past=mtList().filter(m=>(!nx||m.id!==nx.id)&&(m.status==='done'||mtWhen(m)<today()+'T00:00')).sort((a,b)=>mtWhen(b).localeCompare(mtWhen(a)));
  const upcoming=mtList().filter(m=>m.status!=='done'&&mtWhen(m)>=today()+'T00:00'&&(!nx||m.id!==nx.id)).sort((a,b)=>mtWhen(a).localeCompare(mtWhen(b)));
  return `<div class="section"><div class="spread"><h2>Meetings</h2><button class="btn sm pri wr" data-act="mtNew">+ Schedule</button></div>
   ${nx?mtCard(nx,true):`<div class="card empty">No meeting scheduled. Tap <b>+ Schedule</b> to set your regular partners meeting.</div>`}
   ${upcoming.length?`<div class="list">${upcoming.map(m=>`<button class="item" data-act="mtOpen" data-id="${m.id}"><span class="main"><span class="t">${esc(m.title||'Meeting')}</span><span class="s" style="display:block">${fmtDate(m.date)}${m.time?' · '+fmtTime(m.time):''}</span></span><span class="pill">${esc(whenLabel(m))}</span></button>`).join('')}</div>`:''}
   ${past.length?`<h3>Past meetings</h3><div class="list">${past.slice(0,12).map(m=>`<button class="item" data-act="mtOpen" data-id="${m.id}"><span class="main"><span class="t">${esc(m.title||'Meeting')}</span><span class="s" style="display:block">${fmtDate(m.date)}${m.attended?' · '+esc(m.attended):''}</span></span>${m.status==='done'?'<span class="pill good">Report</span>':'<span class="pill warn">No report</span>'}</button>`).join('')}</div>`:''}
  </div>`;
}
function mtForm(id){
  const m=id?S.meetings[id]:{title:'Partners meeting',date:today(),time:'18:00',repeat:'weekly'};
  openSheet(()=>`<div class="spread"><h2>${id?'Edit meeting':'Schedule meeting'}</h2><button class="btn sm" data-act="close">Cancel</button></div>
   <form id="mtForm" data-id="${id||''}" style="display:grid;gap:12px">
    <label>Title<input id="m_title" value="${esc(m.title||'')}" required></label>
    <div class="grid2"><label>Date<input id="m_date" type="date" value="${esc(m.date||today())}" required></label><label>Time<input id="m_time" type="time" value="${esc(m.time||'18:00')}"></label></div>
    <div class="grid2"><label>Place<input id="m_place" value="${esc(m.place||'')}" placeholder="e.g. Office, or WhatsApp call"></label>
    <label>Repeats<select id="m_repeat">${Object.entries(REPEAT).map(([k,l])=>`<option value="${k}" ${(m.repeat||'none')===k?'selected':''}>${l}</option>`).join('')}</select></label></div>
    <label>Agenda (what to discuss)<textarea id="m_agenda" style="min-height:90px" placeholder="1. Collections this week&#10;2. Overdue loans&#10;3. Expenses">${esc(m.agenda||'')}</textarea></label>
    <button class="btn pri block" type="submit">Save meeting</button>
    ${id?`<button type="button" class="btn danger block" data-act="del" data-col="meetings" data-id="${id}">Delete meeting</button>`:''}
   </form>`);
}
function rpForm(id){
  const m=S.meetings[id]; if(!m) return;
  openSheet(()=>`<div class="spread"><h2>Meeting report</h2><button class="btn sm" data-act="close">Cancel</button></div>
   <div class="small muted">${esc(m.title||'Meeting')} · ${fmtDate(m.date)}${m.time?' · '+fmtTime(m.time):''}</div>
   <form id="rpForm" data-id="${id}" style="display:grid;gap:12px">
    <label>Who attended<input id="r_att" value="${esc(m.attended||[pname('p1'),pname('p2')].join(', '))}"></label>
    <label>Summary (what was discussed)<textarea id="r_rep" style="min-height:100px">${esc(m.report||'')}</textarea></label>
    <label>Decisions made<textarea id="r_dec" style="min-height:80px" placeholder="e.g. Raise loan interest to 12%">${esc(m.decisions||'')}</textarea></label>
    <label>Action points (who does what, by when)<textarea id="r_act" style="min-height:80px" placeholder="e.g. Gideon: follow up Kofi's loan by Friday">${esc(m.actions||'')}</textarea></label>
    ${m.repeat&&m.repeat!=='none'&&!m.nextid?`<p class="small muted" style="margin:0">Saving will also schedule the next meeting for ${fmtDate(addRepeat(m.date,m.repeat))}.</p>`:''}
    <button class="btn pri block" type="submit">Save report</button>
   </form>`);
}
function mtText(m,kind){
  if(kind==='remind') return `${biz()}\nMEETING REMINDER\n${m.title||'Partners meeting'}\n${fmtDate(m.date)}${m.time?' at '+fmtTime(m.time):''}${m.place?'\nPlace: '+m.place:''}${m.agenda?'\n\nAgenda:\n'+m.agenda:''}`;
  const nx=m.nextid&&S.meetings[m.nextid];
  return `${biz()}\nMEETING REPORT\n${m.title||'Meeting'} · ${fmtDate(m.date)}${m.time?' '+fmtTime(m.time):''}${m.place?'\nPlace: '+m.place:''}\nAttended: ${m.attended||''}`+
    (m.report?`\n\nSummary:\n${m.report}`:'')+(m.decisions?`\n\nDecisions:\n${m.decisions}`:'')+(m.actions?`\n\nAction points:\n${m.actions}`:'')+
    (nx?`\n\nNext meeting: ${fmtDate(nx.date)}${nx.time?' at '+fmtTime(nx.time):''}`:'')+`\n\nRecorded by ${pname(m.reportBy||m.by)}`;
}
function mtSend(id,kind){
  const m=S.meetings[id]; if(!m) return; const text=mtText(m,kind);
  openSheet(()=>`<div class="spread"><h2>${kind==='remind'?'Reminder':'Report'}</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre>${sendButtons(text,'')}<p class="small muted" style="margin:0">WhatsApp lets you pick your partner or your partners' group.</p>`);
}
function mtOpen(id){
  const m=S.meetings[id]; if(!m) return;
  if(m.status!=='done') return openSheet(()=>`<div class="spread"><h2>Meeting</h2><button class="btn sm" data-act="close">Close</button></div>${mtCard({id,...S.meetings[id]},false)}`,true);
  openSheet(()=>{ const x=S.meetings[id]; if(!x) return `<div class="spread"><h2>Meeting removed</h2><button class="btn sm" data-act="close">Close</button></div>`;
    return `<div class="spread"><h2>Meeting report</h2><button class="btn sm" data-act="close">Close</button></div><pre class="receipt">${esc(mtText(x,'report'))}</pre>
    <div class="grid2"><button class="btn wa" data-act="mtSendRep" data-id="${id}">Send report</button><button class="btn wr" data-act="mtReport" data-id="${id}">Edit report</button></div>`; },true);
}

/* ---------- follow-ups: missed payments and loans due ---------- */
const missLimit=()=>Math.max(1,num(set_().missDays)||2);
const lastPaid=memo('lp',function(cid){ let d=''; for(const t of (idx().byCid[cid]||[])) if(t.kind==='contribution'&&(t.date||'')>d) d=t.date; return d; });
function missedInfo(c){ const lp=lastPaid(c.id), ref=lp||c.joined||''; return {lp,days:ref?Math.max(0,-daysTo(ref)):0}; }
function missedList(){ return custList().filter(c=>c.type!=='loan').map(c=>({...c,...missedInfo(c)})).filter(c=>c.days>=missLimit()).sort((a,b)=>b.days-a.days); }
function loansDue(){ return Object.keys(S.loans).map(loanStats).filter(l=>l.remaining>0.005&&l.due&&daysTo(l.due)<=7).sort((a,b)=>(a.due||'').localeCompare(b.due||'')); }
function missText(cid){ const c=S.customers[cid], i=missedInfo(c);
  return `Hello ${c.name}, this is ${biz()}.\nWe have not received your susu payment since ${i.lp?fmtDate(i.lp):'you joined'} (${i.days} day${i.days===1?'':'s'}).${num(c.daily)?`\nYour daily amount is ${money(c.daily)}.`:''}\nYour susu balance is ${money(custStats(cid).balance)}.\nThank you.`; }
function dueText(id){ const L=loanStats(id), c=S.customers[L.cid]||{}, n=daysTo(L.due);
  return `Hello ${c.name||''}, this is ${biz()}.\nYour loan ${L.no} `+(n<0?`was due on ${fmtDate(L.due)} (${-n} day${n===-1?'':'s'} ago).`:`is due ${n===0?'today':'on '+fmtDate(L.due)+(n===1?' (tomorrow)':` (in ${n} days)`)}.`)+`\nAmount left to pay: ${money(L.remaining)}.\n`+(n<0?'Please pay as soon as possible.':'Thank you.'); }
function remindSheet(text,phone,title){ openSheet(()=>`<div class="spread"><h2>${title}</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre>${sendButtons(text,phone)}`); }
const missRow=c=>`<div class="item"><div class="main"><div class="t">${esc(c.name)}</div><div class="s">${c.lp?'Last paid '+fmtDate(c.lp):'No payment yet'} · <b style="color:var(--bad)">${c.days} days</b>${c.collector?' · '+esc(pname(c.collector)):''}</div></div><button class="btn sm" data-act="missRemind" data-id="${c.id}">Remind</button></div>`;
const dueRow=l=>{ const n=daysTo(l.due), c=S.customers[l.cid]||{}; return `<div class="item"><div class="main"><div class="t">${esc(c.name||'?')} · ${esc(l.no)}</div><div class="s">${money(l.remaining)} left · ${n<0?`<b style="color:var(--bad)">${-n} days overdue</b>`:n===0?'<b>due today</b>':`due in ${n} days`}</div></div><button class="btn sm" data-act="dueRemind" data-id="${l.id}">Remind</button></div>`; };
function followUp(){
  if(isCollector()) return '';
  const m=missedList(), d=loansDue(); if(!m.length&&!d.length) return '';
  return `<div class="section"><h2>Follow up</h2>
   ${m.length?`<div class="spread"><h3>Missed susu payments (${m.length})</h3>${m.length>3?`<button class="btn sm" data-act="missAll">See all</button>`:''}</div><div class="list">${m.slice(0,3).map(missRow).join('')}</div>`:''}
   ${d.length?`<div class="spread"><h3>Loans due or overdue (${d.length})</h3>${d.length>3?`<button class="btn sm" data-act="dueAll">See all</button>`:''}</div><div class="list">${d.slice(0,3).map(dueRow).join('')}</div>`:''}</div>`;
}

/* ---------- bank / MoMo ---------- */
function bankTotals(){ const acc={}; let total=0; for(const d of Object.values(S.deposits)){ const a=(d.account||'Bank').trim(), v=(d.type==='withdraw'?-1:1)*num(d.amount); acc[a]=(acc[a]||0)+v; total+=v; } return {acc,total}; }
function bankSection(){
  const b=bankTotals(), rows=Object.entries(S.deposits).map(([id,d])=>({id,...d})).sort(byDate).reverse();
  return `<div class="section"><div class="spread"><h2>Bank &amp; MoMo</h2><button class="btn sm pri" data-act="pos" data-kind="bank">+ Add</button></div>
   ${Object.keys(b.acc).length?`<div class="stats">${Object.entries(b.acc).map(([a,v])=>`<div class="stat"><span class="k">${esc(a)}</span><span class="v">${money(v)}</span></div>`).join('')}</div>`:''}
   <div class="list">${rows.length?rows.slice(0,10).map(d=>rowWithDelete(`${d.type==='withdraw'?'Taken out of':'Put into'} ${esc(d.account||'Bank')}`,`${fmtDate(d.date)} · by ${esc(pname(d.by))}${d.note?' · '+esc(d.note):''}`,(d.type==='withdraw'?'− ':'')+money(d.amount),'deposits',d.id)).join(''):`<div class="empty">Record here when susu cash goes into the bank or MoMo, so you can see what is in hand and what is in the bank.</div>`}</div></div>`;
}
const accountNames=()=>[...new Set(['MTN MoMo',...Object.values(S.deposits).map(d=>d.account).filter(Boolean)])];

/* ---------- activity log ---------- */
let actWho='', actDel=false;
const actList=()=>Object.values(S.activity).filter(a=>a.action).sort((a,b)=>String(b.time).localeCompare(String(a.time))||(num(b.updated)-num(a.updated)));
const isUndo=a=>/^(Undid|Deleted|Removed)/.test(a.action||'');
const actRow=a=>`<div class="item"><div class="main"><div class="t" style="font-weight:500${isUndo(a)?';color:var(--bad)':''}">${esc(a.action)}</div><div class="s">${esc(a.whoName||pname(a.who))} · ${esc(String(a.time||'').replace(/^(\d{4})-(\d{2})-(\d{2})/,(m,y,mo,d)=>`${+d} ${MON[+mo-1]}`))}</div></div></div>`;
function activitySection(){ const l=actList();
  return `<div class="section"><div class="spread"><h2>Activity log</h2>${l.length?`<button class="btn sm" data-act="actAll">See all</button>`:''}</div>
   <div class="list">${l.length?l.slice(0,5).map(actRow).join(''):'<div class="empty">Everything partners and collectors do will be listed here.</div>'}</div></div>`; }
function actSheet(){
  openSheet(()=>{ const l=actList(), who=[...new Map(l.map(a=>[a.who,a.whoName||pname(a.who)])).entries()];
    const rows=l.filter(a=>(!actWho||a.who===actWho)&&(!actDel||isUndo(a)));
    return `<div class="spread"><h2>Activity log</h2><button class="btn sm" data-act="close">Close</button></div>
     <label>Person<select id="actWho"><option value="">Everyone</option>${who.map(([id,n])=>`<option value="${esc(id)}" ${actWho===id?'selected':''}>${esc(n)}</option>`).join('')}</select></label>
     <div class="chips"><button class="chip ${actDel?'':'on'}" data-act="actDel" data-v="0">Everything</button><button class="chip ${actDel?'on':''}" data-act="actDel" data-v="1">Undo &amp; delete only</button></div>
     <div class="list">${rows.length?rows.slice(0,200).map(actRow).join(''):'<div class="empty">Nothing here.</div>'}</div>
     <p class="small muted" style="margin:0">The log cannot be edited in the app. It is kept in the Activity tab of your Google Sheet.</p>`; },true);
}

/* ---------- backup ---------- */
function backupCard(){ const s=set_();
  return `<div class="card" style="display:grid;gap:8px"><h3>Backup</h3>
   <p class="small muted" style="margin:0">Every Sunday evening the whole sheet is copied to a <b>GAPSON Backups</b> folder in your Google Drive. The last 8 copies are kept.</p>
   <div class="small">Last backup: <b>${esc(s.lastBackup||'not yet')}</b></div>
   <button class="btn" data-act="backupNow">Back up now</button></div>`; }
async function backupNow(btn){
  if(!navigator.onLine) return toast('You need internet to make a backup.');
  btn.disabled=true; btn.textContent='Backing up…';
  try{ const j=await api({action:'backup',user:session.user.id,pin:session.pin}); toast('Backup saved: '+j.stamp); lastFull=0; flush(); }
  catch(e){ toast('Backup failed: '+(e.message||'try again')); btn.disabled=false; btn.textContent='Back up now'; }
}

/* ---------- end-of-cycle payout ---------- */
function cycleStats(cid){
  const tx=Object.values(S.txns).filter(t=>t.cid===cid&&(t.kind==='contribution'||t.kind==='withdrawal')).sort(byDate);
  let start=-1; tx.forEach((t,i)=>{ if(t.payout===true||t.payout==='TRUE'||t.payout==='true') start=i; });
  const cyc=tx.slice(start+1), paid=cyc.filter(t=>t.kind==='contribution').reduce((a,t)=>a+num(t.amount),0), wd=cyc.filter(t=>t.kind==='withdrawal').reduce((a,t)=>a+num(t.amount),0);
  const bal=custStats(cid).balance, c=S.customers[cid]||{};
  return {from:(cyc[0]&&cyc[0].date)||c.joined||'',days:cyc.filter(t=>t.kind==='contribution').length,paid,wd,com:Math.max(0,paid-wd-bal),bal};
}
function payoutText(cid,cs,date){ const c=S.customers[cid]||{};
  return `${biz()}\nSUSU PAYOUT · ${fmtDate(date)}\nCustomer: ${c.name} (${c.no||''})\nPeriod: ${fmtDate(cs.from)} to ${fmtDate(date)}\nDays paid: ${cs.days}\nTotal paid in: ${money(cs.paid)}\nWithdrawals: ${money(cs.wd)}\nCommission: ${money(cs.com)}\nPAID OUT: ${money(cs.bal)}\nBalance now: ${money(0)}\nPaid by: ${pname(me)}\nThank you for saving with us.`; }
function payoutSheet(cid){
  const cs=cycleStats(cid); if(cs.bal<=0.005) return toast('Nothing to pay out.');
  openSheet(()=>`<div class="spread"><h2>Pay out</h2><button class="btn sm" data-act="close">Cancel</button></div>
   <p class="small muted" style="margin:0">End of cycle: the customer receives their full balance and it goes back to zero. Check the figures, then confirm.</p>
   <pre class="receipt">${esc(payoutText(cid,cs,today()))}</pre>
   <button class="btn gold block" data-act="payoutGo" data-id="${cid}" style="padding:14px">Confirm payout of ${money(cs.bal)}</button>`);
}
function payoutGo(cid){
  const cs=cycleStats(cid); if(cs.bal<=0.005) return closeSheet();
  const id=uid(), date=today();
  save('txns',id,{kind:'withdrawal',cid,amount:+cs.bal.toFixed(2),date,note:'End of cycle payout',payout:true,by:me,at:Date.now()});
  const text=payoutText(cid,cs,date), c=S.customers[cid]||{};
  remindSheet(text,c.phone,'Payout done');
}

/* ---------- LOANS-ONLY MODE: simple lend / repay screens. Hides susu screens; never changes data. ---------- */
const loansMode=()=>(set_().mode||'loans')==='loans';
let lendTab='lend', lendPre={name:'',loanId:''}, borQuery='', borFilter='owing';
function setNavLabels(){
  const lm=loansMode(), c=document.querySelector('[data-tab=customers] span'), p=document.querySelector('.tab.pos span');
  if(c) c.textContent=lm?'Borrowers':'Customers'; if(p) p.textContent=lm?'Lend':'Record';
  document.body.classList.toggle('loansmode',lm);
  const sub=$('.brandname small'); if(sub&&!POSONLY) sub.textContent=lm?'Loans · Partners':'Susu · Loans · Partners';
}
const nextLoanNo=()=>'L'+pad(Math.max(0,...Object.values(S.loans).map(l=>parseInt(String(l.no||'').slice(1))||0))+1);
const findCust=name=>custList().find(c=>(c.name||'').trim().toLowerCase()===String(name).trim().toLowerCase());

function viewHomeLoans(){
  const T=totals(), L=Object.keys(S.loans).map(loanStats);
  const lent=L.reduce((a,l)=>a+l.amount,0), intAll=L.reduce((a,l)=>a+l.interest,0), repaid=L.reduce((a,l)=>a+Math.max(0,l.paid),0);
  const active=L.filter(l=>l.remaining>0.005).length, borrowers=new Set(L.filter(l=>l.remaining>0.005).map(l=>l.cid)).size;
  const recent=[...Object.entries(S.loans).map(([id,l])=>({id,...l,_k:'loan'})),...Object.entries(S.txns).filter(([,t])=>t.kind==='repayment').map(([id,t])=>({id,...t,_k:'rep'}))].sort(byDate).reverse().slice(0,8);
  const due=loansDue();
  return `
  ${viewOnly()?`<div class="banner" style="margin-bottom:14px">&#128274; View only. ${esc(pname(controller()))} controls the app. You can see everything but not record or change.</div>`:''}
  ${!isCollector()&&nextMeeting()?`<div style="margin-bottom:14px">${mtCard(nextMeeting(),true)}</div>`:''}
  <div class="section">
    <div class="hero"><span class="lbl">Money still owed to us</span><span class="big num">${money(T.outstanding)}</span>
    <span class="sub">${active} active loan${active===1?'':'s'} · ${borrowers} borrower${borrowers===1?'':'s'}</span></div>
    <div class="stats">
      <div class="stat"><span class="k">Total lent</span><span class="v">${money(lent)}</span></div>
      <div class="stat"><span class="k">Repaid so far</span><span class="v">${money(repaid)}</span></div>
      <div class="stat"><span class="k">Interest earned</span><span class="v">${money(T.intRecv)}</span></div>
      <div class="stat"><span class="k">Interest expected</span><span class="v">${money(intAll)}</span></div>
      <div class="stat"><span class="k">Overdue loans</span><span class="v ${T.overdue?'bad':''}">${T.overdue}</span></div>
      <div class="stat"><span class="k">Profit so far</span><span class="v ${T.profit<0?'bad':''}">${money(T.profit)}</span></div>
    </div>
    <div class="card small muted">Cash with the business: <b class="num" style="color:var(--ink)">${money(T.cash)}</b> (in hand ${money(T.inHand)} · bank/MoMo ${money(T.bank)})</div>
  </div>
  ${due.length?`<div class="section"><h2>Due or overdue (${due.length})</h2><div class="list">${due.slice(0,5).map(dueRow).join('')}</div>${due.length>5?`<button class="btn sm" data-act="dueAll">See all</button>`:''}</div>`:''}
  <div class="section"><div class="spread"><h2>Recent</h2><button class="btn sm gold wr" data-tab="pos">+ Lend</button></div>
   <div class="list">${recent.length?recent.map(r=>{ const c=S.customers[r.cid]||{};
     return `<button class="item" data-act="openCust" data-id="${r.cid}"><span class="main"><span class="t">${r._k==='loan'?'Loan '+esc(r.no||''):'Repayment'} · ${esc(c.name||'?')}</span><span class="s" style="display:block">${fmtDate(r.date)}${r.by?' · by '+esc(pname(r.by)):''}${r._k==='loan'?' · '+r.rate+'%':''}</span></span><span class="amt" style="${r._k==='loan'?'color:var(--bad)':'color:var(--good)'}">${r._k==='loan'?'− ':'+ '}${money(r.amount)}</span></button>`; }).join(''):`<div class="empty">No loans yet. Tap <b>Lend</b> at the bottom to record the first loan.</div>`}</div></div>`;
}

function viewLend(){
  if(isCollector()) lendTab='repay';
  return `<div id="lendRoot" class="section">
   <div class="seg lseg" style="grid-template-columns:repeat(${isCollector()?1:2},minmax(0,1fr))">${isCollector()?'':`<button class="segb ${lendTab==='lend'?'on':''}" data-lt="lend">Lend money</button>`}<button class="segb ${lendTab==='repay'?'on':''}" data-lt="repay">Receive repayment</button></div>
   <div id="lendBody" style="display:grid;gap:12px"></div></div>`;
}
function lendDraw(){
  document.querySelectorAll('[data-lt]').forEach(b=>b.classList.toggle('on',b.dataset.lt===lendTab));
  const body=$('#lendBody'); if(!body) return; const s=set_();
  if(lendTab==='lend'){
    body.innerHTML=`<form id="lendForm" class="card" style="display:grid;gap:12px" autocomplete="off">
     <label>Borrower's name<input id="l_name" list="borNames" required value="${esc(lendPre.name)}" placeholder="Type the name"><datalist id="borNames">${custList().map(c=>`<option value="${esc(c.name)}">`).join('')}</datalist></label>
     <div id="l_who" class="small muted"></div>
     <label>Phone (for WhatsApp receipt)<input id="l_phone" inputmode="tel" placeholder="024 000 0000"></label>
     <div class="grid2"><label>Amount borrowed (GH₵)<input id="l_amt" type="number" inputmode="decimal" min="0" step="0.01" required></label>
     <label>Interest %<input id="l_rate" type="number" inputmode="decimal" min="0" step="0.5" value="${esc(s.rate??10)}"></label></div>
     <div class="grid2"><label>Date given<input id="l_date" type="date" value="${today()}"></label><label>Pay back by (optional)<input id="l_due" type="date"></label></div>
     <div class="display"><span class="lbl">To be repaid</span><span class="amt" id="l_total">GH₵ 0.00</span><span class="small" id="l_int" style="opacity:.75">Interest GH₵ 0.00</span></div>
     <button class="btn pri block" type="submit" style="padding:16px;font-size:17px">Save loan</button></form>`;
    lendWho(); lendCalc();
  } else {
    const owing=Object.keys(S.loans).map(loanStats).filter(l=>l.remaining>0.005).sort((a,b)=>(S.customers[a.cid]?.name||'').localeCompare(S.customers[b.cid]?.name||''));
    body.innerHTML=owing.length?`<form id="repayForm" class="card" style="display:grid;gap:12px">
     <label>Who is paying?<select id="p_loan" required><option value="">— pick the loan —</option>${owing.map(l=>`<option value="${l.id}" ${l.id===lendPre.loanId?'selected':''}>${esc(S.customers[l.cid]?.name||'?')} · ${esc(l.no)} · owes ${money(l.remaining)}</option>`).join('')}</select></label>
     <div id="p_info" class="small muted"></div>
     <div class="grid2"><label>Amount received (GH₵)<input id="p_amt" type="number" inputmode="decimal" min="0" step="0.01" required></label>
     <label>Date<input id="p_date" type="date" value="${today()}"></label></div>
     <button type="button" class="btn sm" data-act="payAll" style="justify-self:start">Pay all that is left</button>
     <button class="btn pri block" type="submit" style="padding:16px;font-size:17px">Save repayment</button></form>`
     :`<div class="card empty">Nobody owes anything right now.</div>`;
    repayInfo();
  }
}
function lendWho(){ const el=$('#l_who'); if(!el) return; const c=findCust($('#l_name').value);
  if(!c){ el.textContent=$('#l_name').value.trim()?'New borrower. They will be added automatically.':''; return; }
  const st=custStats(c.id); el.innerHTML=`Existing borrower ${esc(c.no||'')}${st.owing>0?` · <b style="color:var(--bad)">already owes ${money(st.owing)}</b>`:' · owes nothing now'}`;
  const ph=$('#l_phone'); if(ph&&!ph.value&&c.phone) ph.value=c.phone; }
function lendCalc(){ const a=num($('#l_amt')?.value), r=num($('#l_rate')?.value), i=a*r/100; if($('#l_total')) $('#l_total').textContent=money(a+i); if($('#l_int')) $('#l_int').textContent=`Interest ${money(i)} (${r}% of ${money(a)})`; }
function repayInfo(){ const el=$('#p_info'), id=$('#p_loan')?.value; if(!el) return; if(!id){ el.textContent=''; return; }
  const L=loanStats(id), a=num($('#p_amt')?.value); el.innerHTML=`Loan ${money(L.amount)} at ${L.rate}% · to repay ${money(L.total)} · paid ${money(L.paid)}${L.due?' · due '+fmtDate(L.due):''}<br><b style="color:var(--ink)">Left after this payment: ${money(Math.max(0,L.remaining-a))}</b>`; }
function saveLend(){
  const name=$('#l_name').value.trim(), amt=num($('#l_amt').value), rate=num($('#l_rate').value), phone=$('#l_phone').value.trim();
  if(!name) return toast('Type the borrower’s name.'); if(!(amt>0)) return toast('Type the amount borrowed.');
  let c=findCust(name), cid=c&&c.id;
  if(!cid){ cid=uid(); const nos=custList().map(x=>parseInt(String(x.no||'').slice(1))||0);
    save('customers',cid,{name,phone,type:'loan',daily:0,joined:today(),loc:'',guar:'',collector:'',no:'C'+pad(Math.max(0,...nos)+1),at:Date.now(),by:me}); }
  else if(phone&&phone!==c.phone){ save('customers',cid,{...S.customers[cid],phone}); }
  const id=uid(); save('loans',id,{cid,amount:amt,rate,due:$('#l_due').value||'',date:$('#l_date').value||today(),no:nextLoanNo(),note:'',by:me,at:Date.now()});
  lendPre={name:'',loanId:''}; lendDraw(); receipt('loan',id);
}
function saveRepay(){
  const loanId=$('#p_loan').value, a=num($('#p_amt').value); if(!loanId) return toast('Pick the loan being paid.'); if(!(a>0)) return toast('Type the amount received.');
  const L=loanStats(loanId); if(a>L.remaining+0.005) return toast(`That is more than what is left: ${money(L.remaining)}`);
  const id=uid(); save('txns',id,{kind:'repayment',cid:L.cid,loanId,amount:a,date:$('#p_date').value||today(),note:'',by:me,at:Date.now()});
  lendPre={name:'',loanId:''}; lendDraw(); receipt('txn',id);
}

function viewBorrowers(){
  return `<div class="section"><div class="spread"><h2>Borrowers</h2><button class="btn sm pri wr" data-tab="pos">+ New loan</button></div>
   <input id="borSearch" type="search" placeholder="Search name or phone" value="${esc(borQuery)}" aria-label="Search borrowers">
   <div class="chips">${[['owing','Owing'],['overdue','Overdue'],['all','All']].map(([k,l])=>`<button class="chip ${borFilter===k?'on':''}" data-bf="${k}">${l}</button>`).join('')}</div>
   <div class="list" id="borList"></div></div>`;
}
function drawBorrowers(){
  const el=$('#borList'); if(!el) return; const q=borQuery.toLowerCase().trim();
  const rows=custList().map(c=>{ const ls=Object.keys(S.loans).filter(id=>S.loans[id].cid===c.id).map(loanStats); return {...c,ls,owing:ls.reduce((a,l)=>a+Math.max(0,l.remaining),0),over:ls.some(l=>l.status==='Overdue')}; })
    .filter(c=>c.ls.length||c.type==='loan')
    .filter(c=>!q||(c.name||'').toLowerCase().includes(q)||(c.phone||'').replace(/\s/g,'').includes(q.replace(/\s/g,'')))
    .filter(c=>borFilter==='all'||(borFilter==='overdue'?c.over:c.owing>0.005))
    .sort((a,b)=>b.owing-a.owing||(a.name||'').localeCompare(b.name||''));
  el.innerHTML=rows.length?rows.map(c=>`<button class="item" data-act="openCust" data-id="${c.id}"><span class="av">${esc(initials(c.name))}</span><span class="main"><span class="t">${esc(c.name)}</span><span class="s" style="display:block">${esc(c.phone||'no phone')} · ${c.ls.length} loan${c.ls.length===1?'':'s'}</span></span><span class="amt">${c.owing>0.005?money(c.owing):'<span class="pill good">Paid up</span>'}${c.over?'<span style="display:block;margin-top:3px"><span class="pill bad">Overdue</span></span>':''}</span></button>`).join('')
    :`<div class="empty">${Object.keys(S.loans).length?'Nobody in this list.':'No borrowers yet. Tap <b>Lend</b> to record the first loan.'}</div>`;
}
function openCustLoans(id){
  openSheet(()=>{ const c=S.customers[id]; if(!c) return `<div class="spread"><h2>Removed</h2><button class="btn sm" data-act="close">Close</button></div>`;
    const ls=Object.keys(S.loans).filter(k=>S.loans[k].cid===id).map(loanStats).sort(byDate).reverse();
    const reps=Object.entries(S.txns).filter(([,t])=>t.cid===id&&t.kind==='repayment').map(([k,t])=>({id:k,...t})).sort(byDate).reverse();
    const owing=ls.reduce((a,l)=>a+Math.max(0,l.remaining),0), first=ls.find(l=>l.remaining>0.005);
    return `<div class="spread"><div class="row"><span class="av">${esc(initials(c.name))}</span><div><h2>${esc(c.name)}</h2><div class="small muted">${esc(c.no||'')} · ${esc(c.phone||'no phone')}</div></div></div><button class="btn sm" data-act="close">Close</button></div>
    <div class="stats"><div class="stat"><span class="k">Still owes</span><span class="v ${owing>0.005?'bad':''}">${money(owing)}</span></div><div class="stat"><span class="k">Total borrowed</span><span class="v">${money(ls.reduce((a,l)=>a+l.amount,0))}</span></div></div>
    <div class="grid2"><button class="btn pri wr" data-act="lendFor" data-id="${id}">New loan</button>${first?`<button class="btn wr" data-act="repayFor" data-id="${first.id}">Receive repayment</button>`:'<span></span>'}
    <button class="btn wa" data-act="loanStmt" data-id="${id}">Send statement</button><button class="btn wr" data-act="editCust" data-id="${id}">Edit details</button></div>
    <h3>Loans</h3><div class="list">${ls.length?ls.map(l=>`<div class="item"><div class="main"><div class="t">${esc(l.no)} · ${money(l.amount)} at ${l.rate}%</div><div class="s">Given ${fmtDate(l.date)} · due ${fmtDate(l.due)} · paid ${money(l.paid)} of ${money(l.total)}</div></div>${statusPill(l.status)}${delBtn('loans',l.id)}</div>`).join(''):'<div class="empty">No loans.</div>'}</div>
    <h3>Repayments</h3><div class="list">${reps.length?reps.map(t=>`<div class="item"><div class="main"><div class="t">${money(t.amount)} · ${esc(S.loans[t.loanId]?.no||'')}</div><div class="s">${fmtDate(t.date)} · by ${esc(pname(t.by))}</div></div><button class="btn sm" data-act="resend" data-id="${t.id}">Receipt</button>${delBtn('txns',t.id)}</div>`).join(''):'<div class="empty">No repayments yet.</div>'}</div>
    <button class="btn danger wr" data-act="del" data-col="customers" data-id="${id}">Delete borrower</button>`; },true);
}
function loanStmt(id){
  const c=S.customers[id]; const ls=Object.keys(S.loans).filter(k=>S.loans[k].cid===id).map(loanStats);
  const text=`${biz()}\nLOAN STATEMENT · ${fmtDate(today())}\nBorrower: ${c.name} (${c.no||''})`+ls.map(l=>`\n\n${l.no}: ${money(l.amount)} at ${l.rate}% on ${fmtDate(l.date)}\nTo repay: ${money(l.total)}${l.due?' by '+fmtDate(l.due):''}\nPaid: ${money(l.paid)} · Left: ${money(Math.max(0,l.remaining))} (${l.status})`).join('')+`\n\nTOTAL STILL OWED: ${money(ls.reduce((a,l)=>a+Math.max(0,l.remaining),0))}\nThank you.`;
  openSheet(()=>`<div class="spread"><h2>Statement</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre>${sendButtons(text,c.phone)}`);
}

/* ---------- navigation: tabs, swipe, phone back button ---------- */
const TAB_ORDER=['home','customers','pos','loans','partners'];
const scrollPos={};
let guard=false;
function ensureGuard(){ if(guard) return; try{ history.pushState({gapson:1},''); guard=true; }catch(e){} }
function animateView(dir){ const v=$('#view'); if(!v||matchMedia('(prefers-reduced-motion: reduce)').matches) return; v.classList.remove('slide-l','slide-r'); void v.offsetWidth; v.classList.add(dir>0?'slide-l':'slide-r'); }
function switchTab(nt){
  if(!session) return;
  if(nt===tab&&$('#view').innerHTML){ scrollTo({top:0,behavior:'smooth'}); return; }
  const dir=TAB_ORDER.indexOf(nt)>=TAB_ORDER.indexOf(tab)?1:-1;
  scrollPos[tab]=scrollY;
  if(nt!=='home') ensureGuard();
  if(nt!=='pos') LS.set('gapson.tab',nt);
  if(nt==='pos'){ goPOS(); } else { tab=nt; $('#view').innerHTML=''; render(); }
  animateView(dir);
  scrollTo(0,nt==='pos'?0:(scrollPos[nt]||0));
}
addEventListener('popstate',()=>{
  guard=false;
  if(!$('#sheet').hidden){ closeSheet(); if(tab!=='home'&&!POSONLY) ensureGuard(); return; }
  if(session&&!POSONLY&&tab!=='home'){ switchTab('home'); return; }
  history.back();
});
let tx0=null;
document.addEventListener('touchstart',e=>{
  tx0=null; if(!session||POSONLY||!$('#sheet').hidden||e.touches.length!==1) return;
  if(e.target.closest('input,textarea,select,.chips,.kinds,.keys,.quick,.seg,.split,pre')) return;
  tx0={x:e.touches[0].clientX,y:e.touches[0].clientY,t:Date.now()};
},{passive:true});
document.addEventListener('touchend',e=>{
  if(!tx0) return; const p=e.changedTouches[0], dx=p.clientX-tx0.x, dy=p.clientY-tx0.y, dt=Date.now()-tx0.t; tx0=null;
  if(Math.abs(dx)<70||Math.abs(dx)<Math.abs(dy)*2||dt>700) return;
  const order=TAB_ORDER.filter(k=>!(k==='pos'&&viewOnly())); const i=order.indexOf(tab), j=i+(dx<0?1:-1);
  if(i<0||j<0||j>=order.length) return; switchTab(order[j]);
},{passive:true});

/* ---------- sheet, toast, events ---------- */
function openSheet(fn,live){ ensureGuard(); sheetMode={fn,live:live?()=>{$('#sheetBody').innerHTML=fn()}:null}; $('#sheetBody').innerHTML=fn(); $('#sheet').hidden=false; $('#overlay').hidden=false; $('#sheet').scrollTop=0; }
function closeSheet(){ sheetMode=null; $('#sheet').hidden=true; $('#overlay').hidden=true; }
let tt; function toast(m){ const t=$('#toast'); t.textContent=m; t.hidden=false; clearTimeout(tt); tt=setTimeout(()=>t.hidden=true,3200); }
function goPOS(kind,cid){ closeSheet();
  if(loansMode()){ if(!kind||kind==='loan'){ lendTab=isCollector()?'repay':'lend'; if(cid&&S.customers[cid]) lendPre.name=S.customers[cid].name; } else if(kind==='repayment'){ lendTab='repay'; } else { lendTab='other'; pos.kind=kind; posMode='keypad'; } tab='pos'; $('#view').innerHTML=''; render(); return; }
  if(kind){ pos.kind=kind; posMode='keypad'; } if(cid)pos.cid=cid; tab='pos'; $('#view').innerHTML=''; render(); }

document.addEventListener('click',e=>{
  const t=e.target.closest('[data-tab],[data-act],[data-pk],[data-pm],[data-k],[data-q],[data-cf],[data-lf],[data-lt],[data-bf]'); if(!t) { if(e.target.id==='overlay') closeSheet(); return; }
  if(t.dataset.tab){ switchTab(t.dataset.tab); return; }
  if(t.dataset.pk){ pos.kind=t.dataset.pk; keypadDraw(); return; }
  if(t.dataset.lt){ lendTab=t.dataset.lt; lendDraw(); return; }
  if(t.dataset.bf){ borFilter=t.dataset.bf; document.querySelectorAll('[data-bf]').forEach(b=>b.classList.toggle('on',b.dataset.bf===borFilter)); drawBorrowers(); return; }
  if(t.dataset.pm){ posMode=t.dataset.pm; posDraw(); return; }
  if(t.dataset.k){ posKey(t.dataset.k); return; }
  if(t.dataset.q){ pos.amt=String(+(num(pos.amt)+num(t.dataset.q)).toFixed(2)); posAmt(); posHint(); return; }
  if(t.dataset.cf){ custFilter=t.dataset.cf; render(); return; }
  if(t.dataset.lf){ loanFilter=t.dataset.lf; render(); return; }
  const a=t.dataset.act, id=t.dataset.id;
  if(a==='close') closeSheet();
  else if(a==='lockMe'||a==='unlock'||a==='handover'){
    if(t.dataset.armed!=='1'){ t.dataset.armed='1'; t.textContent='Tap again to confirm'; return; }
    setController(a==='lockMe'?me:a==='unlock'?'':otherPartner());
  }
  else if(a==='mtNew') mtForm();
  else if(a==='lendFor'){ lendPre={name:(S.customers[id]||{}).name||'',loanId:''}; goPOS('loan'); }
  else if(a==='repayFor'){ lendPre={name:'',loanId:id}; goPOS('repayment'); }
  else if(a==='loanStmt') loanStmt(id);
  else if(a==='payAll'){ const lid=$('#p_loan')&&$('#p_loan').value; if(!lid) return toast('Pick the loan first.'); $('#p_amt').value=Math.max(0,loanStats(lid).remaining).toFixed(2); repayInfo(); }
  else if(a==='missRemind'){ const c=S.customers[id]; if(c) remindSheet(missText(id),c.phone,'Payment reminder'); }
  else if(a==='dueRemind'){ const L=S.loans[id]; if(L) remindSheet(dueText(id),(S.customers[L.cid]||{}).phone,'Loan reminder'); }
  else if(a==='missAll') openSheet(()=>`<div class="spread"><h2>Missed payments</h2><button class="btn sm" data-act="close">Close</button></div><div class="list">${missedList().map(missRow).join('')||'<div class="empty">Nobody has missed payments.</div>'}</div>`,true);
  else if(a==='dueAll') openSheet(()=>`<div class="spread"><h2>Loans due</h2><button class="btn sm" data-act="close">Close</button></div><div class="list">${loansDue().map(dueRow).join('')||'<div class="empty">No loans due.</div>'}</div>`,true);
  else if(a==='actAll') actSheet();
  else if(a==='actDel'){ actDel=t.dataset.v==='1'; sheetMode&&sheetMode.live&&sheetMode.live(); }
  else if(a==='backupNow') backupNow(t);
  else if(a==='payout') payoutSheet(id);
  else if(a==='payoutGo'){ if(t.dataset.armed!=='1'){ t.dataset.armed='1'; t.textContent='Tap again to confirm'; return; } payoutGo(id); }
  else if(a==='mtEdit') mtForm(id);
  else if(a==='mtReport') rpForm(id);
  else if(a==='mtRemind') mtSend(id,'remind');
  else if(a==='mtSendRep') mtSend(id,'report');
  else if(a==='mtOpen') mtOpen(id);
  else if(a==='newCust') custForm();
  else if(a==='editCust') custForm(id);
  else if(a==='openCust') openCust(id);
  else if(a==='pos') goPOS(t.dataset.kind,t.dataset.cid);
  else if(a==='posSave') posSave();
  else if(a==='logout'){ if(outbox.length&&t.dataset.armed!=='1'){ t.dataset.armed='1'; t.textContent=outbox.length+' not synced. Tap again'; return; } doLogout(); }
  else if(a==='collect') collect(id);
  else if(a==='pos-cash'){ posMode='cashup'; tab='pos'; $('#view').innerHTML=''; render(); scrollTo(0,0); }
  else if(a==='other'){ pos.kind='contribution'; pos.cid=id; posMode='keypad'; posDraw(); scrollTo(0,0); }
  else if(a==='saveCash') saveCash();
  else if(a==='sendCash') sendCash(id);
  else if(a==='addCollector'){ const n=$('#col_name').value.trim(); if(!n) return toast('Type the collector’s name.'); const pin=$('#col_pin').value.trim(); if(!/^\d{4,6}$/.test(pin)) return toast('Give the collector a PIN of 4 to 6 digits.'); save('settings','main',{...set_(),collectors:[...(set_().collectors||[]),{id:'c-'+uid(),name:n,phone:$('#col_phone').value.trim(),pin}]}); toast(n+' added as a collector.'); }
  else if(a==='delCollector'){ if(t.dataset.armed!=='1'){ t.dataset.armed='1'; t.textContent='Tap again'; return; } save('settings','main',{...set_(),collectors:(set_().collectors||[]).filter(c=>c.id!==id)}); toast('Collector removed. Their past entries stay.'); }
  else if(a==='statement') statement(id);
  else if(a==='resend'){ const tx=S.txns[id]; receipt('txn',id); }
  else if(a==='shareExp') receipt('exp',id);
  else if(a==='copy'){ const txt=$('#rcpt')?.textContent||''; const ok=()=>toast('Message copied.'); const fb=()=>{const r=document.createRange();r.selectNodeContents($('#rcpt'));const s=getSelection();s.removeAllRanges();s.addRange(r);toast('Text selected. Use your phone’s Copy.')}; try{navigator.clipboard.writeText(txt).then(ok,fb)}catch(_){fb()} }
  else if(a==='del'){
    if(t.dataset.armed!=='1'){ const orig=t.textContent; t.dataset.armed='1'; t.textContent='Tap again'; setTimeout(()=>{ if(t.isConnected){t.dataset.armed='';t.textContent=orig;} },3000); return; }
    const col=t.dataset.col;
    if(!mineDoc(col,id)) return toast('Locked. Only '+pname(ownerOf(col,S[col][id]))+' can delete this.');
    const others=[...(col==='customers'?Object.entries(S.txns).filter(([,x])=>x.cid===id).map(([k])=>['txns',k]).concat(Object.entries(S.loans).filter(([,x])=>x.cid===id).map(([k])=>['loans',k])):[]),
                  ...(col==='loans'?Object.entries(S.txns).filter(([,x])=>x.loanId===id).map(([k])=>['txns',k]):[])].filter(([c,k])=>!mineDoc(c,k));
    if(others.length){ const who=[...new Set(others.map(([c,k])=>pname(ownerOf(c,S[c][k]))))].join(' and '); return toast(`Can't delete: it has entries recorded by ${who}. They must delete theirs first.`); }
    if(col==='customers'){ Object.entries(S.txns).filter(([,x])=>x.cid===id).forEach(([k])=>removeDoc('txns',k)); Object.entries(S.loans).filter(([,x])=>x.cid===id).forEach(([k])=>removeDoc('loans',k)); closeSheet(); }
    if(col==='loans'){ Object.entries(S.txns).filter(([,x])=>x.loanId===id).forEach(([k])=>removeDoc('txns',k)); }
    removeDoc(col,id); toast('Deleted.'); if(col==='meetings') closeSheet();
  }
  else if(a==='clearEx'){
    if(t.dataset.armed!=='1'){ t.dataset.armed='1'; t.textContent='Tap again to remove all examples'; return; }
    COLS.forEach(col=>Object.entries(S[col]).forEach(([k,d])=>{ if(d&&d.ex) removeDoc(col,k); })); toast('Example entries removed.');
  }
});
document.addEventListener('input',e=>{ const i=e.target.id;
  if(i==='l_name') lendWho(); if(i==='l_amt'||i==='l_rate') lendCalc(); if(i==='p_amt') repayInfo();
  if(i==='borSearch'){ borQuery=e.target.value; drawBorrowers(); }
  if(i==='custSearch'){ custQuery=e.target.value; drawCustList(); }
  if(i==='posRate') posHint();
  if(i==='roundSearch'){ roundQ=e.target.value; drawRound(); }
  if(i==='cashCounted'){ cashCounted=e.target.value; const r=expectedFor(me,cashDate||today()); $('#cashDiff').innerHTML=cashCounted===''?'':cashStatus(num(cashCounted)-r.expected); }
  if(i==='cashNote') cashNote=e.target.value;
});
document.addEventListener('change',e=>{
  if(e.target.id==='meSel'){ me=e.target.value; LS.set('gapson.me',me); toast('This phone now records as '+pname(me)+'.'); cashCounted=''; if(tab==='pos') posDraw(); else render(); }
  if(e.target.id==='p_loan') repayInfo();
  if(e.target.id==='l_name') lendWho();
  if(e.target.id==='actWho'){ actWho=e.target.value; sheetMode&&sheetMode.live&&sheetMode.live(); }
  if(e.target.id==='roundCol'){ roundCol=e.target.value; drawRound(); }
  if(e.target.id==='cashDate'){ cashDate=e.target.value; cashCounted=''; cashNote=''; cashDraw(); }
});
addEventListener('hashchange',()=>{ POSONLY=location.hash==='#pos'||!!(session&&session.user.role==='collector'); applyMode(); });
function applyMode(){ document.body.classList.toggle('posonly',POSONLY); $('.brandname small').textContent=POSONLY?'Point of sale':'Susu · Loans · Partners'; if(POSONLY){ tab='pos'; if(posMode==='keypad'&&!posKinds().some(([k])=>k===pos.kind)) pos.kind=posKinds()[0][0]; } $('#view').innerHTML=''; render(); }
document.addEventListener('submit',e=>{
  e.preventDefault();
  if(e.target.id==='loginForm'){ doLogin(); return; }
  if(e.target.id==='lendForm'){ saveLend(); return; }
  if(e.target.id==='repayForm'){ saveRepay(); return; }
  if(e.target.id==='mtForm'){
    const id=e.target.dataset.id||uid(), old=S.meetings[id]||{}, date=$('#m_date').value; if(!date) return toast('Pick a date.');
    save('meetings',id,{...old,title:$('#m_title').value.trim()||'Partners meeting',date,time:$('#m_time').value,place:$('#m_place').value.trim(),repeat:$('#m_repeat').value,agenda:$('#m_agenda').value.trim(),status:old.status||'planned',by:old.by||me,at:old.at||Date.now()});
    closeSheet(); toast('Meeting saved.'); return;
  }
  if(e.target.id==='rpForm'){
    const id=e.target.dataset.id, m=S.meetings[id]; if(!m) return; let nextid=m.nextid||'';
    if(m.repeat&&m.repeat!=='none'&&!nextid){ nextid=uid(); save('meetings',nextid,{title:m.title,date:addRepeat(m.date,m.repeat),time:m.time,place:m.place,repeat:m.repeat,agenda:m.agenda,status:'planned',by:me,at:Date.now()}); }
    save('meetings',id,{...m,attended:$('#r_att').value.trim(),report:$('#r_rep').value.trim(),decisions:$('#r_dec').value.trim(),actions:$('#r_act').value.trim(),status:'done',nextid,reportBy:me});
    mtSend(id,'report'); return;
  }
  if(e.target.id==='custForm'){
    const f=e.target, id=f.dataset.id||uid(), old=S.customers[id]||{};
    const name=$('#c_name').value.trim(); if(!name) return toast('Type the customer name.');
    const dup=custList().find(c=>c.id!==id&&(c.name||'').toLowerCase()===name.toLowerCase()); if(dup) return toast('A customer with that name already exists.');
    const nos=custList().map(c=>parseInt(String(c.no||'').slice(1))||0);
    const data={...old,name,phone:$('#c_phone').value.trim(),type:$('#c_type').value,daily:num($('#c_daily').value),joined:$('#c_joined').value,loc:$('#c_loc').value.trim(),guar:$('#c_guar').value.trim(),collector:isCollector()?me:($('#c_collector')?$('#c_collector').value:(old.collector||'')),no:old.no||('C'+pad(Math.max(0,...nos)+1)),at:old.at||Date.now(),by:old.by||me};
    const send=$('#c_send').checked; save('customers',id,data);
    if(tab==='pos'){ pos.cid=id; posDraw(); }
    if(send) welcome(id); else if(f.dataset.id) openCust(id); else { closeSheet(); toast('Customer saved.'); }
  }
  if(e.target.id==='setForm'){
    const g=k=>$('#s_'+k).value;
    save('settings','main',{...set_(),business:g('business').trim()||'GAPSON SUSU ENT',p1name:g('p1name').trim(),p2name:g('p2name').trim(),p1phone:g('p1phone').trim(),p2phone:g('p2phone').trim(),shareMode:g('shareMode'),p1pct:num(g('p1pct')),mode:g('mode'),rate:num(g('rate')),missDays:Math.max(1,num(g('missDays'))||2),tpl:g('tpl'),exptpl:g('exptpl')});
    toast('Settings saved.');
  }
});
{ const t0=LS.get('gapson.tab','home'); if(TAB_ORDER.includes(t0)&&t0!=='pos') tab=t0; }
applyMode();
