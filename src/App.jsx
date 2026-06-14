import { useState, useEffect, useCallback, useMemo, createContext, useContext, useRef, Component } from "react";

class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) return (
      <div style={{ padding: 24, fontFamily: "monospace", color: "#e5484d" }}>
        <h3 style={{ marginBottom: 8 }}>⚠ Chyba pri vykreslení</h3>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{String(this.state.err && (this.state.err.stack || this.state.err.message || this.state.err))}</pre>
      </div>
    );
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const CFG = {
  SLUG: "filmsupport-d93f",
  KEY: "b4fa0a2776238d680da685ac37fa7a9047551017d4bba65792b4a1987ae699db",
  V1: "https://filmsupport-d93f.booqable.com/api/1",
};

// ═══════════════════════════════════════════════
// API LAYER — corrected with proper filtering & pagination
// ═══════════════════════════════════════════════
// ─── Request limiter ────────────────────────────────────────────────────────
// Booqable rate-limits (~120 req/min). Cap concurrency and retry on 429 with
// backoff so bursts (full pagination) don't get throttled.
const MAX_CONCURRENT = 3;
let _active = 0;
const _queue = [];
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _pump() {
  while (_active < MAX_CONCURRENT && _queue.length) {
    const { fn, resolve, reject } = _queue.shift();
    _active++;
    fn().then(resolve, reject).finally(() => { _active--; _pump(); });
  }
}
function _schedule(fn) {
  return new Promise((resolve, reject) => { _queue.push({ fn, resolve, reject }); _pump(); });
}

const api = {
  req(path, opts = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${CFG.V1}${path}${sep}api_key=${CFG.KEY}`;
    return _schedule(async () => {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
        if (r.status === 429 && attempt < 8) {
          const retryAfter = parseInt(r.headers.get("Retry-After") || "", 10);
          await _sleep(retryAfter ? retryAfter * 1000 : Math.min(8000, 900 * (attempt + 1)) + Math.random() * 400);
          continue;
        }
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      }
    });
  },

  // Load ALL orders across every page.
  // NOTE: Booqable's v1 /orders endpoint IGNORES filter[status]=… (a filtered
  // request still returns all orders), so status filtering MUST be done
  // client-side. We fetch every page in parallel batches to stay within the
  // API rate limit, then callers filter by o.status themselves.
  async loadAll() {
    const first = await api.req(`/orders?per=100&page=1`);
    const meta = first.meta || {};
    const total = meta.total_count || 0;
    const totalPages = Math.ceil(total / 100);
    const results = [...(first.orders || [])];
    // Remaining pages — the limiter caps real concurrency, so we can queue
    // them all at once and let it drain at MAX_CONCURRENT.
    const rest = [];
    for (let p = 2; p <= totalPages; p++) rest.push(api.req(`/orders?per=100&page=${p}`));
    const responses = await Promise.all(rest);
    for (const data of responses) results.push(...(data.orders || []));
    return { orders: results, meta };
  },

  // Load recent orders (last N pages sorted newest first via last pages)
  async loadRecent(count = 200) {
    const firstData = await api.req(`/orders?per=1`);
    const total = firstData.meta?.total_count || 0;
    if (total === 0) return [];

    const perPage = 100;
    const totalPages = Math.ceil(total / perPage);
    const pagesToFetch = Math.ceil(count / perPage);
    const results = [];

    const pagePromises = [];
    for (let i = 0; i < pagesToFetch; i++) {
      const page = totalPages - i;
      if (page < 1) break;
      pagePromises.push(api.req(`/orders?per=${perPage}&page=${page}`));
    }

    const responses = await Promise.all(pagePromises);
    for (const data of responses) {
      results.push(...(data.orders || []));
    }
    // Sort newest first
    results.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return results;
  },

  // Get meta stats (total counts per status)
  async getMeta() {
    const data = await api.req(`/orders?per=1`);
    return data.meta || {};
  },

  orders: {
    get: (id) => api.req(`/orders/${id}`),
    update: (id, body) => api.req(`/orders/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    // Cached order detail (lines/bundles). Keyed on updated_at from the order
    // summary — if the order hasn't changed since last fetch, no request at all.
    async getDetail(summary) {
      const key = `fs_od_${summary.id}`;
      const c = LS.get(key);
      if (c && c.v === 3 && summary.updated_at && c.updated_at === summary.updated_at) return c;
      const d = await api.req(`/orders/${summary.id}`);
      const ord = d.order || d;
      const slim = {
        v: 3, id: ord.id, updated_at: ord.updated_at,
        lines: (ord.lines || []).map(l => ({ id: l.id, title: l.title, quantity: l.quantity, position: l.position, parent_line_id: l.parent_line_id, line_type: l.line_type, item_id: l.item_id, planning_id: l.planning_id, price_in_cents: l.price_in_cents })),
        // plannings nesú produkt (SKU, foto, trackable) + priradené sériové kusy
        plannings: (ord.plannings || []).map(p => ({
          id: p.id, item_id: p.item_id, quantity: p.quantity, started: p.started, stopped: p.stopped,
          sku: p.product?.sku || null, photo_url: p.product?.photo_url || null,
          trackable: !!p.product?.trackable, tracking_type: p.product?.tracking_type || null,
          available_quantity: p.product?.available_quantity ?? null,
          stock_items: (p.stock_item_plannings || []).map(s => ({ id: s.stock_item_id, identifier: s.stock_item?.identifier || null, status: s.stock_item?.status || null, started: !!s.started })),
        })),
      };
      LS.set(key, slim);
      return slim;
    },
  },
  customers: {
    list: () => api.req("/customers?per=200"),
    getRecent: async () => {
      const d = await api.req("/customers?per=1");
      const total = d.meta?.total_count || 0;
      const pages = Math.ceil(total / 100);
      const last = await api.req(`/customers?per=100&page=${pages}`);
      return { customers: last.customers || [], total };
    }
  },
  products: {
    list: () => api.req("/product_groups?per=200"),
    // Celý katalóg (všetky stránky product_groups) — pre Inventár. Slim verzia.
    async listAll() {
      const first = await api.req("/product_groups?per=100&page=1");
      const total = first.meta?.total_count || 0;
      const pages = Math.ceil(total / 100);
      const out = [...(first.product_groups || [])];
      const rest = [];
      for (let p = 2; p <= pages; p++) rest.push(api.req(`/product_groups?per=100&page=${p}`));
      const res = await Promise.all(rest);
      for (const d of res) out.push(...(d.product_groups || []));
      return out.filter(p => !p.archived).map(slimProductGroup);
    },
    // Zoznam fyzických kusov (stock items) produktu + ich stav.
    // status "in stock" = dostupné, inak (picked up…) = nedostupné.
    // Cache v session + LS (5 min TTL — stav sa mení ako technika ide von/dnu).
    // Detail product_group (lazy, na rozkliknutie v Inventári): barcode (product-level),
    // sériové kusy (stock_items.identifier + status), popis, depozit, lead/lag, custom fields.
    async groupDetail(gid) {
      if (!gid) return null;
      if (_gdMem.has(gid)) return _gdMem.get(gid);
      const pg = (await api.req(`/product_groups/${gid}`)).product_group || {};
      const prods = pg.products || [];
      let barcode = null; const stock = [];
      for (const p of prods) {
        if (p.barcode && !barcode) barcode = p.barcode;
        (p.stock_items || []).filter(s => !s.archived).forEach(s => stock.push({ identifier: s.identifier, status: s.status, barcode: s.barcode || null }));
      }
      stock.sort((a, b) => (a.identifier || "").localeCompare(b.identifier || "", undefined, { numeric: true }));
      const out = { barcode, description: pg.description || "", deposit_in_cents: pg.deposit_in_cents || 0, lead_time: pg.lead_time, lag_time: pg.lag_time, price_period: pg.price_period, base_price_in_cents: pg.base_price_in_cents || 0, custom_fields: pg.custom_fields || {}, stock, variations: prods.length };
      _gdMem.set(gid, out);
      return out;
    },
    async units(productId) {
      if (!productId) return [];
      if (_unitsMem.has(productId)) return _unitsMem.get(productId);
      const lsKey = `fs_units_${productId}`;
      const c = LS.get(lsKey);
      if (c && Date.now() - c.at < 5 * 60 * 1000) { _unitsMem.set(productId, c.units); return c.units; }
      const prod = (await api.req(`/products/${productId}`)).product || {};
      const units = (prod.stock_items || []).filter(s => !s.archived)
        .map(s => ({ id: s.id, identifier: s.identifier, status: s.status }))
        .sort((a, b) => (a.identifier || "").localeCompare(b.identifier || "", undefined, { numeric: true }));
      LS.set(lsKey, { at: Date.now(), units });
      _unitsMem.set(productId, units);
      return units;
    },
  },
};
const _unitsMem = new Map();
const _gdMem = new Map();
const UNIT_AVAILABLE = (s) => s === "in stock";

// Slim produkt pre Inventár (localStorage cache celého katalógu).
const slimProductGroup = (p) => ({
  id: p.id, name: p.name, sku: p.sku || null,
  base_price_in_cents: p.base_price_in_cents || 0, price_period: p.price_period || "day",
  stock_count: p.stock_count ?? null, trackable: !!p.trackable, tracking_type: p.tracking_type || null,
  product_type: p.product_type || null, photo_url: p.photo_url || null,
  zlava: parseFloat(p.custom_fields?.zlava) || 0,
  tags: Array.isArray(p.tags) ? p.tags.slice(0, 6) : [],
});

// Fulltext + fuzzy: bez diakritiky, bez interpunkcie, tolerancia medzier/preklepov.
const fold = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const levenshtein = (a, b) => {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  const m = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = m[0]; m[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = m[j];
      m[j] = Math.min(m[j] + 1, m[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return m[b.length];
};

// ═══════════════════════════════════════════════
// TOKENS
// ═══════════════════════════════════════════════
// Light theme · purple accent.
// NOTE: token KEYS are kept (gold / goldDim / goldGlow) so every existing
// `C.gold` usage across the app becomes the purple accent automatically.
const C = {
  bg: "#f6f6f8", s0: "#ffffff", s1: "#ffffff", s2: "#f3f3f6", s3: "#ebebef",
  border: "#e7e7ec", borderHi: "#d6d6dd",
  gold: "#6d4aff", goldDim: "#5a3ae0", goldGlow: "rgba(109,74,255,0.09)",
  red: "#e5484d", green: "#1f9d57", blue: "#3b82f6", orange: "#e0663a", purple: "#7c5cff",
  t1: "#18181b", t2: "#6b6b76", t3: "#a0a0ac",
  shadow: "0 1px 2px rgba(18,18,27,0.04), 0 1px 3px rgba(18,18,27,0.06)",
  // Jeden font naprieč celou appkou (Nunito). Rozlišujeme veľkosťou/váhou/farbou,
  // nie rodinou — žiadny monospace pre identifikátory/dátumy.
  // Globálny font appky cez CSS premennú --fs-font (mení sa v Nastaveniach, default Satoshi).
  font: "var(--fs-font, 'Nunito', system-ui, sans-serif)",
  mono: "var(--fs-font, 'Nunito', system-ui, sans-serif)",
  display: "var(--fs-font, 'Nunito', system-ui, sans-serif)",
};

// ── Voliteľný font celej appky (Nastavenia → Zobrazenie). Satoshi = default
// (Fontshare, načítané v index.html), ostatné sa donačítajú z Google Fonts pri výbere.
const APP_FONTS = [
  { name: "Satoshi",           stack: "'Satoshi'" }, // Fontshare (v index.html)
  { name: "Inter",             stack: "'Inter'",             google: "Inter:wght@400;500;600;700;800" },
  { name: "Nunito",            stack: "'Nunito'",            google: "Nunito:wght@400;500;600;700;800;900" },
  { name: "Work Sans",         stack: "'Work Sans'",         google: "Work+Sans:wght@400;500;600;700;800;900" },
  { name: "Poppins",           stack: "'Poppins'",           google: "Poppins:wght@400;500;600;700;800" },
  { name: "Plus Jakarta Sans", stack: "'Plus Jakarta Sans'", google: "Plus+Jakarta+Sans:wght@400;500;600;700;800" },
  { name: "Manrope",           stack: "'Manrope'",           google: "Manrope:wght@400;500;600;700;800" },
  { name: "DM Sans",           stack: "'DM Sans'",           google: "DM+Sans:wght@400;500;600;700" },
  { name: "Space Grotesk",     stack: "'Space Grotesk'",     google: "Space+Grotesk:wght@400;500;600;700" },
  { name: "Montserrat",        stack: "'Montserrat'",        google: "Montserrat:wght@400;500;600;700;800" },
  { name: "Sora",              stack: "'Sora'",              google: "Sora:wght@400;500;600;700;800" },
  { name: "Roboto",            stack: "'Roboto'",            google: "Roboto:wght@400;500;700;900" },
];
const FONT_FALLBACK = "'Nunito', system-ui, -apple-system, sans-serif";
function ensureFontLoaded(f) {
  if (!f?.google) return; // Satoshi a fallbacky sú už načítané
  const id = "fontlink-" + f.name.replace(/\s+/g, "-");
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id; link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
  document.head.appendChild(link);
}
function applyAppFont(name) {
  const f = APP_FONTS.find(x => x.name === name) || APP_FONTS[0];
  ensureFontLoaded(f);
  document.documentElement.style.setProperty("--fs-font", `${f.stack}, ${FONT_FALLBACK}`);
}

const STATUS_MAP = {
  new:      { label: "Nová",        color: "#8a8a96", bg: "#f1f1f4" },
  draft:    { label: "Draft",       color: "#7c5cff", bg: "#f0ecff" },
  concept:  { label: "Koncept",     color: "#3b82f6", bg: "#e9f1fe" },
  reserved: { label: "Rezervovaná", color: "#c77d0a", bg: "#fbf1dd" },
  started:  { label: "Vydaná",      color: "#e0663a", bg: "#fceadf" },
  stopped:  { label: "Vrátená",     color: "#1f9d57", bg: "#e4f5ec" },
  archived: { label: "Archív",      color: "#8a8a96", bg: "#f1f1f4" },
  canceled: { label: "Zrušená",     color: "#e5484d", bg: "#fdeaea" },
};

const LS = {
  get: (k, def = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ═══════════════════════════════════════════════
// APP CONTEXT — proper multi-phase loading
// ═══════════════════════════════════════════════
// ── Cache (šetríme API) ─────────────────────────────────────────────────────
// Orders sa cachujú slim verzie do localStorage; pri štarte sa appka hydratuje
// okamžite z cache a refetch ide len keď je cache staršia ako TTL (alebo ručný Sync).
const ACTIVE_STATUSES = ["started", "reserved", "concept", "draft", "new"];
const ORDERS_CACHE_KEY = "fs_orders_cache_v2";
const SUPPORT_CACHE_KEY = "fs_support_cache_v1";
const ORDERS_TTL = 5 * 60 * 1000;        // 5 min — objednávky sa menia často
const SUPPORT_TTL = 12 * 60 * 60 * 1000; // 12 h — zákazníci/produkty takmer vôbec
const slimOrder = (o) => ({
  id: o.id, number: o.number, status: o.status,
  starts_at: o.starts_at, stops_at: o.stops_at,
  created_at: o.created_at, updated_at: o.updated_at,
  customer: o.customer ? { id: o.customer.id, name: o.customer.name, email: o.customer.email } : null,
  customer_id: o.customer_id,
  grand_total_in_cents: o.grand_total_in_cents, item_count: o.item_count,
  tags: o.tags, payment_status: o.payment_status,
  project: o.properties_attributes?.nazov_projektu || null,
});

const Ctx = createContext(null);

function AppProvider({ children }) {
  // Active orders (started + reserved + concept + draft) — loaded immediately
  const [activeOrders, setActiveOrders] = useState([]);
  // Full order set (all ~2618) — powers full-text search, ⌘K palette, charts
  const [allOrdersFull, setAllOrdersFull] = useState([]);
  // Recent orders — last 200 by date
  const [recentOrders, setRecentOrders] = useState([]);
  // Meta stats from API
  const [meta, setMeta] = useState({});
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [customerTotal, setCustomerTotal] = useState(0);

  const [loadingActive, setLoadingActive] = useState(true);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [error, setError] = useState(null);
  const [synced, setSynced] = useState(null);
  const [prepData, setPrepData] = useState(() => LS.get("fs_prep", {}));
  const [categories, setCategories] = useState(getCategories);
  const [prodTags, setProdTags] = useState(getProdTags);
  const [orderProdTags, setOrderProdTags] = useState(() => LS.get(ORDER_PRODTAG_KEY, {}));
  const [display, setDisplayState] = useState(() => LS.get("fs_display_v1", { bundleView: "expanded", idOrders: false, idQuotes: false, idPicking: true, idCheckin: true, font: "Satoshi", invPhotos: true, invGroup: true, invCatSort: "count" }));
  const setDisplay = useCallback((patch) => setDisplayState(prev => { const next = { ...prev, ...patch }; LS.set("fs_display_v1", next); return next; }), []);
  useEffect(() => { applyAppFont(display.font || "Satoshi"); }, [display.font]);

  const savePrepData = useCallback((next) => { setPrepData(next); LS.set("fs_prep", next); }, []);
  // Uloží kategórie do LS + module store (_CATS) a re-renderuje strom, takže
  // catColor/categorize hneď používajú nové názvy/farby/keywordy.
  const saveCategories = useCallback((next) => { setCategoriesStore(next); setCategories(next); }, []);
  const saveProdTags = useCallback((next) => { setProdTagsStore(next); setProdTags(next); }, []);
  const setOrderProdTag = useCallback((orderId, name) => {
    setOrderProdTags(prev => { const next = { ...prev }; if (name) next[orderId] = name; else delete next[orderId]; LS.set(ORDER_PRODTAG_KEY, next); return next; });
  }, []);

  // Phase 1: Load all orders + meta, then keep only the active ones.
  // (Booqable ignores server-side status filtering — see api.loadAll.)
  const applyOrders = useCallback((allData, metaData) => {
    const active = allData
      .filter((o) => ACTIVE_STATUSES.includes(o.status))
      .sort((a, b) => new Date(b.starts_at || 0) - new Date(a.starts_at || 0));
    const recent = [...allData]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 200);
    setActiveOrders(active);
    setAllOrdersFull(allData);
    setRecentOrders(recent);
    setMeta(metaData || {});
  }, []);

  const loadActive = useCallback(async () => {
    setLoadingActive(true);
    setLoadingRecent(true);
    try {
      const { orders: allData, meta: metaData } = await api.loadAll();
      const slimmed = allData.map(slimOrder);
      applyOrders(slimmed, metaData);
      setSynced(new Date());
      LS.set(ORDERS_CACHE_KEY, { at: Date.now(), orders: slimmed, meta: metaData });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingActive(false);
      setLoadingRecent(false);
    }
  }, [applyOrders]);

  // Phase 2: Load customers + products
  const loadSupport = useCallback(async () => {
    setLoadingCustomers(true);
    setLoadingProducts(true);
    try {
      const [custData, prodData] = await Promise.all([
        api.customers.getRecent(),
        api.products.list(),
      ]);
      setCustomers(custData.customers);
      setCustomerTotal(custData.total);
      setProducts(prodData.product_groups || []);
      LS.set(SUPPORT_CACHE_KEY, { at: Date.now(), customers: custData.customers, total: custData.total, products: prodData.product_groups || [] });
    } catch (e) {
      console.error("Support load error:", e);
    } finally {
      setLoadingCustomers(false);
      setLoadingProducts(false);
    }
  }, []);

  const syncAll = useCallback(async () => {
    setError(null);
    await Promise.all([loadActive(), loadSupport()]);
  }, [loadActive, loadSupport]);

  // Boot: hydratuj z cache okamžite, API volaj len keď cache chýba/expirovala.
  useEffect(() => {
    const oc = LS.get(ORDERS_CACHE_KEY);
    if (oc?.orders?.length) {
      applyOrders(oc.orders, oc.meta);
      setSynced(new Date(oc.at));
      setLoadingActive(false);
      setLoadingRecent(false);
      if (Date.now() - oc.at > ORDERS_TTL) loadActive();
    } else {
      loadActive();
    }
    const sc = LS.get(SUPPORT_CACHE_KEY);
    if (sc?.customers?.length) {
      setCustomers(sc.customers);
      setCustomerTotal(sc.total || 0);
      setProducts(sc.products || []);
      setLoadingCustomers(false);
      setLoadingProducts(false);
      if (Date.now() - sc.at > SUPPORT_TTL) loadSupport();
    } else {
      loadSupport();
    }
  }, []);

  // All orders for views that need everything. Prefer the full fetched set;
  // fall back to active+recent until the full load finishes.
  const allOrders = allOrdersFull.length > 0 ? allOrdersFull : [...activeOrders, ...recentOrders.filter(o =>
    !["started","reserved","concept","draft","new"].includes(o.status)
  )];

  return (
    <Ctx.Provider value={{
      activeOrders, recentOrders, allOrders, meta,
      customers, customerTotal, products,
      loadingActive, loadingRecent, loadingCustomers, loadingProducts,
      error, synced, syncAll, prepData, savePrepData, categories, saveCategories,
      prodTags, saveProdTags, orderProdTags, setOrderProdTag, display, setDisplay,
    }}>
      {children}
    </Ctx.Provider>
  );
}
const useApp = () => useContext(Ctx);

// ═══════════════════════════════════════════════
// UI ATOMS
// ═══════════════════════════════════════════════
function Badge({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.new;
  return <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}44`, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{s.label}</span>;
}
function Card({ children, style = {}, onClick }) {
  return <div onClick={onClick} style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, boxShadow: C.shadow, ...style, cursor: onClick ? "pointer" : "default" }}
    onMouseEnter={e => onClick && (e.currentTarget.style.borderColor = C.borderHi)}
    onMouseLeave={e => onClick && (e.currentTarget.style.borderColor = C.border)}
  >{children}</div>;
}
function Spin({ size = 28 }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
    <div style={{ width: size, height: size, borderRadius: "50%", border: `2px solid ${C.border}`, borderTopColor: C.gold, animation: "spin .7s linear infinite" }} />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>;
}
function Empty({ icon, title, sub }) {
  return <div style={{ textAlign: "center", padding: "40px 16px", color: C.t3 }}><div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div><div style={{ color: C.t2, fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{title}</div>{sub && <div style={{ fontSize: 12 }}>{sub}</div>}</div>;
}
function Btn({ children, onClick, v = "ghost", disabled = false, style = {} }) {
  const vars = { primary: { background: C.gold, color: "#fff", border: "none" }, ghost: { background: C.s2, color: C.t2, border: `1px solid ${C.border}` }, danger: { background: "#fdeaea", color: C.red, border: `1px solid ${C.red}44` }, success: { background: "#e4f5ec", color: C.green, border: `1px solid ${C.green}44` }, orange: { background: "#fceadf", color: C.orange, border: `1px solid ${C.orange}44` } };
  return <button onClick={onClick} disabled={disabled} style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontWeight: 600, fontFamily: C.font, borderRadius: 7, padding: "7px 14px", fontSize: 12, transition: "all .15s", ...vars[v], ...style }}>{children}</button>;
}
function Input({ value, onChange, placeholder, style = {} }) {
  return <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.t1, fontSize: 13, outline: "none", fontFamily: C.font, ...style }} />;
}
function ProgressBar({ pct, color = C.gold }) {
  return <div style={{ background: C.border, borderRadius: 4, height: 5, overflow: "hidden" }}><div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: pct >= 100 ? C.green : color, borderRadius: 4, transition: "width .3s" }} /></div>;
}
function LoadingDot({ loading }) {
  if (!loading) return null;
  return <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: C.gold, marginLeft: 6, animation: "pulse 1s ease infinite" }}>
    <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
  </span>;
}

// ═══════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════
// ── HOME — úvodná operačná stránka: Going out / Return + meškajúce ──
function Home({ nav }) {
  const { activeOrders, meta, loadingActive, error, synced, syncAll } = useApp();
  const today = todayStr();
  const started   = activeOrders.filter(o => o.status === "started");
  const reserved  = activeOrders.filter(o => o.status === "reserved");
  const concept   = activeOrders.filter(o => ["concept","draft","new"].includes(o.status));
  const goingOut  = reserved.filter(o => o.starts_at?.slice(0,10) === today);
  const returning = started.filter(o => o.stops_at?.slice(0,10) === today);
  const overdue   = started.filter(o => o.stops_at && o.stops_at.slice(0,10) < today);

  const [range, setRange] = useState("today_tomorrow");
  const dayStr = (off) => dstrOf(new Date(Date.now() + off * 864e5));
  const winStart = range === "tomorrow" ? dayStr(1) : today;
  const winEnd = range === "today" ? today : range === "tomorrow" ? dayStr(1) : range === "today_tomorrow" ? dayStr(1) : dayStr(7);
  const inWin = (d) => d && d >= winStart && d <= winEnd;
  const goingOutW = [...reserved, ...concept].filter(o => inWin(o.starts_at?.slice(0,10))).sort((a,b)=>(a.starts_at||"").localeCompare(b.starts_at||""));
  const comingBackW = started.filter(o => inWin(o.stops_at?.slice(0,10))).sort((a,b)=>(a.stops_at||"").localeCompare(b.stops_at||""));

  const chips = [
    { label: "Vonku teraz", value: started.length, accent: STATUS_MAP.started.color, click: () => nav("orders", null, "started") },
    { label: "Dnes vychádza", value: goingOut.length, accent: C.gold, click: () => nav("picking") },
    { label: "Dnes vracia", value: returning.length, accent: STATUS_MAP.stopped.color, click: () => nav("checkin") },
    { label: "Mešká", value: overdue.length, accent: C.red, click: () => nav("checkin") },
  ];
  return (
    <div>
      {error && <div style={{ background: "#fdeaea", border: `1px solid ${C.red}44`, borderRadius: 10, padding: "10px 16px", color: C.red, fontSize: 13, marginBottom: 16 }}>⚠ {error}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 21, fontWeight: 800, letterSpacing: "-0.01em" }}>Dnes</h2>
          <div style={{ fontSize: 12, color: C.t3, marginTop: 2, textTransform: "capitalize" }}>{new Date().toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {synced && <span style={{ fontSize: 11, color: C.t3 }}>sync {synced.toLocaleTimeString("sk-SK")}</span>}
          <Btn onClick={syncAll} v="ghost">↺ Sync</Btn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        {chips.map(k => (
          <Card key={k.label} onClick={k.click} style={{ padding: "14px 16px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: k.accent }} />
            <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: k.label === "Mešká" && k.value > 0 ? C.red : C.t1, lineHeight: 1.1, marginTop: 4 }}>{loadingActive ? "…" : k.value}<LoadingDot loading={loadingActive} /></div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <SchedulePanel title="Going out" icon="🚚" color={STATUS_MAP.reserved.color} loading={loadingActive}
          items={goingOutW} dateKey="starts_at" emptyTitle="Žiadne vydania v tomto období"
          range={range} onRange={setRange} onPick={o => nav("picking", o.id)} />
        <SchedulePanel title="Return" icon="↩" color={STATUS_MAP.stopped.color} loading={loadingActive}
          items={comingBackW} dateKey="stops_at" emptyTitle="Žiadne vrátenia v tomto období"
          range={range} onRange={setRange} onPick={o => nav("checkin", o.id)} />
      </div>

      {overdue.length > 0 && (
        <Card style={{ borderColor: `${C.red}55`, background: "#fdeaea" }}>
          <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 12 }}>⚠ MEŠKAJÚ — NEVRÁTENÁ TECHNIKA ({overdue.length})</div>
          {overdue.map(o => { const late = Math.floor((new Date(today) - new Date(o.stops_at.slice(0,10))) / 864e5);
            return <div key={o.id} onClick={() => nav("checkin", o.id)} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.red}22`, fontSize: 13, cursor: "pointer" }}>
              <span><span style={{ color: C.gold, fontFamily: C.mono }}>#{o.number}</span> · <span style={{ color: C.t1 }}>{o.customer?.name || "—"}</span></span>
              <span style={{ color: C.red, fontWeight: 700, fontSize: 12 }}>mešká {late} {late === 1 ? "deň" : late >= 2 && late <= 4 ? "dni" : "dní"}</span>
            </div>; })}
        </Card>
      )}
    </div>
  );
}

