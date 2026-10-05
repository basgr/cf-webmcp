/**
 * Which optional documents the Worker serves, and so advertises: one answer per document,
 * used by the router, the Link header, the <link> tags, llms.txt and the build (the manifest's
 * links, the path-collision check, the skills index digest) and preflight. A document that is
 * not served is not claimed (its path stays with origin) and is not advertised anywhere.
 */

import type { Config } from "./config-types";

/**
 * The API catalog (RFC 9727). Its one entry of ours points at the WebMCP manifest, and RFC 9727
 * section 4.1 requires an API catalog to include hyperlinks to API endpoints. With
 * [features].manifest off there is no such link to publish, so the catalog is not served in any
 * mode: a synthesized one would be empty, and a merged one would add nothing to origin's own.
 */
export function apiCatalogServed(config: Config): boolean {
  return config.features.api_catalog && config.api_catalog.mode !== "passthrough" && config.features.manifest;
}

/**
 * The skills index (Cloudflare Agent Skills Discovery RFC). It lists the SKILL.md with a digest
 * the build computes over the exact bytes the Worker serves, so it needs [features].agent_skills
 * on and a mode whose body the build can hash: synthesize or replace. In merge mode the body holds
 * origin's file and in passthrough the SKILL.md is origin's, so no digest exists and the index is
 * not served: its path stays with origin.
 */
export function skillsIndexServed(config: Config): boolean {
  return (
    config.features.agent_skills_index &&
    config.agent_skills_index.mode !== "passthrough" &&
    config.features.agent_skills &&
    (config.agent_skills.mode === "synthesize" || config.agent_skills.mode === "replace")
  );
}
