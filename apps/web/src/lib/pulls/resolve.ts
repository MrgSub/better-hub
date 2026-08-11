import type { PullRequest } from "@/generated/prisma/client";
import { repositoryAgent } from "@/lib/agents/connection";
import { prisma } from "@/lib/db";
import { GitError, type CommitFileChange } from "@/lib/git/types";
import type { HostedRepo } from "@/lib/repos/hosted-source";
import { writeRefusal } from "@/lib/repos/registry";
import type { ConflictFileData } from "@/lib/three-way-merge";
import { conflictAgent, tooLargeToResolve } from "./agents";
import type { PullAuthor } from "./create";
import { hostedConflicts } from "./conflicts";
import { resolutionBranchName } from "./merge";

/**
 * Resolving a conflict without a human, safely.
 *
 * The agent never touches a ref: it is handed the conflicted hunks and answers
 * with file contents. Those go onto a throwaway `bh/resolve/<pr>-<sha>` branch
 * cut from the base, carrying the whole merged tree — the resolution for the
 * conflicted files and the pull request's own changes for the rest. That is what
 * makes the result landable: a commit on the head branch cannot settle a
 * conflict, because the merge base does not move and both sides still differ,
 * whereas a branch descended from the base fast-forwards.
 *
 * The proof is the backend's: `previewMerge` has to call the resolution branch
 * clean before it is recorded, and a resolution that does not merge is deleted
 * rather than trusted. Recorded is all it is — merging stays a separate human
 * click, which then lands the resolution branch instead of the head.
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
	| { ok: true; sha: string; branch: string; paths: string[]; agent: string }
	| { ok: false; error: string };

/**
 * A coding agent working in its own checkout (Devin, Cursor) plugs in here: it
 * only has to answer with file contents, and the verification below is what
 * makes trusting it safe.
 *
 * Which one answers is the repository owner's choice, and there is no default:
 * an organization that has connected nothing resolves nothing, because sending
 * their code to an agent is not a decision this deployment gets to make for
 * them.
 */
