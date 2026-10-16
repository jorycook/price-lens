/* Price Lens benchmark: made-up price tags with known prices.
 *
 * Each case is a plain description (the tag's design, its prices, and what the camera did to it:
 * angle, blur, glare, noise, distance). tagScene() turns it into HTML the size of what the camera
 * sees inside the aiming box; bench/run.mjs photographs that with a headless browser and damages
 * the picture as described. The same seed always gives the same cases. */

/* a small seeded random generator (mulberry32), so a run can be repeated exactly */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: (list) => list[Math.floor(next() * list.length)],
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    chance: (p) => next() < p,
  };
}

/* How each country writes a price. fmt(amount) gives the text of the big price; raised(amount)
   gives [whole, cents, sign, signSide] for tags that print the cents small and raised. */
const group = (n, sep) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
const two = (n) => Math.round((n % 1) * 100).toString().padStart(2, '0');
const whole = (n) => Math.floor(n + 1e-9);
const LOCALES = [
  { country: 'DE', currency: 'EUR', fmt: (n) => `${group(whole(n), '.')},${two(n)} €`, sign: '€', side: 'after', decimals: 2, max: 60 },
  { country: 'FR', currency: 'EUR', fmt: (n) => `${group(whole(n), ' ')},${two(n)} €`, sign: '€', side: 'after', decimals: 2, max: 60 },
  { country: 'IE', currency: 'EUR', fmt: (n) => `€${group(whole(n), ',')}.${two(n)}`, sign: '€', side: 'before', decimals: 2, max: 60 },
  { country: 'NL', currency: 'EUR', fmt: (n) => `€ ${whole(n)},${two(n)}`, sign: '€', side: 'before', decimals: 2, max: 30 },
  { country: 'GB', currency: 'GBP', fmt: (n) => `£${group(whole(n), ',')}.${two(n)}`, sign: '£', side: 'before', decimals: 2, max: 40 },
  { country: 'US', currency: 'USD', fmt: (n) => `$${group(whole(n), ',')}.${two(n)}`, sign: '$', side: 'before', decimals: 2, max: 50 },
  { country: 'CA', currency: 'CAD', fmt: (n) => `$${whole(n)}.${two(n)}`, sign: '$', side: 'before', decimals: 2, max: 50 },
  { country: 'CH', currency: 'CHF', fmt: (n) => `${whole(n)}.${two(n)}`, sign: 'CHF', side: 'before', decimals: 2, max: 60, bareOk: true },
  { country: 'SE', currency: 'SEK', fmt: (n) => `${whole(n)}:-`, sign: 'kr', side: 'after', decimals: 0, max: 400 },
  { country: 'NO', currency: 'NOK', fmt: (n) => `${whole(n)},${two(n)} kr`, sign: 'kr', side: 'after', decimals: 2, max: 300 },
  { country: 'PL', currency: 'PLN', fmt: (n) => `${whole(n)},${two(n)} zł`, sign: 'zł', side: 'after', decimals: 2, max: 150 },
  { country: 'CZ', currency: 'CZK', fmt: (n) => `${whole(n)},${two(n)} Kč`, sign: 'Kč', side: 'after', decimals: 2, max: 900 },
  { country: 'JP', currency: 'JPY', fmt: (n) => `¥${group(whole(n), ',')}`, sign: '¥', side: 'before', decimals: 0, min: 80, max: 4000 },
  { country: 'JP', currency: 'JPY', fmt: (n) => `${group(whole(n), ',')}円`, sign: '円', side: 'after', decimals: 0, min: 80, max: 4000 },
  { country: 'TH', currency: 'THB', fmt: (n) => `฿${whole(n)}`, sign: '฿', side: 'before', decimals: 0, min: 15, max: 900 },
  { country: 'IN', currency: 'INR', fmt: (n) => `₹ ${group(whole(n), ',')}`, sign: '₹', side: 'before', decimals: 0, min: 20, max: 2000 },
  { country: 'MX', currency: 'MXN', fmt: (n) => `$${whole(n)}.${two(n)}`, sign: '$', side: 'before', decimals: 2, min: 10, max: 300 },
];

