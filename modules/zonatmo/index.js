"use strict";

(() => {
  const BASE_URL = "https://zonatmo.org";
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const ALLOWED_HOSTS = new Set(["zonatmo.org", "storage.zonatmo.org", "storage2.zonatmo.org"]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    Referer: `${BASE_URL}/`,
  };

  function text(value) {
    return String(value ?? "").trim();
  }

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return text(value)
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripHTML(value) {
    return decodeEntities(String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function attribute(tag, name) {
    const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : "";
  }

  function normalizePage(value) {
    const page = Number(value);
    return Number.isSafeInteger(page) && page >= 1 && page <= 1000 ? page : 1;
  }

  function isAllowedURL(value, paths) {
    try {
      const url = new URL(text(value));
      return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname.toLowerCase()) && paths.some((path) => path.test(url.pathname));
    } catch {
      return false;
    }
  }

  function assertSourceURL(value, paths, label) {
    if (!isAllowedURL(value, paths)) throw new Error(`Invalid TuMangaOnline ${label}.`);
    return new URL(text(value)).href;
  }

  function looksBlocked(html) {
    const head = String(html || "").slice(0, 5000);
    return /cf-chl-|cloudflare.*challenge|captcha|access denied|inicia\s+sesi[oó]n.*continuar/i.test(head)
      || /<title>\s*(?:error|forbidden|just a moment)/i.test(head);
  }

  async function responseText(response) {
    if (!response) return "";
    if (response.bodyDropped || Number(response.bodyBytes || 0) > MAX_RESPONSE_BYTES) {
      throw new Error("TuMangaOnline response exceeded the byte limit.");
    }
    if (typeof response.body === "string") return response.body;
    if (typeof response.text === "function") return String(await response.text());
    return "";
  }

  async function requestHTML(url) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("TuMangaOnline requires the fetchv2 bridge.");
    const requested = assertSourceURL(url, [/^\/$/, /^\/biblioteca\/?$/, /^\/library\/(?:manga|manhwa|manhua|webtoon|novel|comic|one_shot|doujinshi|oel)\/\d+\/[a-z0-9-]+\/?$/i, /^\/view_uploads\/\d+\/?$/], "request URL");
    const response = await globalThis.fetchv2(requested, DEFAULT_HEADERS, "GET", null, {
      followRedirects: true,
      maxBytesHint: MAX_RESPONSE_BYTES,
      responseClass: "html",
    });
    const status = Number(response?.status || 0);
    if (!response || response.ok === false || status < 200 || status >= 300) {
      throw new Error(`TuMangaOnline request failed with HTTP ${status || "error"}.`);
    }
    const finalRaw = text(response.finalUrl || response.finalURL);
    if (finalRaw && !/^https:\/\/fixture\.invalid\//i.test(finalRaw)) {
      const finalURL = new URL(finalRaw);
      if (finalURL.protocol !== "https:" || finalURL.hostname !== "zonatmo.org") {
        throw new Error("TuMangaOnline redirected outside its declared source host.");
      }
    }
    const html = await responseText(response);
    if (!html.trim()) throw new Error("TuMangaOnline returned an empty response.");
    if (looksBlocked(html)) throw new Error("TuMangaOnline returned a challenge, login, or error page.");
    if (!/<(?:html|div|main|meta|img|a)\b/i.test(html)) throw new Error("TuMangaOnline returned malformed HTML.");
    return html;
  }

  function seriesURL(value) {
    const raw = text(value);
    if (/^\d+$/.test(raw)) throw new Error("TuMangaOnline numeric IDs require the source-owned series URL.");
    return assertSourceURL(raw, [/^\/library\/(?:manga|manhwa|manhua|webtoon|novel|comic|one_shot|doujinshi|oel)\/\d+\/[a-z0-9-]+\/?$/i], "series identifier");
  }

  function chapterURL(value) {
    return assertSourceURL(value, [/^\/view_uploads\/\d+\/?$/], "chapter identifier");
  }

  function safeAssetURL(value) {
    return isAllowedURL(value, [/^\/storage\//, /^\/(?:covers|proxy|chapters)\//]) ? new URL(text(value)).href : "";
  }

  function cardBlocks(html) {
    const blocks = [];
    const re = /<div\b[^>]*class=["'][^"']*\belement\b[^"']*["'][^>]*data-identifier=["']\d+["'][^>]*>[\s\S]*?<\/a>\s*<\/div>/gi;
    let match;
    while ((match = re.exec(html)) !== null) blocks.push(match[0]);
    return blocks;
  }

  function parseListing(html) {
    const items = [];
    const seen = new Set();
    for (const block of cardBlocks(html)) {
      if (/book-meta-mature|contenido para mayores de 18|>\s*\+18\s*</i.test(block)) continue;
      const anchor = block.match(/<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>/i);
      const heading = block.match(/<h4\b[^>]*title=(?:"([^"]+)"|'([^']+)')[^>]*>/i);
      const image = block.match(/<img\b[^>]*class=["'][^"']*cover-bg-img[^"']*["'][^>]*>/i);
      const href = decodeEntities(anchor?.[1] ?? anchor?.[2] ?? "");
      const title = decodeEntities(heading?.[1] ?? heading?.[2] ?? "");
      if (!title || !isAllowedURL(href, [/^\/library\/(?:manga|manhwa|manhua|webtoon|novel|comic|one_shot|doujinshi|oel)\/\d+\/[a-z0-9-]+\/?$/i])) continue;
      const canonical = new URL(href).href;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      items.push({ id: canonical, href: canonical, url: canonical, title, image: safeAssetURL(attribute(image?.[0], "src")) });
    }
    const hasMore = /<a\b[^>]*rel=["']next["'][^>]*>/i.test(html);
    return { items, hasMore };
  }

  function searchParameters(query, page, overrides = {}) {
    const objectQuery = query && typeof query === "object" ? query : null;
    const includeTags = objectQuery?.tags || objectQuery?.includeTags || [];
    const excludeTags = objectQuery?.excludeTags || objectQuery?.excludedTags || [];
    if ((Array.isArray(includeTags) && includeTags.length) || (Array.isArray(excludeTags) && excludeTags.length)) {
      throw new Error("TuMangaOnline tag filters require source genre IDs and are not exposed by this module.");
    }
    const params = new URLSearchParams({
      title: text(objectQuery ? objectQuery.text || objectQuery.query : query),
      filter_by: "title",
      order_item: overrides.orderItem || "likes_count",
      order_dir: "desc",
      _pg: "1",
      page: String(normalizePage(page)),
    });
    const allowedTypes = new Set(["manga", "manhwa", "manhua", "webtoon", "novel", "comic", "one_shot", "doujinshi", "oel"]);
    const type = text(objectQuery?.type).toLowerCase();
    if (type && !allowedTypes.has(type)) throw new Error(`Unsupported TuMangaOnline type filter: ${type}.`);
    if (type) params.set("type", type);
    const statusAliases = { ongoing: "ongoing", completed: "completed", ended: "ended", hiatus: "hiatus", cancelled: "cancelled" };
    const status = text(objectQuery?.status).toLowerCase();
    if (status && !statusAliases[status]) throw new Error(`Unsupported TuMangaOnline status filter: ${status}.`);
    if (status) params.set("status", statusAliases[status]);
    const demography = text(objectQuery?.demography).toLowerCase();
    if (demography && !["seinen", "shoujo", "shounen", "josei", "kodomo"].includes(demography)) {
      throw new Error(`Unsupported TuMangaOnline demography filter: ${demography}.`);
    }
    if (demography) params.set("demography", demography);
    return params;
  }

  async function listing(query, page, overrides) {
    const params = searchParameters(query, page, overrides);
    return parseListing(await requestHTML(`${BASE_URL}/biblioteca?${params}`));
  }

  async function searchResults(query, page = 1) {
    const raw = text(typeof query === "object" ? query.text || query.query : query);
    if (raw === "__feed:popular") return discoveryFeed("popular", page);
    if (raw === "__feed:latest") return discoveryFeed("latest", page);
    return listing(query, page);
  }

  function metaContent(html, property) {
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
      if (attribute(tag, "property") === property || attribute(tag, "name") === property) return attribute(tag, "content");
    }
    return "";
  }

  function normalizedStatus(value) {
    const status = text(value).toLowerCase();
    if (/public|emisi|ongoing/.test(status)) return "Ongoing";
    if (/complet/.test(status)) return "Completed";
    if (/finaliz|ended/.test(status)) return "Completed";
    if (/pausa|hiatus/.test(status)) return "Hiatus";
    if (/cancel/.test(status)) return "Cancelled";
    return "Unknown";
  }

  function parseDetails(html, href) {
    if (/<span\b[^>]*class=["'][^"']*\bbook-meta-mature\b[^"']*["'][^>]*>|badge[^>]*>\s*\+18/i.test(html)) {
      throw new Error("TuMangaOnline does not expose adult-only entries.");
    }
    const h1 = html.match(/<h1\b[^>]*class=["'][^"']*element-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    const title = stripHTML(h1?.[1] || metaContent(html, "og:title"))
      .replace(/^Ver\s+/i, "")
      .replace(/\s+Online Gratis.*$/i, "")
      .replace(/\s*\(\d{4}\)\s*$/, "")
      .trim();
    if (!title) throw new Error("TuMangaOnline details did not contain a title.");
    const synopsis = html.match(/<p\b[^>]*id=["']manga-synopsis["'][^>]*>([\s\S]*?)<\/p>/i);
    const statusBlock = html.match(/<span\b[^>]*class=["'][^"']*book-status[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const genres = [];
    const genreRe = /<a\b[^>]*href=["'][^"']*\/tag\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = genreRe.exec(html)) !== null) {
      const genre = stripHTML(match[1]);
      if (genre && !genres.includes(genre)) genres.push(genre);
    }
    const authors = [];
    const authorRe = /<a\b[^>]*href=["'][^"']*biblioteca\?filter_by=author[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = authorRe.exec(html)) !== null) {
      const author = stripHTML(match[1]);
      if (author && !authors.includes(author)) authors.push(author);
    }
    return {
      id: href,
      href,
      url: href,
      title,
      description: stripHTML(synopsis?.[1] || metaContent(html, "description")),
      image: safeAssetURL(metaContent(html, "og:image")),
      authors,
      author: authors.join(", "),
      genres,
      status: normalizedStatus(stripHTML(statusBlock?.[1] || "")),
    };
  }

  async function extractDetails(itemID) {
    const href = seriesURL(itemID);
    return parseDetails(await requestHTML(href), href);
  }

  async function extractChapters(itemID) {
    const href = seriesURL(itemID);
    const html = await requestHTML(href);
    if (/<span\b[^>]*class=["'][^"']*\bbook-meta-mature\b[^"']*["'][^>]*>|badge[^>]*>\s*\+18/i.test(html)) {
      throw new Error("TuMangaOnline does not expose adult-only entries.");
    }
    const chapters = [];
    const seen = new Set();
    const liRe = /<li\b[^>]*class=["'][^"']*upload-link[^"']*["'][^>]*data-chapter-number=["']([^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe.exec(html)) !== null) {
      const number = Number.parseFloat(li[1].replace(",", "."));
      if (!Number.isFinite(number)) throw new Error("TuMangaOnline returned a malformed chapter number.");
      const dateMatch = li[2].match(/<i\b[^>]*class=["'][^"']*fa-calendar[^"']*["'][^>]*><\/i>\s*([^<]+)/i);
      const uploadRe = /<a\b[^>]*href=["'](https:\/\/zonatmo\.org\/view_uploads\/(\d+))["'][^>]*>[\s\S]*?Leer online[\s\S]*?<\/a>/gi;
      let upload;
      while ((upload = uploadRe.exec(li[2])) !== null) {
        const chapterHref = chapterURL(upload[1]);
        if (seen.has(chapterHref)) continue;
        seen.add(chapterHref);
        chapters.push({
          id: chapterHref,
          href: chapterHref,
          url: chapterHref,
          title: `Capítulo ${li[1]}`,
          number,
          releaseDate: text(dateMatch?.[1]),
          language: "es",
        });
      }
    }
    if (!chapters.length) throw new Error("TuMangaOnline returned no readable chapters for this series.");
    chapters.sort((left, right) => right.number - left.number || right.id.localeCompare(left.id));
    return chapters;
  }

  async function extractImages(chapterID) {
    const href = chapterURL(chapterID);
    const html = await requestHTML(href);
    const images = [];
    const seen = new Set();
    const re = /<img\b[^>]*class=["'][^"']*reader-image[^"']*["'][^>]*>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
      const url = safeAssetURL(attribute(match[0], "src"));
      if (!url) throw new Error("TuMangaOnline returned an invalid or undeclared reader image URL.");
      if (seen.has(url)) continue;
      seen.add(url);
      images.push({ url, headers: IMAGE_HEADERS });
    }
    if (!images.length) throw new Error("TuMangaOnline chapter returned no readable page images.");
    return images;
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = text(feedID).toLowerCase();
    if (feed === "popular") return listing("", page, { orderItem: "likes_count" });
    if (feed === "latest") return listing("", page, { orderItem: "release_date" });
    throw new Error(`Unknown TuMangaOnline discovery feed: ${feed}.`);
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([discoveryFeed("popular", 1), discoveryFeed("latest", 1)]);
    if (!popular.items.length || !latest.items.length) throw new Error("TuMangaOnline discovery returned an empty section.");
    return { sections: [
      { id: "popular", title: "Más populares", items: popular.items },
      { id: "latest", title: "Novedades", items: latest.items },
    ] };
  }

  const handlers = { discoveryHome, discoveryFeed, searchResults, extractDetails, extractChapters, extractImages };
  Object.assign(globalThis, handlers);
  globalThis.SynthetiqModule = handlers;
})();
