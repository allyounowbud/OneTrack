const { google } = require('googleapis');

/** ==== SHEET SETTINGS (same as your Apps Script) ==== */
const TAB_ORDER_BOOK   = 'Order Book';
const TAB_ITEMS        = 'Items';
const TAB_RETAILERS    = 'Retailers';
const TAB_MARKETPLACES = 'Marketplaces';

// Order Book headers are on row 2 (A:J)
const OB = {
  headerRow: 2,
  colOrderDate: 1,   // A
  colItem: 2,        // B
  colBuyPrice: 3,    // C (negative in your logic)
  colRetailer: 4,    // D
  colSellPrice: 5,   // E
  colSaleDate: 6,    // F
  colMarketplace: 7, // G
  colFeesPct: 8,     // H (0..1)
  colShipping: 9,    // I
  colPL: 10          // J (formula in sheet)
};

// Other tabs: headers on row 1
const ITEMS = { headerRow: 1, colName: 1, colMarketVal: 2 };
const RETS  = { headerRow: 1, colName: 1 };
const MKTS  = { headerRow: 1, colName: 1, colFeePct: 2 };

/** ==== INFRA ==== */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();
const setCache = (k, v, ttl = CACHE_TTL_MS) => cache.set(k, { v, exp: Date.now() + ttl });
const getCache = (k) => {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.exp) { cache.delete(k); return null; }
  return hit.v;
};
const clearCache = () => cache.clear();

const normalizeKey = k => (k || '').replace(/\\n/g, '\n');

function sheetsClient(readWrite = false) {
  const scopes = readWrite
    ? ['https://www.googleapis.com/auth/spreadsheets']
    : ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: normalizeKey(process.env.GOOGLE_PRIVATE_KEY),
    scopes
  });
  return google.sheets({ version: 'v4', auth });
}

function colNumberToA1(n) { let s=''; while(n>0){ n--; s=String.fromCharCode(65+(n%26))+s; n=Math.floor(n/26);} return s; }
function a1Row(sheet,row,c1,c2){ return `${sheet}!${colNumberToA1(c1)}${row}:${colNumberToA1(c2)}${row}`; }

async function getSheetMeta(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const byName = {};
  (meta.data.sheets||[]).forEach(s => { byName[s.properties.title] = s.properties.sheetId; });
  return { byName };
}

/** ==== READ HELPERS ==== */
async function readRange(sheets, spreadsheetId, sheetName, a1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${a1}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  return res.data.values || [];
}

async function readWhole(sheets, spreadsheetId, sheetName, headerRow = 1) {
  const key = `WHOLE:${sheetName}`;
  const cached = getCache(key);
  if (cached) return cached;
  const values = await readRange(sheets, spreadsheetId, sheetName, 'A1:ZZ');
  const headers = (values[headerRow - 1] || []).map(v => (v ?? '').toString().trim());
  const out = { headers, rows: values.slice(headerRow) };
  setCache(key, out);
  return out;
}

/** ==== UTIL ==== */
function toNumber(x) {
  if (x === null || x === undefined || x === '') return 0;
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return n;
}
function parseDateMaybe(x) {
  if (!x && x !== 0) return null;
  if (x instanceof Date) return x;
  const s = String(x).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}
function yymm(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}
function normText(s) {
  let t = String(s || '').trim();
  const idx = t.indexOf(':');
  if (idx >= 0) t = t.slice(idx+1);
  return t.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}

