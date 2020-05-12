import * as babelTypes from '@babel/types';
import generate, { GeneratorOptions } from '@babel/generator';
import traverse from '@babel/traverse';
import { parse, ParserOptions } from '@babel/parser';
import { sortBy, flatten, uniq } from 'lodash';

const parseOptions: ParserOptions = {
	sourceType: 'module',
	strictMode: false,
	plugins: ['typescript', 'classPrivateProperties', 'classProperties']
};

const babelGeneratorOptions: GeneratorOptions = {
	comments: true
};

const angularServices = {
	$document: 'IDocumentService',
	$http: 'IHttpService',
	$interval: 'IIntervalService',
	$location: 'ILocationService',
	$rootScope: 'IRootScope',
	$scope: 'IScope',
	$timeout: 'ITimeoutService',
	$window: 'IWindowService'
};

export class FunctionToClassConverter {
	properties: babelTypes.ClassProperty[];
	methods: babelTypes.ClassMethod[];
	ctor: babelTypes.ClassMethod;
	onInit: babelTypes.ClassMethod;
	idMap: Record<string, babelTypes.Node>;
	copiedComments: number[];
	contextAlias: string;
	annotateTypes: boolean;
	isConstructorFunction: any;

	private constructor() {
		this.methods = [];
		this.properties = [];
		this.copiedComments = [];
		this.idMap = {};
	}

	static convertFunctionToES6Class(source: string): string {
		return this.convertFunctionToClass(source, false);
	}

	static convertFunctionToTypeScriptClass(source: string): string {
		return this.convertFunctionToClass(source, true);
	}

	private static convertFunctionToClass(source: string, annotateTypes: boolean): string {
		if (!source?.trim()) return source;
		if (source.trim().indexOf('function') === -1) return source; //throw Error('Source is not a function');

		const ast = parse(source, parseOptions);
		if (ast.program.body.length === 0) return source;

		const func = ast.program.body[0];
		if (!babelTypes.isFunctionDeclaration(func)) return source;

		const converter = new FunctionToClassConverter();
		converter.annotateTypes = annotateTypes;

		const classDeclaration = converter.convertFactory(func) || converter.convertConstructor(func);
		if (!classDeclaration) {
			throw Error('Failed to convert function to class');
		}

		let output: string = generate(classDeclaration, babelGeneratorOptions).code;

		// babel generator doesn't allow formatting options. No need to use prettier just for indentation.
		const sourceIndentation = this.detectIndentation(source);
		const outputIndentation = this.detectIndentation(output);
		if (sourceIndentation && outputIndentation && sourceIndentation !== outputIndentation) {
			output = output.replace(new RegExp(outputIndentation, 'g'), sourceIndentation);
		}

		if (output.substr(output.length - 3, 2) === '\n\n') {
			output = output.substr(0, output.length - 2) + output[output.length - 1];
		}

		return output;
	}

	private static detectIndentation(source: string): string {
		if (source.includes('\n\t')) return '\t';

		const matches = uniq(source.match(/\n +/g).map(m => m.substr(1)));
		if (matches.length === 0) return '';
		if (matches.length === 1) return matches[0];

		const sorted = sortBy(matches);
		const len = Math.ceil(sorted[sorted.length - 1].length / sorted[0].length);
		return ''.padStart(len, ' ');
	}

	getLastStatement(block: babelTypes.BlockStatement): babelTypes.Statement | undefined {
		for (let index = block.body.length - 1; index >= 0; index--) {
			const node = block.body[index];
			if (babelTypes.isStatement(node) && !babelTypes.isFunctionDeclaration(node)) {
				return node;
			}
		}
	}

	convertFactory(func: babelTypes.FunctionDeclaration): babelTypes.ClassDeclaration | false {
		const lastStmt = this.getLastStatement(func.body);

		if (!babelTypes.isReturnStatement(lastStmt)) return false;

		if (babelTypes.isIdentifier(lastStmt.argument)) {
			this.contextAlias = lastStmt.argument.name;
		} else if (!babelTypes.isObjectExpression(lastStmt.argument)) {
			return false;
		}

		this.ctor = this.createClassConstructor(func);
		this.onInit = this.createClassMethod(babelTypes.identifier('$onInit'));

		for (let index = 0; index < func.body.body.length; index++) {
			// const comments = func.body.body[index-1]?.comm;
			const stmt = func.body.body[index];
			if (babelTypes.isVariableDeclaration(stmt)) {
				this.handleVariableDeclaration(stmt);
			} else if (babelTypes.isFunctionDeclaration(stmt)) {
				this.handleFunctionDeclaration(stmt);
			} else if (babelTypes.isExpressionStatement(stmt)) {
				this.handleAssignmentExpressionStatement(stmt);
			} else if (stmt === lastStmt && babelTypes.isReturnStatement(stmt) && babelTypes.isObjectExpression(stmt.argument)) {
				for (const prop of stmt.argument.properties) {
					this.handleObjectProperty(prop);
				}
			}
		}

		this.properties = sortBy(this.properties, p => (p.key as babelTypes.Identifier).name);
		this.methods = sortBy(this.methods, m => (m.key as babelTypes.Identifier).name);

		if (this.onInit.body.body.length > 0) {
			this.methods.unshift(this.ctor);
		}

		if (this.ctor.body.body.length > 0) {
			this.methods.unshift(this.ctor);
		}

		this.convertIdentifiersToMemberExpressions();
		this.convertFunctionExpressionsToArrowFunctionExpressions();

		const body = babelTypes.classBody([].concat(this.properties).concat(this.methods));
		const classDeclaration = babelTypes.classDeclaration(func.id, null, body, null);

		return classDeclaration;
	}

