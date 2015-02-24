/// <reference path="../scan/Tokens.ts" />
/// <reference path="../parse/grammar/GAst.ts" />
/// <reference path="../parse/Constants.ts" />
/// <reference path="../parse/grammar/Interpreter2.ts" />

/// <reference path="../../libs/lodash.d.ts" />
/// <reference path="../../libs/hashtable.d.ts" />

module chevrotain.parse.infra.recognizer {

    import tok = chevrotain.scan.tokens;
    import gast = chevrotain.parse.grammar.gast;
    import IN = chevrotain.parse.constants.IN;
    import interp = chevrotain.parse.grammar.interpreter;

    export interface RecognitionException extends Error {
        token:tok.Token
    }

    // hacks to bypass no support for custom Errors in javascript/typescript
    export function isRecognitionException(error:Error) {
        var recognitionExceptions = ['MismatchedTokenException', 'NoViableAltException', 'EarlyExitException', 'NotAllInputParsedException'];
        // can't do instanceof on hacked custom js exceptions
        return _.contains(recognitionExceptions, error.name);
    }

    export function MismatchedTokenException(message:string, token:tok.Token) {
        this.name = "MismatchedTokenException";
        this.message = message;
        this.token = token;
    }

    // must use the "Error.prototype" instead of "new Error"
    // because the stack trace points to where "new Error" was invoked"
    MismatchedTokenException.prototype = Error.prototype;

    export function NoViableAltException(message:string, token:tok.Token) {
        this.name = "NoViableAltException";
        this.message = message;
        this.token = token;
    }

    NoViableAltException.prototype = Error.prototype;

    export function NotAllInputParsedException(message:string, token:tok.Token) {
        this.name = "NotAllInputParsedException";
        this.message = message;
        this.token = token;
    }

    NotAllInputParsedException.prototype = Error.prototype;


    export function EarlyExitException(message:string, token:tok.Token) {
        this.name = "EarlyExitException";
        this.message = message;
        this.token = token;
    }

    EarlyExitException.prototype = Error.prototype;

    export class EOF extends tok.VirtualToken {}

    export interface IManyOrCase {
        WHEN:()=>boolean;
        THEN_DO:()=>void;
    }

    export interface IOrCase<T> {
        WHEN:()=>boolean;
        THEN_DO:()=>T;
    }

    export interface IOrRetType<T> {
        tree:T;
        matched:boolean;
    }

    export interface IBaseRecogState {
        errors: Error[];
        inputIdx:number;
    }

    export interface IErrorRecoveryRecogState extends IBaseRecogState {
        RULE_STACK:string[];
        FOLLOW_STACK:Function[][];
    }

    export class BaseRecognizer {

        public errors:Error[] = [];
        // no protected access in TypeScript, so have to use public for members that need to be accessed in sub classes
        public input:tok.Token[] = [];
        public inputIdx = -1;
        public isBackTrackingStack = [];

        constructor(input:tok.Token[] = []) {
            this.input = input;
        }

        public isBackTracking():boolean {
            return !(_.isEmpty(this.isBackTrackingStack));
        }

        // simple and quick reset of the parser to enable reuse of the same parser instance
        reset():void {
            this.isBackTrackingStack = [];
            this.errors = [];
            this.input = [];
            this.inputIdx = -1;
        }

        isAtEndOfInput():boolean {
            return this.LA(1) instanceof EOF;
        }

        SAVE_ERROR(error:Error):Error {
            if (isRecognitionException(error)) {
                this.errors.push(error);
                return error;
            }
            else {
                throw Error("trying to save an Error which is not a RecognitionException");
            }
        }

        NEXT_TOKEN():tok.Token {
            return this.LA(1);
        }

        // skips a token and returns the next token
        SKIP_TOKEN():tok.Token {
            // example: assume 45 tokens in the input, if input index is 44 it means that NEXT_TOKEN will return
            // input[45] which is the 46th item and no longer exists, so in this case the largest valid input index is 43 (input.length - 2 )
            if (this.inputIdx <= this.input.length - 2) {
                this.inputIdx++;
                return this.NEXT_TOKEN();
            }
            else {
                return new EOF();
            }
        }

        IS_ONE_OF_ALTERNATIVES_LOOK_AHEAD(tokTypes:Function[][]):()=>boolean {
            return () => {
                return _.find(tokTypes, (altTokenSeq) => {
                        return _.every(altTokenSeq, (currToken:any, i) => {
                            return this.LA(i + 1) instanceof currToken;
                        }, this);
                    }, this) !== undefined;
            };
        }

