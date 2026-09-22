/** Truthy: "1", "true", "yes" (case-insensitive). Everything else, including unset, is off. */
export const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG ?? '');

export function debugLog(jobId: string, label: string, data?: unknown): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  if (data === undefined) {
    console.log(`[${ts}] [${jobId}] [debug] ${label}`);
    return;
  }
  const rendered = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  console.log(`[${ts}] [${jobId}] [debug] ${label}:\n${rendered}`);
}
