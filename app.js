
const COLS=['customers','loans','txns','capital','expenses','cashups'];
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

const persist=()=>{LS.set('gapson.cache',S);LS.set('gapson.outbox',outbox)};
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
let lastPull=0, syncErr='';
function save(col,id,data){
  data={...data};
  if(col==='settings') S.settings=data; else S[col][id]=data;
  outbox.push({op:'set',col,id,data}); persist(); render(); flush();
}
function removeDoc(col,id){ delete S[col][id]; outbox.push({op:'del',col,id}); persist(); render(); flush(); }
function overlay(col,m){ for(const o of outbox){ if(o.col!==col)continue; if(o.op==='set')m[o.id]=o.data; else delete m[o.id]; } return m; }
async function api(body){
  const r=await fetch(CFG.SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body),redirect:'follow'});
  if(!r.ok) throw new Error('Server error '+r.status);
  const j=await r.json();
  if(!j.ok){ const e=new Error(j.error||'Server refused the request'); e.server=true; throw e; }
  return j;
}
function applyServer(data){
  if(!data) return;
  for(const col of COLS) S[col]=overlay(col,{...(data[col]||{})});
  let s={...(data.settings||{})}; const p=outbox.filter(o=>o.col==='settings').pop(); if(p) s={...s,...p.data};
  S.settings=s; lastPull=Date.now(); persist(); render();
}
async function flush(){
  if(!session||flushing||!navigator.onLine||!CFG.SCRIPT_URL){ syncPill(); return; }
  flushing=true; syncErr=''; syncPill();
  try{
    while(outbox.length){
      const batch=outbox.slice(0,40);
      const j=await api({action:'push',user:session.user.id,pin:session.pin,ops:batch});
      outbox.splice(0,batch.length); persist();
      if(j.rejected&&j.rejected.length) toast('Not saved: '+j.rejected[0].reason);
      applyServer(j.data);
    }
    if(Date.now()-lastPull>45000){
      const j=await api({action:'pull',user:session.user.id,pin:session.pin});
      if(j.user){ session.user=j.user; LS.set('gapson.session',session); }
      applyServer(j.data);
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
document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ lastPull=0; flush(); } });
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
  api({action:'pull',user,pin}).then(j=>{
    session={user:j.user,pin}; LS.set('gapson.session',session); me=j.user.id; outbox=[];
    applyServer(j.data); POSONLY=location.hash==='#pos'||j.user.role==='collector'; posMode=POSONLY?'round':'keypad'; applyMode();
  }).catch(err=>{ msg.textContent=!navigator.onLine?'You need internet to log in the first time.':(err.server?err.message:'Could not reach the server. Check the link in config.js and your internet.'); });
}
function doLogout(){
  session=null; me='p1'; outbox=[]; S={settings:{}}; COLS.forEach(c=>S[c]={});
  try{ localStorage.removeItem('gapson.session'); localStorage.removeItem('gapson.cache'); localStorage.removeItem('gapson.outbox'); }catch(e){}
  closeSheet(); tab='home'; $('#view').innerHTML=''; render();
}
setTimeout(flush,300);

