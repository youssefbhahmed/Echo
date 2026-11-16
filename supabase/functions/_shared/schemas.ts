import { z } from 'npm:zod@4.6.7';
import { CATEGORIES } from './types.ts';

const category = z.enum(CATEGORIES);
const itemId = z.string().min(3).max(200).regex(/^[a-z]+:[a-z]+:[A-Za-z0-9_./\-]+$/);

export const DiscoverBody = z.object({
  query: z.string().max(1000).optional(),
  categories: z.array(category).max(5).optional(),
  moods: z.array(z.string().max(40)).max(6).optional(),
  exploration: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(60).optional(),
  exclude: z.array(itemId).max(200).optional(),
  seed: z.number().int().optional(),
  mix: z.partialRecord(z.enum(CATEGORIES), z.number().min(0).max(3)).optional(),
  intentHint: z.record(z.string(), z.unknown()).optional(),
});

/** Chat picks per answer are fixed server-side (engine/chat.ts: 12, or 20 when the message names an entity). */
export const ChatBody = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1).max(1000),
  categories: z.array(category).max(5).optional(),
  exploration: z.number().min(0).max(1).optional(),
  intentHint: z.record(z.string(), z.unknown()).optional(),
});

export const FeedbackBody = z.object({
  itemId: itemId,
  type: z.enum(['like', 'unlike', 'dislike', 'save', 'unsave', 'skip', 'rate', 'consumed', 'open', 'play']),
  rating: z.number().int().min(1).max(5).optional(),
  context: z.object({ source: z.enum(['feed', 'chat', 'library', 'onboarding']).optional(), query: z.string().max(300).optional(), exploration: z.number().optional() }).optional(),
});

export const ProfileEditBody = z.object({
  action: z.literal('edit'),
  edit: z.object({
    setConcept: z.object({ id: z.string().max(40), weight: z.number().min(-3).max(3) }).optional(),
    removeConcept: z.string().max(40).optional(),
    pinConcept: z.string().max(40).optional(),
    unpinConcept: z.string().max(40).optional(),
    blockConcept: z.string().max(40).optional(),
    unblockConcept: z.string().max(40).optional(),
    removeCreator: z.string().max(200).optional(),
    removeGenre: z.string().max(200).optional(),
    removeStatement: z.string().max(600).optional(),
    removeLike: z.string().max(200).optional(),
    removeDislike: z.string().max(200).optional(),
    exploration: z.number().min(0).max(1).optional(),
    family: z.object({ id: z.string().max(40), action: z.enum(['more', 'less', 'never', 'allow']) }).optional(),
  }),
});

export const OnboardingBody = z.object({
  action: z.literal('onboarding'),
  displayName: z.string().max(80).optional(),
  categories: z.array(category).max(5).optional(),
  interests: z.array(z.string().max(40)).max(20).optional(),
  description: z.string().max(1000).optional(),
  exploration: z.number().min(0).max(1).optional(),
  favorites: z.array(itemId).max(20).optional(),
});

export const ProfileBody = z.discriminatedUnion('action', [
  ProfileEditBody,
  OnboardingBody,
  z.object({ action: z.literal('reset') }),
]);

export const CatalogBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lookup'), query: z.string().min(1).max(200), category: category.optional() }),
  z.object({ action: z.literal('trailer'), itemId: itemId }),
  z.object({ action: z.literal('refresh'), itemIds: z.array(itemId).max(100) }),
  z.object({ action: z.literal('items'), itemIds: z.array(itemId).max(100) }),
]);

export const AccountBody = z.object({ action: z.enum(['export', 'delete']), confirm: z.string().optional() });

export const SpotifyBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('authorize'), redirectTo: z.string().url().max(500) }),
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('disconnect') }),
  z.object({ action: z.literal('create-playlist'), name: z.string().min(1).max(100), description: z.string().max(300).optional(), itemIds: z.array(itemId).min(1).max(100) }),
]);
