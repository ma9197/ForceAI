# Deploying ForceAI online (Railway)

Runs the bot + dashboard 24/7 with no laptop. Private (password-locked). Auto-redeploys
on every git push, and restores each group's exact state (live / sleeping / paused) after
every restart. Cost: ~$5/month (Railway Hobby).

## 1. Put the code on a private GitHub repo

On github.com: **New repository** → name it `forceai` → **Private** → *don't* add a README.
Then, in this project folder:

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/forceai.git
git push -u origin main
```

`.env` and `data/` are git-ignored, so your API keys and WhatsApp login never leave your machine.

## 2. Create the Railway project

1. Go to **railway.app**, log in with GitHub.
2. **New Project → Deploy from GitHub repo →** pick `forceai`.
   Railway sees the `Dockerfile` and starts building. (The first build may fail — that's fine,
   it needs the variables + volume below first.)

## 3. Add a persistent volume (do this before using it!)

Service → **Settings → Volumes → + New Volume**, mount path:

```
/app/data
```

This is where the WhatsApp login, memory database, stickers and images live. Without it, every
redeploy would forget everything and re-ask for the QR. **Don't skip this.**

## 4. Add environment variables

Service → **Variables → + New Variable** (raw editor works too):

```
ANTHROPIC_API_KEY      = sk-ant-...                 (required)
DASHBOARD_PASSWORD     = <a long random password>   (required — your dashboard lock)
DASHBOARD_USER         = admin                       (optional, defaults to admin)
GEMINI_API_KEY         = ...                          (optional — image generation)
ELEVENLABS_API_KEY     = ...                          (optional — voice notes)
```

`HOST=0.0.0.0` and the port are already handled — don't set them.

## 5. Deploy + open it

1. Trigger a redeploy (Railway → **Deployments → Redeploy**) so it picks up the variables + volume.
2. Service → **Settings → Networking → Generate Domain**. You get a URL like
   `https://forceai-production.up.railway.app`.
3. Open that URL on your phone or laptop. The browser asks for a username/password —
   enter `admin` + your `DASHBOARD_PASSWORD`.
4. Scan the QR with WhatsApp (Linked Devices), then link your groups. Done — it's live 24/7.

## 6. Updating later

Just push to GitHub:

```bash
git push
```

Railway auto-rebuilds and redeploys. The `data/` volume persists, so memory/stickers/login stay,
and every group comes back in the **exact** state it was in (live, sleeping, or paused) — no
re-intro, no re-scan.

---

### Notes
- The dashboard can send messages as you — keep `DASHBOARD_PASSWORD` strong and private.
- WhatsApp runs from a datacenter IP here (same as any VPS). Ban-risk mitigations still apply;
  keep pacing/rate caps reasonable.
- Moving from local: the server starts with a fresh `data/` (new QR, re-link groups, re-teach
  stickers). To carry over your existing brain instead, ask for the one-time import helper.
