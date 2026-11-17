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

// フィード本体のキャッシュ（q ごと）。同じ q を短い間隔で何度呼ばれても、
// 上流（Google News）へ取りに行くのは FEED_TTL_MS に 1 回にする。
const FEED_TTL_MS = 1000 * 60 * 10; // 10分
const feedCache = new LRUCache({ max: 200, ttl: FEED_TTL_MS });

// 最後に取れたフィード（q ごと）。上流に制限されている間はこれを返す。
// 古さに上限を付け、それを超えたら失敗を返す（死活監視が本当の障害に気づけるように）。
const STALE_MAX_MS = 1000 * 60 * 60 * 6; // 6時間
const lastGoodCache = new LRUCache({ max: 200, ttl: STALE_MAX_MS });

// 上流に 429 / 503 を返されたら、しばらく上流へ取りに行かない。
// 制限は送信元単位なので、q ごとではなくプロセス全体で持つ。
// 429 は断続的に出ることがあるので、既定は短めにする。
const DEFAULT_COOLDOWN_MS = 1000 * 60 * 5; // 5分
const MAX_COOLDOWN_MS = 1000 * 60 * 60; // 1時間
let cooldownUntil = 0;

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

function staleOrThrow(q, error) {
  const stale = lastGoodCache.get(q);
  if (!stale) throw error;
  const ageSec = Math.round((Date.now() - stale.fetchedAt) / 1000);
  logInfo({ event: 'feed-stale', q, ageSec, reason: error.message });
  return { feed: stale.feed, staleAgeSec: ageSec };
}

async function fetchFeed(q) {
  const cached = feedCache.get(q);
  if (cached) return { feed: cached };

  if (Date.now() < cooldownUntil) {
    return staleOrThrow(
      q,
      new UpstreamError(`upstream cooldown until ${new Date(cooldownUntil).toISOString()}`, 503),
    );
  }

  const res = await fetch(buildGoogleNewsRssUrl(q), {
    headers: {
      'User-Agent': 'google-news-rss-cleaner',
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 429 || res.status === 503) {
    const wait = Math.min(
      parseRetryAfter(res.headers.get('retry-after')) ?? DEFAULT_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
    );
    cooldownUntil = Date.now() + wait;
    logError({
      event: 'feed-rate-limited',
      q,
      status: res.status,
      cooldownSec: Math.round(wait / 1000),
    });
    return staleOrThrow(q, new UpstreamError(`Status code ${res.status}`, 503));
  }
  if (!res.ok) throw new UpstreamError(`Status code ${res.status}`, 502);

  const feed = await parser.parseString(await res.text());
  feedCache.set(q, feed);
  lastGoodCache.set(q, { feed, fetchedAt: Date.now() });
  return { feed };
}

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

  let feed;
  try {
    const result = await fetchFeed(q);
    feed = result.feed;
    if (result.staleAgeSec !== undefined) {
      res.setHeader('X-Feed-Stale-Age', String(result.staleAgeSec));
    }
  } catch (e) {
    const status = e instanceof UpstreamError ? e.status : 502;
    logError({ event: 'feed-parse-error', q, status, message: e?.message ?? String(e) });
    if (status === 503 && cooldownUntil > Date.now()) {
      res.setHeader('Retry-After', String(Math.ceil((cooldownUntil - Date.now()) / 1000)));
    }
    res.status(status).send(`failed to fetch/parse feed: ${e?.message ?? e}`);
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
