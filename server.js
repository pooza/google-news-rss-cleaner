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

function isGoogleNewsUrl(url) {
  try {
    return new URL(url).hostname.endsWith('news.google.com');
  } catch {
    return false;
  }
}

async function resolveFinalUrl(googleNewsUrl) {
  const cached = urlCache.get(googleNewsUrl);
  if (cached) return cached;

  const browser = await getBrowser();

  async function tryResolve(timeout) {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
    });

    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });

    try {
      const page = await context.newPage();
      await page.goto(googleNewsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // news.google.com 以外のURLへ遷移するのを待つ
      try {
        await page.waitForURL((url) => !url.toString().includes('news.google.com'), {
          timeout,
        });
      } catch {
        // タイムアウトしても現在のURLを試す
      }

      return page.url();
    } finally {
      await context.close();
    }
  }

  // 1回目: 5秒待ち
  let finalUrl = await tryResolve(5000);

  // まだ news.google.com なら、リトライ（8秒待ち）
  if (!finalUrl || isGoogleNewsUrl(finalUrl)) {
    finalUrl = await tryResolve(8000);
  }

  // 失敗したら壊さない：元URLを返す
  if (!finalUrl || isGoogleNewsUrl(finalUrl)) return googleNewsUrl;

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
        url: finalUrl, // <link> を最終URLへ
        guid: googleNewsLink, // guid は元URL（保険）
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
