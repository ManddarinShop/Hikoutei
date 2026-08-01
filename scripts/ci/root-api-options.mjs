import os from "node:os";
import path from "node:path";

/**
 * Parse the installed root API smoke CLI options.
 *
 * Supported options:
 *
 *   --output=<path>   or   --output <path>
 *   --summary=<path>  or   --summary <path>
 *
 * `--output` defaults to `$HIKOUTEI_CI_OUTPUT` (or a temp path when that is
 * unset); `--summary` defaults to `$GITHUB_STEP_SUMMARY` (or `undefined`
 * outside GitHub Actions). Splitting happens only at the first `=`, so a value
 * that itself contains `=` (for example a signed URL or base64 token) survives
 * intact.
 *
 * In the bare `--key <value>` form, a following argument that is itself another
 * option (starts with `--`) is treated as a missing value rather than a literal
 * value: `--output --summary=foo` is rejected instead of silently swallowing
 * `--summary=foo` as the output path.
 *
 * @param {readonly string[]} argv - arguments after the script path
 * @returns {{ output: string, summary: string | undefined }}
 */
export function parseRootApiOptions(argv) {
  const options = {
    output: process.env.HIKOUTEI_CI_OUTPUT,
    summary: process.env.GITHUB_STEP_SUMMARY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // Split only at the first `=` so a value containing `=` survives intact.
    const equalsIndex = argument.indexOf("=");
    let key;
    let value;
    if (equalsIndex < 0) {
      key = argument;
      value = argv[index + 1];
      // A bare option consumes the next argument as its value, but only when
      // that argument is present and is not itself another option. A following
      // `--option`, an empty value, or no following argument at all is a
      // missing-value error so a typo such as `--output --summary=foo` fails
      // loudly instead of swallowing the next option as a literal value.
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`option ${key} requires a non-empty value`);
      }
      index += 1;
    } else {
      key = argument.slice(0, equalsIndex);
      value = argument.slice(equalsIndex + 1);
      if (value === "") {
        throw new Error(`option ${key} requires a non-empty value`);
      }
    }
    if (key === "--output") options.output = value;
    else if (key === "--summary") options.summary = value;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.output === undefined) {
    options.output = path.join(os.tmpdir(), "hikoutei-root-api-smoke-result.json");
  }
  return options;
}
