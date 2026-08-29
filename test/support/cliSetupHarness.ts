/**
 * Unit tests for the `hikoutei setup` CLI.
 *
 * Every test runs against the real production modules with injected fakes:
 * a recording gcloud runner, a fake tokeninfo validator, a fake human-token
 * sheet API, and a fake SA verifier — so nothing touches gcloud, the
 * network, or real Google resources. The fake runner simulates gcloud's
 * key-file side effect so the flow's chmod-600 step is exercised
 * realistically.
 */

/**
 * Shared fixture harness for the `hikoutei setup` CLI test split.
 *
 * Extracted verbatim from the module preamble of the original 9,179-line
 * `test/cli-setup.test.ts` (plus `export` keywords); the describes moved to
 * `test/cli-setup/args-env-auth.test.ts`, `test/cli-setup/runsetup-states.test.ts`,
 * and `test/cli-setup/interactive.test.ts`, which import everything from here.
 *
 * The mutable `fakeKeyCreated` flag, the scripted `freshSetupScript`, the
 * `createRecordingRunner`/`createHarness` factory, and the full verbatim
 * `afterEach` live in `test/cli-setup/runsetup-states.test.ts` instead: their
 * module-scope state (`fakeKeyCreated`) is reassigned directly by test bodies
 * there, and ESM imported bindings are read-only across modules under vitest's
 * SSR transform. Everything in this module is call-shared state or constants,
 * imported by at least two of the split files.
 */

import { afterEach, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedCommand, SetupResult } from "../../src/cli/setupFlow.js";
import type { GcloudRunResult } from "../../src/cli/gcloudRunner.js";

export const tempDirs: string[] = [];

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hikoutei-setup-test-"));
  tempDirs.push(dir);
  return dir;
}

export const FAKE_TOKEN = "ya29.fake-secret-access-token";

export const FAKE_OWNER = "owner@example.com";

export const SPREADSHEET_ID = "spreadsheet-123";

export const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;

/** Well-formed key marker (UUID v4) used in checkpoint fixtures. */
export const VALID_KEY_MARKER = "a0b1c2d3-e89b-42d3-a456-426614174000";

/** Non-secret `private_key_id` written into key fixtures. */
export const FIXED_KEY_ID = "f5e4d3c2b1a09876";

/** Valid key JSON for a project/email with the fixed non-secret key id. */
export function validKeyJson(projectId: string, saEmail: string, keyId: string = FIXED_KEY_ID): string {
  return JSON.stringify({
    type: "service_account",
    project_id: projectId,
    client_email: saEmail,
    private_key_id: keyId,
    private_key: RSA_PRIVATE_KEY_PEM,
  });
}

/** IAM resource name of a user-managed key for the fake keys list. */
export function keyResourceName(projectId: string, saEmail: string, keyId: string): string {
  return `projects/${projectId}/serviceAccounts/${saEmail}/keys/${keyId}`;
}