const FONTS = [
  { family: 'Liberation Sans', weight: 700 },
  { family: 'Inter', weight: 800 },
  { family: 'DejaVu Sans', weight: 700 },
  { family: 'Liberation Sans', weight: 700, narrow: 0.78 },  // condensed, like most shelf labels
  { family: 'Inter Display', weight: 900, narrow: 0.82 },
  { family: 'FreeSans', weight: 700 },
  { family: 'Liberation Serif', weight: 700 },
  { family: 'DejaVu Sans Mono', weight: 700 },               // e-ink labels often look like this
];

const PRODUCTS = ['Bio Vollmilch 1 l', 'Earl Grey Tea 80 bags', 'Organic Bananas', 'Pasta Fusilli 500 g', 'Olive Oil 750 ml',
  'Greek Yogurt 4x125 g', 'Coffee Beans 1 kg', 'Orange Juice 1.5 L', 'Dark Chocolate 70%', 'Sparkling Water 6 x 1 L',
  'Cheddar Cheese 400 g', 'Shampoo 250 ml', 'Matcha Kit Kat 12 pcs', 'Basmati Rice 2 kg', 'Peanut Butter 340 g'];

function amountFor(r, loc) {
  const min = loc.min ?? 0.5, max = loc.max;
  /* prices cluster just under round numbers */
  let n = r.range(min, max);
  if (loc.decimals === 0) {
    n = Math.max(min, Math.round(n));
    if (r.chance(0.5)) n = Math.max(min, Math.ceil(n / 10) * 10 - (r.chance(0.5) ? 2 : 0));
    return n;
  }
  const endings = [0.99, 0.49, 0.95, 0.89, 0.29, 0.00, 0.50, 0.79, 0.19, 0.59];
  return Math.floor(n) + r.pick(endings);
}

/* The design of one tag. style picks the layout; the rest is drawn from the random generator. */
export function makeCase(r, index) {
  const loc = r.pick(LOCALES);
  const style = r.pick(['shelf', 'shelf', 'raised', 'raised', 'sale', 'eink', 'dark', 'neighbours', 'minimal', 'unit']);
  const font = r.pick(FONTS);
  const amount = amountFor(r, loc);
  const others = [];
  let wasAmount = null;
  if (style === 'sale') {
    wasAmount = loc.decimals === 0 ? Math.round(amount * r.range(1.2, 1.8)) : Math.floor(amount * r.range(1.2, 1.8)) + 0.99;
    others.push({ amount: wasAmount, currency: loc.currency, what: 'old price' });
  }
  let unitAmount = null;
  if (['shelf', 'unit', 'eink', 'neighbours'].includes(style) || r.chance(0.3)) {
    unitAmount = loc.decimals === 0 ? Math.round(amount * r.range(1.5, 6)) : Math.round(amount * r.range(1.5, 6) * 100) / 100;
    if (Math.abs(unitAmount - amount) > 0.001) others.push({ amount: unitAmount, currency: loc.currency, what: 'unit price' });
    else unitAmount = null;
  }
  if (style === 'neighbours') {
    /* the half-visible tags either side show prices too; reading them is not wrong, ranking them first is */
    for (const d of [1, 2]) others.push({ amount: Math.round((amount + d) * 100) / 100, currency: loc.currency, what: 'neighbouring tag' });
  }
  /* what the camera did */
  const hard = r.chance(0.5);
  const camera = {
    scale: r.range(hard ? 0.38 : 0.55, 0.95),     // the tag's width as a share of the aiming box
    rotX: r.range(-1, 1) * (hard ? 28 : 10),      // tilt, degrees
    rotY: r.range(-1, 1) * (hard ? 30 : 10),
    rotZ: r.range(-1, 1) * (hard ? 8 : 3),
    blur: r.chance(hard ? 0.6 : 0.25) ? r.range(0.4, hard ? 2.2 : 1.0) : 0,       // out of focus, px at 1080p
    motion: r.chance(hard ? 0.35 : 0.1) ? r.range(2, hard ? 9 : 4) : 0,          // camera shake, px
    glare: r.chance(hard ? 0.5 : 0.15) ? r.range(0.25, 0.7) : 0,
    shade: r.chance(0.5) ? r.range(0.15, hard ? 0.6 : 0.35) : 0,                  // uneven light
    noise: r.range(2, hard ? 14 : 6),
    jpeg: r.range(hard ? 0.45 : 0.7, 0.92),
    dim: r.chance(hard ? 0.3 : 0.1) ? r.range(0.45, 0.75) : 1,                    // a dark shop
    width: r.pick([720, 900, 1080]),                                               // the aiming box, in camera pixels
  };
  return {
    id: `s${String(index).padStart(3, '0')}-${loc.country.toLowerCase()}-${style}`,
    style, font, country: loc.country, currency: loc.currency,
    locale: loc,
    product: r.pick(PRODUCTS),
    article: String(r.int(10000, 99999)),
    ean: String(r.int(1e5, 9e5)) + String(r.int(1e6, 9e6)),
    amount, wasAmount, unitAmount,
    unitLabel: r.pick(['/kg', '/l', 'per kg', 'per 100g', '/100 g']),
    signShown: style === 'minimal' && loc.bareOk ? false : r.chance(style === 'raised' ? 0.7 : 0.9),
    colours: r.pick([
      { bg: '#ffffff', fg: '#111111', accent: '#d10a0a' },
      { bg: '#fff8c4', fg: '#111111', accent: '#c00000' },
      { bg: '#ffeb00', fg: '#c40000', accent: '#c40000' },
      { bg: '#e8f0ff', fg: '#0b1f5c', accent: '#0b1f5c' },
    ]),
    camera,
    hard,
    truth: { main: { amount, currency: loc.currency }, others },
  };
}

