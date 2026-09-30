import "dotenv/config";
import express from "express";
import cookieSession from "cookie-session";
import Database from "better-sqlite3";
import crypto from "crypto";
import { google } from "googleapis";
import { Server } from "socket.io";
import http from "http";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const db = new Database("fruitforge.db");
const PORT = Number(process.env.PORT || 3000);
const COOLDOWN_MS = 8 * 60 * 1000;

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_id)
);
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  have_json TEXT NOT NULL,
  want_json TEXT NOT NULL,
  nlf TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  seller_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(ad_id, buyer_id, seller_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY CHECK(id=1),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ban_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(reviewed_by) REFERENCES users(id)
);
`);

// Lightweight schema migrations so older FruitForge databases upgrade safely.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("users", "email", "TEXT");
ensureColumn("users", "display_name", "TEXT");
ensureColumn("users", "role", "TEXT NOT NULL DEFAULT 'user'");
ensureColumn("users", "banned", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "ban_reason", "TEXT DEFAULT ''");
ensureColumn("users", "updated_at", "INTEGER");
ensureColumn("conversations", "target_user_id", "INTEGER");
ensureColumn("ads", "inventory_json", "TEXT NOT NULL DEFAULT '[]'");

app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));
app.use(cookieSession({
  name: "fruitforge_session",
  keys: [process.env.SESSION_SECRET || "dev-only-change-me"],
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.COOKIE_SECURE === "true",
  maxAge: 30 * 24 * 60 * 60 * 1000
}));

const now = () => Date.now();
const userById = id => db.prepare("SELECT * FROM users WHERE id=?").get(id);

function uniqueDisplayName(base, currentId = null) {
  let clean = String(base || "Player").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Player";
  if (clean.length < 3) clean = (clean + "Player").slice(0, 40);
  let candidate = clean, n = 1;
  while (true) {
    const row = currentId ? db.prepare("SELECT id FROM users WHERE lower(display_name)=lower(?) AND id<>?").get(candidate, currentId) : db.prepare("SELECT id FROM users WHERE lower(display_name)=lower(?)").get(candidate);
    if (!row) return candidate;
    const suffix = `_${n++}`;
    candidate = (clean.slice(0, 40 - suffix.length) + suffix);
  }
}

function upsertUser(provider, providerId, username, avatar, email = null) {
  const existing = db.prepare("SELECT * FROM users WHERE provider=? AND provider_id=?")
    .get(provider, providerId);
  const ownerGoogleEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const ownerRobloxId = String(process.env.ADMIN_ROBLOX_ID || "").trim();
  const isOwner = (provider === "google" && email && String(email).trim().toLowerCase() === ownerGoogleEmail) ||
                  (provider === "roblox" && String(providerId) === ownerRobloxId);
  if (existing) {
    const nextRole = isOwner ? "owner" : (existing.role || "user");
    db.prepare("UPDATE users SET username=?, avatar=?, email=COALESCE(?,email), role=?, updated_at=? WHERE id=?")
      .run(username, avatar || null, email || null, nextRole, now(), existing.id);
    return userById(existing.id);
  }
  const role = isOwner ? "owner" : "user";
  const displayName = uniqueDisplayName(username);
  const result = db.prepare(
    "INSERT INTO users(provider,provider_id,username,avatar,email,display_name,role,banned,ban_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
  ).run(provider, providerId, username, avatar || null, email || null, displayName, role, 0, "", now(), now());
  return userById(result.lastInsertRowid);
}

function publicUser(user) {
  if (!user) return null;
  return { id:user.id, provider:user.provider, username:user.username, display_name:user.display_name || user.username, avatar:user.avatar, role:user.role, created_at:user.created_at, banned:Boolean(user.banned) };
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (!req.user || !["owner","moderator"].includes(req.user.role)) return res.status(403).json({ error: "Moderator access required." });
    next();
  });
}

function requireOwner(req, res, next) {
  requireUser(req, res, () => {
    if (!req.user || req.user.role !== "owner") return res.status(403).json({ error: "Owner access required." });
    next();
  });
}


function requireUser(req, res, next) {
  const user = req.session?.userId ? userById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error: "Login required." });
  if (user.banned) return res.status(403).json({ error: "You are muted from chat and trading.", banned:true, appealAvailable:true });
  req.user = user;
  next();
}

function randomState() { return crypto.randomBytes(24).toString("hex"); }
function pkceVerifier() { return crypto.randomBytes(48).toString("base64url"); }
function pkceChallenge(v) {
  return crypto.createHash("sha256").update(v).digest("base64url");
}

/* ---------- Google OAuth ---------- */
const googleOAuth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.get("/auth/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.redirect("/?loginError=google_not_configured");
  const state = randomState();
  req.session.oauthState = state;
  const url = googleOAuth.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account"
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.oauthState)
      return res.status(400).send("Invalid Google OAuth state.");
    const { tokens } = await googleOAuth.getToken(req.query.code);
    const oauth = new google.auth.OAuth2();
    oauth.setCredentials(tokens);
    const oauth2 = google.oauth2({ auth: oauth, version: "v2" });
    const { data } = await oauth2.userinfo.get();
    const user = upsertUser("google", data.id, data.name || data.email, data.picture, data.email);
    req.session.userId = user.id;
    req.session.oauthState = null;
    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.redirect("/?loginError=google_failed");
  }
});

/* ---------- Roblox OAuth 2.0 / OIDC + PKCE ---------- */
app.get("/auth/roblox", (req, res) => {
  if (!process.env.ROBLOX_CLIENT_ID || !process.env.ROBLOX_CLIENT_SECRET)
    return res.redirect("/?loginError=roblox_not_configured");
  const state = randomState();
  const verifier = pkceVerifier();
  req.session.robloxState = state;
  req.session.robloxVerifier = verifier;

  const params = new URLSearchParams({
    client_id: process.env.ROBLOX_CLIENT_ID,
    redirect_uri: process.env.ROBLOX_REDIRECT_URI,
    scope: "openid profile",
    response_type: "code",
    prompt: "login consent",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256"
  });
  res.redirect("https://apis.roblox.com/oauth/v1/authorize?" + params.toString());
});

app.get("/auth/roblox/callback", async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.robloxState)
      return res.status(400).send("Invalid Roblox OAuth state.");

    const body = new URLSearchParams({
      client_id: process.env.ROBLOX_CLIENT_ID,
      client_secret: process.env.ROBLOX_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: req.query.code,
      code_verifier: req.session.robloxVerifier
    });

    const tokenRes = await fetch("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokens));

    const meRes = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const me = await meRes.json();
    if (!meRes.ok || !me.sub) throw new Error("Roblox userinfo failed.");

    const username = me.preferred_username || me.nickname || me.name || `Roblox ${me.sub}`;
    const user = upsertUser("roblox", String(me.sub), username, me.picture);
    req.session.userId = user.id;
    req.session.robloxState = null;
    req.session.robloxVerifier = null;
    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.redirect("/?loginError=roblox_failed");
  }
});

/* ---------- API ---------- */
app.get("/api/me", (req, res) => {
  const user = req.session?.userId ? userById(req.session.userId) : null;
  res.json(user ? { loggedIn: true, user: publicUser(user), isOwner: user.role === "owner", isModerator: ["owner","moderator"].includes(user.role) } : { loggedIn: false });
});

app.patch("/api/profile", requireUser, (req, res) => {
  const displayName = String(req.body.displayName || "").trim().slice(0,40);
  if (!/^[A-Za-z0-9_]{3,40}$/.test(displayName))
    return res.status(400).json({ error: "Display name must be 3–40 characters and use only letters, numbers, or underscores." });
  const taken = db.prepare("SELECT id FROM users WHERE lower(display_name)=lower(?) AND id<>?").get(displayName, req.user.id);
  if (taken) return res.status(409).json({ error: "Display name already taken." });
  db.prepare("UPDATE users SET display_name=?, updated_at=? WHERE id=?").run(displayName, now(), req.user.id);
  res.json({ user: publicUser(userById(req.user.id)) });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/ads", (req, res) => {
  const rows = db.prepare(`
    SELECT ads.*, users.username, users.display_name, users.avatar
    FROM ads JOIN users ON users.id=ads.user_id
    ORDER BY ads.created_at DESC LIMIT 50
  `).all();
  res.json(rows.map(a => ({
    ...a,
    have: JSON.parse(a.have_json),
    want: JSON.parse(a.want_json),
    inventory: JSON.parse(a.inventory_json || "[]"),
    display_name: a.display_name || a.username
  })));
});

app.get("/api/cooldown", requireUser, (req, res) => {
  const last = db.prepare("SELECT created_at FROM ads WHERE user_id=? ORDER BY created_at DESC LIMIT 1")
    .get(req.user.id);
  const remainingMs = last ? Math.max(0, last.created_at + COOLDOWN_MS - now()) : 0;
  res.json({ remainingMs });
});

app.post("/api/ads", requireUser, (req, res) => {
  const { have, want, inventory = [], nlf = "", description = "" } = req.body;
  if (!Array.isArray(have) || !have.length || !Array.isArray(want) || !want.length)
    return res.status(400).json({ error: "I HAVE and I WANT are both required." });
  if (have.length > 4 || want.length > 4 || inventory.length > 4)
    return res.status(400).json({ error: "You can add up to 4 items in each selection." });
  if (!Array.isArray(inventory)) return res.status(400).json({ error: "Invalid inventory." });

  const last = db.prepare("SELECT created_at FROM ads WHERE user_id=? ORDER BY created_at DESC LIMIT 1")
    .get(req.user.id);
  if (last) {
    const remaining = last.created_at + COOLDOWN_MS - now();
    if (remaining > 0)
      return res.status(429).json({ error: "You can post again later.", remainingMs: remaining });
  }

  const result = db.prepare(`
    INSERT INTO ads(user_id,have_json,want_json,inventory_json,nlf,description,created_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(req.user.id, JSON.stringify(have), JSON.stringify(want), JSON.stringify(inventory), String(nlf).slice(0,1000),
         String(description).slice(0,2000), now());

  res.json({ ok: true, id: result.lastInsertRowid });
});

