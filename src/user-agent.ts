/**
 * The User-Agent of cf-webmcp's own requests to origin: the Worker's (the executors and the merge
 * routes) is `cf-webmcp/<version>`, preflight's `cf-webmcp-preflight/<version>`. The version is the
 * one in package.json, which the build embeds as CF_WEBMCP_VERSION. The only place either string is
 * built, so no caller can carry a version of its own (scripts/user-agent.test.ts enforces it).
 */

export function userAgent(version: string): string {
  return `cf-webmcp/${version}`;
}

export function preflightUserAgent(version: string): string {
  return `cf-webmcp-preflight/${version}`;
}
