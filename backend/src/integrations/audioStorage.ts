import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getConfig } from '../config.js';
import { notConfigured } from '../http/errors.js';

export interface AudioStorage {
  isConfigured(): boolean;
  put(key: string, audio: Buffer): Promise<void>;
  /** Short-lived download URL. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  /**
   * Whether `key` is still stored. Only needed by stores that can lose files (local disk); a store
   * without it is trusted to keep what it was given.
   */
  exists?(key: string): Promise<boolean>;
}

export class S3AudioStorage implements AudioStorage {
  private client: S3Client | undefined;

  isConfigured(): boolean {
    return Boolean(getConfig().AUDIO_BUCKET);
  }

  private bucket(): string {
    const bucket = getConfig().AUDIO_BUCKET;
    if (!bucket) throw notConfigured('Audio storage');
    return bucket;
  }

  private s3(): S3Client {
    this.client ??= new S3Client({ region: getConfig().AWS_REGION });
    return this.client;
  }

  async put(key: string, audio: Buffer): Promise<void> {
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: audio, ContentType: 'audio/mpeg' }));
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: this.bucket(), Key: key }), { expiresIn: ttlSeconds });
  }
}