/* ---------- business maths ---------- */
function commissionOf(cid){
  const c=S.customers[cid]||{}; const months={};
  for(const t of Object.values(S.txns)) if(t.cid===cid&&t.kind==='contribution'){ const m=(t.date||'').slice(0,7); (months[m]=months[m]||[]).push(t); }
  let total=0; const byMonth={};
  for(const [m,list] of Object.entries(months)){ list.sort(byDate); const sum=list.reduce((s,t)=>s+num(t.amount),0); const k=Math.min(num(c.daily)||num(list[0].amount),sum); byMonth[m]=k; total+=k; }
  return {total,byMonth};
}
function loanStats(id){
  const l=S.loans[id]||{}; const amount=num(l.amount), rate=num(l.rate), interest=amount*rate/100, total=amount+interest;
  let paid=0; for(const t of Object.values(S.txns)) if(t.kind==='repayment'&&t.loanId===id) paid+=num(t.amount);
  const remaining=total-paid;
  const status=remaining<-0.005?'Overpaid':remaining<=0.005?'Paid':(l.due&&l.due<today()?'Overdue':'Owing');
  return {id,...l,amount,rate,interest,total,paid,remaining,status,intRecv:total>0?Math.min(paid,total)*interest/total:0};
}
function custStats(cid){
  let paid=0,wd=0;
  for(const t of Object.values(S.txns)) if(t.cid===cid){ if(t.kind==='contribution')paid+=num(t.amount); else if(t.kind==='withdrawal')wd+=num(t.amount); }
  const com=commissionOf(cid).total;
  const loans=Object.keys(S.loans).filter(id=>S.loans[id].cid===cid).map(loanStats);
  return {paid,wd,com,balance:paid-wd-com,owing:loans.reduce((s,l)=>s+Math.max(0,l.remaining),0),loans};
}
function totals(){
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
  T.owedCust=T.contrib-T.wd-T.com;
  T.profit=T.com+T.intRecv-T.exp;
  T.share=shares(T.cap);
  return T;
}
function shares(cap){
  const s=set_();
  if(s.shareMode==='fixed'){ const a=Math.min(100,Math.max(0,num(s.p1pct??50))); return {p1:a/100,p2:(100-a)/100,mode:'fixed'}; }
  const tot=cap.p1+cap.p2; return {p1:tot>0?cap.p1/tot:.5,p2:tot>0?cap.p2/tot:.5,mode:'capital'};
}
function monthly(n=6){
  const out=[]; const d=new Date(); d.setDate(1);
  for(let i=n-1;i>=0;i--){ const x=new Date(d.getFullYear(),d.getMonth()-i,1); out.push({m:x.getFullYear()+'-'+pad(x.getMonth()+1,2),label:MON[x.getMonth()],com:0,int:0,exp:0}); }
  const idx=Object.fromEntries(out.map((o,i)=>[o.m,i]));
  for(const cid of Object.keys(S.customers)){ const bm=commissionOf(cid).byMonth; for(const m in bm) if(m in idx) out[idx[m]].com+=bm[m]; }
  const ls={}; for(const id of Object.keys(S.loans)) ls[id]=loanStats(id);
  for(const t of Object.values(S.txns)) if(t.kind==='repayment'&&ls[t.loanId]){ const m=(t.date||'').slice(0,7); if(m in idx){ const L=ls[t.loanId]; out[idx[m]].int+=L.total>0?num(t.amount)*L.interest/L.total:0; } }
  for(const e of Object.values(S.expenses)){ const m=(e.date||'').slice(0,7); if(m in idx) out[idx[m]].exp+=num(e.amount); }
  out.forEach(o=>o.profit=o.com+o.int-o.exp); return out;
}
const custList=()=>Object.entries(S.customers).map(([id,c])=>({id,...c})).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
const hasExamples=()=>[...COLS.map(c=>Object.values(S[c]))].flat().some(d=>d&&d.ex);
const statusPill=s=>`<span class="pill ${s==='Paid'?'good':s==='Overdue'||s==='Overpaid'?'bad':'warn'}">${s}</span>`;
const KIND={contribution:'Susu payment',withdrawal:'Susu withdrawal',loan:'Loan given',repayment:'Loan repayment'};

