export type Album = {
  id: string;
  name: string;
  createdAt: number;
  order: number;
  count?: number;
  deleted?: boolean;
  version?: number;
  kind?: "singleArtist" | "testSet";
};

/** 画师串面板里的一位画师：没有权重，一律按默认 1。 */
export type BasketArtist = {
  key: string;
  name: string;
  addedAt: number;
};

export type Artwork = {
  id: string;
  albumId: string;
  addedAt: number;
  name: string;
  mime: string;
  size: number;
  hash: string;
  thumbHash?: string;
  width?: number | null;
  height?: number | null;
  artists: string[];
  artistLine: string;
  params: Record<string, unknown>;
  imageUrl: string;
  thumbUrl: string;
  version?: number;
};

export type GenderId = "f" | "m" | "o";

export type Character = {
  prompt: string;
  uc: string;
  x: number;
  y: number;
  gender?: GenderId;
  enabled?: boolean;
};

export type StudioForm = {
  prompt: string;
  uc: string;
  characters: Character[];
  model: string;
  /** V5 完整的力度。节约会改走蒸馏模型，精选模型忽略这个字段。 */
  effort: "high" | "medium";
  v5Mode: "anime" | "furry";
  quality: "off" | "official" | "gallery";
  width: number;
  height: number;
  sampler: string;
  noiseSchedule: string;
  steps: number;
  scale: number;
  cfgRescale: number;
  seed: number;
  nSamples: number;
  useCoords: boolean;
  straightAlpha: boolean;
  aspect: "land" | "port" | "square";
  preset: "Small" | "Normal" | "Large";
};

export type Job = {
  id: string;
  source: string;
  status: string;
  progress: { step?: number | null; steps?: number; sample?: number; nSamples?: number; text?: string; kind?: string; width?: number; height?: number; sourceHash?: string };
  items: Array<{ id?: string; blobHash?: string; url?: string; thumbUrl?: string; width?: number; height?: number }>;
  meta: Record<string, unknown>;
  error?: string | null;
  subscription?: Record<string, unknown> | null;
  client?: Record<string, unknown>;
  previewUrl?: string | null;
  createdAt: number;
};

export type LotteryControls = {
  min: number;
  max: number;
  draws: number;
  target: number;
  wmin: number;
  wmax: number;
  jitter: number;
  boost: number;
  presetId?: string;
};

export type LotteryBoard = {
  id?: string;
  albumId?: string | null;
  excluded: string[];
  pinned: string[];
  weightCaps: Record<string, number>;
  controls: LotteryControls;
  version?: number;
};

export type PoolArtist = {
  key: string;
  name: string;
  tag: string;
  weight: number;
};

export type DrawRow = {
  tags: string[];
  count: number;
  unit: number;
  weight: number;
  cents: number;
};

export type LotShot = {
  id?: string;
  blobHash?: string;
  url?: string;
  thumbUrl?: string;
  width?: number | null;
  height?: number | null;
  meta?: Record<string, unknown>;
  savedId?: string;
  albumId?: string;
};

export type DrawResult = {
  id?: string;
  outputText: string;
  artistCount: number;
  artists?: string[];
  rows?: DrawRow[];
  newCents?: number;
  targetCents?: number;
  previews?: LotShot[];
  jobId?: string;
};

export type DrawBatch = {
  id: string;
  albumId: string;
  seed: number;
  poolHash: string;
  poolRevision?: number;
  params: Record<string, unknown>;
  draws: DrawResult[];
  createdAt: number;
  deleted?: boolean;
  version?: number;
};

export type LotTriggerRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type LotSave = {
  batchId: string;
  drawId: string;
  shotIndex: number;
  item: LotShot;
  left: number;
  top: number;
  trigger?: LotTriggerRect;
};

export type ParamSet = { id: string; name: string; form: StudioForm; createdAt: number };

export type TokenStatus = {
  configured: boolean;
  hint: string;
  subscription: {
    tierName?: string;
    opus?: boolean;
    usagePercent?: number | null;
    usageNegative?: boolean;
    anlas?: number;
    anlasFixed?: number;
    anlasPurchased?: number;
  } | null;
  error?: string;
};

export type StudioShot = {
  id: string;
  url: string;
  thumbUrl: string;
  blobHash?: string;
  width?: number | null;
  height?: number | null;
  name?: string;
  meta: Record<string, unknown>;
  savedId?: string;
  pending?: boolean;
  jobId?: string;
  sample?: number;
};

export type StudioImportOpts = {
  prompt: boolean;
  uc: boolean;
  chars: boolean;
  append: boolean;
  settings: boolean;
  seed: boolean;
  clean: boolean;
};

export type StudioPop = "token" | "sampler" | "gender" | "album" | "paramSet" | "download" | "enhance" | null;

export type StudioDownloadKind = "original" | "clean";

/** 图生图底图。图片和蒙版都已经上传到后端 blob，这里只存哈希和预览地址。 */
export type I2iBase = {
  hash: string;
  url: string;
  width: number;
  height: number;
  strength: number;
  noise: number;
  /** 有蒙版就走局部重绘。 */
  maskHash?: string;
  maskUrl?: string;
  inpaintStrength: number;
};

export type EnhanceAmount = "1x" | "1.5x" | "max";

export type EnhanceOpts = {
  upscaleAmount: EnhanceAmount;
  /** 官方 Magnitude 1~5，对应一组 strength/noise。 */
  magnitude: number;
  /** Show Advanced：直接填 strength / noise。 */
  advanced: boolean;
  strength: number;
  noise: number;
};

export type EditorMode = "draw" | "mask";

export type JobKind = "generate" | "img2img" | "variation" | "infill" | "enhance" | "upscale";

/** 工具栏按钮旁边显示的 Anlas 估算（后端 /api/nai/estimate）。 */
export type AnlasEstimate = { generate: number; variation: number; upscale: number; enhance: number; upscaleScale: number; estimated: boolean };