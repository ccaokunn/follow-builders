// ============================================================================
// Follow Builders — Product Sources Fetcher
// ============================================================================
// Three independent fetchers for product/startup intelligence:
//   1. Product Hunt  — daily top AI posts (needs free PRODUCT_HUNT_TOKEN)
//   2. Hacker News   — Show HN + AI stories via Algolia API (no key needed)
//   3. YC Companies  — latest batch companies via yc-oss public API (no key)
//
// Each fetcher is a named export so it can be toggled individually.
// Results feed into feed-products.json via generate-feed.js.
// ============================================================================

const PH_GRAPHQL = "https://api.producthunt.com/v2/api/graphql";
const HN_ALGOLIA = "https://hn.algolia.com/api/v1/search";
const YC_API = "https://yc-oss.github.io/api";

// ─── Product Hunt ────────────────────────────────────────────────────────────

export async function fetchProductHunt(token, state, errors) {
  if (!token) {
    console.error("  ProductHunt: no PRODUCT_HUNT_TOKEN, skipping");
    return [];
  }

  // Simplest valid query — top voted posts, no date filter
  const query = `{
    posts(first: 30, order: VOTES) {
      edges {
        node {
          id name tagline url votesCount
          topics { edges { node { name } } }
        }
      }
    }
  }`;

  try {
    const res = await fetch(PH_GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      errors.push(`ProductHunt: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (data.errors) {
      const msg = data.errors.map(e => e.message).join('; ');
      errors.push(`ProductHunt: GraphQL error — ${msg}`);
      console.error(`  ProductHunt GraphQL errors: ${msg}`);
      return [];
    }
    if (!data.data) {
      errors.push(`ProductHunt: unexpected response — ${JSON.stringify(data).slice(0, 200)}`);
      return [];
    }

    const results = [];
    for (const edge of data?.data?.posts?.edges || []) {
      const post = edge.node;
      if (state.seenProducts[post.id]) continue;

      results.push({
        source: "producthunt",
        id: post.id,
        name: post.name,
        tagline: post.tagline || "",
        url: post.url,
        votesCount: post.votesCount || 0,
        topics: (post.topics?.edges || []).map((e) => e.node.name),
      });
      state.seenProducts[post.id] = Date.now();
    }

    console.error(`  ProductHunt: ${results.length} new posts`);
    return results;
  } catch (err) {
    errors.push(`ProductHunt: ${err.message}`);
    return [];
  }
}

// ─── Hacker News (Algolia) ───────────────────────────────────────────────────

const HN_AI_KEYWORDS = [
  "ai", "llm", "gpt", "claude", "gemini", "openai", "anthropic",
  "machine learning", "neural", "chatbot", "agent", "copilot",
  "langchain", "rag", "fine-tun", "diffusion", "embedding",
];

export async function fetchHackerNews(state, errors) {
  const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const results = [];
  const seenThisRun = new Set();

  async function algoliaFetch(params) {
    const url = `${HN_ALGOLIA}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // 1. Show HN from last 24h — all are product launches, always include
  try {
    const data = await algoliaFetch({
      tags: "show_hn",
      numericFilters: `created_at_i>${since}`,
      hitsPerPage: 30,
    });
    for (const hit of data.hits || []) {
      const id = String(hit.objectID);
      if (state.seenProducts[id] || seenThisRun.has(id)) continue;
      seenThisRun.add(id);
      results.push(buildHNItem(hit, id, "show_hn"));
      state.seenProducts[id] = Date.now();
    }
  } catch (err) {
    errors.push(`HN Show HN: ${err.message}`);
  }

  // 2. AI-tagged stories from last 24h — filter by keyword + min score
  try {
    const data = await algoliaFetch({
      query: "AI LLM GPT agent",
      tags: "story",
      numericFilters: `created_at_i>${since},points>10`,
      hitsPerPage: 30,
    });
    for (const hit of data.hits || []) {
      const id = String(hit.objectID);
      if (state.seenProducts[id] || seenThisRun.has(id)) continue;
      const title = (hit.title || "").toLowerCase();
      if (!HN_AI_KEYWORDS.some((kw) => title.includes(kw))) continue;
      seenThisRun.add(id);
      results.push(buildHNItem(hit, id, "story"));
      state.seenProducts[id] = Date.now();
    }
  } catch (err) {
    errors.push(`HN AI stories: ${err.message}`);
  }

  // Sort by score, cap at 20
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 20);
  console.error(`  HackerNews: ${top.length} items`);
  return top;
}

function buildHNItem(hit, id, type) {
  return {
    source: "hackernews",
    id,
    type,
    title: hit.title || "",
    url: hit.url || `https://news.ycombinator.com/item?id=${id}`,
    hnUrl: `https://news.ycombinator.com/item?id=${id}`,
    score: hit.points || 0,
    numComments: hit.num_comments || 0,
  };
}

// ─── YC Companies ─────────────────────────────────────────────────────────────

// Batch sort key for "Season YYYY" format (e.g. "Winter 2026", "Summer 2025")
// Season order within a year: Winter=1, Spring=2, Summer=3, Fall=4
const SEASON_ORDER = { winter: 1, spring: 2, summer: 3, fall: 4 };

function batchSortKey(batch) {
  const m = String(batch).match(/^(Winter|Spring|Summer|Fall)\s+(\d{4})$/i);
  if (!m) return 0;
  const season = SEASON_ORDER[m[1].toLowerCase()] || 0;
  return parseInt(m[2]) * 10 + season;
}

// Ordered list of batches to try, newest first.
// Format matches yc-oss per-batch endpoints: /batches/{slug}.json
// When a new YC batch launches, prepend it here.
const YC_BATCH_SLUGS = [
  { slug: "winter-2026", label: "Winter 2026" },
  { slug: "summer-2025", label: "Summer 2025" },
  { slug: "winter-2025", label: "Winter 2025" },
];

export async function fetchYCCompanies(state, errors) {
  // seenYCBatch persists the current batch ID and which companies we've shown.
  // It resets automatically when a new batch is detected.
  if (!state.seenYCBatch) state.seenYCBatch = { batchId: "", seenIds: [] };

  // Try each batch slug until we get a valid response
  let latestBatch = null;
  let companies = null;

  for (const { slug, label } of YC_BATCH_SLUGS) {
    try {
      const res = await fetch(`${YC_API}/batches/${slug}.json`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length >= 5) {
          latestBatch = label;
          companies = data;
          break;
        }
      }
    } catch {
      // try next slug
    }
  }

  if (!latestBatch || !companies) {
    errors.push("YC: Could not fetch any batch from yc-oss API");
    return [];
  }

  // If batch has changed, reset seen companies
  if (latestBatch !== state.seenYCBatch.batchId) {
    console.error(
      `  YC: New batch detected (${latestBatch}), resetting seen companies`
    );
    state.seenYCBatch = { batchId: latestBatch, seenIds: [] };
  }

  // Exclude already-shown companies, take up to 15
  const seenSet = new Set(state.seenYCBatch.seenIds);
  const newCompanies = companies
    .filter((c) => {
      const id = String(c.slug || c.id || c.name || "");
      return id && !seenSet.has(id);
    })
    .slice(0, 15);

  const results = newCompanies.map((c) => {
    const id = String(c.slug || c.id || c.name || "");
    state.seenYCBatch.seenIds.push(id);
    return {
      source: "yc",
      id,
      name: c.name || id,
      description: c.one_liner || c.description || "",
      batch: latestBatch,
      url: c.website || `https://www.ycombinator.com/companies/${id}`,
      tags: Array.isArray(c.tags) ? c.tags : [],
      industry: c.industry || "",
    };
  });

  const remaining = companies.length - state.seenYCBatch.seenIds.length;
  console.error(
    `  YC: ${results.length} from ${latestBatch} (${Math.max(0, remaining)} remaining in batch)`
  );
  return results;
}