        CONSUME(tokType:Function):tok.Token {
            var nextToken = this.NEXT_TOKEN();
            if (this.NEXT_TOKEN() instanceof tokType) {
                this.inputIdx++;
                return nextToken;
            }
            else {
                var expectedTokType = tok.getTokName(tokType);
                var msg = "Expecting token of type -->" + expectedTokType + "<-- but found -->'" + nextToken.image + "'<--";
                throw this.SAVE_ERROR(new MismatchedTokenException(msg, nextToken));
            }
        }

        LA(howMuch:number):tok.Token {
            if (this.input.length <= this.inputIdx + howMuch) {
                return new EOF();
            }
            else {
                return this.input[this.inputIdx + howMuch];
            }
        }

        BACKTRACK<T>(grammarRule:(idx:number)=>T, isValid:(T)=>boolean):()=>boolean {
            return () => {
                // save org state
                this.isBackTrackingStack.push(1);
                var orgState = this.saveRecogState();
                try {
                    var ruleResult = grammarRule.call(this, 1);
                    return isValid(ruleResult);
                } catch (e) {
                    if (isRecognitionException(e)) {
                        return false;
                    }
                    else {
                        throw e;
                    }
                }
                finally {
                    this.reloadRecogState(orgState);
                    this.isBackTrackingStack.pop();
                }
            };
        }

        saveRecogState():IBaseRecogState {
            var savedErrors = _.clone(this.errors);
            return {errors: savedErrors, inputIdx: this.inputIdx};
        }

        reloadRecogState(newState:IBaseRecogState) {
            this.errors = newState.errors;
            this.inputIdx = newState.inputIdx;
        }

        OPTION(condition:()=>boolean, action:()=>void):boolean {
            if (condition.call(this)) {
                action.call(this);
                return true;
            }
            return false;
        }

        OR<T>(cases:IOrCase<T>[], errMsgTypes:string):IOrRetType<T> {
            var oneValidCaseFound = false;
            for (var i = 0; i < cases.length; i++) {
                if (cases[i].WHEN.call(this)) {
                    oneValidCaseFound = true;
                    var res = cases[i].THEN_DO();
                    // TODO: why return the complex object?
                    return {tree: res, matched: true};
                }
            }

            if (!oneValidCaseFound) {
                var foundToken = this.NEXT_TOKEN().image;
                throw this.SAVE_ERROR(new NoViableAltException("expecting: " + errMsgTypes + " but found '" + foundToken + "'", this.NEXT_TOKEN()));
            }
        }

        MANY(lookAheadFunc:()=>boolean, consume:()=>void):void {
            while (lookAheadFunc.call(this)) {
                consume.call(this);
            }
        }

        MANY_OR(cases:IManyOrCase[]):void {
            var lastWasValid:any = true;
            while (lastWasValid) {
                for (var i = 0; i < cases.length; i++) {
                    lastWasValid = false;
                    if (cases[i].WHEN.call(this)) {
                        cases[i].THEN_DO();
                        lastWasValid = true;
                        break;
                    }
                }
            }
        }

        AT_LEAST_ONE(lookAheadFunc:()=>boolean, consume:()=>void, errMsg:string):void {
            if (lookAheadFunc.call(this)) {
                consume.call(this);
                this.MANY(lookAheadFunc, consume);
            }
            else {
                throw this.SAVE_ERROR(new EarlyExitException("expecting at least one: " + errMsg, this.NEXT_TOKEN()));
            }
        }
    }

    export function InRuleRecoveryException(message:string) {
        this.name = "InRuleRecoveryException";
        this.message = message;
    }

    InRuleRecoveryException.prototype = Error.prototype;

    export interface IFollowSet {}

    // 1. check follow set name
    // 2. check RULE name
    // 2. CHECK FOLLOW_SET have everything it should and nothing it should not
    export class BaseErrorRecoveryRecognizer extends BaseRecognizer {

        public RULE_STACK:string[] = [];
        public RULE_OCCURRENCE_STACK:number[] = [];
        public FOLLOW_STACK:Function[][] = [];

        reset():void {
            super.reset();
            this.RULE_STACK = [];
            this.RULE_OCCURRENCE_STACK = [];
            this.FOLLOW_STACK = [];
        }

        public getInruleFollowSet():IHashtable<string, Function[]> {
            return new Hashtable<string, Function[]>();
        }

        public getResyncFollowSet():IHashtable<string, Function[]> {
            return new Hashtable<string, Function[]>();
        }

