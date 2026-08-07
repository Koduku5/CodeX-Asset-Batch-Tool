/** Pure list operations kept outside the DOM so large-data behavior is testable. */
export function filterAssets(assets, { category = '全部', style = 'all', query = '' } = {}) {
  const needle = query.trim().toLowerCase();
  return assets.filter((asset) =>
    (category === '全部' || asset.category === category)
    && (style === 'all' || asset.style === style)
    && (!needle || `${asset.name} ${asset.description}`.toLowerCase().includes(needle))
  );
}

export function paginateAssets(assets, page = 0, pageSize = 100) {
  const safePage = Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0);
  const safeSize = Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 100);
  const start = safePage * safeSize;
  return assets.slice(start, start + safeSize);
}