/** ==== ACTIONS (reads) ==== */
async function getInitModel() {
  const sheets = sheetsClient(false);
  const id = process.env.SPREADSHEET_ID;

  const items   = await readWhole(sheets, id, TAB_ITEMS,        ITEMS.headerRow);
  const rets    = await readWhole(sheets, id, TAB_RETAILERS,    RETS.headerRow);
  const markets = await readWhole(sheets, id, TAB_MARKETPLACES, MKTS.headerRow);

  return {
    items: items.rows.map(r => (r[ITEMS.colName - 1] || '').toString().trim()).filter(Boolean),
    retailers: rets.rows.map(r => (r[RETS.colName - 1] || '').toString().trim()).filter(Boolean),
    marketplaces: markets.rows.map(r => (r[MKTS.colName - 1] || '').toString().trim()).filter(Boolean),
    marketplacesWithFees: markets.rows.map(r => ({
      name: (r[MKTS.colName - 1] || '').toString().trim(),
      fee_pct: toNumber(r[MKTS.colFeePct - 1] || 0)
    })).filter(x => x.name)
  };
}

async function getDatabaseFull() {
  const sheets = sheetsClient(false);
  const id = process.env.SPREADSHEET_ID;

  const items   = await readWhole(sheets, id, TAB_ITEMS,        ITEMS.headerRow);
  const rets    = await readWhole(sheets, id, TAB_RETAILERS,    RETS.headerRow);
  const markets = await readWhole(sheets, id, TAB_MARKETPLACES, MKTS.headerRow);

  return {
    items: items.rows.map((r,i)=>({
      row: ITEMS.headerRow + 1 + i,
      name: (r[ITEMS.colName - 1] || '').toString().trim(),
      release: '',
      msrp: 0,
      market: toNumber(r[ITEMS.colMarketVal - 1] || 0)
    })).filter(x => x.name),
    retailers: rets.rows.map((r,i)=>({
      row: RETS.headerRow + 1 + i,
      name: (r[RETS.colName - 1] || '').toString().trim()
    })).filter(x => x.name),
    marketplaces: markets.rows.map((r,i)=>({
      row: MKTS.headerRow + 1 + i,
      name: (r[MKTS.colName - 1] || '').toString().trim(),
      fee_pct: toNumber(r[MKTS.colFeePct - 1] || 0)
    })).filter(x => x.name)
  };
}

async function getOpenPurchases() {
  const sheets = sheetsClient(false);
  const id = process.env.SPREADSHEET_ID;
  const tab = await readWhole(sheets, id, TAB_ORDER_BOOK, OB.headerRow);

  const out = [];
  for (let i=0;i<tab.rows.length;i++){
    const r = tab.rows[i];
    const sell = toNumber(r[OB.colSellPrice-1] || 0);
    if (!(sell>0)) {
      const rowNumber = OB.headerRow + 1 + i;
      const orderDate = r[OB.colOrderDate-1] || '';
      const item = r[OB.colItem-1] || '';
      const buy = toNumber(r[OB.colBuyPrice-1] || 0);
      const retailer = r[OB.colRetailer-1] || '';
      out.push({
        row: rowNumber,
        label: `${orderDate || ''} • ${item || ''} • $${buy || 0} • ${retailer || ''}`,
        item, buy_price: buy, order_date: orderDate, bought_from: retailer
      });
    }
  }
  return out;
}

async function getOrderBookEditable() {
  const sheets = sheetsClient(false);
  const id = process.env.SPREADSHEET_ID;
  const tab = await readWhole(sheets, id, TAB_ORDER_BOOK, OB.headerRow);

  return tab.rows.map((r,i)=>({
    row: OB.headerRow + 1 + i,
    order_date: r[OB.colOrderDate-1] || '',
    item: r[OB.colItem-1] || '',
    buy_price: toNumber(r[OB.colBuyPrice-1] || 0),
    bought_from: r[OB.colRetailer-1] || '',
    sell_price: toNumber(r[OB.colSellPrice-1] || 0),
    sale_date: r[OB.colSaleDate-1] || '',
    sale_location: r[OB.colMarketplace-1] || '',
    fees_pct: toNumber(r[OB.colFeesPct-1] || 0),
    shipping: toNumber(r[OB.colShipping-1] || 0),
  }));
}

