// Market Trend Dashboard — Alpaca Market Data API
// - S&P 500 list from Wikipedia + GLD (gold) + SLV (silver)
// - Historical daily bars from Alpaca /v2/stocks/{symbol}/bars

const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.error('Set ALPACA_API_KEY and ALPACA_SECRET_KEY env vars');
  process.exit(1);
}

const ALPACA_DATA = 'https://data.alpaca.markets';
const EXTRAS = ['GLD', 'SLV']; // Gold & Silver ETFs

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sma(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function alpacaHeaders() {
  return { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET };
}

// Scrape S&P 500 tickers from Wikipedia
async function fetchSP500() {
  console.log('Fetching S&P 500 list from Wikipedia...');
  const url = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';
  const r = await fetch(url);
  const html = await r.text();

  // Parse the first table — each row has ticker in the first <td>
  const tableMatch = html.match(/<table[^>]*id="constituents"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableMatch) throw new Error('Could not find S&P 500 table on Wikipedia');

  const tickers = [];
  const rowRegex = /<tr[\s\S]*?<\/tr>/g;
  let match;
  while ((match = rowRegex.exec(tableMatch[1])) !== null) {
    const row = match[0];
    // Skip header rows
    if (row.includes('<th')) continue;
    // First <td> contains the ticker inside an <a> tag or as text
    const tdMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/);
    if (!tdMatch) continue;
    const cellHtml = tdMatch[1];
    // Extract text, stripping HTML tags
    const ticker = cellHtml.replace(/<[^>]+>/g, '').trim();
    if (ticker && /^[A-Z.]+$/.test(ticker)) {
      tickers.push(ticker);
    }
  }

  console.log(`  Found ${tickers.length} S&P 500 tickers`);
  return tickers;
}

// Fetch daily bars from Alpaca
async function fetchDaily(symbol, limit = 55) {
  // Request enough bars (limit param = number of bars)
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - (limit + 30) * 86400000).toISOString().split('T')[0];
  const url = `${ALPACA_DATA}/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&adjustment=split&feed=iex`;

  const r = await fetch(url, { headers: alpacaHeaders() });
  if (!r.ok) {
    if (r.status === 429) return 'rate_limited';
    throw new Error(`HTTP ${r.status}`);
  }
  const json = await r.json();
  const bars = json.bars;
  if (!bars || bars.length < 2) return null;
  return bars.filter(b => b.c > 0); // c = close
}

function computeTrendAndGap(bars) {
  if (!bars || bars.length < 2) return { trend: null, gapPct: null };
  const closes = bars.map(b => b.c);
  const current = closes[closes.length - 1];
  if (current === 0) return { trend: null, gapPct: null };
  const prior = closes.length > 50 ? closes.slice(-51, -1) : closes.slice(0, -1);
  const avg = sma(prior);
  if (avg === 0) return { trend: null, gapPct: null };
  const gapPct = ((current - avg) / avg) * 100;
  return { trend: current >= avg, gapPct: Math.round(gapPct * 100) / 100 };
}

async function main() {
  const sp500 = await fetchSP500();

  // Build full ticker list: extras first, then S&P 500 (deduped)
  const seen = new Set();
  const allTickers = [];
  for (const t of [...EXTRAS, ...sp500]) {
    const normalized = t.replace('.', '/'); // Alpaca uses BRK/B not BRK.B
    if (!seen.has(normalized)) {
      seen.add(normalized);
      allTickers.push({ symbol: normalized, displaySymbol: t });
    }
  }

  console.log(`\nTotal tickers: ${allTickers.length}\n`);

  // Fetch SPY first as the benchmark (like BTC in crypto dashboard)
  console.log('Fetching SPY (benchmark)...');
  let spyBars;
  try { spyBars = await fetchDaily('SPY'); } catch (e) {
    console.error('FATAL: Could not fetch SPY:', e.message);
    process.exit(1);
  }

  const spyCloses = spyBars.map(b => b.c);
  const spyPrice = spyCloses[spyCloses.length - 1];
  const spyResult = computeTrendAndGap(spyBars);
  console.log(`  SPY: $${spyPrice.toFixed(2)} | Gap: ${spyResult.gapPct > 0 ? '+' : ''}${spyResult.gapPct}%\n`);

  const results = [];
  let skipped = 0;
  let errors = 0;
  let rateLimited = 0;

  for (let i = 0; i < allTickers.length; i++) {
    const { symbol, displaySymbol } = allTickers[i];
    process.stdout.write(`\r[${i + 1}/${allTickers.length}] ${displaySymbol}...          `);

    // Alpaca free tier: 200 req/min — pace at ~350ms
    await sleep(350);

    let bars = null;
    try {
      bars = await fetchDaily(symbol);
      if (bars === 'rate_limited') {
        rateLimited++;
        console.warn(`\n  Rate limited on ${displaySymbol}, waiting 60s...`);
        await sleep(60000);
        bars = await fetchDaily(symbol);
        if (bars === 'rate_limited') bars = null;
      }
    } catch {
      errors++;
      continue;
    }

    const usdResult = computeTrendAndGap(bars);
    let price = null;
    if (bars && bars.length >= 1) {
      price = bars[bars.length - 1].c;
    }

    // Compute vs SPY ratio (like vs BTC in crypto dashboard)
    let spyTrend = null;
    let spyGapPct = null;
    if (bars && bars.length >= 2) {
      const closes = bars.map(b => b.c);
      const minLen = Math.min(closes.length, spyCloses.length);
      if (minLen >= 2) {
        const ratios = [];
        for (let j = 0; j < minLen; j++) {
          const ci = closes.length - minLen + j;
          const si = spyCloses.length - minLen + j;
          if (spyCloses[si] > 0 && closes[ci] > 0) {
            ratios.push(closes[ci] / spyCloses[si]);
          }
        }
        if (ratios.length >= 2) {
          const current = ratios[ratios.length - 1];
          const prior = ratios.length > 50 ? ratios.slice(-51, -1) : ratios.slice(0, -1);
          const avg = sma(prior);
          spyTrend = current >= avg;
          spyGapPct = avg > 0 ? Math.round(((current - avg) / avg) * 10000) / 100 : null;
        }
      }
    }

    if (price === null && usdResult.trend === null && spyTrend === null) {
      skipped++;
      continue;
    }

    // Determine category
    let category = 'stock';
    if (displaySymbol === 'GLD') category = 'gold';
    else if (displaySymbol === 'SLV') category = 'silver';

    results.push({
      symbol: displaySymbol,
      category,
      price,
      usdTrend: usdResult.trend,
      usdGapPct: usdResult.gapPct,
      spyTrend,
      spyGapPct,
    });
  }

  console.log(`\n\nDone. ${results.length} assets with data, ${skipped} skipped, ${errors} errors, ${rateLimited} rate limits hit.`);

  const output = { updated: new Date().toISOString(), benchmark: 'SPY', assets: results };
  const { writeFileSync } = await import('fs');
  writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log('Wrote data.json');
}

main().catch(e => { console.error(e); process.exit(1); });