export async function resolveHostedConflicts(
	h: HostedRepo,
	actor: PullAuthor,
	number: number,
	agent?: ConflictAgent,
): Promise<ResolveResult> {
	const refusal = await writeRefusal(h.record, actor.userId);
	if (refusal) return { ok: false, error: refusal };

	const pull = await prisma.pullRequest.findFirst({
		where: { repositoryId: h.record.id, number },
	});
	if (!pull) return { ok: false, error: "Pull request not found" };
	if (pull.state !== "open") return { ok: false, error: "This pull request is not open" };

	const conflicts = await hostedConflicts(h, pull.baseBranch, pull.headBranch);
	const conflicted = conflicts.files.filter((f) => f.hasConflicts);
	if (conflicted.length === 0) return { ok: false, error: "There is nothing to resolve" };

	// Refused before an agent is paid for it: past a certain size the answer is
	// unlikely to be trustworthy anyway, and the bill is real either way.
	const tooLarge = tooLargeToResolve(conflicted);
	if (tooLarge) return { ok: false, error: tooLarge };

	if (!agent) {
		const connection = await repositoryAgent(h.record);
		if (!connection) {
			return {
				ok: false,
				error: `Automatic conflict resolution is off for ${h.record.owner} — an admin can connect Devin or Cursor in settings`,
			};
		}
		try {
			agent = conflictAgent(connection);
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

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
		baseSha: conflicts.baseSha,
		headSha: conflicts.headSha,
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
	const refusal = await writeRefusal(h.record, actor.userId);
	if (refusal) return { ok: false, error: refusal };

	const pull = await prisma.pullRequest.findFirst({
		where: { repositoryId: h.record.id, number },
	});
	if (!pull) return { ok: false, error: "Pull request not found" };
	if (pull.state !== "open") return { ok: false, error: "This pull request is not open" };

	const preview = await h.git.previewMerge(h.ref, pull.baseBranch, pull.headBranch);
	if (preview.status !== "conflicted") {
		return { ok: false, error: "There is nothing to resolve" };
	}
	const marked = resolved.filter((r) => /^(<{7}|={7}|>{7})/m.test(r.content));
	if (marked.length > 0) {
		return {
			ok: false,
			error: `${marked.map((m) => m.path).join(", ")} still contains conflict markers`,
		};
	}

	return land(h, actor, pull, resolved, {
		message,
		baseSha: preview.baseSha,
		headSha: preview.headSha,
	});
}

/**
 * The merged tree, as file operations: the resolution for the conflicted files,
 * and the pull request's own version of everything else it touched, since the
 * branch starts from the base and would otherwise drop those changes.
 */
async function mergedTree(
	h: HostedRepo,
	pull: PullRequest,
	resolved: ResolvedFile[],
): Promise<CommitFileChange[]> {
	const resolvedByPath = new Map(resolved.map((r) => [r.path, r.content]));
	const diff = await h.git.compare(h.ref, pull.baseBranch, pull.headBranch);
	const files: CommitFileChange[] = [];

	for (const file of diff.files) {
		const resolution = resolvedByPath.get(file.path);
		if (resolution !== undefined) {
			files.push({ path: file.path, content: resolution });
			continue;
		}
		if (file.status === "D") {
			files.push({ path: file.path, deleted: true });
			continue;
		}
		const blob = await h.git.getFileContent(h.ref, file.path, pull.headBranch);
		if (!blob || blob.binary) {
			throw new Error(`${file.path} cannot be resolved as text`);
		}
		files.push({ path: file.path, content: new TextDecoder().decode(blob.content) });
	}

	// A resolution for a path the diff does not mention would silently vanish.
	for (const [path, content] of resolvedByPath) {
		if (!files.some((f) => f.path === path)) files.push({ path, content });
	}
	return files;
}

/**
 * The backend refuses the commit when the base moved since the conflicts were
 * computed, and says so in its own vocabulary. Reloading is the only cure, so
 * say that instead of forwarding a ref comparison.
 */
function commitError(error: unknown): string {
	if (error instanceof GitError && error.code === "conflict") {
		return "The base branch moved — reload the conflicts and resolve again.";
	}
	return (error as Error).message;
}

async function land(
	h: HostedRepo,
	actor: PullAuthor,
	pull: PullRequest,
	resolved: ResolvedFile[],
	o: { agent?: string; message?: string; baseSha: string; headSha: string },
): Promise<ResolveResult> {
	const branch = resolutionBranchName(pull.number, o.headSha);
	const by = o.agent ?? "manual";

	let files: CommitFileChange[];
	try {
		files = await mergedTree(h, pull, resolved);
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}

	try {
		// Branches are cut from a ref name, not a sha, so the base tip the
		// resolution was computed against is enforced on the commit instead: a
		// base that moved under us refuses it rather than hiding in the branch.
		await h.git.deleteBranch(h.ref, branch).catch(() => {});
		await h.git.createBranch(h.ref, branch, pull.baseBranch);

		const commit = await h.git.commitFiles(h.ref, {
			branch,
			message:
				o.message ??
				`Resolve conflicts between ${pull.headBranch} and ${pull.baseBranch}` +
					`\n\nResolved by ${by} for #${pull.number}.`,
			author: {
				name: actor.name ?? actor.login ?? "better-hub",
				email: `${actor.login ?? "better-hub"}@users.noreply.better-hub.com`,
			},
			expectedHeadSha: o.baseSha,
			files,
		});

		const preview = await h.git.previewMerge(h.ref, pull.baseBranch, branch);
		if (preview.status === "conflicted") {
			await h.git.deleteBranch(h.ref, branch).catch(() => {});
			await recordFailure(
				pull,
				actor,
				by,
				preview.conflicts.map((c) => c.path),
			);
			return {
				ok: false,
				error: `The resolution still conflicts in ${preview.conflicts
					.map((c) => c.path)
					.join(", ")}`,
			};
		}

		await prisma.pullRequest.update({
			where: { id: pull.id },
			data: {
				resolutionBranch: branch,
				resolutionSha: commit.sha,
				resolutionBy: by,
				events: {
					create: {
						kind: "conflict_resolved",
						actorId: actor.userId,
						actorLogin: actor.login,
						payloadJson: JSON.stringify({
							agent: by,
							branch,
							sha: commit.sha,
							paths: resolved.map((r) => r.path),
						}),
					},
				},
			},
		});

		return {
			ok: true,
			sha: commit.sha,
			branch,
			paths: resolved.map((r) => r.path),
			agent: by,
		};
	} catch (error) {
		// Never leave a half-written resolution branch behind for a merge to find.
		await h.git.deleteBranch(h.ref, branch).catch(() => {});
		return { ok: false, error: commitError(error) };
	}
}

async function recordFailure(
	pull: PullRequest,
	actor: PullAuthor,
	by: string,
	remaining: string[],
): Promise<void> {
	await prisma.pullRequestEvent.create({
		data: {
			pullRequestId: pull.id,
			kind: "conflicted",
			actorId: actor.userId,
			actorLogin: actor.login,
			payloadJson: JSON.stringify({ agent: by, remaining }),
		},
	});
}
