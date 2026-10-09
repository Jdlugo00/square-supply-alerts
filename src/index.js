import { DurableObject } from "cloudflare:workers";

const DAY_MS = 24 * 60 * 60 * 1000;
const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

// ---------- 1. Webhook entry point ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/square-webhook") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.text();
    const signature = request.headers.get("x-square-hmacsha256-signature") || "";
    if (!(await isValidSignature(env, body, signature))) {
      return new Response("Invalid signature", { status: 403 });
    }

    let event;
    try { event = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }
    if (event.type !== "inventory.count.updated") return new Response("Ignored");

    const counts = event.data?.object?.inventory_counts || [];
    for (const group of env.GROUPS) {
      const triggered = counts.some((c) =>
        c.catalog_object_id === group.countCompleteId &&
        c.location_id === env.LOCATION_ID &&
        c.state === "IN_STOCK" &&
        Number(c.quantity) >= 1);
      if (triggered) {
        const id = env.COUNT_RUNNER.idFromName(`${env.LOCATION_ID}:${group.key}`);
        const result = await env.COUNT_RUNNER.get(id).schedule(group.key);
        console.log(`${group.label}: ${result}`);
      }
    }
    return new Response("OK");
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dailyCheck(env));
  },
};

// ---------- 2. One runner per group: blocks duplicates, waits for sync ----------
export class CountRunner extends DurableObject {
  async schedule(groupKey) {
    if (await this.ctx.storage.getAlarm()) return "run already scheduled, ignoring";
    await this.ctx.storage.put("group", groupKey);
    await this.ctx.storage.setAlarm(Date.now() + Number(this.env.RUN_DELAY_SECONDS) * 1000);
    return `run scheduled in ${this.env.RUN_DELAY_SECONDS}s`;
  }

  async alarm() {
    const groupKey = await this.ctx.storage.get("group");
    const group = this.env.GROUPS.find((g) => g.key === groupKey);
    if (group) await runGroup(this.env, group);
  }
}

// ---------- 3. Build and send one group's list ----------
async function runGroup(env, group) {
  try {
    const trigger = await getCounts(env, [group.countCompleteId]);
    if (Number(trigger.get(group.countCompleteId)?.quantity ?? 0) < 1) {
      console.log(`${group.label}: Count Complete already reset, skipping`);
      return;
    }
    const { items, setupIssues } = await loadGroupItems(env, group);
    const counts = await getCounts(env, items.map((i) => i.variationId));
    await sendTelegram(env, buildMessage(group, items, counts, setupIssues));
    console.log(`${group.label}: list sent (${items.length} items checked)`);
  } catch (err) {
    console.log(`${group.label}: run failed`, err.stack || String(err));
    await sendTelegram(env, `⚠️ ${group.label}: couldn't build the order list. Check the Worker logs.\n\n${String(err.message || err).slice(0, 300)}`)
      .catch((e) => console.log("Error alert failed", String(e)));
  } finally {
    await setCount(env, group.countCompleteId, 0).catch((e) => console.log("Reset failed", String(e)));
  }
}

// ---------- 4. Find items in the group's category and read their fields ----------
async function loadGroupItems(env, group) {
  const categories = await listCatalog(env, "CATEGORY");
  const category = categories.find((c) => c.category_data?.name === group.category);
  if (!category) throw new Error(`Category "${group.category}" not found in Square`);

  const storeNames = new Map();
  for (const def of await listCatalog(env, "CUSTOM_ATTRIBUTE_DEFINITION")) {
    for (const s of def.custom_attribute_definition_data?.selection_config?.allowed_selections || []) {
      storeNames.set(s.uid, s.name);
    }
  }

  const items = [];
  const setupIssues = [];
  let cursor;
  do {
    const res = await square(env, "/v2/catalog/search-catalog-items", {
      category_ids: [category.id], limit: 100, ...(cursor && { cursor }),
    });
    for (const item of res.items || []) {
      const variation = item.item_data?.variations?.[0];
      if (!variation || variation.id === group.countCompleteId) continue;

      const name = (item.item_data.name || "").replace(/^SUPPLY\s*-\s*/i, "");
      const attrs = item.custom_attribute_values || {};
      const par = num(attrs.par?.number_value);
      const packSize = num(attrs.pack_size?.number_value) || 1;
      const store = storeNames.get(attrs.store?.selection_uid_values?.[0]) || "Shopping list";
      const override = (variation.item_variation_data?.location_overrides || [])
        .find((o) => o.location_id === env.LOCATION_ID);
      const threshold = override?.inventory_alert_type === "LOW_QUANTITY"
        ? num(override.inventory_alert_threshold) : null;

      if (par === null) { setupIssues.push(`${name}: Par is empty`); continue; }
      if (threshold === null) { setupIssues.push(`${name}: no low-stock alert set`); continue; }
      items.push({ name, variationId: variation.id, par, packSize, store, threshold });
    }
    cursor = res.cursor;
  } while (cursor);

  return { items, setupIssues };
}

