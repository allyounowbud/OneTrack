// netlify/functions/sheet.js
const { google } = require('googleapis');

/** ==== SETTINGS (matches your Apps Script) ==== */
const TAB_ORDER_BOOK   = 'Order Book';
const TAB_ITEMS        = 'Items';
const TAB_RETAILERS    = 'Retailers';
const TAB_MARKETPLACES = 'Marketplaces';

const OB = { // headers on row 2
  headerRow: 2,
  colOrderDate: 1,  // A
  colItem: 2,       // B
  colBuyPrice: 3,   // C
  colRetailer: 4,   // D
  colSellPrice: 5,  // E
  colSaleDate: 6,   // F
  colMarketplace: 7,// G
  colFeesPct: 8,    // H
  colShipping: 9,   // I
  colPL: 10         // J (formula)
};
const ITEMS = { headerRow: 1, colName: 1, colMarketVal: 2 };
const RETS  = { headerRow: 1, colName: 1 };
const MKTS  = { headerRow: 1, colName: 1, colFeePct: 2 };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const CACHE_TTL_MS = 30 * 1000; // short-read cache
const cache = new Map();
const setCache = (k,v,ttl=CACHE_TTL_MS)=>cache.set(k,{v,exp:Date.now()+ttl});
const getCache = (k)=>{ const h=cache.get(k); if(!h) return null; if(Date.now()>h.exp){cache.delete(k);return null;} return h.v; };
const clearCache = ()=>cache.clear();

const normalizeKey = k => (k || '').replace(/\\n/g, '\n');

