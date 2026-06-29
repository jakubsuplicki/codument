// Return one page of `items`. Pages are 1-indexed: page 1 is the first window.

export function paginate(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
