/// <reference path="JsonParser.ts" />
/// <reference path="../../src/scan/Tokens.ts" />
/// <reference path="../../libs/jasmine.d.ts" />


module chevrotain.examples.json.spec {

    describe("Simple json parser example", function () {

        it("can parse a simple Json", function () {
            // { 'name':'shahar', 'age':32 }
            var input = [
                new LCurlyTok(1, 1),
                new StringTok(1, 3, "'name'"), new ColonTok(1, 8), new StringTok(1, 9, "'shahar'"),
                new CommaTok(1, 16),
                new StringTok(1, 17, "'age'"), new ColonTok(1, 20), new NumberTok(1, 21, "32"),
                new RCurlyTok(1, 23),
            ];

            var parser = new JsonParser(input);
            parser.object();
            expect(parser.errors.length).toBe(0);
            expect(parser.isAtEndOfInput()).toBe(true);
        });

        it("can invoke another parsing rule as the top rule", function () {
            var input = [
                new StringTok(1, 3, "'name'"), new ColonTok(1, 8), new StringTok(1, 9, "'shahar'"),
            ];
            var parser = new JsonParser(input);
            parser.objectItem();
            expect(parser.errors.length).toBe(0);
            expect(parser.isAtEndOfInput()).toBe(true);
        });

    });

}