/** A real RSA PKCS#8 private key so key crypto prevalidation passes. */
export const RSA_PRIVATE_KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDzU9xBlhiQQZTc",
  "U9WUp4QrTIaAYrY1z7tLRHjSaShxXVdrnzy6v9b52BBAN8/MPkIvcdOc36v1GRVi",
  "PZQxO+mmkdoKnEgQgX4JRnmfJv2SAICb5cqCqxUncaYK4AM+toQK0h0sPBJt62Zs",
  "eVtufRZ5oGmvspj550LCRGY9X1NU2jD1CvzNNYF+4LaVnYhZ+nFmNVi1Y9uCpp8V",
  "Aj+HUmgYjeW+sIp59xYRac0yJfbXWa6uQ9FL3FZ6sWgRRUmmVH6olEIFBJoaoqxc",
  "BzNoqRdy1W88NiKYULC2J6z3XRmoHXAcCOh+AJcCT+sqs9kKo3JQFmxStng5GJT2",
  "RStIC0B7AgMBAAECggEAH4f78EHPgA4HiL+SWzeT8HpzqXphKzr2hcvjLjzzQTF7",
  "zRXu7DJE3M5rWK8CzfA5amWBKwBvC41LEJZzOCgP4IZg72QOEJl/KBuKUh3e2QcY",
  "o1sVMXaTALAA+MLLmNpU5QQSRLOqHbVV6fOV7gzmly860so9eZDGvV7YstZB+aol",
  "4eNPf4aA0gnMhg+ghZFUnn7jsg2Kx7Cfr+cFmfhdGugluOcdbyoRB7Ox3+8Dqaaj",
  "hqHTQL4rQe5QJWjlkyyqP/4smqgl4AHnFv1irOAH2APGBc/v1FMdcfvIskqB5Sdi",
  "L6lA0HORmzfs22I30BEsei21Iz86YZPjR7BpUbrt9QKBgQD9R7WOmH5LEBtuUi+a",
  "LGi1PvKRSmIYKKwIPPFEAmYMmX7ecPqH/7mWMVcHF3nLqMjHB68VVHKftqsznLtv",
  "Kmz+yqyOwSbdW4qH2qss/E2jXVZaTwRBxb87bD0/qFxPVKBP0r3PMeNlOCF7qiCJ",
  "gNXhex00HtL7IPro+KZRlTWqvQKBgQD18MpsekIm7/NAGTkR6Hutx6DDUfMpyinf",
  "ytOjiyJQNtcus1jiSkQBOzFOwl5JwhzvRN93HW1cgsZfRLaePROSmMGnwU3IUTHx",
  "cbchj3Bd8RBFNwypLvZEd5epGPLEhLxvESLurqi6/2pI4M8FQRhxVezOPz3ymjH+",
  "TBhkSE/nlwKBgGqtUE/t9IuDDjqqDPifqb5k89+z95r7TnHt0SR26ip2YBQqe6ra",
  "T31t7JzFC3x265HAr8KJHfodAwCrC9rngJ7UGFfMDKWBD9jmheBdqAmdn2hMDZvy",
  "QPgzP5zXOYIEP70/Isjo10Djol6mqiugAvWEWCmCrhQtsOB9Efgco0z1AoGBAOtO",
  "MW4uXwKAC10lhMvUghiXagHWc29lREEg/vJ3WSIkBidhYsZHRd9jsd5n6uxo82Qd",
  "oiyGFC8x0/gsdwjY6NQWoRoOwYvJ253lLdDHOzw2O1ntvIhWLTr+rTUVcJiDYwJl",
  "A+YXZ8paO2d0571gNbGiA0qliXCHBRQH3EJ+SS0LAoGBAJWK4S9E2+FVJvxCtKqM",
  "kIwF0dSxFZSHkGan67L8tF18RzrEcxaCyp0zxeXrzmBNsQS0K1R/O1p9K5uNSRvv",
  "eHeCyhop3p7u7u3275UQ2sZdszepulZkPRhX7AFT2XSvpypJMtg8NtH+8T35GQ73",
  "KD2qEH9Vvl0NOHREgI/Z9jb+",
  "-----END PRIVATE KEY-----",
].join("\n");

/** Adversarial secret payloads that must never reach CLI/result strings. */
export const SECRET_JWT =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0.eyJzdWIiOiJzYS0xQHByb2ouaWFtLmdzZXJ2aWNlYWNjb3VudC5jb20ifQ.signature";

export const SECRET_KEY_MATERIAL = `-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----`;

export const SECRET_AUTHORIZATION = "Authorization: Bearer ya29.secret-credential";

export function failed(status: number, stderr: string): GcloudRunResult {
  return { status: "failed", code: status, stdout: "", stderr };
}

export function expectError(result: SetupResult, code: string): void {
  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.code).toBe(code);
  }
}

export function gcloudCommands(commands: readonly PlannedCommand[]): readonly string[][] {
  return commands.filter((c) => c.kind === "gcloud").map((c) => [...c.command]);
}

/**
 * Temp-dir cleanup for every split test file. Inlined here because the
 * original full `afterEach` also resets `fakeKeyCreated`, which lives in
 * `test/cli-setup/runsetup-states.test.ts` (ESM imported bindings cannot be
 * reassigned across modules); that file carries the full verbatim hook.
 */
afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});
