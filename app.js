const $ = s => document.querySelector(s);
const modal = $("#modal");
let me = null;
let ads = [];
let conversations = [];
let currentConversation = null;
const socket = io();

const catalog = {
  Fruits: [
    "Rocket","Spin","Blade","Spring","Bomb","Smoke","Spike","Flame","Ice","Sand","Dark",
    "Eagle","Diamond","Light","Rubber","Ghost","Magma","Quake","Buddha","Love","Creation",
    "Spider","Sound","Phoenix","Portal","Lightning","Pain","Blizzard","Gravity","Mammoth","T-Rex",
    "Dough","Shadow","Venom","Gas","Spirit","Tiger","Yeti","Kitsune","Control","Dragon"
  ],
  Gamepasses: [
    "Fruit Notifier","Dark Blade","+1 Fruit Storage","2x Mastery","2x Money","2x Boss Drops","Fast Boats"
  ],
  Profiles: ["Claimable Profile","Limited Profile"],
  Skins: ["Limited Skin","Fruit Skin","Character Skin","Boat Skin"],
  Boosts: ["2x EXP Boost","2x Drop Chance"],
  Other: ["Voucher","Trade Token","Gift"]
};

// Exact current English fruit names, with simple symbol representations for the picker.
const fruitIcons = {
  Rocket:"🚀", Spin:"🌀", Blade:"🍃", Spring:"🌀", Bomb:"💣", Smoke:"💨", Spike:"🔺",
  Flame:"🔥", Ice:"❄️", Sand:"🏜️", Dark:"⚫", Eagle:"🦅", Diamond:"💎", Light:"✨",
  Rubber:"🛞", Ghost:"👻", Magma:"🌋", Quake:"💥", Buddha:"☀️", Love:"❤️", Creation:"🛠️",
  Spider:"🕷️", Sound:"🔊", Phoenix:"🐦", Portal:"🌀", Lightning:"⚡", Pain:"😣", Blizzard:"🌨️",
  Gravity:"🌌", Mammoth:"🦣", "T-Rex":"🦖", Dough:"🍩", Shadow:"🌑", Venom:"🐍", Gas:"💨",
  Spirit:"👻", Tiger:"🐅", Yeti:"❄️", Kitsune:"🦊", Control:"🔮", Dragon:"🐉"
};

const itemIcons = { Gamepasses:"🎟️", Profiles:"👤", Skins:"🎨", Boosts:"⚡", Other:"🎁" };
const MAX_SELECTIONS = 4;



async function api(url, options={}) {
  const r = await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const data = await r.json().catch(()=>({}));
  if(!r.ok) {
    if(data.banned && typeof showBanNotice === "function") showBanNotice();
    throw Object.assign(new Error(data.error||"Request failed"),data);
  }
  return data;
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]))}
function timeAgo(t){const s=Math.floor((Date.now()-t)/1000);if(s<60)return"s just now";if(s<3600)return`${Math.floor(s/60)}m ago`;if(s<86400)return`${Math.floor(s/3600)}h ago`;return`${Math.floor(s/86400)}d ago`}
function itemsHtml(items){return items.map(x=>`<span class="item">${esc(x.name)} <span class="qty">×${x.qty}</span></span>`).join("")}

async function load(){
  const m=await api("/api/me"); me=m.loggedIn?m.user:null;
  ads=await api("/api/ads"); renderAds();
  if(me) { updateNav(); if(me.banned) showBanNotice(); }
  await loadAnnouncement();
}
async function loadAnnouncement(){
  try{
    const a=await api("/api/announcements");
    const el=$("#announcement");
    if(a){ el.innerHTML=`<b>📢 Announcement</b><span>${esc(a.text)}</span>`; el.classList.remove("hidden"); }
    else el.classList.add("hidden");
  }catch{}
}
function updateNav(){
  $("#createBtn").textContent="＋ Create Ad";
  $("#profileBtn").textContent=(me.display_name||me.username).slice(0,1).toUpperCase();
  $("#modBtn")?.classList.toggle("hidden", !["owner","moderator"].includes(me.role));
  $("#createBtn").classList.toggle("mutedAction", !!me.banned);
  $("#chatBtn").classList.toggle("mutedAction", !!me.banned);
}

