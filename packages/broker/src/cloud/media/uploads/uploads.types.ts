export const MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024;
export const MAX_FILES = 4;
export const MAX_OUTBOUND_ATTACHMENTS = 20;
export const MAX_RUNTIME_UPLOAD_FILES = MAX_OUTBOUND_ATTACHMENTS;
export const MAX_ACTIVE_RUNTIME_UPLOADS = MAX_OUTBOUND_ATTACHMENTS;
export const MAX_RUNTIME_UPLOADS_PER_MINUTE = 20;
export const MAX_OUTBOUND_TOTAL_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_ATTACHMENT_READ_URL_TTL_SECONDS = 60 * 60;
export const ALLOWED_UPLOAD_EXTENSIONS = [
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'jfif',
    'heic',
    'heif',
    'tif',
    'tiff',
    'bmp',
    'svg',
    'pdf',
    'docx',
    'pptx',
    'xls',
    'xlsx',
    'txt',
    'md',
    'html',
    'htm',
    'csv',
    'tsv',
    'json',
    'yaml',
    'yml',
    'mp3',
    'wav',
    'm4a',
    'aac',
    'flac',
    'ogg',
    'opus',
    'mp4',
    'mov',
    'webm',
    'mkv',
] as const;

export const ALLOWED_UPLOAD_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'image/tiff',
    'image/bmp',
    'image/svg+xml',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/markdown',
    'text/html',
    'text/csv',
    'text/tab-separated-values',
    'application/json',
    'application/yaml',
    'text/yaml',
    'text/x-yaml',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/mp4',
    'audio/aac',
    'audio/flac',
    'audio/opus',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
] as const;

export interface UploadConstraintsResponse {
    maxFiles: number;
    maxFileBytes: number;
    allowedExtensions: readonly string[];
    allowedMimeTypes: readonly string[];
}

export type AttachmentKind = 'image' | 'document' | 'audio' | 'video';

export interface UploadedAttachment {
    attachmentId?: string;
    kind: AttachmentKind;
    url?: string;
    mimeType: string;
    fileName: string;
    size: number;
}

export interface PresignFileInput {
    fileName: string;
    size: number;
    mimeType?: string;
    kind?: AttachmentKind;
    sha256: string;
}

export interface PresignRequest {
    files?: PresignFileInput[];
}

export interface PresignUploadItem {
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
    attachment: UploadedAttachment;
}

export interface UploadServiceLogoResponse {
    url: string;
    fileName: string;
    mimeType: string;
    size: number;
}
