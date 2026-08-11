import { importPKCS8, SignJWT } from "jose";
import { GitError, type GitScope, type RepoRef } from "../types";

/**
 * Code Storage REST client.
 *
 * Every request carries a JWT we sign with the org private key. Tokens are
 * repo-scoped (via the `repo` claim) except `org:read`, which is org-wide, so
 * the `/api/v1/*` surface is used throughout: it reads the repo from the claim
 * instead of the path and therefore needs no escaping for the `/` in
 * `owner/repo`.
 */

const DEFAULT_BASE_URL = "https://api.code.storage";
const DEFAULT_TTL_SECONDS = 300;

/** Code Storage permission scopes, distinct from our coarse `GitScope`. */
export type CodeStorageScope = "git:read" | "git:write" | "repo:write" | "org:read";

export function repoId(r: RepoRef): string {
	return `${r.owner}/${r.repo}`;
}

export function toCodeStorageScopes(scopes: GitScope[]): CodeStorageScope[] {
	const out = new Set<CodeStorageScope>(["git:read"]);
	for (const scope of scopes) {
		if (scope === "write" || scope === "admin") out.add("git:write");
		if (scope === "admin") out.add("repo:write");
	}
	return [...out];
}

/**
 * PEM as it survives a `.env` round trip: newlines may arrive escaped, spaced,
 * or the whole block wrapped in quotes.
 */
export function normalizePrivateKeyPem(raw: string): string {
	const unwrapped = raw
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/\\n/g, "\n");
	const match = unwrapped.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
	if (!match) throw new GitError("backend_error", "PIERRE_STORAGE_KEY is not a PEM block");
	const body = match[2].replace(/\s+/g, "").match(/.{1,64}/g);
	if (!body) throw new GitError("backend_error", "PIERRE_STORAGE_KEY has an empty body");
	return `-----BEGIN ${match[1]}-----\n${body.join("\n")}\n-----END ${match[1]}-----\n`;
}

export interface CodeStorageConfig {
	org: string;
	privateKeyPem: string;
	baseUrl: string;
	/** Git remote host, e.g. `orchid.code.storage`. */
	gitHost: string;
}

export function readCodeStorageConfig(
	env: Partial<Record<string, string>> = process.env,
): CodeStorageConfig {
	const org = env.PIERRE_STORAGE_NAME;
	const privateKeyPem = env.PIERRE_STORAGE_KEY;
	if (!org) throw new GitError("backend_error", "PIERRE_STORAGE_NAME is not set");
	if (!privateKeyPem) throw new GitError("backend_error", "PIERRE_STORAGE_KEY is not set");
	return {
		org,
		privateKeyPem,
		baseUrl: env.PIERRE_STORAGE_API_URL ?? DEFAULT_BASE_URL,
		gitHost: env.PIERRE_STORAGE_GIT_HOST ?? `${org}.code.storage`,
	};
}

export interface RequestOptions {
	repo?: RepoRef;
	scopes: CodeStorageScope[];
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	query?: Record<string, string | number | boolean | undefined>;
	body?: BodyInit;
	contentType?: string;
	/** Treat 404 as an empty result instead of throwing. */
	allowNotFound?: boolean;
}

function errorCode(status: number) {
	if (status === 401) return "unauthorized" as const;
	if (status === 403) return "forbidden" as const;
	if (status === 404) return "not_found" as const;
	if (status === 409 || status === 412) return "conflict" as const;
	if (status === 429) return "rate_limited" as const;
	return "backend_error" as const;
}

/** Code Storage returns RFC 7807 problem documents on failure. */
function errorMessage(status: number, body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object") {
			const problem = parsed as {
				detail?: unknown;
				error?: unknown;
				title?: unknown;
				// Commit endpoints answer with their own result envelope.
				result?: { message?: unknown };
			};
			for (const field of [
				problem.detail,
				problem.error,
				problem.title,
				problem.result?.message,
			]) {
				if (typeof field === "string" && field.length > 0) return field;
			}
		}
	} catch {
		// fall through to the raw body
	}
	return body.slice(0, 200) || `HTTP ${status}`;
}

export class CodeStorageClient {
	readonly config: CodeStorageConfig;
	private keyPromise: Promise<CryptoKey> | null = null;

	constructor(config: CodeStorageConfig = readCodeStorageConfig()) {
		this.config = config;
	}

	private async signingKey(): Promise<CryptoKey> {
		this.keyPromise ??= importPKCS8(
			normalizePrivateKeyPem(this.config.privateKeyPem),
			"ES256",
		);
		return this.keyPromise;
	}

	async signToken(
		scopes: CodeStorageScope[],
		repo?: RepoRef,
		ttlSeconds = DEFAULT_TTL_SECONDS,
	): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({
			iss: this.config.org,
			sub: "better-hub",
			...(repo ? { repo: repoId(repo) } : {}),
			scopes,
			iat: now,
			exp: now + ttlSeconds,
		})
			.setProtectedHeader({ alg: "ES256", typ: "JWT" })
			.sign(await this.signingKey());
	}

	async remoteUrl(
		repo: RepoRef,
		scopes: CodeStorageScope[],
		ttlSeconds: number,
	): Promise<string> {
		const token = await this.signToken(scopes, repo, ttlSeconds);
		return `https://t:${token}@${this.config.gitHost}/${repoId(repo)}.git`;
	}

	private async send(path: string, options: RequestOptions): Promise<Response> {
		const url = new URL(`/api/v1${path}`, this.config.baseUrl);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		const token = await this.signToken(options.scopes, options.repo);
		const response = await fetch(url, {
			method: options.method ?? "GET",
			headers: {
				authorization: `Bearer ${token}`,
				...(options.contentType
					? { "content-type": options.contentType }
					: {}),
			},
			body: options.body,
		});
		if (!response.ok) {
			const text = await response.text();
			throw new GitError(
				errorCode(response.status),
				errorMessage(response.status, text),
				response.status,
			);
		}
		return response;
	}

	async json<T>(path: string, options: RequestOptions): Promise<T | null> {
		try {
			const response = await this.send(path, options);
			return (await response.json()) as T;
		} catch (error) {
			if (
				options.allowNotFound &&
				error instanceof GitError &&
				error.code === "not_found"
			) {
				return null;
			}
			throw error;
		}
	}

	/** Same as `json`, for endpoints whose success body we ignore. */
	async send204(path: string, options: RequestOptions): Promise<void> {
		await this.send(path, options);
	}

	async bytes(path: string, options: RequestOptions): Promise<Uint8Array | null> {
		try {
			const response = await this.send(path, options);
			return new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			if (
				options.allowNotFound &&
				error instanceof GitError &&
				error.code === "not_found"
			) {
				return null;
			}
			throw error;
		}
	}

	async stream(path: string, options: RequestOptions): Promise<ReadableStream<Uint8Array>> {
		const response = await this.send(path, options);
		if (!response.body)
			throw new GitError("backend_error", `${path} returned an empty body`);
		return response.body;
	}

	/**
	 * Commit endpoints take NDJSON: a metadata line followed by base64 chunks.
	 * Returns the raw response so callers can read their own result shape.
	 */
	async ndjson<T>(path: string, repo: RepoRef, lines: unknown[]): Promise<T> {
		const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
		const response = await this.send(path, {
			repo,
			scopes: ["git:write"],
			method: "POST",
			contentType: "application/x-ndjson",
			body,
		});
		return (await response.json()) as T;
	}
}
