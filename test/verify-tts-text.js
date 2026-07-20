// Unit checks for the /api/tts speech normalizer. Run from anywhere:
//   node test/verify-tts-text.js
// The persona writes numbers and addresses in written form so transcripts read
// correctly; sanitizeText is what turns them into speech. Exits non-zero on any
// failed check.
const path = require('path');

let fails = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
    fails++;
  }
};

(async () => {
  const { sanitizeText } = await import(
    'file://' + path.join(__dirname, '..', 'api', 'tts.js'));
  const s = sanitizeText;

  // Money: the reading the persona used to spell out by hand.
  check('price', s('Sprint, from $2,950, one feature.'),
    'Sprint, from two thousand nine hundred fifty dollars, one feature.');
  check('price range', s('$6,500 to $9,500 by scope'),
    'six thousand five hundred dollars to nine thousand five hundred dollars by scope');
  check('monthly price', s('from $249 a month'), 'from two hundred forty nine dollars a month');
  check('singular dollar', s('$1 today'), 'one dollar today');

  // Percentages and plain counts.
  check('percent', s('a 71% efficiency gain'), 'a seventy one percent efficiency gain');
  check('percent overload', s('a 50% course overload'), 'a fifty percent course overload');
  check('count', s('delivered in 5 working days'), 'delivered in five working days');
  check('hours', s('within 48 hours'), 'within forty eight hours');
  check('two counts', s('from 7 hours to under 2'), 'from seven hours to under two');

  // Years read in pairs, never as cardinals.
  check('year', s('graduated 2026'), 'graduated twenty twenty six');
  check('year span', s('December 2021 to May 2023'),
    'December twenty twenty one to May twenty twenty three');
  check('year 2000s', s('in 2005'), 'in two thousand five');
  check('year 2000', s('in 2000'), 'in two thousand');

  // Grouped thousands are a quantity, not a year.
  check('grouped quantity', s('1,200 hours'), 'one thousand two hundred hours');

  // Digits welded to letters are left alone for the engine to spell out.
  check('alphanumeric', s('over Google Analytics GA4'), 'over Google Analytics GA4');
  check('ordinal', s('the 1st of many'), 'the 1st of many');

  // Version numbers and decimals.
  check('version', s('built on Next.js 16'), 'built on Next.js sixteen');
  check('decimal', s('about 2.5 days'), 'about two point five days');

  // Digit ranges span rather than pause.
  check('hyphen range', s('7-14 working days'), 'seven to fourteen working days');

  // Regressions: the address rules must still fire, and must not be disturbed
  // by number handling running after them.
  check('email', s('reach me@alexrussell.io'), 'reach me at alexrussell dot io');
  check('domain path', s('see atvora.com/sample'), 'see atvora dot com slash sample');
  check('hyphen domain', s('linkedin.com/in/alexrussell-tech'),
    'linkedin dot com slash in slash alexrussell dash tech');
  check('markdown stripped', s('**bold** text'), 'bold text');
  check('em dash', s('fast — and secure'), 'fast, and secure');

  // Symbols the persona now writes in their written form.
  check('grade', s('Web Architectures A+, Relational Databases A'),
    'Web Architectures A plus, Relational Databases A');
  check('plus plus', s('written in C++ mostly'), 'written in C plus plus mostly');
  check('bit depth', s('a tiny 8-bit Alexander'), 'a tiny eight-bit Alexander');

  // Money with cents says the unit in the right place.
  check('cents', s('costs $1.50 each'), 'costs one dollar fifty each');
  check('cents on a big price', s('$2,950.50 total'),
    'two thousand nine hundred fifty dollars fifty total');
  check('zero cents', s('$20.00 flat'), 'twenty dollars flat');
  check('nickel cents', s('$1.05 each'), 'one dollar five each');

  // More than two decimals is not a price; truncating would speak a wrong
  // amount, so the whole token is left for the engine.
  check('over-precise money left alone', s('costs $1.999 each'), 'costs $1.999 each');

  // Numbers welded to letters are left whole rather than half-converted. The
  // lookahead has to block both the grouped and the decimal branch, or the
  // optional group is dropped and only the head converts ("two,950kg").
  check('grouped welded to letters', s('weighs 2,950kg dry'), 'weighs 2,950kg dry');
  check('decimal welded to letters', s('weighs 2.5kg dry'), 'weighs 2.5kg dry');
  check('grouped decimal welded', s('weighs 2,950.50kg dry'), 'weighs 2,950.50kg dry');
  check('multi-part version left alone', s('on version 2.0.0 now'), 'on version 2.0.0 now');

  // The guards must not swallow a figure that simply ends a sentence.
  check('price at sentence end', s('It costs $2,950. Next question.'),
    'It costs two thousand nine hundred fifty dollars. Next question.');
  check('year at sentence end', s('delivered in 2026. Next.'),
    'delivered in twenty twenty six. Next.');

  // Beyond the named scales, leave it for the engine rather than say "undefined".
  check('overflow left alone', s('2,000,000,000,000 rows'), '2,000,000,000,000 rows');
  check('largest named scale', s('999,000,000,000 rows'),
    'nine hundred ninety nine billion rows');

  // Whole-persona sweep: every figure in the knowledge base must have a spoken
  // form, so nothing the agent quotes verbatim can reach the voice as a raw
  // digit. Catches a future knowledge-base edit that adds an unspeakable one.
  const { SYSTEM_PROMPT } = await import(
    'file://' + path.join(__dirname, '..', 'api', '_persona.js'));
  // Only bare numerals count. Digits welded into a proper noun (n8n, CS50) are
  // deliberately left for the engine to spell out letter by letter.
  const leftover = s(SYSTEM_PROMPT).match(/(?<![A-Za-z0-9])\$?\d[\d,.]*%?(?![A-Za-z0-9])/g) || [];
  check('persona has no unspoken digits', leftover.join(' ') || '(none)', '(none)');

  console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
  process.exit(fails ? 1 : 0);
})();
