import { generateText } from "ai";
import type { PullRequest } from "@/generated/prisma/client";
import { getInternalModel } from "@/lib/billing/ai-models.server";
import { prisma } from "@/lib/db";
import type { HostedRepo } from "@/lib/repos/hosted-source";
import { repositoryPermission } from "@/lib/repos/registry";
import type { ConflictFileData, MergeHunk } from "@/lib/three-way-merge";
import type { PullAuthor } from "./create";
import { hostedConflicts } from "./conflicts";

/**
 * Resolving a conflict without a human, safely.
 *
 * The agent never touches a ref: it is handed the conflicted hunks and returns
 * file contents, which are committed to the head branch through `GitProvider`
 * exactly like the manual resolver's output — the merge itself stays a separate,
 * human click, and the resulting commit is a normal reviewable one on the pull
 * request rather than a rewrite of anyone's history. Whatever it produces is
 * re-checked with `previewMerge` before we call the conflict resolved, so a
 * plausible-looking answer that does not actually merge is refused instead of
 * trusted.
 */

export interface ResolvedFile {
	path: string;
	content: string;
}

/** A backend that can propose contents for conflicted files. */
export interface ConflictAgent {
	readonly name: string;
	resolve(request: ResolveRequest): Promise<ResolvedFile[]>;
}

export interface ResolveRequest {
	/** Why the change exists, which is what disambiguates most conflicts. */
	title: string;
	body: string;
	baseBranch: string;
	headBranch: string;
	files: ConflictFileData[];
	/** Whose model keys pay for the run. */
	userId: string;
}

export type ResolveResult =
	| { ok: true; sha: string | null; paths: string[]; agent: string }
	| { ok: false; error: string };

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

function conflictText(file: ConflictFileData, baseBranch: string, headBranch: string): string {
	return file.hunks.map((hunk) => hunkText(hunk, baseBranch, headBranch)).join("\n");
}

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

/** Parses the fenced form the prompt asks for, ignoring anything else it says. */
function parseFiles(text: string): ResolvedFile[] {
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
		const conflicted = request.files.filter((f) => f.hasConflicts);
		const { text } = await generateText({
			model,
			system: CONFLICT_MARKER_PROMPT,
			prompt: [
				`Pull request: ${request.title}`,
				request.body ? `Description:\n${request.body}` : "",
				`Merging ${request.headBranch} into ${request.baseBranch}.`,
				...conflicted.map(
					(file) =>
						`--- FILE: ${file.path}\n${conflictText(
							file,
							request.baseBranch,
							request.headBranch,
						)}\n--- END FILE`,
				),
			]
				.filter(Boolean)
				.join("\n\n"),
		});
		return parseFiles(text);
	},
};

/**
 * A coding agent working in its own checkout (Devin, Cursor) plugs in here: it
 * only has to answer with file contents, and the verification below is what
 * makes trusting it safe.
 */
export async function resolveHostedConflicts(
	h: HostedRepo,
	actor: PullAuthor,
	number: number,
	agent: ConflictAgent = modelAgent,
): Promise<ResolveResult> {
	const permission = await repositoryPermission(h.record, actor.userId);
	if (permission !== "admin" && permission !== "write") {
		return { ok: false, error: "You do not have write access to this repository" };
	}

	const pull = await prisma.pullRequest.findFirst({
		where: { repositoryId: h.record.id, number },
	});
	if (!pull) return { ok: false, error: "Pull request not found" };
	if (pull.state !== "open") return { ok: false, error: "This pull request is not open" };

	const conflicts = await hostedConflicts(h, pull.baseBranch, pull.headBranch);
	const conflicted = conflicts.files.filter((f) => f.hasConflicts);
	if (conflicted.length === 0) return { ok: false, error: "There is nothing to resolve" };

	let resolved: ResolvedFile[];
	try {
		resolved = await agent.resolve({
			title: pull.title,
			body: pull.bodyMd,
			baseBranch: pull.baseBranch,
			headBranch: pull.headBranch,
			files: conflicted,
			userId: actor.userId,
		});
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}

	// A resolution that skips a file, invents one, or leaves a marker behind is
	// not a resolution.
	const expected = new Set(conflicted.map((f) => f.path));
	const missing = [...expected].filter((p) => !resolved.some((r) => r.path === p));
	if (missing.length > 0) {
		return { ok: false, error: `${agent.name} left ${missing.join(", ")} unresolved` };
	}
	const stray = resolved.filter((r) => !expected.has(r.path));
	if (stray.length > 0) {
		return {
			ok: false,
			error: `${agent.name} changed files that were not in conflict: ${stray
				.map((s) => s.path)
				.join(", ")}`,
		};
	}
	const marked = resolved.filter((r) => /^(<{7}|={7}|>{7})/m.test(r.content));
	if (marked.length > 0) {
		return { ok: false, error: `${agent.name} left conflict markers behind` };
	}

	return land(h, actor, pull, resolved, {
		agent: agent.name,
		expectedHeadSha: conflicts.headSha,
	});
}

