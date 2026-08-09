/**
 * Local GitHub emulation (https://emulate.dev), for development and CI where no
 * real OAuth app exists.
 *
 * The emulator serves GitHub's OAuth endpoints *and* its REST API from a single
 * origin, so redirecting the app at it is a host rewrite: both `github.com` and
 * `api.github.com` collapse onto `GITHUB_EMULATOR_URL`.
 *
 * Only the browser-facing authorization redirect is configured explicitly (via
 * better-auth's `authorizationEndpoint`); everything else — the token exchange,
 * better-auth's profile lookup, and every Octokit call in the app — is caught by
 * the `fetch` rewrite installed at server startup, so no call site knows the
 * emulator exists.
 */

const EMULATED_HOSTS = new Set(["github.com", "www.github.com", "api.github.com"]);

/** Configured emulator origin, or null when talking to the real GitHub. */
export const githubEmulatorOrigin: string | null = readEmulatorOrigin();

function readEmulatorOrigin(): string | null {
	const raw = process.env.GITHUB_EMULATOR_URL?.trim();
	if (!raw) return null;
	if (
		process.env.NODE_ENV === "production" &&
		!process.env.ALLOW_GITHUB_EMULATOR_IN_PRODUCTION
	) {
		throw new Error(
			"GITHUB_EMULATOR_URL is set in production; refusing to route GitHub traffic at an emulator",
		);
	}
	return new URL(raw).origin;
}

/** The URL the browser is sent to in order to sign in, or null for real GitHub. */
export const githubAuthorizationEndpoint: string | null = githubEmulatorOrigin
	? `${githubEmulatorOrigin}/login/oauth/authorize`
	: null;

/** Rewrites a GitHub URL onto the emulator, or returns it unchanged. */
export function rewriteGithubUrl(url: string): string {
	if (!githubEmulatorOrigin) return url;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (!EMULATED_HOSTS.has(parsed.host)) return url;
	return `${githubEmulatorOrigin}${parsed.pathname}${parsed.search}`;
}

/**
 * Routes every outgoing GitHub request at the emulator by wrapping `fetch`.
 * Idempotent, and a no-op unless `GITHUB_EMULATOR_URL` is set.
 */
export function installGithubEmulator(): void {
	if (!githubEmulatorOrigin) return;
	const original = globalThis.fetch;
	if (Reflect.get(original, EMULATOR_INSTALLED)) return;

	const patched: typeof fetch = (input, init) => {
		if (typeof input === "string" || input instanceof URL) {
			return original(rewriteGithubUrl(input.toString()), init);
		}
		const rewritten = rewriteGithubUrl(input.url);
		return original(
			rewritten === input.url ? input : new Request(rewritten, input),
			init,
		);
	};
	Reflect.set(patched, EMULATOR_INSTALLED, true);
	globalThis.fetch = patched;
	console.warn(`[github-emulator] routing GitHub traffic at ${githubEmulatorOrigin}`);
}

const EMULATOR_INSTALLED = Symbol.for("better-hub.github-emulator");
