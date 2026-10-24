/**
 * What the app can do about an error: `not_configured` (the provider's app keys are missing),
 * `not_connected`, `reconnect` (the sign-in expired or was revoked), `missing_permission` (the
 * user did not allow something the call needs), or `platform` (anything else the platform refused).
 */
export type PublishErrorCode = "not_configured" | "not_connected" | "reconnect" | "missing_permission" | "platform";

export class PublishError extends Error {
  readonly code: PublishErrorCode;

  constructor(code: PublishErrorCode, message: string) {
    super(message);
    this.name = "PublishError";
    this.code = code;
  }
}

export function permissionMessage(who: string, missing: string[]): string {
  return `${who} needs ${missing.join(", ")}. Connect again and allow ${missing.length === 1 ? "it" : "them"}.`;
}

/** Throws when the user did not grant every permission in `required`. */
export function requirePermissions(provider: string, required: string[], granted: string[]): void {
  const missing = required.filter((p) => !granted.includes(p));
  if (missing.length) throw new PublishError("missing_permission", permissionMessage(provider, missing));
}

/**
 * Runs a read that needs an optional permission, and stops it quietly when the platform
 * refuses for lack of one.
 */
export async function ifPermitted(read: () => Promise<void>): Promise<void> {
  try {
    await read();
  } catch (err) {
    if (!(err instanceof PublishError && err.code === "missing_permission")) throw err;
  }
}