// ---------- 5. Turn counts into the Telegram message ----------
function buildMessage(group, items, counts, setupIssues) {
  const byStore = new Map();
  const stale = [];
  const now = Date.now();

  for (const item of items) {
    const count = counts.get(item.variationId);
    const onHand = Math.max(0, Number(count?.quantity ?? 0));

    if (!count) {
      stale.push(`${item.name} (never counted)`);
    } else {
      const age = now - Date.parse(count.calculated_at);
      if (age > group.staleDays * DAY_MS) stale.push(`${item.name} (no change in ${Math.floor(age / DAY_MS)} days)`);
    }

    if (onHand > item.threshold) continue;
    const needed = item.par - onHand;
    if (needed <= 0) { setupIssues.push(`${item.name}: low-stock alert is at or above Par`); continue; }
    const packs = Math.ceil(needed / item.packSize);
    const buy = item.packSize > 1 ? `buy ${packs} packs (${item.packSize} per pack)` : `buy ${packs}`;
    if (!byStore.has(item.store)) byStore.set(item.store, []);
    byStore.get(item.store).push(`  ${item.name}: ${onHand} on hand, par ${item.par}, ${buy}`);
  }

  const lines = [];
  if (byStore.size) {
    lines.push(`🛒 ${group.label} order list`);
    for (const [store, rows] of [...byStore].sort(([a], [b]) => a.localeCompare(b))) lines.push("", store, ...rows);
  } else {
    lines.push(`✅ ${group.label}: nothing to order. Everything is above its low-stock level.`);
  }
  if (stale.length) lines.push("", "Double-check these counts:", ...stale.map((s) => `  ${s}`));
  if (setupIssues.length) lines.push("", "Needs setup in Square:", ...setupIssues.map((s) => `  ${s}`));
  return lines.join("\n");
}

// ---------- 6. Daily check: overdue counts and stuck triggers ----------
async function dailyCheck(env) {
  try {
    const counts = await getCounts(env, env.GROUPS.map((g) => g.countCompleteId));
    const now = Date.now();
    for (const group of env.GROUPS) {
      const c = counts.get(group.countCompleteId);
      const days = c ? (now - Date.parse(c.calculated_at)) / DAY_MS : Infinity;
      if (c && Number(c.quantity) >= 1 && days > 1) {
        await sendTelegram(env, `⚠️ ${group.label}: Count Complete has been stuck at ${c.quantity} for over a day, so the list may not have sent. Set it back to 0 and scan again.`);
      } else if (days > group.overdueDays) {
        const when = Number.isFinite(days) ? `${Math.floor(days)} days ago` : "never";
        await sendTelegram(env, `⏰ ${group.label} count is overdue. Last Count Complete scan: ${when}.`);
      } else {
        console.log(`${group.label}: on schedule`);
      }
    }
  } catch (err) {
    console.log("Daily check failed", err.stack || String(err));
    await sendTelegram(env, `⚠️ Daily supply check failed. Check the Worker logs.`).catch(() => {});
  }
}

// ---------- 7. Helpers: Square, Telegram, signature ----------
async function square(env, path, body) {
  const res = await fetch(env.SQUARE_BASE + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.errors?.map((e) => e.detail || e.code).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Square ${path.split("?")[0]}: ${detail}`);
  }
  return data;
}

async function listCatalog(env, type) {
  const out = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ types: type, ...(cursor && { cursor }) });
    const res = await square(env, `/v2/catalog/list?${qs}`);
    out.push(...(res.objects || []));
    cursor = res.cursor;
  } while (cursor);
  return out;
}

async function getCounts(env, ids) {
  const map = new Map();
  if (!ids.length) return map;
  let cursor;
  do {
    const res = await square(env, "/v2/inventory/counts/batch-retrieve", {
      catalog_object_ids: ids, location_ids: [env.LOCATION_ID], states: ["IN_STOCK"], ...(cursor && { cursor }),
    });
    for (const c of res.counts || []) map.set(c.catalog_object_id, c);
    cursor = res.cursor;
  } while (cursor);
  return map;
}

async function setCount(env, variationId, quantity) {
  await square(env, "/v2/inventory/changes/batch-create", {
    idempotency_key: crypto.randomUUID(),
    changes: [{
      type: "PHYSICAL_COUNT",
      physical_count: {
        catalog_object_id: variationId, location_id: env.LOCATION_ID, state: "IN_STOCK",
        quantity: String(quantity), occurred_at: new Date().toISOString(),
      },
    }],
  });
}

async function sendTelegram(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  if (!res.ok) throw new Error(`Telegram returned ${res.status}`);
}

async function isValidSignature(env, body, signature) {
  if (!signature || !env.SQUARE_WEBHOOK_SIGNATURE_KEY) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.SQUARE_WEBHOOK_SIGNATURE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(env.WEBHOOK_URL + body));
  const expected = enc.encode(btoa(String.fromCharCode(...new Uint8Array(mac))));
  const given = enc.encode(signature);
  return expected.byteLength === given.byteLength && crypto.subtle.timingSafeEqual(expected, given);
}