        saveRecogState():IErrorRecoveryRecogState {
            var baseState = super.saveRecogState();
            var savedRuleStack = _.clone(this.RULE_STACK);
            var savedFollowStack = _.clone(this.FOLLOW_STACK);
            return {
                errors: baseState.errors,
                inputIdx: baseState.inputIdx,
                RULE_STACK: savedRuleStack,
                FOLLOW_STACK: savedFollowStack
            };
        }

        reloadRecogState(newState:IErrorRecoveryRecogState) {
            super.reloadRecogState(newState);
            this.RULE_STACK = newState.RULE_STACK;
            this.FOLLOW_STACK = newState.FOLLOW_STACK;
        }

        CONSUME(tokType:Function):tok.Token {
            // The basic indexless consume is not supported because that index/occurrence number must be provided
            // to allow the parser to "know" its position. for example: take a simple qualifiedName rule.
            //
            // this.CONSUME1(IdentTok)); <-- first Ident
            // this.MANY(isQualifiedNamePart, ()=> {
            //    this.CONSUME1(DotTok);
            //    this.CONSUME2(IdentTok);   <-- ident 2...n
            // })
            //
            // the behavior for recovering from a mismatched Token may be different depending if we are trying to consume
            // the first or the second occurrence of IdentTok. because the position in the grammar is different...
            throw Error("must use COMSUME1/2/3... to indicate the occurrence of the specific Token inside the current rule");
        }

        CONSUME1(tokType:Function):tok.Token {
            return this.consume_internal(tokType, 1);
        }

        CONSUME2(tokType:Function):tok.Token {
            return this.consume_internal(tokType, 2);
        }

        CONSUME3(tokType:Function):tok.Token {
            return this.consume_internal(tokType, 3);
        }

        CONSUME4(tokType:Function):tok.Token {
            return this.consume_internal(tokType, 4);
        }

        /**
         *  This is an "empty" wrapper that has no meaning in runtime, it is only used to create an easy to identify
         *  textual mark for the purpose of making the "self" parsing of the implemented grammar rules easier.
         */
        // TODO: can this limitation be removed? if we know all the parsing rules names (or mark them in one way or another)
        // can the self parsing itself be done in a more dynamic manner taking into account this information (rules names) ?
        SUBRULE<T>(res:T):T {
            return res;
        }

        // TODO: can the 2 optional parameters for special 'preemptive' resync recovery into the next item of the 'MANY'
        // be computed automatically?
        MANY(lookAheadFunc:()=>boolean,
             consume:()=>void,
             expectTokAfterLastMatch?:Function,
             nextTokIdx?:number):void {
            super.MANY(lookAheadFunc, consume);


            if (this.shouldInRepetitionRecoveryBeTried(expectTokAfterLastMatch, nextTokIdx)) {
                this.tryInRepetitionRecovery(this.MANY, arguments, lookAheadFunc, expectTokAfterLastMatch);
            }
        }

        AT_LEAST_ONE(lookAheadFunc:()=>boolean,
                     consume:()=>void,
                     errMsg:string,
                     expectTokAfterLastMatch?:Function,
                     nextTokIdx?:number):void {

            super.AT_LEAST_ONE(lookAheadFunc, consume, errMsg);

            if (this.shouldInRepetitionRecoveryBeTried(expectTokAfterLastMatch, nextTokIdx)) {
                // note that while it may seem that this can cause an error because by using a recursive call to
                // AT_LEAST_ONE we change the grammar to AT_LEAST_TWO, AT_LEAST_THREE ... , the possible recursive call
                // from the tryInRepetitionRecovery(...) will only happen IFF there really are TWO/THREE/.... items.
                this.tryInRepetitionRecovery(this.AT_LEAST_ONE, arguments, lookAheadFunc, expectTokAfterLastMatch);
            }
        }

        MANY_OR(cases:IManyOrCase[], expectTokAfterLastMatch?:Function, nextTokIdx?:number):void {
            super.MANY_OR(cases);

            if (this.shouldInRepetitionRecoveryBeTried(expectTokAfterLastMatch, nextTokIdx)) {
                this.tryInRepetitionRecovery(
                    this.MANY_OR,
                    arguments,
                    // the lookahead Func for trying preemptive in repetition recovery in MANY_OR is
                    // performed by trying all the OR cases lookaheads one by one
                    ()=> {
                        var allLookAheadFuncs = _.map(cases, (singleCase:IManyOrCase)=> {
                            return singleCase.WHEN;
                        });
                        return _.find(allLookAheadFuncs, (singleLookAheadFunc)=> {
                                return singleLookAheadFunc();
                            }) !== undefined;
                    },
                    expectTokAfterLastMatch);
            }
        }

