export type Album = {
  id: string;
  name: string;
  createdAt: number;
  order: number;
  count?: number;
  deleted?: boolean;
  version?: number;
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
  progress: { step?: number | null; steps?: number; sample?: number; nSamples?: number; text?: string };
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

export type StudioPop = "token" | "sampler" | "gender" | "album" | "paramSet" | "download" | null;

export type StudioDownloadKind = "original" | "clean";
