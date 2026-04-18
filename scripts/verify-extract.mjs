import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizePublishedAt, extractPublishedAt } from '../lib/extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureUrl = (name) =>
  pathToFileURL(resolve(here, '..', 'test', 'fixtures', name)).toString();

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}`);
  if (!pass) {
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
    failures++;
  }
}

function checkPartial(label, actual, expected) {
  const ok = Object.entries(expected).every(
    ([k, v]) => JSON.stringify(actual?.[k]) === JSON.stringify(v),
  );
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}`);
  if (!ok) {
    console.log(`       expected subset: ${JSON.stringify(expected)}`);
    console.log(`       actual:          ${JSON.stringify(actual)}`);
    failures++;
  }
}

function sanitizeTests() {
  console.log('--- sanitizePublishedAt ---');
  check('ISO 正常', sanitizePublishedAt('2020-10-02T12:00:00+09:00'), '2020-10-02T03:00:00.000Z');
  check('null 入力', sanitizePublishedAt(null), null);
  check('空文字', sanitizePublishedAt(''), null);
  check('不正文字列', sanitizePublishedAt('not-a-date'), null);
  check('数字のみ文字列', sanitizePublishedAt('1696204800'), null);
  check('epoch 近辺 (1970)', sanitizePublishedAt('1970-01-02T00:00:00Z'), null);
  check('1999年', sanitizePublishedAt('1999-12-31T23:59:59Z'), null);
  check('2000年境界 OK', sanitizePublishedAt('2000-01-01T00:00:00Z'), '2000-01-01T00:00:00.000Z');
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  check('未来 +3日', sanitizePublishedAt(future), null);
  const tolerable = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  check('未来 +12時間は許容', !!sanitizePublishedAt(tolerable), true);
}

async function fixtureTests(browser) {
  console.log('--- extractPublishedAt (fixtures) ---');
  const cases = [
    { file: 'json-ld.html', via: 'json-ld', publishedAt: '2020-10-02T03:00:00.000Z' },
    { file: 'ogp.html', via: 'ogp', publishedAt: '2022-03-20T01:00:00.000Z' },
    { file: 'microdata.html', via: 'microdata', publishedAt: '2019-05-04T06:00:00.000Z' },
    { file: 'time-tag.html', via: 'time-tag', publishedAt: '2018-11-11T09:30:00.000Z' },
    { file: 'time-tag-text.html', via: 'time-tag', publishedAt: '2020-11-27T09:00:00.000Z' },
    { file: 'dc-date.html', via: 'dc-date', publishedAt: '2021-07-15T00:30:00.000Z' },
    { file: 'empty.html', via: 'none', publishedAt: null },
  ];
  for (const c of cases) {
    const context = await browser.newContext({ timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
    try {
      const page = await context.newPage();
      await page.goto(fixtureUrl(c.file), { waitUntil: 'domcontentloaded' });
      const result = await extractPublishedAt(page);
      checkPartial(`${c.file}`, result, { via: c.via, publishedAt: c.publishedAt });
    } finally {
      await context.close();
    }
  }
}

async function timeoutTest() {
  console.log('--- extractPublishedAt (timeout via mock) ---');
  const mockPage = { evaluate: () => new Promise(() => {}) };
  const start = Date.now();
  const result = await extractPublishedAt(mockPage, 300);
  const elapsed = Date.now() - start;
  checkPartial('timeout returns via:timeout', result, { via: 'timeout', publishedAt: null });
  check('timeout fires near timeoutMs (<800ms)', elapsed < 800, true);
}

async function main() {
  sanitizeTests();
  const browser = await chromium.launch({ headless: true });
  try {
    await fixtureTests(browser);
  } finally {
    await browser.close();
  }
  await timeoutTest();
  console.log(`\n${failures === 0 ? 'all green' : `${failures} failure(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
