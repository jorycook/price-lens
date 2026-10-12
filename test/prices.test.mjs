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
  assert.deepEqual(top('1 290 Ft'), [1290, 'HUF']);
  assert.deepEqual(top('฿120'), [120, 'THB']);
  assert.deepEqual(top('49:-'), [49, 'SEK']);
  assert.deepEqual(top('R25.99'), [25.99, 'ZAR']);
  assert.deepEqual(top('RM 8.90'), [8.9, 'MYR']);
  assert.deepEqual(top('Rp 15.000'), [15000, 'IDR']);
  assert.deepEqual(top('250 TL'), [250, 'TRY']);
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
  assert.deepEqual(top('45 kr'), [45, 'SEK']);
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
  const [p] = findPrices('XYZ 9.99', { local: 'USD', codes: ['USD', 'XYZ'] });
  assert.equal(p.currency, 'XYZ');
});

test('currency from the browser language', () => {
  assert.equal(currencyForLanguage('en-US'), 'USD');
  assert.equal(currencyForLanguage('de-CH'), 'CHF');
  assert.equal(currencyForLanguage('ja-JP'), 'JPY');
  assert.equal(currencyForLanguage('zh-Hant-TW'), 'TWD');
  assert.equal(currencyForLanguage('fr'), null);
});
