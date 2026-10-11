import { getConfig } from '../config.js';
import { badGateway, notConfigured } from '../http/errors.js';

export interface ElevenLabsClient {
  isConfigured(): boolean;
  /** Text to speech, returned as MP3 bytes. */
  synthesize(text: string): Promise<Buffer>;
  /** Signed WebSocket URL for the conversational agent. */
  getSignedUrl(): Promise<{ signedUrl: string; agentId: string }>;
}

const API = 'https://api.elevenlabs.io/v1';

export class HttpElevenLabsClient implements ElevenLabsClient {
  isConfigured(): boolean {
    const config = getConfig();
    return Boolean(config.ELEVENLABS_API_KEY && config.ELEVENLABS_VOICE_ID);
  }

  async synthesize(text: string): Promise<Buffer> {
    const config = getConfig();
    if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_VOICE_ID) throw notConfigured('ElevenLabs');
    let res: Response;
    try {
      res = await fetch(`${API}/text-to-speech/${config.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': config.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        // A steady, unhurried delivery: stable, slightly slower than default.
        body: JSON.stringify({
          text,
          model_id: config.ELEVENLABS_MODEL_ID,
          voice_settings: { stability: 0.75, similarity_boost: 0.75, speed: 0.95 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw badGateway('ElevenLabs', 'Could not reach ElevenLabs.');
    }
    if (!res.ok) throw badGateway('ElevenLabs', `ElevenLabs responded with ${res.status}.`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getSignedUrl(): Promise<{ signedUrl: string; agentId: string }> {
    const config = getConfig();
    if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_AGENT_ID) throw notConfigured('ElevenLabs conversational agent');
    let res: Response;
    try {
      res = await fetch(`${API}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(config.ELEVENLABS_AGENT_ID)}`, {
        headers: { 'xi-api-key': config.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw badGateway('ElevenLabs', 'Could not reach ElevenLabs.');
    }
    if (!res.ok) throw badGateway('ElevenLabs', `ElevenLabs responded with ${res.status}.`);
    const body = (await res.json()) as { signed_url?: string };
    if (!body.signed_url) throw badGateway('ElevenLabs', 'ElevenLabs returned no signed URL.');
    return { signedUrl: body.signed_url, agentId: config.ELEVENLABS_AGENT_ID };
  }
}
