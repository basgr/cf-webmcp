import ts from "typescript";

/**
 * Finds syntax in a script that is newer than ES5. The generated bootstrap and the inline
 * script of the landing page stay ES5 on purpose (widest browser reach, no transpile step),
 * so the build tests run this over their output.
 *
 * It parses with the TypeScript parser, which accepts all of modern JavaScript, and reports
 * each node kind that ES5 does not have. Every message ends in its 1-based line number.
 * Syntax errors the parser finds are reported too.
 */
export function es5Violations(source: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile("script.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const diagnostics = (file as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of diagnostics) {
    out.push(`syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")} (line ${lineOf(file, d.start ?? 0)})`);
  }

  const flag = (node: ts.Node, what: string): void => {
    out.push(`${what} (line ${lineOf(file, node.getStart(file))})`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node)) flag(node, "arrow function");
    else if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) flag(node, "template literal");
    else if (ts.isTaggedTemplateExpression(node)) flag(node, "tagged template");
    else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) flag(node, "spread");
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) flag(node, "class");
    else if (ts.isAwaitExpression(node)) flag(node, "await");
    else if (ts.isYieldExpression(node)) flag(node, "yield");
    else if (ts.isForOfStatement(node)) flag(node, "for...of");
    else if (ts.isShorthandPropertyAssignment(node)) flag(node, "shorthand property");
    else if (ts.isComputedPropertyName(node)) flag(node, "computed property name");
    else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) flag(node, "destructuring");
    else if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) !== 0) {
      flag(node, "let or const");
    } else if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
      flag(node, "method shorthand");
    } else if (ts.isParameter(node) && (node.initializer !== undefined || node.dotDotDotToken !== undefined)) {
      flag(node, "default or rest parameter");
    } else if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      if (k === ts.SyntaxKind.QuestionQuestionToken) flag(node, "nullish coalescing");
      else if (k === ts.SyntaxKind.AsteriskAsteriskToken || k === ts.SyntaxKind.AsteriskAsteriskEqualsToken) {
        flag(node, "exponent operator");
      }
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) &&
      node.questionDotToken !== undefined
    ) {
      flag(node, "optional chaining");
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      (node.asteriskToken !== undefined || (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) !== 0)
    ) {
      flag(node, "generator or async function");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

function lineOf(file: ts.SourceFile, pos: number): number {
  return file.getLineAndCharacterOfPosition(pos).line + 1;
}

/** The text of every inline `<script>` (no src attribute) in an HTML document. */
export function inlineScripts(html: string): string[] {
  const found: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    if (!/\bsrc\s*=/i.test(m[1] ?? "")) found.push(m[2] ?? "");
  }
  return found;
}
