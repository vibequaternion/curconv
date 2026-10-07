// Разбор и форматирование сумм, сведения о валютах.
// Логика совпадает с Android-версией (Amounts.kt, Currencies.kt).

import { FLAGS } from './flags.js';

const GROUP = ' '; // неразрывный пробел между разрядами: «1 234 567,89»
const MAX_LENGTH = 24;

/** Десятичный разделитель локали браузера: «,» или «.». */
export function decimalSeparator(locale = navigator.language) {
  try {
    const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal');
    return part && (part.value === ',' || part.value === '.') ? part.value : '.';
  } catch {
    return '.';
  }
}

/** Оставляет в тексте только цифры, пробелы и первый десятичный разделитель. */
export function sanitizeInput(text) {
  let out = '';
  let hasSeparator = false;
  for (const c of text) {
    if (c >= '0' && c <= '9') out += c;
    else if (c === '.' || c === ',') {
      if (!hasSeparator) { out += c; hasSeparator = true; }
    } else if (/\s/.test(c)) out += c;
  }
  return out.slice(0, MAX_LENGTH);
}

/** «1 234,5» → 1234.5; пустая строка или одинокий разделитель → null. */
export function parseAmount(text) {
  let cleaned = '';
  for (const c of String(text)) {
    if (c >= '0' && c <= '9') cleaned += c;
    else if (c === '.' || c === ',') cleaned += '.';
  }
  if (cleaned === '' || cleaned === '.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const fmtTwo = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const fmtSig = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4, useGrouping: false });

/**
 * От 1 и больше — два знака после запятой (у целых без «,00»),
 * меньше 1 — четыре значащие цифры: 0,0123 или 0,00001234.
 */
export function formatAmount(value, sep = decimalSeparator()) {
  if (!Number.isFinite(value)) return '';
  const a = Math.abs(value);
  let plain;
  if (a >= 1 || a === 0) {
    plain = fmtTwo.format(a);
    if (plain.endsWith('.00')) plain = plain.slice(0, -3);
  } else {
    plain = fmtSig.format(a);
  }
  const [intPart, fracPart = ''] = plain.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  return (value < 0 ? '-' : '') + grouped + (fracPart ? sep + fracPart : '');
}

/** amount единиц from → сколько это в to; null, если у источника нет одной из валют. */
export function convert(snapshot, amount, from, to) {
  const f = snapshot?.rates?.[from];
  const t = snapshot?.rates?.[to];
  if (!f || !t) return null;
  return (amount / f) * t;
}

// ── Валюты ────────────────────────────────────────────────────────────

/** Показываются в настройках, даже пока источник не загрузился. */
export const COMMON = [
  'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CNY', 'RUB', 'UAH', 'BYN', 'KZT', 'AMD', 'GEL', 'AZN',
  'UZS', 'KGS', 'TJS', 'MDL', 'TRY', 'AED', 'ILS', 'INR', 'THB', 'KRW', 'CAD', 'AUD', 'PLN',
  'CZK', 'SEK', 'NOK', 'DKK', 'HUF', 'RSD', 'BTC', 'ETH', 'USDT', 'XAU',
];

const CRYPTO = {
  BTC: 'Bitcoin', ETH: 'Ethereum', USDT: 'Tether', USDC: 'USD Coin', BNB: 'BNB', SOL: 'Solana',
  XRP: 'XRP', TON: 'Toncoin', DOGE: 'Dogecoin', LTC: 'Litecoin', TRX: 'TRON', ADA: 'Cardano', DOT: 'Polkadot',
};

const SYMBOLS = {
  BTC: '₿', ETH: 'Ξ', USDT: '₮', LTC: 'Ł', DOGE: 'Ð', XAU: 'Au', XAG: 'Ag', XPT: 'Pt', XPD: 'Pd',
};

/** Валюта по стране языка браузера (ru → RU → RUB). */
const REGION_CURRENCY = {
  RU: 'RUB', UA: 'UAH', BY: 'BYN', KZ: 'KZT', AM: 'AMD', GE: 'GEL', AZ: 'AZN', UZ: 'UZS', KG: 'KGS',
  TJ: 'TJS', MD: 'MDL', TR: 'TRY', IL: 'ILS', US: 'USD', GB: 'GBP', CH: 'CHF', JP: 'JPY', CN: 'CNY',
  PL: 'PLN', CZ: 'CZK', CA: 'CAD', AU: 'AUD', IN: 'INR', AE: 'AED', TH: 'THB', KR: 'KRW', RS: 'RSD',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', AT: 'EUR', FI: 'EUR', LV: 'EUR', LT: 'EUR', EE: 'EUR',
};

export const ISO = new Set((() => {
  try { return Intl.supportedValuesOf('currency'); } catch { return []; }
})());

let displayNames = null;
const nameCache = new Map();

/** «USD» → «Доллар США» на языке браузера; для крипты — английское имя. */
export function currencyName(code) {
  if (nameCache.has(code)) return nameCache.get(code);
  let name = CRYPTO[code];
  if (!name) {
    try {
      displayNames ??= new Intl.DisplayNames([navigator.language, 'ru'], { type: 'currency' });
      name = displayNames.of(code) || code;
    } catch {
      name = code;
    }
    name = name.charAt(0).toLocaleUpperCase() + name.slice(1);
  }
  nameCache.set(code, name);
  return name;
}

/** Код страны для флага (EUR → eu) или null для крипты, металлов и т. п. */
export function flagRegion(code) {
  if (code.length !== 3 || code.startsWith('X')) return null;
  if (ISO.size > 0 && !ISO.has(code)) return null;
  const region = code === 'ANG' ? 'cw' : code.slice(0, 2).toLowerCase();
  return FLAGS.has(region) ? region : null;
}

/** Значок для валют без флага. */
export function badgeText(code) {
  return SYMBOLS[code] ?? code.charAt(0);
}

export function matchesQuery(code, query) {
  const q = query.trim().toLocaleLowerCase();
  return q === '' || code.toLowerCase().includes(q) || currencyName(code).toLocaleLowerCase().includes(q);
}

/** Стартовый набор: валюта страны языка браузера + USD, EUR, RUB. */
export function defaultCurrencies() {
  let local = null;
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    local = REGION_CURRENCY[region] ?? null;
  } catch { /* старый браузер */ }
  return [...new Set([local, 'USD', 'EUR', 'RUB'].filter(Boolean))];
}

/** Русское склонение: 1 валюта, 2 валюты, 5 валют. */
export function plural(n, one, few, many) {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}