app.post("/api/conversations", requireUser, (req, res) => {
  const { adId, userId } = req.body;
  let targetId, linkedAdId = 0;
  if (userId) {
    const target = userById(userId);
    if (!target || target.id === req.user.id) return res.status(400).json({ error: "Invalid user." });
    if (target.banned && !["owner","moderator"].includes(req.user.role)) return res.status(403).json({ error: "You cannot start a conversation with a banned user." });
    targetId = target.id;
  } else {
    const ad = db.prepare("SELECT * FROM ads WHERE id=?").get(adId);
    if (!ad) return res.status(404).json({ error: "Ad not found." });
    if (ad.user_id === req.user.id) return res.status(400).json({ error: "You cannot chat with yourself." });
    targetId = ad.user_id; linkedAdId = ad.id;
  }
  const result = db.prepare(`INSERT OR IGNORE INTO conversations(ad_id,buyer_id,seller_id,target_user_id,created_at) VALUES(?,?,?,?,?)`)
    .run(linkedAdId, req.user.id, targetId, targetId, now());
  const conversation = db.prepare(`SELECT * FROM conversations WHERE buyer_id=? AND seller_id=? AND ad_id=? ORDER BY id DESC LIMIT 1`)
    .get(req.user.id, targetId, linkedAdId);
  res.json(conversation);
});