/* ---------- views ---------- */
function render(){
  if(!session){ document.body.classList.add('posonly'); $('#view').innerHTML=viewLogin(); syncPill(); return; }
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  const v=$('#view');
  if(tab==='home') v.innerHTML=viewHome();
  else if(tab==='customers'){ if(!v.querySelector('#custSearch')) v.innerHTML=viewCustomers(); else v.querySelectorAll('[data-cf]').forEach(b=>b.classList.toggle('on',b.dataset.cf===custFilter)); drawCustList(); }
  else if(tab==='partners'&&document.activeElement&&document.activeElement.closest&&document.activeElement.closest('#setForm')){ /* keep the form while someone is typing */ }
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
  ${hasExamples()?`<div class="banner" style="margin-bottom:14px">Entries marked EXAMPLE are practice data. Remove them in Partners → Settings when you start for real.</div>`:''}
  <div class="section">
    <div class="hero"><span class="lbl">Cash with the business</span><span class="big num">${money(T.cash)}</span>
    <span class="sub">Partners' money + susu in − payouts − loans out + repayments − expenses</span></div>
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
  el.innerHTML=rows.length?rows.map(c=>{ const st=custStats(c.id); return `<button class="item" data-act="openCust" data-id="${c.id}"><span class="av">${esc(initials(c.name))}</span><span class="main"><span class="t">${esc(c.name)} ${c.ex?'<span class="pill gold">Example</span>':''}</span><span class="s" style="display:block">${esc(c.no||'')} · ${esc(c.phone||'no phone')}</span></span><span class="amt">${money(st.balance)}${st.owing>0?`<span class="s" style="display:block;color:var(--bad)">owes ${money(st.owing)}</span>`:''}</span></button>`; }).join('')
    :`<div class="empty">${Object.keys(S.customers).length?'No customer matches that search.':'No customers yet. Tap <b>+ New customer</b> to enrol the first one.'}</div>`;
}
function viewLoans(){
  const all=Object.keys(S.loans).map(loanStats).sort(byDate).reverse(); const T=totals();
  const rows=all.filter(l=>loanFilter==='all'||(loanFilter==='open'?(l.status==='Owing'||l.status==='Overdue'):loanFilter==='overdue'?l.status==='Overdue':(l.status==='Paid'||l.status==='Overpaid')));
  return `<div class="section"><div class="spread"><h2>Loans</h2><button class="btn sm pri" data-act="pos" data-kind="loan">+ New loan</button></div>
  <div class="stats"><div class="stat"><span class="k">Given out</span><span class="v">${money(T.loansOut)}</span></div><div class="stat"><span class="k">Still owed</span><span class="v">${money(T.outstanding)}</span></div>
  <div class="stat"><span class="k">Interest received</span><span class="v">${money(T.intRecv)}</span></div><div class="stat"><span class="k">Overdue</span><span class="v ${T.overdue?'bad':''}">${T.overdue}</span></div></div>
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
  <div class="section"><div class="spread"><h2>Cash-ups</h2><button class="btn sm" data-act="pos-cash">Do cash-up</button></div>
   <div class="list">${Object.entries(S.cashups).map(([k,c])=>({id:k,...c})).sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,10).map(c=>`<div class="item"><div class="main"><div class="t">${esc(pname(c.person))} · ${fmtDate(c.date)}</div><div class="s">Expected ${money(c.expected)} · counted ${money(c.counted)}${c.note?' · '+esc(c.note):''}</div></div>${cashStatus(num(c.diff))}</div>`).join('')||'<div class="empty">End-of-day cash counts from partners and collectors show here.</div>'}</div></div>
  <div class="section"><h2>Settings</h2>
   <form class="card" id="setForm" style="display:grid;gap:12px">
    <label>Business name<input id="s_business" value="${esc(s.business||'GAPSON SUSU ENT')}"></label>
    <div class="grid2"><label>Partner 1 name<input id="s_p1name" value="${esc(s.p1name||'')}" placeholder="Partner 1"></label><label>Partner 1 phone<input id="s_p1phone" inputmode="tel" value="${esc(s.p1phone||'')}"></label>
    <label>Partner 2 name<input id="s_p2name" value="${esc(s.p2name||'')}" placeholder="Partner 2"></label><label>Partner 2 phone<input id="s_p2phone" inputmode="tel" value="${esc(s.p2phone||'')}"></label></div>
    <div class="grid2"><label>How profit is shared<select id="s_shareMode"><option value="capital" ${s.shareMode!=='fixed'?'selected':''}>By money each put in</option><option value="fixed" ${s.shareMode==='fixed'?'selected':''}>Fixed percentage</option></select></label>
    <label>Partner 1 % (if fixed)<input id="s_p1pct" type="number" min="0" max="100" step="1" value="${esc(s.p1pct??50)}"></label></div>
    <label>Default loan interest %<input id="s_rate" type="number" min="0" step="0.5" value="${esc(s.rate??10)}"></label>
    <label>Receipt message (customers)<textarea id="s_tpl">${esc(s.tpl||DEFAULT_TPL)}</textarea></label>
    <label>Expense message (to partner)<textarea id="s_exptpl" style="min-height:90px">${esc(s.exptpl||DEFAULT_EXP_TPL)}</textarea></label>
    <p class="small muted" style="margin:0">Words in {brackets} fill themselves: {business} {receipt} {date} {customer} {type} {amount} {balance} {partner} {note}</p>
    <button class="btn pri block" type="submit">Save settings</button>
   </form>
   <div class="card" style="display:grid;gap:10px">
    <div class="small muted" style="display:grid;gap:6px;font-weight:600">Logged in as ${meSelect()}</div>
    <p class="small muted" style="margin:0">Everything you record is marked with your name. PINs are changed in the Users sheet.</p>
   </div>
   <div class="card small muted" style="display:grid;gap:6px"><b style="color:var(--ink)">Commission rule</b>One day's contribution per customer per month. The app uses the customer's daily amount, or their first payment that month if no daily amount is set.</div>
   ${hasExamples()?`<button class="btn danger block" data-act="clearEx">Remove all example entries</button>`:''}
  </div>`;
}
function rowWithDelete(t,s,amt,col,id,kind){
  return `<div class="item"><div class="main"><div class="t">${t}</div><div class="s">${s}</div></div><div class="amt">${amt}</div>${kind==='exp'?`<button class="btn sm" data-act="shareExp" data-id="${id}" aria-label="Send">Send</button>`:''}<button class="btn sm danger" data-act="del" data-col="${col}" data-id="${id}">Delete</button></div>`;
}

