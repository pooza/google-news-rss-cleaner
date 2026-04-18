export function sanitizePublishedAt(raw) {
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  const now = Date.now();
  if (d.getTime() > now + 24 * 60 * 60 * 1000) return null;
  if (d.getTime() < Date.UTC(2000, 0, 1)) return null;
  return d.toISOString();
}

export async function extractPublishedAt(page, timeoutMs = 2000) {
  try {
    const hit = await Promise.race([
      page.evaluate(() => {
        function findDatePublished(node) {
          if (!node || typeof node !== 'object') return null;
          if (typeof node.datePublished === 'string') return node.datePublished;
          if (Array.isArray(node['@graph'])) {
            for (const g of node['@graph']) {
              const r = findDatePublished(g);
              if (r) return r;
            }
          }
          return null;
        }

        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const data = JSON.parse(script.textContent);
            const candidates = Array.isArray(data) ? data : [data];
            for (const node of candidates) {
              const r = findDatePublished(node);
              if (r) return { raw: r, via: 'json-ld' };
            }
          } catch {
            /* malformed JSON-LD, skip */
          }
        }

        const ogp = document.querySelector('meta[property="article:published_time"]');
        if (ogp && ogp.content) return { raw: ogp.content, via: 'ogp' };

        const micro = document.querySelector('[itemprop="datePublished"]');
        if (micro) {
          const v =
            micro.getAttribute('content') ||
            micro.getAttribute('datetime') ||
            (micro.textContent && micro.textContent.trim());
          if (v) return { raw: v, via: 'microdata' };
        }

        const timeEl = document.querySelector('article time[datetime], time[datetime]');
        if (timeEl) {
          const v = timeEl.getAttribute('datetime');
          if (v) return { raw: v, via: 'time-tag' };
        }

        for (const name of ['DC.date.issued', 'dcterms.issued', 'pubdate', 'date']) {
          const meta = document.querySelector(`meta[name="${name}" i]`);
          if (meta && meta.content) return { raw: meta.content, via: 'dc-date' };
        }

        return null;
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('extract-timeout')), timeoutMs),
      ),
    ]);
    if (!hit) return { publishedAt: null, via: 'none' };
    const sanitized = sanitizePublishedAt(hit.raw);
    return sanitized
      ? { publishedAt: sanitized, via: hit.via }
      : { publishedAt: null, via: 'none' };
  } catch {
    return { publishedAt: null, via: 'timeout' };
  }
}