function showBanNotice(){
  if(!me?.banned) return;
  show(`<button class="close" onclick="closeModal()">×</button><div class="banNotice"><div class="banIcon">🔒</div><h2>You are muted from chat and trading</h2><p>You cannot send chats or post trades while your FruitForge account is banned.</p>${me.ban_reason?`<p class="small"><b>Reason:</b> ${esc(me.ban_reason)}</p>`:""}<button class="primary" id="appealBanBtn">Appeal Ban</button><button class="ghost" id="bannedChatBtn">Open Chats</button></div>`);
  $("#appealBanBtn").onclick=openBanAppeal;
  $("#bannedChatBtn").onclick=()=>openChats();
}

async function openBanAppeal(){
  let status={}; try{status=await api("/api/ban-status")}catch{}
  if(status.pendingAppeal){
    show(`<button class="close" onclick="closeModal()">×</button><h2>Appeal Ban</h2><div class="modCard"><b>Appeal pending</b><p class="small">Your appeal has already been sent to the moderators.</p></div>`);
    return;
  }
  show(`<button class="close" onclick="closeModal()">×</button><h2>Appeal Ban</h2><p class="appealTemplate"><b>Be honest.</b> Your message will be reviewed by the moderators.</p><div class="field"><label>What happened?</label><textarea id="appealMessage" rows="7" maxlength="2000" placeholder="Explain what you did, what happened, and why you are appealing the ban…"></textarea></div><button class="primary" id="submitAppeal">Send Appeal to Moderators</button>`);
  $("#submitAppeal").onclick=async()=>{
    try{await api("/api/ban-appeals",{method:"POST",body:JSON.stringify({message:$("#appealMessage").value})});show(`<button class="close" onclick="closeModal()">×</button><h2>Appeal sent</h2><p>Your appeal was sent to the moderators for review.</p>`);}
    catch(e){alert(e.message)}
  };
}
window.openBanAppeal=openBanAppeal;
function renderAds(){
  const q=$("#search").value.trim().toLowerCase();
  const filtered=ads.filter(a=>{
    const blob=JSON.stringify(a).toLowerCase();
    return !q||blob.includes(q);
  });
  $("#feed").innerHTML=filtered.map(a=>`
    <article class="card">
      <div class="user">
        <img class="avatar" src="${esc(a.avatar||"https://tr.rbxcdn.com/30DAY-AvatarHeadshot-Png/150/150/AvatarHeadshot/Webp/noFilter")}" onerror="this.style.display='none'">
        <div><div class="username" ${me?.role==="owner"?`onclick="openUser(${a.user_id})" style="cursor:pointer"`:""}>${esc(a.display_name||a.username)}</div><div class="time">${timeAgo(a.created_at)}</div></div>
      </div>
      <div class="tradeGrid">
        <div class="tradeBox"><div class="label">I HAVE</div><div class="items">${itemsHtml(a.have)}</div></div>
        <div class="tradeBox"><div class="label">I WANT</div><div class="items">${itemsHtml(a.want)}</div></div>
      </div>
      ${a.nlf?`<div class="nlf"><b>NLF:</b> ${esc(a.nlf)}</div>`:""}
      ${a.description?`<div class="desc">${esc(a.description)}</div>`:""}
      <div class="cardActions">
        <button class="ghost danger" onclick="reportAd(${a.id})">⚠ Report</button>
        ${me && me.id!==a.user_id?`<button class="primary" onclick="startChat(${a.id})">💬 Chat</button>`:""}
      </div>
    </article>`).join("");
  $("#empty").classList.toggle("hidden",filtered.length!==0);
}

function show(content){modal.innerHTML=`<div class="panel">${content}</div>`;modal.classList.remove("hidden")}
function closeModal(){modal.classList.add("hidden");modal.innerHTML=""}
modal.addEventListener("click",e=>{if(e.target===modal)closeModal()});

document.querySelectorAll(".login").forEach(b=>b.onclick=()=>{
  b.disabled=true;
  location.href=`/auth/${b.dataset.provider}`;
});
$("#createBtn").onclick=()=>me?(me.banned?showBanNotice():createAd()):location.href="/auth/google";
$("#profileBtn").onclick=()=>me?profile():location.href="/auth/google";
$("#chatBtn").onclick=()=>me?openChats():location.href="/auth/google";
$("#search").oninput=renderAds;
$("#modBtn")?.addEventListener("click",()=>openModerator());
$("#reportTop").onclick=()=>show(`<button class="close" onclick="closeModal()">×</button><h2>Report an ad</h2><p class="small">Use the Report button on a specific ad so FruitForge can identify it.</p>`);
$("#userSearchBtn").onclick=searchUsers;

