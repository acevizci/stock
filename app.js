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
let stocks = [], charts = {}, histories = {}, chartRanges = {}, chartMode = {};
let portfolioData = {}, targetData = {}, usdtryRate = null, goldData = null;
let notesData = {}, sectorData = {};       // UV #11 & #12
let currentSort = 'added';                 // UV #13
let notifOn = false, toastT = null, showOnlyDiv = false;
if ('Notification' in window && Notification.permission === 'granted') notifOn = true;

// ── localStorage yardımcıları ──
function loadPortfolio() { try { portfolioData = JSON.parse(localStorage.getItem('portfolio_data') || '{}'); } catch(_) { portfolioData = {}; } }
function savePortfolio() { localStorage.setItem('portfolio_data', JSON.stringify(portfolioData)); }
function loadTargets()   { try { targetData   = JSON.parse(localStorage.getItem('target_data')   || '{}'); } catch(_) { targetData = {}; }   }
function saveTargets()   { localStorage.setItem('target_data',   JSON.stringify(targetData));   }
function loadNotes()     { try { notesData    = JSON.parse(localStorage.getItem('notes_data')    || '{}'); } catch(_) { notesData = {}; }     }
function saveNotes()     { localStorage.setItem('notes_data',    JSON.stringify(notesData));     }
function loadSectors()   { try { sectorData   = JSON.parse(localStorage.getItem('sector_data')   || '{}'); } catch(_) { sectorData = {}; }   }
function saveSectors()   { localStorage.setItem('sector_data',   JSON.stringify(sectorData));   }

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

let BIST_DIVIDENDS = {};
async function fetchBistDividends() {
  if (Object.keys(BIST_DIVIDENDS).length > 0) return;
  try {
    const res = await fetch(WORKER_URL + '/api/bist-dividends');
    if (res.ok) { BIST_DIVIDENDS = await res.json(); console.log('[Temettü] Yüklendi: ' + Object.keys(BIST_DIVIDENDS).length); }
  } catch(e) { console.warn('[Temettü] Başarısız:', e); }
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
    const list = data.filter(q => q.symbol && (q.companyName || q.name)).map(q => {
      let sym = q.symbol.replace(/\.IS$/i, '');
      return { s: sym, n: q.companyName || q.name, div: BIST_DIVIDENDS[sym] || 0 };
    });
    if (list.length < 5) throw new Error('Parse sonrası yetersiz');
    BIST_LIST = list;
    localStorage.setItem('bist_list', JSON.stringify(list));
    sessionStorage.setItem('bist_list_fetched', '1');
    filterList();
    console.log('[Hisse] BIST listesi yüklendi: ' + list.length);
  } catch(err) { console.warn('[Hisse] BIST FMP başarısız:', err.message); }
}

