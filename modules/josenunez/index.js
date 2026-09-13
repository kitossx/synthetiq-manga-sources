"use strict";

(() => {
  const BASE_URL = "https://mangalovers.josenunez.cl";
  const API_URL = `${BASE_URL}/api`;
  const SEARCH_PAGE_SIZE = 20;
  const DISCOVERY_PAGE_SIZE = 16;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_ATTEMPTS = 2;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const ALLOWED_ASSET_HOSTS = new Set([
    "mangalovers.josenunez.cl",
    "imagizer.imageshack.com",
    "images.leermangaesp.net",
  ]);
  const EXPLICIT_GENRES = new Set([
    "adult",
    "bdsm",
    "erotica",
    "hentai",
    "rape",
    "smut",
  ]);
  const DEFAULT_EXCLUDED_GENRES = [...EXPLICIT_GENRES].sort();
  const DEFAULT_HEADERS = {
    Accept: "application/json",
    Referer: `${BASE_URL}/`,
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    Referer: `${BASE_URL}/`,
  };

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function text(value) {
    return String(value ?? "").trim();
  }

  function normalizedPage(value) {
    const page = Number(value);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) return 1;
    return page;
  }

  function normalizedGenre(value) {
    return text(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(values) ? values : []) {
      const clean = text(value);
      const key = normalizedGenre(clean);
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
    return out;
  }

  function assertNonExplicitGenres(genres) {
    const blocked = uniqueStrings(genres).find((genre) => EXPLICIT_GENRES.has(normalizedGenre(genre)));
    if (blocked) throw new Error(`MangaLoversEsp does not expose adult-only genre: ${blocked}.`);
  }

  function isAllowedAssetURL(value) {
    try {
      const url = new URL(text(value));
      return url.protocol === "https:" && ALLOWED_ASSET_HOSTS.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function safeAssetURL(...candidates) {
    for (const candidate of candidates) {
      if (isAllowedAssetURL(candidate)) return text(candidate);
    }
    return "";
  }

  function assertFinalURL(response, requestedURL) {
    const raw = text(response?.finalUrl || response?.finalURL);
    if (!raw) return;
    let finalURL;
    try {
      finalURL = new URL(raw);
    } catch {
      throw new Error("MangaLoversEsp returned an invalid final URL.");
    }
    // The repository fixture bridge uses this reserved host for local samples.
    if (finalURL.hostname === "fixture.invalid") return;
    const requested = new URL(requestedURL);
    if (finalURL.protocol !== "https:" || finalURL.hostname !== requested.hostname) {
      throw new Error("MangaLoversEsp redirected outside its declared API host.");
    }
  }

  async function responseText(response) {
    if (!response) return "";
    if (response.bodyDropped) throw new Error("MangaLoversEsp response exceeded the byte limit.");
    if (Number(response.bodyBytes || 0) > MAX_RESPONSE_BYTES) {
      throw new Error("MangaLoversEsp response exceeded the byte limit.");
    }
    if (typeof response.body === "string") return response.body;
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string") return body;
    }
    return "";
  }

  async function requestJSON(url) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("MangaLoversEsp requires the fetchv2 bridge.");
    }
    const requested = new URL(url);
    if (requested.protocol !== "https:" || requested.hostname !== "mangalovers.josenunez.cl") {
      throw new Error("MangaLoversEsp refused an undeclared API URL.");
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(750);
      let response;
      try {
        response = await globalThis.fetchv2(url, DEFAULT_HEADERS, "GET", null, {
          followRedirects: true,
          maxBytesHint: MAX_RESPONSE_BYTES,
          responseClass: "json",
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_ATTEMPTS) continue;
        throw lastError;
      }

      const status = Number(response?.status || 0);
      if (!response || response.ok === false || status < 200 || status >= 300) {
        const failure = new Error(`MangaLoversEsp request failed with HTTP ${status || "error"}.`);
        if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) {
          lastError = failure;
          continue;
        }
        throw failure;
      }
      assertFinalURL(response, url);
      const body = await responseText(response);
      if (!body.trim()) throw new Error("MangaLoversEsp returned an empty response.");
      if (/^\s*</.test(body) || /cloudflare|captcha|sign\s*in|inicia\s+sesi[oó]n/i.test(body.slice(0, 1200))) {
        throw new Error("MangaLoversEsp returned HTML, a challenge, or a login response instead of JSON.");
      }
      try {
        return JSON.parse(body);
      } catch {
        throw new Error("MangaLoversEsp returned malformed JSON.");
      }
    }
    throw lastError || new Error("MangaLoversEsp request failed.");
  }

  function seriesSlug(value) {
    const raw = text(value);
    let candidate = raw;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== "mangalovers.josenunez.cl") throw new Error();
      const match = url.pathname.match(/^\/manga\/([^/?#]+)\/?$/i);
      if (!match) throw new Error();
      candidate = decodeURIComponent(match[1]);
    } catch {
      const pathMatch = raw.match(/^\/?manga\/([^/?#]+)\/?$/i);
      if (pathMatch) candidate = decodeURIComponent(pathMatch[1]);
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,180}$/i.test(candidate)) {
      throw new Error("Invalid MangaLoversEsp series identifier.");
    }
    return candidate;
  }

  function chapterParts(value) {
    const raw = text(value);
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== "mangalovers.josenunez.cl") throw new Error();
      const match = url.pathname.match(/^\/manga\/([a-z0-9][a-z0-9_-]{0,180})\/capitulo\/(\d+)\/?$/i);
      if (!match) throw new Error();
      return { slug: match[1], chapterID: match[2] };
    } catch {
      throw new Error("Invalid MangaLoversEsp chapter identifier.");
    }
  }

  function itemFromRow(row) {
    const slug = text(row?.slug);
    const title = text(row?.name);
    if (!/^[a-z0-9][a-z0-9_-]{0,180}$/i.test(slug) || !title) return null;
    const href = `${BASE_URL}/manga/${encodeURIComponent(slug)}`;
    return {
      id: slug,
      href,
      url: href,
      title,
      image: safeAssetURL(row?.cover, row?.fallbackCover),
    };
  }

  function parseListing(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.data) || !payload.meta) {
      throw new Error("MangaLoversEsp listing response has an invalid shape.");
    }
    const seen = new Set();
    const items = [];
    for (const row of payload.data) {
      const item = itemFromRow(row);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    const current = Number(payload.meta.page);
    const totalPages = Number(payload.meta.totalPages);
    if (!Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(totalPages) || totalPages < 0) {
      throw new Error("MangaLoversEsp listing metadata is malformed.");
    }
    return { items, hasMore: current < totalPages };
  }

  function queryParameters(query, page, overrides = {}) {
    const objectQuery = query && typeof query === "object" ? query : null;
    const search = text(objectQuery ? objectQuery.text || objectQuery.query : query);
    const included = uniqueStrings(objectQuery?.tags || objectQuery?.includeTags || []);
    assertNonExplicitGenres(included);
    const excluded = uniqueStrings([
      ...DEFAULT_EXCLUDED_GENRES,
      ...(objectQuery?.excludeTags || objectQuery?.excludedTags || []),
    ]);
    const statusMap = {
      ongoing: "Activo",
      activo: "Activo",
      completed: "Finalizado",
      finalizado: "Finalizado",
      hiatus: "Pausado",
      pausado: "Pausado",
      dropped: "Abandonado",
      abandonado: "Abandonado",
    };
    const requestedStatus = normalizedGenre(objectQuery?.status);
    if (requestedStatus && !statusMap[requestedStatus]) {
      throw new Error(`Unsupported MangaLoversEsp status filter: ${text(objectQuery?.status)}.`);
    }
    const type = normalizedGenre(objectQuery?.type);
    if (type && !["manga", "manhwa", "manhua", "webtoon"].includes(type)) {
      throw new Error(`Unsupported MangaLoversEsp type filter: ${text(objectQuery?.type)}.`);
    }

    const params = new URLSearchParams({
      page: String(normalizedPage(page)),
      limit: String(overrides.limit || SEARCH_PAGE_SIZE),
      sort: overrides.sort || "updated",
      order: overrides.order || "desc",
      excludeGenres: excluded.join(","),
    });
    if (search) params.set("search", search);
    if (included.length) params.set("genres", included.join(","));
    if (requestedStatus) params.set("status", statusMap[requestedStatus]);
    if (type) params.set("type", type);
    return params;
  }

  async function listing(query, page, overrides = {}) {
    const params = queryParameters(query, page, overrides);
    return parseListing(await requestJSON(`${API_URL}/manga?${params.toString()}`));
  }

  async function searchResults(query, page = 1) {
    const raw = text(typeof query === "object" ? query?.text || query?.query : query);
    if (raw === "__feed:popular") return discoveryFeed("popular", page);
    if (raw === "__feed:latest") return discoveryFeed("latest", page);
    return listing(query, page);
  }

  function normalizedStatus(value) {
    const status = normalizedGenre(value);
    if (status === "activo" || status === "ongoing") return "Ongoing";
    if (status === "finalizado" || status === "completed") return "Completed";
    if (status === "pausado" || status === "hiatus") return "Hiatus";
    if (status.includes("abandonado") || status === "dropped") return "Dropped";
    return "Unknown";
  }

  function validateDetailsPayload(payload, expectedSlug) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("MangaLoversEsp details response has an invalid shape.");
    }
    const slug = seriesSlug(payload.slug);
    if (slug !== expectedSlug || !text(payload.name) || !Array.isArray(payload.chapters)) {
      throw new Error("MangaLoversEsp details response does not match the requested series.");
    }
    const genres = uniqueStrings(payload.genres);
    assertNonExplicitGenres(genres);
    return { slug, genres };
  }

  async function fetchDetailsPayload(id) {
    const slug = seriesSlug(id);
    const payload = await requestJSON(`${API_URL}/manga/${encodeURIComponent(slug)}`);
    return { payload, ...validateDetailsPayload(payload, slug) };
  }

  async function extractDetails(id) {
    const { payload, slug, genres } = await fetchDetailsPayload(id);
    const href = `${BASE_URL}/manga/${encodeURIComponent(slug)}`;
    return {
      id: slug,
      href,
      url: href,
      title: text(payload.name),
      description: text(payload.summary),
      image: safeAssetURL(payload.cover, payload.fallbackCover),
      genres,
      status: normalizedStatus(payload.status),
    };
  }

  function chapterNumber(row) {
    const direct = Number(row?.chapterNumber);
    if (Number.isFinite(direct)) return direct;
    const fallback = Number.parseFloat(text(row?.name).replace(",", "."));
    return Number.isFinite(fallback) ? fallback : null;
  }

  async function extractChapters(id) {
    const { payload, slug } = await fetchDetailsPayload(id);
    const seen = new Set();
    const chapters = [];
    for (const row of payload.chapters) {
      const numericID = Number(row?.id);
      const title = text(row?.name);
      const number = chapterNumber(row);
      if (!Number.isSafeInteger(numericID) || numericID < 1 || !title || number === null) {
        throw new Error("MangaLoversEsp returned a malformed chapter entry.");
      }
      if (seen.has(numericID)) continue;
      seen.add(numericID);
      const href = `${BASE_URL}/manga/${encodeURIComponent(slug)}/capitulo/${numericID}`;
      chapters.push({
        id: href,
        href,
        url: href,
        title: `Capítulo ${title}`,
        number,
        releaseDate: text(row?.publishedAt),
        language: "es",
      });
    }
    chapters.sort((left, right) => right.number - left.number || right.id.localeCompare(left.id));
    if (!chapters.length) throw new Error("MangaLoversEsp returned no chapters for this series.");
    return chapters;
  }

  function normalizePages(payload, expected) {
    if (!payload || typeof payload !== "object" || Number(payload.chapterId) !== Number(expected.chapterID)) {
      throw new Error("MangaLoversEsp page response does not match the requested chapter.");
    }
    if (seriesSlug(payload?.series?.slug) !== expected.slug) {
      throw new Error("MangaLoversEsp page response belongs to another series.");
    }
    const candidates = Array.isArray(payload.pages) && payload.pages.length
      ? payload.pages
      : payload.fallbackPages;
    if (!Array.isArray(candidates) || !candidates.length) {
      throw new Error("MangaLoversEsp chapter returned no readable page images.");
    }
    const pages = [];
    const seen = new Set();
    for (const row of candidates) {
      const url = text(typeof row === "string" ? row : row?.url);
      if (!isAllowedAssetURL(url)) {
        throw new Error("MangaLoversEsp returned an invalid or undeclared page-image URL.");
      }
      if (seen.has(url)) continue;
      seen.add(url);
      pages.push({ url, headers: IMAGE_HEADERS });
    }
    if (!pages.length) throw new Error("MangaLoversEsp chapter returned no readable page images.");
    return pages;
  }

  async function extractImages(chapterID) {
    const parts = chapterParts(chapterID);
    const payload = await requestJSON(
      `${API_URL}/manga/capitulo/${encodeURIComponent(parts.slug)}/${parts.chapterID}/pages`,
    );
    return normalizePages(payload, parts);
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = text(feedID).toLowerCase();
    if (feed === "popular") {
      return listing("", page, { limit: DISCOVERY_PAGE_SIZE, sort: "chapters", order: "desc" });
    }
    if (feed === "latest") {
      return listing("", page, { limit: DISCOVERY_PAGE_SIZE, sort: "updated", order: "desc" });
    }
    throw new Error(`Unknown MangaLoversEsp discovery feed: ${text(feedID)}.`);
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([
      discoveryFeed("popular", 1),
      discoveryFeed("latest", 1),
    ]);
    if (!popular.items.length || !latest.items.length) {
      throw new Error("MangaLoversEsp discovery returned an empty section.");
    }
    return {
      sections: [
        { id: "popular", title: "Más capítulos", items: popular.items },
        { id: "latest", title: "Actualizados recientemente", items: latest.items },
      ],
    };
  }

  const handlers = {
    discoveryHome,
    discoveryFeed,
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
  };
  Object.assign(globalThis, handlers);
  globalThis.SynthetiqModule = handlers;
})();
