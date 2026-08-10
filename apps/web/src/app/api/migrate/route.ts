import { getServerSession } from "@/lib/auth";
import { GitError } from "@/lib/git/types";
import {
	grantAccessUrl,
	migrateRepository,
	parseRepoInput,
	planImport,
	resolveUpstream,
} from "@/lib/migrate";

async function actor() {
	const session = await getServerSession();
	const token = session?.githubUser?.accessToken;
	const login = session?.githubUser?.login;
	const userId = session?.user?.id;
	if (!token || typeof login !== "string" || !userId) return null;
	return { token, login, userId };
}

/** Resolves a pasted repository reference against the user's own GitHub access. */
export async function GET(request: Request) {
	const credentials = await actor();
	if (!credentials) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const input = new URL(request.url).searchParams.get("repo") ?? "";
	const target = parseRepoInput(input);
	if (!target) {
		return Response.json(
			{ error: "Enter a repository as owner/name or a GitHub URL" },
			{ status: 400 },
		);
	}

	const upstream = await resolveUpstream(credentials.token, target);
	if (!upstream) {
		return Response.json({
			needsAccess: true,
			target,
			grantUrl: grantAccessUrl(),
		});
	}

	// Told up front, so the confirm step can say whose namespace this lands in
	// and whether it will be a fork rather than surprising the user afterwards.
	const plan = await planImport(upstream, credentials.login);
	return Response.json({ needsAccess: false, upstream, plan });
}

export async function POST(request: Request) {
	const credentials = await actor();
	if (!credentials) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const body = (await request.json()) as {
		repo?: string;
		name?: string;
		defaultBranch?: string;
	};
	const target = parseRepoInput(body.repo ?? "");
	if (!target) return Response.json({ error: "Invalid repository" }, { status: 400 });

	const upstream = await resolveUpstream(credentials.token, target);
	if (!upstream) {
		return Response.json(
			{ needsAccess: true, target, grantUrl: grantAccessUrl() },
			{ status: 403 },
		);
	}

	try {
		const result = await migrateRepository({
			upstream,
			actor: credentials,
			name: body.name?.trim() || upstream.name,
			defaultBranch: body.defaultBranch?.trim() || upstream.defaultBranch,
		});
		return Response.json(result);
	} catch (error) {
		// A conflict is about the user's own input; anything else is a backend
		// or configuration failure whose message would leak our internals.
		if (error instanceof GitError) {
			if (error.code === "conflict") {
				return Response.json({ error: error.message }, { status: 409 });
			}
			console.error("migration failed", error);
			return Response.json(
				{ error: "Migration failed. Please try again." },
				{ status: 502 },
			);
		}
		throw error;
	}
}
