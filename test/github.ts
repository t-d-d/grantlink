import { z } from "zod";

// The conformance files' one way to read GitHub, so a change to how the
// token or the proxy is handled is made here once (#489).
const repository = "t-d-d/grantlink";

// Anonymous calls share a small rate limit per address, so a token is sent
// when GITHUB_TOKEN holds one: a token a workflow maps, or in a cloud
// session the placeholder its proxy replaces, which Node's fetch reaches
// only with NODE_USE_ENV_PROXY=1 set. An empty token, as a workflow passes
// for a secret that is not set, counts as none.
const { GITHUB_TOKEN } = z
  .object({
    GITHUB_TOKEN: z
      .string()
      .optional()
      .transform((token) => (token === "" ? undefined : token)),
  })
  .parse(process.env);

// Reads a path under the repository, or the repository's own record when
// the path is empty, and fails unless GitHub answers 200. The caller parses
// the reply with its own schema. fetch follows GitHub's redirects, and the
// callers rely on that: a renamed or transferred repository's old name and
// a moved issue's old number answer with the new record.
export async function getRepo(path = ""): Promise<unknown> {
  const url = `https://api.github.com/repos/${repository}${path === "" ? "" : `/${path}`}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN === undefined
        ? {}
        : { Authorization: `Bearer ${GITHUB_TOKEN}` }),
    },
  });
  // GitHub's reply says why a call failed, such as a bad token or the rate
  // limit, so a failure shows it. A helper imports no test runner
  // (test/code-and-tests.static.ts), so this throws rather than asserts.
  const reply = await response.text();
  if (response.status !== 200) {
    throw new Error(
      `GitHub answered ${String(response.status)} for ${url}: ${reply}`,
    );
  }
  return JSON.parse(reply);
}
