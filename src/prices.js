/* Price Lens: finds prices in text read off a price tag.
 *
 * The camera's text reader (OCR) hands over lines of text, each with the height of its letters.
 * This file turns those lines into prices: an amount, a currency, and how sure we are of both.
 * It runs on its own, without the page, so the tests can feed it text directly. */

/* Marks that name a currency. Several marks are shared (the dollar sign, "kr", the yen sign);
   for those the list holds every currency that uses it, most common first. The local currency
   the person has chosen wins when it is in the list. Longer marks are matched before shorter
   ones, so "US$" is never read as "$". */
export const MARKS = {
  'US$': ['USD'], 'U$S': ['USD'], 'USD$': ['USD'],
  'C$': ['CAD'], 'CA$': ['CAD'], 'CAN$': ['CAD'],
  'A$': ['AUD'], 'AU$': ['AUD'],
  'NZ$': ['NZD'], 'HK$': ['HKD'], 'S$': ['SGD'], 'NT$': ['TWD'], 'MX$': ['MXN'],
  'R$': ['BRL'], 'RD$': ['DOP'], 'J$': ['JMD'], 'TT$': ['TTD'], 'B$': ['BND'],
  '$': ['USD', 'CAD', 'AUD', 'NZD', 'MXN', 'HKD', 'SGD', 'TWD', 'ARS', 'CLP', 'COP'],
  '€': ['EUR'], '£': ['GBP'], 'E£': ['EGP'],
  '¥': ['JPY', 'CNY'], '￥': ['JPY', 'CNY'], 'JP¥': ['JPY'], 'CN¥': ['CNY'],
  '円': ['JPY'], '元': ['CNY'], 'RMB': ['CNY'], '₩': ['KRW'], '원': ['KRW'],
  '₹': ['INR'], 'Rs.': ['INR', 'PKR', 'LKR', 'NPR'], 'Rs': ['INR', 'PKR', 'LKR', 'NPR'],
  '₽': ['RUB'], 'руб': ['RUB'], '₺': ['TRY'], 'TL': ['TRY'], '₪': ['ILS'],
  '₫': ['VND'], '฿': ['THB'], '₱': ['PHP'], '₴': ['UAH'], '₦': ['NGN'], '₡': ['CRC'],
  '₲': ['PYG'], '₵': ['GHS'], '₸': ['KZT'], '₼': ['AZN'], '₾': ['GEL'],
  'zł': ['PLN'], 'zl': ['PLN'], 'Kč': ['CZK'], 'Kc': ['CZK'], 'Ft': ['HUF'],
  'lei': ['RON'], 'лв': ['BGN'], 'kn': ['HRK'],
  'kr.': ['DKK', 'SEK', 'NOK', 'ISK'], 'kr': ['SEK', 'NOK', 'DKK', 'ISK'],
  ':-': ['SEK'],
  'Fr.': ['CHF'], 'SFr.': ['CHF'], 'SFr': ['CHF'],
  'RM': ['MYR'], 'Rp': ['IDR'], 'Rp.': ['IDR'], 'S/': ['PEN'], 'S/.': ['PEN'],
  'Dhs': ['AED'], 'Dh': ['AED', 'MAD'], 'د.إ': ['AED'], '﷼': ['SAR', 'IRR', 'OMR', 'QAR', 'YER'],
  'Bs': ['BOB'], 'Q': ['GTQ'], 'R': ['ZAR'],
};

/* Currencies whose prices have no minor unit in everyday use: "1.250" there is one thousand two
   hundred and fifty, never one and a quarter. */
const NO_DECIMALS = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'PYG', 'ISK', 'HUF', 'UGX', 'COP', 'IRR', 'KHR', 'LAK', 'MMK', 'TWD']);
/* ...and of those, the ones whose everyday prices run to five digits or more */
const LONG_PRICES = new Set(['KRW', 'VND', 'IDR', 'CLP', 'PYG', 'UGX', 'COP', 'IRR', 'KHR', 'LAK', 'MMK']);
/* and the few with three decimal places */
const THREE_DECIMALS = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD']);

