// ── Hisse Listeleri ──

// Son çare — screener ve localStorage ikisi de boşsa bunlar gösterilir
const BIST_EMERGENCY = [
  {s:'THYAO',n:'Türk Hava Yolları',div:0},{s:'GARAN',n:'Garanti BBVA',div:0},
  {s:'ASELS',n:'Aselsan',div:0},{s:'SISE',n:'Şişe Cam',div:0},
  {s:'EREGL',n:'Ereğli Demir Çelik',div:0},{s:'BIMAS',n:'BİM Mağazaları',div:0},
  {s:'KCHOL',n:'Koç Holding',div:0},{s:'SAHOL',n:'Sabancı Holding',div:0},
  {s:'AKBNK',n:'Akbank',div:0},{s:'YKBNK',n:'Yapı Kredi',div:0},
  {s:'ISCTR',n:'İş Bankası C',div:0},{s:'HALKB',n:'Halkbank',div:0},
  {s:'VAKBN',n:'Vakıfbank',div:0},{s:'FROTO',n:'Ford Otosan',div:0},
  {s:'TOASO',n:'Tofaş',div:0},{s:'TUPRS',n:'Tüpraş',div:0},
  {s:'TCELL',n:'Turkcell',div:0},{s:'PGSUS',n:'Pegasus',div:0},
  {s:'TAVHL',n:'TAV Havalimanları',div:0},{s:'EKGYO',n:'Emlak Konut GYO',div:0},
  {s:'ENKAI',n:'Enka İnşaat',div:0},{s:'PETKM',n:'Petkim',div:0},
  {s:'ARCLK',n:'Arçelik',div:0},{s:'MGROS',n:'Migros Ticaret',div:0},
  {s:'SOKM',n:'Şok Marketler',div:0},{s:'KOZAL',n:'Koza Altın',div:0},
  {s:'MAVI',n:'Mavi Giyim',div:0},{s:'LOGO',n:'Logo Yazılım',div:0},
  {s:'ULKER',n:'Ülker Bisküvi',div:0},{s:'ODAS',n:'Odaş Elektrik',div:0},
  {s:'AEFES',n:'Anadolu Efes',div:0},{s:'TTKOM',n:'Türk Telekom',div:0},
  {s:'TTRAK',n:'Türk Traktör',div:0},{s:'SASA',n:'Sasa Polyester',div:0},
  {s:'DOHOL',n:'Doğan Holding',div:0},
];

// Dinamik BIST listesi — önce localStorage'dan yüklenir, sonra screener günceller
let BIST_LIST = (() => {
  try {
    const cached = JSON.parse(localStorage.getItem('bist_list') || '[]');
    // Eski format kontrolü: div alanı yoksa temizle, screener yeniden çeksin
    if (cached.length >= 5 && 'div' in cached[0]) return cached;
    localStorage.removeItem('bist_list');
    sessionStorage.removeItem('bist_list_fetched');
    return BIST_EMERGENCY;
  } catch (_) { return BIST_EMERGENCY; }
})();

/**
 * Yahoo Finance screener üzerinden Borsa İstanbul hisselerini çeker.
 * Piyasa değerine göre büyükten küçüğe sıralı, ilk 150 hisse.
 * Başarılı sonuç localStorage'a kaydedilir (kalıcı cache).
 * sessionStorage ile aynı oturumda tekrar istek atılmaz.
 */
async function fetchBistList() {
  if (sessionStorage.getItem('bist_list_fetched') === '1') return;

  try {
    // FMP → IST borsasındaki tüm aktif hisseler, piyasa değerine göre
    const url = WORKER_URL + '/fmp/stock-screener?exchange=IST&limit=300&isActivelyTrading=true';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();
    if (!Array.isArray(data) || data.length < 5) throw new Error('Yetersiz sonuç');

    const list = data
      .filter(q => q.symbol && q.companyName)
      .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
      .map(q => ({
        s:   q.symbol.replace(/\.IS$/i, ''),
        n:   q.companyName,
        // FMP lastAnnualDividend miktar verir — yield hesapla
        div: q.lastAnnualDividend > 0 && q.price > 0
          ? q.lastAnnualDividend / q.price
          : 0,
      }));

    BIST_LIST = list;
    localStorage.setItem('bist_list', JSON.stringify(list));
    sessionStorage.setItem('bist_list_fetched', '1');
    filterList();
    console.log(`[Hisse] BIST listesi FMP'den güncellendi: ${list.length} hisse`);

  } catch (err) {
    console.warn('[Hisse] BIST FMP başarısız:', err.message,
      BIST_LIST === BIST_EMERGENCY ? '→ acil liste' : '→ önbellek');
  }
}
// ── Uluslararası hisse listesi (dinamik) ──
const INTL_EMERGENCY = [
  {s:'AAPL',n:'Apple',x:'NASDAQ'},{s:'MSFT',n:'Microsoft',x:'NASDAQ'},
  {s:'NVDA',n:'NVIDIA',x:'NASDAQ'},{s:'GOOGL',n:'Alphabet',x:'NASDAQ'},
  {s:'AMZN',n:'Amazon',x:'NASDAQ'},{s:'JPM',n:'JPMorgan Chase',x:'NYSE'},
  {s:'META',n:'Meta Platforms',x:'NASDAQ'},{s:'XOM',n:'ExxonMobil',x:'NYSE'},
];

