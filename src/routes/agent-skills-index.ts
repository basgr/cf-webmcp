/**
 * GET /.well-known/agent-skills/index.json handler.
 *
 * Implements the Cloudflare Agent Skills Discovery RFC v0.2.0 index document
 * (https://github.com/cloudflare/agent-skills-discovery-rfc). The RFC pins
 * the JSON shape to its $schema URI; we version-lock to 0.2.0 here and bump
 * when the RFC firms up.
 *
 * cf-webmcp emits a single skill entry pointing at the publisher's SKILL.md
 * (the one served by routes/agent-skills.ts). The SHA-256 digest is computed
 * at build time over the synthesised SKILL.md body and embedded as
 * AGENT_SKILLS_DIGEST in the generated config module.
 *
 * Modes:
 *   - synthesize (default): emit the index
 *   - passthrough: route not registered (router/feature toggle handles it)
 *
 * If the underlying agent_skills.mode is "merge", the digest cannot be
 * computed deterministically at build time (origin content is part of the
 * served body), so AGENT_SKILLS_DIGEST is null and this handler returns
 * 404 with an explanatory body rather than publish a stale digest.
 *
 * No HTTP Link rel is defined by the RFC; discovery is well-known-path only.
 * cf-webmcp does include `links.agent_skills_index` in the manifest as a
 * secondary discovery path for WebMCP-aware clients.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { slugify } from "./agent-skills";

export const AGENT_SKILLS_INDEX_SCHEMA_URI =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

interface SkillEntry {
  name: string;
  type: "skill-md" | "archive";
  description: string;
  url: string;
  digest: string;
}

interface IndexDocument {
  $schema: string;
  skills: SkillEntry[];
}

export function agentSkillsIndexResponse(
  _request: Request,
  config: Config,
  agentSkillsDigest: string | null,
): Response {
  // The digest is null when:
  //   - feature is disabled (route won't reach here in that case)
  //   - mode is passthrough (route won't reach here either)
  //   - agent_skills.mode is merge or passthrough (we don't own a stable body)
  // The router filters the first two; only the third can land here at runtime.
  if (!agentSkillsDigest) {
    return new Response(
      JSON.stringify(
        {
          error: "agent-skills index requires agent_skills.mode in {synthesize, replace}; current mode is " + config.agent_skills.mode,
        },
        null,
        2,
      ) + "\n",
      {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex",
          // Short cache so a TOML change that flips mode to synthesize is
          // picked up promptly.
          "cache-control": "public, max-age=60",
        },
      },
    );
  }

  const skillName = slugify(config.agent_skills.name || config.site.name);
  const description =
    config.agent_skills.description ||
    config.site.description ||
    `WebMCP-enabled site: ${config.site.name}`;

  const doc: IndexDocument = {
    $schema: AGENT_SKILLS_INDEX_SCHEMA_URI,
    skills: [
      {
        name: skillName,
        type: "skill-md",
        description,
        url: config.agent_skills.path,
        digest: agentSkillsDigest,
      },
    ],
  };

  // Stable byte output: 2-space indent, trailing newline. This means a
  // hash of the response body is stable across builds with the same config.
  const body = JSON.stringify(doc, null, 2) + "\n";

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.agent_skills_index_max_age,
        s_maxage: config.cache.agent_skills_index_s_maxage,
        swr: config.cache.agent_skills_index_swr,
        sie: config.cache.agent_skills_index_sie,
      }),
      "x-content-type-options": "nosniff",
      // /.well-known/agent-skills/index.json is an agent-discovery surface.
      // See feedback memory and the x-robots coverage test.
      "x-robots-tag": "noindex",
    },
  });
}
