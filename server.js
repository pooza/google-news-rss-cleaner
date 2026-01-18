import express from 'express';
import Parser from 'rss-parser';
import RSS from 'rss';
import { chromium } from 'playwright';
import { LRUCache } from 'lru-cache';

const app = express();
const parser = new Parser({
  customFields: { item: ['link', 'guid', 'pubDate', 'isoDate', 'title'] },
});

const urlCache = new LRUCache({
  max: 5000,
  ttl: 1000 * 60 * 60 * 24 * 14, // 14日
});

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

function buildGoogleNewsRssUrl(q) {
  const base = 'https://news.google.com/rss/search';
  const params = new URLSearchParams({
    q,
    hl: 'ja',
    gl: 'JP',
    ceid: 'JP:ja',
  });
  return `${base}?${params.toString()}`;
}

async function resolveFinalUrl(googleNewsUrl) {
  const cached = urlCache.get(googleNewsUrl);
  if (cached) return cached;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
  });

  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  await page.goto(googleNewsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1200);

  let finalUrl = page.url();
  await context.close();

  if (!finalUrl || finalUrl.includes('news.google.com/articles/')) {
    // 1回だけ追加待ちでリトライ
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(googleNewsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page2.waitForTimeout(2500);
    finalUrl = page2.url();
    await context2.close();
  }

  // 失敗したら壊さない：元URLを返す
  if (!finalUrl || finalUrl.includes('news.google.com/articles/')) return googleNewsUrl;

  urlCache.set(googleNewsUrl, finalUrl);
  return finalUrl;
}

app.get('/clean', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : null;

  const feedUrl = buildGoogleNewsRssUrl(q);
  if (!feedUrl) {
    res.status(400).send('missing q');
    return;
  }

  let feed;
  try {
    feed = await parser.parseURL(feedUrl);
  } catch (e) {
    res.status(502).send(`failed to fetch/parse feed: ${e?.message ?? e}`);
    return;
  }

  const out = new RSS({
    title: feed.title ?? (q ? `Google News: ${q}` : 'Cleaned Feed'),
    description: feed.description ?? '',
    site_url: feed.link ?? undefined,
    language: 'ja',
  });

  const limit = 30;
  const items = (feed.items ?? []).slice(0, limit);

  // 並列は控えめに
  const concurrency = 3;
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      const googleNewsLink = item.link;
      if (!googleNewsLink) continue;

      const finalUrl = await resolveFinalUrl(googleNewsLink);

      const pubDate = item.isoDate ?? item.pubDate ?? undefined;

      out.item({
        title: item.title ?? finalUrl,
        url: finalUrl,          // <link> を最終URLへ
        guid: googleNewsLink,   // guid は元URL（保険）
        date: pubDate ? new Date(pubDate) : undefined,
        description: '',
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const xml = out.xml({ indent: true });
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

app.listen(3000, '0.0.0.0', () => console.log('listening on 0.0.0.0:3000'));
