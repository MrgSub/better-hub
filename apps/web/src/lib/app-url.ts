const DEFAULT_APP_URL = "https://orkd.ai";
const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

export const APP_URL = configuredAppUrl || DEFAULT_APP_URL;
export const HAS_CONFIGURED_APP_URL = Boolean(configuredAppUrl);
