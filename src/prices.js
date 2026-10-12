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
/* and the few with three decimal places */
const THREE_DECIMALS = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'LYD', 'IQD']);

/* Marks that are a single letter (R, Q) are only trusted before the number, never after it. */
const WEAK_MARKS = new Set(['R', 'Q']);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const markList = Object.keys(MARKS).sort((a, b) => b.length - a.length);

/* A number as it appears on a tag: 4.99, 1,299.00, 1.299,00, 1 299, 12'500, 3,-, 980 */
const NUM = String.raw`\d{1,3}(?:[.,    '’]\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?`;
const DASH_END = String.raw`(?:[.,][-–—]{1,2})?`; // "12,-" and "12.–" mean twelve, no cents

/* ISO codes are matched as any three capital letters; whether they are a real currency is decided
   by the list of codes the exchange rates know about (or a built-in list when none is given). */
const COMMON_CODES = new Set(('USD EUR JPY GBP CNY AUD CAD CHF HKD SGD SEK NOK DKK ISK NZD KRW INR MXN BRL ZAR TRY ' +
  'RUB PLN CZK HUF RON BGN ILS AED SAR QAR KWD BHD OMR JOD EGP MAD TND THB VND IDR MYR PHP TWD PKR LKR NPR ' +
  'BDT ARS CLP COP PEN UYU BOB PYG CRC GTQ DOP JMD TTD UAH KZT GEL AZN NGN GHS KES TZS UGX ETB XOF XAF ISK HRK').split(' '));

/* Text right after the number that means it is not a price: a weight, a volume, a percentage, a time, a count. */
const NOT_PRICE_AFTER = /^\s?(?:%|kg\b|g\b|gr\b|mg\b|lbs?\b|oz\b|ml\b|cl\b|l\b|ltr\b|cm\b|mm\b|m\b|km\b|pcs\b|pc\b|pk\b|x\b|st\b|stk\b|h\b|min\b|°|:\d|\/\d|[-./]\d{1,2}[-./]\d)/i;
const NOT_PRICE_BEFORE = /(?:№|#|no\.?|art\.?|ref\.?|tel\.?|\+|\d[-./:])\s?$/i;

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

/* Finds every price in one line of text.
 * options.local: the currency to assume when the tag shows none, and to settle shared marks ($, kr, ¥).
 * options.codes: the currency codes to accept (defaults to a built-in list of common ones). */
export function findPricesInLine(line, options = {}) {
  const { local = null } = options;
  const codes = options.codes ? new Set(options.codes) : COMMON_CODES;
  const text = cleanDigits(line);
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
      if (!glued && b.groups.mark) { mark = word; }
      else if (!glued && b.groups.code && codes.has(word)) { mark = word; currency = word; }
      if (mark) { side = 'before'; markText = b[0]; }
    }
    if (!mark) {
      const a = after.match(AFTER_RE);
      if (a) {
        const word = a.groups.mark || a.groups.code;
        const nextChar = text[end + a[0].length] || '';
        /* "12 kroner" is a word that starts like a mark; a mark is only a mark when the word ends there */
        const runsOn = /[\p{L}]/u.test(nextChar) && !/[.$]$/.test(word);
        if (!runsOn && a.groups.mark && !WEAK_MARKS.has(word)) { mark = word; }
        else if (!runsOn && a.groups.code && codes.has(word)) { mark = word; currency = word; }
        if (mark) { side = 'after'; markText = a[0]; }
      }
    }
    if (mark && !currency) currency = resolveMark(mark, local);

    if (!mark) {
      if (NOT_PRICE_AFTER.test(after) || NOT_PRICE_BEFORE.test(before)) continue;
    }
    const explicit = !!mark;
    if (!currency) currency = local;
    const amount = readAmount(raw, currency);
    if (amount === null || amount <= 0) continue;
    /* bare numbers that do not look like money: a single digit, or a long run of digits like a barcode */
    if (!explicit) {
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 2 || digits.length > 7) continue;
      if (/^(19|20)\d\d$/.test(raw) && !/[.,]/.test(raw)) continue; // a year
      /* a whole number followed by a word counts something: "80 bags", "2 for", "6 pack" */
      if (!/[.,]\d{1,3}$/.test(raw) && /^\s?\p{L}{2,}/u.test(after)) continue;
    }
    const shared = mark ? (MARKS[mark] || [currency]).length > 1 : false;
    found.push({
      amount, currency, explicit, shared, mark, side,
      text: side === 'before' ? markText + raw : side === 'after' ? raw + markText : raw,
      index: start,
    });
  }
  return found;
}

/* Finds the prices on a whole tag and puts the likeliest first.
 * lines: an array of { text, height } (height: the size of the letters, in any unit), or plain text.
 * The likeliest price is the one in the biggest letters, with a currency mark if any line has one. */
export function findPrices(lines, options = {}) {
  if (typeof lines === 'string') lines = lines.split(/\r?\n/).map((text) => ({ text, height: 1 }));
  const all = [];
  const tallest = Math.max(1, ...lines.map((l) => l.height || 1));
  lines.forEach((line, lineIndex) => {
    for (const p of findPricesInLine(line.text || '', options)) {
      const size = (line.height || 1) / tallest;
      const hasCents = /[.,]\d{2}$/.test(p.text.replace(/\s?\D+$/, ''));
      p.score = size * 2 + (p.explicit ? 1.5 : 0) + (hasCents ? 0.3 : 0) - (p.shared ? 0.1 : 0);
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