/** Inventory (matches GAS shape closely) */
async function getInventory() {
  const sheets = sheetsClient(false);
  const id = process.env.SPREADSHEET_ID;

  // Market value map from Items
  const items = await readWhole(sheets, id, TAB_ITEMS, ITEMS.headerRow);
  const mvMap = {};
  for (const r of items.rows) {
    const name = (r[ITEMS.colName-1] || '').toString().trim();
    if (!name) continue;
    mvMap[name] = toNumber(r[ITEMS.colMarketVal-1] || 0);
  }

  // Build per-item tallies from Order Book
  const ob = await readWhole(sheets, id, TAB_ORDER_BOOK, OB.headerRow);
  if (!ob.rows.length) {
    return { items: [], totals: { qty: 0, cost: 0, estValue: 0, unrealized: 0 } };
  }

  const map = {}; // item -> {boughtQty,soldQty,costAll,costSold}
  for (const r of ob.rows) {
    const item = (r[OB.colItem-1] || '').toString().trim();
    if (!item) continue;
    const buyPrice  = toNumber(r[OB.colBuyPrice-1] || 0); // negative cost in your sheet logic
    const sellPrice = toNumber(r[OB.colSellPrice-1] || 0);

    if (!map[item]) map[item] = { item, boughtQty: 0, soldQty: 0, costAll: 0, costSold: 0 };
    map[item].boughtQty += 1;
    map[item].costAll   += buyPrice;
    if (sellPrice > 0) {
      map[item].soldQty  += 1;
      map[item].costSold += buyPrice;
    }
  }

  const out = [];
  let tQty = 0, tCost = 0, tEst = 0;

  for (const key of Object.keys(map)) {
    const x = map[key];
    const onHand = Math.max(0, (x.boughtQty || 0) - (x.soldQty || 0));
    if (onHand <= 0) continue;

    const onHandCost = (x.costAll || 0) - (x.costSold || 0); // still negative
    const avgCost = onHand ? (onHandCost / onHand) : 0;

    const estPrice = mvMap[key] || 0;
    const estValue = estPrice * onHand;

    out.push({
      item: key,
      onHandQty: onHand,
      avgCost: Math.round(avgCost*100)/100,
      onHandCost: Math.round(onHandCost*100)/100,
      estPrice: Math.round(estPrice*100)/100,
      estValue: Math.round(estValue*100)/100
    });

    tQty  += onHand;
    tCost += onHandCost;
    tEst  += estValue;
  }

  out.sort((a,b) => (b.onHandQty||0)-(a.onHandQty||0));
  const unreal = tEst + (tCost || 0); // cost negative
  return {
    items: out,
    totals: {
      qty: tQty,
      cost: Math.round(tCost*100)/100,
      estValue: Math.round(tEst*100)/100,
      unrealized: Math.round(unreal*100)/100
    }
  };
}