// ── DASHBOARD — operačný prehľad: nastaviteľné obdobie, denný progres, úkony ──
const DASH_PERIODS = [["today", "Dnes"], ["today_tomorrow", "Dnes + zajtra"], ["7d", "Najbližších 7 dní"], ["month", "Tento mesiac"]];
function Dashboard({ nav }) {
  const { activeOrders, allOrders, meta, loadingActive, error, synced, syncAll } = useApp();
  const today = todayStr();
  const [period, setPeriod] = useState("today_tomorrow");

  const started   = activeOrders.filter(o => o.status === "started");
  const reserved  = activeOrders.filter(o => o.status === "reserved");
  const concept   = activeOrders.filter(o => ["concept","draft","new"].includes(o.status));
  const overdue    = started.filter(o => o.stops_at && o.stops_at.slice(0,10) < today)
    .sort((a,b) => (a.stops_at||"").localeCompare(b.stops_at||""));

  const dayStr = (off) => dstrOf(new Date(Date.now() + off * 864e5));
  const monthStart = today.slice(0,8) + "01";
  const monthEnd = (() => { const d = new Date(); return dstrOf(new Date(d.getFullYear(), d.getMonth()+1, 0)); })();
  const [winStart, winEnd] = period === "today" ? [today, today]
    : period === "today_tomorrow" ? [today, dayStr(1)]
    : period === "7d" ? [today, dayStr(7)]
    : [monthStart, monthEnd];
  const inWin = (d) => d && d >= winStart && d <= winEnd;
  const outWin  = [...reserved, ...concept].filter(o => inWin(o.starts_at?.slice(0,10)));
  const backWin = started.filter(o => inWin(o.stops_at?.slice(0,10)));

  // Denný progres výdaja: koľko z dnešných odchodov je už vydaných.
  const pickPend = [...reserved, ...concept].filter(o => o.starts_at?.slice(0,10) === today).length;
  const pickDone = started.filter(o => o.starts_at?.slice(0,10) === today).length;
  const pickTotal = pickPend + pickDone;
  const dayPct = pickTotal ? Math.round((pickDone / pickTotal) * 100) : 0;
  const returningToday = started.filter(o => o.stops_at?.slice(0,10) === today).length;

  // Going out / Return panely (vlastný rozsah, default Dnes+zajtra)
  const [panelRange, setPanelRange] = useState("today_tomorrow");
  const pEnd = panelRange === "today" ? today : panelRange === "today_tomorrow" ? dayStr(1) : dayStr(7);
  const inP = (d) => d && d >= today && d <= pEnd;
  const goP   = [...reserved, ...concept].filter(o => inP(o.starts_at?.slice(0,10))).sort((a,b)=>(a.starts_at||"").localeCompare(b.starts_at||""));
  const backP = started.filter(o => inP(o.stops_at?.slice(0,10))).sort((a,b)=>(a.stops_at||"").localeCompare(b.stops_at||""));

  const kpis = [
    { label: "Vydaných práve teraz", value: started.length, accent: STATUS_MAP.started.color, sub: `${overdue.length} mešká`, click: () => nav("orders", null, "started") },
    { label: "Na výdaj (obdobie)", value: outWin.length, accent: C.gold, sub: "→ Výdaj", click: () => nav("picking") },
    { label: "Vráti sa (obdobie)", value: backWin.length, accent: STATUS_MAP.stopped.color, sub: "← Príjem", click: () => nav("checkin") },
    { label: "Oneskorené", value: overdue.length, accent: C.red, sub: "nevrátené", click: () => nav("checkin") },
  ];
  const periodOrders = [...outWin.map(o => ({ o, when: o.starts_at, kind: "out" })), ...backWin.map(o => ({ o, when: o.stops_at, kind: "back" }))]
    .sort((a,b) => (a.when||"").localeCompare(b.when||""));

  return (
    <div>
      {error && <div style={{ background: "#fdeaea", border: `1px solid ${C.red}44`, borderRadius: 10, padding: "10px 16px", color: C.red, fontSize: 13, marginBottom: 16 }}>⚠ {error}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 21, fontWeight: 800, letterSpacing: "-0.01em" }}>Dashboard</h2>
          <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>{loadingActive ? "Načítavajú sa objednávky…" : `${started.length} vonku · ${reserved.length} rezervácií · ${(meta.total_count||0).toLocaleString("sk-SK")} objednávok celkom`}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
            {DASH_PERIODS.map(([k, l]) => (
              <button key={k} onClick={() => setPeriod(k)} style={{ border: "none", background: period === k ? C.s1 : "transparent", color: period === k ? C.t1 : C.t3, borderRadius: 6, padding: "6px 11px", fontSize: 12, fontWeight: period === k ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: period === k ? C.shadow : "none" }}>{l}</button>
            ))}
          </div>
          {synced && <span style={{ fontSize: 11, color: C.t3 }}>sync {synced.toLocaleTimeString("sk-SK")}</span>}
          <Btn onClick={() => { try { window.location.hash = "tv"; } catch {} nav("tv"); }} v="primary">📺 TV view</Btn>
          <Btn onClick={syncAll} v="ghost">↺ Sync</Btn>
        </div>
      </div>

      {/* Going out / Return — s progress barom prípravy (ako vo Výdaji) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <SchedulePanel title="Going out" icon="🚚" color={STATUS_MAP.reserved.color} loading={loadingActive}
          items={goP} dateKey="starts_at" emptyTitle="Žiadne vydania v tomto období" showProgress
          range={panelRange} onRange={setPanelRange} onPick={o => nav("picking", o.id)} />
        <SchedulePanel title="Return" icon="↩" color={STATUS_MAP.stopped.color} loading={loadingActive}
          items={backP} dateKey="stops_at" emptyTitle="Žiadne vrátenia v tomto období" showProgress
          range={panelRange} onRange={setPanelRange} onPick={o => nav("checkin", o.id)} />
      </div>

      {/* Úlohy dnes */}
      <TasksToday nav={nav} />

      {/* Dnes na zmene — ONLINE / OFFLINE */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>DNES NA ZMENE</div>
        <ShiftPresence />
      </Card>

      {/* Denný progres */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: C.t1, fontWeight: 800, fontFamily: C.display }}>Dnešný výdaj</div>
          <div style={{ fontSize: 12, color: C.t2 }}>{pickDone}/{pickTotal} vydaných · {returningToday} na vrátenie dnes</div>
        </div>
        <div style={{ background: C.s2, borderRadius: 6, height: 12, overflow: "hidden" }}>
          <div style={{ width: `${dayPct}%`, height: "100%", background: dayPct >= 100 ? C.green : C.gold, borderRadius: 6, transition: "width .4s" }} />
        </div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 6 }}>{pickTotal === 0 ? "Dnes nie sú naplánované žiadne výdaje." : `${dayPct}% dnešných výdajov hotových`}</div>
      </Card>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 16 }}>
        {kpis.map(k => (
          <Card key={k.label} onClick={k.click} style={{ padding: "16px 18px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: k.accent }} />
            <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: k.label === "Oneskorené" && k.value > 0 ? C.red : C.t1, lineHeight: 1.1, marginTop: 6 }}>{loadingActive ? "…" : k.value}<LoadingDot loading={loadingActive} /></div>
            <div style={{ fontSize: 11, color: C.t3, marginTop: 6, fontWeight: 600 }}>{k.sub}</div>
          </Card>
        ))}
      </div>

      {/* Oneskorené — vypísané s počtom dní */}
      {overdue.length > 0 && (
        <Card style={{ borderColor: `${C.red}55`, background: "#fdeaea", marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 12 }}>⚠ ONESKORENÉ — NEVRÁTENÁ TECHNIKA ({overdue.length})</div>
          {overdue.map(o => { const late = Math.floor((new Date(today) - new Date(o.stops_at.slice(0,10))) / 864e5);
            return <div key={o.id} onClick={() => nav("checkin", o.id)} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.red}22`, fontSize: 13, cursor: "pointer" }}>
              <span><span style={{ color: C.gold, fontFamily: C.mono }}>#{o.number}</span> · <span style={{ color: C.t1 }}>{o.customer?.name || "—"}</span>{o.project && <span style={{ color: C.t3 }}> · {o.project}</span>}</span>
              <span style={{ color: C.red, fontWeight: 700, fontSize: 12 }}>mešká {late} {late === 1 ? "deň" : late >= 2 && late <= 4 ? "dni" : "dní"}</span>
            </div>; })}
        </Card>
      )}

      {/* Úkony v období */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em" }}>ÚKONY V OBDOBÍ ({periodOrders.length})<LoadingDot loading={loadingActive} /></div>
          <Btn v="ghost" onClick={() => nav("orders")} style={{ fontSize: 11 }}>Všetky →</Btn>
        </div>
        {loadingActive ? <Spin size={20} /> : periodOrders.length === 0
          ? <Empty icon="📋" title="V tomto období nie sú žiadne úkony" sub="" />
          : periodOrders.slice(0, 30).map(({ o, when, kind }) => (
            <div key={o.id + kind} onClick={() => nav(kind === "out" ? "picking" : "checkin", o.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13, cursor: "pointer" }}>
              <span style={{ fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 6, background: kind === "out" ? C.goldGlow : "#e4f5ec", color: kind === "out" ? C.gold : C.green, flexShrink: 0 }}>{kind === "out" ? "VÝDAJ" : "PRÍJEM"}</span>
              <span style={{ color: C.gold, fontFamily: C.mono, flexShrink: 0 }}>#{o.number}</span>
              <span style={{ color: C.t1, fontWeight: 600, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer?.name || "—"}{o.project && <span style={{ color: C.t3, fontWeight: 400 }}> · {o.project}</span>}</span>
              <span style={{ color: C.t2, fontSize: 12, flexShrink: 0 }}>{fmtDate(when)}{when?.slice(11,16) ? ` · ${when.slice(11,16)}` : ""}</span>
            </div>
          ))}
      </Card>
    </div>
  );
}

// ── Dnešné smeny + ONLINE/OFFLINE prezencia (Dashboard aj TV view) ──
// Prezencia je lokálna (žiadny backend) — klik prepína online; pri telefóne
// ponúkne volanie / WhatsApp. dark=true → tmavá paleta pre TV.
function ShiftPresence({ dark }) {
  const P = dark
    ? { s1: "#16161c", s2: "#22222c", border: "#2a2a34", t1: "#f4f4f6", t2: "#a0a0ae", t3: "#70707e", green: "#34c759", red: "#ff5a5f" }
    : { s1: C.s1, s2: C.s2, border: C.border, t1: C.t1, t2: C.t2, t3: C.t3, green: C.green, red: C.t3 };
  const today = todayStr();
  const [pres, setPres] = useState(() => LS.get(PRESENCE_KEY, {}));
  const list = onShiftToday(today);
  const toggle = (id) => { const n = { ...pres, [id]: !pres[id] }; setPres(n); LS.set(PRESENCE_KEY, n); };
  if (list.length === 0) return <div style={{ fontSize: 13, color: P.t3 }}>Dnes nemá nikto naplánovanú smenu.</div>;
  const sorted = [...list].sort((a, b) => (pres[b.staff.id] ? 1 : 0) - (pres[a.staff.id] ? 1 : 0));
  const tel = (p) => (p || "").replace(/[^\d+]/g, "");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {sorted.map(({ staff: s, shift: sh }) => {
        const online = !!pres[s.id]; const g = G_BY_ID[s.group];
        return (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, background: P.s2, border: `1px solid ${online ? P.green + "66" : P.border}`, borderRadius: 12, padding: "9px 12px", minWidth: 210, opacity: online ? 1 : 0.62 }}>
            <span style={{ position: "relative", flexShrink: 0 }}>
              <span style={{ width: 34, height: 34, borderRadius: "50%", background: avaColor(s.name), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>{initials(s.name)}</span>
              <span style={{ position: "absolute", right: -1, bottom: -1, width: 11, height: 11, borderRadius: "50%", background: online ? P.green : P.t3, border: `2px solid ${P.s2}` }} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 13, color: P.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
              <div style={{ fontSize: 11, color: P.t3, whiteSpace: "nowrap" }}>{s.role || g?.label} · {shiftTimeLabel(sh)}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
              {s.phone && <>
                <a href={`tel:${tel(s.phone)}`} title="Volať" onClick={e => e.stopPropagation()} style={{ textDecoration: "none", fontSize: 14, background: P.s1, border: `1px solid ${P.border}`, borderRadius: 7, padding: "3px 7px" }}>📞</a>
                <a href={`https://wa.me/${tel(s.phone).replace("+", "")}`} target="_blank" rel="noreferrer" title="WhatsApp" onClick={e => e.stopPropagation()} style={{ textDecoration: "none", fontSize: 14, background: P.s1, border: `1px solid ${P.border}`, borderRadius: 7, padding: "3px 7px" }}>💬</a>
              </>}
              <button onClick={() => toggle(s.id)} title="Prepnúť online/offline" style={{ border: "none", cursor: "pointer", borderRadius: 999, padding: "4px 9px", fontSize: 10, fontWeight: 800, fontFamily: C.font, background: online ? P.green : P.border, color: online ? "#fff" : P.t2 }}>{online ? "ONLINE" : "OFFLINE"}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── TV / fullscreen view (dark) — auto-refresh, číta živé objednávky z Booqable.
// Dostupné cez tlačidlo v Dashboarde alebo URL #tv (Android TV / iPad / Vercel subdoména).
function TvDashboard({ onExit }) {
  const { activeOrders, loadingActive, syncAll, synced, prepData } = useApp();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(() => { try { syncAll && syncAll(); } catch {} }, 60000); return () => clearInterval(t); }, [syncAll]);
  useEffect(() => { const onKey = (e) => { if (e.key === "Escape") onExit(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onExit]);

  const T = { bg: "#1b1b20", panel: "#26262d", panel2: "#31313a", border: "#3a3a45", t1: "#f6f6f8", t2: "#a6a6b3", t3: "#74747f", yellow: "#F5C842", green: "#4FE0B0", pink: "#FF5C93", blue: "#7FB4FF", red: "#FF5A5F", font: "var(--fs-font, 'Inter', system-ui, sans-serif)" };
  const today = todayStr();
  const [tvRange, setTvRange] = useState("today");
  const dstr = (off) => dstrOf(new Date(Date.now() + off * 864e5));
  const wStart = tvRange === "tomorrow" ? dstr(1) : today;
  const wEnd = tvRange === "today" ? today : tvRange === "tomorrow" ? dstr(1) : dstr(7);
  const inW = (d) => d && d >= wStart && d <= wEnd;
  const multi = tvRange === "7d";
  const started = activeOrders.filter(o => o.status === "started");
  const reserved = activeOrders.filter(o => o.status === "reserved");
  const concept = activeOrders.filter(o => ["concept","draft","new"].includes(o.status));
  const goingOut = [...reserved, ...concept].filter(o => inW(o.starts_at?.slice(0,10))).sort((a,b)=>(a.starts_at||"").localeCompare(b.starts_at||""));
  // Oneskorené = vrátenie podľa reálneho času už prešlo (nie len dátum). Vrátenia, ktorých
  // čas ešte nenastal, sú normálne nadchádzajúce. Meškanie sa ráta na minúty.
  const nowMs = now.getTime();
  const isLate = (o) => o.status === "started" && o.stops_at && new Date(o.stops_at).getTime() < nowMs;
  const overdue = started.filter(isLate);
  const lateLabel = (o) => { const m = Math.floor((nowMs - new Date(o.stops_at).getTime()) / 60000);
    if (m < 60) return `mešká ${m} ${m === 1 ? "minútu" : m >= 2 && m <= 4 ? "minúty" : "minút"}`;
    const h = Math.floor(m / 60); if (h < 24) return `mešká ${h} ${h === 1 ? "hodinu" : h >= 2 && h <= 4 ? "hodiny" : "hodín"}`;
    const d = Math.floor(h / 24); return `mešká ${d} ${d === 1 ? "deň" : d >= 2 && d <= 4 ? "dni" : "dní"}`; };
  const upcomingReturns = started.filter(o => !isLate(o) && inW(o.stops_at?.slice(0,10))).sort((a,b)=>(a.stops_at||"").localeCompare(b.stops_at||""));
  // RETURN stĺpec: len vrátenia v zobrazenom období (ako klasický dashboard) — staré
  // oneskorené z minulých dní sa tu neukazujú; meškajúce dnešné sú červené s minútami.
  const returnItems = started.filter(o => inW(o.stops_at?.slice(0,10))).sort((a,b)=>(a.stops_at||"").localeCompare(b.stops_at||""));
  const stat = (o) => { const p = prepData?.[o.id]; const checked = p ? Object.values(p.checklist||{}).filter(Boolean).length : 0; const tot = p?.totalLines || o.item_count || 0; const pct = tot ? Math.round(checked/tot*100) : 0; return { checked, tot, pct }; };

  const rangeLabel = tvRange === "today" ? "Dnes" : tvRange === "tomorrow" ? "Zajtra" : "Najbližších 7 dní";
  const tasks = LS.get(TASKS_KEY, []);
  const openTasks = tasks.filter(t => t.status !== "done").sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  // TV úlohy: dnešné, a pod nimi nestihnuté (open z minulých dní). Budúce sa nezobrazujú.
  const tvTasks = [
    ...openTasks.filter(t => t.date === today).map(t => ({ t, missed: false })),
    ...openTasks.filter(t => t.date && t.date < today).map(t => ({ t, missed: true })),
  ];
  const ORDER_CAP = 7, TASK_CAP = 13;

  // Karta objednávky — čas, avatar zákazníka, väčšie #číslo, spodný progress.
  const Col = ({ title, accent, items, emptyMsg, pickup }) => {
    const shown = items.slice(0, ORDER_CAP), more = items.length - shown.length;
    return (
      <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 20, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "14px 22px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 18, fontWeight: 800, color: T.t1, letterSpacing: "0.05em" }}>{title}</span>
          <span style={{ marginLeft: "auto", fontSize: 22, fontWeight: 800, color: accent }}>{items.length}</span>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          {items.length === 0 ? <div style={{ padding: 30, textAlign: "center", color: T.t3, fontSize: 15 }}>{emptyMsg}</div>
            : shown.map(o => { const { checked, tot, pct } = stat(o); const dt = (o.starts_at || o.stops_at || ""); const t = dt.slice(11,16);
              const dlabel = multi ? new Date(dt.slice(0,10) + "T00:00:00").toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" }) : null;
              const barColor = pct >= 100 ? T.green : pct > 0 ? T.yellow : null;
              const late = !pickup && isLate(o);
              return (
                <div key={o.id} style={{ borderBottom: `1px solid ${T.border}`, borderLeft: late ? `3px solid ${T.red}` : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "11px 20px" }}>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "center", fontWeight: 800, color: late ? T.red : T.t1, background: late ? "rgba(255,90,95,0.12)" : T.panel2, borderRadius: 10, padding: "6px 11px", lineHeight: 1.15, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                      {dlabel && <span style={{ fontSize: 10.5, color: late ? T.red : T.t3 }}>{dlabel}</span>}
                      <span style={{ fontSize: 16 }}>{t || "—"}</span>
                    </span>
                    <span style={{ width: 40, height: 40, borderRadius: "50%", background: avaColor(o.customer?.name), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, flexShrink: 0 }}>{initials(o.customer?.name)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: T.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer?.name || "—"}</div>
                      {o.project && <div style={{ fontSize: 12.5, color: T.t3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.project}</div>}
                      {late
                        ? <div style={{ fontSize: 12.5, fontWeight: 800, color: T.red, marginTop: 1 }}>{lateLabel(o)} · {tot} items to return</div>
                        : <div style={{ fontSize: 12.5, fontWeight: 600, color: T.t2, marginTop: 1 }}>{tot} items to {pickup ? "pick up" : "return"}</div>}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 23, color: T.t1, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>#{o.number}</div>
                      {tot > 0 && <div style={{ fontSize: 12, fontWeight: 700, marginTop: 1, color: pct >= 100 ? T.green : pct > 0 ? T.yellow : T.t3 }}>{checked}/{tot} pripravené</div>}
                    </div>
                  </div>
                  <div style={{ height: 8, background: T.panel2, width: "100%" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: barColor || "transparent", transition: "width .5s" }} />
                  </div>
                </div>
              ); })}
          {more > 0 && <div style={{ padding: "9px 20px", fontSize: 13, fontWeight: 700, color: T.t3 }}>+{more} ďalších</div>}
        </div>
      </div>
    );
  };
  // Kompaktný riadok úlohy — viac úloh pod seba pre prehľad.
  // TV úloha — len tag (typ), názov a číslo objednávky. Nestihnuté = červený okraj.
  const TaskRow = ({ t, missed }) => { const tt = TT_BY_ID[t.type] || TT_BY_ID.other;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${T.border}`, borderLeft: `3px solid ${missed ? T.red : tt.color}` }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: tt.color, background: tt.color + "22", borderRadius: 6, padding: "3px 9px", flexShrink: 0, whiteSpace: "nowrap" }}>{tt.icon} {tt.label}</span>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, color: T.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
        {t.orderNumber && <span style={{ fontSize: 13, fontWeight: 800, color: missed ? T.red : T.t2, flexShrink: 0 }}>#{t.orderNumber}</span>}
      </div>
    ); };
  const Stat = ({ label, value, color, hi }) => (
    <div className={hi ? "tv-sheen" : ""} style={{ position: "relative", overflow: "hidden", background: hi ? T.yellow : T.panel, border: `1px solid ${hi ? T.yellow : T.border}`, borderRadius: 16, padding: "12px 18px", flex: 1 }}>
      <div style={{ fontSize: 10.5, color: hi ? "rgba(27,27,32,0.62)" : T.t3, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 800, color: hi ? "#1b1b20" : color, lineHeight: 1.1, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>{loadingActive ? "…" : value}</div>
    </div>
  );
  const taskMore = openTasks.length - Math.min(openTasks.length, TASK_CAP);

  return (
    <div style={{ position: "fixed", inset: 0, background: T.bg, color: T.t1, fontFamily: T.font, overflow: "hidden", zIndex: 200 }}>
      <style>{`
        @keyframes tvpulse{0%,100%{opacity:1}50%{opacity:.25}}
        @keyframes tvfloat1{0%,100%{transform:translate(0,0)}50%{transform:translate(-30px,26px)}}
        @keyframes tvfloat2{0%,100%{transform:translate(0,0)}50%{transform:translate(28px,-22px)}}
        @keyframes tvsheen{0%{transform:translateX(-130%)}14%{transform:translateX(130%)}100%{transform:translateX(130%)}}
        .tv-sheen::before{content:"";position:absolute;top:0;left:0;width:55%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,0.45),transparent);transform:translateX(-130%);animation:tvsheen 9s ease-in-out infinite;pointer-events:none}
      `}</style>
      {/* dekoratívne žlté gule — pomalá animácia, vhodné do celodenného loopu */}
      <div style={{ position: "absolute", top: -180, right: -120, width: 460, height: 460, borderRadius: "50%", background: "radial-gradient(circle, rgba(245,200,66,0.30), rgba(245,200,66,0) 70%)", animation: "tvfloat1 24s ease-in-out infinite", pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "absolute", bottom: -200, left: -150, width: 520, height: 520, borderRadius: "50%", background: "radial-gradient(circle, rgba(245,200,66,0.20), rgba(245,200,66,0) 70%)", animation: "tvfloat2 28s ease-in-out infinite", pointerEvents: "none", zIndex: 0 }} />

      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "14px 26px", gap: 18, flexShrink: 0 }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ fontSize: 23, fontWeight: 900, color: T.t1, letterSpacing: "-0.01em", lineHeight: 1 }}>FILMSUPPORT</div>
            <div style={{ fontSize: 8.5, fontWeight: 800, color: T.yellow, letterSpacing: "0.26em", marginTop: 4 }}>CAMERA &amp; LIGHTING RENTAL</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginLeft: 8, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 999, padding: "5px 12px" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: T.green, animation: "tvpulse 1.4s ease infinite" }} />
            <span style={{ fontSize: 12, fontWeight: 800, color: T.green, letterSpacing: "0.06em" }}>LIVE</span>
            {synced && <span style={{ fontSize: 11, color: T.t3 }}>sync {synced.toLocaleTimeString("sk-SK")}</span>}
            {loadingActive && <span style={{ fontSize: 11, color: T.t3 }}>…</span>}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 3, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 12, padding: 3 }}>
            {[["today", "Dnes"], ["tomorrow", "Zajtra"], ["7d", "7 dní"]].map(([k, l]) => (
              <button key={k} onClick={() => setTvRange(k)} style={{ border: "none", background: tvRange === k ? T.yellow : "transparent", color: tvRange === k ? "#1b1b20" : T.t2, borderRadius: 9, padding: "7px 14px", fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: T.font }}>{l}</button>
            ))}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{now.toLocaleTimeString("sk-SK")}</div>
            <div style={{ fontSize: 12.5, color: T.t3, textTransform: "capitalize", marginTop: 3 }}>{now.toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
          </div>
          <button onClick={onExit} title="Zavrieť (Esc)" style={{ marginLeft: 12, background: T.panel, border: `1px solid ${T.border}`, color: T.t2, borderRadius: 10, padding: "8px 12px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: T.font }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 14, padding: "14px 22px 0", flexShrink: 0 }}>
          <Stat label="Vonku teraz" value={started.length} color={T.t1} />
          <Stat label="Na výdaj" value={goingOut.length} color={T.yellow} hi />
          <Stat label="Vráti sa" value={upcomingReturns.length} color={T.green} />
          <Stat label="Oneskorené" value={overdue.length} color={overdue.length ? T.red : T.t1} />
          <Stat label="Otvorené úlohy" value={tvTasks.length} color={T.blue} />
        </div>

        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 0.5fr", gap: 14, padding: "14px 22px", minHeight: 0 }}>
          <Col title="GOING OUT" accent={T.yellow} items={goingOut} emptyMsg="Žiadne výdaje v tomto období" pickup />
          <Col title="RETURN" accent={T.green} items={returnItems} emptyMsg="Žiadne vrátenia v tomto období" />
          <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 20, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: T.t1, letterSpacing: "0.05em" }}>ÚLOHY</span>
              <span style={{ marginLeft: "auto", fontSize: 22, fontWeight: 800, color: T.yellow }}>{tvTasks.length}</span>
            </div>
            <div style={{ flex: 1, overflow: "hidden" }}>
              {tvTasks.length === 0 ? <div style={{ padding: 30, textAlign: "center", color: T.t3, fontSize: 15 }}>Žiadne úlohy na dnes</div>
                : tvTasks.slice(0, TASK_CAP).map(({ t, missed }) => <TaskRow key={t.id} t={t} missed={missed} />)}
              {tvTasks.length > TASK_CAP && <div style={{ padding: "9px 16px", fontSize: 13, fontWeight: 700, color: T.t3 }}>+{tvTasks.length - TASK_CAP} ďalších</div>}
            </div>
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${T.border}`, padding: "10px 26px", flexShrink: 0, maxHeight: 98, overflow: "hidden" }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", color: T.t3, marginBottom: 8 }}>DNES NA ZMENE</div>
          <ShiftPresence dark />
        </div>
      </div>
    </div>
  );
}

// ── Štandardné kategórie FilmSupport (rovnaké ako sekcie v Booqable
// objednávkach). Primárne sa používajú reálne section riadky z objednávky;
// keyword pravidlá sú fallback pre objednávky bez sekcií. Poradie testov je
// dôležité — špecifické kategórie pred generickými brand-matchmi.
// ── Kategórie techniky — EDITOVATEĽNÉ (Inventár → Kategórie), uložené v LS.
// Priradenie produktu do kategórie: (a) podľa sekcie v objednávke so zhodným
// názvom, inak (b) podľa keywordov v názve. Editor vie meniť názvy, farby,
// keywordy, poradie aj pridávať kategórie.
const CATEGORIES_KEY = "fs_categories_v2";
const CAT_FALLBACK = { name: "Other", color: "#9aa0ad" };
const DEFAULT_CATEGORIES = [
  { name: "Cameras",                   color: "#e8112d", keywords: ["alexa","amira","komodo","raptor","v-raptor","venice","burano","fx3","fx6","fx9","fx30","a7s","a7r","blackmagic","bmpcc","pyxis","gopro","osmo","camera body","kamera","c70","c300","c500","z cam"] },
  { name: "Lenses",                    color: "#c0188f", keywords: ["objektív","prime","anamorph","cooke","zeiss","sigma","fujinon","atlas","supreme","g-master","gmaster","cn-e","laowa","samyang","irix","tokina","dzofilm","dzo","summicron","summilux","signature prime","ultra prime","master prime"] },
  { name: "Filters",                   color: "#8a25c9", keywords: ["filter","filtre","irnd","ndf","polariser","polarizer","black mist","diffusion filter","glimmer","hollywood black","nd 0.","nd0."] },
  { name: "Optical Accessories",       color: "#6a30d6", keywords: ["diopter","dioptr","lens support","donut","step ring","rear adapter","pl to ","ef to ","lens adapter"] },
  { name: "Matteboxes",                color: "#4339cf", keywords: ["mattebox","matte box","lmb","sunshade","flag holder","filter frame","filter tray"] },
  { name: "Follow Focus",              color: "#3b6fe0", keywords: ["follow focus","cforce","nucleus","focus motor","wcu","hi-5","hand unit","heden"] },
  { name: "Lens Control",              color: "#2f9fe0", keywords: ["lbus","fiz","cmotion","master grip","mdr","lcube"] },
  { name: "Focus Assist",              color: "#1fb5b0", keywords: ["cine tape","focusbug","focus bug","tape measure","light ranger"] },
  { name: "Wireless Video",            color: "#34a847", keywords: ["teradek","bolt","vaxis","hollyland","cineye","transmitter","receiver","prijímač","vysielač","prenos"] },
  { name: "Monitors",                  color: "#5cb84a", keywords: ["monitor","smallhd","director","sidefinder","viewfinder","evf"] },
  { name: "Video Recorders",           color: "#8cc63f", keywords: ["atomos","ninja","shogun","shinobi","recorder","odyssey"] },
  { name: "Video Assist",              color: "#a8cf38", keywords: ["q-take","qtake","video assist","video village"] },
  { name: "Lighting",                  color: "#f5a623", keywords: ["aputure","amaran","nanlite","nanlux","skypanel","s60","s360","astera","titan tube","pavotube","hmi","fresnel","dedolight","forza","litepanel","kinoflo","led panel","orbiter","spotlight"] },
  { name: "Light Modifiers",           color: "#e08a2b", keywords: ["softbox","soft box","lantern","dome diffuser","grid","barndoor","barn door","diffuser","snapbag","dopchoice","scrim","flag","floppy","reflector","bounce","chimera","octa"] },
  { name: "Cables",                    color: "#f2d31f", keywords: ["cable","kábel","kabel","xlr","hdmi","sdi","bnc","extension","power cable","usb-c to"] },
  { name: "Grip",                      color: "#f3b81f", keywords: ["grip","clamp","magic arm","griphead","grip head","knuckle","baby pin","spigot","cardellini","matthellini","super clamp","bazooka","menace arm","apple box"] },
  { name: "Stands",                    color: "#6f5346", keywords: ["stand","statív","tripod","c-stand","combo","century","sachtler","oconnor","manfrotto","flowtech","wind up","high roller"] },
  { name: "Carts",                     color: "#f59320", keywords: ["cart","magliner","vozík","rudla","trolley","dolly"] },
  { name: "Power",                     color: "#ee6f1f", keywords: ["battery","batér","bateria","v-mount","vmount","gold mount","charger","nabíja","napája","d-tap","powerbank","power station","ac adapter","power supply","power adapter"] },
  { name: "Data / Media",              color: "#df4f2c", keywords: ["cfexpress","cfast","sdxc","micro sd","sd card","ssd","card reader","čítačka","samsung t"] },
  { name: "Audio",                     color: "#b0568f", keywords: ["mikrofón","microphone","sennheiser","rode","deity","lavalier","boom","mixpre","zoom f","zaxcom","wireless go","dpa","sound devices","headphone","slúchadl"] },
  { name: "Transport",                 color: "#5a7a8c", keywords: ["sprinter","ducato","crafter","transport","vehicle"] },
  { name: "Miscellaneous Accessories", color: "#1ba06a", keywords: ["tape","gaff","case","kufor","bag","tašk","strap","cover","rain","tarp"] },
];
let _CATS = (() => {
  try { const v = JSON.parse(localStorage.getItem(CATEGORIES_KEY)); return Array.isArray(v) && v.length ? v : DEFAULT_CATEGORIES; }
  catch { return DEFAULT_CATEGORIES; }
})();
const getCategories = () => _CATS;
const setCategoriesStore = (next) => { _CATS = next; try { localStorage.setItem(CATEGORIES_KEY, JSON.stringify(next)); } catch {} };
const categorize = (title = "") => {
  const t = title.toLowerCase();
  for (const c of _CATS) if ((c.keywords || []).some(k => k && t.includes(k.toLowerCase()))) return c.name;
  return CAT_FALLBACK.name;
};

// ── Typy produkcie (order tag) — editovateľné v Nastaveniach, priradenie
// per objednávka uložené lokálne. ──
const PRODTAGS_KEY = "fs_prodtags_v1";
const ORDER_PRODTAG_KEY = "fs_order_prodtag_v1";
const DEFAULT_PRODTAGS = [
  { name: "FILM",            color: "#e11d2e" },
  { name: "TV SERIES",       color: "#6a30d6" },
  { name: "COMMERCIAL",      color: "#3b6fe0" },
  { name: "NON COMMERCIAL",  color: "#1f9d57" },
  { name: "STUDENT PROJECT", color: "#f59320" },
];
let _PRODTAGS = (() => {
  try { const v = JSON.parse(localStorage.getItem(PRODTAGS_KEY)); return Array.isArray(v) && v.length ? v : DEFAULT_PRODTAGS; }
  catch { return DEFAULT_PRODTAGS; }
})();
const getProdTags = () => _PRODTAGS;
const setProdTagsStore = (next) => { _PRODTAGS = next; try { localStorage.setItem(PRODTAGS_KEY, JSON.stringify(next)); } catch {} };
const prodTagColor = (name) => _PRODTAGS.find(p => p.name === name)?.color || C.t3;

// Obrysová pilulka typu produkcie (odlíšená od plného statusu)
function ProdTagPill({ name, onClick }) {
  if (!name) return null;
  const color = prodTagColor(name);
  return <span onClick={onClick} style={{ border: `1.5px solid ${color}`, color, background: "#fff", fontFamily: C.display, fontWeight: 800, fontSize: 10.5, letterSpacing: "0.02em", borderRadius: 9, padding: "3px 10px", whiteSpace: "nowrap", cursor: onClick ? "pointer" : "default" }}>{name}</span>;
}

// Výber typu produkcie pre objednávku (dropdown), uloží sa lokálne
function ProdTagPicker({ orderId }) {
  const { prodTags, orderProdTags, setOrderProdTag } = useApp();
  const [open, setOpen] = useState(false);
  const current = orderProdTags[orderId];
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      {current
        ? <ProdTagPill name={current} onClick={() => setOpen(o => !o)} />
        : <span onClick={() => setOpen(o => !o)} style={{ border: `1px dashed ${C.borderHi}`, color: C.t3, borderRadius: 9, padding: "3px 10px", fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: C.display }}>+ Typ produkcie</span>}
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 29 }} />
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, background: C.s1, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: C.shadow, padding: 6, minWidth: 180 }}>
            {prodTags.map(p => (
              <div key={p.name} onClick={() => { setOrderProdTag(orderId, p.name); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: C.display, color: C.t1 }}
                onMouseEnter={e => e.currentTarget.style.background = C.s2} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: p.color, flexShrink: 0 }} />{p.name}
              </div>
            ))}
            {current && <div onClick={() => { setOrderProdTag(orderId, null); setOpen(false); }} style={{ padding: "7px 8px", borderTop: `1px solid ${C.border}`, marginTop: 4, fontSize: 11.5, color: C.red, cursor: "pointer", fontWeight: 600 }}>Odstrániť typ</div>}
          </div>
        </>
      )}
    </span>
  );
}

// Hierarchicky usporiadané riadky objednávky: parenty (bundle/hlavné položky)
// podľa position, ich deti hneď pod nimi (tiež podľa position).
function orderedLines(det) {
  const all = (det?.lines || []).filter(l => l.title && l.line_type !== "section");
  const parents = all.filter(l => !l.parent_line_id).sort((a, b) => (a.position || 0) - (b.position || 0));
  const kids = all.filter(l => l.parent_line_id);
  const byParent = {};
  for (const k of kids) (byParent[k.parent_line_id] = byParent[k.parent_line_id] || []).push(k);
  for (const arr of Object.values(byParent)) arr.sort((a, b) => (a.position || 0) - (b.position || 0));
  const out = [];
  for (const p of parents) { out.push(p); for (const k of byParent[p.id] || []) out.push(k); }
  const known = new Set(out.map(l => l.id));
  for (const k of kids) if (!known.has(k.id)) out.push(k);
  return out;
}

// Farba kategórie podľa editovateľnej tabuľky. Exact zhoda názvu → partial
// (sekcie z objednávky typu "CAMERA" ~ "Cameras") → hash fallback.
const catColor = (name = "") => {
  const k = (name || "").trim().toLowerCase();
  if (!k) return CAT_FALLBACK.color;
  const exact = _CATS.find(c => c.name.toLowerCase() === k);
  if (exact) return exact.color;
  const part = _CATS.find(c => c.name.toLowerCase().startsWith(k) || k.startsWith(c.name.toLowerCase()));
  if (part) return part.color;
  if (["other","ostatné","ostatne","bez sekcie"].includes(k)) return CAT_FALLBACK.color;
  let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return _CATS[h % Math.max(1, _CATS.length)]?.color || CAT_FALLBACK.color;
};

// Spoločné zoskupenie riadkov techniky: reálne sekcie objednávky → keyword
// kategórie (fallback) → čisté poradie. Bundle deti vždy pod parentom.
function groupGearLines(lines, orderSections, grouping = "category") {
  const kidsOf = {};
  for (const l of lines) if (l.parent_line_id) (kidsOf[l.parent_line_id] = kidsOf[l.parent_line_id] || []).push(l);
  const withKids = (p) => [p, ...(kidsOf[p.id] || [])];
  if (grouping === "order") return [["", lines]];
  if (orderSections && orderSections.length > 0) {
    const m = new Map();
    for (const l of lines) {
      if (l.parent_line_id) continue;
      let sec = null;
      for (const s of orderSections) if ((s.position || 0) <= (l.position || 0)) sec = s;
      const key = (sec?.title || "Bez sekcie").trim().toUpperCase();
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(...withKids(l));
    }
    return [...m.entries()];
  }
  const m = new Map();
  for (const l of lines) {
    if (l.parent_line_id) continue;
    const cat = categorize(l.title);
    if (!m.has(cat)) m.set(cat, []);
    m.get(cat).push(...withKids(l));
  }
  const order = _CATS.map(c => c.name);
  const idx = (n) => { const i = order.indexOf(n); return i < 0 ? 999 : i; };
  return [...m.entries()].sort((a, b) => idx(a[0]) - idx(b[0]));
}

const sectionsOf = (orderLike) => (orderLike?.lines || [])
  .filter(l => l.line_type === "section" && l.title?.trim())
  .sort((a, b) => (a.position || 0) - (b.position || 0));

// ── Workflow status TAG (delivery-note štýl, zaoblená pilulka) ──
const STATUS_TAGS = {
  draft:     { label: "DRAFT",             bg: "#9aa0ad", fg: "#fff" },
  reserved:  { label: "RESERVED",          bg: "#3b6fe0", fg: "#fff" },
  ready:     { label: "READY FOR PICK UP", bg: "#1f9d57", fg: "#fff" },
  picked_up: { label: "PICKED UP",         bg: "#f4c41a", fg: "#3a2e00" },
  returned:  { label: "RETURNED",          bg: "#5fc97a", fg: "#103a1f" },
  completed: { label: "COMPLETED",         bg: "#18181b", fg: "#fff" },
};
function StatusTag({ tag, small }) {
  const t = STATUS_TAGS[tag];
  if (!t) return null;
  return <span style={{ background: t.bg, color: t.fg, fontFamily: C.display, fontWeight: 800, fontSize: small ? 10 : 11, letterSpacing: "0.02em", borderRadius: 9, padding: small ? "3px 9px" : "4px 12px", whiteSpace: "nowrap" }}>{t.label}</span>;
}
// Booqable status + lokálny prep stav → workflow tag
const orderTag = (o, prep) => {
  if (o.status === "stopped" || o.status === "archived") return prep?.checkedAt ? "completed" : "returned";
  if (o.status === "started") return "picked_up";
  if (o.status === "reserved") return prep?.state === "ready" ? "ready" : "reserved";
  if (["draft", "concept", "new"].includes(o.status)) return "draft";
  return null;
};

// Dátum DD.MM.RRRR z ISO reťazca
const fmtDate = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}.${m}.${y}`; };
// Suma v centoch → "25,00 €"
const eur = (cents) => (((cents || 0) / 100).toLocaleString("sk-SK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + " €";
// Počet účtovaných dní z Booqable charge_label ("1 deň", "2 dni", "Fix" → 1)
const chargeDays = (label = "") => { const m = String(label).match(/\d+/); return m ? parseInt(m[0], 10) : 1; };
// Slovenská pluralizácia dní: 1 deň, 2–4 dni, 5+ dní
const daysLabel = (n) => n === 1 ? "1 deň" : (n >= 2 && n <= 4 ? `${n} dni` : `${n} dní`);

// Vizuálne pekné zobrazenie obdobia prevzatie → vrátenie
function DateRange({ from, to, compact }) {
  const Box = ({ label, val }) => (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 8, color: C.t3, fontWeight: 800, letterSpacing: "0.07em" }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontSize: compact ? 12 : 13.5, fontWeight: 700, color: C.t1, marginTop: 2 }}>{fmtDate(val)}</div>
    </div>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.s2, borderRadius: 10, padding: "8px 16px", flexShrink: 0 }}>
      <Box label="PREVZATIE" val={from} />
      <span style={{ color: C.t3, fontSize: 15 }}>→</span>
      <Box label="VRÁTENIE" val={to} />
    </div>
  );
}

// Jednotná karta objednávky (Objednávky / Výdaj / Príjem vyzerajú rovnako).
// Tenký farebný pásik vľavo = workflow status.
function OrderCard({ o, prep, onClick, markers, meta, progress, fullBar }) {
  const { orderProdTags } = useApp();
  const tag = orderTag(o, prep);
  const ptag = orderProdTags?.[o.id];
  const color = STATUS_TAGS[tag]?.bg || C.borderHi;
  // Spodný progress pásik cez celý riadok (Výdaj): sivý = ešte sa nezačalo,
  // oranžový = rozpracované / niečo chýba, zelený = ready (100 %).
  const barColor = fullBar == null ? null : fullBar >= 100 ? C.green : fullBar > 0 ? C.orange : C.border;
  return (
    <div onClick={onClick} style={{ display: "flex", flexDirection: "column", background: C.s1, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", cursor: onClick ? "pointer" : "default", boxShadow: C.shadow }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = C.borderHi; }}
      onMouseLeave={e => { if (onClick) e.currentTarget.style.borderColor = C.border; }}>
      <div style={{ display: "flex" }}>
        <div style={{ width: 4, background: color, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 18, padding: "13px 20px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4, flexWrap: "wrap" }}>
              <span style={{ color: C.t2, fontFamily: C.mono, fontWeight: 700, fontSize: 13 }}>#{o.number}</span>
              {tag && <StatusTag tag={tag} small />}
              {ptag && <ProdTagPill name={ptag} />}
              {markers}
            </div>
            <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 15.5, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer?.name || "—"}</div>
            {o.project && <div style={{ fontSize: 12, color: C.t2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>Projekt: <span style={{ fontWeight: 700, color: C.t1 }}>{o.project}</span></div>}
            {progress != null && <div style={{ marginTop: 9, maxWidth: 320 }}><ProgressBar pct={progress} /></div>}
          </div>
          {o.starts_at && o.stops_at && <DateRange from={o.starts_at} to={o.stops_at} />}
          {meta && <div style={{ textAlign: "right", flexShrink: 0, minWidth: 86 }}>{meta}</div>}
        </div>
      </div>
      {fullBar != null && (
        <div style={{ height: 6, background: C.border, width: "100%" }}>
          <div style={{ width: `${Math.max(fullBar >= 100 ? 100 : fullBar, fullBar > 0 ? 6 : 100)}%`, height: "100%", background: barColor, transition: "width .3s, background .3s" }} />
        </div>
      )}
    </div>
  );
}

// Chip sériového čísla — Booqable štýl. variant: selected (modrá + ×),
// available (sivá, klik), unavailable (červený obrys).
function SerialChip({ label, variant = "available", onClick, onRemove, title }) {
  const s = {
    selected:    { bg: "#fff",     bd: "#2f6df0", fg: "#2f6df0" },
    available:   { bg: "#eef0f4",  bd: "#eef0f4", fg: C.t2 },
    unavailable: { bg: "#fff",     bd: "#e5484d", fg: "#e5484d" },
  }[variant];
  return (
    <span title={title || ""} onClick={onClick}
      style={{ display: "inline-flex", alignItems: "stretch", borderRadius: 999, border: `1.5px solid ${s.bd}`, background: s.bg, color: s.fg, fontFamily: C.mono, fontWeight: 700, fontSize: 10.5, overflow: "hidden", cursor: onClick ? "pointer" : "default", whiteSpace: "nowrap" }}>
      <span style={{ padding: "3px 10px" }}>{label}</span>
      {onRemove && <span onClick={e => { e.stopPropagation(); onRemove(); }} style={{ display: "flex", alignItems: "center", padding: "0 8px", borderLeft: `1.5px solid ${s.bd}`, cursor: "pointer", fontSize: 12 }}>×</span>}
    </span>
  );
}

// Booqable serial picker: vyber konkrétne kusy. Vybrané = modré (×),
// dostupné = sivé (klik vyberie), nedostupné = červené pod "Nedostupné".
function SerialPicker({ units, selectedIds, lockedIds = [], required, onAdd, onRemove, interactive = true }) {
  const sel = new Set(selectedIds), lock = new Set(lockedIds);
  const selectedUnits = units.filter(u => sel.has(u.id));
  const available = units.filter(u => !sel.has(u.id) && UNIT_AVAILABLE(u.status));
  const unavail = units.filter(u => !sel.has(u.id) && !UNIT_AVAILABLE(u.status));
  const enough = required == null || selectedUnits.length >= required;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {selectedUnits.map(u => (
          <SerialChip key={u.id} label={u.identifier} variant="selected"
            onRemove={interactive && !lock.has(u.id) ? () => onRemove(u.id) : undefined}
            title={lock.has(u.id) ? "Priradené v Booqable" : ""} />
        ))}
        {interactive && available.map(u => (
          <SerialChip key={u.id} label={u.identifier} variant="available" onClick={() => onAdd(u.id)} />
        ))}
        {required != null && (
          <span style={{ fontSize: 10, fontFamily: C.mono, fontWeight: 800, color: enough ? C.green : C.red, marginLeft: 2 }}>{enough ? "✓" : "⚠"} {selectedUnits.length}/{required}</span>
        )}
      </div>
      {interactive && unavail.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", color: C.t3, margin: "9px 0 4px" }}>NEDOSTUPNÉ</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {unavail.map(u => <SerialChip key={u.id} label={u.identifier} variant="unavailable" title={u.status} />)}
          </div>
        </>
      )}
    </div>
  );
}

// Prepínač zoskupenia: Kategórie ZAP (sekcie/kategórie) ↔ VYP (poradie v objednávke)
function CatToggle({ on, set }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: C.display, fontWeight: 800, fontSize: 12, color: on ? C.t1 : C.t3, cursor: "pointer", userSelect: "none", border: `1px solid ${on ? C.gold : C.border}`, background: on ? C.goldGlow : "transparent", borderRadius: 8, padding: "5px 11px" }}>
      <input type="checkbox" checked={on} onChange={e => set(e.target.checked)} style={{ accentColor: C.gold }} />
      Kategórie
    </label>
  );
}

// Farebná pilulka kategórie (gear-list štýl)
function CatPill({ name, color, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 4px" }}>
      <span style={{ background: color, color: "#fff", fontFamily: C.display, fontWeight: 800, fontSize: 13, borderRadius: 11, padding: "6px 16px", textTransform: "capitalize" }}>{name.toLowerCase()}</span>
      {right}
    </div>
  );
}

// Jednotný riadok techniky: farebný pruh kategórie, foto, Nunito titulok,
// qty badge, SKU/cena meta; `children` = chips/varovania, `right` = akcie.
function GearRow({ line: l, plan, color, done, onClick, right, children, fill, showId = true }) {
  const isChild = !!l.parent_line_id;
  const qty = Math.round(l.quantity || 0);
  return (
    <div onClick={onClick} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 4px 9px 0", marginLeft: isChild ? 26 : 0, borderBottom: `1px solid ${C.border}`, cursor: onClick ? "pointer" : "default" }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.background = C.s2; }}
      onMouseLeave={e => { if (onClick) e.currentTarget.style.background = "transparent"; }}
    >
      {fill != null
        ? <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, background: `${color}26`, position: "relative", overflow: "hidden", flexShrink: 0, minHeight: 34 }}>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${Math.round(Math.min(1, fill) * 100)}%`, background: color, borderRadius: 3, transition: "height .4s ease" }} />
          </div>
        : <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, background: color, opacity: isChild ? 0.4 : 1, flexShrink: 0, minHeight: 34 }} />}
      {plan?.photo_url
        ? <img src={plan.photo_url} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", flexShrink: 0, border: `1px solid ${C.border}`, opacity: done ? 0.55 : 1 }} />
        : <div style={{ width: 34, height: 34, borderRadius: 7, background: C.s2, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0, opacity: done ? 0.55 : 1 }}>🎬</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: C.display, fontSize: 14, fontWeight: isChild ? 700 : 800, color: done ? C.t3 : C.t1, textDecoration: done ? "line-through" : "none", lineHeight: 1.25 }}>
          {l.title}
          {qty > 1 && <span style={{ marginLeft: 7, fontSize: 10.5, fontWeight: 800, fontFamily: C.mono, color: "#fff", background: color, borderRadius: 5, padding: "1px 6px", verticalAlign: "1px" }}>×{qty}</span>}
        </div>
        {showId && plan?.sku && <div style={{ fontSize: 10.5, color: C.t3, fontFamily: C.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{plan.sku}</div>}
        {children}
      </div>
      {right}
    </div>
  );
}