app.get("/api/conversations", (req, res) => {
  const user = req.session?.userId ? userById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error: "Login required." });
  const rows = db.prepare(`
    SELECT c.*, a.description, a.have_json, a.want_json,
      CASE WHEN c.buyer_id=? THEN COALESCE(seller.display_name,seller.username) ELSE COALESCE(buyer.display_name,buyer.username) END AS other_username,
      CASE WHEN c.buyer_id=? THEN seller.avatar ELSE buyer.avatar END AS other_avatar,
      CASE WHEN c.buyer_id=? THEN seller.id ELSE buyer.id END AS other_user_id,
      CASE WHEN c.buyer_id=? THEN seller.banned ELSE buyer.banned END AS other_banned
    FROM conversations c
    LEFT JOIN ads a ON a.id=c.ad_id
    JOIN users buyer ON buyer.id=c.buyer_id
    JOIN users seller ON seller.id=c.seller_id
    WHERE c.buyer_id=? OR c.seller_id=?
    ORDER BY c.created_at DESC
  `).all(user.id, user.id, user.id, user.id, user.id, user.id);
  res.json(rows);
});

function requireConversationParticipant(req, res, next) {
  const user = req.session?.userId ? userById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error: "Login required." });
  const c = db.prepare("SELECT * FROM conversations WHERE id=?").get(req.params.id || req.body.conversationId);
  if (!c || (c.buyer_id !== user.id && c.seller_id !== user.id)) return res.status(403).json({ error: "Forbidden." });
  req.user = user; req.conversation = c; next();
}

