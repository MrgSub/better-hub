import { NextResponse } from "next/server";
import {
	parseCodeStorageEvent,
	readWebhookSecret,
	verifyCodeStorageSignature,
} from "@/lib/git/code-storage/webhook";
import { recordMirrorPush, recordMirrorSync } from "@/lib/repos/mirror";

/**
 * What the git backend tells us about our own repositories.
 *
 * The delivery is the only report we get on a mirror: the backend forwards our
 * refs to the GitHub upstream on its own, so whether that worked arrives here or
 * nowhere. It is also the only report on a push that did not come through the
 * app, since the remotes we mint are usable directly.
 *
 * The body is signed, and the signature covers a timestamp we bound, so an
 * unsigned or replayed delivery is refused before anything is looked up.
 */
export async function POST(request: Request) {
	const rawBody = await request.text();
	const verified = await verifyCodeStorageSignature({
		header: request.headers.get("x-pierre-signature"),
		rawBody,
		secret: readWebhookSecret(),
	});
	if (!verified) {
		return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
	}

	const event = parseCodeStorageEvent(request.headers.get("x-pierre-event") ?? "", body);
	// An event we do not act on is still a delivery we accepted: answering
	// anything else makes the backend retry it.
	if (!event) return NextResponse.json({ ok: true, handled: false });

	if (event.type === "push") {
		await recordMirrorPush(event.gitRepoId, event.at);
	} else {
		await recordMirrorSync(event);
	}

	return NextResponse.json({ ok: true, handled: true });
}
