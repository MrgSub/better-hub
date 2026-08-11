import { generateText } from "ai";
import { getInternalModel } from "@/lib/billing/ai-models.server";
import type { ConflictAgent, ResolveRequest, ResolvedFile } from "./resolve";
import type { ConflictFileData, MergeHunk } from "@/lib/three-way-merge";

/**
 * The agents that can propose a conflict resolution, and the limits every one
 * of them runs behind.
 *
 * Which agent answers is a configuration detail — the interface is the same
 * either way, and so is the verification that follows, so nothing downstream
 * has to know whether a model or a coding agent wrote the file. What does
 * belong here is the cost side of calling one: a ceiling so a thousand-file
 * conflict is refused before it is paid for, and a retry so a single flaky
 * response is not reported to the user as an unresolvable conflict.
 */

/** Past this a conflict is a merge someone has to think about, not a repair. */
export const MAX_CONFLICT_FILES = 25;
export const MAX_CONFLICT_BYTES = 256 * 1024;

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

const DEVIN_API_URL = "https://api.devin.ai/v1";
const DEVIN_POLL_MS = 10_000;
const DEVIN_TIMEOUT_MS = 15 * 60_000;

export function conflictSize(files: ConflictFileData[]): number {
	let bytes = 0;
	for (const file of files) {
		for (const hunk of file.hunks) {
			for (const lines of [hunk.baseLines, hunk.headLines, hunk.resolvedLines]) {
				for (const line of lines ?? []) bytes += line.length + 1;
			}
		}
	}
	return bytes;
}

