const API = 'https://gateway.production.kiva.org/graphql';
// Country groups that can be excluded. U.S. territories count with the U.S.; the G20's EU and
// African Union seats are left out so that excluding the G20 doesn't remove all of Africa.
const G7 = ['US', 'PR', 'GU', 'VI', 'CA', 'GB', 'FR', 'DE', 'IT', 'JP'];
const EXCLUDE_GROUPS = {
  none: new Set(),
  g7: new Set(G7),
  g20: new Set([...G7, 'AR', 'AU', 'BR', 'CN', 'IN', 'ID', 'MX', 'RU', 'SA', 'ZA', 'KR', 'TR']),
};
const isExcludedCountry = iso => (EXCLUDE_GROUPS[settings.excludeGroup] || EXCLUDE_GROUPS.none).has(iso);
// Searches saved before G7/G20 existed had an "Exclude U.S. & Canada" checkbox
function migrateSearch(s) {
  if ('excludeUSCA' in s) { if (!s.excludeGroup) s.excludeGroup = s.excludeUSCA ? 'g7' : 'none'; delete s.excludeUSCA; }
  if (s.maxLeft === '25') s.maxLeft = '50';   // the $25 option was removed
  return s;
}
// The settings that make up a saved or recent search
const SEARCH_KEYS = ['regions', 'excluded', 'excludeGroup', 'womenOnly', 'hideOwned', 'maxTerm', 'maxDefault', 'minFunded',
  'maxLeft', 'maxDays', 'sortBy', 'wFam', 'wNew', 'wBadge', 'wUrg'];
const RECENT_MAX = 5;
const BADGE_NAMES = {
  'climate-action': 'Climate Action', 'womens-equality': "Women's Equality", 'refugee-equality': 'Refugee Equality',
  'basic-needs': 'Basic Needs', 'us-economic-equality': 'U.S. Economic Equality',
};
const TAB_HELP = {
  top: 'A blend of familiar, new, achievements and urgency, using the weighting above. Each card says why it ranks where it does.',
  fam: 'Loans that look like the ones you already make: your most common countries, sectors and activities.',
  new: "Loans that broaden your portfolio: countries you've never lent in rank first, then new sectors and activities.",
  badge: 'Kiva badge progress. Pick a badge to see qualifying loans that also pass your filters. Badges closest to their next tier score highest.',
  coverage: 'Countries in your selected regions, how many loans you have made there, and how many matching loans are fundraising now.',
  anon: 'Ranked by urgency: loans that are nearly funded, have little left to raise, or expire soon. Enter a Kiva lender ID above to rank by your own lending history and unlock the Familiar, New to us, Achievements and Country coverage tabs.',
};
// excluded: countries (ISO codes), sectors and activities the visitor has chosen to hide
const noExclusions = () => ({ country: [], sector: [], activity: [] });
const DEFAULTS = { lender: '', regions: ['Central America', 'South America'], excludeGroup: 'g7', womenOnly: true, hideOwned: true,
  maxTerm: '0', maxDefault: '100', minFunded: '0', maxLeft: '0', maxDays: '0', sortBy: 'score',
  wFam: 30, wNew: 45, wBadge: 25, wUrg: 15, tab: 'top', sidebarOpen: true, closedSecs: ['weights'] };
const PAGE = 100, CONCURRENCY = 3, SHOW_STEP = 48;

// Lender IDs are short alphanumeric handles; anything else (from the URL or the input box) is ignored
const cleanLender = v => { const id = String(v || '').trim().replace(/^.*\/lender\//, '').replace(/[/?#].*$/, '');
  return /^[\w.-]{1,64}$/.test(id) ? id : ''; };
const SORTS = ['score', 'left', 'funded', 'expiring', 'term'];
const TABS = ['top', 'fam', 'new', 'badge', 'coverage'];
const isStrList = v => Array.isArray(v) && v.every(x => typeof x === 'string');

// ---------- state ----------
let settings = loadSettings();
const state = {
  portfolio: null,    // { ids:Set, country:{}, sector:{}, activity:{}, total, name }
  badges: [],         // [{ id, name, description, progress, next, remaining, tiers, filters, loanIds:Set }]
  facets: [],         // [{ iso, name, region, count }]
  pool: [],           // fundraising loans for current groups/women setting
  poolKey: '', countryFilter: null, badgeFocus: null, shown: SHOW_STEP, loadSeq: 0,
};
const poolCache = new Map();


// Settings come from browser storage, saved searches and the URL, so keep only known keys with sane values
function cleanSettings(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const k of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
    const v = s[k], d = DEFAULTS[k];
    if (Array.isArray(d) ? isStrList(v) : typeof v === typeof d) out[k] = v;
  }
  if (out.lender !== undefined) out.lender = cleanLender(out.lender);
  if (out.excludeGroup && !EXCLUDE_GROUPS[out.excludeGroup]) delete out.excludeGroup;
  if (out.sortBy && !SORTS.includes(out.sortBy)) delete out.sortBy;
  if (out.tab && !TABS.includes(out.tab)) delete out.tab;
  ['maxTerm', 'maxDefault', 'minFunded', 'maxLeft', 'maxDays'].forEach(k => { if (k in out && !/^\d{1,4}$/.test(out[k])) delete out[k]; });
  ['wFam', 'wNew', 'wBadge', 'wUrg'].forEach(k => { if (k in out) out[k] = Math.min(100, Math.max(0, +out[k] || 0)); });
  const ex = s.excluded;
  if (ex && typeof ex === 'object' && ['country', 'sector', 'activity'].every(d => isStrList(ex[d])))
    out.excluded = { country: ex.country.slice(), sector: ex.sector.slice(), activity: ex.activity.slice() };
  return out;
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('kivaFinder') || '{}'); } catch (e) {}
  // Older versions stored fixed region groups; map them to Kiva's region names
  if (s.groups && !s.regions) {
    const map = { sa: ['South America'], ca: ['Central America'], mxc: ['North America'],
      row: ['Africa', 'Asia', 'Eastern Europe', 'Middle East', 'Oceania'] };
    s.regions = s.groups.flatMap(g => map[g] || []);
  }
  delete s.groups;
  if (s && typeof s === 'object') migrateSearch(s);
  const p = cleanLender(new URLSearchParams(location.search).get('lender'));
  return { ...DEFAULTS, excluded: noExclusions(), ...cleanSettings(s), ...(p ? { lender: p } : {}) };
}
function saveSettings() { try { localStorage.setItem('kivaFinder', JSON.stringify(settings)); } catch (e) {} }

