/**
 * Route registry. `server.ts` only wires this in, so adding an endpoint never
 * means editing the dispatcher.
 */

import type { Router } from '../http/router.ts';
import type { Store } from '../store/db.ts';

import { registerCharacterRoutes } from './characters.ts';
import { registerChatRoutes } from './chats.ts';
import { registerConnectionRoutes } from './connections.ts';
import { registerGenerateRoutes } from './generate.ts';
import { registerMemoryRoutes } from './memory.ts';
import { registerMetaRoutes } from './meta.ts';
import { registerPersonaRoutes } from './personas.ts';
import { registerPromptRoutes } from './prompt.ts';
import { registerQuickReplyRoutes } from './quick-replies.ts';
import { registerRegexRoutes } from './regex.ts';
import { registerFontRoutes } from './fonts.ts';
import { registerImageRoutes } from './images.ts';
import { registerSpriteRoutes } from './sprites.ts';
import { registerTraceRoutes } from './trace.ts';
import { registerVectorRoutes } from './vectors.ts';
import { registerTtsRoutes } from './tts.ts';
import { registerWorldRoutes } from './worlds.ts';

export function registerRoutes(router: Router, store: Store): void {
  registerMetaRoutes(router, store);
  registerCharacterRoutes(router, store);
  registerWorldRoutes(router, store);
  registerChatRoutes(router, store);
  registerMemoryRoutes(router, store);
  registerPersonaRoutes(router, store);
  registerConnectionRoutes(router, store);
  registerTraceRoutes(router, store);
  registerVectorRoutes(router, store);
  registerTtsRoutes(router, store);
  registerPromptRoutes(router, store);
  registerQuickReplyRoutes(router, store);
  registerRegexRoutes(router, store);
  registerFontRoutes(router, store);
  registerImageRoutes(router, store);
  registerSpriteRoutes(router, store);
  registerGenerateRoutes(router, store);
}