/** Stats (rangeKey/item/from/to) closely modeled on your GAS */
async function getStatsV2(rangeKey, itemFilter, fromISO, toISO) {
  const sheets = sheetsClient(false);
  const id = process.env.SPREADSHEET_ID;
  const ob = await readWhole(sheets, id, TAB_ORDER_BOOK, OB.headerRow);
  if (!ob.rows.length) return emptyStatsPayload();

  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const minusDays = d => new Date(today.getFullYear(), today.getMonth(), today.getDate() - d);

  let start = null, end = null;
  if (rangeKey === 'mtd') { start = startOfMonth; end = today; }
  else if (rangeKey === 'last7') { start = minusDays(7); end = today; }
  else if (rangeKey === 'last30') { start = minusDays(30); end = today; }
  // explicit overrides win
  if (fromISO) { const d = new Date(fromISO); if (Number.isFinite(d)) start = d; }
  if (toISO)   { const d = new Date(toISO);   if (Number.isFinite(d)) end = d;   }
  const inWindow = (d) => {
    if (!(d instanceof Date)) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  };

  const filterTokens = new Set(normText(itemFilter || '').split(' ').filter(Boolean));
  const wantItem = (name) => {
    if (!filterTokens.size) return true;
    const toks = new Set(normText(name).split(' ').filter(Boolean));
    for (const t of filterTokens) if (!toks.has(t)) return false;
    return true;
  };

  const summary = { totalQty:0, soldQty:0, revenue:0, fees:0, shipping:0, costSold:0, profit:0, orders:0, avgDaysToSell:0 };
  const breakdownMap = {};
  const salesByMonthByItem = {};
  const purchasesByMonthByItem = {};
  const salesByPlatformByItem = {};
  const purchasesByStoreByItem = {};
  const monthlyMap = {}; // ym -> { ym, soldQty, revenue, cost }

  let dSellSum = 0, dSellCount = 0;

  for (const r of ob.rows) {
    const item = (r[OB.colItem-1] || '').toString().trim();
    if (!item) continue;
    if (!wantItem(item)) continue;

    const buyPrice   = toNumber(r[OB.colBuyPrice-1] || 0); // negative
    const sellPrice  = toNumber(r[OB.colSellPrice-1] || 0);
    const feePct     = toNumber(r[OB.colFeesPct-1] || 0);
    const shipping   = toNumber(r[OB.colShipping-1] || 0);
    const retailer   = (r[OB.colRetailer-1] || '').toString().trim();

    // coalesce empty platforms so the chart shows them
    let marketplace = (r[OB.colMarketplace-1] || '').toString().trim();
    if (!marketplace) marketplace = 'Unknown/Other';

    const orderDate = parseDateMaybe(r[OB.colOrderDate-1]);
    const saleDate  = parseDateMaybe(r[OB.colSaleDate-1]);

    const purchaseInRange = (start || end) ? inWindow(orderDate) : true;
    const sold = sellPrice > 0 && (saleDate instanceof Date);
    const saleInRange = sold ? ((start || end) ? inWindow(saleDate) : true) : false;

    if (!breakdownMap[item] && (purchaseInRange || saleInRange)) {
      breakdownMap[item] = { item, boughtQty:0, soldQty:0, totalCost:0, totalRevenue:0, costSold:0, fees:0, shipping:0, profit:0 };
    }

    if (purchaseInRange) {
      summary.totalQty += 1;
      summary.orders   += 1;
      breakdownMap[item].boughtQty += 1;
      breakdownMap[item].totalCost += buyPrice; // negative

      if (orderDate instanceof Date) {
        const ym = yymm(orderDate);
        if (!purchasesByMonthByItem[ym]) purchasesByMonthByItem[ym] = {};
        purchasesByMonthByItem[ym][item] = (purchasesByMonthByItem[ym][item] || 0) + 1;
      }
      if (!purchasesByStoreByItem[retailer]) purchasesByStoreByItem[retailer] = {};
      purchasesByStoreByItem[retailer][item] = (purchasesByStoreByItem[retailer][item] || 0) + 1;
    }

    if (saleInRange) {
      const feeAmt = sellPrice * feePct;
      breakdownMap[item].soldQty += 1;
      breakdownMap[item].totalRevenue += sellPrice;
      breakdownMap[item].fees += feeAmt;
      breakdownMap[item].shipping += shipping;
      breakdownMap[item].costSold += buyPrice;

      summary.soldQty += 1;
      summary.revenue += sellPrice;
      summary.fees    += feeAmt;
      summary.shipping+= shipping;
      summary.costSold+= buyPrice;
      summary.orders  += 1;

      if (orderDate instanceof Date && saleDate instanceof Date) {
        const diff = Math.max(0, Math.round((saleDate - orderDate)/(24*3600*1000)));
        dSellSum += diff; dSellCount += 1;
      }

      if (saleDate instanceof Date) {
        const ym = yymm(saleDate);
        if (!salesByMonthByItem[ym]) salesByMonthByItem[ym] = {};
        salesByMonthByItem[ym][item] = (salesByMonthByItem[ym][item] || 0) + 1;

        // accumulate revenue/cost for the rev/COGS chart
        if (!monthlyMap[ym]) monthlyMap[ym] = { ym, soldQty: 0, revenue: 0, cost: 0 };
        monthlyMap[ym].revenue += sellPrice;
        monthlyMap[ym].cost    += Math.abs(buyPrice); // buyPrice is negative in the sheet
      }

      if (!salesByPlatformByItem[marketplace]) salesByPlatformByItem[marketplace] = {};
      salesByPlatformByItem[marketplace][item] = (salesByPlatformByItem[marketplace][item] || 0) + 1;
    }
  }

  // compute profits + onHand per item
  const breakdownRows = Object.values(breakdownMap).map(b => {
    const profit = b.totalRevenue - b.fees - b.shipping + b.costSold; // costSold negative
    const onHandQty = Math.max(0, (b.boughtQty || 0) - (b.soldQty || 0));
    return { ...b, profit, onHandQty };
  }).sort((a,b)=> (b.profit||0)-(a.profit||0));

  // === SUMMARY METRICS for pills ===
  summary.profit = summary.revenue - summary.fees - summary.shipping + summary.costSold;
  summary.netProfit = summary.profit; // UI reads netProfit
  const costAbs = Math.abs(summary.costSold || 0);
  summary.roiPct = costAbs ? (summary.netProfit / costAbs) : 0;                // Profit / Cost
  summary.marginPct = (summary.revenue > 0) ? (summary.netProfit / summary.revenue) : 0; // Profit / Revenue
  summary.asp = (summary.soldQty > 0) ? (summary.revenue / summary.soldQty) : 0;         // Avg selling price
  summary.avgDaysToSell = dSellCount ? Math.round(dSellSum / dSellCount) : 0;

  // Monthly soldQty from the per-item map; output sorted ascending (Jan -> Dec)
  for (const [ym, perItem] of Object.entries(salesByMonthByItem)) {
    let cnt = 0;
    for (const v of Object.values(perItem)) cnt += v;
    if (!monthlyMap[ym]) monthlyMap[ym] = { ym, soldQty: 0, revenue: 0, cost: 0 };
    monthlyMap[ym].soldQty += cnt;
  }
  const monthlyRows = Object.values(monthlyMap).sort((a,b)=> a.ym.localeCompare(b.ym));

  // Top items as strings for legend
  const topItems = breakdownRows.slice(0, 10).map(b => b.item);

  return {
    summary,
    monthly: monthlyRows,
    breakdownByItem: breakdownRows,
    charts: {
      topItems,
      purchasesByMonthByItem,
      salesByMonthByItem,
      purchasesByStoreByItem,
      salesByPlatformByItem
    }
  };
}