	convertConstructor(func: babelTypes.FunctionDeclaration): babelTypes.ClassDeclaration | false {
		this.contextAlias = this.getContextAlias(func);

		this.ctor = this.createClassConstructor(func);
		this.onInit = this.createClassMethod(babelTypes.identifier('$onInit'));

		for (let index = 0; index < func.body.body.length; index++) {
			// const comments = func.body.body[index-1]?.comm;
			const stmt = func.body.body[index];
			if (babelTypes.isVariableDeclaration(stmt)) {
				this.handleVariableDeclaration(stmt);
			} else if (babelTypes.isFunctionDeclaration(stmt)) {
				this.handleFunctionDeclaration(stmt);
			} else if (babelTypes.isExpressionStatement(stmt)) {
				this.handleAssignmentExpressionStatement(stmt);
			} else {
				debugger;
			}
		}

		this.properties = sortBy(this.properties, p => (p.key as babelTypes.Identifier).name);
		this.methods = sortBy(this.methods, m => (m.key as babelTypes.Identifier).name);

		if (this.onInit.body.body.length > 0) {
			this.methods.unshift(this.onInit);
		}

		if (this.ctor.body.body.length > 0) {
			this.methods.unshift(this.ctor);
		}

		this.convertIdentifiersToMemberExpressions();
		this.convertFunctionExpressionsToArrowFunctionExpressions();

		const body = babelTypes.classBody([].concat(this.properties).concat(this.methods));
		const classDeclaration = babelTypes.classDeclaration(func.id, null, body, null);

		return classDeclaration;
	}

	isNamed(node: babelTypes.Node, name: string): node is babelTypes.Identifier {
		return babelTypes.isIdentifier(node) && node.name === name;
	}

	getContextAlias(func: babelTypes.FunctionDeclaration): string {
		const variableDeclarations = flatten(func.body.body
			.map(stmt => babelTypes.isVariableDeclaration(stmt) ? stmt.declarations : []));

		const variableDeclarators = variableDeclarations
			.filter(varDecl => !!varDecl) as babelTypes.VariableDeclarator[];

		const alias = variableDeclarators
			.map(vd => babelTypes.isThisExpression(vd.init) && babelTypes.isIdentifier(vd.id) ? vd.id.name : null)
			.find(alias => !!alias);

		return alias;
	}

	createClassConstructor(func: babelTypes.FunctionDeclaration = null): babelTypes.ClassMethod {
		const id = babelTypes.identifier('constructor');
		const blockStmt = babelTypes.blockStatement([]);

		if (!func) {
			return babelTypes.classMethod('constructor', id, [], blockStmt);
		}

		for (let index = 0; index < func.params.length; index++) {
			const param = func.params[index];
			if (babelTypes.isIdentifier(param)) {
				this.idMap[param.name] = param;
				this.annotateIdentifier(param);

				const paramProperty = babelTypes.tsParameterProperty(param);
				paramProperty.accessibility = 'private';
				func.params[index] = paramProperty;
			}
		}

		return babelTypes.classMethod('constructor', id, func.params, blockStmt);
	}

	createClassMethod(id: babelTypes.Identifier, func: babelTypes.FunctionDeclaration | babelTypes.FunctionExpression | babelTypes.ArrowFunctionExpression = null): babelTypes.ClassMethod {
		let body: babelTypes.BlockStatement;
		if (!func || !func.body) {
			body = babelTypes.blockStatement([]);
		} else if (babelTypes.isBlockStatement(func.body)) {
			body = func.body;
		} else {
			throw Error('Not implemented: convert arrow function to class method');
		}

		return babelTypes.classMethod('method', id, func?.params || [], body);
	}

