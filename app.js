// ─────────────────────────────────────────────
//  app.js  —  Hisse Takibi
// ─────────────────────────────────────────────

// ── Hisse Listeleri (boş başlar, FMP'den dolar) ──
let BIST_LIST = (() => {
  try {
    const c = JSON.parse(localStorage.getItem('bist_list') || '[]');
    if (c.length >= 5 && 'div' in c[0]) return c;
    localStorage.removeItem('bist_list');
    sessionStorage.removeItem('bist_list_fetched');
  } catch (_) {}
  return [];
})();

let INTL_LIST = (() => {
  try {
    const c = JSON.parse(localStorage.getItem('intl_list') || '[]');
    if (c.length >= 5 && 'div' in c[0]) return c;
    localStorage.removeItem('intl_list');
    sessionStorage.removeItem('intl_list_fetched');
  } catch (_) {}
  return [];
})();

const EXCH_MAP = {
  NMS:'NASDAQ', NasdaqGS:'NASDAQ', NasdaqGM:'NASDAQ', NasdaqCM:'NASDAQ',
  NYQ:'NYSE', NYSE:'NYSE', PCX:'NYSE',
};

// ── State ──
let stocks = [], charts = {}, histories = {};
let curTab = 'bist', notifOn = false, toastT = null, showOnlyDiv = false;
if ('Notification' in window && Notification.permission === 'granted') notifOn = true;

// ── Worker proxy ──
const WORKER_URL = 'https://stock-proxy.burcufidan51.workers.dev';

async function fetchWithFallback(targetUrl) {
  const proxyUrl = WORKER_URL + new URL(targetUrl).pathname + new URL(targetUrl).search;
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Proxy hatasi: ' + res.status);
  const data = await res.json();
  if (!data?.chart?.result?.[0]) throw new Error('Yahoo verisi bos');
  return data;
}

function saveToStorage() {
  localStorage.setItem('my_tracked_stocks',
    JSON.stringify(stocks.map(s => ({ symbol: s.symbol, name: s.name, exchange: s.exchange }))));
}

// ── FMP yardimci ──
function parseFmpDiv(q) {
  const y = q.dividendYield || q.lastAnnualDividendYield || 0;
  if (y > 0) return y > 1 ? y / 100 : y;
  const amt = q.lastAnnualDividend || q.annualDividend || 0;
  const p   = q.price || 0;
  return amt > 0 && p > 0 ? amt / p : 0;
}

