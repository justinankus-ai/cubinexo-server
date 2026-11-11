# Cubinexo Server

WebSocket multiplayer server for Cubinexo.

## Deploy to Render (free tier)

1. Push this `server/` folder to a GitHub repo
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Set Root Directory: `server` (or root if you only push the server folder)
5. Build Command: `npm install`
6. Start Command: `node server.js`
7. Plan: Free

Render gives you a URL like `cubinexo-server.onrender.com`.

## Update Unity

In Unity Inspector, find the **NetClient** component on your NetworkManager GameObject.
Set **Server Url** to: `wss://your-render-url.onrender.com`

## Local dev

```
npm install
node server.js
# Server runs on ws://localhost:8080
```