window.reportAd=async id=>{
  if(!me)return location.href="/auth/google";
  show(`<button class="close" onclick="closeModal()">×</button><h2>Report ad #${id}</h2>
  <div class="field"><label>Reason</label><textarea id="reason" rows="4" placeholder="Explain what is wrong…"></textarea></div>
  <button class="primary" id="sendReport">Submit report</button>`);
  $("#sendReport").onclick=async()=>{try{await api("/api/reports",{method:"POST",body:JSON.stringify({adId:id,reason:$("#reason").value})});closeModal();alert("Report submitted.");}catch(e){alert(e.message)}}
};

function createAd(){
  show(`<button class="close" onclick="closeModal()">×</button><h2>Create Ad</h2>
  <p class="small">You can post one ad every 8 minutes. Both I HAVE and I WANT are required.</p>
  <div class="formRow">
    <div class="field"><label>I HAVE</label><div class="selector"><div id="have" class="selected"></div><div class="pickerTabs" id="haveTabs"></div><div class="picker" id="havePicker"></div></div></div>
    <div class="field"><label>I WANT</label><div class="selector"><div id="want" class="selected"></div><div class="pickerTabs" id="wantTabs"></div><div class="picker" id="wantPicker"></div></div></div>
  </div>
  <div class="field"><label>MY INVENTORY</label><div class="selector"><div id="inv" class="selected"></div><div class="pickerTabs" id="invTabs"></div><div class="picker" id="invPicker"></div></div></div>
  <div class="field"><label>NLF — Not Looking For</label><input id="nlf" maxlength="1000" placeholder="Optional"></div>
  <div class="field"><label>Description</label><textarea id="desc" rows="3" maxlength="2000" placeholder="Add trade details…"></textarea></div>
  <div id="cooldown" class="countdown"></div>
  <button class="primary" id="postAd">Post Ad</button>`);

  const state={have:[],want:[],inv:[]};
  const categories=Object.keys(catalog);

  for(const type of ["have","want","inv"]){
    const tabs=$(`#${type}Tabs`);
    const picker=$(`#${type}Picker`);
    let activeCategory="Fruits";

    tabs.innerHTML=categories.map((cat,i)=>
      `<button type="button" class="pickerTab ${i===0?"active":""}" data-cat="${esc(cat)}">${itemIcons[cat]} ${esc(cat)}</button>`
    ).join("");

    function draw(){
      picker.innerHTML=catalog[activeCategory].map(name=>
        `<button type="button" class="pick" data-name="${esc(name)}" title="Add ${esc(name)}">
          <span class="itemIcon">${itemIcons[activeCategory]}</span>
          <span class="pickName">${esc(name)}</span>
        </button>`
      ).join("");
    }

    tabs.onclick=e=>{
      const b=e.target.closest(".pickerTab"); if(!b)return;
      activeCategory=b.dataset.cat;
      tabs.querySelectorAll(".pickerTab").forEach(x=>x.classList.remove("active"));
      b.classList.add("active");
      draw();
    };

    picker.onclick=e=>{
      const b=e.target.closest(".pick"); if(!b)return;
      const arr=state[type], name=b.dataset.name;
      const index=arr.findIndex(x=>x.name===name);
      // Clicking an already-selected item removes it; first click adds it.
      if(index>=0) {
        arr.splice(index,1);
      } else {
        if(arr.length >= MAX_SELECTIONS) {
          alert(`You can add up to ${MAX_SELECTIONS} items only.`);
          return;
        }
        arr.push({name,qty:1});
      }
      renderSelection(type,arr);
    };
    draw();
  }

  function renderSelection(type,arr){
    $(`#${type}`).innerHTML=arr.map((x,i)=>
      `<button type="button" class="chip" data-index="${i}" title="Remove ${esc(x.name)}">${iconFor(x.name)} ${esc(x.name)} <span class="qty">×${x.qty}</span></button>`
    ).join("");
  }

  function findCategory(name){
    return categories.find(cat=>catalog[cat].includes(name)) || "Other";
  }
  function iconFor(name){
    const cat=findCategory(name);
    return cat === "Fruits" ? (fruitIcons[name] || "🍎") : (itemIcons[cat] || "🎁");
  }

  let timer;
  const tick=async()=>{
    try{
      const x=await api("/api/cooldown");
      if(x.remainingMs>0){
        $("#postAd").disabled=true;
        $("#cooldown").textContent=`Posting available in ${fmt(x.remainingMs)}`;
      }else{
        $("#postAd").disabled=false;
        $("#cooldown").textContent="Ready to post.";
      }
    }catch{}
  };
  const fmt=ms=>{const sec=Math.ceil(ms/1000);return`${Math.floor(sec/60)}m ${sec%60}s`};
  tick(); timer=setInterval(tick,1000);

  $("#postAd").onclick=async()=>{
    try{
      if(!state.have.length||!state.want.length)return alert("I HAVE and I WANT are both required.");
      await api("/api/ads",{
        method:"POST",
        body:JSON.stringify({have:state.have,want:state.want,inventory:state.inv,nlf:$("#nlf").value,description:$("#desc").value})
      });
      clearInterval(timer); closeModal(); ads=await api("/api/ads"); renderAds();
    }catch(e){alert(e.message)}
  };
}
async function startChat(adId){
  if(me?.banned) return showBanNotice();
  try{const c=await api("/api/conversations",{method:"POST",body:JSON.stringify({adId})});openChats(c.id)}catch(e){alert(e.message)}
}
window.startChat=startChat;
async function startUserChat(userId){
  if(me?.banned) return showBanNotice();
  try{const c=await api("/api/conversations",{method:"POST",body:JSON.stringify({userId})});openChats(c.id)}catch(e){alert(e.message)}
}
window.startUserChat=startUserChat;

