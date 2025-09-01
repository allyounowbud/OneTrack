// lib/supabaseApi.js
import { supabase } from './supabaseClient.js';

// Example: get Items / Retailers / Marketplaces
export async function getInitModel() {
  const [items, retailers, marketplaces] = await Promise.all([
    supabase.from('Items').select('item_name, market_value'),
    supabase.from('Retailers').select('retailers'),
    supabase.from('Marketplaces').select('marketplaces, fee')
  ]);

  if (items.error) throw items.error;
  if (retailers.error) throw retailers.error;
  if (marketplaces.error) throw marketplaces.error;

  const feeTable = {};
  (marketplaces.data || []).forEach(m => {
    const f = m.fee ?? 0;
    feeTable[m.marketplaces] = { pct: f > 1 ? f / 100 : f };
  });

  return {
    items: (items.data || []).map(r => r.item_name),
    retailers: (retailers.data || []).map(r => r.retailers),
    marketplaces: (marketplaces.data || []).map(r => r.marketplaces),
    feeTable
  };
}

// Example: insert a new order
export async function submitQuickAdd(payload) {
  const row = {
    order_date: payload.order_date || new Date().toISOString().slice(0,10),
    item: payload.item,
    buy_price: -Math.abs(payload.buy_price),
    retailer: payload.bought_from || '',
    sale_price: payload.sell_price || 0,
    sale_date: payload.sale_price ? (payload.sale_date || null) : null,
    marketplace: payload.sale_location || '',
    shipping: payload.sale_price ? Math.abs(payload.shipping || 0) : 0,
    qty: 1
  };

  const { error } = await supabase.from('Order Book').insert([row]);
  if (error) throw error;
  return { ok: true };
}
