import {
  COMMON, badgeText, convert, currencyName, decimalSeparator, defaultCurrencies, flagRegion,
  formatAmount, matchesQuery, parseAmount, plural, sanitizeInput,
} from './core.js';
import {
  DEFAULT_SOURCE_ID, SOURCES, SourceError, bankKeyOf, fetchBanks, fetchRates, isFrankfurter,
  sourceById, sourceTitle,
} from './sources.js';

// ── Хранилище (localStorage) ──────────────────────────────────────────

const KEY_SETTINGS = 'cc.settings.v1';
const KEY_BANKS = 'cc.banks.v1';
const ratesKey = (id) => `cc.rates.v1.${id}`;
const DAY = 86_400_000;

const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим или нет места */ }
  },
  clearAll() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('cc.')).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

function loadSnapshot(id) {
  const snap = store.get(ratesKey(id));
  return snap && snap.rates && typeof snap.rates === 'object' ? snap : null;
}

// ── Состояние ─────────────────────────────────────────────────────────

const saved = store.get(KEY_SETTINGS) ?? {};
const savedBanks = store.get(KEY_BANKS) ?? {};
const sep = decimalSeparator();

const state = {
  currencies: Array.isArray(saved.currencies) ? saved.currencies : defaultCurrencies(),
  sourceId: typeof saved.sourceId === 'string' ? saved.sourceId : DEFAULT_SOURCE_ID,
  activeCode: typeof saved.activeCode === 'string' ? saved.activeCode : null,
  activeText: typeof saved.activeText === 'string' ? saved.activeText : '1',
  snapshot: null,
  loading: false,
  error: null,
  banks: Array.isArray(savedBanks.banks) ? savedBanks.banks : [],
  banksAt: Number(savedBanks.at) || 0,
  banksLoading: false,
  banksError: null,
};

let saveTimer = 0;
function saveSettings(delay = 0) {
  clearTimeout(saveTimer);
  const write = () => store.set(KEY_SETTINGS, {
    currencies: state.currencies,
    sourceId: state.sourceId,
    activeCode: state.activeCode,
    activeText: state.activeText,
  });
  if (delay) saveTimer = setTimeout(write, delay);
  else write();
}

const supports = (code) => !state.snapshot || code in state.snapshot.rates;

/** Что показать в поле валюты code. */
function valueFor(code) {
  if (code === state.activeCode) return state.activeText;
  const amount = parseAmount(state.activeText);
  if (!state.activeCode || amount == null) return '';
  const value = convert(state.snapshot, amount, state.activeCode, code);
  return value == null ? '' : formatAmount(value, sep);
}

/** «1 USD = 81,37 RUB» — направление выбираем так, чтобы число было ≥ 1. */
function rateHint(code) {
  const from = state.activeCode;
  if (!from || code === from || !state.snapshot) return '';
  const direct = convert(state.snapshot, 1, code, from);
  if (direct == null) return '';
  if (direct >= 1) return `1 ${code} = ${formatAmount(direct, sep)} ${from}`;
  return `1 ${from} = ${formatAmount(convert(state.snapshot, 1, from, code), sep)} ${code}`;
}

/** Активная валюта должна быть в списке и поддерживаться источником — иначе переносим сумму. */
function normalize() {
  if (state.currencies.length === 0) return;
  const current = state.activeCode;
  if (current && state.currencies.includes(current) && supports(current)) return;
  const target = state.currencies.find(supports);
  if (!target) return;
  const amount = parseAmount(state.activeText);
  const value = current && amount != null ? convert(state.snapshot, amount, current, target) : null;
  state.activeCode = target;
  if (value != null) state.activeText = formatAmount(value, sep);
}

// ── Загрузка курсов ───────────────────────────────────────────────────

let fetchToken = 0;

async function refresh(force = true) {
  const source = sourceById(state.sourceId);
  const snap = state.snapshot;
  if (!force && snap && Date.now() - snap.fetchedAt < source.freshFor) return;

  const token = ++fetchToken;
  const id = state.sourceId;
  state.loading = true;
  state.error = null;
  renderStatus();
  try {
    const fresh = await fetchRates(id, state.currencies, state.banks);
    if (token !== fetchToken) return; // пока качали, пользователь сменил источник
    store.set(ratesKey(id), fresh);
    state.snapshot = fresh;
    state.loading = false;
    normalize();
    renderAll();
  } catch (e) {
    if (token !== fetchToken) return;
    console.error(e);
    state.loading = false;
    state.error = e instanceof SourceError ? e.message : 'Не удалось получить курс';
    renderStatus();
  }
}

