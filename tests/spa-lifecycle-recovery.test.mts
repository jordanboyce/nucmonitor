import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function sourceFile(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    resolve(REPO_ROOT, rel),
    read(rel),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, cb: (child: ts.Node) => void): void {
  node.forEachChild(child => {
    cb(child);
    visit(child, cb);
  });
}

function findClassMember<T extends ts.ClassElement>(
  file: ts.SourceFile,
  className: string,
  predicate: (member: ts.ClassElement) => member is T,
  label: string,
): T {
  let match: T | undefined;
  visit(file, node => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;
    for (const member of node.members) {
      if (predicate(member)) match = member;
    }
  });
  assert.ok(match, `could not find ${className}.${label}`);
  return match;
}

function findMethod(file: ts.SourceFile, className: string, methodName: string): ts.MethodDeclaration {
  return findClassMember(
    file,
    className,
    (member): member is ts.MethodDeclaration => (
      ts.isMethodDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === methodName
    ),
    methodName,
  );
}

function findConstructor(file: ts.SourceFile, className: string): ts.ConstructorDeclaration {
  return findClassMember(
    file,
    className,
    (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member),
    'constructor',
  );
}

function propertyCalls(node: ts.Node, propertyName: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(node, child => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === propertyName
    ) {
      calls.push(child);
    }
  });
  return calls;
}

function identifierCalls(node: ts.Node, identifierName: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(node, child => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === identifierName) {
      calls.push(child);
    }
  });
  return calls;
}

function firstStringArg(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

function hasReturnGuard(method: ts.MethodDeclaration, guardedCall: string): boolean {
  let found = false;
  visit(method, child => {
    if (!ts.isIfStatement(child)) return;
    const expr = child.expression;
    const thenStatement = child.thenStatement;
    const returns =
      ts.isReturnStatement(thenStatement) ||
      (ts.isBlock(thenStatement) &&
        thenStatement.statements.length === 1 &&
        ts.isReturnStatement(thenStatement.statements[0]!));
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === guardedCall &&
      returns
    ) {
      found = true;
    }
  });
  return found;
}

describe('SPA lifecycle recovery contracts', () => {
  it('PanelLayoutManager.destroy destroys every registered panel once and clears the registry', () => {
    const file = sourceFile('src/app/panel-layout.ts');
    const destroy = findMethod(file, 'PanelLayoutManager', 'destroy');
    const body = destroy.getText(file);

    assert.match(body, /destroyOnce/, 'destroy() must use a shared exactly-once helper');
    assert.match(
      body,
      /Object\.values\(this\.ctx\.panels\)[\s\S]*destroyOnce\(panel\)/,
      'destroy() must iterate every registered panel and pass each through destroyOnce',
    );
    assert.match(
      body,
      /Object\.keys\(this\.ctx\.panels\)[\s\S]*delete this\.ctx\.panels\[key\]/,
      'destroy() must clear ctx.panels after teardown so repeat destroys do not hit stale panels',
    );
    assert.doesNotMatch(
      body,
      /this\.ctx\.panels\[['"]airline-intel['"]\]\?\.destroy\(/,
      'destroy() must not special-case only airline-intel from the registered panel catalog',
    );
  });

  it('App.destroy terminates the ML worker it may have initialized', () => {
    const file = sourceFile('src/App.ts');
    const destroy = findMethod(file, 'App', 'destroy');
    assert.ok(
      propertyCalls(destroy, 'terminate').some(call => call.expression.getText(file) === 'mlWorker.terminate'),
      'App.destroy must terminate mlWorker so same-document reinit does not leak worker resources',
    );
  });
});
