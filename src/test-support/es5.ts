import ts from "typescript";

/**
 * Finds syntax in a script that is newer than ES5. The generated bootstrap and the inline
 * script of the landing page stay ES5 on purpose (widest browser reach, no transpile step),
 * so the build tests run this over their output.
 *
 * Two passes. The TypeScript compiler's public transpile API reports syntax errors, which
 * includes TypeScript-only syntax in a .js file. Then a walk over the parsed tree reports every
 * construct ES5 does not have: the TypeScript parser accepts all of modern JavaScript, so
 * nothing newer fails to parse. Every message ends in its 1-based line number.
 */
export function es5Violations(source: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile("script.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  const transpiled = ts.transpileModule(source, {
    fileName: "script.js",
    reportDiagnostics: true,
    compilerOptions: { allowJs: true },
  });
  for (const d of transpiled.diagnostics ?? []) {
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
    } else if (ts.isCatchClause(node) && node.variableDeclaration === undefined) {
      flag(node, "optional catch binding");
    } else if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      if (k === ts.SyntaxKind.QuestionQuestionToken) flag(node, "nullish coalescing");
      else if (k === ts.SyntaxKind.AsteriskAsteriskToken || k === ts.SyntaxKind.AsteriskAsteriskEqualsToken) {
        flag(node, "exponent operator");
      } else if (
        k === ts.SyntaxKind.BarBarEqualsToken ||
        k === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        k === ts.SyntaxKind.QuestionQuestionEqualsToken
      ) {
        flag(node, "logical assignment");
      }
    } else if (ts.isMetaProperty(node)) {
      flag(node, node.keywordToken === ts.SyntaxKind.ImportKeyword ? "import.meta" : "new.target");
    } else if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      flag(node, "import or export");
    } else if (ts.isNumericLiteral(node)) {
      const raw = node.getText(file);
      if (raw.includes("_")) flag(node, "numeric separator");
      else if (/^0[bBoO]/.test(raw)) flag(node, "binary or octal literal");
    } else if (ts.isBigIntLiteral(node)) {
      flag(node, "BigInt literal");
    } else if (ts.isStringLiteral(node)) {
      const raw = node.getText(file);
      if (/\\u\{/.test(raw)) flag(node, "code point escape in a string");
      if (LINE_SEPARATORS.test(raw)) flag(node, "raw U+2028 or U+2029 in a string");
    } else if (ts.isRegularExpressionLiteral(node)) {
      for (const problem of regexProblems(node.getText(file))) flag(node, problem);
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) &&
      node.questionDotToken !== undefined
    ) {
      flag(node, "optional chaining");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      flag(node, "dynamic import");
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.hasTrailingComma) {
      flag(node, "trailing comma in call arguments");
    }
    if (ts.isFunctionLike(node) && node.parameters.hasTrailingComma) {
      flag(node, "trailing comma in a parameter list");
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      (node.asteriskToken !== undefined || (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) !== 0)
    ) {
      flag(node, "generator or async function");
    }
    if (
      (ts.isVariableStatement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      (ts.getCombinedModifierFlags(node as ts.Declaration) & (ts.ModifierFlags.Export | ts.ModifierFlags.Default)) !== 0
    ) {
      flag(node, "import or export");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(out)];
}

/** U+2028 and U+2029: line terminators in ES5, so illegal raw inside a string literal. */
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]");

/** What a regular expression literal (`/body/flags`) uses that ES5 does not have. */
function regexProblems(literal: string): string[] {
  const problems: string[] = [];
  const slash = literal.lastIndexOf("/");
  const body = literal.slice(1, slash);
  const flags = literal.slice(slash + 1);
  for (const flag of flags) {
    if (!"gim".includes(flag)) problems.push(`regex flag "${flag}"`);
  }
  // Walk the body so an escaped paren or a character class cannot pass for a group.
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "(" && body.startsWith("(?<", i)) {
      const next = body[i + 3];
      if (next === "=" || next === "!") problems.push("regex lookbehind");
      else problems.push("regex named group");
    }
  }
  return problems;
}

function lineOf(file: ts.SourceFile, pos: number): number {
  return file.getLineAndCharacterOfPosition(pos).line + 1;
}

/** `type` values the HTML spec runs as a classic script, besides an absent or empty type. */
const CLASSIC_SCRIPT_TYPE = /^(?:(?:application|text)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript|javascript1\.[0-5]))$/i;

/** The value of attribute `name` in the text between `<script` and `>`, or null when it is absent. */
function attributeValue(attributes: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attributes);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/**
 * The text of every inline classic `<script>` in an HTML document: no `src` attribute (a
 * `data-src` is not one) and a JavaScript `type` or none. Module scripts, JSON-LD, import maps
 * and template scripts are not run as classic scripts and are skipped. The end tag may carry
 * whitespace (`</script >`), and a quoted attribute value may contain `>`.
 */
export function inlineScripts(html: string): string[] {
  const found: string[] = [];
  const re = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const attributes = m[1] ?? "";
    if (/(?:^|\s)src\s*=/i.test(attributes)) continue;
    const type = attributeValue(attributes, "type");
    if (type !== null && type.trim() !== "" && !CLASSIC_SCRIPT_TYPE.test(type.trim())) continue;
    found.push(m[2] ?? "");
  }
  return found;
}
