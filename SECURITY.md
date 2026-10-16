# Security

Buz Cards stores personal contact data. Please report vulnerabilities privately through the repository's security advisory feature rather than a public issue.

Design choices:
- Binds to `127.0.0.1` by default. LAN mode (`start-phone`, `--lan`, `HOST=0.0.0.0`) requires a per-installation access code for every device except the computer itself.
- Plain HTTP on a LAN is unencrypted: use only on networks you trust, or enable HTTPS (`HTTPS=1` or your own certificate).
- No telemetry and no outbound traffic except the optional LinkedIn search API (name + company are sent to that provider when you press *Find profile*).
- Secrets live in `.env` on the server only; they are excluded from backups, logs and the web app.
- Uploaded files are identified by content (magic bytes), size-limited, and decoded in a worker thread with a timeout.
