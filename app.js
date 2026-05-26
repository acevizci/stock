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

// ── State ──
let stocks = [], charts = {}, histories = {}, chartRanges = {};
let portfolioData = {}, targetData = {}, usdtryRate = null;
let curTab = 'bist', notifOn = false, toastT = null, showOnlyDiv = false;
if ('Notification' in window && Notification.permission === 'granted') notifOn = true;

// ── Portföy & Hedef — localStorage ──
function loadPortfolio() {
  try { portfolioData = JSON.parse(localStorage.getItem('portfolio_data') || '{}'); }
  catch(_) { portfolioData = {}; }
}
function savePortfolio() {
  localStorage.setItem('portfolio_data', JSON.stringify(portfolioData));
}
function loadTargets() {
  try { targetData = JSON.parse(localStorage.getItem('target_data') || '{}'); }
  catch(_) { targetData = {}; }
}
function saveTargets() {
  localStorage.setItem('target_data', JSON.stringify(targetData));
}

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

let BIST_DIVIDENDS = {};

async function fetchBistDividends() {
  if (Object.keys(BIST_DIVIDENDS).length > 0) return;
  try {
    const res = await fetch(WORKER_URL + '/api/bist-dividends');
    if (res.ok) {
      BIST_DIVIDENDS = await res.json();
      console.log('[Temettü] Yüklendi: ' + Object.keys(BIST_DIVIDENDS).length + ' hisse');
    }
  } catch (e) { console.warn('[Temettü] Çekim başarısız:', e); }
}

