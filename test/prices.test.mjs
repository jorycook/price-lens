import test from 'node:test';
import assert from 'node:assert/strict';
import { findPrices, findPricesInLine, readAmount, currencyForLanguage } from '../src/prices.js';

const top = (text, local) => {
  const [p] = findPrices(text, { local });
  return p ? [p.amount, p.currency] : null;
};

test('symbols before and after the number', () => {
  assert.deepEqual(top('€12.50'), [12.5, 'EUR']);
  assert.deepEqual(top('12,50 €'), [12.5, 'EUR']);
  assert.deepEqual(top('£3.99'), [3.99, 'GBP']);
  assert.deepEqual(top('¥1,980', 'JPY'), [1980, 'JPY']);
  assert.deepEqual(top('1,980円'), [1980, 'JPY']);
  assert.deepEqual(top('₩12,000'), [12000, 'KRW']);
  assert.deepEqual(top('R$ 49,90'), [49.9, 'BRL']);
  assert.deepEqual(top('US$ 5'), [5, 'USD']);
  assert.deepEqual(top('CHF 12.50'), [12.5, 'CHF']);
  assert.deepEqual(top('12.50 CHF'), [12.5, 'CHF']);
  assert.deepEqual(top('29,90 zł'), [29.9, 'PLN']);
  assert.deepEqual(top('149 Kč'), [149, 'CZK']);
  assert.deepEqual(top('1 290 Ft', 'HUF'), [1290, 'HUF']);
  assert.deepEqual(top('฿120'), [120, 'THB']);
  assert.deepEqual(top('49:-', 'SEK'), [49, 'SEK']);
  assert.deepEqual(top('R25.99', 'ZAR'), [25.99, 'ZAR']);
  assert.deepEqual(top('RM 8.90', 'MYR'), [8.9, 'MYR']);
  assert.deepEqual(top('Rp 15.000', 'IDR'), [15000, 'IDR']);
  assert.deepEqual(top('250 TL', 'TRY'), [250, 'TRY']);
});

test('separators: thousands and decimals in the local styles', () => {
  assert.equal(readAmount('1,234.56'), 1234.56);
  assert.equal(readAmount('1.234,56'), 1234.56);
  assert.equal(readAmount('1 234,56'), 1234.56);
  assert.equal(readAmount("12'500.00"), 12500);
  assert.equal(readAmount('1,250'), 1250);
  assert.equal(readAmount('1.250'), 1250);
  assert.equal(readAmount('4.99'), 4.99);
  assert.equal(readAmount('4,99'), 4.99);
  assert.equal(readAmount('12,-'), 12);
  assert.equal(readAmount('1.234.567'), 1234567);
  assert.equal(readAmount('3.5'), 3.5);
  assert.equal(readAmount('1.250', 'KWD'), 1.25);
  assert.equal(readAmount('12.5', 'JPY'), 125);
});

test('shared marks follow the local currency', () => {
  assert.deepEqual(top('$4.99'), [4.99, 'USD']);
  assert.deepEqual(top('$4.99', 'CAD'), [4.99, 'CAD']);
  assert.deepEqual(top('$4.99', 'MXN'), [4.99, 'MXN']);
  assert.deepEqual(top('¥68', 'CNY'), [68, 'CNY']);
  assert.deepEqual(top('45 kr', 'NOK'), [45, 'NOK']);
  assert.deepEqual(top('45 kr', 'SEK'), [45, 'SEK']);
  assert.deepEqual(top('C$ 4.99', 'USD'), [4.99, 'CAD']);
});

test('a tag without a currency mark uses the local currency', () => {
  assert.deepEqual(top('4.99', 'USD'), [4.99, 'USD']);
  assert.deepEqual(top('298', 'JPY'), [298, 'JPY']);
  const [p] = findPrices('4.99', { local: 'USD' });
  assert.equal(p.explicit, false);
});

