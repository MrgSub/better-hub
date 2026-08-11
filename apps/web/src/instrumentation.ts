import * as Sentry from "@sentry/nextjs";
import { installGithubEmulator } from "./lib/github-emulator";

export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		installGithubEmulator();
		await import("../sentry.server.config");
	}

	if (process.env.NEXT_RUNTIME === "edge") {
		await import("../sentry.edge.config");
	}
}

export const onRequestError = Sentry.captureRequestError;
