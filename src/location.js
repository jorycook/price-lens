/* Price Lens: which country the phone is in, and so which currency the price tags are in.
 *
 * Two ways, best first:
 *  - GPS, when the person allows it: the position (rounded to about 10 km) is turned into a
 *    country by BigDataCloud's free lookup. Exact, even near borders.
 *  - The phone's time zone: phones set it from the network when they arrive in a new country,
 *    it needs no permission and no connection, and nearly every time zone lies in one country.
 * The internet address is not used: phones roaming abroad usually still show their home country. */

import { ZONE_COUNTRY } from './zones.js';

/* the currency in everyday use in each country (ISO 3166 → ISO 4217) */
export const COUNTRY_CURRENCY = {
  AD: 'EUR', AE: 'AED', AF: 'AFN', AG: 'XCD', AI: 'XCD', AL: 'ALL', AM: 'AMD', AO: 'AOA', AR: 'ARS', AS: 'USD',
  AT: 'EUR', AU: 'AUD', AW: 'AWG', AX: 'EUR', AZ: 'AZN', BA: 'BAM', BB: 'BBD', BD: 'BDT', BE: 'EUR', BF: 'XOF',
  BG: 'BGN', BH: 'BHD', BI: 'BIF', BJ: 'XOF', BL: 'EUR', BM: 'BMD', BN: 'BND', BO: 'BOB', BQ: 'USD', BR: 'BRL',
  BS: 'BSD', BT: 'BTN', BV: 'NOK', BW: 'BWP', BY: 'BYN', BZ: 'BZD', CA: 'CAD', CC: 'AUD', CD: 'CDF', CF: 'XAF',
  CG: 'XAF', CH: 'CHF', CI: 'XOF', CK: 'NZD', CL: 'CLP', CM: 'XAF', CN: 'CNY', CO: 'COP', CR: 'CRC', CU: 'CUP',
  CV: 'CVE', CW: 'ANG', CX: 'AUD', CY: 'EUR', CZ: 'CZK', DE: 'EUR', DJ: 'DJF', DK: 'DKK', DM: 'XCD', DO: 'DOP',
  DZ: 'DZD', EC: 'USD', EE: 'EUR', EG: 'EGP', EH: 'MAD', ER: 'ERN', ES: 'EUR', ET: 'ETB', FI: 'EUR', FJ: 'FJD',
  FK: 'FKP', FM: 'USD', FO: 'DKK', FR: 'EUR', GA: 'XAF', GB: 'GBP', GD: 'XCD', GE: 'GEL', GF: 'EUR', GG: 'GBP',
  GH: 'GHS', GI: 'GIP', GL: 'DKK', GM: 'GMD', GN: 'GNF', GP: 'EUR', GQ: 'XAF', GR: 'EUR', GS: 'GBP', GT: 'GTQ',
  GU: 'USD', GW: 'XOF', GY: 'GYD', HK: 'HKD', HM: 'AUD', HN: 'HNL', HR: 'EUR', HT: 'HTG', HU: 'HUF', ID: 'IDR',
  IE: 'EUR', IL: 'ILS', IM: 'GBP', IN: 'INR', IO: 'USD', IQ: 'IQD', IR: 'IRR', IS: 'ISK', IT: 'EUR', JE: 'GBP',
  JM: 'JMD', JO: 'JOD', JP: 'JPY', KE: 'KES', KG: 'KGS', KH: 'KHR', KI: 'AUD', KM: 'KMF', KN: 'XCD', KP: 'KPW',
  KR: 'KRW', KW: 'KWD', KY: 'KYD', KZ: 'KZT', LA: 'LAK', LB: 'LBP', LC: 'XCD', LI: 'CHF', LK: 'LKR', LR: 'LRD',
  LS: 'LSL', LT: 'EUR', LU: 'EUR', LV: 'EUR', LY: 'LYD', MA: 'MAD', MC: 'EUR', MD: 'MDL', ME: 'EUR', MF: 'EUR',
  MG: 'MGA', MH: 'USD', MK: 'MKD', ML: 'XOF', MM: 'MMK', MN: 'MNT', MO: 'MOP', MP: 'USD', MQ: 'EUR', MR: 'MRU',
  MS: 'XCD', MT: 'EUR', MU: 'MUR', MV: 'MVR', MW: 'MWK', MX: 'MXN', MY: 'MYR', MZ: 'MZN', NA: 'NAD', NC: 'XPF',
  NE: 'XOF', NF: 'AUD', NG: 'NGN', NI: 'NIO', NL: 'EUR', NO: 'NOK', NP: 'NPR', NR: 'AUD', NU: 'NZD', NZ: 'NZD',
  OM: 'OMR', PA: 'PAB', PE: 'PEN', PF: 'XPF', PG: 'PGK', PH: 'PHP', PK: 'PKR', PL: 'PLN', PM: 'EUR', PN: 'NZD',
  PR: 'USD', PS: 'ILS', PT: 'EUR', PW: 'USD', PY: 'PYG', QA: 'QAR', RE: 'EUR', RO: 'RON', RS: 'RSD', RU: 'RUB',
  RW: 'RWF', SA: 'SAR', SB: 'SBD', SC: 'SCR', SD: 'SDG', SE: 'SEK', SG: 'SGD', SH: 'SHP', SI: 'EUR', SJ: 'NOK',
  SK: 'EUR', SL: 'SLE', SM: 'EUR', SN: 'XOF', SO: 'SOS', SR: 'SRD', SS: 'SSP', ST: 'STN', SV: 'USD', SX: 'ANG',
  SY: 'SYP', SZ: 'SZL', TC: 'USD', TD: 'XAF', TF: 'EUR', TG: 'XOF', TH: 'THB', TJ: 'TJS', TK: 'NZD', TL: 'USD',
  TM: 'TMT', TN: 'TND', TO: 'TOP', TR: 'TRY', TT: 'TTD', TV: 'AUD', TW: 'TWD', TZ: 'TZS', UA: 'UAH', UG: 'UGX',
  UM: 'USD', US: 'USD', UY: 'UYU', UZ: 'UZS', VA: 'EUR', VC: 'XCD', VE: 'VES', VG: 'USD', VI: 'USD', VN: 'VND',
  VU: 'VUV', WF: 'XPF', WS: 'WST', YE: 'YER', YT: 'EUR', ZA: 'ZAR', ZM: 'ZMW', ZW: 'USD',
};

