# Costs

Rough numbers for `cf-webmcp` on Cloudflare. These are publisher-facing operational costs, not licensing.

> **Pricing snapshot as of 2026-05-13.** Cloudflare publishes the authoritative numbers and changes them from time to time. Verify against [cloudflare.com/plans](https://www.cloudflare.com/plans/developer-platform/) before relying on these figures.

## Cloudflare Workers

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

R2 has a free tier that covers `cf-webmcp` with room to spare: 10 GB of storage per month, 1 million Class A operations per month, 10 million Class B operations per month. The widget JS is roughly 30KB. One stored object, a handful of reads on each Worker cold start. Nowhere near the free tier ceiling.

Beyond free tier: 0.015 EUR/GB/month for storage, with no egress fees on R2.

R2 activation requires a payment method on file even at zero usage. If you do not enable R2, set `[features].fallback_widget = false` in your TOML and remove the `[[r2_buckets]]` block from `wrangler.toml`. Browser-native users keep working; desktop MCP clients see the "widget disabled" landing state.

## Cache hits do not count

When CF edge serves a cached response (manifest, bootstrap script, executor response), no Worker invocation runs. Worker requests counter only ticks on cache misses and on the proxy path (HTML responses).

## What to monitor

`/_webmcp/health` exposes per-tool success/error counts (where Analytics Engine is wired). Once you have a few weeks of traffic, look at:

- Executor error rates per tool. If `origin_5xx` is non-zero, your origin needs attention, not the Worker.
- Cache hit rate per route (visible in CF dashboard).

## When you would not use this

- If you serve thousands of tool calls per second to a single tool, the per-request Worker cost beats the network round-trip cost. At that scale a dedicated backend is cheaper than per-request Worker billing.
- If you cannot accept proxying your entire domain through Cloudflare (full proxy mode), you fall back to route-only mode which loses the in-page injection feature.