function emptyStatsPayload(){
  return {
    summary:{ totalQty:0, soldQty:0, revenue:0, fees:0, shipping:0, costSold:0, profit:0, netProfit:0, roiPct:0, marginPct:0, asp:0, orders:0, avgDaysToSell:0 },
    monthly: [],
    breakdownByItem: [],
    charts: { topItems:[], purchasesByMonthByItem:{}, salesByMonthByItem:{}, purchasesByStoreByItem:{}, salesByPlatformByItem:{} }
  };
}

/** Longest hold days (unsold rows for an item, token match like GAS) */
async function getLongestHoldDays(itemName) {
  const sheets = sheetsClient(false);
  const id = process.env.SPREADSHEET_ID;
  const ob = await readWhole(sheets, id, TAB_ORDER_BOOK, OB.headerRow);
  if (!ob.rows.length) return 0;

  const want = new Set(normText(itemName || '').split(' ').filter(Boolean));
  const match = (name) => {
    if (!want.size) return true;
    const toks = new Set(normText(name).split(' ').filter(Boolean));
    for (const t of want) if (!toks.has(t)) return false;
    return true;
  };

  let oldest = null;
  for (const r of ob.rows) {
    const item = (r[OB.colItem-1] || '').toString().trim();
    if (!item || !match(item)) continue;

    const sellPrice = toNumber(r[OB.colSellPrice-1] || 0);
    if (sellPrice > 0) continue; // sold: skip

    const od = parseDateMaybe(r[OB.colOrderDate-1]);
    if (!od) continue;
    if (!oldest || od < oldest) oldest = od;
  }
  if (!oldest) return 0;

  const today = new Date();
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d1 = new Date(oldest.getFullYear(), oldest.getMonth(), oldest.getDate());
  return Math.max(0, Math.round((d0 - d1) / (24*3600*1000)));
}