function sheetsClient(readWrite=false){
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

function colNumberToA1(n){ let s=''; while(n>0){ n--; s=String.fromCharCode(65+(n%26))+s; n=Math.floor(n/26);} return s; }
function a1Row(sheet,row,c1,c2){ return `${sheet}!${colNumberToA1(c1)}${row}:${colNumberToA1(c2)}${row}`; }

async function getSheetMeta(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const byName = {};
  (meta.data.sheets||[]).forEach(s => byName[s.properties.title] = s.properties.sheetId);
  return { byName };
}

/** ---------- READ HELPERS ---------- */
async function readRange(sheets, spreadsheetId, sheetName, a1) {
  const out = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${a1}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return out.data.values || [];
}

async function readWhole(sheets, spreadsheetId, sheetName, headerRow=1) {
  const cacheKey = `whole:${sheetName}`;
  const hit = getCache(cacheKey);
  if (hit) return hit;
  // read a wide range; if you know your max columns/rows, narrow for speed
  const vals = await readRange(sheets, spreadsheetId, sheetName, 'A1:ZZ');
  const headers = (vals[headerRow-1] || []).map(v => (v ?? '').toString().trim());
  const result = { headers, rows: vals.slice(headerRow) };
  setCache(cacheKey, result);
  return result;
}

/** ---------- ACTIONS (mirror Apps Script) ---------- */
async function getInitModel() {
  const sheets = sheetsClient(false);
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const itemsTab = await readWhole(sheets, spreadsheetId, TAB_ITEMS, ITEMS.headerRow);
  const retailersTab = await readWhole(sheets, spreadsheetId, TAB_RETAILERS, RETS.headerRow);
  const marketsTab = await readWhole(sheets, spreadsheetId, TAB_MARKETPLACES, MKTS.headerRow);

  return {
    items: itemsTab.rows.map(r => (r[ITEMS.colName-1] || '').toString().trim()).filter(Boolean),
    retailers: retailersTab.rows.map(r => (r[RETS.colName-1] || '').toString().trim()).filter(Boolean),
    marketplaces: marketsTab.rows.map(r => (r[MKTS.colName-1] || '').toString().trim()).filter(Boolean),
    marketplacesWithFees: marketsTab.rows.map(r => ({
      name: (r[MKTS.colName-1] || '').toString().trim(),
      fee_pct: Number(r[MKTS.colFeePct-1] || 0)
    })).filter(x => x.name)
  };
}

async function getDatabaseFull() {
  const sheets = sheetsClient(false);
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const itemsTab = await readWhole(sheets, spreadsheetId, TAB_ITEMS, ITEMS.headerRow);
  const retailersTab = await readWhole(sheets, spreadsheetId, TAB_RETAILERS, RETS.headerRow);
  const marketsTab = await readWhole(sheets, spreadsheetId, TAB_MARKETPLACES, MKTS.headerRow);

  return {
    items: itemsTab.rows.map((r,i)=>({
      row: ITEMS.headerRow + 1 + i,
      name: (r[ITEMS.colName-1] || '').toString().trim(),
      release: '',
      msrp: 0,
      market: Number(r[ITEMS.colMarketVal-1] || 0)
    })).filter(x => x.name),
    retailers: retailersTab.rows.map((r,i)=>({
      row: RETS.headerRow + 1 + i,
      name: (r[RETS.colName-1] || '').toString().trim()
    })).filter(x => x.name),
    marketplaces: marketsTab.rows.map((r,i)=>({
      row: MKTS.headerRow + 1 + i,
      name: (r[MKTS.colName-1] || '').toString().trim(),
      fee_pct: Number(r[MKTS.colFeePct-1] || 0)
    })).filter(x => x.name)
  };
}

async function getOpenPurchases() {
  const sheets = sheetsClient(false);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const tab = await readWhole(sheets, spreadsheetId, TAB_ORDER_BOOK, OB.headerRow);

  const out = [];
  for (let i=0;i<tab.rows.length;i++){
    const r = tab.rows[i];
    const sell = Number(r[OB.colSellPrice-1] || 0);
    if (!(sell>0)) {
      const rowNumber = OB.headerRow + 1 + i;
      const orderDate = r[OB.colOrderDate-1] || '';
      const item = r[OB.colItem-1] || '';
      const buy = Number(r[OB.colBuyPrice-1] || 0);
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
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const tab = await readWhole(sheets, spreadsheetId, TAB_ORDER_BOOK, OB.headerRow);

  const rows = tab.rows.map((r,i)=>({
    row: OB.headerRow + 1 + i,
    order_date: r[OB.colOrderDate-1] || '',
    item: r[OB.colItem-1] || '',
    buy_price: Number(r[OB.colBuyPrice-1] || 0),
    bought_from: r[OB.colRetailer-1] || '',
    sell_price: Number(r[OB.colSellPrice-1] || 0),
    sale_date: r[OB.colSaleDate-1] || '',
    sale_location: r[OB.colMarketplace-1] || '',
    fees_pct: Number(r[OB.colFeesPct-1] || 0),
    shipping: Number(r[OB.colShipping-1] || 0),
  }));
  return rows;
}

/** ---------- MUTATIONS ---------- */
async function appendOrder(sheets, spreadsheetId, data){
  // data keys: order_date,item,bought_from,buy_price,sell_price,sale_date,sale_location,fees_pct,shipping
  const row = [
    data.order_date || '',
    data.item || '',
    Number(data.buy_price || 0),
    data.bought_from || '',
    Number(data.sell_price || 0),
    data.sell_date || data.sale_date || '',
    data.sale_location || '',
    Number(data.fees_pct || 0),
    Number(data.shipping || 0),
    '' // PL formula column left blank; your sheet formula can compute
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB_ORDER_BOOK}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

async function updateOrderRow(sheets, spreadsheetId, rowNumber, values, startCol=1){
  const endCol = startCol + values.length - 1;
  const range = a1Row(TAB_ORDER_BOOK, rowNumber, startCol, endCol);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });
}

async function deleteRowsByNumbers(sheets, spreadsheetId, rowNumbers){
  const meta = await getSheetMeta(sheets, spreadsheetId);
  const sheetId = meta.byName[TAB_ORDER_BOOK];
  const sorted = [...new Set(rowNumbers)].sort((a,b)=>a-b);
  const requests = sorted.map(rn => ({
    deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rn-1, endIndex: rn } }
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

async function submitQuickAdd(payload){
  const sheets = sheetsClient(true);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  await appendOrder(sheets, spreadsheetId, payload || {});
  clearCache();
  return { ok: true, added: 1 };
}

async function submitMarkAsSold(payload){
  // payload: { row, sell_price, sale_date, sale_location, fees_pct, shipping }
  const sheets = sheetsClient(true);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const row = Number(payload.row);
  const vals = new Array(OB.colPL).fill('');
  vals[OB.colSellPrice-1] = Number(payload.sell_price || 0);
  vals[OB.colSaleDate-1] = payload.sale_date || '';
  vals[OB.colMarketplace-1] = payload.sale_location || '';
  vals[OB.colFeesPct-1] = Number(payload.fees_pct || 0);
  vals[OB.colShipping-1] = Number(payload.shipping || 0);
  await updateOrderRow(sheets, spreadsheetId, row, vals, 1);
  clearCache();
  return { ok: true, row };
}

async function addOrderBookRow(payload){ return submitQuickAdd(payload); }

async function updateOrderBookRows(rows){
  // rows: [{ row, order_date, item, buy_price, bought_from, sell_price, sale_date, sale_location, fees_pct, shipping }]
  const sheets = sheetsClient(true);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  for (const r of (rows||[])) {
    const row = Number(r.row);
    const vals = [
      r.order_date || '',
      r.item || '',
      Number(r.buy_price || 0),
      r.bought_from || '',
      Number(r.sell_price || 0),
      r.sale_date || '',
      r.sale_location || '',
      Number(r.fees_pct || 0),
      Number(r.shipping || 0),
      '' // PL formula
    ];
    await updateOrderRow(sheets, spreadsheetId, row, vals, 1);
  }
  clearCache();
  return { ok: true, updated: (rows||[]).length };
}

async function deleteOrderBookRows(rows){
  const sheets = sheetsClient(true);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const numbers = (rows||[]).map(r => Number(r.row)).filter(Boolean);
  if (!numbers.length) return { ok: true, deleted: 0 };
  await deleteRowsByNumbers(sheets, spreadsheetId, numbers);
  clearCache();
  return { ok: true, deleted: numbers.length };
}

/** ---- Database (Items/Retailers/Marketplaces) ---- */
async function updateDatabaseItems(rows){
  const sheets = sheetsClient(true);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  for (const r of (rows||[])) {
    const row = Number(r.row); if (!row) continue;
    const vals = [ (r.name||''), Number(r.market||0) ];
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: a1Row(TAB_ITEMS, row, 1, 2),
      valueInputOption: 'USER_ENTERED', requestBody: { values: [vals] }
    });
  }
  clearCache(); return { ok: true };
}
async function updateDatabaseRetailers(rows){
  const sheets = sheetsClient(true);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  for (const r of (rows||[])) {
    const row = Number(r.row); if (!row) continue;
    const vals = [ (r.name||'') ];
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: a1Row(TAB_RETAILERS, row, 1, 1),
      valueInputOption: 'USER_ENTERED', requestBody: { values: [vals] }
    });
  }
  clearCache(); return { ok: true };
}
async function updateDatabaseMarketplaces(rows){
  const sheets = sheetsClient(true);
  const spreadsheetId = process.env.SPREADSHEET_ID;
  for (const r of (rows||[])) {
    const row = Number(r.row); if (!row) continue;
    const vals = [ (r.name||''), Number(r.fee_pct||0) ];
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: a1Row(TAB_MARKETPLACES, row, 1, 2),
      valueInputOption: 'USER_ENTERED', requestBody: { values: [vals] }
    });
  }
  clearCache(); return { ok: true };
}
async function removeDatabaseItem(row){ return deleteOrderBookRows([{row}]); }           // You may have a separate Items delete; we can add if needed
async function removeDatabaseRetailer(row){ /* TODO: delete a row in Retailers */ return { ok:true, note:'Implement if used' }; }
async function removeDatabaseMarketplace(row){ /* TODO */ return { ok:true, note:'Implement if used' }; }

