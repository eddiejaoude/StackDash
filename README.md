# StackDash

The project is on the `main` branch, which is the repository's default branch. Sign up to get notified.

<img width="1280" height="880" alt="a525c634-0497-4b3a-9b2c-8150b60ef4ae" src="https://github.com/user-attachments/assets/5f991fd5-98d1-44ba-a0d8-721ac5c197f5" />


The coming soon page for [stackda.sh](https://stackda.sh): the landing page hero with its animated
product preview, the StackDash logo, a note that StackDash is open source with a link to
[the repository](https://github.com/eddiejaoude/StackDash), and a signup form for the launch list.

<img width="1280" height="1080" alt="5c74ee55-5622-48f7-b164-835cbf2ddd71" src="https://github.com/user-attachments/assets/888fc186-ff57-4f30-92df-cd0df1095c64" />

This branch has its own history and is never merged to `main`. The product itself lives on `main`.
Tracked in issue #438.

## Run it

```bash
npm install
npm run dev
```

`npm run build && npm start` serves the production build. The page is fully static.

## Launch list

The signup form saves each address as a Resend contact in one segment (issue #440). Set these in
the Vercel project, never in the repository:

| Variable | Value |
| --- | --- |
| `RESEND_API_KEY` | A **Full access** key from the StackDash Resend team. A sending-only key cannot create contacts. |
| `RESEND_SEGMENT_ID` | The ID of the launch list segment (Audience, Segments, then Copy ID). |

Without them the form shows an error with a reference, and the server log says which is missing.
Add a Vercel Firewall rate limit rule for `POST /` so a bot cannot flood the list.
