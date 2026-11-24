// server/api/dictionary/remove.post.ts
import { Buffer } from "node:buffer";

type GithubFile = {
  sha: string;
  content: string;
  encoding: string;
};

function headers(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "words-app",
  };
}

async function githubError(e: unknown, fallback: string) {
  const err = e as { statusCode?: number; statusMessage?: string; data?: { message?: string } };
  const detail = err?.data?.message || err?.statusMessage;
  return `${fallback} (HTTP ${err?.statusCode ?? "unknown"}${detail ? `: ${detail}` : ""})`;
}

/**
 * Remove a word from public/dict/words.txt by committing to the GitHub repo.
 * Requires GITHUB_TOKEN (contents write) and GITHUB_REPO ("owner/name")
 * in the server environment; without them the removal stays session-local
 * and this route reports persisted: "local".
 */
export default defineEventHandler(async (event) => {
  const { word } = await readBody(event);
  const target = typeof word === "string" ? word.trim().toLowerCase() : "";
  if (!target || !/^[a-z]+$/.test(target))
    throw createError({ statusCode: 400, statusMessage: "A lowercase word is required" });

  const config = useRuntimeConfig();
  if (!config.githubToken || !config.githubRepo)
    return { removed: false, persisted: "local", message: "GitHub token not configured on the server" };

  const filePath = "public/dict/words.txt";
  const api = `https://api.github.com/repos/${config.githubRepo}/contents/${filePath}`;

  let remote: GithubFile;
  try {
    remote = await $fetch<GithubFile>(api, { headers: headers(config.githubToken) });
  }
  catch (e: unknown) {
    throw createError({ statusCode: 502, statusMessage: await githubError(e, "GitHub read failed") });
  }

  const text = Buffer.from(remote.content, "base64").toString("utf-8");
  const lines = text.split("\n");
  const kept = lines.filter(line => line.trim().toLowerCase() !== target);
  if (kept.length === lines.length)
    return { removed: false, persisted: "local", message: `"${target}" is not in the dictionary file` };

  try {
    await $fetch(api, {
      method: "PUT",
      headers: headers(config.githubToken),
      body: {
        message: `Remove "${target}" from dictionary`,
        content: Buffer.from(kept.join("\n"), "utf-8").toString("base64"),
        sha: remote.sha,
      },
    });
  }
  catch (e: unknown) {
    throw createError({ statusCode: 502, statusMessage: await githubError(e, "GitHub commit failed") });
  }

  return { removed: true, persisted: "github" };
});