        tryInRepetitionRecovery(grammarRule:Function,
                                grammarRuleArgs:IArguments,
                                lookAheadFunc:()=>boolean,
                                expectedTokType:Function):void {
            var reSyncTokType = this.findReSyncTokenType();
            var orgInputIdx = this.inputIdx;
            var nextTokenWithoutResync = this.NEXT_TOKEN();
            var currToken = this.NEXT_TOKEN();
            while (!(currToken instanceof reSyncTokType)) {
                // we skipped enough tokens so we can resync right back into another iteration of the repetition grammar rule
                if (lookAheadFunc.call(this)) {
                    // we are preemptively re-syncing before an error has been detected, therefor we must reproduce
                    // the error that would have been thrown
                    var expectedTokName = tok.getTokName(expectedTokType);
                    var msg = "Expecting token of type -->" + expectedTokName + "<-- but found -->'" + nextTokenWithoutResync.image + "'<--";
                    this.SAVE_ERROR(new MismatchedTokenException(msg, nextTokenWithoutResync));

                    // recursive invocation in other to support multiple re-syncs in the same top level repetition grammar rule
                    grammarRule.apply(this, grammarRuleArgs);
                    return; // must return here to avoid reverting the inputIdx
                }
                currToken = this.SKIP_TOKEN();
            }

            // we were unable to find a CLOSER point to resync inside the MANY, reset the state and
            // rethrow the exception for farther recovery attempts into rules deeper in the rules stack
            this.inputIdx = orgInputIdx;
        }

        shouldInRepetitionRecoveryBeTried(expectTokAfterLastMatch?:Function, nextTokIdx?:number):boolean {
            // arguments to try and perform resync into the next iteration of the many are missing
            if (_.isUndefined(expectTokAfterLastMatch) || _.isUndefined(nextTokIdx)) {
                return false;
            }

            // no need to recover, next token is what we expect...
            if (this.NEXT_TOKEN() instanceof expectTokAfterLastMatch) {
                return false;
            }

            // error recovery is disabled during backtracking as it can make the parser ignore a valid grammar path
            // and prefer some backtracking path that includes recovered errors.
            if (this.isBackTracking()) {
                return false;
            }

            // if we can perform inRule recovery (single token insertion or deletion) we always prefer that recovery algorithim
            // because if it works, it makes the least amount of changes to the input stream (greedy algorithm)
            //noinspection RedundantIfStatementJS
            if (this.canPerformInRuleRecovery(expectTokAfterLastMatch,
                    this.getFollowsForInRuleRecovery(expectTokAfterLastMatch, nextTokIdx))) {
                return false;
            }

            return true;
        }

        /**
         * @param tokType The Type of Token we wish to consume (Reference to its constructor function)
         * @param idx occurrence index of consumed token in the invoking parser rule text
         *         for example:
         *         IDENT (DOT IDENT)*
         *         the first ident will have idx 1 and the second one idx 2
         *         * note that for the second ident the idx is always 2 even if its invoked 30 times in the same rule
         *           the idx is about the position in grammar (source code) and has nothing to do with a specific invocation
         *           details
         *
         * @returns the consumed Token
         */
        public consume_internal(tokType:Function, idx:number):tok.Token {
            try {
                return super.CONSUME(tokType);
            } catch (eFromConsumption) {
                // no recovery allowed during backtracking, otherwise backtracking may recover invalid syntax and accept it
                // but the original syntax could have been parsed successfully without any backtracking + recovery
                if (eFromConsumption instanceof MismatchedTokenException && !this.isBackTracking()) {
                    var follows = this.getFollowsForInRuleRecovery(tokType, idx);
                    try {
                        return this.tryInRuleRecovery(tokType, follows);
                    } catch (eFromInRuleRecovery) {
                        if (eFromConsumption instanceof InRuleRecoveryException) {
                            // throw the original error in order to trigger reSync error recovery
                            throw eFromConsumption;
                        }
                        else {
                            // some other error Type (built in JS error) this needs to be rethrown, we don't want to swallow it
                            throw eFromInRuleRecovery;
                        }
                    }
                }
                else {
                    throw eFromConsumption;
                }
            }
        }


        private calculateInRuleFollowsByFullContext = true;

