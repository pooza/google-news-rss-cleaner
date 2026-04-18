import express from 'express';
import Parser from 'rss-parser';
import RSS from 'rss';
import { chromium } from 'playwright';
import { LRUCache } from 'lru-cache';
import syslog from 'modern-syslog';
import { extractPublishedAt } from './lib/extract.js';

syslog.open('google-news-rss-cleaner', syslog.LOG_PID, syslog.LOG_DAEMON);

function logInfo(fields) {
  syslog.log(syslog.LOG_INFO, JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

function logError(fields) {
  syslog.log(syslog.LOG_ERR, JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

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

async function resolveArticle(googleNewsUrl) {
  const start = Date.now();

  const cached = urlCache.get(googleNewsUrl);
  if (cached && typeof cached === 'object') {
    const via = cached.publishedAt ? 'cache' : 'none';
    logInfo({
      event: 'resolve',
      cached: true,
      googleNewsUrl,
      finalUrl: cached.finalUrl,
      publishedAt: cached.publishedAt,
      via,
      durationMs: Date.now() - start,
    });
    return { finalUrl: cached.finalUrl, publishedAt: cached.publishedAt, via };
  }

  const browser = await getBrowser();

  async function tryOnce(timeoutMs) {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
      timezoneId: 'Asia/Tokyo',
      locale: 'ja-JP',
    });
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });
    try {
      const page = await context.newPage();
      await page.goto(googleNewsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      try {
        await page.waitForURL((url) => !url.toString().includes('news.google.com'), {
          timeout: timeoutMs,
        });
      } catch {
        /* keep current URL */
      }
      const finalUrl = page.url();
      if (!finalUrl || isGoogleNewsUrl(finalUrl)) {
        return { finalUrl: null, publishedAt: null, via: 'none' };
      }
      const { publishedAt, via } = await extractPublishedAt(page);
      return { finalUrl, publishedAt, via };
    } finally {
      await context.close();
    }
  }

  let result;
  try {
    result = await tryOnce(5000);
    if (!result.finalUrl) result = await tryOnce(8000);
  } catch (e) {
    logError({
      event: 'resolve-error',
      googleNewsUrl,
      message: e?.message ?? String(e),
      durationMs: Date.now() - start,
    });
    return { finalUrl: null, publishedAt: null, via: 'error' };
  }

  if (!result.finalUrl) {
    logInfo({
      event: 'resolve',
      cached: false,
      googleNewsUrl,
      finalUrl: null,
      publishedAt: null,
      via: 'none',
      durationMs: Date.now() - start,
    });
    return { finalUrl: null, publishedAt: null, via: 'none' };
  }

  if (result.via !== 'timeout') {
    urlCache.set(googleNewsUrl, {
      finalUrl: result.finalUrl,
      publishedAt: result.publishedAt,
    });
  }

  logInfo({
    event: 'resolve',
    cached: false,
    googleNewsUrl,
    finalUrl: result.finalUrl,
    publishedAt: result.publishedAt,
    via: result.via,
    durationMs: Date.now() - start,
  });

  return { finalUrl: result.finalUrl, publishedAt: result.publishedAt, via: result.via };
}

app.get('/clean', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : null;

  if (!q) {
    res.status(400).send('missing q');
    return;
  }

  const feedUrl = buildGoogleNewsRssUrl(q);

  let feed;
  try {
    feed = await parser.parseURL(feedUrl);
  } catch (e) {
    logError({ event: 'feed-parse-error', q, message: e?.message ?? String(e) });
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

  const concurrency = 3;
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      const googleNewsLink = item.link;
      if (!googleNewsLink) continue;

      const { finalUrl, publishedAt, via } = await resolveArticle(googleNewsLink);
      if (!publishedAt) {
        logInfo({
          event: 'drop',
          googleNewsUrl: googleNewsLink,
          finalUrl,
          title: item.title,
          via,
        });
        continue;
      }

      out.item({
        title: item.title ?? finalUrl,
        url: finalUrl,
        guid: googleNewsLink,
        date: new Date(publishedAt),
        description: '',
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const xml = out.xml({ indent: true });
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

app.listen(3000, '0.0.0.0', () => logInfo({ event: 'listen', host: '0.0.0.0', port: 3000 }));
