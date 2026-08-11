import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/repos/mirror", () => ({
	recordMirrorPush: vi.fn(() => Promise.resolve()),
	recordMirrorSync: vi.fn(() => Promise.resolve()),
}));

import { recordMirrorPush, recordMirrorSync } from "@/lib/repos/mirror";
import { POST } from "./route";

const SECRET = "whsec_test";

async function signature(rawBody: string): Promise<string> {
	const timestamp = Math.floor(Date.now() / 1000);
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

async function deliver(event: string, body: unknown, header?: string | null) {
	const rawBody = typeof body === "string" ? body : JSON.stringify(body);
	return await POST(
		new Request("https://better-hub.com/api/webhooks/code-storage", {
			method: "POST",
			body: rawBody,
			headers: {
				"content-type": "application/json",
				"x-pierre-event": event,
				...(header === null
					? {}
					: {
							"x-pierre-signature":
								header ??
								(await signature(rawBody)),
						}),
			},
		}),
	);
}

describe("POST /api/webhooks/code-storage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.PIERRE_STORAGE_WEBHOOK_SECRET = SECRET;
	});

	it("records a signed sync failure against the repository", async () => {
		const response = await deliver("repo.sync.failed", {
			repository: { id: "repo_1" },
			error: "authentication failed",
		});
		expect(response.status).toBe(200);
		expect(recordMirrorSync).toHaveBeenCalledWith(
			expect.objectContaining({
				gitRepoId: "repo_1",
				state: "failed",
				error: "authentication failed",
			}),
		);
	});

	it("records a signed push", async () => {
		await deliver("push", {
			repository: { id: "repo_1" },
			ref: "refs/heads/main",
			pushed_at: "2026-08-16T10:30:00Z",
		});
		expect(recordMirrorPush).toHaveBeenCalledWith(
			"repo_1",
			new Date("2026-08-16T10:30:00Z"),
		);
	});

	it("refuses an unsigned or wrongly signed delivery without touching anything", async () => {
		const unsigned = await deliver("push", { repository: { id: "repo_1" } }, null);
		const forged = await deliver(
			"push",
			{ repository: { id: "repo_1" } },
			"t=1,sha256=00",
		);
		expect([unsigned.status, forged.status]).toEqual([401, 401]);
		expect(recordMirrorPush).not.toHaveBeenCalled();
		expect(recordMirrorSync).not.toHaveBeenCalled();
	});

	it("accepts an event it does not act on, so it is not redelivered", async () => {
		const response = await deliver("branch.created", { repository: { id: "repo_1" } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, handled: false });
		expect(recordMirrorPush).not.toHaveBeenCalled();
	});

	it("rejects a signed body that is not json", async () => {
		const response = await deliver("push", "not json");
		expect(response.status).toBe(400);
	});
});
