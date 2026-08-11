import type { PullRequest } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { HostedRepo } from "@/lib/repos/hosted-source";
import { writeRefusal } from "@/lib/repos/registry";

/**
 * Opening a pull request we own: the branches are resolved through the git
 * backend, the number comes from the counter Issues share, and the merge is
 * left for later — nothing here talks to GitHub.
 */

export interface PullAuthor {
	userId: string;
	login: string | null;
	name: string | null;
	avatarUrl: string | null;
}

export interface CreatePullInput {
	title: string;
	body?: string;
	head: string;
	base: string;
	draft?: boolean;
}

export type CreatePullResult =
	| { ok: true; pullRequest: PullRequest }
	| { ok: false; error: string };

/**
 * Issues stay upstream while pull requests are ours, so `#123` is only
 * unambiguous if one counter hands out both. Incrementing in the update makes
 * two people opening at once serialise on the row rather than collide on the
 * unique index.
 */
async function allocateNumber(repositoryId: string): Promise<number> {
	const { nextNumber } = await prisma.repository.update({
		where: { id: repositoryId },
		data: { nextNumber: { increment: 1 } },
		select: { nextNumber: true },
	});
	return nextNumber - 1;
}

export async function createHostedPull(
	h: HostedRepo,
	author: PullAuthor,
	input: CreatePullInput,
): Promise<CreatePullResult> {
	const title = input.title.trim();
	if (!title) return { ok: false, error: "A title is required" };
	if (input.head === input.base) {
		return { ok: false, error: "The head and base branches are the same" };
	}

	const refusal = await writeRefusal(h.record, author.userId);
	if (refusal) return { ok: false, error: refusal };

	const branches = await h.git.listBranches(h.ref);
	const head = branches.items.find((b) => b.name === input.head);
	const base = branches.items.find((b) => b.name === input.base);
	if (!head) return { ok: false, error: `Branch ${input.head} does not exist` };
	if (!base) return { ok: false, error: `Branch ${input.base} does not exist` };

	const existing = await prisma.pullRequest.findFirst({
		where: {
			repositoryId: h.record.id,
			state: "open",
			headBranch: input.head,
			baseBranch: input.base,
		},
	});
	if (existing) {
		return {
			ok: false,
			error: `Pull request #${existing.number} is already open for these branches`,
		};
	}

	// A pull request based on another's head branch is the next one up its
	// stack; sharing `stackId` makes the whole stack one query.
	const parent = await prisma.pullRequest.findFirst({
		where: { repositoryId: h.record.id, state: "open", headBranch: input.base },
	});

	const diff = await h.git.compare(h.ref, input.base, input.head).catch(() => null);

	const number = await allocateNumber(h.record.id);
	const pullRequest = await prisma.pullRequest.create({
		data: {
			repositoryId: h.record.id,
			number,
			title,
			bodyMd: input.body ?? "",
			draft: input.draft ?? false,
			headBranch: input.head,
			baseBranch: input.base,
			headSha: head.sha,
			baseSha: base.sha,
			additions: diff?.stats.additions ?? 0,
			deletions: diff?.stats.deletions ?? 0,
			changedFiles: diff?.stats.files ?? 0,
			parentId: parent?.id ?? null,
			stackId: parent ? (parent.stackId ?? parent.id) : null,
			authorId: author.userId,
			authorLogin: author.login,
			authorName: author.name,
			authorAvatarUrl: author.avatarUrl,
			events: {
				create: {
					kind: "opened",
					actorId: author.userId,
					actorLogin: author.login,
					payloadJson: JSON.stringify({
						headSha: head.sha,
						baseSha: base.sha,
					}),
				},
			},
		},
	});

	// The parent had no stack until this one arrived, so it joins the stack it
	// now roots.
	if (parent && !parent.stackId) {
		await prisma.pullRequest.update({
			where: { id: parent.id },
			data: { stackId: parent.id },
		});
	}

	return { ok: true, pullRequest };
}
