# Tier 1 — Cloudflare in front of the chatbot ("the bouncer")

This guide is the deployment half of Tier 1 from `abuse_protection_report.pdf`.
The code half (trusting the right IP header) is already implemented in the
FastAPI sidecar — see `TRUSTED_PROXIES` / `CLIENT_IP_HEADER` in its `.env`.

## Why we need this tier at all

Tier 0 (rate limit, length cap, daily budgets) lives **inside our server**.
That means abusive traffic still *reaches* the server before being rejected:
it eats CPU, connections and bandwidth, and a big enough flood can knock the
machine over even though every request gets a 429. Cloudflare stands on the
sidewalk **in front of** the server and turns away bots and floods before
they touch it.

Just as important: Tier 0's per-IP limits are only as good as the IP they
key on. Without a trusted edge, the forwarding header that names the
visitor's IP is just text the client typed — fakeable on every request.
Cloudflare *observes* the visitor's address at the edge and stamps it into
`CF-Connecting-IP`, giving our limits a source of truth.

## What you get on the free plan

- DDoS protection and bot blocking before traffic reaches the origin.
- `CF-Connecting-IP`: the visitor's real IP, observed (not claimed).
- Edge rate-limiting rules (a generous free allowance).
- TLS certificates and caching as a bonus.

## Setup steps

### 1. Put the domain on Cloudflare

1. Create a free account at cloudflare.com and click **Add a site**.
2. Enter the shop's domain. Cloudflare imports the existing DNS records.
3. At your registrar, replace the nameservers with the two Cloudflare gives
   you. (Propagation can take a few hours.)

### 2. Proxy the two hostnames

In **DNS → Records**, make sure the cloud icon is **orange (Proxied)** for:

- the Odoo website (e.g. `shop.example.com`)
- the chat API (e.g. `chat-api.example.com` → the FastAPI sidecar)

Orange = traffic flows through the bouncer. Grey = bypasses it.

### 3. TLS

**SSL/TLS → Overview**: set mode to **Full (strict)**. The origin (nginx)
must have a valid certificate — Cloudflare's free *origin certificate*
(SSL/TLS → Origin Server) works and never expires on you.

### 4. Turn on the bot defenses

- **Security → Bots**: enable **Bot Fight Mode** (free).
- **Security → WAF → Rate limiting rules**: add a rule for the chat path,
  e.g. *URI path contains `/mcp_chatbot/message` → more than 30 requests
  per minute per IP → Block for 1 minute*. This duplicates our slowapi
  limit **at the edge**, so floods are rejected before costing us anything.

### 5. Close the back door (IMPORTANT)

The bouncer is useless if people can climb in through the window: if the
origin server answers traffic from anywhere, an attacker who finds its IP
can skip Cloudflare entirely — and forge `CF-Connecting-IP` themselves.

Allow only Cloudflare's published IP ranges (https://www.cloudflare.com/ips/)
to reach ports 80/443. With ufw, for example:

```bash
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow proto tcp from "$ip" to any port 80,443
done
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow proto tcp from "$ip" to any port 80,443
done
# then remove any generic "allow 80/443 from anywhere" rules
```

(On a cloud provider, do the same in the security group instead.)

### 6. Tell the sidecar who to trust

In the sidecar's `.env`:

```bash
# nginx on the same machine forwards to uvicorn
TRUSTED_PROXIES=127.0.0.1,::1
# behind Cloudflare, the visitor's real IP arrives in this header
CLIENT_IP_HEADER=CF-Connecting-IP
```

nginx passes `CF-Connecting-IP` through to uvicorn automatically (it
forwards unknown headers untouched), so no nginx change is needed for it.

### 7. Verify

After DNS propagates:

1. `curl -s https://chat-api.example.com/...` from your laptop — works.
2. `curl -s https://<origin-server-ip>/...` directly — should now time out
   or be refused (step 5 working).
3. Check the sidecar logs: rate-limit and budget lines should show real
   visitor IPs, not `127.0.0.1` and not whatever a client typed.

## How the pieces line up afterwards

```
visitor → Cloudflare (blocks bots/floods, stamps CF-Connecting-IP)
        → origin firewall (only Cloudflare may enter)
        → nginx (trusted proxy, 127.0.0.1)
        → FastAPI sidecar (believes CF-Connecting-IP because the request
          arrived via a trusted peer; Tier 0 limits key on the real IP)
```