// ---------- saved and recent searches ----------
function loadSearches() {
  try {
    const v = JSON.parse(localStorage.getItem('kivaFinderSearches'));
    if (v) { v.saved.forEach(x => migrateSearch(x.s)); v.recent.forEach(migrateSearch); return v; }
  } catch (e) {}
  return { saved: [], recent: [] };
}
function storeSearches(v) { try { localStorage.setItem('kivaFinderSearches', JSON.stringify(v)); } catch (e) {} }
function currentSearch() { const s = {}; SEARCH_KEYS.forEach(k => { s[k] = settings[k]; }); return s; }
function sameSearch(a, b) { return SEARCH_KEYS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])); }

function describeSearch(s) {
  const all = allRegions();
  const parts = [!s.regions || (all.length && all.every(r => s.regions.includes(r))) ? 'All regions'
    : s.regions.length ? s.regions.join(', ') : 'No regions'];
  if (s.womenOnly) parts.push('women');
  if (+s.maxTerm) parts.push(`≤${s.maxTerm} mo`);
  if (+s.minFunded) parts.push(`≥${s.minFunded}% funded`);
  if (+s.maxLeft) parts.push(`≤$${s.maxLeft} left`);
  if (+s.maxDays) parts.push(`≤${s.maxDays} days`);
  if (+s.maxDefault < 100) parts.push(`default ≤${s.maxDefault}%`);
  if (s.excludeGroup === 'none') parts.push('incl. G7');
  if (s.excludeGroup === 'g20') parts.push('excl. G20');
  const hidden = s.excluded ? s.excluded.country.length + s.excluded.sector.length + s.excluded.activity.length : 0;
  if (hidden) parts.push(`${hidden} excluded`);
  return parts.join(' · ');
}

let recentTimer;
// Called after any change to a search setting: remember it, and add it to recent searches once it settles
function searchChanged() {
  saveSettings();
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => {
    const v = loadSearches(), s = currentSearch();
    v.recent = [s, ...v.recent.filter(r => !sameSearch(r, s))].slice(0, RECENT_MAX);
    storeSearches(v);
    renderSearches();
  }, 3000);
}

function renderSearches() {
  const v = loadSearches(), cur = currentSearch();
  const savedIdx = v.saved.findIndex(x => sameSearch(x.s, cur));
  const opt = (val, label, sel) => `<option value="${val}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  $('savedSel').innerHTML = opt('', v.saved.length || v.recent.length ? 'Saved & recent searches…' : 'No saved searches yet', savedIdx < 0)
    + (v.saved.length ? `<optgroup label="Saved">${v.saved.map((x, i) => opt('s' + i, x.name, i === savedIdx)).join('')}</optgroup>` : '')
    + (v.recent.length ? `<optgroup label="Recent">${v.recent.map((r, i) => opt('r' + i, describeSearch(r))).join('')}</optgroup>` : '');
  $('delBtn').hidden = savedIdx < 0;
  $('delBtn').dataset.idx = savedIdx;
}

function applySearch(s) {
  // Copy only search settings, validated, so a stored search can't set arbitrary properties
  const clean = cleanSettings(migrateSearch(JSON.parse(JSON.stringify(s))));
  const picked = { excluded: noExclusions() };
  SEARCH_KEYS.forEach(k => { if (k in clean) picked[k] = clean[k]; });
  Object.assign(settings, picked);
  saveSettings();
  syncControls();
  renderRegions();
  renderExcluded();
  renderSearches();
  refreshPool();
}

// Downloads are cached in the browser so reopening the page doesn't send another burst of requests to Kiva
const PROFILE_TTL = 60 * 60 * 1000, POOL_TTL = 15 * 60 * 1000;
function cacheGet(name, ttl) {
  try {
    const v = JSON.parse(localStorage.getItem(name));
    if (v && Date.now() - v.at < ttl) return v;
  } catch (e) {}
  return null;
}
function cacheSet(name, value) {
  try { localStorage.setItem(name, JSON.stringify({ ...value, at: Date.now() })); }
  catch (e) { try { localStorage.removeItem(name); } catch (e2) {} }
}
// The loan pool can be several MB, more than localStorage allows, so it lives in IndexedDB
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kivaFinder', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('cache');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(k) {
  try {
    const db = await idbOpen();
    return await new Promise(res => {
      const q = db.transaction('cache').objectStore('cache').get(k);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function idbSet(k, v) {
  try { (await idbOpen()).transaction('cache', 'readwrite').objectStore('cache').put(v, k); } catch (e) {}
}
try { localStorage.removeItem('kivaFinderPool'); localStorage.removeItem('kivaFinderProfile'); } catch (e) {}

// ---------- api ----------
async function gql(query, variables, retried) {
  let r;
  try {
    r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }) });
  } catch (e) {
    if (!retried) { await new Promise(res => setTimeout(res, 2000)); return gql(query, variables, true); }
    // Kiva's firewall answers rate-limited requests with a 403 that has no CORS headers, which surfaces as a network error
    throw new Error("Couldn't reach Kiva. Kiva may be briefly limiting requests after a lot of reloads; wait a few minutes and press Retry.");
  }
  if (!r.ok) throw new Error(`Kiva API returned HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors && !j.data) throw new Error(j.errors[0].message);
  return j.data;
}
async function inBatches(tasks) {
  const out = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) out.push(...await Promise.all(tasks.slice(i, i + CONCURRENCY).map(t => t())));
  return out;
}

const PORTFOLIO_Q = `query($id:String!,$offset:Int){ community { lender(publicId:$id){ name loanCount
  loans(limit:100, offset:$offset){ totalCount values { id geocode{country{isoCode name region}} sector{name} activity{name}
  } } } } }`;