async function fetchBistList() {
  if (sessionStorage.getItem('bist_list_fetched') === '1') return;
  try {
    await fetchBistDividends();
    const res  = await fetch(WORKER_URL + '/fmp/search-symbol?query=.IS', { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw  = await res.json();
    const data = Array.isArray(raw) ? raw : (raw.stockList || raw.stocks || []);
    if (data.length < 5) throw new Error('Yetersiz: ' + data.length);
    const list = data
      .filter(q => q.symbol && (q.companyName || q.name))
      .map(q => {
        let sym = q.symbol.replace(/\.IS$/i, '');
        return { s: sym, n: q.companyName || q.name, div: BIST_DIVIDENDS[sym] || 0 };
      });
    if (list.length < 5) throw new Error('Parse sonrasi yetersiz');
    BIST_LIST = list;
    localStorage.setItem('bist_list', JSON.stringify(list));
    sessionStorage.setItem('bist_list_fetched', '1');
    filterList();
    console.log('[Hisse] BIST listesi yuklendi: ' + list.length);
  } catch (err) { console.warn('[Hisse] BIST FMP basarisiz:', err.message); }
}

// ── Veri çekme ──
async function fetchStockPrice(symbol, exchange, range) {
  range = range || '1y';
  // 5 yıllık veri için haftalık bar; kısa aralıklarda günlük
  var interval = range === '5y' ? '1wk' : '1d';
  const ticker = exchange === 'BIST' ? symbol + '.IS' : symbol;
  const url    = 'https://query1.finance.yahoo.com/v8/finance/chart/'
                 + ticker + '?interval=' + interval + '&range=' + range;
  const data   = await fetchWithFallback(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Sembol bulunamadi');

  const meta  = result.meta;
  const price = meta.regularMarketPrice;
  if (!price) throw new Error('Fiyat alinamadi');

  const prev      = meta.chartPreviousClose || meta.previousClose || price;
  const change    = +(price - prev).toFixed(4);
  const changePct = +((change / prev) * 100).toFixed(4);

  const q = result.indicators?.quote?.[0] || {};

  // Tüm OHLCV dizilerini aynı indeks üzerinden hizala (Bug 4 fix)
  const rawClose  = q.close  || [];
  const rawHigh   = q.high   || [];
  const rawLow    = q.low    || [];
  const rawVolume = q.volume || [];

  const aligned = rawClose
    .map((c, i) => ({ close: c, high: rawHigh[i] ?? null, low: rawLow[i] ?? null, volume: rawVolume[i] ?? null }))
    .filter(d => d.close != null);

  const closes  = aligned.map(d => d.close);
  const highs   = aligned.map(d => d.high);
  const lows    = aligned.map(d => d.low);
  const volumes = aligned.map(d => d.volume);

  const yesterday = aligned.length >= 2 ? {
    high:   aligned[aligned.length - 2].high,
    low:    aligned[aligned.length - 2].low,
    volume: aligned[aligned.length - 2].volume,
  } : null;

  // Temettü — meta alanlarını dene
  const metaYield = meta.dividendYield || meta.trailingAnnualDividendYield || 0;
  const metaRate  = meta.dividendRate  || meta.trailingAnnualDividendRate  || 0;
  let dividendYield = metaYield || (metaRate > 0 && price > 0 ? metaRate / price : 0);

  // events.dividends — hem yield hesabı hem de son temettü detayı
  const evDivs     = result.events?.dividends || {};
  const oneYrAgo   = Date.now() / 1000 - 365 * 24 * 3600;
  const recentDivs = Object.values(evDivs)
    .filter(d => d.date > oneYrAgo)
    .sort((a, b) => b.date - a.date);

  if (!dividendYield) {
    const annual = recentDivs.reduce((sum, d) => sum + (d.amount || 0), 0);
    if (annual > 0 && price > 0) dividendYield = annual / price;
  }

  // Worker temettü fallback
  if (!dividendYield && exchange === 'BIST') {
    if (Object.keys(BIST_DIVIDENDS).length === 0) await fetchBistDividends();
    if (BIST_DIVIDENDS[symbol]) dividendYield = BIST_DIVIDENDS[symbol];
  }

  // Son temettü detayı (Orta Vadeli #9)
  const lastDividend = recentDivs.length > 0 ? {
    amount: recentDivs[0].amount,
    date:   recentDivs[0].date,
    count:  recentDivs.length,
  } : null;

  return {
    price, change, changePct,
    high:         meta.regularMarketDayHigh || highs[highs.length - 1] || price,
    low:          meta.regularMarketDayLow  || lows[lows.length - 1]   || price,
    volume:       meta.regularMarketVolume  || volumes[volumes.length - 1] || 0,
    yesterday,
    dividendYield,
    lastDividend,
    currency:     meta.currency || (exchange === 'BIST' ? 'TRY' : 'USD'),
    closes,
    weekHigh52:   meta.fiftyTwoWeekHigh || null,
    weekLow52:    meta.fiftyTwoWeekLow  || null,
    avgVolume:    meta.averageDailyVolume10Day || meta.averageDailyVolume3Month || null,
    marketCap:    meta.marketCap || null,
    eps:          meta.epsTrailingTwelveMonths || null,
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
function fmtMcap(v, cur) {
  if (!v) return '-';
  var s = cur === 'TRY' ? ' TL' : '$';
  if (v >= 1e12) return (v / 1e12).toFixed(2) + ' Tr' + s;
  if (v >= 1e9)  return (v / 1e9).toFixed(2)  + ' Mr' + s;
  if (v >= 1e6)  return (v / 1e6).toFixed(1)  + ' Mn' + s;
  return String(Math.round(v)) + s;
}
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('tr-TR', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function dirOf(c)    { return c > 0.001 ? 'up' : c < -0.001 ? 'down' : 'neutral'; }
function chartCol(d) { return d === 'up' ? '#10b981' : d === 'down' ? '#f43f5e' : '#64748b'; }
function chartBg(d)  { return d === 'up' ? 'rgba(16,185,129,.08)' : d === 'down' ? 'rgba(244,63,94,.08)' : 'rgba(100,116,139,.05)'; }
function peStr(price, eps) {
  if (eps == null || eps === 0) return '-';
  var pe = price / eps;
  if (pe < 0) return 'Zarar';
  return pe.toFixed(1) + '×';
}
function volRatioStr(vol, avg) {
  if (!avg || !vol) return '';
  return (vol / avg).toFixed(1) + '× ort.';
}

// ── RSI — 14 günlük, Wilder yöntemi (Orta Vadeli #8) ──
function calcRSI(closes, period) {
  period = period || 14;
  if (!closes || closes.length < period + 1) return null;
  var start = closes.length - period - 1;
  var gains = 0, losses = 0;
  for (var i = start + 1; i <= start + period; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else           losses -= diff;
  }
  var avgGain = gains  / period;
  var avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

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
function showToast(sym, msg, detail, dir) {
  clearTimeout(toastT);
  var symEl   = document.getElementById('toast-sym');
  var bodyEl  = document.getElementById('toast-body');
  var toastEl = document.getElementById('toast');
  symEl.textContent = (dir === 'up' ? '↑ ' : '↓ ') + sym + (msg ? '  ' + msg : '');
  symEl.style.color = dir === 'up' ? 'var(--up)' : 'var(--dn)';
  bodyEl.textContent = detail || '';
  toastEl.classList.add('show');
  toastT = setTimeout(function() { toastEl.classList.remove('show'); }, 5500);
}

function maybeNotify(s, oldPrice) {
  if (!s.data || !oldPrice || s.data.price >= oldPrice) return;
  var pct = ((s.data.price - oldPrice) / oldPrice) * 100;
  var ps  = fmt(s.data.price, s.data.currency);
  showToast(s.symbol, s.name, ps + '  ▾ ' + Math.abs(pct).toFixed(2) + '%', 'down');
  if (notifOn && Notification.permission === 'granted') {
    try { new Notification(s.symbol + ' düştü', { body: s.name + '\n' + ps, tag: 'drop-' + s.symbol }); }
    catch (e) {}
  }
}

// ── Hedef Fiyat Alarmları (Orta Vadeli #7) ──
function checkTargetAlerts(s, oldPrice) {
  var t = targetData[s.symbol];
  if (!t || !s.data || !oldPrice) return;
  var np  = s.data.price;
  var cur = s.data.currency;
  var ps  = fmt(np, cur);
  if (t.upper && oldPrice < t.upper && np >= t.upper) {
    showToast(s.symbol, 'Üst hedefe ulaştı', s.name + '\n' + ps, 'up');
    if (notifOn && Notification.permission === 'granted') {
      try { new Notification(s.symbol + ' ↑ Hedef', { body: s.name + ' — ' + ps, tag: 'tgt-u-' + s.symbol }); } catch(e) {}
    }
  }
  if (t.lower && oldPrice > t.lower && np <= t.lower) {
    showToast(s.symbol, 'Alt limite düştü', s.name + '\n' + ps, 'down');
    if (notifOn && Notification.permission === 'granted') {
      try { new Notification(s.symbol + ' ↓ Alt Limit', { body: s.name + ' — ' + ps, tag: 'tgt-l-' + s.symbol }); } catch(e) {}
    }
  }
}

// ── USD/TRY Kuru (Orta Vadeli #10) ──
async function fetchUsdTryRate() {
  try {
    var url    = 'https://query1.finance.yahoo.com/v8/finance/chart/USDTRY=X?interval=1d&range=1mo';
    var data   = await fetchWithFallback(url);
    var result = data?.chart?.result?.[0];
    if (!result) return;
    var meta  = result.meta;
    var price = meta.regularMarketPrice;
    if (!price) return;
    var prev      = meta.chartPreviousClose || meta.previousClose || price;
    var changePct = ((price - prev) / prev) * 100;
    var q         = result.indicators?.quote?.[0] || {};
    var closes    = (q.close || []).filter(function(v) { return v != null; });
    usdtryRate = { price: price, changePct: changePct, closes: closes };
    updateUsdTryCard();
    // Açık portföy panellerini yeni kur ile yenile
    stocks.forEach(function(s) {
      if (s.data) updatePortfolioPanel(s.symbol, s.data.price, s.data.currency);
    });
  } catch(e) { console.warn('[USD/TRY] Çekim başarısız:', e.message); }
}

function makeUsdTrySkeletonCard() {
  var d = document.createElement('div');
  d.className = 'card kur-card';
  d.id = 'card-USDTRY';
  d.innerHTML =
    '<div class="c-hdr">' +
      '<div>' +
        '<div class="c-sym">USD<span class="c-xch">TRY</span></div>' +
        '<div class="c-name">Döviz Kuru</div>' +
      '</div>' +
      '<div class="live-dot" style="flex-shrink:0;margin-top:4px"></div>' +
    '</div>' +
    '<div class="c-price" id="kur-price"><div class="skel-box" style="width:120px;height:28px;border-radius:5px"></div></div>' +
    '<div class="c-badges" id="kur-badges"><span class="badge loading">Yükleniyor...</span></div>' +
    '<div class="chart-area"><canvas id="cv-USDTRY" aria-label="USD/TRY grafik"></canvas></div>' +
    '<div class="sep"></div>' +
    '<div class="kur-port" id="kur-port" style="display:none">' +
      '<div class="m-lbl" style="margin-bottom:5px">Portföy toplam (USD)</div>' +
      '<div class="kur-port-val" id="kur-port-val">-</div>' +
    '</div>';
  return d;
}

function updateUsdTryCard() {
  if (!usdtryRate) return;
  var priceEl  = document.getElementById('kur-price');
  var badgesEl = document.getElementById('kur-badges');
  if (!priceEl) return;

  var rate = usdtryRate.price;
  var pct  = usdtryRate.changePct;
  var D    = pct >  0.01 ? 'up' : pct < -0.01 ? 'down' : 'neutral';
  var card = document.getElementById('card-USDTRY');
  if (card) card.className = 'card kur-card ' + D;

  priceEl.textContent = rate.toLocaleString('tr-TR', { minimumFractionDigits:4, maximumFractionDigits:4 }) + ' TL';

  if (badgesEl) {
    var arrow = D === 'up' ? '+' : D === 'down' ? '-' : '';
    badgesEl.innerHTML = '<span class="badge ' + D + '">' + arrow + ' ' + Math.abs(pct).toFixed(2) + '%</span>';
  }

  // Mini sparkline
  var hist = usdtryRate.closes;
  if (hist.length) {
    var cc = chartCol(D), cb = chartBg(D);
    if (charts['USDTRY']) {
      var ch = charts['USDTRY'];
      ch.data.labels = hist.map(function() { return ''; });
      ch.data.datasets[0].data = hist;
      ch.data.datasets[0].borderColor = cc;
      ch.data.datasets[0].backgroundColor = cb;
      ch.update('none');
    } else {
      var ctx = document.getElementById('cv-USDTRY');
      if (ctx) {
        charts['USDTRY'] = new Chart(ctx, {
          type: 'line',
          data: { labels: hist.map(function() { return ''; }),
                  datasets: [{ data: hist, borderColor: cc, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: cb, tension: 0.4 }] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales:  { x: { display: false }, y: { display: false, grace: '8%' } },
          },
        });
      }
    }
  }

  // Portföy TRY toplamı → USD
  var tryTotal = 0;
  stocks.forEach(function(s) {
    if (s.data && s.data.currency === 'TRY' && portfolioData[s.symbol]) {
      tryTotal += (portfolioData[s.symbol].qty || 0) * s.data.price;
    }
  });
  var portEl  = document.getElementById('kur-port');
  var portVal = document.getElementById('kur-port-val');
  if (portEl && portVal) {
    if (tryTotal > 0 && usdtryRate.price > 0) {
      portVal.textContent = '$' + (tryTotal / usdtryRate.price)
        .toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
      portEl.style.display = '';
    } else {
      portEl.style.display = 'none';
    }
  }
}

function ensureUsdTryCard() {
  if (!document.getElementById('card-USDTRY')) {
    var grid = document.getElementById('grid');
    grid.insertBefore(makeUsdTrySkeletonCard(), grid.firstChild);
    fetchUsdTryRate();
  }
}

// ── Portföy / Alım Takibi (Orta Vadeli #6) ──
function togglePortfolioPanel(sym) {
  var panel    = document.getElementById('port-panel-' + sym);
  var tgtPanel = document.getElementById('tgt-panel-'  + sym);
  if (!panel) return;
  var opening = panel.style.display === 'none';
  panel.style.display    = opening ? '' : 'none';
  if (tgtPanel) tgtPanel.style.display = 'none'; // diğer paneli kapat
  if (opening && portfolioData[sym]) {
    var qtyEl  = document.getElementById('port-qty-'  + sym);
    var costEl = document.getElementById('port-cost-' + sym);
    if (qtyEl)  qtyEl.value  = portfolioData[sym].qty     || '';
    if (costEl) costEl.value = portfolioData[sym].avgCost || '';
  }
}

function savePortfolioEntry(sym) {
  var qtyEl  = document.getElementById('port-qty-'  + sym);
  var costEl = document.getElementById('port-cost-' + sym);
  if (!qtyEl || !costEl) return;
  var qty     = parseFloat(qtyEl.value);
  var avgCost = parseFloat(costEl.value);
  if (isNaN(qty) || qty <= 0 || isNaN(avgCost) || avgCost <= 0) {
    costEl.focus(); return;
  }
  portfolioData[sym] = { qty: qty, avgCost: avgCost };
  savePortfolio();
  var s = stocks.find(function(x) { return x.symbol === sym; });
  if (s && s.data) updatePortfolioPanel(sym, s.data.price, s.data.currency);
  updateUsdTryCard();
}

function clearPortfolioEntry(sym) {
  delete portfolioData[sym];
  savePortfolio();
  updatePortfolioPanel(sym, null, null);
  updateUsdTryCard();
  // Inputları temizle
  var qtyEl  = document.getElementById('port-qty-'  + sym);
  var costEl = document.getElementById('port-cost-' + sym);
  if (qtyEl)  qtyEl.value  = '';
  if (costEl) costEl.value = '';
}

function updatePortfolioPanel(sym, currentPrice, currency) {
  var pnlEl = document.getElementById('port-pnl-' + sym);
  if (!pnlEl) return;
  var p = portfolioData[sym];
  if (!p || !currentPrice) {
    pnlEl.innerHTML = '<span class="port-empty">Adet ve ort. maliyet gir → K/Z hesabı otomatik yapılır.</span>';
    return;
  }
  var totalCost  = p.qty * p.avgCost;
  var totalValue = p.qty * currentPrice;
  var pnl        = totalValue - totalCost;
  var pnlPct     = (pnl / totalCost) * 100;
  var col        = pnl >= 0 ? 'var(--up)' : 'var(--dn)';
  var sign       = pnl >= 0 ? '+' : '';
  var cur        = currency || 'TRY';
  // USD karşılığı (BIST hisseleri için)
  var usdLine = '';
  if (cur === 'TRY' && usdtryRate && usdtryRate.price > 0) {
    usdLine = '<div class="port-usd">≈ $' +
      (totalValue / usdtryRate.price).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) +
      ' (kur: ' + usdtryRate.price.toFixed(2) + ')</div>';
  }

  pnlEl.innerHTML =
    '<div class="port-row-disp">' +
      '<span><span class="m-lbl">Adet</span> ' + p.qty.toLocaleString('tr-TR') + '</span>' +
      '<span><span class="m-lbl">Ort. Maliyet</span> ' + fmt(p.avgCost, cur) + '</span>' +
    '</div>' +
    '<div class="port-row-disp" style="margin-top:6px">' +
      '<span><span class="m-lbl">Güncel Değer</span> ' + fmt(totalValue, cur) + '</span>' +
      '<span class="port-pnl-val" style="color:' + col + '">' +
        sign + fmt(pnl, cur) + ' <span class="port-pct">(' + sign + pnlPct.toFixed(2) + '%)</span>' +
      '</span>' +
    '</div>' + usdLine;
}

// ── Hedef Fiyat (Orta Vadeli #7) ──
function toggleTargetPanel(sym) {
  var panel    = document.getElementById('tgt-panel-'  + sym);
  var portPanel = document.getElementById('port-panel-' + sym);
  if (!panel) return;
  var opening = panel.style.display === 'none';
  panel.style.display     = opening ? '' : 'none';
  if (portPanel) portPanel.style.display = 'none'; // diğer paneli kapat
  if (opening && targetData[sym]) {
    var upperEl = document.getElementById('tgt-upper-' + sym);
    var lowerEl = document.getElementById('tgt-lower-' + sym);
    if (upperEl) upperEl.value = targetData[sym].upper || '';
    if (lowerEl) lowerEl.value = targetData[sym].lower || '';
  }
}

function saveTargetEntry(sym) {
  var upperEl = document.getElementById('tgt-upper-' + sym);
  var lowerEl = document.getElementById('tgt-lower-' + sym);
  if (!upperEl || !lowerEl) return;
  var upper = upperEl.value.trim() ? parseFloat(upperEl.value) : null;
  var lower = lowerEl.value.trim() ? parseFloat(lowerEl.value) : null;
  if (!upper && !lower) { clearTargetEntry(sym); return; }
  targetData[sym] = { upper: upper || null, lower: lower || null };
  saveTargets();
  renderTargetBadges(sym);
}

function clearTargetEntry(sym) {
  delete targetData[sym];
  saveTargets();
  renderTargetBadges(sym);
  var upperEl = document.getElementById('tgt-upper-' + sym);
  var lowerEl = document.getElementById('tgt-lower-' + sym);
  if (upperEl) upperEl.value = '';
  if (lowerEl) lowerEl.value = '';
}

function renderTargetBadges(sym) {
  var area = document.getElementById('tgt-badges-' + sym);
  if (!area) return;
  var t = targetData[sym];
  if (!t) { area.innerHTML = ''; return; }
  var s   = stocks.find(function(x) { return x.symbol === sym; });
  var cur = s && s.data ? s.data.currency : 'TRY';
  var html = '';
  if (t.upper) html += '<span class="badge tgt-badge tgt-up"><i class="ti ti-arrow-up"></i> ' + fmt(t.upper, cur) + '</span>';
  if (t.lower) html += '<span class="badge tgt-badge tgt-dn"><i class="ti ti-arrow-down"></i> ' + fmt(t.lower, cur) + '</span>';
  area.innerHTML = html;
}

// ── Grafik zaman aralığı değiştirme ──
async function changeRange(sym, range) {
  chartRanges[sym] = range;
  var card = document.getElementById('card-' + sym);
  if (card) {
    card.querySelectorAll('.range-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.range === range);
    });
    var ca = card.querySelector('.chart-area');
    if (ca) ca.style.opacity = '.4';
  }
  var s = stocks.find(function(x) { return x.symbol === sym; });
  if (!s) return;
  try {
    s.data = await fetchStockPrice(sym, s.exchange, range);
    updateCard(s, null);
    if (card) { var ca2 = card.querySelector('.chart-area'); if (ca2) ca2.style.opacity = ''; }
  } catch (e) {
    console.warn('[Range] Değişim başarısız:', sym, e.message);
    if (card) { var ca3 = card.querySelector('.chart-area'); if (ca3) ca3.style.opacity = ''; }
  }
}

// ── Card ──
function makeSkeletonCard(sym, name, exch) {
  var activeRange = chartRanges[sym] || '1y';
  var RLABELS = { '1mo':'1A', '3mo':'3A', '6mo':'6A', '1y':'1Y', '5y':'5Y' };
  var rangeBtns = Object.keys(RLABELS).map(function(r) {
    return '<button class="range-btn' + (r === activeRange ? ' active' : '') +
           '" data-range="' + r + '" onclick="changeRange(\'' + sym + '\',\'' + r + '\')">' +
           RLABELS[r] + '</button>';
  }).join('');

  const d = document.createElement('div');
  d.className = 'card';
  d.id = 'card-' + sym;
  d.innerHTML =
    '<div class="c-hdr">' +
      '<div>' +
        '<div class="c-sym">' + sym + '<span class="c-xch">' + exch + '</span></div>' +
        '<div class="c-name">' + name + '</div>' +
      '</div>' +
      '<div class="c-hdr-actions">' +
        '<button class="card-action-btn" onclick="togglePortfolioPanel(\'' + sym + '\')" title="Alım takibi"><i class="ti ti-wallet"></i></button>' +
        '<button class="card-action-btn" onclick="toggleTargetPanel(\'' + sym + '\')" title="Hedef fiyat"><i class="ti ti-target"></i></button>' +
        '<button class="rm-btn" onclick="removeStock(\'' + sym + '\')" title="Kaldir"><i class="ti ti-x"></i></button>' +
      '</div>' +
    '</div>' +
    '<div class="c-price"><div class="skel-box" style="width:130px;height:28px;border-radius:5px"></div></div>' +
    '<div class="c-badges"><span class="badge loading">Veri cekiliyor...</span></div>' +
    '<div id="tgt-badges-' + sym + '" class="tgt-badges-row"></div>' +
    '<div class="range-bar">' + rangeBtns + '</div>' +
    '<div class="chart-area"><canvas id="cv-' + sym + '" aria-label="' + sym + ' grafik"></canvas></div>' +
    '<div class="sep"></div>' +
    '<div class="c-meta">' +
      '<div class="m-col"><div class="m-lbl">Yüksek</div><div class="m-val" data-k="high-today">-</div><div class="m-val m-prev" data-k="high-prev">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Düşük</div><div class="m-val" data-k="low-today">-</div><div class="m-val m-prev" data-k="low-prev">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Hacim</div><div class="m-val" data-k="vol-today">-</div><div class="m-val m-prev" data-k="vol-prev">-</div><div class="vol-ratio" data-k="vol-ratio"></div></div>' +
    '</div>' +
    '<div class="sep"></div>' +
    '<div class="c-meta2">' +
      '<div class="m-col"><div class="m-lbl">52H Yük</div><div class="m-val" data-k="h52-high">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">52H Düş</div><div class="m-val" data-k="h52-low">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Piy. Değ.</div><div class="m-val" data-k="mcap">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">F/K</div><div class="m-val" data-k="pe">-</div></div>' +
    '</div>' +
    // ── Portföy paneli (varsayılan gizli) ──
    '<div id="port-panel-' + sym + '" class="action-panel" style="display:none">' +
      '<div class="sep"></div>' +
      '<div class="panel-title"><i class="ti ti-wallet"></i> Alım Takibi</div>' +
      '<div id="port-pnl-' + sym + '" class="port-pnl">' +
        '<span class="port-empty">Adet ve ort. maliyet gir → K/Z hesabı otomatik yapılır.</span>' +
      '</div>' +
      '<div class="port-form-row">' +
        '<input type="number" class="ci port-ci" id="port-qty-'  + sym + '" placeholder="Adet"        min="0" step="1"    style="width:90px" />' +
        '<input type="number" class="ci port-ci" id="port-cost-' + sym + '" placeholder="Ort. Maliyet" min="0" step="0.01" style="flex:1;min-width:100px" />' +
      '</div>' +
      '<div class="panel-footer">' +
        '<button class="btn panel-btn" onclick="clearPortfolioEntry(\'' + sym + '\')">Temizle</button>' +
        '<button class="btn btn-primary panel-btn" onclick="savePortfolioEntry(\'' + sym + '\')">Kaydet</button>' +
      '</div>' +
    '</div>' +
    // ── Hedef fiyat paneli (varsayılan gizli) ──
    '<div id="tgt-panel-' + sym + '" class="action-panel" style="display:none">' +
      '<div class="sep"></div>' +
      '<div class="panel-title"><i class="ti ti-target"></i> Hedef Fiyat Alarmı</div>' +
      '<div class="port-form-row">' +
        '<div class="tgt-field">' +
          '<label class="m-lbl" style="margin-bottom:3px;display:block">Üst Hedef ↑</label>' +
          '<input type="number" class="ci port-ci" id="tgt-upper-' + sym + '" placeholder="Fiyat" min="0" step="0.01" style="width:100%" />' +
        '</div>' +
        '<div class="tgt-field">' +
          '<label class="m-lbl" style="margin-bottom:3px;display:block">Alt Limit ↓</label>' +
          '<input type="number" class="ci port-ci" id="tgt-lower-' + sym + '" placeholder="Fiyat" min="0" step="0.01" style="width:100%" />' +
        '</div>' +
      '</div>' +
      '<div class="panel-footer">' +
        '<button class="btn panel-btn" onclick="clearTargetEntry(\'' + sym + '\')">Temizle</button>' +
        '<button class="btn btn-primary panel-btn" onclick="saveTargetEntry(\'' + sym + '\')">Kaydet</button>' +
      '</div>' +
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

  // Önce class, sonra pulse (Bug 5 fix)
  card.className = 'card ' + D;
  if (typeof prevPrice === 'number' && prevPrice !== d.price) {
    const pc = d.price > prevPrice ? 'pulse-up' : 'pulse-down';
    card.classList.remove('pulse-up', 'pulse-down');
    void card.offsetWidth;
    card.classList.add(pc);
    setTimeout(() => card.classList.remove(pc), 1900);
  }

  const priceEl  = card.querySelector('.c-price');
  const badgesEl = card.querySelector('.c-badges');
  const g        = function(k) { return card.querySelector('[data-k="' + k + '"]'); };

  if (priceEl) priceEl.textContent = fmt(d.price, d.currency);

  // ── RSI badge (Orta Vadeli #8) ──
  var rsi = calcRSI(d.closes);
  var rsiCls = 'rsi-ok', rsiLbl = '';
  if (rsi !== null) {
    if (rsi >= 70)      { rsiCls = 'rsi-ob'; rsiLbl = ' · AŞ'; } // Aşırı Alım
    else if (rsi <= 30) { rsiCls = 'rsi-os'; rsiLbl = ' · AS'; } // Aşırı Satım
  }

  if (badgesEl) {
    var changeTxt = Math.abs(d.changePct).toFixed(2) + '% (' + sign + d.change.toFixed(2) + ')';
    var divSpan   = d.dividendYield > 0
      ? '<span class="badge div"><i class="ti ti-coin"></i> ' + (d.dividendYield * 100).toFixed(2) + '% TEM</span>'
      : '';
    var rsiSpan = rsi !== null
      ? '<span class="badge rsi ' + rsiCls + '" title="RSI 14 — >70 Aşırı Alım / <30 Aşırı Satım">RSI ' + rsi + rsiLbl + '</span>'
      : '';
    badgesEl.innerHTML = '<span class="badge ' + D + '">' + arrow + ' ' + changeTxt + '</span>' + divSpan + rsiSpan;
  }

  // ── Son temettü detayı (Orta Vadeli #9) ──
  var divDetail = card.querySelector('.div-detail');
  if (!divDetail) {
    divDetail = document.createElement('div');
    divDetail.className = 'div-detail';
    var badgesRow = card.querySelector('.c-badges');
    if (badgesRow) badgesRow.insertAdjacentElement('afterend', divDetail);
  }
  if (d.lastDividend && d.lastDividend.amount > 0) {
    divDetail.style.display = '';
    divDetail.innerHTML =
      '<i class="ti ti-calendar-event"></i> Son tem: <strong>' +
      d.lastDividend.amount.toFixed(4) + ' ' + (d.currency === 'TRY' ? 'TL' : '$') +
      '</strong> — ' + fmtDate(d.lastDividend.date) +
      (d.lastDividend.count > 1 ? ' <span class="div-count">(' + d.lastDividend.count + ' ödeme/yıl)</span>' : '');
  } else {
    divDetail.style.display = 'none';
  }

  if (g('high-today')) g('high-today').textContent = fmt(d.high,   d.currency);
  if (g('low-today'))  g('low-today').textContent  = fmt(d.low,    d.currency);
  if (g('vol-today'))  g('vol-today').textContent  = fmtVol(d.volume);

  var vr = g('vol-ratio');
  if (vr) {
    var ratio = volRatioStr(d.volume, d.avgVolume);
    vr.textContent = ratio;
    vr.className   = 'vol-ratio' + (d.avgVolume && d.volume > d.avgVolume * 1.5 ? ' high' : '');
  }

  if (d.yesterday) {
    if (g('high-prev')) g('high-prev').textContent = fmt(d.yesterday.high,   d.currency);
    if (g('low-prev'))  g('low-prev').textContent  = fmt(d.yesterday.low,    d.currency);
    if (g('vol-prev'))  g('vol-prev').textContent  = fmtVol(d.yesterday.volume);
  }

  if (g('h52-high')) g('h52-high').textContent = fmt(d.weekHigh52, d.currency);
  if (g('h52-low'))  g('h52-low').textContent  = fmt(d.weekLow52,  d.currency);
  if (g('mcap'))     g('mcap').textContent     = fmtMcap(d.marketCap, d.currency);
  if (g('pe')) {
    var peVal = peStr(d.price, d.eps);
    g('pe').textContent = peVal;
    g('pe').style.color = peVal === 'Zarar' ? 'var(--dn)' : '';
  }

  // Portföy P/L ve hedef badge'larını güncelle
  updatePortfolioPanel(s.symbol, d.price, d.currency);
  renderTargetBadges(s.symbol);

  // ── Sparkline ──
  var hist = d.closes.length ? d.closes : (histories[s.symbol] || [d.price]);
  histories[s.symbol] = hist;
  var cc = chartCol(D), cb = chartBg(D);

  if (charts[s.symbol]) {
    var ch = charts[s.symbol];
    ch.data.labels = hist.map(function() { return ''; });
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
          scales:  { x: { display: false }, y: { display: false, grace: '8%' } },
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

// ── Ekle / Kaldır / Yenile ──
async function addStock(sym, name, exch) {
  if (stocks.find(function(s) { return s.symbol === sym; })) return;
  histories[sym]   = [];
  chartRanges[sym] = chartRanges[sym] || '1y';
  var s = { symbol: sym, name: name, exchange: exch, data: null };
  stocks.push(s);
  saveToStorage();
  closeModal();
  renderUI();
  document.getElementById('grid').appendChild(makeSkeletonCard(sym, name, exch));
  // Kayıtlı portföy / hedef varsa hemen başlat
  if (portfolioData[sym]) updatePortfolioPanel(sym, null, null);
  if (targetData[sym])    renderTargetBadges(sym);
  try {
    s.data = await fetchStockPrice(sym, exch, chartRanges[sym] || '1y');
    updateCard(s, null);
    updateSummary();
    setUpd();
  } catch (e) { setError(sym, e.message.slice(0, 30)); }
}

async function retryFetch(sym) {
  var s = stocks.find(function(x) { return x.symbol === sym; });
  if (!s) return;
  var b = document.querySelector('#card-' + sym + ' .badge');
  if (b) { b.textContent = 'Yeniden deneniyor...'; b.className = 'badge loading'; b.onclick = null; }
  try {
    s.data = await fetchStockPrice(sym, s.exchange, chartRanges[sym] || '1y');
    updateCard(s, null);
    updateSummary();
    setUpd();
  } catch (e) { setError(sym, e.message.slice(0, 30)); }
}

function removeStock(sym) {
  if (charts[sym]) { charts[sym].destroy(); delete charts[sym]; }
  delete histories[sym];
  delete chartRanges[sym];
  // Not: portfolioData ve targetData kasıtlı olarak korunuyor —
  // kullanıcı yeniden eklerse verileri kaybolmamış olur.
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

  fetchUsdTryRate(); // USD/TRY'yi de yenile

  await Promise.all(stocks.map(async function(s) {
    var old = s.data ? s.data.price : null;
    var b   = document.querySelector('#card-' + s.symbol + ' .badge');
    if (b) { b.textContent = 'Guncelleniyor...'; b.className = 'badge loading'; }
    try {
      s.data = await fetchStockPrice(s.symbol, s.exchange, chartRanges[s.symbol] || '1y');
      updateCard(s, old);
      maybeNotify(s, old);
      checkTargetAlerts(s, old);
    } catch (e) { setError(s.symbol, e.message.slice(0, 30)); }
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
  if (has) ensureUsdTryCard();
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
  curTab = 'bist';
  showOnlyDiv = false;
  var btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.remove('active');
  filterList();
  setTimeout(function() { document.getElementById('search-inp').focus(); }, 60);
}
function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  scheduleRefresh(); // Bug 3 fix
}
function bgClick(e) { if (e.target.id === 'overlay') closeModal(); }
function clearErr() { document.getElementById('cerr').style.display = 'none'; }

function toggleDivFilter() {
  showOnlyDiv = !showOnlyDiv;
  var btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.toggle('active', showOnlyDiv);
  filterList();
}

function filterList() {
  var q        = document.getElementById('search-inp').value.toLowerCase().trim();
  var raw      = BIST_LIST.map(function(x) { return Object.assign({}, x, { x: 'BIST' }); });
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
    var added    = !!stocks.find(function(s) { return s.symbol === item.s; });
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
      (function(i) { div.onclick = function() { addStock(i.s, i.n, i.x || 'BIST'); }; })(item);
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

// ── Başla ──
loadPortfolio();
loadTargets();
updateBellUI();
filterList();
fetchBistList();

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
  // BIST: 10:00–18:00 TR (UTC+3) → dakika 600–1080
  return wd && (trMin >= 600 && trMin < 1080);
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

var fileWarnEl = document.getElementById('file-warn');
if (fileWarnEl) fileWarnEl.style.display = 'block';
