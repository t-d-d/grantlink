import { join } from "node:path";
import ts from "typescript";
import { root } from "./repo.ts";

// How the parameters of an exported step helper differ from the callback
// positions STEP_HELPERS lists for it (#411). Position 0 is the context. A
// parameter is function-typed when the type checker gives its type, or one
// member of its union, a call signature, so an alias such as
// `type Log = () => void` counts. A parameter whose type does not resolve is
// reported, since the check cannot tell what it is. A parameter whose type,
// or one member of its union, is an array or a tuple that holds a function is
// reported whether or not it is listed, since the table lists single
// positions and cannot describe it. A rest parameter's type is such an array,
// so a rest parameter of functions is reported the same way, even in the
// context's place (#480, #498). The source is checked as if it sat at `path`
// in the repo, under the repo's tsconfig.json, so its relative and package
// imports resolve as they do for the real module.
export function callbackMismatches(
  source: string,
  name: string,
  callbacks: readonly number[],
  path = "test/step-helper-under-check.ts",
): string[] {
  const fileName = join(root, path).replaceAll("\\", "/");
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (file, language, ...rest) => {
    if (file === fileName)
      return ts.createSourceFile(file, source, language, true);
    let parsed = parsedFiles.get(file);
    if (!parsed) {
      parsed = getSourceFile(file, language, ...rest);
      if (parsed) parsedFiles.set(file, parsed);
    }
    return parsed;
  };
  host.readFile = (file) => (file === fileName ? source : readFile(file));
  host.fileExists = (file) => file === fileName || fileExists(file);

  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(fileName);
  const exported = file && checker.getSymbolAtLocation(file);
  const symbol =
    exported && checker.tryGetMemberInModuleExports(name, exported);
  const fn = symbol && exportedFunction(checker, symbol);
  if (!fn) return [`${name} is not an exported function`];

  const problems = callbacks
    .filter((position) => !fn.parameters[position])
    .map((position) => `${name} has no parameter ${String(position)}`);
  fn.parameters.forEach((parameter, position) => {
    const listed = callbacks.includes(position);
    const rest = parameter.dotDotDotToken !== undefined;
    if (position === 0 && !listed && !rest) return;
    const label = `${name}'s parameter ${String(position)} (${parameter.name.getText()})`;
    const kind = kindOf(checker, checker.getTypeAtLocation(parameter));
    if (kind === "functions")
      problems.push(
        `${label} is ${rest ? "a rest parameter" : "an array"} of functions, which the table cannot list`,
      );
    else if (kind === "unread")
      problems.push(`${label} has a type the check cannot read`);
    else if (listed && kind === "other")
      problems.push(`${label} is not a function`);
    else if (!listed && kind === "function")
      problems.push(`${label} is a function the table does not list`);
  });
  return problems;
}

// The repo's compiler options, read once. Every program shares them, so the
// lib and package files one program parses serve the next (parsedFiles).
let options: ts.CompilerOptions | undefined;
function compilerOptions(): ts.CompilerOptions {
  if (options) return options;
  const fail = (diagnostic: ts.Diagnostic): never => {
    throw new Error(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(root, "tsconfig.json"),
    undefined,
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: fail },
  );
  if (!parsed) throw new Error("tsconfig.json did not parse");
  options = parsed.options;
  return options;
}

// Source files parsed from disk, keyed by path. Only a file read from disk is
// kept, never the source under check.
const parsedFiles = new Map<string, ts.SourceFile>();

// The function an export names: a function declaration, the implementation
// of an overloaded one, or a const whose value is an arrow function or a
// function expression.
function exportedFunction(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): ts.SignatureDeclaration | undefined {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declarations = target.declarations ?? [];
  const functions = declarations.filter((declaration) =>
    ts.isFunctionDeclaration(declaration),
  );
  if (functions.length > 0)
    return (
      functions.find((declaration) => declaration.body !== undefined) ??
      functions[0]
    );
  for (const declaration of declarations) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    )
      return declaration.initializer;
  }
  return undefined;
}

// Whether a parameter's type is a function, an array or tuple that holds a
// function, another type, or one the checker could not resolve, which it
// reads as `any`. A type parameter is read by its constraint. An array or
// tuple is read by its elements, so one whose elements do not resolve is
// unread too. A union that may be a function reads as one, even when
// another member does not resolve. `reading` holds the types already being
// read, so a recursive type such as `type Json = string | Json[]` ends
// instead of looping.
function kindOf(
  checker: ts.TypeChecker,
  type: ts.Type,
  reading = new Set<ts.Type>(),
): "function" | "functions" | "other" | "unread" {
  if (type.flags & ts.TypeFlags.TypeParameter)
    type = checker.getBaseConstraintOfType(type) ?? type;
  if (type.flags & ts.TypeFlags.Any) return "unread";
  if (reading.has(type)) return "other";
  reading.add(type);
  const members = type.isUnion() ? type.types : [type];
  const kinds = members.map((member) =>
    checker.isArrayType(member) || checker.isTupleType(member)
      ? elementsKind(checker, member, reading)
      : member.getCallSignatures().length > 0
        ? "function"
        : "other",
  );
  reading.delete(type);
  for (const kind of ["functions", "function", "unread"] as const)
    if (kinds.includes(kind)) return kind;
  return "other";
}

// What an array or a tuple holds: functions if any element may be one.
function elementsKind(
  checker: ts.TypeChecker,
  type: ts.Type,
  reading: Set<ts.Type>,
): "functions" | "other" | "unread" {
  const elements = checker.getTypeArguments(type as ts.TypeReference);
  const kinds = elements.map((element) => kindOf(checker, element, reading));
  if (kinds.some((kind) => kind === "function" || kind === "functions"))
    return "functions";
  return kinds.includes("unread") ? "unread" : "other";
}
