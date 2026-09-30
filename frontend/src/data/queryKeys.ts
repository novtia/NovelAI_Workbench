export const queryKeys = {
  albums: ["albums"] as const,
  itemsRoot: ["items"] as const,
  items: (albumId: string) => ["items", albumId] as const,
  galleryView: ["gallery-view"] as const,
  artistBasket: ["artist-basket"] as const,
  jobs: ["jobs"] as const,
  naiStatus: ["nai-status"] as const,
  paramSets: ["param-sets"] as const,
  lotteryBatches: ["lottery-batches"] as const,
  lotteryBoard: ["lottery-board"] as const,
};
