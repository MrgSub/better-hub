import { GitError } from "../types";

/**
 * Code Storage's webhook transport: the signature scheme and the event shapes.
 *
 * Kept beside the rest of the adapter because both are this backend's wire
 * format — what the route above it acts on is the neutral `CodeStorageEvent`.
 */

const TOLERANCE_SECONDS = 5 * 60;

export interface PushEvent {
	type: "push";
	gitRepoId: string;
	ref: string;
	before: string;
	after: string;
	at: Date;
}

export interface SyncEvent {
	type: "sync";
	gitRepoId: string;
	state: "syncing" | "synced" | "failed";
	error: string | null;
	at: Date;
}

export type CodeStorageEvent = PushEvent | SyncEvent;

interface WireRepository {
	id?: unknown;
	url?: unknown;
}

interface WireEvent {
	repository?: WireRepository;
	ref?: unknown;
	before?: unknown;
	after?: unknown;
	error?: unknown;
	pushed_at?: unknown;
	started_at?: unknown;
	completed_at?: unknown;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function at(...candidates: unknown[]): Date {
	for (const candidate of candidates) {
		const raw = str(candidate);
		if (!raw) continue;
		const parsed = new Date(raw);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return new Date();
}

/**
 * The event, or null for one we do not act on.
 *
 * The delivery header names the event; the body repeats it only for sync
 * events, so the header is what is trusted. An unknown event is not an error:
 * the subscription is configured over there and may gain types we predate.
 */
export function parseCodeStorageEvent(eventType: string, body: unknown): CodeStorageEvent | null {
	if (typeof body !== "object" || body === null) return null;
	const wire = body as WireEvent;
	const gitRepoId = str(wire.repository?.id);
	if (!gitRepoId) return null;

	if (eventType === "push") {
		const ref = str(wire.ref);
		if (!ref) return null;
		return {
			type: "push",
			gitRepoId,
			ref,
			before: str(wire.before) ?? "",
			after: str(wire.after) ?? "",
			at: at(wire.pushed_at),
		};
	}

	const state = SYNC_STATES[eventType];
	if (!state) return null;
	return {
		type: "sync",
		gitRepoId,
		state,
		error: state === "failed" ? (str(wire.error) ?? "sync failed") : null,
		at: at(wire.completed_at, wire.started_at),
	};
}

const SYNC_STATES: Record<string, SyncEvent["state"] | undefined> = {
	"repo.sync.started": "syncing",
	"repo.sync.succeeded": "synced",
	"repo.sync.failed": "failed",
};

/**
 * Verifies `X-Pierre-Signature: t=<unix>,sha256=<hex>` over `<t>.<raw body>`.
 *
 * The timestamp is part of the signed payload and is checked against a window,
 * so a delivery that is captured cannot be replayed later. Comparison is
 * length-then-constant-time over the raw bytes rather than string equality.
 */
export async function verifyCodeStorageSignature(input: {
	header: string | null;
	rawBody: string;
	secret: string;
	now?: Date;
}): Promise<boolean> {
	const parsed = parseSignatureHeader(input.header);
	if (!parsed) return false;

	const now = input.now ?? new Date();
	const age = Math.abs(Math.floor(now.getTime() / 1000) - parsed.timestamp);
	if (age > TOLERANCE_SECONDS) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(input.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signed = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${parsed.timestamp}.${input.rawBody}`),
	);
	return timingSafeEqual(new Uint8Array(signed), parsed.signature);
}

function parseSignatureHeader(
	header: string | null,
): { timestamp: number; signature: Uint8Array } | null {
	if (!header) return null;
	let timestamp: number | null = null;
	let signature: Uint8Array | null = null;
	for (const part of header.split(",")) {
		const [key, value] = part.trim().split("=", 2);
		if (key === "t" && /^\d+$/.test(value ?? "")) timestamp = Number(value);
		if (key === "sha256") signature = hexToBytes(value ?? "");
	}
	return timestamp !== null && signature ? { timestamp, signature } : null;
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

/** The shared secret the subscription signs with. */
export function readWebhookSecret(env: Partial<Record<string, string>> = process.env): string {
	const secret = env.PIERRE_STORAGE_WEBHOOK_SECRET;
	if (!secret) {
		throw new GitError("backend_error", "PIERRE_STORAGE_WEBHOOK_SECRET is not set");
	}
	return secret;
}