export function countryName(cc, lang) {
  try { return new Intl.DisplayNames([lang || 'en', 'en'], { type: 'region' }).of(cc) || cc; } catch { return cc; }
}

/* The country of the phone's time zone, or null for zones like UTC that are not in any one country. */
export function countryFromTimeZone(tz) {
  if (tz === undefined) {
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; }
  }
  return ZONE_COUNTRY[tz] || null;
}

/* Whether the person has already allowed the position for this site (so asking shows no prompt). */
export async function gpsAllowed() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch { return false; }
}

/* The country from GPS. Asks for permission the first time. Only a rounded position (one decimal
   place, about 10 km) is sent for the lookup. Rejects with a message a person can read. */
export async function countryFromGps({ timeout = 15000 } = {}) {
  if (!navigator.geolocation) throw new Error('This browser cannot share its position.');
  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      reject(new Error(err.code === 1 ? 'Location access was refused. Allow it for this site in your browser settings.'
        : 'Could not get a position. Try again outdoors or with Wi-Fi on.'));
    }, { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout });
  });
  const lat = pos.coords.latitude.toFixed(1), lon = pos.coords.longitude.toFixed(1);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, { signal: ctrl.signal });
    const json = await res.json();
    if (!json.countryCode) throw new Error('no country');
    return json.countryCode.toUpperCase();
  } catch {
    throw new Error('Could not look up the country (no connection?).');
  } finally {
    clearTimeout(timer);
  }
}
