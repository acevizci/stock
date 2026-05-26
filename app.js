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

// Otomatik temettü listemiz (boş başlar, Worker'dan dolar)
let BIST_DIVIDENDS = {};

async function fetchBistDividends() {
  // Zaten çektiysek tekrar sunucuyu yorma
  if (Object.keys(BIST_DIVIDENDS).length > 0) return;
  try {
    const res = await fetch(WORKER_URL + '/api/bist-dividends');
    if (res.ok) {
      BIST_DIVIDENDS = await res.json();
      console.log('[Temettü] Otomatik veriler yüklendi: ' + Object.keys(BIST_DIVIDENDS).length + ' hisse');
    }
  } catch (e) {
    console.warn('[Temettü] Çekim başarısız:', e);
  }
}

async function fetchBistList() {
  if (sessionStorage.getItem('bist_list_fetched') === '1') return;
  try {
    // 1. FMP'den hisse listesini getirmeden önce güncel temettü oranlarını bekle
    await fetchBistDividends();

    // 2. FMP hisselerini indir
    const res = await fetch(WORKER_URL + '/fmp/search-symbol?query=.IS', { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    
    const raw  = await res.json();
    const data = Array.isArray(raw) ? raw : (raw.stockList || raw.stocks || []);
    
    if (data.length < 5) throw new Error('Yetersiz: ' + data.length);
    
    const list = data
      .filter(q => q.symbol && (q.companyName || q.name))
      .map(q => {
        let sym = q.symbol.replace(/\.IS$/i, '');
        return { 
          s: sym, 
          n: q.companyName || q.name, 
          // 3. Worker'dan canlı çekilen listeden oranı bul, yoksa sıfır yaz
          div: BIST_DIVIDENDS[sym] || 0 
        };
      });

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


// ── Veri cekme ──
async function fetchStockPrice(symbol, exchange, range) {
  range = range || '1y';
  // 5 yıllık veri için haftalık bar; daha kısa aralıklarda günlük
  var interval = range === '5y' ? '1wk' : '1d';
  const ticker = exchange === 'BIST' ? symbol + '.IS' : symbol;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
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

  // Her dizi ayrı ayrı filtrelenirse farklı uzunluklarda kalır ve
  // "dünkü" indeks (length - 2) farklı güne denk gelebilir.
  // Çözüm: tüm OHLCV değerlerini aynı indeks üzerinden hizalı tut,
  // yalnızca close'u dolu olan satırları koru.
  const rawClose  = q.close  || [];
  const rawHigh   = q.high   || [];
  const rawLow    = q.low    || [];
  const rawVolume = q.volume || [];

  const aligned = rawClose
    .map((c, i) => ({
      close:  c,
      high:   rawHigh[i]   ?? null,
      low:    rawLow[i]    ?? null,
      volume: rawVolume[i] ?? null,
    }))
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

  // YENİ EKLENEN KISIM: Yahoo temettü bilgisini bulamadıysa, Worker'dan gelen canlı veriyi kullan
  if (!dividendYield && exchange === 'BIST') {
    if (Object.keys(BIST_DIVIDENDS).length === 0) {
      await fetchBistDividends(); // Eğer sözlük henüz dolmadıysa hemen çek
    }
    if (BIST_DIVIDENDS[symbol]) {
      dividendYield = BIST_DIVIDENDS[symbol];
    }
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
    // ── Yeni finansal alanlar ──
    weekHigh52: meta.fiftyTwoWeekHigh || null,
    weekLow52:  meta.fiftyTwoWeekLow  || null,
    avgVolume:  meta.averageDailyVolume10Day || meta.averageDailyVolume3Month || null,
    marketCap:  meta.marketCap || null,
    eps:        meta.epsTrailingTwelveMonths || null,
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

// Piyasa değeri formatı (TL/USD)
function fmtMcap(v, cur) {
  if (!v) return '-';
  var s = cur === 'TRY' ? ' TL' : '$';
  if (v >= 1e12) return (v / 1e12).toFixed(2) + ' Tr' + s;
  if (v >= 1e9)  return (v / 1e9).toFixed(2)  + ' Mr' + s;
  if (v >= 1e6)  return (v / 1e6).toFixed(1)  + ' Mn' + s;
  return String(Math.round(v)) + s;
}
// F/K oranı metni
function peStr(price, eps) {
  if (eps == null || eps === 0) return '-';
  var pe = price / eps;
  if (pe < 0) return 'Zarar';
  return pe.toFixed(1) + '×';
}
// Hacim / ortalama hacim oranı
function volRatioStr(vol, avg) {
  if (!avg || !vol) return '';
  return (vol / avg).toFixed(1) + '× ort.';
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
  // Pulse animasyonu updateCard tarafından yönetilir — burada tekrar eklenmez.
  if (notifOn && Notification.permission === 'granted') {
    try { new Notification(s.symbol + ' dustu', { body: s.name + '\n' + ps, tag: 'drop-' + s.symbol }); }
    catch (e) {}
  }
}

// ── Grafik zaman aralığı değiştirme ──
async function changeRange(sym, range) {
  chartRanges[sym] = range;
  // Kart üzerindeki buton durumunu güncelle
  var card = document.getElementById('card-' + sym);
  if (card) {
    card.querySelectorAll('.range-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.range === range);
    });
    // Yükleniyor göstergesi — chart üzerine overlay yerine basit renk değişimi
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
      '<button class="rm-btn" onclick="removeStock(\'' + sym + '\')" title="Kaldir"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<div class="c-price"><div class="skel-box" style="width:130px;height:28px;border-radius:5px"></div></div>' +
    '<div class="c-badges"><span class="badge loading">Veri cekiliyor...</span></div>' +
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

  // Önce temel class'ı set et, sonra pulse ekle —
  // aksi halde aşağıdaki `card.className = 'card ' + D` pulse'u siler.
  card.className = 'card ' + D;

  // Pulse
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

  // Hacim / ortalama hacim oranı
  var vr = g('vol-ratio');
  if (vr) {
    var ratio = volRatioStr(d.volume, d.avgVolume);
    vr.textContent  = ratio;
    vr.className    = 'vol-ratio' + (d.avgVolume && d.volume > d.avgVolume * 1.5 ? ' high' : '');
  }

  if (d.yesterday) {
    if (g('high-prev')) g('high-prev').textContent = fmt(d.yesterday.high,   d.currency);
    if (g('low-prev'))  g('low-prev').textContent  = fmt(d.yesterday.low,    d.currency);
    if (g('vol-prev'))  g('vol-prev').textContent  = fmtVol(d.yesterday.volume);
  }

  // 52 haftalık yüksek / düşük
  if (g('h52-high')) g('h52-high').textContent = fmt(d.weekHigh52, d.currency);
  if (g('h52-low'))  g('h52-low').textContent  = fmt(d.weekLow52,  d.currency);

  // Piyasa değeri
  if (g('mcap')) g('mcap').textContent = fmtMcap(d.marketCap, d.currency);

  // F/K oranı
  if (g('pe')) {
    var peVal = peStr(d.price, d.eps);
    g('pe').textContent = peVal;
    g('pe').style.color = peVal === 'Zarar' ? 'var(--dn)' : '';
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
  histories[sym]    = [];
  chartRanges[sym]  = chartRanges[sym] || '1y'; // varsayılan 1 yıl
  var s = { symbol: sym, name: name, exchange: exch, data: null };
  stocks.push(s);
  saveToStorage();
  closeModal();
  renderUI();
  document.getElementById('grid').appendChild(makeSkeletonCard(sym, name, exch));
  try {
    s.data = await fetchStockPrice(sym, exch, chartRanges[sym] || '1y');
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
    s.data = await fetchStockPrice(sym, s.exchange, chartRanges[sym] || '1y');
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
  delete chartRanges[sym];
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
      s.data = await fetchStockPrice(s.symbol, s.exchange, chartRanges[s.symbol] || '1y');
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
  curTab = 'bist'; // Güvenlik için tab'ı BIST'e sabitliyoruz
  showOnlyDiv = false;
  var btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.remove('active');
  filterList(); // switchTab yerine doğrudan listeyi filtrele
  setTimeout(function() { document.getElementById('search-inp').focus(); }, 60);
}
function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  // Modal kapanır kapanmaz zamanlayıcıyı yeniden başlat;
  // aksi halde 5 saniyelik polling döngüsü bitmeden yenileme yapılmaz.
  scheduleRefresh();
}
function bgClick(e)   { if (e.target.id === 'overlay') closeModal(); }
function clearErr()   { document.getElementById('cerr').style.display = 'none'; }



function toggleDivFilter() {
  showOnlyDiv = !showOnlyDiv;
  var btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.toggle('active', showOnlyDiv);
  filterList();
}

function filterList() {
  var q   = document.getElementById('search-inp').value.toLowerCase().trim();
var raw = BIST_LIST.map(function(x) { return Object.assign({}, x, { x: 'BIST' }); });

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