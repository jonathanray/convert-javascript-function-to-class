import { convertFunctionToClass } from '../src/convert';

const options = {
	annotateTypes: true,
	angularJs: true
};

describe('convertFunctionToClass', () => {
	const source = cleanSource(`
			function TestService($http, someService) {
				this.something = 'something';
			}

			var someConstant = 'Hello World';
			
			TestService.prototype.doSomething2 = function doNotUseThisName() {
				return this.doSomething1();
			};

			TestService.prototype.doSomething1 = function() {
				return someConstant;
			}`);

	it('constructor function with prototype methods', () => {
		const expected = cleanSource(`
			var someConstant = 'Hello World';
			
			class TestService {
				something: string;

				constructor(private $http: ng.IHttpService, private someService) {
					this.something = 'something';
				}
			
				doSomething1() {
					return someConstant;
				}
			
				doSomething2() {
					return this.doSomething1();
				}
			}`);

		const result = convertFunctionToClass(source, options).trim();
		expect(result).toBe(expected);
	});
});

function cleanSource(source: string) {
	return source.replace(/\n\t\t\t/g, '\n').trimLeft();
}