app.get("/api/conversations/:id/messages", requireConversationParticipant, (req, res) => {
  res.json(db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(req.conversation.id));
});

app.post("/api/reports", requireUser, (req, res) => {
  const { adId, reason } = req.body;
  if (!adId || !String(reason || "").trim()) return res.status(400).json({ error: "Reason required." });
  db.prepare("INSERT INTO reports(ad_id,reporter_id,reason,created_at) VALUES(?,?,?,?)")
    .run(adId, req.user.id, String(reason).slice(0,500), now());
  res.json({ ok: true });
});

/* ---------- Ban appeals ---------- */
app.get("/api/ban-status", (req, res) => {
  const user = req.session?.userId ? userById(req.session.userId) : null;
  if (!user) return res.json({ loggedIn:false, banned:false });
  const pending = db.prepare("SELECT id, message, status, created_at FROM ban_appeals WHERE user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(user.id);
  res.json({ loggedIn:true, banned:Boolean(user.banned), reason:user.ban_reason||"", pendingAppeal:pending||null });
});

app.post("/api/ban-appeals", (req, res) => {
  const user = req.session?.userId ? userById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error:"Login required." });
  if (!user.banned) return res.status(400).json({ error:"You are not banned." });
  const message = String(req.body.message || "").trim().slice(0,2000);
  if (!message) return res.status(400).json({ error:"Please explain what happened in your appeal." });
  const pending = db.prepare("SELECT id FROM ban_appeals WHERE user_id=? AND status='pending' LIMIT 1").get(user.id);
  if (pending) return res.status(409).json({ error:"You already have a pending appeal." });
  const result = db.prepare("INSERT INTO ban_appeals(user_id,message,status,created_at) VALUES(?,?,?,?)").run(user.id,message,"pending",now());
  res.json({ ok:true, id:result.lastInsertRowid });
});

/* ---------- Moderator / owner controls ---------- */
app.get("/api/mod/users", requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim();
  const rows = q ? db.prepare(`SELECT id,provider,provider_id,username,display_name,avatar,email,role,banned,ban_reason,created_at FROM users WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 100`).all(`%${q}%`,`%${q}%`,`%${q}%`)
                 : db.prepare(`SELECT id,provider,provider_id,username,display_name,avatar,email,role,banned,ban_reason,created_at FROM users ORDER BY created_at DESC LIMIT 100`).all();
  res.json(rows.map(u=>({...u,banned:Boolean(u.banned)})));
});