/** ==== MUTATIONS ==== */
async function appendOrder(sheets, id, data) {
  const row = [
    data.order_date || '',
    data.item || '',
    toNumber(data.buy_price || 0),
    data.bought_from || '',
    toNumber(data.sell_price || 0),
    data.sale_date || data.sell_date || '',
    data.sale_location || '',
    toNumber(data.fees_pct || 0),
    toNumber(data.shipping || 0),
    '' // PL
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${TAB_ORDER_BOOK}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}
async function updateOrderRow(sheets, id, rowNumber, values, startCol = 1) {
  const endCol = startCol + values.length - 1;
  const range = a1Row(TAB_ORDER_BOOK, rowNumber, startCol, endCol);
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });
}
async function deleteRowsByNumbers(sheets, id, sheetName, rowNumbers) {
  const meta = await getSheetMeta(sheets, id);
  const sheetId = meta.byName[sheetName];
  const sorted = [...new Set(rowNumbers)].sort((a,b)=>a-b);
  const requests = sorted.map(rn => ({
    deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rn - 1, endIndex: rn } }
  }));
  if (!requests.length) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests } });
}

async function submitQuickAdd(payload) {
  const s = sheetsClient(true);
  const id = process.env.SPREADSHEET_ID;
  await appendOrder(s, id, payload || {});
  clearCache();
  return { ok: true, added: 1 };
}
async function submitMarkAsSold(payload) {
  const s = sheetsClient(true);
  const id = process.env.SPREADSHEET_ID;
  const row = Number(payload.row);
  const vals = new Array(OB.colPL).fill('');
  vals[OB.colSellPrice - 1] = toNumber(payload.sell_price || 0);
  vals[OB.colSaleDate  - 1] = payload.sale_date || '';
  vals[OB.colMarketplace- 1] = payload.sale_location || '';
  vals[OB.colFeesPct   - 1] = toNumber(payload.fees_pct || 0);
  vals[OB.colShipping  - 1] = toNumber(payload.shipping || 0);
  await updateOrderRow(s, id, row, vals, 1);
  clearCache();
  return { ok: true, row };
}
async function addOrderBookRow(payload) { return submitQuickAdd(payload); }
async function updateOrderBookRows(rows) {
  const s = sheetsClient(true); const id = process.env.SPREADSHEET_ID;
  for (const r of (rows || [])) {
    const row = Number(r.row);
    const vals = [
      r.order_date || '',
      r.item || '',
      toNumber(r.buy_price || 0),
      r.bought_from || '',
      toNumber(r.sell_price || 0),
      r.sale_date || '',
      r.sale_location || '',
      toNumber(r.fees_pct || 0),
      toNumber(r.shipping || 0),
      ''
    ];
    await updateOrderRow(s, id, row, vals, 1);
  }
  clearCache();
  return { ok: true, updated: (rows || []).length };
}
async function deleteOrderBookRows(rows) {
  const s = sheetsClient(true); const id = process.env.SPREADSHEET_ID;
  const numbers = (rows || []).map(r => Number(r.row)).filter(Boolean);
  await deleteRowsByNumbers(s, id, TAB_ORDER_BOOK, numbers);
  clearCache();
  return { ok: true, deleted: numbers.length || 0 };
}