/** Why this conflict must not be sent to an agent, or null when it may be. */
export function tooLargeToResolve(files: ConflictFileData[]): string | null {
	if (files.length > MAX_CONFLICT_FILES) {
		return `${files.length} conflicted files is too many to resolve automatically — resolve them locally`;
	}
	const bytes = conflictSize(files);
	if (bytes > MAX_CONFLICT_BYTES) {
		return `This conflict is ${Math.round(bytes / 1024)}KB, past the ${
			MAX_CONFLICT_BYTES / 1024
		}KB automatic limit — resolve it locally`;
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A dropped connection or an overloaded model is worth asking again; being
 * told the request itself is wrong is not, and retrying it only spends money.
 */
function isTransient(error: unknown): boolean {
	const message = (error as Error)?.message?.toLowerCase() ?? "";
	return (
		/timeout|timed out|econnreset|fetch failed|network|socket/.test(message) ||
		/\b(429|500|502|503|504)\b/.test(message) ||
		/rate limit|overloaded|unavailable/.test(message)
	);
}

/** Same agent, asked again when the failure was the connection rather than the answer. */
export function retrying(agent: ConflictAgent, attempts = RETRY_ATTEMPTS): ConflictAgent {
	return {
		name: agent.name,
		async resolve(request) {
			let last: unknown;
			for (let attempt = 1; attempt <= attempts; attempt++) {
				try {
					return await agent.resolve(request);
				} catch (error) {
					if (!isTransient(error) || attempt === attempts)
						throw error;
					last = error;
					await sleep(RETRY_DELAY_MS * attempt);
				}
			}
			throw last;
		},
	};
}

const CONFLICT_MARKER_PROMPT = `You resolve git merge conflicts.

Each conflict is given as a file with git conflict markers: <<<<<<< base is the
branch being merged into, ======= separates, >>>>>>> head is the pull request's
branch. Combine both intents — keep the base's changes and the pull request's
changes unless they are genuinely mutually exclusive, in which case prefer the
pull request's. Never keep a conflict marker, never leave a TODO, never
reformat or fix unrelated lines, and never drop code from either side that is
not actually in conflict.

Reply with the full resolved content of every file, each as:
--- FILE: <path>
<content>
--- END FILE`;

function hunkText(hunk: MergeHunk, baseBranch: string, headBranch: string): string {
	if (hunk.type === "clean") return (hunk.resolvedLines ?? []).join("\n");
	return [
		`<<<<<<< ${baseBranch}`,
		...(hunk.baseLines ?? []),
		"=======",
		...(hunk.headLines ?? []),
		`>>>>>>> ${headBranch}`,
	].join("\n");
}

function conflictText(file: ConflictFileData, baseBranch: string, headBranch: string): string {
	return file.hunks.map((hunk) => hunkText(hunk, baseBranch, headBranch)).join("\n");
}

/** The conflicts as one prompt body, in the fenced form both agents answer in. */
function conflictPrompt(request: ResolveRequest): string {
	return [
		`Pull request: ${request.title}`,
		request.body ? `Description:\n${request.body}` : "",
		`Merging ${request.headBranch} into ${request.baseBranch}.`,
		...request.files
			.filter((f) => f.hasConflicts)
			.map(
				(file) =>
					`--- FILE: ${file.path}\n${conflictText(
						file,
						request.baseBranch,
						request.headBranch,
					)}\n--- END FILE`,
			),
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Parses the fenced form the prompt asks for, ignoring anything else it says. */
export function parseFiles(text: string): ResolvedFile[] {
	const files: ResolvedFile[] = [];
	const pattern = /^--- FILE: (.+)$\n([\s\S]*?)^--- END FILE$/gm;
	for (const match of text.matchAll(pattern)) {
		const path = match[1].trim();
		if (path) files.push({ path, content: match[2].replace(/\n$/, "") });
	}
	return files;
}

/**
 * The default agent: the model the app already runs on, so resolution works
 * with the keys a user has configured rather than a second vendor.
 */
export const modelAgent: ConflictAgent = {
	name: "model",
	async resolve(request) {
		const { model } = await getInternalModel(request.userId);
		const { text } = await generateText({
			model,
			system: CONFLICT_MARKER_PROMPT,
			prompt: conflictPrompt(request),
		});
		return parseFiles(text);
	},
};

interface DevinSession {
	session_id: string;
}

interface DevinSessionState {
	status_enum?: string | null;
	structured_output?: { files?: { path?: string; content?: string }[] } | null;
	messages?: { message?: string }[] | null;
}

async function devinFetch<T>(path: string, key: string, body?: unknown): Promise<T> {
	const response = await fetch(`${DEVIN_API_URL}${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) {
		throw new Error(
			`Devin API ${response.status}: ${(await response.text()).slice(0, 200)}`,
		);
	}
	return (await response.json()) as T;
}

/**
 * Devin resolving the conflict in its own machine.
 *
 * It is given the same conflicted text and asked for the same fenced answer as
 * the model agent, so nothing about the verification changes; the difference is
 * that it can reason with tools before answering. The session is polled because
 * the API is asynchronous, and a run that never finishes is abandoned rather
 * than left holding the request open forever.
 */
export const devinAgent: ConflictAgent = {
	name: "devin",
	async resolve(request) {
		const key = process.env.DEVIN_API_KEY;
		if (!key) throw new Error("DEVIN_API_KEY is not set");

		const session = await devinFetch<DevinSession>("/sessions", key, {
			prompt: [
				CONFLICT_MARKER_PROMPT,
				conflictPrompt(request),
				"Return the resolved files in structured output as",
				'{"files": [{"path": "...", "content": "..."}]}.',
			].join("\n\n"),
			idempotent: true,
		});

		const deadline = Date.now() + DEVIN_TIMEOUT_MS;
		for (;;) {
			await sleep(DEVIN_POLL_MS);
			const state = await devinFetch<DevinSessionState>(
				`/session/${session.session_id}`,
				key,
			);
			const files = state.structured_output?.files;
			if (files?.length) {
				return files
					.filter(
						(f): f is { path: string; content: string } =>
							typeof f.path === "string" &&
							typeof f.content === "string",
					)
					.map((f) => ({ path: f.path, content: f.content }));
			}
			if (state.status_enum === "blocked" || state.status_enum === "finished") {
				// It stopped without structured output; the transcript may still
				// carry the fenced form the prompt asked for.
				const text = (state.messages ?? [])
					.map((m) => m.message ?? "")
					.join("\n");
				const parsed = parseFiles(text);
				if (parsed.length > 0) return parsed;
				throw new Error("Devin finished without proposing a resolution");
			}
			if (Date.now() > deadline) {
				throw new Error("Devin did not finish resolving in time");
			}
		}
	},
};

/**
 * Which agent this deployment resolves with. Agent-neutral by construction:
 * adding one is a case here plus an adapter above, and everything downstream —
 * validation, the clean-merge proof, the human approval — is unchanged.
 */
export function conflictAgent(name = process.env.CONFLICT_AGENT): ConflictAgent {
	switch (name) {
		case "devin":
			return retrying(devinAgent);
		default:
			return retrying(modelAgent);
	}
}