        getFollowsForInRuleRecovery(tokType:Function, tokIdxInRule):Function[] {
            if (this.calculateInRuleFollowsByFullContext) {
                var pathRuleStack:string[] = _.clone(this.RULE_STACK);
                var pathOccurrenceStack:number[] = _.clone(this.RULE_OCCURRENCE_STACK);
                var grammarPath:any = {
                    ruleStack: pathRuleStack,
                    occurrenceStack: pathOccurrenceStack,
                    lastTok: tokType,
                    lastTokOccurrence: tokIdxInRule
                };

                var topRuleName = _.first(pathRuleStack);
                var gastProductions = this.getGAstProductions();
                var topProduction = gastProductions.get(topRuleName);
                var follows = new interp.NextPossibleTokensWalker(topProduction, grammarPath).startWalking();
                return follows;
            }
            else {
                var followName = tok.getTokName(tokType) + tokIdxInRule + IN + _.last(this.RULE_STACK);
                var preComputedFollows = this.getInruleFollowSet().get(followName);
                return _.isArray(preComputedFollows) ? preComputedFollows : [];
            }
        }

        /**
         * must override this in actual Recognizer implementations.
         * This is because each grammar has its own productions and these should probably be static
         * as they only need to be computed once.
         */
        getGAstProductions():IHashtable<string, gast.TOP_LEVEL> {
            return new Hashtable<string, gast.TOP_LEVEL>();
        }

        /*
         * Returns an "imaginary" Token to insert when Single Token Insertion is done
         * Override this if you require special behavior in your grammar
         * for example if an IntegerToken is required provide one with the image '0' so it would be valid syntactically
         */
        getTokenToInsert(tokType:Function):tok.Token {
            return new (<any>tokType)(-1, -1);
        }

        /*
         * By default all tokens type may be inserted. This behavior may be overridden in inheriting Recognizers
         * for example: One may decide that only punctuation tokens may be inserted automatically as they have no additional
         * semantic value. (A mandatory semicolon has no additional semantic meaning, but an Integer may have additional meaning
         * depending on its int value and context (Inserting an integer 0 in cardinality: "[1..]" will cause semantic issues
         * as the max of the cardinality will be greater than the min value. (and this is a false error!)
         */
        canTokenTypeBeInsertedInRecovery(tokType:Function) {
            return true;
        }

        tryInRuleRecovery(expectedTokType:Function, follows:Function[]):tok.Token {
            if (this.canRecoverWithSingleTokenInsertion(expectedTokType, follows)) {
                var tokToInsert = this.getTokenToInsert(expectedTokType);
                tokToInsert.isInserted = true;
                return tokToInsert;

            }

            if (this.canRecoverWithSingleTokenDeletion(expectedTokType)) {
                var nextTok = this.SKIP_TOKEN();
                this.inputIdx++;
                return nextTok;
            }

            throw new InRuleRecoveryException("sad sad panda");
        }

        canPerformInRuleRecovery(expectedToken:Function, follows:Function[]):boolean {
            return this.canRecoverWithSingleTokenInsertion(expectedToken, follows) ||
                this.canRecoverWithSingleTokenDeletion(expectedToken);
        }

        canRecoverWithSingleTokenInsertion(expectedTokType:Function, follows:Function[]):boolean {
            if (!this.canTokenTypeBeInsertedInRecovery(expectedTokType)) {
                return false;
            }

            // must know the possible following tokens to perform single token insertion
            if (_.isEmpty(follows)) {
                return false;
            }

            var mismatchedTok = this.NEXT_TOKEN();
            var isMisMatchedTokInFollows = _.find(follows, (possibleFollowsTokType:Function)=> {
                    return mismatchedTok instanceof possibleFollowsTokType;
                }) !== undefined;

            return isMisMatchedTokInFollows;
        }

        canRecoverWithSingleTokenDeletion(expectedTokType:Function):boolean {
            var isNextTokenWhatIsExpected = this.LA(2) instanceof expectedTokType;
            return isNextTokenWhatIsExpected;
        }

        isInCurrentRuleReSyncSet(token:Function):boolean {
            var currentRuleReSyncSet = _.last(this.FOLLOW_STACK);
            return _.contains(currentRuleReSyncSet, token);
        }

        findReSyncTokenType():Function {
            var allPossibleReSyncTokTypes = _.flatten(this.FOLLOW_STACK);
            // this loop will always terminate as EOF is always in the follow stack and also always (virtually) in the input
            var nextToken = this.NEXT_TOKEN();
            var k = 2;
            while (true) {
                var nextTokenType:any = (<any>nextToken).constructor;
                if (_.contains(allPossibleReSyncTokTypes, nextTokenType)) {
                    return nextTokenType;
                }
                nextToken = this.LA(k);
                k++;
            }
        }