/* ---------- POS ---------- */
let pos={kind:'contribution',amt:'',cid:'',loanId:''};
const POSKINDS=[['contribution','Susu pay'],['withdrawal','Withdraw'],['repayment','Loan pay'],['loan','New loan'],['expense','Expense'],['capital','Capital']];
const posKinds=()=>POSONLY?POSKINDS.filter(([k])=>k!=='loan'&&k!=='capital'):POSKINDS;
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
  if(!posKinds().some(([k])=>k===pos.kind)) pos.kind='contribution';
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
  $('#posBody').innerHTML=`<div class="card" id="roundSum" style="display:grid;gap:8px"></div>
   <div class="row" style="flex-wrap:nowrap"><input id="roundSearch" type="search" placeholder="Search customer" value="${esc(roundQ)}" aria-label="Search customers" style="flex:1"><button class="btn sm" data-act="newCust" style="flex:none">+ New</button></div>
   <div class="list" id="roundList"></div>`;
  drawRound();
}
function drawRound(){
  const sumEl=$('#roundSum'), listEl=$('#roundList'); if(!sumEl||!listEl) return;
  const paid=todayPaid(), list=custList().filter(c=>c.type!=='loan');
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
    const right=p?`<span class="pill good">Paid ${money(p.reduce((s,t)=>s+num(t.amount),0))}</span><button class="btn sm" data-act="resend" data-id="${p[p.length-1].id}">Send</button><button class="btn sm danger" data-act="del" data-col="txns" data-id="${p[p.length-1].id}">Undo</button>`
      :(d?`<button class="btn sm pri" data-act="collect" data-id="${c.id}">Collect ${money(d)}</button>`:'')+`<button class="btn sm" data-act="other" data-id="${c.id}">${d?'Other':'Enter amount'}</button>`;
    return `<div class="item" style="flex-wrap:wrap"><span class="av">${esc(initials(c.name))}</span><div class="main"><div class="t">${esc(c.name)} ${c.ex?'<span class="pill gold">Example</span>':''}</div><div class="s">${esc(c.no||'')} · ${d?'daily '+money(d):'no daily amount set'}</div></div><div class="row" style="justify-content:flex-end;flex:1 1 100%;padding-left:48px">${right}</div></div>`;
  }).join(''):`<div class="empty">${list.length?'No customer matches that search.':'No susu customers yet. Tap <b>+ New</b> to enrol one.'}</div>`;
}
function collect(cid){
  const c=S.customers[cid]; if(!c) return; if(todayPaid()[cid]) return toast(c.name+' has already paid today.');
  const id=uid(); save('txns',id,{kind:'contribution',cid,amount:num(c.daily),date:today(),note:'',by:me,at:Date.now()});
  toast(`${c.name}: ${money(c.daily)} collected`);
}