app.get("/api/mod/users/:id", requireOwner, (req,res)=>{
  const u=db.prepare("SELECT id,provider,provider_id,username,display_name,avatar,email,role,banned,ban_reason,created_at,updated_at FROM users WHERE id=?").get(req.params.id);
  if(!u) return res.status(404).json({error:"User not found."});
  const ads=db.prepare(`SELECT id,have_json,want_json,inventory_json,nlf,description,created_at FROM ads WHERE user_id=? ORDER BY created_at DESC LIMIT 200`).all(u.id).map(a=>({...a,have:JSON.parse(a.have_json),want:JSON.parse(a.want_json),inventory:JSON.parse(a.inventory_json||"[]")}));
  const convs=db.prepare(`SELECT c.id,c.ad_id,c.created_at, buyer.id buyer_id,COALESCE(buyer.display_name,buyer.username) buyer_name,seller.id seller_id,COALESCE(seller.display_name,seller.username) seller_name FROM conversations c JOIN users buyer ON buyer.id=c.buyer_id JOIN users seller ON seller.id=c.seller_id WHERE c.buyer_id=? OR c.seller_id=? ORDER BY c.created_at DESC LIMIT 200`).all(u.id,u.id);
  const chats=convs.map(c=>({ ...c, messages: db.prepare(`SELECT m.id,m.sender_id,COALESCE(us.display_name,us.username) sender_name,m.body,m.created_at FROM messages m JOIN users us ON us.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.created_at ASC`).all(c.id) }));
  const reports=db.prepare(`SELECT r.*,a.user_id ad_owner_id,COALESCE(reporter.display_name,reporter.username) reporter_name FROM reports r JOIN ads a ON a.id=r.ad_id JOIN users reporter ON reporter.id=r.reporter_id WHERE a.user_id=? OR r.reporter_id=? ORDER BY r.created_at DESC LIMIT 200`).all(u.id,u.id);
  res.json({user:{...u,banned:Boolean(u.banned)},ads,chats,reports});
});

app.post("/api/mod/users/:id/ban", requireAdmin, (req,res)=>{
  const target=userById(req.params.id); if(!target)return res.status(404).json({error:"User not found."});
  if(target.role==="owner")return res.status(400).json({error:"The owner cannot be banned."});
  if(target.id===req.user.id)return res.status(400).json({error:"You cannot ban yourself."});
  db.prepare("UPDATE users SET banned=1,ban_reason=?,updated_at=? WHERE id=?").run(String(req.body.reason||"Moderator action").slice(0,500),now(),target.id);
  res.json({ok:true});
});

app.post("/api/mod/users/:id/unban", requireAdmin, (req,res)=>{
  const target=userById(req.params.id); if(!target)return res.status(404).json({error:"User not found."});
  db.prepare("UPDATE users SET banned=0,ban_reason='',updated_at=? WHERE id=?").run(now(),target.id);
  res.json({ok:true});
});

app.post("/api/mod/users/:id/role", requireOwner, (req,res)=>{
  const target=userById(req.params.id); if(!target)return res.status(404).json({error:"User not found."});
  if(target.id===req.user.id)return res.status(400).json({error:"The owner role cannot be changed."});
  const role=req.body.role==="moderator"?"moderator":"user";
  db.prepare("UPDATE users SET role=?,updated_at=? WHERE id=?").run(role,now(),target.id);
  res.json({ok:true,role});
});

app.get("/api/mod/appeals", requireAdmin, (req,res)=>{
  const rows=db.prepare(`SELECT ba.*,u.username,u.display_name,u.avatar,u.banned,u.ban_reason,COALESCE(rv.display_name,rv.username) reviewer_name
    FROM ban_appeals ba JOIN users u ON u.id=ba.user_id LEFT JOIN users rv ON rv.id=ba.reviewed_by
    ORDER BY CASE WHEN ba.status='pending' THEN 0 ELSE 1 END, ba.created_at DESC LIMIT 200`).all();
  res.json(rows.map(a=>({...a,banned:Boolean(a.banned)})));
});

app.post("/api/mod/appeals/:id/resolve", requireAdmin, (req,res)=>{
  const appeal=db.prepare("SELECT * FROM ban_appeals WHERE id=?").get(req.params.id);
  if(!appeal)return res.status(404).json({error:"Appeal not found."});
  const action=req.body.action==="unban"?"unban":"reviewed";
  if(action==="unban") db.prepare("UPDATE users SET banned=0,ban_reason='',updated_at=? WHERE id=?").run(now(),appeal.user_id);
  db.prepare("UPDATE ban_appeals SET status=?,reviewed_at=?,reviewed_by=? WHERE id=?").run(action==="unban"?"accepted":"reviewed",now(),req.user.id,appeal.id);
  res.json({ok:true});
});