/**
 * Lands the manual resolver's output on a pull request we own, the same way an
 * agent's lands: through `GitProvider`, then verified.
 */
export async function commitHostedResolution(
	h: HostedRepo,
	actor: PullAuthor,
	number: number,
	resolved: ResolvedFile[],
	message?: string,
): Promise<ResolveResult> {
	const permission = await repositoryPermission(h.record, actor.userId);
	if (permission !== "admin" && permission !== "write") {
		return { ok: false, error: "You do not have write access to this repository" };
	}

	const pull = await prisma.pullRequest.findFirst({
		where: { repositoryId: h.record.id, number },
	});
	if (!pull) return { ok: false, error: "Pull request not found" };
	if (pull.state !== "open") return { ok: false, error: "This pull request is not open" };

	return land(h, actor, pull, resolved, { message });
}

async function land(
	h: HostedRepo,
	actor: PullAuthor,
	pull: PullRequest,
	resolved: ResolvedFile[],
	o: { agent?: string; message?: string; expectedHeadSha?: string },
): Promise<ResolveResult> {
	// Guarding on the tip the resolution was computed from: a push landing while
	// it was produced would otherwise be silently overwritten.
	const commit = await h.git.commitFiles(h.ref, {
		branch: pull.headBranch,
		message:
			o.message ??
			`Resolve conflicts with ${pull.baseBranch}${
				o.agent ? `\n\nResolved by ${o.agent} for #${pull.number}.` : ""
			}`,
		author: {
			name: actor.name ?? actor.login ?? "better-hub",
			email: `${actor.login ?? "better-hub"}@users.noreply.better-hub.com`,
		},
		expectedHeadSha: o.expectedHeadSha,
		files: resolved.map((file) => ({ path: file.path, content: file.content })),
	});

	// The proof is the backend's, not the resolver's: if it still does not merge,
	// the pull request stays conflicted and says so.
	const preview = await h.git.previewMerge(h.ref, pull.baseBranch, pull.headBranch);
	const settled = preview.status !== "conflicted";
	const by = o.agent ?? "The resolution";

	await prisma.pullRequest.update({
		where: { id: pull.id },
		data: {
			headSha: commit.sha,
			events: {
				create: {
					kind: settled ? "conflict_resolved" : "conflicted",
					actorId: actor.userId,
					actorLogin: actor.login,
					payloadJson: JSON.stringify({
						...(o.agent ? { agent: o.agent } : {}),
						sha: commit.sha,
						paths: resolved.map((r) => r.path),
						...(settled
							? {}
							: {
									remaining: preview.conflicts.map(
										(c) => c.path,
									),
								}),
					}),
				},
			},
		},
	});

	if (!settled) {
		return {
			ok: false,
			error: `${by} still conflicts in ${preview.conflicts
				.map((c) => c.path)
				.join(", ")}`,
		};
	}

	return {
		ok: true,
		sha: commit.sha,
		paths: resolved.map((r) => r.path),
		agent: o.agent ?? "manual",
	};
}