/* ---------- cash-up ---------- */
function expectedFor(person,date){
  const r={susu:0,repay:0,wd:0,loans:0,exp:0};
  for(const t of Object.values(S.txns)) if(t.by===person&&t.date===date){ const a=num(t.amount); if(t.kind==='contribution')r.susu+=a; else if(t.kind==='repayment')r.repay+=a; else if(t.kind==='withdrawal')r.wd+=a; }
  for(const l of Object.values(S.loans)) if(l.by===person&&l.date===date) r.loans+=num(l.amount);
  for(const e of Object.values(S.expenses)) if(e.by===person&&e.date===date) r.exp+=num(e.amount);
  r.expected=r.susu+r.repay-r.wd-r.loans-r.exp; return r;
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
    ${line('Susu collected',r.susu)}${line('Loan repayments received',r.repay)}${line('Susu withdrawals paid out',r.wd,1)}${line('Loans given out',r.loans,1)}${line('Expenses paid',r.exp,1)}
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
  const text=`${biz()}\nCASH-UP · ${fmtDate(c.date)}\nBy: ${pname(c.person)}\nSusu collected: ${money(d.susu)}\nRepayments: ${money(d.repay)}\nWithdrawals paid: ${money(d.wd)}\nLoans given: ${money(d.loans)}\nExpenses: ${money(d.exp)}\nExpected cash: ${money(c.expected)}\nCounted cash: ${money(c.counted)}\nResult: ${Math.abs(c.diff)<0.005?'Balanced':(c.diff<0?'SHORT '+money(-c.diff):'OVER '+money(c.diff))}${c.note?'\nNote: '+c.note:''}`;
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
  else if(k==='capital') ex.innerHTML=`<label>Note<input id="posNote" placeholder="e.g. Starting capital (use − for money taken out)"></label>${d}`;
  else ex.innerHTML=`<label>Note (optional)<input id="posNote"></label>${d}`;
  posAmt(); posHint();
  ['posCid','posLoan'].forEach(i=>{const e=$('#'+i); if(e) e.onchange=()=>{ if(i==='posCid')pos.cid=e.value; else pos.loanId=e.value; posHint(); };});
}
function posRefreshSelects(){ const a=$('#posCid'); if(a){ const v=a.value; a.innerHTML=custOptions(v||pos.cid,pos.kind==='loan'?c=>c.type!=='susu':c=>c.type!=='loan'); } const b=$('#posLoan'); if(b){ b.innerHTML=loanOptions(b.value||pos.loanId); } posHint(); }
function posAmt(){ const lbl={contribution:'Susu payment',withdrawal:'Withdrawal',repayment:'Loan repayment',loan:'Loan amount',expense:'Expense',capital:'Capital'}[pos.kind]; $('#posLbl').textContent=lbl; $('#posAmt').textContent='GH₵ '+(pos.amt||'0'); }
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
    <label>Type<select id="c_type"><option value="both" ${!c.type||c.type==='both'?'selected':''}>Susu + loans</option><option value="susu" ${c.type==='susu'?'selected':''}>Susu only</option><option value="loan" ${c.type==='loan'?'selected':''}>Loans only</option></select></label></div>
    <div class="grid2"><label>Daily susu amount<input id="c_daily" type="number" min="0" step="0.5" value="${esc(c.daily||'')}"></label><label>Date enrolled<input id="c_joined" type="date" value="${esc(c.joined||today())}"></label></div>
    <label>Location<input id="c_loc" value="${esc(c.loc||'')}"></label>
    <label>Guarantor (name & phone)<input id="c_guar" value="${esc(c.guar||'')}"></label>
    <label><span><input type="checkbox" id="c_send" ${id?'':'checked'} style="width:auto;margin-right:8px">Send a welcome message after saving</span></label>
    <button class="btn pri block" type="submit">Save customer</button></form>`);
}
function welcome(id){
  const c=S.customers[id]; const text=`${biz()}\nWelcome, ${c.name}!\nYou are enrolled as customer ${c.no}.${num(c.daily)?`\nDaily susu: ${money(c.daily)}.`:''}\nCommission: one day's contribution each month.\nThank you.`;
  openSheet(()=>`<div class="spread"><h2>Customer saved</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre>${sendButtons(text,c.phone)}`);
}
function openCust(id){
  openSheet(()=>{
    const c=S.customers[id]; if(!c) return `<div class="spread"><h2>Customer removed</h2><button class="btn sm" data-act="close">Close</button></div>`;
    const st=custStats(id);
    const tx=Object.entries(S.txns).filter(([,t])=>t.cid===id).map(([tid,t])=>({id:tid,...t})).sort(byDate).reverse();
    return `<div class="spread"><div class="row"><span class="av">${esc(initials(c.name))}</span><div><h2>${esc(c.name)}</h2><div class="small muted">${esc(c.no||'')} · ${esc(c.phone||'no phone')}${c.loc?' · '+esc(c.loc):''}</div></div></div><button class="btn sm" data-act="close">Close</button></div>
    <div class="stats"><div class="stat"><span class="k">Susu balance</span><span class="v">${money(st.balance)}</span></div><div class="stat"><span class="k">Loan owed</span><span class="v ${st.owing>0?'bad':''}">${money(st.owing)}</span></div>
    <div class="stat"><span class="k">Paid in</span><span class="v">${money(st.paid)}</span></div><div class="stat"><span class="k">Commission taken</span><span class="v">${money(st.com)}</span></div></div>
    <div class="grid2"><button class="btn pri" data-act="pos" data-kind="contribution" data-cid="${id}">Susu pay</button><button class="btn" data-act="pos" data-kind="withdrawal" data-cid="${id}">Withdraw</button>
    <button class="btn" data-act="pos" data-kind="loan" data-cid="${id}">New loan</button><button class="btn wa" data-act="statement" data-id="${id}">Send statement</button></div>
    ${st.loans.length?`<h3>Loans</h3><div class="list">${st.loans.map(l=>`<div class="item"><div class="main"><div class="t">${esc(l.no)} · ${money(l.amount)} at ${l.rate}%</div><div class="s">Given ${fmtDate(l.date)} · due ${fmtDate(l.due)} · paid ${money(l.paid)} of ${money(l.total)}</div></div>${statusPill(l.status)}<button class="btn sm danger" data-act="del" data-col="loans" data-id="${l.id}">Delete</button></div>`).join('')}</div>`:''}
    <h3>History</h3><div class="list">${tx.length?tx.map(t=>`<div class="item"><div class="main"><div class="t">${esc(KIND[t.kind])}${t.note?' · '+esc(t.note):''}</div><div class="s">${fmtDate(t.date)} · by ${esc(pname(t.by))}</div></div><div class="amt">${money(t.amount)}</div><button class="btn sm" data-act="resend" data-id="${t.id}">Receipt</button><button class="btn sm danger" data-act="del" data-col="txns" data-id="${t.id}">Delete</button></div>`).join(''):`<div class="empty">No payments yet.</div>`}</div>
    <div class="grid2"><button class="btn" data-act="editCust" data-id="${id}">Edit details</button><button class="btn danger" data-act="del" data-col="customers" data-id="${id}">Delete customer</button></div>`;
  },true);
}
function statement(id){
  const c=S.customers[id], st=custStats(id);
  const text=`${biz()}\nSTATEMENT · ${fmtDate(today())}\nCustomer: ${c.name} (${c.no||''})\nTotal paid in: ${money(st.paid)}\nWithdrawn: ${money(st.wd)}\nCommission: ${money(st.com)}\nSusu balance: ${money(st.balance)}`+(st.loans.length?`\nLoans owed: ${money(st.owing)}`+st.loans.filter(l=>l.remaining>0.005).map(l=>`\n  ${l.no}: ${money(l.remaining)} left${l.due?' (due '+fmtDate(l.due)+')':''}`).join(''):'')+`\nThank you.`;
  openSheet(()=>`<div class="spread"><h2>Statement</h2><button class="btn sm" data-act="close">Done</button></div><pre class="receipt" id="rcpt">${esc(text)}</pre>${sendButtons(text,c.phone)}`);
}