// Exchange kodu → borsa adı eşlemesi
const EXCH_MAP = {
  NMS:'NASDAQ', NasdaqGS:'NASDAQ', NasdaqGM:'NASDAQ', NasdaqCM:'NASDAQ',
  NYQ:'NYSE', NYSE:'NYSE', PCX:'NYSE',
};

let INTL_LIST = (() => {
  try {
    const cached = JSON.parse(localStorage.getItem('intl_list') || '[]');
    // Eski format kontrolü
    if (cached.length >= 5 && 'div' in cached[0]) return cached;
    localStorage.removeItem('intl_list');
    sessionStorage.removeItem('intl_list_fetched');
    return INTL_EMERGENCY;
  } catch (_) { return INTL_EMERGENCY; }
})();

async function fetchIntlList() {
  if (sessionStorage.getItem('intl_list_fetched') === '1') return;

  try {
    // FMP → NASDAQ + NYSE, piyasa değerine göre top 300
    const url = WORKER_URL + '/fmp/stock-screener?exchange=NASDAQ,NYSE&limit=300&isActivelyTrading=true&country=US';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();
    if (!Array.isArray(data) || data.length < 5) throw new Error('Yetersiz sonuç');

    const list = data
      .filter(q => q.symbol && q.companyName && !q.symbol.includes('.'))
      .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
      .map(q => ({
        s:   q.symbol,
        n:   q.companyName,
        x:   q.exchangeShortName === 'NYSE' ? 'NYSE' : 'NASDAQ',
        div: q.lastAnnualDividend > 0 && q.price > 0
          ? q.lastAnnualDividend / q.price
          : 0,
      }));

    INTL_LIST = list;
    localStorage.setItem('intl_list', JSON.stringify(list));
    sessionStorage.setItem('intl_list_fetched', '1');
    filterList();
    console.log(`[Hisse] INTL listesi FMP'den güncellendi: ${list.length} hisse`);

  } catch (err) {
    console.warn('[Hisse] INTL FMP başarısız:', err.message,
      INTL_LIST === INTL_EMERGENCY ? '→ acil liste' : '→ önbellek');
  }
}

// ── State ──
let stocks = [], charts = {}, histories = {};
let curTab = 'bist', notifOn = false, toastT = null, showOnlyDiv = false;
if ('Notification' in window && Notification.permission === 'granted') notifOn = true;

// ── Proxy ──
// Worker adresini buraya yaz (Cloudflare Workers)
const WORKER_URL = 'https://stock-proxy.burcufidan51.workers.dev';

async function fetchWithFallback(targetUrl) {
  const proxyUrl = WORKER_URL + new URL(targetUrl).pathname + new URL(targetUrl).search;
  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Proxy hatası: ' + res.status);
  const data = await res.json();
  if (!data?.chart?.result?.[0]) throw new Error('Yahoo verisi boş');
  return data;
}

function saveToStorage() {
  const basicStocks = stocks.map(s => ({ symbol: s.symbol, name: s.name, exchange: s.exchange }));
  localStorage.setItem('my_tracked_stocks', JSON.stringify(basicStocks));
}

