import { describe, expect, it } from "vitest";
import { parseCodeStorageEvent, verifyCodeStorageSignature } from "./webhook";

const SECRET = "whsec_test";

async function sign(rawBody: string, timestamp: number): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${timestamp}.${rawBody}`),
	);
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `t=${timestamp},sha256=${hex}`;
}

const now = new Date("2026-08-16T10:00:00Z");
const seconds = Math.floor(now.getTime() / 1000);

describe("verifyCodeStorageSignature", () => {
	const rawBody = JSON.stringify({ repository: { id: "repo_1" }, ref: "refs/heads/main" });

	it("accepts a delivery signed with the secret", async () => {
		expect(
			await verifyCodeStorageSignature({
				header: await sign(rawBody, seconds),
				rawBody,
				secret: SECRET,
				now,
			}),
		).toBe(true);
	});

	it("refuses another secret, a tampered body, and a missing header", async () => {
		const header = await sign(rawBody, seconds);
		expect(
			await verifyCodeStorageSignature({
				header,
				rawBody,
				secret: "whsec_other",
				now,
			}),
		).toBe(false);
		expect(
			await verifyCodeStorageSignature({
				header,
				rawBody: `${rawBody} `,
				secret: SECRET,
				now,
			}),
		).toBe(false);
		expect(
			await verifyCodeStorageSignature({
				header: null,
				rawBody,
				secret: SECRET,
				now,
			}),
		).toBe(false);
	});

	it("refuses a valid signature replayed outside the window", async () => {
		const header = await sign(rawBody, seconds - 6 * 60);
		expect(
			await verifyCodeStorageSignature({ header, rawBody, secret: SECRET, now }),
		).toBe(false);
	});

	it("refuses a header whose signature is not hex of the right length", async () => {
		for (const header of [`t=${seconds},sha256=zz`, `t=${seconds}`, "sha256=abcd"]) {
			expect(
				await verifyCodeStorageSignature({
					header,
					rawBody,
					secret: SECRET,
					now,
				}),
			).toBe(false);
		}
	});
});

describe("parseCodeStorageEvent", () => {
	it("reads a push", () => {
		expect(
			parseCodeStorageEvent("push", {
				repository: { id: "repo_1", url: "admin/lab" },
				ref: "refs/heads/main",
				before: "a".repeat(40),
				after: "b".repeat(40),
				pushed_at: "2026-08-16T10:30:00Z",
			}),
		).toEqual({
			type: "push",
			gitRepoId: "repo_1",
			ref: "refs/heads/main",
			before: "a".repeat(40),
			after: "b".repeat(40),
			at: new Date("2026-08-16T10:30:00Z"),
		});
	});

	it("maps the sync lifecycle, keeping the failure reason", () => {
		expect(
			parseCodeStorageEvent("repo.sync.started", {
				repository: { id: "repo_1" },
			}),
		).toMatchObject({ type: "sync", state: "syncing", error: null });
		expect(
			parseCodeStorageEvent("repo.sync.succeeded", {
				repository: { id: "repo_1" },
				completed_at: "2026-08-16T10:31:00Z",
			}),
		).toMatchObject({
			type: "sync",
			state: "synced",
			at: new Date("2026-08-16T10:31:00Z"),
		});
		expect(
			parseCodeStorageEvent("repo.sync.failed", {
				repository: { id: "repo_1" },
				error: "authentication failed",
			}),
		).toMatchObject({ type: "sync", state: "failed", error: "authentication failed" });
	});

	it("ignores an event we do not act on, or one we cannot attribute", () => {
		expect(
			parseCodeStorageEvent("branch.created", { repository: { id: "r" } }),
		).toBeNull();
		expect(parseCodeStorageEvent("push", { ref: "refs/heads/main" })).toBeNull();
		expect(parseCodeStorageEvent("push", { repository: { id: "r" } })).toBeNull();
		expect(parseCodeStorageEvent("push", null)).toBeNull();
	});
});