/* ---------- sheet, toast, events ---------- */
function openSheet(fn,live){ sheetMode={fn,live:live?()=>{$('#sheetBody').innerHTML=fn()}:null}; $('#sheetBody').innerHTML=fn(); $('#sheet').hidden=false; $('#overlay').hidden=false; $('#sheet').scrollTop=0; }
function closeSheet(){ sheetMode=null; $('#sheet').hidden=true; $('#overlay').hidden=true; }
let tt; function toast(m){ const t=$('#toast'); t.textContent=m; t.hidden=false; clearTimeout(tt); tt=setTimeout(()=>t.hidden=true,3200); }
function goPOS(kind,cid){ closeSheet(); if(kind){ pos.kind=kind; posMode='keypad'; } if(cid)pos.cid=cid; tab='pos'; $('#view').innerHTML=''; render(); }

document.addEventListener('click',e=>{
  const t=e.target.closest('[data-tab],[data-act],[data-pk],[data-pm],[data-k],[data-q],[data-cf],[data-lf]'); if(!t) { if(e.target.id==='overlay') closeSheet(); return; }
  if(t.dataset.tab){ tab=t.dataset.tab; if(tab==='pos'){ goPOS(); } else { $('#view').innerHTML=''; render(); } scrollTo(0,0); return; }
  if(t.dataset.pk){ pos.kind=t.dataset.pk; keypadDraw(); return; }
  if(t.dataset.pm){ posMode=t.dataset.pm; posDraw(); return; }
  if(t.dataset.k){ posKey(t.dataset.k); return; }
  if(t.dataset.q){ pos.amt=String(+(num(pos.amt)+num(t.dataset.q)).toFixed(2)); posAmt(); posHint(); return; }
  if(t.dataset.cf){ custFilter=t.dataset.cf; render(); return; }
  if(t.dataset.lf){ loanFilter=t.dataset.lf; render(); return; }
  const a=t.dataset.act, id=t.dataset.id;
  if(a==='close') closeSheet();
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
    if(col==='customers'){ Object.entries(S.txns).filter(([,x])=>x.cid===id).forEach(([k])=>removeDoc('txns',k)); Object.entries(S.loans).filter(([,x])=>x.cid===id).forEach(([k])=>removeDoc('loans',k)); closeSheet(); }
    if(col==='loans'){ Object.entries(S.txns).filter(([,x])=>x.loanId===id).forEach(([k])=>removeDoc('txns',k)); }
    removeDoc(col,id); toast('Deleted.');
  }
  else if(a==='clearEx'){
    if(t.dataset.armed!=='1'){ t.dataset.armed='1'; t.textContent='Tap again to remove all examples'; return; }
    COLS.forEach(col=>Object.entries(S[col]).forEach(([k,d])=>{ if(d&&d.ex) removeDoc(col,k); })); toast('Example entries removed.');
  }
});
document.addEventListener('input',e=>{ const i=e.target.id;
  if(i==='custSearch'){ custQuery=e.target.value; drawCustList(); }
  if(i==='posRate') posHint();
  if(i==='roundSearch'){ roundQ=e.target.value; drawRound(); }
  if(i==='cashCounted'){ cashCounted=e.target.value; const r=expectedFor(me,cashDate||today()); $('#cashDiff').innerHTML=cashCounted===''?'':cashStatus(num(cashCounted)-r.expected); }
  if(i==='cashNote') cashNote=e.target.value;
});
document.addEventListener('change',e=>{
  if(e.target.id==='meSel'){ me=e.target.value; LS.set('gapson.me',me); toast('This phone now records as '+pname(me)+'.'); cashCounted=''; if(tab==='pos') posDraw(); else render(); }
  if(e.target.id==='cashDate'){ cashDate=e.target.value; cashCounted=''; cashNote=''; cashDraw(); }
});
addEventListener('hashchange',()=>{ POSONLY=location.hash==='#pos'||!!(session&&session.user.role==='collector'); applyMode(); });
function applyMode(){ document.body.classList.toggle('posonly',POSONLY); $('.brandname small').textContent=POSONLY?'Point of sale':'Susu · Loans · Partners'; if(POSONLY){ tab='pos'; if(posMode==='keypad'&&!posKinds().some(([k])=>k===pos.kind)) pos.kind='contribution'; } $('#view').innerHTML=''; render(); }
document.addEventListener('submit',e=>{
  e.preventDefault();
  if(e.target.id==='loginForm'){ doLogin(); return; }
  if(e.target.id==='custForm'){
    const f=e.target, id=f.dataset.id||uid(), old=S.customers[id]||{};
    const name=$('#c_name').value.trim(); if(!name) return toast('Type the customer name.');
    const dup=custList().find(c=>c.id!==id&&(c.name||'').toLowerCase()===name.toLowerCase()); if(dup) return toast('A customer with that name already exists.');
    const nos=custList().map(c=>parseInt(String(c.no||'').slice(1))||0);
    const data={...old,name,phone:$('#c_phone').value.trim(),type:$('#c_type').value,daily:num($('#c_daily').value),joined:$('#c_joined').value,loc:$('#c_loc').value.trim(),guar:$('#c_guar').value.trim(),no:old.no||('C'+pad(Math.max(0,...nos)+1)),at:old.at||Date.now(),by:old.by||me};
    const send=$('#c_send').checked; save('customers',id,data);
    if(tab==='pos'){ pos.cid=id; posDraw(); }
    if(send) welcome(id); else if(f.dataset.id) openCust(id); else { closeSheet(); toast('Customer saved.'); }
  }
  if(e.target.id==='setForm'){
    const g=k=>$('#s_'+k).value;
    save('settings','main',{...set_(),business:g('business').trim()||'GAPSON SUSU ENT',p1name:g('p1name').trim(),p2name:g('p2name').trim(),p1phone:g('p1phone').trim(),p2phone:g('p2phone').trim(),shareMode:g('shareMode'),p1pct:num(g('p1pct')),rate:num(g('rate')),tpl:g('tpl'),exptpl:g('exptpl')});
    toast('Settings saved.');
  }
});
applyMode();
