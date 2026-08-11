import { describe, expect, it } from "vitest";
import { buildAgentPrompt, parseRepoInput } from "./migrate";
import type { MigrateInput } from "./migrate";

describe("parseRepoInput", () => {
	it("accepts the shapes people paste", () => {
		const expected = { owner: "octocat", name: "Hello-World" };
		for (const input of [
			"octocat/Hello-World",
			"  octocat/Hello-World  ",
			"https://github.com/octocat/Hello-World",
			"https://github.com/octocat/Hello-World.git",
			"http://github.com/octocat/Hello-World",
			"git@github.com:octocat/Hello-World.git",
			"ssh://git@github.com/octocat/Hello-World.git",
		]) {
			expect(parseRepoInput(input), input).toEqual(expected);
		}
	});

	it("rejects anything that is not a repository reference", () => {
		for (const input of [
			"",
			"   ",
			"octocat",
			"https://github.com/octocat",
			"a/b/c/d",
		]) {
			expect(parseRepoInput(input), input).toBeNull();
		}
	});

	it("takes the repository out of a deep link", () => {
		expect(parseRepoInput("https://github.com/octocat/Hello-World/pull/1")).toEqual({
			owner: "octocat",
			name: "Hello-World",
		});
	});
});

describe("buildAgentPrompt", () => {
	const input: MigrateInput = {
		upstream: {
			owner: "octocat",
			name: "Hello-World",
			private: false,
			defaultBranch: "master",
			description: null,
			homepage: null,
			topics: [],
			sizeKb: 1,
			ownerType: "User",
			permission: "admin",
			orgRole: null,
		},
		actor: { userId: "u1", login: "adam", token: "should-never-appear" },
		name: "hello-world",
		defaultBranch: "master",
	};
	const target = { owner: "adam", repo: "hello-world" };

	it("repoints origin and keeps github as a fallback remote", () => {
		const prompt = buildAgentPrompt(
			input,
			target,
			"https://t:short-lived@host/adam/hello-world.git",
		);
		expect(prompt).toContain(
			"git remote set-url origin https://t:short-lived@host/adam/hello-world.git",
		);
		expect(prompt).toContain(
			"git remote add github https://github.com/octocat/Hello-World.git",
		);
		expect(prompt).toContain("Do not rewrite history");
	});

	it("never leaks the user's github token", () => {
		expect(buildAgentPrompt(input, target, "https://host/x.git")).not.toContain(
			input.actor.token,
		);
	});
});