export function makeCases(seed, count) {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => makeCase(r, i));
}

/* the text of a price in this case's style */
function priceHtml(c, amount, size, { raised = c.style === 'raised', sign = c.signShown } = {}) {
  const loc = c.locale;
  if (raised && loc.decimals === 2) {
    const w = whole(amount), cents = two(amount);
    const s = sign ? `<span style="font-size:${size * 0.42}px;vertical-align:${size * 0.42}px">${loc.sign}</span>` : '';
    return `${loc.side === 'before' ? s : ''}<span>${w}</span><span style="font-size:${size * 0.45}px;vertical-align:${size * 0.4}px;margin-left:${size * 0.04}px">${cents}</span>${loc.side === 'after' ? ` ${s}` : ''}`;
  }
  let text = loc.fmt(amount);
  if (!sign) text = text.replace(loc.sign, '').replace(/^\s+|\s+$/g, '');
  if (loc.country === 'CH' && sign) text = `CHF ${text}`;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/* The HTML of what the camera sees inside the aiming box: the tag, turned and lit as the case says.
   The box is camera.width wide and 0.62 of that tall (the app's box on an upright phone). */
export function tagScene(c) {
  const W = c.camera.width, H = Math.round(W * 0.62);
  const tagW = Math.round(W * c.camera.scale);
  /* the big price fits on one line, as on a real tag: long prices ("1.299,00 €") get smaller letters */
  const chars = c.locale.fmt(c.amount).length + (c.locale.country === 'CH' ? 4 : 0);
  const big = Math.round(Math.min(tagW * (c.style === 'minimal' ? 0.26 : 0.22), (tagW * 1.55) / chars / (c.font.narrow || 1)));
  const small = Math.max(9, Math.round(tagW * 0.045));
  const { bg, fg, accent } = c.colours;
  const ff = `font-family:'${c.font.family}';font-weight:${c.font.weight}`;
  const narrow = (c.font.narrow ? `display:inline-block;transform:scaleX(${c.font.narrow});transform-origin:center` : 'display:inline-block') + ';white-space:nowrap';
  const unit = c.unitAmount != null
    ? `<div style="font-size:${small}px;font-weight:400">${priceHtml(c, c.unitAmount, small, { raised: false, sign: true })} ${c.unitLabel}</div>` : '';
  const meta = `<div style="font-size:${small * 0.85}px;font-weight:400;opacity:.8;display:flex;justify-content:space-between"><span>Art. ${c.article}</span><span>${c.ean}</span></div>`;
  let body;
  let tagBg = bg, tagFg = fg;
  switch (c.style) {
    case 'sale':
      tagBg = c.colours.bg === '#ffffff' ? '#ffeb00' : c.colours.bg;
      body = `<div style="font-size:${small * 1.4}px;font-weight:900;color:${accent}">SALE</div>
        <div style="font-size:${small * 1.3}px;font-weight:400">was <s>${priceHtml(c, c.wasAmount, small * 1.3, { raised: false, sign: true })}</s></div>
        <div style="font-size:${big}px;line-height:1;color:${accent}"><span style="${narrow}">${priceHtml(c, c.amount, big)}</span></div>${unit}`;
      break;
    case 'eink':
      tagBg = '#d9d9d2'; tagFg = '#151515';
      body = `<div style="font-size:${small}px;font-weight:400">${c.product}</div>
        <div style="font-size:${big}px;line-height:1.05"><span style="${narrow}">${priceHtml(c, c.amount, big)}</span></div>${unit}${meta}`;
      break;
    case 'dark':
      tagBg = c.colours.accent === '#0b1f5c' ? '#0b1f5c' : '#b30000'; tagFg = '#ffffff';
      body = `<div style="font-size:${small}px;font-weight:400">${c.product}</div>
        <div style="font-size:${big}px;line-height:1.05"><span style="${narrow}">${priceHtml(c, c.amount, big)}</span></div>${unit}`;
      break;
    case 'minimal':
      body = `<div style="font-size:${big}px;line-height:1.05"><span style="${narrow}">${priceHtml(c, c.amount, big)}</span></div>`;
      break;
    default:
      body = `<div style="font-size:${small * 1.1}px;font-weight:600;text-align:left">${c.product}</div>
        <div style="font-size:${big}px;line-height:1.05"><span style="${narrow}">${priceHtml(c, c.amount, big)}</span></div>${unit}${meta}`;
  }
  const tag = `<div style="width:${tagW}px;box-sizing:border-box;padding:${small}px ${small * 1.2}px;background:${tagBg};color:${tagFg};
    text-align:center;border-radius:${small * 0.5}px;border:${Math.max(1, small * 0.15)}px solid ${accent};${ff}">${body}</div>`;
  /* the neighbouring tags on the shelf, half in view, with prices that are not the one aimed at */
  const neighbour = (side) => `<div style="position:absolute;top:${H * 0.18}px;${side}:${-tagW * 0.62}px;width:${tagW * 0.8}px;padding:${small}px;
    background:${bg};color:${fg};text-align:center;border:1px solid #999;${ff}"><div style="font-size:${small}px">${c.product}</div>
    <div style="font-size:${big * 0.8}px">${priceHtml(c, Math.round((c.amount + (side === 'left' ? 1 : 2)) * 100) / 100, big * 0.8, { raised: false })}</div></div>`;
  const cam = c.camera;
  const glare = cam.glare ? `<div style="position:absolute;inset:0;background:radial-gradient(circle at ${30 + cam.glare * 60}% ${25 + cam.glare * 40}%, rgba(255,255,255,${cam.glare}) 0, rgba(255,255,255,${cam.glare * 0.5}) 12%, transparent 30%);mix-blend-mode:screen"></div>` : '';
  const shade = cam.shade ? `<div style="position:absolute;inset:0;background:linear-gradient(${Math.round(cam.rotZ * 20)}deg, rgba(0,0,0,${cam.shade}), transparent 70%);mix-blend-mode:multiply"></div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#8c877d}</style></head>
<body><div style="position:absolute;inset:0;background:linear-gradient(#6f6a62,#a29d92)"></div>
${c.style === 'neighbours' ? neighbour('left') + neighbour('right') : ''}
<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;display:grid;place-items:center;perspective:${W * 1.1}px">
  <div style="transform:rotateX(${cam.rotX}deg) rotateY(${cam.rotY}deg) rotateZ(${cam.rotZ}deg);filter:brightness(${cam.dim})${cam.blur ? ` blur(${cam.blur * W / 1080}px)` : ''}">${tag}</div>
</div>${shade}${glare}</body></html>`;
}