/* Marks that are a single letter (R, Q) are only trusted before the number, never after it. */
const WEAK_MARKS = new Set(['R', 'Q']);
/* Marks that are also ordinary letters or abbreviations ("Ft" is feet, "RM" a room, "S/M" a size,
   a stray "R" is OCR noise). They only count where that currency is the local one; elsewhere the
   number is read as if it had no mark. */
const LOCAL_ONLY = new Set(['R', 'Q', 'Rs', 'Rs.', 'TL', 'Dh', 'Dhs', 'Bs', 'Fr.', 'kn', 'lei', 'Ft', 'RM',
  'S/', 'S/.', 'zl', 'Kc', ':-', 'Rp', 'Rp.', 'kr', 'kr.', 'B$', 'J$']);

/* The pound sign is also what the reader makes of smudges and of other signs: it turns up on tags in
   Mexico, Sweden and Taiwan. It only counts where the pound is the local currency, or none is known. */
const SMUDGE_MARKS = new Set(['£']);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const markList = Object.keys(MARKS).sort((a, b) => b.length - a.length);

/* A number as it appears on a tag: 4.99, 1,299.00, 1.299,00, 1 299, 12'500, 3,-, 980 */
const NUM = String.raw`\d{1,3}(?:[.,    '’]\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?`;
const DASH_END = String.raw`(?:[.,][-–—]{1,2})?`; // "12,-" and "12.–" mean twelve, no cents

/* ISO codes are matched as any three capital letters next to a number. Only these common codes count,
   plus the local currency's own code: many other codes are also English words printed on packs in
   capitals (ALL, TOP, CUP, PEN, GEL, MAD, BOB), and would turn "PEN 2" into Peruvian soles. */
const COMMON_CODES = new Set(('USD EUR JPY GBP CNY AUD CAD CHF HKD SGD SEK NOK DKK ISK NZD KRW INR MXN BRL ZAR TRY ' +
  'RUB PLN CZK HUF RON BGN ILS AED SAR QAR KWD BHD OMR JOD EGP TND THB VND IDR MYR PHP TWD PKR LKR NPR ' +
  'BDT ARS CLP COP UYU PYG CRC GTQ DOP JMD TTD UAH KZT AZN NGN GHS KES TZS UGX ETB XOF XAF RSD').split(' '));

/* Text right after the number that means it is not a price: a weight, a volume, a percentage, a time, a count. */
const NOT_PRICE_AFTER = /^\s?(?:%|kg\b|g\b|gr\b|mg\b|lbs?\b|oz\b|ml\b|cl\b|l\b|ltr\b|cm\b|mm\b|m\b|km\b|pcs\b|pc\b|pk\b|x\b|st\b|stk\b|h\b|min\b|°|:\d|\/\d|[-./]\d{1,2}[-./]\d)/i;
/* a weight, volume, length or percentage */
const MEASURE_AFTER = /^\s?(?:%|°|(?:kg|g|gr|mg|lbs?|oz|ml|cl|l|ltr|cm|mm|m|km)\b)/i;
const NOT_PRICE_BEFORE = /(?:(?:№|#|no\.?|ref\.?|tel\.?|\+|\d[-./:]|\d\s?[x×])\s?|art[.,]?\s*)$/i;

/* Common misreadings inside numbers: O for 0, l or I for 1, S for 5, B for 8 — only between digits
   or right after a currency mark, so ordinary words are left alone. */
function cleanDigits(text) {
  return text
    .replace(/(?<=\d)[Oo](?=[\d.,]|\b)/g, '0')
    .replace(/(?<=[\d.,])[Oo](?=\d)/g, '0')
    .replace(/(?<=\d[.,]?)[lI|](?=\d)/g, '1')
    .replace(/(?<=\d)[S](?=\d)/g, '5')
    .replace(/(?<=\d)[B](?=\d)/g, '8')
    .replace(/[，]/g, ',').replace(/[．]/g, '.')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFF10 + 48));
}