/** ---------- MAIN HANDLER ---------- */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: 'ok' };

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing SPREADSHEET_ID'}) };

  try {
    const qs = event.queryStringParameters || {};
    const route = (qs.route || '').trim();

    if (route === 'api') {
      const action = (qs.action || '').trim();
      // parse body JSON if present (for POST/PUT/DELETE)
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}

      switch (action) {
        // ----- Reads -----
        case 'getInitModel':         return ok(await getInitModel());
        case 'getDatabaseFull':      return ok(await getDatabaseFull());
        case 'getOpenPurchases':     return ok(await getOpenPurchases());
        case 'getOrderBookEditable': return ok(await getOrderBookEditable());
        case 'getInventory':         return ok({ error: 'TODO: implement inventory calc' }); // TODO: port your logic if used
        case 'getStatsV2':           return ok({ error: 'TODO: implement stats' });         // TODO
        case 'getLongestHoldDays':   return ok({ error: 'TODO: implement longest hold' });  // TODO

        // ----- Mutations -----
        case 'submitQuickAdd':           return ok(await submitQuickAdd(JSON.parse(qs.payload || '{}') || body.payload));
        case 'submitMarkAsSold':         return ok(await submitMarkAsSold(JSON.parse(qs.payload || '{}') || body.payload));
        case 'addOrderBookRow':          return ok(await addOrderBookRow(JSON.parse(qs.payload || '{}') || body.payload));
        case 'updateOrderBookRows':      return ok(await updateOrderBookRows(JSON.parse(qs.rows || '[]') || body.rows));
        case 'deleteOrderBookRows':      return ok(await deleteOrderBookRows(JSON.parse(qs.rows || '[]') || body.rows));
        case 'updateDatabaseItems':      return ok(await updateDatabaseItems(JSON.parse(qs.rows || '[]') || body.rows));
        case 'updateDatabaseRetailers':  return ok(await updateDatabaseRetailers(JSON.parse(qs.rows || '[]') || body.rows));
        case 'updateDatabaseMarketplaces':return ok(await updateDatabaseMarketplaces(JSON.parse(qs.rows || '[]') || body.rows));
        case 'removeDatabaseItem':       return ok(await removeDatabaseItem(Number(qs.row || (body && body.row))));
        case 'removeDatabaseRetailer':   return ok(await removeDatabaseRetailer(Number(qs.row || (body && body.row))));
        case 'removeDatabaseMarketplace':return ok(await removeDatabaseMarketplace(Number(qs.row || (body && body.row))));

        // ----- Utilities / Discord (port later) -----
        case 'fetchImageAsDataUrl':  return ok({ error:'TODO: implement image fetch proxy' });
        case 'getDiscordAuthUrl':    return ok({ error:'TODO: migrate Discord auth to Netlify separately' });

        default:
          return err(400, `Unknown action: ${action}`);
      }
    }

    // Future: if you want to support /exec?route=discord_login / discord_callback, we’ll add here.
    return err(400, 'Unsupported route. Use ?route=api&action=...');
  } catch (e) {
    console.error(e);
    return err(500, e.message || String(e));
  }
};

function ok(data){ return { statusCode: 200, headers: cors, body: JSON.stringify(data) }; }
function err(code,msg){ return { statusCode: code, headers: cors, body: JSON.stringify({ ok:false, error: msg }) }; }
