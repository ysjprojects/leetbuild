import type {Company} from '@/lib/types';

/**
 * Companies whose engineering writing courses are derived from. The tag is the name beside a
 * monogram in the brand colour — no trademarked logo assets ship with the app.
 */

export const STRIPE: Company = {
  id: 'stripe',
  name: 'Stripe',
  color: '#635bff',
  publication: 'Stripe Blog',
  url: 'https://stripe.com/blog/engineering',
};

export const DISCORD: Company = {
  id: 'discord',
  name: 'Discord',
  color: '#5865f2',
  publication: 'Discord Engineering Blog',
  url: 'https://discord.com/category/engineering',
};

export const NETFLIX: Company = {
  id: 'netflix',
  name: 'Netflix',
  color: '#e50914',
  publication: 'Netflix TechBlog',
  url: 'https://netflixtechblog.com',
};

export const REDDIT: Company = {
  id: 'reddit',
  name: 'Reddit',
  color: '#ff4500',
  publication: 'Reddit Blog',
  url: 'https://www.redditinc.com/blog',
};