// Malý toggle prepínač (Pripravené / Vydané) v štýle delivery note
function Tgl({ on, color = C.gold, onClick, label }) {
  return (
    <div onClick={onClick} title={label} style={{ width: 32, height: 18, borderRadius: 10, background: on ? color : C.s3, border: `1px solid ${on ? color : C.borderHi}`, position: "relative", cursor: "pointer", transition: "background .15s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 1.5, left: on ? 15 : 2, width: 13, height: 13, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 2px rgba(0,0,0,.25)" }} />
    </div>
  );
}

// Deterministic avatar color from customer name
const AVA_COLORS = ["#7c5cff", "#3b82f6", "#e0663a", "#1f9d57", "#c77d0a", "#e5484d", "#0ea5b7", "#8b5cf6"];
const avaColor = (name = "") => AVA_COLORS[[...name].reduce((s, ch) => s + ch.charCodeAt(0), 0) % AVA_COLORS.length];
const initials = (name = "") => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "—";

// "Going out / Coming back" panel — orders grouped by day with time chips,
// avatar, prep progress (from local prepData) and order number, ako vo Filmo.
function SchedulePanel({ title, icon, color, items, dateKey, emptyTitle, onPick, loading, range, onRange, showProgress }) {
  const { prepData } = useApp();
  const now = new Date();
  const today = dstrOf(now);
  const groups = [];
  for (const o of items) {
    const d = (o[dateKey] || "").slice(0, 10);
    if (!groups.length || groups[groups.length - 1].date !== d) groups.push({ date: d, rows: [] });
    groups[groups.length - 1].rows.push(o);
  }
  const fmtDay = ds => new Date(ds + "T00:00:00").toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" });
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: C.t1 }}>{title} <span style={{ color: C.t3, fontWeight: 500 }}>({items.length})</span></div>
        {onRange && (
          <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
            {[["today","Dnes"],["today_tomorrow","Dnes+zajtra"],["7d","7 dní"]].map(([k, l]) => (
              <button key={k} onClick={() => onRange(k)} style={{ border: "none", background: range === k ? C.s1 : "transparent", color: range === k ? C.t1 : C.t3, borderRadius: 6, padding: "4px 9px", fontSize: 11, fontWeight: range === k ? 700 : 500, cursor: "pointer", fontFamily: C.font, boxShadow: range === k ? C.shadow : "none" }}>{l}</button>
            ))}
          </div>
        )}
      </div>
      {loading && items.length === 0 ? <Spin size={20} /> : items.length === 0 ? <Empty icon="✓" title={emptyTitle} sub="" /> : groups.map(g => (
        <div key={g.date}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "6px 16px", background: C.s2, borderBottom: `1px solid ${C.border}` }}>
            {g.date === today && <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.07em", color: color }}>DNES</span>}
            <span style={{ fontSize: 11, fontWeight: g.date === today ? 600 : 700, color: C.t3, textTransform: "capitalize" }}>{fmtDay(g.date)}</span>
          </div>
          {g.rows.map(o => {
            const t = (o[dateKey] || "").slice(11, 16);
            const isPast = o[dateKey] && new Date(o[dateKey]) < now;
            const prep = prepData?.[o.id];
            const checked = prep ? Object.values(prep.checklist || {}).filter(Boolean).length : 0;
            const totalLines = prep?.totalLines || 0;
            const ready = totalLines > 0 && checked >= totalLines;
            const tot = totalLines || o.item_count || 0;
            const pickup = dateKey === "starts_at";
            const pct = tot ? Math.round((checked / tot) * 100) : 0;
            const barColor = pct >= 100 ? C.green : pct > 0 ? "#ed8a3c" : null;
            return (
              <div key={o.id} onClick={() => onPick(o)} style={{ display: "flex", flexDirection: "column", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = C.s2}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 16px" }}>
                  <span style={{ fontFamily: C.mono, fontSize: 11.5, fontWeight: 700, color: isPast ? "#c77d0a" : C.t1, background: isPast ? "#fbf1dd" : C.s1, border: `1px solid ${isPast ? "#c77d0a55" : C.border}`, borderRadius: 8, padding: "4px 8px", flexShrink: 0 }}>{t || "—"}</span>
                  <span style={{ width: 30, height: 30, borderRadius: "50%", background: avaColor(o.customer?.name), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{initials(o.customer?.name)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer?.name || "—"}</div>
                    {o.project && <div style={{ fontSize: 11.5, color: C.t3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Projekt: <span style={{ fontWeight: 700, color: C.t2 }}>{o.project}</span></div>}
                    <div style={{ fontSize: 11, fontWeight: 700, marginTop: 1, color: C.t2 }}>
                      {tot} items to {pickup ? "pick up" : "return"}
                      {totalLines > 0 && <span style={{ color: ready ? C.green : "#ed8a3c" }}> · {checked}/{totalLines} pripravené</span>}
                    </div>
                  </div>
                  <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 600, color: C.t2, flexShrink: 0 }}>#{o.number}</span>
                </div>
                {showProgress && (
                  <div style={{ height: 7, background: C.s2, width: "100%" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: barColor || "transparent", transition: "width .3s" }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </Card>
  );
}

function OrderRowSmall({ order: o, onClick }) {
  return (
    <div onClick={onClick} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}`, cursor: onClick ? "pointer" : "default" }}>
      <div>
        <span style={{ color: C.gold, fontFamily: C.mono, fontSize: 12, fontWeight: 700 }}>#{o.number}</span>
        <span style={{ color: C.t1, fontSize: 13, marginLeft: 8 }}>{o.customer?.name || "—"}</span>
      </div>
      <StatusTag tag={orderTag(o)} small />
    </div>
  );
}

function OrderTable({ orders, onSelect }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            {["#", "Zákazník", "Od", "Do", "Status", "Suma", ""].map(h => (
              <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: C.t3, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map(o => (
            <tr key={o.id} onClick={() => onSelect?.(o)} style={{ borderBottom: `1px solid ${C.border}`, cursor: onSelect ? "pointer" : "default", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = C.s2}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <td style={{ padding: "10px 14px", color: C.gold, fontFamily: C.mono, fontWeight: 700 }}>#{o.number}</td>
              <td style={{ padding: "10px 14px", color: C.t1, maxWidth: 160 }}>{o.customer?.name || <span style={{ color: C.t3 }}>—</span>}</td>
              <td style={{ padding: "10px 14px", color: C.t2, fontFamily: C.mono, fontSize: 11 }}>{o.starts_at?.slice(0,10) || "—"}</td>
              <td style={{ padding: "10px 14px", color: C.t2, fontFamily: C.mono, fontSize: 11 }}>{o.stops_at?.slice(0,10) || "—"}</td>
              <td style={{ padding: "10px 14px" }}><StatusTag tag={orderTag(o)} small /></td>
              <td style={{ padding: "10px 14px", color: C.t1, fontFamily: C.mono }}>{o.grand_total_in_cents ? `€${(o.grand_total_in_cents/100).toFixed(0)}` : "—"}</td>
              <td style={{ padding: "10px 14px", color: C.t3 }}>{onSelect ? "›" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ORDERS LIST — with filters and search
// ═══════════════════════════════════════════════
function OrdersList({ nav, initialStatus }) {
  const { allOrders, loadingActive, prepData } = useApp();
  const [q, setQ] = useState("");
  const [st, setSt] = useState(initialStatus || "all");
  const [sort, setSort] = useState("new"); // new | old | amount_desc | amount_asc

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const filtered = allOrders.filter(o => {
      const ms = st === "all" || o.status === st;
      const mq = !ql ||
        String(o.number).includes(ql) ||
        (o.customer?.name || "").toLowerCase().includes(ql) ||
        (o.customer?.email || "").toLowerCase().includes(ql) ||
        (o.tags || []).join(" ").toLowerCase().includes(ql);
      return ms && mq;
    });
    const sorters = {
      new: (a,b) => new Date(b.created_at||0) - new Date(a.created_at||0),
      old: (a,b) => new Date(a.created_at||0) - new Date(b.created_at||0),
      amount_desc: (a,b) => (b.grand_total_in_cents||0) - (a.grand_total_in_cents||0),
      amount_asc: (a,b) => (a.grand_total_in_cents||0) - (b.grand_total_in_cents||0),
    };
    return filtered.sort(sorters[sort]);
  }, [allOrders, q, st, sort]);

  const CAP = 200;
  const chip = (seld) => ({ background: seld ? C.gold : C.s2, color: seld ? "#fff" : C.t2, border: `1px solid ${seld ? C.gold : C.border}`, borderRadius: 7, padding: "5px 11px", fontSize: 11.5, cursor: "pointer", fontWeight: seld ? 700 : 500 });

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Input value={q} onChange={setQ} placeholder="Hľadaj číslo, zákazníka, e-mail, tag…" style={{ flex: 1, minWidth: 220 }} />
        {loadingActive && <Spin size={14} />}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {["all","started","reserved","concept","stopped","archived","canceled"].map(s => (
            <button key={s} onClick={() => setSt(s)} style={chip(st===s)}>{s === "all" ? "Všetky" : STATUS_MAP[s]?.label || s}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.t3 }}>Zoradiť:</span>
          {[["new","Najnovšie"],["old","Najstaršie"],["amount_desc","Suma ↓"],["amount_asc","Suma ↑"]].map(([k,l]) => (
            <button key={k} onClick={() => setSort(k)} style={{ background: sort===k ? C.s3 : "transparent", color: sort===k ? C.t1 : C.t3, border: `1px solid ${sort===k ? C.borderHi : "transparent"}`, borderRadius: 6, padding: "4px 9px", fontSize: 11, cursor: "pointer", fontWeight: sort===k?600:400 }}>{l}</button>
          ))}
        </div>
      </div>

      {loadingActive && list.length === 0 ? <Card><Spin /></Card> : list.length === 0
        ? <Card><Empty icon="🔍" title="Žiadne výsledky" sub="Zmeňte filter alebo hľadanie" /></Card>
        : <div style={{ display: "grid", gap: 9 }}>
          {list.slice(0, CAP).map(o => (
            <OrderCard key={o.id} o={o} prep={prepData?.[o.id]} onClick={() => nav("order_detail", o.id)}
              meta={o.grand_total_in_cents > 0
                ? <><div style={{ fontFamily: C.mono, fontWeight: 700, color: C.t1, fontSize: 14 }}>€{Math.round(o.grand_total_in_cents/100).toLocaleString("sk-SK")}</div>
                    {o.item_count > 0 && <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>{o.item_count} ks</div>}</>
                : o.item_count > 0 ? <div style={{ fontSize: 11, color: C.t3 }}>{o.item_count} ks</div> : null} />
          ))}
        </div>
      }
      <div style={{ color: C.t3, fontSize: 11, marginTop: 8 }}>
        {list.length > CAP ? `Zobrazených ${CAP} z ${list.length.toLocaleString("sk-SK")} objednávok` : `${list.length.toLocaleString("sk-SK")} objednávok`}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ORDER DETAIL
// ═══════════════════════════════════════════════
function OrderDetail({ orderId, nav }) {
  const { activeOrders, recentOrders, display } = useApp();
  const collapsed = display.bundleView === "collapsed";
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [byCat, setByCat] = useState(true);
  const [bundleOpen, setBundleOpen] = useState({});
  const cached = [...activeOrders, ...recentOrders].find(o => o.id === orderId);

  useEffect(() => {
    api.orders.get(orderId)
      .then(d => setFull(d.order || d))
      .catch(() => setFull(cached))
      .finally(() => setLoading(false));
  }, [orderId]);

  const o = full || cached;
  if (!o && loading) return <Spin />;
  if (!o) return <Empty icon="?" title="Objednávka nenájdená" sub="" />;
  // Identifikátor (SKU): koncept = cenová ponuka, inak potvrdená objednávka.
  const isQuote = ["concept", "draft", "new"].includes(o.status);
  const showId = isQuote ? (display.idQuotes ?? false) : (display.idOrders ?? false);

  const lines = orderedLines(o);
  const planById = (o?.plannings || []).reduce((m, p) => {
    m[p.id] = { sku: p.product?.sku || null, photo_url: p.product?.photo_url || null,
      zlava: parseFloat(p.product?.custom_fields?.zlava) || 0,
      stock_items: (p.stock_item_plannings || []).map(s => ({ id: s.stock_item_id, identifier: s.stock_item?.identifier || null, status: s.stock_item?.status || null })) };
    return m;
  }, {});
  const dur = o.starts_at && o.stops_at ? Math.ceil((new Date(o.stops_at)-new Date(o.starts_at))/86400000) : null;
  // Cenotvorba ako Booqable: bundle = nadpis (cena = súčet komponentov po zľave),
  // cena sa zobrazuje iba pri produktoch. Medzisúčet = súčet listových riadkov
  // (komponenty + samostatné produkty), aby sa bundle nerátal 2×.
  const kidsOf = {};
  for (const l of lines) if (l.parent_line_id) (kidsOf[l.parent_line_id] = kidsOf[l.parent_line_id] || []).push(l);
  const isBundleParent = (l) => (kidsOf[l.id] || []).length > 0;
  const lineNet = (l) => (l.price_with_discount_in_cents ?? l.price_in_cents ?? 0);
  // Zľava: order-level = projektová zľava (na konci). Line zľava len ak sa líši
  // od projektovej (bundle / manuálna). Riadok ukazuje GROSS, projektová zľava
  // sa odráta až z medzisúčtu.
  const orderDiscPct = o.discount_percentage || 0;
  const isSpecialDisc = (l) => { const ld = l.discount_percentage || 0; return ld > 0 && Math.abs(ld - orderDiscPct) > 0.01; };
  const shownTotal = (l) => isSpecialDisc(l) ? lineNet(l) : (l.price_in_cents || 0);
  const medzisucet = lines.filter(l => l.line_type !== "section" && !isBundleParent(l)).reduce((s, l) => s + shownTotal(l), 0);
  const projectDiscCents = o.discount_in_cents || 0;
  const taxCents = o.tax_in_cents || 0;
  const totalWithTax = o.grand_total_with_tax_in_cents || (medzisucet - projectDiscCents + taxCents);
  // Produktová "zľava" = custom field `zlava` na produkte (fiktívna, marketingová).
  // NERÁTA sa do súčtov — len ukazuje, o koľko by bolo bez zliav drahšie.
  const prodZlava = (l) => planById[l.planning_id]?.zlava || 0;
  const bundleZlava = (l) => Math.max(0, ...(kidsOf[l.id] || []).map(prodZlava), 0);
  const leafLines = lines.filter(l => l.line_type !== "section" && !isBundleParent(l));
  const bezZliav = Math.round(leafLines.reduce((s, l) => { const z = prodZlava(l), g = l.price_in_cents || 0; return s + (z > 0 && z < 100 ? g / (1 - z / 100) : g); }, 0));
  const usetrili = Math.max(0, bezZliav - medzisucet);
  const zVals = leafLines.map(prodZlava).filter(z => z > 0);
  const avgZlava = zVals.length ? Math.round(zVals.reduce((a, b) => a + b, 0) / zVals.length) : 0;
  // per-bundle expand/collapse (default podľa globálneho nastavenia)
  const bOpen = (id) => bundleOpen[id] !== undefined ? bundleOpen[id] : !collapsed;
  const toggleB = (id) => setBundleOpen(s => ({ ...s, [id]: !bOpen(id) }));

  // Zákazník + custom fields
  const cust = o.customer || {};
  const cprops = cust.properties || [];
  const cval = (id) => cprops.find(p => p.identifier === id)?.value;
  const phone = cval("phone");
  const ico = cval("ico"), dic = cval("dic");
  const address = cval("main_address")?.split("\n").map(s => s.trim()).filter(Boolean).join(", ")
    || [cust.address1, cust.zipcode, cust.city].filter(Boolean).join(", ");
  const oprops = o.properties || [];
  const oval = (id) => oprops.find(p => p.identifier === id)?.value || o.properties_attributes?.[id];
  const project = oval("nazov_projektu");
  // poznamka (custom field) je text; o.notes z Booqable je pole note-objektov {body,…}.
  const noteText = (n) => Array.isArray(n) ? n.map(x => x?.body || x).filter(x => typeof x === "string").join("\n")
    : (n && typeof n === "object") ? (n.body || "") : (n || "");
  const orderNote = oval("poznamka") || noteText(o.notes);
  const crew = [["Potvrdil", "objednavku_potvrdil"], ["Pripravil", "objednavku_pripravil"], ["Vydal", "techniku_vydal"], ["Prevzal", "techniku_prevzal"], ["Kontrola", "kontrola_techniky"], ["Čistenie", "cistenie_techniky"], ["Prep bay", "prep_bay"]]
    .map(([l, id]) => [l, oval(id)]).filter(([, v]) => v);

  const KV = ({ label, value }) => value ? (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: C.t3, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 13, color: C.t1, fontWeight: 600, marginTop: 1, wordBreak: "break-word" }}>{value}</div>
    </div>
  ) : null;

  // Cenové stĺpce riadku objednávky (Ks · Denná sadzba · Zľava · Dni · Celkom)
  const COLS = [["Ks", 52], ["Denná sadzba", 80], ["Zľava", 52], ["Dni", 58], ["Celkom", 82]];
  const RightCols = ({ ks, rate, disc, dni, total, faded }) => (
    <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
      <div style={{ width: 52, textAlign: "center", fontFamily: C.mono, fontSize: 12, color: C.t2 }}>{ks != null ? `${ks} ks` : ""}</div>
      <div style={{ width: 80, textAlign: "center", fontFamily: C.mono, fontSize: 12, color: C.t2 }}>{rate || ""}</div>
      <div style={{ width: 52, textAlign: "center" }}>{disc > 0 ? <span style={{ background: "#fdeaea", color: C.red, fontWeight: 800, fontSize: 10, borderRadius: 6, padding: "2px 5px" }}>−{Math.round(disc)}%</span> : ""}</div>
      <div style={{ width: 58, textAlign: "center", fontFamily: C.mono, fontSize: 11.5, color: C.t2 }}>{dni || ""}</div>
      <div style={{ width: 82, textAlign: "right", fontFamily: C.display, fontWeight: 700, fontSize: 13, color: faded ? C.t3 : C.t1 }}>{total || ""}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 940 }}>
      {/* Header */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}>
        <Btn v="ghost" onClick={() => nav("orders")}>← Späť</Btn>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: C.t1, fontFamily: C.display, fontSize: 20, fontWeight: 800 }}>Objednávka</span>
          <span style={{ color: C.gold, fontFamily: C.display, fontSize: 18, fontWeight: 800 }}>#{o.number}</span>
          <StatusTag tag={orderTag(o)} />
          <ProdTagPicker orderId={o.id} />
          {project && <span style={{ fontSize: 13, color: C.t2, fontWeight: 600 }}>· Projekt: <span style={{ color: C.t1, fontWeight: 800 }}>{project}</span></span>}
        </div>
        <Btn v="ghost" onClick={() => window.open(`https://${CFG.SLUG}.booqable.com/back/orders/${o.id}`, "_blank")}>↗ Booqable</Btn>
      </div>

      {/* Karta zákazníka */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <span style={{ width: 44, height: 44, borderRadius: "50%", background: avaColor(cust.name), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, flexShrink: 0 }}>{initials(cust.name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 17, color: C.t1 }}>{cust.name || "—"}</div>
            <div style={{ fontSize: 12, color: C.t3, marginTop: 1 }}>{[cust.legal_type === "business" ? "Firma" : "Súkromná osoba", cust.order_count != null ? `${cust.order_count} objednávok` : null].filter(Boolean).join(" · ")}</div>
          </div>
          <Btn v="ghost" onClick={() => nav("customers")} style={{ fontSize: 11 }}>Profil →</Btn>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
          <KV label="Email" value={cust.email} />
          <KV label="Telefón" value={phone} />
          <KV label="Adresa" value={address} />
          <KV label="IČO" value={ico} />
          <KV label="DIČ" value={dic} />
        </div>
      </Card>

      {/* Dátumy + poznámka + workflow */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <DateRange from={o.starts_at} to={o.stops_at} />
          {dur != null && <div style={{ fontSize: 13, color: C.t2 }}>Trvanie <b style={{ color: C.t1, fontFamily: C.display }}>{dur} {dur === 1 ? "deň" : "dní"}</b></div>}
          {o.starts_at && <div style={{ fontSize: 12, color: C.t3 }}>{o.starts_at.slice(11, 16)} – {o.stops_at?.slice(11, 16)}</div>}
        </div>
        {orderNote && (
          <div style={{ marginTop: 12, background: C.s2, borderRadius: 9, padding: "10px 13px", fontSize: 13, color: C.t1, whiteSpace: "pre-wrap" }}>
            <span style={{ fontSize: 9.5, color: C.t3, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", display: "block", marginBottom: 3 }}>Poznámka k objednávke</span>
            {orderNote}
          </div>
        )}
        {crew.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
            {crew.map(([l, v]) => <KV key={l} label={l} value={v} />)}
          </div>
        )}
      </Card>

      {/* Zoznam techniky — celá šírka */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
          <div style={{ fontFamily: C.display, fontSize: 14, color: C.t1, fontWeight: 800 }}>Technika ({lines.filter(l => !l.parent_line_id).length})</div>
          <CatToggle on={byCat} set={setByCat} />
        </div>
        {loading ? <Spin size={20} /> : lines.length === 0
            ? <Empty icon="📦" title="Žiadne položky" sub="" />
            : <>
              {/* hlavička tabuľky */}
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10, padding: "0 4px 8px 0", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.05em", color: C.t3, textTransform: "uppercase" }}>
                <div style={{ flex: 1 }}>Položka</div>
                <div style={{ display: "flex", alignItems: "flex-end", flexShrink: 0 }}>
                  {COLS.map(([l, w], i) => <div key={l} style={{ width: w, textAlign: i === COLS.length - 1 ? "right" : "center", lineHeight: 1.15 }}>{l}</div>)}
                </div>
              </div>
              {groupGearLines(lines, sectionsOf(o), byCat ? "category" : "order").map(([cat, gls]) => {
                const gcolor = catColor(cat);
                return (
                  <div key={cat || "all"}>
                    {cat && <CatPill name={cat} color={gcolor} right={<span style={{ fontSize: 11, color: C.t3 }}>{gls.filter(l => !l.parent_line_id).length} pol.</span>} />}
                    {gls.map(l => {
                      // Bundle = nadpis so šípkou (rozbaliť/zbaliť). Zbalený → cena setu (gross) vpravo.
                      if (isBundleParent(l)) {
                        const qty = Math.round(l.quantity || 0);
                        const kids = kidsOf[l.id] || [];
                        const open = bOpen(l.id);
                        const thumb = planById[kids[0]?.planning_id]?.photo_url || planById[l.planning_id]?.photo_url;
                        // Cenotvorba je celá na riadku bundle (set sa účtuje ako celok)
                        const bDays = chargeDays(l.charge_label);
                        const bRate = l.price_each_in_cents > 0 ? (bDays > 0 ? l.price_each_in_cents / bDays : l.price_each_in_cents) : 0;
                        const bDni = /\d/.test(l.charge_label || "") ? daysLabel(bDays) : (l.charge_label || "1 deň");
                        const bTotal = shownTotal(l);
                        return (
                          <div key={l.id} onClick={() => toggleB(l.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px 10px 0", borderBottom: `1px solid ${C.border}`, background: C.s2, cursor: "pointer" }}>
                            <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, background: gcolor, flexShrink: 0, minHeight: 34 }} />
                            <span style={{ width: 16, textAlign: "center", color: C.t3, fontSize: 11, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
                            {thumb
                              ? <img src={thumb} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", flexShrink: 0, border: `1px solid ${C.border}` }} />
                              : <div style={{ width: 34, height: 34, borderRadius: 7, background: C.s1, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>🎬</div>}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 14, color: C.t1 }}>{l.title}</div>
                              <div style={{ fontSize: 10.5, color: C.t3, fontWeight: 700, letterSpacing: "0.04em" }}>SET · {kids.length} položiek</div>
                            </div>
                            <RightCols ks={qty} rate={bRate > 0 ? eur(bRate) : null} disc={bundleZlava(l)} dni={bDni} total={eur(bTotal)} faded={bTotal === 0} />
                          </div>
                        );
                      }
                      // dieťa skrytého bundle
                      if (l.parent_line_id && !bOpen(l.parent_line_id)) return null;
                      const serials = (planById[l.planning_id]?.stock_items || []).filter(s => s.identifier);
                      const isChild = !!l.parent_line_id;
                      const plan = planById[l.planning_id];
                      const days = chargeDays(l.charge_label);
                      const dailyRate = l.price_each_in_cents > 0 ? (days > 0 ? l.price_each_in_cents / days : l.price_each_in_cents) : 0;
                      const dniLabel = /\d/.test(l.charge_label || "") ? daysLabel(days) : (l.charge_label || "1 deň");
                      const total = shownTotal(l);
                      return (
                        <div key={l.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 4px 9px 0", marginLeft: isChild ? 26 : 0, borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, background: gcolor, opacity: isChild ? 0.4 : 1, flexShrink: 0, minHeight: 34 }} />
                          {plan?.photo_url
                            ? <img src={plan.photo_url} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", flexShrink: 0, border: `1px solid ${C.border}` }} />
                            : <div style={{ width: 34, height: 34, borderRadius: 7, background: C.s2, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>🎬</div>}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: C.display, fontSize: 13.5, fontWeight: isChild ? 700 : 800, color: C.t1, lineHeight: 1.25 }}>{l.title}</div>
                            {showId && plan?.sku && <div style={{ fontSize: 10.5, color: C.t3, fontFamily: C.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{plan.sku}</div>}
                            {showId && serials.length > 0 && <SerialPicker units={serials} selectedIds={serials.map(s => s.id)} lockedIds={serials.map(s => s.id)} interactive={false} />}
                          </div>
                          {/* dieťa bundle = len počet ks; samostatný produkt = celá cenotvorba */}
                          <RightCols ks={Math.round(l.quantity || 0)} rate={isChild ? null : (dailyRate > 0 ? eur(dailyRate) : null)} disc={isChild ? 0 : prodZlava(l)} dni={isChild ? "" : dniLabel} total={isChild ? "" : eur(total)} faded={total === 0} />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {/* Totals — riadky sú GROSS; projektová zľava sa odráta z medzisúčtu */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: `2px solid ${C.border}` }}>
                {[
                  ["Medzisúčet", eur(medzisucet), {}],
                  usetrili > 0 && ["Bežná cena (bez zliav)", eur(bezZliav), { strike: true }],
                  usetrili > 0 && [`Produktové zľavy (⌀ −${avgZlava} %) · ušetrili ste`, eur(usetrili), { green: true }],
                  projectDiscCents > 0 && [`Projektová zľava (−${Math.round(orderDiscPct)} %)`, "−" + eur(projectDiscCents), { red: true }],
                  taxCents > 0 && ["DPH 23 %", eur(taxCents), {}],
                  ["Spolu", eur(totalWithTax), { bold: true }],
                  o.deposit_in_cents > 0 && ["Záloha", eur(o.deposit_in_cents), {}],
                ].filter(Boolean).map(([k, v, opt]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: opt.bold ? 15 : 13 }}>
                    <span style={{ color: opt.red ? C.red : opt.green ? C.green : (opt.bold ? C.t1 : C.t2), fontWeight: opt.bold ? 800 : 600, fontFamily: opt.bold ? C.display : C.font, textDecoration: opt.strike ? "line-through" : "none" }}>{k}</span>
                    <span style={{ color: opt.red ? C.red : opt.green ? C.green : C.t1, fontWeight: opt.bold ? 800 : 700, fontFamily: C.display, textDecoration: opt.strike ? "line-through" : "none" }}>{v}</span>
                  </div>
                ))}
              </div>
            </>
          }
        </Card>

      <Card>
        <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>AKCIE</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {o.status === "reserved" && <Btn v="orange" onClick={() => nav("picking", o.id)}>→ Spustiť prípravu výdaja</Btn>}
          {o.status === "started"  && <Btn v="success" onClick={() => nav("checkin", o.id)}>← Príjem techniky</Btn>}
          <Btn v="ghost" onClick={() => window.open(`https://${CFG.SLUG}.booqable.com/back/orders/${o.id}`, "_blank")}>↗ Otvoriť v Booqable</Btn>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════
// PICKING MODULE
// ═══════════════════════════════════════════════
function PickingModule({ initialOrderId, nav }) {
  const { activeOrders, prepData, savePrepData, loadingActive } = useApp();
  const [selectedId, setSelectedId] = useState(initialOrderId || null);

  const today = todayStr();
  // Len RESERVED — koncepty/drafty sa do prípravy výdaja nedostanú.
  const pickOrders = activeOrders
    .filter(o => o.status === "reserved")
    .sort((a,b) => {
      const ta = a.starts_at?.slice(0,10) === today ? 0 : 1;
      const tb = b.starts_at?.slice(0,10) === today ? 0 : 1;
      return ta - tb || new Date(a.starts_at||0) - new Date(b.starts_at||0);
    });

  if (selectedId) {
    const order = activeOrders.find(o => o.id === selectedId);
    if (order) return <PickingWorkflow order={order} onBack={() => setSelectedId(null)} prepData={prepData} savePrepData={savePrepData} />;
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", color: C.t1, fontFamily: C.display, fontSize: 18, fontWeight: 800 }}>Príprava výdaja</h2>
      <p style={{ margin: "0 0 20px", color: C.t2, fontSize: 13 }}>Rezervácie čakajúce na prípravu a výdaj — {pickOrders.length}</p>
      {loadingActive ? <Spin /> : pickOrders.length === 0
        ? <Empty icon="🎬" title="Žiadne objednávky na prípravu" sub="Všetky rezervácie sú vydané alebo neexistujú" />
        : <div style={{ display: "grid", gap: 9 }}>
          {pickOrders.map(o => {
            const prep = prepData[o.id] || {};
            const checked = Object.values(prep.checklist || {}).filter(Boolean).length;
            const totalLines = prep.totalLines || 0;
            const pct = totalLines > 0 ? Math.round((checked/totalLines)*100) : 0;
            const isToday = o.starts_at?.slice(0,10) === today;
            return (
              <OrderCard key={o.id} o={o} prep={prep} onClick={() => setSelectedId(o.id)}
                fullBar={totalLines > 0 ? pct : 0}
                markers={isToday && <span style={{ background: "#fbf1dd", color: "#c77d0a", fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 6 }}>DNES</span>}
                meta={<div style={{ fontSize: 11, color: C.t3 }}>{totalLines > 0 ? `${checked}/${totalLines} pol.` : `${o.item_count || 0} ks`}</div>} />
            );
          })}
        </div>
      }
    </div>
  );
}

function PickingWorkflow({ order: o, onBack, prepData, savePrepData }) {
  const { display } = useApp();
  const showId = display.idPicking ?? true;
  const [orderFull, setOrderFull] = useState(null);
  const [loadingFull, setLoadingFull] = useState(true);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [scanFeedback, setScanFeedback] = useState(null);
  const [byCat, setByCat] = useState(true);
  const grouping = byCat ? "category" : "order";
  // Vo Výdaji sú bundly vždy rozbalené (kontrola položiek); klik na hlavičku ich zbalí.
  const [bundleColl, setBundleColl] = useState({});
  const bOpen = (id) => !bundleColl[id];
  const toggleBundleOpen = (id) => setBundleColl(s => ({ ...s, [id]: !s[id] }));
  const barcodeRef = useRef();

  const prep = prepData[o.id] || { state: "prepping", checklist: {}, delivered: {}, notes: "", issues: [] };
  const lines = orderedLines(orderFull);
  const planById = (orderFull?.plannings || []).reduce((m, p) => { m[p.id] = p; return m; }, {});
  // mapa rodič → deti (bundle)
  const kidsOf = {};
  for (const l of lines) if (l.parent_line_id) (kidsOf[l.parent_line_id] = kidsOf[l.parent_line_id] || []).push(l);
  const isBundleParent = (l) => (kidsOf[l.id] || []).length > 0;
  // Reálne sekcie z Booqable objednávky (CAMERA, LENSES, FILTERS…) — ak
  // existujú, triedi sa podľa nich; keyword kategórie sú len fallback.
  const orderSections = (orderFull?.lines || [])
    .filter(l => l.line_type === "section" && l.title?.trim())
    .sort((a, b) => (a.position || 0) - (b.position || 0));

  const [unitsByProd, setUnitsByProd] = useState({});

  useEffect(() => {
    api.orders.getDetail(o)
      .then(setOrderFull)
      .catch(() => {})
      .finally(() => setLoadingFull(false));
  }, [o.id]);

  // Načítaj fyzické kusy (stock items) pre trackovateľné produkty v objednávke
  useEffect(() => {
    if (!orderFull) return;
    const pids = [...new Set((orderFull.plannings || []).filter(p => p.trackable && p.item_id).map(p => p.item_id))];
    if (!pids.length) return;
    let alive = true;
    Promise.all(pids.map(pid => api.products.units(pid).then(u => [pid, u]).catch(() => null)))
      .then(res => { if (!alive) return; const m = {}; for (const r of res) if (r) m[r[0]] = r[1]; setUnitsByProd(m); });
    return () => { alive = false; };
  }, [orderFull]);

  const save = (patch) => savePrepData({ ...prepData, [o.id]: { ...prep, totalLines: lines.length || prep.totalLines || 0, ...patch } });

  // Trackovateľná položka qty N vyžaduje výber N konkrétnych kusov. Výber je
  // prednastavený kusmi priradenými v Booqable, ale dá sa meniť (× odoberie,
  // klik na sivý dostupný kus pridá).
  const assignedOf = (l) => (planById[l.planning_id]?.stock_items || []).map(s => s.id);
  const selOf = (l) => { const v = prep.units?.[l.id]; return v !== undefined ? v : assignedOf(l); };
  const reqSerials = (l) => (planById[l.planning_id]?.trackable ? Math.round(l.quantity || 0) : 0);
  const lineReady = (l) => reqSerials(l) === 0 || selOf(l).length >= reqSerials(l);
  const addUnit = (l, id) => save({ units: { ...(prep.units || {}), [l.id]: [...new Set([...selOf(l), id])] } });
  const removeUnit = (l, id) => save({ units: { ...(prep.units || {}), [l.id]: selOf(l).filter(x => x !== id) } });
  const unitsForLine = (l) => {
    const plan = planById[l.planning_id];
    const fromApi = unitsByProd[plan?.item_id];
    if (fromApi?.length) return fromApi;
    // fallback kým sa nenačíta zoznam: aspoň priradené kusy
    return (plan?.stock_items || []).map(s => ({ id: s.id, identifier: s.identifier, status: s.status || "picked up" }));
  };

  // Bundle: počet pripravených detí, % a stav celého bundlu
  const bundleKids = (l) => kidsOf[l.id] || [];
  const bundleChecked = (l) => bundleKids(l).filter(k => prep.checklist[k.id]).length;
  const bundleDone = (l) => { const k = bundleKids(l); return k.length > 0 && k.every(x => prep.checklist[x.id]); };
  const bundleFill = (l) => { const k = bundleKids(l); return k.length ? bundleChecked(l) / k.length : 0; };

  // Klik na bundle checkbox → zaškrtne/odškrtne všetky deti (pripravené iba tie,
  // čo majú vybrané sériové čísla). Parent sa zaškrtne keď sú hotové všetky deti.
  const toggleBundle = (parent) => {
    const kids = bundleKids(parent);
    const next = { ...prep.checklist };
    if (bundleDone(parent)) {
      kids.forEach(k => next[k.id] = false); next[parent.id] = false;
    } else {
      let blocked = 0;
      kids.forEach(k => { if (lineReady(k)) next[k.id] = true; else blocked++; });
      next[parent.id] = kids.every(k => next[k.id]);
      if (blocked) { setScanFeedback({ ok: false, msg: `${blocked} ks treba najprv vybrať sériové čísla` }); setTimeout(() => setScanFeedback(null), 2600); }
    }
    save({ checklist: next, state: lines.every(l2 => next[l2.id]) ? "ready" : "prepping" });
  };

  const toggleLine = (id) => {
    const l = lines.find(x => x.id === id);
    if (l && isBundleParent(l)) return toggleBundle(l);
    const turningOn = !prep.checklist[id];
    if (turningOn && l && !lineReady(l)) {
      setScanFeedback({ ok: false, msg: `Najprv vyber kusy (${selOf(l).length}/${reqSerials(l)})` });
      setTimeout(() => setScanFeedback(null), 2600);
      return;
    }
    const next = { ...prep.checklist, [id]: !prep.checklist[id] };
    // dieťa zmení stav → prepočítaj rodiča (auto-zaškrtnutie keď sú všetky deti)
    if (l?.parent_line_id) { const kids = kidsOf[l.parent_line_id] || []; next[l.parent_line_id] = kids.every(k => next[k.id]); }
    save({ checklist: next, state: lines.every(l2 => next[l2.id]) ? "ready" : "prepping" });
  };
  const handleScan = (val) => {
    const v = val.trim();
    if (!v) return;
    const vl = v.toLowerCase();
    // 1) skenovanie sériového čísla konkrétneho kusu → vyber ten kus na riadku
    for (const l of lines) {
      const unit = unitsForLine(l).find(u => u.identifier?.toLowerCase() === vl);
      if (unit) {
        if (!selOf(l).includes(unit.id)) addUnit(l, unit.id);
        const willHave = [...new Set([...selOf(l), unit.id])].length;
        if (willHave >= reqSerials(l)) {
          const next = { ...prep.checklist, [l.id]: true };
          save({ checklist: next, units: { ...(prep.units || {}), [l.id]: [...new Set([...selOf(l), unit.id])] }, state: lines.every(x => next[x.id]) ? "ready" : "prepping" });
        }
        setScanFeedback({ ok: true, msg: `✓ ${unit.identifier} → ${l.title}` });
        setBarcodeInput(""); setTimeout(() => setScanFeedback(null), 2500); barcodeRef.current?.focus();
        return;
      }
    }
    // 2) inak skús nájsť položku podľa názvu/SKU a zaškrtni (ak netrackovateľná / pripravená)
    const match = lines.find(l => !prep.checklist[l.id] && lineReady(l) && (
      l.title?.toLowerCase().includes(vl) || planById[l.planning_id]?.sku?.toLowerCase().includes(vl)
    ));
    if (match) {
      const next = { ...prep.checklist, [match.id]: true };
      save({ checklist: next, state: lines.every(l => next[l.id]) ? "ready" : "prepping" });
      setScanFeedback({ ok: true, msg: `✓ ${match.title}` });
    } else {
      setScanFeedback({ ok: false, msg: `Nenájdené: "${v}"` });
    }
    setBarcodeInput("");
    setTimeout(() => setScanFeedback(null), 2500);
    barcodeRef.current?.focus();
  };

  const checked = lines.filter(l => prep.checklist[l.id]).length;
  const pct = lines.length > 0 ? Math.round((checked/lines.length)*100) : 0;
  const allDone = pct === 100 && lines.length > 0;
  const hasOpenIssues = (prep.issues||[]).some(i => !i.resolved);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={onBack}>← Späť</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: C.display, fontSize: 19, fontWeight: 800, color: C.t1 }}>Príprava výdaja <span style={{ color: C.gold, fontFamily: C.mono }}>#{o.number}</span>{o.project && <span style={{ fontSize: 13, color: C.t2, fontWeight: 600 }}> · Projekt: <span style={{ color: C.t1, fontWeight: 800 }}>{o.project}</span></span>}</div>
          <div style={{ color: C.t2, fontSize: 13 }}>{o.customer?.name} · {fmtDate(o.starts_at)} → {fmtDate(o.stops_at)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: C.gold, fontFamily: C.mono, fontSize: 22, fontWeight: 800 }}>{pct}%</div>
          <div style={{ color: C.t3, fontSize: 11 }}>{checked}/{lines.length} pripravené</div>
        </div>
      </div>
      <ProgressBar pct={pct} />
      <div style={{ height: 16 }} />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>🔍 SKENER / HĽADANIE</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Input ref={barcodeRef} value={barcodeInput} onChange={setBarcodeInput} placeholder="Barcode, SKU alebo názov…" style={{ flex: 1 }} />
          <Btn v="primary" onClick={() => handleScan(barcodeInput)}>Potvrď</Btn>
        </div>
        {scanFeedback && <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 7, background: scanFeedback.ok ? "#e4f5ec" : "#fdeaea", color: scanFeedback.ok ? C.green : C.red, fontSize: 13, fontWeight: 600 }}>{scanFeedback.msg}</div>}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontFamily: C.display, fontSize: 13, color: C.t1, fontWeight: 800 }}>Technika ({lines.length})</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <CatToggle on={byCat} set={setByCat} />
              <Btn v="ghost" onClick={() => { const cl = {}; for (const l of lines) if (lineReady(l)) cl[l.id] = true; save({ checklist: cl, state: lines.every(l => cl[l.id]) ? "ready" : "prepping" }); }}>✓ Všetko</Btn>
              <Btn v="ghost" onClick={() => save({ checklist: {}, state: "prepping" })}>Reset</Btn>
            </div>
          </div>
          {loadingFull ? <Spin size={20} /> : lines.length === 0
            ? <Empty icon="📦" title="Žiadne položky" sub="" />
            : groupGearLines(lines, orderSections, grouping).map(([cat, gls]) => {
              const gcolor = catColor(cat);
              return (
                <div key={cat || "all"}>
                  {cat && <CatPill name={cat} color={gcolor} right={
                    <span style={{ fontSize: 11, color: gls.every(l => prep.checklist[l.id]) ? C.green : C.t3, fontWeight: 700 }}>{gls.filter(l => prep.checklist[l.id]).length}/{gls.length}</span>
                  } />}
                  {gls.map(l => {
                    const bundle = isBundleParent(l);
                    if (bundle) {
                      const done = bundleDone(l);
                      const kids = kidsOf[l.id] || [];
                      const open = bOpen(l.id);
                      const partial = !done && bundleChecked(l) > 0;
                      const fillPct = bundleFill(l);
                      const thumb = planById[kids[0]?.planning_id]?.photo_url;
                      return (
                        <div key={l.id} onClick={() => toggleBundleOpen(l.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px 10px 0", borderBottom: `1px solid ${C.border}`, background: C.s2, cursor: "pointer" }}>
                          <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, background: `${gcolor}26`, position: "relative", overflow: "hidden", flexShrink: 0, minHeight: 34 }}>
                            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${Math.round(Math.min(1, fillPct) * 100)}%`, background: gcolor, borderRadius: 3, transition: "height .4s ease" }} />
                          </div>
                          <span style={{ width: 16, textAlign: "center", color: C.t3, fontSize: 11, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
                          {thumb
                            ? <img src={thumb} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", flexShrink: 0, border: `1px solid ${C.border}` }} />
                            : <div style={{ width: 34, height: 34, borderRadius: 7, background: C.s1, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>🎬</div>}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 14, color: C.t1 }}>{l.title}</div>
                            <div style={{ fontSize: 10.5, color: C.t3, fontWeight: 700, letterSpacing: "0.04em" }}>SET · {kids.length} položiek · {bundleChecked(l)}/{kids.length} hotových</div>
                          </div>
                          <div onClick={e => { e.stopPropagation(); toggleLine(l.id); }} title="Označiť celý set" style={{ width: 26, height: 26, borderRadius: 7, border: `2px solid ${done ? C.green : C.borderHi}`, background: done ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: done ? "#fff" : C.gold, fontWeight: 900, flexShrink: 0 }}>{done ? "✓" : partial ? "–" : ""}</div>
                        </div>
                      );
                    }
                    if (l.parent_line_id && !bOpen(l.parent_line_id)) return null;
                    const done = !!prep.checklist[l.id];
                    const plan = planById[l.planning_id];
                    const req = reqSerials(l);
                    const ready = lineReady(l);
                    return (
                      <GearRow key={l.id} line={l} plan={plan} color={gcolor} done={done} showId={showId} onClick={() => toggleLine(l.id)}
                        right={
                          <div style={{ width: 26, height: 26, borderRadius: 7, border: `2px solid ${done ? C.green : (ready ? C.borderHi : C.border)}`, background: done ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: done ? "#fff" : C.gold, fontWeight: 900, flexShrink: 0, marginTop: 2, opacity: ready || done ? 1 : 0.5 }}>{done ? "✓" : ""}</div>
                        }>
                        {req > 0 && (
                          <div onClick={e => e.stopPropagation()}>
                            <SerialPicker units={unitsForLine(l)} selectedIds={selOf(l)} required={req}
                              onAdd={id => addUnit(l, id)} onRemove={id => removeUnit(l, id)} />
                          </div>
                        )}
                      </GearRow>
                    );
                  })}
                </div>
              );
            })
          }
          {allDone && !hasOpenIssues && <div style={{ marginTop: 14, background: "#e4f5ec", border: `1px solid ${C.green}55`, borderRadius: 8, padding: "12px 16px", color: C.green, fontSize: 14, fontWeight: 600, textAlign: "center" }}>✓ Všetká technika skontrolovaná — pripravené na výdaj</div>}
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>📝 POZNÁMKY</div>
            <textarea value={prep.notes || ""} onChange={e => save({ notes: e.target.value })} placeholder="Poznámky k príprave…" style={{ width: "100%", boxSizing: "border-box", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 7, padding: "10px 12px", color: C.t1, fontSize: 13, resize: "vertical", minHeight: 80, outline: "none", fontFamily: C.font }} />
          </Card>
          <Card style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>⚠ PROBLÉMY</div>
            <IssueTracker issues={prep.issues||[]}
              onAdd={(t) => save({ issues: [...(prep.issues||[]), { id: Date.now(), text: t, ts: new Date().toISOString(), resolved: false }], state: "issue" })}
              onResolve={(id) => save({ issues: prep.issues.map(i => i.id===id ? {...i, resolved:true} : i) })}
            />
          </Card>
          <Card style={{ background: allDone && !hasOpenIssues ? "#e4f5ec" : C.s1, borderColor: allDone && !hasOpenIssues ? `${C.green}55` : C.border }}>
            <Btn v={allDone && !hasOpenIssues ? "success" : "ghost"} disabled={!allDone || hasOpenIssues}
              onClick={() => { save({ state: "ready", completedAt: new Date().toISOString() }); alert(`Objednávka #${o.number} pripravená na výdaj!\n\nVydajte techniku v Booqable a zmeňte status na "Started".`); }}
              style={{ width: "100%" }}>
              {allDone && !hasOpenIssues ? "✓ Potvrdiť — pripravené na výdaj" : `Dokonči prípravu (${checked}/${lines.length})`}
            </Btn>
          </Card>
        </div>
      </div>
    </div>
  );
}

function IssueTracker({ issues, onAdd, onResolve }) {
  const [text, setText] = useState("");
  const open = issues.filter(i => !i.resolved);
  const done = issues.filter(i => i.resolved);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <Input value={text} onChange={setText} placeholder="Popíš problém…" style={{ flex: 1, fontSize: 12 }} />
        <Btn v="danger" onClick={() => { onAdd(text); setText(""); }} disabled={!text.trim()}>+</Btn>
      </div>
      {open.length === 0 && done.length === 0 && <div style={{ color: C.t3, fontSize: 12 }}>Žiadne problémy ✓</div>}
      {open.map(i => (
        <div key={i.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.red }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: C.t1 }}>{i.text}</div>
            <div style={{ fontSize: 10, color: C.t3 }}>{new Date(i.ts).toLocaleTimeString("sk-SK")}</div>
          </div>
          <Btn v="success" onClick={() => onResolve(i.id)} style={{ fontSize: 11, padding: "3px 8px" }}>✓</Btn>
        </div>
      ))}
      {done.length > 0 && <div style={{ marginTop: 8 }}>{done.map(i => <div key={i.id} style={{ fontSize: 12, color: C.t3, textDecoration: "line-through", padding: "2px 0" }}>{i.text}</div>)}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// CHECKIN MODULE
// ═══════════════════════════════════════════════
function CheckinModule({ initialOrderId, nav }) {
  const { activeOrders, loadingActive } = useApp();
  const [selectedId, setSelectedId] = useState(initialOrderId || null);
  const today = todayStr();

  const started = activeOrders.filter(o => o.status === "started")
    .sort((a,b) => new Date(a.stops_at||0) - new Date(b.stops_at||0));
  // Hore aktuálne vonku (PICKED UP), meškajúce pod čiarou.
  const onTime = started.filter(o => !(o.stops_at && o.stops_at.slice(0,10) < today));
  const overdue = started.filter(o => o.stops_at && o.stops_at.slice(0,10) < today);

  if (selectedId) {
    const order = activeOrders.find(o => o.id === selectedId);
    if (order) return <CheckinWorkflow order={order} onBack={() => setSelectedId(null)} />;
  }

  const CheckinCard = (o) => {
    const isToday = o.stops_at?.slice(0,10) === today;
    const isLate = o.stops_at && o.stops_at.slice(0,10) < today;
    return (
      <OrderCard key={o.id} o={o} onClick={() => setSelectedId(o.id)}
        markers={<>
          {isLate && <span style={{ background: "#fdeaea", color: C.red, fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 6 }}>⚠ MEŠKÁ</span>}
          {isToday && !isLate && <span style={{ background: "#e4f5ec", color: C.green, fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 6 }}>DNES</span>}
        </>}
        meta={<>
          {o.grand_total_in_cents > 0 && <div style={{ fontFamily: C.mono, fontWeight: 700, color: C.t1, fontSize: 14 }}>€{Math.round(o.grand_total_in_cents/100).toLocaleString("sk-SK")}</div>}
          <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>{o.item_count || 0} ks →</div>
        </>} />
    );
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", color: C.t1, fontFamily: C.display, fontSize: 18, fontWeight: 800 }}>Príjem vrátenia</h2>
      <p style={{ margin: "0 0 20px", color: C.t2, fontSize: 13 }}>Kontrola a príjem vrátenej techniky — {started.length} vonku{overdue.length > 0 ? ` · ${overdue.length} mešká` : ""}</p>
      {loadingActive ? <Spin /> : started.length === 0
        ? <Empty icon="✅" title="Žiadna technika vonku" sub="Všetky objednávky sú vrátené" />
        : <>
          <div style={{ display: "grid", gap: 10 }}>{onTime.map(CheckinCard)}</div>
          {overdue.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 12px" }}>
                <div style={{ flex: 1, height: 1, background: C.border }} />
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", color: C.red, fontFamily: C.display }}>⚠ MEŠKAJÚCE ({overdue.length})</span>
                <div style={{ flex: 1, height: 1, background: C.border }} />
              </div>
              <div style={{ display: "grid", gap: 10 }}>{overdue.map(CheckinCard)}</div>
            </>
          )}
        </>
      }
    </div>
  );
}

function CheckinWorkflow({ order: o, onBack }) {
  const { display } = useApp();
  const showId = display.idCheckin ?? true;
  const [orderFull, setOrderFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState(() => LS.get(`fs_ci_${o.id}`, {}));
  const [damages, setDamages] = useState(() => LS.get(`fs_dmg_${o.id}`, []));
  const [dmgText, setDmgText] = useState("");
  const [notes, setNotes] = useState(() => LS.get(`fs_cn_${o.id}`, ""));
  const [byCat, setByCat] = useState(true);
  // V Príjme sú bundly vždy rozbalené (kontrola); klik na hlavičku ich zbalí.
  const [bundleColl, setBundleColl] = useState({});
  const bOpen = (id) => !bundleColl[id];
  const toggleBundleOpen = (id) => setBundleColl(s => ({ ...s, [id]: !s[id] }));

  useEffect(() => {
    api.orders.getDetail(o).then(setOrderFull).catch(()=>{}).finally(()=>setLoading(false));
  }, [o.id]);

  const lines = orderedLines(orderFull);
  const kidsOf = {};
  for (const l of lines) if (l.parent_line_id) (kidsOf[l.parent_line_id] = kidsOf[l.parent_line_id] || []).push(l);
  const isBundleParent = (l) => (kidsOf[l.id] || []).length > 0;
  const planById = (orderFull?.plannings || []).reduce((m, p) => { m[p.id] = p; return m; }, {});
  const saveC = v => { setChecks(v); LS.set(`fs_ci_${o.id}`, v); };
  const saveD = v => { setDamages(v); LS.set(`fs_dmg_${o.id}`, v); };

  const PROTOCOL = [
    { id: "all_returned", label: "Všetka technika fyzicky vrátená a spočítaná" },
    { id: "no_damage", label: "Vizuálna kontrola — žiadne viditeľné poškodenie" },
    { id: "cables", label: "Káble, adaptéry a príslušenstvo kompletné" },
    { id: "batteries", label: "Batérie a nabíjačky vrátené" },
    { id: "media", label: "CFexpress / SD karty vymazané a vrátené" },
    { id: "cases", label: "Prepravné kufre a tašky v poriadku" },
    { id: "cleaned", label: "Technika čistá (šošovky, body)" },
    { id: "tested", label: "Základná funkčná kontrola vykonaná" },
  ];

  const protocolDone = PROTOCOL.every(i => checks[i.id]);
  const itemsDone = lines.length > 0 && lines.every(l => checks[`i_${l.id}`]);
  const pct = Math.round((Object.values(checks).filter(Boolean).length / (PROTOCOL.length + lines.length)) * 100);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={onBack}>← Späť</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: C.display, fontSize: 19, fontWeight: 800, color: C.t1 }}>Príjem vrátenia <span style={{ color: C.gold, fontFamily: C.mono }}>#{o.number}</span>{o.project && <span style={{ fontSize: 13, color: C.t2, fontWeight: 600 }}> · Projekt: <span style={{ color: C.t1, fontWeight: 800 }}>{o.project}</span></span>}</div>
          <div style={{ color: C.t2, fontSize: 13 }}>{o.customer?.name} · vrátenie {fmtDate(o.stops_at)}</div>
        </div>
        <div style={{ color: C.t2, fontSize: 13 }}>{pct}%</div>
      </div>
      <ProgressBar pct={pct} color={C.green} />
      <div style={{ height: 16 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
            <div style={{ fontFamily: C.display, fontSize: 13, color: C.t1, fontWeight: 800 }}>Fyzická kontrola položiek</div>
            <CatToggle on={byCat} set={setByCat} />
          </div>
          {loading ? <Spin size={20} /> : groupGearLines(lines, sectionsOf(orderFull), byCat ? "category" : "order").map(([cat, gls]) => {
            const gcolor = catColor(cat);
            return (
              <div key={cat || "all"}>
                {cat && <CatPill name={cat} color={gcolor} right={
                  <span style={{ fontSize: 11, color: gls.every(l => checks[`i_${l.id}`]) ? C.green : C.t3, fontFamily: C.mono, fontWeight: 700 }}>{gls.filter(l => checks[`i_${l.id}`]).length}/{gls.length}</span>
                } />}
                {gls.map(l => {
                  const bundle = isBundleParent(l);
                  if (bundle) {
                    const kids = kidsOf[l.id] || [];
                    const checkedN = kids.filter(k => checks[`i_${k.id}`]).length;
                    const done = kids.length > 0 && checkedN === kids.length;
                    const partial = !done && checkedN > 0;
                    const open = bOpen(l.id);
                    const thumb = planById[kids[0]?.planning_id]?.photo_url;
                    const checkAll = () => { const v = !done; const next = { ...checks }; kids.forEach(k => next[`i_${k.id}`] = v); saveC(next); };
                    return (
                      <div key={l.id} onClick={() => toggleBundleOpen(l.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px 10px 0", borderBottom: `1px solid ${C.border}`, background: C.s2, cursor: "pointer" }}>
                        <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, background: `${gcolor}26`, position: "relative", overflow: "hidden", flexShrink: 0, minHeight: 34 }}>
                          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${kids.length ? Math.round(checkedN / kids.length * 100) : 0}%`, background: gcolor, borderRadius: 3, transition: "height .4s ease" }} />
                        </div>
                        <span style={{ width: 16, textAlign: "center", color: C.t3, fontSize: 11, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
                        {thumb
                          ? <img src={thumb} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", flexShrink: 0, border: `1px solid ${C.border}` }} />
                          : <div style={{ width: 34, height: 34, borderRadius: 7, background: C.s1, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>🎬</div>}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 14, color: C.t1 }}>{l.title}</div>
                          <div style={{ fontSize: 10.5, color: C.t3, fontWeight: 700, letterSpacing: "0.04em" }}>SET · {kids.length} položiek · {checkedN}/{kids.length} OK</div>
                        </div>
                        <div onClick={e => { e.stopPropagation(); checkAll(); }} title="Označiť celý set" style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${done ? C.green : C.borderHi}`, background: done ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: done ? "#fff" : C.gold, fontWeight: 900, flexShrink: 0 }}>{done ? "✓" : partial ? "–" : ""}</div>
                      </div>
                    );
                  }
                  if (l.parent_line_id && !bOpen(l.parent_line_id)) return null;
                  const done = !!checks[`i_${l.id}`];
                  const plan = planById[l.planning_id];
                  const serials = (plan?.stock_items || []).filter(s => s.identifier);
                  return (
                    <GearRow key={l.id} line={l} plan={plan} color={gcolor} done={done} showId={showId} onClick={() => saveC({ ...checks, [`i_${l.id}`]: !done })}
                      right={
                        <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${done ? C.green : C.borderHi}`, background: done ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#fff", fontWeight: 900, flexShrink: 0, marginTop: 4 }}>{done ? "✓" : ""}</div>
                      }>
                      {serials.length > 0 && (
                        <SerialPicker units={serials} selectedIds={serials.map(s => s.id)} lockedIds={serials.map(s => s.id)} interactive={false} />
                      )}
                    </GearRow>
                  );
                })}
              </div>
            );
          })}
        </Card>

        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>KONTROLNÝ PROTOKOL</div>
          {PROTOCOL.map(item => (
            <div key={item.id} onClick={() => saveC({...checks, [item.id]: !checks[item.id]})} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = C.s2}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checks[item.id] ? C.green : C.border}`, background: checks[item.id] ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#000", fontWeight: 900 }}>{checks[item.id] ? "✓" : ""}</div>
              <div style={{ fontSize: 13, color: checks[item.id] ? C.t3 : C.t1, textDecoration: checks[item.id] ? "line-through" : "none" }}>{item.label}</div>
            </div>
          ))}
        </Card>

        <Card style={{ borderColor: damages.length > 0 ? `${C.red}55` : C.border }}>
          <div style={{ fontSize: 11, color: damages.length > 0 ? C.red : C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>🔴 POŠKODENIA {damages.length > 0 ? `(${damages.length})` : ""}</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <Input value={dmgText} onChange={setDmgText} placeholder="Popíš poškodenie…" style={{ flex: 1, fontSize: 12 }} />
            <Btn v="danger" onClick={() => { saveD([...damages, { id: Date.now(), text: dmgText, ts: new Date().toISOString() }]); setDmgText(""); }} disabled={!dmgText.trim()}>+</Btn>
          </div>
          {damages.length === 0 ? <div style={{ color: C.t3, fontSize: 12 }}>✓ Žiadne poškodenia</div>
            : damages.map(d => <div key={d.id} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ color: C.red }}>⚠</span><div><div style={{ fontSize: 13, color: C.t1 }}>{d.text}</div><div style={{ fontSize: 10, color: C.t3 }}>{new Date(d.ts).toLocaleString("sk-SK")}</div></div></div>)}
        </Card>

        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>ZÁVEREČNÉ POTVRDENIE</div>
          <textarea value={notes} onChange={e => { setNotes(e.target.value); LS.set(`fs_cn_${o.id}`, e.target.value); }} placeholder="Interné poznámky…" style={{ width: "100%", boxSizing: "border-box", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 7, padding: "10px 12px", color: C.t1, fontSize: 13, resize: "vertical", minHeight: 70, outline: "none", fontFamily: C.font, marginBottom: 12 }} />
          {[{ label: "Položky skontrolované", ok: itemsDone }, { label: "Protokol dokončený", ok: protocolDone }, { label: "Poškodenia zaznamenané", ok: true }].map(item => (
            <div key={item.label} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <span style={{ color: item.ok ? C.green : C.t3 }}>{item.ok ? "✓" : "○"}</span>
              <span style={{ fontSize: 13, color: item.ok ? C.t1 : C.t2 }}>{item.label}</span>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <Btn v={protocolDone && itemsDone ? "success" : "ghost"} disabled={!protocolDone || !itemsDone}
              onClick={() => { LS.set(`fs_ci_done_${o.id}`, { ts: new Date().toISOString(), damages }); alert(`Príjem #${o.number} zaznamenaný.${damages.length > 0 ? `\n⚠ ${damages.length} poškodenie(í)!` : "\n✓ Bez poškodení."}\n\nVráťte objednávku v Booqable.`); }}
              style={{ width: "100%" }}>
              {protocolDone && itemsDone ? "✓ Potvrdiť príjem" : "Dokonči kontrolu"}
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════
const INVENTORY_KEY = "fs_inventory_v1", INV_OVERRIDES_KEY = "fs_inv_overrides", INV_TTL = 6 * 60 * 60 * 1000;
const isSetProduct = (p) => /(^|[^a-z])(set|kit|sada)([^a-z]|$)/i.test(p.name || "");
const stripHtml = (s) => (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// Rozkliknutý produkt — všetky info z Booqable (lazy): barcode, sériové kusy (SN), popis, depozit, custom fields.
function ProductExpand({ p, det, ld, bcOverride }) {
  const KV = ({ label, value }) => (value != null && value !== "") ? (
    <div><div style={{ fontSize: 9.5, color: C.t3, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</div><div style={{ fontSize: 13, color: C.t1, marginTop: 2, wordBreak: "break-word" }}>{value}</div></div>
  ) : null;
  return (
    <div style={{ padding: "13px 16px 16px 38px", background: C.s2, borderTop: `1px solid ${C.border}` }}>
      {ld && !det ? <div style={{ fontSize: 12.5, color: C.t3 }}>Načítavam detaily z Booqable…</div>
        : det?.error ? <div style={{ fontSize: 12.5, color: C.red }}>Detail sa nepodarilo načítať.</div>
        : det ? <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px,1fr))", gap: 13, marginBottom: 12 }}>
            <KV label="SKU" value={p.sku} />
            <KV label="Cena / deň" value={p.base_price_in_cents ? eur(p.base_price_in_cents) : "—"} />
            <KV label="Depozit" value={det.deposit_in_cents ? eur(det.deposit_in_cents) : "—"} />
            <KV label="Sklad" value={p.stock_count != null ? `${p.stock_count} ks` : "—"} />
            <KV label="Typ sledovania" value={p.tracking_type} />
            <KV label="Barcode (Booqable)" value={det.barcode || "nie je nastavený"} />
            {bcOverride && <KV label="Barcode (lokálne)" value={bcOverride} />}
            {det.lead_time != null && <KV label="Lead time" value={String(det.lead_time)} />}
            {det.lag_time != null && <KV label="Lag time" value={String(det.lag_time)} />}
            {Object.entries(det.custom_fields || {}).map(([k, v]) => <KV key={k} label={k} value={String(v)} />)}
          </div>
          {det.description && <div style={{ fontSize: 12.5, color: C.t2, marginBottom: 12, lineHeight: 1.5 }}>{stripHtml(det.description)}</div>}
          {(p.tags || []).length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>{p.tags.map(t => <span key={t} style={{ fontSize: 10.5, color: C.t2, background: C.s1, border: `1px solid ${C.border}`, borderRadius: 999, padding: "2px 9px" }}>{t}</span>)}</div>}
          <div>
            <div style={{ fontSize: 9.5, color: C.t3, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 7 }}>Sériové kusy / SN ({det.stock.length})</div>
            {det.stock.length === 0 ? <div style={{ fontSize: 12, color: C.t3 }}>Žiadne sériové kusy — bulk položka.</div>
              : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{det.stock.map((s, i) => { const avail = UNIT_AVAILABLE(s.status); return (
                <span key={i} title={s.status} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1.5px solid ${avail ? C.green : C.borderHi}`, background: avail ? "#e4f5ec" : C.s1, color: avail ? C.green : C.t2, borderRadius: 999, fontFamily: C.mono, fontWeight: 700, fontSize: 11, padding: "3px 10px" }}>
                  {s.identifier || "—"}{s.barcode ? <span style={{ color: C.t3 }}>· {s.barcode}</span> : ""}<span style={{ width: 6, height: 6, borderRadius: "50%", background: avail ? C.green : C.t3 }} />
                </span>); })}</div>}
          </div>
        </> : null}
    </div>
  );
}

function Inventory() {
  const { display, setDisplay } = useApp();
  const cache0 = LS.get(INVENTORY_KEY);
  const [items, setItems] = useState(() => cache0?.data || []);
  const [loading, setLoading] = useState(!(cache0?.data?.length));
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState(() => cache0?.at || null);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState({});
  const [overrides, setOverrides] = useState(() => LS.get(INV_OVERRIDES_KEY, {}));
  const photos = display.invPhotos !== false;

  const refresh = useCallback(async () => {
    try {
      setRefreshing(true);
      const all = await api.products.listAll();
      const at = Date.now();
      setItems(all); setSyncedAt(at); LS.set(INVENTORY_KEY, { at, data: all });
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => {
    // hydratuj z lokálnej kópie hneď; z API aktualizuj na pozadí (alebo ak je prázdne/staré)
    const c = LS.get(INVENTORY_KEY);
    if (!c?.data?.length || Date.now() - (c.at || 0) > INV_TTL) refresh();
  }, [refresh]);

  const saveOverrides = (n) => { setOverrides(n); LS.set(INV_OVERRIDES_KEY, n); };
  const ov = (id) => overrides[id] || {};
  const setOv = (id, patch) => { const next = { ...ov(id), ...patch }; Object.keys(next).forEach(k => (next[k] === "" || next[k] == null) && delete next[k]); saveOverrides({ ...overrides, [id]: next }); };
  const discOf = (p) => { const o = ov(p.id); return o.zlava != null ? o.zlava : (p.zlava || 0); };
  const grouping = display.invGroup !== false;
  const catSort = display.invCatSort || "count";

  // ── fulltext + fuzzy ──
  const ql = fold(q), tokens = ql.split(" ").filter(Boolean);
  const matched = useMemo(() => !tokens.length ? items
    : items.filter(p => { const h = fold(`${p.name} ${p.sku} ${(p.tags || []).join(" ")}`); return tokens.every(t => h.includes(t)); }), [items, ql]);
  const suggestion = useMemo(() => {
    if (!tokens.length || matched.length || !items.length) return null;
    const qf = ql.replace(/ /g, ""); let best = null, bd = Infinity;
    for (const p of items) for (const w of fold(p.name).split(" ")) { if (w.length < 2) continue; const d = levenshtein(qf, w); if (d < bd) { bd = d; best = w; } }
    return best && bd <= Math.max(2, Math.floor(qf.length / 3)) ? best : null;
  }, [matched, ql, items]);

  // ── zoskupenie podľa kategórií (keyword kategória, fallback na Booqable štítok) ──
  const catOf = (p) => { const c = categorize(p.name); if (c && c !== "Other") return c; const t = (p.tags || [])[0]; return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Ostatné"; };
  const groups = useMemo(() => {
    const m = new Map();
    for (const p of matched) { const c = catOf(p); if (!m.has(c)) m.set(c, []); m.get(c).push(p); }
    const arr = [...m.entries()].map(([name, list]) => { const cc = catColor(name); return { name, color: cc === CAT_FALLBACK.color ? avaColor(name) : cc, list: list.sort((a, b) => (a.name || "").localeCompare(b.name || "")) }; });
    arr.sort(catSort === "abc" ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));
    return arr;
  }, [matched, catSort]);
  const flatList = useMemo(() => [...matched].sort((a, b) => (a.name || "").localeCompare(b.name || "")), [matched]);

  const COLW = { ks: 64, price: 90, disc: 86, barcode: 150 };
  const cellInp = { width: "100%", background: "transparent", border: `1px solid transparent`, borderRadius: 6, padding: "4px 6px", fontSize: 12.5, fontFamily: C.font, color: C.t1, outline: "none", boxSizing: "border-box", textAlign: "center" };

  const Row = ({ p }) => {
    const d = discOf(p), bc = ov(p.id).barcode || "";
    const [open, setOpen] = useState(false);
    const [det, setDet] = useState(null);
    const [ld, setLd] = useState(false);
    useEffect(() => { if (open && !det && !ld) { setLd(true); api.products.groupDetail(p.id).then(setDet).catch(() => setDet({ error: true })).finally(() => setLd(false)); } }, [open]);
    const stop = e => e.stopPropagation();
    return (
      <div style={{ borderBottom: `1px solid ${C.border}` }}>
        <div onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", cursor: "pointer", background: open ? C.s2 : "transparent" }}
          onMouseEnter={e => { if (!open) e.currentTarget.style.background = C.s2; }} onMouseLeave={e => { if (!open) e.currentTarget.style.background = "transparent"; }}>
          <span style={{ fontSize: 10, color: C.t3, width: 10, flexShrink: 0, transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }}>▾</span>
          {photos && (p.photo_url
            ? <img src={p.photo_url} loading="lazy" alt="" style={{ width: 36, height: 36, borderRadius: 7, objectFit: "cover", flexShrink: 0, border: `1px solid ${C.border}` }} />
            : <div style={{ width: 36, height: 36, borderRadius: 7, background: C.s2, border: `1px solid ${C.border}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>🎬</div>)}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              {isSetProduct(p) && <span title="Set / bundle — obsah je viditeľný v objednávke" style={{ fontSize: 9.5, fontWeight: 800, color: C.gold, background: C.goldGlow, borderRadius: 5, padding: "1px 6px", flexShrink: 0 }}>SET</span>}
              {p.trackable && <span title="Trackovateľné — rozklikni pre sériové čísla" style={{ fontSize: 9.5, fontWeight: 800, color: C.blue, border: `1px solid ${C.blue}55`, borderRadius: 5, padding: "1px 6px", flexShrink: 0 }}>SN</span>}
            </div>
            {p.sku && <div style={{ fontSize: 10.5, color: C.t3, fontFamily: C.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{p.sku}</div>}
          </div>
          <div style={{ width: COLW.ks, textAlign: "center", flexShrink: 0, fontSize: 13, fontWeight: 700, color: p.stock_count > 0 ? C.t1 : C.t3 }}>{p.stock_count != null ? `${p.stock_count} ks` : "—"}</div>
          <div style={{ width: COLW.price, textAlign: "center", flexShrink: 0, fontSize: 13, color: C.t2 }}>{p.base_price_in_cents ? `${eur(p.base_price_in_cents)}` : "—"}</div>
          <div style={{ width: COLW.disc, flexShrink: 0, display: "flex", justifyContent: "center" }} onClick={stop}>
            <span style={{ display: "inline-flex", alignItems: "center", border: `1px solid ${d > 0 ? C.red + "55" : C.border}`, background: d > 0 ? "#fdeaea" : "transparent", borderRadius: 7 }}>
              <input value={d || ""} onChange={e => setOv(p.id, { zlava: e.target.value === "" ? "" : Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} placeholder="0" inputMode="numeric" style={{ ...cellInp, width: 42, color: d > 0 ? C.red : C.t2, fontWeight: 700 }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: d > 0 ? C.red : C.t3, paddingRight: 7 }}>%</span>
            </span>
          </div>
          <div style={{ width: COLW.barcode, flexShrink: 0 }} onClick={stop}>
            <input value={bc} onChange={e => setOv(p.id, { barcode: e.target.value })} placeholder="📷 barcode…" style={{ ...cellInp, fontFamily: C.mono, fontSize: 11.5, border: `1px solid ${C.border}`, background: C.s1, textAlign: "left" }} />
          </div>
        </div>
        {open && <ProductExpand p={p} det={det} ld={ld} bcOverride={bc} />}
      </div>
    );
  };

  const Tgl = ({ on, onClick, children }) => (
    <button onClick={onClick} style={{ border: `1px solid ${on ? C.gold : C.border}`, background: on ? C.goldGlow : C.s1, color: on ? C.gold : C.t2, borderRadius: 8, padding: "7px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: C.font }}>{children}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 20, fontWeight: 800 }}>Inventár</h2>
          <p style={{ margin: "3px 0 0", color: C.t2, fontSize: 13 }}>
            {loading ? "Načítavam katalóg…" : `${matched.length.toLocaleString("sk-SK")}${q ? ` / ${items.length.toLocaleString("sk-SK")}` : ""} položiek · ${groups.length} kategórií`}
            {refreshing && <span style={{ color: C.t3 }}> · aktualizujem…</span>}
            {syncedAt && !refreshing && <span style={{ color: C.t3 }}> · sync {new Date(syncedAt).toLocaleTimeString("sk-SK")}</span>}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Tgl on={grouping} onClick={() => setDisplay({ invGroup: !grouping })}>{grouping ? "Kategórie: ZAP" : "Kategórie: VYP"}</Tgl>
          {grouping && <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
            {[["count", "Podľa počtu"], ["abc", "A–Z"]].map(([k, l]) => (
              <button key={k} onClick={() => setDisplay({ invCatSort: k })} style={{ border: "none", background: catSort === k ? C.s1 : "transparent", color: catSort === k ? C.t1 : C.t3, borderRadius: 6, padding: "6px 10px", fontSize: 11.5, fontWeight: catSort === k ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: catSort === k ? C.shadow : "none" }}>{l}</button>
            ))}
          </div>}
          <Tgl on={photos} onClick={() => setDisplay({ invPhotos: !photos })}>{photos ? "🖼 Fotky: ZAP" : "Fotky: VYP"}</Tgl>
          <Btn onClick={refresh} disabled={refreshing}>↺ Aktualizovať</Btn>
        </div>
      </div>

      <Input value={q} onChange={setQ} placeholder="Hľadaj techniku, SKU, štítok… (toleruje preklepy a diakritiku)" style={{ width: "100%", boxSizing: "border-box", margin: "10px 0 4px" }} />
      {suggestion && <div style={{ fontSize: 12.5, color: C.t2, margin: "4px 2px 8px" }}>Žiadne výsledky. Mysleli ste: <button onClick={() => setQ(suggestion)} style={{ border: "none", background: "none", color: C.gold, fontWeight: 800, cursor: "pointer", fontFamily: C.font, fontSize: 12.5 }}>{suggestion}</button>?</div>}

      {loading ? <Spin /> : matched.length === 0 ? <Empty icon="🎥" title="Žiadna technika" sub={q ? "Skús iný výraz" : ""} />
        : <div style={{ marginTop: 8 }}>
          {/* hlavička stĺpcov */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 14px 6px", fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", color: C.t3, textTransform: "uppercase" }}>
            {photos && <div style={{ width: 36, flexShrink: 0 }} />}
            <div style={{ flex: 1 }}>Položka</div>
            <div style={{ width: COLW.ks, textAlign: "center", flexShrink: 0 }}>Sklad</div>
            <div style={{ width: COLW.price, textAlign: "center", flexShrink: 0 }}>Cena/deň</div>
            <div style={{ width: COLW.disc, textAlign: "center", flexShrink: 0 }}>Zľava</div>
            <div style={{ width: COLW.barcode, textAlign: "center", flexShrink: 0 }}>Barcode</div>
          </div>
          {grouping
            ? <div style={{ display: "grid", gap: 12 }}>
                {groups.map(g => { const open = !collapsed[g.name]; return (
                  <Card key={g.name} style={{ padding: 0, overflow: "hidden" }}>
                    <div onClick={() => setCollapsed(c => ({ ...c, [g.name]: !c[g.name] }))} style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 14px", cursor: "pointer", background: C.s2, borderBottom: open ? `1px solid ${C.border}` : "none" }}>
                      <span style={{ fontSize: 10, color: C.t3, transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }}>▾</span>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: g.color, flexShrink: 0 }} />
                      <span style={{ fontFamily: C.display, fontWeight: 800, fontSize: 13.5, color: C.t1, flex: 1 }}>{g.name}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 800, color: C.t3 }}>{g.list.length}</span>
                    </div>
                    {open && g.list.map(p => <Row key={p.id} p={p} />)}
                  </Card>
                ); })}
              </div>
            : <Card style={{ padding: 0, overflow: "hidden" }}>{flatList.map(p => <Row key={p.id} p={p} />)}</Card>}
          <div style={{ fontSize: 11, color: C.t3, marginTop: 10 }}>Zmeny zliav a barcodov sa ukladajú lokálne v appke. Plná synchronizácia do Booqable a skener pribudnú v ďalšom kroku.</div>
        </div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// PROJEKTY — viac turnusov (objednávok) s rovnakým názvom projektu zlúčené
// ═══════════════════════════════════════════════
const PROJ_FLAGS_KEY = "fs_project_flags"; // { orderId: { loaded: true } } — technika ostáva naložená
const eachDayStr = (from, to) => { const out = []; if (!from || !to) return out; const d = new Date(from.slice(0,10) + "T00:00:00"), end = new Date(to.slice(0,10) + "T00:00:00"); let g = 0; while (d <= end && g < 366) { out.push(dstrOf(d)); d.setDate(d.getDate() + 1); g++; } return out; };
const WD_SK2 = ["Po", "Ut", "St", "Št", "Pi", "So", "Ne"];

function Projects({ nav }) {
  const { allOrders, loadingActive } = useApp();
  const [q, setQ] = useState("");
  const [flt, setFlt] = useState("all");
  const [sel, setSel] = useState(null);
  const [flags, setFlags] = useState(() => LS.get(PROJ_FLAGS_KEY, {}));
  const today = todayStr();
  const setLoaded = (oid, v) => { const n = { ...flags, [oid]: { ...(flags[oid] || {}), loaded: v } }; if (!v) delete n[oid]; setFlags(n); LS.set(PROJ_FLAGS_KEY, n); };

  const projects = useMemo(() => {
    const m = new Map();
    for (const o of allOrders) { const name = o.project; if (!name) continue; if (!m.has(name)) m.set(name, []); m.get(name).push(o); }
    const arr = [...m.entries()].map(([name, orders]) => {
      orders.sort((a, b) => (a.starts_at || "").localeCompare(b.starts_at || ""));
      const client = orders.find(o => o.customer?.name)?.customer || null;
      const from = orders.map(o => o.starts_at).filter(Boolean).sort()[0] || null;
      const to = orders.map(o => o.stops_at).filter(Boolean).sort().slice(-1)[0] || null;
      const total = orders.reduce((s, o) => s + (o.grand_total_in_cents || 0), 0);
      const dayset = new Set(); orders.forEach(o => eachDayStr(o.starts_at, o.stops_at).forEach(d => dayset.add(d)));
      const upcoming = orders.filter(o => o.stops_at && o.stops_at.slice(0,10) >= today).length;
      const isDraft = orders.every(o => ["concept", "draft", "new"].includes(o.status));
      return { name, orders, client, from, to, total, days: dayset.size, upcoming, isDraft };
    });
    arr.sort((a, b) => (b.from || "").localeCompare(a.from || ""));
    const ql = fold(q);
    return ql ? arr.filter(p => fold(p.name + " " + (p.client?.name || "")).includes(ql)) : arr;
  }, [allOrders, q, today]);
  const FLT = [["all", "Všetky"], ["upcoming", "Nadchádzajúce"], ["ended", "Ukončené"], ["draft", "Drafty"]];
  const fcount = (k) => projects.filter(p => k === "all" || (k === "upcoming" ? p.upcoming > 0 : k === "ended" ? p.upcoming === 0 : p.isDraft)).length;
  const shown = projects.filter(p => flt === "all" || (flt === "upcoming" ? p.upcoming > 0 : flt === "ended" ? p.upcoming === 0 : p.isDraft));

  if (sel) { const p = projects.find(x => x.name === sel) || [...new Map(allOrders.filter(o=>o.project===sel).map(o=>[o.id,o])).values()].length && null;
    const proj = projects.find(x => x.name === sel);
    if (proj) return <ProjectDetail proj={proj} onBack={() => setSel(null)} nav={nav} flags={flags} setLoaded={setLoaded} today={today} />;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div><h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 20, fontWeight: 800 }}>Projekty</h2>
          <p style={{ margin: "3px 0 0", color: C.t2, fontSize: 13 }}>{shown.length} projektov · objednávky s rovnakým názvom projektu zlúčené do turnusov</p></div>
      </div>
      <Input value={q} onChange={setQ} placeholder="Hľadaj projekt, objednávateľa…" style={{ width: "100%", boxSizing: "border-box", marginBottom: 12 }} />
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {FLT.map(([k, l]) => { const a = flt === k; return (
          <button key={k} onClick={() => setFlt(k)} style={{ border: `1.5px solid ${a ? C.gold : C.border}`, background: a ? C.goldGlow : C.s1, color: a ? C.gold : C.t2, borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: C.font }}>{l} <span style={{ color: a ? C.gold : C.t3, fontWeight: 800 }}>{fcount(k)}</span></button>
        ); })}
      </div>
      {loadingActive && projects.length === 0 ? <Spin /> : shown.length === 0 ? <Empty icon="🎬" title="Žiadne projekty" sub="V tomto filtri nie sú žiadne projekty" /> : (
        <div style={{ display: "grid", gap: 10 }}>
          {shown.map(p => {
            const done = p.upcoming === 0;
            return (
              <div key={p.name} onClick={() => setSel(p.name)} style={{ display: "flex", background: C.s1, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", cursor: "pointer", boxShadow: C.shadow }}
                onMouseEnter={e => e.currentTarget.style.borderColor = C.borderHi} onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
                <div style={{ width: 4, background: done ? C.t3 : C.gold, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 18, padding: "14px 20px" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 15.5, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{p.client?.name || "—"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 22, flexShrink: 0, textAlign: "center" }}>
                    <div><div style={{ fontSize: 18, fontWeight: 800, color: C.t1 }}>{p.orders.length}</div><div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.05em" }}>turnusy</div></div>
                    <div><div style={{ fontSize: 18, fontWeight: 800, color: C.t1 }}>{p.days}</div><div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.05em" }}>dni</div></div>
                    <div><div style={{ fontSize: 18, fontWeight: 800, color: C.gold }}>{eur(p.total)}</div><div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.05em" }}>hodnota</div></div>
                  </div>
                  <div style={{ flexShrink: 0, minWidth: 130, textAlign: "right" }}>
                    <div style={{ fontSize: 12, color: C.t2 }}>{p.from ? fmtDate(p.from) : "?"} – {p.to ? fmtDate(p.to) : "?"}</div>
                    <span style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 9px", borderRadius: 999, marginTop: 5, display: "inline-block", background: done ? C.s2 : C.goldGlow, color: done ? C.t3 : C.gold }}>{done ? "Ukončený" : `${p.upcoming} nadchádza`}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectDetail({ proj, onBack, nav, flags, setLoaded, today }) {
  const { orders, name, client, from, to, total, days } = proj;
  const past = orders.filter(o => o.stops_at && o.stops_at.slice(0,10) < today);
  const delivered = past.reduce((s, o) => s + (o.grand_total_in_cents || 0), 0);
  const pct = total > 0 ? Math.round((delivered / total) * 100) : 0;

  // pokrytie dní → mapa deň → [čísla objednávok]; mesiace v rozsahu (max 4)
  const cover = new Map();
  orders.forEach(o => eachDayStr(o.starts_at, o.stops_at).forEach(d => { if (!cover.has(d)) cover.set(d, []); cover.get(d).push(o.number); }));
  const months = [];
  if (from && to) { const d = new Date(from.slice(0,10) + "T00:00:00"); d.setDate(1); const end = new Date(to.slice(0,10) + "T00:00:00"); let g = 0; while ((d.getFullYear() < end.getFullYear() || (d.getFullYear() === end.getFullYear() && d.getMonth() <= end.getMonth())) && g < 6) { months.push(new Date(d)); d.setMonth(d.getMonth() + 1); g++; } }

  // mesačný rozpis hodnoty (podľa začiatku turnusu)
  const byMonth = new Map();
  orders.forEach(o => { const k = (o.starts_at || "").slice(0, 7); if (!k) return; byMonth.set(k, (byMonth.get(k) || 0) + (o.grand_total_in_cents || 0)); });
  const monthsBill = [...byMonth.entries()].sort();

  const MiniMonth = ({ m }) => {
    const y = m.getFullYear(), mo = m.getMonth(), n = new Date(y, mo + 1, 0).getDate(), first = (new Date(y, mo, 1).getDay() + 6) % 7;
    return (
      <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, minWidth: 220 }}>
        <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 13, color: C.t1, marginBottom: 8, textTransform: "capitalize" }}>{m.toLocaleDateString("sk-SK", { month: "long", year: "numeric" })}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
          {WD_SK2.map(w => <div key={w} style={{ fontSize: 9, fontWeight: 800, color: C.t3, textAlign: "center" }}>{w}</div>)}
          {Array.from({ length: first }, (_, i) => <div key={"e" + i} />)}
          {Array.from({ length: n }, (_, i) => { const day = i + 1; const ds = `${y}-${String(mo+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`; const on = cover.get(ds); const t = ds === today;
            return <div key={day} title={on ? `#${on.join(", #")}` : ""} style={{ aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: on ? 800 : 500, borderRadius: 7, background: on ? C.gold : "transparent", color: on ? "#fff" : C.t3, border: t ? `1.5px solid ${C.gold}` : "1.5px solid transparent" }}>{day}</div>; })}
        </div>
      </div>
    );
  };

  const OrderLine = ({ o }) => { const isPast = o.stops_at && o.stops_at.slice(0,10) < today; const loaded = !!flags[o.id]?.loaded;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 800, color: C.gold, cursor: "pointer", flexShrink: 0 }} onClick={() => nav("order_detail", o.id)}>#{o.number}</span>
        <StatusTag tag={orderTag(o)} small />
        <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.t2 }}>{fmtDate(o.starts_at)} – {fmtDate(o.stops_at)} · {o.item_count || 0} ks</div>
        {loaded && <span style={{ fontSize: 10, fontWeight: 800, color: C.orange, background: "#fceadf", borderRadius: 999, padding: "2px 8px", flexShrink: 0 }}>NALOŽENÉ · nevracia sa</span>}
        <span style={{ fontFamily: C.mono, fontSize: 12.5, color: C.t1, fontWeight: 700, flexShrink: 0, minWidth: 70, textAlign: "right" }}>{eur(o.grand_total_in_cents)}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: C.t3, cursor: "pointer", flexShrink: 0 }} title="Technika ostáva naložená, nevracia sa do skladu medzi turnusmi">
          <input type="checkbox" checked={loaded} onChange={e => setLoaded(o.id, e.target.checked)} style={{ accentColor: C.gold }} /> nevracia sa
        </label>
      </div>
    );
  };

  return (
    <div>
      <Btn onClick={onBack} v="ghost" style={{ marginBottom: 12 }}>← Späť na projekty</Btn>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: C.display, fontWeight: 900, fontSize: 26, color: C.t1, letterSpacing: "-0.01em" }}>{name}</div>
            {client && <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 8 }}>
              <span style={{ width: 30, height: 30, borderRadius: "50%", background: avaColor(client.name), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{initials(client.name)}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.t1 }}>{client.name}</span>
            </div>}
          </div>
          <div style={{ display: "flex", gap: 26, flexShrink: 0, textAlign: "center" }}>
            <div><div style={{ fontSize: 24, fontWeight: 800, color: C.t1 }}>{orders.length}</div><div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.05em" }}>turnusy</div></div>
            <div><div style={{ fontSize: 24, fontWeight: 800, color: C.t1 }}>{days}</div><div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.05em" }}>natáčacie dni</div></div>
            <div><div style={{ fontSize: 24, fontWeight: 800, color: C.gold }}>{eur(total)}</div><div style={{ fontSize: 10, color: C.t3, textTransform: "uppercase", letterSpacing: "0.05em" }}>hodnota</div></div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: C.t2, marginTop: 12 }}>{from ? fmtDate(from) : "?"} – {to ? fmtDate(to) : "?"}</div>
      </Card>

      {/* Kalendár natáčacích dní */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>KALENDÁR NATÁČACÍCH DNÍ</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>{months.map((m, i) => <MiniMonth key={i} m={m} />)}</div>
      </Card>

      {/* Objednávky / turnusy */}
      <Card style={{ marginBottom: 14, padding: 0 }}>
        <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", padding: "14px 14px 8px" }}>TURNUSY / OBJEDNÁVKY ({orders.length})</div>
        {orders.map(o => <OrderLine key={o.id} o={o} />)}
      </Card>

      {/* Vyúčtovanie */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: C.t1, fontWeight: 800, fontFamily: C.display }}>Vyúčtovanie projektu</div>
          <div style={{ fontSize: 12, color: C.t2 }}>odovzdané {eur(delivered)} / {eur(total)}</div>
        </div>
        <div style={{ background: C.s2, borderRadius: 6, height: 12, overflow: "hidden", position: "relative" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? C.green : C.gold, borderRadius: 6, transition: "width .4s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.t3, marginTop: 5 }}><span>Začiatok</span><span style={{ fontWeight: 800, color: pct >= 100 ? C.green : C.gold }}>{pct}% odovzdané</span><span>Koniec</span></div>
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 8 }}>MESAČNE</div>
          {monthsBill.map(([k, v]) => { const dt = new Date(k + "-01T00:00:00");
            return <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
              <span style={{ color: C.t2, textTransform: "capitalize" }}>{dt.toLocaleDateString("sk-SK", { month: "long", year: "numeric" })}</span>
              <span style={{ color: C.t1, fontWeight: 700, fontFamily: C.mono }}>{eur(v)}</span>
            </div>; })}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 0", fontSize: 14, fontWeight: 800 }}><span style={{ color: C.t1 }}>Spolu</span><span style={{ color: C.gold, fontFamily: C.mono }}>{eur(total)}</span></div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════
// CENOVÉ PONUKY — editor s riadkovými zľavami + A4 PDF náhľad (SK/EN/DE, dizajny)
// ═══════════════════════════════════════════════
const QUOTES_KEY = "fs_quotes_v1", COMPANY_KEY = "fs_company_v1", QUOTE_TPL_KEY = "fs_quote_templates_v1";
const QUOTE_LANGS = [["sk", "SK"], ["en", "EN"], ["de", "DE"]];
const QUOTE_DESIGNS = [["minimal", "Minimal"], ["classic", "Klasik"], ["accent", "Accent"]];
const QL = {
  sk: { quote: "CENOVÁ PONUKA", no: "Číslo", date: "Dátum", valid: "Platí do", forr: "Pre", project: "Projekt", item: "Položka", qty: "Ks", days: "Dni", unit: "Cena/deň", disc: "Zľava", total: "Spolu", subtotal: "Medzisúčet", orderDisc: "Zľava na ponuku", vat: "DPH", grand: "Celkom", notes: "Poznámky", youSave: "Ušetríte", thanks: "Ďakujeme za dôveru.", before: "pred zľavou" },
  en: { quote: "QUOTATION", no: "No.", date: "Date", valid: "Valid until", forr: "For", project: "Project", item: "Item", qty: "Qty", days: "Days", unit: "Price/day", disc: "Disc.", total: "Total", subtotal: "Subtotal", orderDisc: "Quote discount", vat: "VAT", grand: "Grand total", notes: "Notes", youSave: "You save", thanks: "Thank you for your business.", before: "before disc." },
  de: { quote: "ANGEBOT", no: "Nr.", date: "Datum", valid: "Gültig bis", forr: "Für", project: "Projekt", item: "Position", qty: "Stk", days: "Tage", unit: "Preis/Tag", disc: "Rabatt", total: "Summe", subtotal: "Zwischensumme", orderDisc: "Angebotsrabatt", vat: "MwSt.", grand: "Gesamt", notes: "Notizen", youSave: "Sie sparen", thanks: "Vielen Dank für Ihr Vertrauen.", before: "vor Rabatt" },
};
const DEFAULT_COMPANY = { name: "FilmSupport", tagline: "CAMERA & LIGHTING RENTAL", address: "", email: "info@filmsupport.sk", phone: "", web: "filmsupport.sk", ico: "", dic: "", icdph: "", iban: "", bic: "" };
const loadCompany = () => ({ ...DEFAULT_COMPANY, ...(LS.get(COMPANY_KEY) || {}) });
const qLineGross = (l) => Math.round((l.qty || 0) * (l.days || 1) * (l.unitCents || 0));
const qLineNet = (l) => Math.round(qLineGross(l) * (1 - (l.discountPct || 0) / 100));
function quoteTotals(qt) {
  const items = (qt.items || []).filter(l => l.kind !== "section");
  const subtotal = items.reduce((s, l) => s + qLineNet(l), 0);
  const lineSaved = items.reduce((s, l) => s + (qLineGross(l) - qLineNet(l)), 0);
  const orderDisc = Math.round(subtotal * (qt.orderDiscountPct || 0) / 100);
  const base = subtotal - orderDisc;
  const vat = Math.round(base * (qt.vatPct ?? 23) / 100);
  return { subtotal, lineSaved, orderDisc, base, vat, grand: base + vat, saved: lineSaved + orderDisc };
}
// Vytvor ponuku z objednávky (vychádza z poslednej objednávky klienta).
function buildQuoteFromOrder(o, det, base) {
  const days = o.starts_at && o.stops_at ? Math.max(1, Math.ceil((new Date(o.stops_at) - new Date(o.starts_at)) / 864e5)) : 1;
  const skuById = {}; (det.plannings || []).forEach(p => { skuById[p.id] = p.sku; });
  const items = [];
  for (const l of (det.lines || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0))) {
    if (l.line_type === "section" && l.title) { items.push({ id: uid(), kind: "section", name: l.title }); continue; }
    if (!l.title || !(l.quantity > 0)) continue;
    const qty = Math.round(l.quantity), gross = l.price_in_cents || 0;
    items.push({ id: uid(), kind: "item", name: l.title, sku: skuById[l.planning_id] || null, qty, days, unitCents: qty && days ? Math.round(gross / (qty * days)) : 0, discountPct: 0 });
  }
  return { ...base, client: { name: o.customer?.name || "", company: "", email: o.customer?.email || "", phone: "", address: "" }, project: o.project || "", days, items };
}
// Asistent: "často sa pridáva spolu" — z lokálne cachovaných detailov objednávok (fs_od_*).
function quoteLearned(items) {
  try {
    const present = new Set(items.filter(i => i.kind !== "section").map(i => fold(i.name)));
    if (!present.size) return [];
    const co = new Map();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith("fs_od_")) continue;
      const d = JSON.parse(localStorage.getItem(k) || "{}");
      const titles = [...new Set((d.lines || []).filter(l => l.title && l.line_type !== "section" && l.quantity > 0).map(l => l.title))];
      if (!titles.some(t => present.has(fold(t)))) continue;
      for (const t of titles) { const f = fold(t); if (present.has(f)) continue; const e = co.get(f) || { name: t, count: 0 }; e.count++; co.set(f, e); }
    }
    return [...co.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  } catch { return []; }
}
// Pravidlový asistent — chýbajúce sprievodné položky podľa kategórií.
const QUOTE_RULES = [
  { need: "Cameras", miss: "Power", msg: "Kamera bez napájania — pridaj batérie / V-mount." },
  { need: "Cameras", miss: "Data / Media", msg: "Kamera bez médií — pridaj pamäťové karty." },
  { need: "Cameras", miss: "Cables", msg: "Skontroluj káble (SDI/HDMI/power) ku kamere." },
  { need: "Cameras", miss: "Monitors", msg: "Zváž monitor k zostave." },
  { need: "Lenses", miss: "Filters", msg: "Objektívy — zváž ND/pol filtre." },
  { need: "Lighting", miss: "Stands", msg: "Svetlá bez statívov — pridaj statívy." },
  { need: "Lighting", miss: "Power", msg: "Svetlá — skontroluj napájanie / káble." },
  { need: "Monitors", miss: "Power", msg: "Monitor bez napájania — pridaj batérie." },
  { need: "Wireless Video", miss: "Power", msg: "Bezdrôtový prenos — pridaj batérie." },
  { need: "Audio", miss: "Power", msg: "Zvuk — skontroluj batérie / napájanie." },
];

function Quotes({ nav }) {
  const { allOrders } = useApp();
  const [list, setList] = useState(() => LS.get(QUOTES_KEY, []));
  const [edit, setEdit] = useState(null);     // quote being edited
  const [preview, setPreview] = useState(null);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const save = (n) => { setList(n); LS.set(QUOTES_KEY, n); };
  const upsert = (qt) => { const n = list.some(x => x.id === qt.id) ? list.map(x => x.id === qt.id ? qt : x) : [qt, ...list]; save(n); };
  const today = todayStr();
  const newNumber = () => `CP-${new Date().getFullYear()}-${String(list.length + 1).padStart(3, "0")}`;
  const blank = () => ({ id: uid(), number: newNumber(), createdAt: today, date: today, validUntil: "", lang: "sk", design: LS.get("fs_display_v1")?.quoteDesign || "minimal", client: { name: "", company: "", email: "", phone: "", address: "", ico: "", dic: "" }, project: "", contact: "", location: "", days: 1, vatPct: 23, orderDiscountPct: 0, notes: "", items: [] });
  const fromTemplate = (tpl) => { setTplOpen(false); setEdit({ ...blank(), items: (tpl.items || []).map(i => ({ ...i, id: uid() })) }); };
  const fromOrder = (o) => { setBuilding(true); api.orders.getDetail(o).then(det => setEdit(buildQuoteFromOrder(o, det, blank()))).catch(() => window.alert("Detail objednávky sa nepodarilo načítať.")).finally(() => { setBuilding(false); setImportOpen(false); }); };

  if (edit) return <QuoteEditor key={edit.id} quote={edit} company={loadCompany()} onClose={() => setEdit(null)} onSave={(qt) => { upsert(qt); setEdit(null); }} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div><h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 20, fontWeight: 800 }}>Cenové ponuky</h2>
          <p style={{ margin: "3px 0 0", color: C.t2, fontSize: 13 }}>{list.length} ponúk · riadkové zľavy, A4 náhľad, SK/EN/DE</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => setCompanyOpen(true)}>⚙ Firma</Btn>
          <Btn onClick={() => setTplOpen(true)}>📋 Templates</Btn>
          <Btn onClick={() => setImportOpen(true)}>↟ Z objednávky</Btn>
          <Btn v="primary" onClick={() => setEdit(blank())}>+ Nová ponuka</Btn>
        </div>
      </div>
      {list.length === 0 ? <Empty icon="📄" title="Žiadne cenové ponuky" sub="Vytvor prvú ponuku" /> : (
        <div style={{ display: "grid", gap: 9 }}>
          {list.map(qt => { const t = quoteTotals(qt); return (
            <div key={qt.id} style={{ display: "flex", alignItems: "center", gap: 16, background: C.s1, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 18px", boxShadow: C.shadow }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: C.mono, fontWeight: 800, color: C.gold, fontSize: 13 }}>{qt.number}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.t3, border: `1px solid ${C.border}`, borderRadius: 5, padding: "1px 6px", textTransform: "uppercase" }}>{qt.lang}</span>
                </div>
                <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 15.5, color: C.t1, marginTop: 2 }}>{qt.client?.name || qt.client?.company || "—"}</div>
                {qt.project && <div style={{ fontSize: 12, color: C.t2 }}>Projekt: {qt.project}</div>}
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontFamily: C.mono, fontWeight: 800, color: C.t1 }}>{eur(t.grand)}</div>
                <div style={{ fontSize: 11, color: C.t3 }}>{(qt.items || []).filter(l => l.kind !== "section").length} položiek</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Btn onClick={() => setPreview(qt)}>Náhľad</Btn>
                <Btn v="primary" onClick={() => setEdit(qt)}>Upraviť</Btn>
                <Btn v="danger" onClick={() => { if (window.confirm("Zmazať ponuku?")) save(list.filter(x => x.id !== qt.id)); }}>×</Btn>
              </div>
            </div>
          ); })}
        </div>
      )}
      {preview && <QuotePreview quote={preview} company={loadCompany()} onClose={() => setPreview(null)} />}
      {companyOpen && <CompanyModal onClose={() => setCompanyOpen(false)} />}
      {tplOpen && <TemplatesModal onUse={fromTemplate} onClose={() => setTplOpen(false)} />}
      {importOpen && <OrderImportModal orders={allOrders} building={building} onPick={fromOrder} onClose={() => setImportOpen(false)} />}
    </div>
  );
}
function TemplatesModal({ onUse, onClose }) {
  const [tpls, setTpls] = useState(() => LS.get(QUOTE_TPL_KEY, []));
  const del = (id) => { const n = tpls.filter(t => t.id !== id); setTpls(n); LS.set(QUOTE_TPL_KEY, n); };
  return (
    <ShModalShell title="Šablóny ponúk" onClose={onClose} width={420}>
      {tpls.length === 0 ? <div style={{ fontSize: 13, color: C.t3, padding: "6px 0 14px" }}>Zatiaľ žiadne šablóny. Ulož ich v editore ponuky cez „💾 Šablóna".</div>
        : <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>{tpls.map(t => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.border}`, borderRadius: 9, padding: "9px 12px" }}>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13.5, color: C.t1 }}>{t.name}</div><div style={{ fontSize: 11.5, color: C.t3 }}>{(t.items || []).filter(i => i.kind !== "section").length} položiek</div></div>
            <Btn v="primary" onClick={() => onUse(t)}>Použiť</Btn>
            <Btn v="danger" onClick={() => del(t.id)}>×</Btn>
          </div>))}</div>}
      <Btn onClick={onClose} style={{ width: "100%" }}>Zavrieť</Btn>
    </ShModalShell>
  );
}
function OrderImportModal({ orders, building, onPick, onClose }) {
  const [q, setQ] = useState("");
  const ql = fold(q);
  const list = useMemo(() => [...orders].sort((a, b) => (b.starts_at || "").localeCompare(a.starts_at || ""))
    .filter(o => !ql || fold(`${o.number} ${o.customer?.name || ""} ${o.project || ""}`).includes(ql)).slice(0, 40), [orders, ql]);
  return (
    <ShModalShell title="Vytvoriť z objednávky" onClose={onClose} width={460}>
      <p style={{ fontSize: 12, color: C.t2, margin: "0 0 10px" }}>Vyber objednávku — položky sa prenesú do novej ponuky (môžeš ich upraviť).</p>
      <Input value={q} onChange={setQ} placeholder="Hľadaj číslo, klienta, projekt…" style={{ width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
      {building && <div style={{ fontSize: 12.5, color: C.gold, marginBottom: 8 }}>Načítavam položky…</div>}
      <div style={{ display: "grid", gap: 6, maxHeight: "50vh", overflowY: "auto" }}>
        {list.map(o => (
          <div key={o.id} onClick={() => !building && onPick(o)} style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.border}`, borderRadius: 9, padding: "8px 12px", cursor: building ? "wait" : "pointer" }}
            onMouseEnter={e => e.currentTarget.style.background = C.s2} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: C.mono, fontWeight: 800, color: C.gold, fontSize: 12.5, flexShrink: 0 }}>#{o.number}</span>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer?.name || "—"}</div>{o.project && <div style={{ fontSize: 11, color: C.t3 }}>{o.project}</div>}</div>
            <span style={{ fontSize: 11.5, color: C.t3, flexShrink: 0 }}>{fmtDate(o.starts_at)}</span>
          </div>))}
      </div>
    </ShModalShell>
  );
}

function CompanyModal({ onClose }) {
  const [c, setC] = useState(loadCompany());
  const set = (k, v) => setC(p => ({ ...p, [k]: v }));
  const fields = [["name", "Názov firmy"], ["tagline", "Tagline"], ["address", "Adresa"], ["email", "E-mail"], ["phone", "Telefón"], ["web", "Web"], ["ico", "IČO"], ["dic", "DIČ"], ["icdph", "IČ DPH"], ["iban", "IBAN"], ["bic", "BIC"]];
  const inp = { width: "100%", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: C.font, outline: "none", boxSizing: "border-box" };
  return (
    <ShModalShell title="Údaje firmy (hlavička ponuky)" onClose={onClose} width={440}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {fields.map(([k, l]) => <div key={k} style={{ gridColumn: ["address"].includes(k) ? "1 / -1" : "auto" }}><span style={{ fontSize: 11, fontWeight: 800, color: C.t3, display: "block", marginBottom: 3 }}>{l}</span><input value={c[k] || ""} onChange={e => set(k, e.target.value)} style={inp} /></div>)}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn v="primary" onClick={() => { LS.set(COMPANY_KEY, c); onClose(); }} style={{ flex: 1 }}>Uložiť</Btn>
        <Btn onClick={onClose}>Zrušiť</Btn>
      </div>
    </ShModalShell>
  );
}

function QuoteEditor({ quote, company, onClose, onSave }) {
  const [qt, setQt] = useState(quote);
  const [pick, setPick] = useState("");
  const [prev, setPrev] = useState(false);
  const [asst, setAsst] = useState(false);
  const set = (patch) => setQt(p => ({ ...p, ...patch }));
  const setClient = (k, v) => setQt(p => ({ ...p, client: { ...p.client, [k]: v } }));
  const setItem = (id, patch) => setQt(p => ({ ...p, items: p.items.map(l => l.id === id ? { ...l, ...patch } : l) }));
  const delItem = (id) => setQt(p => ({ ...p, items: p.items.filter(l => l.id !== id) }));
  const addItem = (it) => setQt(p => ({ ...p, items: [...p.items, it] }));
  const inv = LS.get(INVENTORY_KEY)?.data || [];
  const addByName = (name) => { const f = fold(name); const hit = inv.find(x => fold(x.name) === f) || inv.find(x => fold(x.name).includes(f)); addItem({ id: uid(), kind: "item", name: hit ? hit.name : name, sku: hit?.sku || null, qty: 1, days: qt.days, unitCents: hit?.base_price_in_cents || 0, discountPct: hit?.zlava || 0 }); };
  const saveTpl = () => { const name = window.prompt("Názov šablóny:", qt.project || "Šablóna"); if (!name) return; const tpls = LS.get(QUOTE_TPL_KEY, []); LS.set(QUOTE_TPL_KEY, [{ id: uid(), name, items: qt.items.map(i => ({ ...i })) }, ...tpls]); window.alert("Šablóna uložená."); };
  const ql = fold(pick), tok = ql.split(" ").filter(Boolean);
  const results = tok.length ? inv.filter(x => { const h = fold(`${x.name} ${x.sku}`); return tok.every(t => h.includes(t)); }).slice(0, 8) : [];
  const t = quoteTotals(qt);
  const lbl = { fontSize: 11, fontWeight: 800, color: C.t3, display: "block", marginBottom: 3 };
  const inp = { width: "100%", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: C.font, outline: "none", boxSizing: "border-box" };
  const cell = { background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 6px", fontSize: 12.5, fontFamily: C.font, outline: "none", textAlign: "center", boxSizing: "border-box" };
  const [vw, setVw] = useState(() => LS.get("fs_quoteview", { cats: true, photos: true, sku: false }));
  const setView = (patch) => { const n = { ...vw, ...patch }; setVw(n); LS.set("fs_quoteview", n); };
  const [collapsed, setCollapsed] = useState({});
  const invByKey = useMemo(() => { const m = {}; for (const x of inv) { if (x.sku) m["s:" + fold(x.sku)] = x; m["n:" + fold(x.name)] = x; } return m; }, [inv.length]);
  const photoOf = (l) => ((l.sku && invByKey["s:" + fold(l.sku)]) || invByKey["n:" + fold(l.name)])?.photo_url || null;
  const itemLines = qt.items.filter(l => l.kind !== "section");
  const groups = vw.cats ? (() => { const m = new Map(); for (const l of itemLines) { const c = categorize(l.name) || "Other"; if (!m.has(c)) m.set(c, []); m.get(c).push(l); } return [...m.entries()].map(([name, list]) => ({ name, color: catColor(name) === CAT_FALLBACK.color ? avaColor(name) : catColor(name), list, sum: list.reduce((s, l) => s + qLineNet(l), 0) })); })() : null;
  const COL = { ks: 54, rate: 86, disc: 66, days: 52, total: 100 };

  // editovateľný riadok položky (štýl ako objednávka)
  const ItemRow = ({ l }) => { const g = qLineGross(l), n = qLineNet(l), disc = l.discountPct || 0; const ph = photoOf(l);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 16px", borderBottom: `1px solid ${C.border}` }}>
        {vw.photos && (ph ? <img src={ph} loading="lazy" alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", border: `1px solid ${C.border}`, flexShrink: 0 }} /> : <div style={{ width: 34, height: 34, borderRadius: 7, background: C.s2, border: `1px solid ${C.border}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>🎬</div>)}
        <div style={{ flex: 1, minWidth: 0 }}>
          <input value={l.name} onChange={e => setItem(l.id, { name: e.target.value })} placeholder="Názov položky" style={{ width: "100%", border: "1px solid transparent", background: "transparent", fontSize: 13.5, fontWeight: 700, color: C.t1, fontFamily: C.display, outline: "none", padding: "2px 4px", borderRadius: 6 }}
            onFocus={e => e.target.style.background = C.s2} onBlur={e => e.target.style.background = "transparent"} />
          {vw.sku && l.sku && <div style={{ fontSize: 10, color: C.t3, fontFamily: C.mono, padding: "0 4px" }}>{l.sku}</div>}
        </div>
        <input value={l.qty} onChange={e => setItem(l.id, { qty: Math.max(0, Number(e.target.value) || 0) })} style={{ ...cell, width: COL.ks }} />
        <input value={(l.unitCents / 100) || ""} onChange={e => setItem(l.id, { unitCents: Math.round((Number(e.target.value) || 0) * 100) })} placeholder="0" style={{ ...cell, width: COL.rate }} />
        <input value={disc || ""} onChange={e => setItem(l.id, { discountPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} placeholder="0%" style={{ ...cell, width: COL.disc, color: disc > 0 ? C.red : C.t1, fontWeight: disc > 0 ? 800 : 400 }} />
        <input value={l.days} onChange={e => setItem(l.id, { days: Math.max(1, Number(e.target.value) || 1) })} style={{ ...cell, width: COL.days }} />
        <div style={{ width: COL.total, textAlign: "right", flexShrink: 0 }}>
          {disc > 0 && <div style={{ fontSize: 10.5, color: C.t3, textDecoration: "line-through" }}>{eur(g)}</div>}
          <div style={{ fontSize: 13, fontWeight: 700, color: C.t1, fontFamily: C.mono }}>{eur(n)}</div>
        </div>
        <button onClick={() => delItem(l.id)} title="Zmazať" style={{ border: "none", background: "transparent", color: C.t3, cursor: "pointer", fontSize: 15, flexShrink: 0, width: 22 }}>×</button>
      </div>
    );
  };
  const ColHead = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 16px", fontSize: 10, fontWeight: 800, color: C.t3, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${C.border}` }}>
      {vw.photos && <div style={{ width: 34, flexShrink: 0 }} />}
      <div style={{ flex: 1 }}>Položka</div>
      <div style={{ width: COL.ks, textAlign: "center" }}>Ks</div>
      <div style={{ width: COL.rate, textAlign: "center" }}>Denná sadzba</div>
      <div style={{ width: COL.disc, textAlign: "center" }}>Zľava</div>
      <div style={{ width: COL.days, textAlign: "center" }}>Dni</div>
      <div style={{ width: COL.total, textAlign: "right" }}>Celkom</div>
      <div style={{ width: 22 }} />
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <Btn onClick={onClose} v="ghost">← Späť</Btn>
          <h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 19, fontWeight: 800 }}>{qt.number}</h2>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
            {QUOTE_LANGS.map(([k, l]) => <button key={k} onClick={() => set({ lang: k })} style={{ border: "none", background: qt.lang === k ? C.s1 : "transparent", color: qt.lang === k ? C.t1 : C.t3, borderRadius: 6, padding: "5px 10px", fontSize: 11.5, fontWeight: 800, cursor: "pointer", fontFamily: C.font, boxShadow: qt.lang === k ? C.shadow : "none" }}>{l}</button>)}
          </div>
          <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
            {QUOTE_DESIGNS.map(([k, l]) => <button key={k} onClick={() => set({ design: k })} style={{ border: "none", background: qt.design === k ? C.s1 : "transparent", color: qt.design === k ? C.t1 : C.t3, borderRadius: 6, padding: "5px 10px", fontSize: 11.5, fontWeight: qt.design === k ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: qt.design === k ? C.shadow : "none" }}>{l}</button>)}
          </div>
          <Btn onClick={() => setAsst(a => !a)} v={asst ? "primary" : "ghost"}>🤖 Asistent</Btn>
          <Btn onClick={saveTpl}>💾 Šablóna</Btn>
          <Btn onClick={() => setPrev(true)}>👁 Náhľad A4</Btn>
          <Btn v="primary" onClick={() => onSave(qt)}>Uložiť</Btn>
        </div>
      </div>

      {/* karta klienta — ako v objednávke, editovateľná */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ width: 52, height: 52, borderRadius: "50%", background: avaColor(qt.client.name || "?"), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, flexShrink: 0 }}>{initials(qt.client.name || "?")}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <input value={qt.client.name} onChange={e => setClient("name", e.target.value)} placeholder="Meno klienta / firma" style={{ width: "100%", border: "1px solid transparent", background: "transparent", fontSize: 20, fontWeight: 800, color: C.t1, fontFamily: C.display, outline: "none", padding: "2px 4px", borderRadius: 6 }} onFocus={e => e.target.style.background = C.s2} onBlur={e => e.target.style.background = "transparent"} />
            <input value={qt.client.company} onChange={e => setClient("company", e.target.value)} placeholder="Spoločnosť / poznámka" style={{ width: "100%", border: "1px solid transparent", background: "transparent", fontSize: 13, color: C.t2, fontFamily: C.font, outline: "none", padding: "1px 4px", borderRadius: 6 }} onFocus={e => e.target.style.background = C.s2} onBlur={e => e.target.style.background = "transparent"} />
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 14 }}>
          {[["email", "E-MAIL"], ["phone", "TELEFÓN"], ["address", "ADRESA"], ["ico", "IČO"], ["dic", "DIČ"]].map(([k, l]) => (
            <div key={k}><span style={lbl}>{l}</span><input value={qt.client[k] || ""} onChange={e => setClient(k, e.target.value)} style={{ ...inp, padding: "6px 8px" }} /></div>
          ))}
        </div>
      </Card>

      {/* karta projektu — viac detailov */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12 }}>
          <div><span style={lbl}>PROJEKT</span><input value={qt.project} onChange={e => set({ project: e.target.value })} placeholder="Názov projektu" style={inp} /></div>
          <div><span style={lbl}>KONTAKTNÁ OSOBA</span><input value={qt.contact || ""} onChange={e => set({ contact: e.target.value })} style={inp} /></div>
          <div><span style={lbl}>MIESTO / LOKÁCIA</span><input value={qt.location || ""} onChange={e => set({ location: e.target.value })} style={inp} /></div>
          <div><span style={lbl}>DÁTUM</span><input type="date" value={qt.date} onChange={e => set({ date: e.target.value })} style={inp} /></div>
          <div><span style={lbl}>PLATÍ DO</span><input type="date" value={qt.validUntil} onChange={e => set({ validUntil: e.target.value })} style={inp} /></div>
          <div><span style={lbl}>POČET DNÍ</span><input type="number" min={1} value={qt.days} onChange={e => set({ days: Math.max(1, Number(e.target.value) || 1) })} style={inp} /></div>
        </div>
        <div style={{ marginTop: 12 }}><span style={lbl}>POZNÁMKA</span><textarea value={qt.notes} onChange={e => set({ notes: e.target.value })} placeholder="Poznámky k ponuke, podmienky…" style={{ ...inp, minHeight: 56, resize: "vertical" }} /></div>
      </Card>

      {asst && <QuoteAssistant items={qt.items} onAdd={addByName} />}

      {/* technika — pridávanie + zobrazenie ako objednávka */}
      <Card style={{ marginBottom: 14, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
          <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 15, color: C.t1 }}>Technika <span style={{ color: C.t3, fontWeight: 600 }}>({itemLines.length})</span></div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[["cats", "Kategórie"], ["photos", "Fotky"], ["sku", "SKU"]].map(([k, l]) => (
              <button key={k} onClick={() => setView({ [k]: !vw[k] })} style={{ border: `1.5px solid ${vw[k] ? C.gold : C.border}`, background: vw[k] ? C.goldGlow : C.s1, color: vw[k] ? C.gold : C.t2, borderRadius: 8, padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.font }}>{l}</button>
            ))}
          </div>
        </div>
        {/* pridať */}
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, position: "relative" }}>
          <input value={pick} onChange={e => setPick(e.target.value)} placeholder="🔍 Pridaj techniku — hľadaj názov, SKU…" style={inp} />
          {results.length > 0 && <div style={{ position: "absolute", left: 16, right: 16, zIndex: 5, background: C.s1, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: C.shadow, marginTop: 4, overflow: "hidden" }}>
            {results.map(r => (
              <div key={r.id} onClick={() => { addItem({ id: uid(), kind: "item", name: r.name, sku: r.sku, qty: 1, days: qt.days, unitCents: r.base_price_in_cents || 0, discountPct: r.zlava || 0 }); setPick(""); }}
                style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", padding: "8px 12px", cursor: "pointer", fontSize: 13 }}
                onMouseEnter={e => e.currentTarget.style.background = C.s2} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ color: C.t1, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                <span style={{ color: C.t2, fontFamily: C.mono, flexShrink: 0 }}>{r.base_price_in_cents ? eur(r.base_price_in_cents) : "—"}</span>
              </div>
            ))}
          </div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Btn onClick={() => addItem({ id: uid(), kind: "item", name: "", qty: 1, days: qt.days, unitCents: 0, discountPct: 0 })}>+ Prázdny riadok</Btn>
            {!vw.cats && <Btn onClick={() => addItem({ id: uid(), kind: "section", name: "Sekcia" })}>+ Sekcia</Btn>}
          </div>
        </div>

        {itemLines.length === 0 ? <div style={{ padding: 28, textAlign: "center", color: C.t3, fontSize: 13 }}>Zatiaľ žiadne položky — pridaj techniku vyššie</div>
          : vw.cats ? <>
            <ColHead />
            {groups.map(g => { const open = !collapsed[g.name]; return (
              <div key={g.name}>
                <div onClick={() => setCollapsed(c => ({ ...c, [g.name]: !c[g.name] }))} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: C.s2, borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
                  <span style={{ fontSize: 10, color: C.t3, transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }}>▾</span>
                  <span style={{ background: g.color, color: "#fff", fontFamily: C.display, fontWeight: 800, fontSize: 11.5, borderRadius: 8, padding: "3px 11px" }}>{g.name}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: C.t3 }}>{g.list.length} pol. · {eur(g.sum)}</span>
                </div>
                {open && g.list.map(l => <ItemRow key={l.id} l={l} />)}
              </div>
            ); })}
          </> : <>
            <ColHead />
            {qt.items.map(l => l.kind === "section"
              ? <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 16px", background: C.s2, borderBottom: `1px solid ${C.border}` }}>
                  <input value={l.name} onChange={e => setItem(l.id, { name: e.target.value })} style={{ ...inp, fontWeight: 800, flex: 1, padding: "5px 8px" }} />
                  <button onClick={() => delItem(l.id)} style={{ border: "none", background: "transparent", color: C.t3, cursor: "pointer", fontSize: 15 }}>×</button>
                </div>
              : <ItemRow key={l.id} l={l} />)}
          </>}
      </Card>

      {/* súčty */}
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div style={{ alignSelf: "start" }}>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}><span style={lbl}>ZĽAVA NA PONUKU %</span><input type="number" value={qt.orderDiscountPct || ""} onChange={e => set({ orderDiscountPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} style={inp} /></div>
              <div style={{ flex: 1 }}><span style={lbl}>DPH %</span><input type="number" value={qt.vatPct} onChange={e => set({ vatPct: Math.max(0, Number(e.target.value) || 0) })} style={inp} /></div>
            </div>
          </div>
          <div style={{ alignSelf: "end" }}>
            {[["Medzisúčet", eur(t.subtotal)], t.saved > 0 && ["Ušetríte (zľavy)", "− " + eur(t.saved), C.green], qt.orderDiscountPct > 0 && [`Zľava na ponuku (−${qt.orderDiscountPct}%)`, "− " + eur(t.orderDisc), C.red], [`DPH ${qt.vatPct}%`, eur(t.vat)]].filter(Boolean).map(([k, v, col], i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, color: col || C.t2 }}><span>{k}</span><span style={{ fontFamily: C.mono, fontWeight: 700 }}>{v}</span></div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 0", borderTop: `1px solid ${C.border}`, fontSize: 16, fontWeight: 800 }}><span style={{ color: C.t1 }}>Celkom</span><span style={{ color: C.gold, fontFamily: C.mono }}>{eur(t.grand)}</span></div>
          </div>
        </div>
      </Card>
      {prev && <QuotePreview quote={qt} company={company} onClose={() => setPrev(false)} />}
    </div>
  );
}

// Asistent ponuky — pravidlové návrhy (chýbajúce sprievodné veci) + učenie z histórie.
function QuoteAssistant({ items, onAdd }) {
  const cats = new Set(items.filter(i => i.kind !== "section").map(i => categorize(i.name)));
  const rules = QUOTE_RULES.filter(r => cats.has(r.need) && !cats.has(r.miss)).map(r => r.msg);
  const learned = quoteLearned(items);
  const empty = items.filter(i => i.kind !== "section").length === 0;
  return (
    <Card style={{ marginBottom: 14, borderColor: C.gold + "55", background: C.goldGlow }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.t1, fontFamily: C.display, marginBottom: 8 }}>🤖 Asistent ponuky</div>
      {empty ? <div style={{ fontSize: 12.5, color: C.t2 }}>Pridaj položky a asistent skontroluje, či niečo nechýba (batérie, káble, médiá…).</div> : <>
        {rules.length > 0 ? <div style={{ marginBottom: learned.length ? 12 : 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.t3, letterSpacing: "0.05em", marginBottom: 6 }}>SKONTROLUJ</div>
          {rules.map((m, i) => <div key={i} style={{ fontSize: 12.5, color: C.t1, padding: "3px 0", display: "flex", gap: 7 }}><span style={{ color: C.orange }}>⚠</span>{m}</div>)}
        </div> : <div style={{ fontSize: 12.5, color: C.green, fontWeight: 700, marginBottom: learned.length ? 12 : 0 }}>✓ Zostava vyzerá kompletne podľa pravidiel.</div>}
        {learned.length > 0 && <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.t3, letterSpacing: "0.05em", marginBottom: 6 }}>ČASTO SA PRIDÁVA SPOLU (z histórie)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {learned.map((s, i) => <button key={i} onClick={() => onAdd(s.name)} title={`v ${s.count} objednávkach`} style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 999, padding: "4px 11px", fontSize: 12, fontWeight: 600, color: C.t1, cursor: "pointer", fontFamily: C.font }}>+ {s.name} <span style={{ color: C.t3 }}>·{s.count}</span></button>)}
          </div>
        </div>}
      </>}
    </Card>
  );
}

// A4 náhľad ponuky — tlačiteľný do PDF (window.print), dizajn + jazyk podľa ponuky.
function QuotePreview({ quote: qt, company, onClose }) {
  const L = QL[qt.lang] || QL.sk;
  const t = quoteTotals(qt);
  const design = qt.design || "minimal";
  const accent = design === "accent" ? C.gold : design === "classic" ? "#1a1a1a" : C.t1;
  const headBg = design === "accent" ? C.gold : "transparent";
  const headFg = design === "accent" ? "#fff" : C.t1;
  const serif = design === "classic" ? "Georgia, 'Times New Roman', serif" : "inherit";
  const money = (c) => eur(c);
  const fmt = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString(qt.lang === "en" ? "en-GB" : qt.lang === "de" ? "de-DE" : "sk-SK") : "—";
  const th = { fontSize: 9.5, fontWeight: 800, color: "#888", textTransform: "uppercase", letterSpacing: "0.04em", padding: "0 6px 6px", textAlign: "left" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(20,20,24,0.55)", zIndex: 300, overflow: "auto", padding: "0 0 40px" }}>
      <style>{`@media print { body * { visibility: hidden !important; } #quote-sheet, #quote-sheet * { visibility: visible !important; } #quote-sheet { position: absolute !important; left: 0; top: 0; box-shadow: none !important; margin: 0 !important; } .no-print { display: none !important; } @page { size: A4; margin: 0; } }`}</style>
      <div className="no-print" style={{ position: "sticky", top: 0, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", background: "#1b1b20", color: "#fff", zIndex: 2 }}>
        <span style={{ fontWeight: 800 }}>{qt.number} · {qt.lang.toUpperCase()} · {QUOTE_DESIGNS.find(d => d[0] === design)?.[1]}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => window.print()} style={{ background: C.gold, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 800, cursor: "pointer", fontFamily: C.font }}>⤓ Uložiť ako PDF / Tlačiť</button>
          <button onClick={onClose} style={{ background: "transparent", color: "#fff", border: "1px solid #444", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer", fontFamily: C.font }}>✕ Zavrieť</button>
        </div>
      </div>

      <div id="quote-sheet" style={{ width: "210mm", minHeight: "297mm", background: "#fff", color: "#1a1a1a", margin: "24px auto", padding: "18mm 16mm", boxShadow: "0 10px 40px rgba(0,0,0,0.3)", fontFamily: serif, boxSizing: "border-box" }}>
        {/* hlavička */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", paddingBottom: 16, borderBottom: design === "minimal" ? `2px solid ${accent}` : "none", marginBottom: 22 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 900, color: accent, letterSpacing: "-0.01em", fontFamily: "inherit" }}>{company.name}</div>
            {company.tagline && <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.22em", color: design === "accent" ? C.gold : "#999", marginTop: 3 }}>{company.tagline}</div>}
          </div>
          <div style={{ textAlign: "right", fontSize: 10.5, color: "#555", lineHeight: 1.6 }}>
            {company.address && <div>{company.address}</div>}
            {company.email && <div>{company.email}</div>}
            {company.phone && <div>{company.phone}</div>}
            {company.web && <div>{company.web}</div>}
            {(company.ico || company.dic) && <div>{[company.ico && "IČO " + company.ico, company.dic && "DIČ " + company.dic].filter(Boolean).join(" · ")}</div>}
          </div>
        </div>

        {/* titul + meta + príjemca */}
        <div style={{ background: headBg, color: headFg, borderRadius: design === "accent" ? 10 : 0, padding: design === "accent" ? "14px 18px" : "0", marginBottom: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: "0.04em", color: design === "accent" ? "#fff" : accent }}>{L.quote}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <div style={{ fontSize: 9.5, fontWeight: 800, color: "#999", textTransform: "uppercase", letterSpacing: "0.06em" }}>{L.forr}</div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{qt.client.name || qt.client.company || "—"}</div>
            {qt.client.company && qt.client.name && <div>{qt.client.company}</div>}
            {qt.client.address && <div>{qt.client.address}</div>}
            {qt.client.email && <div>{qt.client.email}</div>}
            {qt.project && <div style={{ marginTop: 4 }}>{L.project}: <b>{qt.project}</b></div>}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.7, textAlign: "right" }}>
            <div>{L.no}: <b>{qt.number}</b></div>
            <div>{L.date}: <b>{fmt(qt.date)}</b></div>
            {qt.validUntil && <div>{L.valid}: <b>{fmt(qt.validUntil)}</b></div>}
          </div>
        </div>

        {/* tabuľka položiek */}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead><tr style={{ borderBottom: `2px solid ${accent}` }}>
            <th style={th}>{L.item}</th>
            <th style={{ ...th, textAlign: "center", width: 40 }}>{L.qty}</th>
            <th style={{ ...th, textAlign: "center", width: 40 }}>{L.days}</th>
            <th style={{ ...th, textAlign: "right", width: 70 }}>{L.unit}</th>
            <th style={{ ...th, textAlign: "center", width: 54 }}>{L.disc}</th>
            <th style={{ ...th, textAlign: "right", width: 80 }}>{L.total}</th>
          </tr></thead>
          <tbody>
            {qt.items.map(l => l.kind === "section" ? (
              <tr key={l.id}><td colSpan={6} style={{ padding: "12px 6px 4px", fontWeight: 800, fontSize: 12.5, color: accent, textTransform: "uppercase", letterSpacing: "0.03em" }}>{l.name}</td></tr>
            ) : (() => { const g = qLineGross(l), n = qLineNet(l), d = l.discountPct || 0; return (
              <tr key={l.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "7px 6px", fontWeight: 600 }}>{l.name}{l.sku && <span style={{ color: "#aaa", fontWeight: 400, fontSize: 10 }}> · {l.sku}</span>}</td>
                <td style={{ padding: "7px 6px", textAlign: "center" }}>{l.qty}</td>
                <td style={{ padding: "7px 6px", textAlign: "center" }}>{l.days}</td>
                <td style={{ padding: "7px 6px", textAlign: "right" }}>{money(l.unitCents)}</td>
                <td style={{ padding: "7px 6px", textAlign: "center" }}>{d > 0 ? <span style={{ background: "#fdeaea", color: "#d33", fontWeight: 800, borderRadius: 5, padding: "1px 6px", fontSize: 10.5 }}>−{d}%</span> : "—"}</td>
                <td style={{ padding: "7px 6px", textAlign: "right", fontWeight: 700 }}>{d > 0 ? <><span style={{ color: "#bbb", textDecoration: "line-through", fontWeight: 400, fontSize: 10, marginRight: 5 }}>{money(g)}</span>{money(n)}</> : money(n)}</td>
              </tr>
            ); })())}
          </tbody>
        </table>

        {/* súčty */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <div style={{ width: 280, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}><span>{L.subtotal}</span><span>{money(t.subtotal)}</span></div>
            {t.saved > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "#1f9d57", fontWeight: 700 }}><span>{L.youSave}</span><span>− {money(t.saved)}</span></div>}
            {qt.orderDiscountPct > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "#d33" }}><span>{L.orderDisc} (−{qt.orderDiscountPct}%)</span><span>− {money(t.orderDisc)}</span></div>}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "#666" }}><span>{L.vat} {qt.vatPct}%</span><span>{money(t.vat)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 0", marginTop: 6, borderTop: `2px solid ${accent}`, fontSize: 16, fontWeight: 900, color: accent }}><span>{L.grand}</span><span>{money(t.grand)}</span></div>
          </div>
        </div>

        {qt.notes && <div style={{ marginTop: 26, fontSize: 11, color: "#555", lineHeight: 1.6, borderTop: "1px solid #eee", paddingTop: 12 }}><b style={{ color: "#333" }}>{L.notes}:</b> {qt.notes}</div>}

        {/* päta */}
        <div style={{ marginTop: 34, paddingTop: 14, borderTop: "1px solid #eee", fontSize: 9.5, color: "#888", display: "flex", justifyContent: "space-between", lineHeight: 1.6 }}>
          <div>{L.thanks}</div>
          <div style={{ textAlign: "right" }}>{company.iban && <div>IBAN {company.iban}</div>}{company.bic && <div>BIC {company.bic}</div>}{company.icdph && <div>IČ DPH {company.icdph}</div>}</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════
function Customers() {
  const { customers, customerTotal, activeOrders, recentOrders, loadingCustomers } = useApp();
  const [q, setQ] = useState("");
  const allOrders = [...activeOrders, ...recentOrders];
  const enriched = customers.map(c => ({
    ...c,
    orderCount: allOrders.filter(o => o.customer?.id === c.id || o.customer_id === c.id).length,
    spent: allOrders.filter(o => (o.customer?.id===c.id||o.customer_id===c.id) && o.status!=="canceled").reduce((s,o)=>s+(o.grand_total_in_cents||0),0)/100,
  })).sort((a,b) => b.spent - a.spent);
  const filtered = enriched.filter(c => !q || (c.name||"").toLowerCase().includes(q.toLowerCase()) || (c.email||"").toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <Input value={q} onChange={setQ} placeholder="Hľadaj zákazníka, email…" style={{ flex: 1 }} />
        <div style={{ color: C.t3, fontSize: 12, marginLeft: 12 }}>Celkom: {customerTotal.toLocaleString()}</div>
      </div>
      <Card style={{ padding: 0 }}>
        {loadingCustomers ? <Spin /> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Zákazník","Email","Telefón","Objednávky","Útrata"].map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.t3, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}
                  onMouseEnter={e => e.currentTarget.style.background = C.s2}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <td style={{ padding: "10px 14px", color: C.t1, fontWeight: 500 }}>{c.name||"—"}{c.company&&<div style={{fontSize:11,color:C.t3}}>{c.company}</div>}</td>
                  <td style={{ padding: "10px 14px", color: C.t2 }}>{c.email||"—"}</td>
                  <td style={{ padding: "10px 14px", color: C.t2, fontFamily: C.mono, fontSize: 12 }}>{c.phone||"—"}</td>
                  <td style={{ padding: "10px 14px", color: C.t1 }}>{c.orderCount}</td>
                  <td style={{ padding: "10px 14px", color: c.spent > 0 ? C.gold : C.t3, fontFamily: C.mono }}>{c.spent > 0 ? `€${c.spent.toFixed(0)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div style={{ color: C.t3, fontSize: 11, marginTop: 8 }}>Zobrazuje sa posledných {customers.length} z {customerTotal.toLocaleString()} zákazníkov</div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════
function Stats() {
  const { recentOrders, activeOrders, meta, products, loadingRecent } = useApp();
  const allOrders = [...activeOrders, ...recentOrders];
  const statuses = meta.statuses || {};
  const payStatus = meta.payment_status || {};
  const tags = meta.tag_list || {};

  const totalRevCents = allOrders.filter(o=>o.status!=="canceled").reduce((s,o)=>s+(o.grand_total_in_cents||0),0);
  const totalRev = totalRevCents / 100;

  const now = new Date();
  const months = Array.from({length:6},(_,i)=>{
    const d = new Date(now.getFullYear(), now.getMonth()-(5-i), 1);
    return { key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label: d.toLocaleString("sk-SK",{month:"short"}), rev:0, cnt:0 };
  });
  allOrders.forEach(o => {
    if (!o.starts_at || o.status==="canceled") return;
    const k = o.starts_at.slice(0,7);
    const m = months.find(m=>m.key===k);
    if (m) { m.rev += (o.grand_total_in_cents||0)/100; m.cnt++; }
  });
  const maxRev = Math.max(...months.map(m=>m.rev), 1);

  // Top zákazníci podľa útraty (presunuté z Dashboardu)
  const topCustomers = useMemo(() => {
    const m = new Map();
    for (const o of allOrders) {
      if (o.status === "canceled") continue;
      const name = o.customer?.name; if (!name) continue;
      const cur = m.get(name) || { name, spent: 0, count: 0 };
      cur.spent += (o.grand_total_in_cents || 0) / 100; cur.count++; m.set(name, cur);
    }
    return [...m.values()].sort((a,b) => b.spent - a.spent).slice(0, 8);
  }, [allOrders]);
  const maxSpent = Math.max(1, ...topCustomers.map(c => c.spent));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* KPIs from meta */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          { l: "Objednávok celkom", v: Object.values(statuses).reduce((a,b)=>a+b,0).toLocaleString() },
          { l: "Vydaných práve teraz", v: (statuses.started||0) },
          { l: "Zaplatených", v: (payStatus.paid||0).toLocaleString() },
          { l: "Nezaplatených", v: (payStatus.payment_due||0).toLocaleString() },
          { l: "Produktov v inventári", v: products.length },
          { l: "Tržby (posledných 200)", v: `€${Math.round(totalRev).toLocaleString("sk-SK")}` },
        ].map(k => (
          <Card key={k.l} style={{ flex: 1, minWidth: 120, textAlign: "center", padding: "16px 12px" }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.gold, lineHeight: 1 }}>{k.v}</div>
            <div style={{ fontSize: 10, color: C.t3, marginTop: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k.l}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Revenue chart */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 20 }}>TRŽBY — POSLEDNÝCH 6 MESIACOV</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
            {months.map(m => (
              <div key={m.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ fontSize: 10, color: C.t3, fontFamily: C.mono }}>{m.rev > 0 ? `€${Math.round(m.rev)}` : ""}</div>
                <div style={{ width: "100%", background: m.rev > 0 ? C.gold : C.border, borderRadius: "3px 3px 0 0", height: `${(m.rev/maxRev)*90}px`, minHeight: m.rev > 0 ? 4 : 2 }} />
                <div style={{ fontSize: 10, color: C.t3 }}>{m.label}</div>
              </div>
            ))}
          </div>
          {loadingRecent && <div style={{ fontSize: 11, color: C.t3, textAlign: "center", marginTop: 8 }}>Načítavajú sa dáta…</div>}
        </Card>

        {/* Status breakdown */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>STAV VŠETKÝCH OBJEDNÁVOK</div>
          {Object.entries(statuses).map(([s, cnt]) => {
            const sc = STATUS_MAP[s]; if (!sc || !cnt) return null;
            const total = Object.values(statuses).reduce((a,b)=>a+b,0);
            const pct = ((cnt/total)*100).toFixed(0);
            return (
              <div key={s} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: sc.color }}>{sc.label}</span>
                  <span style={{ color: C.t3 }}>{cnt.toLocaleString()} ({pct}%)</span>
                </div>
                <ProgressBar pct={Number(pct)} color={sc.color} />
              </div>
            );
          })}
        </Card>

        {/* Payment status */}
        {Object.keys(payStatus).length > 0 && (
          <Card>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>PLATOBNÝ STAV</div>
            {Object.entries(payStatus).map(([s, cnt]) => {
              const colors = { paid: C.green, payment_due: C.red, partially_paid: C.orange, overpaid: C.purple };
              const labels = { paid: "Zaplatené", payment_due: "Nezaplatené", partially_paid: "Čiastočne", overpaid: "Preplatok" };
              return (
                <div key={s} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                  <span style={{ color: colors[s] || C.t2 }}>{labels[s] || s}</span>
                  <span style={{ color: C.t1, fontFamily: C.mono, fontWeight: 700 }}>{cnt.toLocaleString()}</span>
                </div>
              );
            })}
          </Card>
        )}

        {/* Top zákazníci */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>TOP ZÁKAZNÍCI · PODĽA ÚTRATY</div>
          {topCustomers.length === 0 ? <Empty icon="👥" title="Načítava sa…" sub="" /> : topCustomers.map((c, i) => (
            <div key={c.name} style={{ marginBottom: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: C.t2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}><span style={{ color: C.t3, marginRight: 6, fontFamily: C.mono }}>{String(i+1).padStart(2,"0")}</span>{c.name}</span>
                <span style={{ color: C.t1, fontWeight: 700, fontFamily: C.mono }}>€{Math.round(c.spent).toLocaleString("sk-SK")}</span>
              </div>
              <div style={{ background: C.s2, borderRadius: 5, height: 6, overflow: "hidden" }}>
                <div style={{ width: `${(c.spent/maxSpent)*100}%`, height: "100%", background: C.gold, borderRadius: 5 }} />
              </div>
            </div>
          ))}
        </Card>

        {/* Tags */}
        {Object.keys(tags).length > 0 && (
          <Card>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>ŠTÍTKY OBJEDNÁVOK</div>
            {Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([tag, cnt]) => (
              <div key={tag} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                <span style={{ color: C.t1 }}>{tag}</span>
                <span style={{ color: C.gold, fontFamily: C.mono }}>{cnt.toLocaleString()}</span>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════
function Calendar({ nav }) {
  const { allOrders, loadingActive } = useApp();
  const [cur, setCur] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [view, setView] = useState("products"); // products | timeline | month
  const [winStart, setWinStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 2); d.setHours(0,0,0,0); return d; });
  const [search, setSearch] = useState("");
  const today = new Date();
  const todayStr = dstrOf(today);
  const y = cur.getFullYear(), m = cur.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const firstDay = (new Date(y, m, 1).getDay() + 6) % 7;
  const monthStartStr = `${y}-${pad(m + 1)}-01`;
  const monthEndStr = `${y}-${pad(m + 1)}-${pad(daysInMonth)}`;
  const isToday = (d) => today.getDate() === d && today.getMonth() === m && today.getFullYear() === y;
  const isWeekend = (d) => { const wd = new Date(y, m, d).getDay(); return wd === 0 || wd === 6; };

  // ── Products (bookings) view: 10-day window ──
  const WIN = 10;
  const winDays = Array.from({ length: WIN }, (_, i) => { const d = new Date(winStart); d.setDate(d.getDate() + i); return d; });
  const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const winStartStr = dstr(winDays[0]), winEndStr = dstr(winDays[WIN-1]);
  const DAY_CAP = 60;
  const winOrders = useMemo(() => allOrders
    .filter(o => o.starts_at && o.stops_at && !["canceled","archived"].includes(o.status)
      && o.starts_at.slice(0,10) <= winEndStr && o.stops_at.slice(0,10) >= winStartStr)
    .sort((a,b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, DAY_CAP), [allOrders, winStartStr, winEndStr]);

  // Lazy-load order details (lines) for the visible window; getDetail is
  // LS-cached by updated_at, so revisits cost zero API calls.
  const [details, setDetails] = useState({});
  const [detailsPending, setDetailsPending] = useState(0);
  useEffect(() => {
    if (view !== "products" || winOrders.length === 0) return;
    const missing = winOrders.filter(o => !details[o.id]);
    if (missing.length === 0) return;
    let alive = true;
    setDetailsPending(missing.length);
    Promise.allSettled(missing.map(o =>
      api.orders.getDetail(o).then(d => { if (alive) setDetails(prev => ({ ...prev, [o.id]: d })); })
        .finally(() => { if (alive) setDetailsPending(p => Math.max(0, p - 1)); })
    ));
    return () => { alive = false; };
  }, [view, winOrders.map(o => o.id).join(",")]);

  // product title → bookings, lane-packed to handle overlaps.
  // Rovnaký produkt v jednej objednávke sa agreguje (sčíta qty), bundle
  // príslušenstvo (parent_line_id) sa defaultne skrýva.
  const [withAccessories, setWithAccessories] = useState(false);
  const productRows = useMemo(() => {
    const map = new Map();
    for (const o of winOrders) {
      const det = details[o.id];
      if (!det) continue;
      for (const l of det.lines || []) {
        if (!l.title || l.line_type === "section" || !(l.quantity > 0)) continue;
        if (!withAccessories && l.parent_line_id) continue;
        const cur2 = map.get(l.title) || { title: l.title, byOrder: new Map() };
        const b = cur2.byOrder.get(o.id) || { order: o, qty: 0, s: o.starts_at.slice(0,10), e: o.stops_at.slice(0,10) };
        b.qty += Math.round(l.quantity);
        cur2.byOrder.set(o.id, b);
        map.set(l.title, cur2);
      }
    }
    let rows2 = [...map.values()].map(r => ({ title: r.title, bookings: [...r.byOrder.values()] }));
    const ql = search.trim().toLowerCase();
    if (ql) rows2 = rows2.filter(r => r.title.toLowerCase().includes(ql) || r.bookings.some(b => (b.order.customer?.name||"").toLowerCase().includes(ql)));
    rows2.sort((a,b) => b.bookings.length - a.bookings.length || a.title.localeCompare(b.title));
    for (const r of rows2) {
      const lanes = [];
      for (const b of [...r.bookings].sort((x,z) => x.s.localeCompare(z.s))) {
        const lane = lanes.find(L => L[L.length-1].e < b.s);
        lane ? lane.push(b) : lanes.push([b]);
      }
      r.lanes = lanes;
    }
    return rows2.slice(0, 40);
  }, [winOrders, details, search, withAccessories]);

  const colOf = (ds) => { // 1-based day column in window, clamped
    if (ds <= winStartStr) return 1;
    if (ds >= winEndStr) return WIN;
    return winDays.findIndex(d => dstr(d) === ds) + 1;
  };
  const fmtT = (iso) => (iso || "").slice(11, 16);
  const rangeLabel = `${winDays[0].getDate()}. ${winDays[0].toLocaleString("sk-SK",{month:"short"})} – ${winDays[WIN-1].getDate()}. ${winDays[WIN-1].toLocaleString("sk-SK",{month:"short"})} (${WIN} dní)`;

  const shiftWin = (dir) => setWinStart(p => { const d = new Date(p); d.setDate(d.getDate() + dir * 7); return d; });
  const goPrev = () => view === "products" ? shiftWin(-1) : setCur(new Date(y, m-1, 1));
  const goNext = () => view === "products" ? shiftWin(1) : setCur(new Date(y, m+1, 1));
  const goToday = () => { setWinStart(() => { const d = new Date(); d.setDate(d.getDate()-2); d.setHours(0,0,0,0); return d; }); setCur(new Date(today.getFullYear(), today.getMonth(), 1)); };

  // Orders overlapping the visible month
  const rows = allOrders
    .filter(o => o.starts_at && o.stops_at && o.starts_at.slice(0,10) <= monthEndStr && o.stops_at.slice(0,10) >= monthStartStr)
    .sort((a,b) => a.starts_at.slice(0,10).localeCompare(b.starts_at.slice(0,10)));
  const shown = rows.slice(0, 80);

  const getDayOrders = d => {
    const ds = `${y}-${pad(m+1)}-${pad(d)}`;
    return rows.filter(o => ds >= o.starts_at.slice(0,10) && ds <= o.stops_at.slice(0,10));
  };

  const ToggleBtn = ({ v, children }) => (
    <button onClick={() => setView(v)} style={{ background: view===v ? C.t1 : "transparent", color: view===v ? "#fff" : C.t2, border: `1px solid ${view===v ? C.t1 : C.border}`, borderRadius: 7, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{children}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Btn v="ghost" onClick={goPrev}>‹</Btn>
          <Btn v="ghost" onClick={goNext}>›</Btn>
          <Btn v="primary" onClick={goToday} style={{ fontSize: 12 }}>Dnes</Btn>
          <h2 style={{ margin: "0 0 0 8px", color: C.t1, fontFamily: C.display, fontSize: 17, fontWeight: 800, textTransform: view === "products" ? "none" : "capitalize" }}>
            {view === "products" ? rangeLabel : cur.toLocaleString("sk-SK", {month:"long", year:"numeric"})}
          </h2>
          {view === "products" && detailsPending > 0 && <span style={{ fontSize: 11, color: C.t3 }}>načítavam detaily… ({detailsPending})</span>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {view === "products" && <>
            <Input value={search} onChange={setSearch} placeholder="⌕ Hľadaj produkt / zákazníka…" style={{ width: 220, padding: "6px 11px", fontSize: 12 }} />
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: C.t2, cursor: "pointer", userSelect: "none" }}>
              <input type="checkbox" checked={withAccessories} onChange={e => setWithAccessories(e.target.checked)} style={{ accentColor: C.gold }} />
              aj príslušenstvo
            </label>
          </>}
          <ToggleBtn v="products">🎥 Produkty</ToggleBtn>
          <ToggleBtn v="timeline">▦ Objednávky</ToggleBtn>
          <ToggleBtn v="month">▤ Mesiac</ToggleBtn>
        </div>
      </div>

      {loadingActive && allOrders.length === 0 ? <Card><Spin /></Card> : view === "products" ? (
        /* ── PRODUCTS / BOOKINGS (resource timeline) ─────────────────── */
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 860 }}>
              {/* month label + day header */}
              <div style={{ display: "grid", gridTemplateColumns: `220px repeat(${WIN}, 1fr)`, borderBottom: `1px solid ${C.border}`, background: C.s1 }}>
                <div style={{ padding: "12px 14px", fontSize: 11, color: C.t2, fontWeight: 700 }}>Technika</div>
                {winDays.map((d, i) => {
                  const wknd = d.getDay() === 0 || d.getDay() === 6;
                  const tod = dstr(d) === todayStr;
                  return (
                    <div key={i} style={{ textAlign: "center", padding: "7px 0 8px", background: wknd ? C.s2 : "transparent", borderLeft: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", color: tod ? C.gold : C.t3, textTransform: "uppercase" }}>{d.toLocaleString("sk-SK",{weekday:"short"}).replace(".","")}</div>
                      <div style={{ marginTop: 2, fontSize: 12, fontWeight: tod ? 800 : 600 }}>
                        {tod
                          ? <span style={{ display: "inline-flex", width: 22, height: 22, borderRadius: "50%", background: C.gold, color: "#fff", alignItems: "center", justifyContent: "center" }}>{d.getDate()}</span>
                          : <span style={{ color: C.t1 }}>{d.getDate()}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* product rows */}
              {productRows.length === 0 ? (
                detailsPending > 0 ? <div style={{ padding: 30 }}><Spin size={22} /></div>
                : <Empty icon="🎥" title={search ? "Žiadny produkt nezodpovedá hľadaniu" : "Žiadne bookingy v tomto okne"} sub="" />
              ) : productRows.map(r => (
                <div key={r.title} style={{ display: "grid", gridTemplateColumns: `220px 1fr`, borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ padding: "10px 14px", borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.title}>{r.title}</div>
                    <div style={{ fontSize: 10.5, color: C.t3, marginTop: 1 }}>{r.bookings.length} {r.bookings.length === 1 ? "booking" : "bookingy"}</div>
                  </div>
                  <div>
                    {r.lanes.map((lane, li) => (
                      <div key={li} style={{ display: "grid", gridTemplateColumns: `repeat(${WIN}, 1fr)`, minHeight: 52, alignItems: "center", position: "relative" }}>
                        {winDays.map((d, i) => <div key={i} style={{ gridColumn: i+1, height: "100%", borderLeft: `1px solid ${C.border}22`, background: (d.getDay()===0||d.getDay()===6) ? `${C.s2}66` : "transparent" }} />)}
                        {lane.map(b => {
                          const sm = STATUS_MAP[b.order.status] || STATUS_MAP.new;
                          const c1 = colOf(b.s), c2 = colOf(b.e);
                          return (
                            <div key={b.order.id + b.s} onClick={() => nav("order_detail", b.order.id)}
                              style={{ gridColumn: `${c1} / ${c2 + 1}`, gridRow: 1, margin: "5px 3px", background: sm.bg, border: `1.5px solid ${sm.color}`, borderRadius: 9, padding: "5px 9px", cursor: "pointer", overflow: "hidden", zIndex: 1 }}
                              title={`${b.qty}x ${r.title} · ${b.order.customer?.name || "—"} · #${b.order.number} · ${b.s} → ${b.e}`}>
                              <div style={{ fontSize: 11.5, fontWeight: 700, color: sm.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {b.qty}x <span style={{ fontWeight: 600 }}>· {b.order.customer?.name || "—"}</span>
                              </div>
                              <div style={{ fontSize: 10, color: sm.color, opacity: 0.75, fontFamily: C.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {fmtT(b.order.starts_at)} – {fmtT(b.order.stops_at)} · #{b.order.number}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {winOrders.length >= DAY_CAP && <div style={{ padding: "9px 14px", fontSize: 11, color: C.t3, borderTop: `1px solid ${C.border}` }}>Zobrazených prvých {DAY_CAP} objednávok v okne — zúž okno alebo použi hľadanie</div>}
        </Card>
      ) : view === "timeline" ? (
        /* ── TIMELINE / GANTT ───────────────────────────────────────── */
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 760 }}>
              {/* day header */}
              <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${daysInMonth}, minmax(22px, 1fr))`, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.s1, zIndex: 2 }}>
                <div style={{ padding: "10px 14px", fontSize: 10, color: C.t3, fontWeight: 700, letterSpacing: "0.06em" }}>OBJEDNÁVKA</div>
                {Array.from({length: daysInMonth}, (_,i)=>i+1).map(d => (
                  <div key={d} style={{ textAlign: "center", padding: "5px 0", fontSize: 10, fontWeight: 500, color: isWeekend(d) ? C.t3 : C.t2, background: isWeekend(d) ? C.s2 : "transparent" }}>
                    {isToday(d)
                      ? <span style={{ display: "inline-flex", width: 18, height: 18, borderRadius: "50%", background: C.gold, color: "#fff", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>{d}</span>
                      : d}
                  </div>
                ))}
              </div>
              {/* rows */}
              {shown.length === 0 ? <Empty icon="🗓️" title="Žiadne objednávky v tomto mesiaci" sub="" /> : shown.map(o => {
                const s = o.starts_at.slice(0,10), e = o.stops_at.slice(0,10);
                const startCol = s < monthStartStr ? 1 : new Date(s).getDate();
                const endCol = e > monthEndStr ? daysInMonth : new Date(e).getDate();
                const sm = STATUS_MAP[o.status] || STATUS_MAP.new;
                return (
                  <div key={o.id} style={{ display: "grid", gridTemplateColumns: `200px repeat(${daysInMonth}, minmax(22px, 1fr))`, alignItems: "center", borderBottom: `1px solid ${C.border}`, minHeight: 38 }}>
                    <div style={{ padding: "6px 14px", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      <span style={{ color: C.gold, fontFamily: C.mono, fontWeight: 700 }}>#{o.number}</span>
                      <span style={{ color: C.t2, marginLeft: 6 }}>{o.customer?.name || "—"}</span>
                    </div>
                    <div style={{ gridColumn: `${startCol + 1} / ${endCol + 2}`, height: 26, background: sm.bg, border: `1.5px solid ${sm.color}`, borderRadius: 8, margin: "0 2px", display: "flex", alignItems: "center", gap: 6, padding: "0 8px", overflow: "hidden" }} title={`#${o.number} · ${o.customer?.name || "—"} · ${sm.label} · ${s} → ${e}`}>
                      {o.item_count > 0 && <span style={{ fontSize: 10.5, color: sm.color, fontWeight: 800, whiteSpace: "nowrap" }}>{o.item_count}x</span>}
                      <span style={{ fontSize: 11, color: sm.color, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer?.name || "—"}</span>
                      <span style={{ fontSize: 10, color: sm.color, opacity: 0.7, fontFamily: C.mono, whiteSpace: "nowrap" }}>#{o.number}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {rows.length > 80 && <div style={{ padding: "10px 14px", fontSize: 11, color: C.t3, borderTop: `1px solid ${C.border}` }}>+ {rows.length - 80} ďalších objednávok v tomto mesiaci</div>}
        </Card>
      ) : (
        /* ── MONTH GRID ─────────────────────────────────────────────── */
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 8 }}>
            {["Po","Ut","St","Št","Pi","So","Ne"].map(d => <div key={d} style={{ textAlign: "center", fontSize: 11, color: C.t3, fontWeight: 700, padding: "4px 0" }}>{d}</div>)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
            {Array.from({length:firstDay}).map((_,i) => <div key={`e${i}`}/>)}
            {Array.from({length:daysInMonth},(_,i)=>i+1).map(day => {
              const dos = getDayOrders(day);
              const out = dos.filter(o=>o.status==="started").length;
              const res = dos.filter(o=>o.status==="reserved").length;
              const tod = isToday(day);
              return (
                <div key={day} style={{ background: tod ? C.goldGlow : C.s2, border: `1px solid ${tod ? C.gold : C.border}`, borderRadius: 8, padding: "7px 6px", minHeight: 62 }}>
                  <div style={{ fontSize: 12, fontWeight: tod?800:500, color: tod?C.gold:C.t2, marginBottom: 4 }}>{day}</div>
                  {out > 0 && <div style={{ fontSize: 10, fontWeight: 600, background: STATUS_MAP.started.bg, color: STATUS_MAP.started.color, borderRadius: 4, padding: "1px 5px", marginBottom: 2 }}>{out} vyd.</div>}
                  {res > 0 && <div style={{ fontSize: 10, fontWeight: 600, background: STATUS_MAP.reserved.bg, color: STATUS_MAP.reserved.color, borderRadius: 4, padding: "1px 5px" }}>{res} rez.</div>}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// NAV
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// CATEGORIES MANAGER (Inventár → Kategórie)
// ═══════════════════════════════════════════════
function CategoriesManager() {
  const { categories, saveCategories } = useApp();
  const [draft, setDraft] = useState(() => categories.map(c => ({ ...c, keywords: [...(c.keywords || [])] })));
  const dirty = JSON.stringify(draft) !== JSON.stringify(categories);

  const upd = (i, patch) => setDraft(d => d.map((c, j) => j === i ? { ...c, ...patch } : c));
  const move = (i, dir) => setDraft(d => { const j = i + dir; if (j < 0 || j >= d.length) return d; const n = [...d]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const del = (i) => setDraft(d => d.filter((_, j) => j !== i));
  const add = () => setDraft(d => [...d, { name: "Nová kategória", color: "#7c5cff", keywords: [] }]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 18, fontWeight: 800 }}>Kategórie techniky</h2>
          <p style={{ margin: "4px 0 0", color: C.t2, fontSize: 13 }}>Názvy, farby a kľúčové slová pre triedenie techniky vo Výdaji, Príjme a objednávkach.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {dirty && <Btn v="ghost" onClick={() => setDraft(categories.map(c => ({ ...c, keywords: [...(c.keywords || [])] })))}>Zahodiť</Btn>}
          <Btn v={dirty ? "primary" : "ghost"} disabled={!dirty} onClick={() => saveCategories(draft.map((c, i) => ({ ...c, name: c.name.trim() || `Kategória ${i + 1}` })))}>Uložiť zmeny</Btn>
        </div>
      </div>

      <div style={{ fontSize: 12, color: C.t3, marginBottom: 14 }}>
        Priradenie: <b>(1)</b> ak má objednávka sekciu so zhodným názvom, použije ju · <b>(2)</b> inak podľa kľúčových slov v názve produktu. Poradie určuje prioritu (zhora nadol).
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "46px 1fr 1.6fr 64px", gap: 0, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, background: C.s2, fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", color: C.t3, textTransform: "uppercase" }}>
          <div>Farba</div><div>Názov</div><div>Kľúčové slová (oddelené čiarkou)</div><div style={{ textAlign: "right" }}>Poradie</div>
        </div>
        {draft.map((c, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "46px 1fr 1.6fr 64px", gap: 10, alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${C.border}` }}>
            <input type="color" value={c.color} onChange={e => upd(i, { color: e.target.value })} style={{ width: 32, height: 32, border: `1px solid ${C.border}`, borderRadius: 8, background: "none", cursor: "pointer", padding: 0 }} />
            <div>
              <input value={c.name} onChange={e => upd(i, { name: e.target.value })}
                style={{ width: "100%", border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 9px", fontSize: 13, fontWeight: 700, fontFamily: C.display, color: C.t1, outline: "none", background: C.s1 }} />
              <span style={{ display: "inline-block", marginTop: 5, background: c.color, color: "#fff", fontFamily: C.display, fontWeight: 800, fontSize: 10.5, borderRadius: 9, padding: "3px 10px" }}>{(c.name || "—").toLowerCase()}</span>
            </div>
            <input value={(c.keywords || []).join(", ")} onChange={e => upd(i, { keywords: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
              placeholder="napr. alexa, venice, fx6…"
              style={{ width: "100%", border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 9px", fontSize: 12, fontFamily: C.font, color: C.t2, outline: "none", background: C.s1 }} />
            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} title="Vyššie" style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 6, width: 22, height: 22, cursor: i === 0 ? "default" : "pointer", color: C.t2, opacity: i === 0 ? 0.4 : 1 }}>↑</button>
              <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} title="Nižšie" style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 6, width: 22, height: 22, cursor: i === draft.length - 1 ? "default" : "pointer", color: C.t2, opacity: i === draft.length - 1 ? 0.4 : 1 }}>↓</button>
              <button onClick={() => del(i)} title="Zmazať" style={{ border: `1px solid ${C.red}44`, background: "#fdeaea", borderRadius: 6, width: 22, height: 22, cursor: "pointer", color: C.red, fontWeight: 800 }}>×</button>
            </div>
          </div>
        ))}
        <div style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Btn v="ghost" onClick={add}>+ Pridať kategóriu</Btn>
          <span style={{ fontSize: 11, color: C.t3 }}>{draft.length} kategórií · fallback „{CAT_FALLBACK.name}"</span>
        </div>
      </Card>
    </div>
  );
}

// ── Editor typov produkcie (Nastavenia → Typy produkcie) ──
function ProdTagsManager() {
  const { prodTags, saveProdTags } = useApp();
  const [draft, setDraft] = useState(() => prodTags.map(p => ({ ...p })));
  const dirty = JSON.stringify(draft) !== JSON.stringify(prodTags);
  const upd = (i, patch) => setDraft(d => d.map((c, j) => j === i ? { ...c, ...patch } : c));
  const move = (i, dir) => setDraft(d => { const j = i + dir; if (j < 0 || j >= d.length) return d; const n = [...d]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const del = (i) => setDraft(d => d.filter((_, j) => j !== i));
  const add = () => setDraft(d => [...d, { name: "NEW TYPE", color: "#7c5cff" }]);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, color: C.t2, fontSize: 13, maxWidth: 520 }}>Typy produkcie sa dajú priradiť k objednávke (zobrazia sa vedľa stavu). Názvy a farby sú voľne editovateľné.</p>
        <div style={{ display: "flex", gap: 8 }}>
          {dirty && <Btn v="ghost" onClick={() => setDraft(prodTags.map(p => ({ ...p })))}>Zahodiť</Btn>}
          <Btn v={dirty ? "primary" : "ghost"} disabled={!dirty} onClick={() => saveProdTags(draft.map((c, i) => ({ ...c, name: (c.name || `Typ ${i + 1}`).toUpperCase() })))}>Uložiť zmeny</Btn>
        </div>
      </div>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {draft.map((c, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "46px 1fr 220px 64px", gap: 10, alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${C.border}` }}>
            <input type="color" value={c.color} onChange={e => upd(i, { color: e.target.value })} style={{ width: 32, height: 32, border: `1px solid ${C.border}`, borderRadius: 8, background: "none", cursor: "pointer", padding: 0 }} />
            <input value={c.name} onChange={e => upd(i, { name: e.target.value })} style={{ width: "100%", border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 9px", fontSize: 13, fontWeight: 700, fontFamily: C.display, color: C.t1, outline: "none", background: C.s1 }} />
            <span style={{ justifySelf: "start", border: `1.5px solid ${c.color}`, color: c.color, background: "#fff", fontFamily: C.display, fontWeight: 800, fontSize: 10.5, borderRadius: 9, padding: "3px 10px" }}>{(c.name || "—").toUpperCase()}</span>
            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 6, width: 22, height: 22, cursor: "pointer", color: C.t2, opacity: i === 0 ? 0.4 : 1 }}>↑</button>
              <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 6, width: 22, height: 22, cursor: "pointer", color: C.t2, opacity: i === draft.length - 1 ? 0.4 : 1 }}>↓</button>
              <button onClick={() => del(i)} style={{ border: `1px solid ${C.red}44`, background: "#fdeaea", borderRadius: 6, width: 22, height: 22, cursor: "pointer", color: C.red, fontWeight: 800 }}>×</button>
            </div>
          </div>
        ))}
        <div style={{ padding: "12px 14px" }}><Btn v="ghost" onClick={add}>+ Pridať typ produkcie</Btn></div>
      </Card>
    </div>
  );
}

// ── Nastavenia → Zobrazenie ──
function DisplaySettings() {
  const { display, setDisplay } = useApp();
  // donačítaj všetky fonty pre živý náhľad v pickeri
  useEffect(() => { APP_FONTS.forEach(ensureFontLoaded); }, []);
  const curFont = display.font || "Satoshi";
  const Opt = ({ k, label, desc, options }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: `1px solid ${C.border}`, gap: 16 }}>
      <div><div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 13.5, color: C.t1 }}>{label}</div><div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{desc}</div></div>
      <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2, flexShrink: 0 }}>
        {options.map(([v, l]) => (
          <button key={v} onClick={() => setDisplay({ [k]: v })} style={{ border: "none", background: display[k] === v ? C.s1 : "transparent", color: display[k] === v ? C.t1 : C.t3, borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: display[k] === v ? 700 : 500, cursor: "pointer", fontFamily: C.font, boxShadow: display[k] === v ? C.shadow : "none" }}>{l}</button>
        ))}
      </div>
    </div>
  );
  const Bool = ({ k, label, desc, def }) => {
    const cur = display[k] ?? def;
    return (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: `1px solid ${C.border}`, gap: 16 }}>
        <div><div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 13.5, color: C.t1 }}>{label}</div><div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{desc}</div></div>
        <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2, flexShrink: 0 }}>
          {[["Skryť", false], ["Zobraziť", true]].map(([l, v]) => (
            <button key={l} onClick={() => setDisplay({ [k]: v })} style={{ border: "none", background: cur === v ? C.s1 : "transparent", color: cur === v ? C.t1 : C.t3, borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: cur === v ? 700 : 500, cursor: "pointer", fontFamily: C.font, boxShadow: cur === v ? C.shadow : "none" }}>{l}</button>
          ))}
        </div>
      </div>
    );
  };
  return (
    <Card>
      <div style={{ padding: "2px 0 12px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
          <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 13.5, color: C.t1 }}>Font (celá appka)</div>
          <div style={{ fontSize: 12, color: C.t2 }}>Predvolený <b>Satoshi</b> · zmena sa prejaví okamžite všade vrátane TV pohľadu</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {APP_FONTS.map(f => { const cur = curFont === f.name; return (
            <button key={f.name} onClick={() => setDisplay({ font: f.name })} style={{ border: `1.5px solid ${cur ? C.gold : C.border}`, background: cur ? C.goldGlow : C.s1, borderRadius: 10, padding: "8px 13px", cursor: "pointer", textAlign: "left", minWidth: 132 }}>
              <div style={{ fontFamily: `${f.stack}, ${FONT_FALLBACK}`, fontSize: 16, fontWeight: 700, color: cur ? C.gold : C.t1 }}>{f.name}{f.name === "Satoshi" ? "" : ""}</div>
              <div style={{ fontFamily: `${f.stack}, ${FONT_FALLBACK}`, fontSize: 11.5, color: C.t3, marginTop: 1 }}>Ag 0123 · Filmsupport</div>
            </button>
          ); })}
        </div>
      </div>
      <Opt k="bundleView" label="Zobrazenie bundlov v zozname techniky" desc="Collapsed = len názov setu + počet kusov · Expanded = rozbalené komponenty" options={[["expanded", "Expanded"], ["collapsed", "Collapsed"]]} />
      <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 12, letterSpacing: "0.04em", color: C.t3, margin: "18px 0 2px" }}>IDENTIFIKÁTOR (SKU)</div>
      <Bool k="idOrders"  def={false} label="Identifikátor v objednávkach"   desc="SKU pod názvom položky v detaile objednávky · predvolene skrytý" />
      <Bool k="idQuotes"  def={false} label="Identifikátor v cenových ponukách" desc="SKU v detaile konceptu / cenovej ponuky · predvolene skrytý" />
      <Bool k="idPicking" def={true}  label="Identifikátor vo výdaji"          desc="SKU pri príprave výdaja · predvolene zobrazený" />
      <Bool k="idCheckin" def={true}  label="Identifikátor v príjme"           desc="SKU pri kontrole vrátenia · predvolene zobrazený" />
      <p style={{ margin: "12px 0 0", color: C.t3, fontSize: 12 }}>Ďalšie možnosti (stĺpce, predvolené zoskupenie, default filter dashboardu…) doplníme postupne.</p>
    </Card>
  );
}

// ── Nastavenia (sekcia vľavo) — karty s možnosťami customizácie ──
function Settings() {
  const [tab, setTab] = useState("categories");
  const TABS = [["categories", "Kategórie techniky"], ["prodtags", "Typy produkcie"], ["display", "Zobrazenie"]];
  return (
    <div>
      <h2 style={{ margin: "0 0 14px", color: C.t1, fontFamily: C.display, fontSize: 20, fontWeight: 800 }}>Nastavenia</h2>
      <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: `1px solid ${C.border}`, paddingBottom: 0 }}>
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ border: "none", background: "none", padding: "8px 12px", marginBottom: -1, fontSize: 13, fontWeight: 700, fontFamily: C.display, cursor: "pointer", color: tab === k ? C.t1 : C.t3, borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}` }}>{l}</button>
        ))}
      </div>
      {tab === "categories" && <CategoriesManager />}
      {tab === "prodtags" && <ProdTagsManager />}
      {tab === "display" && <DisplaySettings />}
    </div>
  );
}

// ═══════════════════════════════════════════════
// SMENY (interná rota) — Fáza 1: timeline + dátový model + ručná správa
// Owner-only, localStorage. 3 kalendáre nad rovnakými dátami:
//   • Obmedzenia  — kedy pracovník NEMÔŽE (celodenná nedostupnosť)
//   • Smeny       — pridelené smeny (potvrdené / návrh)
//   • Porovnanie  — prekrytie + kolízie (neverejné), ručný zásah
// Fázy 2–3 (auto-generovanie z pravidiel/hodnotenia, sadzby/honoráre) nadviažu.
// ═══════════════════════════════════════════════
const SHIFT_GROUPS = [
  { id: "warehouse", label: "Warehouse", color: "#6d4aff" },
  { id: "onset",     label: "On set",    color: "#1f9d57" },
  { id: "drivers",   label: "Drivers",   color: "#3b82f6" },
  { id: "cleaners",  label: "Cleaners",  color: "#e0663a" },
];
const G_BY_ID = Object.fromEntries(SHIFT_GROUPS.map(g => [g.id, g]));
const SEED_STAFF = [
  { id: "s1", name: "Ján Kováč",      group: "warehouse", role: "Branch manager" },
  { id: "s2", name: "Peter Novák",    group: "warehouse", role: "Technik" },
  { id: "s3", name: "Eva Horváthová", group: "warehouse", role: "Technik" },
  { id: "s4", name: "Mark Reeves",    group: "onset",     role: "Gaffer" },
  { id: "s5", name: "Lisa Hart",      group: "onset",     role: "Best boy" },
  { id: "s6", name: "Tomáš Veselý",   group: "drivers",   role: "Driver" },
  { id: "s7", name: "Anna Malá",      group: "cleaners",  role: "Cleaner" },
];
const STAFF_KEY = "fs_staff_v1", SHIFTS_KEY = "fs_shifts_v1", RESTR_KEY = "fs_restrictions_v1", PRESENCE_KEY = "fs_presence_v1", TASKS_KEY = "fs_tasks_v1";
// Typy úloh (servis / čistenie / balenie / príprava / iné) — farby + ikony.
const TASK_TYPES = [
  { id: "cleaning", label: "Čistenie",  color: "#3b82f6", icon: "🧼" },
  { id: "service",  label: "Servis",    color: "#e0663a", icon: "🔧" },
  { id: "packing",  label: "Balenie",   color: "#1f9d57", icon: "📦" },
  { id: "prep",     label: "Príprava",  color: "#6d4aff", icon: "🎬" },
  { id: "other",    label: "Iné",       color: "#8a8a96", icon: "📌" },
];
const TT_BY_ID = Object.fromEntries(TASK_TYPES.map(t => [t.id, t]));
const TASK_STATUSES = [["todo", "Čaká"], ["doing", "Prebieha"], ["done", "Hotové"]];
// Pracovníci so smenou v daný deň (číta LS — používa Dashboard aj TV view).
const onShiftToday = (ds) => {
  const staff = LS.get(STAFF_KEY) || SEED_STAFF;
  const shifts = LS.get(SHIFTS_KEY, []);
  const byId = Object.fromEntries(staff.map(s => [s.id, s]));
  return shifts.filter(sh => sh.date === ds).map(sh => ({ shift: sh, staff: byId[sh.staffId] }))
    .filter(x => x.staff).sort((a, b) => (a.shift.start || "").localeCompare(b.shift.start || ""));
};
const SH_TABS = [["shifts", "Smeny"], ["restrictions", "Obmedzenia"], ["compare", "Porovnanie"]];
const WD_SK = ["Po", "Ut", "St", "Št", "Pi", "So", "Ne"];
const uid = () => Math.random().toString(36).slice(2, 9);
const padN = (n) => String(n).padStart(2, "0");
const dstrOf = (d) => `${d.getFullYear()}-${padN(d.getMonth() + 1)}-${padN(d.getDate())}`;
const todayStr = () => dstrOf(new Date());
const mondayOf = (d) => { const x = new Date(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); x.setHours(0, 0, 0, 0); return x; };
const wdSk = (d) => WD_SK[(d.getDay() + 6) % 7];
const hm2min = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const shiftHours = (sh) => { let mins = Math.max(0, hm2min(sh.end) - hm2min(sh.start)); if (sh.start2 && sh.end2) mins += Math.max(0, hm2min(sh.end2) - hm2min(sh.start2)); return mins / 60; };
const hLabel = (h) => (Number.isInteger(h) ? String(h) : h.toFixed(1).replace(".", ",")) + " h";
const shiftTimeLabel = (sh) => sh.start2 && sh.end2 ? `${sh.start}–${sh.end} · ${sh.start2}–${sh.end2}` : `${sh.start}–${sh.end}`;
// Warehouse: defaultne 9:00–13:00 + 14:00–18:00 (8 h). Ostatné skupiny: 08:00–16:00.
const defaultShiftFor = (group) => group === "warehouse"
  ? { start: "09:00", end: "13:00", start2: "14:00", end2: "18:00", status: "confirmed", note: "" }
  : { start: "08:00", end: "16:00", start2: null, end2: null, status: "confirmed", note: "" };

// ── Fáza 2: hodnotenie (priorita), preferencie, pravidlá, auto-generovanie ──
const RATING_AXES = [["skill", "Skill"], ["precision", "Precíznosť"], ["diligence", "Pracovitosť"], ["autonomy", "Samostatnosť"], ["communication", "Komunikácia"]];
const ratingScore = (s) => RATING_AXES.reduce((sum, [k]) => sum + (s.ratings?.[k] ?? 5), 0); // max 50
const DEFAULT_PREF = 160; // preferované hodiny/mesiac (default)
const RULES_KEY = "fs_rules_v1";
// Primárne: 1× Branch manager + 2× Technik každý deň.
const DEFAULT_RULES = { roles: [{ role: "Branch manager", count: 1 }, { role: "Technik", count: 2 }], weekdays: [true, true, true, true, true, true, true] };
const ymOf = (d) => `${d.getFullYear()}-${padN(d.getMonth() + 1)}`;
const monthHours = (sid, ym, shifts) => shifts.filter(s => s.staffId === sid && s.date.slice(0, 7) === ym).reduce((a, s) => a + shiftHours(s), 0);

// Vygeneruje NÁVRHY smien pre mesiac podľa pravidiel, dostupnosti, preferencií a hodnotenia.
// Nemaže existujúce; iba dopĺňa medzery. Priorita: kto je pod svojím limitom hodín → vyššie hodnotenie → menej hodín.
function generateMonth(anchor, staff, shifts, restr, rules) {
  const y = anchor.getFullYear(), m = anchor.getMonth(), n = new Date(y, m + 1, 0).getDate(), ym = ymOf(anchor);
  const approved = (sid, ds) => restr.some(r => r.staffId === sid && r.date === ds && r.status === "approved");
  const hasShift = (sid, ds) => shifts.some(s => s.staffId === sid && s.date === ds);
  const hours = {}; staff.forEach(s => hours[s.id] = monthHours(s.id, ym, shifts));
  const adds = [];
  const taken = (sid, ds) => hasShift(sid, ds) || adds.some(a => a.staffId === sid && a.date === ds);
  for (let day = 1; day <= n; day++) {
    const dt = new Date(y, m, day), ds = dstrOf(dt), wd = (dt.getDay() + 6) % 7;
    if (!rules.weekdays[wd]) continue;
    for (const { role, count } of rules.roles) {
      const rl = role.toLowerCase();
      const cur = staff.filter(s => (s.role || "").toLowerCase() === rl && taken(s.id, ds)).length;
      let need = count - cur;
      if (need <= 0) continue;
      const cands = staff.filter(s => (s.role || "").toLowerCase() === rl && !approved(s.id, ds) && !taken(s.id, ds));
      cands.sort((a, b) => {
        const pa = hours[a.id] < (a.prefHours ?? DEFAULT_PREF) ? 0 : 1, pb = hours[b.id] < (b.prefHours ?? DEFAULT_PREF) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        const r = ratingScore(b) - ratingScore(a);
        if (r !== 0) return r;
        return hours[a.id] - hours[b.id];
      });
      for (let i = 0; i < need && i < cands.length; i++) {
        const s = cands[i], def = defaultShiftFor(s.group);
        adds.push({ id: uid(), staffId: s.id, date: ds, start: def.start, end: def.end, start2: def.start2, end2: def.end2, status: "proposed", note: "" });
        hours[s.id] += shiftHours(def);
      }
    }
  }
  return adds;
}
// Návrh posily na konkrétny deň: najlepší dostupný (pod limitom → hodnotenie → menej hodín), nezaradený v ten deň.
function suggestReinforcement(ds, staff, shifts, restr) {
  const ym = ds.slice(0, 7);
  const busy = (sid) => shifts.some(s => s.staffId === sid && s.date === ds) || restr.some(r => r.staffId === sid && r.date === ds && r.status === "approved");
  const cands = staff.filter(s => !busy(s.id));
  cands.sort((a, b) => {
    const ha = monthHours(a.id, ym, shifts), hb = monthHours(b.id, ym, shifts);
    const pa = ha < (a.prefHours ?? DEFAULT_PREF) ? 0 : 1, pb = hb < (b.prefHours ?? DEFAULT_PREF) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const r = ratingScore(b) - ratingScore(a);
    if (r !== 0) return r;
    return ha - hb;
  });
  return cands[0] || null;
}

const GROUP_H = 38, STAFF_H = 56;

function Shifts() {
  const [staff, setStaff] = useState(() => LS.get(STAFF_KEY) || SEED_STAFF);
  const [shifts, setShifts] = useState(() => LS.get(SHIFTS_KEY, []));
  const [restr, setRestr] = useState(() => LS.get(RESTR_KEY, []));
  const [tab, setTab] = useState("shifts");
  const [view, setView] = useState("week");          // day | week | month
  const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [collapsed, setCollapsed] = useState({});
  const [modal, setModal] = useState(null);
  const todayStr = dstrOf(new Date());

  const [rules, setRules] = useState(() => LS.get(RULES_KEY) || DEFAULT_RULES);
  const saveStaff  = (n) => { setStaff(n);  LS.set(STAFF_KEY, n); };
  const saveShifts = (n) => { setShifts(n); LS.set(SHIFTS_KEY, n); };
  const saveRestr  = (n) => { setRestr(n);  LS.set(RESTR_KEY, n); };
  const saveRules  = (n) => { setRules(n);  LS.set(RULES_KEY, n); };

  // ── Day / Week / Month ──
  const days = useMemo(() => {
    if (view === "day") return [new Date(anchor)];
    if (view === "month") { const y = anchor.getFullYear(), m = anchor.getMonth(), n = new Date(y, m + 1, 0).getDate(); return Array.from({ length: n }, (_, i) => new Date(y, m, i + 1)); }
    const mon = mondayOf(anchor); return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return d; });
  }, [view, anchor]);
  const dayStrs = days.map(dstrOf);
  const compact = view === "month";
  const go = (dir) => setAnchor(p => { const d = new Date(p); if (view === "day") d.setDate(d.getDate() + dir); else if (view === "month") d.setMonth(d.getMonth() + dir); else d.setDate(d.getDate() + dir * 7); return d; });
  const goToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d); };
  const rangeLabel = view === "day"
    ? days[0].toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : view === "month"
      ? anchor.toLocaleDateString("sk-SK", { month: "long", year: "numeric" })
      : `${days[0].getDate()}. ${days[0].toLocaleString("sk-SK", { month: "long" })} – ${days[6].getDate()}. ${days[6].toLocaleString("sk-SK", { month: "long" })} ${days[6].getFullYear()}`;
  const gridCols = view === "day" ? "1fr" : `repeat(${days.length}, minmax(${compact ? 40 : 78}px, 1fr))`;
  const innerMin = view === "day" ? 320 : compact ? days.length * 42 : 560;

  const shiftAt = (sid, ds) => shifts.find(x => x.staffId === sid && x.date === ds);
  const restrAt = (sid, ds) => restr.find(x => x.staffId === sid && x.date === ds);

  // kolízie: pridelená smena na deň, kedy má pracovník SCHVÁLENÉ obmedzenie
  const collisions = useMemo(() => shifts.filter(s => restr.some(r => r.staffId === s.staffId && r.date === s.date && r.status === "approved")), [shifts, restr]);
  const winCollisions = collisions.filter(c => dayStrs.includes(c.date));

  const rows = [];
  for (const g of SHIFT_GROUPS) {
    const members = staff.filter(s => s.group === g.id);
    rows.push({ type: "group", g, count: members.length });
    if (!collapsed[g.id]) for (const s of members) rows.push({ type: "staff", s, g });
  }

  const openShiftEditor = (sid, ds) => {
    const ex = shiftAt(sid, ds);
    const person = staff.find(s => s.id === sid);
    setModal({ type: "shift", staffId: sid, date: ds, draft: ex ? { ...ex } : defaultShiftFor(person?.group) });
  };
  const saveShiftDraft = () => {
    const { staffId, date, draft } = modal;
    const rest = shifts.filter(s => !(s.staffId === staffId && s.date === date));
    saveShifts([...rest, { id: draft.id || uid(), staffId, date, start: draft.start, end: draft.end, start2: draft.start2 || null, end2: draft.end2 || null, status: draft.status, note: draft.note || "" }]);
    setModal(null);
  };
  const removeShiftDraft = () => { const { staffId, date } = modal; saveShifts(shifts.filter(s => !(s.staffId === staffId && s.date === date))); setModal(null); };
  const openRestrEditor = (sid, ds) => {
    const ex = restrAt(sid, ds);
    setModal({ type: "restr", staffId: sid, date: ds, draft: ex ? { ...ex } : { reason: "", status: "pending" } });
  };
  const saveRestrDraft = () => {
    const { staffId, date, draft } = modal;
    const rest = restr.filter(r => !(r.staffId === staffId && r.date === date));
    saveRestr([...rest, { id: draft.id || uid(), staffId, date, reason: draft.reason || "", status: draft.status }]);
    setModal(null);
  };
  const removeRestrDraft = () => { const { staffId, date } = modal; saveRestr(restr.filter(r => !(r.staffId === staffId && r.date === date))); setModal(null); };

  // ── Fáza 2: generovanie ──
  const ym = ymOf(anchor);
  const monthLabel = anchor.toLocaleDateString("sk-SK", { month: "long", year: "numeric" });
  const proposalsInMonth = shifts.filter(s => s.status === "proposed" && s.date.slice(0, 7) === ym).length;
  const doGenerate = () => {
    const adds = generateMonth(anchor, staff, shifts, restr, rules);
    if (!adds.length) { window.alert(`Pre ${monthLabel} sa nedali doplniť žiadne ďalšie smeny — pravidlá sú už pokryté alebo nie sú dostupní vhodní pracovníci.`); return; }
    saveShifts([...shifts, ...adds]);
    window.alert(`✨ Vygenerovaných ${adds.length} návrhov smien pre ${monthLabel}.\nSú šedé (nepotvrdené) — skontroluj a potvrď.`);
  };
  const doClearProposals = () => {
    if (!proposalsInMonth) return;
    if (window.confirm(`Zmazať ${proposalsInMonth} nepotvrdených návrhov v ${monthLabel}? (Potvrdené smeny ostanú.)`))
      saveShifts(shifts.filter(s => !(s.status === "proposed" && s.date.slice(0, 7) === ym)));
  };
  const doConfirmProposals = () => {
    if (!proposalsInMonth) return;
    if (window.confirm(`Potvrdiť všetkých ${proposalsInMonth} návrhov v ${monthLabel}?`))
      saveShifts(shifts.map(s => (s.status === "proposed" && s.date.slice(0, 7) === ym) ? { ...s, status: "confirmed" } : s));
  };
  const doReinforce = () => {
    const ds = dstrOf(anchor);
    const best = suggestReinforcement(ds, staff, shifts, restr);
    if (!best) { window.alert(`Na ${anchor.toLocaleDateString("sk-SK", { day: "numeric", month: "long" })} nemá nikto voľno (všetci sú zaradení alebo nedostupní).`); return; }
    const def = defaultShiftFor(best.group);
    if (window.confirm(`Posila na ${anchor.toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" })}:\n\nNavrhujem ${best.name} (${best.role || G_BY_ID[best.group]?.label}) — ${monthHours(best.id, ds.slice(0, 7), shifts)} h tento mesiac, hodnotenie ${ratingScore(best)}/50.\n\nPridať ako návrh (pozvánka na potvrdenie)?`))
      saveShifts([...shifts, { id: uid(), staffId: best.id, date: ds, start: def.start, end: def.end, start2: def.start2, end2: def.end2, status: "proposed", note: "posila" }]);
  };

  // ── bunka v gride ──
  const Cell = ({ sid, ds, g }) => {
    const sh = shiftAt(sid, ds), rs = restrAt(sid, ds);
    const today = ds === todayStr;
    const base = { borderRight: `1px solid ${C.border}`, padding: compact ? 3 : 5, position: "relative", background: today ? "rgba(109,74,255,0.035)" : "transparent", cursor: "pointer", minHeight: STAFF_H, display: "flex", alignItems: "center" };
    const hover = { onMouseEnter: e => e.currentTarget.style.background = C.s2, onMouseLeave: e => e.currentTarget.style.background = today ? "rgba(109,74,255,0.035)" : "transparent" };

    if (tab === "restrictions") {
      return <div style={base} onClick={() => openRestrEditor(sid, ds)} {...hover}>
        {rs ? <RestrChip rs={rs} compact={compact} /> : <span style={{ color: C.t3, fontSize: 16, opacity: 0, width: "100%", textAlign: "center" }} className="addhint">+</span>}
      </div>;
    }
    // shifts + compare
    const collision = sh && rs && rs.status === "approved";
    return <div style={base} onClick={() => openShiftEditor(sid, ds)} {...hover}>
      {sh ? <ShiftChip sh={sh} g={g} collision={collision} compact={compact} />
        : (tab === "compare" && rs) ? <RestrChip rs={rs} compact={compact} />
          : <span style={{ color: C.t3, fontSize: 16, opacity: 0, width: "100%", textAlign: "center" }} className="addhint">+</span>}
      {tab === "compare" && collision && <span style={{ position: "absolute", top: 2, right: 3, fontSize: compact ? 9 : 12 }} title="Kolízia: smena v deň nedostupnosti">⚠️</span>}
    </div>;
  };

  return (
    <div>
      <style>{`.shgrid .addhint{transition:opacity .12s} .shgrid [role=cell]:hover .addhint{opacity:1}`}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 20, fontWeight: 800 }}>Smeny</h2>
          <p style={{ margin: "4px 0 0", color: C.t2, fontSize: 13 }}>{rangeLabel}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Day / Week / Month */}
          <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
            {[["day", "Deň"], ["week", "Týždeň"], ["month", "Mesiac"]].map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} style={{ border: "none", background: view === k ? C.s1 : "transparent", color: view === k ? C.t1 : C.t3, borderRadius: 6, padding: "6px 13px", fontSize: 12.5, fontWeight: view === k ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: view === k ? C.shadow : "none" }}>{l}</button>
            ))}
          </div>
          {/* kalendáre */}
          <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
            {SH_TABS.map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{ border: "none", background: tab === k ? C.s1 : "transparent", color: tab === k ? C.t1 : C.t3, borderRadius: 6, padding: "6px 12px", fontSize: 12.5, fontWeight: tab === k ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: tab === k ? C.shadow : "none" }}>
                {l}{k === "compare" && <span title="Neverejné" style={{ marginLeft: 5, fontSize: 10 }}>🔒</span>}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <Btn onClick={() => go(-1)}>‹</Btn>
            <Btn onClick={goToday}>Dnes</Btn>
            <Btn onClick={() => go(1)}>›</Btn>
          </div>
        </div>
      </div>

      {tab === "shifts" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "9px 12px", marginBottom: 12 }}>
          <span style={{ fontSize: 12.5, fontWeight: 800, color: C.t2, marginRight: 2 }}>Auto-rota · {monthLabel}</span>
          <Btn v="primary" onClick={doGenerate}>✨ Vygenerovať mesiac</Btn>
          <Btn onClick={doReinforce} title={`Pre deň ${anchor.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" })}`}>➕ Navrhnúť posilu</Btn>
          <Btn onClick={() => setModal({ type: "rules", draft: JSON.parse(JSON.stringify(rules)) })}>⚙ Pravidlá</Btn>
          <span style={{ flex: 1 }} />
          {proposalsInMonth > 0 && <>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.t3 }}>{proposalsInMonth} návrhov</span>
            <Btn v="success" onClick={doConfirmProposals}>✓ Potvrdiť návrhy</Btn>
            <Btn v="danger" onClick={doClearProposals}>Zmazať návrhy</Btn>
          </>}
        </div>
      )}
      {tab === "compare" && (
        <div style={{ background: winCollisions.length ? "#fdeaea" : "#e4f5ec", border: `1px solid ${winCollisions.length ? C.red + "44" : C.green + "44"}`, borderRadius: 9, padding: "9px 14px", marginBottom: 12, fontSize: 12.5, fontWeight: 700, color: winCollisions.length ? C.red : C.green }}>
          {winCollisions.length ? `⚠️ ${winCollisions.length} kolízia(í) v zobrazenom období — smena v deň schváleného obmedzenia. Klikni na bunku pre ručný zásah.` : "✓ Žiadne kolízie v zobrazenom období."}
        </div>
      )}
      {tab === "restrictions" && <p style={{ margin: "0 0 12px", color: C.t3, fontSize: 12 }}>Klikni na bunku — zadáš celodennú nedostupnosť pracovníka s dôvodom. Žiadosti čakajú na tvoje schválenie (oranžové), schválené sú červené. (Vo Fáze 2 si toto budú písať zamestnanci sami a smeny sa podľa toho vygenerujú.)</p>}

      <div style={{ display: "flex", border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: C.s1, boxShadow: C.shadow }}>
        {/* ── ľavý panel: pracovníci v skupinách ── */}
        <div style={{ width: 260, flexShrink: 0, borderRight: `1px solid ${C.border}` }}>
          <div style={{ height: 44, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", background: C.s2 }}>
            <span style={{ fontFamily: C.display, fontWeight: 800, fontSize: 11, letterSpacing: "0.06em", color: C.t3 }}>PRACOVNÍCI</span>
            <button onClick={() => setModal({ type: "staff", draft: { name: "", group: "warehouse", role: "", phone: "" } })} style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 7, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: C.t2, cursor: "pointer", fontFamily: C.font }}>+ Pracovník</button>
          </div>
          {rows.map((r) => r.type === "group"
            ? <div key={"g" + r.g.id} onClick={() => setCollapsed(c => ({ ...c, [r.g.id]: !c[r.g.id] }))} style={{ height: GROUP_H, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", background: C.s2, borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}>
                <span style={{ fontSize: 10, color: C.t3, transform: collapsed[r.g.id] ? "rotate(-90deg)" : "none", transition: "transform .15s" }}>▾</span>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.g.color }} />
                <span style={{ fontFamily: C.display, fontWeight: 800, fontSize: 12, color: C.t1, flex: 1 }}>{r.g.label}</span>
                <span style={{ fontSize: 11, fontWeight: 800, color: C.t3 }}>{r.count}</span>
              </div>
            : <div key={r.s.id} title="Upraviť pracovníka" onClick={() => setModal({ type: "staffEdit", id: r.s.id, draft: { name: r.s.name, group: r.s.group, role: r.s.role || "", phone: r.s.phone || "", ratings: { ...(r.s.ratings || {}) }, prefHours: r.s.prefHours ?? DEFAULT_PREF } })} style={{ height: STAFF_H, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = C.s2} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ width: 30, height: 30, borderRadius: "50%", background: avaColor(r.s.name), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{initials(r.s.name)}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: C.display, fontWeight: 700, fontSize: 13, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.s.name}</div>
                  <div style={{ fontSize: 11, color: C.t3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[r.s.role, r.s.phone].filter(Boolean).join(" · ") || "—"}</div>
                </div>
                {(() => { const h = monthHours(r.s.id, ym, shifts), pref = r.s.prefHours ?? DEFAULT_PREF, over = h > pref;
                  return <span title={`Odpracované v ${monthLabel} / preferencia`} style={{ fontSize: 10.5, fontWeight: 800, color: over ? C.red : C.t3, background: over ? "#fdeaea" : C.s2, borderRadius: 6, padding: "2px 6px", flexShrink: 0 }}>{h}/{pref}h</span>; })()}
                <span style={{ color: C.t3, fontSize: 13, flexShrink: 0 }}>›</span>
              </div>)}
        </div>

        {/* ── pravý timeline ── */}
        <div className="shgrid" style={{ flex: 1, overflowX: "auto" }}>
          <div style={{ minWidth: innerMin }}>
            <div style={{ height: 44, display: "grid", gridTemplateColumns: gridCols, borderBottom: `1px solid ${C.border}`, background: C.s2 }}>
              {days.map((d, i) => { const t = dstrOf(d) === todayStr; const we = [0, 6].includes(d.getDay()); return (
                <div key={i} style={{ borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: compact ? "column" : (view === "day" ? "row" : "column"), gap: compact ? 0 : 4, alignItems: "center", justifyContent: "center", background: we ? "rgba(0,0,0,0.015)" : "transparent" }}>
                  <span style={{ fontSize: compact ? 8.5 : 10, fontWeight: 800, color: C.t3, letterSpacing: "0.04em" }}>{wdSk(d)}</span>
                  <span style={{ fontSize: compact ? 11 : 13, fontWeight: 800, color: t ? "#fff" : C.t1, background: t ? C.gold : "transparent", borderRadius: "50%", width: compact ? 18 : 22, height: compact ? 18 : 22, display: "flex", alignItems: "center", justifyContent: "center" }}>{d.getDate()}</span>
                </div>); })}
            </div>
            {rows.map((r) => r.type === "group"
              ? <div key={"rg" + r.g.id} style={{ height: GROUP_H, background: C.s2, borderBottom: `1px solid ${C.border}` }} />
              : <div key={"rs" + r.s.id} style={{ display: "grid", gridTemplateColumns: gridCols, borderBottom: `1px solid ${C.border}` }}>
                  {dayStrs.map(ds => <div key={ds} role="cell"><Cell sid={r.s.id} ds={ds} g={r.g} /></div>)}
                </div>)}
          </div>
        </div>
      </div>

      {/* legenda */}
      <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap", fontSize: 11.5, color: C.t2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 22, height: 13, borderRadius: 4, border: `1.5px solid ${C.green}`, background: "#e4f5ec" }} /> Potvrdená smena</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 22, height: 13, borderRadius: 4, border: `1.5px dashed ${C.borderHi}`, background: C.s2 }} /> Návrh (nepotvrdený)</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 22, height: 13, borderRadius: 4, border: `1.5px dashed #e0a23a`, background: "#fdf3e0" }} /> Žiadosť o voľno (čaká)</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 22, height: 13, borderRadius: 4, border: `1.5px solid ${C.red}`, background: "#fdeaea" }} /> Nedostupný (schválené)</span>
      </div>

      {modal?.type === "shift" && <ShiftModal modal={modal} setModal={setModal} staff={staff} onSave={saveShiftDraft} onRemove={removeShiftDraft} />}
      {modal?.type === "restr" && <RestrModal modal={modal} setModal={setModal} staff={staff} onSave={saveRestrDraft} onRemove={removeRestrDraft} />}
      {modal?.type === "staff" && <StaffModal modal={modal} setModal={setModal} onSave={(d) => { saveStaff([...staff, { id: uid(), name: d.name.trim(), group: d.group, role: d.role.trim(), phone: d.phone.trim() }]); setModal(null); }} />}
      {modal?.type === "staffEdit" && <StaffEditModal modal={modal} setModal={setModal} staff={staff} saveStaff={saveStaff} restr={restr} saveRestr={saveRestr} shifts={shifts} saveShifts={saveShifts} />}
      {modal?.type === "rules" && <RulesModal modal={modal} setModal={setModal} onSave={(d) => { saveRules(d); setModal(null); }} />}
    </div>
  );
}