/** Database adds/updates/removes */
async function addDatabaseItem(payload){
  if (!payload || !payload.name) return { ok:false, error:'Name required' };
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  const vals = [[ payload.name || '', toNumber(payload.market || 0) ]];
  await s.spreadsheets.values.append({
    spreadsheetId:id, range:`${TAB_ITEMS}!A1`,
    valueInputOption:'USER_ENTERED', requestBody:{ values: vals }
  });
  clearCache(); return { ok:true };
}
async function addDatabaseRetailer(name){
  name = (name || '').toString().trim();
  if (!name) return { ok:false, error:'Retailer name required' };
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  await s.spreadsheets.values.append({
    spreadsheetId:id, range:`${TAB_RETAILERS}!A1`,
    valueInputOption:'USER_ENTERED', requestBody:{ values: [[name]] }
  });
  clearCache(); return { ok:true };
}
async function addDatabaseMarketplace(payload){
  if (!payload || !payload.name) return { ok:false, error:'Marketplace name required' };
  let fee = toNumber(payload.fee);
  if (fee > 1) fee = fee / 100; // accept 12.5 -> 0.125
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  await s.spreadsheets.values.append({
    spreadsheetId:id, range:`${TAB_MARKETPLACES}!A1`,
    valueInputOption:'USER_ENTERED', requestBody:{ values: [[payload.name, fee]] }
  });
  clearCache(); return { ok:true };
}
async function updateDatabaseItems(rows){
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  for (const r of (rows||[])) {
    const row = Number(r.row); if (!row) continue;
    const vals = [ (r.name||''), toNumber(r.market||0) ];
    await s.spreadsheets.values.update({
      spreadsheetId:id, range:a1Row(TAB_ITEMS, row, 1, 2),
      valueInputOption:'USER_ENTERED', requestBody:{ values:[vals] }
    });
  }
  clearCache(); return { ok:true };
}
async function updateDatabaseRetailers(rows){
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  for (const r of (rows||[])) {
    const row = Number(r.row); if (!row) continue;
    const vals = [ (r.name||'') ];
    await s.spreadsheets.values.update({
      spreadsheetId:id, range:a1Row(TAB_RETAILERS, row, 1, 1),
      valueInputOption:'USER_ENTERED', requestBody:{ values:[vals] }
    });
  }
  clearCache(); return { ok:true };
}
async function updateDatabaseMarketplaces(rows){
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  for (const r of (rows||[])) {
    const row = Number(r.row); if (!row) continue;
    let fee = toNumber(r.fee_pct || r.fee || 0);
    if (fee > 1) fee = fee/100;
    const vals = [ (r.name||''), fee ];
    await s.spreadsheets.values.update({
      spreadsheetId:id, range:a1Row(TAB_MARKETPLACES, row, 1, 2),
      valueInputOption:'USER_ENTERED', requestBody:{ values:[vals] }
    });
  }
  clearCache(); return { ok:true };
}
async function removeDatabaseItem(row){
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  await deleteRowsByNumbers(s, id, TAB_ITEMS, [Number(row)]);
  clearCache(); return { ok:true };
}
async function removeDatabaseRetailer(row){
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  await deleteRowsByNumbers(s, id, TAB_RETAILERS, [Number(row)]);
  clearCache(); return { ok:true };
}
async function removeDatabaseMarketplace(row){
  const s = sheetsClient(true), id = process.env.SPREADSHEET_ID;
  await deleteRowsByNumbers(s, id, TAB_MARKETPLACES, [Number(row)]);
  clearCache(); return { ok:true };
}

/** Utility: fetch image -> base64 data URL */
async function fetchImageAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const ct = res.headers.get('content-type') || 'image/*';
  const buf = Buffer.from(await res.arrayBuffer());
  const b64 = buf.toString('base64');
  return { dataUrl: `data:${ct};base64,${b64}` };
}

