import { headers } from "next/headers";
import { cache } from "react";
import { auth } from "@/lib/auth";

/**
 * Who is asking, as far as our own tables are concerned.
 *
 * Deliberately narrower than `getServerSession`: that one also resolves a
 * GitHub access token, which a read served entirely from our backend has no
 * use for. Cached per request because every hosted read asks.
 */
export const viewerId = cache(async (): Promise<string | null> => {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		return session?.user?.id ?? null;
	} catch {
		return null;
	}
});