async function loadPortfolio(id) {
  const first = await gql(PORTFOLIO_Q, { id, offset: 0 });
  const lender = first.community.lender;
  if (!lender) throw new Error(`No public lender page found for "${id}". Check the ID and that the lender page is public.`);
  let loans = lender.loans.values;
  const total = lender.loans.totalCount;
  const rest = [];
  for (let off = 100; off < total; off += 100) rest.push(() => gql(PORTFOLIO_Q, { id, offset: off }));
  (await inBatches(rest)).forEach(d => { loans = loans.concat(d.community.lender.loans.values); });
  const p = { name: lender.name, total, ids: new Set(), country: {}, countryNames: {}, sector: {}, activity: {} };
  const inc = (o, k) => { if (k != null && k !== '__proto__') o[k] = (o[k] || 0) + 1; };
  for (const l of loans) {
    p.ids.add(Number(l.id));
    const c = l.geocode && l.geocode.country;
    if (c) { inc(p.country, c.isoCode); p.countryNames[c.isoCode] = c.name; }
    inc(p.sector, l.sector && l.sector.name);
    inc(p.activity, l.activity && l.activity.name);  }
  return p;
}

async function loadBadges(id) {
  const d = await gql(`query($id:String){ userAchievementProgress(publicId:$id){ tieredLendingAchievements {
    id description totalProgressToAchievement tiers { target completedDate } matchingLoans { filters } } } }`, { id });
  const list = (d.userAchievementProgress && d.userAchievementProgress.tieredLendingAchievements) || [];
  return list.map(a => {
    const id = str(a.id);
    const progress = Number(a.totalProgressToAchievement) || 0;
    const tiers = (a.tiers || []).map(t => ({ target: Number(t.target) || 0, completedDate: t.completedDate || null }));
    const next = tiers.find(t => !t.completedDate && t.target > progress) || null;
    return { id, name: BADGE_NAMES[id] || id.replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase()), tiers,
      description: str(a.description), progress, next, remaining: next ? next.target - progress : 0,
      filters: (a.matchingLoans && a.matchingLoans.filters) || [], loanIds: new Set() };
  });
}

async function loadFacets() {
  const d = await gql(`{ lend { countryFacets { count country { isoCode name region } } } }`);
  return d.lend.countryFacets.filter(f => f.country && f.country.region)
    .map(f => ({ iso: str(f.country.isoCode), name: str(f.country.name), region: str(f.country.region), count: Number(f.count) || 0 }));
}

const POOL_Q = `query($f:[FundraisingLoanSearchFilterInput!],$page:Int){ fundraisingLoans(filters:$f, limit:${PAGE}, pageNumber:$page){
  totalCount values { id name use loanAmount lenderRepaymentTerm plannedExpirationDate isMatchable
  image { url(presetSize:loan_thumbnail) } geocode { country { isoCode name region } } sector { name } activity { name }
  loanFundraisingInfo { fundedAmount reservedAmount }
  ... on LoanPartner { partner { defaultRate } } } } }`;
const IDS_Q = `query($f:[FundraisingLoanSearchFilterInput!],$page:Int){ fundraisingLoans(filters:$f, limit:${PAGE}, pageNumber:$page){ totalCount values { id } } }`;

// onProgress(newValues, loadedSoFar, total) runs after each batch; returning false stops fetching
async function fetchAllPages(query, filters, onProgress) {
  const first = await gql(query, { f: filters, page: 0 });
  const total = first.fundraisingLoans.totalCount;
  let values = first.fundraisingLoans.values.filter(Boolean);
  if (onProgress && onProgress(values, values.length, total) === false) return values;
  const rest = [];
  for (let page = 1; page * PAGE < total; page++) rest.push(() => gql(query, { f: filters, page }));
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const chunk = (await Promise.all(rest.slice(i, i + CONCURRENCY).map(t => t())))
      .flatMap(d => d.fundraisingLoans.values).filter(Boolean);
    values = values.concat(chunk);
    if (onProgress && onProgress(chunk, values.length, total) === false) break;
  }
  return values;
}

function allRegions() { return [...new Set(state.facets.map(f => f.region))].sort(); }
function regionCountries() {
  const regions = settings.regions || allRegions();
  return state.facets.filter(f => regions.includes(f.region) && !isExcludedCountry(f.iso)).map(f => f.iso);
}

// AND our base filter into each of the badge's OR'd filter entries, intersecting country lists
async function loadBadgeIds(isos, base) {
  const badgeIds = {};
  await Promise.all(state.badges.filter(b => b.next && b.filters.length).map(async b => {
    const entries = b.filters.map(f => {
      const own = f.countryIsoCode && f.countryIsoCode.any;
      const any = own ? own.filter(c => isos.includes(c)) : isos;
      return any.length ? { ...f, ...base, countryIsoCode: { any } } : null;
    }).filter(Boolean);
    const ids = entries.length ? await fetchAllPages(IDS_Q, entries) : [];
    badgeIds[b.id] = new Set(ids.map(x => x.id));
  }));
  return badgeIds;
}

