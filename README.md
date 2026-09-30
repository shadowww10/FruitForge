# FruitForge

FruitForge is a Blox Fruits trading community starter with:

- Google OAuth 2.0 login
- Roblox OAuth 2.0 / OpenID Connect login with PKCE
- Server-side sessions
- SQLite database
- 7-minute server-enforced ad cooldown
- Trade ads with I HAVE / I WANT / MY INVENTORY
- NLF (Not Looking For)
- Report system
- WhatsApp-style conversation list
- Real-time Socket.IO message delivery
- Responsive dark UI

## Run locally

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Add Google OAuth credentials and set the Google redirect URI to:
   `http://localhost:3000/auth/google/callback`
4. Register a Roblox OAuth app and set its redirect URI to:
   `http://localhost:3000/auth/roblox/callback`
5. Run:

```bash
npm install
npm start
```

6. Open `http://localhost:3000`.

## Important OAuth setup

Do not put client secrets in browser JavaScript.

Google OAuth uses the server-side web application flow. Roblox uses its OAuth 2.0 authorization-code flow with PKCE. The server stores the PKCE verifier and exchanges the code server-side.

The Roblox OAuth identity flow does not automatically read a player's Blox Fruits in-game inventory. `MY INVENTORY` in this app is a FruitForge-maintained list selected by the user.

## Production

Use HTTPS, a strong SESSION_SECRET, COOKIE_SECURE=true, a persistent database, and a proper deployment environment. For a public deployment, move SQLite to a managed PostgreSQL database and put the Socket.IO server behind infrastructure that supports WebSockets.


## Item picker

The Create Ad plus flow is categorized so traders can browse:
- Fruits
- Swords
- Gamepasses / trade vouchers
- Materials
- Accessories
- Boosts

Each selection supports quantity and can be removed from I HAVE, I WANT, or MY INVENTORY.
The catalog is intentionally editable because Blox Fruits item availability changes over time.


## Owner / moderator controls

Set `ADMIN_EMAIL` to the exact Google email that should own FruitForge. Optionally set `ADMIN_ROBLOX_ID` to the Roblox OAuth subject/user ID for the same owner. Matching accounts are automatically assigned the `owner` role. Do not leave these values blank in production.

The owner can search users, view user profiles, ban/unban users, make/remove moderators, review reports, inspect a user's trade history and private conversation/message history, and publish/replace/remove a home announcement. Announcements automatically expire after 24 hours. Promoted moderators can use the moderator ban/unban and report tools, but only the owner can change moderator roles, publish announcements, or open full private user history. OAuth passwords/tokens are never shown in the moderator panel.

Users can customize their FruitForge display name after signing in with Google or Roblox; the display name is shown publicly on profiles, chats, and trade ads.