function setSource(id) {
  if (id === state.sourceId) return;
  fetchToken++; // ответ для прежнего источника больше не нужен
  state.sourceId = id;
  state.snapshot = loadSnapshot(id);
  state.loading = false;
  state.error = null;
  normalize();
  saveSettings();
  renderAll();
  refresh(false);
}

async function loadBanks(force = false) {
  if (state.banksLoading) return;
  if (!force && state.banks.length && Date.now() - state.banksAt < DAY) return;
  state.banksLoading = true;
  state.banksError = null;
  renderBankPicker();
  try {
    state.banks = await fetchBanks();
    state.banksAt = Date.now();
    store.set(KEY_BANKS, { banks: state.banks, at: state.banksAt });
  } catch (e) {
    state.banksError = e instanceof SourceError ? e.message : 'Список банков недоступен';
  } finally {
    state.banksLoading = false;
    renderBankPicker();
    renderStatus();
  }
}

function updateCurrencies(next) {
  state.currencies = [...new Set(next)];
  normalize();
  saveSettings();
  renderBoard();
  if (dialog.open) {
    renderMyList();
    renderAddList();
  }
}

// ── Отрисовка: главный экран ─────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const board = $('board');
const dialog = $('settings');
const rows = new Map(); // code → { row, input, hint }

function makeBadge(code, size = '') {
  const el = document.createElement('span');
  el.className = size ? `badge badge-${size}` : 'badge';
  el.setAttribute('aria-hidden', 'true');
  const showText = () => {
    el.replaceChildren(document.createTextNode(badgeText(code)));
    el.classList.add('badge-text');
  };
  const region = flagRegion(code);
  if (region) {
    const img = document.createElement('img');
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = `flags/${region}.svg`;
    img.addEventListener('error', showText, { once: true });
    el.append(img);
  } else {
    showText();
  }
  return el;
}