// seq identifies this load; if settings change mid-load a newer load takes over and this one stops
async function loadPool(force, seq) {
  const current = () => seq === state.loadSeq;
  const isos = regionCountries();
  const key = settings.lender + '|' + isos.slice().sort().join(',') + '|' + settings.womenOnly;
  if (key === state.poolKey && !force) return;
  if (force) poolCache.delete(key);
  if (!force && !poolCache.has(key)) {
    const stored = await idbGet('pool:v2');
    if (!current()) return;
    if (stored && stored.key === key && Date.now() - stored.at < POOL_TTL)
      poolCache.set(key, { loans: stored.loans.map(enrich), badgeIds: stored.badgeIds, at: stored.at });
  }
  if (!poolCache.has(key)) {
    if (!isos.length) { poolCache.set(key, { loans: [], badgeIds: {}, at: Date.now() }); }
    else {
      const base = { countryIsoCode: { any: isos } };
      if (settings.womenOnly) base.gender = { eq: 'female' };
      // Badge matches first (a few small requests), so cards shown during loading already carry badge reasons
      setStatus('Checking which loans count toward your badges…');
      const badgeIds = await loadBadgeIds(isos, base);
      if (!current()) return;
      state.badges.forEach(b => { b.loanIds = badgeIds[b.id] || new Set(); });
      state.pool = [];
      setStatus('Loading fundraising loans…');
      const loans = await fetchAllPages(POOL_Q, [base], (chunk, n, total) => {
        if (!current()) return false;
        state.pool = state.pool.concat(chunk.map(enrich));
        if (n < total) {
          setStatus(`Loading fundraising loans… ${n} of ${total}. Showing what's loaded so far; rankings may shift until it finishes.`);
          render();
        }
      });
      if (!current()) return;
      poolCache.set(key, { loans: state.pool, badgeIds, at: Date.now() });
      idbSet('pool:v2', { key, loans, badgeIds, at: Date.now() });
    }
  }
  const cached = poolCache.get(key);
  state.pool = cached.loans;
  state.poolAt = cached.at;
  state.badges.forEach(b => { b.loanIds = cached.badgeIds[b.id] || new Set(); });
  state.poolKey = key;
}