	createAssignmentToThis(id: babelTypes.Identifier, right: babelTypes.Expression): babelTypes.ExpressionStatement {
		const left = babelTypes.memberExpression(babelTypes.thisExpression(), id);
		const assignment = babelTypes.assignmentExpression('=', left, right);
		return babelTypes.expressionStatement(assignment);
	}

	handleObjectProperty(prop: babelTypes.ObjectMethod | babelTypes.ObjectProperty | babelTypes.SpreadElement) {
		if (!babelTypes.isObjectProperty(prop)) return;

		if (babelTypes.isFunctionExpression(prop.value)) {
			this.appendClassMethod(this.createClassMethod(prop.key, prop.value), prop.key, prop);
		} else if (babelTypes.isLiteral(prop.value)) {
			this.appendConstructorExprStmt(this.createAssignmentToThis(prop.key, prop.value), prop.key, prop);
		} else if (babelTypes.isIdentifier(prop.value)) {
			if (!this.idMap[prop.key.name]) {
				debugger;
			}
		} else {
			debugger; // What else is there?
		}
	}

	handleVariableDeclaration(stmt: babelTypes.VariableDeclaration) {
		for (const varDec of stmt.declarations) {
			if (!babelTypes.isIdentifier(varDec.id)) throw Error('Variable Declarator ID is not Identifier type');

			if (babelTypes.isLiteral(varDec.init)) {
				this.appendConstructorExprStmt(this.createAssignmentToThis(varDec.id, varDec.init), varDec.id, varDec);
			} else if (babelTypes.isFunctionExpression(varDec.init)) {
				this.appendClassMethod(this.createClassMethod(varDec.id, varDec.init), varDec.id, varDec);
			} else if (babelTypes.isIdentifier(varDec.id) && varDec.id.name === this.contextAlias) {
				if (!babelTypes.isObjectExpression(varDec.init)) return false;

				for (const prop of varDec.init.properties) {
					this.handleObjectProperty(prop);
				}
			} else {
				debugger;
			}
		}
	}

	appendClassMethod(method: babelTypes.ClassMethod, id: babelTypes.Identifier, copyCommentsFrom: babelTypes.Node): void {
		this.copyComments(copyCommentsFrom, method);
		this.methods.push(method);
		this.idMap[id.name] = method;
	}

	appendConstructorExprStmt(exprStmt: babelTypes.ExpressionStatement, id: babelTypes.Identifier, copyCommentsFrom: babelTypes.Node): void {
		this.copyComments(copyCommentsFrom, exprStmt);
		this.ctor.body.body.push(exprStmt);
		this.idMap[id.name] = exprStmt;

		const typeAnnotation = this.getTypeAnnotation((exprStmt.expression as babelTypes.AssignmentExpression).right);
		const property = babelTypes.classProperty(id, undefined, typeAnnotation);
		this.properties.push(property);
	}

	convertIdentifiersToMemberExpressions(): void {
		for (const method of this.methods) {
			traverse(method, {
				noScope: true,
				Identifier: (path) => {
					if (!this.idMap[path.node.name]) return;
					const parent = path.parent;
					if (babelTypes.isClassMethod(parent)) return;
					if (babelTypes.isTSParameterProperty(parent)) return;
					if (babelTypes.isMemberExpression(parent)) return;

					const memberExpr = babelTypes.memberExpression(babelTypes.thisExpression(), path.node);
					path.replaceWith(memberExpr);
				},
				MemberExpression: (path) => {
					const obj = path.node.object;
					if (!babelTypes.isIdentifier(obj)) return;

					if (obj.name === this.contextAlias) {
						const memberExpr = babelTypes.memberExpression(babelTypes.thisExpression(), path.node.property);
						path.replaceWith(memberExpr);
						return;
					}

					if (this.idMap[obj.name]) {
						const memberExpr = babelTypes.memberExpression(
							babelTypes.memberExpression(babelTypes.thisExpression(), path.node.object),
							path.node.property);
						path.replaceWith(memberExpr);
						return;
					}
				}
			});
		}
	}


	convertFunctionExpressionsToArrowFunctionExpressions() {
		for (const method of this.methods) {
			traverse(method, {
				noScope: true,
				FunctionExpression: (path) => {
					const funcStmts = path.node.body.body;
					let arrowFunction: babelTypes.ArrowFunctionExpression;

					const makeFuncExpr = funcStmts.length === 1
						&& babelTypes.isReturnStatement(funcStmts[0])
						&& !path.node.leadingComments?.length
						&& !path.node.innerComments?.length
						&& !path.node.trailingComments?.length;

					if (makeFuncExpr) {
						arrowFunction = babelTypes.arrowFunctionExpression(path.node.params, (funcStmts[0] as babelTypes.ReturnStatement).argument);
						arrowFunction.expression = true;
					} else {
						arrowFunction = babelTypes.arrowFunctionExpression(path.node.params, path.node.body);
						this.copyComments(path.node, arrowFunction);
					}

					path.replaceWith(arrowFunction);
				}
			});
		}
	}

