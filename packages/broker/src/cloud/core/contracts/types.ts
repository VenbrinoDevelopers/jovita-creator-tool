export type AttachmentKind = 'image' | 'audio' | 'video' | 'document';

export interface MediaAttachment {
  kind: AttachmentKind;
  attachmentId?: string;
  sha256?: string;
  role?: 'original' | 'model-preview';
  url?: string;
  path?: string;
  data?: string;
  encoding?: 'base64';
  mimeType?: string;
  fileName?: string;
  size?: number;
  caption?: string;
  pageNumbers?: number[];
  collectionId?: string;
  collectionName?: string;
  collectionSize?: number;
  position?: number;
  presentationRole?: 'cover' | 'asset' | 'archive';
  durationMs?: number;
  width?: number;
  height?: number;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio?: boolean;
  posterAttachmentId?: string;
  playbackAttachmentId?: string;
  originalAttachmentId?: string;
  waveformPeaks?: number[];
  processingStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  processingFailureCode?: string;
}

export interface InboundMessage {
  cancellationGeneration?: number;
  channel: string;
  from?: string;
  to?: string;
  text?: string;
  messageId?: string;
  accountId?: string;
  conversationId?: string;
  chatType?: 'dm' | 'group';
  timestamp?: number;
  attachments?: MediaAttachment[];
  meta?: Record<string, unknown>;
}

export interface BridgeConnectConfig {
  upstreamWsUrl?: string;
  upstreamToken?: string;
  upstreamClientId: string;
  upstreamChannels: string[];
}