// ── Veri çekme ──
async function fetchStockPrice(symbol, exchange, range) {
  range = range || '1y';
  var interval = range === '5y' ? '1wk' : '1d';
  const ticker = exchange === 'BIST' ? symbol + '.IS' : symbol;
  const url    = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=' + interval + '&range=' + range;
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
  const rawClose = q.close || [], rawHigh = q.high || [], rawLow = q.low || [],
        rawVolume = q.volume || [], rawOpen = q.open || [];
  const rawTs = result.timestamp || [];

  // Tüm OHLCV ve timestamp'leri aynı indekste hizala; yalnızca close dolu olanları tut
  const aligned = rawClose
    .map((c, i) => ({
      t:      rawTs[i]      != null ? rawTs[i] * 1000 : null, // ms timestamp
      o:      rawOpen[i]    ?? null,
      close:  c,
      high:   rawHigh[i]   ?? null,
      low:    rawLow[i]    ?? null,
      volume: rawVolume[i] ?? null,
    }))
    .filter(d => d.close != null);

  const ohlcv   = aligned;                          // mum grafik için tam dizi
  const closes  = aligned.map(d => d.close);
  const highs   = aligned.map(d => d.high);
  const lows    = aligned.map(d => d.low);
  const volumes = aligned.map(d => d.volume);

  const yesterday = aligned.length >= 2 ? {
    high: aligned[aligned.length - 2].high, low: aligned[aligned.length - 2].low,
    volume: aligned[aligned.length - 2].volume,
  } : null;

  const metaYield = meta.dividendYield || meta.trailingAnnualDividendYield || 0;
  const metaRate  = meta.dividendRate  || meta.trailingAnnualDividendRate  || 0;
  let dividendYield = metaYield || (metaRate > 0 && price > 0 ? metaRate / price : 0);

  const evDivs     = result.events?.dividends || {};
  const oneYrAgo   = Date.now() / 1000 - 365 * 24 * 3600;
  const recentDivs = Object.values(evDivs).filter(d => d.date > oneYrAgo).sort((a,b) => b.date - a.date);
  if (!dividendYield) {
    const annual = recentDivs.reduce((sum, d) => sum + (d.amount || 0), 0);
    if (annual > 0 && price > 0) dividendYield = annual / price;
  }
  if (!dividendYield && exchange === 'BIST') {
    if (Object.keys(BIST_DIVIDENDS).length === 0) await fetchBistDividends();
    if (BIST_DIVIDENDS[symbol]) dividendYield = BIST_DIVIDENDS[symbol];
  }
  const lastDividend = recentDivs.length > 0 ? { amount: recentDivs[0].amount, date: recentDivs[0].date, count: recentDivs.length } : null;

  return {
    price, change, changePct,
    high:       meta.regularMarketDayHigh || highs[highs.length-1] || price,
    low:        meta.regularMarketDayLow  || lows[lows.length-1]   || price,
    volume:     meta.regularMarketVolume  || volumes[volumes.length-1] || 0,
    yesterday, dividendYield, lastDividend,
    currency:   meta.currency || (exchange === 'BIST' ? 'TRY' : 'USD'),
    closes,
    ohlcv,      // {t, o, close, high, low, volume} dizisi — mum grafik için
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
  if (v >= 1e9) return (v/1e9).toFixed(1)+'B'; if (v >= 1e6) return (v/1e6).toFixed(1)+'M';
  if (v >= 1e3) return (v/1e3).toFixed(0)+'K'; return String(v);
}
function fmtMcap(v, cur) {
  if (!v) return '-';
  if (cur === 'TRY') {
    if (v >= 1e12) return (v/1e12).toFixed(2) + ' Tr TL';
    if (v >= 1e9)  return (v/1e9).toFixed(2)  + ' Mr TL';
    if (v >= 1e6)  return (v/1e6).toFixed(1)  + ' Mn TL';
    return String(Math.round(v)) + ' TL';
  } else {
    // USD: prefix $ ve standart B/M/T kısaltmaları
    if (v >= 1e12) return '$' + (v/1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return '$' + (v/1e9).toFixed(2)  + 'B';
    if (v >= 1e6)  return '$' + (v/1e6).toFixed(1)  + 'M';
    return '$' + String(Math.round(v));
  }
}
function fmtDate(ts) { if (!ts) return ''; return new Date(ts*1000).toLocaleDateString('tr-TR',{day:'2-digit',month:'2-digit',year:'numeric'}); }
function dirOf(c)    { return c > 0.001 ? 'up' : c < -0.001 ? 'down' : 'neutral'; }
function chartCol(d) { return d==='up'?'#10b981':d==='down'?'#f43f5e':'#64748b'; }
function chartBg(d)  { return d==='up'?'rgba(16,185,129,.08)':d==='down'?'rgba(244,63,94,.08)':'rgba(100,116,139,.05)'; }
function peStr(price, eps) { if (eps==null||eps===0) return '-'; var pe=price/eps; return pe<0?'Zarar':pe.toFixed(1)+'×'; }
function volRatioStr(vol, avg) { if (!avg||!vol) return ''; return (vol/avg).toFixed(1)+'× ort.'; }

// ── RSI — 14 günlük Wilder ──
function calcRSI(closes, period) {
  period = period || 14;
  if (!closes || closes.length < period+1) return null;
  var start=closes.length-period-1, gains=0, losses=0;
  for (var i=start+1; i<=start+period; i++) { var diff=closes[i]-closes[i-1]; if(diff>=0) gains+=diff; else losses-=diff; }
  var ag=gains/period, al=losses/period;
  if (al===0) return 100;
  return +(100-100/(1+ag/al)).toFixed(1);
}

// ── Bildirim ──
function updateBellUI() {
  const b = document.getElementById('bell-btn');
  if (!('Notification' in window)) { b.style.opacity='.3'; b.style.pointerEvents='none'; return; }
  b.className='btn btn-icon btn-bell'+(Notification.permission==='denied'?' denied':notifOn?' on':'');
  b.title=notifOn?'Bildirimleri kapat':Notification.permission==='denied'?'Tarayıcıdan izin ver':'Bildirime izin ver';
}
async function toggleNotif() {
  if (!('Notification' in window)) return;
  if (notifOn) { notifOn=false; updateBellUI(); return; }
  if (Notification.permission==='denied') return;
  notifOn=(await Notification.requestPermission())==='granted'; updateBellUI();
}

// ── Toast ──
function showToast(sym, msg, detail, dir) {
  clearTimeout(toastT);
  var symEl=document.getElementById('toast-sym'), bodyEl=document.getElementById('toast-body'), toastEl=document.getElementById('toast');
  symEl.textContent=(dir==='up'?'↑ ':'↓ ')+sym+(msg?'  '+msg:'');
  symEl.style.color=dir==='up'?'var(--up)':'var(--dn)';
  bodyEl.textContent=detail||'';
  toastEl.classList.add('show');
  toastT=setTimeout(function(){toastEl.classList.remove('show');},5500);
}
function maybeNotify(s, oldPrice) {
  if (!s.data||!oldPrice||s.data.price>=oldPrice) return;
  var pct=((s.data.price-oldPrice)/oldPrice)*100, ps=fmt(s.data.price,s.data.currency);
  showToast(s.symbol,s.name,ps+'  ▾ '+Math.abs(pct).toFixed(2)+'%','down');
  if (notifOn&&Notification.permission==='granted') try { new Notification(s.symbol+' düştü',{body:s.name+'\n'+ps,tag:'drop-'+s.symbol}); } catch(e){}
}

// ── Hedef fiyat alarmları ──
function checkTargetAlerts(s, oldPrice) {
  var t=targetData[s.symbol]; if (!t||!s.data||!oldPrice) return;
  var np=s.data.price, cur=s.data.currency, ps=fmt(np,cur);
  if (t.upper&&oldPrice<t.upper&&np>=t.upper) {
    showToast(s.symbol,'Üst hedefe ulaştı',s.name+'\n'+ps,'up');
    if (notifOn&&Notification.permission==='granted') try{new Notification(s.symbol+' ↑ Hedef',{body:s.name+' — '+ps,tag:'tgt-u-'+s.symbol});}catch(e){}
  }
  if (t.lower&&oldPrice>t.lower&&np<=t.lower) {
    showToast(s.symbol,'Alt limite düştü',s.name+'\n'+ps,'down');
    if (notifOn&&Notification.permission==='granted') try{new Notification(s.symbol+' ↓ Alt Limit',{body:s.name+' — '+ps,tag:'tgt-l-'+s.symbol});}catch(e){}
  }
}

// ── USD/TRY ──
async function fetchUsdTryRate() {
  try {
    var data   = await fetchWithFallback('https://query1.finance.yahoo.com/v8/finance/chart/USDTRY=X?interval=1d&range=1mo');
    var result = data?.chart?.result?.[0]; if (!result) return;
    var meta   = result.meta, price = meta.regularMarketPrice; if (!price) return;
    var prev   = meta.chartPreviousClose || meta.previousClose || price;
    var q      = result.indicators?.quote?.[0] || {};
    var closes = (q.close  || []).filter(v => v != null);
    var highs  = (q.high   || []).filter(v => v != null);
    var lows   = (q.low    || []).filter(v => v != null);

    usdtryRate = {
      price,
      change:     price - prev,
      changePct:  ((price - prev) / prev) * 100,
      dayHigh:    meta.regularMarketDayHigh  || (highs.length  ? highs[highs.length-1]   : null),
      dayLow:     meta.regularMarketDayLow   || (lows.length   ? lows[lows.length-1]     : null),
      monthHigh:  highs.length  ? Math.max.apply(null, highs)  : null,
      monthLow:   lows.length   ? Math.min.apply(null, lows)   : null,
      weekChange: closes.length >= 6
        ? ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
        : null,
      closes,
    };
    updateUsdTryCard();
    stocks.forEach(s => { if (s.data) updatePortfolioPanel(s.symbol, s.data.price, s.data.currency); });
  } catch(e) { console.warn('[USD/TRY]', e.message); }
}
function makeUsdTrySkeletonCard() {
  var d = document.createElement('div');
  d.className = 'card kur-card'; d.id = 'card-USDTRY';
  d.innerHTML =
    '<div class="c-hdr">' +
      '<div>' +
        '<div class="c-sym">USD <span class="c-xch">TRY</span></div>' +
        '<div class="c-name">Döviz Kuru</div>' +
      '</div>' +
      '<div class="live-dot" style="flex-shrink:0;margin-top:4px"></div>' +
    '</div>' +
    '<div class="c-price" id="kur-price"><div class="skel-box" style="width:130px;height:28px;border-radius:5px"></div></div>' +
    '<div class="c-badges" id="kur-badges"><span class="badge loading">Yükleniyor...</span></div>' +
    '<div class="chart-area" id="chart-area-USDTRY"><canvas id="cv-USDTRY" aria-label="USD/TRY grafik"></canvas></div>' +
    '<div class="sep"></div>' +
    // Günlük yüksek / düşük / değişim
    '<div class="c-meta" id="kur-meta">' +
      '<div class="m-col"><div class="m-lbl">Günlük Yük</div><div class="m-val" id="kur-day-high">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Günlük Düş</div><div class="m-val" id="kur-day-low">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Değişim</div><div class="m-val" id="kur-change">-</div></div>' +
    '</div>' +
    '<div class="sep"></div>' +
    // Aylık yüksek / düşük / haftalık değişim
    '<div class="c-meta" id="kur-meta2">' +
      '<div class="m-col"><div class="m-lbl">1A Yüksek</div><div class="m-val" id="kur-mo-high">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">1A Düşük</div><div class="m-val" id="kur-mo-low">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Haftalık</div><div class="m-val" id="kur-wk-chg">-</div></div>' +
    '</div>' +
    // Portföy USD değeri (portföy varsa göster)
    '<div class="kur-port" id="kur-port" style="display:none">' +
      '<div class="sep"></div>' +
      '<div class="kur-port-row">' +
        '<div class="m-lbl">Portföy (USD)</div>' +
        '<div class="kur-port-val" id="kur-port-val">-</div>' +
      '</div>' +
    '</div>';
  return d;
}
function updateUsdTryCard() {
  if (!usdtryRate) return;
  var priceEl  = document.getElementById('kur-price');
  var badgesEl = document.getElementById('kur-badges');
  if (!priceEl) return;

  var r   = usdtryRate;
  var D   = r.changePct > 0.01 ? 'up' : r.changePct < -0.01 ? 'down' : 'neutral';
  var card = document.getElementById('card-USDTRY');
  if (card) card.className = 'card kur-card ' + D;

  // Ana fiyat
  priceEl.textContent = r.price.toLocaleString('tr-TR', { minimumFractionDigits:4, maximumFractionDigits:4 }) + ' TL';

  // Değişim badge
  if (badgesEl) {
    var arrow  = D === 'up' ? '+' : D === 'down' ? '-' : '';
    var chgTxt = arrow + ' ' + Math.abs(r.changePct).toFixed(2) + '%';
    var chgAmt = (r.change >= 0 ? '+' : '') + r.change.toFixed(4) + ' TL';
    badgesEl.innerHTML =
      '<span class="badge ' + D + '">' + chgTxt + '</span>' +
      '<span class="badge neutral kur-amt">' + chgAmt + '</span>';
  }

  // Günlük yüksek / düşük / değişim
  var fmtKur = function(v) { return v != null ? v.toLocaleString('tr-TR',{minimumFractionDigits:4,maximumFractionDigits:4}) : '-'; };
  var el = function(id) { return document.getElementById(id); };

  if (el('kur-day-high')) el('kur-day-high').textContent = fmtKur(r.dayHigh);
  if (el('kur-day-low'))  el('kur-day-low').textContent  = fmtKur(r.dayLow);
  if (el('kur-change'))   {
    el('kur-change').textContent = (r.change >= 0 ? '+' : '') + r.change.toFixed(4);
    el('kur-change').style.color = D === 'up' ? 'var(--up)' : D === 'down' ? 'var(--dn)' : '';
  }
  if (el('kur-mo-high'))  el('kur-mo-high').textContent  = fmtKur(r.monthHigh);
  if (el('kur-mo-low'))   el('kur-mo-low').textContent   = fmtKur(r.monthLow);
  if (el('kur-wk-chg') && r.weekChange != null) {
    var wD  = r.weekChange > 0 ? 'up' : r.weekChange < 0 ? 'down' : 'neutral';
    var wSign = r.weekChange >= 0 ? '+' : '';
    el('kur-wk-chg').textContent = wSign + r.weekChange.toFixed(2) + '%';
    el('kur-wk-chg').style.color = wD === 'up' ? 'var(--up)' : wD === 'down' ? 'var(--dn)' : '';
  }

  // Sparkline
  var hist = r.closes;
  if (hist.length) {
    var cc = chartCol(D), cb = chartBg(D);
    if (charts['USDTRY']) {
      var ch = charts['USDTRY'];
      ch.data.labels = hist.map(function() { return ''; });
      ch.data.datasets[0].data            = hist;
      ch.data.datasets[0].borderColor     = cc;
      ch.data.datasets[0].backgroundColor = cb;
      ch.update('none');
    } else {
      var ctx = document.getElementById('cv-USDTRY');
      if (ctx) {
        charts['USDTRY'] = new Chart(ctx, {
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

  // Portföy USD değeri
  var tryTotal = 0;
  stocks.forEach(function(s) {
    if (s.data && s.data.currency === 'TRY' && portfolioData[s.symbol])
      tryTotal += (portfolioData[s.symbol].qty || 0) * s.data.price;
  });
  var portEl  = document.getElementById('kur-port');
  var portVal = document.getElementById('kur-port-val');
  if (portEl && portVal) {
    if (tryTotal > 0 && r.price > 0) {
      portVal.textContent = '$' + (tryTotal / r.price).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
      portEl.style.display = '';
    } else {
      portEl.style.display = 'none';
    }
  }
  // Kur değişince gram TRY fiyatını da yenile
  if (typeof updateGoldCard === 'function') updateGoldCard();
}
function ensureUsdTryCard() {
  if (!document.getElementById('card-USDTRY')) {
    var grid=document.getElementById('grid'); grid.insertBefore(makeUsdTrySkeletonCard(),grid.firstChild); fetchUsdTryRate();
  }
}

// ── Altın Kartı ─────────────────────────────────
var TROY_OZ_TO_GRAM = 31.1035; // 1 troy ons = 31.1035 gram

async function fetchGoldRate() {
  try {
    // GC=F: Comex Gold Futures — USD/troy ons
    var data   = await fetchWithFallback('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1mo');
    var result = data?.chart?.result?.[0]; if (!result) return;
    var meta   = result.meta, priceOz = meta.regularMarketPrice; if (!priceOz) return;
    var prev   = meta.chartPreviousClose || meta.previousClose || priceOz;
    var q      = result.indicators?.quote?.[0] || {};
    var closesOz = (q.close || []).filter(v => v != null);
    var highsOz  = (q.high  || []).filter(v => v != null);
    var lowsOz   = (q.low   || []).filter(v => v != null);

    goldData = {
      priceOz,
      priceGram:    priceOz / TROY_OZ_TO_GRAM,
      change:       priceOz - prev,
      changePct:    ((priceOz - prev) / prev) * 100,
      dayHighOz:    meta.regularMarketDayHigh  || (highsOz.length ? highsOz[highsOz.length-1] : null),
      dayLowOz:     meta.regularMarketDayLow   || (lowsOz.length  ? lowsOz[lowsOz.length-1]  : null),
      monthHighOz:  highsOz.length ? Math.max.apply(null, highsOz) : null,
      monthLowOz:   lowsOz.length  ? Math.min.apply(null, lowsOz)  : null,
      weekChange:   closesOz.length >= 6
        ? ((priceOz - closesOz[closesOz.length-6]) / closesOz[closesOz.length-6]) * 100
        : null,
      closesOz,
    };
    updateGoldCard();
  } catch(e) { console.warn('[Altın]', e.message); }
}

function makeGoldSkeletonCard() {
  var d = document.createElement('div');
  d.className = 'card gold-card'; d.id = 'card-GOLD';
  d.innerHTML =
    '<div class="c-hdr">' +
      '<div>' +
        '<div class="c-sym"><i class="ti ti-currency-dollar" style="font-size:13px;opacity:.7"></i> Altın <span class="c-xch">XAU</span></div>' +
        '<div class="c-name">Ons / Gram</div>' +
      '</div>' +
      '<div class="live-dot" style="flex-shrink:0;margin-top:4px;background:var(--gold);box-shadow:0 0 6px var(--gold)"></div>' +
    '</div>' +
    // Ana fiyat: gram TRY (varsa) veya ons USD
    '<div class="c-price" id="gold-price"><div class="skel-box" style="width:130px;height:28px;border-radius:5px"></div></div>' +
    '<div class="c-badges" id="gold-badges"><span class="badge loading">Yükleniyor...</span></div>' +
    // İkincil fiyat (ons USD)
    '<div class="gold-sub" id="gold-sub"></div>' +
    '<div class="chart-area" id="chart-area-GOLD"><canvas id="cv-GOLD" aria-label="Altın grafik"></canvas></div>' +
    '<div class="sep"></div>' +
    '<div class="c-meta">' +
      '<div class="m-col"><div class="m-lbl">Günlük Yük</div><div class="m-val" id="gold-day-high">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Günlük Düş</div><div class="m-val" id="gold-day-low">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Değişim</div><div class="m-val" id="gold-change">-</div></div>' +
    '</div>' +
    '<div class="sep"></div>' +
    '<div class="c-meta">' +
      '<div class="m-col"><div class="m-lbl">1A Yüksek</div><div class="m-val" id="gold-mo-high">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">1A Düşük</div><div class="m-val" id="gold-mo-low">-</div></div>' +
      '<div class="m-col"><div class="m-lbl">Haftalık</div><div class="m-val" id="gold-wk-chg">-</div></div>' +
    '</div>';
  return d;
}

function updateGoldCard() {
  if (!goldData) return;
  var priceEl  = document.getElementById('gold-price');
  var badgesEl = document.getElementById('gold-badges');
  if (!priceEl) return;

  var g   = goldData;
  var D   = g.changePct > 0.01 ? 'up' : g.changePct < -0.01 ? 'down' : 'neutral';
  var card = document.getElementById('card-GOLD');
  if (card) card.className = 'card gold-card ' + D;

  var elG = function(id) { return document.getElementById(id); };

  // Gram TRY (kur varsa), yoksa ons USD
  var hasTry  = usdtryRate && usdtryRate.price > 0;
  var gramTry = hasTry ? (g.priceGram * usdtryRate.price) : null;
  var ozUsd   = g.priceOz;

  if (gramTry != null) {
    priceEl.textContent = gramTry.toLocaleString('tr-TR', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' TL/gr';
    if (elG('gold-sub')) elG('gold-sub').textContent = '$' + ozUsd.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) + '/oz';
  } else {
    priceEl.textContent = '$' + ozUsd.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) + '/oz';
    if (elG('gold-sub')) elG('gold-sub').textContent = '';
  }

  // Badge
  if (badgesEl) {
    var arrow  = D === 'up' ? '+' : D === 'down' ? '-' : '';
    var pctTxt = arrow + ' ' + Math.abs(g.changePct).toFixed(2) + '%';
    var amtTxt = (g.change >= 0 ? '+' : '') + '$' + Math.abs(g.change).toFixed(2);
    badgesEl.innerHTML =
      '<span class="badge ' + D + '">' + pctTxt + '</span>' +
      '<span class="badge neutral kur-amt">' + amtTxt + '</span>';
  }

  // Stat satırları — ons bazında göster
  var fmtOz  = function(v) { return v != null ? '$' + v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '-'; };
  if (elG('gold-day-high')) elG('gold-day-high').textContent = fmtOz(g.dayHighOz);
  if (elG('gold-day-low'))  elG('gold-day-low').textContent  = fmtOz(g.dayLowOz);
  if (elG('gold-change')) {
    elG('gold-change').textContent = (g.change >= 0 ? '+' : '') + '$' + Math.abs(g.change).toFixed(2);
    elG('gold-change').style.color = D === 'up' ? 'var(--up)' : D === 'down' ? 'var(--dn)' : '';
  }
  if (elG('gold-mo-high')) elG('gold-mo-high').textContent = fmtOz(g.monthHighOz);
  if (elG('gold-mo-low'))  elG('gold-mo-low').textContent  = fmtOz(g.monthLowOz);
  if (elG('gold-wk-chg') && g.weekChange != null) {
    var wD    = g.weekChange > 0 ? 'up' : g.weekChange < 0 ? 'down' : 'neutral';
    var wSign = g.weekChange >= 0 ? '+' : '';
    elG('gold-wk-chg').textContent = wSign + g.weekChange.toFixed(2) + '%';
    elG('gold-wk-chg').style.color = wD === 'up' ? 'var(--up)' : wD === 'down' ? 'var(--dn)' : '';
  }

  // Sparkline (ons kapanış fiyatları)
  var hist = g.closesOz;
  if (hist.length) {
    var cc = chartCol(D), cb = chartBg(D);
    if (charts['GOLD']) {
      var ch = charts['GOLD'];
      ch.data.labels = hist.map(function() { return ''; });
      ch.data.datasets[0].data            = hist;
      ch.data.datasets[0].borderColor     = cc;
      ch.data.datasets[0].backgroundColor = cb;
      ch.update('none');
    } else {
      var ctx = document.getElementById('cv-GOLD');
      if (ctx) {
        charts['GOLD'] = new Chart(ctx, {
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
}

function ensureGoldCard() {
  if (!document.getElementById('card-GOLD')) {
    var grid = document.getElementById('grid');
    var kurCard = document.getElementById('card-USDTRY');
    var goldCard = makeGoldSkeletonCard();
    // USD/TRY kartının hemen arkasına ekle
    if (kurCard && kurCard.nextSibling) {
      grid.insertBefore(goldCard, kurCard.nextSibling);
    } else {
      grid.insertBefore(goldCard, grid.firstChild);
    }
    fetchGoldRate();
  }
}

// ── Sektör etiketi (UV #11) ──
async function fetchSector(sym, exchange) {
  if (sym in sectorData) return; // zaten çekildi (boş string de olsa)
  sectorData[sym] = ''; // denemeden önce işaretle
  try {
    var ticker = exchange==='BIST' ? sym+'.IS' : sym;
    var res = await fetch(WORKER_URL+'/fmp/profile/'+ticker, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    var data = await res.json();
    var prof = Array.isArray(data) ? data[0] : data;
    if (prof && prof.sector) {
      sectorData[sym] = prof.sector;
      saveSectors();
      renderSectorTag(sym);
    }
  } catch(e) { /* silent — kullanıcı panelden girebilir */ }
}
function renderSectorTag(sym) {
  var el = document.getElementById('sector-'+sym); if (!el) return;
  var s = sectorData[sym];
  if (s) { el.textContent=s; el.style.display=''; } else { el.style.display='none'; }
}

// ── Hisse notu (UV #12) ──
function toggleNotePanel(sym) {
  var panel=document.getElementById('note-panel-'+sym),portPanel=document.getElementById('port-panel-'+sym),tgtPanel=document.getElementById('tgt-panel-'+sym);
  if (!panel) return;
  var opening=panel.style.display==='none';
  panel.style.display=opening?'':'none';
  if (portPanel) portPanel.style.display='none';
  if (tgtPanel)  tgtPanel.style.display='none';
  if (opening) {
    var sEl=document.getElementById('note-sector-'+sym),tEl=document.getElementById('note-text-'+sym);
    if (sEl) sEl.value=sectorData[sym]||'';
    if (tEl) tEl.value=notesData[sym]||'';
  }
}
function saveNote(sym) {
  var sEl=document.getElementById('note-sector-'+sym),tEl=document.getElementById('note-text-'+sym);
  sectorData[sym]=sEl?sEl.value.trim():''; notesData[sym]=tEl?tEl.value.trim():'';
  saveSectors(); saveNotes(); renderSectorTag(sym); renderNoteBadge(sym);
}
function clearNote(sym) {
  delete sectorData[sym]; delete notesData[sym]; saveSectors(); saveNotes();
  renderSectorTag(sym); renderNoteBadge(sym);
  var sEl=document.getElementById('note-sector-'+sym),tEl=document.getElementById('note-text-'+sym);
  if (sEl) sEl.value=''; if (tEl) tEl.value='';
}
function renderNoteBadge(sym) {
  var btn=document.getElementById('note-btn-'+sym); if (!btn) return;
  btn.classList.toggle('active',!!(notesData[sym]||sectorData[sym]));
}

// ── Mum Grafik (Candlestick) ──
// ── Mini Mum Grafik (kart içi) ──────────────────
function renderMiniCandle(chartArea, sym, d) {
  var bars = (d.ohlcv || []).filter(function(b) {
    return b.o != null && b.high != null && b.low != null && b.close != null;
  });

  // Son N barı göster (kart genişliğine göre)
  var MAX = 60;
  if (bars.length > MAX) bars = bars.slice(bars.length - MAX);

  if (bars.length < 2) {
    chartArea.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--muted2)">Veri yükleniyor...</div>';
    return;
  }

  var W  = 260, H  = 72;   // viewBox — SVG responsive ile gerçek boyuta uzar
  var PT = 3,   PB = 14;   // üst / alt boşluk (alt: hacim için)
  var chartH = H - PT - PB;
  var VOL_H  = 10;          // hacim şeridi yüksekliği (alt)
  var N      = bars.length;
  var step   = W / N;
  var barW   = Math.max(1.5, step * 0.65);

  function bx(i) { return i * step + step / 2; }

  // Fiyat skalası
  var maxP = Math.max.apply(null, bars.map(function(b){ return b.high; }));
  var minP = Math.min.apply(null, bars.map(function(b){ return b.low;  }));
  var prng  = maxP - minP || 1;
  var ppad  = prng * 0.08;
  var pMax  = maxP + ppad, pMin = minP - ppad;
  function py(p){ return PT + (pMax - p) / (pMax - pMin) * chartH; }

  // Hacim skalası
  var maxVol = Math.max.apply(null, bars.map(function(b){ return b.volume||0; })) || 1;
  var volTop = H - VOL_H;
  function vy(v){ return volTop + VOL_H - (v / maxVol) * VOL_H; }

  var UP = '#10b981', DN = '#f43f5e';
  var parts = '';

  bars.forEach(function(bar, i) {
    var x     = bx(i);
    var bull  = bar.close >= bar.o;
    var col   = bull ? UP : DN;
    var bodyT = py(Math.max(bar.o, bar.close));
    var bodyB = py(Math.min(bar.o, bar.close));
    var bodyH = Math.max(1, bodyB - bodyT);
    var hw    = Math.max(0.8, barW / 2);

    // Hacim
    if (bar.volume) {
      parts += '<rect x="'+(x-hw)+'" y="'+vy(bar.volume)+'" width="'+(hw*2)+'" height="'+(H-vy(bar.volume))+'" fill="'+col+'" opacity="0.22" rx="0.5"/>';
    }
    // Fitil
    parts += '<line x1="'+x+'" y1="'+py(bar.high)+'" x2="'+x+'" y2="'+bodyT+'" stroke="'+col+'" stroke-width="0.8" opacity="0.7"/>';
    parts += '<line x1="'+x+'" y1="'+bodyB+'" x2="'+x+'" y2="'+py(bar.low)+'" stroke="'+col+'" stroke-width="0.8" opacity="0.7"/>';
    // Gövde
    parts += '<rect x="'+(x-hw)+'" y="'+bodyT+'" width="'+(hw*2)+'" height="'+bodyH+'" fill="'+col+'" rx="0.4"/>';
  });

  // Hacim ayırıcı
  parts += '<line x1="0" y1="'+volTop+'" x2="'+W+'" y2="'+volTop+'" stroke="rgba(255,255,255,.05)" stroke-width="0.5"/>';

  // Son kapanış fiyatı — sağ kenar etiketi
  var last  = bars[bars.length - 1];
  var lastY = py(last.close);
  var lCol  = last.close >= last.o ? UP : DN;
  // Yatay referans çizgisi
  parts += '<line x1="0" y1="'+lastY+'" x2="'+W+'" y2="'+lastY+'" stroke="'+lCol+'" stroke-width="0.6" stroke-dasharray="2,2" opacity="0.5"/>';

  // Expand ikonu — sağ alt
  var expandIcon = '<div class="chart-expand-hint"><i class="ti ti-arrows-maximize"></i></div>';

  chartArea.innerHTML =
    '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="100%" preserveAspectRatio="none" style="display:block">'+
      parts +
    '</svg>' + expandIcon;
}

// ── Grafik Modalı ──────────────────────────────
var _chartModalSym = null;

function openChartModal(sym) {
  _chartModalSym = sym;
  var s = stocks.find(x => x.symbol === sym);
  if (!s || !s.data) return;

  var overlay = document.getElementById('chart-overlay');
  var titleEl = document.getElementById('cm-title');
  var nameEl  = document.getElementById('cm-name');
  if (titleEl) titleEl.textContent = sym;
  if (nameEl)  nameEl.textContent  = s.name;

  // Range butonlarını hissenin mevcut aralığına senkronize et
  var cur = chartRanges[sym] || '1y';
  overlay.querySelectorAll('.cm-range-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.range === cur);
  });

  overlay.classList.add('open');
  _renderFullChart(sym, s.data);
}

function closeChartModal() {
  document.getElementById('chart-overlay').classList.remove('open');
  _chartModalSym = null;
}

async function cmChangeRange(range) {
  var sym = _chartModalSym; if (!sym) return;
  chartRanges[sym] = range;

  document.querySelectorAll('.cm-range-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.range === range);
  });

  var loadEl = document.getElementById('cm-loading');
  if (loadEl) loadEl.style.display = 'flex';

  var s = stocks.find(x => x.symbol === sym);
  try {
    s.data = await fetchStockPrice(sym, s.exchange, range);
    updateCard(s, null);
    _renderFullChart(sym, s.data);
  } catch(e) {
    console.warn('[ChartModal]', e.message);
  } finally {
    if (loadEl) loadEl.style.display = 'none';
  }
}

function _renderFullChart(sym, d) {
  var container = document.getElementById('cm-chart');
  if (!container) return;

  var bars = (d.ohlcv || []).filter(function(b) {
    return b.o != null && b.high != null && b.low != null && b.close != null;
  });

  if (bars.length < 2) {
    container.innerHTML = '<div class="cm-nodata">Yeterli veri yok</div>';
    return;
  }

  // ── Boyutlar ──
  var W     = container.clientWidth  || 700;
  var H     = container.clientHeight || 340;
  var PL    = 64;   // sol — fiyat ekseni
  var PR    = 10;   // sağ
  var PT    = 14;   // üst
  var PB_VOL= 52;   // alt — hacim + tarih
  var VOL_H = 38;   // hacim bölgesi yüksekliği
  var chartW = W - PL - PR;
  var chartH = H - PT - PB_VOL;

  // Bar genişliği: bar sayısına göre otomatik hesapla
  var barW  = Math.max(2, Math.min(12, chartW / bars.length - 1));
  var gap   = barW * 0.15;
  var step  = chartW / bars.length;

  function bx(i) { return PL + i * step + step / 2; } // bar merkezi

  // ── Fiyat skalası ──
  var maxP = Math.max.apply(null, bars.map(function(b){ return b.high; }));
  var minP = Math.min.apply(null, bars.map(function(b){ return b.low;  }));
  var prng  = maxP - minP || 1;
  var ppad  = prng * 0.08;
  var pMax  = maxP + ppad, pMin = minP - ppad;

  function py(p) { return PT + (pMax - p) / (pMax - pMin) * chartH; }

  // ── Hacim skalası ──
  var maxVol = Math.max.apply(null, bars.map(function(b){ return b.volume || 0; })) || 1;
  var volTop = H - PB_VOL + 4;
  function vy(v) { return H - 18 - (v / maxVol) * (VOL_H - 8); }

  // ── Fiyat grid çizgileri + Y ekseni etiketleri ──
  var tickCount = 5;
  var gridLines = '', yLabels = '';
  for (var ti = 0; ti <= tickCount; ti++) {
    var tickP = pMin + (pMax - pMin) * ti / tickCount;
    var tickY = py(tickP);
    gridLines += '<line x1="' + PL + '" y1="' + tickY + '" x2="' + (W - PR) + '" y2="' + tickY +
                 '" stroke="rgba(255,255,255,.045)" stroke-width="1"/>';
    var label = tickP >= 1000
      ? tickP.toLocaleString('tr-TR', {maximumFractionDigits: 0})
      : tickP.toFixed(2);
    yLabels += '<text x="' + (PL - 5) + '" y="' + (tickY + 4) + '" text-anchor="end"' +
               ' font-size="9" fill="#64748b" font-family="JetBrains Mono,monospace">' + label + '</text>';
  }

  // ── X ekseni tarih etiketleri ──
  var xLabels = '';
  var dateStep = Math.max(1, Math.floor(bars.length / 6));
  for (var di = 0; di < bars.length; di += dateStep) {
    var bar = bars[di];
    if (!bar.t) continue;
    var dt  = new Date(bar.t);
    var lbl = (dt.getMonth() + 1) + '/' + (dt.getFullYear() % 100);
    xLabels += '<text x="' + bx(di) + '" y="' + (H - 4) + '" text-anchor="middle"' +
               ' font-size="9" fill="#64748b" font-family="JetBrains Mono,monospace">' + lbl + '</text>';
  }

  // ── Mumlar ──
  var UP = '#10b981', DN = '#f43f5e';
  var candleParts = '', volParts = '';

  bars.forEach(function(bar, i) {
    var x    = bx(i);
    var bull = bar.close >= bar.o;
    var col  = bull ? UP : DN;
    var bodyT = py(Math.max(bar.o, bar.close));
    var bodyB = py(Math.min(bar.o, bar.close));
    var bodyH = Math.max(1.5, bodyB - bodyT);
    var hw    = Math.max(1, barW / 2 - gap);

    // Fitil
    candleParts +=
      '<line x1="' + x + '" y1="' + py(bar.high) + '" x2="' + x + '" y2="' + bodyT +
      '" stroke="' + col + '" stroke-width="1" opacity="0.8"/>' +
      '<line x1="' + x + '" y1="' + bodyB + '" x2="' + x + '" y2="' + py(bar.low) +
      '" stroke="' + col + '" stroke-width="1" opacity="0.8"/>';

    // Gövde — etkileşim verisi data attribute olarak
    candleParts +=
      '<rect class="cm-bar" x="' + (x - hw) + '" y="' + bodyT + '" width="' + (hw * 2) + '"' +
      ' height="' + bodyH + '" fill="' + col + '" rx="1"' +
      ' data-i="' + i + '" data-x="' + x + '" data-col="' + col + '"/>';

    // Hacim
    if (bar.volume) {
      volParts +=
        '<rect x="' + (x - hw) + '" y="' + vy(bar.volume) + '" width="' + (hw * 2) + '"' +
        ' height="' + (H - 18 - vy(bar.volume)) + '" fill="' + col + '" opacity="0.3" rx="1"/>';
    }
  });

  // ── Hacim ekseni ayırıcı ──
  var separator = '<line x1="' + PL + '" y1="' + volTop + '" x2="' + (W - PR) + '" y2="' + volTop +
                  '" stroke="rgba(255,255,255,.07)" stroke-width="1"/>';

  // ── SVG ──
  var svg =
    '<svg id="cm-svg" width="' + W + '" height="' + H + '" style="display:block;cursor:crosshair">' +
      gridLines + yLabels + separator +
      volParts + candleParts +
      xLabels +
      // Crosshair (başta gizli)
      '<line id="cm-cross-v" x1="0" y1="' + PT + '" x2="0" y2="' + (H - PB_VOL) + '"' +
      ' stroke="rgba(255,255,255,.2)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>' +
      '<line id="cm-cross-h" x1="' + PL + '" y1="0" x2="' + (W - PR) + '" y2="0"' +
      ' stroke="rgba(255,255,255,.2)" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>' +
    '</svg>';

  container.innerHTML = svg;

  // ── OHLCV başlık kutusunu son mum ile başlat ──
  var last = bars[bars.length - 1];
  _updateCmOhlc(last, last.close >= last.o ? UP : DN);

  // ── Mouse / touch etkileşimi ──
  var svgEl = document.getElementById('cm-svg');
  if (!svgEl) return;

  function getBarAt(clientX) {
    var rect = svgEl.getBoundingClientRect();
    var relX = (clientX - rect.left) * (W / rect.width) - PL;
    var idx  = Math.round(relX / step - 0.5);
    return Math.max(0, Math.min(bars.length - 1, idx));
  }

  function onMove(clientX, clientY) {
    var idx = getBarAt(clientX);
    var bar = bars[idx];
    var cx  = bx(idx);
    var rect = svgEl.getBoundingClientRect();
    var relY = (clientY - rect.top) * (H / rect.height);
    var col  = bar.close >= bar.o ? UP : DN;

    document.getElementById('cm-cross-v').setAttribute('x1', cx);
    document.getElementById('cm-cross-v').setAttribute('x2', cx);
    document.getElementById('cm-cross-v').setAttribute('visibility', 'visible');
    document.getElementById('cm-cross-h').setAttribute('y1', relY);
    document.getElementById('cm-cross-h').setAttribute('y2', relY);
    document.getElementById('cm-cross-h').setAttribute('visibility', 'visible');

    _updateCmOhlc(bar, col);
  }
  function onLeave() {
    document.getElementById('cm-cross-v').setAttribute('visibility', 'hidden');
    document.getElementById('cm-cross-h').setAttribute('visibility', 'hidden');
    _updateCmOhlc(last, last.close >= last.o ? UP : DN);
  }

  svgEl.addEventListener('mousemove', function(e) { onMove(e.clientX, e.clientY); });
  svgEl.addEventListener('mouseleave', onLeave);
  svgEl.addEventListener('touchmove', function(e) {
    e.preventDefault();
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  svgEl.addEventListener('touchend', onLeave);
}

function _updateCmOhlc(bar, col) {
  var el = document.getElementById('cm-ohlc');
  if (!el) return;
  var pct = bar.o ? ((bar.close - bar.o) / bar.o * 100) : 0;
  var sign = pct >= 0 ? '+' : '';
  var dt = bar.t ? new Date(bar.t).toLocaleDateString('tr-TR', { day:'2-digit', month:'short', year:'numeric' }) : '';
  el.innerHTML =
    '<span class="cm-date">' + dt + '</span>' +
    '<span>A <strong>' + bar.o.toFixed(2) + '</strong></span>' +
    '<span>Y <strong>' + bar.high.toFixed(2) + '</strong></span>' +
    '<span>D <strong>' + bar.low.toFixed(2) + '</strong></span>' +
    '<span>K <strong style="color:' + col + '">' + bar.close.toFixed(2) + '</strong></span>' +
    (bar.volume ? '<span>Hcm <strong>' + fmtVol(bar.volume) + '</strong></span>' : '') +
    '<span style="color:' + col + '">' + sign + pct.toFixed(2) + '%</span>';
}

// ── Sıralama (UV #13) ──
function ensureSortBar() {
  if (document.getElementById('sort-bar')) return;
  var grid=document.getElementById('grid'), bar=document.createElement('div');
  bar.id='sort-bar'; bar.className='sort-bar';
  var SORTS=[{k:'added',l:'Eklenme'},{k:'az',l:'A → Z'},{k:'change-desc',l:'↑ Değişim'},{k:'change-asc',l:'↓ Değişim'},{k:'div',l:'Temettü'},{k:'vol',l:'Hacim'},{k:'mcap',l:'Piy. Değ.'}];
  var pills=SORTS.map(s=>'<button class="sort-pill'+(s.k===currentSort?' active':'')+'" data-sort="'+s.k+'" onclick="setSort(\''+s.k+'\')">'+s.l+'</button>').join('');
  bar.innerHTML='<span class="sort-lbl"><i class="ti ti-arrows-sort"></i> Sırala</span><div class="sort-pills">'+pills+'</div>';
  grid.parentNode.insertBefore(bar, grid);
}
function setSort(s) {
  currentSort=s;
  document.querySelectorAll('.sort-pill').forEach(b=>b.classList.toggle('active',b.dataset.sort===s));
  applySort();
}
function applySort() {
  var grid=document.getElementById('grid'), sorted=stocks.slice();
  if      (currentSort==='az')          sorted.sort((a,b)=>a.symbol.localeCompare(b.symbol,'tr'));
  else if (currentSort==='change-desc') sorted.sort((a,b)=>(b.data?b.data.changePct:0)-(a.data?a.data.changePct:0));
  else if (currentSort==='change-asc')  sorted.sort((a,b)=>(a.data?a.data.changePct:0)-(b.data?b.data.changePct:0));
  else if (currentSort==='div')         sorted.sort((a,b)=>(b.data?b.data.dividendYield:0)-(a.data?a.data.dividendYield:0));
  else if (currentSort==='vol')         sorted.sort((a,b)=>(b.data?b.data.volume:0)-(a.data?a.data.volume:0));
  else if (currentSort==='mcap')        sorted.sort((a,b)=>(b.data?b.data.marketCap:0)-(a.data?a.data.marketCap:0));
  sorted.forEach(s=>{ var c=document.getElementById('card-'+s.symbol); if(c) grid.appendChild(c); });
  var kur=document.getElementById('card-USDTRY'); if (kur) grid.insertBefore(kur,grid.firstChild);
}

// ── CSV Dışa Aktarma (UV #14) ──
function ensureExportBtn() {
  if (document.getElementById('export-btn')) return;
  var refBtn=document.getElementById('ref-btn'); if (!refBtn) return;
  var btn=document.createElement('button');
  btn.id='export-btn'; btn.className='btn'; btn.title='Portföyü CSV olarak indir';
  btn.innerHTML='<i class="ti ti-download"></i> CSV'; btn.onclick=exportCSV;
  refBtn.insertAdjacentElement('beforebegin',btn);
}
function exportCSV() {
  var BOM='\uFEFF', D=',';
  var cols=['Sembol','Ad','Borsa','Sektör','Fiyat','Para Birimi','Değişim %','Hacim',
            'Temettü %','RSI','52H Yüksek','52H Düşük','F/K','Piyasa Değeri',
            'Adet','Ort. Maliyet','Toplam Maliyet','Güncel Değer','K/Z','K/Z %',
            'Üst Hedef','Alt Limit','Not'];
  function esc(v){if(v==null||v==='')return'';return'"'+String(v).replace(/"/g,'""').replace(/\r?\n/g,' ')+'"';}
  function num(v){return (v != null && v !== '') ? v : '';}
  var rows=[cols.join(D)];
  stocks.forEach(function(s){
    var d=s.data||{}, p=portfolioData[s.symbol]||{}, t=targetData[s.symbol]||{};
    var sect=sectorData[s.symbol]||'', note=notesData[s.symbol]||'';
    var rsi=d.closes?calcRSI(d.closes):null;
    var tc=(p.qty&&p.avgCost)?p.qty*p.avgCost:null, tv=(p.qty&&d.price)?p.qty*d.price:null;
    var pnl=(tc!=null&&tv!=null)?tv-tc:null, pnlP=(tc&&pnl!=null)?pnl/tc*100:null;
    var pe=(d.eps&&d.price&&d.eps!==0)?d.price/d.eps:null;
    rows.push([
      esc(s.symbol),esc(s.name),esc(s.exchange),esc(sect),
      num(d.price),esc(d.currency),
      num(d.changePct!=null?d.changePct.toFixed(2):null),num(d.volume),
      num(d.dividendYield?(d.dividendYield*100).toFixed(2):null),num(rsi),
      num(d.weekHigh52),num(d.weekLow52),num(pe?pe.toFixed(1):null),num(d.marketCap),
      num(p.qty),num(p.avgCost),
      num(tc?tc.toFixed(2):null),num(tv?tv.toFixed(2):null),
      num(pnl!=null?pnl.toFixed(2):null),num(pnlP!=null?pnlP.toFixed(2):null),
      num(t.upper),num(t.lower),esc(note)
    ].join(D));
  });
  var blob=new Blob([BOM+rows.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  var url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download='hisse_takibi_'+new Date().toISOString().slice(0,10)+'.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Portföy / Alım Takibi ──
function _closeOtherPanels(sym, keep) {
  var panels=['port','tgt','note'];
  panels.filter(p=>p!==keep).forEach(p=>{var el=document.getElementById(p+'-panel-'+sym);if(el)el.style.display='none';});
}
function togglePortfolioPanel(sym) {
  var panel=document.getElementById('port-panel-'+sym); if (!panel) return;
  var opening=panel.style.display==='none';
  panel.style.display=opening?'':'none';
  if (opening) { _closeOtherPanels(sym,'port'); }
  if (opening&&portfolioData[sym]) {
    var qEl=document.getElementById('port-qty-'+sym),cEl=document.getElementById('port-cost-'+sym);
    if(qEl) qEl.value=portfolioData[sym].qty||''; if(cEl) cEl.value=portfolioData[sym].avgCost||'';
  }
}
function savePortfolioEntry(sym) {
  var qEl=document.getElementById('port-qty-'+sym),cEl=document.getElementById('port-cost-'+sym); if(!qEl||!cEl) return;
  var qty=parseFloat(qEl.value),avgCost=parseFloat(cEl.value);
  if(isNaN(qty)||qty<=0||isNaN(avgCost)||avgCost<=0){cEl.focus();return;}
  portfolioData[sym]={qty:qty,avgCost:avgCost}; savePortfolio();
  var s=stocks.find(x=>x.symbol===sym); if(s&&s.data) updatePortfolioPanel(sym,s.data.price,s.data.currency);
  updateUsdTryCard();
}
function clearPortfolioEntry(sym) {
  delete portfolioData[sym]; savePortfolio(); updatePortfolioPanel(sym,null,null); updateUsdTryCard();
  var qEl=document.getElementById('port-qty-'+sym),cEl=document.getElementById('port-cost-'+sym);
  if(qEl)qEl.value=''; if(cEl)cEl.value='';
}
function updatePortfolioPanel(sym, currentPrice, currency) {
  var pnlEl=document.getElementById('port-pnl-'+sym); if(!pnlEl) return;
  var p=portfolioData[sym];
  if (!p||!currentPrice){pnlEl.innerHTML='<span class="port-empty">Adet ve ort. maliyet gir → K/Z hesabı otomatik yapılır.</span>';return;}
  var tc=p.qty*p.avgCost,tv=p.qty*currentPrice,pnl=tv-tc,pp=(pnl/tc)*100,col=pnl>=0?'var(--up)':'var(--dn)',sign=pnl>=0?'+':'',cur=currency||'TRY';
  var usdLine='';
  if (cur==='TRY'&&usdtryRate&&usdtryRate.price>0)
    usdLine='<div class="port-usd">≈ $'+(tv/usdtryRate.price).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' (kur: '+usdtryRate.price.toFixed(2)+')</div>';
  pnlEl.innerHTML=
    '<div class="port-row-disp"><span><span class="m-lbl">Adet</span> '+p.qty.toLocaleString('tr-TR')+'</span><span><span class="m-lbl">Ort. Maliyet</span> '+fmt(p.avgCost,cur)+'</span></div>'+
    '<div class="port-row-disp" style="margin-top:6px"><span><span class="m-lbl">Güncel Değer</span> '+fmt(tv,cur)+'</span><span class="port-pnl-val" style="color:'+col+'">'+sign+fmt(pnl,cur)+' <span class="port-pct">('+sign+pp.toFixed(2)+'%)</span></span></div>'+usdLine;
}

// ── Hedef Fiyat ──
function toggleTargetPanel(sym) {
  var panel=document.getElementById('tgt-panel-'+sym); if (!panel) return;
  var opening=panel.style.display==='none';
  panel.style.display=opening?'':'none';
  if (opening) { _closeOtherPanels(sym,'tgt'); }
  if (opening&&targetData[sym]) {
    var uEl=document.getElementById('tgt-upper-'+sym),lEl=document.getElementById('tgt-lower-'+sym);
    if(uEl)uEl.value=targetData[sym].upper||''; if(lEl)lEl.value=targetData[sym].lower||'';
  }
}
function saveTargetEntry(sym) {
  var uEl=document.getElementById('tgt-upper-'+sym),lEl=document.getElementById('tgt-lower-'+sym); if(!uEl||!lEl) return;
  var upper=uEl.value.trim()?parseFloat(uEl.value):null,lower=lEl.value.trim()?parseFloat(lEl.value):null;
  if(!upper&&!lower){clearTargetEntry(sym);return;}
  targetData[sym]={upper:upper||null,lower:lower||null}; saveTargets(); renderTargetBadges(sym);
}
function clearTargetEntry(sym) {
  delete targetData[sym]; saveTargets(); renderTargetBadges(sym);
  var uEl=document.getElementById('tgt-upper-'+sym),lEl=document.getElementById('tgt-lower-'+sym);
  if(uEl)uEl.value=''; if(lEl)lEl.value='';
}
function renderTargetBadges(sym) {
  var area=document.getElementById('tgt-badges-'+sym); if(!area) return;
  var t=targetData[sym]; if(!t){area.innerHTML='';return;}
  var s=stocks.find(x=>x.symbol===sym),cur=s&&s.data?s.data.currency:'TRY',html='';
  if(t.upper) html+='<span class="badge tgt-badge tgt-up"><i class="ti ti-arrow-up"></i> '+fmt(t.upper,cur)+'</span>';
  if(t.lower) html+='<span class="badge tgt-badge tgt-dn"><i class="ti ti-arrow-down"></i> '+fmt(t.lower,cur)+'</span>';
  area.innerHTML=html;
}

// ── Grafik aralık değiştirme ──
async function changeRange(sym, range) {
  chartRanges[sym]=range;
  var card=document.getElementById('card-'+sym);
  if (card){card.querySelectorAll('.range-btn').forEach(b=>b.classList.toggle('active',b.dataset.range===range));var ca=card.querySelector('.chart-area');if(ca)ca.style.opacity='.4';}
  var s=stocks.find(x=>x.symbol===sym); if(!s) return;
  try {
    s.data=await fetchStockPrice(sym,s.exchange,range); updateCard(s,null);
    if(card){var ca2=card.querySelector('.chart-area');if(ca2)ca2.style.opacity='';}
    applySort(); // Yeni verilerle sıralamayı güncelle
  } catch(e){
    console.warn('[Range]',sym,e.message);
    if(card){var ca3=card.querySelector('.chart-area');if(ca3)ca3.style.opacity='';}
  }
}

// ── Card ──
function makeSkeletonCard(sym, name, exch) {
  var activeRange=chartRanges[sym]||'1y';
  var RLABELS={'1mo':'1A','3mo':'3A','6mo':'6A','1y':'1Y','5y':'5Y'};
  var rangeBtns=Object.keys(RLABELS).map(r=>
    '<button class="range-btn'+(r===activeRange?' active':'')+'" data-range="'+r+'" onclick="changeRange(\''+sym+'\',\''+r+'\')">'+RLABELS[r]+'</button>'
  ).join('');
  var d=document.createElement('div'); d.className='card'; d.id='card-'+sym;
  d.innerHTML=
    '<div class="c-hdr">'+
      '<div>'+
        '<div class="c-sym">'+sym+'<span class="c-xch">'+exch+'</span></div>'+
        '<div class="c-name">'+name+' <span class="sector-tag" id="sector-'+sym+'" style="display:none"></span></div>'+
      '</div>'+
      '<div class="c-hdr-actions">'+
        '<button class="card-action-btn" onclick="togglePortfolioPanel(\''+sym+'\')" title="Alım takibi"><i class="ti ti-wallet"></i></button>'+
        '<button class="card-action-btn" onclick="toggleTargetPanel(\''+sym+'\')"    title="Hedef fiyat"><i class="ti ti-target"></i></button>'+
        '<button class="card-action-btn" id="note-btn-'+sym+'" onclick="toggleNotePanel(\''+sym+'\')" title="Not &amp; Sektör"><i class="ti ti-pencil"></i></button>'+
        '<button class="rm-btn" onclick="removeStock(\''+sym+'\')" title="Kaldır"><i class="ti ti-x"></i></button>'+
      '</div>'+
    '</div>'+
    '<div class="c-price"><div class="skel-box" style="width:130px;height:28px;border-radius:5px"></div></div>'+
    '<div class="c-badges"><span class="badge loading">Veri çekiliyor...</span></div>'+
    '<div id="tgt-badges-'+sym+'" class="tgt-badges-row"></div>'+
    '<div class="range-bar">' + rangeBtns + '</div>'+
    '<div class="chart-area chart-clickable" id="chart-area-'+sym+'" onclick="openChartModal(\''+sym+'\')" title="Detaylı grafik için tıkla">'+
      '<div class="mini-candle-skel"><div class="skel-box" style="width:100%;height:100%;border-radius:4px;opacity:.4"></div></div>'+
      '<div class="chart-expand-hint"><i class="ti ti-arrows-maximize"></i></div>'+
    '</div>'+
    '<div class="sep"></div>'+
    '<div class="c-meta">'+
      '<div class="m-col"><div class="m-lbl">Yüksek</div><div class="m-val" data-k="high-today">-</div><div class="m-val m-prev" data-k="high-prev">-</div></div>'+
      '<div class="m-col"><div class="m-lbl">Düşük</div><div class="m-val" data-k="low-today">-</div><div class="m-val m-prev" data-k="low-prev">-</div></div>'+
      '<div class="m-col"><div class="m-lbl">Hacim</div><div class="m-val" data-k="vol-today">-</div><div class="m-val m-prev" data-k="vol-prev">-</div><div class="vol-ratio" data-k="vol-ratio"></div></div>'+
    '</div>'+
    '<div class="sep"></div>'+
    '<div class="c-meta2">'+
      '<div class="m-col"><div class="m-lbl">52H Yük</div><div class="m-val" data-k="h52-high">-</div></div>'+
      '<div class="m-col"><div class="m-lbl">52H Düş</div><div class="m-val" data-k="h52-low">-</div></div>'+
      '<div class="m-col"><div class="m-lbl">Piy. Değ.</div><div class="m-val" data-k="mcap">-</div></div>'+
      '<div class="m-col"><div class="m-lbl">F/K</div><div class="m-val" data-k="pe">-</div></div>'+
    '</div>'+
    // ── Portföy paneli ──
    '<div id="port-panel-'+sym+'" class="action-panel" style="display:none">'+
      '<div class="sep"></div><div class="panel-title"><i class="ti ti-wallet"></i> Alım Takibi</div>'+
      '<div id="port-pnl-'+sym+'" class="port-pnl"><span class="port-empty">Adet ve ort. maliyet gir → K/Z hesabı otomatik yapılır.</span></div>'+
      '<div class="port-form-row">'+
        '<input type="number" class="ci port-ci" id="port-qty-'+sym+'"  placeholder="Adet"        min="0" step="1"    style="width:90px"/>'+
        '<input type="number" class="ci port-ci" id="port-cost-'+sym+'" placeholder="Ort. Maliyet" min="0" step="0.01" style="flex:1;min-width:100px"/>'+
      '</div>'+
      '<div class="panel-footer"><button class="btn panel-btn" onclick="clearPortfolioEntry(\''+sym+'\')">Temizle</button><button class="btn btn-primary panel-btn" onclick="savePortfolioEntry(\''+sym+'\')">Kaydet</button></div>'+
    '</div>'+
    // ── Hedef fiyat paneli ──
    '<div id="tgt-panel-'+sym+'" class="action-panel" style="display:none">'+
      '<div class="sep"></div><div class="panel-title"><i class="ti ti-target"></i> Hedef Fiyat Alarmı</div>'+
      '<div class="port-form-row">'+
        '<div class="tgt-field"><label class="m-lbl" style="margin-bottom:3px;display:block">Üst Hedef ↑</label><input type="number" class="ci port-ci" id="tgt-upper-'+sym+'" placeholder="Fiyat" min="0" step="0.01" style="width:100%"/></div>'+
        '<div class="tgt-field"><label class="m-lbl" style="margin-bottom:3px;display:block">Alt Limit ↓</label><input type="number" class="ci port-ci" id="tgt-lower-'+sym+'" placeholder="Fiyat" min="0" step="0.01" style="width:100%"/></div>'+
      '</div>'+
      '<div class="panel-footer"><button class="btn panel-btn" onclick="clearTargetEntry(\''+sym+'\')">Temizle</button><button class="btn btn-primary panel-btn" onclick="saveTargetEntry(\''+sym+'\')">Kaydet</button></div>'+
    '</div>'+
    // ── Not & Sektör paneli (UV #11 & #12) ──
    '<div id="note-panel-'+sym+'" class="action-panel" style="display:none">'+
      '<div class="sep"></div><div class="panel-title"><i class="ti ti-pencil"></i> Not &amp; Sektör</div>'+
      '<div class="note-sector-row"><label class="m-lbl" style="margin-bottom:3px;display:block">Sektör</label>'+
        '<input type="text" class="ci port-ci" id="note-sector-'+sym+'" placeholder="örn. Bankacılık, Enerji..." style="width:100%"/></div>'+
      '<div style="margin-top:8px"><label class="m-lbl" style="margin-bottom:3px;display:block">Notlarım</label>'+
        '<textarea class="ci note-ta" id="note-text-'+sym+'" placeholder="Kişisel notlarını buraya yaz..." rows="3"></textarea></div>'+
      '<div class="panel-footer"><button class="btn panel-btn" onclick="clearNote(\''+sym+'\')">Temizle</button><button class="btn btn-primary panel-btn" onclick="saveNote(\''+sym+'\')">Kaydet</button></div>'+
    '</div>';
  return d;
}

function updateCard(s, prevPrice) {
  const d=s.data; if (!d) return;
  const D=dirOf(d.change),arrow=D==='up'?'+':D==='down'?'-':'',sign=d.change>=0?'+':'';
  const card=document.getElementById('card-'+s.symbol); if (!card) return;

  card.className='card '+D;
  if (typeof prevPrice==='number'&&prevPrice!==d.price) {
    const pc=d.price>prevPrice?'pulse-up':'pulse-down';
    card.classList.remove('pulse-up','pulse-down'); void card.offsetWidth;
    card.classList.add(pc); setTimeout(()=>card.classList.remove(pc),1900);
  }

  const priceEl=card.querySelector('.c-price'),badgesEl=card.querySelector('.c-badges');
  const g=k=>card.querySelector('[data-k="'+k+'"]');
  if (priceEl) priceEl.textContent=fmt(d.price,d.currency);

  var rsi=calcRSI(d.closes),rsiCls='rsi-ok',rsiLbl='';
  if (rsi!==null){if(rsi>=70){rsiCls='rsi-ob';rsiLbl=' · AŞ';}else if(rsi<=30){rsiCls='rsi-os';rsiLbl=' · AS';}}
  if (badgesEl) {
    var ct=Math.abs(d.changePct).toFixed(2)+'% ('+sign+d.change.toFixed(2)+')';
    var ds=d.dividendYield>0?'<span class="badge div"><i class="ti ti-coin"></i> '+(d.dividendYield*100).toFixed(2)+'% TEM</span>':'';
    var rs=rsi!==null?'<span class="badge rsi '+rsiCls+'" title="RSI 14 — >70 AŞ / <30 AS">RSI '+rsi+rsiLbl+'</span>':'';
    badgesEl.innerHTML='<span class="badge '+D+'">'+arrow+' '+ct+'</span>'+ds+rs;
  }

  // Son temettü detayı
  var divDetail=card.querySelector('.div-detail');
  if (!divDetail){divDetail=document.createElement('div');divDetail.className='div-detail';var br=card.querySelector('.c-badges');if(br)br.insertAdjacentElement('afterend',divDetail);}
  if (d.lastDividend&&d.lastDividend.amount>0){
    divDetail.style.display='';
    divDetail.innerHTML='<i class="ti ti-calendar-event"></i> Son tem: <strong>'+d.lastDividend.amount.toFixed(4)+' '+(d.currency==='TRY'?'TL':'$')+'</strong> — '+fmtDate(d.lastDividend.date)+(d.lastDividend.count>1?' <span class="div-count">('+d.lastDividend.count+' ödeme/yıl)</span>':'');
  } else divDetail.style.display='none';

  if (g('high-today')) g('high-today').textContent=fmt(d.high,d.currency);
  if (g('low-today'))  g('low-today').textContent=fmt(d.low,d.currency);
  if (g('vol-today'))  g('vol-today').textContent=fmtVol(d.volume);
  var vr=g('vol-ratio');
  if (vr){var ratio=volRatioStr(d.volume,d.avgVolume);vr.textContent=ratio;vr.className='vol-ratio'+(d.avgVolume&&d.volume>d.avgVolume*1.5?' high':'');}
  if (d.yesterday){if(g('high-prev'))g('high-prev').textContent=fmt(d.yesterday.high,d.currency);if(g('low-prev'))g('low-prev').textContent=fmt(d.yesterday.low,d.currency);if(g('vol-prev'))g('vol-prev').textContent=fmtVol(d.yesterday.volume);}
  if (g('h52-high')) g('h52-high').textContent=fmt(d.weekHigh52,d.currency);
  if (g('h52-low'))  g('h52-low').textContent=fmt(d.weekLow52,d.currency);
  if (g('mcap'))     g('mcap').textContent=fmtMcap(d.marketCap,d.currency);
  if (g('pe')){var pv=peStr(d.price,d.eps);g('pe').textContent=pv;g('pe').style.color=pv==='Zarar'?'var(--dn)':'';}

  updatePortfolioPanel(s.symbol,d.price,d.currency);
  renderTargetBadges(s.symbol);
  renderSectorTag(s.symbol);
  renderNoteBadge(s.symbol);

  // ── Mini Mum Grafik ──
  var chartArea = document.getElementById('chart-area-' + s.symbol);
  if (chartArea) renderMiniCandle(chartArea, s.symbol, d);

  // Modal açıksa yenile
  if (_chartModalSym === s.symbol) _renderFullChart(s.symbol, d);
} // ── updateCard sonu ──

function setError(sym, msg) {
  var card=document.getElementById('card-'+sym); if (!card) return;
  card.className='card error';
  var badge=card.querySelector('.badge'),price=card.querySelector('.c-price');
  if (price) price.textContent='-';
  if (badge){badge.textContent='! '+(msg||'Hata')+' - tekrar dene';badge.className='badge error';badge.onclick=()=>retryFetch(sym);}
}

// ── Ekle / Kaldır / Yenile ──
async function addStock(sym, name, exch) {
  if (stocks.find(s=>s.symbol===sym)) return;
  histories[sym]=[];chartRanges[sym]=chartRanges[sym]||'1y';
  var s={symbol:sym,name:name,exchange:exch,data:null};
  stocks.push(s); saveToStorage();
  // Modal sadece gerçekten açıksa kapat (sayfa yüklemede toplu addStock çağrılarında gereksiz scheduleRefresh tetiklenmesin)
  if (document.getElementById('overlay').classList.contains('open')) closeModal();
  renderUI();
  document.getElementById('grid').appendChild(makeSkeletonCard(sym,name,exch));
  if (portfolioData[sym]) updatePortfolioPanel(sym,null,null);
  if (targetData[sym])    renderTargetBadges(sym);
  if (sectorData[sym]!==undefined) renderSectorTag(sym); // kayıtlı sektörü göster
  if (notesData[sym])     renderNoteBadge(sym);
  try {
    s.data=await fetchStockPrice(sym,exch,chartRanges[sym]||'1y');
    updateCard(s,null); updateSummary(); setUpd();
    fetchSector(sym,exch);  // UV #11 — arka planda FMP'den sektör çek
    applySort();             // UV #13 — eklendikten sonra sıralamayı uygula
  } catch(e){setError(sym,e.message.slice(0,30));}
}

async function retryFetch(sym) {
  var s=stocks.find(x=>x.symbol===sym); if (!s) return;
  var b=document.querySelector('#card-'+sym+' .badge');
  if (b){b.textContent='Yeniden deneniyor...';b.className='badge loading';b.onclick=null;}
  try{s.data=await fetchStockPrice(sym,s.exchange,chartRanges[sym]||'1y');updateCard(s,null);updateSummary();setUpd();}
  catch(e){setError(sym,e.message.slice(0,30));}
}

function removeStock(sym) {
  if (charts[sym]) { charts[sym].destroy(); delete charts[sym]; }
  delete histories[sym]; delete chartRanges[sym];
  // notesData, sectorData, portfolioData, targetData kasıtlı korunuyor
  stocks=stocks.filter(s=>s.symbol!==sym); saveToStorage();
  var c=document.getElementById('card-'+sym); if(c)c.remove();
  renderUI();
}

async function refreshAll() {
  if (!stocks.length) return;
  var btn=document.getElementById('ref-btn'),icon=document.getElementById('ref-icon');
  btn.disabled=true; icon.style.animation='spin 1s linear infinite';
  fetchUsdTryRate();
  fetchGoldRate();
  await Promise.all(stocks.map(async s=>{
    var old=s.data?s.data.price:null;
    var b=document.querySelector('#card-'+s.symbol+' .badge');
    if(b){b.textContent='Güncelleniyor...';b.className='badge loading';}
    try{s.data=await fetchStockPrice(s.symbol,s.exchange,chartRanges[s.symbol]||'1y');updateCard(s,old);maybeNotify(s,old);checkTargetAlerts(s,old);}
    catch(e){setError(s.symbol,e.message.slice(0,30));}
  }));
  updateSummary(); setUpd();
  btn.disabled=false; icon.style.animation='';
  applySort(); // Güncel verilerle aktif sıralamayı yeniden uygula
}

// ── UI ──
function renderUI() {
  var has = stocks.length > 0;
  document.getElementById('empty-state').style.display = has ? 'none'        : 'flex';
  document.getElementById('sbar').style.display        = has ? 'grid'        : 'none';
  document.getElementById('live-tag').style.display    = has ? 'flex'        : 'none';
  document.getElementById('ref-btn').style.display     = has ? 'inline-flex' : 'none';

  if (has) {
    ensureUsdTryCard(); ensureGoldCard(); ensureSortBar(); ensureExportBtn();
  } else {
    // Tüm hisseler kaldırılınca yardımcı elemanları gizle
    var sb   = document.getElementById('sort-bar');
    var eb   = document.getElementById('export-btn');
    var kur  = document.getElementById('card-USDTRY');
    var gold = document.getElementById('card-GOLD');
    if (sb)   sb.style.display   = 'none';
    if (eb)   eb.style.display   = 'none';
    if (kur)  kur.style.display  = 'none';
    if (gold) gold.style.display = 'none';
  }

  updateSummary();
}
function updateSummary() {
  var wd=stocks.filter(s=>s.data);
  document.getElementById('sc-t').textContent=stocks.length;
  document.getElementById('sc-u').textContent=wd.filter(s=>s.data.change>=0).length;
  document.getElementById('sc-d').textContent=wd.filter(s=>s.data.change<0).length;
}
function setUpd(){document.getElementById('upd').textContent=new Date().toLocaleTimeString('tr-TR');}

// ── Modal ──
function openModal() {
  document.getElementById('overlay').classList.add('open');
  document.getElementById('search-inp').value=''; document.getElementById('m-sym').value='';
  document.getElementById('m-name').value=''; document.getElementById('cerr').style.display='none';
  showOnlyDiv=false;
  var btn=document.getElementById('div-filter-btn'); if(btn)btn.classList.remove('active');
  filterList(); setTimeout(()=>document.getElementById('search-inp').focus(),60);
}
function closeModal(){document.getElementById('overlay').classList.remove('open');scheduleRefresh();}
function bgClick(e){if(e.target.id==='overlay')closeModal();}
function clearErr(){document.getElementById('cerr').style.display='none';}

function toggleDivFilter(){
  showOnlyDiv=!showOnlyDiv;
  var btn=document.getElementById('div-filter-btn'); if(btn)btn.classList.toggle('active',showOnlyDiv);
  filterList();
}

function filterList() {
  var q=document.getElementById('search-inp').value.toLowerCase().trim();
  var raw=BIST_LIST.map(x=>Object.assign({},x,{x:'BIST'}));
  var filtered=showOnlyDiv?raw.filter(x=>(x.div||0)>0):raw;
  if(q) filtered=filtered.filter(x=>x.s.toLowerCase().includes(q)||x.n.toLowerCase().includes(q));
  var el=document.getElementById('s-list'); el.innerHTML='';
  if (!filtered.length){
    var msg=raw.length===0?'<i class="ti ti-loader" style="animation:spin 1.2s linear infinite;display:inline-block;font-size:20px;margin-bottom:8px"></i><br>Liste yükleniyor...':(showOnlyDiv?'Temettü verisi olan hisse bulunamadı':'Sonuç bulunamadı');
    el.innerHTML='<div style="padding:22px;text-align:center;font-size:12px;color:var(--muted)">'+msg+'</div>'; return;
  }
  filtered.forEach(item=>{
    var added=!!stocks.find(s=>s.symbol===item.s);
    var divBadge=item.div>0?'<span class="s-div">'+(item.div*100).toFixed(1)+'%</span>':'';
    var div=document.createElement('div'); div.className='s-item'+(added?' added':'');
    div.innerHTML='<div><div class="s-sym">'+item.s+' '+divBadge+'</div><div class="s-name">'+item.n+'</div></div>'+
      '<i class="ti ti-'+(added?'check':'plus')+'" style="font-size:15px;color:'+(added?'var(--up)':'var(--muted)')+'"></i>';
    if (!added)(function(i){div.onclick=()=>addStock(i.s,i.n,i.x||'BIST');})(item);
    el.appendChild(div);
  });
}

function addManual() {
  var sym=document.getElementById('m-sym').value.trim().toUpperCase(),name=document.getElementById('m-name').value.trim()||sym,exch=document.getElementById('m-exch').value,err=document.getElementById('cerr');
  if(!sym){err.textContent='Sembol giriniz.';err.style.display='block';return;}
  if(stocks.find(s=>s.symbol===sym)){err.textContent='Bu sembol zaten listede.';err.style.display='block';return;}
  addStock(sym,name,exch);
}

document.getElementById('m-sym').addEventListener('keydown',e=>{if(e.key==='Enter')addManual();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});

// ── Başla ──
loadPortfolio(); loadTargets(); loadNotes(); loadSectors();
updateBellUI(); filterList(); fetchBistList();

var savedStocks=localStorage.getItem('my_tracked_stocks');
if (savedStocks) {
  try { JSON.parse(savedStocks).forEach(item=>addStock(item.symbol,item.name,item.exchange)); }
  catch(e){console.error('Kayıtlı veriler yüklenemedi:',e);}
}

// ── Otomatik yenileme ──
function getMarketOpen() {
  var now=new Date(),trMin=((now.getUTCHours()+3)%24)*60+now.getUTCMinutes(),day=now.getUTCDay(),wd=day>=1&&day<=5;
  return wd&&(trMin>=600&&trMin<1080); // BIST 10:00–18:00 TR
}
var refreshTimer=null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  var isModalOpen=document.getElementById('overlay').classList.contains('open');
  if(isModalOpen||!stocks.length){refreshTimer=setTimeout(scheduleRefresh,5000);return;}
  var interval=getMarketOpen()?30000:300000;
  refreshTimer=setTimeout(async()=>{await refreshAll();scheduleRefresh();},interval);
}
scheduleRefresh();

var fileWarnEl=document.getElementById('file-warn');
if(fileWarnEl)fileWarnEl.style.display='block';
