import { getServerSession } from "@/lib/auth";
import type { PullAuthor } from "./create";

/**
 * Who is acting on a pull request we own. Identity is ours — the session — not
 * GitHub's, because the record is ours and the action must work when GitHub is
 * unreachable. The GitHub login is carried along only for display.
 */
export async function hostedPullActor(): Promise<PullAuthor | null> {
	const session = await getServerSession();
	const userId = session?.user?.id;
	if (!userId) return null;
	return {
		userId,
		login: (session.githubUser?.login as string | undefined) ?? null,
		name: session.user.name ?? null,
		avatarUrl:
			(session.githubUser?.avatar_url as string | undefined) ??
			session.user.image ??
			null,
	};
}
