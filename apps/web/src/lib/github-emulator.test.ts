import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "http://localhost:4000";

async function load(env: { url?: string; nodeEnv?: string; allow?: string; phase?: string }) {
	vi.resetModules();
	vi.stubEnv("GITHUB_EMULATOR_URL", env.url ?? "");
	vi.stubEnv("NODE_ENV", env.nodeEnv ?? "test");
	vi.stubEnv("ALLOW_GITHUB_EMULATOR_IN_PRODUCTION", env.allow ?? "");
	vi.stubEnv("NEXT_PHASE", env.phase ?? "");
	return import("./github-emulator");
}

describe("github emulator", () => {
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = realFetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("is inert when unconfigured", async () => {
		const mod = await load({});
		expect(mod.githubEmulatorOrigin).toBeNull();
		expect(mod.githubAuthorizationEndpoint).toBeNull();
		expect(mod.rewriteGithubUrl("https://api.github.com/user")).toBe(
			"https://api.github.com/user",
		);
		mod.installGithubEmulator();
		expect(globalThis.fetch).toBe(realFetch);
	});

	it("collapses both GitHub origins onto the emulator, preserving path and query", async () => {
		const { rewriteGithubUrl } = await load({ url: ORIGIN });
		expect(rewriteGithubUrl("https://github.com/login/oauth/access_token")).toBe(
			`${ORIGIN}/login/oauth/access_token`,
		);
		expect(
			rewriteGithubUrl("https://api.github.com/repos/a/b/commits?per_page=5"),
		).toBe(`${ORIGIN}/repos/a/b/commits?per_page=5`);
	});

	it("leaves non-GitHub and unparseable URLs alone", async () => {
		const { rewriteGithubUrl } = await load({ url: ORIGIN });
		expect(rewriteGithubUrl("https://raw.githubusercontent.com/a/b")).toBe(
			"https://raw.githubusercontent.com/a/b",
		);
		expect(rewriteGithubUrl("/api/auth/session")).toBe("/api/auth/session");
	});

	it("rewrites string, URL and Request inputs, and installs only once", async () => {
		const mod = await load({ url: ORIGIN });
		const spy = vi.fn<typeof fetch>(async () => new Response(null));
		globalThis.fetch = spy;

		mod.installGithubEmulator();
		const patched = globalThis.fetch;
		mod.installGithubEmulator();
		expect(globalThis.fetch).toBe(patched);

		await globalThis.fetch("https://api.github.com/user");
		await globalThis.fetch(new URL("https://api.github.com/user/emails"));
		await globalThis.fetch(new Request("https://github.com/login/oauth/access_token"));
		await globalThis.fetch("https://example.com/untouched");

		expect(
			spy.mock.calls.map(([input]) =>
				String(input instanceof Request ? input.url : input),
			),
		).toEqual([
			`${ORIGIN}/user`,
			`${ORIGIN}/user/emails`,
			`${ORIGIN}/login/oauth/access_token`,
			"https://example.com/untouched",
		]);
	});

	it("refuses to route production traffic at an emulator", async () => {
		await expect(load({ url: ORIGIN, nodeEnv: "production" })).rejects.toThrow(
			/production/,
		);
		const forced = await load({ url: ORIGIN, nodeEnv: "production", allow: "1" });
		expect(forced.githubEmulatorOrigin).toBe(ORIGIN);
	});

	it("still allows a production build, which shares NODE_ENV with the server", async () => {
		const built = await load({
			url: ORIGIN,
			nodeEnv: "production",
			phase: "phase-production-build",
		});
		expect(built.githubEmulatorOrigin).toBe(ORIGIN);
	});
});
