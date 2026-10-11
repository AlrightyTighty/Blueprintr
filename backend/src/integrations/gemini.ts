import { getConfig } from '../config.js';
import { badGateway, notConfigured, tooManyRequests } from '../http/errors.js';

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiRequest {
  system?: string;
  contents: GeminiContent[];
  tools?: FunctionDeclaration[];
  /** JSON Schema; makes the model answer with matching JSON in `text`. */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
}

export interface GeminiResponse {
  text: string | null;
  functionCalls: { name: string; args: Record<string, unknown> }[];
  /** The model's turn, to append to `contents` when continuing a tool-calling conversation. */
  content: GeminiContent;
}

export interface GeminiClient {
  readonly model: string;
  isConfigured(): boolean;
  generate(request: GeminiRequest): Promise<GeminiResponse>;
}

export class HttpGeminiClient implements GeminiClient {
  get model(): string {
    return getConfig().GEMINI_MODEL;
  }

  isConfigured(): boolean {
    return Boolean(getConfig().GEMINI_API_KEY);
  }

  async generate(request: GeminiRequest): Promise<GeminiResponse> {
    const config = getConfig();
    if (!config.GEMINI_API_KEY) throw notConfigured('Gemini');

    const body: Record<string, unknown> = {
      contents: request.contents,
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        ...(request.jsonSchema ? { responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema } : {}),
      },
    };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
    if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools }];

    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw badGateway('Gemini', 'Could not reach Gemini.');
    }
    if (res.status === 429) throw tooManyRequests('Gemini rate limit reached. Try again shortly.');
    if (!res.ok) throw badGateway('Gemini', `Gemini responded with ${res.status}.`);

    const data = (await res.json()) as { candidates?: { content?: GeminiContent }[] };
    const content = data.candidates?.[0]?.content;
    if (!content?.parts) throw badGateway('Gemini', 'Gemini returned no answer.');

    const text = content.parts.flatMap((p) => ('text' in p && typeof p.text === 'string' ? [p.text] : [])).join('');
    const functionCalls = content.parts.flatMap((p) => ('functionCall' in p ? [p.functionCall] : []));
    return { text: text || null, functionCalls, content: { role: 'model', parts: content.parts } };
  }
}
