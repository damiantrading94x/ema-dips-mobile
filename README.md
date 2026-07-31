# EMA Dips — mobile app

Installable Android app (PWA) that pushes a notification to your phone when a
stock falls a configurable distance below its 12-day EMA.

Built to be useful **while travelling**, which drove every architectural
decision below.

---

## The one thing that matters: alerts don't depend on your PC

Your desktop will be off while you're away, so it cannot be what sends the
notifications. Instead the existing **GitHub Actions scanner** sends them — it
already runs every 15 minutes during US market hours, independently of any
machine at home.

```
GitHub Actions (every 15 min)
   → scans tickers, computes EMA12
   → sends Web Push straight to your phone      ← works with the PC off
   → also sends the existing email alerts
```

The desktop server is only needed for two things:

1. **Registering the phone once** (and changing the threshold later)
2. **Browsing the dip list** in the app

Neither is needed for alerts to arrive. Open the app abroad with the PC off and
you'll see the last list it downloaded, marked as cached — but pushes keep
coming.

---

## Setup

### 1. Add the GitHub secrets (one time)

The scanner needs the VAPID keypair to sign pushes. In the **Stock-analyzer**
repo → Settings → Secrets and variables → Actions → *New repository secret*:

| Secret | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | `BD0_7DyPI3cdvfTdYtBqdS5nzUbGa-_kQmgUAiBuneobQim2xc23mpcRsB6YqDoD9HcPkzC7s9lzbcxrc3Uy4ZE` |
| `VAPID_PRIVATE_KEY` | in `Stock-analyzer/server/.env` — **never commit it** |
| `VAPID_SUBJECT` | `mailto:damianluto@hotmail.com` |

Without these the scanner just skips push and still emails, so a missing secret
degrades quietly rather than breaking the job.

### 2. Serve the app to your phone

Web push requires a **secure context**: HTTPS, or `localhost`. A plain
`http://192.168.x.x` address will not work — the browser silently refuses to
subscribe. Pick one:

**Option A — Cloudflare Tunnel (recommended, works anywhere)**

```bash
npm run build
npx cloudflared tunnel --url http://localhost:5180
```

Serves `dist/` over a public HTTPS URL. Open that on the phone.

**Option B — GitHub Pages**

Commit `dist/` to a `gh-pages` branch. Permanent HTTPS URL, no tunnel to keep
alive. The app uses relative paths, so it works from a project subpath.

**Option C — Chrome port forwarding (USB, for testing)**

`chrome://inspect` → Port forwarding → map `5180` to `localhost:5180`. The phone
then sees it as `localhost`, which counts as secure.

### 3. Install and enable

1. Open the URL in Chrome on the phone
2. Menu → **Add to Home screen** (it installs as a standalone app)
3. Open it from the home screen, tap **Enable phone alerts**, accept the prompt
4. Tap **Send test** to confirm a notification arrives
5. Set the threshold with the slider — it's stored per device on the server

> Register while on your home Wi-Fi, with the desktop server running. The
> subscription is saved to `server/data/push_subscriptions.json`, which is
> committed to the repo so Actions can read it from anywhere.
>
> **Commit that file after registering**, otherwise the cloud scanner won't know
> your phone exists.

---

## Configuration in the app

| Setting | Meaning |
| --- | --- |
| **Alert threshold** | How far below EMA12 before this device is notified (5–40%). Stored server-side per device, so two phones can differ. |
| **Server address** | Your desktop on the LAN, e.g. `http://192.168.1.20:3050`. Only for browsing the list and registering. |

---

## Notification behaviour

- **20%+ dips** use `requireInteraction` — they stay on screen until you dismiss
  them, rather than disappearing while your phone is in your pocket.
- **One notification per ticker.** A deeper reading replaces the earlier one via
  the notification `tag`, so a stock sliding from 15% to 22% doesn't leave three
  separate alerts.
- **12-hour cooldown** per ticker+bucket, and **max 6 pushes per run**, so a
  broad selloff can't fire fifty notifications at once. Deepest dips win the cap.
- Tapping a notification opens the app focused on that ticker.

Push cooldowns are tracked separately from email cooldowns, and push is **not**
subject to the daily email budget — the phone alert is the one that matters when
you're away from a desk.

---

## Development

```bash
npm install
npm run dev      # http://localhost:5180, --host so the phone can reach it
npm run build    # -> dist/
```

The desktop server must be running for the dip list and registration:

```bash
cd ../Stock-analyzer/server && npm run dev
```

### Endpoints it uses

| Endpoint | Purpose |
| --- | --- |
| `GET /api/push/vapid-public-key` | key needed to build a subscription |
| `POST /api/push/subscribe` | register device + threshold (upsert by endpoint) |
| `POST /api/push/unsubscribe` | remove device |
| `POST /api/push/test` | send a test notification |
| `GET /api/push/dips?min=N` | compact dip list for the phone |

---

## Troubleshooting

**"Push requires HTTPS"** — you're on a plain `http://` LAN address. See step 2.

**Notifications blocked** — Android Settings → Apps → EMA Dips → Notifications.
Chrome remembers a denial per site; you may need to clear the site's permissions.

**Test works but real alerts never arrive** — check in order:
1. `server/data/push_subscriptions.json` is committed and shows your device
2. The three `VAPID_*` GitHub secrets exist
3. The Actions run log says `Pushing N dip(s) to 1 device(s)` rather than
   `No phones registered` or `VAPID keys missing`
4. Nothing was deep enough to clear your threshold — lower it and retest

**Alerts stopped after weeks** — push endpoints expire. Open the app and tap
*Enable phone alerts* again; the server retires dead endpoints automatically
after a 404/410.
