/**
 * The User-Agent of the Worker's own requests to origin (the executors and the merge routes):
 * `cf-webmcp/<version>`, the version from package.json that the build embeds as
 * CF_WEBMCP_VERSION. One function, so no caller can carry a version of its own.
 */

export function userAgent(version: string): string {
  return `cf-webmcp/${version}`;
}
