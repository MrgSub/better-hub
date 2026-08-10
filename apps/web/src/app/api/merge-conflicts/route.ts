import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { getOctokit } from "@/lib/github";
import { type BlobReader, conflictFiles, hostedConflicts } from "@/lib/pulls/conflicts";
import { hostedRepo } from "@/lib/repos/hosted-source";
import { repositoryPermission } from "@/lib/repos/registry";
import { getErrorMessage } from "@/lib/utils";

interface GitHubFileContent {
	content: string;
	type: string;
}

export async function GET(request: NextRequest) {
	const { searchParams } = request.nextUrl;
	const owner = searchParams.get("owner");
	const repo = searchParams.get("repo");
	const base = searchParams.get("base");
	const head = searchParams.get("head");

	if (!owner || !repo || !base || !head) {
		return NextResponse.json(
			{ error: "Missing required parameters: owner, repo, base, head" },
			{ status: 400 },
		);
	}

	// A pull request we own resolves against the git backend: its branches may
	// not exist on GitHub at all.
	const hosted = await hostedRepo(owner, repo);
	if (hosted) {
		// Conflict data is file content from both branches, so it is gated the
		// same way resolving is: our own permissions, not GitHub's.
		const session = await getServerSession();
		const userId = session?.user?.id ?? null;
		if (!userId) {
			return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
		}
		const permission = await repositoryPermission(hosted.record, userId);
		if (permission !== "admin" && permission !== "write") {
			return NextResponse.json(
				{ error: "You do not have write access to this repository" },
				{ status: 403 },
			);
		}
		try {
			return NextResponse.json(await hostedConflicts(hosted, base, head));
		} catch (e: unknown) {
			return NextResponse.json(
				{
					error:
						getErrorMessage(e) ||
						"Failed to compute merge conflicts",
				},
				{ status: 500 },
			);
		}
	}

	const octokit = await getOctokit();
	if (!octokit) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const { data: comparison } = await octokit.repos.compareCommits({
			owner,
			repo,
			base,
			head,
		});

		const mergeBaseSha = comparison.merge_base_commit.sha;
		const baseSha = comparison.base_commit.sha;
		const headSha =
			comparison.commits.length > 0
				? comparison.commits[comparison.commits.length - 1].sha
				: mergeBaseSha;

		// For fork PRs, head content lives in the fork repo
		const isFork = head.includes(":");
		const headOwner = isFork ? head.split(":")[0] : owner;

		const read: BlobReader = async (path, ref) => {
			try {
				const { data } = await octokit.repos.getContent({
					owner: ref === headSha ? headOwner : owner,
					repo,
					path,
					ref,
				});
				if (Array.isArray(data) || data.type !== "file") return null;
				const fileContent = data as GitHubFileContent;
				return Buffer.from(fileContent.content, "base64").toString("utf-8");
			} catch {
				return null;
			}
		};

		return NextResponse.json({
			mergeBaseSha,
			baseBranch: base,
			headBranch: head,
			files: await conflictFiles(
				(comparison.files || []).map((f) => f.filename),
				read,
				{ mergeBase: mergeBaseSha, base: baseSha, head: headSha },
			),
		});
	} catch (e: unknown) {
		const msg = getErrorMessage(e) || "Failed to compute merge conflicts";
		const status =
			e &&
			typeof e === "object" &&
			"status" in e &&
			typeof (e as { status: unknown }).status === "number"
				? (e as { status: number }).status
				: 500;
		if (status === 404) {
			return NextResponse.json(
				{
					error: `Could not compare branches. The branch may not exist or you may not have access. If this is a fork PR, ensure the head branch is accessible.`,
				},
				{ status: 404 },
			);
		}
		return NextResponse.json({ error: msg }, { status });
	}
}