function renderBoard() {
  board.replaceChildren();
  rows.clear();
  for (const code of state.currencies) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.code = code;

    const meta = document.createElement('label');
    meta.className = 'meta';
    meta.htmlFor = `amount-${code}`;
    const codeEl = document.createElement('span');
    codeEl.className = 'code';
    codeEl.textContent = code;
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = currencyName(code);
    meta.append(codeEl, nameEl);

    const input = document.createElement('input');
    input.id = `amount-${code}`;
    input.className = 'amount';
    input.inputMode = 'decimal';
    input.enterKeyHint = 'done';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = '0';
    input.addEventListener('input', () => onAmountInput(code, input));
    input.addEventListener('focus', () => {
      // Выделяем сумму целиком: новое число сразу заменит старое.
      setTimeout(() => input.setSelectionRange(0, input.value.length), 0);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.id = `hint-${code}`;
    input.setAttribute('aria-describedby', hint.id);

    row.append(makeBadge(code), meta, input, hint);
    board.append(row);
    rows.set(code, { row, input, hint });
  }
  $('emptyState').hidden = state.currencies.length > 0;
  updateBoard();
}

/** Обновляет числа и подсказки, не пересоздавая поля (фокус и курсор остаются на месте). */
function updateBoard() {
  for (const [code, { row, input, hint }] of rows) {
    const ok = supports(code);
    const active = code === state.activeCode;
    row.classList.toggle('active', active);
    row.classList.toggle('unsupported', !ok);
    input.disabled = !ok;
    input.placeholder = ok ? '0' : '—';
    const text = valueFor(code);
    const typingHere = active && document.activeElement === input;
    if (!typingHere && input.value !== text) input.value = text;
    hint.textContent = ok ? rateHint(code) : 'У этого источника нет такой валюты';
  }
}

function onAmountInput(code, input) {
  const raw = input.value;
  const clean = sanitizeInput(raw);
  if (clean !== raw) {
    const caret = sanitizeInput(raw.slice(0, input.selectionStart ?? raw.length)).length;
    input.value = clean;
    input.setSelectionRange(caret, caret);
  }
  state.activeCode = code;
  state.activeText = clean;
  updateBoard();
  saveSettings(400);
}

function formatAsOf(snap) {
  if (!snap.asOf) return '—';
  const date = snap.asOfHasTime ? new Date(snap.asOf) : new Date(`${String(snap.asOf).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(snap.asOf);
  const options = snap.asOfHasTime
    ? { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'long', year: 'numeric' };
  return new Intl.DateTimeFormat(navigator.language, options).format(date);
}

function renderStatus() {
  const source = sourceById(state.sourceId);
  const link = $('sourceLink');
  link.textContent = sourceTitle(state.sourceId, state.banks);
  link.href = source.homepage;

  const snap = state.snapshot;
  $('asOf').textContent = snap
    ? `Курс на ${formatAsOf(snap)}`
    : state.loading ? 'Загружаю курс…' : 'Курс ещё не загружен';

  const refreshBtn = $('refreshBtn');
  refreshBtn.disabled = state.loading;
  refreshBtn.classList.toggle('spinning', state.loading);
  refreshBtn.setAttribute('aria-busy', String(state.loading));

  $('errorBox').hidden = !state.error;
  if (state.error) {
    $('errorText').textContent = snap ? `${state.error}. Пока показан сохранённый курс.` : `${state.error}.`;
  }

  const attribution = $('attribution');
  attribution.replaceChildren();
  if (source.attribution) {
    const a = document.createElement('a');
    a.href = source.homepage;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = source.attribution;
    attribution.append(a);
  }
}

function renderAll() {
  renderStatus();
  updateBoard();
  if (dialog.open) renderSettings();
}

// ── Отрисовка: настройки ──────────────────────────────────────────────

function renderSettings() {
  renderSources();
  renderBankPicker();
  renderMyList();
  renderAddList();
}

function renderSources() {
  const list = $('sourceList');
  list.replaceChildren();
  for (const s of SOURCES) {
    const checked = s.id === 'frankfurter' ? isFrankfurter(state.sourceId) : state.sourceId === s.id;
    const label = document.createElement('label');
    label.className = 'source-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'source';
    radio.value = s.id;
    radio.checked = checked;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setSource(s.id);
      if (s.id === 'frankfurter') loadBanks();
      list.querySelector(`input[value="${s.id}"]`)?.focus();
    });
    const text = document.createElement('span');
    text.className = 'source-text';
    const title = document.createElement('strong');
    title.textContent = s.title;
    const desc = document.createElement('span');
    desc.textContent = s.description;
    text.append(title, desc);
    label.append(radio, text);
    list.append(label);
  }
}

function renderBankPicker() {
  const picker = $('bankPicker');
  picker.hidden = !isFrankfurter(state.sourceId);
  if (picker.hidden) return;
  const select = $('bankSelect');
  const key = bankKeyOf(state.sourceId);
  select.replaceChildren(new Option('Все центробанки, сводный курс', ''));
  for (const b of state.banks) select.append(new Option(`${b.name} (${b.key})`, b.key));
  if (key && !state.banks.some((b) => b.key === key)) select.append(new Option(key, key));
  select.value = key;
  const n = state.banks.length;
  $('bankStatus').textContent = state.banksLoading
    ? 'Загружаю список банков…'
    : state.banksError
      ? `${state.banksError}. Сводный курс при этом доступен.`
      : n ? `В каталоге ${n} ${plural(n, 'источник', 'источника', 'источников')}.` : '';
}

const ICONS = {
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

function smallButton(icon, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn icon-btn-small';
  b.innerHTML = ICONS[icon];
  b.setAttribute('aria-label', label);
  b.title = label;
  b.dataset.action = icon;
  b.addEventListener('click', onClick);
  return b;
}

function currencyText(code, note) {
  const wrap = document.createElement('span');
  wrap.className = 'item-text';
  const c = document.createElement('strong');
  c.textContent = code;
  const n = document.createElement('span');
  n.textContent = currencyName(code);
  wrap.append(c, n);
  if (note) {
    const x = document.createElement('em');
    x.textContent = note;
    wrap.append(x);
  }
  return wrap;
}

function moveCurrency(code, delta) {
  const list = [...state.currencies];
  const from = list.indexOf(code);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return;
  list.splice(to, 0, list.splice(from, 1)[0]);
  updateCurrencies(list);
  // Возвращаем фокус на ту же стрелку, чтобы можно было двигать дальше с клавиатуры.
  const li = $('myList').querySelector(`li[data-code="${code}"]`);
  const again = li?.querySelector(`[data-action="${delta < 0 ? 'up' : 'down'}"]`);
  (again && !again.disabled ? again : li?.querySelector('button:not(:disabled)'))?.focus();
}

function placeBefore(dragged, target) {
  if (dragged === target) return;
  const list = [...state.currencies];
  const from = list.indexOf(dragged);
  const to = list.indexOf(target);
  if (from < 0 || to < 0) return;
  list.splice(from, 1);
  list.splice(to, 0, dragged);
  updateCurrencies(list);
}

function renderMyList() {
  const ol = $('myList');
  ol.replaceChildren();
  if (state.currencies.length === 0) {
    const li = document.createElement('li');
    li.className = 'fine empty-item';
    li.textContent = 'Пока пусто. Добавьте валюты из списка ниже.';
    ol.append(li);
    return;
  }
  state.currencies.forEach((code, i) => {
    const li = document.createElement('li');
    li.className = 'my-item';
    li.dataset.code = code;
    li.draggable = true;
    const missing = state.snapshot && !(code in state.snapshot.rates);
    const actions = document.createElement('span');
    actions.className = 'item-actions';
    const up = smallButton('up', `Поднять ${code}`, () => moveCurrency(code, -1));
    const down = smallButton('down', `Опустить ${code}`, () => moveCurrency(code, +1));
    const remove = smallButton('remove', `Убрать ${code}`, () => {
      updateCurrencies(state.currencies.filter((c) => c !== code));
      ($('myList').querySelector('button') ?? $('search')).focus();
    });
    up.disabled = i === 0;
    down.disabled = i === state.currencies.length - 1;
    actions.append(up, down, remove);
    li.append(makeBadge(code, 'small'), currencyText(code, missing ? 'нет у этого источника' : ''), actions);

    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', code);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drop-target');
      placeBefore(e.dataTransfer.getData('text/plain'), code);
    });
    ol.append(li);
  });
}

function renderAddList() {
  const query = $('search').value;
  const pool = new Set([...Object.keys(state.snapshot?.rates ?? {}), ...COMMON]);
  state.currencies.forEach((c) => pool.delete(c));
  const codes = [...pool].sort().filter((c) => matchesQuery(c, query));
  const ul = $('addList');
  ul.replaceChildren();
  if (codes.length === 0) {
    const li = document.createElement('li');
    li.className = 'fine empty-item';
    li.textContent = 'Ничего не нашлось. Попробуйте трёхбуквенный код, например GEL.';
    ul.append(li);
    return;
  }
  codes.forEach((code, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-item';
    const missing = state.snapshot && !(code in state.snapshot.rates);
    const plus = document.createElement('span');
    plus.className = 'add-icon';
    plus.innerHTML = ICONS.add;
    btn.append(makeBadge(code, 'small'), currencyText(code, missing ? 'нет у этого источника' : ''), plus);
    btn.addEventListener('click', () => {
      updateCurrencies([...state.currencies, code]);
      const next = $('addList').querySelectorAll('button')[i];
      (next ?? $('search')).focus();
    });
    li.append(btn);
    ul.append(li);
  });
}

// ── Перенос настроек ссылкой ──────────────────────────────────────────

function importFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const c = params.get('c');
  const s = params.get('s');
  if (c == null && s == null) return false;
  if (c != null) {
    state.currencies = [...new Set(c.split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,10}$/.test(x)))];
  }
  if (s) state.sourceId = s;
  history.replaceState(null, '', location.pathname + location.search);
  saveSettings();
  return true;
}

function shareLink() {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ c: state.currencies.join(','), s: state.sourceId }).toString();
  return url.toString();
}

// ── События ───────────────────────────────────────────────────────────

function openSettings() {
  $('search').value = '';
  $('shareStatus').textContent = '';
  renderSettings();
  dialog.showModal();
  if (isFrankfurter(state.sourceId)) loadBanks();
}

$('settingsBtn').addEventListener('click', openSettings);
$('emptySettingsBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // клик по затемнению
});
$('refreshBtn').addEventListener('click', () => refresh(true));
$('retryBtn').addEventListener('click', () => refresh(true));
$('search').addEventListener('input', renderAddList);
$('bankSelect').addEventListener('change', (e) => {
  const key = e.target.value;
  setSource(key ? `frankfurter:${key}` : 'frankfurter');
});

$('shareBtn').addEventListener('click', async () => {
  const link = shareLink();
  const status = $('shareStatus');
  try {
    await navigator.clipboard.writeText(link);
    status.textContent = 'Ссылка скопирована. Откройте её на другом устройстве.';
  } catch {
    status.textContent = `Скопируйте ссылку вручную: ${link}`;
  }
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('Сбросить выбранные валюты, источник и сохранённые курсы?')) return;
  store.clearAll();
  location.reload();
});

window.addEventListener('hashchange', () => {
  if (!importFromHash()) return;
  state.snapshot = loadSnapshot(state.sourceId);
  normalize();
  renderBoard();
  renderAll();
  refresh(false);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh(false);
});
window.addEventListener('online', () => refresh(false));

// ── Старт ─────────────────────────────────────────────────────────────

importFromHash();
state.snapshot = loadSnapshot(state.sourceId);
normalize();
renderBoard();
renderStatus();
refresh(false);
if (bankKeyOf(state.sourceId)) loadBanks(); // чтобы показать название выбранного банка

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн-режим просто не включится */ });
}