        reSyncTo(tokType:Function):void {
            var nextTok = this.NEXT_TOKEN();
            while ((nextTok instanceof tokType) === false) {
                nextTok = this.SKIP_TOKEN();
            }
        }

        private definedRulesNames:string[] = [];

        /**
         * @param ruleFuncName name of the Grammar rule
         * @throws Grammar validation errors if the name is invalid
         */
        private validateRuleName(ruleFuncName:string):void {
            if (ruleFuncName.length < 1) {
                throw Error("INVALID GRAMMAR RULE FUNCTION NAME must be at least 6 chars long --> " + ruleFuncName);
            }
            if (_.contains(this.definedRulesNames, ruleFuncName)) {
                throw Error("CAN'T HAVE TWO RULES WITH THE SAME NAME" + ruleFuncName);
            }

            if (ruleFuncName.indexOf("_") !== -1) {
                throw Error("CAN'T USE UNDERSCORE '_' IN RULE NAME" + ruleFuncName);
            }
            this.definedRulesNames.push(ruleFuncName);
        }

        RULE_NO_RESYNC<T>(ruleName:string, consumer:()=>T, invalidRet:()=>T):(idxInCallingRule:number,
                                                                              isEntryPoint?:boolean)=>T {
            return this.RULE(ruleName, consumer, invalidRet, false);
        }

        RULE<T>(ruleName:string, consumer:()=>T, invalidRet:()=>T, doReSync = true):(idxInCallingRule:number,
                                                                                     isEntryPoint?:boolean)=>T {

            this.validateRuleName(ruleName);

            var wrappedGrammarRule = function (idxInCallingRule:number = 1, isEntryPoint?:boolean) {
                // state update
                // first rule invocation
                if (_.isEmpty(this.RULE_STACK)) {
                    // the only thing that can appear after the outer most invoked rule is the END OF FILE
                    this.FOLLOW_STACK.push([EOF]);
                } else {
                    var followName = ruleName + idxInCallingRule + IN + _.last(this.RULE_STACK);
                    var followSet = this.getResyncFollowSet().get(followName);
                    if (!followSet) {
                        // always insert an empty set if we have no other information
                        // this will maintain the valid structure of the FOLLOW_STACK and at worse will cause
                        // reSync at top most rule for EOF token
                        followSet = [];
                    }
                    this.FOLLOW_STACK.push(followSet);
                }
                this.RULE_OCCURRENCE_STACK.push(idxInCallingRule);
                this.RULE_STACK.push(ruleName);

                try {
                    // actual parsing happens here
                    return consumer.call(this);
                } catch (e) {
                    var isFirstInvokedRule = (this.RULE_STACK.length === 1);
                    // note the reSync is always enabled for the first rule invocation, because we must always be able to
                    // reSync with EOF and just output some INVALID ParseTree
                    // during backtracking reSync recovery is disabled, otherwise we can't be certain the backtracking
                    // path is really the most valid one
                    var reSyncEnabled = (isFirstInvokedRule || doReSync) && _.isEmpty(this.isBackTrackingStack);

                    if (reSyncEnabled && isRecognitionException(e)) {
                        var reSyncTokType = this.findReSyncTokenType();
                        if (this.isInCurrentRuleReSyncSet(reSyncTokType)) {
                            this.reSyncTo(reSyncTokType);
                            return invalidRet();
                        }
                        else {
                            // to be handled farther up the call stack
                            throw e;
                        }
                    }
                    else {
                        // some other Error type which we don't know how to handle (for example a built in JavaScript Error)
                        throw e;
                    }
                }
                finally {
                    this.FOLLOW_STACK.pop();
                    this.RULE_STACK.pop();
                    this.RULE_OCCURRENCE_STACK.pop();

                    var maxInputIdx = this.input.length - 1;
                    if (isEntryPoint && this.inputIdx < maxInputIdx) {
                        var firstRedundantTok:tok.Token = this.NEXT_TOKEN();
                        this.SAVE_ERROR(
                            new NotAllInputParsedException(
                                "Redundant input, expecting EOF but found: " + firstRedundantTok.image, firstRedundantTok));
                    }
                }
            };
            var ruleNamePropName = 'ruleName';
            wrappedGrammarRule[ruleNamePropName] = ruleName;
            return wrappedGrammarRule;
        }
    }
}
