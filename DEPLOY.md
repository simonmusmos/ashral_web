# Deploying Ashral Backend

## Vercel

1. Install the Vercel CLI if you haven't already:
   ```bash
   npm i -g vercel
   ```

2. From the project root, run:
   ```bash
   vercel
   ```
   Follow the prompts — link to your Vercel account and project. On first deploy it will ask a few setup questions; accept the defaults.

3. Add the environment variable in the Vercel dashboard under **Settings → Environment Variables**:
   ```
   FIREBASE_SERVICE_ACCOUNT=<inline JSON — see below>
   ```
   Set it for **Production**, **Preview**, and **Development** as needed.

4. Redeploy to pick up the env var:
   ```bash
   vercel --prod
   ```

Your backend will be live at `https://<your-project>.vercel.app`.

### Getting the inline JSON for FIREBASE_SERVICE_ACCOUNT

Vercel env vars are single-line strings, so minify your service account file:

```bash
cat service-account.json | jq -c '.'
```

Paste the output as the value of `FIREBASE_SERVICE_ACCOUNT`.

---

## Local development

```bash
cp .env.example .env
# Fill in FIREBASE_SERVICE_ACCOUNT in .env
npm run dev
```

Server starts at `http://localhost:3000`. Verify with:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

---

## Firebase project checklist

- [ ] Firestore database created (production or test mode)
- [ ] Cloud Messaging enabled (on by default for Firebase projects)
- [ ] Service account JSON downloaded and set in `FIREBASE_SERVICE_ACCOUNT`
- [ ] Mobile app configured with the same Firebase project (so Auth JWTs verify correctly)
