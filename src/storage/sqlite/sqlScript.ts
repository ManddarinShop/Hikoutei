import type { SqlExecutor } from "../../adapter/persistence/contracts/sql.js";
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";

/** Executes a SQLite SQL script statement-by-statement through the active executor. */
export async function executeSqlScript(executor: SqlExecutor, script: string): Promise<void> {
  for (const statement of splitSqlStatements(script)) {
    await executor.run(statement);
  }
}

/**
 * Splits a SQLite script without treating semicolons inside quoted values or
 * comments as statement boundaries.
 */
export function splitSqlStatements(script: string): readonly string[] {
  const statements: string[] = [];
  let statementStart = 0;
  let state: SqlScriptState = "code";

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    const nextCharacter = script[index + 1];

    if (state === "single_quote") {
      if (character === "'" && nextCharacter === "'") {
        index += 1;
      } else if (character === "'") {
        state = "code";
      }
      continue;
    }

    if (state === "double_quote") {
      if (character === '"' && nextCharacter === '"') {
        index += 1;
      } else if (character === '"') {
        state = "code";
      }
      continue;
    }

    if (state === "backtick") {
      if (character === "`" && nextCharacter === "`") {
        index += 1;
      } else if (character === "`") {
        state = "code";
      }
      continue;
    }

    if (state === "bracket_identifier") {
      if (character === "]") {
        state = "code";
      }
      continue;
    }

    if (state === "line_comment") {
      if (character === "\n") {
        state = "code";
      }
      continue;
    }

    if (state === "block_comment") {
      if (character === "*" && nextCharacter === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }

    if (character === "'") {
      state = "single_quote";
      continue;
    }
    if (character === '"') {
      state = "double_quote";
      continue;
    }
    if (character === "`") {
      state = "backtick";
      continue;
    }
    if (character === "[") {
      state = "bracket_identifier";
      continue;
    }
    if (character === "-" && nextCharacter === "-") {
      state = "line_comment";
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      state = "block_comment";
      index += 1;
      continue;
    }
    if (character === ";") {
      appendStatement(statements, script.slice(statementStart, index));
      statementStart = index + 1;
    }
  }

  if (state !== "code" && state !== "line_comment") {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SQL_SCRIPT,
      `SQLite SQL script ended inside ${describeUnterminatedState(state)}.`,
    );
  }

  appendStatement(statements, script.slice(statementStart));
  return statements;
}

type SqlScriptState =
  | "code"
  | "single_quote"
  | "double_quote"
  | "backtick"
  | "bracket_identifier"
  | "line_comment"
  | "block_comment";

function appendStatement(statements: string[], value: string): void {
  const statement = value.trim();
  if (statement.length > 0) {
    statements.push(statement);
  }
}

function describeUnterminatedState(state: Exclude<SqlScriptState, "code" | "line_comment">): string {
  switch (state) {
    case "single_quote":
      return "a single-quoted value";
    case "double_quote":
      return "a double-quoted identifier";
    case "backtick":
      return "a backtick-quoted identifier";
    case "bracket_identifier":
      return "a bracket-quoted identifier";
    case "block_comment":
      return "a block comment";
  }
}