async function openChats(selectedId){
  conversations=await api("/api/conversations");
  show(`<button class="close" onclick="closeModal()">×</button><h2>Chat</h2>
    ${me?.banned?'<p class="small banInline">You are banned. You cannot start new conversations, but you can reply to an existing moderator conversation.</p>':''}
    <div class="chatLayout"><div class="chatList" id="chatList"></div><div class="messages"><div id="messageList" class="messageList"><div class="empty">No Chats</div></div><div class="send"><input id="messageInput" placeholder="Type a message…"><button class="primary" id="sendBtn">Send</button></div></div></div>`);
  renderChats(selectedId);
  $("#sendBtn").onclick=sendMessage;
  $("#messageInput").onkeydown=e=>{if(e.key==="Enter")sendMessage()};
}
async function renderChats(selectedId){
  $("#chatList").innerHTML=conversations.length?conversations.map(c=>`<div class="chatRow ${selectedId==c.id?"active":""}" onclick="selectChat(${c.id})"><b>${esc(c.other_username)}</b><div class="time">${c.ad_id?`Ad #${c.ad_id}`:"Direct chat"}${c.other_banned?" • Banned":""}</div></div>`).join(""):`<div class="empty">No Chats</div>`;
  if(selectedId)selectChat(selectedId);
}
window.selectChat=async id=>{
  currentConversation=id;
  document.querySelectorAll(".chatRow").forEach(x=>x.classList.remove("active"));
  const row=[...document.querySelectorAll(".chatRow")].find(x=>x.getAttribute("onclick")===`selectChat(${id})`); if(row)row.classList.add("active");
  try{const msgs=await api(`/api/conversations/${id}/messages`);
    $("#messageList").innerHTML=msgs.map(m=>`<div class="bubble ${m.sender_id===me.id?"mine":""}">${esc(m.body)}</div>`).join("")||`<div class="empty">No messages yet.</div>`;
    $("#messageList").scrollTop=$("#messageList").scrollHeight;
    socket.emit("joinConversation",{conversationId:id});
  }catch(e){alert(e.message)}
};
async function sendMessage(){
  if(!currentConversation)return;
  const input=$("#messageInput"), body=input.value.trim();if(!body)return;
  try{await api("/api/messages",{method:"POST",body:JSON.stringify({conversationId:currentConversation,body})});input.value=""}catch(e){alert(e.message)}
}
socket.on("message",m=>{
  if(m.conversation_id!==currentConversation)return;
  const div=document.createElement("div");div.className=`bubble ${m.sender_id===me?.id?"mine":""}`;div.textContent=m.body;
  $("#messageList")?.appendChild(div);if($("#messageList"))$("#messageList").scrollTop=$("#messageList").scrollHeight;
});


async function openUserPublic(userId){
  try{
    const u=await api(`/api/users/${userId}`);
    show(`<button class="close" onclick="closeModal()">×</button><h2>${esc(u.display_name||u.username)}</h2><p class="small">@${esc(u.username)} • ${esc(u.provider)}</p><div class="profileGrid"><div><b>Status</b><div>${u.banned?"Banned":"Active"}</div></div><div><b>Account</b><div>${esc(u.provider)}</div></div></div>${u.id!==me.id&&!u.banned?`<button class="primary" onclick="startUserChat(${u.id})">💬 Start Chat</button>`:""}${u.banned&&["owner","moderator"].includes(me.role)?`<button class="primary" onclick="startUserChat(${u.id})">💬 Message Banned User</button>`:""}`);
  }catch(e){alert(e.message)}
}
window.openUserPublic=openUserPublic;

async function searchUsers(){
  if(!me)return location.href="/auth/google";
  show(`<button class="close" onclick="closeModal()">×</button><h2>Search Users</h2><div class="field"><input id="publicUserSearch" placeholder="Search display name or username…"></div><div id="publicUserResults" class="modList"><div class="empty">Type at least 2 characters.</div></div>`);
  const run=async()=>{
    const q=$("#publicUserSearch").value.trim(); if(q.length<2){$("#publicUserResults").innerHTML=`<div class="empty">Type at least 2 characters.</div>`;return;}
    try{const rows=await api(`/api/users/search?q=${encodeURIComponent(q)}`);$("#publicUserResults").innerHTML=rows.map(u=>`<div class="modRow"><img class="avatar" src="${esc(u.avatar||"")}" onerror="this.style.display='none'"><div class="modMain"><b>${esc(u.display_name||u.username)}</b><span class="small">@${esc(u.username)} • ${u.banned?"BANNED":"Active"}</span></div><button class="ghost" onclick="openUserPublic(${u.id})">Profile</button>${u.id!==me.id&&(!u.banned||["owner","moderator"].includes(me.role))?`<button class="primary" onclick="startUserChat(${u.id})">Chat</button>`:""}</div>`).join("")||`<div class="empty">No users found.</div>`;}catch(e){$("#publicUserResults").innerHTML=`<div class="empty">${esc(e.message)}</div>`}
  };
  $("#publicUserSearch").oninput=run;
}

function profile(){
  show(`<button class="close" onclick="closeModal()">×</button><h2>${esc(me.display_name||me.username)}</h2>
  <p class="small">Signed in with ${esc(me.provider)}${me.username?` • ${esc(me.username)}`:""}</p>
  <div class="field"><label>Display name</label><input id="displayName" maxlength="40" value="${esc(me.display_name||me.username)}"></div>
  <button class="primary" id="saveProfile">Save display name</button>
  <button class="ghost" id="logout">Log out</button>`);
  $("#saveProfile").onclick=async()=>{
    try{const r=await api("/api/profile",{method:"PATCH",body:JSON.stringify({displayName:$("#displayName").value})});me=r.user;updateNav();closeModal();renderAds();}
    catch(e){alert(e.message)}
  };
  $("#logout").onclick=async()=>{await api("/api/logout",{method:"POST"});location.reload()};
}

async function openModerator(){
  if(!me || !["owner","moderator"].includes(me.role)) return;
  const owner=me.role==="owner";
  show(`<button class="close" onclick="closeModal()">×</button><h2>🛡️ Moderator Panel</h2>
    <p class="small">${owner?"Owner controls: users, bans, moderator roles, private chat review, reports and announcements.":"Moderator controls: user search, bans/unbans and reports."}</p>
    <div class="modTabs"><button class="filter active" data-tab="users">Users</button><button class="filter" data-tab="reports">Reports</button><button class="filter" data-tab="appeals">Ban Appeals</button>${owner?'<button class="filter" data-tab="announce">Announcement</button>':''}</div>
    <div id="modBody"></div>`);
  document.querySelectorAll(".modTabs .filter").forEach(b=>b.onclick=()=>{document.querySelectorAll(".modTabs .filter").forEach(x=>x.classList.remove("active"));b.classList.add("active"); if(b.dataset.tab==="users")renderModUsers(); if(b.dataset.tab==="reports")renderModReports(); if(b.dataset.tab==="appeals")renderModAppeals(); if(b.dataset.tab==="announce")renderAnnouncementManager();});
  renderModUsers();
}
async function renderModUsers(){
  const body=$("#modBody");
  body.innerHTML=`<div class="field"><input id="userSearch" placeholder="Search username, display name or email…"></div><div id="userResults" class="modList"></div>`;
  const run=async()=>{
    try{const users=await api(`/api/mod/users?q=${encodeURIComponent($("#userSearch").value)}`);$("#userResults").innerHTML=users.map(u=>`<div class="modRow"><img class="avatar" src="${esc(u.avatar||"")}" onerror="this.style.display='none'"><div class="modMain"><b>${esc(u.display_name||u.username)}</b><span class="small">@${esc(u.username)} • ${esc(u.provider)} • ${u.role}${u.banned?" • BANNED":""}</span></div><button class="ghost" onclick="openUser(${u.id})">View</button>${u.id!==me.id?`<button class="ghost" onclick="toggleBan(${u.id},${u.banned})">${u.banned?"Unban":"Ban"}</button>`:""}</div>`).join("")||`<div class="empty">No users found.</div>`;}
    catch(e){body.innerHTML=`<div class="empty">${esc(e.message)}</div>`}
  };
  $("#userSearch").oninput=run; await run();
}
window.openUser=async id=>{
  if(me.role!=="owner")return alert("Only the owner can open full private user history.");
  try{const d=await api(`/api/mod/users/${id}`);const u=d.user;
    show(`<button class="close" onclick="closeModal()">×</button><h2>${esc(u.display_name||u.username)}</h2>
      <div class="profileGrid"><div><b>Username</b><div>${esc(u.username)}</div></div><div><b>Provider</b><div>${esc(u.provider)}</div></div><div><b>Email</b><div>${esc(u.email||"Not provided")}</div></div><div><b>Role</b><div>${esc(u.role)}</div></div><div><b>Status</b><div>${u.banned?"Banned":"Active"}</div></div><div><b>Joined</b><div>${new Date(u.created_at).toLocaleString()}</div></div></div>
      <h3>Trade history (${d.ads.length})</h3><div class="modList">${d.ads.map(a=>`<div class="modCard"><b>Ad #${a.id}</b><div>I HAVE: ${itemsHtml(a.have)}</div><div>I WANT: ${itemsHtml(a.want)}</div>${a.inventory?.length?`<div>Inventory: ${itemsHtml(a.inventory)}</div>`:""}<div class="small">${new Date(a.created_at).toLocaleString()}</div></div>`).join("")||`<div class="empty">No trades.</div>`}</div>
      <h3>Chat history (${d.chats.length})</h3><div class="modList">${d.chats.map(c=>`<div class="modCard"><b>Chat #${c.id} • Ad #${c.ad_id}</b><div class="small">${esc(c.buyer_name)} ↔ ${esc(c.seller_name)}</div>${c.messages.map(m=>`<div class="auditMsg"><b>${esc(m.sender_name)}:</b> ${esc(m.body)} <span>${new Date(m.created_at).toLocaleString()}</span></div>`).join("")||`<div class="small">No messages.</div>`}</div>`).join("")||`<div class="empty">No chats.</div>`}</div>
      <h3>Report history (${d.reports.length})</h3><div class="modList">${d.reports.map(r=>`<div class="modCard"><b>Report #${r.id}</b> • Ad #${r.ad_id}<div>${esc(r.reason)}</div><div class="small">Reporter: ${esc(r.reporter_name)} • ${new Date(r.created_at).toLocaleString()}</div></div>`).join("")||`<div class="empty">No reports.</div>`}</div>
      ${me.role==="owner"&&u.id!==me.id?`<div class="modActions"><button class="ghost" onclick="setRole(${u.id},'${u.role==='moderator'?'user':'moderator'}')">${u.role==='moderator'?'Remove moderator':'Make moderator'}</button></div>`:""}`);
  }catch(e){alert(e.message)}
};
window.toggleBan=async(id,banned)=>{try{await api(`/api/mod/users/${id}/${banned?"unban":"ban"}`,{method:"POST",body:JSON.stringify({reason:"Moderator action"})});renderModUsers();}catch(e){alert(e.message)}};
window.setRole=async(id,role)=>{try{await api(`/api/mod/users/${id}/role`,{method:"POST",body:JSON.stringify({role})});closeModal();openModerator();}catch(e){alert(e.message)}};
async function renderModReports(){
  const body=$("#modBody"); try{const rows=await api("/api/mod/reports");body.innerHTML=rows.map(r=>`<div class="modCard"><b>Report #${r.id}</b> • Ad #${r.ad_id}<div>${esc(r.reason)}</div><div class="small">Reporter: ${esc(r.reporter_name)} • Trader: ${esc(r.owner_name)} • ${new Date(r.created_at).toLocaleString()}</div></div>`).join("")||`<div class="empty">No reports.</div>`}catch(e){body.innerHTML=`<div class="empty">${esc(e.message)}</div>`}
}
async function renderModAppeals(){
  const body=$("#modBody");
  try{
    const rows=await api("/api/mod/appeals");
    body.innerHTML=rows.map(a=>{
      const reviewed=a.reviewed_at?`<div class="small">Reviewed: ${new Date(a.reviewed_at).toLocaleString()}</div>`:"";
      const actions=a.status==="pending"?`<div class="modActions"><button class="ghost" onclick="resolveAppeal(${a.id},'reviewed')">Mark reviewed</button><button class="primary" onclick="resolveAppeal(${a.id},'unban')">Accept & Unban</button></div>`:"";
      return `<div class="modCard"><div class="modRow"><img class="avatar" src="${esc(a.avatar||"")}" onerror="this.style.display='none'"><div class="modMain"><b>${esc(a.display_name||a.username)}</b><span class="small">@${esc(a.username)} • ${esc(a.status)}${a.banned?" • BANNED":""}</span></div></div><p>${esc(a.message)}</p><div class="small">Submitted: ${new Date(a.created_at).toLocaleString()}</div>${actions}${reviewed}</div>`;
    }).join("")||`<div class="empty">No ban appeals.</div>`;
  }catch(e){body.innerHTML=`<div class="empty">${esc(e.message)}</div>`}
}
window.resolveAppeal=async(id,action)=>{try{await api(`/api/mod/appeals/${id}/resolve`,{method:"POST",body:JSON.stringify({action})});renderModAppeals();}catch(e){alert(e.message)}};

async function renderAnnouncementManager(){
  const body=$("#modBody"); let a=null; try{a=await api("/api/announcements")}catch{}
  body.innerHTML=`<div class="field"><label>Home announcement — visible for 1 day</label><textarea id="announcementText" rows="5" maxlength="1000" placeholder="Write an announcement…">${esc(a?.text||"")}</textarea></div><button class="primary" id="publishAnnouncement">${a?"Replace announcement":"Publish announcement"}</button>${a?` <button class="ghost danger" id="removeAnnouncement">Remove now</button><p class="small">Expires: ${new Date(a.expires_at).toLocaleString()}</p>`:""}`;
  $("#publishAnnouncement").onclick=async()=>{try{await api("/api/announcements",{method:"POST",body:JSON.stringify({text:$("#announcementText").value})});await loadAnnouncement();renderAnnouncementManager();}catch(e){alert(e.message)}};
  if(a)$("#removeAnnouncement").onclick=async()=>{try{await api("/api/announcements",{method:"DELETE"});await loadAnnouncement();renderAnnouncementManager();}catch(e){alert(e.message)}};
}

const loginError=new URLSearchParams(location.search).get("loginError");
if(loginError){
  const messages={google_not_configured:"Google login is not configured on this server yet.",roblox_not_configured:"Roblox login is not configured on this server yet.",google_failed:"Google login could not be completed. Please try again.",roblox_failed:"Roblox login could not be completed. Please try again."};
  const n=$("#loginNotice");
  if(n){n.textContent=messages[loginError]||"Login could not be completed. Please try again.";n.classList.remove("hidden");}
  history.replaceState({},"",location.pathname);
}
load();
