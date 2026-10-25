// Общие типы окружения Worker'а.

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
  LIMIT: DurableObjectNamespace;
  ASSETS: Fetcher;
  VERSION: string; // секрет/вар — необязательный, есть дефолт
  GOR_GIPHY_KEY?: string; // ключ GIPHY (optional): без него /api/giphy отдаёт ошибку
}

export interface UserRow {
  id: number;
  username: string;
}

export interface Frame {
  id?: number;
  chatId?: number;
  userId?: number;
  username?: string;
  text?: string;
  timestamp?: string;
  type?: string;
  stickerId?: string;
  stickerUrl?: string;
  stickerPack?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  replyTo?: number;
  edited?: number;
}