app.get("/api/mod/reports", requireAdmin, (req,res)=>{
  const rows=db.prepare(`SELECT r.*,COALESCE(reporter.display_name,reporter.username) reporter_name,a.description,COALESCE(owner.display_name,owner.username) owner_name FROM reports r JOIN ads a ON a.id=r.ad_id JOIN users reporter ON reporter.id=r.reporter_id JOIN users owner ON owner.id=a.user_id ORDER BY r.created_at DESC LIMIT 200`).all();
  res.json(rows);
});

app.get("/api/announcements", (req,res)=>{
  const row=db.prepare("SELECT * FROM announcements WHERE id=1 AND expires_at>? AND active=1").get(now());
  res.json(row||null);
});

app.post("/api/announcements", requireOwner, (req,res)=>{
  const text=String(req.body.text||"").trim().slice(0,1000);
  if(!text)return res.status(400).json({error:"Announcement text is required."});
  const created=now(),expires=created+24*60*60*1000;
  db.prepare(`INSERT INTO announcements(id,text,created_at,expires_at,active,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,created_at=excluded.created_at,expires_at=excluded.expires_at,active=1,updated_at=excluded.updated_at`).run(text,created,expires,1,created);
  res.json({ok:true});
});

app.delete("/api/announcements", requireOwner, (req,res)=>{ db.prepare("UPDATE announcements SET active=0,updated_at=? WHERE id=1").run(now()); res.json({ok:true}); });

/* ---------- Realtime chat ---------- */
io.use((socket, next) => {
  const cookies = socket.handshake.headers.cookie || "";
  const match = cookies.match(/fruitforge_session=([^;]+)/);
  // cookie-session values are signed/encrypted-ish and aren't safely parseable here.
  // REST auth remains authoritative; client joins conversations through the HTTP endpoint.
  socket.userId = null;
  next();
});

io.on("connection", socket => {
  socket.on("joinConversation", async ({ conversationId }) => {
    socket.join(`conversation:${conversationId}`);
  });

  socket.on("sendMessage", ({ conversationId, body }) => {
    // Client-side socket identity is not trusted for persistence.
    // The app uses the REST endpoint below for authenticated sends.
  });
});

app.post("/api/messages", requireConversationParticipant, (req, res) => {
  const c = req.conversation;
  const clean = String(req.body.body || "").trim().slice(0,2000);
  if (!clean) return res.status(400).json({ error: "Message is empty." });
  if (req.user.banned) {
    const otherId = c.buyer_id === req.user.id ? c.seller_id : c.buyer_id;
    const other = userById(otherId);
    if (!other || !["owner","moderator"].includes(other.role))
      return res.status(403).json({ error: "You are muted. You can only reply to an existing moderator conversation." });
  }
  const result = db.prepare("INSERT INTO messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)")
    .run(c.id, req.user.id, clean, now());
  const message = db.prepare("SELECT * FROM messages WHERE id=?").get(result.lastInsertRowid);
  io.to(`conversation:${c.id}`).emit("message", message);
  res.json(message);
});

app.get("/api/users/:id", (req, res) => {
  const u = db.prepare("SELECT id,username,display_name,avatar,provider,role,banned,created_at FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "User not found." });
  res.json({ ...u, banned:Boolean(u.banned), role: u.role === "owner" || u.role === "moderator" ? u.role : "user" });
});

/* ---------- Public user search ---------- */
app.get("/api/users/search", (req, res) => {
  const user = req.session?.userId ? userById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error: "Login required." });
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`SELECT id,username,display_name,avatar,provider,role,banned FROM users
    WHERE username LIKE ? OR display_name LIKE ? ORDER BY display_name COLLATE NOCASE LIMIT 25`).all(`%${q}%`,`%${q}%`);
  res.json(rows.map(u=>({...u,banned:Boolean(u.banned)})));
});

app.get("*", (req, res) => res.sendFile(process.cwd() + "/public/index.html"));
server.listen(PORT, () => console.log(`FruitForge running on http://localhost:${PORT}`));