// ── Veri çekme ──
async function fetchStockPrice(symbol, exchange) {
  const ticker = exchange === 'BIST' ? symbol + '.IS' : symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`;
  const data = await fetchWithFallback(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Sembol bulunamadı');
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  if (!price) throw new Error('Fiyat alınamadı');

  const prev      = meta.chartPreviousClose || meta.previousClose || price;
  const change    = +(price - prev).toFixed(4);
  const changePct = +((change / prev) * 100).toFixed(4);

  // Günlük OHLCV dizileri — null'ları filtrele
  const q       = result.indicators?.quote?.[0] || {};
  const closes  = (q.close  || []).filter(v => v != null);
  const highs   = (q.high   || []).filter(v => v != null);
  const lows    = (q.low    || []).filter(v => v != null);
  const volumes = (q.volume || []).filter(v => v != null);

  // Dünün verisi (son kapalı gün)
  const yesterday = highs.length >= 2 ? {
    high:   highs[highs.length - 2],
    low:    lows[lows.length   - 2],
    volume: volumes[volumes.length - 2],
  } : null;

  // Temettü verisi — meta alanını dene, yoksa chart events'ten hesapla
  const metaYield = meta.dividendYield || meta.trailingAnnualDividendYield || 0;
  const metaRate  = meta.dividendRate  || meta.trailingAnnualDividendRate  || 0;

  let dividendYield = metaYield
    || (metaRate > 0 && price > 0 ? metaRate / price : 0);

  // Yahoo BIST için meta'yı doldurmayabiliyor — events.dividends'tan hesapla
  if (!dividendYield) {
    const evDivs    = result.events?.dividends || {};
    const oneYrAgo  = Date.now() / 1000 - 365 * 24 * 3600;
    const annualDiv = Object.values(evDivs)
      .filter(d => d.date > oneYrAgo)
      .reduce((sum, d) => sum + (d.amount || 0), 0);
    if (annualDiv > 0 && price > 0) dividendYield = annualDiv / price;
  }

  const dividendRate = metaRate || (dividendYield * price) || 0;

  return {
    price, change, changePct,
    high:      meta.regularMarketDayHigh || highs[highs.length - 1] || price,
    low:       meta.regularMarketDayLow  || lows[lows.length   - 1] || price,
    volume:    meta.regularMarketVolume  || volumes[volumes.length - 1] || 0,
    yesterday,
    dividendYield,
    dividendRate,
    currency:  meta.currency || (exchange === 'BIST' ? 'TRY' : 'USD'),
    closes,
  };
}

// ── Format ──
function fmt(v, cur) {
  if (v == null) return '—';
  return cur === 'TRY'
    ? v.toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ₺'
    : '$' + v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e9) return (v/1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v/1e3).toFixed(0) + 'K';
  return String(v);
}
function dirOf(c)    { return c > 0.001 ? 'up' : c < -0.001 ? 'down' : 'neutral'; }
function chartCol(d) { return d==='up' ? '#10b981' : d==='down' ? '#f43f5e' : '#64748b'; }
function chartBg(d)  { return d==='up' ? 'rgba(16,185,129,.08)' : d==='down' ? 'rgba(244,63,94,.08)' : 'rgba(100,116,139,.05)'; }

// ── Bildirim ──
function updateBellUI() {
  const b = document.getElementById('bell-btn');
  if (!('Notification' in window)) { b.style.opacity='.3'; b.style.pointerEvents='none'; return; }
  b.className = 'btn btn-icon btn-bell' +
    (Notification.permission==='denied' ? ' denied' : notifOn ? ' on' : '');
  b.title = notifOn
    ? 'Düşüş bildirimleri açık — kapatmak için tıkla'
    : Notification.permission==='denied'
    ? 'Tarayıcı ayarlarından izin gerekiyor'
    : 'Düşüş bildirimlerine izin ver';
}
async function toggleNotif() {
  if (!('Notification' in window)) return;
  if (notifOn) { notifOn = false; updateBellUI(); return; }
  if (Notification.permission === 'denied') return;
  const p = await Notification.requestPermission();
  notifOn = (p === 'granted');
  updateBellUI();
}

// ── Toast ──
function showToast(sym, name, priceStr, pct) {
  clearTimeout(toastT);
  document.getElementById('toast-sym').textContent  = '📉 ' + sym + ' düştü';
  document.getElementById('toast-body').textContent = name + '\n' + priceStr + '  ▼' + Math.abs(pct).toFixed(2) + '%';
  document.getElementById('toast').classList.add('show');
  toastT = setTimeout(() => document.getElementById('toast').classList.remove('show'), 5500);
}
function maybeNotify(s, oldPrice) {
  if (!s.data || !oldPrice || s.data.price >= oldPrice) return;
  const pct = ((s.data.price - oldPrice) / oldPrice) * 100;
  const ps  = fmt(s.data.price, s.data.currency);
  showToast(s.symbol, s.name, ps, pct);
  // pulse-down animasyonu düşüşte
  const card = document.getElementById('card-' + s.symbol);
  if (card) {
    card.classList.remove('pulse-up', 'pulse-down');
    void card.offsetWidth;
    card.classList.add('pulse-down');
    setTimeout(() => card.classList.remove('pulse-down'), 1900);
  }
  if (notifOn && Notification.permission === 'granted') {
    try {
      new Notification('📉 ' + s.symbol + ' düştü', {
        body: s.name + '\n' + ps + '  ▼' + Math.abs(pct).toFixed(2) + '%',
        tag:  'drop-' + s.symbol,
      });
    } catch(e) {}
  }
}

// ── Card ──
function makeSkeletonCard(sym, name, exch) {
  const d = document.createElement('div');
  d.className = 'card'; d.id = 'card-' + sym;
  d.innerHTML = `
    <div class="c-hdr">
      <div>
        <div class="c-sym">${sym}<span class="c-xch">${exch}</span></div>
        <div class="c-name">${name}</div>
      </div>
      <button class="rm-btn" onclick="removeStock('${sym}')" title="Kaldır"><i class="ti ti-x"></i></button>
    </div>
    <div class="c-price"><div class="skel-box" style="width:130px;height:28px;border-radius:5px"></div></div>
    <div class="c-badges">
      <span class="badge loading">Veri çekiliyor...</span>
    </div>
    <div class="chart-area"><canvas id="cv-${sym}" aria-label="${sym} fiyat grafiği"></canvas></div>
    <div class="sep"></div>
    <div class="c-meta">
      <div class="m-col">
        <div class="m-lbl">Yüksek</div>
        <div class="m-val" data-k="high-today">—</div>
        <div class="m-val m-prev" data-k="high-prev">—</div>
      </div>
      <div class="m-col">
        <div class="m-lbl">Düşük</div>
        <div class="m-val" data-k="low-today">—</div>
        <div class="m-val m-prev" data-k="low-prev">—</div>
      </div>
      <div class="m-col">
        <div class="m-lbl">Hacim</div>
        <div class="m-val" data-k="vol-today">—</div>
        <div class="m-val m-prev" data-k="vol-prev">—</div>
      </div>
    </div>`;
  return d;
}

function updateCard(s, prevPrice) {
  const d = s.data; if (!d) return;
  const D     = dirOf(d.change);
  const arrow = D==='up' ? '↑' : D==='down' ? '↓' : '–';
  const sign  = d.change >= 0 ? '+' : '';
  const card  = document.getElementById('card-' + s.symbol); if (!card) return;

  // Pulse on refresh price change
  if (typeof prevPrice === 'number' && prevPrice !== d.price) {
    const pc = d.price > prevPrice ? 'pulse-up' : 'pulse-down';
    card.classList.remove('pulse-up', 'pulse-down');
    void card.offsetWidth;
    card.classList.add(pc);
    setTimeout(() => card.classList.remove(pc), 1900);
  }

  card.className = 'card ' + D;
  const priceEl = card.querySelector('.c-price');
  const badgeEl = card.querySelector('.badge');
  const vals    = card.querySelectorAll('.m-val');

  if (priceEl) priceEl.textContent = fmt(d.price, d.currency);

  // Badge satırı — değişim + temettü rozeti
  const badgesEl = card.querySelector('.c-badges');
  if (badgesEl) {
    const divHtml = d.dividendYield > 0
      ? `<span class="badge div"><i class="ti ti-coin"></i> ${(d.dividendYield * 100).toFixed(2)}% TEM</span>`
      : '';
    badgesEl.innerHTML = `<span class="badge ${D}">${arrow} ${Math.abs(d.changePct).toFixed(2)}% (${sign}${d.change.toFixed(2)})</span>${divHtml}`;
  }

  // Meta — bugün
  const g = k => card.querySelector(`[data-k="${k}"]`);
  if (g('high-today')) g('high-today').textContent = fmt(d.high,   d.currency);
  if (g('low-today'))  g('low-today').textContent  = fmt(d.low,    d.currency);
  if (g('vol-today'))  g('vol-today').textContent  = fmtVol(d.volume);

  // Meta — dün (varsa)
  if (d.yesterday) {
    if (g('high-prev')) g('high-prev').textContent = fmt(d.yesterday.high,   d.currency);
    if (g('low-prev'))  g('low-prev').textContent  = fmt(d.yesterday.low,    d.currency);
    if (g('vol-prev'))  g('vol-prev').textContent  = fmtVol(d.yesterday.volume);
  }

  // Grafik — gerçek Yahoo verisi
  const hist = d.closes.length ? d.closes : (histories[s.symbol] || [d.price]);
  histories[s.symbol] = hist;
  const cc = chartCol(D), cb = chartBg(D);

  if (charts[s.symbol]) {
    const ch = charts[s.symbol];
    ch.data.labels                       = hist.map(() => '');
    ch.data.datasets[0].data             = hist;
    ch.data.datasets[0].borderColor      = cc;
    ch.data.datasets[0].backgroundColor  = cb;
    ch.update('none');
  } else {
    const ctx = document.getElementById('cv-' + s.symbol);
    if (ctx) {
      charts[s.symbol] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: hist.map(() => ''),
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
  const card  = document.getElementById('card-' + sym); if (!card) return;
  card.className = 'card error';
  const badge = card.querySelector('.badge');
  const price = card.querySelector('.c-price');
  if (price) price.textContent = '—';
  if (badge) {
    badge.textContent = '⚠ ' + (msg || 'Hata') + ' — tekrar dene';
    badge.className   = 'badge error';
    badge.onclick     = () => retryFetch(sym);
  }
}

// ── Ekle / Kaldır / Yenile ──
async function addStock(sym, name, exch) {
  if (stocks.find(s => s.symbol === sym)) return;
  histories[sym] = [];
  const s = { symbol: sym, name, exchange: exch, data: null };
  stocks.push(s);
  saveToStorage();
  closeModal(); renderUI();
  document.getElementById('grid').appendChild(makeSkeletonCard(sym, name, exch));
  try {
    s.data = await fetchStockPrice(sym, exch);
    updateCard(s, null); updateSummary(); setUpd();
  } catch(e) {
    setError(sym, e.message.slice(0, 30));
  }
}

async function retryFetch(sym) {
  const s = stocks.find(x => x.symbol === sym); if (!s) return;
  const b = document.querySelector('#card-' + sym + ' .badge');
  if (b) { b.textContent = 'Yeniden deneniyor...'; b.className = 'badge loading'; b.onclick = null; }
  try {
    s.data = await fetchStockPrice(sym, s.exchange);
    updateCard(s, null); updateSummary(); setUpd();
  } catch(e) { setError(sym, e.message.slice(0, 30)); }
}

function removeStock(sym) {
  if (charts[sym]) { charts[sym].destroy(); delete charts[sym]; }
  delete histories[sym];
  stocks = stocks.filter(s => s.symbol !== sym);
  saveToStorage();
  const c = document.getElementById('card-' + sym); if (c) c.remove();
  renderUI();
}

async function refreshAll() {
  if (!stocks.length) return;
  const btn  = document.getElementById('ref-btn');
  const icon = document.getElementById('ref-icon');
  btn.disabled = true;
  icon.style.animation = 'spin 1s linear infinite';

  await Promise.all(stocks.map(async s => {
    const old = s.data?.price;
    const b   = document.querySelector('#card-' + s.symbol + ' .badge');
    if (b) { b.textContent = 'Güncelleniyor...'; b.className = 'badge loading'; }
    try {
      s.data = await fetchStockPrice(s.symbol, s.exchange);
      updateCard(s, old); maybeNotify(s, old);
    } catch(e) { setError(s.symbol, e.message.slice(0, 30)); }
  }));

  updateSummary(); setUpd();
  btn.disabled = false; icon.style.animation = '';
}

// ── UI ──
function renderUI() {
  const has = stocks.length > 0;
  document.getElementById('empty-state').style.display = has ? 'none'        : 'flex';
  document.getElementById('sbar').style.display        = has ? 'grid'        : 'none';
  document.getElementById('live-tag').style.display    = has ? 'flex'        : 'none';
  document.getElementById('ref-btn').style.display     = has ? 'inline-flex' : 'none';
  updateSummary();
}
function updateSummary() {
  const wd = stocks.filter(s => s.data);
  document.getElementById('sc-t').textContent = stocks.length;
  document.getElementById('sc-u').textContent = wd.filter(s => s.data.change >= 0).length;
  document.getElementById('sc-d').textContent = wd.filter(s => s.data.change < 0).length;
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
  setTimeout(() => document.getElementById('search-inp').focus(), 60);
}
function closeModal() { document.getElementById('overlay').classList.remove('open'); }
function bgClick(e)   { if (e.target.id === 'overlay') closeModal(); }
function clearErr()   { document.getElementById('cerr').style.display = 'none'; }

function switchTab(t) {
  curTab = t;
  showOnlyDiv = false;
  const btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.remove('active');
  document.getElementById('tb-bist').className = 'tab' + (t === 'bist' ? ' active' : '');
  document.getElementById('tb-intl').className = 'tab' + (t === 'intl' ? ' active' : '');
  document.getElementById('search-inp').value = '';
  filterList();
}

function toggleDivFilter() {
  showOnlyDiv = !showOnlyDiv;
  const btn = document.getElementById('div-filter-btn');
  if (btn) btn.classList.toggle('active', showOnlyDiv);
  filterList();
}

function filterList() {
  const q   = document.getElementById('search-inp').value.toLowerCase().trim();
  let raw   = curTab === 'bist' ? BIST_LIST.map(x => ({...x, x:'BIST'})) : INTL_LIST;

  // Temettü filtresi
  if (showOnlyDiv) raw = raw.filter(x => (x.div || 0) > 0);

  const list = q ? raw.filter(x => x.s.toLowerCase().includes(q) || x.n.toLowerCase().includes(q)) : raw;
  const el   = document.getElementById('s-list');
  el.innerHTML = '';

  if (!list.length) {
    el.innerHTML = `<div style="padding:18px;text-align:center;font-size:12px;color:var(--muted)">${showOnlyDiv ? 'Temettü verisi olan hisse bulunamadı' : 'Sonuç bulunamadı'}</div>`;
    return;
  }
  list.forEach(item => {
    const added   = !!stocks.find(s => s.symbol === item.s);
    const divPct  = item.div > 0 ? `<span class="s-div">${(item.div * 100).toFixed(1)}%</span>` : '';
    const div     = document.createElement('div');
    div.className = 's-item' + (added ? ' added' : '');
    div.innerHTML = `
      <div>
        <div class="s-sym">${item.s} ${divPct}</div>
        <div class="s-name">${item.n}</div>
      </div>
      <i class="ti ti-${added ? 'check' : 'plus'}" style="font-size:15px;color:${added ? 'var(--up)' : 'var(--muted)'}"></i>`;
    if (!added) div.onclick = () => addStock(item.s, item.n, item.x || 'BIST');
    el.appendChild(div);
  });
}

function addManual() {
  const sym  = document.getElementById('m-sym').value.trim().toUpperCase();
  const name = document.getElementById('m-name').value.trim() || sym;
  const exch = document.getElementById('m-exch').value;
  const err  = document.getElementById('cerr');
  if (!sym)  { err.textContent = 'Sembol giriniz.'; err.style.display = 'block'; return; }
  if (stocks.find(s => s.symbol === sym)) { err.textContent = 'Bu sembol zaten listede.'; err.style.display = 'block'; return; }
  addStock(sym, name, exch);
}

document.getElementById('m-sym').addEventListener('keydown', e => { if (e.key === 'Enter') addManual(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Başlat ──
updateBellUI();
filterList();

// BIST ve INTL listelerini dinamik çek
fetchBistList();
fetchIntlList();

// LocalStorage'dan kayıtlı hisseleri yükle
const savedStocks = localStorage.getItem('my_tracked_stocks');
if (savedStocks) {
  try {
    JSON.parse(savedStocks).forEach(item => addStock(item.symbol, item.name, item.exchange));
  } catch(e) { console.error('Kayıtlı veriler yüklenemedi:', e); }
}

// ── Otomatik yenileme — piyasa saatine göre akıllı aralık ──
// BIST: 10:00–18:00 TR (UTC+3) | ABD: 16:30–23:00 TR
function getMarketOpen() {
  const now = new Date();
  const trMin = ((now.getUTCHours() + 3) % 24) * 60 + now.getUTCMinutes();
  const day   = now.getUTCDay(); // 0=Pazar
  const wd    = day >= 1 && day <= 5;
  return wd && ((trMin >= 600 && trMin < 1080) || (trMin >= 990 && trMin < 1380));
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const isModalOpen = document.getElementById('overlay').classList.contains('open');
  if (isModalOpen || !stocks.length) { refreshTimer = setTimeout(scheduleRefresh, 5000); return; }
  const interval = getMarketOpen() ? 30_000 : 5 * 60_000;
  refreshTimer = setTimeout(async () => { await refreshAll(); scheduleRefresh(); }, interval);
}
scheduleRefresh();

// file:// uyarısı
if (location.protocol === 'file:') {
  document.getElementById('file-warn').style.display = 'block';
}