/** ==== MAIN HANDLER ==== */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: 'ok' };
  if (!process.env.SPREADSHEET_ID) return { statusCode: 500, headers: cors, body: JSON.stringify({ error:'Missing SPREADSHEET_ID' }) };

  try {
    const qs = event.queryStringParameters || {};
    const route = (qs.route || '').trim();

    if (route === 'api') {
      const action = (qs.action || '').trim();
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}

      // Diagnostic endpoint (temporary)
      if (action === 'diag') {
        return ok({
          emailSet: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          keyLen: (process.env.GOOGLE_PRIVATE_KEY || '').length,
          hasBEGIN: /BEGIN PRIVATE KEY/.test(process.env.GOOGLE_PRIVATE_KEY || ''),
          hasRealNewlines: /\n/.test(process.env.GOOGLE_PRIVATE_KEY || ''),
          hasBackslashN: /\\n/.test(process.env.GOOGLE_PRIVATE_KEY || '')
        });
      }

      switch (action) {
        case 'getInitModel':         return ok(await getInitModel());
        case 'getDatabaseFull':      return ok(await getDatabaseFull());
        case 'getOpenPurchases':     return ok(await getOpenPurchases());
        case 'getOrderBookEditable': return ok(await getOrderBookEditable());
        case 'getInventory':         return ok(await getInventory());
        case 'getStatsV2': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await getStatsV2(params.rangeKey, params.item, params.from, params.to));
        }
        case 'getLongestHoldDays': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await getLongestHoldDays(params.item));
        }

        // MUTATIONS
        case 'submitQuickAdd': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await submitQuickAdd(JSON.parse(params.payload || '{}')));
        }
        case 'submitMarkAsSold': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await submitMarkAsSold(JSON.parse(params.payload || '{}')));
        }
        case 'addOrderBookRow': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await addOrderBookRow(JSON.parse(params.payload || '{}')));
        }
        case 'updateOrderBookRows': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await updateOrderBookRows(JSON.parse(params.rows || '[]')));
        }
        case 'deleteOrderBookRows': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await deleteOrderBookRows(JSON.parse(params.rows || '[]')));
        }

        case 'addDatabaseItem': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await addDatabaseItem(JSON.parse(params.payload || '{}')));
        }
        case 'addDatabaseRetailer': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await addDatabaseRetailer(params.name));
        }
        case 'addDatabaseMarketplace': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await addDatabaseMarketplace(JSON.parse(params.payload || '{}')));
        }
        case 'updateDatabaseItems': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await updateDatabaseItems(JSON.parse(params.rows || '[]')));
        }
        case 'updateDatabaseRetailers': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await updateDatabaseRetailers(JSON.parse(params.rows || '[]')));
        }
        case 'updateDatabaseMarketplaces': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await updateDatabaseMarketplaces(JSON.parse(params.rows || '[]')));
        }
        case 'removeDatabaseItem': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await removeDatabaseItem(Number(params.row)));
        }
        case 'removeDatabaseRetailer': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await removeDatabaseRetailer(Number(params.row)));
        }
        case 'removeDatabaseMarketplace': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await removeDatabaseMarketplace(Number(params.row)));
        }

        case 'fetchImageAsDataUrl': {
          const params = JSON.parse(qs.params || '{}') || body.params || {};
          return ok(await fetchImageAsDataUrl(params.url));
        }

        default:
          return err(400, `Unknown action: ${action}`);
      }
    }

    return err(400, 'Unsupported route. Use ?route=api&action=...');
  } catch (e) {
    console.error('Function error:', e);
    return err(500, e.message || String(e));
  }
};

function ok(data){ return { statusCode: 200, headers: cors, body: JSON.stringify(data) }; }
function err(code,msg){ return { statusCode: code, headers: cors, body: JSON.stringify({ ok:false, error: msg }) }; }
