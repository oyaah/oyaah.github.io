# Deployment Notes

This is the production portfolio source for `https://oyaah.github.io/` and
`www.yashbansal.xyz`.

## Domain

- GitHub Pages custom domain: `www.yashbansal.xyz`
- Repo file: `CNAME`
- Namecheap root redirect should point to `https://www.yashbansal.xyz/`, not `http://www.yashbansal.xyz/`.
- Add a `www` CNAME DNS record pointing to `oyaah.github.io`.

## Voice/RAG Backend

The static portfolio sends production chat and voice traffic to:

```text
wss://api.yashbansal.xyz
```

The backend must allow:

```text
ALLOWED_ORIGINS=https://www.yashbansal.xyz,https://yashbansal.xyz,https://oyaah.github.io,http://localhost:5500,http://127.0.0.1:5500
```

Required backend secrets:

```text
OPENAI_API_KEY
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
```