// Only Kiva-hosted https images are shown (this also matches the page's Content-Security-Policy)
const safeImage = u => (typeof u === 'string' && /^https:\/\/www\.kiva\.org\//.test(u) ? u : '');
const str = v => (v == null ? '' : String(v));

// Normalize each loan from the API: numbers are numbers and text is text before anything is rendered
function enrich(raw) {
  const l = { ...raw, id: Number(raw.id) || 0, lenderRepaymentTerm: Number(raw.lenderRepaymentTerm) || 0,
    name: str(raw.name), use: str(raw.use), isMatchable: raw.isMatchable === true,
    image: { url: safeImage(raw.image && raw.image.url) } };
  const amount = parseFloat(l.loanAmount) || 0;
  const fi = l.loanFundraisingInfo || {};
  const left = Math.max(0, amount - (parseFloat(fi.fundedAmount) || 0) - (parseFloat(fi.reservedAmount) || 0));
  const c = (l.geocode && l.geocode.country) || {};
  const defaultRate = l.partner && l.partner.defaultRate != null ? Number(l.partner.defaultRate) : null;
  return { ...l, amount, left, funded: amount ? (amount - left) / amount : 0, iso: str(c.isoCode), country: str(c.name),
    sectorName: str(l.sector && l.sector.name), activityName: str(l.activity && l.activity.name),
    defaultRate: Number.isFinite(defaultRate) ? defaultRate : null,
    daysLeft: l.plannedExpirationDate ? Math.max(0, (new Date(l.plannedExpirationDate) - Date.now()) / 864e5) : 99,
    text: [l.name, l.use, l.activity && l.activity.name, l.sector && l.sector.name, c.name].join(' ').toLowerCase() };
}

// ---------- scoring ----------
function maxOf(o) { return Math.max(1, ...Object.values(o)); }

function scoreLoan(l) {
  const p = state.portfolio;
  const reasons = [];
  const cN = p.country[l.iso] || 0, sN = p.sector[l.sectorName] || 0, aN = p.activity[l.activityName] || 0;

  const fam = 0.35 * cN / maxOf(p.country) + 0.35 * sN / maxOf(p.sector) + 0.3 * aN / maxOf(p.activity);
  // Reasons are [kind, text] plus, when they name a country/sector/activity, [dimension, value] so they can be hidden
  const C = ['country', l.iso], S = ['sector', l.sectorName], A = ['activity', l.activityName];
  const rank = (o, k) => Object.entries(o).sort((a, b) => b[1] - a[1]).findIndex(e => e[0] == k) + 1;
  if (cN && rank(p.country, l.iso) <= 3) reasons.push(['fam', `Your #${rank(p.country, l.iso)} country`, ...C]);
  if (sN && rank(p.sector, l.sectorName) <= 3) reasons.push(['fam', `Favorite sector: ${l.sectorName}`, ...S]);
  if (aN >= 3) reasons.push(['fam', `You've made ${aN} ${l.activityName} loans`, ...A]);

  let nov = 0;
  if (cN === 0) { nov += 1; reasons.unshift(['new', `New country: ${l.country}`, ...C]); }
  else if (cN <= 2) { nov += 0.6; reasons.unshift(['new', `You've made ${cN} loan${cN > 1 ? 's' : ''} in ${l.country}`, ...C]); }
  else if (cN <= 5) nov += 0.3;
  if (sN === 0) { nov += 0.5; reasons.push(['new', `New sector: ${l.sectorName}`, ...S]); } else if (sN <= 2) nov += 0.25;
  if (aN === 0) { nov += 0.5; reasons.push(['new', `New activity: ${l.activityName}`, ...A]); }
  nov /= 2;

  let badge = 0; const badgeHits = [];
  for (const b of state.badges) {
    if (!b.next || !b.loanIds.has(l.id)) continue;
    badgeHits.push(b.id);
    badge = Math.max(badge, 1 / Math.sqrt(b.remaining));
    reasons.push(['badge', `${b.name}: ${b.remaining} to next tier`]);
  }

  // Urgency: how close the loan is to fully funded, how little is left to raise, and how soon it expires
  const urg = 0.4 * l.funded + 0.3 * (1 - Math.min(l.left, 500) / 500) + 0.3 * (1 - Math.min(l.daysLeft, 30) / 30);
  if (l.funded >= 0.75) reasons.push(['urgent', `${Math.floor(100 * l.funded)}% funded`]);
  if (l.left > 0 && l.left <= 100) reasons.push(['urgent', `Only $${Math.round(l.left)} left`]);
  if (l.daysLeft < 5) reasons.push(['urgent', `Expires in ${Math.ceil(l.daysLeft)} day${Math.ceil(l.daysLeft) === 1 ? '' : 's'}`]);
  if (l.isMatchable) reasons.push(['urgent', 'Matched']);

  // Without a lender there is no history to compare against, so rank on urgency alone
  if (!settings.lender) return { fam: 0, nov: 0, badge: 0, urg, top: urg, reasons: reasons.filter(r => r[0] === 'urgent'), badgeHits };
  const w = settings.wFam + settings.wNew + settings.wBadge + settings.wUrg || 1;
  const top = (settings.wFam * fam + settings.wNew * nov + settings.wBadge * badge + settings.wUrg * urg) / w;
  return { fam, nov, badge, urg, top, reasons, badgeHits };
}

function filteredPool() {
  const q = (document.getElementById('search').value || '').trim().toLowerCase();
  const maxTerm = +settings.maxTerm, maxDef = +settings.maxDefault,
        minFunded = +settings.minFunded / 100, maxLeft = +settings.maxLeft, maxDays = +settings.maxDays;
  const ex = settings.excluded;
  return state.pool.filter(l =>
    l.left > 0 &&
    !ex.country.includes(l.iso) && !ex.sector.includes(l.sectorName) && !ex.activity.includes(l.activityName) &&
    l.funded >= minFunded &&
    !(maxLeft && l.left > maxLeft) &&
    !(maxDays && l.daysLeft > maxDays) &&
    !(settings.hideOwned && state.portfolio.ids.has(l.id)) &&
    !(maxTerm && l.lenderRepaymentTerm > maxTerm) &&
    !(maxDef < 100 && l.defaultRate != null && l.defaultRate > maxDef) &&
    !(state.countryFilter && l.iso !== state.countryFilter) &&
    !(q && !l.text.includes(q)));
}

function sortLoans(list, key) {
  const by = {
    score: (a, b) => b.s[key] - a.s[key] || a.left - b.left,
    left: (a, b) => a.left - b.left,
    funded: (a, b) => b.funded - a.funded || a.left - b.left,
    expiring: (a, b) => a.daysLeft - b.daysLeft,
    term: (a, b) => a.lenderRepaymentTerm - b.lenderRepaymentTerm || b.s[key] - a.s[key],
  }[settings.sortBy];
  return list.sort(by);
}

// ---------- render ----------
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Math.round(n).toLocaleString();
// e.g. 11:00a, 2:05p
const shortTime = t => { const d = new Date(t), h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; };
function setStatus(msg, err, action) {
  const s = $('status');
  s.innerHTML = esc(msg) + (action ? ` <button class="link" data-action="${action}">${action}</button>` : '');
  s.className = 'status' + (err ? ' err' : '');
}

function renderStats() {
  const p = state.portfolio;
  if (!p || !settings.lender) { $('stats').innerHTML = ''; return; }
  const isos = new Set(regionCountries());
  const inRegions = state.facets.filter(f => isos.has(f.iso));
  const covered = inRegions.filter(f => p.country[f.iso]).length;
  const gaps = inRegions.filter(f => f.count > 0 && !p.country[f.iso]).length;
  const nextBadge = state.badges.filter(b => b.next && !(isExcludedCountry('US') && b.id === 'us-economic-equality'))
    .sort((a, b) => a.remaining - b.remaining)[0];
  $('stats').innerHTML = `
    <span><b>${p.total}</b> loans by ${esc(p.name)}</span>
    <span><b>${Object.keys(p.country).length}</b> countries overall</span>
    <span><b>${covered}/${inRegions.length}</b> countries covered in selected regions</span>
    <span><b>${gaps}</b> new-to-you countries available</span>
    ${nextBadge ? `<span><b>${nextBadge.remaining}</b> loan${nextBadge.remaining > 1 ? 's' : ''} to the next ${esc(nextBadge.name)} tier</span>` : ''}`;
}

// ---------- filter criteria shown above the results ----------
// The "off" value of each filter, used by the ✕ on its criteria chip
const FILTER_OFF = { excludeGroup: 'none', womenOnly: false, maxTerm: '0', maxDefault: '100', minFunded: '0', maxLeft: '0', maxDays: '0' };
const POOL_FILTERS = ['excludeGroup', 'womenOnly'];   // these change which loans are downloaded

function filterCounts() {
  const ex = settings.excluded;
  const loan = (settings.womenOnly ? 1 : 0) + (+settings.maxTerm ? 1 : 0) + (+settings.maxDefault < 100 ? 1 : 0);
  const funding = ['minFunded', 'maxLeft', 'maxDays'].filter(k => +settings[k]).length;
  const hidden = ex.country.length + ex.sector.length + ex.activity.length;
  return { loan, funding, hidden, all: loan + funding + hidden + (settings.excludeGroup !== 'none' ? 1 : 0) };
}

function renderCriteria() {
  const c = filterCounts();
  const regions = settings.regions || allRegions();
  $('cntRegions').textContent = regions.length || '';
  $('cntLoan').textContent = c.loan || '';
  $('cntFunding').textContent = c.funding || '';
  $('cntHidden').textContent = c.hidden || '';
  $('cntAll').textContent = c.all || '';

  const chip = (label, attrs, cls = '') => `<span class="chip ${cls}">${esc(label)}${attrs ? `<button ${attrs} aria-label="Remove">✕</button>` : ''}</span>`;
  const out = [];
  out.push(`<span class="chip region" data-open="regions" title="Change regions">${esc(regions.length ? regions.join(', ') : 'No regions selected')}</span>`);
  if (settings.excludeGroup !== 'none') out.push(chip(`Excluding ${settings.excludeGroup.toUpperCase()}`, 'data-reset="excludeGroup"'));
  if (settings.womenOnly) out.push(chip('Women borrowers', 'data-reset="womenOnly"'));
  if (+settings.maxTerm) out.push(chip(`Term ≤ ${settings.maxTerm} mo`, 'data-reset="maxTerm"'));
  if (+settings.maxDefault < 100) out.push(chip(`Default rate ≤ ${settings.maxDefault}%`, 'data-reset="maxDefault"'));
  if (+settings.minFunded) out.push(chip(`≥ ${settings.minFunded}% funded`, 'data-reset="minFunded"'));
  if (+settings.maxLeft) out.push(chip(`≤ $${settings.maxLeft} left`, 'data-reset="maxLeft"'));
  if (+settings.maxDays) out.push(chip(`≤ ${settings.maxDays} days left`, 'data-reset="maxDays"'));
  ['country', 'sector', 'activity'].forEach(dim => settings.excluded[dim].forEach(val =>
    out.push(chip(`Excluding ${excludedName(dim, val)}`, `data-unexclude="${dim}" data-val="${esc(val)}"`))));
  const q = $('search').value.trim();
  if (q) out.push(chip(`“${q}”`, 'data-clear="search"'));
  if (state.countryFilter) {
    const f = state.facets.find(x => x.iso === state.countryFilter);
    out.push(chip(`Only ${f ? f.name : state.countryFilter}`, 'data-clear="country"'));
  }
  if (state.badgeFocus && settings.tab === 'badge') {
    const b = state.badges.find(x => x.id === state.badgeFocus);
    out.push(chip(`Badge: ${b.name}`, 'data-clear="badge"', 'badge'));
  }
  $('criteria').innerHTML = out.join('');
}

// After any filter change: remember it, update the controls, then re-download or just re-rank
function afterFilterChange(needsPool) {
  searchChanged(); syncControls(); renderSearches(); renderRegions(); renderStats();
  state.shown = SHOW_STEP;
  if (needsPool) refreshPool(); else render();
}
function resetFilter(key) { settings[key] = FILTER_OFF[key]; afterFilterChange(POOL_FILTERS.includes(key)); }
function resetAllFilters() {
  ['excludeGroup', 'womenOnly', 'maxTerm', 'maxDefault', 'minFunded', 'maxLeft', 'maxDays'].forEach(k => { settings[k] = DEFAULTS[k]; });
  settings.regions = DEFAULTS.regions.slice();
  settings.excluded = noExclusions();
  $('search').value = '';
  state.countryFilter = null;
  renderExcluded();
  afterFilterChange(true);
}

// ---------- sidebar open/closed (drawer on narrow screens) ----------
const isNarrow = () => matchMedia('(max-width: 900px)').matches;
function applySidebar() { document.body.classList.toggle('filters-closed', !settings.sidebarOpen); }
function openFilters(section) {
  if (isNarrow()) document.body.classList.add('drawer-open');
  else { settings.sidebarOpen = true; saveSettings(); applySidebar(); }
  const sec = section && document.querySelector(`.sec[data-sec="${section}"]`);
  if (sec) { sec.open = true; sec.scrollIntoView({ block: 'nearest' }); }
}
function closeFilters() {
  if (isNarrow()) document.body.classList.remove('drawer-open');
  else { settings.sidebarOpen = false; saveSettings(); applySidebar(); }
}

// ---------- hiding countries, sectors and activities ----------
const DIM_LABEL = { country: 'country', sector: 'sector', activity: 'activity' };
function excludedName(dim, val) {
  if (dim !== 'country') return val;
  const f = state.facets.find(x => x.iso === val);
  return f ? f.name : val;
}
function hideBtn(dim, val) {
  const name = excludedName(dim, val);
  return `<button class="x" data-exclude="${dim}" data-val="${esc(val)}" title="Exclude all loans in this ${DIM_LABEL[dim]}: ${esc(name)}" aria-label="Exclude ${esc(name)}">✕</button>`;
}
function setExcluded(dim, val, hide) {
  const ex = settings.excluded;
  const list = ex[dim].filter(v => v !== val);
  settings.excluded = { ...ex, [dim]: hide ? [...list, val].sort() : list };
  searchChanged(); renderSearches(); renderExcluded(); state.shown = Math.max(state.shown, SHOW_STEP); render();
}
function renderExcluded() {
  const ex = settings.excluded;
  const chips = ['country', 'sector', 'activity'].flatMap(dim => ex[dim].map(val =>
    `<span class="chip">${esc(excludedName(dim, val))}<button data-unexclude="${dim}" data-val="${esc(val)}" aria-label="Include ${esc(excludedName(dim, val))} again">✕</button></span>`));
  $('secHidden').hidden = !chips.length;
  $('excludedChips').innerHTML = chips.join('');
}
let toastTimer;
function showUndo(dim, val) {
  const t = $('toast');
  t.innerHTML = `Excluded all ${esc(excludedName(dim, val))} loans <button data-undo="${dim}" data-val="${esc(val)}">Undo</button>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

function cardHtml(l) {
  const pct = l.amount ? Math.round(100 * (l.amount - l.left) / l.amount) : 0;
  const shownScore = { top: 'top', fam: 'fam', new: 'nov', badge: 'badge' }[settings.tab];
  const chips = l.s.reasons.slice(0, 5).map(([k, t, dim, val]) =>
    `<span class="chip ${k}${dim ? ' ex' : ''}">${esc(t)}${dim ? hideBtn(dim, val) : ''}</span>`).join('');
  const part = (dim, val, label) => `<span class="ex">${esc(label)}${hideBtn(dim, val)}</span>`;
  return `<article class="card">
    <a href="https://www.kiva.org/lend/${l.id}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="${esc(l.image && l.image.url)}"></a>
    <div>
      <h3><a href="https://www.kiva.org/lend/${l.id}" target="_blank" rel="noopener">${esc(l.name)}</a>
        <span class="score" title="Score for this loan">${Math.round(100 * l.s[shownScore])}</span></h3>
      <div class="meta">${part('country', l.iso, l.country)} · ${part('sector', l.sectorName, l.sectorName)} / ${part('activity', l.activityName, l.activityName)}</div>
      <div class="use">${esc(l.use)}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="meta">${money(l.left)} left of ${money(l.amount)} · ${l.lenderRepaymentTerm} mo · ${Math.ceil(l.daysLeft)}d left</div>
      <div class="chiprow">${chips}</div>
    </div></article>`;
}

function renderLoans(list, key) {
  sortLoans(list, key);
  if (!list.length) return `<div class="empty">No loans match these filters. Try a longer repayment term, more regions, or clearing the search.</div>`;
  const shown = list.slice(0, state.shown);
  return `<div class="meta" style="margin-bottom:8px">${list.length} matching loan${list.length === 1 ? '' : 's'}</div>
    <div class="grid">${shown.map(cardHtml).join('')}</div>
    ${list.length > shown.length ? `<div class="more"><button id="moreBtn">Show more (${list.length - shown.length} left)</button></div>` : ''}`;
}

function renderBadgeTab(list) {
  const cards = state.badges.map(b => {
    const done = !b.next;
    const pct = done ? 100 : Math.round(100 * b.progress / b.next.target);
    const n = list.filter(l => b.loanIds.has(l.id)).length;
    const note = done ? 'Every tier complete'
      : b.id === 'us-economic-equality' && isExcludedCountry('US') ? 'U.S. loans only, which your settings exclude'
      : `${b.remaining} more to reach ${b.next.target} · ${n} matching loan${n === 1 ? '' : 's'}`;
    return `<button class="panel badgecard${state.badgeFocus === b.id ? ' on' : ''}" data-badge="${esc(b.id)}" ${done ? 'disabled' : ''}>
      <strong>${esc(b.name)}</strong> <span class="meta">${b.progress} loans</span>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p>${esc(note)}</p></button>`;
  }).join('');
  const subset = state.badgeFocus
    ? list.filter(l => state.badges.find(b => b.id === state.badgeFocus).loanIds.has(l.id))
    : list.filter(l => l.s.badge > 0);
  return `<div class="badges">${cards}</div>${renderLoans(subset, 'badge')}`;
}

function renderCoverage() {
  const p = state.portfolio;
  const isos = new Set(regionCountries());
  const matching = {};
  const base = state.countryFilter;
  state.countryFilter = null;
  filteredPool().forEach(l => { matching[l.iso] = (matching[l.iso] || 0) + 1; });
  state.countryFilter = base;
  const rows = state.facets.filter(f => isos.has(f.iso))
    .map(f => ({ ...f, mine: p.country[f.iso] || 0, match: matching[f.iso] || 0 }))
    .filter(r => r.count > 0 || r.mine > 0)
    .sort((a, b) => (a.mine > 0) - (b.mine > 0) || a.mine - b.mine || b.match - a.match);
  const maxMine = Math.max(1, ...rows.map(r => r.mine));
  return `<div class="panel tablewrap"><table>
    <thead><tr><th>Country</th><th>Region</th><th class="num">Your loans</th><th></th><th class="num">Fundraising now</th><th class="num">Match your filters</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.mine ? '' : 'gap'}">
      <td>${esc(r.name)} ${r.mine ? '' : '<span class="chip new">new</span>'}</td>
      <td class="meta">${esc(r.region)}</td>
      <td class="num">${r.mine}</td>
      <td style="width:120px"><div class="bar"><i style="width:${Math.round(100 * r.mine / maxMine)}%"></i></div></td>
      <td class="num">${r.count}</td>
      <td class="num">${r.match}</td>
      <td>${r.match ? `<button data-country="${esc(r.iso)}">Show loans</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function render() {
  // Without a lender ID only Top picks (ranked by urgency) makes sense; the history-based parts are hidden
  const anon = !settings.lender;
  const tab = anon ? 'top' : settings.tab;
  document.querySelectorAll('#tabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.hidden = anon && b.dataset.tab !== 'top';
  });
  $('weights').hidden = anon;
  $('hideOwned').closest('label').hidden = anon;
  $('tabHelp').textContent = anon ? TAB_HELP.anon : TAB_HELP[tab];
  renderCriteria();
  if (!state.portfolio) return;
  const view = $('view');
  if (tab === 'coverage') { view.innerHTML = renderCoverage(); return; }
  const list = filteredPool();
  list.forEach(l => { l.s = scoreLoan(l); });
  if (tab === 'top') view.innerHTML = renderLoans(list, 'top');
  else if (tab === 'fam') view.innerHTML = renderLoans(list.filter(l => l.s.fam > 0), 'fam');
  else if (tab === 'new') view.innerHTML = renderLoans(list.filter(l => l.s.nov > 0), 'nov');
  else view.innerHTML = renderBadgeTab(list);
}

// ---------- wiring ----------
function syncControls() {
  $('lenderId').value = settings.lender;
  $('excludeGroup').value = settings.excludeGroup;
  $('womenOnly').checked = settings.womenOnly;
  $('hideOwned').checked = settings.hideOwned;
  ['maxTerm', 'maxDefault', 'sortBy', 'wFam', 'wNew', 'wBadge', 'wUrg'].forEach(k => { $(k).value = settings[k]; });
  document.querySelectorAll('.pills').forEach(p => p.querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.v === String(settings[p.dataset.key]))));
}

// Region checkboxes come from Kiva's own region list, with fundraising loan counts
function renderRegions() {
  if (!state.facets.length) return;
  const regions = settings.regions || allRegions();
  $('regionChecks').innerHTML = allRegions().map(r => {
    const n = state.facets.filter(f => f.region === r && !isExcludedCountry(f.iso))
      .reduce((t, f) => t + f.count, 0);
    return `<label><input type="checkbox" value="${esc(r)}" ${regions.includes(r) ? 'checked' : ''}> ${esc(r)} <span class="meta">${n.toLocaleString()}</span></label>`;
  }).join('');
}

async function refreshPool(force) {
  const seq = ++state.loadSeq;
  state.shown = SHOW_STEP;
  try {
    await loadPool(force, seq);
    if (seq !== state.loadSeq) return;
    setStatus(`${state.pool.length.toLocaleString()} fundraising loans · updated ${shortTime(state.poolAt)}`, false, 'Refresh');
  } catch (e) {
    if (seq !== state.loadSeq) return;
    setStatus('Could not load loans: ' + e.message, true, 'Retry');
  }
  render();
}

async function loadProfile(force) {
  const stored = !force && await idbGet('profile:v2');
  if (stored && stored.lender === settings.lender && Date.now() - stored.at < PROFILE_TTL) return stored;
  const empty = { name: '', total: 0, ids: new Set(), country: {}, countryNames: {}, sector: {}, activity: {} };
  const [portfolio, badges, facets] = settings.lender
    ? await Promise.all([loadPortfolio(settings.lender), loadBadges(settings.lender), loadFacets()])
    : [empty, [], await loadFacets()];
  idbSet('profile:v2', { lender: settings.lender, portfolio, badges, facets, at: Date.now() });
  return { portfolio, badges, facets };
}

async function loadAll(force) {
  const typed = $('lenderId').value.trim();
  settings.lender = cleanLender(typed);
  $('lenderId').value = settings.lender;
  if (typed && !settings.lender) { setStatus("That doesn't look like a Kiva lender ID (letters and numbers from kiva.org/lender/<id>).", true); return; }
  saveSettings();
  state.loadSeq++;
  state.portfolio = null; state.poolKey = ''; state.pool = []; poolCache.clear(); state.countryFilter = null; state.badgeFocus = null;
  $('view').innerHTML = ''; renderStats(); render();
  setStatus(settings.lender ? `Loading ${settings.lender}'s portfolio and badges…` : 'Loading regions…');
  try {
    const { portfolio, badges, facets } = await loadProfile(force);
    Object.assign(state, { portfolio, badges, facets });
    renderRegions();
    renderExcluded();
    renderSearches();
    renderStats();
    await refreshPool(force);
  } catch (e) { setStatus(e.message, true, 'Retry'); }
}

$('lenderForm').addEventListener('submit', e => { e.preventDefault(); loadAll(true); });
$('status').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.action === 'Refresh' || !state.portfolio) loadAll(b.dataset.action === 'Refresh');
  else refreshPool();
});
$('regionChecks').addEventListener('change', () => {
  settings.regions = [...document.querySelectorAll('#regionChecks input:checked')].map(i => i.value);
  afterFilterChange(true);
});
$('excludeGroup').addEventListener('change', e => { settings.excludeGroup = e.target.value; afterFilterChange(true); });
$('womenOnly').addEventListener('change', e => { settings.womenOnly = e.target.checked; afterFilterChange(true); });
$('hideOwned').addEventListener('change', e => { settings.hideOwned = e.target.checked; afterFilterChange(false); });
['maxTerm', 'maxDefault', 'sortBy'].forEach(k => $(k).addEventListener('change', e => { settings[k] = e.target.value; afterFilterChange(false); }));
$('sidebar').addEventListener('click', e => {
  const b = e.target.closest('.pills button'); if (!b) return;
  settings[b.closest('.pills').dataset.key] = b.dataset.v;
  afterFilterChange(false);
});
// Remember which sidebar sections are collapsed
document.querySelectorAll('.sec').forEach(d => {
  d.open = !settings.closedSecs.includes(d.dataset.sec);
  d.addEventListener('toggle', () => {
    settings.closedSecs = [...document.querySelectorAll('.sec')].filter(x => !x.open).map(x => x.dataset.sec);
    saveSettings();
  });
});
$('filtersBtn').addEventListener('click', () => openFilters());
$('closeFilters').addEventListener('click', closeFilters);
$('backdrop').addEventListener('click', closeFilters);
$('resetBtn').addEventListener('click', resetAllFilters);
$('criteria').addEventListener('click', e => {
  if (e.target.closest('[data-open]')) { openFilters(e.target.closest('[data-open]').dataset.open); return; }
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.reset) resetFilter(b.dataset.reset);
  else if (b.dataset.unexclude) setExcluded(b.dataset.unexclude, b.dataset.val, false);
  else if (b.dataset.clear === 'search') { $('search').value = ''; state.shown = SHOW_STEP; render(); }
  else if (b.dataset.clear === 'country') { state.countryFilter = null; render(); }
  else if (b.dataset.clear === 'badge') { state.badgeFocus = null; render(); }
});
['wFam', 'wNew', 'wBadge', 'wUrg'].forEach(k => $(k).addEventListener('input', e => { settings[k] = +e.target.value; searchChanged(); render(); }));
$('savedSel').addEventListener('change', e => {
  const v = loadSearches(), val = e.target.value;
  if (!val) return;
  const s = val[0] === 's' ? v.saved[+val.slice(1)].s : v.recent[+val.slice(1)];
  if (s) applySearch(s);
});
$('saveBtn').addEventListener('click', () => {
  const name = $('saveName').value.trim() || describeSearch(currentSearch());
  const v = loadSearches();
  v.saved = [...v.saved.filter(x => x.name !== name), { name, s: currentSearch() }];
  storeSearches(v);
  $('saveName').value = '';
  renderSearches();
});
$('saveName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('saveBtn').click(); } });
$('delBtn').addEventListener('click', () => {
  const v = loadSearches();
  v.saved.splice(+$('delBtn').dataset.idx, 1);
  storeSearches(v);
  renderSearches();
});
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.shown = SHOW_STEP; render(); }, 200); });
$('tabs').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  settings.tab = t.dataset.tab; saveSettings(); state.shown = SHOW_STEP; render();
});
$('excludedChips').addEventListener('click', e => {
  const b = e.target.closest('button[data-unexclude]'); if (b) setExcluded(b.dataset.unexclude, b.dataset.val, false);
});
$('toast').addEventListener('click', e => {
  const b = e.target.closest('button[data-undo]'); if (!b) return;
  setExcluded(b.dataset.undo, b.dataset.val, false);
  $('toast').hidden = true;
});
$('view').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.exclude) { setExcluded(b.dataset.exclude, b.dataset.val, true); showUndo(b.dataset.exclude, b.dataset.val); }
  else if (b.id === 'moreBtn') { state.shown += SHOW_STEP; render(); }
  else if (b.dataset.country) { state.countryFilter = b.dataset.country; settings.tab = 'top'; state.shown = SHOW_STEP; render(); window.scrollTo(0, 0); }
  else if (b.dataset.badge) { state.badgeFocus = state.badgeFocus === b.dataset.badge ? null : b.dataset.badge; state.shown = SHOW_STEP; render(); }
});
$('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('kivaFinderTheme', root.dataset.theme); } catch (e) {}
});
try { const t = localStorage.getItem('kivaFinderTheme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}

syncControls();
applySidebar();
render();
loadAll();
