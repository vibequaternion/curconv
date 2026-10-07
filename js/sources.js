// Источники курсов. Все работают прямо из браузера (CORS открыт) и без ключей.
// Снимок курсов: { sourceId, base, rates: { КОД: единиц за 1 base }, asOf, asOfHasTime, fetchedAt }.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class SourceError extends Error {}

async function getJSON(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if (e.name === 'AbortError') throw new SourceError('Источник не ответил вовремя');
    throw new SourceError(navigator.onLine === false
      ? 'Нет подключения к интернету'
      : 'Не удалось связаться с источником. Попробуйте позже или выберите другой');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new SourceError('Источник просит подождать: слишком много запросов');
  if (!res.ok) throw new SourceError(`Источник ответил ошибкой HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new SourceError('Источник прислал ответ в неожиданном формате');
  }
}

/** Все положительные числовые значения объекта как { КОД: курс } (строки "3.67" тоже понимает). */
function toRateMap(obj, keyFilter = () => true) {
  const out = {};
  for (const [key, raw] of Object.entries(obj ?? {})) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    const code = key.toUpperCase();
    if (Number.isFinite(value) && value > 0 && keyFilter(code)) out[code] = value;
  }
  return out;
}

function snapshot(sourceId, base, rates, asOf, asOfHasTime) {
  return { sourceId, base, rates: { ...rates, [base]: 1 }, asOf, asOfHasTime, fetchedAt: Date.now() };
}

const FRANKFURTER_API = 'https://api.frankfurter.dev';

export const SOURCES = [
  {
    id: 'erapi',
    title: 'ExchangeRate-API',
    description: 'Около 160 валют, обновляется раз в сутки.',
    homepage: 'https://www.exchangerate-api.com',
    attribution: 'Rates By Exchange Rate API',
    freshFor: HOUR,
    async fetch() {
      const json = await getJSON('https://open.er-api.com/v6/latest/USD');
      if (json.result !== 'success') throw new SourceError(`ExchangeRate-API: ${json['error-type'] ?? 'ошибка'}`);
      const at = json.time_last_update_unix ? new Date(json.time_last_update_unix * 1000).toISOString() : new Date().toISOString();
      return snapshot(this.id, json.base_code || 'USD', toRateMap(json.rates), at, true);
    },
  },
  {
    id: 'currency-api',
    title: 'Currency API (fawazahmed0)',
    description: 'Больше 300 валют, включая криптовалюты и золото. Раз в сутки.',
    homepage: 'https://github.com/fawazahmed0/exchange-api',
    freshFor: HOUR,
    async fetch() {
      const urls = [
        'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json',
        'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json',
      ];
      let lastError;
      for (const url of urls) {
        try {
          const json = await getJSON(url);
          const rates = toRateMap(json.usd, (code) => /^[A-Z0-9]{2,10}$/.test(code));
          return snapshot(this.id, 'USD', rates, json.date, false);
        } catch (e) {
          lastError = e; // пробуем запасной адрес
        }
      }
      throw lastError;
    },
  },
  {
    id: 'frankfurter',
    title: 'Центробанки (Frankfurter)',
    description: 'Официальные курсы около сотни центробанков: сводный курс или конкретный банк.',
    homepage: 'https://frankfurter.dev',
    freshFor: HOUR,
    async fetch(_wanted, { bankKey = '', pivot = null } = {}) {
      // Для конкретного банка лучше всего запрашивать в его «родной» валюте.
      const bases = bankKey ? [...new Set([pivot, 'EUR', 'USD'].filter(Boolean))] : ['USD'];
      const id = bankKey ? `frankfurter:${bankKey}` : 'frankfurter';
      let lastError;
      for (const base of bases) {
        try {
          let url = `${FRANKFURTER_API}/v2/rates?base=${base}`;
          if (bankKey) url += `&providers=${encodeURIComponent(bankKey)}`;
          const rows = await getJSON(url);
          const rates = {};
          let latest = '';
          for (const row of Array.isArray(rows) ? rows : []) {
            const quote = String(row.quote ?? '').toUpperCase();
            const rate = Number(row.rate);
            if (quote && Number.isFinite(rate) && rate > 0) rates[quote] = rate;
            if (row.date && row.date > latest) latest = row.date;
          }
          if (Object.keys(rates).length === 0) throw new SourceError(`У этого банка нет курсов к ${base}`);
          return snapshot(id, base, rates, latest || new Date().toISOString().slice(0, 10), false);
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    },
  },
  {
    id: 'coinbase',
    title: 'Coinbase',
    description: 'Обычные валюты и сотни криптовалют, курс почти в реальном времени.',
    homepage: 'https://www.coinbase.com',
    freshFor: MINUTE,
    async fetch() {
      const { data } = await getJSON('https://api.coinbase.com/v2/exchange-rates?currency=USD');
      return snapshot(this.id, data?.currency || 'USD', toRateMap(data?.rates), new Date().toISOString(), true);
    },
  },
  {
    id: 'cbr',
    title: 'Банк России (ЦБ РФ)',
    description: 'Официальный курс к рублю, около 50 валют. Обновляется по рабочим дням.',
    homepage: 'https://www.cbr-xml-daily.ru',
    freshFor: HOUR,
    async fetch() {
      const json = await getJSON('https://www.cbr-xml-daily.ru/daily_json.js');
      const rates = {};
      for (const [key, v] of Object.entries(json.Valute ?? {})) {
        const nominal = Number(v.Nominal) || 1;
        const value = Number(v.Value); // рублей за nominal единиц валюты
        if (Number.isFinite(value) && value > 0) rates[(v.CharCode || key).toUpperCase()] = nominal / value;
      }
      return snapshot(this.id, 'RUB', rates, json.Date, true);
    },
  },
];

export const DEFAULT_SOURCE_ID = 'erapi';

export function isFrankfurter(id) {
  return id === 'frankfurter' || id.startsWith('frankfurter:');
}

export function bankKeyOf(id) {
  return id.startsWith('frankfurter:') ? id.slice('frankfurter:'.length) : '';
}

export function sourceById(id) {
  if (isFrankfurter(id)) return SOURCES.find((s) => s.id === 'frankfurter');
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}

export function sourceTitle(id, banks = []) {
  const key = bankKeyOf(id);
  if (key) return `Центробанк: ${banks.find((b) => b.key === key)?.name ?? key}`;
  return sourceById(id).title;
}

/** Скачать курсы для источника с данным id (учитывает выбранный банк Frankfurter). */
export function fetchRates(id, wanted, banks = []) {
  const source = sourceById(id);
  const bankKey = bankKeyOf(id);
  const pivot = banks.find((b) => b.key === bankKey)?.pivot ?? null;
  return source.fetch(wanted, { bankKey, pivot });
}

/** Каталог центробанков Frankfurter: GET /v2/providers. */
export async function fetchBanks() {
  const list = await getJSON(`${FRANKFURTER_API}/v2/providers`);
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && p.key)
    .map((p) => ({
      key: p.key,
      name: p.name || p.key,
      country: p.country_code || null,
      pivot: p.pivot_currency || null,
      currencyCount: Array.isArray(p.currencies) ? p.currencies.length : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