// Chip smeny: potvrdená = plná v skupinovej farbe; návrh = šedý prerušovaný.
function ShiftChip({ sh, g, collision, compact }) {
  const proposed = sh.status === "proposed";
  const color = g?.color || C.gold;
  const st = proposed
    ? { border: `1.5px dashed ${C.borderHi}`, background: C.s2, fg: C.t3 }
    : { border: `1.5px solid ${color}`, background: color + "16", fg: color };
  const hrs = shiftHours(sh);
  if (compact) {
    return <div title={`${shiftTimeLabel(sh)} (${hLabel(hrs)})${proposed ? " · návrh" : ""}`} style={{ flex: 1, border: collision ? `1.5px solid ${C.red}` : st.border, background: collision ? "#fdeaea" : st.background, borderRadius: 5, padding: "3px 0", textAlign: "center", fontSize: 9.5, fontWeight: 800, color: collision ? C.red : st.fg }}>{Number.isInteger(hrs) ? hrs : hrs.toFixed(1).replace(".", ",")}</div>;
  }
  return (
    <div style={{ flex: 1, border: collision ? `1.5px solid ${C.red}` : st.border, background: collision ? "#fdeaea" : st.background, borderRadius: 7, padding: "5px 8px", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: collision ? C.red : st.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shiftTimeLabel(sh)}</span>
        <span style={{ fontSize: 10, fontWeight: 800, color: C.t3, flexShrink: 0 }}>{hLabel(hrs)}</span>
      </div>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: C.t3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{proposed ? "Návrh" : (sh.note || "Potvrdená")}</div>
    </div>
  );
}
// Chip obmedzenia: žiadosť (čaká) = oranžová prerušovaná; schválené = červená.
function RestrChip({ rs, compact }) {
  const pending = rs.status !== "approved";
  const c = pending ? { bd: "#e0a23a", bg: "#fdf3e0", fg: "#b8791a", lbl: "Žiadosť" } : { bd: C.red, bg: "#fdeaea", fg: C.red, lbl: "Nedostupný" };
  if (compact) return <div title={`${c.lbl}${rs.reason ? " · " + rs.reason : ""}`} style={{ flex: 1, border: `1.5px ${pending ? "dashed" : "solid"} ${c.bd}`, background: c.bg, borderRadius: 5, padding: "3px 0", textAlign: "center", fontSize: 10, fontWeight: 800, color: c.fg }}>✕</div>;
  return <div style={{ flex: 1, border: `1.5px ${pending ? "dashed" : "solid"} ${c.bd}`, background: c.bg, borderRadius: 7, padding: "5px 8px", minWidth: 0 }}>
    <div style={{ fontSize: 11, fontWeight: 800, color: c.fg }}>{c.lbl}</div>
    {rs.reason && <div style={{ fontSize: 9.5, fontWeight: 600, color: C.t3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rs.reason}</div>}
  </div>;
}

function ShModalShell({ title, children, onClose, width = 340 }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(18,18,27,0.32)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width, maxHeight: "88vh", overflowY: "auto", background: C.s1, borderRadius: 14, boxShadow: "0 12px 40px rgba(18,18,27,0.22)", padding: 20, fontFamily: C.font }}>
        <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 15, color: C.t1, marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}