/* Reads the digits of one price. The currency, when known, settles "1.250" (thousands or decimals). */
export function readAmount(raw, currency) {
  let s = raw.replace(/[.,][-–—]{1,2}$/, '').replace(/[    '’]/g, (c) => '_');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let decimal = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = s.split(sep).length - 1;
    const after = s.length - s.lastIndexOf(sep) - 1;
    if (count > 1) decimal = null; // 1.234.567
    else if (after === 3) decimal = currency && THREE_DECIMALS.has(currency) ? sep : null; // 1,250
    else decimal = currency && NO_DECIMALS.has(currency) && after !== 2 ? null : sep; // 4.99, 3.5
  }
  let whole = s, frac = '';
  if (decimal) {
    const i = s.lastIndexOf(decimal);
    whole = s.slice(0, i);
    frac = s.slice(i + 1);
  }
  whole = whole.replace(/[_.,]/g, '');
  const value = Number(whole + (frac ? '.' + frac : ''));
  return Number.isFinite(value) ? value : null;
}

/* The currency a mark stands for, given the person's local currency. */
export function resolveMark(mark, local) {
  const list = MARKS[mark];
  if (!list) return null;
  if (local && list.includes(local)) return local;
  return list[0];
}

const MARK_RE = markList.map(escape).join('|');
const BEFORE_RE = new RegExp(`(?:(?<mark>${MARK_RE})|(?<code>\\b[A-Z]{3}\\b))\\s?$`, 'u');
const AFTER_RE = new RegExp(`^\\s?(?:(?<mark>${MARK_RE})|(?<code>[A-Z]{3}\\b))`, 'u');

/* How the English text reader reads signs it does not know, or reads poorly: ₹ comes out as ¥, X, % or <,
   ฿ as B or $, 円 as M, H or F, zł as zi, zt or 21, Kč as Ke, K¢ or K&, CHF as HF. A tag is nearly always
   priced in the currency of the country it is in, so where that currency is the local one these count as
   its sign. Elsewhere they mean nothing ("5 M" is a size, "X 2" a count). */
const LOOKALIKES = {
  INR: { before: ['¥', 'X', '%', '<'] },
  THB: { before: ['B', '$'] },
  JPY: { after: ['PJ', 'FJ', 'M', 'H', 'F'] },
  PLN: { after: ['zi', 'zt', 'z1', 'z!', 'z|', 'z}', 'z]', 'Zt', 'Zl', 'Zi', 'zr', '7}', '21', 'z'] },
  CZK: { after: ['Ke', 'KE', 'KC', 'K¢', 'K&', 'Ké', 'Kè', 'kK', 'K'] },
  EUR: { before: ['£', 'E', 'C'], after: ['£', 'E', 'C', 'e'] },
  GBP: { before: ['E', 'f'] },
  CHF: { before: ['CHE', 'GHF', 'HF', 'F'] },
  SEK: { after: [': -', ':=', ';-', ':.', ':'] },
  NOK: { after: ['Kr', 'KR', 'kK'] },
  DKK: { after: ['Kr', 'KR', 'kK'] },
};
for (const l of Object.values(LOOKALIKES)) for (const side of ['before', 'after']) l[side]?.sort((a, b) => b.length - a.length);

/* Currencies with a minor unit that tags mostly leave out: Indian rupees, Thai baht, Swedish kronor ("49:-"). */
const WHOLE_ON_TAGS = new Set(['INR', 'THB', 'SEK', 'PKR', 'LKR', 'NPR', 'BDT']);
/* whether tags in this currency normally show the cents (4,99 €) */
const showsCents = (currency) => !NO_DECIMALS.has(currency) && !WHOLE_ON_TAGS.has(currency);
const WITH_CENTS = /[.,](?:\d{2}|[-–—]{1,2})$/;

/* What small raised cents become when the reader cannot make them out: 98⁹⁵ zł is read as "98% zł",
   541⁹⁹ as "541°", 24⁷⁹ as "24”", 38.89 as "38.8¢". */
const GARBLED_CENTS = /^[%°º”“"»™*^'’`¢+¹²³⁰-⁹]/;

/* A price per kilo, per litre or per 100 g ("4,99 €/kg", "$12.07 per 100g", "1 l = 1,19 €") is
   never the price to pay, even when its sign was read better than the big one's. */
const UNIT_AFTER = /^\s*(?:\/\s?(?:\d+\s?)?(?:kg|g|gr|l|ltr|ml|cl|lb|oz|m|[1I|])(?!\p{L})|\/\s?100|per\b|je\b|pro\b|par\b|kg\b|lb\b)/iu;
const UNIT_BEFORE = /\d\s?(?:kg|g|l|ml|cl|lb|oz)\s?=\s?$/i;

/* Pence and cents written as such: "75p" in Britain, "79¢" where the dollar is used. */
const CENT_SIGNS = /^\s?(?<sign>¢|p)(?![\p{L}\d])/u;
const centCurrency = (sign, local) => sign === 'p'
  ? (local === 'GBP' ? 'GBP' : null)
  : (!local ? 'USD' : MARKS.$.includes(local) && showsCents(local) ? local : null);

/* Cents the reader split off with a space: "€17, 79", "$40 .50", "182, 00 kr". Only on a line with a
   currency sign, or the biggest text on the tag; elsewhere "sizes 38, 40" is a list. The price itself,
   printed with small raised cents, can also come out as two numbers, "17 19" or "CHF 44 89"; that is read
   as one price only when it is all the line says. */
const SPLIT_SEPARATOR = /(\d+)(?:([.,])\s+|\s+([.,]))(\d{2})(?!\d)/g;
function joinCents(text, local, big) {
  if (local && !showsCents(local)) return text;
  const { signBefore, signAfter, splitWhole } = patternsFor(local);
  const signed = (at, length) => signBefore.test(text.slice(0, at)) || signAfter.test(text.slice(at + length));
  text = text.replace(SPLIT_SEPARATOR, (all, whole, sep1, sep2, cents, at) =>
    (big || signed(at, all.length) ? whole + (sep1 || sep2) + cents : all));
  const w = text.trim().match(splitWhole);
  if (w && (big || w[2] || w[5])) text = `${w[1]}${w[2] || ''}${w[3]}.${w[4]}${w[5] || ''}${w[6]}`;
  return text;
}

/* the patterns that depend on the local currency (its misread signs), made once for each */
const patterns = new Map();
function patternsFor(local) {
  if (!patterns.has(local)) {
    const lookalikes = LOOKALIKES[local] || {};
    const signs = [MARK_RE, '\\b[A-Z]{3}\\b', ...[...(lookalikes.before || []), ...(lookalikes.after || [])].map(escape)].join('|');
    patterns.set(local, {
      signBefore: new RegExp(`(?:^|[^\\p{L}])(?:${signs})\\s?$`, 'u'),
      signAfter: new RegExp(`^\\s?(?:${signs})(?!\\p{L})`, 'u'),
      /* a whole price and its cents, with stray marks around it ("*49 99", "259 50 K¢&") */
      splitWhole: new RegExp(`^([^\\p{L}\\d]?)((?:${signs})\\s?)?([1-9]\\d{0,3}) (\\d{2})(\\s?(?:${signs}))?([^\\p{L}\\d]?)$`, 'u'),
    });
  }
  return patterns.get(local);
}

/* A sign misread as letters, right before or right after the number: "X 1,993", "570M", "96,19 zi". */
function lookalikeBefore(text, start, signs = []) {
  const head = text.slice(0, start);
  for (const sign of signs) {
    const at = head.endsWith(sign + ' ') ? start - sign.length - 1 : head.endsWith(sign) ? start - sign.length : -1;
    if (at < 0) continue;
    /* not the tail of a word, and not the "X" of "6 X 125 g" */
    if (/[\p{L}\d]/u.test(text[at - 1] || '') || /\d\s?$/.test(text.slice(0, at))) continue;
    return { sign, markText: text.slice(at, start) };
  }
  return null;
}
function lookalikeAfter(text, end, signs = []) {
  for (const sign of signs) {
    const gap = text.startsWith(' ' + sign, end) ? 1 : 0;
    if (!text.startsWith(sign, end + gap)) continue;
    /* not the start of a word or number: "5 Hz", "12 Mio", "12:30" */
    if (/[\p{L}\d]/u.test(text[end + gap + sign.length] || '')) continue;
    return { sign, markText: text.slice(end, end + gap + sign.length) };
  }
  return null;
}

/* Finds every price in one line of text.
 * options.local: the currency to assume when the tag shows none, and to settle shared marks ($, kr, ¥).
 * options.codes: the currency codes there are rates for; codes outside it are not read as currencies.
 * options.big: the line is the biggest text on the tag, so a price split in two there is put back together. */
export function findPricesInLine(line, options = {}) {
  const { local = null } = options;
  const known = options.codes ? new Set(options.codes) : null;
  const codes = new Set([...COMMON_CODES, ...(local ? [local] : [])].filter((c) => !known || known.has(c)));
  const lookalikes = LOOKALIKES[local] || {};
  const isLocal = (word) => !local || MARKS[word].includes(local) || [lookalikes.before, lookalikes.after].some((l) => l?.includes(word));
  const markOk = (word) => (!LOCAL_ONLY.has(word) || (local && MARKS[word].includes(local))) && (!SMUDGE_MARKS.has(word) || isLocal(word));
  const text = joinCents(cleanDigits(line), local, !!options.big);
  const found = [];
  const numRe = new RegExp(`(?<![\\d.,])(?:${NUM})${DASH_END}(?![\\d])`, 'g');
  let m;
  while ((m = numRe.exec(text))) {
    const raw = m[0];
    const start = m.index, end = start + raw.length;
    const before = text.slice(Math.max(0, start - 6), start);
    const after = text.slice(end, end + 6);

    let currency = null, mark = null, side = null, markText = '';
    const b = before.match(BEFORE_RE);
    if (b) {
      const word = b.groups.mark || b.groups.code;
      const markStart = start - b[0].length;
      /* a mark that is the tail of a longer word ("Paris 12" is not R12, "Prs 5" is not Rs 5) does not count */
      const glued = markStart > 0 && /[\p{L}]/u.test(text[markStart - 1]);
      if (!glued && b.groups.mark && markOk(word)) { mark = word; }
      else if (!glued && b.groups.code && codes.has(word)) { mark = word; currency = word; }
      if (mark) { side = 'before'; markText = b[0]; }
    }
    if (!mark) {
      const a = after.match(AFTER_RE);
      if (a) {
        const word = a.groups.mark || a.groups.code;
        const nextChar = text[end + a[0].length] || '';
        /* "12 kroner" is a word that starts like a mark; a mark is only a mark when the word ends there.
           And in "9 £13.19" the sign belongs to the number it touches. */
        const runsOn = (/[\p{L}]/u.test(nextChar) && !/[.$]$/.test(word)) || (/\d/.test(nextChar) && /^\s/.test(a[0]));
        if (!runsOn && a.groups.mark && !WEAK_MARKS.has(word) && markOk(word)) { mark = word; }
        else if (!runsOn && a.groups.code && codes.has(word)) { mark = word; currency = word; }
        if (mark) { side = 'after'; markText = a[0]; }
      }
    }
    if (mark && !currency) currency = resolveMark(mark, local);

    /* the local sign misread: as another currency's sign (¥ for ₹ in India), or as letters */
    let lookalike = !!mark && currency !== local && !!lookalikes[side]?.includes(mark);
    if (!mark) {
      const l = lookalikeBefore(text, start, lookalikes.before);
      const r = l ? null : lookalikeAfter(text, end, lookalikes.after);
      if (l || r) {
        ({ sign: mark, markText } = l || r);
        side = l ? 'before' : 'after';
        lookalike = true;
      }
    }
    if (lookalike) {
      /* A misread sign is weaker than a real one, so the number has to look like a whole price by
         itself: two digits or more, its cents where the currency has cents ("12,50 E" is euros, "12 E"
         is not), and no weight or size after it ("< 500 g" is not ₹500). */
      const measured = side === 'before' && MEASURE_AFTER.test(after);
      if (raw.replace(/\D/g, '').length >= 2 && (!showsCents(local) || WITH_CENTS.test(raw)) && !measured) currency = local;
      else { mark = null; side = null; markText = ''; currency = null; lookalike = false; }
    }

    if (!mark && /^\d{1,2}$/.test(raw)) {
      const c = after.match(CENT_SIGNS);
      const cur = c && centCurrency(c.groups.sign, local);
      if (cur) {
        found.push({
          amount: Number(raw) / 100, currency: cur, explicit: true, shared: false, mark: c.groups.sign, side: 'after', unit: false,
          text: raw + c[0].trim(), number: raw, index: start,
        });
        continue;
      }
    }

    if (!mark) {
      if (NOT_PRICE_AFTER.test(after) || NOT_PRICE_BEFORE.test(before)) continue;
    }
    const explicit = !!mark;
    if (!currency) currency = local;
    if (!currency || showsCents(currency)) {
      /* The cents are lost: garbled ("98% zł", "541°"), one digit short ("€38,7", "$6.9"), or gone after
         the point ("$40.", the cents read as a line of their own). The rest alone would be a wrong price. */
      const tail = text.slice(end);
      if (/[.,]\d$/.test(raw)) continue;
      if (!WITH_CENTS.test(raw) && (GARBLED_CENTS.test(tail) || /^[.,](?!\s?[\d-–—])/.test(tail))) continue;
    }
    const amount = readAmount(raw, currency);
    if (amount === null || amount <= 0) continue;
    /* "08" is part of a date or a code, and where there are no cents a price is never a single digit ("¥2") */
    if (/^0\d/.test(raw) || (NO_DECIMALS.has(currency) && amount < 10)) continue;
    /* bare numbers that do not look like money: a single digit, or a long run of digits like a barcode */
    if (!explicit) {
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 2 || digits.length > 7) continue;
      /* five digits or more with no separator is an article number or part of a barcode, except where
         everyday prices run that long (₩18990) */
      if (digits.length > 4 && digits === raw && !LONG_PRICES.has(currency)) continue;
      /* where there are no cents, "1.5" or "12.50" is not a price at all */
      if (NO_DECIMALS.has(currency) && /[.,]\d{1,2}$/.test(raw)) continue;
      if (/^(19|20)\d\d$/.test(raw) && !/[.,]/.test(raw)) continue; // a year
      /* a whole number followed by a word counts something: "80 bags", "2 for", "6 pack" */
      if (!/[.,]\d{1,3}$/.test(raw) && /^\s*\p{L}{2,}/u.test(after)) continue;
    }
    /* a misread sign is shown as read ("zi read as PLN"), like a shared one */
    const shared = lookalike || (mark ? (MARKS[mark] || [currency]).length > 1 : false);
    const markEnd = end + (side === 'after' ? markText.length : 0);
    const unit = UNIT_AFTER.test(text.slice(markEnd, markEnd + 12)) || UNIT_BEFORE.test(text.slice(0, start - (side === 'before' ? markText.length : 0)));
    found.push({
      amount, currency, explicit, shared, mark, side, unit,
      text: side === 'before' ? markText + raw : side === 'after' ? raw + markText : raw,
      number: raw, index: start,
    });
    /* a sign made of digits ("21" for zł) is not read again as a number */
    if (side === 'after' && /\d/.test(markText)) numRe.lastIndex = end + markText.length;
  }
  return found;
}

/* Finds the prices on a whole tag and puts the likeliest first.
 * lines: an array of { text, height, bbox?, confidence? } (height: the size of the letters, in any
 * unit; confidence: the reader's 0–100), or plain text.
 * options.center: { x, y, reach } in bbox units: where the person is aiming. Prices near it rank higher.
 *
 * The likeliest price is the one in the biggest letters, with a currency mark, near the middle of the
 * box. A number with no mark has to look like money to be kept at all: cents in the local style, or
 * the biggest text on the tag, or (for currencies without cents, like yen) a number of 10 or more. */
export function findPrices(lines, options = {}) {
  if (typeof lines === 'string') lines = lines.split(/\r?\n/).map((text) => ({ text, height: 1 }));
  const { local = null, center = null } = options;
  const all = [];
  const tallest = Math.max(1, ...lines.map((l) => l.height || 1));
  const noCents = local && NO_DECIMALS.has(local);
  lines.forEach((line, lineIndex) => {
    const confidence = line.confidence ?? 100;
    const size = (line.height || 1) / tallest;
    for (const p of findPricesInLine(line.text || '', { ...options, big: size >= 0.8 })) {
      const hasCents = /[.,]\d{2}$/.test(p.number);
      if (!p.explicit) {
        const moneyLike = (hasCents && !noCents) || size >= 0.8 || (noCents && p.amount >= 10);
        if (!moneyLike || confidence < 50) continue;
      } else if (confidence < 30) continue;
      /* Small print (unit prices, old prices) shows its cents. Without them, a lone digit next to a sign
         is a fragment ("1 € per kg"), and a long number has lost its decimal point ("€5787/100 g"). */
      if (p.explicit && size < 0.5 && showsCents(p.currency) && !hasCents && /^(?:\d|\d{4,})$/.test(p.number)) continue;
      let near = 0;
      if (center && line.bbox) {
        const cx = (line.bbox.x0 + line.bbox.x1) / 2, cy = (line.bbox.y0 + line.bbox.y1) / 2;
        near = Math.max(0, 1 - Math.hypot(cx - center.x, cy - center.y) / center.reach);
      }
      p.score = size * 2 + (p.explicit ? 1.5 : 0) + (hasCents ? 0.3 : 0) - (p.shared ? 0.1 : 0) - (p.unit ? 1 : 0) + near * 0.8 + confidence / 200;
      p.line = lineIndex;
      p.bbox = line.bbox || null;
      all.push(p);
    }
  });
  /* the same price read twice (e.g. "€4.99" and "4.99" on another line) is kept once, the better reading */
  all.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return all.filter((p) => {
    const key = p.amount.toFixed(3);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* A short name for a price that stays the same from one camera frame to the next. */
export const priceKey = (p) => `${p.currency} ${p.amount.toFixed(2)}`;

/* A first guess at the person's own currency, from the region in the browser's language (en-US → USD). */
export const REGION_CURRENCY = {
  US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR',
  NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR',
  LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR', JP: 'JPY', CN: 'CNY', KR: 'KRW', IN: 'INR', MX: 'MXN',
  BR: 'BRL', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', IS: 'ISK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON',
  BG: 'BGN', TR: 'TRY', RU: 'RUB', UA: 'UAH', IL: 'ILS', AE: 'AED', SA: 'SAR', ZA: 'ZAR', EG: 'EGP', TH: 'THB',
  VN: 'VND', ID: 'IDR', MY: 'MYR', PH: 'PHP', SG: 'SGD', HK: 'HKD', TW: 'TWD', AR: 'ARS', CL: 'CLP', CO: 'COP',
  PE: 'PEN', NG: 'NGN', KE: 'KES', PK: 'PKR', BD: 'BDT', LK: 'LKR', MA: 'MAD',
};

export function currencyForLanguage(lang) {
  const region = (lang || '').split(/[-_]/).slice(1).find((part) => /^[A-Z]{2}$/i.test(part));
  return (region && REGION_CURRENCY[region.toUpperCase()]) || null;
}
