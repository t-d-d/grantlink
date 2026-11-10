import { join } from "node:path";
import ts from "typescript";
import { root } from "./repo.ts";

// How the parameters of an exported step helper differ from the callback
// positions STEP_HELPERS lists for it (#411). Position 0 is the context. A
// parameter is function-typed when the type checker gives its type a call
// signature, so an alias such as `type Log = () => void` counts. The source
// is checked as if it sat at `path` in the repo, so its relative and package
// imports resolve as they do for the real module.
export function callbackMismatches(
  source: string,
  name: string,
  callbacks: readonly number[],
  path = "test/step-helper-under-check.ts",
): string[] {
  const fileName = join(root, path);
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (file, language, ...rest) =>
    file === fileName
      ? ts.createSourceFile(file, source, language, true)
      : getSourceFile(file, language, ...rest);
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

  const problems: string[] = [];
  for (const position of callbacks) {
    const parameter = fn.parameters[position];
    if (!parameter) problems.push(`${name} has no parameter ${position}`);
    else if (!isFunction(checker, parameter))
      problems.push(
        `${name}'s parameter ${position} (${parameter.name.getText()}) is not a function`,
      );
  }
  fn.parameters.forEach((parameter, position) => {
    if (position === 0 || callbacks.includes(position)) return;
    if (isFunction(checker, parameter))
      problems.push(
        `${name}'s parameter ${position} (${parameter.name.getText()}) is a function the table does not list`,
      );
  });
  return problems;
}

// The function an export names: a function declaration, or a const whose
// value is an arrow function or a function expression.
function exportedFunction(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): ts.SignatureDeclaration | undefined {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  for (const declaration of target.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration)) return declaration;
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

function isFunction(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): boolean {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(parameter));
  return type.getCallSignatures().length > 0;
}