const shLbl = { display: "block", fontSize: 11, fontWeight: 800, color: C.t3, letterSpacing: "0.04em", margin: "0 0 4px" };
const shInp = { width: "100%", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: C.font, outline: "none", boxSizing: "border-box" };
function GroupPicker({ value, onPick }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
    {SHIFT_GROUPS.map(g => (
      <button key={g.id} onClick={() => onPick(g.id)} style={{ border: `1.5px solid ${value === g.id ? g.color : C.border}`, background: value === g.id ? g.color + "16" : C.s1, color: value === g.id ? g.color : C.t2, borderRadius: 8, padding: "6px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.font }}>{g.label}</button>
    ))}
  </div>;
}

function ShiftModal({ modal, setModal, staff, onSave, onRemove }) {
  const d = modal.draft;
  const set = (patch) => setModal(m => ({ ...m, draft: { ...m.draft, ...patch } }));
  const person = staff.find(s => s.id === modal.staffId);
  const hasBreak = d.start2 != null;
  return (
    <ShModalShell title={`Smena · ${person?.name || ""}`} onClose={() => setModal(null)}>
      <div style={{ fontSize: 12, color: C.t2, marginBottom: 14 }}>{new Date(modal.date).toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" })} · spolu <b>{hLabel(shiftHours(d))}</b></div>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}><span style={shLbl}>OD</span><input type="time" value={d.start} onChange={e => set({ start: e.target.value })} style={shInp} /></div>
        <div style={{ flex: 1 }}><span style={shLbl}>DO</span><input type="time" value={d.end} onChange={e => set({ end: e.target.value })} style={shInp} /></div>
      </div>
      {hasBreak
        ? <div style={{ display: "flex", gap: 10, marginBottom: 4, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><span style={shLbl}>OD (2. blok)</span><input type="time" value={d.start2} onChange={e => set({ start2: e.target.value })} style={shInp} /></div>
            <div style={{ flex: 1 }}><span style={shLbl}>DO (2. blok)</span><input type="time" value={d.end2} onChange={e => set({ end2: e.target.value })} style={shInp} /></div>
            <Btn onClick={() => set({ start2: null, end2: null })} style={{ marginBottom: 0 }}>×</Btn>
          </div>
        : <button onClick={() => set({ start2: "14:00", end2: "18:00" })} style={{ border: `1px dashed ${C.borderHi}`, background: "transparent", color: C.t2, borderRadius: 8, padding: "7px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.font, width: "100%" }}>+ Druhý blok (po prestávke)</button>}
      <div style={{ margin: "14px 0 12px" }}>
        <span style={shLbl}>STAV</span>
        <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
          {[["confirmed", "Potvrdená"], ["proposed", "Návrh"]].map(([v, l]) => (
            <button key={v} onClick={() => set({ status: v })} style={{ flex: 1, border: "none", background: d.status === v ? C.s1 : "transparent", color: d.status === v ? C.t1 : C.t3, borderRadius: 6, padding: "7px 0", fontSize: 12, fontWeight: d.status === v ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: d.status === v ? C.shadow : "none" }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 16 }}><span style={shLbl}>POZNÁMKA</span><input value={d.note} onChange={e => set({ note: e.target.value })} placeholder="napr. nočná, sklad…" style={shInp} /></div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="primary" onClick={onSave} style={{ flex: 1 }}>Uložiť</Btn>
        {d.id && <Btn v="danger" onClick={onRemove}>Zmazať</Btn>}
        <Btn onClick={() => setModal(null)}>Zrušiť</Btn>
      </div>
    </ShModalShell>
  );
}
function RestrModal({ modal, setModal, staff, onSave, onRemove }) {
  const d = modal.draft;
  const set = (patch) => setModal(m => ({ ...m, draft: { ...m.draft, ...patch } }));
  const person = staff.find(s => s.id === modal.staffId);
  return (
    <ShModalShell title={`Obmedzenie · ${person?.name || ""}`} onClose={() => setModal(null)}>
      <div style={{ fontSize: 12, color: C.t2, marginBottom: 14 }}>{new Date(modal.date).toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" })} · celodenná nedostupnosť</div>
      <div style={{ marginBottom: 12 }}><span style={shLbl}>DÔVOD</span><input value={d.reason} onChange={e => set({ reason: e.target.value })} placeholder="napr. dovolenka, lekár, škola…" style={shInp} autoFocus /></div>
      <div style={{ marginBottom: 16 }}>
        <span style={shLbl}>STAV</span>
        <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
          {[["pending", "Čaká na schválenie"], ["approved", "Schválené"]].map(([v, l]) => (
            <button key={v} onClick={() => set({ status: v })} style={{ flex: 1, border: "none", background: d.status === v ? C.s1 : "transparent", color: d.status === v ? C.t1 : C.t3, borderRadius: 6, padding: "7px 0", fontSize: 11.5, fontWeight: d.status === v ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: d.status === v ? C.shadow : "none" }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="primary" onClick={onSave} style={{ flex: 1 }}>Uložiť</Btn>
        {d.id && <Btn v="danger" onClick={onRemove}>Zmazať</Btn>}
        <Btn onClick={() => setModal(null)}>Zrušiť</Btn>
      </div>
    </ShModalShell>
  );
}
function StaffModal({ modal, setModal, onSave }) {
  const d = modal.draft;
  const set = (patch) => setModal(m => ({ ...m, draft: { ...m.draft, ...patch } }));
  return (
    <ShModalShell title="Nový pracovník" onClose={() => setModal(null)}>
      <div style={{ marginBottom: 12 }}><span style={shLbl}>MENO</span><input value={d.name} onChange={e => set({ name: e.target.value })} placeholder="Meno Priezvisko" style={shInp} autoFocus /></div>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><span style={shLbl}>POZÍCIA</span><input value={d.role} onChange={e => set({ role: e.target.value })} placeholder="napr. Technik" style={shInp} /></div>
        <div style={{ flex: 1 }}><span style={shLbl}>TELEFÓN</span><input value={d.phone} onChange={e => set({ phone: e.target.value })} placeholder="+421…" style={shInp} /></div>
      </div>
      <div style={{ marginBottom: 16 }}><span style={shLbl}>SKUPINA</span><GroupPicker value={d.group} onPick={g => set({ group: g })} /></div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="primary" onClick={() => d.name.trim() && onSave(d)} style={{ flex: 1 }}>Pridať</Btn>
        <Btn onClick={() => setModal(null)}>Zrušiť</Btn>
      </div>
    </ShModalShell>
  );
}
// Správa pracovníka: premenovať, telefón, pozícia, skupina + jeho obmedzenia (schvaľovanie).
function StaffEditModal({ modal, setModal, staff, saveStaff, restr, saveRestr, shifts, saveShifts }) {
  const d = modal.draft;
  const set = (patch) => setModal(m => ({ ...m, draft: { ...m.draft, ...patch } }));
  const [newR, setNewR] = useState({ date: dstrOf(new Date()), reason: "" });
  const mine = restr.filter(r => r.staffId === modal.id).sort((a, b) => a.date.localeCompare(b.date));
  const saveProfile = () => { saveStaff(staff.map(s => s.id === modal.id ? { ...s, name: d.name.trim() || s.name, role: d.role.trim(), phone: d.phone.trim(), group: d.group, ratings: d.ratings, prefHours: Number(d.prefHours) || DEFAULT_PREF } : s)); setModal(null); };
  const score = RATING_AXES.reduce((sum, [k]) => sum + (d.ratings?.[k] ?? 5), 0);
  const delStaff = () => { if (window.confirm(`Zmazať pracovníka „${d.name}" a všetky jeho smeny/obmedzenia?`)) { saveStaff(staff.filter(s => s.id !== modal.id)); saveShifts(shifts.filter(s => s.staffId !== modal.id)); saveRestr(restr.filter(r => r.staffId !== modal.id)); setModal(null); } };
  const addR = () => { if (!newR.date) return; const rest = restr.filter(r => !(r.staffId === modal.id && r.date === newR.date)); saveRestr([...rest, { id: uid(), staffId: modal.id, date: newR.date, reason: newR.reason, status: "pending" }]); setNewR({ date: newR.date, reason: "" }); };
  const approve = (id) => saveRestr(restr.map(r => r.id === id ? { ...r, status: "approved" } : r));
  const unapprove = (id) => saveRestr(restr.map(r => r.id === id ? { ...r, status: "pending" } : r));
  const delR = (id) => saveRestr(restr.filter(r => r.id !== id));
  return (
    <ShModalShell title="Pracovník" onClose={() => setModal(null)} width={440}>
      <div style={{ marginBottom: 12 }}><span style={shLbl}>MENO</span><input value={d.name} onChange={e => set({ name: e.target.value })} style={shInp} /></div>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><span style={shLbl}>POZÍCIA</span><input value={d.role} onChange={e => set({ role: e.target.value })} placeholder="napr. Technik" style={shInp} /></div>
        <div style={{ flex: 1 }}><span style={shLbl}>TELEFÓN</span><input value={d.phone} onChange={e => set({ phone: e.target.value })} placeholder="+421…" style={shInp} /></div>
      </div>
      <div style={{ marginBottom: 14 }}><span style={shLbl}>SKUPINA</span><GroupPicker value={d.group} onPick={g => set({ group: g })} /></div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ ...shLbl, margin: 0 }}>HODNOTENIE (PRIORITA)</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: C.gold }}>{score}/50</span>
        </div>
        {RATING_AXES.map(([k, l]) => { const v = d.ratings?.[k] ?? 5; return (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
            <span style={{ fontSize: 12, color: C.t2, width: 100, flexShrink: 0 }}>{l}</span>
            <input type="range" min={1} max={10} value={v} onChange={e => set({ ratings: { ...d.ratings, [k]: Number(e.target.value) } })} style={{ flex: 1, accentColor: C.gold }} />
            <span style={{ fontSize: 12, fontWeight: 800, color: C.t1, width: 18, textAlign: "right" }}>{v}</span>
          </div>); })}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
          <span style={{ fontSize: 12, color: C.t2, width: 100, flexShrink: 0 }}>Pref. hodín/mes.</span>
          <input type="number" min={0} step={10} value={d.prefHours} onChange={e => set({ prefHours: e.target.value })} style={{ ...shInp, width: 90 }} />
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, marginBottom: 12 }}>
        <span style={shLbl}>OBMEDZENIA (NEDOSTUPNOSŤ)</span>
        {mine.length === 0 && <div style={{ fontSize: 12, color: C.t3, margin: "2px 0 8px" }}>Žiadne obmedzenia.</div>}
        {mine.map(r => {
          const pending = r.status !== "approved";
          return <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: C.t1, width: 78, flexShrink: 0 }}>{new Date(r.date).toLocaleDateString("sk-SK", { day: "numeric", month: "numeric", year: "2-digit" })}</span>
            <span style={{ flex: 1, fontSize: 12, color: C.t2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.reason || "—"}</span>
            <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 999, background: pending ? "#fdf3e0" : "#e4f5ec", color: pending ? "#b8791a" : C.green, flexShrink: 0 }}>{pending ? "Čaká" : "Schválené"}</span>
            {pending
              ? <button onClick={() => approve(r.id)} title="Schváliť" style={{ border: "none", background: C.green, color: "#fff", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: C.font, flexShrink: 0 }}>✓</button>
              : <button onClick={() => unapprove(r.id)} title="Zrušiť schválenie" style={{ border: `1px solid ${C.border}`, background: C.s1, color: C.t2, borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: C.font, flexShrink: 0 }}>↺</button>}
            <button onClick={() => delR(r.id)} title="Zmazať" style={{ border: `1px solid ${C.red}33`, background: "#fdeaea", color: C.red, borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: C.font, flexShrink: 0 }}>×</button>
          </div>;
        })}
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
          <div style={{ flexShrink: 0 }}><span style={shLbl}>DÁTUM</span><input type="date" value={newR.date} onChange={e => setNewR(n => ({ ...n, date: e.target.value }))} style={{ ...shInp, width: 150 }} /></div>
          <div style={{ flex: 1 }}><span style={shLbl}>DÔVOD</span><input value={newR.reason} onChange={e => setNewR(n => ({ ...n, reason: e.target.value }))} placeholder="dovolenka…" style={shInp} /></div>
          <Btn onClick={addR} style={{ marginBottom: 0 }}>+ Pridať</Btn>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="primary" onClick={saveProfile} style={{ flex: 1 }}>Uložiť profil</Btn>
        <Btn v="danger" onClick={delStaff}>Zmazať pracovníka</Btn>
        <Btn onClick={() => setModal(null)}>Zavrieť</Btn>
      </div>
    </ShModalShell>
  );
}
// Pravidlá pre auto-generovanie: koľko ktorej pozície na deň + ktoré dni v týždni.
function RulesModal({ modal, setModal, onSave }) {
  const d = modal.draft;
  const set = (patch) => setModal(m => ({ ...m, draft: { ...m.draft, ...patch } }));
  const setRole = (i, patch) => set({ roles: d.roles.map((r, j) => j === i ? { ...r, ...patch } : r) });
  const addRole = () => set({ roles: [...d.roles, { role: "", count: 1 }] });
  const delRole = (i) => set({ roles: d.roles.filter((_, j) => j !== i) });
  const toggleWd = (i) => set({ weekdays: d.weekdays.map((w, j) => j === i ? !w : w) });
  return (
    <ShModalShell title="Pravidlá rozvrhu" onClose={() => setModal(null)} width={420}>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: C.t2 }}>Koľko ktorej pozície má byť na deň. Generátor podľa toho doplní návrhy smien (dostupnosť, preferencie hodín a hodnotenie zohľadní automaticky).</p>
      <span style={shLbl}>POZÍCIE NA DEŇ</span>
      {d.roles.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
          <input value={r.role} onChange={e => setRole(i, { role: e.target.value })} placeholder="napr. Technik" style={{ ...shInp, flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => setRole(i, { count: Math.max(1, r.count - 1) })} style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 6, width: 26, height: 30, fontSize: 15, fontWeight: 800, color: C.t2, cursor: "pointer" }}>−</button>
            <span style={{ width: 22, textAlign: "center", fontWeight: 800, fontSize: 14 }}>{r.count}</span>
            <button onClick={() => setRole(i, { count: r.count + 1 })} style={{ border: `1px solid ${C.border}`, background: C.s1, borderRadius: 6, width: 26, height: 30, fontSize: 15, fontWeight: 800, color: C.t2, cursor: "pointer" }}>+</button>
          </div>
          <button onClick={() => delRole(i)} style={{ border: `1px solid ${C.red}33`, background: "#fdeaea", color: C.red, borderRadius: 6, padding: "0 9px", height: 30, fontSize: 13, fontWeight: 800, cursor: "pointer" }}>×</button>
        </div>
      ))}
      <button onClick={addRole} style={{ border: `1px dashed ${C.borderHi}`, background: "transparent", color: C.t2, borderRadius: 8, padding: "7px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.font, width: "100%", marginBottom: 16 }}>+ Pridať pozíciu</button>
      <span style={shLbl}>DNI V TÝŽDNI</span>
      <div style={{ display: "flex", gap: 5, marginBottom: 18 }}>
        {WD_SK.map((w, i) => (
          <button key={i} onClick={() => toggleWd(i)} style={{ flex: 1, border: `1.5px solid ${d.weekdays[i] ? C.gold : C.border}`, background: d.weekdays[i] ? C.goldGlow : C.s1, color: d.weekdays[i] ? C.gold : C.t3, borderRadius: 8, padding: "8px 0", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: C.font }}>{w}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="primary" onClick={() => onSave({ roles: d.roles.filter(r => r.role.trim()), weekdays: d.weekdays })} style={{ flex: 1 }}>Uložiť pravidlá</Btn>
        <Btn onClick={() => setModal(null)}>Zrušiť</Btn>
      </div>
    </ShModalShell>
  );
}

// ── ÚLOHY (Tasks) — servis / čistenie / balenie / príprava; auto aj ručné ──
const taskAssignee = (id) => { const st = LS.get(STAFF_KEY) || SEED_STAFF; return st.find(s => s.id === id); };
function TaskCard({ t, dark, onOpen, onMove }) {
  const P = dark ? { s1: "#1d1d26", border: "#2a2a34", t1: "#f4f4f6", t2: "#a7a7b4", t3: "#6f6f7c" } : { s1: C.s1, border: C.border, t1: C.t1, t2: C.t2, t3: C.t3 };
  const tt = TT_BY_ID[t.type] || TT_BY_ID.other;
  const a = t.assignee && taskAssignee(t.assignee);
  return (
    <div onClick={() => onOpen && onOpen(t)} style={{ background: P.s1, border: `1px solid ${P.border}`, borderLeft: `3px solid ${tt.color}`, borderRadius: 9, padding: "9px 11px", cursor: onOpen ? "pointer" : "default", opacity: t.status === "done" ? 0.6 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: tt.color, background: tt.color + "1a", borderRadius: 6, padding: "2px 7px" }}>{tt.icon} {tt.label}</span>
        {t.orderNumber && <span style={{ fontFamily: C.mono, fontSize: 11, color: P.t3, fontWeight: 700 }}>#{t.orderNumber}</span>}
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: P.t3 }}>{t.date ? fmtDate(t.date) : ""}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: P.t1, textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        {a ? <><span style={{ width: 20, height: 20, borderRadius: "50%", background: avaColor(a.name), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800 }}>{initials(a.name)}</span><span style={{ fontSize: 11, color: P.t2 }}>{a.name}</span></>
          : <span style={{ fontSize: 11, color: P.t3 }}>nepridelené</span>}
        {onMove && <div style={{ marginLeft: "auto", display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
          {t.status !== "todo" && <button onClick={() => onMove(t, -1)} title="Späť" style={{ border: `1px solid ${P.border}`, background: P.s1, color: P.t2, borderRadius: 6, width: 22, height: 22, cursor: "pointer", fontSize: 12 }}>‹</button>}
          {t.status !== "done" && <button onClick={() => onMove(t, 1)} title="Posunúť" style={{ border: "none", background: tt.color, color: "#fff", borderRadius: 6, width: 22, height: 22, cursor: "pointer", fontSize: 12, fontWeight: 800 }}>›</button>}
        </div>}
      </div>
    </div>
  );
}
function Tasks() {
  const { activeOrders } = useApp();
  const [tasks, setTasks] = useState(() => LS.get(TASKS_KEY, []));
  const save = (n) => { setTasks(n); LS.set(TASKS_KEY, n); };
  const [filter, setFilter] = useState("all");
  const [modal, setModal] = useState(null);
  const today = todayStr();
  const upd = (t) => save(tasks.some(x => x.id === t.id) ? tasks.map(x => x.id === t.id ? t : x) : [...tasks, t]);
  const move = (t, dir) => { const ord = ["todo", "doing", "done"]; const i = ord.indexOf(t.status); upd({ ...t, status: ord[Math.max(0, Math.min(2, i + dir))] }); };
  const autoClean = () => {
    const end = dstrOf(new Date(Date.now() + 7 * 864e5));
    const ret = activeOrders.filter(o => o.status === "started" && o.stops_at && o.stops_at.slice(0,10) >= today && o.stops_at.slice(0,10) <= end);
    const add = [];
    for (const o of ret) { if (tasks.some(t => t.orderId === o.id && t.type === "cleaning")) continue; add.push({ id: uid(), type: "cleaning", title: "Čistenie po vrátení", orderId: o.id, orderNumber: o.number, date: o.stops_at.slice(0,10), assignee: null, status: "todo", note: "" }); }
    if (!add.length) { window.alert("Žiadne nové úlohy — vrátenia najbližších 7 dní už majú čistenie."); return; }
    save([...tasks, ...add]); window.alert(`✨ Vytvorených ${add.length} úloh čistenia z vrátení (7 dní).`);
  };
  const filtered = tasks.filter(t => filter === "all" || t.type === filter);
  const col = (s) => filtered.filter(t => t.status === s).sort((a,b)=>(a.date||"").localeCompare(b.date||""));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div><h2 style={{ margin: 0, color: C.t1, fontFamily: C.display, fontSize: 20, fontWeight: 800 }}>Úlohy</h2>
          <p style={{ margin: "3px 0 0", color: C.t2, fontSize: 13 }}>Servis, čistenie, balenie, príprava — priraď pracovníkom.</p></div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={autoClean}>✨ Auto: čistenie z vrátení</Btn>
          <Btn v="primary" onClick={() => setModal({ type: "task", draft: { id: null, type: "service", title: "", orderNumber: "", date: today, assignee: "", status: "todo", note: "" } })}>+ Úloha</Btn>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[["all", "Všetky"], ...TASK_TYPES.map(t => [t.id, t.label])].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ border: `1.5px solid ${filter === k ? C.gold : C.border}`, background: filter === k ? C.goldGlow : C.s1, color: filter === k ? C.gold : C.t2, borderRadius: 8, padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.font }}>{k !== "all" ? (TT_BY_ID[k].icon + " ") : ""}{l}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
        {TASK_STATUSES.map(([s, label]) => (
          <div key={s} style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, minHeight: 120 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontFamily: C.display, fontWeight: 800, fontSize: 13, color: C.t1 }}>{label}</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: C.t3 }}>{col(s).length}</span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {col(s).length === 0 ? <div style={{ fontSize: 12, color: C.t3, textAlign: "center", padding: "16px 0" }}>—</div>
                : col(s).map(t => <TaskCard key={t.id} t={t} onOpen={tk => setModal({ type: "task", draft: { ...tk, assignee: tk.assignee || "" } })} onMove={move} />)}
            </div>
          </div>
        ))}
      </div>

      {modal?.type === "task" && <TaskModal modal={modal} setModal={setModal} onSave={(d) => { upd({ ...d, id: d.id || uid(), assignee: d.assignee || null }); setModal(null); }} onDelete={(id) => { save(tasks.filter(x => x.id !== id)); setModal(null); }} />}
    </div>
  );
}
function TaskModal({ modal, setModal, onSave, onDelete }) {
  const d = modal.draft;
  const set = (patch) => setModal(m => ({ ...m, draft: { ...m.draft, ...patch } }));
  const staff = LS.get(STAFF_KEY) || SEED_STAFF;
  return (
    <ShModalShell title={d.id ? "Upraviť úlohu" : "Nová úloha"} onClose={() => setModal(null)} width={400}>
      <div style={{ marginBottom: 12 }}>
        <span style={shLbl}>TYP</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TASK_TYPES.map(tt => (
            <button key={tt.id} onClick={() => set({ type: tt.id })} style={{ border: `1.5px solid ${d.type === tt.id ? tt.color : C.border}`, background: d.type === tt.id ? tt.color + "16" : C.s1, color: d.type === tt.id ? tt.color : C.t2, borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.font }}>{tt.icon} {tt.label}</button>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 12 }}><span style={shLbl}>NÁZOV</span><input value={d.title} onChange={e => set({ title: e.target.value })} placeholder="napr. Čistenie po Habs s.r.o." style={shInp} autoFocus /></div>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}><span style={shLbl}>OBJEDNÁVKA #</span><input value={d.orderNumber} onChange={e => set({ orderNumber: e.target.value })} placeholder="napr. 4614" style={shInp} /></div>
        <div style={{ flex: 1 }}><span style={shLbl}>DÁTUM</span><input type="date" value={d.date} onChange={e => set({ date: e.target.value })} style={shInp} /></div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <span style={shLbl}>PRIRADIŤ PRACOVNÍKOVI</span>
        <select value={d.assignee} onChange={e => set({ assignee: e.target.value })} style={{ ...shInp, cursor: "pointer" }}>
          <option value="">— nepridelené —</option>
          {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ""}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 16 }}>
        <span style={shLbl}>STAV</span>
        <div style={{ display: "flex", gap: 2, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
          {TASK_STATUSES.map(([v, l]) => (
            <button key={v} onClick={() => set({ status: v })} style={{ flex: 1, border: "none", background: d.status === v ? C.s1 : "transparent", color: d.status === v ? C.t1 : C.t3, borderRadius: 6, padding: "7px 0", fontSize: 12, fontWeight: d.status === v ? 800 : 600, cursor: "pointer", fontFamily: C.font, boxShadow: d.status === v ? C.shadow : "none" }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn v="primary" onClick={() => d.title.trim() && onSave(d)} style={{ flex: 1 }}>Uložiť</Btn>
        {d.id && <Btn v="danger" onClick={() => onDelete(d.id)}>Zmazať</Btn>}
        <Btn onClick={() => setModal(null)}>Zrušiť</Btn>
      </div>
    </ShModalShell>
  );
}
// Kompaktný panel otvorených úloh pre dnešok (Dashboard).
function TasksToday({ nav }) {
  const tasks = LS.get(TASKS_KEY, []);
  const today = todayStr();
  const open = tasks.filter(t => t.status !== "done" && (!t.date || t.date <= today)).sort((a,b)=>(a.date||"").localeCompare(b.date||"")).slice(0, 8);
  const done = tasks.filter(t => t.status === "done" && t.date === today).length;
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em" }}>ÚLOHY DNES ({open.length} otvorených{done ? ` · ${done} hotových` : ""})</div>
        <Btn v="ghost" onClick={() => nav("tasks")} style={{ fontSize: 11 }}>Všetky úlohy →</Btn>
      </div>
      {open.length === 0 ? <Empty icon="✓" title="Žiadne otvorené úlohy na dnes" sub="" />
        : <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>{open.map(t => <TaskCard key={t.id} t={t} onOpen={() => nav("tasks")} />)}</div>}
    </Card>
  );
}

const MODULES = [
  { id:"home",       label:"Home",        icon:"🏠" },
  { id:"dashboard",  label:"Dashboard",   icon:"◉" },
  { id:"orders",     label:"Objednávky",  icon:"📋" },
  { id:"projects",   label:"Projekty",    icon:"🎬" },
  { id:"quotes",     label:"Cenové ponuky", icon:"📄" },
  { id:"picking",    label:"Výdaj",       icon:"→" },
  { id:"checkin",    label:"Príjem",      icon:"←" },
  { id:"shifts",     label:"Smeny",       icon:"🗓️" },
  { id:"tasks",      label:"Úlohy",       icon:"✅" },
  { id:"inventory",  label:"Inventár",    icon:"🎥" },
  { id:"customers",  label:"Zákazníci",   icon:"👥" },
  { id:"calendar",   label:"Kalendár",    icon:"📅" },
  { id:"stats",      label:"Štatistiky",  icon:"📊" },
  { id:"settings",   label:"Nastavenia",  icon:"⚙️" },
];
const M_BY_ID = Object.fromEntries(MODULES.map(m => [m.id, m]));
const NAV_SECTIONS = [
  { title: null,            items: ["home", "dashboard", "calendar"] },
  { title: "Objednávky",    items: ["orders", "projects", "quotes", "picking", "checkin"] },
  { title: "Prevádzka",     items: ["shifts", "tasks"] },
  { title: "Sklad & ľudia", items: ["inventory", "customers"] },
  { title: "Analýza",       items: ["stats"] },
  { title: "Systém",        items: ["settings"] },
];

function Nav({ active, onNav, onOpenPalette }) {
  const { activeOrders, meta, loadingActive } = useApp();
  const today = todayStr();
  const started  = activeOrders.filter(o => o.status === "started").length;
  const reserved = activeOrders.filter(o => o.status === "reserved").length;
  const goingToday = activeOrders.filter(o => o.status==="reserved" && o.starts_at?.slice(0,10)===today).length;
  const returningToday = activeOrders.filter(o => o.status==="started" && o.stops_at?.slice(0,10)===today).length;
  const overdue = activeOrders.filter(o => o.status==="started" && o.stops_at && o.stops_at.slice(0,10)<today).length;
  const badges = { picking: goingToday, checkin: returningToday };

  const NavBtn = ({ m }) => {
    const a = active === m.id, b = badges[m.id];
    return (
      <button onClick={() => onNav(m.id)} style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "10px 14px", borderRadius: 9, marginBottom: 3, background: a ? C.goldGlow : "transparent", border: "none", cursor: "pointer", transition: "background .15s, color .15s, transform .15s", color: a ? C.gold : C.t2, fontSize: 14, fontWeight: a ? 800 : 700, textAlign: "left", fontFamily: C.font }}
        onMouseEnter={e => { if (!a) { e.currentTarget.style.background = C.s2; e.currentTarget.style.color = C.t1; e.currentTarget.style.transform = "translateX(3px)"; } }}
        onMouseLeave={e => { if (!a) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.t2; e.currentTarget.style.transform = "none"; } }}>
        {a && <span style={{ position: "absolute", left: 0, top: 9, bottom: 9, width: 3, borderRadius: "0 3px 3px 0", background: C.gold }} />}
        <span>{m.label}</span>
        {b > 0 && <span style={{ background: C.gold, color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 800 }}>{b}</span>}
      </button>
    );
  };

  return (
    <div style={{ width: 224, flexShrink: 0, background: C.s0, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", height: "100vh", position: "sticky", top: 0 }}>
      <div style={{ padding: "18px 16px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: C.gold, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, color: "#fff" }}>FS</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.t1, letterSpacing: "-0.02em" }}>FilmSupport</div>
            <div style={{ fontSize: 9, color: C.t3, letterSpacing: "0.08em", textTransform: "uppercase" }}>RENTAL OS</div>
          </div>
        </div>
      </div>

      {/* ⌘K quick actions */}
      <div style={{ padding: "0 12px 10px" }}>
        <button onClick={onOpenPalette} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "8px 11px", borderRadius: 9, background: C.s2, border: `1px solid ${C.border}`, cursor: "pointer", color: C.t3, fontSize: 12.5, fontFamily: C.font }}
          onMouseEnter={e => e.currentTarget.style.borderColor = C.borderHi}
          onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>⌕ Hľadať…</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.t3, background: C.s1, border: `1px solid ${C.border}`, borderRadius: 5, padding: "1px 5px" }}>⌘K</span>
        </button>
      </div>

      {/* Live status */}
      <div style={{ margin: "0 12px 8px", padding: "9px 12px", borderRadius: 10, background: C.s2, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12 }}><span style={{ color: STATUS_MAP.started.color, fontWeight: 800 }}>{loadingActive ? "…" : started}</span><span style={{ color: C.t3, marginLeft: 4 }}>vonku</span></div>
        <div style={{ fontSize: 12 }}><span style={{ color: STATUS_MAP.reserved.color, fontWeight: 800 }}>{loadingActive ? "…" : reserved}</span><span style={{ color: C.t3, marginLeft: 4 }}>rezerv.</span></div>
        {overdue > 0 && <div style={{ fontSize: 12, width: "100%" }}><span style={{ color: C.red, fontWeight: 800 }}>⚠ {overdue}</span><span style={{ color: C.t3, marginLeft: 4 }}>mešká</span></div>}
      </div>

      <nav style={{ flex: 1, padding: "4px 8px", overflowY: "auto" }}>
        {NAV_SECTIONS.map((sec, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            {sec.title && <div style={{ fontSize: 9.5, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "4px 10px 4px" }}>{sec.title}</div>}
            {sec.items.map(id => <NavBtn key={id} m={M_BY_ID[id]} />)}
          </div>
        ))}
      </nav>

      <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.t3 }}>
        <div>Booqable API v1</div>
        <div style={{ marginTop: 2 }}>filmsupport-d93f · {(meta.total_count||0).toLocaleString("sk-SK")} obj.</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// COMMAND PALETTE (⌘K)
