# Rabbithole Fetch Proxy

Stateless GET-only proxy for the static web app's URL-open flow.

Deploy with Wrangler:

```bash
wrangler deploy workers/fetch-proxy/index.js --name rabbithole-fetch-proxy
```

Then paste the deployed Worker URL into Rabbithole web Settings as the fetch proxy URL. The app sends requests as:

```text
https://your-worker.example/?url=https%3A%2F%2Farxiv.org%2Fabs%2F1706.03762
```

## Allowlist Rationale

The proxy exists only for academic-reading sources that often block browser CORS:

- `arxiv.org`, `www.arxiv.org`: canonical arXiv pages and PDFs.
- `ar5iv.labs.arxiv.org`, `ar5iv.org`: HTML renderings of arXiv papers, preferred over PDFs when available.
- `openreview.net`: paper pages commonly used for ML research.

It is deliberately not a general web proxy. The handler accepts only GET, strips cookies/auth headers in both directions, caps responses at 25 MB while streaming, passes through only `content-type`, and never logs request or response bodies.
