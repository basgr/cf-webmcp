# Costs

Rough numbers for `cf-webmcp` on Cloudflare. These are publisher-facing operational costs, not licensing.

## Cloudflare Workers

Pricing as of 2026:

| Tier | Cost | Limits |
|------|------|--------|
| Free | 0 EUR/month | 100,000 requests/day, 10ms CPU per request |
| Paid | 5 EUR/month base | First 10M requests included, then 0.30 EUR per million |

Workers Paid includes 50ms CPU per request and faster cold starts. CPU time per Worker invocation in this project is well under 10ms for the manifest, landing, bootstrap, and health routes. Executor calls that fetch from origin spend most of their time waiting on the network, not on CPU.

### Sketch math

- Small blog, 10k pageviews/day, full-proxy mode: ~10k Worker requests/day. Free tier.
- Medium WordPress site, 100k pageviews/day, full-proxy mode: ~100k Worker requests/day. Free tier comfortable.
- High-traffic WooCommerce, 1M pageviews/day, full-proxy mode: ~1M Worker requests/day = 30M/month. Paid tier: 5 EUR + 20M overage × 0.30 EUR/M = ~11 EUR/month.

Tool calls add a fraction on top, since they are a small fraction of total page traffic and most are cached at the edge.

## R2 storage (for the fallback widget)

The widget JS is roughly 30KB. R2 storage cost is 0.015 EUR/GB/month, so 30KB is rounding error.

Egress is free on R2.

## Cache hits do not count

When CF edge serves a cached response (manifest, bootstrap script, executor response), no Worker invocation runs. Worker requests counter only ticks on cache misses and on the proxy path (HTML responses).

## What to monitor

`/_webmcp/health` exposes per-tool success/error counts (where Analytics Engine is wired). Once you have a few weeks of traffic, look at:

- Executor error rates per tool. If `origin_5xx` is non-zero, your origin needs attention, not the Worker.
- Cache hit rate per route (visible in CF dashboard).

## When you would not use this

- If you serve thousands of tool calls per second to a single tool, the per-request Worker cost beats the network round-trip cost. At that scale a dedicated backend is cheaper than per-request Worker billing.
- If you cannot accept proxying your entire domain through Cloudflare (full proxy mode), you fall back to route-only mode which loses the in-page injection feature.