test('weights, volumes, percentages, dates and codes are not prices', () => {
  assert.deepEqual(findPricesInLine('500g', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('1.5 l', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('20% off', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('12/10/2026', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('Art. 40213', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('4006381333931', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('2026', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('12:30', { local: 'EUR' }), []);
  assert.deepEqual(findPricesInLine('Earl Grey Tea 80 bags', { local: 'USD' }), []);
  assert.equal(findPricesInLine('4.99 each', { local: 'USD' })[0].amount, 4.99);
});

test('words that start like a mark are not marks', () => {
  const p = findPricesInLine('12,50 kroner', { local: 'EUR' });
  assert.equal(p[0].currency, 'EUR'); // the "kr" of kroner does not count; falls back to local
  assert.equal(p[0].explicit, false);
  const q = findPricesInLine('Paris 12', { local: 'EUR' });
  assert.equal(q[0].currency, 'EUR');
});

test('the price in the biggest letters, with a mark, comes first', () => {
  const lines = [
    { text: 'Bio Vollmilch 3,5% 1 l', height: 10 },
    { text: '1,19 €', height: 40 },
    { text: '1 l = 1,19 €', height: 8 },
    { text: 'Art. 40213', height: 8 },
  ];
  const prices = findPrices(lines, { local: 'EUR' });
  assert.equal(prices[0].amount, 1.19);
  assert.equal(prices[0].currency, 'EUR');
  assert.equal(prices.length, 1); // the unit price repeats the same amount
});

test('unit price and main price on one tag', () => {
  const lines = [
    { text: 'Olive Oil 500 ml', height: 12 },
    { text: '$7.49', height: 50 },
    { text: '$14.98 / L', height: 9 },
  ];
  const prices = findPrices(lines, { local: 'USD' });
  assert.deepEqual(prices.map((p) => p.amount), [7.49, 14.98]);
});

test('common misreadings inside numbers', () => {
  assert.deepEqual(top('€1O.5O'), [10.5, 'EUR']);
  assert.deepEqual(top('$l2.99'.replace('l', '1')), [12.99, 'USD']);
  assert.deepEqual(top('€12,9O'), [12.9, 'EUR']);
  assert.deepEqual(top('¥１,９８０', 'JPY'), [1980, 'JPY']);
});

test('ISO codes', () => {
  assert.deepEqual(top('EUR 9.99'), [9.99, 'EUR']);
  assert.deepEqual(top('9.99 GBP'), [9.99, 'GBP']);
  assert.deepEqual(top('ABC 9.99', 'USD'), [9.99, 'USD']); // not a currency
  assert.deepEqual(top('XYZ 9.99', 'USD'), [9.99, 'USD']);
  assert.deepEqual(top('XYZ 9.99', 'USD'), [9.99, 'USD']);
  const [p] = findPrices('9.99 PEN', { local: 'PEN' }); // a word-like code counts where it is local
  assert.equal(p.currency, 'PEN');
});

test('currency from the browser language', () => {
  assert.equal(currencyForLanguage('en-US'), 'USD');
  assert.equal(currencyForLanguage('de-CH'), 'CHF');
  assert.equal(currencyForLanguage('ja-JP'), 'JPY');
  assert.equal(currencyForLanguage('zh-Hant-TW'), 'TWD');
  assert.equal(currencyForLanguage('fr'), null);
});

test('signs that are also letters only count where that currency is local', () => {
  assert.deepEqual(top('R25.99', 'USD'), [25.99, 'USD']); // a stray R is noise in the US
  assert.deepEqual(top('RM 8.90', 'EUR'), [8.9, 'EUR']);
  assert.deepEqual(top('45 kr', 'EUR'), null); // with the kr ignored, "45 kr" reads as a count, like "45 bags"
  assert.deepEqual(findPrices('10 Ft long', { local: 'USD' }), []);
  assert.deepEqual(top('1 290 Ft', 'HUF'), [1290, 'HUF']);
});

test('capitalised words are not currency codes', () => {
  assert.deepEqual(findPrices([{ text: 'ALL 4 SEASONS', height: 1 }], { local: 'USD' }), []);
  assert.deepEqual(top('TOP 10.00', 'USD'), [10, 'USD']);
  assert.deepEqual(top('PEN 2.50', 'EUR'), [2.5, 'EUR']);
});

test('a number with no sign has to look like money', () => {
  const lines = [
    { text: '$3.99', height: 40 },
    { text: 'Aisle 12', height: 10 },
    { text: 'Item 4471', height: 10 },
    { text: 'Save 30', height: 12 },
    { text: '2.49', height: 12 },
  ];
  const prices = findPrices(lines, { local: 'USD' });
  assert.deepEqual(prices.map((p) => p.amount), [3.99, 2.49]);
  /* yen have no cents, so whole numbers are normal there */
  assert.deepEqual(findPrices([{ text: '198', height: 40 }, { text: '税込 213', height: 12 }], { local: 'JPY' }).map((p) => p.amount), [198, 213]);
  /* the biggest text on the tag counts even without cents (US tags often print 499 with small cents) */
  assert.deepEqual(top([{ text: '499', height: 40 }, { text: 'per lb', height: 10 }], 'USD'), [499, 'USD']);
});

test('text the reader was unsure of is not trusted without a sign', () => {
  assert.deepEqual(findPrices([{ text: '7.49', height: 20, confidence: 35 }], { local: 'USD' }), []);
  assert.equal(findPrices([{ text: '$7.49', height: 20, confidence: 35 }], { local: 'USD' }).length, 1);
});

test('prices nearer the middle of the box rank higher', () => {
  const lines = [
    { text: '$2.99', height: 30, bbox: { x0: 0, y0: 0, x1: 100, y1: 30 } },
    { text: '$5.49', height: 30, bbox: { x0: 400, y0: 200, x1: 500, y1: 230 } },
  ];
  const center = { x: 450, y: 215, reach: 600 };
  assert.equal(findPrices(lines, { local: 'USD', center })[0].amount, 5.49);
});

/* what the English text reader makes of signs it does not know */
const line = (text, local) => findPricesInLine(text, { local }).map((p) => [p.amount, p.currency, p.explicit]);

test('the local sign misread as another sign or as letters', () => {
  assert.deepEqual(top('¥1,680', 'INR'), [1680, 'INR']); // ₹ read as ¥
  assert.deepEqual(top('¥ 937', 'INR'), [937, 'INR']);
  assert.deepEqual(top('X 1,993', 'INR'), [1993, 'INR']);
  assert.deepEqual(top('< 980', 'INR'), [980, 'INR']);
  assert.deepEqual(top('B283', 'THB'), [283, 'THB']); // ฿ read as B or $
  assert.deepEqual(top('was $947', 'THB'), [947, 'THB']);
  assert.deepEqual(top('570M', 'JPY'), [570, 'JPY']); // 円 read as M, H or F
  assert.deepEqual(top('485H', 'JPY'), [485, 'JPY']);
  assert.deepEqual(top('96,19 zi', 'PLN'), [96.19, 'PLN']); // zł
  assert.deepEqual(top('38,49 zt', 'PLN'), [38.49, 'PLN']);
  assert.deepEqual(line('104,69 21', 'PLN'), [[104.69, 'PLN', true]]); // the 21 is the sign, not another number
  assert.deepEqual(top('389,49 K', 'CZK'), [389.49, 'CZK']); // Kč
  assert.deepEqual(top('618.49 K&', 'CZK'), [618.49, 'CZK']);
  assert.deepEqual(top('721,29 K¢', 'CZK'), [721.29, 'CZK']);
  assert.deepEqual(top('12,50 E', 'EUR'), [12.5, 'EUR']); // €
  assert.deepEqual(top('£21,94', 'EUR'), [21.94, 'EUR']);
  assert.deepEqual(top('E3.99', 'GBP'), [3.99, 'GBP']); // £
  assert.deepEqual(top('HF 15.37', 'CHF'), [15.37, 'CHF']);
  assert.deepEqual(top('10: -', 'SEK'), [10, 'SEK']); // 10:-
  assert.deepEqual(top('45,90 Kr', 'NOK'), [45.9, 'NOK']);
  const [p] = findPrices('570M', { local: 'JPY' });
  assert.equal(p.explicit, true);
  assert.equal(p.shared, true); // so the app says "M read as JPY"
});

test('a misread sign only counts where it is the local sign', () => {
  assert.deepEqual(top('¥1,680', 'JPY'), [1680, 'JPY']);
  assert.deepEqual(top('$947', 'USD'), [947, 'USD']);
  assert.deepEqual(line('B283', 'USD'), [[283, 'USD', false]]);
  assert.deepEqual(line('96,19 zi', 'EUR'), [[96.19, 'EUR', false]]);
  assert.deepEqual(line('570M', 'EUR'), []);
});

test('a misread sign needs a number that looks like a whole price', () => {
  assert.deepEqual(line('5 M', 'JPY'), []); // a size
  assert.deepEqual(line('12 E', 'EUR'), [[12, 'EUR', false]]); // no cents: E is not taken for €
  assert.deepEqual(line('14759 zi', 'PLN'), []); // no cents: a count, as "80 bags"
  assert.deepEqual(line('4K', 'CZK'), []);
  assert.deepEqual(line('6 X 125 g', 'INR'), []); // a pack size, not rupees
  assert.deepEqual(line('< 500 g', 'INR'), []);
  assert.deepEqual(line('£2194 /kg', 'EUR'), [[2194, 'EUR', false]]);
});

test('a stray pound sign only counts where the pound is used', () => {
  assert.deepEqual(line('£44', 'MXN'), [[44, 'MXN', false]]);
  assert.deepEqual(top('£44', 'GBP'), [44, 'GBP']);
  assert.deepEqual(top('£3.99'), [3.99, 'GBP']);
});

test('pence and cents', () => {
  assert.deepEqual(top('75p', 'GBP'), [0.75, 'GBP']);
  assert.deepEqual(top('Now 99p', 'GBP'), [0.99, 'GBP']);
  assert.deepEqual(top('79¢', 'USD'), [0.79, 'USD']);
  assert.deepEqual(top('79¢', 'CAD'), [0.79, 'CAD']);
  assert.deepEqual(top('79¢'), [0.79, 'USD']);
  assert.notDeepEqual(top('75p', 'EUR'), [0.75, 'EUR']);
  assert.deepEqual(line('6 pcs', 'GBP'), []);
});

test('cents garbled by the reader give no price, not the whole part', () => {
  assert.deepEqual(line('98% zt', 'PLN'), []);
  assert.deepEqual(line('541°', 'CZK'), []);
  assert.deepEqual(line('24”', 'MXN'), []);
  assert.deepEqual(line('36” kr', 'NOK'), []);
  assert.deepEqual(line('CHF 38.8¢', 'CHF'), []);
  assert.deepEqual(line('46+ €', 'EUR'), []);
  assert.deepEqual(line('€38,7', 'EUR'), []); // a digit lost
  assert.deepEqual(line('$6.9', 'USD'), []);
  assert.deepEqual(line('$40.', 'USD'), []); // the cents read as a line of their own
  assert.deepEqual(top('12.–', 'CHF'), [12, 'CHF']);
  assert.deepEqual(top('12. -', 'CHF'), [12, 'CHF']);
  /* where tags show no cents, a mark after the number is just a misread sign */
  assert.deepEqual(top('271»', 'SEK'), [271, 'SEK']);
  assert.deepEqual(top('12!', 'INR'), [12, 'INR']);
});

test('cents split off with a space', () => {
  assert.deepEqual(top('€17, 79'), [17.79, 'EUR']);
  assert.deepEqual(top('$40 .50', 'USD'), [40.5, 'USD']);
  assert.deepEqual(top('182, 00 kr', 'NOK'), [182, 'NOK']);
  assert.deepEqual(top('CHF 44 89'), [44.89, 'CHF']);
  assert.deepEqual(top('259 50 K¢&', 'CZK'), [259.5, 'CZK']);
  const tag = [{ text: 'Cheddar Cheese 400 g', height: 30 }, { text: '17 19', height: 140 }];
  assert.deepEqual(top(tag, 'EUR'), [17.19, 'EUR']);
  /* not elsewhere: small text with no sign is a list, and 1 299 is a thousand */
  assert.deepEqual(findPrices([{ text: '€4.99', height: 40 }, { text: 'Sizes 38, 40', height: 10 }], { local: 'EUR' }).map((p) => p.amount), [4.99]);
  assert.deepEqual(top('1 299 €'), [1299, 'EUR']);
  assert.deepEqual(top('2 x 1 299 €'), [1299, 'EUR']);
  assert.deepEqual(top('¥1 980', 'JPY'), [1980, 'JPY']);
});

test('codes, article numbers and pack sizes', () => {
  assert.deepEqual(line('Art, 97395', 'JPY'), []);
  assert.deepEqual(line('Art   43435', 'JPY'), []);
  assert.deepEqual(line('An 31537', 'JPY'), []); // five digits with no separator
  assert.deepEqual(line('18990', 'KRW'), [[18990, 'KRW', false]]); // where prices run that long
  assert.deepEqual(line('Greek Yogurt 4x125 9', 'PLN'), []);
  assert.deepEqual(line('08', 'EUR'), []);
  assert.deepEqual(line('¥2', 'JPY'), []);
  assert.deepEqual(line('Orange Juice 1.5 |', 'JPY'), []); // no cents in yen: "1.5" is not ¥15
  assert.deepEqual(line('19   zt', 'PLN'), []);
});

test('a unit price comes after the price to pay', () => {
  const tag = [{ text: '11,95', height: 100 }, { text: '€42,38 per 100g', height: 28 }];
  assert.deepEqual(findPrices(tag, { local: 'EUR' }).map((p) => p.amount), [11.95, 42.38]);
  const tag2 = [{ text: '21.79', height: 90 }, { text: '$59.23 /kg', height: 30 }];
  assert.deepEqual(findPrices(tag2, { local: 'CAD' }).map((p) => p.amount), [21.79, 59.23]);
  const [p] = findPricesInLine('1 l = 1,19 €', { local: 'EUR' }).filter((q) => q.amount === 1.19);
  assert.equal(p.unit, true);
  assert.equal(findPricesInLine('$3.99 /ea', { local: 'USD' })[0].unit, false);
});