	getRootObject(memberExpr: babelTypes.MemberExpression): babelTypes.Expression {
		let obj = memberExpr.object;
		while (babelTypes.isMemberExpression(obj)) {
			obj = obj.object;
		}
		return obj;
	}

	handleFunctionDeclaration(stmt: babelTypes.FunctionDeclaration) {
		this.appendClassMethod(this.createClassMethod(stmt.id, stmt), stmt.id, stmt);
	}

	handleAssignmentExpressionStatement(stmt: babelTypes.ExpressionStatement) {
		if (!babelTypes.isExpressionStatement(stmt)) return;
		if (!babelTypes.isAssignmentExpression(stmt.expression)) return;

		const left = stmt.expression.left;
		if (!babelTypes.isMemberExpression(left)) return;
		if (!babelTypes.isIdentifier(left.property)) return;
		if (!babelTypes.isThisExpression(left.object) && !(this.contextAlias && this.isNamed(left.object, this.contextAlias))) return;

		const right = stmt.expression.right;
		const leftId = left.property;
		if (babelTypes.isFunctionExpression(right) || babelTypes.isArrowFunctionExpression(right)) {
			this.appendClassMethod(this.createClassMethod(leftId, right), left.property, stmt);
			return;
		}

		if (babelTypes.isLiteral(right)) {
			this.appendConstructorExprStmt(this.createAssignmentToThis(leftId, right), leftId, stmt);
			return;
		}

		if (babelTypes.isIdentifier(right)) {
			if (right.name === leftId.name && this.idMap[leftId.name]) {
				this.copyComments(stmt, this.idMap[leftId.name]);
				return;
			}
		}
	}

	copyComments(srcNode: babelTypes.Node, destNode: babelTypes.Node): void {
		const leadingComments = srcNode.leadingComments
			?.filter(comment => !this.copiedComments.some(copied => comment.start === copied));

		if (leadingComments?.length) {
			destNode.leadingComments = (destNode.leadingComments || []).concat(leadingComments);
			this.copiedComments.push(...leadingComments.map(c => c.start));
		}

		if (srcNode.innerComments?.length) {
			destNode.innerComments = (destNode.innerComments || []).concat(srcNode.innerComments);
			this.copiedComments.push(...srcNode.innerComments.map(c => c.start));
		}

		const trailingComments = srcNode.trailingComments
			?.filter(comment => !this.copiedComments.some(copied => comment.start === copied))
			?.filter(c => c.loc.start.line <= srcNode.loc.end.line);

		if (trailingComments?.length) {
			if (babelTypes.isClassMethod(destNode)) {
				destNode.body.innerComments = (destNode.innerComments || []).concat(trailingComments);
			} else {
				destNode.trailingComments = (destNode.trailingComments || []).concat(trailingComments);
			}
			this.copiedComments.push(...trailingComments.map(c => c.start));
		}
	}

	annotateIdentifier(id: babelTypes.Identifier): void {
		if (!babelTypes.isIdentifier(id)) return id;

		if (!id.typeAnnotation && angularServices[id.name]) {
			id.typeAnnotation = babelTypes.tsTypeAnnotation(
				babelTypes.tsTypeReference(
					babelTypes.tsQualifiedName(
						babelTypes.identifier('ng'),
						babelTypes.identifier(angularServices[id.name]))));
		}
	}

	getTypeAnnotation(node: babelTypes.Expression): babelTypes.TypeAnnotation | undefined {
		if (babelTypes.isLiteral(node)) {
			if (babelTypes.isStringLiteral(node)) {
				return babelTypes.typeAnnotation(babelTypes.stringTypeAnnotation());
			}
			if (babelTypes.isNumberLiteral(node)) {
				return babelTypes.typeAnnotation(babelTypes.numberTypeAnnotation());
			}
			if (babelTypes.isBooleanLiteral(node)) {
				return babelTypes.typeAnnotation(babelTypes.booleanTypeAnnotation());
			}
		}
		return undefined; // babelTypes.typeAnnotation(babelTypes.anyTypeAnnotation());
	}
}

const source = `							
function TestService($http, someService) {
	var self = this;
	self.something = 'something';

	self.doSomething1 = function doSomething1() {
		return something;
	}

	var doSomething2 = function doNotUseThisName() {
		return self.something;
	}

	this.doSomething2 = doSomething2;

	function testAngular() {
		return $http.get('http://').then(function(response) { return response.data; });
	}
}`;

FunctionToClassConverter.convertFunctionToTypeScriptClass(source).trim();
