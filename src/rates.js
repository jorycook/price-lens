/* Price Lens: exchange rates.
 *
 * Rates come from two free sources that need no key. The first covers about 160 currencies and
 * is updated daily; the second (the European Central Bank's reference rates) is the fallback.
 * The last rates fetched are kept on the phone, so conversion keeps working with no connection,
 * and the page always says how old they are. */

const SOURCES = [
  {
    name: 'ExchangeRate-API',
    url: 'https://open.er-api.com/v6/latest/USD',
    link: 'https://www.exchangerate-api.com',
    read(json) {
      if (json.result !== 'success' || !json.rates) throw new Error('bad response');
      return { base: json.base_code, rates: json.rates, updated: json.time_last_update_unix * 1000 };
    },
  },
  {
    name: 'Frankfurter (ECB)',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD',
    link: 'https://frankfurter.dev',
    read(json) {
      if (!json.rates) throw new Error('bad response');
      return { base: json.base, rates: { ...json.rates, [json.base]: 1 }, updated: Date.parse(json.date + 'T16:00:00Z') };
    },
  },
];

const KEY = 'price-lens:rates';
/* Fetch again when the stored rates are older than this. The sources publish once a day, so an
   hour keeps them current without asking more than needed. */
export const MAX_AGE = 60 * 60 * 1000;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && saved.rates && saved.base) return saved;
  } catch {}
  return null;
}

function save(table) {
  try { localStorage.setItem(KEY, JSON.stringify(table)); } catch {}
}

async function fetchJson(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* The rate table: { base, rates: {CODE: units per base}, updated (ms), fetched (ms), source, link, stale }.
 * Uses the stored table while it is fresh; otherwise asks the sources in turn. With no connection,
 * hands back the stored table marked stale, or null when there has never been one. */
export async function getRates({ force = false } = {}) {
  const saved = load();
  if (!force && saved && Date.now() - saved.fetched < MAX_AGE) return { ...saved, stale: false };
  for (const source of SOURCES) {
    try {
      const table = { ...source.read(await fetchJson(source.url)), fetched: Date.now(), source: source.name, link: source.link };
      save(table);
      return { ...table, stale: false };
    } catch (err) {
      console.warn('rates:', source.name, err);
    }
  }
  return saved ? { ...saved, stale: true } : null;
}

export function storedRates() {
  const saved = load();
  return saved ? { ...saved, stale: Date.now() - saved.fetched >= MAX_AGE } : null;
}

/* Converts an amount between two currencies through the table's base. Null when either is unknown. */
export function convert(table, amount, from, to) {
  if (!table) return null;
  const a = table.rates[from], b = table.rates[to];
  if (!a || !b) return null;
  return (amount / a) * b;
}

/* "1 EUR = 1.1180 USD": the rate shown under each result. */
export function rateOf(table, from, to) {
  return convert(table, 1, from, to);
}
