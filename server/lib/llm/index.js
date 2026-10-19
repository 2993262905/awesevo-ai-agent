import { streamOpenAI } from './openai.js';
import { streamAnthropic } from './anthropic.js';

export function getAdapter(format) {
  switch (String(format || 'openai').toLowerCase()) {
    case 'anthropic':
    case 'claude':
      return streamAnthropic;
    default:
      return streamOpenAI;
  }
}

export { streamOpenAI, streamAnthropic };
