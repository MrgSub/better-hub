import type { Repository } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { HostedRepo } from "./hosted-source";
import { findRepository, repositoryPermission } from "./registry";

/**
 * Settings of a repository we host.
 *
 * They are ours, not GitHub's: the row is the source of truth the pages read,
 * so editing them needs no GitHub call and keeps working while GitHub is down.
 * Only the settings that mean something here exist — issues still live
 * upstream, and which merge strategies are offered is what the backend can
 * really do rather than a preference.
 *
 * A rename moves display coordinates only. The backend named the repository at
 * creation time and is addressed by `gitRepoId` ever since, so `owner`/`name`
 * can move underneath it without touching a ref.
 */

export interface HostedSettingsPatch {
	name?: string;
	description?: string | null;
	homepage?: string | null;
	isPrivate?: boolean;
	topics?: string[];
	defaultBranch?: string;
	archived?: boolean;
}

export type HostedSettingsResult = { ok: true; record: Repository } | { ok: false; error: string };

/** GitHub's own repository-name character set, so imports round-trip. */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;

async function adminOf(h: HostedRepo, userId: string | null): Promise<boolean> {
	return (await repositoryPermission(h.record, userId)) === "admin";
}

async function validate(h: HostedRepo, patch: HostedSettingsPatch): Promise<string | null> {
	if (patch.name !== undefined && patch.name !== h.record.name) {
		if (!REPOSITORY_NAME.test(patch.name)) {
			return "A repository name may only contain letters, numbers, ., - and _";
		}
		if (await findRepository(h.record.owner, patch.name)) {
			return `${h.record.owner}/${patch.name} already exists`;
		}
	}

	if (patch.defaultBranch !== undefined && patch.defaultBranch !== h.record.defaultBranch) {
		const branches = await h.git.listBranches(h.ref);
		if (!branches.items.some((b) => b.name === patch.defaultBranch)) {
			return `Branch ${patch.defaultBranch} no longer exists`;
		}
	}

	return null;
}

export async function updateHostedRepository(
	h: HostedRepo,
	userId: string | null,
	patch: HostedSettingsPatch,
): Promise<HostedSettingsResult> {
	if (!(await adminOf(h, userId))) {
		return { ok: false, error: "You need admin access to change these settings" };
	}

	// An archived repository is read-only, so the only edit it accepts is the
	// one that lifts that — which we can do ourselves, unlike GitHub.
	const unarchiving = patch.archived === false;
	if (h.record.archived && !unarchiving) {
		return { ok: false, error: "This repository is archived" };
	}

	const invalid = await validate(h, patch);
	if (invalid) return { ok: false, error: invalid };

	return {
		ok: true,
		record: await prisma.repository.update({ where: { id: h.record.id }, data: patch }),
	};
}

/**
 * Deletes the repository and its git data. Irreversible.
 *
 * The row goes first and the backend after, because the two failures are not
 * equally bad: git data nobody references is storage to reclaim, while refs
 * deleted under a surviving row would be a repository whose every page throws.
 */
export async function deleteHostedRepository(
	h: HostedRepo,
	userId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!(await adminOf(h, userId))) {
		return { ok: false, error: "You need admin access to delete this repository" };
	}

	await prisma.repository.delete({ where: { id: h.record.id } });
	await h.git.deleteRepo(h.ref).catch(() => {});
	return { ok: true };
}