// ═══════════════════════════════════════════════
function CommandPalette({ onClose, nav }) {
  const { allOrders, customers } = useApp();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const out = [];
    MODULES.forEach(m => { if (!ql || m.label.toLowerCase().includes(ql)) out.push({ type:"module", id:m.id, label:m.label, icon:m.icon, sub:"Modul" }); });
    if (ql) {
      allOrders.filter(o =>
        String(o.number).includes(ql) ||
        (o.customer?.name || "").toLowerCase().includes(ql) ||
        (o.customer?.email || "").toLowerCase().includes(ql) ||
        (o.tags || []).join(" ").toLowerCase().includes(ql)
      ).slice(0, 8).forEach(o => out.push({ type:"order", id:o.id, icon:"📋", label:`#${o.number} · ${o.customer?.name || "—"}`, sub: STATUS_MAP[o.status]?.label || o.status }));
      customers.filter(c => (c.name || "").toLowerCase().includes(ql) || (c.email || "").toLowerCase().includes(ql))
        .slice(0, 6).forEach(c => out.push({ type:"customer", id:c.id, icon:"👤", label:c.name || "—", sub:c.email || "Zákazník" }));
    }
    return out.slice(0, 20);
  }, [q, allOrders, customers]);

  useEffect(() => { setSel(0); }, [q]);

  const choose = (r) => {
    if (!r) return;
    if (r.type === "module") nav(r.id);
    else if (r.type === "order") nav("order_detail", r.id);
    else if (r.type === "customer") nav("customers");
    onClose();
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s+1, results.length-1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(s-1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(results[sel]); }
    else if (e.key === "Escape") { onClose(); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(18,18,27,0.32)", backdropFilter: "blur(2px)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: "90vw", background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: "0 16px 48px rgba(18,18,27,0.18)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 16, color: C.t3 }}>⌕</span>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Hľadaj objednávku, zákazníka, modul…"
            style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 15, color: C.t1, fontFamily: C.font }} />
          <span style={{ fontSize: 10, color: C.t3, border: `1px solid ${C.border}`, borderRadius: 5, padding: "2px 6px" }}>ESC</span>
        </div>
        <div style={{ maxHeight: 380, overflowY: "auto", padding: 6 }}>
          {results.length === 0 ? <div style={{ padding: "28px 16px", textAlign: "center", color: C.t3, fontSize: 13 }}>Žiadne výsledky</div> :
            results.map((r, i) => (
              <div key={`${r.type}-${r.id}`} onClick={() => choose(r)} onMouseEnter={() => setSel(i)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", borderRadius: 9, cursor: "pointer", background: i === sel ? C.s2 : "transparent" }}>
                <span style={{ fontSize: 15, width: 20, textAlign: "center" }}>{r.icon}</span>
                <span style={{ flex: 1, fontSize: 13.5, color: C.t1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
                <span style={{ fontSize: 11, color: C.t3 }}>{r.sub}</span>
              </div>
            ))}
        </div>
        <div style={{ padding: "8px 14px", borderTop: `1px solid ${C.border}`, fontSize: 10.5, color: C.t3, display: "flex", gap: 14 }}>
          <span>↑↓ pohyb</span><span>↵ otvoriť</span><span>esc zavrieť</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════
function App() {
  const [route, setRoute] = useState(() => {
    const tv = typeof window !== "undefined" && /(^#?|#)tv$/.test(window.location.hash || "");
    return { module: tv ? "tv" : "home", id: null, extra: null };
  });
  const nav = useCallback((module, id = null, extra = null) => { if (module !== "tv") { try { if (window.location.hash) window.location.hash = ""; } catch {} } setRoute({ module, id, extra }); }, []);

  return (
    <AppProvider>
      <AppInner route={route} nav={nav} />
    </AppProvider>
  );
}

function AppInner({ route, nav }) {
  const mod = MODULES.find(m => m.id === route.module);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const renderModule = () => {
    switch(route.module) {
      case "home":         return <Home nav={nav} />;
      case "dashboard":    return <Dashboard nav={nav} />;
      case "orders":       return <OrdersList nav={nav} initialStatus={route.extra} />;
      case "projects":     return <Projects nav={nav} />;
      case "quotes":       return <Quotes nav={nav} />;
      case "order_detail": return <OrderDetail orderId={route.id} nav={nav} />;
      case "picking":      return <PickingModule initialOrderId={route.id} nav={nav} />;
      case "checkin":      return <CheckinModule initialOrderId={route.id} nav={nav} />;
      case "inventory":    return <Inventory />;
      case "settings":     return <Settings />;
      case "customers":    return <Customers />;
      case "calendar":     return <Calendar nav={nav} />;
      case "shifts":       return <Shifts />;
      case "tasks":        return <Tasks />;
      case "stats":        return <Stats />;
      default:             return <Home nav={nav} />;
    }
  };

  if (route.module === "tv") return <ErrorBoundary resetKey="tv"><TvDashboard onExit={() => nav("dashboard")} /></ErrorBoundary>;

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, color: C.t1, fontFamily: C.font, fontSize: 14 }}>
      <Nav active={route.module} onNav={m => nav(m)} onOpenPalette={() => setPaletteOpen(true)} />
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ borderBottom: `1px solid ${C.border}`, padding: "14px 24px", background: "rgba(255,255,255,0.8)", backdropFilter: "blur(8px)", position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 13, color: C.t3, fontWeight: 500 }}>FilmSupport <span style={{ margin: "0 6px", color: C.border }}>›</span> <span style={{ color: C.t1, fontWeight: 700 }}>{mod?.label || "Dashboard"}</span></div>
          <div style={{ fontSize: 11, color: C.t3, textTransform: "capitalize" }}>{new Date().toLocaleDateString("sk-SK", {weekday:"long", day:"numeric", month:"long", year:"numeric"})}</div>
        </div>
        <div style={{ padding: 24, maxWidth: 1400 }}><ErrorBoundary resetKey={route.module + (route.id || "")}>{renderModule()}</ErrorBoundary></div>
      </div>
      {paletteOpen && <CommandPalette nav={nav} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

export default App;