async function fetchBistList() {
  if (sessionStorage.getItem('bist_list_fetched') === '1') return;
  try {
    const res = await fetch(WORKER_URL + '/fmp/search-symbol?query=.IS', 
	{ signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw  = await res.json();
    const data = Array.isArray(raw) ? raw : (raw.stockList || raw.stocks || []);
    if (data.length < 5) throw new Error('Yetersiz: ' + data.length);
    const list = data
      .filter(q => q.symbol && (q.companyName || q.name))
      .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
      .map(q => ({ s: q.symbol.replace(/\.IS$/i, ''), n: q.companyName || q.name, div: parseFmpDiv(q) }));
    if (list.length < 5) throw new Error('Parse sonrasi yetersiz');
    BIST_LIST = list;
    localStorage.setItem('bist_list', JSON.stringify(list));
    sessionStorage.setItem('bist_list_fetched', '1');
    filterList();
    console.log('[Hisse] BIST listesi yuklendi: ' + list.length);
  } catch (err) {
    console.warn('[Hisse] BIST FMP basarisiz:', err.message);
  }
}

async function fetchIntlList() {
  if (sessionStorage.getItem('intl_list_fetched') === '1') return;
  try {
    // FMP'nin tüm hisseleri veren genel listesine istek atıyoruz
    const res = await fetch(WORKER_URL + '/fmp/stock/list', { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    
    const raw  = await res.json();
    const allStocks = Array.isArray(raw) ? raw : (raw.stockList || raw.stocks || []);
    
    // Gelen devasa listeden sadece NASDAQ ve NYSE olanları filtreleyip ilk 500 tanesini alıyoruz
    const data = allStocks
      .filter(q => (q.exchangeShortName === 'NASDAQ' || q.exchangeShortName === 'NYSE') && q.symbol && !q.symbol.includes('.'))
      .slice(0, 500);

    if (data.length < 5) throw new Error('Yetersiz: ' + data.length);
    
    const list = data
      .map(q => ({
        s: q.symbol,
        n: q.name || q.companyName || q.symbol,
        x: EXCH_MAP[q.exchangeShortName] || (q.exchangeShortName === 'NYSE' ? 'NYSE' : 'NASDAQ'),
        div: 0 // Temel liste API'sinde temettü verisi genelde gelmez
      }));
      
    if (list.length < 5) throw new Error('Parse sonrasi yetersiz');
    
    INTL_LIST = list;
    localStorage.setItem('intl_list', JSON.stringify(list));
    sessionStorage.setItem('intl_list_fetched', '1');
    filterList();
    console.log('[Hisse] INTL listesi yuklendi: ' + list.length);
  } catch (err) {
    console.warn('[Hisse] INTL FMP basarisiz:', err.message);
  }
}

// ── Veri cekme ──
async function fetchStockPrice(symbol, exchange) {
  const ticker = exchange === 'BIST' ? symbol + '.IS' : symbol;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1wk&range=1y';
  const data   = await fetchWithFallback(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Sembol bulunamadi');

  const meta  = result.meta;
  const price = meta.regularMarketPrice;
  if (!price) throw new Error('Fiyat alinamadi');

  const prev      = meta.chartPreviousClose || meta.previousClose || price;
  const change    = +(price - prev).toFixed(4);
  const changePct = +((change / prev) * 100).toFixed(4);

  const q       = result.indicators?.quote?.[0] || {};
  const closes  = (q.close  || []).filter(v => v != null);
  const highs   = (q.high   || []).filter(v => v != null);
  const lows    = (q.low    || []).filter(v => v != null);
  const volumes = (q.volume || []).filter(v => v != null);

  const yesterday = highs.length >= 2 ? {
    high:   highs[highs.length - 2],
    low:    lows[lows.length - 2],
    volume: volumes[volumes.length - 2],
  } : null;

  // Temettü — meta alanlarini dene
  const metaYield = meta.dividendYield || meta.trailingAnnualDividendYield || 0;
  const metaRate  = meta.dividendRate  || meta.trailingAnnualDividendRate  || 0;
  let dividendYield = metaYield || (metaRate > 0 && price > 0 ? metaRate / price : 0);

  // BIST icin events.dividends'tan hesapla
  if (!dividendYield) {
    const evDivs   = result.events?.dividends || {};
    const oneYrAgo = Date.now() / 1000 - 365 * 24 * 3600;
    const annual   = Object.values(evDivs)
      .filter(d => d.date > oneYrAgo)
      .reduce((sum, d) => sum + (d.amount || 0), 0);
    if (annual > 0 && price > 0) dividendYield = annual / price;
  }

  return {
    price, change, changePct,
    high:     meta.regularMarketDayHigh || highs[highs.length - 1] || price,
    low:      meta.regularMarketDayLow  || lows[lows.length - 1]   || price,
    volume:   meta.regularMarketVolume  || volumes[volumes.length - 1] || 0,
    yesterday,
    dividendYield,
    currency: meta.currency || (exchange === 'BIST' ? 'TRY' : 'USD'),
    closes,
  };
}

// ── Format ──
function fmt(v, cur) {
  if (v == null) return '-';
  return cur === 'TRY'
    ? v.toLocaleString('tr-TR', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' TL'
    : '$' + v.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}
function fmtVol(v) {
  if (!v) return '-';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}
function dirOf(c)    { return c > 0.001 ? 'up' : c < -0.001 ? 'down' : 'neutral'; }
function chartCol(d) { return d === 'up' ? '#10b981' : d === 'down' ? '#f43f5e' : '#64748b'; }
function chartBg(d)  { return d === 'up' ? 'rgba(16,185,129,.08)' : d === 'down' ? 'rgba(244,63,94,.08)' : 'rgba(100,116,139,.05)'; }

// ── Bildirim ──
function updateBellUI() {
  const b = document.getElementById('bell-btn');
  if (!('Notification' in window)) { b.style.opacity = '.3'; b.style.pointerEvents = 'none'; return; }
  b.className = 'btn btn-icon btn-bell' +
    (Notification.permission === 'denied' ? ' denied' : notifOn ? ' on' : '');
  b.title = notifOn ? 'Bildirimleri kapat' :
    Notification.permission === 'denied' ? 'Tarayicidan izin ver' : 'Bildirime izin ver';
}
async function toggleNotif() {
  if (!('Notification' in window)) return;
  if (notifOn) { notifOn = false; updateBellUI(); return; }
  if (Notification.permission === 'denied') return;
  notifOn = (await Notification.requestPermission()) === 'granted';
  updateBellUI();
}

// ── Toast ──
function showToast(sym, name, priceStr, pct) {
  clearTimeout(toastT);
  document.getElementById('toast-sym').textContent  = 'Dustu: ' + sym;
  document.getElementById('toast-body').textContent = name + '\n' + priceStr + '  v' + Math.abs(pct).toFixed(2) + '%';
  document.getElementById('toast').classList.add('show');
  toastT = setTimeout(() => document.getElementById('toast').classList.remove('show'), 5500);
}
function maybeNotify(s, oldPrice) {
  if (!s.data || !oldPrice || s.data.price >= oldPrice) return;
  const pct = ((s.data.price - oldPrice) / oldPrice) * 100;
  const ps  = fmt(s.data.price, s.data.currency);
  showToast(s.symbol, s.name, ps, pct);
  const card = document.getElementById('card-' + s.symbol);
  if (card) {
    card.classList.remove('pulse-up', 'pulse-down');
    void card.offsetWidth;
    card.classList.add('pulse-down');
    setTimeout(() => card.classList.remove('pulse-down'), 1900);
  }
  if (notifOn && Notification.permission === 'granted') {
    try { new Notification(s.symbol + ' dustu', { body: s.name + '\n' + ps, tag: 'drop-' + s.symbol }); }
    catch (e) {}
  }
}

// ── Card ──
function makeSkeletonCard(sym, name, exch) {
  const d = document.createElement('div');
  d.className = 'card';
  d.id = 'card-' + sym;
  d.innerHTML =
    '<div class="c-hdr">' +
      '<div>' +
        '<div class="c-sym">' + sym + '<span class="c-xch">' + exch + '</span></div>' +
        '<div class="c-name">' + name + '</div>' +
      '</div>' +
      '<button class="rm-btn" onclick="removeStock(\'' + sym + '\')" title="Kaldir"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<div class="c-price"><div class="skel-box" style="width:130px;height:28px;border-radius:5px"></div></div>' +
    '<div class="c-badges"><span class="badge loading">Veri cekiliyor...</span></div>' +
    '<div class="chart-area"><canvas id="cv-' + sym + '" aria-label="' + sym + ' grafik"></canvas></div>' +
    '<div class="sep"></div>' +
    '<div class="c-meta">' +
      '<div class="m-col"><div class="m-lbl">Yuksek</div><div class="m-val" data-k="high-today">-</div><div class="m-val m-prev" data-k="high-prev">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Dusuk</div><div class="m-val" data-k="low-today">-</div><div class="m-val m-prev" data-k="low-prev">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Hacim</div><div class="m-val" data-k="vol-today">-</div><div class="m-val m-prev" data-k="vol-prev">-</div></div>' +
    '</div>';
  return d;
}

function updateCard(s, prevPrice) {
  const d = s.data;
  if (!d) return;
  const D     = dirOf(d.change);
  const arrow = D === 'up' ? '+' : D === 'down' ? '-' : '';
  const sign  = d.change >= 0 ? '+' : '';
  const card  = document.getElementById('card-' + s.symbol);
  if (!card) return;

  // Pulse
  if (typeof prevPrice === 'number' && prevPrice !== d.price) {
    const pc = d.price > prevPrice ? 'pulse-up' : 'pulse-down';
    card.classList.remove('pulse-up', 'pulse-down');
    void card.offsetWidth;
    card.classList.add(pc);
    setTimeout(() => card.classList.remove(pc), 1900);
  }

  card.className = 'card ' + D;

  const priceEl  = card.querySelector('.c-price');
  const badgesEl = card.querySelector('.c-badges');
  const g        = function(k) { return card.querySelector('[data-k="' + k + '"]'); };

  if (priceEl) priceEl.textContent = fmt(d.price, d.currency);

  if (badgesEl) {
    var changeTxt = Math.abs(d.changePct).toFixed(2) + '% (' + sign + d.change.toFixed(2) + ')';
    var divSpan   = d.dividendYield > 0
      ? '<span class="badge div"><i class="ti ti-coin"></i> ' + (d.dividendYield * 100).toFixed(2) + '% TEM</span>'
      : '';
    badgesEl.innerHTML = '<span class="badge ' + D + '">' + arrow + ' ' + changeTxt + '</span>' + divSpan;
  }

  if (g('high-today')) g('high-today').textContent = fmt(d.high,   d.currency);
  if (g('low-today'))  g('low-today').textContent  = fmt(d.low,    d.currency);
  if (g('vol-today'))  g('vol-today').textContent  = fmtVol(d.volume);

  if (d.yesterday) {
    if (g('high-prev')) g('high-prev').textContent = fmt(d.yesterday.high,   d.currency);
    if (g('low-prev'))  g('low-prev').textContent  = fmt(d.yesterday.low,    d.currency);
    if (g('vol-prev'))  g('vol-prev').textContent  = fmtVol(d.yesterday.volume);
  }

  var hist = d.closes.length ? d.closes : (histories[s.symbol] || [d.price]);
  histories[s.symbol] = hist;
  var cc = chartCol(D), cb = chartBg(D);

  if (charts[s.symbol]) {
    var ch = charts[s.symbol];
    ch.data.labels                      = hist.map(function() { return ''; });
    ch.data.datasets[0].data            = hist;
    ch.data.datasets[0].borderColor     = cc;
    ch.data.datasets[0].backgroundColor = cb;
    ch.update('none');
  } else {
    var ctx = document.getElementById('cv-' + s.symbol);
    if (ctx) {
      charts[s.symbol] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: hist.map(function() { return ''; }),
          datasets: [{ data: hist, borderColor: cc, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: cb, tension: 0.4 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false, grace: '8%' } },
        },
      });
    }
  }
}

function setError(sym, msg) {
  var card  = document.getElementById('card-' + sym);
  if (!card) return;
  card.className = 'card error';
  var badge = card.querySelector('.badge');
  var price = card.querySelector('.c-price');
  if (price) price.textContent = '-';
  if (badge) {
    badge.textContent = '! ' + (msg || 'Hata') + ' - tekrar dene';
    badge.className   = 'badge error';
    badge.onclick     = function() { retryFetch(sym); };
  }
}

// ── Ekle / Kaldir / Yenile ──
async function addStock(sym, name, exch) {
  if (stocks.find(function(s) { return s.symbol === sym; })) return;
  histories[sym] = [];
  var s = { symbol: sym, name: name, exchange: exch, data: null };
  stocks.push(s);
  saveToStorage();
  closeModal();
  renderUI();
  document.getElementById('grid').appendChild(makeSkeletonCard(sym, name, exch));
  try {
    s.data = await fetchStockPrice(sym, exch);
    updateCard(s, null);
    updateSummary();
    setUpd();
  } catch (e) {
    setError(sym, e.message.slice(0, 30));
  }
}

async function retryFetch(sym) {
  var s = stocks.find(function(x) { return x.symbol === sym; });
  if (!s) return;
  var b = document.querySelector('#card-' + sym + ' .badge');
  if (b) { b.textContent = 'Yeniden deneniyor...'; b.className = 'badge loading'; b.onclick = null; }
  try {
    s.data = await fetchStockPrice(sym, s.exchange);
    updateCard(s, null);
    updateSummary();
    setUpd();
  } catch (e) {
    setError(sym, e.message.slice(0, 30));
  }
}

function removeStock(sym) {
  if (charts[sym]) { charts[sym].destroy(); delete charts[sym]; }
  delete histories[sym];
  stocks = stocks.filter(function(s) { return s.symbol !== sym; });
  saveToStorage();
  var c = document.getElementById('card-' + sym);
  if (c) c.remove();
  renderUI();
}

async function refreshAll() {
  if (!stocks.length) return;
  var btn  = document.getElementById('ref-btn');
  var icon = document.getElementById('ref-icon');
  btn.disabled = true;
  icon.style.animation = 'spin 1s linear infinite';

  await Promise.all(stocks.map(async function(s) {
    var old = s.data ? s.data.price : null;
    var b   = document.querySelector('#card-' + s.symbol + ' .badge');
    if (b) { b.textContent = 'Guncelleniyor...'; b.className = 'badge loading'; }
    try {
      s.data = await fetchStockPrice(s.symbol, s.exchange);
      updateCard(s, old);
      maybeNotify(s, old);
    } catch (e) {
      setError(s.symbol, e.message.slice(0, 30));
    }
  }));

  updateSummary();
  setUpd();
  btn.disabled = false;
  icon.style.animation = '';
}

// ── UI ──
function renderUI() {
  var has = stocks.length > 0;
  document.getElementById('empty-state').style.display = has ? 'none'        : 'flex';
  document.getElementById('sbar').style.display        = has ? 'grid'        : 'none';
  document.getElementById('live-tag').style.display    = has ? 'flex'        : 'none';
  document.getElementById('ref-btn').style.display     = has ? 'inline-flex' : 'none';
  updateSummary();
}
function updateSummary() {
  var wd = stocks.filter(function(s) { return s.data; });
  document.getElementById('sc-t').textContent = stocks.length;
  document.getElementById('sc-u').textContent = wd.filter(function(s) { return s.data.change >= 0; }).length;
  document.getElementById('sc-d').textContent = wd.filter(function(s) { return s.data.change < 0;  }).length;
}
function setUpd() {
  document.getElementById('upd').textContent = new Date().toLocaleTimeString('tr-TR');
}

// ── Modal ──
function openModal() {
  document.getElementById('overlay').classList.add('open');
  document.getElementById('search-inp').value = '';
  document.getElementById('m-sym').value      = '';
  document.getElementById('m-name').value     = '';
  document.getElementById('cerr').style.display = 'none';
  switchTab('bist');
  setTimeout(function() { document.getElementById('search-inp').focus(); }, 60);
}
function closeModal() { document.getElementById('overlay').classList.remove('open'); }
function bgClick(e)   { if (e.target.id === 'overlay') closeModal(); }
function clearErr()   { document.getElementById('cerr').style.display = 'none'; }

function switchTab(t) {
  curTab = t;
  showOnlyDiv = false;
  var btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.remove('active');
  document.getElementById('tb-bist').className = 'tab' + (t === 'bist' ? ' active' : '');
  document.getElementById('tb-intl').className = 'tab' + (t === 'intl' ? ' active' : '');
  document.getElementById('search-inp').value = '';
  filterList();
}

function toggleDivFilter() {
  showOnlyDiv = !showOnlyDiv;
  var btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.toggle('active', showOnlyDiv);
  filterList();
}

function filterList() {
  var q   = document.getElementById('search-inp').value.toLowerCase().trim();
  var raw = curTab === 'bist'
    ? BIST_LIST.map(function(x) { return Object.assign({}, x, { x: 'BIST' }); })
    : INTL_LIST;

  var filtered = showOnlyDiv ? raw.filter(function(x) { return (x.div || 0) > 0; }) : raw;
  if (q) filtered = filtered.filter(function(x) {
    return x.s.toLowerCase().includes(q) || x.n.toLowerCase().includes(q);
  });

  var el = document.getElementById('s-list');
  el.innerHTML = '';

  if (!filtered.length) {
    var msg = raw.length === 0
      ? '<i class="ti ti-loader" style="animation:spin 1.2s linear infinite;display:inline-block;font-size:20px;margin-bottom:8px"></i><br>Liste yukleniyor...'
      : (showOnlyDiv ? 'Temettü verisi olan hisse bulunamadi' : 'Sonuc bulunamadi');
    el.innerHTML = '<div style="padding:22px;text-align:center;font-size:12px;color:var(--muted)">' + msg + '</div>';
    return;
  }

  filtered.forEach(function(item) {
    var added  = !!stocks.find(function(s) { return s.symbol === item.s; });
    var divBadge = item.div > 0
      ? '<span class="s-div">' + (item.div * 100).toFixed(1) + '%</span>'
      : '';
    var div = document.createElement('div');
    div.className = 's-item' + (added ? ' added' : '');
    div.innerHTML =
      '<div>' +
        '<div class="s-sym">' + item.s + ' ' + divBadge + '</div>' +
        '<div class="s-name">' + item.n + '</div>' +
      '</div>' +
      '<i class="ti ti-' + (added ? 'check' : 'plus') + '" style="font-size:15px;color:' + (added ? 'var(--up)' : 'var(--muted)') + '"></i>';
    if (!added) {
      (function(i) {
        div.onclick = function() { addStock(i.s, i.n, i.x || 'BIST'); };
      })(item);
    }
    el.appendChild(div);
  });
}

function addManual() {
  var sym  = document.getElementById('m-sym').value.trim().toUpperCase();
  var name = document.getElementById('m-name').value.trim() || sym;
  var exch = document.getElementById('m-exch').value;
  var err  = document.getElementById('cerr');
  if (!sym) { err.textContent = 'Sembol giriniz.'; err.style.display = 'block'; return; }
  if (stocks.find(function(s) { return s.symbol === sym; })) {
    err.textContent = 'Bu sembol zaten listede.'; err.style.display = 'block'; return;
  }
  addStock(sym, name, exch);
}

document.getElementById('m-sym').addEventListener('keydown', function(e) { if (e.key === 'Enter') addManual(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

// ── Basla ──
updateBellUI();
filterList();
fetchBistList();
fetchIntlList();

var savedStocks = localStorage.getItem('my_tracked_stocks');
if (savedStocks) {
  try {
    JSON.parse(savedStocks).forEach(function(item) {
      addStock(item.symbol, item.name, item.exchange);
    });
  } catch (e) { console.error('Kayitli veriler yuklenemedi:', e); }
}

// ── Otomatik yenileme ──
function getMarketOpen() {
  var now   = new Date();
  var trMin = ((now.getUTCHours() + 3) % 24) * 60 + now.getUTCMinutes();
  var day   = now.getUTCDay();
  var wd    = day >= 1 && day <= 5;
  return wd && ((trMin >= 600 && trMin < 1080) || (trMin >= 990 && trMin < 1380));
}

var refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  var isModalOpen = document.getElementById('overlay').classList.contains('open');
  if (isModalOpen || !stocks.length) { refreshTimer = setTimeout(scheduleRefresh, 5000); return; }
  var interval = getMarketOpen() ? 30000 : 300000;
  refreshTimer = setTimeout(async function() { await refreshAll(); scheduleRefresh(); }, interval);
}
scheduleRefresh();

if (location.protocol === 'file:') {
  document.getElementById('file-warn').style.display = 'block';
}