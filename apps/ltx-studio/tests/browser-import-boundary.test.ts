import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "..");
const scriptExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);

function runtimeImportDeclaration(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings?.elements.some((element) => !element.isTypeOnly) ?? false;
}

function runtimeExportDeclaration(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false;
  if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) return true;
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

function runtimeModuleSpecifiers(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ESNext,
    true,
    extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)
      && runtimeImportDeclaration(statement)
      && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(statement)
      && runtimeExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(statement)
      && !statement.isTypeOnly
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && ts.isStringLiteralLike(statement.moduleReference.expression)) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]!)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        specifiers.push(node.arguments[0]!.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return [...new Set(specifiers)];
}

function localModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = resolve(dirname(importer), specifier);
  const extension = extname(unresolved);
  const withoutJsExtension = extension === ".js" || extension === ".mjs" || extension === ".jsx"
    ? unresolved.slice(0, -extension.length)
    : unresolved;
  const candidates = [
    unresolved,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    `${withoutJsExtension}.mts`,
    `${withoutJsExtension}.js`,
    `${withoutJsExtension}.mjs`,
    resolve(unresolved, "index.ts"),
    resolve(unresolved, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function browserRuntimeGraph(entries: readonly string[]): {
  visited: Set<string>;
  violations: string[];
} {
  const pending = [...entries];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const specifier of runtimeModuleSpecifiers(current)) {
      const importer = relative(appRoot, current);
      if (specifier.startsWith("node:")) {
        violations.push(`${importer} imports ${specifier}`);
        continue;
      }
      const resolved = localModule(current, specifier);
      if (!resolved) continue;
      const relativePath = relative(appRoot, resolved);
      if (relativePath.split(sep).includes("scripts")) {
        violations.push(`${importer} reaches ${relativePath}`);
        continue;
      }
      if (scriptExtensions.has(extname(resolved))) pending.push(resolved);
    }
  }
  return { visited, violations };
}

describe("browser import boundary", () => {
  it("keeps the public T2A and complete client runtime graph away from Node and scripts", () => {
    const graph = browserRuntimeGraph([
      resolve(appRoot, "shared/t2aAudioPublic.ts"),
      resolve(appRoot, "src/main.tsx"),
    ]);
    const visited = [...graph.visited].map((path) => relative(appRoot, path));

    expect(graph.violations).toEqual([]);
    expect(visited).toContain("shared/t2aAudioBaseContracts.ts");
    expect(visited).not.toContain("shared/t2aAudioQuality.ts");
  });
});
