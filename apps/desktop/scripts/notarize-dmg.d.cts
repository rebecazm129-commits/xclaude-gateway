// Type surface of notarize-dmg.cjs for the test project (tests/notarize-dmg
// .test.ts imports the hook; without this, TS7016 implicit-any). The runtime
// module shape is module.exports.default = hook, which a namespace import
// exposes as the `default` member — hence a default export of the function.
// Second param is the injectable execFileSync (the test's mock seam). Keep in
// sync with notarize-dmg.cjs.
declare function notarizeDmg(buildResult: unknown, execFileSync?: unknown): Promise<string[]>;
export default notarizeDmg;
